import { formatAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { PayGuardRefusal } from '../seams/guards.js';
import { allowanceOf, usedInWindow } from './allowance.js';
import type { WithdrawalLimitMode } from './config.js';
import { GUARD_WITHDRAWAL_LIMIT_UNSET, GUARD_WITHDRAWAL_TIER_UNWIRED, type KycTierOf } from './guards.js';
import type { LimitSource } from './source.js';

/** Limits are not enforced in this deployment (`PAY_WITHDRAWAL_LIMITS` is `off`), so there is no allowance to show. */
export const GUARD_WITHDRAWAL_LIMITS_OFF = 'pay.guard_withdrawal_limits_off' as const;
/** No allowance reader is wired into this service. */
export const GUARD_WITHDRAWAL_LIMITS_UNWIRED = 'pay.guard_withdrawal_limits_unwired' as const;

export interface WithdrawalAllowanceView {
  readonly tier: string;
  readonly assetId: string;
  readonly perTx: string;
  readonly rolling24h: string;
  readonly used24h: string;
  readonly remaining: { readonly perTx: string; readonly rolling24h: string };
  /** The most one withdrawal may be right now. */
  readonly maxNow: string;
}

/**
 * The owner's withdrawal limits for every KYC tier, as the verification ladder shows them (I-kyc-compliance-04). Only
 * figures the owner set are listed; a tier or asset left out has no limit set. `enforced` is false when this deployment
 * does not apply limits at all (`PAY_WITHDRAWAL_LIMITS=off`), so the page never presents a figure as binding when it is not.
 */
export interface PublishedLimitsView {
  readonly enforced: boolean;
  readonly limits: Array<{ tier: string; assetId: string; perTx: string; rolling24h: string }>;
}

export interface WithdrawalLimitReader {
  allowance(userId: string, assetId: string): Promise<WithdrawalAllowanceView>;
  published(): Promise<PublishedLimitsView>;
}

export interface WithdrawalLimitReaderDeps {
  readonly sql: Sql;
  readonly source: LimitSource;
  readonly mode: WithdrawalLimitMode;
  readonly tierOf?: KycTierOf;
}

/**
 * The customer's own remaining withdrawal allowance for one asset (D-148), read
 * the way the guard reads it: the tier comes from identity at the moment of the
 * call, the figure from the owner-set table, the used amount from the same
 * rolling window. It refuses with the guard's own typed codes where the guard
 * would, so the form never promises room the guard will not give.
 *
 * This is a read at one instant. It does not reserve anything: the guard still
 * decides at submit, under its lock.
 */
export function createWithdrawalLimitReader(deps: WithdrawalLimitReaderDeps): WithdrawalLimitReader {
  return {
    async allowance(userId, assetId) {
      if (deps.mode === 'off') throw new PayGuardRefusal(GUARD_WITHDRAWAL_LIMITS_OFF, 'unavailable');
      if (!deps.tierOf) throw new PayGuardRefusal(GUARD_WITHDRAWAL_TIER_UNWIRED, 'unavailable');
      // A dark identity service is "unavailable", never a guessed tier.
      const tier = await deps.tierOf(userId).catch(() => {
        throw new PayGuardRefusal('pay.guard_unavailable', 'unavailable');
      });
      const limit = await deps.source.get(tier, assetId, deps.sql);
      if (!limit) throw new PayGuardRefusal(GUARD_WITHDRAWAL_LIMIT_UNSET, 'refused');
      const a = allowanceOf(limit, await usedInWindow(deps.sql, { userId, assetId }));
      return {
        tier,
        assetId,
        perTx: formatAmount(a.perTx),
        rolling24h: formatAmount(a.rolling24h),
        used24h: formatAmount(a.used24h),
        remaining: { perTx: formatAmount(a.perTx), rolling24h: formatAmount(a.left24h) },
        maxNow: formatAmount(a.maxNow),
      };
    },
    async published() {
      const rows = await deps.source.list(deps.sql);
      return {
        enforced: deps.mode === 'required',
        limits: rows.map((r) => ({
          tier: r.tier,
          assetId: r.assetId,
          perTx: formatAmount(r.perTx),
          rolling24h: formatAmount(r.rolling24h),
        })),
      };
    },
  };
}
