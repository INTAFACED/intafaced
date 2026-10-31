import { SCALE, type Amount } from '@intafaced/ledger-client';
import type { VestingSchedule } from './launch-service.js';

/**
 * Linear vesting with a cliff (ENGINE LC-7, MC-launch-05): nothing before the start or the cliff, everything from the end,
 * and in between the elapsed part of start to end. The share is scaled like an amount (SCALE is 1), floored, and is read
 * at the service's clock, never at a time a client supplies.
 */
export type VestingPhase = 'before_start' | 'before_cliff' | 'vesting' | 'vested';

export function vestedShare(schedule: VestingSchedule, at: Date): { phase: VestingPhase; share: Amount } {
  const t = BigInt(at.getTime());
  const start = BigInt(schedule.startAt.getTime());
  const end = BigInt(schedule.endAt.getTime());
  if (t >= end) return { phase: 'vested', share: SCALE };
  if (t < start) return { phase: 'before_start', share: 0n };
  if (schedule.cliffAt !== null && t < BigInt(schedule.cliffAt.getTime())) return { phase: 'before_cliff', share: 0n };
  return { phase: 'vesting', share: ((t - start) * SCALE) / (end - start) };
}

/** The vested part of an allocation at a share from `vestedShare`, floored; what is not vested stays unreleased. */
export function vestedAmount(allocation: Amount, share: Amount): Amount {
  return (allocation * share) / SCALE;
}
