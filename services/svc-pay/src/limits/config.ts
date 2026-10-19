import { parseAmount, type Amount } from '@intafaced/ledger-client';

/**
 * PER-CUSTOMER WITHDRAWAL LIMITS (D-148). No defaults, no sandbox numbers.
 *
 * `PAY_WITHDRAWAL_LIMITS_BY_TIER` is a JSON object: KYC tier -> asset id ->
 * `{ "perTx": "<decimal>", "rolling24h": "<decimal>" }`. The owner sets every
 * figure. A missing, blank, malformed or non-positive entry (either figure) is
 * UNSET, never unlimited and never zero-means-open. Limits are per asset, in that
 * asset's own units; no price is read or invented here.
 */
export const PAY_WITHDRAWAL_LIMITS_ENV = 'PAY_WITHDRAWAL_LIMITS_BY_TIER';

/**
 * ENFORCEMENT SWITCH. `PAY_WITHDRAWAL_LIMITS=off|required`, default `off`.
 * Any other value, including a blank one, FAILS BOOT: a typo must never silently
 * turn enforcement off.
 */
export const PAY_WITHDRAWAL_LIMITS_MODE_ENV = 'PAY_WITHDRAWAL_LIMITS';
export type WithdrawalLimitMode = 'off' | 'required';

export function loadWithdrawalLimitMode(env: Record<string, string | undefined>): WithdrawalLimitMode {
  const raw = env[PAY_WITHDRAWAL_LIMITS_MODE_ENV];
  if (raw === undefined) return 'off';
  if (raw === 'off' || raw === 'required') return raw;
  throw new Error(`${PAY_WITHDRAWAL_LIMITS_MODE_ENV} must be "off" or "required" (got ${JSON.stringify(raw)}); refusing to boot`);
}

export interface WithdrawalLimit {
  readonly perTx: Amount;
  readonly rolling24h: Amount;
}

export interface WithdrawalLimits {
  /** Tier -> asset id -> limit. A missing entry means no limit is set. */
  readonly byTier: ReadonlyMap<string, ReadonlyMap<string, WithdrawalLimit>>;
  /** Entries present but unusable, for status ("configured but invalid"). */
  readonly invalid: readonly string[];
}

export function loadWithdrawalLimits(env: Record<string, string | undefined>): WithdrawalLimits {
  const raw = env[PAY_WITHDRAWAL_LIMITS_ENV]?.trim();
  const byTier = new Map<string, Map<string, WithdrawalLimit>>();
  const invalid: string[] = [];
  if (!raw) return { byTier, invalid };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { byTier, invalid: ['<whole value is not JSON>'] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { byTier, invalid: ['<not an object>'] };
  for (const [tier, assets] of Object.entries(parsed)) {
    if (!assets || typeof assets !== 'object' || Array.isArray(assets)) {
      invalid.push(tier);
      continue;
    }
    for (const [asset, value] of Object.entries(assets)) {
      try {
        const v = value as { perTx?: unknown; rolling24h?: unknown } | null;
        if (!v || typeof v.perTx !== 'string' || typeof v.rolling24h !== 'string' || asset.trim() === '')
          throw new Error('not decimal strings');
        const perTx = parseAmount(v.perTx);
        const rolling24h = parseAmount(v.rolling24h);
        if (perTx <= 0n || rolling24h <= 0n) throw new Error('not positive');
        const forTier = byTier.get(tier) ?? new Map<string, WithdrawalLimit>();
        forTier.set(asset, { perTx, rolling24h });
        byTier.set(tier, forTier);
      } catch {
        invalid.push(`${tier}/${asset}`);
      }
    }
  }
  return { byTier, invalid };
}
