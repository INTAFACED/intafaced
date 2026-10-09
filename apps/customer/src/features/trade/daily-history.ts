import type { OHLCV } from '@intafaced/exchange-contract/schemas';
import { parseAmount, formatAmount } from '../../shared/money';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OFFSET = 8 * HOUR;
const PRIOR_DAYS = 19;
const LIMIT = 500;
const READ_TIMEOUT = 15_000;

export type DailyHistoryWindow = { sinceMs: number; requestedAtMs: number };
export class DailyHistoryError extends Error {
  constructor(readonly code: 'invalid_clock_window' | 'invalid_hourly_history') {
    super(code);
    this.name = 'DailyHistoryError';
  }
}
export function utc8DailyStart(timestampMs: number): number {
  return Math.floor((timestampMs + OFFSET) / DAY) * DAY - OFFSET;
}
/** A deliberately short public read keeps every possible hourly bucket below
 * the existing newest-500 cap. Local clock checks do not establish server asOf. */
export function dailyHistoryWindow(requestedAtMs: number): DailyHistoryWindow {
  const sinceMs = utc8DailyStart(requestedAtMs) - PRIOR_DAYS * DAY;
  if (!Number.isSafeInteger(requestedAtMs) || requestedAtMs < 0 || sinceMs < 0)
    throw new DailyHistoryError('invalid_clock_window');
  return { sinceMs, requestedAtMs };
}

/** Exact, read-only derivation. First/last chronological source hours supply
 * open/close; this cannot reproduce cross-hour engine-sequence ordering.
 * Missing buckets remain absent. No candle completeness is asserted. */
export function deriveUtc8Daily(rows: readonly OHLCV[], window: DailyHistoryWindow, readAtMs: number): OHLCV[] {
  const { sinceMs, requestedAtMs } = window;
  const expected = dailyHistoryWindow(requestedAtMs);
  const possibleHours = Math.floor((readAtMs - sinceMs) / HOUR) + 1;
  if (
    sinceMs !== expected.sinceMs ||
    !Number.isSafeInteger(readAtMs) ||
    readAtMs < requestedAtMs ||
    readAtMs - requestedAtMs > READ_TIMEOUT ||
    possibleHours >= LIMIT
  ) throw new DailyHistoryError('invalid_clock_window');
  if (rows.length >= LIMIT || rows.length > possibleHours) throw new DailyHistoryError('invalid_hourly_history');
  const days: OHLCV[] = [];
  let previous = -1;
  for (const row of rows) {
    try {
      if (!Array.isArray(row) || row.length !== 6) throw new Error();
      const [timestamp, open, high, low, close, volume] = row;
      if (
        !Number.isSafeInteger(timestamp) || timestamp % HOUR !== 0 ||
        timestamp < sinceMs || timestamp > Math.floor(readAtMs / HOUR) * HOUR || timestamp <= previous ||
        [open, high, low, close, volume].some((value) => typeof value !== 'string')
      ) throw new Error();
      const o = parseAmount(open), h = parseAmount(high), l = parseAmount(low), c = parseAmount(close), v = parseAmount(volume);
      if (o <= 0n || h <= 0n || l <= 0n || c <= 0n || v < 0n || h < l || h < o || h < c || l > o || l > c)
        throw new Error();
      previous = timestamp;
      const start = utc8DailyStart(timestamp), last = days.at(-1);
      // A read may cross midnight. The earlier request still fits below the
      // cap, but its oldest day no longer belongs to the disclosed window.
      if (start < utc8DailyStart(readAtMs) - PRIOR_DAYS * DAY) continue;
      if (!last || last[0] !== start) days.push([start, open, high, low, close, volume]);
      else {
        if (h > parseAmount(last[2])) last[2] = high;
        if (l < parseAmount(last[3])) last[3] = low;
        last[4] = close;
        last[5] = formatAmount(parseAmount(last[5]) + v);
      }
    } catch {
      throw new DailyHistoryError('invalid_hourly_history');
    }
  }
  return days;
}
