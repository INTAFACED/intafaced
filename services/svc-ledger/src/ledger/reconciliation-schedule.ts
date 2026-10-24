/**
 * UTC schedule boundaries for operator reconciliation controls.
 * Weeks are ISO (Monday starts the week). Months are calendar months.
 * A margin is a decimal number of seconds. Blank is unset. Typed `0` is zero.
 */

import { SCALE, parseAmount } from '@intafaced/ledger-client';
import type { ReconciliationSchedule } from '@intafaced/contracts/ledger-reconciliation';
import { OPS_CONTROL_MARGIN_UNSET, LEDGER_RECONCILE_ASOF_INVALID } from '@intafaced/contracts/ledger-reconciliation';
import { ReconciliationControlError } from './reconciliation-control-error.js';

export type ReconciliationPeriod = 'hour' | 'day' | 'iso_week' | 'month';

/** A margin is a decimal number of seconds; one millisecond is a thousandth of the ledger scale. */
const MS_DIVISOR = SCALE / 1000n;
const MAX_MARGIN_SECONDS = 366n * 24n * 60n * 60n;

export function periodForSchedule(schedule: ReconciliationSchedule): ReconciliationPeriod {
  switch (schedule.cadence) {
    case 'hourly':
      return 'hour';
    case 'daily':
      return 'day';
    case 'weekly':
      return 'iso_week';
    case 'monthly':
      return 'month';
  }
}

/** Monday 00:00 UTC of the ISO week that contains `at`. */
export function utcIsoWeekStart(at: Date): Date {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const weekday = start.getUTCDay() === 0 ? 7 : start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - (weekday - 1));
  return start;
}

export function periodBounds(period: ReconciliationPeriod, at: Date): { start: Date; end: Date } {
  if (period === 'hour') {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours()));
    return { start, end: new Date(start.getTime() + 3_600_000) };
  }
  if (period === 'day') {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    return { start, end: new Date(start.getTime() + 86_400_000) };
  }
  if (period === 'iso_week') {
    const start = utcIsoWeekStart(at);
    return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
  }
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * The instant inside `periodStart`'s bucket when the control is due.
 * Null when a monthly day does not exist in that month (31 February). That is
 * not a run and not a zero.
 */
export function dueInstant(schedule: ReconciliationSchedule, periodStart: Date): Date | null {
  const minute = schedule.minute;
  if (schedule.cadence === 'hourly') {
    return new Date(periodStart.getTime() + minute * 60_000);
  }
  const hour = schedule.hour;
  if (schedule.cadence === 'daily') {
    return new Date(periodStart.getTime() + hour * 3_600_000 + minute * 60_000);
  }
  if (schedule.cadence === 'weekly') {
    return new Date(periodStart.getTime() + (schedule.isoWeekday - 1) * 86_400_000 + hour * 3_600_000 + minute * 60_000);
  }
  const year = periodStart.getUTCFullYear();
  const month = periodStart.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (schedule.day > lastDay) return null;
  return new Date(Date.UTC(year, month, schedule.day, hour, minute, 0, 0));
}

/** Milliseconds to subtract. Truncates below one millisecond. Refuses a blank or a non-number. */
export function marginMillis(margin: string | undefined): bigint {
  if (margin === undefined || margin.trim() === '') {
    throw new ReconciliationControlError(OPS_CONTROL_MARGIN_UNSET);
  }
  let scaled: bigint;
  try {
    scaled = parseAmount(margin.trim());
  } catch {
    throw new ReconciliationControlError(OPS_CONTROL_MARGIN_UNSET);
  }
  if (scaled < 0n) throw new ReconciliationControlError(OPS_CONTROL_MARGIN_UNSET);
  const seconds = scaled / SCALE;
  if (seconds > MAX_MARGIN_SECONDS) throw new ReconciliationControlError(OPS_CONTROL_MARGIN_UNSET);
  return scaled / MS_DIVISOR;
}

export function readInstant(asOf: Date, margin: string): Date {
  const ms = marginMillis(margin);
  return new Date(asOf.getTime() - Number(ms));
}

export function assertNotFuture(asOf: Date, now: Date): void {
  if (asOf.getTime() > now.getTime()) {
    throw new ReconciliationControlError(LEDGER_RECONCILE_ASOF_INVALID);
  }
}
