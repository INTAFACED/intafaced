/**
 * Futures conditional orders: store, caller door, and the one-shot trigger.
 *
 * A trigger claims the row under a unique key before it closes or places.
 * A second worker updates zero rows. A failed close is written on the row.
 *
 * While futures orders go through the book (`placeReduce` wired), a fired order
 * closes through one reduce-only order in the book, the same path as a manual
 * reduce, on the trader's standing instruction. Its quantity is fixed on the row
 * before it is placed, and its client id is the conditional order's own, so a
 * retry after a crash finds the same order and never places a second one.
 */
import { randomUUID } from 'node:crypto';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql, TransactionSql } from 'postgres';
import { checkCloseQuantity } from '../desk-quantity.js';
import { FuturesError } from '../position-service.js';
import {
  FILL_WAIT_CODES,
  FUTURES_REDUCE_ONLY_EXCEEDS_POSITION,
  FUTURES_REDUCE_ONLY_NO_POSITION,
  orderFills,
  reservedReduceQty,
} from '../matched-orders.js';
import { refuseFuturesRestingLimit, type RestingLimitInput } from './resting.js';
import {
  closingSide,
  conditionalHash,
  nextTrail,
  priceOnProtectionSide,
  requestHash,
  requireClientKey,
  triggerCrossed,
  validateConditional,
  type AttachmentLeg,
  type ConditionalKind,
  type ConditionalSide,
  type ConditionalStatus,
  type CreateConditionalInput,
  type ParsedConditional,
} from './validate.js';

export interface ConditionalOrderView {
  readonly id: string;
  readonly market: string;
  readonly kind: ConditionalKind;
  readonly side: ConditionalSide;
  readonly quantity: string;
  readonly triggerPrice: string | null;
  readonly limitPrice: string | null;
  readonly trailingDistance: string | null;
  readonly trailExtreme: string | null;
  readonly reduceOnly: true;
  readonly clientOrderId: string;
  readonly positionId: string | null;
  readonly attachment: AttachmentLeg | null;
  readonly status: ConditionalStatus;
  readonly cancelReason: string | null;
  readonly failureReason: string | null;
  /** The price a trigger is judged against. Only the published mark is wired. */
  readonly triggerSource: 'mark';
  /** The order a fired conditional order placed in the book, once placed. */
  readonly closeOrderId: string | null;
  /**
   * What the fired order's latest book order asks for: its own quantity less what earlier attempts closed, or for a
   * position's take-profit or stop-loss the position as it is then, less what its other reduce-only orders claim.
   */
  readonly firedQuantity: string | null;
  /** What earlier book orders of this fired order closed, when the book took less than the whole of one. */
  readonly closedQuantity: string | null;
  readonly createdAt: string;
}

/** A reduce-only order a fired conditional order places in the book. */
export interface ReduceOnInstruction {
  readonly userId: string;
  readonly symbol: string;
  readonly side: ConditionalSide;
  readonly type: 'market' | 'limit';
  readonly qty: Amount;
  readonly limitPrice?: Amount;
  readonly clientOrderId: string;
}

/** What the book order became, as far as the caller knows on return. */
export interface ReducePlaced {
  readonly orderId: string;
  readonly status: string;
  readonly qty: string;
  readonly filledQty: string;
  readonly refusalCode: string | null;
}

export interface ProtectionView {
  readonly positionId: string;
  readonly takeProfit: ConditionalOrderView | null;
  readonly stopLoss: ConditionalOrderView | null;
}

export interface ProtectionInput {
  readonly takeProfit?: unknown;
  readonly stopLoss?: unknown;
  readonly clientRequestId: unknown;
}

const TRIGGER_OFF =
  'conditional orders cannot be armed: the trigger job is off (TRADE_FUTURES_CONDITIONAL_JOBS_ENABLED / TRADE_FUTURES_CONDITIONAL_JOBS_INTERVAL_MS)';

export interface ConditionalOrderDeps {
  readonly sql: Sql;
  /** False when the trigger job is off or its interval is blank. Required; there is no default. */
  readonly triggerScheduled: boolean;
  /** Published mark as a decimal string. Null skips a trigger and refuses a trail or a protection replace. */
  publishedMark(marketId: string, symbol: string): Promise<string | null>;
  closeQuantity(userId: string, positionId: string, input: { quantity: Amount; clientCloseId: string }): Promise<unknown>;
  placeLimit(input: RestingLimitInput): Promise<{ orderId: string }>;
  /**
   * While futures orders go through the book, where the at-mark close and `placeLimit` are retired: places a fired
   * order's one reduce-only order on the trader's standing instruction (the conditional order's id). Null or absent
   * keeps `closeQuantity` and `placeLimit`.
   */
  readonly placeReduce?: ((input: ReduceOnInstruction, instructionId: string) => Promise<ReducePlaced>) | null;
  /** How many finished orders (filled, cancelled, failed) the list carries, newest first. Default 100. */
  readonly listFinishedLimit?: number;
}

/**
 * What a fired order has done so far, on the row. Each attempt is one reduce-only order in the book: `attempt` numbers
 * it (its client id is `cond:<id>`, then `cond:<id>:<n>`), `qty` is what it asks for, fixed before it is placed, and
 * `closed` is what earlier attempts closed.
 */
interface FireResult {
  readonly attempt?: number;
  readonly qty?: string;
  readonly orderId?: string;
  readonly restingOrderId?: string;
  readonly filledQty?: string;
  readonly closed?: string;
}

/**
 * Refusals that pass on their own: the position is mid-fill, mid-margin-change, under a liquidation rung, an ADL pair
 * or a review hold (the book's own wait list), the engine has not answered, or admission could not be reached. The
 * row stays `triggered` and the next tick places again on the same client id.
 */
const PASSING_REFUSALS = new Set([...FILL_WAIT_CODES, 'trade.futures_submit_unknown', 'authority.unavailable']);
/** Book order states before the order is in the book. */
const PRE_BOOK = new Set(['pending', 'held', 'submitting', 'submit_unknown']);

/** The claim key of a fired order the book path owns. Rows the at-mark path claimed (`fire:`) are never placed in the book. */
function bookKey(id: string): string {
  return `book:${id}`;
}

function bookClientId(id: string, attempt: number): string {
  return attempt > 0 ? `cond:${id}:${attempt}` : `cond:${id}`;
}

interface OrderRow {
  id: string;
  user_id: string;
  market_id: string;
  position_id: string | null;
  client_order_id: string;
  kind: ConditionalKind;
  side: ConditionalSide;
  quantity: string;
  trigger_price: string | null;
  limit_price: string | null;
  trailing_distance: string | null;
  trail_extreme: string | null;
  reduce_only: boolean;
  attachment: AttachmentLeg | null;
  status: ConditionalStatus;
  cancel_reason: string | null;
  failure_reason: string | null;
  trigger_key: string | null;
  request_hash: string;
  result: unknown;
  created_at: Date | string;
  symbol: string;
}

interface ReducingPosition {
  id: string;
  kind: string;
  symbol: string;
  lot_size: string | null;
  position_id: string | null;
  position_side: 'long' | 'short' | null;
  size: string | null;
}

const LOCK_TIMEOUT_MS = 3_000;
const NOT_FOUND = 'trade.conditional_not_found';
const LIST_FINISHED_LIMIT = 100;

function money(raw: string | null): string | null {
  if (raw == null) return null;
  return formatAmount(parseAmount(raw));
}

function fireResult(raw: unknown): FireResult {
  return raw != null && typeof raw === 'object' ? (raw as FireResult) : {};
}

function present(row: OrderRow): ConditionalOrderView {
  const created = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  const fired = fireResult(row.result);
  return {
    id: row.id,
    market: row.symbol,
    kind: row.kind,
    side: row.side,
    quantity: formatAmount(parseAmount(row.quantity)),
    triggerPrice: money(row.trigger_price),
    limitPrice: money(row.limit_price),
    trailingDistance: money(row.trailing_distance),
    trailExtreme: money(row.trail_extreme),
    reduceOnly: true,
    clientOrderId: row.client_order_id,
    positionId: row.position_id,
    attachment: row.attachment,
    status: row.status,
    cancelReason: row.cancel_reason,
    failureReason: row.failure_reason,
    triggerSource: 'mark',
    closeOrderId: fired.orderId ?? fired.restingOrderId ?? null,
    firedQuantity: fired.qty == null ? null : formatAmount(parseAmount(fired.qty)),
    closedQuantity: fired.closed == null ? null : formatAmount(parseAmount(fired.closed)),
    createdAt: created.toISOString(),
  };
}

function failureCode(err: unknown): string {
  if (err instanceof FuturesError) return err.code;
  return 'trade.conditional_close_failed';
}

/** The typed code of a refusal from the book path (FuturesError, MatchedOrderError, TradingControlError). */
function refusalCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z_]+\.[a-z0-9_.]+$/.test(code) ? code : null;
}

function passes(err: unknown, code: string | null): boolean {
  if (code != null && PASSING_REFUSALS.has(code)) return true;
  const status = (err as { status?: unknown } | null)?.status;
  // An error with no typed code (a dropped connection, a query that failed) is not a refusal: try again.
  return code == null || (typeof status === 'number' && status >= 500);
}

function optionalPrice(field: string, raw: unknown): Amount | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new FuturesError(`${field} must be a decimal string`, 'trade.conditional_amount_invalid', 400);
  }
  try {
    const amount = parseAmount(raw);
    if (amount <= 0n) throw new Error('non-positive');
    return amount;
  } catch (err) {
    if (err instanceof FuturesError) throw err;
    throw new FuturesError(`${field} must be a positive decimal string`, 'trade.conditional_amount_invalid', 400);
  }
}

export function createConditionalOrderService(deps: ConditionalOrderDeps) {
  const { sql } = deps;

  async function findByClient(userId: string, clientOrderId: string): Promise<OrderRow | null> {
    const [row] = await sql<OrderRow[]>`
      SELECT o.*, m.symbol
      FROM trade.futures_conditional_orders o
      JOIN trade.markets m ON m.id = o.market_id
      WHERE o.user_id = ${userId} AND o.client_order_id = ${clientOrderId}
    `;
    return row ?? null;
  }

  async function findOwn(userId: string, id: string): Promise<OrderRow | null> {
    const [row] = await sql<OrderRow[]>`
      SELECT o.*, m.symbol
      FROM trade.futures_conditional_orders o
      JOIN trade.markets m ON m.id = o.market_id
      WHERE o.id = ${id} AND o.user_id = ${userId}
    `;
    return row ?? null;
  }

  async function reducingPosition(userId: string, market: string, side: ConditionalSide): Promise<ReducingPosition> {
    const [row] = await sql<ReducingPosition[]>`
      SELECT m.id, m.kind, m.symbol, m.lot_size,
             p.id AS position_id, p.side AS position_side, p.size
      FROM trade.markets m
      LEFT JOIN trade.positions p
        ON p.market_id = m.id
       AND p.user_id = ${userId}
       AND p.status = 'open'
       AND (
         (p.side = 'long' AND ${side} = 'sell')
         OR (p.side = 'short' AND ${side} = 'buy')
       )
      WHERE m.symbol = ${market}
      LIMIT 1
    `;
    if (!row) throw new FuturesError('market not found', 'trade.market_not_found', 404);
    if (row.kind !== 'futures') {
      throw new FuturesError('market is not a futures market', 'trade.conditional_market_not_futures', 400);
    }
    if (row.position_id == null || row.size == null || row.position_side == null) {
      throw new FuturesError('order would not reduce an open position', 'trade.conditional_would_increase', 400);
    }
    return row;
  }

  async function insertOrder(
    tx: TransactionSql,
    input: {
      userId: string;
      marketId: string;
      symbol: string;
      positionId: string;
      clientOrderId: string;
      kind: ConditionalKind;
      side: ConditionalSide;
      quantity: Amount;
      triggerPrice: Amount | null;
      limitPrice: Amount | null;
      trailingDistance: Amount | null;
      trailExtreme: Amount | null;
      attachment: AttachmentLeg | null;
      requestHash: string;
    },
  ): Promise<OrderRow> {
    const id = randomUUID();
    const [row] = await tx<OrderRow[]>`
      INSERT INTO trade.futures_conditional_orders (
        id, user_id, market_id, position_id, client_order_id, kind, side, quantity,
        trigger_price, limit_price, trailing_distance, trail_extreme, reduce_only,
        attachment, status, request_hash
      ) VALUES (
        ${id}, ${input.userId}, ${input.marketId}, ${input.positionId}, ${input.clientOrderId},
        ${input.kind}, ${input.side}, ${formatAmount(input.quantity)},
        ${input.triggerPrice == null ? null : formatAmount(input.triggerPrice)},
        ${input.limitPrice == null ? null : formatAmount(input.limitPrice)},
        ${input.trailingDistance == null ? null : formatAmount(input.trailingDistance)},
        ${input.trailExtreme == null ? null : formatAmount(input.trailExtreme)},
        true, ${input.attachment}, 'armed', ${input.requestHash}
      )
      RETURNING *
    `;
    return { ...row!, symbol: input.symbol };
  }

  async function create(userId: string, raw: CreateConditionalInput): Promise<{ order: ConditionalOrderView; replay: boolean }> {
    const parsed: ParsedConditional = validateConditional(raw);
    const hash = conditionalHash(parsed);
    const existing = await findByClient(userId, parsed.clientOrderId);
    if (existing) {
      if (existing.request_hash !== hash) {
        throw new FuturesError('clientOrderId was already used for a different conditional order', 'trade.client_order_id_conflict', 409);
      }
      return { order: present(existing), replay: true };
    }

    if (!deps.triggerScheduled) {
      throw new FuturesError(TRIGGER_OFF, 'trade.conditional_trigger_off', 503);
    }

    const position = await reducingPosition(userId, parsed.market, parsed.side);
    const size = parseAmount(position.size!);
    const lot = checkCloseQuantity({
      quantity: parsed.quantity,
      size,
      lotSize: position.lot_size == null ? null : parseAmount(position.lot_size),
    });
    if (!lot.ok) throw new FuturesError(lot.reason, lot.code, 400);

    let triggerPrice = parsed.triggerPrice;
    let trailExtreme: Amount | null = null;
    if (parsed.kind === 'trailing_stop' && parsed.trailingDistance != null) {
      const markRaw = await deps.publishedMark(position.id, position.symbol);
      if (markRaw == null) {
        throw new FuturesError('published mark is missing — a trail is not armed at an invented price', 'trade.mark_missing', 409);
      }
      const trailed = nextTrail({
        side: parsed.side,
        extreme: parseAmount(markRaw),
        mark: parseAmount(markRaw),
        distance: parsed.trailingDistance,
      });
      if (trailed.trigger <= 0n) {
        throw new FuturesError('trailing distance leaves no positive trigger', 'trade.conditional_trail_unusable', 400);
      }
      triggerPrice = trailed.trigger;
      trailExtreme = trailed.extreme;
    }

    try {
      const row = await insertOrder(sql as unknown as TransactionSql, {
        userId,
        marketId: position.id,
        symbol: position.symbol,
        positionId: position.position_id!,
        clientOrderId: parsed.clientOrderId,
        kind: parsed.kind,
        side: parsed.side,
        quantity: parsed.quantity,
        triggerPrice,
        limitPrice: parsed.limitPrice,
        trailingDistance: parsed.trailingDistance,
        trailExtreme,
        attachment: null,
        requestHash: hash,
      });
      return { order: present(row), replay: false };
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      const again = await findByClient(userId, parsed.clientOrderId);
      if (!again || again.request_hash !== hash) {
        throw new FuturesError('clientOrderId was already used for a different conditional order', 'trade.client_order_id_conflict', 409);
      }
      return { order: present(again), replay: true };
    }
  }

  /**
   * Every live order (armed or triggered) and the most recent finished ones, oldest first. The screen reads this every
   * few seconds, so a long history is cut; a live order is never left out.
   */
  async function list(userId: string): Promise<ConditionalOrderView[]> {
    const finished = deps.listFinishedLimit ?? LIST_FINISHED_LIMIT;
    const rows = await sql<OrderRow[]>`
      SELECT o.*, m.symbol
      FROM trade.futures_conditional_orders o
      JOIN trade.markets m ON m.id = o.market_id
      WHERE o.user_id = ${userId}
        AND (
          o.status IN ('armed', 'triggered')
          OR o.id IN (
            SELECT f.id FROM trade.futures_conditional_orders f
            WHERE f.user_id = ${userId} AND f.status NOT IN ('armed', 'triggered')
            ORDER BY f.created_at DESC, f.id DESC
            LIMIT ${finished}
          )
        )
      ORDER BY o.created_at, o.id
    `;
    return rows.map(present);
  }

  async function get(userId: string, id: string): Promise<ConditionalOrderView> {
    const row = await findOwn(userId, id);
    if (!row) throw new FuturesError('conditional order not found', NOT_FOUND, 404);
    return present(row);
  }

  async function cancel(userId: string, id: string): Promise<ConditionalOrderView> {
    await sql`
      UPDATE trade.futures_conditional_orders
      SET status = 'cancelled', cancel_reason = 'cancelled', updated_at = now()
      WHERE id = ${id} AND user_id = ${userId} AND status = 'armed'
    `;
    const row = await findOwn(userId, id);
    if (!row) throw new FuturesError('conditional order not found', NOT_FOUND, 404);
    if (row.status === 'cancelled') return present(row);
    throw new FuturesError(`conditional order is ${row.status}`, 'trade.conditional_not_cancellable', 409);
  }

  async function replaceProtection(userId: string, positionId: string, raw: ProtectionInput): Promise<ProtectionView> {
    const clientRequestId = requireClientKey(raw.clientRequestId, 'clientRequestId', 'trade.client_request_id_required');
    const takeProfit = optionalPrice('takeProfit', raw.takeProfit);
    const stopLoss = optionalPrice('stopLoss', raw.stopLoss);
    const hash = requestHash({
      positionId,
      takeProfit: takeProfit == null ? '' : formatAmount(takeProfit),
      stopLoss: stopLoss == null ? '' : formatAmount(stopLoss),
    });

    return sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
      const [pos] = await tx<
        {
          id: string;
          user_id: string;
          side: 'long' | 'short';
          size: string;
          status: string;
          market_id: string;
          symbol: string;
          kind: string;
          lot_size: string | null;
        }[]
      >`
        SELECT p.id, p.user_id, p.side, p.size, p.status, p.market_id, m.symbol, m.kind, m.lot_size
        FROM trade.positions p
        JOIN trade.markets m ON m.id = p.market_id
        WHERE p.id = ${positionId} AND p.user_id = ${userId}
        FOR UPDATE OF p
      `;
      if (!pos) throw new FuturesError('position not found', 'trade.position_not_found', 404);
      if (pos.kind !== 'futures') {
        throw new FuturesError('market is not a futures market', 'trade.conditional_market_not_futures', 400);
      }
      if (pos.status !== 'open') throw new FuturesError(`position is ${pos.status}`, 'trade.position_not_open', 400);

      const [prior] = await tx<{ request_hash: string; result: ProtectionView }[]>`
        SELECT request_hash, result
        FROM trade.futures_protection_requests
        WHERE user_id = ${userId} AND client_request_id = ${clientRequestId}
      `;
      if (prior) {
        if (prior.request_hash !== hash) {
          throw new FuturesError(
            'clientRequestId was already used for a different protection replace',
            'trade.client_order_id_conflict',
            409,
          );
        }
        return prior.result;
      }

      if ((takeProfit != null || stopLoss != null) && !deps.triggerScheduled) {
        throw new FuturesError(TRIGGER_OFF, 'trade.conditional_trigger_off', 503);
      }

      const markRaw = await deps.publishedMark(pos.market_id, pos.symbol);
      if (markRaw == null) {
        throw new FuturesError('published mark is missing — protection is not priced from an invented mark', 'trade.mark_missing', 409);
      }
      const mark = parseAmount(markRaw);
      if (takeProfit != null && !priceOnProtectionSide({ positionSide: pos.side, leg: 'take_profit', mark, price: takeProfit })) {
        throw new FuturesError('takeProfit is on the wrong side of the mark', 'trade.protection_wrong_side', 400);
      }
      if (stopLoss != null && !priceOnProtectionSide({ positionSide: pos.side, leg: 'stop_loss', mark, price: stopLoss })) {
        throw new FuturesError('stopLoss is on the wrong side of the mark', 'trade.protection_wrong_side', 400);
      }

      const size = parseAmount(pos.size);
      const lot = checkCloseQuantity({
        quantity: size,
        size,
        lotSize: pos.lot_size == null ? null : parseAmount(pos.lot_size),
      });
      if (!lot.ok) throw new FuturesError(lot.reason, lot.code, 400);

      await tx`
        UPDATE trade.futures_conditional_orders
        SET status = 'cancelled', cancel_reason = 'replaced', updated_at = now()
        WHERE position_id = ${pos.id} AND user_id = ${userId} AND attachment IS NOT NULL AND status = 'armed'
      `;

      const side = closingSide(pos.side);
      const legs = {
        positionId: pos.id,
        takeProfit: null as ConditionalOrderView | null,
        stopLoss: null as ConditionalOrderView | null,
      };
      if (takeProfit != null) {
        const row = await insertOrder(tx, {
          userId,
          marketId: pos.market_id,
          symbol: pos.symbol,
          positionId: pos.id,
          clientOrderId: `p:${clientRequestId}:tp`,
          kind: 'take_profit',
          side,
          quantity: size,
          triggerPrice: takeProfit,
          limitPrice: null,
          trailingDistance: null,
          trailExtreme: null,
          attachment: 'take_profit',
          requestHash: hash,
        });
        legs.takeProfit = present(row);
      }
      if (stopLoss != null) {
        const row = await insertOrder(tx, {
          userId,
          marketId: pos.market_id,
          symbol: pos.symbol,
          positionId: pos.id,
          clientOrderId: `p:${clientRequestId}:sl`,
          kind: 'stop_market',
          side,
          quantity: size,
          triggerPrice: stopLoss,
          limitPrice: null,
          trailingDistance: null,
          trailExtreme: null,
          attachment: 'stop_loss',
          requestHash: hash,
        });
        legs.stopLoss = present(row);
      }
      await tx`
        INSERT INTO trade.futures_protection_requests (user_id, client_request_id, position_id, request_hash, result)
        VALUES (${userId}, ${clientRequestId}, ${pos.id}, ${hash}, ${tx.json(legs as never)})
      `;
      return legs;
    });
  }

  async function markFailed(id: string, key: string, err: unknown): Promise<void> {
    const code = failureCode(err);
    await sql`
      UPDATE trade.futures_conditional_orders
      SET status = 'failed', failure_reason = ${code}, updated_at = now()
      WHERE id = ${id} AND trigger_key = ${key} AND status = 'triggered'
    `;
  }

  async function cancelPositionGone(id: string, key: string): Promise<void> {
    await sql`
      UPDATE trade.futures_conditional_orders
      SET status = 'cancelled', cancel_reason = 'position_gone', updated_at = now()
      WHERE id = ${id} AND trigger_key = ${key} AND status = 'triggered'
    `;
  }

  /**
   * The quantity this attempt asks the book for, fixed on the row once so every retry of the attempt asks for the
   * same order. A position's take-profit or stop-loss closes the position as it is then, less what its other live
   * reduce-only orders already claim; any other order closes what is left of its own quantity, never more than that
   * room. `gone` when the position is no longer open, `no_room` when other reduce-only orders claim all of it.
   */
  async function fireQuantity(row: OrderRow, key: string): Promise<Amount | 'gone' | 'no_room'> {
    const fired = fireResult(row.result);
    if (fired.qty != null) return parseAmount(fired.qty);
    const [pos] = await sql<{ id: string; size: string; status: string }[]>`
      SELECT id, size, status FROM trade.positions WHERE id = ${row.position_id} AND user_id = ${row.user_id}
    `;
    if (!pos || pos.status !== 'open') return 'gone';
    const room = parseAmount(pos.size) - (await reservedReduceQty(sql, pos.id));
    const left = parseAmount(row.quantity) - parseAmount(fired.closed ?? '0');
    const qty = row.attachment != null ? room : left < room ? left : room;
    if (qty <= 0n) {
      // The room may be taken by this very attempt, placed by another worker that fixed its quantity first.
      const [now] = await sql<{ result: unknown }[]>`SELECT result FROM trade.futures_conditional_orders WHERE id = ${row.id}`;
      const theirs = fireResult(now?.result);
      return theirs.qty != null && (theirs.attempt ?? 0) === (fired.attempt ?? 0) ? parseAmount(theirs.qty) : 'no_room';
    }
    const [fixed] = await sql<{ result: unknown }[]>`
      UPDATE trade.futures_conditional_orders
      SET result = COALESCE(result, '{}'::jsonb) || ${sql.json({ qty: formatAmount(qty) })}, updated_at = now()
      WHERE id = ${row.id} AND trigger_key = ${key} AND status = 'triggered' AND (result ->> 'qty') IS NULL
      RETURNING result
    `;
    if (fixed) return qty;
    // Another worker fixed it first: use theirs.
    const [again] = await sql<{ result: unknown }[]>`SELECT result FROM trade.futures_conditional_orders WHERE id = ${row.id}`;
    const theirs = fireResult(again?.result).qty;
    return theirs == null ? 'gone' : parseAmount(theirs);
  }

  /**
   * A fired order through the book: one reduce-only order on the trader's standing instruction. Safe to run again.
   * When the book takes less than the whole of a market attempt (too little inside the band), the rest comes off and
   * the next tick places a new attempt for what is left, so a stop keeps working until its size is closed.
   */
  async function executeThroughBook(
    row: OrderRow,
    key: string,
    place: (input: ReduceOnInstruction, instructionId: string) => Promise<ReducePlaced>,
  ): Promise<void> {
    if (row.kind === 'stop_limit' && row.limit_price == null) {
      await markFailed(row.id, key, new FuturesError('limitPrice is required', 'trade.conditional_field_required', 400));
      return;
    }
    const fired = fireResult(row.result);
    const attempt = fired.attempt ?? 0;
    const closed = parseAmount(fired.closed ?? '0');
    const qty = await fireQuantity(row, key);
    if (qty === 'gone') {
      // A position closed while a part of it was still to close is a stop that has done its work.
      if (closed > 0n) await setOutcome(row.id, key, 'filled', null, fired);
      else await cancelPositionGone(row.id, key);
      return;
    }
    if (qty === 'no_room') {
      await setOutcome(row.id, key, 'failed', FUTURES_REDUCE_ONLY_EXCEEDS_POSITION, fired);
      return;
    }
    let placed: ReducePlaced;
    try {
      placed = await place(
        {
          userId: row.user_id,
          symbol: row.symbol,
          side: row.side,
          type: row.kind === 'stop_limit' ? 'limit' : 'market',
          qty,
          ...(row.kind === 'stop_limit' ? { limitPrice: parseAmount(row.limit_price!) } : {}),
          clientOrderId: bookClientId(row.id, attempt),
        },
        row.id,
      );
    } catch (err) {
      const code = refusalCode(err);
      if (code === FUTURES_REDUCE_ONLY_NO_POSITION) {
        if (closed > 0n) await setOutcome(row.id, key, 'filled', null, fired);
        else await cancelPositionGone(row.id, key);
      } else if (!passes(err, code)) {
        await setOutcome(row.id, key, 'failed', code, { ...fired, qty: formatAmount(qty) });
      }
      return;
    }
    const result: FireResult = { ...fired, qty: formatAmount(qty), orderId: placed.orderId, filledQty: placed.filledQty };
    if (placed.status === 'rejected' || placed.status === 'refused') {
      await setOutcome(row.id, key, 'failed', placed.refusalCode ?? 'trade.futures_engine_refused', result);
      return;
    }
    if (PRE_BOOK.has(placed.status)) {
      // Not in the book yet: stays triggered with its order named, and the next tick carries it on.
      await keepWorking(row.id, key, result);
      return;
    }
    if (row.kind === 'stop_limit') {
      // A stop-limit's work is done once its limit is in the book; the order then lives in the orders list.
      if (placed.status === 'open' || placed.status === 'filled') await setOutcome(row.id, key, 'filled', null, result);
      else await setOutcome(row.id, key, 'failed', `trade.conditional_order_${placed.status}`, result);
      return;
    }
    const nowClosed = closed + parseAmount(placed.filledQty);
    if (placed.status === 'filled') {
      // A whole-position leg has closed the position, and closing it cancels the other leg (`position_closed`).
      await setOutcome(row.id, key, 'filled', null, { ...result, closed: formatAmount(nowClosed) });
      return;
    }
    if (placed.status === 'cancelled') {
      // A fill the engine printed before the cancel can still be settling. The attempt is counted, and the next one
      // sized, only once every fill the engine says it made has landed; until then the next tick reads it again.
      const fills = await orderFills(sql, placed.orderId);
      if (fills == null || fills.engine == null || fills.settled < fills.engine) {
        await keepWorking(row.id, key, result);
        return;
      }
      const finalClosed = closed + fills.settled;
      if (row.attachment == null && finalClosed >= parseAmount(row.quantity)) {
        await setOutcome(row.id, key, 'filled', null, {
          ...result,
          filledQty: formatAmount(fills.settled),
          closed: formatAmount(finalClosed),
        });
        return;
      }
      // The book had less than the attempt inside the band and the rest came off: the next tick places a new attempt
      // for what is left. Only the worker that saw this attempt end moves it on.
      const next = {
        attempt: attempt + 1,
        closed: formatAmount(finalClosed),
        orderId: placed.orderId,
        filledQty: formatAmount(fills.settled),
      };
      await sql`
        UPDATE trade.futures_conditional_orders
        SET result = ${sql.json(next)},
            updated_at = now()
        WHERE id = ${row.id} AND trigger_key = ${key} AND status = 'triggered'
          AND COALESCE((result ->> 'attempt')::int, 0) = ${attempt}
      `;
      return;
    }
    // Open: its fills are still settling. Stays triggered, and the next tick reads it again.
    await keepWorking(row.id, key, result);
  }

  async function keepWorking(id: string, key: string, result: FireResult): Promise<void> {
    await sql`
      UPDATE trade.futures_conditional_orders SET result = ${sql.json(result as never)}, updated_at = now()
      WHERE id = ${id} AND trigger_key = ${key} AND status = 'triggered'
    `;
  }

  /** The last word on a fired order. */
  async function setOutcome(
    id: string,
    key: string,
    status: 'filled' | 'failed',
    reason: string | null,
    result: FireResult,
  ): Promise<void> {
    await sql`
      UPDATE trade.futures_conditional_orders
      SET status = ${status}, failure_reason = ${reason}, result = ${sql.json(result as never)}, updated_at = now()
      WHERE id = ${id} AND trigger_key = ${key} AND status = 'triggered'
    `;
  }

  async function executeClaimed(row: OrderRow): Promise<void> {
    if (deps.placeReduce) {
      await executeThroughBook(row, bookKey(row.id), deps.placeReduce);
      return;
    }
    const key = `fire:${row.id}`;
    const [pos] = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM trade.positions
      WHERE id = ${row.position_id} AND user_id = ${row.user_id}
    `;
    if (!pos || pos.status !== 'open') {
      await sql`
        UPDATE trade.futures_conditional_orders
        SET status = 'cancelled', cancel_reason = 'position_gone', updated_at = now()
        WHERE id = ${row.id} AND trigger_key = ${key} AND status = 'triggered'
      `;
      return;
    }
    if (row.kind === 'stop_limit') {
      if (row.limit_price == null) {
        await markFailed(row.id, key, new FuturesError('limitPrice is required', 'trade.conditional_field_required', 400));
        return;
      }
      try {
        const placed = await deps.placeLimit({
          userId: row.user_id,
          market: row.symbol,
          side: row.side,
          quantity: formatAmount(parseAmount(row.quantity)),
          limitPrice: formatAmount(parseAmount(row.limit_price)),
          reduceOnly: true,
          clientOrderId: `lim:${row.id}`,
        });
        await sql`
          UPDATE trade.futures_conditional_orders
          SET status = 'filled', result = ${sql.json({ restingOrderId: placed.orderId })}, updated_at = now()
          WHERE id = ${row.id} AND trigger_key = ${key} AND status = 'triggered'
        `;
      } catch (err) {
        await markFailed(row.id, key, err);
      }
      return;
    }
    try {
      await deps.closeQuantity(row.user_id, pos.id, {
        quantity: parseAmount(row.quantity),
        clientCloseId: `cond:${row.id}`,
      });
      await sql`
        UPDATE trade.futures_conditional_orders
        SET status = 'filled', updated_at = now()
        WHERE id = ${row.id} AND trigger_key = ${key} AND status = 'triggered'
      `;
    } catch (err) {
      if (err instanceof FuturesError && (err.code === 'trade.position_not_found' || err.code === 'trade.position_not_open')) {
        await sql`
          UPDATE trade.futures_conditional_orders
          SET status = 'cancelled', cancel_reason = 'position_gone', updated_at = now()
          WHERE id = ${row.id} AND trigger_key = ${key} AND status = 'triggered'
        `;
        return;
      }
      await markFailed(row.id, key, err);
    }
  }

  async function evaluate(input: { enabled: boolean }): Promise<{ fired: number }> {
    if (input.enabled !== true) return { fired: 0 };
    // One row that cannot be worked must not stop every other trader's orders: each row's error is kept, the tick
    // carries on, and the first error is thrown at the end for the job to report.
    let failure: unknown = null;
    const work = async (row: OrderRow) => {
      try {
        await executeClaimed(row);
      } catch (err) {
        failure ??= err;
      }
    };
    if (deps.placeReduce) {
      // Fired orders the book path has not settled yet: a crash before the order was placed, a passing refusal, fills
      // still landing, or a part fill with more to close. Placing again on the same client id finds the same order.
      // Rows the at-mark path claimed (`fire:`) are not placed again here: their close may already have run.
      const fired = await sql<OrderRow[]>`
        SELECT o.*, m.symbol
        FROM trade.futures_conditional_orders o
        JOIN trade.markets m ON m.id = o.market_id
        WHERE o.status = 'triggered' AND o.trigger_key = 'book:' || o.id::text
        ORDER BY o.updated_at, o.id
      `;
      for (const row of fired) await work(row);
    }
    const rows = await sql<OrderRow[]>`
      SELECT o.*, m.symbol
      FROM trade.futures_conditional_orders o
      JOIN trade.markets m ON m.id = o.market_id
      WHERE o.status = 'armed'
      ORDER BY o.created_at, o.id
    `;
    let fired = 0;
    const marks = new Map<string, string | null>();
    for (const row of rows) {
      if (row.position_id != null) {
        const [pos] = await sql<{ status: string }[]>`
          SELECT status FROM trade.positions
          WHERE id = ${row.position_id} AND user_id = ${row.user_id}
        `;
        if (!pos || pos.status !== 'open') {
          await sql`
            UPDATE trade.futures_conditional_orders
            SET status = 'cancelled', cancel_reason = 'position_gone', updated_at = now()
            WHERE id = ${row.id} AND status = 'armed'
          `;
          continue;
        }
      }
      if (!marks.has(row.market_id)) {
        marks.set(row.market_id, await deps.publishedMark(row.market_id, row.symbol));
      }
      const markRaw = marks.get(row.market_id);
      if (markRaw == null) continue;
      const mark = parseAmount(markRaw);
      let trigger = row.trigger_price == null ? null : parseAmount(row.trigger_price);
      if (row.kind === 'trailing_stop') {
        if (row.trail_extreme == null || row.trailing_distance == null) continue;
        const trailed = nextTrail({
          side: row.side,
          extreme: parseAmount(row.trail_extreme),
          mark,
          distance: parseAmount(row.trailing_distance),
        });
        if (trailed.trigger <= 0n) continue;
        if (trailed.moved) {
          await sql`
            UPDATE trade.futures_conditional_orders
            SET trail_extreme = ${formatAmount(trailed.extreme)},
                trigger_price = ${formatAmount(trailed.trigger)},
                updated_at = now()
            WHERE id = ${row.id} AND status = 'armed'
              AND (
                (${row.side} = 'sell' AND trail_extreme < ${formatAmount(trailed.extreme)}::numeric)
                OR (${row.side} = 'buy' AND trail_extreme > ${formatAmount(trailed.extreme)}::numeric)
              )
          `;
        }
        trigger = trailed.trigger;
      }
      if (trigger == null || !triggerCrossed({ kind: row.kind, side: row.side, mark, trigger })) continue;
      const key = deps.placeReduce ? bookKey(row.id) : `fire:${row.id}`;
      const claimed = await sql<{ id: string }[]>`
        UPDATE trade.futures_conditional_orders
        SET status = 'triggered', trigger_key = ${key}, updated_at = now()
        WHERE id = ${row.id} AND status = 'armed' AND trigger_key IS NULL
        RETURNING id
      `;
      if (claimed.length === 0) continue;
      fired += 1;
      await work(row);
    }
    if (failure != null) throw failure;
    return { fired };
  }

  async function placeResting(): Promise<never> {
    return refuseFuturesRestingLimit({
      userId: '',
      market: '',
      side: 'sell',
      quantity: '0',
      limitPrice: '0',
      reduceOnly: true,
      clientOrderId: 'unsupported',
    });
  }

  return { create, list, get, cancel, replaceProtection, evaluate, placeResting };
}

export type ConditionalOrderService = ReturnType<typeof createConditionalOrderService>;
