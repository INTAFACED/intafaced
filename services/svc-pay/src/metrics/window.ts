import type { PayMetricWindow } from '@intafaced/contracts';
import { MetricsError } from './errors.js';

/** Half-open range of UTC calendar days: `from` inclusive, `to` exclusive, both `YYYY-MM-DD`. */
export interface DayRange {
  readonly from: string;
  readonly to: string;
}

const DAY_MS = 86_400_000;
/** One year plus a leap day. An unbounded range is an unbounded scan of every merchant-day. */
export const MAX_WINDOW_DAYS = 366;

export const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const parseDay = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
export const addDays = (day: string, n: number): string => dayOf(new Date(parseDay(day) + n * DAY_MS));
export const daysBetween = (from: string, to: string): number => Math.round((parseDay(to) - parseDay(from)) / DAY_MS);

/**
 * Presets are counted in UTC day buckets, ending with today: `today` is today's
 * bucket, `rolling_7d` the last 7 buckets and `rolling_30d` the last 30. The
 * read model stores one bucket per UTC day, so it cannot answer "the last 168
 * hours"; a window it cannot answer exactly is refused, not approximated.
 */
export function resolveWindow(window: PayMetricWindow, now: Date): DayRange {
  if (window.kind === 'preset') {
    const today = dayOf(now);
    const back = window.preset === 'today' ? 0 : window.preset === 'rolling_7d' ? 6 : 29;
    return { from: addDays(today, -back), to: addDays(today, 1) };
  }
  return resolveRange(window.from, window.to);
}

/** An explicit range must start and end exactly on a UTC midnight, so it maps onto whole buckets. */
export function resolveRange(from: string, to: string): DayRange {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new MetricsError('pay.metrics_window_invalid');
  if (a % DAY_MS !== 0 || b % DAY_MS !== 0) throw new MetricsError('pay.metrics_window_unaligned');
  if (b <= a) throw new MetricsError('pay.metrics_window_invalid');
  if ((b - a) / DAY_MS > MAX_WINDOW_DAYS) throw new MetricsError('pay.metrics_window_too_wide');
  return { from: dayOf(new Date(a)), to: dayOf(new Date(b)) };
}
