import { AcademyError, type AcademyErrorCode } from '../errors.js';

/**
 * Service-side page cap for the customer and operator lists this slice adds.
 * Same ceiling `sql-list-limit.ts` already applies (Math.min(200, n)).
 * A caller must pass `limit`. A larger limit is cut to this cap so a read
 * cannot dump the table. It is not a product page size the owner published.
 */
export const ACADEMY_CUSTOMER_LIST_MAX = 200;

/**
 * One `touchLesson` call cannot claim more than one UTC day of reading.
 * This is a write bound, not a lesson duration. The spine does not publish
 * durations, and this constant does not invent one.
 */
export const TOUCH_LESSON_MAX_SECONDS = 86_400;

/**
 * Inclusive UTC day span `opsMetrics` will return. A wider range is refused
 * rather than silently shortened.
 */
export const OPS_METRICS_MAX_DAYS = 366;

export function assertCustomerListLimit(limit: number | null | undefined, code: AcademyErrorCode, label: string): number {
  if (limit === undefined || limit === null || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new AcademyError(`${label} list limit is unset — pass limit (never invent the whole table)`, code);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new AcademyError(`${label} list limit is unset — pass limit (never invent the whole table)`, code);
  }
  return Math.min(ACADEMY_CUSTOMER_LIST_MAX, n);
}

export function assertTouchSeconds(secondsRead: number | null | undefined): number {
  if (secondsRead === undefined || secondsRead === null) return 0;
  if (typeof secondsRead !== 'number' || !Number.isInteger(secondsRead) || secondsRead < 0 || secondsRead > TOUCH_LESSON_MAX_SECONDS) {
    throw new AcademyError(
      `secondsRead must be an integer from 0 to ${TOUCH_LESSON_MAX_SECONDS} (TOUCH_LESSON_MAX_SECONDS)`,
      'academy.seconds_out_of_range',
    );
  }
  return secondsRead;
}
