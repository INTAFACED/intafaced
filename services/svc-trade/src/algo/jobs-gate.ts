/**
 * TRD-0522 — a TWAP parent is a schedule. With the slice scheduler off, create
 * must refuse before an active row is stored. TRADE_ALGO_ENABLED is a different
 * switch and does not make this one true.
 */
import { TradeError, type TradeErrorCode } from '../spot/types.js';
import type { TwapParent } from './types.js';

export const ALGO_JOBS_DISABLED_CODE = 'trade.algo_jobs_disabled';
export const ALGO_JOBS_UNKNOWN_CODE = 'trade.algo_jobs_unknown';

/**
 * Same allowlist as `TRADE_ALGO_JOBS_ENABLED` in env.ts. Absent or blank is
 * off. Anything other than 1 / true / on / yes is off. A throw from the caller
 * means the flag could not be read.
 */
export function readTradeAlgoJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TRADE_ALGO_JOBS_ENABLED;
  if (raw === undefined || raw === '') return false;
  if (typeof raw !== 'string') {
    throw new Error('TRADE_ALGO_JOBS_ENABLED is unreadable');
  }
  return ['1', 'true', 'on', 'yes'].includes(raw.trim().toLowerCase());
}

export function isFreshAlgoCreate(parent: TwapParent): boolean {
  return (
    parent.status === 'active' &&
    parent.nextSliceIndex === 0 &&
    parent.children.length === 0 &&
    parent.misses.length === 0 &&
    parent.scheduleStretchReason == null
  );
}

/** Same schedule, not a second parent hiding under the same client algo id. */
export function sameAlgoSchedule(a: TwapParent, b: TwapParent): boolean {
  return (
    a.id === b.id &&
    a.userId === b.userId &&
    a.marketId === b.marketId &&
    a.side === b.side &&
    a.kind === b.kind &&
    a.totalQty === b.totalQty &&
    a.durationMs === b.durationMs &&
    a.sliceIntervalMs === b.sliceIntervalMs &&
    a.limitPrice === b.limitPrice &&
    (a.subAccountId ?? null) === (b.subAccountId ?? null)
  );
}

function jobsError(message: string, code: string): TradeError {
  return new TradeError(message, code as TradeErrorCode);
}

/**
 * Read the scheduler flag before the row exists. If the read throws after a
 * row was already stored, or the flag is off and a row is already active,
 * abandon that row so it is not left active.
 */
export async function admitFreshActiveAlgoParent(input: {
  readJobs: () => boolean;
  isActive: () => Promise<boolean>;
  persist: () => Promise<void>;
  abandon: () => Promise<void>;
}): Promise<void> {
  let enabled = false;
  try {
    enabled = input.readJobs();
  } catch {
    if (await input.isActive()) await input.abandon();
    throw jobsError('The slice scheduler flag could not be read. No active schedule was left stored.', ALGO_JOBS_UNKNOWN_CODE);
  }
  if (!enabled) {
    if (await input.isActive()) await input.abandon();
    throw jobsError('The slice scheduler is off. A schedule created now would sit active and place nothing.', ALGO_JOBS_DISABLED_CODE);
  }
  await input.persist();
}

/**
 * Decide a parent save. A brand-new active parent goes through the jobs gate.
 * A second fresh create with the same id and a different schedule is refused
 * and the first row is left as it was.
 */
export async function prepareAlgoParentWrite(input: {
  existing: { readonly parent: TwapParent } | null;
  record: { readonly parent: TwapParent };
  onlyIfMissing: boolean;
  readJobs: () => boolean;
  isActive: () => Promise<boolean>;
  persist: () => Promise<void>;
  abandon: () => Promise<void>;
}): Promise<'done' | 'write'> {
  if (input.existing && input.onlyIfMissing) return 'done';
  if (
    input.existing &&
    isFreshAlgoCreate(input.record.parent) &&
    isFreshAlgoCreate(input.existing.parent) &&
    !sameAlgoSchedule(input.existing.parent, input.record.parent)
  ) {
    throw new TradeError(`algo id ${input.record.parent.id} already exists`, 'trade.algo_duplicate_id');
  }
  if (!input.existing && input.record.parent.status === 'active') {
    await admitFreshActiveAlgoParent({
      readJobs: input.readJobs,
      isActive: input.isActive,
      persist: input.persist,
      abandon: input.abandon,
    });
    return 'done';
  }
  return 'write';
}
