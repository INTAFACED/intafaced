import type { Sql } from 'postgres';
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { DeskError } from '../desk/errors.js';
import { csvCell } from '../convert/convert-history.js';

/** Same database-protection bound as convert history. Not a commercial window. */
export const RFQ_LIST_WINDOW_MAX_MS = 92 * 24 * 60 * 60 * 1000;
export const RFQ_LIST_LIMIT_MAX = 500;

export const TRADE_RFQ_LIST_WINDOW_UNSET = 'trade.rfq_list_window_unset' as const;
export const TRADE_RFQ_LIST_WINDOW_TOO_WIDE = 'trade.rfq_list_window_too_wide' as const;
export const TRADE_RFQ_LIST_LIMIT_UNSET = 'trade.rfq_list_limit_unset' as const;
export const TRADE_RFQ_LIST_CURSOR_INVALID = 'trade.rfq_list_cursor_invalid' as const;

export interface RfqListQuery {
  readonly from?: string | null;
  readonly to?: string | null;
  readonly limit?: number | null;
  readonly cursor?: string | null;
}

export interface RfqHistoryRow {
  readonly quoteId: string;
  readonly side: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly qty: string;
  readonly quotedPrice: string;
  readonly userNotional: string;
  readonly state: 'open' | 'bound' | 'settled' | 'expired';
  readonly createdAt: string;
}

export interface RfqListPage {
  readonly rows: RfqHistoryRow[];
  readonly nextCursor: string | null;
}

interface StoredRow {
  quote_id: string;
  side: string;
  base_asset: string;
  quote_asset: string;
  qty: string;
  quoted_price: string;
  user_notional: string;
  lifecycle: 'open' | 'bound' | 'settled' | 'expired';
  created_at: Date;
}

export function publishedRfqListLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > RFQ_LIST_LIMIT_MAX) {
    throw new DeskError('rfq list limit is unset — refuse to invent 50', TRADE_RFQ_LIST_LIMIT_UNSET);
  }
  return value;
}

export function assertRfqListWindow(from: string | undefined | null, to: string | undefined | null): { from: Date; to: Date } {
  if (from == null || to == null || from.trim() === '' || to.trim() === '') {
    throw new DeskError('rfq list window is unset', TRADE_RFQ_LIST_WINDOW_UNSET);
  }
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new DeskError('rfq list window is unset', TRADE_RFQ_LIST_WINDOW_UNSET);
  }
  if (end - start > RFQ_LIST_WINDOW_MAX_MS) {
    throw new DeskError('rfq list window is wider than 92 days — database-protection bound', TRADE_RFQ_LIST_WINDOW_TOO_WIDE);
  }
  return { from: new Date(start), to: new Date(end) };
}

function encodeCursor(createdAt: string, quoteId: string): string {
  return Buffer.from(`${createdAt}\n${quoteId}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; quoteId: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new DeskError('rfq list cursor is invalid', TRADE_RFQ_LIST_CURSOR_INVALID);
  }
  const split = raw.indexOf('\n');
  if (split <= 0 || split === raw.length - 1) {
    throw new DeskError('rfq list cursor is invalid', TRADE_RFQ_LIST_CURSOR_INVALID);
  }
  const createdAt = raw.slice(0, split);
  const quoteId = raw.slice(split + 1);
  if (!Number.isFinite(Date.parse(createdAt)) || quoteId.trim() === '' || quoteId.includes('\n')) {
    throw new DeskError('rfq list cursor is invalid', TRADE_RFQ_LIST_CURSOR_INVALID);
  }
  return { createdAt, quoteId };
}

function present(row: StoredRow): RfqHistoryRow {
  return {
    quoteId: row.quote_id,
    side: row.side,
    baseAsset: row.base_asset,
    quoteAsset: row.quote_asset,
    qty: formatAmount(parseAmount(row.qty)),
    quotedPrice: formatAmount(parseAmount(row.quoted_price)),
    userNotional: formatAmount(parseAmount(row.user_notional)),
    state: row.lifecycle,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Caller RFQs from the durable otc_desk_quotes table (migration 0026).
 * The quote store is not process memory.
 */
export async function listRfqHistory(sql: Sql, principal: Principal, query: RfqListQuery): Promise<RfqListPage> {
  requireScope(principal, 'trade:read');
  const window = assertRfqListWindow(query.from, query.to);
  const limit = publishedRfqListLimit(query.limit);
  const cursor = query.cursor == null || query.cursor.trim() === '' ? null : decodeCursor(query.cursor);
  const rows = await selectPage(sql, principal.userId, window, cursor, limit + 1);
  const page = rows.slice(0, limit).map(present);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(last.createdAt, last.quoteId) : null;
  return { rows: page, nextCursor };
}

export function rfqHistoryCsv(rows: readonly RfqHistoryRow[]): string {
  const header = 'quoteId,side,baseAsset,quoteAsset,qty,quotedPrice,userNotional,state,createdAt';
  const lines = rows.map((row) =>
    [row.quoteId, row.side, row.baseAsset, row.quoteAsset, row.qty, row.quotedPrice, row.userNotional, row.state, row.createdAt]
      .map(csvCell)
      .join(','),
  );
  return [header, ...lines].join('\n');
}

export async function exportRfqHistory(
  sql: Sql,
  principal: Principal,
  query: { from?: string | null; to?: string | null },
): Promise<string> {
  requireScope(principal, 'trade:read');
  const window = assertRfqListWindow(query.from, query.to);
  const rows = await selectPage(sql, principal.userId, window, null, null);
  return rfqHistoryCsv(rows.map(present));
}

async function selectPage(
  sql: Sql,
  userId: string,
  window: { from: Date; to: Date },
  cursor: { createdAt: string; quoteId: string } | null,
  limit: number | null,
): Promise<StoredRow[]> {
  const cursorAt = cursor ? new Date(cursor.createdAt) : null;
  if (cursor && cursorAt && limit != null) {
    return sql<StoredRow[]>`
      SELECT quote_id, side, base_asset, quote_asset, qty::text AS qty, quoted_price::text AS quoted_price,
             user_notional::text AS user_notional, lifecycle, created_at
      FROM otc_desk_quotes
      WHERE user_id = ${userId}
        AND created_at >= ${window.from}
        AND created_at <= ${window.to}
        AND (created_at < ${cursorAt} OR (created_at = ${cursorAt} AND quote_id < ${cursor.quoteId}))
      ORDER BY created_at DESC, quote_id DESC
      LIMIT ${limit}
    `;
  }
  if (limit != null) {
    return sql<StoredRow[]>`
      SELECT quote_id, side, base_asset, quote_asset, qty::text AS qty, quoted_price::text AS quoted_price,
             user_notional::text AS user_notional, lifecycle, created_at
      FROM otc_desk_quotes
      WHERE user_id = ${userId} AND created_at >= ${window.from} AND created_at <= ${window.to}
      ORDER BY created_at DESC, quote_id DESC
      LIMIT ${limit}
    `;
  }
  return sql<StoredRow[]>`
    SELECT quote_id, side, base_asset, quote_asset, qty::text AS qty, quoted_price::text AS quoted_price,
           user_notional::text AS user_notional, lifecycle, created_at
    FROM otc_desk_quotes
    WHERE user_id = ${userId} AND created_at >= ${window.from} AND created_at <= ${window.to}
    ORDER BY created_at DESC, quote_id DESC
  `;
}
