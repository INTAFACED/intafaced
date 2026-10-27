/**
 * FUTURES ORDERS THROUGH svc-matching (docs/adr/2026-10-20-futures-matched-traders.md slice 6, phase 1).
 *
 * A futures order is a market in the one order book, exactly as spot is. This service:
 *
 *   · PLACES an order: refuses outside the owner's price band, gives a market order a protective limit at the
 *     band edge, locks the order's margin (`futuresOrderMarginHold`) and only then submits it, with the band as
 *     the engine's collar;
 *   · SETTLES each fill into both sides' position rows: the fill moves margin from the order's hold into the
 *     position's collateral (`futuresOrderMarginApply`), grows or opens the user's open row, and is keyed so a
 *     replay posts nothing and moves no row twice;
 *   · RELEASES the unused hold when an order is finished (filled, cancelled or rejected), with
 *     `futuresOrderMarginRelease`.
 *
 * REDUCE-ONLY ORDERS (slice 6b). A reduce-only order names the caller's open isolated position on the other side,
 * locks no margin, and may not ask for more than that position's size less its other live reduce-only orders. Its
 * limit may not be past the position's bankruptcy price, and a market reduce gets that price (pulled in to the
 * band edge) as its limit, so a voluntary reduce never loses more than the margin (ADR section 1). Its fill closes
 * that quantity of the position at the fill price: the margin share is returned, a loss goes into the clearing pot,
 * a profit is paid from the clearing pot or owed until it holds it (ADR sections 3 and 4).
 *
 * The engine's own `reduceOnly` flag is NOT relied on. svc-matching checks it against the account's net of fills
 * in its book (`positionQty` is not on the wire), which is not the margin book: a liquidation rung or an ADL pair
 * moves a position here without a fill there, and in hedge mode a long and a short net to zero, so the engine would
 * refuse a legitimate reduce. The reduce bound is checked here, under the position's row lock, and again on fill.
 *
 * ONE-WAY MODE. An opening order on the side opposite an open position (or opposite a live opening order) refuses
 * at placement: in one-way mode a position is net, and a fill that opened a second row on the other side would
 * break it. Hedge mode keeps one row per side (`position-mode.ts`, `account-mode.ts`), so it is allowed there.
 *
 * THE SWITCH. `enabled` gates NEW orders only. Settling a fill, and releasing a hold, keep running when it is
 * off, because a fill the engine has already matched is final and a hold that is not released strands the
 * trader's margin. A kill switch that traps funds is not a safety control.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY MONEY STEP, ITS KEY, AND WHAT STRANDS IF IT CRASHES THERE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   hold      `futures.order.margin.hold:<orderId>`    order row `pending`, then `held`. A crash after the post
 *                                                      and before `held`: the retry posts the same key, which
 *                                                      returns the original, and the order continues. The
 *                                                      hold is the trader's own available balance, not stranded.
 *   submit    no money. A transport failure leaves the hold in place and the row `submit_unknown`; the order is
 *             not sent again, so nothing double-submits. Engine fills still settle through the event path.
 *   fill      `futures.fill:<fillKey>`. The fill intent (`futures_order_fills`, state `pending`) is committed
 *             BEFORE the post and holds its position: a close, a liquidation or a margin change on that position
 *             refuses until the fill is `applied`. A crash after the post and before the row update: the intent
 *             is still `pending`, so the retry replays the same key with the same stored amount and finishes.
 *   release   `futures.order.margin.release:<orderId>:0`. Written only when the engine has said how much the order
 *             filled in all (its cancel reply or cancellation event names the remainder), every one of those fills
 *             has settled, and none is pending. A fill printed before a cancel can arrive after it; it still finds
 *             its margin in the hold. Set from the order's own numbers, so a crash after the post replays the same key.
 *
 *   reduce    one fill, three legs, all keyed off the intent's key `<marketId>:<sequence>:<positionId>`:
 *             `futures.profit:fill:<key>:profit` (through the payout bound: paid, or a `payout_pending` row the payout
 *             tick pays later), `futures.loss:fill:<key>:loss` (into the clearing pot), and
 *             `futures.margin.release:<positionId>:fill:<key>:release` (the rest of the margin share). The intent row,
 *             and the payout row for a profit, are committed BEFORE the first post and hold the position exactly as an
 *             opening fill's intent does. A crash after any post: the retry replays the same keys with the stored
 *             amounts, so each leg posts once, and only then is the position row shrunk (or closed).
 *
 * Nothing here holds a balance. Every amount is recomputed from the order row, the intent row, or the ledger.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, recipes, userAvailable, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { EngineSubmitRequest, EngineSubmitResult, MatchingClient } from '../spot/matching-client.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { checkCloseQuantity } from './desk-quantity.js';
import { checkLeverage, LEVERAGE_STEP } from './initial-margin.js';
import { checkCollateralClassForMargin, checkMarginModeForFuturesOpen, UNSUPPORTED_COLLATERAL_CLASS } from './margin-mode.js';
import { HAIRCUT_CREDIT_SHORT, HAIRCUT_UNSET } from './haircut-credit.js';
import { checkOpenAdmission, LIMIT_MAX_ORDER, limitAmount, PRETRADE_LIMIT_HTTP_STATUS, resolveAdmissionLimits } from './pretrade-limits.js';
import { assertDatedFuturesTradable } from './dated-futures.js';
import { CLEARING_POT_SHORT, isInsufficientFunds, payOrOweProfit } from './futures-payouts.js';
import type { DerivativesAccessGate } from './derivatives-access.js';
import { unconfirmedTierRefusal, type RiskTierCrossing } from './risk-tier-confirm.js';
import { OI_LIMIT_UNSET, openInterestRefusal, type OpenInterestRoom } from './open-interest-limits.js';
import { checkInsuranceBound, INSURANCE_UNDERFUNDED, recipeInsuranceAccount } from './insurance-bound.js';
import { matchedOrderIdFor, matchedSlotPositionIdFor } from './ids.js';
import { defaultLiquidationId } from './liquidation-tick.js';
import type { LiquidationBookInput, LiquidationBookResult, MatchedLiquidationPort } from './matched-liquidation.js';
import type { IncreasingOrderBook } from './liquidation-tick.js';
import {
  FUTURES_PRICE_BAND_UNSET,
  bankruptcyPrice,
  feeSplit,
  fillFee,
  fillMargin,
  fillWithinLimit,
  limitWithinBand,
  liquidationLimit,
  marketReduceLimit,
  orderFeeReserve,
  orderHoldAmount,
  planLiquidationFill,
  planLiquidationSettlement,
  planReduceFill,
  bandFractionOf,
  priceBandAround,
  liquidationSettlementRoot,
  protectiveLimit,
  marketOpenLimit,
  correctToBand,
  splitPlan,
  SPLIT_MAX_CHILDREN,
  honouredSlippageCapBps,
  reduceFillProfitId,
  reduceFillRecipes,
  reducingSide,
  weightedEntry,
  withinBankruptcy,
  type FeeRates,
  type FeeRole,
  type OrderSide,
  liquidationClientOrderId,
  type PositionSide,
  type PriceBand,
} from './matched-order-plan.js';
import { assertEmailProved, type EmailProofSource } from '../spot/email-proof.js';
import { FeeScheduleError } from '../spot/fee-schedule.js';

/** A refusal with a typed code. Shaped like `FuturesError` so the edge can map it the same way. */
export class MatchedOrderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'MatchedOrderError';
  }
}

/**
 * The refusals that mean "not yet": a position is being liquidated, deleveraged, reviewed or having its margin
 * adjusted, an earlier fill on the same order or position is still being recorded, or a reduce loss past the bound
 * waits for the insurance fund. A fill refused with one of these waits in `trade.futures_fill_waits`.
 */
export const FILL_WAIT_CODES: readonly string[] = [
  'trade.liquidation_in_progress',
  'trade.position_under_review',
  'trade.futures_fill_in_progress',
  'trade.margin_adjustment_in_progress',
  INSURANCE_UNDERFUNDED,
];

function fillMustWait(err: unknown): err is MatchedOrderError {
  return err instanceof MatchedOrderError && FILL_WAIT_CODES.includes(err.code);
}

/** How many waiting fills one retry tick takes. A batch size, not a limit on anyone: the rest go on the next tick. */
export const MATCHED_FILL_RETRY_BATCH = 200;

/** A fill that pairs a matched futures order with an order from the spot path. Neither path can settle it. */
export const FUTURES_FILL_CROSSES_ORDER_PATHS = 'trade.futures_fill_crosses_order_paths';

/** A reduce-only order with no open isolated position on the other side of the market to reduce. */
export const FUTURES_REDUCE_ONLY_NO_POSITION = 'trade.futures_reduce_only_no_position';
/** A reduce-only order larger than its position less the position's other live reduce-only orders. */
export const FUTURES_REDUCE_ONLY_EXCEEDS_POSITION = 'trade.futures_reduce_only_exceeds_position';
/** A reduce-only limit past the position's bankruptcy price: the fill could lose more than the margin. */
export const FUTURES_REDUCE_PAST_BANKRUPTCY = 'trade.futures_reduce_past_bankruptcy';
/** A market reduce whose bankruptcy price lies beyond the whole band: no price in the band is inside the bound. */
export const FUTURES_REDUCE_BANKRUPTCY_OUTSIDE_BAND = 'trade.futures_reduce_bankruptcy_outside_band';
/** In one-way mode, an opening order on the side opposite an open position or a live opening order. */
export const FUTURES_ONE_WAY_FLIP_REFUSED = 'trade.futures_one_way_flip_refused';
/** A reduce fill whose position is no longer open, or no longer as large as the fill. Needs an operator. */
export const FUTURES_REDUCE_FILL_UNMATCHED = 'trade.futures_reduce_fill_unmatched';

export const MATCHED_ORDER_STATUSES = [
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
export type MatchedOrderStatus = (typeof MATCHED_ORDER_STATUSES)[number];

export interface PlaceMatchedOrderInput {
  readonly userId: string;
  /** Market symbol, e.g. BTC/USDT-PERP. Must be kind `futures` and active. */
  readonly symbol: string;
  readonly side: OrderSide;
  readonly type: 'limit' | 'market';
  readonly qty: Amount;
  /** Required for a limit order, and refused on a market order: the protective limit is the band's edge. */
  readonly limitPrice?: Amount;
  readonly leverage: Amount;
  readonly clientOrderId: string;
  readonly reduceOnly?: boolean;
  readonly marginMode?: 'isolated';
  /** What the margin is posted from. Omitted is cash in the market's settle asset; any other class refuses. */
  readonly collateralClass?: unknown;
  /**
   * A limit outside the price band: `reject` (the default) refuses it; `adjust` moves it to the nearer band edge and
   * the order rests or fills there. Any other value refuses.
   */
  readonly priceCorrection?: unknown;
  /**
   * The highest margin tier the trader has accepted for this order (`risk-tier-confirm.ts`). An opening order that
   * would carry its side into a higher tier than it sits in now refuses `trade.risk_limit_confirm_required` naming
   * the tier, until this names it. Not part of the request's identity: a retry with it finds the same order.
   */
  readonly confirmTier?: number;
}

/** What a split request placed: every child, in order, and the refusal that stopped it early, if one did. */
export interface SplitPlacement {
  readonly parts: number;
  readonly orders: MatchedOrderView[];
  /** The child (1-based) a typed refusal stopped at; the children before it are live. Null when every child placed. */
  readonly stopped: { readonly child: number; readonly code: string; readonly message: string } | null;
}

export interface MatchedOrderView {
  readonly orderId: string;
  /** The caller's own request id: a client that lost the answer finds its order by it without sending again. */
  readonly clientOrderId: string;
  readonly marketId: string;
  readonly userId: string;
  readonly side: OrderSide;
  readonly type: 'limit' | 'market';
  readonly qty: string;
  readonly limitPrice: string;
  readonly markPrice: string;
  readonly bandLow: string;
  readonly bandHigh: string;
  /** The whole hold the order locked: its margin and, for an opening order, its fee reserve. */
  readonly holdAmount: string;
  readonly filledQty: string;
  readonly appliedAmount: string;
  readonly releasedAmount: string;
  /** What the order's fills paid in trading fees from its hold, so held = holdAmount − applied − feesPaid − released. */
  readonly feesPaid: string;
  readonly status: MatchedOrderStatus;
  readonly refusalCode: string | null;
  readonly reduceOnly: boolean;
  /** The position a reduce-only order shrinks; null for an opening order. */
  readonly positionId: string | null;
  /** The bankruptcy price a reduce-only order was bounded by at placement; null for an opening order. */
  readonly bankruptcyPrice: string | null;
}

/** One order's share of one engine fill, and which side of it the order was on. */
interface FillShare {
  readonly marketId: string;
  readonly orderId: string;
  readonly sequence: number;
  readonly price: Amount;
  readonly qty: Amount;
  readonly role: FeeRole;
}

/** One engine fill, as the event carries it. Both sides are futures orders on a futures market. */
export interface MatchedFillEvent {
  readonly marketId: string;
  readonly makerOrderId: string;
  readonly takerOrderId: string;
  readonly price: string;
  readonly qty: string;
  readonly sequence: number;
}

export interface MatchedOrdersDeps {
  readonly sql: Sql;
  readonly ledger: LedgerClient;
  /** Null when the engine is not configured on this deployment. New orders refuse; settlement still runs. */
  readonly matching: MatchingClient | null;
  /** TRADE_FUTURES_MATCHING_ENABLED. OFF refuses new orders only. */
  readonly enabled: boolean;
  /** The owner's band as a fraction of the mark. Null is unset, and refuses new orders. */
  readonly priceBand: Amount | null;
  /**
   * The band a new order on a market is held to now (`dynamic-price-band.ts`): the static band, or wider while the
   * operator's dynamic range has widened it. Absent holds every order to the static band.
   */
  readonly priceBandFor?: (marketId: string) => Promise<Amount>;

  /** The owner's leverage cap. Null is unset, and refuses. */
  readonly maxLeverage: Amount | null;
  readonly now: () => Date;
  /** The price a futures order is read against. Required and never supplied by the caller. */
  readonly markFor: (marketId: string, symbol: string, at: Date, size: Amount | null) => Promise<Amount>;
  /** Refuses a NEW order on a position that has a liquidation rung, a planned ADL pair or a review hold. */
  readonly assertPositionIdle: (positionId: string) => Promise<void>;
  /**
   * D-account-07: the identity-level gate, the same one the at-mark open runs. Null when the deployment wires none
   * (tests); production always wires it.
   */
  readonly assertDerivativesAccess?: DerivativesAccessGate | null;
  /** The same email-proof gate as every other new order (RC-identity-01). Absent refuses an opening order. */
  readonly emailProof?: EmailProofSource;
  /**
   * The door an opening order answers to beyond the access gate, the same one the at-mark open ran: the futures
   * exposure switch. Run after the client-order-id replay; never for a reduce-only order.
   */
  readonly assertOpeningAllowed?: (userId: string) => Promise<void>;
  /** The PX-S01 lifecycle proof for a PLACE on this market. Null is unset, and refuses. */
  readonly lifecycleProof: ((marketId: string) => Promise<LifecycleAdmissionProof>) | null;
  readonly admission?: TradingAdmissionPort;
  /** Publishes the private positions update after a fill commits. Best effort: it never undoes a settled fill. */
  readonly publishPosition?: (positionId: string) => Promise<void>;
  /**
   * The perpetual maker and taker rates this account pays now (`perpetualFeeRates`: the owner's published schedule
   * less the account's rank discount). An order keeps what this returned when it was accepted. Null is unwired and
   * refuses an opening order; an unpublished schedule refuses it with the schedule's own code.
   */
  readonly feeRates: ((userId: string) => Promise<FeeRates>) | null;
  /**
   * The owner's collateral haircut on an opening order's hold (`TRADE_COLLATERAL_HAIRCUT_BPS`): the account's posted
   * cash, cut by the haircut, must cover every margin it has committed, which counts every live order's hold including
   * the one being placed (its row is written first). Blank refuses `trade.haircut_unset`; short refuses
   * `trade.haircut_credit_short`. Absent in tests that do not wire it; production always wires it (PositionService).
   */
  readonly assertCollateralCredit?: (input: { userId: string; asset: string; additionalHold?: Amount }) => Promise<void>;
  /**
   * The slippage cap of a market open, in bps of the mark: the operator's per-market cap, else the owner's
   * `TRADE_MARKET_SLIPPAGE_CAP_BPS`, as spot reads it. Null is unset, and every market open refuses
   * `trade.slippage_cap_unset`; a set cap brings the protective limit nearer the mark than the band edge when tighter.
   * Absent in tests that do not wire it (the band edge alone); production always wires it.
   */
  readonly slippageCapBps?: (marketId: string) => Promise<number | null>;
  /**
   * The margin tier the side's exposure sits in now and would sit in with `qty` more, at `mark` against today's depth
   * (`PositionService.riskTierCrossing`). Throws a typed refusal when the ladder is unset or the depth unreadable.
   * Absent in tests that do not wire it; production always wires it.
   */
  readonly riskTier?: (input: {
    readonly userId: string;
    readonly marketId: string;
    readonly symbol: string;
    readonly side: PositionSide;
    readonly qty: Amount;
    readonly mark: Amount;
    /** Once the order's row is written: that row, left out of the exposure since `qty` is that order. */
    readonly excludeOrderId?: string;
    /** The depth an earlier rating in the same request read; absent reads it now. */
    readonly depthNotional?: Amount;
  }) => Promise<RiskTierCrossing>;
  /**
   * The open-interest room this account has on the market (`PositionService.openInterestRoom`), from the operator's
   * per-market limits. Throws `trade.oi_limit_unset` when either limit is blank. Absent in tests that do not wire it;
   * production always wires it.
   */
  readonly openInterest?: (input: {
    readonly userId: string;
    readonly marketId: string;
    readonly symbol: string;
    readonly lotSize: Amount | null;
    /** Once the order's row is written: that row, left out of what is committed, since it is the order being rated. */
    readonly excludeOrderId?: string;
  }) => Promise<OpenInterestRoom>;
}

/** What an opening order's request said about margin tiers, carried to the rating after its row is written. */
interface TierContext {
  readonly confirmTier?: number | undefined;
  readonly depthNotional?: Amount | undefined;
}

export interface OrderRow {
  id: string;
  user_id: string;
  market_id: string;
  client_order_id: string;
  side: OrderSide;
  order_type: 'limit' | 'market';
  qty: string;
  limit_price: string;
  mark_price: string;
  band_low: string;
  band_high: string;
  leverage: string;
  hold_asset: string;
  filled_qty: string;
  adverse_num: string;
  applied_amount: string;
  released_amount: string;
  engine_filled_qty: string | null;
  status: MatchedOrderStatus;
  refusal_code: string | null;
  reduce_only: boolean;
  position_id: string | null;
  bankruptcy_price: string | null;
  /** The matched liquidation rung this order works for (slice 7); null for every trader's order. */
  liquidation_rung_id: string | null;
  /** The listing's published rates when the order was accepted (migration 0099). Zero on an older order. */
  maker_fee_bps: string;
  taker_fee_bps: string;
  /** What this opening order's fills have paid in fees from its hold so far. Zero on a reduce-only order. */
  fee_charged: string;
}

interface FillRow {
  fill_key: string;
  order_id: string;
  market_id: string;
  engine_sequence: string;
  position_id: string;
  qty: string;
  price: string;
  amount: string;
  new_filled: string;
  new_adverse: string;
  new_applied: string;
  state: 'pending' | 'applied';
  kind: 'open' | 'reduce';
  realized_pnl: string | null;
  loss_from_margin: string | null;
  loss_from_insurance: string | null;
  loss_unbooked: string | null;
  profit: string | null;
  margin_release: string | null;
  pot_out: string | null;
  initial_out: string | null;
  closes_position: boolean | null;
  /** The fee this fill paid, and the part its source could not cover (recorded, never posted). */
  fee: string;
  fee_waived: string;
  fee_role: FeeRole | null;
}

interface PositionRowLite {
  id: string;
  user_id: string;
  market_id: string;
  side: PositionSide;
  status: string;
  size: string;
  entry_price: string;
  leverage: string;
  margin_initial: string;
  margin_current: string;
  margin_asset: string;
  margin_adjust_request: string | null;
}

interface MarketRow {
  id: string;
  symbol: string;
  kind: string;
  status: string;
  base_asset: string;
  quote_asset: string;
  lot_size: string | null;
  futures_contract_style: 'perpetual' | 'dated' | null;
  futures_expiry_at: Date | null;
  futures_settlement_fixing: string | null;
}

const ORDER_TERMINAL = ['filled', 'cancelled', 'rejected'] as const;

function lotOf(market: MarketRow): Amount | null {
  return market.lot_size == null ? null : parseAmount(market.lot_size);
}

/**
 * A matched futures order id is a uuid. The engine also names orders that are not (spot OCO legs are
 * `<parentId>:tp` and `<parentId>:sl`), and comparing one of those with the uuid column fails in Postgres (22P02)
 * before the spot path runs, so the routing lookups only ask about ids that can be ours.
 */
const ORDER_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mayBeMatchedOrderId = (id: string): boolean => ORDER_ID_UUID.test(id);
/** States in which the order may still be live at the engine, so a cancel must ask it. */
const LIVE_OR_UNKNOWN = ['held', 'submitting', 'open', 'submit_unknown'] as const;

/**
 * The hold the order locked at placement, from its own terms. It is never stored as a figure: the ledger hold is
 * the money, and these terms are what it was opened for.
 */
/** What an opening order holds once accepted: its margin and its fee reserve, from the row. */
export function holdOf(order: OrderRow): Amount {
  return marginHoldOf(order) + feeReserveOf(order);
}

/** The margin part of the hold: what the order's fills can move into the position's pot. */
function marginHoldOf(order: OrderRow): Amount {
  // A reduce-only order locks nothing: what it can lose is bounded by its position's bankruptcy price instead.
  if (order.reduce_only) return 0n;
  return orderHoldAmount({
    side: order.side,
    qty: parseAmount(order.qty),
    limit: parseAmount(order.limit_price),
    mark: parseAmount(order.mark_price),
    leverage: parseAmount(order.leverage),
  });
}

/** The rates the order kept from its listing when it was accepted. */
function ratesOf(order: OrderRow): FeeRates {
  return { makerBps: Number(order.maker_fee_bps), takerBps: Number(order.taker_fee_bps) };
}

/** The fee part of the hold: the most the order's fills can owe at its rates (`orderFeeReserve`). */
function feeReserveOf(order: OrderRow): Amount {
  if (order.reduce_only) return 0n;
  return orderFeeReserve({
    side: order.side,
    qty: parseAmount(order.qty),
    limit: parseAmount(order.limit_price),
    bandHigh: parseAmount(order.band_high),
    rates: ratesOf(order),
  });
}

/**
 * What fills applied, what they paid in fees and what was released never exceed what the order locked, and neither
 * part borrows from the other: margin stays within the margin part and fees within the fee reserve. The hold is
 * derived from the order's stored terms, so this is the check a stored hold column used to give; it runs before every
 * apply or release.
 */
function assertWithinHold(order: OrderRow, applied: Amount, feeCharged: Amount, released: Amount): void {
  if (applied <= marginHoldOf(order) && feeCharged <= feeReserveOf(order) && applied + feeCharged + released <= holdOf(order)) return;
  refuse('trade.futures_hold_exceeded', `order ${order.id} would use more than the margin it holds`, 500);
}

/**
 * How much of the order the engine filled in all, or null while that is not known. A cancel or a cancellation
 * event says it (qty less the remainder); a fill can still arrive after it, because the engine printed the fill
 * before the cancel and the event or reply carrying it is slower.
 */
function engineFilled(order: OrderRow): Amount | null {
  if (order.status === 'filled') return parseAmount(order.qty);
  return order.engine_filled_qty == null ? null : parseAmount(order.engine_filled_qty);
}

/**
 * Refuses a fill the order cannot take: more than the engine says it filled, or more than the order. A fill past
 * a released hold names the release, since nothing is left to fund it from.
 */
function assertFillFits(order: OrderRow, sequence: number, qty: Amount): void {
  const cap = engineFilled(order) ?? parseAmount(order.qty);
  if (parseAmount(order.filled_qty) + qty <= cap) return;
  if (parseAmount(order.released_amount) > 0n) {
    refuse(
      'trade.futures_hold_released',
      `order ${order.id} is ${order.status}: its hold was released, so a later fill cannot be funded — this needs an operator`,
      409,
    );
  }
  refuse('trade.futures_overfill', `fill ${sequence} would overfill order ${order.id}`, 500);
}

/**
 * A reduce fill needs its position open and at least as large as the fill. Placement keeps every reduce order
 * inside its position, so this only fails when the position was shrunk or closed some other way (a liquidation rung
 * or an ADL pair) while the order rested. The fill is final in the book and has no margin to open anything with, so
 * it is refused whole for an operator rather than settled half.
 */
function assertReduceFillFits(
  order: OrderRow,
  position: { id: string; status: string; size: string } | undefined,
  sequence: number,
  qty: Amount,
): asserts position is { id: string; status: string; size: string } {
  if (!position || position.status !== 'open') {
    refuse(
      FUTURES_REDUCE_FILL_UNMATCHED,
      `reduce fill ${sequence} of order ${order.id}: position ${order.position_id} is ${position?.status ?? 'missing'} — this needs an operator`,
      500,
    );
  }
  if (qty > parseAmount(position.size)) {
    refuse(
      FUTURES_REDUCE_FILL_UNMATCHED,
      `reduce fill ${sequence} of order ${order.id} is larger than position ${position.id} — this needs an operator`,
      500,
    );
  }
}

function positionSideOf(side: OrderSide): 'long' | 'short' {
  return side === 'buy' ? 'long' : 'short';
}

function presentOrder(row: OrderRow): MatchedOrderView {
  return {
    orderId: row.id,
    clientOrderId: row.client_order_id,
    marketId: row.market_id,
    userId: row.user_id,
    side: row.side,
    type: row.order_type,
    qty: formatAmount(parseAmount(row.qty)),
    limitPrice: formatAmount(parseAmount(row.limit_price)),
    markPrice: formatAmount(parseAmount(row.mark_price)),
    bandLow: formatAmount(parseAmount(row.band_low)),
    bandHigh: formatAmount(parseAmount(row.band_high)),
    holdAmount: formatAmount(holdOf(row)),
    filledQty: formatAmount(parseAmount(row.filled_qty)),
    appliedAmount: formatAmount(parseAmount(row.applied_amount)),
    releasedAmount: formatAmount(parseAmount(row.released_amount)),
    feesPaid: formatAmount(parseAmount(row.fee_charged)),
    status: row.status,
    refusalCode: row.refusal_code,
    reduceOnly: row.reduce_only,
    positionId: row.position_id,
    bankruptcyPrice: row.bankruptcy_price == null ? null : formatAmount(parseAmount(row.bankruptcy_price)),
  };
}

function refuse(code: string, message: string, status = 400): never {
  throw new MatchedOrderError(message, code, status);
}

/**
 * A fill may not grow a position that a liquidation rung, a planned ADL pair or a review hold is working on. The
 * refusal is a 409: the event is redelivered, and once the rung or pair has finished the fill lands (on the same row,
 * or on a new one if the row was closed). The codes are the ones the position service uses for the same states.
 *
 * `ownRungId` is the liquidation rung the filling order works for (slice 7). That rung's live state does not hold its
 * own fill back: the rung exists to get exactly that fill into the row. Every other fill on the position still waits,
 * and since a position has at most one live rung, nothing else is let through.
 */
async function refuseIfPositionBusy(sql: Sql | TransactionSql, positionId: string, ownRungId: string | null = null): Promise<void> {
  const [hold] = await sql<{ live_rung: boolean; adl_planned: boolean; parked: boolean; adjusting: boolean }[]>`
    SELECT
      EXISTS (SELECT 1 FROM trade.positions p
               WHERE p.id = ${positionId} AND p.margin_adjust_request IS NOT NULL) AS adjusting,
      EXISTS (SELECT 1 FROM trade.liquidation_rungs r
               WHERE r.position_id = ${positionId} AND r.state IN ('planned', 'posted')
                 AND r.rung_id IS DISTINCT FROM ${ownRungId}::uuid) AS live_rung,
      EXISTS (SELECT 1 FROM trade.futures_adl_pairs q
               WHERE q.state = 'planned' AND (q.bankrupt_position_id = ${positionId} OR q.candidate_position_id = ${positionId})) AS adl_planned,
      (COALESCE((SELECT r.state FROM trade.liquidation_rungs r WHERE r.position_id = ${positionId}
                  ORDER BY r.created_at DESC, r.rung_id DESC LIMIT 1), '') = 'abandoned'
        OR EXISTS (SELECT 1 FROM trade.liquidation_attempts a WHERE a.liquidation_id = ${defaultLiquidationId(positionId)})) AS parked
  `;
  if (hold?.live_rung || hold?.adl_planned) {
    refuse('trade.liquidation_in_progress', `position ${positionId} is being liquidated or deleveraged — the fill waits for it`, 409);
  }
  if (hold?.parked) {
    refuse('trade.position_under_review', `position ${positionId} is under review — the fill waits until support resolves it`, 409);
  }
  // A leverage change or margin add or release between its ledger post and its row write sets the row's margin to an
  // absolute figure when it finishes. A fill that moved the row in between would be overwritten, so it waits.
  if (hold?.adjusting) {
    refuse(
      'trade.margin_adjustment_in_progress',
      `position ${positionId} has a margin adjustment in flight — the fill waits until it finishes`,
      409,
    );
  }
}

/** What a liquidation order's applied fills did so far (`planLiquidationFill`). */
async function liquidationFillsSoFar(
  sql: Sql | TransactionSql,
  orderId: string,
): Promise<{ qty: Amount; pnl: Amount; fromMargin: Amount }> {
  const [row] = await sql<{ qty: string; pnl: string; from_margin: string }[]>`
    SELECT COALESCE(sum(qty), 0)::text AS qty, COALESCE(sum(realized_pnl), 0)::text AS pnl,
           COALESCE(sum(loss_from_margin), 0)::text AS from_margin
      FROM trade.futures_order_fills
     WHERE order_id = ${orderId} AND kind = 'reduce' AND state = 'applied'
  `;
  return { qty: parseAmount(row!.qty), pnl: parseAmount(row!.pnl), fromMargin: parseAmount(row!.from_margin) };
}

/** Any fill intent on this position still being recorded. A reduce waits for every one; an opening fill waits for a reduce. */
async function refuseIfPositionHasPendingFill(tx: Sql | TransactionSql, positionId: string, kind: 'any' | 'reduce'): Promise<void> {
  const [pending] = await tx<{ n: number }[]>`
    SELECT 1 AS n FROM trade.futures_order_fills
     WHERE position_id = ${positionId} AND state = 'pending' AND (${kind} = 'any' OR kind = 'reduce')
     LIMIT 1
  `;
  if (pending) {
    refuse('trade.futures_fill_in_progress', `another fill on position ${positionId} is still being recorded — retry in a moment`, 409);
  }
}

/**
 * What the position's live reduce-only orders can still take from it: each one's quantity less what has already
 * settled, or, once it has left the book, what the engine says it filled less what has settled (a fill printed
 * before a cancel still arrives). Refused and rejected orders claim nothing.
 */
export async function reservedReduceQty(tx: Sql | TransactionSql, positionId: string): Promise<Amount> {
  const rows = await tx<{ qty: string; filled_qty: string; engine_filled_qty: string | null; status: string }[]>`
    SELECT qty, filled_qty, engine_filled_qty, status FROM trade.futures_orders
     WHERE position_id = ${positionId} AND reduce_only AND status NOT IN ('refused', 'rejected')
  `;
  let reserved = 0n;
  for (const r of rows) {
    const cap =
      r.status === 'filled' ? parseAmount(r.qty) : r.engine_filled_qty == null ? parseAmount(r.qty) : parseAmount(r.engine_filled_qty);
    const left = cap - parseAmount(r.filled_qty);
    if (left > 0n) reserved += left;
  }
  return reserved;
}

/**
 * What a book order has closed so far (`settled`) and what the engine says it filled in all (`engine`, null while
 * that is not known). A fill printed before a cancel can still be settling, so the two agree only once it has landed.
 */
export async function orderFills(tx: Sql | TransactionSql, orderId: string): Promise<{ settled: Amount; engine: Amount | null } | null> {
  const [row] = await tx<OrderRow[]>`SELECT * FROM trade.futures_orders WHERE id = ${orderId}`;
  return row ? { settled: parseAmount(row.filled_qty), engine: engineFilled(row) } : null;
}

function oppositeSide(side: PositionSide): PositionSide {
  return side === 'long' ? 'short' : 'long';
}

interface WaitRow {
  market_id: string;
  engine_sequence: string;
  maker_order_id: string;
  taker_order_id: string;
  price: string;
  qty: string;
}

/** Leverage is stored as numeric(8,2). A value with finer precision would be rounded in the row, not in the hold. */

export class MatchedFuturesOrders {
  constructor(private readonly deps: MatchedOrdersDeps) {}

  /** The band a new order on this market is held to: the dynamic range's band in force, else the owner's static band. */
  private async bandInForce(marketId: string, staticBand: Amount): Promise<Amount> {
    return this.deps.priceBandFor ? this.deps.priceBandFor(marketId) : staticBand;
  }

  /** Whether NEW matched orders are accepted. Read by the at-mark open, which must not run alongside them. */
  get matchingEnabled(): boolean {
    return this.deps.enabled;
  }

  /**
   * The price an opening order is held and sent at: a market open at the band edge or nearer the mark under the
   * slippage cap (blank refuses), a limit as sent or, with `priceCorrection: 'adjust'`, moved to the band edge. A limit
   * still outside the band refuses with the band's edges.
   */
  private async openingLimit(
    input: PlaceMatchedOrderInput,
    marketId: string,
    mark: Amount,
    band: Amount,
  ): Promise<{ bandAt: PriceBand; limit: Amount }> {
    const bandAt: PriceBand = priceBandAround(mark, band);
    let limit: Amount;
    if (input.type === 'market') {
      if (this.deps.slippageCapBps) {
        const cap = honouredSlippageCapBps(await this.deps.slippageCapBps(marketId));
        if (cap === null) {
          refuse(
            'trade.slippage_cap_unset',
            'no slippage cap is published for this market, so a market open has no protection price; use a limit',
            503,
          );
        }
        limit = marketOpenLimit(input.side, mark, bandAt, cap);
      } else {
        limit = protectiveLimit(input.side, bandAt);
      }
    } else {
      limit = input.priceCorrection === 'adjust' ? correctToBand(input.limitPrice as Amount, bandAt) : (input.limitPrice as Amount);
    }
    if (!limitWithinBand(limit, bandAt)) {
      refuse(
        'trade.futures_price_outside_band',
        `the limit is outside the price band around the mark (${formatAmount(bandAt.low)} to ${formatAmount(bandAt.high)}); send priceCorrection adjust to move it to the edge`,
        400,
      );
    }
    return { bandAt, limit };
  }

  /**
   * An opening order above the owner's max-order (`TRADE_MAX_ORDER`) placed as children of at most the cap each
   * (`splitPlan`), keyed `<clientOrderId>:<n>:<tag>`, where the tag is a digest of the request (`splitRequestTag`), so a
   * key names one request: the same clientOrderId with any other size, side, price or leverage refuses
   * `trade.client_order_id_conflict` before anything is placed, and so does a clientOrderId that already names a single
   * order. Before any child is placed, the whole order must be a lot multiple and the children not yet placed must
   * together pass what one order would: max-position and max-loss on their total, and the free balance and the haircut
   * credit for their total hold. Then each child goes through `place` with every check of its own.
   *
   * A crash after child k leaves children 1..k as ordinary orders the trader can see and cancel; the same request again
   * replays those by key and places the rest, never one twice. A child refused on its own check (the mark moved past
   * the band it was sized at, say) stops the request there: the answer lists every child placed and names the refusal
   * in `stopped`, so nothing live is reported as nothing placed. The same request later plans again and finishes.
   */
  async placeSplit(
    principal: Principal,
    input: PlaceMatchedOrderInput,
    context: { readonly region?: string | null } = {},
  ): Promise<SplitPlacement> {
    if (!this.deps.enabled) {
      refuse('trade.futures_matching_disabled', 'futures orders through the matching engine are switched off on this deployment', 503);
    }
    if (principal.userId !== input.userId) refuse('auth.credential_denied', 'the order must be placed by its own account', 403);
    if (input.reduceOnly === true) {
      refuse('trade.split_opening_only', 'only an opening order is split; a reduce-only order closes what is already open');
    }
    const base = input.clientOrderId?.trim() ?? '';
    if (base.length === 0) refuse('trade.client_order_id_required', 'clientOrderId is required: each child is keyed by it');
    const tag = splitRequestTag(input);
    const key = (n: number) => `${base}:${n}:${tag}`;
    if (key(SPLIT_MAX_CHILDREN).length > 64) {
      refuse('trade.client_order_id_required', `clientOrderId is too long to key the children (64 chars with the ":<n>:${tag}" suffix)`);
    }
    refuseMalformedOrder(input);
    // The precheck below sizes the children's hold with this leverage, so it is checked first; each child checks it again.
    if (this.deps.maxLeverage == null || this.deps.maxLeverage <= 0n) {
      refuse('trade.leverage_cap_unset', 'the leverage cap is unset on this deployment — refuse rather than invent one');
    }
    const leverageCheck = checkLeverage(input.leverage, this.deps.maxLeverage);
    if (!leverageCheck.ok) refuse(leverageCheck.code ?? 'trade.leverage_invalid', leverageCheck.reason ?? 'leverage refused');
    const resolved = resolveAdmissionLimits();
    if ('refusal' in resolved) throw new MatchedOrderError(resolved.refusal.message, resolved.refusal.code, 400);
    const maxOrder = resolved.limits.maxOrder;
    const band = this.deps.priceBand;
    if (band === null) {
      refuse(FUTURES_PRICE_BAND_UNSET, 'the futures price band is unset on this deployment — the owner names it; nothing is invented');
    }
    const market = await this.loadMarket(input.symbol);
    const inForce = await this.bandInForce(market.id, band);
    const lotSize = market.lot_size == null ? null : parseAmount(market.lot_size);
    // Every full child is a lot multiple, so a whole order off the lot step would only fail on its last child.
    const lot = checkCloseQuantity({ quantity: input.qty, size: input.qty, lotSize });
    if (!lot.ok) refuse(lot.code, lot.reason);

    if (await this.findOrderByClientId(input.userId, input.symbol, base)) {
      refuse('trade.client_order_id_conflict', 'this clientOrderId names a single order, not a split', 409);
    }
    const children = await this.findSplitChildren(input.userId, market.id, base);
    if (children.some((row) => row.tag !== tag)) {
      refuse('trade.client_order_id_conflict', 'this clientOrderId names a different split order', 409);
    }
    const placedByKey = new Map(children.map((row) => [row.row.client_order_id, row.row]));
    // A retry plans with the child size its first attempt used, so every key names the same child as before.
    const first = placedByKey.get(key(1));
    // The plan's mark sizes the children and prechecks them together; it authorises no size. Each child's own `place`
    // reads a mark the book's depth backs for that child's size, as any single order does.
    const mark = await this.deps.markFor(market.id, market.symbol, this.deps.now(), null);
    // Sized at the band's high edge, so a child's own max-order check passes while the mark stays inside the band.
    const plan =
      maxOrder === null
        ? { ok: true as const, parts: [input.qty] }
        : splitPlan({
            qty: input.qty,
            sizedAt: priceBandAround(mark, inForce).high,
            maxOrderNotional: limitAmount(maxOrder),
            lotSize,
            ...(first ? { childSize: parseAmount(first.qty) } : {}),
          });
    if (!plan.ok) {
      refuse(
        LIMIT_MAX_ORDER,
        plan.reason === 'lot_over_cap'
          ? `one lot at the mark is already above the max-order limit of ${maxOrder} ${market.quote_asset}`
          : `the order would take ${plan.children} orders of at most ${maxOrder} ${market.quote_asset} each, and one request places at most ${SPLIT_MAX_CHILDREN}`,
        PRETRADE_LIMIT_HTTP_STATUS,
      );
    }
    const ids = plan.parts.map((_, n) => key(n + 1));

    const waiting = plan.parts.filter((_, n) => !placedByKey.has(ids[n]!));
    if (waiting.length > 0) {
      const total = waiting.reduce((sum, part) => sum + part, 0n);
      const pretrade = await checkOpenAdmission({
        sql: this.deps.sql,
        userId: input.userId,
        marketId: market.id,
        quoteAsset: market.quote_asset,
        side: positionSideOf(input.side),
        size: total,
        orderSize: plan.parts[0],
        entryPrice: mark,
        positionMode: undefined,
        markFor: async (marketId, symbol) => this.deps.markFor(marketId, symbol, this.deps.now(), null),
      });
      if (pretrade) {
        throw new MatchedOrderError(pretrade.message, pretrade.code, pretrade.code.endsWith('_unset') ? 400 : PRETRADE_LIMIT_HTTP_STATUS);
      }
      // The children not yet placed, together, cross into the tier the trader must name before the first is placed.
      await this.refuseUnconfirmedTier(input, market, total, mark);
      // The children not yet placed, together, must fit the room the open-interest limits leave.
      await this.refuseOverOpenInterest(input.userId, market, total);
      const { bandAt, limit } = await this.openingLimit(input, market.id, mark, inForce);
      const rates = await this.openingFeeRates(input.userId);
      const hold = waiting.reduce(
        (sum, qty) =>
          sum +
          orderHoldAmount({ side: input.side, qty, limit, mark, leverage: input.leverage }) +
          orderFeeReserve({ side: input.side, qty, limit, bandHigh: bandAt.high, rates }),
        0n,
      );
      const free = (await this.deps.ledger.balance(userAvailable(input.userId, market.quote_asset))).amount;
      if (free < hold) {
        refuse(
          'trade.futures_margin_insufficient',
          `the ${waiting.length} orders together hold ${formatAmount(hold)} ${market.quote_asset} and ${formatAmount(free)} is free; nothing was placed`,
          400,
        );
      }
      if (this.deps.assertCollateralCredit) {
        await this.deps.assertCollateralCredit({ userId: input.userId, asset: market.quote_asset, additionalHold: hold });
      }
    }

    const orders: MatchedOrderView[] = [];
    for (const [n, qty] of plan.parts.entries()) {
      try {
        orders.push(await this.place(principal, { ...input, qty, clientOrderId: ids[n]! }, context));
      } catch (err) {
        // A typed refusal after a child is live is an answer, not a failure: the children placed are named with it.
        // Anything else (an engine or ledger answer that never came) leaves the outcome unknown, so it is thrown.
        const refusal = typedRefusal(err);
        if (orders.length > 0 && refusal) return { parts: plan.parts.length, orders, stopped: { child: n + 1, ...refusal } };
        throw err;
      }
    }
    return { parts: plan.parts.length, orders, stopped: null };
  }

  /** The children of a split already written under `base` on this market, with the request tag their key carries. */
  private async findSplitChildren(userId: string, marketId: string, base: string): Promise<{ row: OrderRow; tag: string }[]> {
    const prefix = `${base.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`;
    const rows = await this.deps.sql<OrderRow[]>`
      SELECT * FROM trade.futures_orders
       WHERE user_id = ${userId} AND market_id = ${marketId} AND client_order_id LIKE ${prefix} ESCAPE '\\'
    `;
    const out: { row: OrderRow; tag: string }[] = [];
    for (const row of rows) {
      // Only `<base>:<n>:<tag>` is a child of this base; `<base>:x:...` is some other key that shares the prefix.
      const child = /^(\d+):([0-9a-f]{8})$/.exec(row.client_order_id.slice(base.length + 1));
      if (child) out.push({ row, tag: child[2]! });
    }
    return out;
  }

  // ── placement ─────────────────────────────────────────────────────────────

  async place(
    principal: Principal,
    input: PlaceMatchedOrderInput,
    context: { readonly region?: string | null } = {},
  ): Promise<MatchedOrderView> {
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
    // An opening order posts margin from cash in the settle asset; yield-bearing, staked and lending balances are another
    // product. A reduce-only order posts none, so it is never refused for this.
    const classCheck = input.reduceOnly === true ? { ok: true as const } : checkCollateralClassForMargin(input.collateralClass);
    if (!classCheck.ok) refuse(classCheck.code ?? UNSUPPORTED_COLLATERAL_CLASS, classCheck.reason ?? 'collateral class refused');
    refuseMalformedOrder(input);

    const existing = await this.findOrderByClientId(input.userId, input.symbol, clientOrderId);
    if (existing) {
      if (!sameRequest(existing, input)) {
        refuse('trade.client_order_id_conflict', 'this clientOrderId names a different order', 409);
      }
      return this.resume(existing, input.confirmTier);
    }

    // After the replay above, so an order that was accepted and holds margin is finished on retry even if a new
    // rules version was published meanwhile (the same order as the at-mark open). A reduce-only order is never
    // gated: while matching is on it is the only way to close, and no gate may trap a position.
    if (input.reduceOnly !== true) {
      await assertEmailProved(this.deps.emailProof, input.userId);
      if (this.deps.assertOpeningAllowed) await this.deps.assertOpeningAllowed(input.userId);
    }
    if (this.deps.assertDerivativesAccess && input.reduceOnly !== true) {
      await this.deps.assertDerivativesAccess({ userId: input.userId, tier: principal.tier ?? null, region: context.region ?? null });
    }

    const market = await this.loadMarket(input.symbol);
    const band = this.deps.priceBand;
    if (band === null) {
      refuse(FUTURES_PRICE_BAND_UNSET, 'the futures price band is unset on this deployment — the owner names it; nothing is invented');
    }
    const inForce = await this.bandInForce(market.id, band);
    if (input.reduceOnly === true) {
      return this.placeReduceOnly(
        (admission, businessId, payload) => admission.admit(principal, 'order.place', businessId, payload),
        input,
        clientOrderId,
        market,
        inForce,
      );
    }

    if (input.leverage % LEVERAGE_STEP !== 0n) {
      refuse('trade.leverage_invalid', 'leverage has at most two decimal places');
    }
    if (this.deps.maxLeverage == null || this.deps.maxLeverage <= 0n) {
      refuse('trade.leverage_cap_unset', 'the leverage cap is unset on this deployment — refuse rather than invent one');
    }
    const leverageCheck = checkLeverage(input.leverage, this.deps.maxLeverage);
    if (!leverageCheck.ok) refuse(leverageCheck.code ?? 'trade.leverage_invalid', leverageCheck.reason ?? 'leverage refused');
    const lot = checkCloseQuantity({
      quantity: input.qty,
      size: input.qty,
      lotSize: market.lot_size == null ? null : parseAmount(market.lot_size),
    });
    if (!lot.ok) refuse(lot.code, lot.reason);

    await this.refuseOneWayFlip(input.userId, market.id, positionSideOf(input.side));

    const at = this.deps.now();
    const mark = await this.deps.markFor(market.id, market.symbol, at, input.qty);
    const { bandAt, limit } = await this.openingLimit(input, market.id, mark, inForce);

    const slot = await this.deps.sql<{ id: string; leverage: string }[]>`
      SELECT id, leverage FROM trade.positions
       WHERE user_id = ${input.userId} AND market_id = ${market.id} AND side = ${positionSideOf(input.side)}
         AND margin_mode = 'isolated' AND status = 'open'
       LIMIT 1
    `;
    if (slot[0]) {
      if (parseAmount(slot[0].leverage) !== input.leverage) {
        refuse('trade.futures_leverage_mismatch', 'an order that grows this position must use its current leverage', 409);
      }
      await this.deps.assertPositionIdle(slot[0].id);
    }

    // The hold carries the order's fees as well as its margin, so a fill never needs money the trader no longer has.
    const rates = await this.openingFeeRates(input.userId);
    const hold =
      orderHoldAmount({ side: input.side, qty: input.qty, limit, mark, leverage: input.leverage }) +
      orderFeeReserve({ side: input.side, qty: input.qty, limit, bandHigh: bandAt.high, rates });
    const orderId = matchedOrderIdFor(input.userId, market.id, clientOrderId);

    const pretrade = await checkOpenAdmission({
      sql: this.deps.sql,
      userId: input.userId,
      marketId: market.id,
      quoteAsset: market.quote_asset,
      side: positionSideOf(input.side),
      size: input.qty,
      entryPrice: mark,
      positionMode: undefined,
      markFor: async (marketId, symbol) => this.deps.markFor(marketId, symbol, at, null),
    });
    if (pretrade) {
      throw new MatchedOrderError(pretrade.message, pretrade.code, pretrade.code.endsWith('_unset') ? 400 : PRETRADE_LIMIT_HTTP_STATUS);
    }
    const rated = await this.refuseUnconfirmedTier(input, market, input.qty, mark);
    await this.refuseOverOpenInterest(input.userId, market, input.qty);

    if (!this.deps.lifecycleProof) refuse('trade.lifecycle_authority_unavailable', 'market lifecycle authority is not configured', 503);
    const proof = await this.deps.lifecycleProof(market.id);

    if (!this.deps.admission) refuse('authority.unavailable', 'trading admission is not configured', 503);
    await this.deps.admission.admit(principal, 'order.place', `futures.order:${orderId}`, {
      orderId,
      userId: input.userId,
      marketId: market.id,
      symbol: market.symbol,
      side: input.side,
      type: input.type,
      qty: formatAmount(input.qty),
      limitPrice: formatAmount(limit),
      markPrice: formatAmount(mark),
      leverage: formatAmount(input.leverage),
      holdAmount: formatAmount(hold),
      at: at.toISOString(),
    });

    const inserted = await this.deps.sql<{ id: string }[]>`
      INSERT INTO trade.futures_orders (
        id, user_id, market_id, client_order_id, side, order_type, qty, limit_price, mark_price,
        band_low, band_high, leverage, hold_asset, status, maker_fee_bps, taker_fee_bps
      ) VALUES (
        ${orderId}, ${input.userId}, ${market.id}, ${clientOrderId}, ${input.side}, ${input.type},
        ${formatAmount(input.qty)}, ${formatAmount(limit)}, ${formatAmount(mark)},
        ${formatAmount(bandAt.low)}, ${formatAmount(bandAt.high)}, ${formatAmount(input.leverage)},
        ${market.quote_asset}, 'pending', ${rates.makerBps}, ${rates.takerBps}
      )
      ON CONFLICT (user_id, market_id, client_order_id) DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) {
      const raced = await this.findOrderByClientId(input.userId, input.symbol, clientOrderId);
      if (!raced || !sameRequest(raced, input)) refuse('trade.client_order_id_conflict', 'this clientOrderId names a different order', 409);
      return this.resume(raced, input.confirmTier);
    }

    const row = await this.loadOrder(orderId);
    return this.continueOrder(row, market, proof, { confirmTier: input.confirmTier, depthNotional: rated?.depthNotional });
  }

  /**
   * An opening order that carries its side into a higher margin tier than it sits in now refuses until `confirmTier`
   * names that tier (`risk-tier-confirm.ts`). Before anything is held or written, so the refusal locks nothing.
   */
  private async refuseUnconfirmedTier(
    input: PlaceMatchedOrderInput,
    market: MarketRow,
    qty: Amount,
    mark: Amount,
  ): Promise<RiskTierCrossing | null> {
    if (!this.deps.riskTier) return null;
    const crossing = await this.deps.riskTier({
      userId: input.userId,
      marketId: market.id,
      symbol: market.symbol,
      side: positionSideOf(input.side),
      qty,
      mark,
    });
    const refusal = unconfirmedTierRefusal(crossing, input.confirmTier, input.leverage, this.deps.maxLeverage);
    if (refusal) refuse(refusal.code, refusal.message, refusal.status);
    return crossing;
  }

  /**
   * The same rating again once the order's row is written, before its hold posts, as the haircut is checked: the row
   * counts in the side's exposure from the moment it exists, so of two opens placed together the later rating sees
   * both, and they cannot each stay "inside the tier" while together crossing one nobody named. A crossing refuses the
   * order on its code (the row is kept, refused, as an unfunded hold is). A rating that cannot be read leaves the order
   * pending, and a retry rates it again.
   */
  private async refuseUnconfirmedTierOnRow(row: OrderRow, market: MarketRow, tier: TierContext): Promise<void> {
    const crossing = await this.deps.riskTier!({
      userId: row.user_id,
      marketId: market.id,
      symbol: market.symbol,
      side: positionSideOf(row.side),
      qty: parseAmount(row.qty),
      mark: parseAmount(row.mark_price),
      excludeOrderId: row.id,
      ...(tier.depthNotional !== undefined ? { depthNotional: tier.depthNotional } : {}),
    });
    const refusal = unconfirmedTierRefusal(crossing, tier.confirmTier, parseAmount(row.leverage), this.deps.maxLeverage);
    if (!refusal) return;
    await this.deps.sql`
      UPDATE trade.futures_orders SET status = 'refused', refusal_code = ${refusal.code}, updated_at = now()
       WHERE id = ${row.id} AND status = 'pending'
    `;
    refuse(refusal.code, refusal.message, refusal.status);
  }

  /**
   * An opening order that would carry the account past its share of the market's open-interest limit, or the market
   * past the limit, refuses with the room left (`open-interest-limits.ts`). Before anything is held or written.
   */
  private async refuseOverOpenInterest(userId: string, market: MarketRow, qty: Amount): Promise<void> {
    if (!this.deps.openInterest) return;
    const room = await this.deps.openInterest({ userId, marketId: market.id, symbol: market.symbol, lotSize: lotOf(market) });
    const refusal = openInterestRefusal(room, qty, market.base_asset);
    if (refusal) refuse(refusal.code, refusal.message, refusal.status);
  }

  /**
   * The same check once the order's row is written, before its hold posts: the row counts from the moment it exists,
   * so of two opens placed together near a limit the later check sees both, and at most one passes (when both checks
   * run after both rows exist, both refuse: the safe way round). An order over the limit, or on a market whose limit
   * was blanked meanwhile, is refused on its code and its row kept, refused; a read that fails leaves it pending for a
   * retry, as the haircut does.
   */
  private async refuseOverOpenInterestOnRow(row: OrderRow, market: MarketRow): Promise<void> {
    let refusal: { code: string; message: string; status: number } | null;
    try {
      const room = await this.deps.openInterest!({
        userId: row.user_id,
        marketId: market.id,
        symbol: market.symbol,
        lotSize: lotOf(market),
        excludeOrderId: row.id,
      });
      refusal = openInterestRefusal(room, parseAmount(row.qty), market.base_asset);
    } catch (err) {
      // PositionService's FuturesError, matched by code since that module imports this one.
      const code = (err as { code?: unknown } | null)?.code;
      if (code !== OI_LIMIT_UNSET) throw err;
      const { message, status } = err as { message: string; status: number };
      refusal = { code, message, status };
    }
    if (!refusal) return;
    await this.deps.sql`
      UPDATE trade.futures_orders SET status = 'refused', refusal_code = ${refusal.code}, updated_at = now()
       WHERE id = ${row.id} AND status = 'pending'
    `;
    refuse(refusal.code, refusal.message, refusal.status);
  }

  /**
   * In one-way mode a position is net: an opening order on the side opposite an open position, or opposite a live
   * opening order that could still open one, refuses. A trader who wants out places a reduce-only order instead.
   * Hedge mode keeps a row per side, so both sides may open there. An account that has not chosen is one-way, as
   * the at-mark open treats it (`resolveOpenPositionMode`); nothing is stored by reading it.
   */
  private async refuseOneWayFlip(userId: string, marketId: string, side: PositionSide): Promise<void> {
    const [mode] = await this.deps.sql<{ mode: string }[]>`
      SELECT mode FROM trade.account_position_modes WHERE user_id = ${userId}
    `;
    if (mode?.mode === 'hedge') return;
    const opposite = oppositeSide(side);
    const [conflict] = await this.deps.sql<{ what: string }[]>`
      SELECT 'position' AS what FROM trade.positions
       WHERE user_id = ${userId} AND market_id = ${marketId} AND side = ${opposite} AND status IN ('open', 'closing')
      UNION ALL
      SELECT 'order' AS what FROM trade.futures_orders
       WHERE user_id = ${userId} AND market_id = ${marketId} AND NOT reduce_only
         AND side = ${opposite === 'long' ? 'buy' : 'sell'}
         AND status IN ('pending', 'held', 'submitting', 'open', 'submit_unknown')
      LIMIT 1
    `;
    if (!conflict) return;
    refuse(
      FUTURES_ONE_WAY_FLIP_REFUSED,
      conflict.what === 'position'
        ? `this account is in one-way mode and holds a ${opposite} position here — reduce it with a reduce-only order instead of opening the other side`
        : `this account is in one-way mode and has a live ${opposite} opening order here — cancel it before opening the other side`,
      409,
    );
  }

  /** The rates an opening order keeps. Unwired or unpublished refuses: an order never trades on an invented rate. */
  private async openingFeeRates(userId: string): Promise<FeeRates> {
    if (!this.deps.feeRates) {
      refuse('trade.fee_schedule_blank', 'futures trading fees are not wired on this deployment — the owner publishes them');
    }
    try {
      return await this.deps.feeRates(userId);
    } catch (err) {
      if (err instanceof FeeScheduleError) refuse(err.code, err.message);
      throw err;
    }
  }

  /**
   * The rates a reduce-only order keeps. A reduce is never refused for fees: while matching is on it is the only way
   * to close, and a schedule withdrawn after the position opened must not trap it. With no published rate there is no
   * fee to charge, so the order keeps zero and its fills record a fee of zero.
   */
  private async reducingFeeRates(userId: string): Promise<FeeRates> {
    if (!this.deps.feeRates) return { makerBps: 0, takerBps: 0 };
    try {
      return await this.deps.feeRates(userId);
    } catch (err) {
      if (err instanceof FeeScheduleError) return { makerBps: 0, takerBps: 0 };
      throw err;
    }
  }

  /**
   * The one reduce-only order a fired conditional order places for its trader (D-orders-04, J-derivatives-03). No
   * session or key is behind it: the trader armed the conditional order, and admission names that order as a standing
   * instruction owned by svc-trade (`admitStanding`), whose caller has claimed it as fired. Everything after admission
   * is the reduce-only path a trader's own order takes: the position's own bound, the band, the reduce room left by
   * its other reduce-only orders, and a retry on the same `clientOrderId` that finds the same order. It never opens.
   */
  async placeOnInstruction(input: PlaceMatchedOrderInput, instructionId: string): Promise<MatchedOrderView> {
    if (!this.deps.enabled) {
      refuse('trade.futures_matching_disabled', 'futures orders through the matching engine are switched off on this deployment', 503);
    }
    if (input.reduceOnly !== true) refuse('trade.conditional_would_increase', 'a conditional order only ever places a reduce-only order');
    const clientOrderId = input.clientOrderId?.trim() ?? '';
    if (clientOrderId.length === 0 || clientOrderId.length > 64) {
      refuse('trade.client_order_id_required', 'clientOrderId is required (1–64 chars) — omit would double-lock margin on retry');
    }
    refuseMalformedOrder(input);
    const existing = await this.findOrderByClientId(input.userId, input.symbol, clientOrderId);
    if (existing) {
      if (!sameRequest(existing, input)) {
        refuse('trade.client_order_id_conflict', 'this clientOrderId names a different order', 409);
      }
      return this.resume(existing);
    }
    const market = await this.loadMarket(input.symbol);
    const band = this.deps.priceBand;
    if (band === null) {
      refuse(FUTURES_PRICE_BAND_UNSET, 'the futures price band is unset on this deployment — the owner names it; nothing is invented');
    }
    const inForce = await this.bandInForce(market.id, band);
    return this.placeReduceOnly(
      (admission, businessId, payload) => admission.admitStanding(input.userId, instructionId, businessId, payload, 'svc-trade'),
      input,
      clientOrderId,
      market,
      inForce,
    );
  }

  /**
   * A reduce-only order: the other side of the caller's open isolated position, no margin locked, at most the
   * position's size less its other live reduce-only orders, and never past its bankruptcy price.
   *
   * The position row is locked while the bound is read and the order row is written, so two reduce orders placed at
   * once cannot both claim the same size. Leverage and the leverage cap are not checked: reducing is always allowed,
   * and the order carries its position's leverage.
   */
  private async placeReduceOnly(
    admit: (admission: TradingAdmissionPort, businessId: string, payload: Record<string, unknown>) => Promise<unknown>,
    input: PlaceMatchedOrderInput,
    clientOrderId: string,
    market: MarketRow,
    band: Amount,
  ): Promise<MatchedOrderView> {
    const target = oppositeSide(positionSideOf(input.side));
    // A reduce pays its fee from the margin share each fill returns, at the rates the order keeps from now on.
    const reduceRates = await this.reducingFeeRates(input.userId);
    const [open] = await this.deps.sql<{ id: string }[]>`
      SELECT id FROM trade.positions
       WHERE user_id = ${input.userId} AND market_id = ${market.id} AND side = ${target}
         AND margin_mode = 'isolated' AND status = 'open'
       LIMIT 1
    `;
    if (!open) {
      refuse(FUTURES_REDUCE_ONLY_NO_POSITION, `reduce-only ${input.side} needs an open isolated ${target} position on this market`, 400);
    }
    // A rung, an ADL pair, a review hold or a fill still being recorded: the reduce waits, as a close would.
    await this.deps.assertPositionIdle(open.id);

    const at = this.deps.now();
    const mark = await this.deps.markFor(market.id, market.symbol, at, input.qty);
    const bandAt: PriceBand = priceBandAround(mark, band);
    if (!this.deps.lifecycleProof) refuse('trade.lifecycle_authority_unavailable', 'market lifecycle authority is not configured', 503);
    const proof = await this.deps.lifecycleProof(market.id);
    if (!this.deps.admission) refuse('authority.unavailable', 'trading admission is not configured', 503);
    const admission = this.deps.admission;
    const orderId = matchedOrderIdFor(input.userId, market.id, clientOrderId);

    const placed = await this.deps.sql.begin(async (tx) => {
      const [position] = await tx<PositionRowLite[]>`
        SELECT id, user_id, market_id, side, status, size, entry_price, leverage, margin_initial, margin_current,
               margin_asset, margin_adjust_request
          FROM trade.positions WHERE id = ${open.id} FOR UPDATE
      `;
      if (!position || position.status !== 'open') {
        refuse(FUTURES_REDUCE_ONLY_NO_POSITION, `reduce-only ${input.side} needs an open isolated ${target} position on this market`, 400);
      }
      // The same request placed at once twice: the one that wrote its row first holds the room, and this one is its
      // replay (below), not a second claim on the same size refused as too large.
      const [same] = await tx<{ id: string }[]>`
        SELECT id FROM trade.futures_orders
         WHERE user_id = ${input.userId} AND market_id = ${market.id} AND client_order_id = ${clientOrderId}
      `;
      if (same) return false;
      // The bound below is priced from the margin; one that is mid-change would price it from a figure about to move.
      if (position.margin_adjust_request != null) {
        refuse(
          'trade.margin_adjustment_in_progress',
          `position ${position.id} has a margin adjustment in flight — place the reduce-only order once it finishes`,
          409,
        );
      }
      const size = parseAmount(position.size);
      const reserved = await reservedReduceQty(tx, position.id);
      if (input.qty + reserved > size) {
        refuse(
          FUTURES_REDUCE_ONLY_EXCEEDS_POSITION,
          `reduce-only qty ${formatAmount(input.qty)} is more than the position's ${formatAmount(size)} less ${formatAmount(reserved)} its other live reduce-only orders already claim`,
          400,
        );
      }
      const lot = checkCloseQuantity({
        quantity: input.qty,
        size,
        lotSize: market.lot_size == null ? null : parseAmount(market.lot_size),
      });
      if (!lot.ok) refuse(lot.code, lot.reason);

      const bankruptcy = bankruptcyPrice({
        side: position.side,
        size,
        entryPrice: parseAmount(position.entry_price),
        margin: parseAmount(position.margin_current),
      });
      let limit: Amount;
      if (input.type === 'market') {
        const pulledIn = marketReduceLimit(position.side, bandAt, bankruptcy);
        if (pulledIn === null) {
          refuse(
            FUTURES_REDUCE_BANKRUPTCY_OUTSIDE_BAND,
            `the position's bankruptcy price ${formatAmount(bankruptcy)} is beyond the price band around the mark — no price in the band keeps the loss inside the margin`,
            409,
          );
        }
        limit = pulledIn;
      } else {
        limit = input.limitPrice as Amount;
        if (!limitWithinBand(limit, bandAt)) {
          refuse('trade.futures_price_outside_band', 'the limit is outside the price band around the mark', 400);
        }
        if (!withinBankruptcy(position.side, limit, bankruptcy)) {
          refuse(
            FUTURES_REDUCE_PAST_BANKRUPTCY,
            `the limit ${formatAmount(limit)} is past the position's bankruptcy price ${formatAmount(bankruptcy)} — a reduce may not lose more than the margin`,
            400,
          );
        }
      }

      await admit(admission, `futures.order:${orderId}`, {
        orderId,
        userId: input.userId,
        marketId: market.id,
        symbol: market.symbol,
        side: input.side,
        type: input.type,
        qty: formatAmount(input.qty),
        limitPrice: formatAmount(limit),
        markPrice: formatAmount(mark),
        leverage: formatAmount(parseAmount(position.leverage)),
        holdAmount: '0',
        reduceOnly: true,
        positionId: position.id,
        bankruptcyPrice: formatAmount(bankruptcy),
        at: at.toISOString(),
      });

      const inserted = await tx<{ id: string }[]>`
        INSERT INTO trade.futures_orders (
          id, user_id, market_id, client_order_id, side, order_type, qty, limit_price, mark_price,
          band_low, band_high, leverage, hold_asset, status, reduce_only, position_id, bankruptcy_price,
          maker_fee_bps, taker_fee_bps
        ) VALUES (
          ${orderId}, ${input.userId}, ${market.id}, ${clientOrderId}, ${input.side}, ${input.type},
          ${formatAmount(input.qty)}, ${formatAmount(limit)}, ${formatAmount(mark)},
          ${formatAmount(bandAt.low)}, ${formatAmount(bandAt.high)}, ${formatAmount(parseAmount(position.leverage))},
          ${position.margin_asset}, 'pending', true, ${position.id}, ${formatAmount(bankruptcy)},
          ${reduceRates.makerBps}, ${reduceRates.takerBps}
        )
        ON CONFLICT (user_id, market_id, client_order_id) DO NOTHING
        RETURNING id
      `;
      return inserted.length > 0;
    });
    if (!placed) {
      const raced = await this.findOrderByClientId(input.userId, input.symbol, clientOrderId);
      if (!raced || !sameRequest(raced, input)) refuse('trade.client_order_id_conflict', 'this clientOrderId names a different order', 409);
      return this.resume(raced);
    }
    return this.continueOrder(await this.loadOrder(orderId), market, proof);
  }

  /** A retry of an order whose placement stopped part-way: continue from what the row says, with its stored numbers. */
  private async resume(row: OrderRow, confirmTier?: number): Promise<MatchedOrderView> {
    if (row.status === 'pending' || row.status === 'held') {
      const market = await this.loadMarketById(row.market_id);
      if (!this.deps.lifecycleProof) refuse('trade.lifecycle_authority_unavailable', 'market lifecycle authority is not configured', 503);
      const proof = await this.deps.lifecycleProof(market.id);
      return this.continueOrder(row, market, proof, { confirmTier });
    }
    if (row.status === 'submitting' || row.status === 'submit_unknown') {
      refuse(
        'trade.futures_submit_unknown',
        'the engine did not answer for this order; it is not sent again, and its hold stays until it is reconciled',
        503,
      );
    }
    return presentOrder(row);
  }

  /** Hold, then submit. Both steps are idempotent on the order id, so a retry runs them again safely. */
  /**
   * The owner's haircut, checked once the order's row is written and before its hold is posted: the account's figures
   * count this row's whole hold from the moment it exists, so of two opens placed together the later check sees both,
   * and they cannot both pass on credit that covers only one. A blank haircut or a shortfall refuses the order on its
   * code, as an unfunded hold does. A read that fails leaves the order pending, and a retry checks again.
   */
  private async refuseShortOfCredit(row: OrderRow): Promise<void> {
    try {
      await this.deps.assertCollateralCredit!({ userId: row.user_id, asset: row.hold_asset });
    } catch (err) {
      // The refusal is PositionService's FuturesError; it is matched by code, since that module imports this one.
      const code = (err as { code?: unknown } | null)?.code;
      if (code === HAIRCUT_UNSET || code === HAIRCUT_CREDIT_SHORT) {
        await this.deps.sql`
          UPDATE trade.futures_orders SET status = 'refused', refusal_code = ${code}, updated_at = now()
           WHERE id = ${row.id} AND status = 'pending'
        `;
      }
      throw err;
    }
  }

  private async continueOrder(
    row: OrderRow,
    market: MarketRow,
    proof: LifecycleAdmissionProof,
    tier: TierContext = {},
  ): Promise<MatchedOrderView> {
    if (row.status === 'pending' && row.reduce_only) {
      // Nothing to lock: a reduce-only order's loss is bounded by its position's bankruptcy price, not by a hold.
      await this.deps.sql`
        UPDATE trade.futures_orders SET status = 'held', updated_at = now() WHERE id = ${row.id} AND status = 'pending'
      `;
    } else if (row.status === 'pending') {
      if (this.deps.riskTier) await this.refuseUnconfirmedTierOnRow(row, market, tier);
      if (this.deps.openInterest) await this.refuseOverOpenInterestOnRow(row, market);
      if (this.deps.assertCollateralCredit) await this.refuseShortOfCredit(row);
      try {
        await this.deps.ledger.post(
          recipes.futuresOrderMarginHold({
            orderId: row.id,
            userId: row.user_id,
            assetId: row.hold_asset,
            amount: holdOf(row),
          }),
        );
      } catch (err) {
        if (isInsufficientFunds(err)) {
          await this.deps.sql`
            UPDATE trade.futures_orders
               SET status = 'refused', refusal_code = 'trade.futures_margin_insufficient', updated_at = now()
             WHERE id = ${row.id} AND status = 'pending'
          `;
          refuse(
            'trade.futures_margin_insufficient',
            'available balance does not cover the initial margin and the adverse distance for this order',
            400,
          );
        }
        throw err;
      }
      await this.deps.sql`
        UPDATE trade.futures_orders SET status = 'held', updated_at = now() WHERE id = ${row.id} AND status = 'pending'
      `;
    }

    const current = await this.loadOrder(row.id);
    if (current.status !== 'held') return presentOrder(current);
    // The attempt is recorded before the engine sees the order. A crash after the engine accepted it leaves
    // `submitting`, which a retry never sends again: the engine may hold the order, and its fills still settle.
    const claimed = await this.deps.sql<{ id: string }[]>`
      UPDATE trade.futures_orders SET status = 'submitting', updated_at = now()
       WHERE id = ${current.id} AND status = 'held'
       RETURNING id
    `;
    if (claimed.length === 0) return presentOrder(await this.loadOrder(current.id));

    if (!this.deps.matching) refuse('trade.futures_matching_unconfigured', 'the matching engine is not configured', 503);
    const request: EngineSubmitRequest = {
      orderId: current.id,
      accountId: current.user_id,
      type: 'limit',
      side: current.side === 'buy' ? 'buy' : 'sell',
      qty: formatAmount(parseAmount(current.qty)),
      price: formatAmount(parseAmount(current.limit_price)),
      tif: current.order_type === 'market' ? 'IOC' : 'GTC',
      collar: true,
      min: formatAmount(parseAmount(current.band_low)),
      max: formatAmount(parseAmount(current.band_high)),
      // Never the engine's reduce-only: it is judged against the engine's net of fills, not the margin book (see the
      // header). The reduce bound for a reduce-only order is enforced here, at placement and again on every fill.
      reduceOnly: false,
      lifecycleProof: proof,
    };

    let result: EngineSubmitResult;
    try {
      result = await this.deps.matching.submit(market.id, request);
    } catch {
      await this.deps.sql`
        UPDATE trade.futures_orders SET status = 'submit_unknown', updated_at = now()
         WHERE id = ${current.id} AND status = 'submitting'
      `;
      refuse(
        'trade.futures_submit_unknown',
        'the engine did not answer for this order; it is not sent again, and its hold stays until it is reconciled',
        503,
      );
    }

    if (!result.accepted || result.rejected) {
      await this.deps.sql`
        UPDATE trade.futures_orders
           SET status = 'rejected', refusal_code = ${result.rejected?.code ?? 'trade.futures_engine_refused'},
               engine_filled_qty = 0, updated_at = now()
         WHERE id = ${current.id} AND status = 'submitting'
      `;
      await this.releaseWhenDone(current.id);
      return presentOrder(await this.loadOrder(current.id));
    }

    for (const fill of result.fills) {
      await this.settleFillOrWait({
        marketId: market.id,
        makerOrderId: fill.makerOrderId,
        takerOrderId: fill.takerOrderId,
        price: fill.price,
        qty: fill.qty,
        sequence: fill.sequence,
      });
    }

    const afterFills = await this.loadOrder(current.id);
    if (parseAmount(afterFills.filled_qty) !== parseAmount(afterFills.qty)) {
      if (result.resting) {
        await this.deps.sql`
          UPDATE trade.futures_orders SET status = 'open', updated_at = now()
           WHERE id = ${current.id} AND status IN ('submitting', 'open')
        `;
      } else {
        // A remainder that is not resting is an IOC or market remainder: the engine has taken it off the book.
        // Every fill of a taker that does not rest is in this reply, so the reply says what the engine filled in
        // all, even when some of those fills are still waiting to settle (`settleFillOrWait`).
        const printed = result.fills
          .filter((f) => f.takerOrderId === current.id || f.makerOrderId === current.id)
          .reduce((sum, f) => sum + parseAmount(f.qty), 0n);
        const left = result.cancellations.find((c) => c.orderId === current.id);
        if (!left && printed === parseAmount(current.qty)) {
          // Filled in full in the engine; the order turns `filled` as its waiting fills settle.
          await this.deps.sql`
            UPDATE trade.futures_orders
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

  // ── fills ─────────────────────────────────────────────────────────────────

  /** Settle one engine fill into both of its orders. Each side is keyed on its own position, so the two never collide. */
  async settleFill(fill: {
    marketId: string;
    makerOrderId: string;
    takerOrderId: string;
    price: string;
    qty: string;
    sequence: number;
  }): Promise<void> {
    const price = parseAmount(fill.price);
    const qty = parseAmount(fill.qty);
    if (!Number.isSafeInteger(fill.sequence) || fill.sequence < 0) {
      refuse('trade.futures_fill_sequence_invalid', 'a fill needs a non-negative integer engine sequence', 500);
    }
    // Both sides are checked before either posts: a fill one side cannot take is refused whole, never half-applied.
    await this.assertFillSettles(fill, price, qty);
    await this.applyFill({ marketId: fill.marketId, orderId: fill.takerOrderId, sequence: fill.sequence, price, qty, role: 'taker' });
    await this.applyFill({ marketId: fill.marketId, orderId: fill.makerOrderId, sequence: fill.sequence, price, qty, role: 'maker' });
  }

  /**
   * Settle a fill, or keep it to settle later. A fill refused only because one of its positions is busy (see
   * `refuseIfPositionBusy`) is stored in `trade.futures_fill_waits` and the call returns, so the matching event is
   * acknowledged and nothing depends on it being delivered again. `retryWaitingFills` settles it once the position is
   * free. Any other refusal or failure is thrown as before.
   */
  async settleFillOrWait(fill: MatchedFillEvent): Promise<'settled' | 'waiting'> {
    try {
      await this.settleFill(fill);
      return 'settled';
    } catch (err) {
      if (!fillMustWait(err)) throw err;
      await this.deps.sql`
        INSERT INTO trade.futures_fill_waits (market_id, engine_sequence, maker_order_id, taker_order_id, price, qty, reason)
        VALUES (${fill.marketId}, ${fill.sequence}, ${fill.makerOrderId}, ${fill.takerOrderId},
                ${formatAmount(parseAmount(fill.price))}, ${formatAmount(parseAmount(fill.qty))}, ${err.code})
        ON CONFLICT (market_id, engine_sequence, maker_order_id, taker_order_id) DO UPDATE
           SET attempts = trade.futures_fill_waits.attempts + 1, reason = EXCLUDED.reason, retried_at = now()
         WHERE trade.futures_fill_waits.settled_at IS NULL
      `;
      return 'waiting';
    }
  }

  /**
   * Retry the fills that are waiting: never-retried first, then the longest since its last try, so a batch full of
   * fills stuck on a parked position cannot starve a newer fill whose position is free. Settling is idempotent per
   * side, so a fill that meanwhile settled through a redelivered event is only marked settled here. A fill that fails
   * for another reason stays waiting and is reported, never dropped.
   */
  async retryWaitingFills(limit: number): Promise<{ settled: number; waiting: number; failed: { sequence: number; message: string }[] }> {
    const rows = await this.deps.sql<WaitRow[]>`
      SELECT market_id, engine_sequence::text, maker_order_id, taker_order_id, price::text, qty::text
        FROM trade.futures_fill_waits
       WHERE settled_at IS NULL
       ORDER BY retried_at NULLS FIRST, created_at, engine_sequence
       LIMIT ${limit}
    `;
    return this.retryWaitRows(rows);
  }

  /** Retry the waiting fills of one order (a liquidation's IOC), oldest first. Same rules as `retryWaitingFills`. */
  private async retryWaitingFillsOf(orderId: string) {
    const rows = await this.deps.sql<WaitRow[]>`
      SELECT market_id, engine_sequence::text, maker_order_id, taker_order_id, price::text, qty::text
        FROM trade.futures_fill_waits
       WHERE settled_at IS NULL AND (maker_order_id = ${orderId} OR taker_order_id = ${orderId})
       ORDER BY engine_sequence
    `;
    return this.retryWaitRows(rows);
  }

  private async retryWaitRows(
    rows: readonly WaitRow[],
  ): Promise<{ settled: number; waiting: number; failed: { sequence: number; message: string }[] }> {
    let settled = 0;
    let waiting = 0;
    const failed: { sequence: number; message: string }[] = [];
    for (const row of rows) {
      const where = this.deps.sql`
        market_id = ${row.market_id} AND engine_sequence = ${row.engine_sequence}
        AND maker_order_id = ${row.maker_order_id} AND taker_order_id = ${row.taker_order_id}
      `;
      try {
        await this.settleFill({
          marketId: row.market_id,
          makerOrderId: row.maker_order_id,
          takerOrderId: row.taker_order_id,
          price: formatAmount(parseAmount(row.price)),
          qty: formatAmount(parseAmount(row.qty)),
          sequence: Number(row.engine_sequence),
        });
        await this.deps.sql`UPDATE trade.futures_fill_waits SET settled_at = now(), retried_at = now() WHERE ${where}`;
        settled += 1;
      } catch (err) {
        const reason = err instanceof MatchedOrderError ? err.code : 'trade.futures_fill_retry_failed';
        await this.deps.sql`
          UPDATE trade.futures_fill_waits SET attempts = attempts + 1, reason = ${reason}, retried_at = now() WHERE ${where}
        `;
        if (fillMustWait(err)) waiting += 1;
        else failed.push({ sequence: Number(row.engine_sequence), message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { settled, waiting, failed };
  }

  /**
   * The checks that would refuse a fill, run for both orders before any post. A side that already has an intent
   * for this sequence is a replay and is not checked again: its quantity is already in the order's totals.
   */
  private async assertFillSettles(
    fill: { marketId: string; makerOrderId: string; takerOrderId: string; sequence: number },
    price: Amount,
    qty: Amount,
  ): Promise<void> {
    for (const orderId of [fill.takerOrderId, fill.makerOrderId]) {
      const order = await this.loadOrder(orderId);
      const [prior] = await this.deps.sql<{ n: number }[]>`
        SELECT 1 AS n FROM trade.futures_order_fills WHERE order_id = ${orderId} AND engine_sequence = ${fill.sequence}
      `;
      if (prior) continue;
      if (order.market_id !== fill.marketId) refuse('trade.futures_market_mismatch', 'a fill names an order on another market', 500);
      if (!fillWithinLimit(order.side, price, parseAmount(order.limit_price))) {
        refuse('trade.futures_fill_outside_limit', `fill ${fill.sequence} prices outside order ${order.id}'s limit`, 500);
      }
      assertFillFits(order, fill.sequence, qty);
      if (order.reduce_only) {
        // Repeated under the lock in recordReduceIntent; checked here too so the usual case refuses the fill whole.
        const [position] = await this.deps.sql<{ id: string; status: string; size: string }[]>`
          SELECT id, status, size FROM trade.positions WHERE id = ${order.position_id}
        `;
        assertReduceFillFits(order, position, fill.sequence, qty);
        await refuseIfPositionBusy(this.deps.sql, position.id, order.liquidation_rung_id);
        await refuseIfPositionHasPendingFill(this.deps.sql, position.id, 'any');
        continue;
      }
      // Repeated under the lock in recordIntent; checked here too so that the usual case refuses the fill whole.
      const [open] = await this.deps.sql<{ id: string }[]>`
        SELECT id FROM trade.positions
         WHERE user_id = ${order.user_id} AND market_id = ${order.market_id} AND side = ${positionSideOf(order.side)}
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
   * One order's share of one fill.
   *
   * TX1 (intent): lock the order, decide the position it grows or opens, store the amount and the fee, commit.
   * POST: `futuresOrderMarginApply` under the fill key, which pays the fee from the order's hold in the same posting.
   * TX2 (apply): lock the position and the order, mark the intent applied, move the row, count the fee, commit.
   */
  private async applyFill(input: FillShare): Promise<void> {
    const [kind] = await this.deps.sql<{ reduce_only: boolean }[]>`
      SELECT reduce_only FROM trade.futures_orders WHERE id = ${input.orderId}
    `;
    if (kind?.reduce_only) {
      await this.applyReduceFill(input);
      return;
    }
    const intent = await this.deps.sql.begin(async (tx) => this.recordIntent(tx, input));
    if (intent.state === 'applied') {
      await this.releaseWhenDone(input.orderId);
      return;
    }

    if (intent.amount > 0n) {
      await this.deps.ledger.post(
        recipes.futuresOrderMarginApply({
          orderId: intent.order.id,
          userId: intent.order.user_id,
          assetId: intent.order.hold_asset,
          positionId: intent.position_id,
          fillId: intent.fill_key,
          amount: intent.amount,
          ...(intent.fee > 0n ? { fee: intent.fee } : {}),
        }),
      );
    }

    const positionId = await this.deps.sql.begin(async (tx) => this.applyIntent(tx, intent));
    // The fill moved the position's entry and margin, so its bankruptcy price moved: a resting reduce order whose
    // limit is now past it is taken off the book (ADR section 1, "resting reduce orders follow the margin").
    await this.cancelReduceOrdersPastBound(positionId);
    if (this.deps.publishPosition) {
      try {
        await this.deps.publishPosition(positionId);
      } catch {
        // A notification that fails after a settled fill is not a reason to unsettle it: the position is already right.
      }
    }
    await this.releaseWhenDone(input.orderId);
  }

  private async recordIntent(
    tx: TransactionSql,
    input: FillShare,
  ): Promise<{
    fill_key: string;
    position_id: string;
    user_id: string;
    amount: Amount;
    fee: Amount;
    state: 'pending' | 'applied';
    order: OrderRow;
  }> {
    const [order] = await tx<OrderRow[]>`SELECT * FROM trade.futures_orders WHERE id = ${input.orderId} FOR UPDATE`;
    if (!order) refuse('trade.futures_order_not_found', `futures order ${input.orderId} is not known`, 404);
    if (order.market_id !== input.marketId) {
      refuse('trade.futures_market_mismatch', 'a fill names an order on another market', 500);
    }

    const [prior] = await tx<FillRow[]>`
      SELECT * FROM trade.futures_order_fills WHERE order_id = ${order.id} AND engine_sequence = ${input.sequence}
    `;
    if (prior) {
      return {
        fill_key: prior.fill_key,
        position_id: prior.position_id,
        user_id: order.user_id,
        amount: parseAmount(prior.amount),
        fee: parseAmount(prior.fee),
        state: prior.state,
        order,
      };
    }

    assertFillFits(order, input.sequence, input.qty);
    const [pendingOnOrder] = await tx<{ n: number }[]>`
      SELECT 1 AS n FROM trade.futures_order_fills WHERE order_id = ${order.id} AND state = 'pending' LIMIT 1
    `;
    if (pendingOnOrder) {
      refuse('trade.futures_fill_in_progress', 'an earlier fill of this order is still being recorded — retry in a moment', 409);
    }

    const side = order.side;
    const qty = input.qty;
    const price = input.price;
    const mark = parseAmount(order.mark_price);
    const leverage = parseAmount(order.leverage);
    const limit = parseAmount(order.limit_price);
    if (!fillWithinLimit(side, price, limit)) {
      refuse('trade.futures_fill_outside_limit', `fill ${input.sequence} prices outside order ${order.id}'s limit`, 500);
    }

    const filledBefore = parseAmount(order.filled_qty);

    const [open] = await tx<{ id: string }[]>`
      SELECT id FROM trade.positions
       WHERE user_id = ${order.user_id} AND market_id = ${order.market_id} AND side = ${positionSideOf(side)}
         AND margin_mode = 'isolated' AND status = 'open'
       LIMIT 1
       FOR UPDATE
    `;
    let positionId: string;
    if (open) {
      // Checked under the position's lock, the same lock a rung or an ADL pair takes before it moves the row. A fill
      // that landed now would post into a pot the rung or pair then closes, with no open row left to apply it to.
      await refuseIfPositionBusy(tx, open.id);
      // A reduce intent computed its amounts from the row as it stood; growing the row first would change them.
      await refuseIfPositionHasPendingFill(tx, open.id, 'reduce');
      positionId = open.id;
    } else {
      const [count] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM trade.positions
         WHERE user_id = ${order.user_id} AND market_id = ${order.market_id} AND side = ${positionSideOf(side)}
           AND margin_mode = 'isolated'
      `;
      positionId = matchedSlotPositionIdFor(order.user_id, order.market_id, positionSideOf(side), count?.n ?? 0);
    }

    const step = fillMargin({ filled: filledBefore, adverseNum: BigInt(order.adverse_num) }, { side, qty, price, mark, leverage });
    // The fee at this fill's own price and side, paid from what is left of the order's fee reserve. A fill that moves
    // no margin posts nothing, so its fee (a rounding unit at most) is recorded as waived.
    const feeCharged = parseAmount(order.fee_charged);
    const fee = fillFee({ qty, price, role: input.role, rates: ratesOf(order) });
    const split = feeSplit(fee, step.amount > 0n ? feeReserveOf(order) - feeCharged : 0n);
    assertWithinHold(order, step.need, feeCharged + split.charged, parseAmount(order.released_amount));
    const fillKey = `${input.marketId}:${input.sequence}:${positionId}`;
    await tx`
      INSERT INTO trade.futures_order_fills (
        fill_key, order_id, market_id, engine_sequence, position_id, qty, price, amount,
        new_filled, new_adverse, new_applied, state, fee, fee_waived, fee_role
      ) VALUES (
        ${fillKey}, ${order.id}, ${order.market_id}, ${input.sequence}, ${positionId},
        ${formatAmount(qty)}, ${formatAmount(price)}, ${formatAmount(step.amount)},
        ${formatAmount(step.filled)}, ${step.adverseNum.toString()}, ${formatAmount(step.need)}, 'pending',
        ${formatAmount(split.charged)}, ${formatAmount(split.waived)}, ${input.role}
      )
    `;
    return {
      fill_key: fillKey,
      position_id: positionId,
      user_id: order.user_id,
      amount: step.amount,
      fee: split.charged,
      state: 'pending',
      order,
    };
  }

  private async applyIntent(
    tx: TransactionSql,
    intent: { fill_key: string; position_id: string; user_id: string; amount: Amount; order: OrderRow },
  ): Promise<string> {
    const [fill] = await tx<FillRow[]>`SELECT * FROM trade.futures_order_fills WHERE fill_key = ${intent.fill_key} FOR UPDATE`;
    if (!fill) refuse('trade.futures_fill_missing', `fill ${intent.fill_key} has no intent`, 500);
    if (fill.state === 'applied') return fill.position_id;

    const [order] = await tx<OrderRow[]>`SELECT * FROM trade.futures_orders WHERE id = ${fill.order_id} FOR UPDATE`;
    if (!order) refuse('trade.futures_order_not_found', `futures order ${fill.order_id} is not known`, 404);

    const qty = parseAmount(fill.qty);
    const price = parseAmount(fill.price);
    const amount = parseAmount(fill.amount);
    const side = order.side;
    const [row] = await tx<
      { id: string; size: string; entry_price: string; margin_initial: string; margin_current: string; status: string }[]
    >`
      SELECT id, size, entry_price, margin_initial, margin_current, status
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
      const newSize = size + qty;
      const entry = weightedEntry({ size, entryPrice: parseAmount(row.entry_price) }, { qty, price });
      await tx`
        UPDATE trade.positions
           SET size = ${formatAmount(newSize)},
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
          ${fill.position_id}, ${order.user_id}, ${order.market_id}, ${positionSideOf(side)}, 'open', 'isolated',
          ${formatAmount(qty)}, ${formatAmount(price)}, ${formatAmount(parseAmount(order.leverage))},
          ${formatAmount(amount)}, ${formatAmount(amount)}, ${order.hold_asset}, '0',
          ${order.mark_price}, ${new Date()}, NULL
        )
      `;
    }

    const filledNow = parseAmount(fill.new_filled);
    const orderStatus = filledNow === parseAmount(order.qty) ? 'filled' : 'open';
    await tx`
      UPDATE trade.futures_orders
         SET filled_qty = ${fill.new_filled},
             adverse_num = ${fill.new_adverse},
             applied_amount = ${fill.new_applied},
             fee_charged = fee_charged + ${fill.fee}::numeric,
             status = CASE WHEN status IN ('held', 'submitting', 'open', 'filled', 'submit_unknown') THEN ${orderStatus} ELSE status END,
             updated_at = now()
       WHERE id = ${order.id}
    `;
    await tx`
      UPDATE trade.futures_order_fills SET state = 'applied', applied_at = now()
       WHERE fill_key = ${intent.fill_key} AND state = 'pending'
    `;
    return fill.position_id;
  }

  // ── reduce fills ──────────────────────────────────────────────────────────

  /**
   * One reduce-only order's share of one fill: close `qty` of its position at the fill price.
   *
   * TX1 (intent): lock the order and the position, plan the fill from the row, store every amount (and, for a
   *   profit, the payout row in state `pending`), commit. From here the position is held: a close, a liquidation, a
   *   margin change or another fill on it waits until the intent is applied.
   * POSTS, each under its own key and from the stored amounts: the profit through the payout bound (paid, or left
   *   owed for the payout tick), the loss into the clearing pot, the rest of the margin share back to the trader.
   * TX2 (apply): lock the intent, the order and the position; shrink or close the row; mark the intent applied.
   *
   * A crash anywhere after TX1 leaves the intent pending; the retry finds it and replays the same keys with the same
   * amounts, so every leg posts once, and the row moves once.
   */
  private async applyReduceFill(input: FillShare): Promise<void> {
    const fill = await this.deps.sql.begin(async (tx) => this.recordReduceIntent(tx, input));
    if (fill.state === 'applied') return;
    const [order] = await this.deps.sql<OrderRow[]>`SELECT * FROM trade.futures_orders WHERE id = ${fill.order_id}`;
    if (!order) refuse('trade.futures_order_not_found', `futures order ${fill.order_id} is not known`, 404);

    const profit = parseAmount(fill.profit ?? '0');
    if (profit > 0n) {
      // The intent and the payout row are already committed; this posts, or leaves the row owed when the pot is short.
      await payOrOweProfit({
        tx: this.deps.sql,
        ledger: this.deps.ledger,
        profitId: reduceFillProfitId(fill.fill_key),
        positionId: fill.position_id,
        userId: order.user_id,
        assetId: order.hold_asset,
        amount: profit,
      });
    }
    const legs = reduceFillRecipes({
      fillKey: fill.fill_key,
      positionId: fill.position_id,
      userId: order.user_id,
      assetId: order.hold_asset,
      plan: {
        fromMargin: parseAmount(fill.loss_from_margin ?? '0'),
        fromInsurance: parseAmount(fill.loss_from_insurance ?? '0'),
        release: parseAmount(fill.margin_release ?? '0'),
      },
      fee: parseAmount(fill.fee),
    });
    if (legs.loss) await this.deps.ledger.post(legs.loss);
    if (legs.release) await this.deps.ledger.post(legs.release);

    await this.deps.sql.begin(async (tx) => this.applyReduceIntent(tx, fill.fill_key));
    if (this.deps.publishPosition) {
      try {
        await this.deps.publishPosition(fill.position_id);
      } catch {
        // A notification that fails after a settled fill is not a reason to unsettle it.
      }
    }
  }

  private async recordReduceIntent(tx: TransactionSql, input: FillShare): Promise<FillRow> {
    const [order] = await tx<OrderRow[]>`SELECT * FROM trade.futures_orders WHERE id = ${input.orderId} FOR UPDATE`;
    if (!order) refuse('trade.futures_order_not_found', `futures order ${input.orderId} is not known`, 404);
    if (order.market_id !== input.marketId) refuse('trade.futures_market_mismatch', 'a fill names an order on another market', 500);

    const [prior] = await tx<FillRow[]>`
      SELECT * FROM trade.futures_order_fills WHERE order_id = ${order.id} AND engine_sequence = ${input.sequence}
    `;
    if (prior) return prior;

    assertFillFits(order, input.sequence, input.qty);
    const [pendingOnOrder] = await tx<{ n: number }[]>`
      SELECT 1 AS n FROM trade.futures_order_fills WHERE order_id = ${order.id} AND state = 'pending' LIMIT 1
    `;
    if (pendingOnOrder) {
      refuse('trade.futures_fill_in_progress', 'an earlier fill of this order is still being recorded — retry in a moment', 409);
    }
    if (!fillWithinLimit(order.side, input.price, parseAmount(order.limit_price))) {
      refuse('trade.futures_fill_outside_limit', `fill ${input.sequence} prices outside order ${order.id}'s limit`, 500);
    }

    const [position] = await tx<PositionRowLite[]>`
      SELECT id, user_id, market_id, side, status, size, entry_price, leverage, margin_initial, margin_current,
             margin_asset, margin_adjust_request
        FROM trade.positions WHERE id = ${order.position_id} FOR UPDATE
    `;
    assertReduceFillFits(order, position, input.sequence, input.qty);
    // The same holds an opening fill waits for, under the same lock a rung or an ADL pair takes. A liquidation order's
    // own rung does not hold it back (slice 7).
    await refuseIfPositionBusy(tx, position.id, order.liquidation_rung_id);
    await refuseIfPositionHasPendingFill(tx, position.id, 'any');

    const [earlier] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM trade.futures_order_fills
       WHERE position_id = ${position.id} AND kind = 'reduce' AND state = 'applied'
    `;
    const figures = {
      side: (position as PositionRowLite).side,
      size: parseAmount(position.size),
      entryPrice: parseAmount((position as PositionRowLite).entry_price),
      margin: parseAmount((position as PositionRowLite).margin_current),
      marginInitial: parseAmount((position as PositionRowLite).margin_initial),
      qty: input.qty,
      price: input.price,
      roundingAllowance: BigInt(earlier?.n ?? '0'),
    };
    // A liquidation's fills are one liquidation: netted against each other, nothing paid out and nothing drawn from
    // the insurance fund until the tranche is done (`planLiquidationFill`).
    const plan =
      order.liquidation_rung_id != null
        ? planLiquidationFill({ ...figures, prior: await liquidationFillsSoFar(tx, order.id) })
        : planReduceFill(figures);
    if (plan.fromInsurance > 0n) {
      // Past the bankruptcy price the position has now (its margin fell after the order was placed): the same law
      // as a close through the shortfall, bounded by the fund's live balance. A refusal waits; nothing has posted.
      const insurance = await checkInsuranceBound({
        assetId: order.hold_asset,
        fromInsurance: plan.fromInsurance,
        balance: (ref) => this.deps.ledger.balance(ref),
      });
      if (!insurance.ok) {
        refuse(INSURANCE_UNDERFUNDED, `reduce fill ${input.sequence} on position ${position.id} — ${insurance.reason}`, 409);
      }
    }

    // The fill's fee comes out of the margin share it returns, so the margin left on the position is untouched and
    // what leaves the pot is the same. A share smaller than the fee (a loss took the rest) pays what it has; the rest
    // is recorded as waived. A liquidation order pays no trading fee (engine spec LQ-1).
    const fee =
      order.liquidation_rung_id != null ? 0n : fillFee({ qty: input.qty, price: input.price, role: input.role, rates: ratesOf(order) });
    const split = feeSplit(fee, plan.release);
    const fillKey = `${input.marketId}:${input.sequence}:${position.id}`;
    const filledNow = parseAmount(order.filled_qty) + input.qty;
    const [inserted] = await tx<FillRow[]>`
      INSERT INTO trade.futures_order_fills (
        fill_key, order_id, market_id, engine_sequence, position_id, qty, price, amount,
        new_filled, new_adverse, new_applied, state, kind,
        realized_pnl, loss_from_margin, loss_from_insurance, loss_unbooked, profit, margin_release,
        pot_out, initial_out, closes_position, liquidation_rung_id, fee, fee_waived, fee_role
      ) VALUES (
        ${fillKey}, ${order.id}, ${order.market_id}, ${input.sequence}, ${position.id},
        ${formatAmount(input.qty)}, ${formatAmount(input.price)}, '0',
        ${formatAmount(filledNow)}, ${order.adverse_num}, ${order.applied_amount}, 'pending', 'reduce',
        ${formatAmount(plan.realizedPnl)}, ${formatAmount(plan.fromMargin)}, ${formatAmount(plan.fromInsurance)},
        ${formatAmount(plan.unbooked)}, ${formatAmount(plan.profit)}, ${formatAmount(plan.release - split.charged)},
        ${formatAmount(plan.potOut)}, ${formatAmount(plan.initialOut)}, ${plan.closes}, ${order.liquidation_rung_id},
        ${formatAmount(split.charged)}, ${formatAmount(split.waived)}, ${input.role}
      )
      RETURNING *
    `;
    if (plan.profit > 0n) {
      // The payout intent is committed with the fill's, so a profit the fill realised is never lost to a crash: if
      // this process never comes back, the payout tick pays it under the same key.
      await tx`
        INSERT INTO trade.futures_payouts
          (profit_id, position_id, user_id, asset_id, amount, state, refusal_code, attempts, last_attempt_at)
        VALUES (
          ${reduceFillProfitId(fillKey)}, ${position.id}, ${order.user_id}, ${order.hold_asset}, ${formatAmount(plan.profit)},
          'pending', ${CLEARING_POT_SHORT}, 0, NULL
        )
        ON CONFLICT (profit_id) DO NOTHING
      `;
    }
    return inserted!;
  }

  private async applyReduceIntent(tx: TransactionSql, fillKey: string): Promise<void> {
    const [fill] = await tx<FillRow[]>`SELECT * FROM trade.futures_order_fills WHERE fill_key = ${fillKey} FOR UPDATE`;
    if (!fill) refuse('trade.futures_fill_missing', `fill ${fillKey} has no intent`, 500);
    if (fill.state === 'applied') return;
    const [order] = await tx<OrderRow[]>`SELECT * FROM trade.futures_orders WHERE id = ${fill.order_id} FOR UPDATE`;
    if (!order) refuse('trade.futures_order_not_found', `futures order ${fill.order_id} is not known`, 404);

    const qty = formatAmount(parseAmount(fill.qty));
    // The row cannot have moved since the intent: margin changes and closes (assertLiquidationHold), rungs, ADL
    // pairs and dated settlement wait for a pending intent, and funding skips the position (position-loaders.ts).
    // The guard on the update says so anyway, and a row that no longer matches throws with the posts already made,
    // which the operator reconciles from the intent row.
    const moved = fill.closes_position
      ? // A full close keeps the row's last size and margins and only closes it, as every close does
        // (`positions_size_positive_ck`); the collateral pot is empty once the posts above have run. A liquidation
        // order's close is a liquidation, as a closing rung's is.
        await tx`
          UPDATE trade.positions
             SET status = ${order.liquidation_rung_id != null ? 'liquidated' : 'closed'}, closed_at = now(), updated_at = now()
           WHERE id = ${fill.position_id} AND status = 'open' AND size = ${qty}::numeric
             AND margin_current = ${fill.pot_out}::numeric
        `
      : await tx`
          UPDATE trade.positions
             SET size = size - ${qty}::numeric,
                 margin_current = margin_current - ${fill.pot_out}::numeric,
                 margin_initial = margin_initial - ${fill.initial_out}::numeric,
                 updated_at = now()
           WHERE id = ${fill.position_id} AND status = 'open' AND size > ${qty}::numeric
             AND margin_current >= ${fill.pot_out}::numeric AND margin_initial >= ${fill.initial_out}::numeric
        `;
    if (moved.count !== 1) {
      refuse(
        FUTURES_REDUCE_FILL_UNMATCHED,
        `reduce fill ${fillKey} posted but position ${fill.position_id} no longer matches its intent — this needs an operator`,
        500,
      );
    }
    if (fill.closes_position && order.liquidation_rung_id != null) {
      // The liquidation's closing fill finishes its rung in the same transaction. The fill may arrive through the
      // engine's events after a crash, when the closed position is no longer in the liquidation scan: without this
      // the rung would stay live on a closed row for good. The tick's own finish is then a no-op.
      const [rung] = await tx<{ liquidation_id: string }[]>`
        UPDATE trade.liquidation_rungs SET state = 'applied', updated_at = now()
         WHERE rung_id = ${order.liquidation_rung_id} AND kind = 'matched' AND state IN ('planned', 'posted')
        RETURNING liquidation_id
      `;
      if (rung) {
        await tx`
          INSERT INTO trade.liquidation_attempts (liquidation_id) VALUES (${rung.liquidation_id})
          ON CONFLICT (liquidation_id) DO NOTHING
        `;
      }
    }
    const filledNow = parseAmount(fill.new_filled);
    const orderStatus = filledNow === parseAmount(order.qty) ? 'filled' : 'open';
    await tx`
      UPDATE trade.futures_orders
         SET filled_qty = ${fill.new_filled},
             status = CASE WHEN status IN ('held', 'submitting', 'open', 'filled', 'submit_unknown') THEN ${orderStatus} ELSE status END,
             updated_at = now()
       WHERE id = ${order.id}
    `;
    await tx`
      UPDATE trade.futures_order_fills SET state = 'applied', applied_at = now()
       WHERE fill_key = ${fillKey} AND state = 'pending'
    `;
  }

  /**
   * Take a position's resting reduce-only orders off the book when they no longer fit it (ADR section 1, "resting
   * reduce orders follow the margin"): the position is gone, its reduce orders now claim more than its size (newest
   * first), or an order's limit is past the bankruptcy price the position has now. Nothing to release: a reduce
   * order holds no margin. A fill the engine printed before the cancel still arrives and settles, or refuses for an
   * operator if the position cannot take it.
   */
  private async cancelReduceOrdersPastBound(positionId: string): Promise<string[]> {
    const matching = this.deps.matching;
    if (!matching) return [];
    const resting = await this.deps.sql<OrderRow[]>`
      SELECT * FROM trade.futures_orders
       WHERE position_id = ${positionId} AND reduce_only AND status = 'open'
       ORDER BY created_at, id
    `;
    if (resting.length === 0) return [];
    const [position] = await this.deps.sql<PositionRowLite[]>`
      SELECT id, user_id, market_id, side, status, size, entry_price, leverage, margin_initial, margin_current,
             margin_asset, margin_adjust_request
        FROM trade.positions WHERE id = ${positionId}
    `;
    const out: { order: OrderRow; code: string }[] = [];
    if (!position || position.status !== 'open') {
      for (const order of resting) out.push({ order, code: FUTURES_REDUCE_ONLY_NO_POSITION });
    } else {
      const size = parseAmount(position.size);
      const bound = bankruptcyPrice({
        side: position.side,
        size,
        entryPrice: parseAmount(position.entry_price),
        margin: parseAmount(position.margin_current),
      });
      let claimed = 0n;
      for (const order of resting) {
        const left = parseAmount(order.qty) - parseAmount(order.filled_qty);
        if (!withinBankruptcy(position.side, parseAmount(order.limit_price), bound)) {
          out.push({ order, code: FUTURES_REDUCE_PAST_BANKRUPTCY });
        } else if (claimed + left > size) {
          out.push({ order, code: FUTURES_REDUCE_ONLY_EXCEEDS_POSITION });
        } else {
          claimed += left;
        }
      }
    }
    const cancelled: string[] = [];
    for (const { order, code } of out) {
      const result = await matching.cancel(order.market_id, order.id);
      if (!result.cancelled) continue;
      await this.deps.sql`
        UPDATE trade.futures_orders SET refusal_code = ${code}, updated_at = now()
         WHERE id = ${order.id} AND refusal_code IS NULL
      `;
      await this.markLeftBook(order.id, result.cancellation ? parseAmount(result.cancellation.remainingQty) : null);
      cancelled.push(order.id);
    }
    return cancelled;
  }

  // ── liquidation through the book (slice 7) ───────────────────────────────

  /** The port the liquidation tick works a `matched` rung through (`matched-liquidation.ts`). */
  get liquidationPort(): MatchedLiquidationPort {
    return {
      enabled: this.deps.enabled,
      readiness: () => this.liquidationReadiness(),
      trancheFor: (input) => this.liquidationTranche(input),
      driveBook: (input) => this.driveLiquidationBook(input),
      increasingOrders: this.increasingOrderBook,
      openSize: async (positionId) => {
        const [row] = await this.deps.sql<{ status: string; size: string }[]>`
          SELECT status, size FROM trade.positions WHERE id = ${positionId}
        `;
        return row && row.status === 'open' ? parseAmount(row.size) : null;
      },
    };
  }

  private liquidationReadiness(): string | null {
    if (this.deps.priceBand === null) return FUTURES_PRICE_BAND_UNSET;
    if (!this.deps.matching) return 'trade.futures_matching_unconfigured';
    if (!this.deps.lifecycleProof) return 'trade.lifecycle_authority_unavailable';
    return null;
  }

  /**
   * The ladder sizes a tranche to the attounit; the book trades whole lots. Rounded UP, so the tranche is never smaller
   * than what restores the position, and capped at the position, so it never asks for more than there is.
   */
  private async liquidationTranche(input: { marketId: string; positionSize: Amount; sizeClosed: Amount }): Promise<Amount> {
    const [market] = await this.deps.sql<{ lot_size: string | null }[]>`
      SELECT lot_size FROM trade.markets WHERE id = ${input.marketId}
    `;
    const lot = market?.lot_size == null ? 0n : parseAmount(market.lot_size);
    let size = input.sizeClosed;
    if (lot > 0n && size % lot !== 0n) size = (size / lot + 1n) * lot;
    return size > input.positionSize ? input.positionSize : size;
  }

  /**
   * Store, send and settle the IOC of a matched liquidation rung (see `matched-liquidation.ts`).
   *
   * The order's id and client id are derived from the liquidation id and the rung id, so every call for the rung
   * finds the same row. The limit, the band and the mark are decided once, when the row is stored, and never again:
   * a crash after the row is stored sends the stored order; a crash after the engine took it leaves it `submitting`,
   * which is never sent again; each fill settles through its own intent.
   *
   *   pending ─send─▶ submitting ─reply─▶ open / filled / cancelled / rejected
   *   refused   (no price in the band is inside the bound: nothing is sent, the book takes none of it)
   */
  private async driveLiquidationBook(input: LiquidationBookInput): Promise<LiquidationBookResult> {
    const [position] = await this.deps.sql<PositionRowLite[]>`
      SELECT id, user_id, market_id, side, status, size, entry_price, leverage, margin_initial, margin_current,
             margin_asset, margin_adjust_request
        FROM trade.positions WHERE id = ${input.positionId}
    `;
    if (!position) refuse('trade.futures_position_not_found', `position ${input.positionId} is not known`, 404);
    const clientOrderId = liquidationClientOrderId(input.liquidationId, input.rungId);
    const orderId = matchedOrderIdFor(position.user_id, position.market_id, clientOrderId);

    let [order] = await this.deps.sql<OrderRow[]>`SELECT * FROM trade.futures_orders WHERE id = ${orderId}`;
    if (position.margin_adjust_request != null && (!order || order.status === 'pending' || order.status === 'held')) {
      // A leverage change or margin add or release is between its ledger post and its row write. Its fills would only
      // wait behind it (refuseIfPositionBusy), so nothing is stored or sent until it has finished: the rung waits and
      // the next tick tries again. Never a failure, and never a new rung.
      return {
        status: 'waiting',
        orderId,
        code: 'trade.margin_adjustment_in_progress',
        reason: `a margin adjustment (${position.margin_adjust_request}) is finishing on the position — the order is sent once it has`,
      };
    }
    if (!order) {
      if (position.status !== 'open') {
        refuse(
          FUTURES_REDUCE_FILL_UNMATCHED,
          `position ${position.id} is ${position.status} under a live liquidation rung ${input.rungId} — this needs an operator`,
          500,
        );
      }
      // The trader's resting orders on the position come off first, and the order is stored (so sent) only once the
      // engine has said each is off the book. Reduce-only ones: with the tranche they could claim more than the
      // position holds. Ones that would grow it: the rung holds the position, so a fill of theirs could only wait
      // behind it, and two liquidations each hitting the other's resting order would wait on each other for good.
      // Taken off before the IOC is sent, after the rung holds the position (no new order is placed on it), that
      // cannot happen: an IOC can only meet a resting order whose own liquidation has not sent its IOC yet, so the
      // waits form a chain ordered by send time, never a cycle (see the header of `matched-liquidation.ts`).
      await this.cancelTraderOrdersForLiquidation(position);
      order = await this.storeLiquidationOrder(position, input, clientOrderId, orderId);
    }
    if (order.liquidation_rung_id !== input.rungId || !order.reduce_only || order.position_id !== position.id) {
      // A trader's client id cannot reach this id (it is longer than any client id `place` accepts), so this is a bug.
      refuse('trade.liquidation_order_conflict', `order ${orderId} is not the IOC of liquidation rung ${input.rungId}`, 500);
    }

    if (order.status === 'pending' || order.status === 'held') {
      const market = await this.loadMarketById(order.market_id);
      if (!this.deps.lifecycleProof) refuse('trade.lifecycle_authority_unavailable', 'market lifecycle authority is not configured', 503);
      const proof = await this.deps.lifecycleProof(market.id);
      try {
        await this.continueOrder(order, market, proof);
      } catch (err) {
        // Never sent again; the state below says the rung waits for the engine's events.
        if (!(err instanceof MatchedOrderError && err.code === 'trade.futures_submit_unknown')) throw err;
      }
    } else if (order.status === 'open' && order.engine_filled_qty == null && this.deps.matching) {
      // An IOC never rests. If the engine says it does, take it off rather than let it work past its tick.
      const result = await this.deps.matching.cancel(order.market_id, order.id);
      if (result.cancelled) await this.markLeftBook(order.id, result.cancellation ? parseAmount(result.cancellation.remainingQty) : null);
    }
    // Fills of the IOC that met a busy counterparty and wait: settle what can settle now.
    await this.retryWaitingFillsOf(order.id);
    const state = await this.liquidationBookState(order.id);
    if (state.status !== 'done') return state;
    const settled = await this.settleLiquidationBook(order.id, input.rungId);
    return settled ?? state;
  }

  /**
   * The book is done and part of the position is left: settle what the tranche's fills kept back, once
   * (`planLiquidationSettlement`), and mark the rung `posted` in the same transaction as the row moves. The free margin
   * of the filled part comes back, a net profit is paid, and a net loss past the filled part's margin is drawn from
   * the insurance fund. Every amount is read from the applied intents and the row, which nothing else moves while the
   * rung is planned, so a crash between the posts and the transaction replays the same posts under the same keys.
   * Returns a waiting result when the fund cannot cover the draw now; null when settled (or nothing to settle).
   */
  private async settleLiquidationBook(orderId: string, rungId: string): Promise<LiquidationBookResult | null> {
    const order = await this.loadOrder(orderId);
    const [position] = await this.deps.sql<PositionRowLite[]>`
      SELECT id, user_id, market_id, side, status, size, entry_price, leverage, margin_initial, margin_current,
             margin_asset, margin_adjust_request
        FROM trade.positions WHERE id = ${order.position_id}
    `;
    // Closed by the IOC's last fill, which settled the whole tranche and finished the rung itself.
    if (!position || position.status !== 'open') return null;
    const [rung] = await this.deps.sql<{ state: string }[]>`SELECT state FROM trade.liquidation_rungs WHERE rung_id = ${rungId}`;
    if (!rung || rung.state !== 'planned') return null;

    const prior = await liquidationFillsSoFar(this.deps.sql, orderId);
    const [earlier] = await this.deps.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM trade.futures_order_fills
       WHERE position_id = ${position.id} AND kind = 'reduce' AND state = 'applied'
    `;
    const margin = parseAmount(position.margin_current);
    const plan = planLiquidationSettlement({
      size: parseAmount(position.size),
      margin,
      prior,
      roundingAllowance: BigInt(earlier?.n ?? '0'),
    });
    const root = liquidationSettlementRoot(orderId);
    if (plan.fromInsurance > 0n) {
      const loss = recipes.futuresRealizeLoss({
        positionId: position.id,
        userId: position.user_id,
        assetId: position.margin_asset,
        fromMargin: 0n,
        fromInsurance: plan.fromInsurance,
        lossId: `${root}:loss`,
      });
      // A replay after the draw posted must not be refused by the balance it lowered.
      if (!(await this.deps.ledger.getTxByKey(loss.idempotencyKey))) {
        const insurance = await checkInsuranceBound({
          assetId: position.margin_asset,
          fromInsurance: plan.fromInsurance,
          balance: (ref) => this.deps.ledger.balance(ref),
        });
        if (!insurance.ok) {
          return {
            status: 'waiting',
            orderId,
            code: INSURANCE_UNDERFUNDED,
            reason: `the book is done; the tranche's net loss past its margin is ${formatAmount(plan.fromInsurance)} and ${insurance.reason} — retried every tick`,
          };
        }
      }
      await this.deps.ledger.post(loss);
    }
    if (plan.release > 0n) {
      const base = recipes.futuresMarginRelease({
        positionId: position.id,
        userId: position.user_id,
        assetId: position.margin_asset,
        amount: plan.release,
      });
      await this.deps.ledger.post({ ...base, idempotencyKey: `futures.margin.release:${position.id}:${root}:release` });
    }
    if (plan.profit > 0n) {
      await payOrOweProfit({
        tx: this.deps.sql,
        ledger: this.deps.ledger,
        profitId: `${root}:profit`,
        positionId: position.id,
        userId: position.user_id,
        assetId: position.margin_asset,
        amount: plan.profit,
      });
    }
    await this.deps.sql.begin(async (tx) => {
      await tx`SELECT id FROM trade.positions WHERE id = ${position.id} FOR UPDATE`;
      const [live] = await tx<{ state: string }[]>`
        SELECT state FROM trade.liquidation_rungs WHERE rung_id = ${rungId} FOR UPDATE
      `;
      if (!live || live.state !== 'planned') return;
      const moved = await tx`
        UPDATE trade.positions
           SET margin_current = margin_current - ${formatAmount(plan.release)}::numeric, updated_at = now()
         WHERE id = ${position.id} AND status = 'open' AND margin_current = ${formatAmount(margin)}::numeric
      `;
      if (moved.count !== 1) {
        refuse(
          FUTURES_REDUCE_FILL_UNMATCHED,
          `liquidation ${orderId} settled its book but position ${position.id} no longer matches — this needs an operator`,
          500,
        );
      }
      await tx`UPDATE trade.liquidation_rungs SET state = 'posted', updated_at = now() WHERE rung_id = ${rungId}`;
    });
    return null;
  }

  /**
   * The resting-order book the liquidation tick pulls a position's increasing orders from before any rung
   * (`LiquidationTickDeps.increasingOrders`): the account's orders on the market that may be live at the engine
   * (`LIVE_OR_UNKNOWN`), cancelled through the engine (a `held` one before it is sent),
   * their unused hold released once every printed fill has settled. An engine that does not answer is a timeout: the
   * rung is not planned this tick.
   */
  get increasingOrderBook(): IncreasingOrderBook {
    return {
      list: async (marketId, accountId) => {
        if (!this.deps.matching) return [];
        const rows = await this.deps.sql<{ id: string; side: OrderSide; reduce_only: boolean }[]>`
          SELECT id, side, reduce_only FROM trade.futures_orders
           WHERE market_id = ${marketId} AND user_id = ${accountId} AND NOT reduce_only
             AND status IN ('held', 'submitting', 'open', 'submit_unknown')
           ORDER BY created_at, id
        `;
        return rows.map((r) => ({ orderId: r.id, side: r.side, reduceOnly: r.reduce_only }));
      },
      cancelAndRelease: async (_marketId, orderId) => {
        const result = await this.cancelForLiquidation(orderId);
        return result === 'timeout' ? 'timeout' : 'released';
      },
    };
  }

  /**
   * Take one of the trader's orders off the book for a liquidation. `timeout` when the engine did not answer.
   *
   * Every state that may be live at the engine is asked (`LIVE_OR_UNKNOWN`), not only `open`: a `submitting` or
   * `submit_unknown` order may rest in the book. A `held` order has not been sent: it is cancelled here, before any
   * submit can claim it (the submit claims `held` only), so it never reaches the book. An order the engine says is not
   * resting is left as it is; a later tick sees it again if it arrives.
   */
  private async cancelForLiquidation(orderId: string): Promise<'cancelled' | 'not_resting' | 'timeout'> {
    const unsent = await this.deps.sql<{ reduce_only: boolean }[]>`
      UPDATE trade.futures_orders
         SET status = 'cancelled', engine_filled_qty = 0, refusal_code = COALESCE(refusal_code, 'trade.liquidation_in_progress'),
             updated_at = now()
       WHERE id = ${orderId} AND status = 'held'
       RETURNING reduce_only
    `;
    if (unsent[0]) {
      if (!unsent[0].reduce_only) await this.releaseWhenDone(orderId);
      return 'cancelled';
    }
    const matching = this.deps.matching;
    if (!matching) return 'not_resting';
    const order = await this.loadOrder(orderId);
    let result: Awaited<ReturnType<MatchingClient['cancel']>>;
    try {
      result = await matching.cancel(order.market_id, order.id);
    } catch {
      return 'timeout';
    }
    if (!result.cancelled) return 'not_resting';
    await this.deps.sql`
      UPDATE trade.futures_orders SET refusal_code = 'trade.liquidation_in_progress', updated_at = now()
       WHERE id = ${order.id} AND refusal_code IS NULL
    `;
    await this.markLeftBook(order.id, result.cancellation ? parseAmount(result.cancellation.remainingQty) : null);
    if (!order.reduce_only) await this.releaseWhenDone(order.id);
    return 'cancelled';
  }

  /**
   * Take the trader's resting orders that a liquidation must not leave in the book: reduce-only orders on the position,
   * and orders on the market that would grow it. Throws when the engine does not confirm one: nothing is stored or
   * sent, and the next tick tries again.
   */
  private async cancelTraderOrdersForLiquidation(position: PositionRowLite): Promise<void> {
    const growing: OrderSide = position.side === 'long' ? 'buy' : 'sell';
    const resting = await this.deps.sql<{ id: string }[]>`
      SELECT id FROM trade.futures_orders
       WHERE status IN ('held', 'submitting', 'open', 'submit_unknown') AND liquidation_rung_id IS NULL
         AND ((reduce_only AND position_id = ${position.id})
              OR (NOT reduce_only AND user_id = ${position.user_id} AND market_id = ${position.market_id} AND side = ${growing}))
       ORDER BY created_at, id
    `;
    for (const { id } of resting) {
      if ((await this.cancelForLiquidation(id)) === 'timeout') {
        refuse(
          'trade.liquidation_increasing_cancel_timeout',
          `order ${id} did not confirm its cancel; the liquidation order of position ${position.id} is not sent until it does`,
          503,
        );
      }
    }
  }

  /**
   * Decide the IOC once and store it. The bankruptcy price is the row's (the rung holds the row, so it is the one every
   * fill will be planned against); the widening is read from the insurance fund's live balance now.
   */
  private async storeLiquidationOrder(
    position: PositionRowLite,
    input: LiquidationBookInput,
    clientOrderId: string,
    orderId: string,
  ): Promise<OrderRow> {
    const band = this.deps.priceBand;
    if (band === null)
      refuse(FUTURES_PRICE_BAND_UNSET, 'the futures price band is unset on this deployment — the owner names it; nothing is invented');
    const market = await this.loadMarketById(position.market_id);
    const size = parseAmount(position.size);
    if (input.sizeClosed <= 0n || input.sizeClosed > size) {
      refuse(
        'trade.liquidation_tranche_invalid',
        `the tranche ${formatAmount(input.sizeClosed)} does not fit position ${position.id}`,
        500,
      );
    }
    const bankruptcy = bankruptcyPrice({
      side: position.side,
      size,
      entryPrice: parseAmount(position.entry_price),
      margin: parseAmount(position.margin_current),
    });
    const bandAt = priceBandAround(input.mark, band);
    const closes = input.closesPosition && input.sizeClosed === size;
    const insurance = closes ? await this.insuranceAvailable(position.margin_asset) : 0n;
    const lot = market.lot_size == null ? 0n : parseAmount(market.lot_size);
    const { limit, widened } = liquidationLimit({
      side: position.side,
      size,
      closesPosition: closes,
      bankruptcy,
      insurance,
      // One fill per lot at most; with no lot grid, one per attounit of size (the most conservative bound).
      fillsBound: lot > 0n ? (size + lot - 1n) / lot : size,
      band: bandAt,
    });
    await this.deps.sql`
      INSERT INTO trade.futures_orders (
        id, user_id, market_id, client_order_id, side, order_type, qty, limit_price, mark_price,
        band_low, band_high, leverage, hold_asset, status, refusal_code, engine_filled_qty,
        reduce_only, position_id, bankruptcy_price, liquidation_rung_id
      ) VALUES (
        ${orderId}, ${position.user_id}, ${position.market_id}, ${clientOrderId}, ${reducingSide(position.side)}, 'market',
        ${formatAmount(input.sizeClosed)}, ${formatAmount(limit ?? widened)}, ${formatAmount(input.mark)},
        ${formatAmount(bandAt.low)}, ${formatAmount(bandAt.high)}, ${formatAmount(parseAmount(position.leverage))},
        ${position.margin_asset}, ${limit === null ? 'refused' : 'pending'},
        ${limit === null ? FUTURES_REDUCE_BANKRUPTCY_OUTSIDE_BAND : null}, ${limit === null ? '0' : null},
        true, ${position.id}, ${formatAmount(bankruptcy)}, ${input.rungId}
      )
      ON CONFLICT (user_id, market_id, client_order_id) DO NOTHING
    `;
    return this.loadOrder(orderId);
  }

  /** The insurance fund's live balance, from the account the loss recipe draws. Unreadable is 0: no widening, never a guess. */
  private async insuranceAvailable(assetId: string): Promise<Amount> {
    try {
      const { amount } = await this.deps.ledger.balance(recipeInsuranceAccount(assetId));
      return amount > 0n ? amount : 0n;
    } catch {
      return 0n;
    }
  }

  /** Where the rung's IOC stands, from its row and its fill intents only. */
  private async liquidationBookState(orderId: string): Promise<LiquidationBookResult> {
    const order = await this.loadOrder(orderId);
    const filled = parseAmount(order.filled_qty);
    if (order.status === 'refused') return { status: 'done', orderId, filled, code: order.refusal_code };
    if (order.status === 'pending' || order.status === 'held') {
      return { status: 'waiting', orderId, code: 'trade.liquidation_order_not_sent', reason: 'the IOC has not reached the engine yet' };
    }
    const final = engineFilled(order);
    if (final == null) {
      if (order.status === 'submitting' || order.status === 'submit_unknown') {
        return {
          status: 'waiting',
          orderId,
          code: 'trade.futures_submit_unknown',
          reason: 'the engine did not answer for the IOC; it is not sent again, and the rung waits for its fill and cancellation events',
        };
      }
      return { status: 'waiting', orderId, code: 'trade.liquidation_order_resting', reason: 'the IOC has not left the book' };
    }
    // `filled_qty` moves only when a fill's intent applies, so a fill still pending, or waiting on a busy
    // counterparty, keeps it below what the engine filled.
    if (filled !== final) {
      return {
        status: 'waiting',
        orderId,
        code: 'trade.futures_fill_in_progress',
        reason: `${formatAmount(filled)} of the ${formatAmount(final)} the engine filled has settled`,
      };
    }
    return { status: 'done', orderId, filled, code: order.refusal_code };
  }

  // ── cancel, release ───────────────────────────────────────────────────────

  /**
   * The caller's own matched orders, newest first. `open` is every order that can still fill or still holds margin
   * for a fill on its way (`LIVE_OR_UNKNOWN` plus `pending`); `all` is every state. The page size is the caller's.
   */
  async listForUser(
    userId: string,
    input: { readonly scope: 'open' | 'all'; readonly limit: number; readonly symbol?: string | null },
  ): Promise<(MatchedOrderView & { readonly symbol: string; readonly createdAt: string })[]> {
    const live = ['pending', ...LIVE_OR_UNKNOWN];
    const rows = await this.deps.sql<(OrderRow & { symbol: string; created_at: Date })[]>`
      SELECT o.*, m.symbol FROM trade.futures_orders o JOIN trade.markets m ON m.id = o.market_id
       WHERE o.user_id = ${userId}
         ${input.scope === 'open' ? this.deps.sql`AND o.status IN ${this.deps.sql(live)}` : this.deps.sql``}
         ${input.symbol ? this.deps.sql`AND m.symbol = ${input.symbol}` : this.deps.sql``}
         AND o.liquidation_rung_id IS NULL
       ORDER BY o.created_at DESC, o.id
       LIMIT ${input.limit}
    `;
    return rows.map((row) => ({ ...presentOrder(row), symbol: row.symbol, createdAt: new Date(row.created_at).toISOString() }));
  }

  /** Cancel a resting order we own, then release the part of its hold that no fill used. */
  async cancel(principal: Principal, orderId: string): Promise<MatchedOrderView> {
    const row = await this.loadOrder(orderId).catch(() => null);
    if (!row || row.user_id !== principal.userId) refuse('trade.futures_order_not_found', `futures order ${orderId} not found`, 404);
    if (!LIVE_OR_UNKNOWN.includes(row.status as (typeof LIVE_OR_UNKNOWN)[number])) {
      await this.releaseWhenDone(orderId);
      return presentOrder(await this.loadOrder(orderId));
    }
    if (!this.deps.matching) refuse('trade.futures_matching_unconfigured', 'the matching engine is not configured', 503);
    const result = await this.deps.matching.cancel(row.market_id, orderId);
    if (result.cancelled) {
      // Without the remainder the release waits for the engine's cancellation event, which carries it.
      await this.markLeftBook(orderId, result.cancellation ? parseAmount(result.cancellation.remainingQty) : null);
      await this.releaseWhenDone(orderId);
    }
    return presentOrder(await this.loadOrder(orderId));
  }

  /**
   * The engine says an order has left the book. Releases the unused hold for a futures order; returns false for
   * anything that is not one, so the caller can run its own path.
   */
  async releaseEngineCancellation(orderId: string, remainingQty: string): Promise<boolean> {
    if (!mayBeMatchedOrderId(orderId)) return false;
    const rows = await this.deps.sql<{ status: string }[]>`SELECT status FROM trade.futures_orders WHERE id = ${orderId}`;
    if (!rows[0]) return false;
    await this.markLeftBook(orderId, parseAmount(remainingQty));
    await this.releaseWhenDone(orderId);
    return true;
  }

  /**
   * The engine has taken the order off the book. Records it as cancelled (a live state only: a filled order stays
   * filled) and, when the remainder is known, how much the engine filled in all. The first remainder recorded wins.
   */
  private async markLeftBook(orderId: string, remainingQty: Amount | null): Promise<void> {
    await this.deps.sql`
      UPDATE trade.futures_orders
         SET status = CASE WHEN status IN ('held', 'submitting', 'open', 'submit_unknown') THEN 'cancelled' ELSE status END,
             engine_filled_qty = COALESCE(engine_filled_qty, qty - ${remainingQty == null ? null : formatAmount(remainingQty)}::numeric),
             updated_at = now()
       WHERE id = ${orderId}
    `;
  }

  /**
   * Take resting orders off the book once their limit has left the band around the current mark (futures ADR
   * section 1), and resting reduce-only orders once they no longer fit their position (`cancelReduceOrdersPastBound`). The engine's collar checks an incoming order only, so without this a resting order placed when the
   * mark was 100 could still fill at 100 after the mark fell to 50, far beyond the margin it holds.
   *
   * A market whose mark cannot be read is skipped and reported, never judged against an old price. The cancel goes
   * through the engine first; the hold is released exactly as for a customer cancel, after every printed fill settles.
   */
  async cancelOutsideBand(): Promise<{ cancelled: string[]; skipped: { marketId: string; reason: string }[] }> {
    const cancelled: string[] = [];
    const skipped: { marketId: string; reason: string }[] = [];
    const band = this.deps.priceBand;
    const matching = this.deps.matching;
    // Resting reduce orders follow their position first: no mark is needed to see that a position has gone, that its
    // reduce orders claim more than it holds, or that a limit is past the bankruptcy price after a margin change.
    const reducing = await this.deps.sql<{ position_id: string }[]>`
      SELECT DISTINCT position_id FROM trade.futures_orders WHERE reduce_only AND status = 'open' ORDER BY position_id
    `;
    for (const { position_id } of reducing) cancelled.push(...(await this.cancelReduceOrdersPastBound(position_id)));
    const markets = await this.deps.sql<{ market_id: string; symbol: string }[]>`
      SELECT DISTINCT o.market_id, m.symbol
        FROM trade.futures_orders o JOIN trade.markets m ON m.id = o.market_id
       WHERE o.status = 'open'
       ORDER BY o.market_id
    `;
    if (markets.length === 0) return { cancelled, skipped };
    if (band === null || !matching) {
      const reason = band === null ? FUTURES_PRICE_BAND_UNSET : 'trade.futures_matching_unconfigured';
      return { cancelled, skipped: markets.map((m) => ({ marketId: m.market_id, reason })) };
    }
    const at = this.deps.now();
    for (const market of markets) {
      let mark: Amount;
      try {
        mark = await this.deps.markFor(market.market_id, market.symbol, at, null);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        skipped.push({ marketId: market.market_id, reason: typeof code === 'string' ? code : 'trade.mark_unavailable' });
        continue;
      }
      const bandAt = priceBandAround(mark, band);
      const resting = await this.deps.sql<OrderRow[]>`
        SELECT * FROM trade.futures_orders WHERE market_id = ${market.market_id} AND status = 'open' ORDER BY id
      `;
      for (const order of resting) {
        // An order answers to the wider of the static band and the band it was accepted under (D-instruments-08): a band
        // narrowing again, or the dynamic range being cleared, never cancels an order its band accepted.
        const accepted = bandFractionOf(parseAmount(order.mark_price), parseAmount(order.band_high));
        const own = accepted > band ? priceBandAround(mark, accepted) : bandAt;
        if (limitWithinBand(parseAmount(order.limit_price), own)) continue;
        const result = await matching.cancel(order.market_id, order.id);
        if (!result.cancelled) continue;
        await this.deps.sql`
          UPDATE trade.futures_orders SET refusal_code = 'trade.futures_price_outside_band', updated_at = now()
           WHERE id = ${order.id} AND refusal_code IS NULL
        `;
        await this.markLeftBook(order.id, result.cancellation ? parseAmount(result.cancellation.remainingQty) : null);
        await this.releaseWhenDone(order.id);
        cancelled.push(order.id);
      }
    }
    return { cancelled, skipped };
  }

  /**
   * Whether a fill belongs here: true when both of its orders are matched futures orders, false when neither is (a
   * spot-path order, or a house market-maker order, on any market). One of each cannot be settled by either path,
   * since each side's money sits in a different kind of hold, so it refuses for an operator rather than settling half.
   */
  async ownsFill(fill: { makerOrderId: string; takerOrderId: string }): Promise<boolean> {
    const ids = [fill.makerOrderId, fill.takerOrderId].filter(mayBeMatchedOrderId);
    const rows =
      ids.length === 0 ? [] : await this.deps.sql<{ id: string }[]>`SELECT id FROM trade.futures_orders WHERE id IN ${this.deps.sql(ids)}`;
    const known = new Set(rows.map((r) => r.id));
    const maker = known.has(fill.makerOrderId);
    const taker = known.has(fill.takerOrderId);
    if (maker && taker) return true;
    if (!maker && !taker) return false;
    refuse(
      FUTURES_FILL_CROSSES_ORDER_PATHS,
      `a fill pairs a matched futures order with an order from another path (maker ${fill.makerOrderId}, taker ${fill.takerOrderId}) — this needs an operator`,
      500,
    );
  }

  /**
   * Return the order's unused hold, once the order can no longer fill. Written only when every fill the engine
   * printed for the order has settled and none is pending, and never more than what is left of the hold after the
   * fills, so a fill still in flight is never left without its margin.
   */
  private async releaseWhenDone(orderId: string): Promise<void> {
    const order = await this.loadOrder(orderId).catch(() => null);
    if (!order) return;
    if (!ORDER_TERMINAL.includes(order.status as (typeof ORDER_TERMINAL)[number])) return;
    // Until every fill the engine printed has settled, part of the hold still belongs to a fill on its way. Once it
    // has, no further fill fits the order (`assertFillFits`), so what is left can go back.
    const final = engineFilled(order);
    if (final == null || parseAmount(order.filled_qty) !== final) return;
    const [pending] = await this.deps.sql<{ n: number }[]>`
      SELECT 1 AS n FROM trade.futures_order_fills WHERE order_id = ${orderId} AND state = 'pending' LIMIT 1
    `;
    if (pending) return;
    const applied = parseAmount(order.applied_amount);
    const feeCharged = parseAmount(order.fee_charged);
    assertWithinHold(order, applied, feeCharged, 0n);
    const remainder = holdOf(order) - applied - feeCharged;
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
      UPDATE trade.futures_orders SET released_amount = ${formatAmount(remainder)}, updated_at = now() WHERE id = ${orderId}
    `;
  }

  // ── reads and loads ───────────────────────────────────────────────────────

  private async loadOrder(orderId: string): Promise<OrderRow> {
    const [row] = await this.deps.sql<OrderRow[]>`SELECT * FROM trade.futures_orders WHERE id = ${orderId}`;
    if (!row) refuse('trade.futures_order_not_found', `futures order ${orderId} not found`, 404);
    return row;
  }

  private async findOrderByClientId(userId: string, symbol: string, clientOrderId: string): Promise<OrderRow | null> {
    const [row] = await this.deps.sql<OrderRow[]>`
      SELECT o.* FROM trade.futures_orders o
        JOIN trade.markets m ON m.id = o.market_id
       WHERE o.user_id = ${userId} AND m.symbol = ${symbol} AND o.client_order_id = ${clientOrderId}
    `;
    return row ?? null;
  }

  private async loadMarket(symbol: string): Promise<MarketRow> {
    const [m] = await this.deps.sql<MarketRow[]>`
      SELECT id, symbol, kind, status, base_asset, quote_asset, lot_size,
             futures_contract_style, futures_expiry_at, futures_settlement_fixing
        FROM trade.markets WHERE symbol = ${symbol} LIMIT 1
    `;
    if (!m) refuse('trade.market_not_found', `unknown market ${symbol}`, 404);
    if (m.kind !== 'futures') refuse('trade.not_futures_market', `market ${symbol} is ${m.kind}, not futures`, 400);
    if (m.status !== 'active') refuse('trade.market_not_tradable', `market ${symbol} is ${m.status}`, 400);
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

  private async loadMarketById(marketId: string): Promise<MarketRow> {
    const [m] = await this.deps.sql<MarketRow[]>`
      SELECT id, symbol, kind, status, base_asset, quote_asset, lot_size,
             futures_contract_style, futures_expiry_at, futures_settlement_fixing
        FROM trade.markets WHERE id = ${marketId} LIMIT 1
    `;
    if (!m) refuse('trade.market_not_found', `market ${marketId} not found`, 404);
    return m;
  }
}

/**
 * The request a split's keys name: a short digest of everything that decides its children, so the same clientOrderId
 * with another size, side, price, correction, leverage or collateral never replays or adds to the first one's children.
 */
export function splitRequestTag(input: PlaceMatchedOrderInput): string {
  const parts = [
    input.symbol,
    input.side,
    input.type,
    formatAmount(input.qty),
    input.limitPrice === undefined ? '' : formatAmount(input.limitPrice),
    input.priceCorrection === 'adjust' ? 'adjust' : 'reject',
    formatAmount(input.leverage),
    typeof input.collateralClass === 'string' ? input.collateralClass : 'cash',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 8);
}

/** A typed refusal (a code and a 4xx status) from a child's own checks; null for anything that left the outcome unknown. */
function typedRefusal(err: unknown): { code: string; message: string } | null {
  if (!(err instanceof Error)) return null;
  const { code, status } = err as Error & { code?: unknown; status?: unknown };
  if (typeof code !== 'string' || typeof status !== 'number' || status >= 500) return null;
  return { code, message: err.message };
}

/** The order's own shape, before anything is read: the same refusals for a single order and a split. */
function refuseMalformedOrder(input: PlaceMatchedOrderInput): void {
  if (input.priceCorrection !== undefined && input.priceCorrection !== 'reject' && input.priceCorrection !== 'adjust') {
    refuse('trade.price_correction_invalid', 'priceCorrection is reject or adjust');
  }
  if (input.side !== 'buy' && input.side !== 'sell') refuse('trade.side_invalid', 'side must be buy or sell');
  if (input.type !== 'limit' && input.type !== 'market') refuse('trade.order_type_invalid', 'type must be limit or market');
  if (input.qty <= 0n) refuse('trade.size_invalid', `qty must be greater than zero, got ${formatAmount(input.qty)}`);
  if (input.type === 'limit' && (input.limitPrice === undefined || input.limitPrice <= 0n)) {
    refuse('trade.invalid_price', 'a limit order needs a positive limitPrice');
  }
  if (input.type === 'market' && input.limitPrice !== undefined) {
    refuse('trade.limit_price_on_market_order', 'a market order takes no limitPrice: its protective limit is the band edge');
  }
}

function sameRequest(row: OrderRow, input: PlaceMatchedOrderInput): boolean {
  if (row.user_id !== input.userId || row.side !== input.side || row.order_type !== input.type) return false;
  if (parseAmount(row.qty) !== input.qty) return false;
  if (row.reduce_only !== (input.reduceOnly === true)) return false;
  // A reduce-only order carries its position's leverage, whatever the request said.
  if (!row.reduce_only && parseAmount(row.leverage) !== input.leverage) return false;
  if (input.type === 'limit') {
    if (input.limitPrice === undefined) return false;
    // An adjusted order stored the band edge it was moved to: the same request moves to the same edge of its own band.
    const asked =
      input.priceCorrection === 'adjust'
        ? correctToBand(input.limitPrice, { low: parseAmount(row.band_low), high: parseAmount(row.band_high) })
        : input.limitPrice;
    if (parseAmount(row.limit_price) !== asked) return false;
  }
  return true;
}
