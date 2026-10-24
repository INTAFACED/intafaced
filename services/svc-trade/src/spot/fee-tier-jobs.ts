/**
 * The daily fee tier snapshot (fee-tiers.ts). Default OFF: with no interval nothing runs, and the tier page says no
 * snapshot is running. Each tick asks whether the schedule in force has a snapshot instant at or before now that has
 * no finished run, and writes that one snapshot. A missed day is not back-filled: the next tick writes the latest
 * instant only, and tiers stay at the last snapshot until then.
 */
import type { Sql } from 'postgres';
import { createJobHost, type JobHost } from '../futures/job-host.js';
import type { OwnerFeeSchedule } from './fee-schedule.js';
import { programmeSince, runTierSnapshot } from './fee-tier-store.js';
import { lastSnapshotInstant } from './fee-tiers.js';

export interface FeeTierJobsDeps {
  sql: Sql;
  /** The schedule in force at a moment (the stored versions, else the boot value). */
  scheduleAt(at: Date): Promise<OwnerFeeSchedule>;
  /** The boot schedule (TRADE_FEE_SCHEDULE), in force before every stored version. */
  bootSchedule: OwnerFeeSchedule;
  /** Tick interval in ms, owner/ops-set. Null: the job is not scheduled. */
  intervalMs: number | null;
  now?: () => Date;
  onError?: (name: string, err: unknown) => void;
  onResult?: (result: FeeTierTickResult) => void;
}

export type FeeTierTickResult =
  | { readonly outcome: 'no_programme' | 'no_snapshot_time' | 'not_due' }
  | { readonly outcome: 'written' | 'already_written'; readonly instant: string; readonly accounts: number };

export interface FeeTierJobsHandle {
  host: JobHost;
  tick(): Promise<FeeTierTickResult>;
  stop(): void;
}

export function startFeeTierJobs(deps: FeeTierJobsDeps): FeeTierJobsHandle {
  const host = createJobHost({ onError: deps.onError });
  const now = deps.now ?? (() => new Date());

  async function tick(): Promise<FeeTierTickResult> {
    const at = now();
    const schedule = await deps.scheduleAt(at);
    const program = schedule.published === true ? schedule.tierProgram : null;
    if (!program || schedule.published !== true) return { outcome: 'no_programme' };
    if (program.snapshotTimeUtc === null) return { outcome: 'no_snapshot_time' };
    // The programme has been in force since `since` without a break: an instant at or after it was under a programme. A
    // restart or a rates-only version after the snapshot time does not move it, so it never skips that day's snapshot.
    const since = await programmeSince(deps.sql, deps.bootSchedule, at);
    const instant = lastSnapshotInstant(program, since, at);
    if (!instant) return { outcome: 'not_due' };
    const run = await runTierSnapshot(deps.sql, program, schedule.version, instant);
    return { outcome: run.written ? 'written' : 'already_written', instant: instant.toISOString(), accounts: run.accounts };
  }

  if (deps.intervalMs !== null && Number.isInteger(deps.intervalMs) && deps.intervalMs > 0) {
    host.every('spot.fee_tier_snapshot', deps.intervalMs, async () => {
      deps.onResult?.(await tick());
    });
  }
  return { host, tick, stop: () => host.stopAll() };
}
