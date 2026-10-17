/**
 * Read and export the mirror trail. `from` and `to` are required. A span over
 * 92 days is refused: that bound protects the database, it is not a product
 * limit. A blank limit is refused rather than filled in. Amounts stay decimal
 * strings. Cells that start with =, +, - or @ are escaped with the convert
 * history helper so a spreadsheet does not treat them as formulas.
 *
 * The row carries the follower order id and the leader fill id. It does not
 * carry a leader account id.
 */
import type { Sql } from 'postgres';
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { csvCell } from '../convert/convert-history.js';
import { CopyError } from './errors.js';

/** Database-protection bound. Not a commercial history limit. */
export const COPY_TRAIL_WINDOW_MAX_MS = 92 * 24 * 60 * 60 * 1000;
export const COPY_TRAIL_LIMIT_MAX = 500;

export const TRADE_COPY_TRAIL_WINDOW_UNSET = 'trade.copy_trail_window_unset' as const;
export const TRADE_COPY_TRAIL_WINDOW_TOO_WIDE = 'trade.copy_trail_window_too_wide' as const;
export const TRADE_COPY_TRAIL_LIMIT_UNSET = 'trade.copy_trail_limit_unset' as const;
export const TRADE_COPY_TRAIL_CURSOR_INVALID = 'trade.copy_trail_cursor_invalid' as const;

export interface MirrorTrailRow {
  readonly eventId: string;
  readonly followId: string;
  readonly leaderFillId: string;
  readonly kind: string;
  readonly followerOrderId: string | null;
  readonly followerFillId: string | null;
  readonly quantity: string | null;
  readonly price: string | null;
  readonly basisPoints: string | null;
  readonly code: string | null;
  readonly occurredAt: string;
}

export interface MirrorTrailPage {
  readonly rows: MirrorTrailRow[];
  readonly nextCursor: string | null;
}

export interface MirrorTrailQuery {
  readonly followId: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number | null;
  readonly cursor?: string | null;
}

interface StoredEvent {
  event_id: string;
  follow_id: string;
  leader_fill_id: string;
  kind: string;
  follower_order_id: string | null;
  follower_fill_id: string | null;
  quantity: string | null;
  price: string | null;
  basis_points: string | null;
  code: string | null;
  occurred_at: Date;
  seq: string;
}

export function assertCopyTrailWindow(from: string | undefined, to: string | undefined): { from: Date; to: Date } {
  if (from == null || to == null || from.trim() === '' || to.trim() === '') {
    throw new CopyError('copy trail window is unset', TRADE_COPY_TRAIL_WINDOW_UNSET);
  }
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new CopyError('copy trail window is unset', TRADE_COPY_TRAIL_WINDOW_UNSET);
  }
  if (end - start > COPY_TRAIL_WINDOW_MAX_MS) {
    throw new CopyError('copy trail window is wider than 92 days — database-protection bound', TRADE_COPY_TRAIL_WINDOW_TOO_WIDE);
  }
  return { from: new Date(start), to: new Date(end) };
}

export function publishedCopyTrailLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > COPY_TRAIL_LIMIT_MAX) {
    throw new CopyError('copy trail limit is unset — refuse to invent 50', TRADE_COPY_TRAIL_LIMIT_UNSET);
  }
  return value;
}

export function encodeCopyTrailCursor(occurredAt: string, seq: string): string {
  return Buffer.from(`${occurredAt}\n${seq}`, 'utf8').toString('base64url');
}

export function decodeCopyTrailCursor(cursor: string): { occurredAt: string; seq: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new CopyError('copy trail cursor is invalid', TRADE_COPY_TRAIL_CURSOR_INVALID);
  }
  const split = raw.indexOf('\n');
  if (split <= 0 || split === raw.length - 1) {
    throw new CopyError('copy trail cursor is invalid', TRADE_COPY_TRAIL_CURSOR_INVALID);
  }
  const occurredAt = raw.slice(0, split);
  const seq = raw.slice(split + 1);
  if (!Number.isFinite(Date.parse(occurredAt)) || !/^\d+$/.test(seq)) {
    throw new CopyError('copy trail cursor is invalid', TRADE_COPY_TRAIL_CURSOR_INVALID);
  }
  return { occurredAt, seq };
}

function canonicalMoney(value: string | null): string | null {
  if (value == null || value.trim() === '') return null;
  return formatAmount(parseAmount(value));
}

function present(row: StoredEvent): MirrorTrailRow {
  const occurredAt = row.occurred_at instanceof Date ? row.occurred_at.toISOString() : new Date(row.occurred_at).toISOString();
  return {
    eventId: row.event_id,
    followId: row.follow_id,
    leaderFillId: row.leader_fill_id,
    kind: row.kind,
    followerOrderId: row.follower_order_id,
    followerFillId: row.follower_fill_id,
    quantity: canonicalMoney(row.quantity),
    price: canonicalMoney(row.price),
    basisPoints: row.basis_points,
    code: row.code,
    occurredAt,
  };
}

async function selectEvents(
  sql: Sql,
  followId: string,
  window: { from: Date; to: Date },
  cursor: { occurredAt: string; seq: string } | null,
  limit: number | null,
): Promise<StoredEvent[]> {
  if (cursor && limit != null) {
    const cursorAt = new Date(cursor.occurredAt);
    return await sql<StoredEvent[]>`
      SELECT event_id::text AS event_id, follow_id, leader_fill_id, kind,
             follower_order_id, follower_fill_id, quantity::text AS quantity, price::text AS price,
             basis_points::text AS basis_points, code, occurred_at, seq::text AS seq
        FROM copy_mirror_events
       WHERE follow_id = ${followId}
         AND occurred_at >= ${window.from}
         AND occurred_at <= ${window.to}
         AND (occurred_at > ${cursorAt} OR (occurred_at = ${cursorAt} AND copy_mirror_events.seq > ${cursor.seq}::bigint))
       ORDER BY occurred_at ASC, copy_mirror_events.seq ASC
       LIMIT ${limit}
    `;
  }
  if (limit != null) {
    return await sql<StoredEvent[]>`
      SELECT event_id::text AS event_id, follow_id, leader_fill_id, kind,
             follower_order_id, follower_fill_id, quantity::text AS quantity, price::text AS price,
             basis_points::text AS basis_points, code, occurred_at, seq::text AS seq
        FROM copy_mirror_events
       WHERE follow_id = ${followId}
         AND occurred_at >= ${window.from}
         AND occurred_at <= ${window.to}
       ORDER BY occurred_at ASC, copy_mirror_events.seq ASC
       LIMIT ${limit}
    `;
  }
  return await sql<StoredEvent[]>`
    SELECT event_id::text AS event_id, follow_id, leader_fill_id, kind,
           follower_order_id, follower_fill_id, quantity::text AS quantity, price::text AS price,
           basis_points::text AS basis_points, code, occurred_at, seq::text AS seq
      FROM copy_mirror_events
     WHERE follow_id = ${followId}
       AND occurred_at >= ${window.from}
       AND occurred_at <= ${window.to}
     ORDER BY occurred_at ASC, copy_mirror_events.seq ASC
  `;
}

export async function listMirrorTrail(sql: Sql, principal: Principal, query: MirrorTrailQuery): Promise<MirrorTrailPage> {
  requireScope(principal, 'trade:read');
  const window = assertCopyTrailWindow(query.from, query.to);
  const limit = publishedCopyTrailLimit(query.limit);
  const cursor = query.cursor == null || query.cursor.trim() === '' ? null : decodeCopyTrailCursor(query.cursor);
  const rows = await selectEvents(sql, query.followId, window, cursor, limit + 1);
  const page = rows.slice(0, limit).map(present);
  const last = page[page.length - 1];
  const lastStored = rows[limit - 1];
  const nextCursor = rows.length > limit && last && lastStored ? encodeCopyTrailCursor(last.occurredAt, lastStored.seq) : null;
  return { rows: page, nextCursor };
}

export const MIRROR_TRAIL_CSV_HEADER =
  'eventId,followId,leaderFillId,kind,followerOrderId,followerFillId,quantity,price,basisPoints,code,occurredAt';

export function mirrorTrailCsv(rows: readonly MirrorTrailRow[]): string {
  const lines = rows.map((row) =>
    [
      row.eventId,
      row.followId,
      row.leaderFillId,
      row.kind,
      row.followerOrderId ?? '',
      row.followerFillId ?? '',
      row.quantity ?? '',
      row.price ?? '',
      row.basisPoints ?? '',
      row.code ?? '',
      row.occurredAt,
    ]
      .map((cell) => csvCell(cell))
      .join(','),
  );
  return [MIRROR_TRAIL_CSV_HEADER, ...lines].join('\n');
}

export async function exportMirrorTrail(
  sql: Sql,
  principal: Principal,
  query: { followId: string; from?: string; to?: string },
): Promise<string> {
  requireScope(principal, 'trade:read');
  const window = assertCopyTrailWindow(query.from, query.to);
  const rows = await selectEvents(sql, query.followId, window, null, null);
  return mirrorTrailCsv(rows.map(present));
}
