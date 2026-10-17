import type { Sql } from 'postgres';
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { childOrderIds } from '../algo/algo-list.js';
import { DeskError } from '../desk/errors.js';

export const ORDER_EVENT_KINDS = ['ack', 'reject', 'rest', 'amend', 'cancel', 'partial', 'fill', 'expire'] as const;
export type OrderEventKind = (typeof ORDER_EVENT_KINDS)[number];

export const TRADE_ALGO_REPORTS_LIMIT_UNSET = 'trade.algo_reports_limit_unset' as const;
export const TRADE_ALGO_REPORTS_CURSOR_INVALID = 'trade.algo_reports_cursor_invalid' as const;
export const ALGO_REPORTS_LIMIT_MAX = 500;

export interface OrderEventInput {
  readonly orderId: string;
  readonly parentId: string | null;
  readonly kind: OrderEventKind;
  readonly quantity: string | null;
  readonly price: string | null;
  readonly code: string;
}

export interface OrderEventRow {
  readonly id: string;
  readonly orderId: string;
  readonly parentId: string | null;
  readonly kind: OrderEventKind;
  readonly quantity: string | null;
  readonly price: string | null;
  readonly code: string;
  readonly at: string;
}

/** `algo:<parentId>:<slice>` → parentId. Other client ids are not algo children. */
export function parentIdFromClientOrder(clientOrderId: string | null | undefined): string | null {
  if (!clientOrderId || !clientOrderId.startsWith('algo:')) return null;
  const body = clientOrderId.slice('algo:'.length);
  const split = body.lastIndexOf(':');
  if (split <= 0) return null;
  const parentId = body.slice(0, split);
  const index = body.slice(split + 1);
  if (parentId.trim() === '' || !/^\d+$/.test(index)) return null;
  return parentId;
}

/**
 * `truncateAll` names every table in the schema, and this one refuses TRUNCATE.
 * Tests that reset the schema skip it. The rows stay; they are not a balance.
 */
export async function truncateTradeExceptOrderEvents(sql: Sql): Promise<void> {
  const tables = await sql<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'trade' AND tablename <> 'order_events'
  `;
  if (tables.length === 0) return;
  const list = tables.map((table) => `"trade"."${table.tablename}"`).join(', ');
  await sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function appendOrderEvent(sql: Sql, event: OrderEventInput): Promise<void> {
  if (!ORDER_EVENT_KINDS.includes(event.kind)) return;
  if (event.code.trim() === '') return;
  await sql`
    INSERT INTO order_events (order_id, parent_id, kind, quantity, price, code)
    VALUES (
      ${event.orderId},
      ${event.parentId},
      ${event.kind},
      ${event.quantity},
      ${event.price},
      ${event.code}
    )
    ON CONFLICT (order_id, kind, code) DO NOTHING
  `;
}

export function publishedAlgoReportsLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > ALGO_REPORTS_LIMIT_MAX) {
    throw new DeskError('algo reports limit is unset — refuse to invent 50', TRADE_ALGO_REPORTS_LIMIT_UNSET);
  }
  return value;
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}\n${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new DeskError('algo reports cursor is invalid', TRADE_ALGO_REPORTS_CURSOR_INVALID);
  }
  const split = raw.indexOf('\n');
  if (split <= 0 || split === raw.length - 1) {
    throw new DeskError('algo reports cursor is invalid', TRADE_ALGO_REPORTS_CURSOR_INVALID);
  }
  const at = raw.slice(0, split);
  const id = raw.slice(split + 1);
  if (!Number.isFinite(Date.parse(at)) || !/^\d+$/.test(id)) {
    throw new DeskError('algo reports cursor is invalid', TRADE_ALGO_REPORTS_CURSOR_INVALID);
  }
  return { at, id };
}

async function selectReportRows(
  sql: Sql,
  algoId: string,
  userId: string,
  childIds: readonly string[],
  cursor: { at: string; id: string } | null,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  if (childIds.length === 0) return [];
  if (cursor) {
    const cursorAt = new Date(cursor.at);
    return sql<Array<Record<string, unknown>>>`
      SELECT e.id::text AS id, e.order_id, e.parent_id, e.kind, e.quantity::text AS quantity, e.price::text AS price, e.code, e.at
      FROM order_events e
      JOIN trade.orders o ON o.id = e.order_id AND o.user_id = ${userId}::uuid
      WHERE e.parent_id = ${algoId}
        AND e.order_id = ANY(${[...childIds]}::uuid[])
        AND (e.at > ${cursorAt} OR (e.at = ${cursorAt} AND e.id > ${cursor.id}))
      ORDER BY e.at ASC, e.id ASC
      LIMIT ${limit}
    `;
  }
  return sql<Array<Record<string, unknown>>>`
    SELECT e.id::text AS id, e.order_id, e.parent_id, e.kind, e.quantity::text AS quantity, e.price::text AS price, e.code, e.at
    FROM order_events e
    JOIN trade.orders o ON o.id = e.order_id AND o.user_id = ${userId}::uuid
    WHERE e.parent_id = ${algoId}
      AND e.order_id = ANY(${[...childIds]}::uuid[])
    ORDER BY e.at ASC, e.id ASC
    LIMIT ${limit}
  `;
}

export async function listAlgoReports(
  sql: Sql,
  principal: Principal,
  query: { algoId: string; limit?: number | null; cursor?: string | null },
): Promise<{ rows: OrderEventRow[]; nextCursor: string | null }> {
  requireScope(principal, 'trade:read');
  const limit = publishedAlgoReportsLimit(query.limit);
  const owners = await sql<Array<{ id: string; children: unknown }>>`
    SELECT id, children FROM algo_parents WHERE id = ${query.algoId} AND user_id = ${principal.userId}
  `;
  if (!owners[0]) throw new DeskError('algo not found', 'trade.algo_not_found');
  const cursor = query.cursor == null || query.cursor.trim() === '' ? null : decodeCursor(query.cursor);
  const rows = await selectReportRows(sql, query.algoId, principal.userId, childOrderIds(owners[0].children), cursor, limit + 1);
  const page = rows.slice(0, limit).map(presentEvent);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(last.at, last.id) : null;
  return { rows: page, nextCursor };
}

function presentEvent(row: Record<string, unknown>): OrderEventRow {
  const quantity = row.quantity == null ? null : formatAmount(parseAmount(String(row.quantity)));
  const price = row.price == null ? null : formatAmount(parseAmount(String(row.price)));
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    kind: String(row.kind) as OrderEventKind,
    quantity,
    price,
    code: String(row.code),
    at: new Date(String(row.at)).toISOString(),
  };
}

export function eventQuantity(qty: Amount | null): string | null {
  return qty === null ? null : formatAmount(qty);
}
