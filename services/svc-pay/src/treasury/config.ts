import { parseAmount, type Amount } from '@intafaced/ledger-client';

/**
 * TREASURY EXPOSURE LIMITS. No defaults, no sandbox numbers.
 *
 * `PAY_TREASURY_EXPOSURE_LIMITS` is a JSON object of asset id -> decimal string,
 * e.g. {"USDT":"100000"} (that example is illustrative, not a recommendation).
 * The limit caps, per asset, the SUM of open conversion inventory and pending
 * payouts. An asset with no valid entry has NO limit configured, and every
 * operation that would add exposure in that asset is refused
 * (`pay.guard_treasury_limit_unset`). A blank, malformed or non-positive entry
 * counts as unset, never as unlimited or zero-means-open.
 */
export const PAY_TREASURY_LIMITS_ENV = 'PAY_TREASURY_EXPOSURE_LIMITS';

export interface TreasuryLimits {
  /** Asset id -> limit in scaled bigint. Missing asset = no limit set. */
  readonly byAsset: ReadonlyMap<string, Amount>;
  /** Entries that were present but unusable, for status ("configured but invalid"). */
  readonly invalid: readonly string[];
}

export function loadTreasuryLimits(env: Record<string, string | undefined>): TreasuryLimits {
  const raw = env[PAY_TREASURY_LIMITS_ENV]?.trim();
  const byAsset = new Map<string, Amount>();
  const invalid: string[] = [];
  if (!raw) return { byAsset, invalid };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { byAsset, invalid: ['<whole value is not JSON>'] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { byAsset, invalid: ['<not an object>'] };
  for (const [asset, value] of Object.entries(parsed)) {
    try {
      if (typeof value !== 'string' || asset.trim() === '') throw new Error('not a decimal string');
      const amount = parseAmount(value);
      if (amount <= 0n) throw new Error('not positive');
      byAsset.set(asset, amount);
    } catch {
      invalid.push(asset);
    }
  }
  return { byAsset, invalid };
}
