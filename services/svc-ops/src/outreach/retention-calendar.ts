import { OutreachError } from './config.js';

/** Published outreach policy: six calendar months in UTC, with month-end clamp. */
export function outreachInactivityDeadline(lastMeaningfulAt: Date): Date {
  if (!Number.isFinite(lastMeaningfulAt.getTime())) throw new OutreachError('ops.crm.retention_clock_invalid');
  const deadline = new Date(lastMeaningfulAt);
  const day = deadline.getUTCDate();
  deadline.setUTCDate(1);
  deadline.setUTCMonth(deadline.getUTCMonth() + 6);
  const monthEnd = new Date(deadline);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  deadline.setUTCDate(Math.min(day, monthEnd.getUTCDate()));
  if (!Number.isFinite(deadline.getTime())) throw new OutreachError('ops.crm.retention_clock_invalid');
  return deadline;
}
