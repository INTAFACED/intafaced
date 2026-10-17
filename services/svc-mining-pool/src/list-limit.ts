import { MiningError } from './errors.js';

/**
 * Same list-limit posture as the academy SQL readers: a missing, blank, or
 * non-positive limit is a typed refusal. A caller-supplied page above 200 is
 * capped. The cap is not a default for an omitted limit.
 */
const PAGE_CAP = 200;

export function assertListLimit(limit: unknown, code: string): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new MiningError('List limit is unset', code);
  }
  return Math.min(PAGE_CAP, limit);
}

/** Requested hashrate lookback. 1 to 1440 minutes, no default. */
export function assertWindowMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1440) {
    throw new MiningError('Hashrate window is unset', 'mining.hashrate_window_unset');
  }
  return value;
}

export function decodeCursor(cursor: string): { at: Date; key: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new MiningError('Cursor is not valid', 'mining.cursor_invalid');
  }
  const nl = raw.indexOf('\n');
  if (nl < 1) throw new MiningError('Cursor is not valid', 'mining.cursor_invalid');
  const at = new Date(raw.slice(0, nl));
  const key = raw.slice(nl + 1);
  if (Number.isNaN(at.getTime()) || key.length === 0) {
    throw new MiningError('Cursor is not valid', 'mining.cursor_invalid');
  }
  return { at, key };
}

export function encodeCursor(at: Date, key: string): string {
  return Buffer.from(`${at.toISOString()}\n${key}`, 'utf8').toString('base64url');
}

export function decodePayoutCursor(cursor: string): { at: Date; windowId: string; minerId: string } {
  const decoded = decodeCursor(cursor);
  const nl = decoded.key.indexOf('\n');
  if (nl < 1) throw new MiningError('Cursor is not valid', 'mining.cursor_invalid');
  const windowId = decoded.key.slice(0, nl);
  const minerId = decoded.key.slice(nl + 1);
  if (!windowId || !minerId) throw new MiningError('Cursor is not valid', 'mining.cursor_invalid');
  return { at: decoded.at, windowId, minerId };
}

export function encodePayoutCursor(at: Date, windowId: string, minerId: string): string {
  return encodeCursor(at, `${windowId}\n${minerId}`);
}
