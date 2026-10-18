import { hostname } from 'node:os';
import type { Sql } from 'postgres';

/**
 * Scheduler honesty (TRD-0067).
 *
 * `running` is true only when the jobs flag is on AND the newest heartbeat
 * is no older than HEARTBEAT_FRESH_INTERVALS times the loop's own
 * `intervalMs`. The factor is an operational bound for "the loop is alive",
 * not a commercial timeout and not a product SLA.
 *
 * Flag off → false, `jobs_disabled` (the shipped default).
 * No row yet → null, `heartbeat_unknown`.
 * Older than three intervals → false, `heartbeat_stale`.
 * Jobs on but `intervalMs` blank → null, `jobs_interval_unset`.
 * The read path only SELECTs. It never inserts.
 */

/** Operational bound. Not a commercial value. */
export const HEARTBEAT_FRESH_INTERVALS = 3;

export const SCHEDULER_REASONS = ['jobs_disabled', 'heartbeat_unknown', 'heartbeat_stale', 'jobs_interval_unset'] as const;

export type SchedulerReason = (typeof SCHEDULER_REASONS)[number];

export interface AlgoSchedulerView {
  readonly running: boolean | null;
  readonly reason: SchedulerReason | null;
}

export function schedulerInstanceId(): string {
  return `${hostname()}:${process.pid}`;
}

export function readSchedulerState(input: {
  readonly jobsEnabled: boolean;
  readonly intervalMs: number | null;
  readonly newestTickAt: Date | null;
  readonly now: Date;
}): AlgoSchedulerView {
  if (!input.jobsEnabled) return { running: false, reason: 'jobs_disabled' };
  if (input.intervalMs == null || !Number.isInteger(input.intervalMs) || input.intervalMs < 1) {
    return { running: null, reason: 'jobs_interval_unset' };
  }
  if (input.newestTickAt == null) return { running: null, reason: 'heartbeat_unknown' };
  const ageMs = input.now.getTime() - input.newestTickAt.getTime();
  if (ageMs > HEARTBEAT_FRESH_INTERVALS * input.intervalMs) return { running: false, reason: 'heartbeat_stale' };
  return { running: true, reason: null };
}

/** Tick write. One row per instance. A second tick updates the same row. */
export async function recordSchedulerHeartbeat(sql: Sql, instanceId: string, at: Date): Promise<void> {
  await sql`
    INSERT INTO algo_scheduler_heartbeat (instance_id, last_tick_at)
    VALUES (${instanceId}, ${at})
    ON CONFLICT (instance_id) DO UPDATE SET last_tick_at = EXCLUDED.last_tick_at
  `;
  // A restart changes the pid. Drop this host's earlier-pid rows so they do
  // not pile up (the host prefix is everything before the final colon).
  const host = instanceId.slice(0, instanceId.lastIndexOf(':') + 1);
  if (host !== '') {
    await sql`
      DELETE FROM algo_scheduler_heartbeat
      WHERE instance_id <> ${instanceId} AND left(instance_id, ${host.length}) = ${host}
    `;
  }
}

/** Read. Does not insert. */
export async function newestSchedulerHeartbeat(sql: Sql): Promise<Date | null> {
  const rows = await sql<Array<{ at: Date | null }>>`
    SELECT MAX(last_tick_at) AS at FROM algo_scheduler_heartbeat
  `;
  const at = rows[0]?.at ?? null;
  return at == null ? null : new Date(at);
}
