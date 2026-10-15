import { z } from 'zod';
import { MerchantOpsError } from './errors.js';

/**
 * CURSOR PAGINATION for every merchant-operations list.
 *
 * Newest first, keyed on (timestamp, id) so equal timestamps never skip or
 * repeat a row. The cursor is opaque to the client. The timestamp travels as a
 * MICROSECOND string straight from Postgres: a JS `Date` has milliseconds and
 * would drop digits, and a page boundary that drops digits loses rows.
 *
 * WHEN BINDING THAT STRING, WRITE `(${ts}::text)::timestamptz`, NEVER
 * `${ts}::timestamptz`. postgres.js serialises a parameter typed timestamptz
 * through `new Date(...)`, which cuts it to milliseconds and silently skips the
 * rows between the cut and the real boundary (found by a flaky page walk).
 *
 * `limit` is accepted as optional in the input schema so that leaving it out
 * reaches a named refusal instead of a Zod "Required", and is never defaulted
 * (same rule as every svc-pay list: blank is not 50).
 */
export const limitInput = z.number().int().min(1).max(200).optional();
export const cursorInput = z.string().min(1).max(512).optional();

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export function requireLimit(limit?: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) {
    throw new MerchantOpsError('pay.merchant_ops_list_limit_unset', 'bad_request');
  }
  return limit;
}

const MICRO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeCursor(ts: string, key: string): string {
  return Buffer.from(JSON.stringify([ts, key]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { ts: string; key: string } | null {
  if (cursor === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string' && MICRO_TS.test(parsed[0])) {
      return { ts: parsed[0], key: parsed[1] };
    }
  } catch {
    /* falls through */
  }
  throw new MerchantOpsError('pay.cursor_invalid', 'bad_request');
}

/** Take one page from `limit + 1` fetched rows. */
export function toPage<R, T>(rows: R[], limit: number, map: (row: R) => T, cursorOf: (row: R) => string): Page<T> {
  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept[kept.length - 1];
  return { items: kept.map(map), nextCursor: hasMore && last ? cursorOf(last) : null };
}
