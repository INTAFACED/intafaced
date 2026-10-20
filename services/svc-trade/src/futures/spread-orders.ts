/**
 * FUTURES CALENDAR SPREAD ORDERS THROUGH svc-matching'S SPREAD BOOK (CB-otc-16, svc-trade side).
 *
 * A spread order is ONE order at a signed spread price over exactly two futures legs (an owner listing in the engine).
 * This service:
 *
 *   · PLACES it: reads the listing from the engine, checks both legs are futures markets sharing one quote asset,
 *     reads each leg's mark and the owner's price band, sizes ONE hold that covers the most margin any fill can need
 *     (`spread-order-plan.ts` explains why it does), takes the hold (`futuresOrderMarginHold`) and only then sends it;
 *   · SENDS it under a per-spread lock, with an anchor reference chosen inside the anchor window of every live order it
 *     can cross. The engine prints leg 0 at the taker's anchor and does not bound it, so the bound is enforced here;
 *   · SETTLES each fill, for each account side, as two leg fills in one intent: each leg moves margin from the order's
 *     hold into that leg's position (`futuresOrderMarginApply`) and grows or opens the row;
 *   · RELEASES the unused hold when the order is finished (`futuresOrderMarginRelease`).
 *
 * An order that opens or grows a position only. There is no reduce-only spread, no market spread and no amend: the
 * engine takes GTC limit spreads only (CB-otc-17 widens that). In one-way mode an order that would open a leg's other
 * side refuses at placement, as a matched order does (`refuseOneWayFlip`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY MONEY STEP, ITS KEY, AND WHAT STRANDS IF IT CRASHES THERE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   hold      `futures.order.margin.hold:<orderId>`    order row `pending`, then `held`. A crash after the post and
 *                                                      before `held`: the retry posts the same key, which returns the
 *                                                      original. The hold is the trader's own available balance.
 *   send      no money. Under the spread lock: the anchor is chosen, the row claimed `submitting` with it, then the
 *             engine is called. A transport failure leaves the hold and the row `submit_unknown`; the order is never
 *             sent again, so nothing double-submits, and its fills still settle through the event path. A crash after
 *             the claim leaves `submitting`: counted live by every later order's window check, never resent.
 *   fill      `futures.fill:spread:<spreadId>:<sequence>:<leg>:<positionId>`, one per leg. The two legs' intents
 *             (`futures_spread_fills`, state `pending`) are committed together BEFORE the first post and hold their
 *             positions: a close, a liquidation, funding or a margin change on either refuses until both are `applied`.
 *             A crash after one leg posted: the intent is `pending`, so the retry replays both keys with the stored
 *             amounts (the posted leg returns its original, the other posts) and then moves both rows. The spread's
 *             sequence is its own book's, so the key carries the spread id and cannot equal an outright fill's.
 *   release   `futures.order.margin.release:<orderId>:0`. Written only once the engine has said how much the order filled
 *             in all (cancel reply or cancellation event), every one of those fills has settled and none is pending. A
 *             fill printed before a cancel can arrive after it; it still finds its margin in the hold.
 *
 * Nothing here holds a balance. Every amount is recomputed from the order row, the intent rows, or the ledger.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, recipes, type Amount } from '@intafaced/ledger-client';
import type { LedgerClient } from '@intafaced/ledger-client';
import type {
  EngineSpreadFill,
  EngineSpreadSubmitRequest,
  EngineSpreadSubmitResult,
  MatchingClient,
  SpreadMatchingPort,
} from '../spot/matching-client.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { checkCloseQuantity } from './desk-quantity.js';
import { checkLeverage } from './initial-margin.js';
import { checkMarginModeForFuturesOpen } from './margin-mode.js';
import { checkOpenAdmission, PRETRADE_LIMIT_HTTP_STATUS } from './pretrade-limits.js';
import { assertDatedFuturesTradable } from './dated-futures.js';
import { isInsufficientFunds } from './futures-payouts.js';
import type { DerivativesAccessGate } from './derivatives-access.js';
import { matchedSlotPositionIdFor, spreadLegFillKey, spreadOrderIdFor } from './ids.js';
import { FUTURES_PRICE_BAND_UNSET, fillWithinLimit, priceBandAround, weightedEntry } from './matched-order-plan.js';
import {
  MatchedOrderError,
  fillMustWait,
  positionSideOf,
  refuse,
  refuseIfPositionBusy,
  refuseIfPositionHasPendingFill,
  type MatchedFuturesOrders,
  type SpreadLiquidationPort,
} from './matched-orders.js';
import {
  anchorStep,
  anchorWindow,
  crossesSpread,
  engineLegPrices,
  intersectWindows,
  legFillMargin,
  legQtyOf,
  legsSumToSpread,
  mulExact,
  opposite,
  orderLegSides,
  pickAnchor,
  readWireListing,
  spreadHoldAmount,
  windowIsEmpty,
  type AnchorWindow,
  type OrderSide,
  type SpreadListing,
  type SpreadOrderTerms,
} from './spread-order-plan.js';
import { SpreadLifecycleError, spreadLifecycleProof } from './spread-lifecycle.js';
import { MatchingUnavailableError } from '../spot/matching-client.js';

// ── codes ────────────────────────────────────────────────────────────────────

/** The engine has no listing for this spread id. */
export const SPREAD_UNLISTED = 'trade.spread_unlisted';
/** The listing is a kind svc-trade does not take (only calendar spreads of futures). */
export const SPREAD_KIND_UNSUPPORTED = 'trade.spread_kind_unsupported';
/** A leg is not a futures market in this service (a spot or inter-coin leg), or is not tradable. */
export const SPREAD_LEG_NOT_FUTURES = 'trade.spread_leg_not_futures';
/** The two legs settle in different quote assets, so one hold cannot fund them. */
export const SPREAD_LEG_QUOTE_MISMATCH = 'trade.spread_leg_quote_mismatch';
/** The spread's limit would let a leg print outside the band the hold covers (no anchor keeps both legs inside). */
export const SPREAD_PRICE_OUTSIDE_BAND = 'trade.spread_price_outside_band';
/** No anchor exists that keeps every live order this one can cross inside its own cover; the order is not sent. */
export const SPREAD_ANCHOR_UNCOVERED = 'trade.spread_anchor_uncovered';
/** A fill whose leg prices are outside what an order's hold covers. Refused whole; needs an operator. */
export const SPREAD_FILL_OUTSIDE_COVER = 'trade.spread_fill_outside_cover';
/** A fill whose legs disagree with the order's listing. Refused whole; needs an operator. */
export const SPREAD_FILL_LEGS_MISMATCH = 'trade.spread_fill_legs_mismatch';
/** A spread fill that names an order this service did not place. */
export const SPREAD_FILL_UNKNOWN_ORDER = 'trade.spread_fill_unknown_order';
/** The engine will not take spread orders until it announces their fills (the event subject is not wired there yet). */
export const SPREAD_FILL_EVENT_UNWIRED = 'trade.spread_fill_event_unwired';

const ENGINE_REFUSALS: Record<string, { code: string; status: number }> = {
  spread_fill_event_unwired: { code: SPREAD_FILL_EVENT_UNWIRED, status: 503 },
  spread_unlisted: { code: SPREAD_UNLISTED, status: 404 },
  spread_leg_unavailable: { code: 'trade.spread_leg_unavailable', status: 409 },
  spread_leg_unfillable: { code: 'trade.spread_leg_unfillable', status: 409 },
  spread_reference_missing: { code: 'trade.spread_anchor_refused', status: 409 },
  spread_qty_off_lot: { code: 'trade.spread_qty_off_lot', status: 400 },
  spread_price_off_tick: { code: 'trade.spread_price_off_tick', status: 400 },
  spread_order_unsupported: { code: 'trade.spread_order_unsupported', status: 400 },
  spread_identity_disagrees: { code: 'trade.spread_identity_disagrees', status: 409 },
  spread_book_outright_refused: { code: 'trade.spread_identity_disagrees', status: 409 },
};

function engineRefusal(code: string | undefined): { code: string; status: number } {
  return (code !== undefined && ENGINE_REFUSALS[code]) || { code: 'trade.spread_engine_refused', status: 409 };
}

export const SPREAD_ORDER_STATUSES = [
  'pending',
  'held',
  'submitting',
  'open',
  'filled',
  'cancelled',
  'rejected',
  'refused',
  'submit_unknown',
] as const;
export type SpreadOrderStatus = (typeof SPREAD_ORDER_STATUSES)[number];

const ORDER_TERMINAL = ['filled', 'cancelled', 'rejected'] as const;
/** States in which the order may still be live at the engine, so a cancel must ask it. */
const LIVE_OR_UNKNOWN = ['held', 'submitting', 'open', 'submit_unknown'] as const;

/** How many waiting spread fills one retry tick takes. */
export const SPREAD_FILL_RETRY_BATCH = 200;

// ── inputs and views ─────────────────────────────────────────────────────────

export interface PlaceSpreadOrderInput {
  readonly userId: string;
  /** The engine's spread id (the owner's listing). */
  readonly spreadId: string;
  readonly side: OrderSide;
  /** Spread quantity, a whole number of the listing's lots. */
  readonly qty: Amount;
  /** The spread price: may be zero or negative. GTC limit only. */
  readonly limitPrice: Amount;
  readonly leverage: Amount;
  readonly clientOrderId: string;
  readonly marginMode?: 'isolated';
}

export interface SpreadOrderView {
  readonly orderId: string;
  readonly spreadId: string;
  readonly userId: string;
  readonly side: OrderSide;
  readonly qty: string;
  readonly limitPrice: string;
  readonly leverage: string;
  readonly legs: readonly {
    readonly marketId: string;
    /** The side this order takes on the leg. */
    readonly side: OrderSide;
    readonly ratio: string;
    readonly markPrice: string;
    readonly bandLow: string;
    readonly bandHigh: string;
  }[];
  readonly anchorLow: string;
  readonly anchorHigh: string;
  /** The anchor the order was sent with; null until it is sent. */
  readonly anchorReference: string | null;
  readonly holdAmount: string;
  readonly filledQty: string;
  readonly appliedAmount: string;
  readonly releasedAmount: string;
  readonly status: SpreadOrderStatus;
  readonly refusalCode: string | null;
}

/** One engine spread fill, as the reply or the event carries it. Decimal strings; the spread price may be negative. */
export interface SpreadFillInput {
  readonly spreadId: string;
  readonly makerOrderId: string;
  readonly takerOrderId: string;
  readonly takerSide: OrderSide;
  readonly price: string;
  readonly qty: string;
  readonly sequence: number;
  readonly legs: readonly { readonly symbol: string; readonly takerSide: OrderSide; readonly qty: string; readonly price: string }[];
}

export interface SpreadOrdersDeps {
  readonly sql: Sql;
  readonly ledger: LedgerClient;
  /** Null when the engine is not configured on this deployment. New orders refuse; settlement still runs. */
  readonly matching: (Pick<MatchingClient, 'cancel'> & Partial<SpreadMatchingPort>) | null;
  /** TRADE_FUTURES_MATCHING_ENABLED. OFF refuses new orders only: a fill already matched is final. */
  readonly enabled: boolean;
  /** The owner's band as a fraction of the mark. Null is unset, and refuses new orders. */
  readonly priceBand: Amount | null;
  /** The owner's leverage cap. Null is unset, and refuses. */
  readonly maxLeverage: Amount | null;
  readonly now: () => Date;
  readonly markFor: (marketId: string, symbol: string, at: Date, size: Amount | null) => Promise<Amount>;
  readonly assertPositionIdle: (positionId: string) => Promise<void>;
  readonly assertDerivativesAccess?: DerivativesAccessGate | null;
  /** The PX-S01 PLACE proof of one LEG market. The spread's own proof is derived from both (`spread-lifecycle.ts`). */
  readonly lifecycleProof: ((marketId: string) => Promise<LifecycleAdmissionProof>) | null;
  readonly admission?: TradingAdmissionPort;
  readonly publishPosition?: (positionId: string) => Promise<void>;
  /** The matched-order service this one shares the one-way rule and the reduce-order follow-up with. */
  readonly matched: Pick<MatchedFuturesOrders, 'refuseOneWayFlip' | 'followPositionAfterGrowth'>;
}

// ── rows ─────────────────────────────────────────────────────────────────────

interface OrderRow {
  id: string;
  user_id: string;
  spread_id: string;
  client_order_id: string;
  side: OrderSide;
  qty: string;
  limit_price: string;
  leverage: string;
  hold_asset: string;
  leg0_market_id: string;
  leg0_side: OrderSide;
  leg0_ratio: string;
  leg0_mark: string;
  leg0_delta: string;
  leg1_market_id: string;
  leg1_side: OrderSide;
  leg1_ratio: string;
  leg1_mark: string;
  leg1_delta: string;
  anchor_lo: string;
  anchor_hi: string;
  anchor_ref: string | null;
  filled_qty: string;
  leg0_adverse_num: string;
  leg1_adverse_num: string;
  leg0_applied: string;
  leg1_applied: string;
  applied_amount: string;
  released_amount: string;
  engine_filled_qty: string | null;
  status: SpreadOrderStatus;
  refusal_code: string | null;
}

interface LegFillRow {
  fill_key: string;
  order_id: string;
  spread_id: string;
  engine_sequence: string;
  leg_index: number;
  market_id: string;
  position_id: string;
  spread_qty: string;
  qty: string;
  price: string;
  amount: string;
  new_filled: string;
  new_adverse: string;
  new_applied: string;
  state: 'pending' | 'applied';
}

interface MarketRow {
  id: string;
  symbol: string;
  kind: string;
  status: string;
  quote_asset: string;
  lot_size: string | null;
  futures_contract_style: 'perpetual' | 'dated' | null;
  futures_expiry_at: Date | null;
  futures_settlement_fixing: string | null;
}

interface WaitRow {
  spread_id: string;
  engine_sequence: string;
  maker_order_id: string;
  taker_order_id: string;
  taker_side: OrderSide;
  price: string;
  qty: string;
  leg0_symbol: string;
  leg0_taker_side: OrderSide;
  leg0_qty: string;
  leg0_price: string;
  leg1_symbol: string;
  leg1_taker_side: OrderSide;
  leg1_qty: string;
  leg1_price: string;
}

interface PositionRowLite {
  id: string;
  status: string;
  size: string;
  entry_price: string;
  margin_initial: string;
  margin_current: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `idempotencyKey` is `min(8).max(200)` in the ledger's post request (`packages/ledger-client/src/types.ts`). */
export const LEDGER_IDEMPOTENCY_KEY_MAX = 200;

/** The ledger key of a leg fill of this spread at the largest sequence and leg index, on a position id (a uuid). */
function spreadLegFillKeyLength(spreadId: string): number {
  return `futures.fill:${spreadLegFillKey(spreadId, Number.MAX_SAFE_INTEGER, 1, '00000000-0000-0000-0000-000000000000')}`.length;
}

/** The longest spread id whose fill keys fit the ledger's limit. */
export const MAX_SPREAD_ID_LENGTH = LEDGER_IDEMPOTENCY_KEY_MAX - spreadLegFillKeyLength('');

/** Leverage is stored as numeric(8,2). */
const LEVERAGE_STEP = 10n ** 16n;

function listingOf(row: OrderRow): Pick<SpreadListing, 'legs'> {
  return {
    legs: [
      { marketId: row.leg0_market_id, side: row.leg0_side, ratio: parseAmount(row.leg0_ratio) },
      { marketId: row.leg1_market_id, side: row.leg1_side, ratio: parseAmount(row.leg1_ratio) },
    ],
  };
}

/** The order's terms, from its own row: the hold, the window and every fill's margin are functions of these. */
function termsOf(row: OrderRow): SpreadOrderTerms {
  return {
    side: row.side,
    qty: parseAmount(row.qty),
    limit: parseAmount(row.limit_price),
    leverage: parseAmount(row.leverage),
    listing: listingOf(row),
    legs: [
      { ratio: parseAmount(row.leg0_ratio), mark: parseAmount(row.leg0_mark), delta: parseAmount(row.leg0_delta) },
      { ratio: parseAmount(row.leg1_ratio), mark: parseAmount(row.leg1_mark), delta: parseAmount(row.leg1_delta) },
    ],
  };
}

/** The hold the order locked at placement, from its own terms. It is never stored as a figure. */
function holdOf(row: OrderRow): Amount {
  return spreadHoldAmount(termsOf(row));
}

function windowOf(row: OrderRow): AnchorWindow {
  return { lo: parseAmount(row.anchor_lo), hi: parseAmount(row.anchor_hi) };
}

function engineFilled(row: OrderRow): Amount | null {
  if (row.status === 'filled') return parseAmount(row.qty);
  return row.engine_filled_qty == null ? null : parseAmount(row.engine_filled_qty);
}

function assertWithinHold(row: OrderRow, applied: Amount, released: Amount): void {
  if (applied + released <= holdOf(row)) return;
  refuse('trade.futures_hold_exceeded', `spread order ${row.id} would use more than the margin it holds`, 500);
}

function assertFillFits(row: OrderRow, sequence: number, qty: Amount): void {
  const cap = engineFilled(row) ?? parseAmount(row.qty);
  if (parseAmount(row.filled_qty) + qty <= cap) return;
  if (parseAmount(row.released_amount) > 0n) {
    refuse(
      'trade.futures_hold_released',
      `spread order ${row.id} is ${row.status}: its hold was released, so a later fill cannot be funded — this needs an operator`,
      409,
    );
  }
  refuse('trade.futures_overfill', `spread fill ${sequence} would overfill order ${row.id}`, 500);
}

function presentOrder(row: OrderRow): SpreadOrderView {
  const sides = orderLegSides(row.side, listingOf(row));
  const leg = (i: 0 | 1) => {
    const mark = parseAmount(i === 0 ? row.leg0_mark : row.leg1_mark);
    const delta = parseAmount(i === 0 ? row.leg0_delta : row.leg1_delta);
    return {
      marketId: i === 0 ? row.leg0_market_id : row.leg1_market_id,
      side: sides[i],
      ratio: formatAmount(parseAmount(i === 0 ? row.leg0_ratio : row.leg1_ratio)),
      markPrice: formatAmount(mark),
      bandLow: formatAmount(mark - delta),
      bandHigh: formatAmount(mark + delta),
    };
  };
  return {
    orderId: row.id,
    spreadId: row.spread_id,
    userId: row.user_id,
    side: row.side,
    qty: formatAmount(parseAmount(row.qty)),
    limitPrice: formatAmount(parseAmount(row.limit_price)),
    leverage: formatAmount(parseAmount(row.leverage)),
    legs: [leg(0), leg(1)],
    anchorLow: formatAmount(parseAmount(row.anchor_lo)),
    anchorHigh: formatAmount(parseAmount(row.anchor_hi)),
    anchorReference: row.anchor_ref == null ? null : formatAmount(parseAmount(row.anchor_ref)),
    holdAmount: formatAmount(holdOf(row)),
    filledQty: formatAmount(parseAmount(row.filled_qty)),
    appliedAmount: formatAmount(parseAmount(row.applied_amount)),
    releasedAmount: formatAmount(parseAmount(row.released_amount)),
    status: row.status,
    refusalCode: row.refusal_code,
  };
}

function sameRequest(row: OrderRow, input: PlaceSpreadOrderInput): boolean {
  return (
    row.user_id === input.userId &&
    row.side === input.side &&
    parseAmount(row.qty) === input.qty &&
    parseAmount(row.limit_price) === input.limitPrice &&
    parseAmount(row.leverage) === input.leverage
  );
}

interface ParsedFill {
  readonly spreadId: string;
  readonly makerOrderId: string;
  readonly takerOrderId: string;
  readonly takerSide: OrderSide;
  readonly sequence: number;
  readonly price: Amount;
  readonly qty: Amount;
  readonly legs: readonly [
    { symbol: string; takerSide: OrderSide; qty: Amount; price: Amount },
    { symbol: string; takerSide: OrderSide; qty: Amount; price: Amount },
  ];
}

function parseFill(fill: SpreadFillInput): ParsedFill {
  if (!Number.isSafeInteger(fill.sequence) || fill.sequence < 0) {
    refuse('trade.futures_fill_sequence_invalid', 'a fill needs a non-negative integer engine sequence', 500);
  }
  if (!Array.isArray(fill.legs) || fill.legs.length !== 2) {
    refuse(SPREAD_FILL_LEGS_MISMATCH, `spread fill ${fill.sequence} does not carry exactly two legs — this needs an operator`, 500);
  }
  const [a, b] = fill.legs as [SpreadFillInput['legs'][number], SpreadFillInput['legs'][number]];
  const leg = (l: SpreadFillInput['legs'][number]) => ({
    symbol: l.symbol,
    takerSide: l.takerSide,
    qty: parseAmount(l.qty),
    price: parseAmount(l.price),
  });
  return {
    spreadId: fill.spreadId,
    makerOrderId: fill.makerOrderId,
    takerOrderId: fill.takerOrderId,
    takerSide: fill.takerSide,
    sequence: fill.sequence,
    price: parseAmount(fill.price),
    qty: parseAmount(fill.qty),
    legs: [leg(a), leg(b)],
  };
}

function fromReplyFill(spreadId: string, fill: EngineSpreadFill): SpreadFillInput {
  if (!fill.legs || fill.legs.length !== 2) {
    refuse(SPREAD_FILL_LEGS_MISMATCH, `the engine's reply for spread fill ${fill.sequence} carries no legs — this needs an operator`, 500);
  }
  return {
    spreadId,
    makerOrderId: fill.makerOrderId,
    takerOrderId: fill.takerOrderId,
    takerSide: fill.takerSide,
    price: fill.price,
    qty: fill.qty,
    sequence: fill.sequence,
    legs: fill.legs.map((l) => ({ symbol: l.symbol, takerSide: l.takerSide, qty: l.qty, price: l.price })),
  };
}

// ── the service ──────────────────────────────────────────────────────────────

export class SpreadFuturesOrders {
  constructor(private readonly deps: SpreadOrdersDeps) {}

  // ── placement ─────────────────────────────────────────────────────────────

  async place(
    principal: Principal,
    input: PlaceSpreadOrderInput,
    context: { readonly region?: string | null } = {},
  ): Promise<SpreadOrderView> {
    if (!this.deps.enabled) {
      refuse('trade.futures_matching_disabled', 'futures orders through the matching engine are switched off on this deployment', 503);
    }
    if (principal.userId !== input.userId) refuse('auth.credential_denied', 'the order must be placed by its own account', 403);
    const clientOrderId = input.clientOrderId?.trim() ?? '';
    if (clientOrderId.length === 0 || clientOrderId.length > 64) {
      refuse('trade.client_order_id_required', 'clientOrderId is required (1–64 chars) — omit would double-lock margin on retry');
    }
    const modeCheck = checkMarginModeForFuturesOpen(input.marginMode);
    if (!modeCheck.ok) refuse(modeCheck.code ?? 'trade.margin_mode_invalid', modeCheck.reason ?? 'margin mode refused');
    if (input.side !== 'buy' && input.side !== 'sell') refuse('trade.side_invalid', 'side must be buy or sell');
    if (input.qty <= 0n) refuse('trade.size_invalid', `qty must be greater than zero, got ${formatAmount(input.qty)}`);
    const spreadId = input.spreadId?.trim() ?? '';
    if (spreadId.length === 0 || spreadId.length > 128) refuse('trade.spread_id_required', 'a spread order names the spread it trades');
    // The longest ledger key this spread can ever post must fit the ledger's key limit, or a fill would fail at post time
    // with a hold already taken and a position already promised. Refuse here, before anything is held.
    if (spreadLegFillKeyLength(spreadId) > LEDGER_IDEMPOTENCY_KEY_MAX) {
      refuse(
        'trade.spread_id_too_long',
        `the spread id is too long for the ledger keys of its fills (at most ${MAX_SPREAD_ID_LENGTH} characters)`,
        400,
      );
    }

    const existing = await this.findByClientId(input.userId, spreadId, clientOrderId);
    if (existing) {
      if (!sameRequest(existing, input)) refuse('trade.client_order_id_conflict', 'this clientOrderId names a different order', 409);
      return this.resume(existing);
    }

    // After the replay above, so an order that holds margin is finished on retry even if a new agreement was published.
    if (this.deps.assertDerivativesAccess) {
      await this.deps.assertDerivativesAccess({ userId: input.userId, tier: principal.tier ?? null, region: context.region ?? null });
    }

    const band = this.deps.priceBand;
    if (band === null) {
      refuse(FUTURES_PRICE_BAND_UNSET, 'the futures price band is unset on this deployment — the owner names it; nothing is invented');
    }
    if (input.leverage % LEVERAGE_STEP !== 0n) refuse('trade.leverage_invalid', 'leverage has at most two decimal places');
    if (this.deps.maxLeverage == null || this.deps.maxLeverage <= 0n) {
      refuse('trade.leverage_cap_unset', 'the leverage cap is unset on this deployment — refuse rather than invent one');
    }
    const leverageCheck = checkLeverage(input.leverage, this.deps.maxLeverage);
    if (!leverageCheck.ok) refuse(leverageCheck.code ?? 'trade.leverage_invalid', leverageCheck.reason ?? 'leverage refused');

    const listing = await this.readListing(spreadId);
    const markets = [await this.loadLegMarket(listing.legs[0].marketId), await this.loadLegMarket(listing.legs[1].marketId)] as const;
    if (markets[0].quote_asset !== markets[1].quote_asset) {
      refuse(
        SPREAD_LEG_QUOTE_MISMATCH,
        `the legs settle in ${markets[0].quote_asset} and ${markets[1].quote_asset}: one hold cannot fund both`,
        400,
      );
    }

    if (input.qty % listing.lot !== 0n) refuse('trade.spread_qty_off_lot', 'the quantity is not a whole number of the spread lot', 400);
    if (input.limitPrice % listing.tick !== 0n) refuse('trade.spread_price_off_tick', 'the price is not on the spread tick', 400);
    const legQtys = listing.legs.map((leg, i) => {
      const qty = mulExact(input.qty, leg.ratio);
      if (qty === null || qty <= 0n) refuse('trade.spread_qty_inexact', 'the quantity does not give a whole leg quantity', 400);
      const lot = checkCloseQuantity({
        quantity: qty,
        size: qty,
        lotSize: markets[i]!.lot_size == null ? null : parseAmount(markets[i]!.lot_size as string),
      });
      if (!lot.ok) refuse(lot.code, lot.reason);
      return qty;
    }) as [Amount, Amount];

    const orderSides = orderLegSides(input.side, listing);
    for (const i of [0, 1] as const) {
      await this.deps.matched.refuseOneWayFlip(input.userId, markets[i].id, positionSideOf(orderSides[i]));
    }

    const at = this.deps.now();
    const legTerms = [] as unknown as [SpreadOrderTerms['legs'][0], SpreadOrderTerms['legs'][1]];
    for (const i of [0, 1] as const) {
      const mark = await this.deps.markFor(markets[i].id, markets[i].symbol, at, legQtys[i]);
      const bandAt = priceBandAround(mark, band);
      legTerms[i] = { ratio: listing.legs[i].ratio, mark, delta: bandAt.high - mark };
    }
    const terms: SpreadOrderTerms = {
      side: input.side,
      qty: input.qty,
      limit: input.limitPrice,
      leverage: input.leverage,
      listing,
      legs: legTerms,
    };
    // The most any fill can need is the hold; an order whose legs could print outside the band has no anchor at all.
    const window = anchorWindow(terms);
    const anchor = pickAnchor({ mark: legTerms[0].mark, step: anchorStep(listing), window });
    if (windowIsEmpty(window) || anchor === null || engineLegPrices(listing, anchor, input.limitPrice) === null) {
      refuse(
        SPREAD_PRICE_OUTSIDE_BAND,
        'at this price a leg of the spread could print outside the price band around its mark — no anchor keeps both legs inside',
        400,
      );
    }
    const hold = spreadHoldAmount(terms);
    if (hold <= 0n) refuse('trade.size_invalid', 'the order is too small to hold any margin');

    for (const i of [0, 1] as const) {
      const [slot] = await this.deps.sql<{ id: string; leverage: string }[]>`
        SELECT id, leverage FROM trade.positions
         WHERE user_id = ${input.userId} AND market_id = ${markets[i].id} AND side = ${positionSideOf(orderSides[i])}
           AND margin_mode = 'isolated' AND status = 'open'
         LIMIT 1
      `;
      if (slot) {
        if (parseAmount(slot.leverage) !== input.leverage) {
          refuse('trade.futures_leverage_mismatch', 'an order that grows this position must use its current leverage', 409);
        }
        await this.deps.assertPositionIdle(slot.id);
      }
      const pretrade = await checkOpenAdmission({
        sql: this.deps.sql,
        userId: input.userId,
        marketId: markets[i].id,
        quoteAsset: markets[i].quote_asset,
        side: positionSideOf(orderSides[i]),
        size: legQtys[i],
        entryPrice: legTerms[i].mark,
        positionMode: undefined,
        markFor: async (marketId, symbol) => this.deps.markFor(marketId, symbol, at, null),
      });
      if (pretrade) {
        throw new MatchedOrderError(pretrade.message, pretrade.code, pretrade.code.endsWith('_unset') ? 400 : PRETRADE_LIMIT_HTTP_STATUS);
      }
    }

    const proof = await this.proofFor(listing);
    if (!this.deps.admission) refuse('authority.unavailable', 'trading admission is not configured', 503);
    const orderId = spreadOrderIdFor(input.userId, spreadId, clientOrderId);
    await this.deps.admission.admit(principal, 'order.place', `futures.spread_order:${orderId}`, {
      orderId,
      userId: input.userId,
      spreadId,
      side: input.side,
      qty: formatAmount(input.qty),
      limitPrice: formatAmount(input.limitPrice),
      leverage: formatAmount(input.leverage),
      holdAmount: formatAmount(hold),
      legs: [0, 1].map((i) => ({
        marketId: markets[i as 0 | 1].id,
        side: orderSides[i as 0 | 1],
        qty: formatAmount(legQtys[i as 0 | 1]),
        markPrice: formatAmount(legTerms[i as 0 | 1].mark),
      })),
      anchorLow: formatAmount(window.lo),
      anchorHigh: formatAmount(window.hi),
      at: at.toISOString(),
    });

    const inserted = await this.deps.sql<{ id: string }[]>`
      INSERT INTO trade.futures_spread_orders (
        id, user_id, spread_id, client_order_id, side, qty, limit_price, leverage, hold_asset,
        leg0_market_id, leg0_side, leg0_ratio, leg0_mark, leg0_delta,
        leg1_market_id, leg1_side, leg1_ratio, leg1_mark, leg1_delta,
        anchor_lo, anchor_hi, status
      ) VALUES (
        ${orderId}, ${input.userId}, ${spreadId}, ${clientOrderId}, ${input.side}, ${formatAmount(input.qty)},
        ${formatAmount(input.limitPrice)}, ${formatAmount(input.leverage)}, ${markets[0].quote_asset},
        ${markets[0].id}, ${listing.legs[0].side}, ${formatAmount(listing.legs[0].ratio)}, ${formatAmount(legTerms[0].mark)},
        ${formatAmount(legTerms[0].delta)},
        ${markets[1].id}, ${listing.legs[1].side}, ${formatAmount(listing.legs[1].ratio)}, ${formatAmount(legTerms[1].mark)},
        ${formatAmount(legTerms[1].delta)},
        ${formatAmount(window.lo)}, ${formatAmount(window.hi)}, 'pending'
      )
      ON CONFLICT (user_id, spread_id, client_order_id) DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) {
      const raced = await this.findByClientId(input.userId, spreadId, clientOrderId);
      if (!raced || !sameRequest(raced, input)) refuse('trade.client_order_id_conflict', 'this clientOrderId names a different order', 409);
      return this.resume(raced);
    }
    return this.continueOrder(await this.loadOrder(orderId), proof);
  }

  /** The engine's listing for the spread, as the engine publishes it. Nothing is assumed about a spread it does not list. */
  private async readListing(spreadId: string): Promise<SpreadListing> {
    const matching = this.deps.matching;
    if (!matching || typeof matching.listSpreads !== 'function' || typeof matching.submitSpread !== 'function') {
      refuse('trade.futures_matching_unconfigured', 'the matching engine is not configured', 503);
    }
    let listed: Awaited<ReturnType<SpreadMatchingPort['listSpreads']>>;
    try {
      listed = await matching.listSpreads();
    } catch (err) {
      if (err instanceof MatchingUnavailableError) refuse(err.code, 'the matching engine did not answer; nothing was held', 503);
      throw err;
    }
    const wire = listed.instruments.find((i) => i.spreadId === spreadId);
    if (!wire) refuse(SPREAD_UNLISTED, `no spread ${spreadId} is listed`, 404);
    const read = readWireListing(wire);
    if (!read.ok) refuse(read.code, read.message, 409);
    if (read.listing.kind !== 'calendar') {
      refuse(
        SPREAD_KIND_UNSUPPORTED,
        `spread ${spreadId} is an ${read.listing.kind} spread: only calendar spreads of futures are taken`,
        400,
      );
    }
    return read.listing;
  }

  private async loadLegMarket(marketId: string): Promise<MarketRow> {
    if (!UUID.test(marketId)) refuse(SPREAD_LEG_NOT_FUTURES, `leg ${marketId} is not a futures market of this service`, 400);
    const [m] = await this.deps.sql<MarketRow[]>`
      SELECT id, symbol, kind, status, quote_asset, lot_size,
             futures_contract_style, futures_expiry_at, futures_settlement_fixing
        FROM trade.markets WHERE id = ${marketId} LIMIT 1
    `;
    if (!m) refuse(SPREAD_LEG_NOT_FUTURES, `leg ${marketId} is not a market of this service`, 400);
    if (m.kind !== 'futures') refuse(SPREAD_LEG_NOT_FUTURES, `leg ${m.symbol} is ${m.kind}, not futures`, 400);
    if (m.status !== 'active') refuse('trade.market_not_tradable', `leg ${m.symbol} is ${m.status}`, 400);
    try {
      assertDatedFuturesTradable(
        {
          kind: 'futures',
          symbol: m.symbol,
          futuresContractStyle: m.futures_contract_style,
          futuresExpiryAt: m.futures_expiry_at,
          futuresSettlementFixing: m.futures_settlement_fixing,
        },
        { now: this.deps.now() },
      );
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'trade.dated_futures_refused';
      refuse(code, (err as Error).message, code === 'trade.dated_futures_expired' ? 403 : 400);
    }
    return m;
  }

  /** The spread's PLACE proof, derived from the real PLACE proof of each leg. A leg that is not open refuses. */
  private async proofFor(listing: Pick<SpreadListing, 'spreadId' | 'legs'>): Promise<LifecycleAdmissionProof> {
    if (!this.deps.lifecycleProof) refuse('trade.lifecycle_authority_unavailable', 'market lifecycle authority is not configured', 503);
    const leg0 = await this.deps.lifecycleProof(listing.legs[0].marketId);
    const leg1 = await this.deps.lifecycleProof(listing.legs[1].marketId);
    try {
      return spreadLifecycleProof({ spreadId: listing.spreadId, legs: [leg0, leg1] });
    } catch (err) {
      if (err instanceof SpreadLifecycleError) refuse(err.code, err.message, 409);
      throw err;
    }
  }

  /** A retry of an order whose placement stopped part-way: continue from what the row says, with its stored numbers. */
  private async resume(row: OrderRow): Promise<SpreadOrderView> {
    if (row.status === 'pending' || row.status === 'held') {
      const proof = await this.proofFor({
        spreadId: row.spread_id,
        legs: [
          { marketId: row.leg0_market_id, side: row.leg0_side, ratio: parseAmount(row.leg0_ratio) },
          { marketId: row.leg1_market_id, side: row.leg1_side, ratio: parseAmount(row.leg1_ratio) },
        ],
      });
      return this.continueOrder(row, proof);
    }
    if (row.status === 'submitting' || row.status === 'submit_unknown') {
      refuse(
        'trade.futures_submit_unknown',
        'the engine did not answer for this order; it is not sent again, and its hold stays until it is reconciled',
        503,
      );
    }
    if ((row.status === 'rejected' || row.status === 'refused') && row.refusal_code) {
      refuse(
        row.refusal_code,
        `this order was refused (${row.refusal_code}); place it again under a new clientOrderId`,
        refusalStatus(row.refusal_code),
      );
    }
    return presentOrder(row);
  }

  /** Hold, then send. Both steps are idempotent on the order id, so a retry runs them again safely. */
  private async continueOrder(row: OrderRow, proof: LifecycleAdmissionProof): Promise<SpreadOrderView> {
    if (row.status === 'pending') {
      try {
        await this.deps.ledger.post(
          recipes.futuresOrderMarginHold({ orderId: row.id, userId: row.user_id, assetId: row.hold_asset, amount: holdOf(row) }),
        );
      } catch (err) {
        if (isInsufficientFunds(err)) {
          await this.deps.sql`
            UPDATE trade.futures_spread_orders
               SET status = 'refused', refusal_code = 'trade.futures_margin_insufficient', updated_at = now()
             WHERE id = ${row.id} AND status = 'pending'
          `;
          refuse(
            'trade.futures_margin_insufficient',
            'available balance does not cover the initial margin and the adverse distance for both legs of this order',
            400,
          );
        }
        throw err;
      }
      await this.deps.sql`
        UPDATE trade.futures_spread_orders SET status = 'held', updated_at = now() WHERE id = ${row.id} AND status = 'pending'
      `;
    }

    const current = await this.loadOrder(row.id);
    if (current.status !== 'held') return presentOrder(current);
    if (!this.deps.matching || typeof this.deps.matching.submitSpread !== 'function') {
      refuse('trade.futures_matching_unconfigured', 'the matching engine is not configured', 503);
    }

    const sent = await this.withSpreadLock(current.spread_id, () => this.claimAndSend(current.id, proof));
    if (sent.kind === 'view') return presentOrder(await this.loadOrder(current.id));
    if (sent.kind === 'uncovered') {
      await this.releaseWhenDone(current.id);
      refuse(
        SPREAD_ANCHOR_UNCOVERED,
        'no anchor keeps this order, and every resting order it can cross, inside the price band of its own margin — the order was not sent and its hold is released',
        409,
      );
    }

    const result = sent.result;
    if (!result.accepted || result.rejected) {
      const mapped = engineRefusal(result.rejected?.code);
      await this.deps.sql`
        UPDATE trade.futures_spread_orders
           SET status = 'rejected', refusal_code = ${mapped.code}, engine_filled_qty = 0, updated_at = now()
         WHERE id = ${current.id} AND status = 'submitting'
      `;
      await this.releaseWhenDone(current.id);
      refuse(
        mapped.code,
        `the matching engine refused this spread order (${result.rejected?.code ?? 'no reason given'}); its hold is released`,
        mapped.status,
      );
    }

    for (const fill of result.fills) {
      await this.settleFillOrWait(fromReplyFill(current.spread_id, fill));
    }

    const afterFills = await this.loadOrder(current.id);
    if (parseAmount(afterFills.filled_qty) !== parseAmount(afterFills.qty)) {
      if (result.resting) {
        await this.deps.sql`
          UPDATE trade.futures_spread_orders SET status = 'open', updated_at = now()
           WHERE id = ${current.id} AND status IN ('submitting', 'open')
        `;
      } else {
        // A remainder that is not resting has left the engine (a self-trade pull). Every fill of a taker that does not
        // rest is in this reply, even when some of them are still waiting to settle.
        const printed = result.fills
          .filter((f) => f.takerOrderId === current.id || f.makerOrderId === current.id)
          .reduce((sum, f) => sum + parseAmount(f.qty), 0n);
        const left = result.cancellations.find((c) => c.orderId === current.id);
        if (!left && printed === parseAmount(current.qty)) {
          await this.deps.sql`
            UPDATE trade.futures_spread_orders
               SET status = 'open', engine_filled_qty = COALESCE(engine_filled_qty, qty), updated_at = now()
             WHERE id = ${current.id} AND status IN ('submitting', 'open')
          `;
        } else {
          await this.markLeftBook(current.id, left ? parseAmount(left.remainingQty) : parseAmount(current.qty) - printed);
        }
      }
    }
    await this.releaseWhenDone(current.id);
    return presentOrder(await this.loadOrder(current.id));
  }

  /**
   * Under the spread's lock: choose the anchor, claim the row with it, send. The lock is what makes the window check
   * exact. Every order in the book is in this table and `submitting`, `open` or `submit_unknown`, and none can be added
   * until this send has been answered, so the set of orders this one can cross cannot change under the check.
   *
   * The anchor is the grid point nearest this order's leg-0 mark inside the window of this order and of every live
   * order it can cross. None exists: the order is rejected here (`held` is not live at the engine), nothing is sent.
   */
  private async claimAndSend(
    orderId: string,
    proof: LifecycleAdmissionProof,
  ): Promise<{ kind: 'view' } | { kind: 'uncovered' } | { kind: 'sent'; result: EngineSpreadSubmitResult }> {
    const order = await this.loadOrder(orderId);
    if (order.status !== 'held') return { kind: 'view' };
    const listing = listingOf(order);
    const crossing = (
      await this.deps.sql<OrderRow[]>`
        SELECT * FROM trade.futures_spread_orders
         WHERE spread_id = ${order.spread_id} AND id <> ${order.id} AND side <> ${order.side}
           AND status IN ('submitting', 'open', 'submit_unknown')
         ORDER BY created_at, id
      `
    ).filter((m) =>
      crossesSpread({ side: order.side, limit: parseAmount(order.limit_price) }, { side: m.side, limit: parseAmount(m.limit_price) }),
    );
    const window = intersectWindows([windowOf(order), ...crossing.map(windowOf)]);
    const anchor = pickAnchor({ mark: parseAmount(order.leg0_mark), step: anchorStep(listing), window });
    // The engine refuses a whole order when any fill it would print cannot price a leg exactly; refuse that here, typed.
    const prices = (price: string) => anchor !== null && engineLegPrices(listing, anchor, parseAmount(price)) !== null;
    if (anchor === null || !prices(order.limit_price) || !crossing.every((m) => prices(m.limit_price))) {
      await this.deps.sql`
        UPDATE trade.futures_spread_orders
           SET status = 'rejected', refusal_code = ${SPREAD_ANCHOR_UNCOVERED}, engine_filled_qty = 0, updated_at = now()
         WHERE id = ${order.id} AND status = 'held'
      `;
      return { kind: 'uncovered' };
    }

    const claimed = await this.deps.sql<{ id: string }[]>`
      UPDATE trade.futures_spread_orders
         SET status = 'submitting', anchor_ref = ${formatAmount(anchor)}, updated_at = now()
       WHERE id = ${order.id} AND status = 'held'
       RETURNING id
    `;
    if (claimed.length === 0) return { kind: 'view' };

    const request: EngineSpreadSubmitRequest = {
      orderId: order.id,
      accountId: order.user_id,
      side: order.side,
      qty: formatAmount(parseAmount(order.qty)),
      price: formatAmount(parseAmount(order.limit_price)),
      tif: 'GTC',
      anchorReference: formatAmount(anchor),
      clientOrderId: order.client_order_id,
      lifecycleProof: proof,
    };
    try {
      const matching = this.deps.matching as Pick<SpreadMatchingPort, 'submitSpread'>;
      return { kind: 'sent', result: await matching.submitSpread(order.spread_id, request) };
    } catch {
      await this.deps.sql`
        UPDATE trade.futures_spread_orders SET status = 'submit_unknown', updated_at = now()
         WHERE id = ${order.id} AND status = 'submitting'
      `;
      refuse(
        'trade.futures_submit_unknown',
        'the engine did not answer for this order; it is not sent again, and its hold stays until it is reconciled',
        503,
      );
    }
  }

  /**
   * One lock per spread, held on a connection of its own for as long as `fn` runs. A crashed process loses its
   * connection and with it the lock. It is a Postgres advisory lock, so it holds across every instance of this service.
   */
  private async withSpreadLock<T>(spreadId: string, fn: () => Promise<T>): Promise<T> {
    const reserved = await this.deps.sql.reserve();
    const key = `trade.futures_spread:${spreadId}`;
    try {
      await reserved`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
      try {
        return await fn();
      } finally {
        await reserved`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
      }
    } finally {
      reserved.release();
    }
  }

  // ── fills ─────────────────────────────────────────────────────────────────

  /**
   * Settle one engine spread fill into both of its orders, each side as two leg fills. Both sides are checked before
   * either posts: a fill one side cannot take is refused whole, never half-applied.
   */
  async settleFill(input: SpreadFillInput): Promise<void> {
    const fill = parseFill(input);
    const [taker, maker] = [await this.loadOrderOrUnknown(fill.takerOrderId), await this.loadOrderOrUnknown(fill.makerOrderId)];
    await this.assertSideSettles(taker, fill, true);
    await this.assertSideSettles(maker, fill, false);
    await this.applySide(taker, fill, true);
    await this.applySide(maker, fill, false);
  }

  /**
   * Settle a fill, or keep it to settle later. A fill refused only because one of its positions is busy is stored in
   * `trade.futures_spread_fill_waits` and the call returns, so the matching event is acknowledged and nothing depends on
   * it being delivered again. `retryWaitingFills` settles it once the position is free. Anything else is thrown.
   */
  async settleFillOrWait(fill: SpreadFillInput): Promise<'settled' | 'waiting'> {
    try {
      await this.settleFill(fill);
      return 'settled';
    } catch (err) {
      if (!fillMustWait(err)) throw err;
      const p = parseFill(fill);
      await this.deps.sql`
        INSERT INTO trade.futures_spread_fill_waits (
          spread_id, engine_sequence, maker_order_id, taker_order_id, taker_side, price, qty,
          leg0_symbol, leg0_taker_side, leg0_qty, leg0_price, leg1_symbol, leg1_taker_side, leg1_qty, leg1_price, reason
        ) VALUES (
          ${p.spreadId}, ${p.sequence}, ${p.makerOrderId}, ${p.takerOrderId}, ${p.takerSide},
          ${formatAmount(p.price)}, ${formatAmount(p.qty)},
          ${p.legs[0].symbol}, ${p.legs[0].takerSide}, ${formatAmount(p.legs[0].qty)}, ${formatAmount(p.legs[0].price)},
          ${p.legs[1].symbol}, ${p.legs[1].takerSide}, ${formatAmount(p.legs[1].qty)}, ${formatAmount(p.legs[1].price)}, ${err.code}
        )
        ON CONFLICT (spread_id, engine_sequence) DO UPDATE
           SET attempts = trade.futures_spread_fill_waits.attempts + 1, reason = EXCLUDED.reason, retried_at = now()
         WHERE trade.futures_spread_fill_waits.settled_at IS NULL
      `;
      return 'waiting';
    }
  }

  /** Retry the waiting fills: never-retried first, then the longest since its last try. Settling is idempotent per side. */
  async retryWaitingFills(limit: number): Promise<{ settled: number; waiting: number; failed: { sequence: number; message: string }[] }> {
    const rows = await this.deps.sql<WaitRow[]>`
      SELECT spread_id, engine_sequence::text, maker_order_id, taker_order_id, taker_side, price::text, qty::text,
             leg0_symbol, leg0_taker_side, leg0_qty::text, leg0_price::text, leg1_symbol, leg1_taker_side, leg1_qty::text, leg1_price::text
        FROM trade.futures_spread_fill_waits
       WHERE settled_at IS NULL
       ORDER BY retried_at NULLS FIRST, created_at, engine_sequence
       LIMIT ${limit}
    `;
    let settled = 0;
    let waiting = 0;
    const failed: { sequence: number; message: string }[] = [];
    for (const row of rows) {
      const where = this.deps.sql`spread_id = ${row.spread_id} AND engine_sequence = ${row.engine_sequence}`;
      try {
        await this.settleFill({
          spreadId: row.spread_id,
          makerOrderId: row.maker_order_id,
          takerOrderId: row.taker_order_id,
          takerSide: row.taker_side,
          price: formatAmount(parseAmount(row.price)),
          qty: formatAmount(parseAmount(row.qty)),
          sequence: Number(row.engine_sequence),
          legs: [
            {
              symbol: row.leg0_symbol,
              takerSide: row.leg0_taker_side,
              qty: formatAmount(parseAmount(row.leg0_qty)),
              price: formatAmount(parseAmount(row.leg0_price)),
            },
            {
              symbol: row.leg1_symbol,
              takerSide: row.leg1_taker_side,
              qty: formatAmount(parseAmount(row.leg1_qty)),
              price: formatAmount(parseAmount(row.leg1_price)),
            },
          ],
        });
        await this.deps.sql`UPDATE trade.futures_spread_fill_waits SET settled_at = now(), retried_at = now() WHERE ${where}`;
        settled += 1;
      } catch (err) {
        const reason = err instanceof MatchedOrderError ? err.code : 'trade.futures_fill_retry_failed';
        await this.deps.sql`
          UPDATE trade.futures_spread_fill_waits SET attempts = attempts + 1, reason = ${reason}, retried_at = now() WHERE ${where}
        `;
        if (fillMustWait(err)) waiting += 1;
        else failed.push({ sequence: Number(row.engine_sequence), message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { settled, waiting, failed };
  }

  /** What one side's fill must satisfy before anything posts. A side that already has its intent is a replay. */
  private async assertSideSettles(order: OrderRow, fill: ParsedFill, isTaker: boolean): Promise<void> {
    const [prior] = await this.deps.sql<{ n: number }[]>`
      SELECT 1 AS n FROM trade.futures_spread_fills WHERE order_id = ${order.id} AND engine_sequence = ${fill.sequence} LIMIT 1
    `;
    if (prior) return;
    this.assertFillMatchesOrder(order, fill, isTaker);
    for (const leg of [0, 1] as const) {
      const marketId = leg === 0 ? order.leg0_market_id : order.leg1_market_id;
      const side = orderLegSides(order.side, listingOf(order))[leg];
      const [open] = await this.deps.sql<{ id: string }[]>`
        SELECT id FROM trade.positions
         WHERE user_id = ${order.user_id} AND market_id = ${marketId} AND side = ${positionSideOf(side)}
           AND margin_mode = 'isolated' AND status = 'open'
         LIMIT 1
      `;
      if (open) {
        await refuseIfPositionBusy(this.deps.sql, open.id);
        await refuseIfPositionHasPendingFill(this.deps.sql, open.id, 'reduce');
      }
    }
  }

  /**
   * The fill is the fill of this order: the legs are its legs, on the sides it takes, at the quantities its ratios give,
   * summing to the spread price, inside its limit, within what is left to fill, and — the bound that makes the hold
   * enough — no leg prints further from its mark, against this order, than the band half-width the hold includes.
   */
  private assertFillMatchesOrder(order: OrderRow, fill: ParsedFill, isTaker: boolean): void {
    if (order.spread_id !== fill.spreadId) refuse('trade.futures_market_mismatch', 'a spread fill names an order on another spread', 500);
    const listing = listingOf(order);
    const sides = orderLegSides(order.side, listing);
    const legMarkets = [order.leg0_market_id, order.leg1_market_id] as const;
    if (fill.takerSide !== (isTaker ? order.side : opposite(order.side)) || fill.qty <= 0n) {
      refuse(
        SPREAD_FILL_LEGS_MISMATCH,
        `spread fill ${fill.sequence} disagrees with order ${order.id} on its side — this needs an operator`,
        500,
      );
    }
    for (const i of [0, 1] as const) {
      const leg = fill.legs[i];
      const expectedQty = mulExact(fill.qty, listing.legs[i].ratio);
      const expectedTakerSide = isTaker ? sides[i] : opposite(sides[i]);
      if (leg.symbol !== legMarkets[i] || leg.takerSide !== expectedTakerSide || leg.qty !== expectedQty || leg.price <= 0n) {
        refuse(
          SPREAD_FILL_LEGS_MISMATCH,
          `spread fill ${fill.sequence} leg ${i} disagrees with order ${order.id} — this needs an operator`,
          500,
        );
      }
    }
    if (!legsSumToSpread(listing, fill.price, [fill.legs[0].price, fill.legs[1].price])) {
      refuse(SPREAD_FILL_LEGS_MISMATCH, `spread fill ${fill.sequence} legs do not sum to its price — this needs an operator`, 500);
    }
    if (!fillWithinLimit(order.side, fill.price, parseAmount(order.limit_price))) {
      refuse('trade.futures_fill_outside_limit', `spread fill ${fill.sequence} prices outside order ${order.id}'s limit`, 500);
    }
    assertFillFits(order, fill.sequence, fill.qty);
    const terms = termsOf(order);
    for (const i of [0, 1] as const) {
      const step = legFillMargin({
        terms,
        leg: i,
        before: {
          spreadFilled: parseAmount(order.filled_qty),
          adverseNum: BigInt(i === 0 ? order.leg0_adverse_num : order.leg1_adverse_num),
        },
        fillQty: fill.qty,
        legPrice: fill.legs[i].price,
      });
      if (step.outsideCover) {
        refuse(
          SPREAD_FILL_OUTSIDE_COVER,
          `spread fill ${fill.sequence} prints leg ${i} outside the price band the hold of order ${order.id} covers — this needs an operator`,
          500,
        );
      }
    }
  }

  /**
   * One order's share of one spread fill: two leg fills, one intent.
   *
   * TX1 (intent): lock the order, decide each leg's position, store both legs' amounts, commit.
   * POSTS: `futuresOrderMarginApply` per leg under the leg's own key.
   * TX2 (apply): lock the intents, the order and each position; move both rows; mark both intents applied, commit.
   */
  private async applySide(order: OrderRow, fill: ParsedFill, isTaker: boolean): Promise<void> {
    const intents = await this.deps.sql.begin(async (tx) => this.recordIntents(tx, order.id, fill, isTaker));
    if (intents.every((i) => i.state === 'applied')) {
      await this.releaseWhenDone(order.id);
      return;
    }
    for (const intent of intents) {
      const amount = parseAmount(intent.amount);
      if (amount <= 0n) continue;
      await this.deps.ledger.post(
        recipes.futuresOrderMarginApply({
          orderId: order.id,
          userId: order.user_id,
          assetId: order.hold_asset,
          positionId: intent.position_id,
          fillId: intent.fill_key,
          amount,
        }),
      );
    }
    const positionIds = await this.deps.sql.begin(async (tx) => this.applyIntents(tx, order.id, fill.sequence));
    for (const positionId of positionIds) {
      // The fill moved the position's entry and margin, so its bankruptcy price moved: a resting reduce order follows it.
      await this.deps.matched.followPositionAfterGrowth(positionId);
      if (this.deps.publishPosition) {
        try {
          await this.deps.publishPosition(positionId);
        } catch {
          // A notification that fails after a settled fill is not a reason to unsettle it: the position is already right.
        }
      }
    }
    await this.releaseWhenDone(order.id);
  }

  private async recordIntents(tx: TransactionSql, orderId: string, fill: ParsedFill, isTaker: boolean): Promise<LegFillRow[]> {
    const [order] = await tx<OrderRow[]>`SELECT * FROM trade.futures_spread_orders WHERE id = ${orderId} FOR UPDATE`;
    if (!order) refuse('trade.futures_order_not_found', `spread order ${orderId} is not known`, 404);

    const prior = await tx<LegFillRow[]>`
      SELECT * FROM trade.futures_spread_fills WHERE order_id = ${order.id} AND engine_sequence = ${fill.sequence} ORDER BY leg_index
    `;
    if (prior.length === 2) return prior;
    if (prior.length !== 0) refuse('trade.futures_fill_missing', `spread fill ${fill.sequence} of order ${order.id} has one leg only`, 500);

    this.assertFillMatchesOrder(order, fill, isTaker);
    const [pendingOnOrder] = await tx<{ n: number }[]>`
      SELECT 1 AS n FROM trade.futures_spread_fills WHERE order_id = ${order.id} AND state = 'pending' LIMIT 1
    `;
    if (pendingOnOrder) {
      refuse('trade.futures_fill_in_progress', 'an earlier fill of this order is still being recorded — retry in a moment', 409);
    }

    const terms = termsOf(order);
    const sides = orderLegSides(order.side, listingOf(order));
    const rows: Array<{
      leg: 0 | 1;
      marketId: string;
      positionId: string;
      fillKey: string;
      qty: Amount;
      price: Amount;
      amount: Amount;
      newFilled: Amount;
      newAdverse: bigint;
      newApplied: Amount;
    }> = [];
    for (const leg of [0, 1] as const) {
      const marketId = leg === 0 ? order.leg0_market_id : order.leg1_market_id;
      const side = positionSideOf(sides[leg]);
      const [open] = await tx<{ id: string }[]>`
        SELECT id FROM trade.positions
         WHERE user_id = ${order.user_id} AND market_id = ${marketId} AND side = ${side}
           AND margin_mode = 'isolated' AND status = 'open'
         LIMIT 1
         FOR UPDATE
      `;
      let positionId: string;
      if (open) {
        // Under the position's lock, the same lock a rung or an ADL pair takes before it moves the row.
        await refuseIfPositionBusy(tx, open.id);
        await refuseIfPositionHasPendingFill(tx, open.id, 'reduce');
        positionId = open.id;
      } else {
        const [count] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM trade.positions
           WHERE user_id = ${order.user_id} AND market_id = ${marketId} AND side = ${side} AND margin_mode = 'isolated'
        `;
        positionId = matchedSlotPositionIdFor(order.user_id, marketId, side, count?.n ?? 0);
      }
      const step = legFillMargin({
        terms,
        leg,
        before: {
          spreadFilled: parseAmount(order.filled_qty),
          adverseNum: BigInt(leg === 0 ? order.leg0_adverse_num : order.leg1_adverse_num),
        },
        fillQty: fill.qty,
        legPrice: fill.legs[leg].price,
      });
      rows.push({
        leg,
        marketId,
        positionId,
        fillKey: spreadLegFillKey(fill.spreadId, fill.sequence, leg, positionId),
        qty: fill.legs[leg].qty,
        price: fill.legs[leg].price,
        amount: step.amount,
        newFilled: parseAmount(order.filled_qty) + fill.qty,
        newAdverse: step.adverseNum,
        newApplied: step.need,
      });
    }
    assertWithinHold(order, rows[0]!.newApplied + rows[1]!.newApplied, parseAmount(order.released_amount));
    const inserted: LegFillRow[] = [];
    for (const r of rows) {
      const [row] = await tx<LegFillRow[]>`
        INSERT INTO trade.futures_spread_fills (
          fill_key, order_id, spread_id, engine_sequence, leg_index, market_id, position_id,
          spread_qty, qty, price, amount, new_filled, new_adverse, new_applied, state
        ) VALUES (
          ${r.fillKey}, ${order.id}, ${fill.spreadId}, ${fill.sequence}, ${r.leg}, ${r.marketId}, ${r.positionId},
          ${formatAmount(fill.qty)}, ${formatAmount(r.qty)}, ${formatAmount(r.price)}, ${formatAmount(r.amount)},
          ${formatAmount(r.newFilled)}, ${r.newAdverse.toString()}, ${formatAmount(r.newApplied)}, 'pending'
        )
        RETURNING *
      `;
      inserted.push(row!);
    }
    return inserted;
  }

  private async applyIntents(tx: TransactionSql, orderId: string, sequence: number): Promise<string[]> {
    const [order] = await tx<OrderRow[]>`SELECT * FROM trade.futures_spread_orders WHERE id = ${orderId} FOR UPDATE`;
    if (!order) refuse('trade.futures_order_not_found', `spread order ${orderId} is not known`, 404);
    const fills = await tx<LegFillRow[]>`
      SELECT * FROM trade.futures_spread_fills
       WHERE order_id = ${orderId} AND engine_sequence = ${sequence} ORDER BY leg_index FOR UPDATE
    `;
    if (fills.length !== 2) refuse('trade.futures_fill_missing', `spread fill ${sequence} of order ${orderId} has no intent`, 500);
    if (fills.every((f) => f.state === 'applied')) return fills.map((f) => f.position_id);

    const sides = orderLegSides(order.side, listingOf(order));
    for (const fill of fills) {
      const leg = fill.leg_index as 0 | 1;
      const qty = parseAmount(fill.qty);
      const price = parseAmount(fill.price);
      const amount = parseAmount(fill.amount);
      const [row] = await tx<PositionRowLite[]>`
        SELECT id, status, size, entry_price, margin_initial, margin_current
          FROM trade.positions WHERE id = ${fill.position_id} FOR UPDATE
      `;
      if (row) {
        if (row.status !== 'open') {
          refuse(
            'trade.futures_position_not_open',
            `position ${fill.position_id} is ${row.status} while a fill is being recorded — this needs an operator`,
            500,
          );
        }
        const size = parseAmount(row.size);
        const entry = weightedEntry({ size, entryPrice: parseAmount(row.entry_price) }, { qty, price });
        await tx`
          UPDATE trade.positions
             SET size = ${formatAmount(size + qty)},
                 entry_price = ${formatAmount(entry)},
                 margin_initial = ${formatAmount(parseAmount(row.margin_initial) + amount)},
                 margin_current = ${formatAmount(parseAmount(row.margin_current) + amount)},
                 updated_at = now()
           WHERE id = ${row.id}
        `;
      } else {
        await tx`
          INSERT INTO trade.positions (
            id, user_id, market_id, side, status, margin_mode,
            size, entry_price, leverage, margin_initial, margin_current, margin_asset, funding_paid,
            accepted_mark, accepted_mark_at, client_open_id
          ) VALUES (
            ${fill.position_id}, ${order.user_id}, ${fill.market_id}, ${positionSideOf(sides[leg])}, 'open', 'isolated',
            ${formatAmount(qty)}, ${formatAmount(price)}, ${formatAmount(parseAmount(order.leverage))},
            ${formatAmount(amount)}, ${formatAmount(amount)}, ${order.hold_asset}, '0',
            ${leg === 0 ? order.leg0_mark : order.leg1_mark}, ${new Date()}, NULL
          )
        `;
      }
    }

    const f0 = fills[0] as LegFillRow;
    const f1 = fills[1] as LegFillRow;
    const filledNow = parseAmount(f0.new_filled);
    const orderStatus = filledNow === parseAmount(order.qty) ? 'filled' : 'open';
    await tx`
      UPDATE trade.futures_spread_orders
         SET filled_qty = ${f0.new_filled},
             leg0_adverse_num = ${f0.new_adverse}, leg1_adverse_num = ${f1.new_adverse},
             leg0_applied = ${f0.new_applied}, leg1_applied = ${f1.new_applied},
             applied_amount = ${formatAmount(parseAmount(f0.new_applied) + parseAmount(f1.new_applied))},
             status = CASE WHEN status IN ('held', 'submitting', 'open', 'filled', 'submit_unknown') THEN ${orderStatus} ELSE status END,
             updated_at = now()
       WHERE id = ${order.id}
    `;
    await tx`
      UPDATE trade.futures_spread_fills SET state = 'applied', applied_at = now()
       WHERE order_id = ${orderId} AND engine_sequence = ${sequence} AND state = 'pending'
    `;
    return fills.map((f) => f.position_id);
  }

  // ── cancel, release ───────────────────────────────────────────────────────

  /** Cancel a resting order we own, then release the part of its hold that no fill used. */
  async cancel(principal: Principal, orderId: string): Promise<SpreadOrderView> {
    const row = await this.loadOrder(orderId).catch(() => null);
    if (!row || row.user_id !== principal.userId) refuse('trade.futures_order_not_found', `spread order ${orderId} not found`, 404);
    if (!(LIVE_OR_UNKNOWN as readonly string[]).includes(row.status)) {
      await this.releaseWhenDone(orderId);
      return presentOrder(await this.loadOrder(orderId));
    }
    if (!this.deps.matching) refuse('trade.futures_matching_unconfigured', 'the matching engine is not configured', 503);
    const result = await this.deps.matching.cancel(row.spread_id, orderId);
    if (result.cancelled) {
      await this.markLeftBook(orderId, result.cancellation ? parseAmount(result.cancellation.remainingQty) : null);
      await this.releaseWhenDone(orderId);
    }
    return presentOrder(await this.loadOrder(orderId));
  }

  /** The engine says an order has left the book. Releases the unused hold for a spread order; false for anything else. */
  async releaseEngineCancellation(orderId: string, remainingQty: string): Promise<boolean> {
    const rows = await this.deps.sql<{ status: string }[]>`SELECT status FROM trade.futures_spread_orders WHERE id = ${orderId}`;
    if (!rows[0]) return false;
    await this.markLeftBook(orderId, parseAmount(remainingQty));
    await this.releaseWhenDone(orderId);
    return true;
  }

  /** The engine has taken the order off the book. A live state only: a filled order stays filled. First remainder wins. */
  private async markLeftBook(orderId: string, remainingQty: Amount | null): Promise<void> {
    await this.deps.sql`
      UPDATE trade.futures_spread_orders
         SET status = CASE WHEN status IN ('held', 'submitting', 'open', 'submit_unknown') THEN 'cancelled' ELSE status END,
             engine_filled_qty = COALESCE(engine_filled_qty, qty - ${remainingQty == null ? null : formatAmount(remainingQty)}::numeric),
             updated_at = now()
       WHERE id = ${orderId}
    `;
  }

  /**
   * Return the order's unused hold, once the order can no longer fill. Written only when every fill the engine printed
   * for the order has settled and none is pending, and never more than what is left of the hold after the fills.
   */
  private async releaseWhenDone(orderId: string): Promise<void> {
    const order = await this.loadOrder(orderId).catch(() => null);
    if (!order) return;
    if (!(ORDER_TERMINAL as readonly string[]).includes(order.status)) return;
    const final = engineFilled(order);
    if (final == null || parseAmount(order.filled_qty) !== final) return;
    const [pending] = await this.deps.sql<{ n: number }[]>`
      SELECT 1 AS n FROM trade.futures_spread_fills WHERE order_id = ${orderId} AND state = 'pending' LIMIT 1
    `;
    if (pending) return;
    assertWithinHold(order, parseAmount(order.applied_amount), 0n);
    const remainder = holdOf(order) - parseAmount(order.applied_amount);
    if (remainder <= 0n) return;
    if (remainder === parseAmount(order.released_amount)) return;
    await this.deps.ledger.post(
      recipes.futuresOrderMarginRelease({
        orderId,
        userId: order.user_id,
        assetId: order.hold_asset,
        amount: remainder,
        sequence: 0,
      }),
    );
    await this.deps.sql`
      UPDATE trade.futures_spread_orders SET released_amount = ${formatAmount(remainder)}, updated_at = now() WHERE id = ${orderId}
    `;
  }

  // ── liquidation ───────────────────────────────────────────────────────────

  /**
   * What a liquidation asks of spread orders. The simpler sound option is to PULL them: every live spread order of the
   * account that would grow the position comes off the book before the rung, exactly as a matched order does, rather
   * than refusing spread placement while a rung is live (placement already refuses a leg whose position is busy).
   */
  get liquidationPort(): SpreadLiquidationPort {
    return {
      growing: (marketId, accountId) => this.growing(marketId, accountId),
      owns: async (orderId) => (await this.deps.sql`SELECT 1 FROM trade.futures_spread_orders WHERE id = ${orderId}`).length > 0,
      cancelForLiquidation: (orderId) => this.cancelForLiquidation(orderId),
    };
  }

  private async growing(marketId: string, accountId: string): Promise<{ orderId: string; side: OrderSide }[]> {
    if (!UUID.test(marketId)) return [];
    const rows = await this.deps.sql<OrderRow[]>`
      SELECT * FROM trade.futures_spread_orders
       WHERE user_id = ${accountId} AND (leg0_market_id = ${marketId} OR leg1_market_id = ${marketId})
         AND status IN ('held', 'submitting', 'open', 'submit_unknown')
       ORDER BY created_at, id
    `;
    return rows.map((row) => {
      const sides = orderLegSides(row.side, listingOf(row));
      return { orderId: row.id, side: row.leg0_market_id === marketId ? sides[0] : sides[1] };
    });
  }

  /**
   * Take one spread order off the book for a liquidation. `timeout` when the engine did not answer. A `held` order has
   * not been sent: it is cancelled here, before any send can claim it, so it never reaches the book.
   */
  private async cancelForLiquidation(orderId: string): Promise<'cancelled' | 'not_resting' | 'timeout'> {
    const unsent = await this.deps.sql<{ id: string }[]>`
      UPDATE trade.futures_spread_orders
         SET status = 'cancelled', engine_filled_qty = 0,
             refusal_code = COALESCE(refusal_code, 'trade.liquidation_in_progress'), updated_at = now()
       WHERE id = ${orderId} AND status = 'held'
       RETURNING id
    `;
    if (unsent[0]) {
      await this.releaseWhenDone(orderId);
      return 'cancelled';
    }
    const matching = this.deps.matching;
    if (!matching) return 'not_resting';
    const order = await this.loadOrder(orderId);
    let result: Awaited<ReturnType<Pick<MatchingClient, 'cancel'>['cancel']>>;
    try {
      result = await matching.cancel(order.spread_id, order.id);
    } catch {
      return 'timeout';
    }
    if (!result.cancelled) return 'not_resting';
    await this.deps.sql`
      UPDATE trade.futures_spread_orders SET refusal_code = 'trade.liquidation_in_progress', updated_at = now()
       WHERE id = ${order.id} AND refusal_code IS NULL
    `;
    await this.markLeftBook(order.id, result.cancellation ? parseAmount(result.cancellation.remainingQty) : null);
    await this.releaseWhenDone(order.id);
    return 'cancelled';
  }

  // ── loads ─────────────────────────────────────────────────────────────────

  private async loadOrder(orderId: string): Promise<OrderRow> {
    const [row] = await this.deps.sql<OrderRow[]>`SELECT * FROM trade.futures_spread_orders WHERE id = ${orderId}`;
    if (!row) refuse('trade.futures_order_not_found', `spread order ${orderId} not found`, 404);
    return row;
  }

  private async loadOrderOrUnknown(orderId: string): Promise<OrderRow> {
    const [row] = await this.deps.sql<OrderRow[]>`SELECT * FROM trade.futures_spread_orders WHERE id = ${orderId}`;
    if (!row) refuse(SPREAD_FILL_UNKNOWN_ORDER, `a spread fill names order ${orderId}, which this service did not place`, 500);
    return row;
  }

  private async findByClientId(userId: string, spreadId: string, clientOrderId: string): Promise<OrderRow | null> {
    const [row] = await this.deps.sql<OrderRow[]>`
      SELECT * FROM trade.futures_spread_orders
       WHERE user_id = ${userId} AND spread_id = ${spreadId} AND client_order_id = ${clientOrderId}
    `;
    return row ?? null;
  }
}

function refusalStatus(code: string): number {
  return Object.values(ENGINE_REFUSALS).find((r) => r.code === code)?.status ?? 409;
}
