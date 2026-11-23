import { MerchantOpsError } from './errors.js';
import { limitInput, cursorInput } from '@intafaced/contracts/pay-founder-admin-procedures';

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
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      MICRO_TS.test(parsed[0])
    ) {
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
export { limitInput, cursorInput };
