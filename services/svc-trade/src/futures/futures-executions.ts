/**
 * Futures executions (J-derivatives-04 step 1, D-orders-03): every change to the caller's futures positions that a
 * trade or the venue made, newest first. Read only, from stored rows:
 *
 *   · a fill of one of their orders through the book (`trade.futures_order_fills`, applied): `open` when it opened or
 *     grew a position, `close` when it reduced one, `liquidation` when the order was a liquidation order;
 *   · an auto-deleverage pair they were on either side of (`trade.futures_adl_pairs`, applied): `adl`, at the
 *     bankruptcy price the pair was struck at.
 *
 * A dated contract's settlement closes positions at the fixing without a fill; it is read from the closed positions,
 * not repeated here. Nothing here holds or moves money, and no figure is computed that a row does not store.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { FUTURES_ORDER_ORIGINS, type FuturesOrderOrigin } from './matched-orders.js';

export const FUTURES_EXECUTION_KINDS = ['open', 'close', 'liquidation', 'adl'] as const;
export type FuturesExecutionKind = (typeof FUTURES_EXECUTION_KINDS)[number];
/** The largest page one read may ask for; a blank or larger limit refuses rather than picking one. */
export const FUTURES_EXECUTIONS_LIMIT_MAX = 200;
export const FUTURES_EXECUTIONS_CURSOR_INVALID = 'trade.invalid_cursor';

export interface FuturesExecution {
  /** Stable per execution: the fill's key, or `adl:<pair>`. */
  readonly id: string;
  readonly kind: FuturesExecutionKind;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly qty: string;
  readonly price: string;
  /** The trading fee this execution paid; null for an ADL pair, which charges none. */
  readonly fee: string | null;
  /** Maker or taker on the book; null for an ADL pair, which is not a match. */
  readonly feeRole: 'maker' | 'taker' | null;
  /** The profit or loss this execution realised; null for an opening fill, which realises none. */
  readonly realizedPnl: string | null;
  readonly orderId: string | null;
  readonly origin: FuturesOrderOrigin | null;
  readonly orderLabel: string | null;
  readonly positionId: string;
  readonly at: string;
}

export interface FuturesExecutionQuery {
  readonly limit: number;
  readonly symbol?: string | null;
  readonly kind?: FuturesExecutionKind | null;
  /** Only the fills of this one order. */
  readonly orderId?: string | null;
  /** The `next` of the previous page. */
  readonly before?: string | null;
}

export class FuturesExecutionsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface Row {
  id: string;
  kind: FuturesExecutionKind;
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  price: string;
  fee: string | null;
  fee_role: 'maker' | 'taker' | null;
  realized_pnl: string | null;
  order_id: string | null;
  origin: string | null;
  order_label: string | null;
  position_id: string;
  at: Date;
  /** The time as the database holds it, to the microsecond, for the cursor. */
  at_key: string;
}

/** The cursor is the last row's time and id, so a page never repeats or skips a row that shares a timestamp. */
export function encodeExecutionCursor(atMicros: string, id: string): string {
  return Buffer.from(JSON.stringify([atMicros, id]), 'utf8').toString('base64url');
}

export function decodeExecutionCursor(cursor: string): { atMicros: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null;
    if (!/^\d{1,20}$/.test(parsed[0]) || parsed[1].length === 0 || parsed[1].length > 200) return null;
    return { atMicros: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}

const decimal = (value: string | null): string | null => (value == null ? null : formatAmount(parseAmount(value)));

function present(row: Row): FuturesExecution {
  return {
    id: row.id,
    kind: row.kind,
    symbol: row.symbol,
    side: row.side,
    qty: formatAmount(parseAmount(row.qty)),
    price: formatAmount(parseAmount(row.price)),
    fee: decimal(row.fee),
    feeRole: row.fee_role,
    realizedPnl: decimal(row.realized_pnl),
    orderId: row.order_id,
    origin:
      row.origin != null && (FUTURES_ORDER_ORIGINS as readonly string[]).includes(row.origin) ? (row.origin as FuturesOrderOrigin) : null,
    orderLabel: row.order_label,
    positionId: row.position_id,
    at: new Date(row.at).toISOString(),
  };
}

export async function listFuturesExecutions(
  sql: Sql,
  userId: string,
  input: FuturesExecutionQuery,
): Promise<{ readonly executions: FuturesExecution[]; readonly next: string | null }> {
  const cursor = input.before ? decodeExecutionCursor(input.before) : null;
  if (input.before && !cursor) throw new FuturesExecutionsError('before is not a cursor this read gave', FUTURES_EXECUTIONS_CURSOR_INVALID);
  const rows = await sql<Row[]>`
    WITH executions AS (
      SELECT f.fill_key AS id,
             CASE WHEN o.origin = 'liquidation' THEN 'liquidation' WHEN f.kind = 'open' THEN 'open' ELSE 'close' END AS kind,
             m.symbol, o.side, f.qty::text AS qty, f.price::text AS price, f.fee::text AS fee, f.fee_role,
             f.realized_pnl::text AS realized_pnl, o.id::text AS order_id, o.origin, o.order_label,
             f.position_id::text AS position_id, COALESCE(f.applied_at, f.created_at) AS at
        FROM trade.futures_order_fills f
        JOIN trade.futures_orders o ON o.id = f.order_id
        JOIN trade.markets m ON m.id = f.market_id
       WHERE o.user_id = ${userId} AND f.state = 'applied'
      UNION ALL
      SELECT 'adl:' || a.pair_id || ':' || p.id::text AS id, 'adl' AS kind, m.symbol,
             CASE WHEN p.side = 'long' THEN 'sell' ELSE 'buy' END AS side,
             a.size::text AS qty, a.bankruptcy_price::text AS price, NULL AS fee, NULL AS fee_role,
             CASE WHEN p.id = a.candidate_position_id THEN a.candidate_profit::text ELSE NULL END AS realized_pnl,
             NULL AS order_id, NULL AS origin, NULL AS order_label, p.id::text AS position_id, a.applied_at AS at
        FROM trade.futures_adl_pairs a
        JOIN trade.positions p ON p.id IN (a.bankrupt_position_id, a.candidate_position_id)
        JOIN trade.markets m ON m.id = p.market_id
       WHERE a.state = 'applied' AND p.user_id = ${userId}
    )
    SELECT *, (EXTRACT(EPOCH FROM at) * 1000000)::bigint::text AS at_key FROM executions
     WHERE TRUE
       ${input.symbol ? sql`AND symbol = ${input.symbol}` : sql``}
       ${input.kind ? sql`AND kind = ${input.kind}` : sql``}
       ${input.orderId ? sql`AND order_id = ${input.orderId}` : sql``}
       ${cursor ? sql`AND ((EXTRACT(EPOCH FROM at) * 1000000)::bigint, id) < (${cursor.atMicros}::bigint, ${cursor.id})` : sql``}
     ORDER BY at DESC, id DESC
     LIMIT ${input.limit}
  `;
  const last = rows[rows.length - 1];
  return {
    executions: rows.map(present),
    next: rows.length === input.limit && last ? encodeExecutionCursor(last.at_key, last.id) : null,
  };
}
