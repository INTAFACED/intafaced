import { ListQueryError } from '../list-page.js';
import { PortalError } from './errors.js';

/**
 * Opaque keyset cursor for period + asset series.
 *
 * Same envelope as payment.list (`{ items, nextCursor }`, base64url, length-capped).
 * The period is a UTC date, not a JavaScript timestamp, so a page boundary does
 * not drop a row inside a day. Amounts that travel beside this cursor stay
 * scaled bigint; this string is only an ordering key.
 */

const TEXT = /^v1\|(\d{4}-\d{2}-\d{2})\|([A-Za-z0-9._-]{1,16})$/;

export interface SeriesCursor {
  readonly period: string;
  readonly assetCode: string;
}

export function encodeSeriesCursor(period: string, assetCode: string): string {
  return Buffer.from(`v1|${period}|${assetCode}`, 'utf8').toString('base64url');
}

export function decodeSeriesCursor(raw: string): SeriesCursor {
  if (raw.length < 1 || raw.length > 300 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new ListQueryError('pay.list_cursor_invalid', 'List cursor is not valid');
  }
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const match = TEXT.exec(text);
  if (!match) throw new ListQueryError('pay.list_cursor_invalid', 'List cursor is not valid');
  const period = match[1]!;
  const assetCode = match[2]!;
  if (new Date(`${period}T00:00:00.000Z`).toISOString().slice(0, 10) !== period) {
    throw new ListQueryError('pay.list_cursor_invalid', 'List cursor is not valid');
  }
  return { period, assetCode };
}

export function requirePageLimit(limit: number | undefined, code: `pay.${string}`): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new PortalError(code, 'precondition');
  }
  return limit;
}
