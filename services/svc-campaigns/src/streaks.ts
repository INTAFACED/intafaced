/**
 * Streak steps (CM-tasks-quests-01, J-campaigns-02 #8): a step done on consecutive calendar days in the platform time
 * zone. A day counts when it holds at least one matching event. A day with none breaks the run: the streak reads 0 from
 * the zone's midnight that ends the first missed day. Once a run reaches the target the step stays done.
 */

const DAY_MS = 86_400_000;

/** The calendar day (`YYYY-MM-DD`) an instant falls on in the zone. */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;
const dayOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** The instant the zone's calendar day starts (its midnight), offsets and daylight saving included. */
export function zoneMidnight(day: string, timeZone: string): Date {
  const wall = dayNumber(day) * DAY_MS;
  let guess = wall;
  // Two passes settle the offset, also across a daylight-saving change.
  for (let i = 0; i < 2; i += 1) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, p.value]),
    );
    const seen = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
    guess += wall - seen;
  }
  return new Date(guess);
}

export interface Streak {
  /** Consecutive days ending today or yesterday; 0 once a day was missed. */
  days: number;
  /** The longest run so far. */
  best: number;
  lastDay: string | null;
  /** While a run is alive: when it resets unless another day is done. */
  resetsAt: Date | null;
}

export function streakOf(times: readonly Date[], timeZone: string, now: Date): Streak {
  const days = [...new Set(times.map((t) => dayNumber(localDay(t, timeZone))))].sort((a, b) => a - b);
  if (days.length === 0) return { days: 0, best: 0, lastDay: null, resetsAt: null };
  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i += 1) {
    run = days[i]! === days[i - 1]! + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  const last = days[days.length - 1]!;
  const today = dayNumber(localDay(now, timeZone));
  const alive = last >= today - 1;
  return {
    days: alive ? run : 0,
    best,
    lastDay: dayOf(last),
    resetsAt: alive ? zoneMidnight(dayOf(last + 2), timeZone) : null,
  };
}
