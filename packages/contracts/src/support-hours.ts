/**
 * Support business hours contract (SP-sla-02): the owner-set time zone, weekly open intervals, holidays and the
 * out-of-hours reply, and the operator call that sets them.
 *
 * Browser safe: nothing here imports Node. Everything is blank until the owner sets it: no zone, no hours, no holidays
 * and no reply text are built in. A desk with no hours set never claims to be open or closed; asking refuses
 * `support.hours_unset`.
 *
 * Rules carried by the shapes below:
 * - Times are wall-clock `HH:MM` in the desk's own IANA time zone, so a daylight-saving day follows the zone.
 * - An interval opens strictly before it closes on the same day, or says `closesNextDay` to run past midnight.
 *   Anything else, or two intervals that overlap, is `support.hours_interval_invalid`.
 * - A zone the runtime does not know is `support.timezone_unknown`.
 * - A holiday is a local calendar date on which the desk is closed all day.
 */
import { z } from 'zod';

export const SUPPORT_HOURS_ERROR_CODES = [
  'support.hours_unset',
  'support.hours_interval_invalid',
  'support.timezone_unknown',
  'support.hours_revision_stale',
] as const;
export type SupportHoursErrorCode = (typeof SUPPORT_HOURS_ERROR_CODES)[number];

/** ISO weekday order, Monday first. */
export const SUPPORT_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type SupportWeekday = (typeof SUPPORT_WEEKDAYS)[number];

export const SUPPORT_HOURS_INTERVALS_MAX = 50;
export const SUPPORT_HOURS_HOLIDAYS_MAX = 400;
export const SUPPORT_HOURS_REPLY_MAX = 2000;
export const SUPPORT_HOURS_REASON_MAX = 500;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Minutes after local midnight for an `HH:MM` the schema already accepted. */
export function supportHoursMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** True when the runtime knows this IANA zone. */
export function supportTimeZoneKnown(zone: string): boolean {
  if (zone.trim() === '' || zone !== zone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const supportHoursIntervalSchema = z
  .object({
    day: z.enum(SUPPORT_WEEKDAYS),
    open: z.string().regex(HHMM),
    close: z.string().regex(HHMM),
    /** The interval runs past midnight and closes at `close` on the next day. */
    closesNextDay: z.boolean().default(false),
  })
  .strict();
export type SupportHoursInterval = z.infer<typeof supportHoursIntervalSchema>;

/** Each interval as [start, end) minutes on a Monday-00:00 week, split where it wraps past Sunday midnight. */
function weekSpans(interval: SupportHoursInterval): [number, number][] {
  const WEEK = 7 * 1440;
  const start = SUPPORT_WEEKDAYS.indexOf(interval.day) * 1440 + supportHoursMinutes(interval.open);
  const end = start - supportHoursMinutes(interval.open) + supportHoursMinutes(interval.close) + (interval.closesNextDay ? 1440 : 0);
  return end <= WEEK
    ? [[start, end]]
    : [
        [start, WEEK],
        [0, end - WEEK],
      ];
}

/** Why a set of intervals cannot be stored, or `null`. */
export function supportHoursIntervalsProblem(intervals: readonly SupportHoursInterval[]): string | null {
  const spans: [number, number][] = [];
  for (const interval of intervals) {
    const open = supportHoursMinutes(interval.open);
    const close = supportHoursMinutes(interval.close);
    // Same day: open strictly before close. Past midnight: it must not reach its own opening time again (<= 24 h).
    if (!interval.closesNextDay && open >= close) return 'open_not_before_close';
    if (interval.closesNextDay && close > open) return 'longer_than_a_day';
    if (interval.closesNextDay && close === open) return 'longer_than_a_day';
    spans.push(...weekSpans(interval));
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i]![0] < spans[i - 1]![1]) return 'overlap';
  }
  return null;
}

const timeZone = z.string().refine(supportTimeZoneKnown, { message: 'support.timezone_unknown' });

const holidays = z
  .array(z.string().regex(DATE))
  .max(SUPPORT_HOURS_HOLIDAYS_MAX)
  .refine((list) => new Set(list).size === list.length, { message: 'support.hours_interval_invalid' });

const intervals = z
  .array(supportHoursIntervalSchema)
  .max(SUPPORT_HOURS_INTERVALS_MAX)
  .refine((list) => supportHoursIntervalsProblem(list) === null, { message: 'support.hours_interval_invalid' });

/** What anyone may read. All blank (`timeZone: null`, no intervals) and revision 0 until the owner sets it. */
export const supportHoursSchema = z
  .object({
    timeZone: z.string().min(1).nullable(),
    intervals: z.array(supportHoursIntervalSchema),
    holidays: z.array(z.string().regex(DATE)),
    outOfHoursReply: z.string().min(1).nullable(),
    revision: z.number().int().min(0),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type SupportHours = z.infer<typeof supportHoursSchema>;

/**
 * Replace the hours. `timeZone: null` clears the hours (the desk reads unset again). `outOfHoursReply: null` sends no
 * reply. `expectedRevision` is the revision the operator read.
 */
export const supportHoursSetInputSchema = z
  .object({
    timeZone: timeZone.nullable(),
    intervals,
    holidays,
    outOfHoursReply: z.string().trim().min(1).max(SUPPORT_HOURS_REPLY_MAX).nullable(),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    reason: z.string().trim().min(1).max(SUPPORT_HOURS_REASON_MAX),
  })
  .strict()
  .refine((input) => input.timeZone !== null || input.intervals.length === 0, { message: 'support.hours_unset' });
export type SupportHoursSetInput = z.infer<typeof supportHoursSetInputSchema>;

/** The key a change is logged under; the revision it moves from makes a lost reply a replay. */
export function supportHoursSetKey(expectedRevision: number): string {
  return `support.hours:r${expectedRevision}`;
}
