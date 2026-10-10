import type { OHLCV } from '@intafaced/exchange-contract/schemas';
import { parseAmount, formatAmount } from '../../shared/money';

const QUARTER = 900_000,
  HOUR = 3_600_000,
  DATE = 86_400_000,
  READ_TIMEOUT = 15_000;
type DateInterval = Readonly<{ calendarDate: string; startMs: number; endMs: number }>;
export type DailyPlan = Readonly<{
  zone: string;
  requestedAtMs: number;
  sinceMs: number;
  sourceInterval: '1h' | '15m';
  sourceSpanMs: number;
  priorDates: 19 | 3;
  limit: 500;
  dateIntervals: readonly DateInterval[];
  nextBoundaryMs: number;
}>;
export type DailyMetadata = Readonly<{
  zone: string;
  sourceInterval: '1h' | '15m';
  priorDates: 19 | 3;
  sinceMs: number;
  requestedAtMs: number;
  readAtMs: number;
  currentCalendarDate: string;
  nextBoundaryMs: number;
  partialCurrent: true;
  manualRefresh: true;
}>;
export type ZonedDailySnapshot = Readonly<{ rows: readonly OHLCV[]; metadata: DailyMetadata; plan: DailyPlan }>;
export class ZonedDailyError extends Error {
  constructor(readonly code: 'invalid_zone' | 'unrepresentable_boundary' | 'invalid_clock_window' | 'invalid_source_history') {
    super(code);
    this.name = 'ZonedDailyError';
  }
}
export function canonicalDailyZone(input: string): string {
  try {
    if (typeof input !== 'string' || input.length > 100 || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(input.trim()))
      throw new Error();
    return new Intl.DateTimeFormat('en', { timeZone: input.trim() }).resolvedOptions().timeZone;
  } catch {
    throw new ZonedDailyError('invalid_zone');
  }
}
function validClock(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Date.UTC(9999, 0, 1)) throw new ZonedDailyError('invalid_clock_window');
}
function calendar(ordinal: number) {
  return new Date(ordinal * DATE).toISOString().slice(0, 10);
}
const issuedPlans = new WeakSet<DailyPlan>();

/** Runtime Intl supplies the calendar rules. Quarter-hour consistency anchors,
 * bounded search and source-grid checks refuse mappings we cannot represent. */
export function planZonedDaily(input: string, requestedAtMs: number): DailyPlan {
  validClock(requestedAtMs);
  const zone = canonicalDailyZone(input);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dates = new Map<number, number>(),
    boundaries = new Map<number, number | null>();
  let calls = 0;
  function dateAt(timestamp: number): number {
    const saved = dates.get(timestamp);
    if (saved !== undefined) return saved;
    if (++calls > 10_000 || !Number.isSafeInteger(timestamp)) throw new ZonedDailyError('unrepresentable_boundary');
    const parts = formatter.formatToParts(timestamp),
      part = (kind: string) => Number(parts.find((entry) => entry.type === kind)?.value);
    const year = part('year'),
      month = part('month'),
      day = part('day');
    if (year < 100 || year > 9999 || !month || !day) throw new ZonedDailyError('unrepresentable_boundary');
    const value = Date.UTC(year, month - 1, day) / DATE;
    dates.set(timestamp, value);
    return value;
  }
  function first(ordinal: number): number | null {
    if (boundaries.has(ordinal)) return boundaries.get(ordinal)!;
    const lower = ordinal * DATE - 48 * HOUR,
      upper = ordinal * DATE + 48 * HOUR;
    let previous = dateAt(lower),
      bracket: [number, number] | undefined;
    if (previous >= ordinal || dateAt(upper) <= ordinal) throw new ZonedDailyError('unrepresentable_boundary');
    for (let instant = lower + QUARTER; instant <= upper; instant += QUARTER) {
      const current = dateAt(instant);
      if (current < previous || current - previous > 2) throw new ZonedDailyError('unrepresentable_boundary');
      if (previous < ordinal && current >= ordinal) bracket = [instant - QUARTER, instant];
      previous = current;
    }
    if (!bracket) throw new ZonedDailyError('unrepresentable_boundary');
    let [lo, hi] = bracket,
      steps = 0;
    while (hi - lo > 1) {
      if (++steps > 32) throw new ZonedDailyError('unrepresentable_boundary');
      const mid = Math.floor((lo + hi) / 2),
        observed = dateAt(mid);
      if (observed < dateAt(lo) || observed > dateAt(hi)) throw new ZonedDailyError('unrepresentable_boundary');
      if (observed < ordinal) lo = mid;
      else hi = mid;
    }
    const value = dateAt(hi) === ordinal ? hi : null;
    if (value !== null && (dateAt(value - 1) >= ordinal || value % QUARTER !== 0)) throw new ZonedDailyError('unrepresentable_boundary');
    boundaries.set(ordinal, value);
    return value;
  }
  const current = dateAt(requestedAtMs);
  // Two subsequent valid dates permit an elapsed read to cross midnight while
  // retaining its original source plan and separately derived next boundary.
  const starts: { ordinal: number; startMs: number }[] = [];
  for (let ordinal = current - 19; ordinal <= current + 3; ordinal++) {
    const startMs = first(ordinal);
    if (startMs !== null) starts.push({ ordinal, startMs });
  }
  for (let index = 1; index < starts.length; index++)
    if (starts[index]!.startMs <= starts[index - 1]!.startMs) throw new ZonedDailyError('unrepresentable_boundary');
  const build = (priorDates: 19 | 3, sourceInterval: '1h' | '15m', sourceSpanMs: number): DailyPlan | null => {
    const retained = starts.filter((entry) => entry.ordinal >= current - priorDates);
    const dateIntervals = retained
      .slice(0, -1)
      .map((entry, index) =>
        Object.freeze({ calendarDate: calendar(entry.ordinal), startMs: entry.startMs, endMs: retained[index + 1]!.startMs }),
      );
    const today = dateIntervals.find((entry) => entry.calendarDate === calendar(current));
    if (!today || retained.some((entry) => entry.startMs % sourceSpanMs !== 0)) return null;
    const sinceMs = retained[0]!.startMs;
    if (sinceMs < 0 || Math.floor((requestedAtMs + READ_TIMEOUT - sinceMs) / sourceSpanMs) + 1 >= 500) return null;
    return Object.freeze({
      zone,
      requestedAtMs,
      sinceMs,
      sourceInterval,
      sourceSpanMs,
      priorDates,
      limit: 500,
      dateIntervals: Object.freeze(dateIntervals),
      nextBoundaryMs: today.endMs,
    });
  };
  const plan = build(19, '1h', HOUR) ?? build(3, '15m', QUARTER);
  if (!plan) throw new ZonedDailyError('unrepresentable_boundary');
  issuedPlans.add(plan);
  return plan;
}

/** Every source row is validated before any result is returned. No source bar
 * is split, no gap is filled, and exact chronological open/close are retained. */
export function deriveZonedDaily(source: readonly OHLCV[], plan: DailyPlan, readAtMs: number): ZonedDailySnapshot {
  validClock(readAtMs);
  if (!issuedPlans.has(plan) || readAtMs < plan.requestedAtMs || readAtMs - plan.requestedAtMs > READ_TIMEOUT)
    throw new ZonedDailyError('invalid_clock_window');
  const today = plan.dateIntervals.find((entry) => entry.startMs <= readAtMs && readAtMs < entry.endMs);
  const possible = Math.floor((readAtMs - plan.sinceMs) / plan.sourceSpanMs) + 1;
  if (!today || possible >= plan.limit) throw new ZonedDailyError('invalid_clock_window');
  if (!Array.isArray(source) || source.length >= plan.limit || source.length > possible)
    throw new ZonedDailyError('invalid_source_history');
  const oldestOrdinal = Date.parse(today.calendarDate) / DATE - plan.priorDates;
  const rows: OHLCV[] = [];
  let previous = -1;
  for (const row of source) {
    try {
      if (!Array.isArray(row) || row.length !== 6) throw new Error();
      const [timestamp, open, high, low, close, volume] = row;
      if (
        !Number.isSafeInteger(timestamp) ||
        timestamp <= previous ||
        timestamp < plan.sinceMs ||
        timestamp > Math.floor(readAtMs / plan.sourceSpanMs) * plan.sourceSpanMs ||
        timestamp % plan.sourceSpanMs !== 0 ||
        [open, high, low, close, volume].some((value) => typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))
      )
        throw new Error();
      const o = parseAmount(open),
        h = parseAmount(high),
        l = parseAmount(low),
        c = parseAmount(close),
        v = parseAmount(volume);
      if (o <= 0n || h < o || h < c || l <= 0n || l > o || l > c || h < l || v < 0n) throw new Error();
      const day = plan.dateIntervals.find((entry) => entry.startMs <= timestamp && timestamp < entry.endMs);
      if (!day || timestamp + plan.sourceSpanMs > day.endMs) throw new Error();
      previous = timestamp;
      if (Date.parse(day.calendarDate) / DATE < oldestOrdinal) continue;
      const last = rows.at(-1);
      if (!last || last[0] !== day.startMs) rows.push([day.startMs, open, high, low, close, volume]);
      else {
        if (h > parseAmount(last[2])) last[2] = high;
        if (l < parseAmount(last[3])) last[3] = low;
        last[4] = close;
        last[5] = formatAmount(parseAmount(last[5]) + v);
      }
    } catch {
      throw new ZonedDailyError('invalid_source_history');
    }
  }
  for (const row of rows) Object.freeze(row);
  return Object.freeze({
    rows: Object.freeze(rows),
    plan,
    metadata: Object.freeze({
      zone: plan.zone,
      sourceInterval: plan.sourceInterval,
      priorDates: plan.priorDates,
      sinceMs: plan.sinceMs,
      requestedAtMs: plan.requestedAtMs,
      readAtMs,
      currentCalendarDate: today.calendarDate,
      nextBoundaryMs: today.endMs,
      partialCurrent: true,
      manualRefresh: true,
    }),
  });
}
