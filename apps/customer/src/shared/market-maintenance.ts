/**
 * A market's maintenance window as the `/markets` and lifecycle reads carry it (`upcomingMaintenance`,
 * J-cex-spot-14 #5). svc-notify's notice board is the one record; this only reads the field and says how far away it is.
 * A board the service could not read (`unavailable`) and no window (`none`) both show nothing: neither claims a time.
 */
import { z } from 'zod';

export const upcomingMaintenanceSchema = z
  .object({ status: z.string(), startsAt: z.string().nullish(), endsAt: z.string().nullish(), title: z.string().nullish() })
  .passthrough()
  .nullish();

export interface MaintenanceWindowSoon {
  readonly status: 'scheduled' | 'in_progress';
  /** Epoch ms, or null when the notice names no start. */
  readonly startsAt: number | null;
  /** Epoch ms, or null when the notice names no end: "End time not set". */
  readonly endsAt: number | null;
}

const instant = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

export function maintenanceOf(raw: z.infer<typeof upcomingMaintenanceSchema>): MaintenanceWindowSoon | null {
  if (!raw || (raw.status !== 'scheduled' && raw.status !== 'in_progress')) return null;
  return { status: raw.status, startsAt: instant(raw.startsAt), endsAt: instant(raw.endsAt) };
}

/** How far away a window's start is, rounded to whole hours from an hour on, else to whole minutes (at least 1). */
export type MaintenanceWhen = { kind: 'now' } | { kind: 'hours'; n: number } | { kind: 'minutes'; n: number };

export function maintenanceWhen(window: MaintenanceWindowSoon, nowMs: number): MaintenanceWhen {
  if (window.status === 'in_progress' || window.startsAt === null || window.startsAt <= nowMs) return { kind: 'now' };
  const minutes = Math.max(1, Math.round((window.startsAt - nowMs) / 60_000));
  return minutes >= 60 ? { kind: 'hours', n: Math.round(minutes / 60) } : { kind: 'minutes', n: minutes };
}
