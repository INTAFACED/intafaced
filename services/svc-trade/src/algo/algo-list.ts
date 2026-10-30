import type { Sql } from 'postgres';
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { DeskError } from '../desk/errors.js';
import { nextSliceAtIso } from './present.js';
import type { AlgoSchedulerView } from './scheduler-heartbeat.js';
import type { AlgoStatus } from './types.js';

/** Calendar months of parent history a caller may list. Not a commercial cap. */
export const ALGO_LIST_HISTORY_MONTHS = 3;
export const ALGO_LIST_LIMIT_MAX = 500;

export const TRADE_ALGO_LIST_LIMIT_UNSET = 'trade.algo_list_limit_unset' as const;
export const TRADE_ALGO_LIST_FROM_BEFORE_WINDOW = 'trade.algo_list_from_before_window' as const;
export const TRADE_ALGO_LIST_CURSOR_INVALID = 'trade.algo_list_cursor_invalid' as const;

const STATUSES: readonly AlgoStatus[] = ['active', 'paused', 'cancelled', 'completed', 'halted'];

/** Kinds a caller may filter "My bots" by. `grid` and `dca` have no engine yet, so they list empty. */
export const ALGO_LIST_KINDS = ['twap', 'vwap', 'pov', 'grid', 'dca'] as const;
export type AlgoListKind = (typeof ALGO_LIST_KINDS)[number];
export const TRADE_ALGO_LIST_KIND_INVALID = 'trade.algo_list_kind_invalid' as const;

export interface AlgoListQuery {
  readonly status?: string | null;
  /** Bot kind filter for "My bots" (CB-bots-01). Grid and DCA list empty until their engines ship. */
  readonly kind?: string | null;
  readonly from?: string | null;
  readonly limit?: number | null;
  readonly cursor?: string | null;
}

export interface AlgoListRow {
  readonly id: string;
  readonly kind: string;
  readonly market: string;
  readonly side: string;
  readonly totalQty: string;
  readonly filledQty: string;
  readonly status: AlgoStatus;
  readonly created: string;
  readonly nextSliceAt: string | null;
  readonly scheduler: AlgoSchedulerView;
}

export interface AlgoListPage {
  readonly rows: AlgoListRow[];
  readonly nextCursor: string | null;
}

interface ParentListRow {
  id: string;
  kind: string;
  symbol: string;
  side: string;
  total_qty: string;
  status: AlgoStatus;
  created_at: Date;
  next_due_at: Date | string | null;
  trigger_price: string | null;
  triggered_at: Date | string | null;
  children: unknown;
}

export function algoListWindowStart(now: Date): Date {
  const start = new Date(now.getTime());
  start.setUTCMonth(start.getUTCMonth() - ALGO_LIST_HISTORY_MONTHS);
  return start;
}

export function publishedAlgoListLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > ALGO_LIST_LIMIT_MAX) {
    throw new DeskError('algo list limit is unset — refuse to invent 50', TRADE_ALGO_LIST_LIMIT_UNSET);
  }
  return value;
}

export function encodeAlgoCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}\n${id}`, 'utf8').toString('base64url');
}

export function decodeAlgoCursor(cursor: string): { createdAt: string; id: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new DeskError('algo list cursor is invalid', TRADE_ALGO_LIST_CURSOR_INVALID);
  }
  const split = raw.indexOf('\n');
  if (split <= 0 || split === raw.length - 1) {
    throw new DeskError('algo list cursor is invalid', TRADE_ALGO_LIST_CURSOR_INVALID);
  }
  const createdAt = raw.slice(0, split);
  const id = raw.slice(split + 1);
  if (!Number.isFinite(Date.parse(createdAt)) || id.trim() === '' || id.includes('\n')) {
    throw new DeskError('algo list cursor is invalid', TRADE_ALGO_LIST_CURSOR_INVALID);
  }
  return { createdAt, id };
}

export function childOrderIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && 'orderId' in item) {
      const orderId = String((item as { orderId: unknown }).orderId);
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) ids.push(orderId);
    }
  }
  return ids;
}

/** Sum of trade.fills.qty for these child orders. Never children.length. */
export async function sumFillQtyForOrders(sql: Sql, orderIds: readonly string[]): Promise<Amount> {
  if (orderIds.length === 0) return 0n;
  const rows = await sql<Array<{ qty: string }>>`
    SELECT COALESCE(SUM(qty), 0)::text AS qty
    FROM trade.fills
    WHERE order_id = ANY(${[...orderIds]}::uuid[])
  `;
  return parseAmount(rows[0]?.qty ?? '0');
}

export async function listAlgoParents(
  sql: Sql,
  principal: Principal,
  query: AlgoListQuery,
  now: Date,
  scheduler: AlgoSchedulerView = { running: null, reason: 'heartbeat_unknown' },
): Promise<AlgoListPage> {
  requireScope(principal, 'trade:read');
  const limit = publishedAlgoListLimit(query.limit);
  const windowStart = algoListWindowStart(now);
  let from = windowStart;
  if (query.from != null && query.from.trim() !== '') {
    const parsed = Date.parse(query.from);
    if (!Number.isFinite(parsed)) {
      throw new DeskError('algo list from is before the 3 month window', TRADE_ALGO_LIST_FROM_BEFORE_WINDOW);
    }
    if (parsed < windowStart.getTime()) {
      throw new DeskError('algo list from is before the 3 month window', TRADE_ALGO_LIST_FROM_BEFORE_WINDOW);
    }
    from = new Date(parsed);
  }
  let status: AlgoStatus | null = null;
  if (query.status != null && query.status.trim() !== '') {
    if (!STATUSES.includes(query.status as AlgoStatus)) {
      throw new DeskError(`algo list status "${query.status}" is not a parent status`, 'trade.algo_list_status_invalid');
    }
    status = query.status as AlgoStatus;
  }
  let kind: AlgoListKind | null = null;
  if (query.kind != null && query.kind.trim() !== '') {
    if (!(ALGO_LIST_KINDS as readonly string[]).includes(query.kind)) {
      throw new DeskError(`algo list kind "${query.kind}" is not a bot kind`, TRADE_ALGO_LIST_KIND_INVALID);
    }
    kind = query.kind as AlgoListKind;
  }
  const cursor = query.cursor == null || query.cursor.trim() === '' ? null : decodeAlgoCursor(query.cursor);
  const cursorAt = cursor ? new Date(cursor.createdAt) : null;
  const rows = await selectParents(sql, principal.userId, from, status, kind, cursorAt, cursor?.id ?? null, limit + 1);
  const filled = new Map<string, string>();
  for (const row of rows.slice(0, limit)) {
    const qty = await sumFillQtyForOrders(sql, childOrderIds(row.children));
    filled.set(row.id, formatAmount(qty));
  }
  const page: AlgoListRow[] = rows.slice(0, limit).map((row) => ({
    id: row.id,
    kind: row.kind,
    market: row.symbol,
    side: row.side,
    totalQty: formatAmount(parseAmount(row.total_qty)),
    filledQty: filled.get(row.id) ?? '0',
    status: row.status,
    created: row.created_at.toISOString(),
    // A schedule waiting for its trigger price has no next slice time until the price is reached.
    nextSliceAt:
      row.trigger_price != null && row.triggered_at == null
        ? null
        : nextSliceAtIso(row.status, row.next_due_at == null ? null : new Date(row.next_due_at)),
    scheduler,
  }));
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeAlgoCursor(last.created, last.id) : null;
  return { rows: page, nextCursor };
}

async function selectParents(
  sql: Sql,
  userId: string,
  from: Date,
  status: AlgoStatus | null,
  kind: AlgoListKind | null,
  cursorAt: Date | null,
  cursorId: string | null,
  limit: number,
): Promise<ParentListRow[]> {
  if (status && cursorAt && cursorId) {
    return sql<ParentListRow[]>`
      SELECT id, kind, symbol, side, total_qty::text AS total_qty, status, created_at, next_due_at, trigger_price::text AS trigger_price, triggered_at, children
      FROM algo_parents
      WHERE user_id = ${userId}
        AND created_at >= ${from} AND (${kind}::text IS NULL OR kind::text = ${kind})
        AND status = ${status}
        AND (created_at < ${cursorAt} OR (created_at = ${cursorAt} AND id < ${cursorId}))
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
  }
  if (status) {
    return sql<ParentListRow[]>`
      SELECT id, kind, symbol, side, total_qty::text AS total_qty, status, created_at, next_due_at, trigger_price::text AS trigger_price, triggered_at, children
      FROM algo_parents
      WHERE user_id = ${userId} AND created_at >= ${from} AND (${kind}::text IS NULL OR kind::text = ${kind}) AND status = ${status}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
  }
  if (cursorAt && cursorId) {
    return sql<ParentListRow[]>`
      SELECT id, kind, symbol, side, total_qty::text AS total_qty, status, created_at, next_due_at, trigger_price::text AS trigger_price, triggered_at, children
      FROM algo_parents
      WHERE user_id = ${userId}
        AND created_at >= ${from} AND (${kind}::text IS NULL OR kind::text = ${kind})
        AND (created_at < ${cursorAt} OR (created_at = ${cursorAt} AND id < ${cursorId}))
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
  }
  return sql<ParentListRow[]>`
    SELECT id, kind, symbol, side, total_qty::text AS total_qty, status, created_at, next_due_at, trigger_price::text AS trigger_price, triggered_at, children
    FROM algo_parents
    WHERE user_id = ${userId} AND created_at >= ${from} AND (${kind}::text IS NULL OR kind::text = ${kind})
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `;
}
