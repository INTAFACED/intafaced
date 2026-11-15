/**
 * trade.mm-bot — shipped occupancy of the seed kill-switch on `/health`.
 *
 * Reports whether jobs are armed (ops enabled AND named markets). Does not
 * start jobs, does not invent a market list, does not 503 `/health` when off.
 */
import { mmSeedJobsArmed } from './seed-honesty.js';

export type MmSeedHealthReason = 'jobs_off' | 'no_targets' | 'armed';

export type MmSeedHealth = {
  readonly enabled: boolean;
  readonly armed: boolean;
  readonly targetCount: number;
  readonly reason: MmSeedHealthReason;
  /**
   * The operator-written configuration (J-cex-spot-20 #5): read every tick when the tick interval is set, and then it
   * places from approved rows with the environment off. `armed` above is the environment's bootstrap only.
   */
  readonly operatorConfig?: 'read_each_tick' | 'off';
};

export function presentMmSeedHealth(input: {
  readonly enabled: boolean;
  readonly targetCount: number;
  /** Whether the seed tick runs at all (TRADE_MM_SEED_INTERVAL_MS set): the operator rows are read only then. */
  readonly operatorTick?: boolean;
}): MmSeedHealth {
  const targetCount = Number.isFinite(input.targetCount) && input.targetCount > 0 ? Math.floor(input.targetCount) : 0;
  const armed = mmSeedJobsArmed(input.enabled, targetCount);
  let reason: MmSeedHealthReason = 'jobs_off';
  if (input.enabled === true) reason = targetCount > 0 ? 'armed' : 'no_targets';
  return {
    enabled: input.enabled === true,
    armed,
    targetCount,
    reason,
    ...(input.operatorTick === undefined ? {} : { operatorConfig: input.operatorTick ? ('read_each_tick' as const) : ('off' as const) }),
  };
}
