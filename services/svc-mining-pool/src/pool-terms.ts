/**
 * Pool terms published by the operator.
 *
 * Blank, non-integer, negative, or out-of-range values are null plus a typed
 * reason. Nothing here substitutes a default, and nothing here rewrites a
 * window that already stored its own fee.
 */

export const FEE_UNCONFIGURED = 'fee_unconfigured' as const;
export const WINDOW_SIZE_UNCONFIGURED = 'window_size_unconfigured' as const;

export type PoolTerms = {
  readonly feeBps: number | null;
  readonly feeReason: typeof FEE_UNCONFIGURED | null;
  readonly windowSize: number | null;
  readonly windowSizeReason: typeof WINDOW_SIZE_UNCONFIGURED | null;
};

function integerConfig(raw: string | undefined, allowZero: boolean): number | null {
  const trimmed = raw?.trim() ?? '';
  if (!/^(0|[1-9]\d{0,14})$/.test(trimmed)) return null;
  if (!allowZero && trimmed === '0') return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

/** Same bounds as `planPplns`: 0 inclusive, 10000 exclusive. */
export function readFeeBps(raw: string | undefined): { feeBps: number | null; feeReason: typeof FEE_UNCONFIGURED | null } {
  const value = integerConfig(raw, true);
  if (value === null || value < 0 || value >= 10_000) return { feeBps: null, feeReason: FEE_UNCONFIGURED };
  return { feeBps: value, feeReason: null };
}

export function readWindowSize(raw: string | undefined): {
  windowSize: number | null;
  windowSizeReason: typeof WINDOW_SIZE_UNCONFIGURED | null;
} {
  const value = integerConfig(raw, false);
  if (value === null || value < 1) return { windowSize: null, windowSizeReason: WINDOW_SIZE_UNCONFIGURED };
  return { windowSize: value, windowSizeReason: null };
}

export function readPoolTerms(env: NodeJS.ProcessEnv = process.env): PoolTerms {
  return {
    ...readFeeBps(env.MINING_POOL_FEE_BPS),
    ...readWindowSize(env.MINING_POOL_WINDOW_SIZE),
  };
}
