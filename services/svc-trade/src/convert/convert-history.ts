/**
 * Convert history, export, and status. Reads the caller's stored quotes.
 * Does not scan ledger lines. A point read of a known hold or fill key is
 * used only to tell `unknown` from `quoted` and to return a transaction id
 * the ledger already holds.
 */

import type { Sql } from 'postgres';
import { TRPCError } from '@intafaced/contracts';
import { requireScope, type Principal } from '@intafaced/auth';
import { convertSettleIdsFor } from './ids.js';
import { convertCustomerHoldKey } from './settle.js';

/** Database-protection bound. Not a commercial history limit. */
export const CONVERT_LIST_WINDOW_MAX_MS = 92 * 24 * 60 * 60 * 1000;
export const CONVERT_LIST_LIMIT_MAX = 500;

export const TRADE_CONVERT_LIST_WINDOW_UNSET = 'trade.convert_list_window_unset' as const;
export const TRADE_CONVERT_LIST_WINDOW_TOO_WIDE = 'trade.convert_list_window_too_wide' as const;
export const TRADE_CONVERT_LIST_LIMIT_UNSET = 'trade.convert_list_limit_unset' as const;
export const TRADE_CONVERT_LIST_CURSOR_INVALID = 'trade.convert_list_cursor_invalid' as const;
export const TRADE_CONVERT_STATUS_CLIENT_ID_UNSET = 'trade.convert_status_client_id_unset' as const;
export const TRADE_CONVERT_STATUS_UNREADABLE = 'trade.convert_status_unreadable' as const;
export const TRADE_CONVERT_CLIENT_ID_CONFLICT = 'trade.convert_client_id_conflict' as const;

export type ConvertHistoryCode =
  | typeof TRADE_CONVERT_LIST_WINDOW_UNSET
  | typeof TRADE_CONVERT_LIST_WINDOW_TOO_WIDE
  | typeof TRADE_CONVERT_LIST_LIMIT_UNSET
  | typeof TRADE_CONVERT_LIST_CURSOR_INVALID
  | typeof TRADE_CONVERT_STATUS_CLIENT_ID_UNSET
  | typeof TRADE_CONVERT_STATUS_UNREADABLE
  | typeof TRADE_CONVERT_CLIENT_ID_CONFLICT;

export class ConvertHistoryError extends Error {
  constructor(
    message: string,
    readonly code: ConvertHistoryCode,
  ) {
    super(message);
    this.name = 'ConvertHistoryError';
  }
}

export type ConvertPublicLifecycle = 'quoted' | 'accepted' | 'settled' | 'refused' | 'expired' | 'unknown';

export type ConvertStatusName = 'none' | ConvertPublicLifecycle;

export interface ConvertHistoryRow {
  readonly quoteId: string;
  readonly inAsset: string;
  readonly outAsset: string;
  readonly inAmount: string;
  readonly outAmount: string;
  readonly lifecycle: ConvertPublicLifecycle;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly settledAt: string | null;
}

export interface ConvertListPage {
  rows: ConvertHistoryRow[];
  nextCursor: string | null;
}

export interface ConvertStatus {
  readonly status: ConvertStatusName;
  readonly quoteId: string | null;
  readonly ledgerTransactionRef: string | null;
}

export interface ConvertListQuery {
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number | null;
  readonly cursor?: string | null;
}

interface StoredQuoteRow {
  quote_id: string;
  in_asset: string;
  out_asset: string;
  in_amount: string;
  out_amount: string;
  lifecycle: 'open' | 'bound' | 'settled';
  refusal_code: string | null;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  settled_at: Date | null;
}

type LedgerPoint = { getTxByKey(idempotencyKey: string): Promise<{ id: string } | null> };

/** Fill idempotency key from `recipes.marketMakerMakerFill`. Not a ledger scan. */
export function convertFillLedgerKey(fillId: string): string {
  return `trade.fill.mm-maker:${fillId}`;
}

export function publishedConvertListLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > CONVERT_LIST_LIMIT_MAX) {
    throw new ConvertHistoryError('convert list limit is unset — refuse to invent 50', TRADE_CONVERT_LIST_LIMIT_UNSET);
  }
  return value;
}

export function assertConvertListWindow(from: string | undefined, to: string | undefined): { from: Date; to: Date } {
  if (from == null || to == null || from.trim() === '' || to.trim() === '') {
    throw new ConvertHistoryError('convert list window is unset', TRADE_CONVERT_LIST_WINDOW_UNSET);
  }
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new ConvertHistoryError('convert list window is unset', TRADE_CONVERT_LIST_WINDOW_UNSET);
  }
  if (end - start > CONVERT_LIST_WINDOW_MAX_MS) {
    throw new ConvertHistoryError(
      'convert list window is wider than 92 days — database-protection bound',
      TRADE_CONVERT_LIST_WINDOW_TOO_WIDE,
    );
  }
  return { from: new Date(start), to: new Date(end) };
}

export function encodeConvertCursor(createdAt: string, quoteId: string): string {
  return Buffer.from(`${createdAt}\n${quoteId}`, 'utf8').toString('base64url');
}

export function decodeConvertCursor(cursor: string): { createdAt: string; quoteId: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new ConvertHistoryError('convert list cursor is invalid', TRADE_CONVERT_LIST_CURSOR_INVALID);
  }
  const split = raw.indexOf('\n');
  if (split <= 0 || split === raw.length - 1) {
    throw new ConvertHistoryError('convert list cursor is invalid', TRADE_CONVERT_LIST_CURSOR_INVALID);
  }
  const createdAt = raw.slice(0, split);
  const quoteId = raw.slice(split + 1);
  if (!Number.isFinite(Date.parse(createdAt)) || quoteId.trim() === '' || quoteId.includes('\n')) {
    throw new ConvertHistoryError('convert list cursor is invalid', TRADE_CONVERT_LIST_CURSOR_INVALID);
  }
  return { createdAt, quoteId };
}

/** List projection from the stored row. Does not read the ledger, so a lost accept stays `quoted` here. */
export function listLifecycle(row: Pick<StoredQuoteRow, 'lifecycle' | 'refusal_code' | 'expires_at'>, now: Date): ConvertPublicLifecycle {
  if (row.lifecycle === 'settled') return 'settled';
  if (row.lifecycle === 'bound') return 'accepted';
  if (row.refusal_code != null && row.refusal_code.trim() !== '') return 'refused';
  if (row.expires_at.getTime() <= now.getTime()) return 'expired';
  return 'quoted';
}

function iso(value: Date): string {
  return value.toISOString();
}

function presentRow(row: StoredQuoteRow, now: Date): ConvertHistoryRow {
  return {
    quoteId: row.quote_id,
    inAsset: row.in_asset,
    outAsset: row.out_asset,
    inAmount: row.in_amount,
    outAmount: row.out_amount,
    lifecycle: listLifecycle(row, now),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    acceptedAt: row.accepted_at ? iso(row.accepted_at) : null,
    settledAt: row.settled_at ? iso(row.settled_at) : null,
  };
}

async function selectPage(
  sql: Sql,
  userId: string,
  window: { from: Date; to: Date },
  cursor: { createdAt: string; quoteId: string } | null,
  limit: number | null,
): Promise<StoredQuoteRow[]> {
  const cursorAt = cursor ? new Date(cursor.createdAt) : null;
  if (cursor && cursorAt && limit != null) {
    return sql<StoredQuoteRow[]>`
      SELECT quote_id, in_asset, out_asset, in_amount::text AS in_amount, out_amount::text AS out_amount,
             lifecycle, refusal_code, created_at, expires_at, accepted_at, settled_at
      FROM convert_quotes
      WHERE user_id = ${userId}
        AND created_at >= ${window.from}
        AND created_at <= ${window.to}
        AND (created_at < ${cursorAt} OR (created_at = ${cursorAt} AND quote_id < ${cursor.quoteId}))
      ORDER BY created_at DESC, quote_id DESC
      LIMIT ${limit}
    `;
  }
  if (cursor && cursorAt) {
    return sql<StoredQuoteRow[]>`
      SELECT quote_id, in_asset, out_asset, in_amount::text AS in_amount, out_amount::text AS out_amount,
             lifecycle, refusal_code, created_at, expires_at, accepted_at, settled_at
      FROM convert_quotes
      WHERE user_id = ${userId}
        AND created_at >= ${window.from}
        AND created_at <= ${window.to}
        AND (created_at < ${cursorAt} OR (created_at = ${cursorAt} AND quote_id < ${cursor.quoteId}))
      ORDER BY created_at DESC, quote_id DESC
    `;
  }
  if (limit != null) {
    return sql<StoredQuoteRow[]>`
      SELECT quote_id, in_asset, out_asset, in_amount::text AS in_amount, out_amount::text AS out_amount,
             lifecycle, refusal_code, created_at, expires_at, accepted_at, settled_at
      FROM convert_quotes
      WHERE user_id = ${userId}
        AND created_at >= ${window.from}
        AND created_at <= ${window.to}
      ORDER BY created_at DESC, quote_id DESC
      LIMIT ${limit}
    `;
  }
  return sql<StoredQuoteRow[]>`
    SELECT quote_id, in_asset, out_asset, in_amount::text AS in_amount, out_amount::text AS out_amount,
           lifecycle, refusal_code, created_at, expires_at, accepted_at, settled_at
    FROM convert_quotes
    WHERE user_id = ${userId}
      AND created_at >= ${window.from}
      AND created_at <= ${window.to}
    ORDER BY created_at DESC, quote_id DESC
  `;
}

export async function listConvertHistory(sql: Sql, principal: Principal, query: ConvertListQuery, now: Date): Promise<ConvertListPage> {
  requireScope(principal, 'trade:read');
  const window = assertConvertListWindow(query.from, query.to);
  const limit = publishedConvertListLimit(query.limit);
  const cursor = query.cursor == null || query.cursor.trim() === '' ? null : decodeConvertCursor(query.cursor);
  const rows = await selectPage(sql, principal.userId, window, cursor, limit + 1);
  const page: ConvertHistoryRow[] = rows.slice(0, limit).map((row) => presentRow(row, now));
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeConvertCursor(last.createdAt, last.quoteId) : null;
  return { rows: page, nextCursor };
}

export function csvCell(value: string): string {
  const dangerous = value.length > 0 && '=+-@'.includes(value[0]!);
  const body = dangerous ? `'${value}` : value;
  if (dangerous || /[",\n\r]/.test(body)) return `"${body.replace(/"/g, '""')}"`;
  return body;
}

export function convertHistoryCsv(rows: readonly ConvertHistoryRow[]): string {
  const header = 'quoteId,inAsset,outAsset,inAmount,outAmount,lifecycle,createdAt,expiresAt,acceptedAt,settledAt';
  const lines = rows.map((row) =>
    [
      row.quoteId,
      row.inAsset,
      row.outAsset,
      row.inAmount,
      row.outAmount,
      row.lifecycle,
      row.createdAt,
      row.expiresAt,
      row.acceptedAt ?? '',
      row.settledAt ?? '',
    ]
      .map(csvCell)
      .join(','),
  );
  return [header, ...lines].join('\n');
}

export async function exportConvertHistory(
  sql: Sql,
  principal: Principal,
  query: { from?: string; to?: string },
  now: Date,
): Promise<string> {
  requireScope(principal, 'trade:read');
  const window = assertConvertListWindow(query.from, query.to);
  const rows = await selectPage(sql, principal.userId, window, null, null);
  return convertHistoryCsv(rows.map((row) => presentRow(row, now)));
}

async function pointTxId(ledger: LedgerPoint, key: string): Promise<string | null> {
  try {
    const tx = await ledger.getTxByKey(key);
    return tx?.id ?? null;
  } catch {
    throw new ConvertHistoryError('convert status could not read the stored ledger key', TRADE_CONVERT_STATUS_UNREADABLE);
  }
}

export async function readConvertStatus(
  sql: Sql,
  ledger: LedgerPoint,
  principal: Principal,
  clientConvertId: string | undefined,
  now: Date,
): Promise<ConvertStatus> {
  requireScope(principal, 'trade:read');
  const id = clientConvertId?.trim() ?? '';
  if (!id) {
    throw new ConvertHistoryError('convert status clientConvertId is unset', TRADE_CONVERT_STATUS_CLIENT_ID_UNSET);
  }
  const rows = await sql<StoredQuoteRow[]>`
    SELECT quote_id, in_asset, out_asset, in_amount::text AS in_amount, out_amount::text AS out_amount,
           lifecycle, refusal_code, created_at, expires_at, accepted_at, settled_at
    FROM convert_quotes
    WHERE user_id = ${principal.userId} AND client_convert_id = ${id}
    LIMIT 2
  `;
  const row = rows[0];
  if (!row || rows.length !== 1) return { status: 'none', quoteId: null, ledgerTransactionRef: null };
  const ids = convertSettleIdsFor(row.quote_id);
  if (row.lifecycle === 'settled') {
    return {
      status: 'settled',
      quoteId: row.quote_id,
      ledgerTransactionRef: await pointTxId(ledger, convertFillLedgerKey(ids.fillId)),
    };
  }
  if (row.lifecycle === 'bound') {
    return { status: 'accepted', quoteId: row.quote_id, ledgerTransactionRef: null };
  }
  if (row.refusal_code != null && row.refusal_code.trim() !== '') {
    return { status: 'refused', quoteId: row.quote_id, ledgerTransactionRef: null };
  }
  const hold = await pointTxId(ledger, convertCustomerHoldKey(ids.takerOrderId));
  if (hold) return { status: 'unknown', quoteId: row.quote_id, ledgerTransactionRef: hold };
  if (row.expires_at.getTime() <= now.getTime()) {
    return { status: 'expired', quoteId: row.quote_id, ledgerTransactionRef: null };
  }
  return { status: 'quoted', quoteId: row.quote_id, ledgerTransactionRef: null };
}

export async function bindConvertClientId(sql: Sql, userId: string, quoteId: string, clientConvertId: string | undefined): Promise<void> {
  const id = clientConvertId?.trim() ?? '';
  if (!id) return;
  try {
    const updated = await sql<Array<{ quote_id: string }>>`
      UPDATE convert_quotes
      SET client_convert_id = ${id}, updated_at = now()
      WHERE quote_id = ${quoteId}
        AND user_id = ${userId}
        AND (client_convert_id IS NULL OR client_convert_id = ${id})
      RETURNING quote_id
    `;
    if (updated.length > 0) return;
    const [row] = await sql<Array<{ client_convert_id: string | null }>>`
      SELECT client_convert_id FROM convert_quotes WHERE quote_id = ${quoteId} AND user_id = ${userId}
    `;
    if (!row || row.client_convert_id === id) return;
    throw new ConvertHistoryError('convert client id does not match the id stored on this quote', TRADE_CONVERT_CLIENT_ID_CONFLICT);
  } catch (err) {
    if (err instanceof ConvertHistoryError) throw err;
    if ((err as { code?: string }).code === '23505') {
      throw new ConvertHistoryError('convert client id is already stored on another quote', TRADE_CONVERT_CLIENT_ID_CONFLICT);
    }
    throw err;
  }
}

export async function markConvertRefusal(sql: Sql, quoteId: string, code: string): Promise<void> {
  const refusal = code.trim();
  if (!refusal) return;
  await sql`
    UPDATE convert_quotes
    SET refusal_code = ${refusal}, updated_at = now()
    WHERE quote_id = ${quoteId} AND lifecycle = 'open'
  `;
}

export function convertHistoryTrpcError(err: unknown): TRPCError | null {
  if (!(err instanceof ConvertHistoryError)) return null;
  return new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [${err.code}]`, cause: err });
}
