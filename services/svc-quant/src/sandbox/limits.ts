import { QUANT_QUOTA_PROFILE_UNSET, QUANT_SANDBOX_LIMIT_UNSET, QuantError } from '../errors.js';
import { SANDBOX_LIMIT_NAMES, SANDBOX_LIMITS, type AppliedProfile, type SandboxLimit, type SandboxLimitRow } from '../quota/quota.js';

/**
 * The sandbox limits one run meets (AL-limits-02, J-algo-dev-12), from the plan that applies to the account. The
 * sandbox enforces each from outside the strategy: the strategy never reads or changes them.
 */
export interface RunLimits {
  /** Wall-clock time the run may take, in milliseconds. */
  readonly wallClockMs: number;
  /** Bytes of text the run's values may hold, two bytes per character. */
  readonly memoryBytes: number;
  /** Bytes of log output the run may write, UTF-8. */
  readonly outputBytes: number;
}

/** No run starts with a limit unset: the first blank one, in list order, is named before anything runs. */
export function requireRunLimits(profile: AppliedProfile | null, rows: readonly SandboxLimitRow[]): RunLimits {
  if (!profile) throw new QuantError(QUANT_QUOTA_PROFILE_UNSET, 'no quota profile applies to this account: the default profile is not set');
  const value = (limit: SandboxLimit): number => {
    const stored = rows.find((row) => row.limit === limit)?.value ?? null;
    if (stored === null) {
      throw new QuantError(QUANT_SANDBOX_LIMIT_UNSET, `${limit}: the limit for ${SANDBOX_LIMIT_NAMES[limit]} is not set, so no run starts`);
    }
    // A stored limit is at most 18 digits; past the largest safe number it bounds nothing more than that number does.
    return stored > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(stored);
  };
  const [wallClockMs, memoryBytes, outputBytes] = SANDBOX_LIMITS.map(value) as [number, number, number];
  return { wallClockMs, memoryBytes, outputBytes };
}
