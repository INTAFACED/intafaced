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
  /** Dead-man switch tick, much shorter than the recovery sweeps because a deadline is a promise. */
  cancelAllAfterIntervalMs?: number;
}

export interface HoldUnknownSweepJobsDeps {
  trade: {
    sweepHoldUnknown(limit?: number): Promise<HoldUnknownSweepResult>;
    /** Resting bracket entries: place exits for filled ones, cancel entries before their grant lapses. */
    sweepBracketExits?(graceMs: number, limit?: number): Promise<{ unavailable: number; failed: number }>;
    /** Countdowns past their deadline: cancel every open order of the user who armed them. */
    sweepCancelAllAfter?(): Promise<{ unavailable: number; failed: number }>;
  };
  config: HoldUnknownSweepJobsConfig;
  onError?: (name: string, err: unknown) => void;
  onResult?: (result: HoldUnknownSweepResult) => void;
  onBracketAlert?: (result: { unavailable: number; failed: number }) => void;
  onCancelAllAfterAlert?: (result: { unavailable: number; failed: number }) => void;
}

export interface HoldUnknownSweepJobsHandle {
  host: JobHost;
  stop(): void;
}

/** Assemble the hold-unknown sweep. Disabled → stopped host, no intervals. */
export function startHoldUnknownSweepJobs(deps: HoldUnknownSweepJobsDeps): HoldUnknownSweepJobsHandle {
  const host = createJobHost({ onError: deps.onError });

  // The dead-man switch is not part of the recovery sweeps: their kill switch must never leave an armed countdown
  // that nothing will fire.
  if (deps.trade.sweepCancelAllAfter) {
    const sweepCaa = deps.trade.sweepCancelAllAfter.bind(deps.trade);
    host.every('trade.cancel_all_after_sweep', deps.config.cancelAllAfterIntervalMs ?? deps.config.intervalMs, async () => {
      const result = await sweepCaa();
      if (result.unavailable > 0 || result.failed > 0) deps.onCancelAllAfterAlert?.(result);
    });
  }

  if (!deps.config.enabled) {
    return { host, stop: () => host.stopAll() };
  }

  host.every('trade.hold_unknown_sweep', deps.config.intervalMs, async () => {
    const result = await deps.trade.sweepHoldUnknown();
    deps.onResult?.(result);
  });

  if (deps.trade.sweepBracketExits) {
    const sweep = deps.trade.sweepBracketExits.bind(deps.trade);
    // Cancel a resting entry two ticks before its grant lapses, so one missed tick cannot strand a fill.
    host.every('trade.bracket_exit_sweep', deps.config.intervalMs, async () => {
      const result = await sweep(deps.config.intervalMs * 2);
      if (result.unavailable > 0 || result.failed > 0) deps.onBracketAlert?.(result);
    });
  }

  return { host, stop: () => host.stopAll() };
}
