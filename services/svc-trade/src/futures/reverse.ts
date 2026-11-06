/**
 * One-tap reverse of a futures position (J-derivatives-03 step 9, D-account-03): one request closes the position
 * through the book and opens the other side at the same size and leverage. It is a saga over the two existing order
 * paths, never a third way to move value: the close is a reduce-only market order and the open an ordinary market
 * order, each with its own hold, fills and settlement through `MatchedFuturesOrders`.
 *
 * The request is recorded first (`trade.futures_reverse_requests`, one row per request id, and one live or finished
 * row per position). The legs are keyed by the trader's request id, `rv:c:<request>` and `rv:o:<request>`, so the same
 * request sent again finds the orders it placed and places nothing twice. The open goes only once this reverse's own
 * close has settled for the whole size and the position is closed; the book itself refuses an open on the other side
 * while it is still open (one-way mode). If the open is refused, or another order (a stop, a liquidation) closed the
 * position first, the close stands and the row says `closed_only` with the reason: never a silent half.
 *
 * A request waits a short while for the close to settle. If it has not, the row stays `closing` and the same request
 * sent again carries it on. The reconciler only reports: it moves a settled close on to `opening`, reads an open that
 * was placed, and reports a reverse whose leg was never sent within `staleMs`. It places nothing, since an order is
 * placed only on the trader's own signed request.
 */
import { randomUUID } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { FILL_WAIT_CODES, type MatchedOrderView, type PlaceMatchedOrderInput } from './matched-orders.js';
import { FuturesError } from './position-service.js';

export type ReverseStatus = 'closing' | 'opening' | 'done' | 'opened_part' | 'closed_only' | 'close_incomplete' | 'refused';

const WORKING = new Set<ReverseStatus>(['closing', 'opening']);
/** The states a book order ends in. */
const FINAL = new Set(['filled', 'cancelled', 'rejected', 'refused']);
/** Refusals that pass on their own (the position is mid-fill, the engine has not answered): the request tries again. */
const PASSING = new Set([...FILL_WAIT_CODES, 'trade.futures_submit_unknown', 'authority.unavailable']);

/** The open leg never reached the book within `staleMs` of the close settling or of its last send. The close stands. */
export const REVERSE_OPEN_NOT_SENT = 'trade.reverse_open_not_sent';
/** The close leg never reached the book within `staleMs`. Nothing changed. */
export const REVERSE_CLOSE_NOT_SENT = 'trade.reverse_close_not_sent';
/** Another order (a stop, a take profit, a liquidation) closed the position before this reverse's close did. */
export const REVERSE_CLOSED_ELSEWHERE = 'trade.reverse_position_closed_elsewhere';
export const REVERSE_ALREADY_REQUESTED = 'trade.reverse_already_requested';
export const REVERSE_LEVERAGE_UNKNOWN = 'trade.reverse_leverage_unknown';

export interface ReverseInput {
  readonly positionId: string;
  readonly clientRequestId: string;
  /** The margin tier the trader accepted for the open in the review; not part of the request's identity. */
  readonly confirmTier?: number;
}

export interface ReverseView {
  readonly clientRequestId: string;
  readonly positionId: string;
  readonly symbol: string;
  readonly from: 'long' | 'short';
  readonly to: 'long' | 'short';
  readonly size: string;
  readonly leverage: string;
  readonly status: ReverseStatus;
  readonly closeClientOrderId: string;
  readonly openClientOrderId: string;
  readonly closeOrderId: string | null;
  readonly openOrderId: string | null;
  readonly closedQuantity: string | null;
  readonly openedQuantity: string | null;
  /** The position the open filled into. */
  readonly newPositionId: string | null;
  readonly refusalCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReverseDeps {
  readonly sql: Sql;
  readonly place: (
    principal: Principal,
    input: PlaceMatchedOrderInput,
    context: { readonly region?: string | null },
  ) => Promise<MatchedOrderView>;
  /** How long a request waits for its close to settle before it answers `closing`. Default 3 s. */
  readonly settleWaitMs?: number;
  /** How long a reverse may wait for its trader before the reconciler reports it. Default 2 min. */
  readonly staleMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface RequestRow {
  id: string;
  user_id: string;
  client_request_id: string;
  position_id: string;
  market_id: string;
  symbol: string;
  from_side: 'long' | 'short';
  size: string;
  leverage: string;
  confirm_tier: number | null;
  status: ReverseStatus;
  close_order_id: string | null;
  open_order_id: string | null;
  closed_quantity: string | null;
  opened_quantity: string | null;
  new_position_id: string | null;
  refusal_code: string | null;
  open_sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface OrderRow {
  id: string;
  status: string;
  qty: string;
  filled_qty: string;
  engine_filled_qty: string | null;
  refusal_code: string | null;
}

/** The legs' client ids: the request id is at most 58 characters, so each stays within the book's 64. */
const REQUEST_ID_MAX = 58;
const closeKey = (requestId: string) => `rv:c:${requestId}`;
const openKey = (requestId: string) => `rv:o:${requestId}`;
const opposite = (side: 'long' | 'short'): 'long' | 'short' => (side === 'long' ? 'short' : 'long');

function refusalCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z_]+\.[a-z0-9_.]+$/.test(code) ? code : null;
}

/** A refusal that passes on its own, or an error that is not a refusal at all (a dropped connection): try again. */
function passes(err: unknown, code: string | null): boolean {
  if (code != null && PASSING.has(code)) return true;
  const status = (err as { status?: unknown } | null)?.status;
  return code == null || (typeof status === 'number' && status >= 500);
}

/**
 * What a leg has settled and what the engine says it filled in all (null while that is not known). Unlike the book's
 * own fill cap, an order refused on its row before the engine saw it is final with nothing filled.
 */
function legFills(order: OrderRow): { settled: Amount; engine: Amount | null } {
  const settled = parseAmount(order.filled_qty);
  if (order.status === 'filled') return { settled, engine: parseAmount(order.qty) };
  if (order.status === 'refused') return { settled, engine: settled };
  return { settled, engine: order.engine_filled_qty == null ? null : parseAmount(order.engine_filled_qty) };
}

/** A leg that has ended with every fill the engine made settled. */
function legEnded(order: OrderRow): boolean {
  if (!FINAL.has(order.status)) return false;
  const { settled, engine } = legFills(order);
  return engine != null && settled >= engine;
}

function present(row: RequestRow): ReverseView {
  const amount = (v: string | null) => (v == null ? null : formatAmount(parseAmount(v)));
  return {
    clientRequestId: row.client_request_id,
    positionId: row.position_id,
    symbol: row.symbol,
    from: row.from_side,
    to: opposite(row.from_side),
    size: formatAmount(parseAmount(row.size)),
    leverage: formatAmount(parseAmount(row.leverage)),
    status: row.status,
    closeClientOrderId: closeKey(row.client_request_id),
    openClientOrderId: openKey(row.client_request_id),
    closeOrderId: row.close_order_id,
    openOrderId: row.open_order_id,
    closedQuantity: amount(row.closed_quantity),
    openedQuantity: amount(row.opened_quantity),
    newPositionId: row.new_position_id,
    refusalCode: row.refusal_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createReverseService(deps: ReverseDeps) {
  const { sql } = deps;
  const settleWaitMs = deps.settleWaitMs ?? 3_000;
  const staleMs = deps.staleMs ?? 120_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function load(userId: string, clientRequestId: string): Promise<RequestRow | undefined> {
    const [row] = await sql<RequestRow[]>`
      SELECT r.*, m.symbol FROM trade.futures_reverse_requests r JOIN trade.markets m ON m.id = r.market_id
      WHERE r.user_id = ${userId} AND r.client_request_id = ${clientRequestId}
    `;
    return row;
  }

  async function reload(row: RequestRow): Promise<RequestRow> {
    return (await load(row.user_id, row.client_request_id)) ?? row;
  }

  async function orderByKey(row: RequestRow, key: string): Promise<OrderRow | undefined> {
    const [order] = await sql<OrderRow[]>`
      SELECT id, status, qty, filled_qty, engine_filled_qty, refusal_code FROM trade.futures_orders
      WHERE user_id = ${row.user_id} AND market_id = ${row.market_id} AND client_order_id = ${key}
    `;
    return order;
  }

  async function positionStatus(row: RequestRow): Promise<{ status: string; size: string } | undefined> {
    const [pos] = await sql<{ status: string; size: string }[]>`
      SELECT status, size FROM trade.positions WHERE id = ${row.position_id} AND user_id = ${row.user_id}
    `;
    return pos;
  }

  /** Moves a row on from one working state, only if it is still in it. */
  async function move(row: RequestRow, from: ReverseStatus, set: Partial<Record<keyof RequestRow, unknown>>): Promise<boolean> {
    const moved = await sql`
      UPDATE trade.futures_reverse_requests
      SET status = ${(set.status as string | undefined) ?? from},
          close_order_id = COALESCE(${(set.close_order_id as string | undefined) ?? null}::uuid, close_order_id),
          open_order_id = COALESCE(${(set.open_order_id as string | undefined) ?? null}::uuid, open_order_id),
          closed_quantity = COALESCE(${(set.closed_quantity as string | undefined) ?? null}::numeric, closed_quantity),
          opened_quantity = COALESCE(${(set.opened_quantity as string | undefined) ?? null}::numeric, opened_quantity),
          new_position_id = COALESCE(${(set.new_position_id as string | undefined) ?? null}::uuid, new_position_id),
          refusal_code = COALESCE(${(set.refusal_code as string | undefined) ?? null}, refusal_code),
          updated_at = now()
      WHERE id = ${row.id} AND status = ${from}
    `;
    return moved.count > 0;
  }

  /**
   * Where the close stands, once the close order has ended and every fill of it has settled (working until then):
   * settled (it closed the whole size and the position is closed), short (it closed less and the position is still
   * open), elsewhere (another order closed the position first) or refused (it closed nothing and the position is open).
   * The order is read before the position, and a fill moves both in one transaction, so a settled fill is never seen
   * without its position.
   */
  async function closeState(
    row: RequestRow,
    order: OrderRow,
  ): Promise<
    | { kind: 'settled' }
    | { kind: 'short'; closed: Amount }
    | { kind: 'elsewhere'; closed: Amount }
    | { kind: 'refused'; code: string }
    | { kind: 'working' }
  > {
    if (!legEnded(order)) return { kind: 'working' };
    const { settled } = legFills(order);
    const pos = await positionStatus(row);
    // A position frozen `closing` while the feed is dark is closed by that exit, not by this order: wait for it.
    if (pos?.status === 'closing') return { kind: 'working' };
    if (pos?.status !== 'open') return settled >= parseAmount(row.size) ? { kind: 'settled' } : { kind: 'elsewhere', closed: settled };
    if (settled === 0n) return { kind: 'refused', code: order.refusal_code ?? 'trade.futures_order_unfilled' };
    // Every fill has settled and the position is still open: the close covered less than it holds now.
    return { kind: 'short', closed: settled };
  }

  async function settleClose(row: RequestRow, order: OrderRow): Promise<RequestRow> {
    const state = await closeState(row, order);
    if (state.kind === 'settled') await move(row, 'closing', { status: 'opening', close_order_id: order.id, closed_quantity: row.size });
    else if (state.kind === 'short')
      await move(row, 'closing', { status: 'close_incomplete', close_order_id: order.id, closed_quantity: formatAmount(state.closed) });
    else if (state.kind === 'elsewhere')
      await move(row, 'closing', {
        status: state.closed === 0n ? 'refused' : 'closed_only',
        close_order_id: order.id,
        closed_quantity: formatAmount(state.closed),
        refusal_code: REVERSE_CLOSED_ELSEWHERE,
      });
    else if (state.kind === 'refused')
      await move(row, 'closing', { status: 'refused', close_order_id: order.id, refusal_code: state.code });
    else if (row.close_order_id == null) await move(row, 'closing', { close_order_id: order.id });
    else return row;
    return reload(row);
  }

  async function settleOpen(row: RequestRow, order: OrderRow): Promise<RequestRow> {
    if (!legEnded(order)) {
      if (row.open_order_id != null) return row;
      await move(row, 'opening', { open_order_id: order.id });
      return reload(row);
    }
    const { settled } = legFills(order);
    if (settled === 0n) {
      await move(row, 'opening', {
        status: 'closed_only',
        open_order_id: order.id,
        refusal_code: order.refusal_code ?? 'trade.futures_order_unfilled',
      });
      return reload(row);
    }
    const [pos] = await sql<{ id: string }[]>`
      SELECT id FROM trade.positions
      WHERE user_id = ${row.user_id} AND market_id = ${row.market_id} AND side = ${opposite(row.from_side)}
        AND status IN ('open', 'closing')
      ORDER BY opened_at DESC LIMIT 1
    `;
    await move(row, 'opening', {
      status: settled >= parseAmount(row.size) ? 'done' : 'opened_part',
      open_order_id: order.id,
      opened_quantity: formatAmount(settled),
      ...(pos ? { new_position_id: pos.id } : {}),
    });
    return reload(row);
  }

  async function placeClose(principal: Principal, row: RequestRow, region: string | null): Promise<RequestRow> {
    // Touched before the close is sent, so the reconciler never reports this row while its close may be on its way.
    const marked = await sql`
      UPDATE trade.futures_reverse_requests SET updated_at = now() WHERE id = ${row.id} AND status = 'closing'
    `;
    if (marked.count === 0) return reload(row);
    try {
      await deps.place(
        principal,
        {
          userId: row.user_id,
          symbol: row.symbol,
          side: row.from_side === 'long' ? 'sell' : 'buy',
          type: 'market',
          qty: parseAmount(row.size),
          leverage: 0n,
          reduceOnly: true,
          marginMode: 'isolated',
          clientOrderId: closeKey(row.client_request_id),
          origin: { kind: 'reverse', ref: row.client_request_id },
        },
        { region },
      );
    } catch (err) {
      const code = refusalCode(err);
      if (passes(err, code)) return row;
      // A replay may meet its own close already settled (no position left to reduce): read the order instead.
      const order = await orderByKey(row, closeKey(row.client_request_id));
      if (order) return settleClose(row, order);
      await move(row, 'closing', { status: 'refused', refusal_code: code! });
      return reload(row);
    }
    // The close settles through the matching consumers: wait a moment for the position to close.
    const until = Date.now() + settleWaitMs;
    let current = row;
    for (;;) {
      const order = await orderByKey(current, closeKey(current.client_request_id));
      if (order) {
        current = await settleClose(current, order);
        if (current.status !== 'closing' || Date.now() >= until) return current;
      } else if (Date.now() >= until) return reload(current);
      await sleep(200);
    }
  }

  async function placeOpen(principal: Principal, row: RequestRow, region: string | null): Promise<RequestRow> {
    // Marked before each send of the open, so the reconciler never reports this row while its open may be on its way.
    const marked = await sql`
      UPDATE trade.futures_reverse_requests SET open_sent_at = now(), updated_at = now()
      WHERE id = ${row.id} AND status = 'opening'
    `;
    if (marked.count === 0) return reload(row);
    try {
      await deps.place(
        principal,
        {
          userId: row.user_id,
          symbol: row.symbol,
          side: row.from_side === 'long' ? 'sell' : 'buy',
          type: 'market',
          qty: parseAmount(row.size),
          leverage: parseAmount(row.leverage),
          marginMode: 'isolated',
          clientOrderId: openKey(row.client_request_id),
          origin: { kind: 'reverse', ref: row.client_request_id },
          ...(row.confirm_tier != null ? { confirmTier: row.confirm_tier } : {}),
        },
        { region },
      );
    } catch (err) {
      const code = refusalCode(err);
      if (passes(err, code)) return reload(row);
      const order = await orderByKey(row, openKey(row.client_request_id));
      if (order) return settleOpen(row, order);
      await move(row, 'opening', { status: 'closed_only', refusal_code: code! });
      return reload(row);
    }
    const order = await orderByKey(row, openKey(row.client_request_id));
    return order ? settleOpen(row, order) : reload(row);
  }

  /** Carries a working reverse as far as it can go now. */
  async function advance(principal: Principal, start: RequestRow, region: string | null): Promise<RequestRow> {
    let row = start;
    if (row.status === 'closing') row = await placeClose(principal, row, region);
    if (row.status === 'opening') {
      const placed = await orderByKey(row, openKey(row.client_request_id));
      row = placed ? await settleOpen(row, placed) : await placeOpen(principal, row, region);
    }
    return row;
  }

  return {
    /**
     * Reverses the caller's open position, or carries on the reverse this request id already started. Refuses a
     * position that is not the caller's or not open, and a second request id for a position already being reversed.
     */
    async reverse(principal: Principal, input: ReverseInput, context: { readonly region?: string | null } = {}): Promise<ReverseView> {
      const userId = principal.userId;
      const region = context.region ?? null;
      const id = input.clientRequestId.trim();
      if (!id || id.length > REQUEST_ID_MAX) {
        throw new FuturesError(`clientRequestId is required (1–${REQUEST_ID_MAX} chars)`, 'trade.client_request_id_required', 400);
      }
      let row = await load(userId, id);
      if (row && row.position_id !== input.positionId) {
        throw new FuturesError('this clientRequestId names a reverse of another position', 'trade.client_order_id_conflict', 409);
      }
      if (!row) {
        const [pos] = await sql<
          { id: string; market_id: string; side: 'long' | 'short'; size: string; leverage: string | null; status: string }[]
        >`
          SELECT id, market_id, side, size, leverage, status FROM trade.positions
          WHERE id = ${input.positionId} AND user_id = ${userId}
        `.catch((err: { code?: string }) => {
          if (err.code === '22P02') return [];
          throw err;
        });
        if (!pos) throw new FuturesError('position not found', 'trade.position_not_found', 404);
        if (pos.status !== 'open') throw new FuturesError(`position is ${pos.status}`, 'trade.position_not_open', 400);
        if (pos.leverage == null) {
          throw new FuturesError(
            'this position has no recorded leverage, so the other side cannot be opened at the same leverage',
            REVERSE_LEVERAGE_UNKNOWN,
            409,
          );
        }
        const inserted = await sql<{ id: string }[]>`
          INSERT INTO trade.futures_reverse_requests
            (id, user_id, client_request_id, position_id, market_id, from_side, size, leverage, confirm_tier)
          VALUES (${randomUUID()}, ${userId}, ${id}, ${pos.id}, ${pos.market_id}, ${pos.side}, ${pos.size}, ${pos.leverage},
                  ${input.confirmTier ?? null})
          ON CONFLICT DO NOTHING
          RETURNING id
        `;
        row = await load(userId, id);
        if (inserted.length === 0 && !row) {
          throw new FuturesError('this position is already being reversed under another request', REVERSE_ALREADY_REQUESTED, 409);
        }
        if (!row || row.position_id !== input.positionId) {
          throw new FuturesError('this clientRequestId names a reverse of another position', 'trade.client_order_id_conflict', 409);
        }
      } else if (input.confirmTier !== undefined && row.status === 'closing' && row.confirm_tier !== input.confirmTier) {
        // A tier accepted on a later send of the same request applies to the open still to come.
        await sql`
          UPDATE trade.futures_reverse_requests SET confirm_tier = ${input.confirmTier}, updated_at = now()
          WHERE id = ${row.id} AND status = 'closing'
        `;
        row = (await load(userId, id))!;
      }
      if (WORKING.has(row.status)) row = await advance(principal, row, region);
      return present(row);
    },

    /**
     * Reports working reverses no request is carrying: a settled close moves on to `opening`; a placed open is read;
     * a close or an open with no order `staleMs` after it was last sent (or, for the open, after the close settled)
     * is reported. Each report is one guarded update, so a send that marks the row first is never reported. Places
     * nothing.
     */
    async reconcile(limit = 50): Promise<number> {
      const rows = await sql<RequestRow[]>`
        SELECT r.*, m.symbol FROM trade.futures_reverse_requests r JOIN trade.markets m ON m.id = r.market_id
        WHERE r.status IN ('closing', 'opening') AND r.updated_at < now() - interval '5 seconds'
        ORDER BY r.updated_at
        LIMIT ${limit}
      `;
      let moved = 0;
      for (const row of rows) {
        if (row.status === 'closing') {
          const order = await orderByKey(row, closeKey(row.client_request_id));
          if (order) {
            const next = await settleClose(row, order);
            if (next.status !== row.status) moved += 1;
            continue;
          }
          const reported = await sql`
            UPDATE trade.futures_reverse_requests
            SET status = 'refused', refusal_code = ${REVERSE_CLOSE_NOT_SENT}, updated_at = now()
            WHERE id = ${row.id} AND status = 'closing' AND updated_at < now() - ${staleMs} * interval '1 millisecond'
          `;
          moved += reported.count;
          continue;
        }
        const order = await orderByKey(row, openKey(row.client_request_id));
        if (order) {
          const next = await settleOpen(row, order);
          if (next.status !== row.status) moved += 1;
          continue;
        }
        const reported = await sql`
          UPDATE trade.futures_reverse_requests
          SET status = 'closed_only', refusal_code = ${REVERSE_OPEN_NOT_SENT}, updated_at = now()
          WHERE id = ${row.id} AND status = 'opening'
            AND COALESCE(open_sent_at, updated_at) < now() - ${staleMs} * interval '1 millisecond'
        `;
        moved += reported.count;
      }
      return moved;
    },
  };
}

export type ReverseService = ReturnType<typeof createReverseService>;
