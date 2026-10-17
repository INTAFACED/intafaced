import { createHash } from 'node:crypto';
import type { PayErrorCode } from '../payment-service.js';
import { ListQueryError, encodeListCursor, parseListFilters, type ListFilters } from '../list-page.js';

export type PayFail = (message: string, code: PayErrorCode) => never;

export function assertPortalPageLimit(limit: number | undefined, code: PayErrorCode, label: string, fail: PayFail): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    fail(`${label} page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).`, code);
  }
  return Math.min(200, Math.floor(limit));
}

export function portalFilters(
  input: { search?: string; assetId?: string; from?: string; to?: string; cursor?: string },
  fail: PayFail,
): ListFilters {
  try {
    return parseListFilters(input);
  } catch (err) {
    if (err instanceof ListQueryError) fail(err.message, err.code);
    throw err;
  }
}

/** Microsecond UTC stamp the list cursor accepts. Milliseconds are padded, not rounded into a neighbour. */
export function cursorStamp(date: Date): string {
  const iso = date.toISOString();
  const dot = iso.indexOf('.');
  const head = dot === -1 ? iso.replace(/Z$/, '') : iso.slice(0, dot);
  const frac = dot === -1 ? '' : iso.slice(dot + 1).replace(/Z$/, '');
  return `${head}.${(frac + '000000').slice(0, 6)}Z`;
}

/** Stable uuid for a line that has no row of its own. Opaque; not a guess at a stored id. */
export function stableUuid(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function pageCursor(rows: Array<{ created_at_cursor: string; id: string }>, limit: number): string | null {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1];
  if (!last) return null;
  return encodeListCursor(last.created_at_cursor, last.id);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asUuid(value: unknown): string | null {
  if (typeof value !== 'string' || !UUID.test(value)) return null;
  return value.toLowerCase();
}
