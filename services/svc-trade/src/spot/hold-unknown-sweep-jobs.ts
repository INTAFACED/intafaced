/**
 * Recovery sweep for orders left in `hold_unknown`.
 *
 * Default ON. A lost `order.hold` reply keeps the row; this pass reads the
 * order's idempotency key and either submits (hold booked) or deletes the
 * unfunded intent (hold absent). A read that itself fails leaves the row and
 * alerts. It does not release a hold it has not seen.
 */
import { createJobHost, type JobHost } from '../futures/job-host.js';
import type { HoldUnknownSweepResult } from './hold-outcome.js';

export interface HoldUnknownSweepJobsConfig {
  /** Master kill. False = host created, no intervals. */
  enabled: boolean;
  /** Tick interval when enabled. */
  intervalMs: number;
}

export interface HoldUnknownSweepJobsDeps {
  trade: {
    sweepHoldUnknown(limit?: number): Promise<HoldUnknownSweepResult>;
  };
  config: HoldUnknownSweepJobsConfig;
  onError?: (name: string, err: unknown) => void;
  onResult?: (result: HoldUnknownSweepResult) => void;
}

export interface HoldUnknownSweepJobsHandle {
  host: JobHost;
  stop(): void;
}

/** Assemble the hold-unknown sweep. Disabled → stopped host, no intervals. */
export function startHoldUnknownSweepJobs(deps: HoldUnknownSweepJobsDeps): HoldUnknownSweepJobsHandle {
  const host = createJobHost({ onError: deps.onError });

  if (!deps.config.enabled) {
    return { host, stop: () => host.stopAll() };
  }

  host.every('trade.hold_unknown_sweep', deps.config.intervalMs, async () => {
    const result = await deps.trade.sweepHoldUnknown();
    deps.onResult?.(result);
  });

  return { host, stop: () => host.stopAll() };
}
