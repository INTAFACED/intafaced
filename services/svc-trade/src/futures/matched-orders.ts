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
 * PHASE 1 SCOPE. Opens and grows only. A reduce-only order, or any fill that reduces a position, is not built
 * here (slice 6b): the bankruptcy bound, realised PnL on a reduce, and the margin share released by a reduce
 * are not in this file, and a reduce-only order is refused at placement. A position is never shrunk by a
 * matched fill, so a resting order's margin always covers what it can still fill.
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
 * Nothing here holds a balance. Every amount is recomputed from the order row, the intent row, or the ledger.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, recipes, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { EngineSubmitRequest, EngineSubmitResult, MatchingClient } from '../spot/matching-client.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { checkCloseQuantity } from './desk-quantity.js';
import { checkLeverage } from './initial-margin.js';
import { checkMarginModeForFuturesOpen } from './margin-mode.js';
import { checkOpenAdmission, PRETRADE_LIMIT_HTTP_STATUS } from './pretrade-limits.js';
import { assertDatedFuturesTradable } from './dated-futures.js';
import { isInsufficientFunds } from './futures-payouts.js';
import type { DerivativesAccessGate } from './derivatives-access.js';
import { matchedOrderIdFor, matchedSlotPositionIdFor } from './ids.js';
import { defaultLiquidationId } from './liquidation-tick.js';
import {
  FUTURES_PRICE_BAND_UNSET,
  fillMargin,
  fillWithinLimit,
  limitWithinBand,
  orderHoldAmount,
  priceBandAround,
  protectiveLimit,
  weightedEntry,
  type OrderSide,
  type PriceBand,
} from './matched-order-plan.js';

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
 * The refusals that mean "not yet": a position is being liquidated, deleveraged or reviewed, or an earlier fill of the
 * same order is still being recorded. A fill refused with one of these waits in `trade.futures_fill_waits`.
 */
const FILL_WAIT_CODES: readonly string[] = [
  'trade.liquidation_in_progress',
  'trade.position_under_review',
  'trade.futures_fill_in_progress',
];

function fillMustWait(err: unknown): err is MatchedOrderError {
  return err instanceof MatchedOrderError && FILL_WAIT_CODES.includes(err.code);
}

/** How many waiting fills one retry tick takes. A batch size, not a limit on anyone: the rest go on the next tick. */
export const MATCHED_FILL_RETRY_BATCH = 200;

/** A fill that pairs a matched futures order with an order from the spot path. Neither path can settle it. */
export const FUTURES_FILL_CROSSES_ORDER_PATHS = 'trade.futures_fill_crosses_order_paths';

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
}

export interface MatchedOrderView {
  readonly orderId: string;
  readonly marketId: string;
  readonly userId: string;
  readonly side: OrderSide;
  readonly type: 'limit' | 'market';
  readonly qty: string;
  readonly limitPrice: string;
  readonly markPrice: string;
  readonly bandLow: string;
  readonly bandHigh: string;
  readonly holdAmount: string;
  readonly filledQty: string;
  readonly appliedAmount: string;
  readonly releasedAmount: string;
  readonly status: MatchedOrderStatus;
  readonly refusalCode: string | null;
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
  /** The owner's leverage cap. Null is unset, and refuses. */
  readonly maxLeverage: Amount | null;
  readonly now: () => Date;
  /** The price a futures order is read against. Required and never supplied by the caller. */
  readonly markFor: (marketId: string, symbol: string, at: Date, size: Amount | null) => Promise<Amount>;
  /** Refuses a NEW order on a position that has a liquidation rung, a planned ADL pair or a review hold. */
  readonly assertPositionIdle: (positionId: string) => Promise<void>;
  /**
   * D-account-07: the risk agreement and eligibility gate, the same one the at-mark open runs. Null when the
   * deployment wires none (tests); production always wires it, and with nothing published it refuses every order.
   */
  readonly assertDerivativesAccess?: DerivativesAccessGate | null;
  /** The PX-S01 lifecycle proof for a PLACE on this market. Null is unset, and refuses. */
  readonly lifecycleProof: ((marketId: string) => Promise<LifecycleAdmissionProof>) | null;
  readonly admission?: TradingAdmissionPort;
  /** Publishes the private positions update after a fill commits. Best effort: it never undoes a settled fill. */
  readonly publishPosition?: (positionId: string) => Promise<void>;
}

interface OrderRow {
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

const ORDER_TERMINAL = ['filled', 'cancelled', 'rejected'] as const;
/** States in which the order may still be live at the engine, so a cancel must ask it. */
const LIVE_OR_UNKNOWN = ['held', 'submitting', 'open', 'submit_unknown'] as const;

/**
 * The hold the order locked at placement, from its own terms. It is never stored as a figure: the ledger hold is
 * the money, and these terms are what it was opened for.
 */
function holdOf(order: OrderRow): Amount {
  return orderHoldAmount({
    side: order.side,
    qty: parseAmount(order.qty),
    limit: parseAmount(order.limit_price),
    mark: parseAmount(order.mark_price),
    leverage: parseAmount(order.leverage),
  });
}

/**
 * How much of the order the engine filled in all, or null while that is not known. A cancel or a cancellation
 * event says it (qty less the remainder); a fill can still arrive after it, because the engine printed the fill
 * before the cancel and the event or reply carrying it is slower.
 */
/**
 * What fills applied plus what was released never exceeds what the order locked. The hold is derived from the
 * order's stored terms, so this is the check a stored hold column used to give; it runs before every apply or release.
 */
function assertWithinHold(order: OrderRow, applied: Amount, released: Amount): void {
  if (applied + released <= holdOf(order)) return;
  refuse('trade.futures_hold_exceeded', `order ${order.id} would use more than the margin it holds`, 500);
}

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

function positionSideOf(side: OrderSide): 'long' | 'short' {
  return side === 'buy' ? 'long' : 'short';
}

function presentOrder(row: OrderRow): MatchedOrderView {
  return {
    orderId: row.id,
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
    status: row.status,
    refusalCode: row.refusal_code,
  };
}

function refuse(code: string, message: string, status = 400): never {
  throw new MatchedOrderError(message, code, status);
}

/**
 * A fill may not grow a position that a liquidation rung, a planned ADL pair or a review hold is working on. The
 * refusal is a 409: the event is redelivered, and once the rung or pair has finished the fill lands (on the same row,
 * or on a new one if the row was closed). The codes are the ones the position service uses for the same states.
 */
async function refuseIfPositionBusy(sql: Sql | TransactionSql, positionId: string): Promise<void> {
  const [hold] = await sql<{ live_rung: boolean; adl_planned: boolean; parked: boolean }[]>`
    SELECT
      EXISTS (SELECT 1 FROM trade.liquidation_rungs r
               WHERE r.position_id = ${positionId} AND r.state IN ('planned', 'posted')) AS live_rung,
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
}

/** Leverage is stored as numeric(8,2). A value with finer precision would be rounded in the row, not in the hold. */
const LEVERAGE_STEP = 10n ** 16n;

export class MatchedFuturesOrders {
  constructor(private readonly deps: MatchedOrdersDeps) {}

  /** Whether NEW matched orders are accepted. Read by the at-mark open, which must not run alongside them. */
  get matchingEnabled(): boolean {
    return this.deps.enabled;
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
    if (input.reduceOnly === true) {
      refuse(
        'trade.futures_reduce_only_unsupported',
        'a reduce-only futures order through the engine is not built yet (futures ADR slice 6b); close through the existing close path',
      );
    }
    if (principal.userId !== input.userId) refuse('auth.credential_denied', 'the order must be placed by its own account', 403);
    const clientOrderId = input.clientOrderId?.trim() ?? '';
    if (clientOrderId.length === 0 || clientOrderId.length > 64) {
      refuse('trade.client_order_id_required', 'clientOrderId is required (1–64 chars) — omit would double-lock margin on retry');
    }
    const modeCheck = checkMarginModeForFuturesOpen(input.marginMode);
    if (!modeCheck.ok) refuse(modeCheck.code ?? 'trade.margin_mode_invalid', modeCheck.reason ?? 'margin mode refused');
    if (input.side !== 'buy' && input.side !== 'sell') refuse('trade.side_invalid', 'side must be buy or sell');
    if (input.type !== 'limit' && input.type !== 'market') refuse('trade.order_type_invalid', 'type must be limit or market');
    if (input.qty <= 0n) refuse('trade.size_invalid', `qty must be greater than zero, got ${formatAmount(input.qty)}`);
    if (input.type === 'limit' && (input.limitPrice === undefined || input.limitPrice <= 0n)) {
      refuse('trade.invalid_price', 'a limit order needs a positive limitPrice');
    }
    if (input.type === 'market' && input.limitPrice !== undefined) {
      refuse('trade.limit_price_on_market_order', 'a market order takes no limitPrice: its protective limit is the band edge');
    }

    const existing = await this.findOrderByClientId(input.userId, input.symbol, clientOrderId);
    if (existing) {
      if (!sameRequest(existing, input)) {
        refuse('trade.client_order_id_conflict', 'this clientOrderId names a different order', 409);
      }
      return this.resume(existing);
    }

    // After the replay above, so an order that was accepted and holds margin is finished on retry even if a new
    // agreement or rules version was published meanwhile (the same order as the at-mark open).
    if (this.deps.assertDerivativesAccess) {
      await this.deps.assertDerivativesAccess({ userId: input.userId, tier: principal.tier ?? null, region: context.region ?? null });
    }

    const market = await this.loadMarket(input.symbol);
    const band = this.deps.priceBand;
    if (band === null) {
      refuse(FUTURES_PRICE_BAND_UNSET, 'the futures price band is unset on this deployment — the owner names it; nothing is invented');
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

    const at = this.deps.now();
    const mark = await this.deps.markFor(market.id, market.symbol, at, input.qty);
    const bandAt: PriceBand = priceBandAround(mark, band);
    const limit = input.type === 'market' ? protectiveLimit(input.side, bandAt) : (input.limitPrice as Amount);
    if (!limitWithinBand(limit, bandAt)) {
      refuse('trade.futures_price_outside_band', 'the limit is outside the price band around the mark', 400);
    }

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

    const hold = orderHoldAmount({ side: input.side, qty: input.qty, limit, mark, leverage: input.leverage });
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
        band_low, band_high, leverage, hold_asset, status
      ) VALUES (
        ${orderId}, ${input.userId}, ${market.id}, ${clientOrderId}, ${input.side}, ${input.type},
        ${formatAmount(input.qty)}, ${formatAmount(limit)}, ${formatAmount(mark)},
        ${formatAmount(bandAt.low)}, ${formatAmount(bandAt.high)}, ${formatAmount(input.leverage)},
        ${market.quote_asset}, 'pending'
      )
      ON CONFLICT (user_id, market_id, client_order_id) DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) {
      const raced = await this.findOrderByClientId(input.userId, input.symbol, clientOrderId);
      if (!raced || !sameRequest(raced, input)) refuse('trade.client_order_id_conflict', 'this clientOrderId names a different order', 409);
      return this.resume(raced);
    }

    const row = await this.loadOrder(orderId);
    return this.continueOrder(row, market, proof);
  }

  /** A retry of an order whose placement stopped part-way: continue from what the row says, with its stored numbers. */
  private async resume(row: OrderRow): Promise<MatchedOrderView> {
    if (row.status === 'pending' || row.status === 'held') {
      const market = await this.loadMarketById(row.market_id);
      if (!this.deps.lifecycleProof) refuse('trade.lifecycle_authority_unavailable', 'market lifecycle authority is not configured', 503);
      const proof = await this.deps.lifecycleProof(market.id);
      return this.continueOrder(row, market, proof);
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
  private async continueOrder(row: OrderRow, market: MarketRow, proof: LifecycleAdmissionProof): Promise<MatchedOrderView> {
    if (row.status === 'pending') {
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
    await this.applyFill({ marketId: fill.marketId, orderId: fill.takerOrderId, sequence: fill.sequence, price, qty });
    await this.applyFill({ marketId: fill.marketId, orderId: fill.makerOrderId, sequence: fill.sequence, price, qty });
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
    const rows = await this.deps.sql<
      { market_id: string; engine_sequence: string; maker_order_id: string; taker_order_id: string; price: string; qty: string }[]
    >`
      SELECT market_id, engine_sequence::text, maker_order_id, taker_order_id, price::text, qty::text
        FROM trade.futures_fill_waits
       WHERE settled_at IS NULL
       ORDER BY retried_at NULLS FIRST, created_at, engine_sequence
       LIMIT ${limit}
    `;
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
      // Repeated under the lock in recordIntent; checked here too so that the usual case refuses the fill whole.
      const [open] = await this.deps.sql<{ id: string }[]>`
        SELECT id FROM trade.positions
         WHERE user_id = ${order.user_id} AND market_id = ${order.market_id} AND side = ${positionSideOf(order.side)}
           AND margin_mode = 'isolated' AND status = 'open'
         LIMIT 1
      `;
      if (open) await refuseIfPositionBusy(this.deps.sql, open.id);
    }
  }

  /**
   * One order's share of one fill.
   *
   * TX1 (intent): lock the order, decide the position it grows or opens, store the amount, commit.
   * POST: `futuresOrderMarginApply` under the fill key.
   * TX2 (apply): lock the position and the order, mark the intent applied, move the row, commit.
   */
  private async applyFill(input: { marketId: string; orderId: string; sequence: number; price: Amount; qty: Amount }): Promise<void> {
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
        }),
      );
    }

    const positionId = await this.deps.sql.begin(async (tx) => this.applyIntent(tx, intent));
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
    input: { marketId: string; orderId: string; sequence: number; price: Amount; qty: Amount },
  ): Promise<{
    fill_key: string;
    position_id: string;
    user_id: string;
    amount: Amount;
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
    assertWithinHold(order, step.need, parseAmount(order.released_amount));
    const fillKey = `${input.marketId}:${input.sequence}:${positionId}`;
    await tx`
      INSERT INTO trade.futures_order_fills (
        fill_key, order_id, market_id, engine_sequence, position_id, qty, price, amount,
        new_filled, new_adverse, new_applied, state
      ) VALUES (
        ${fillKey}, ${order.id}, ${order.market_id}, ${input.sequence}, ${positionId},
        ${formatAmount(qty)}, ${formatAmount(price)}, ${formatAmount(step.amount)},
        ${formatAmount(step.filled)}, ${step.adverseNum.toString()}, ${formatAmount(step.need)}, 'pending'
      )
    `;
    return { fill_key: fillKey, position_id: positionId, user_id: order.user_id, amount: step.amount, state: 'pending', order };
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

  // ── cancel, release ───────────────────────────────────────────────────────

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
   * section 1). The engine's collar checks an incoming order only, so without this a resting order placed when the
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
        if (limitWithinBand(parseAmount(order.limit_price), bandAt)) continue;
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
    const rows = await this.deps.sql<{ id: string }[]>`
      SELECT id FROM trade.futures_orders WHERE id IN (${fill.makerOrderId}, ${fill.takerOrderId})
    `;
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
      SELECT id, symbol, kind, status, quote_asset, lot_size,
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
      SELECT id, symbol, kind, status, quote_asset, lot_size,
             futures_contract_style, futures_expiry_at, futures_settlement_fixing
        FROM trade.markets WHERE id = ${marketId} LIMIT 1
    `;
    if (!m) refuse('trade.market_not_found', `market ${marketId} not found`, 404);
    return m;
  }
}

function sameRequest(row: OrderRow, input: PlaceMatchedOrderInput): boolean {
  if (row.user_id !== input.userId || row.side !== input.side || row.order_type !== input.type) return false;
  if (parseAmount(row.qty) !== input.qty) return false;
  if (parseAmount(row.leverage) !== input.leverage) return false;
  if (input.type === 'limit' && parseAmount(row.limit_price) !== input.limitPrice) return false;
  return true;
}
