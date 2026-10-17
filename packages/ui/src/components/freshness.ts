/**
 * Data freshness, as pure logic with no React: is a figure live, stale, unknown or refused,
 * and how do we print the "as of" time. `now` is always passed in, so tests are deterministic;
 * components read the clock at their own edge (Date.now()) and hand it down.
 *
 * Time values are epoch milliseconds. Money is never handled here.
 */

export type Freshness = 'live' | 'stale' | 'unknown' | 'refused';

/** A time given as an ISO 8601 string, epoch milliseconds as a number, or epoch milliseconds as a digit string. */
export type AsOf = string | number | null | undefined;

/** A timestamp this far ahead of `now` is treated as clock skew and still counts as live; further ahead is unknown. */
export const CLOCK_SKEW_TOLERANCE_MS = 5000;

/** Smallest epoch the kit reads as milliseconds (March 1973). Smaller digit strings are seconds, which would be shown as 1970. */
const MIN_EPOCH_MS = 1e11;
/** Largest epoch the kit reads as milliseconds (the year 2099). Larger digit strings are microsecond or nanosecond epochs. */
const MAX_EPOCH_MS = 4.1e12;

/**
 * Epoch milliseconds for `asOf`, or null when it is missing, empty, not a date, or not plausibly
 * milliseconds. A seconds, microsecond or nanosecond epoch is "unknown" rather than a wrong time or a crash.
 */
export function parseAsOf(asOf: AsOf): number | null {
  if (asOf == null) return null;
  let ms: number;
  if (typeof asOf === 'number') {
    ms = asOf;
  } else {
    const text = asOf.trim();
    if (text === '') return null;
    ms = /^\d+$/.test(text) ? parseInt(text, 10) : Date.parse(text);
  }
  if (!Number.isFinite(ms) || ms < MIN_EPOCH_MS || ms > MAX_EPOCH_MS) return null;
  return ms;
}

export interface FreshnessInput {
  asOf: AsOf;
  /** Epoch ms of "now". Required: the pure function never reads the clock. */
  now: number;
  /** Older than this many ms is stale. Missing or invalid means we cannot judge, so unknown. */
  staleAfterMs: number | null | undefined;
  /** The source refused to answer. Wins over everything else. */
  refused?: boolean;
}

/**
 * refused wins; no usable `asOf` is unknown; an `asOf` more than 5 s in the future is unknown;
 * older than `staleAfterMs` is stale (exactly `staleAfterMs` old is still live); otherwise live.
 */
export function freshnessOf({ asOf, now, staleAfterMs, refused }: FreshnessInput): Freshness {
  if (refused) return 'refused';
  const at = parseAsOf(asOf);
  if (at == null) return 'unknown';
  if (!Number.isFinite(now)) return 'unknown';
  if (staleAfterMs == null || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) return 'unknown';
  const age = now - at;
  if (age < -CLOCK_SKEW_TOLERANCE_MS) return 'unknown';
  if (age > staleAfterMs) return 'stale';
  return 'live';
}

/**
 * Milliseconds from `now` until `freshnessOf` would answer differently for the same inputs, or null
 * when nothing will change on its own (refused, no usable `asOf` or `staleAfterMs`, or already stale).
 * Live turns stale at `asOf + staleAfterMs + 1`; a time too far in the future turns live when it comes
 * within the skew tolerance. Pure: no clock read, so a component can schedule exactly one timer.
 */
export function msUntilFreshnessChange({ asOf, now, staleAfterMs, refused }: FreshnessInput): number | null {
  if (refused) return null;
  const at = parseAsOf(asOf);
  if (at == null || !Number.isFinite(now)) return null;
  if (staleAfterMs == null || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) return null;
  const age = now - at;
  if (age > staleAfterMs) return null;
  if (age < -CLOCK_SKEW_TOLERANCE_MS) return Math.ceil(-CLOCK_SKEW_TOLERANCE_MS - age);
  return Math.ceil(staleAfterMs - age + 1);
}

export interface FormatAsOfOptions {
  /** IANA zone. Undefined = the viewer's zone; tests and the gallery pass 'UTC'. */
  timeZone?: string;
  locale?: string;
  /** Epoch ms of "now". Only used to decide whether to add the date; without it the date is never added. */
  now?: number;
}

function dayKey(ms: number, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

/**
 * "14:03:07" (24 h), or "17 Oct 14:03:07" style (locale order) when `asOf` is not on the same day as `now`.
 * Returns null when `asOf` is unusable or the time zone name is not valid.
 */
export function formatAsOf(asOf: AsOf, options: FormatAsOfOptions = {}): string | null {
  const ms = parseAsOf(asOf);
  if (ms == null) return null;
  const { timeZone, locale, now } = options;
  try {
    const time = new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(ms);
    if (now == null || !Number.isFinite(now) || dayKey(ms, timeZone) === dayKey(now, timeZone)) return time;
    const date = new Intl.DateTimeFormat(locale, { timeZone, month: 'short', day: 'numeric' }).format(ms);
    return `${date} ${time}`;
  } catch {
    return null;
  }
}

/** ISO 8601 text for a <time dateTime>, or null when `asOf` is unusable. */
export function asOfIso(asOf: AsOf): string | null {
  const ms = parseAsOf(asOf);
  return ms == null ? null : new Date(ms).toISOString();
}
