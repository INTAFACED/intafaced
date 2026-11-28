// The one way a journey reads time. A journey compares only a period that has closed: a one-minute candle whose minute
// has ended, a UTC day by its start. Every minute or day boundary is worked here, never by hand in a journey
// (garden/no-hand-clock refuses one, and a candle read with a clock value before `closedMinute`).

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const ms = (at) => (at instanceof Date ? at.getTime() : at);

/** The start of the UTC minute `at` (ms or Date) falls in, in ms. */
export const minuteStart = (at) => Math.floor(ms(at) / MINUTE) * MINUTE;

/** The start of the UTC hour `at` (ms or Date) falls in, in ms. */
export const hourStart = (at) => Math.floor(ms(at) / HOUR) * HOUR;

/** The start of the UTC day `at` (ms or Date) falls in, in ms. */
export const dayStart = (at) => Math.floor(ms(at) / DAY) * DAY;

/** The UTC day `at` (ms or Date) falls in, as `YYYY-MM-DD` (a date input's value, a period's key). */
export const utcDay = (at) => new Date(ms(at)).toISOString().slice(0, 10);

/** The UTC minute `at` (ms or Date) falls in, as `YYYY-MM-DDTHH:MM` (a datetime-local input's value). */
export const utcMinuteOf = (at) => new Date(minuteStart(at)).toISOString().slice(0, 16);

/** A "date and time" field's value for `at` in this machine's own time zone, to the minute, as a person types it. */
export function localMinuteField(at) {
  const d = new Date(ms(at));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Time for a fill stamped in a minute's last moment to be stored and counted in its candle. */
const SETTLE = 5_000;

/**
 * Waits until the minute `at` falls in has closed and its fills are in, and returns that minute's start. An open candle's
 * close moves with every trade, so the screen's read of it and a hand count's read a moment later need not agree; once
 * the minute has closed, both read the same final close (J-portfolio-04 #3, J-portfolio-05 #1).
 */
export async function closedMinute(page, at) {
  const start = minuteStart(at);
  const left = start + MINUTE + SETTLE - Date.now();
  // oxlint-disable-next-line garden/no-wait-for-timeout -- a minute closing has no event to await: the wall clock is the event
  if (left > 0) await page.waitForTimeout(left);
  return start;
}

/** Time for the stack to be in the new UTC day once the old one has ended. */
const DAY_SETTLE = 5_000;

/**
 * How long to wait so that the next `need` ms all fall in one UTC day: 0 when the day `at` falls in has at least `need`
 * left, else until the next day has begun. A step whose alerts are one per UTC day (a daily control's period) and that
 * expects a repeat run to land on the same alert waits this out first, or a run either side of midnight opens a second
 * alert for the new day (J-ops-console-07 #10 on main, run 46083906028: #9 at 23:58:37Z, its repeat after 00:00Z).
 */
export function dayTurnWait(at, need) {
  const left = dayStart(at) + DAY - ms(at);
  return left >= need ? 0 : left + DAY_SETTLE;
}

/**
 * Waits `dayTurnWait(Date.now(), need)` on `page`, so the next `need` ms fall in one UTC day; returns the ms waited. Raise
 * the step's timeout by `dayTurnWait` first, and take the founder sessions again after it (the pool renews an aged one).
 * A UTC day ending has no event to await: the wall clock is the event, as for `closedMinute`.
 */
export async function clearOfDayTurn(page, need) {
  const wait = dayTurnWait(Date.now(), need);
  if (wait > 0) await page.waitForTimeout(wait);
  return wait;
}
