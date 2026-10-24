/**
 * Streak steps (CM-tasks-quests-01, J-campaigns-02 #8): a step done on consecutive calendar days in the platform time
 * zone. A day counts when it holds at least one matching event. A day with none breaks the run: the streak reads 0 from
 * the zone's midnight that ends the first missed day. Once a run reaches the target the step stays done.
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const formats = new Map<string, Intl.DateTimeFormat>();
const formatFor = (timeZone: string) => {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
    formats.set(timeZone, f);
  }
  return f;
};

/** The zone's calendar day of an instant, as a day number (days since 1970-01-01), read from parts, never a locale's layout. */
function dayNumberAt(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    formatFor(timeZone)
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / DAY_MS;
}

const dayOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;

/** The calendar day (`YYYY-MM-DD`) an instant falls on in the zone. */
export function localDay(at: Date, timeZone: string): string {
  return dayOf(dayNumberAt(at, timeZone));
}

/**
 * The first instant of the zone's calendar day, to the minute. Searched rather than computed from an offset, so a day
 * that starts at 01:00 because daylight saving begins at midnight still starts where the zone says.
 */
export function zoneMidnight(day: string, timeZone: string): Date {
  const target = dayNumber(day);
  // Every zone's offset is within 14 hours of UTC.
  let lo = target * DAY_MS - 15 * 3_600_000;
  let hi = target * DAY_MS + 15 * 3_600_000;
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
    if (dayNumberAt(new Date(mid), timeZone) >= target) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

export interface Streak {
  /** Consecutive days ending today or yesterday; 0 once a day was missed. */
  days: number;
  /** The longest run so far. */
  best: number;
  /** The run that ends on the last day done: the one a missed day broke, or the one still alive. */
  lastRun: number;
  lastDay: string | null;
  /** While a run is alive: when it resets unless the next day is done. */
  resetsAt: Date | null;
}

export const NO_STREAK: Streak = { days: 0, best: 0, lastRun: 0, lastDay: null, resetsAt: null };

export function streakOf(times: readonly Date[], timeZone: string, now: Date): Streak {
  const days = [...new Set(times.map((t) => dayNumberAt(t, timeZone)))].sort((a, b) => a - b);
  if (days.length === 0) return NO_STREAK;
  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i += 1) {
    run = days[i]! === days[i - 1]! + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  const last = days[days.length - 1]!;
  const alive = last >= dayNumberAt(now, timeZone) - 1;
  return {
    days: alive ? run : 0,
    best,
    lastRun: run,
    lastDay: dayOf(last),
    resetsAt: alive ? zoneMidnight(dayOf(last + 2), timeZone) : null,
  };
}
