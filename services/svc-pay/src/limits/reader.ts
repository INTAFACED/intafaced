import type { WithdrawalAllowance } from '@intafaced/contracts';
import { formatAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { PayGuardRefusal } from '../seams/guards.js';
import { allowanceOf, usedInWindow } from './allowance.js';
import type { WithdrawalLimitMode } from './config.js';
import { GUARD_WITHDRAWAL_TIER_UNWIRED, limitInForce, readIdentitySide, type KycTierOf } from './guards.js';
import type { LimitOverrideOf } from './identity-override.js';
import type { LimitSource } from './source.js';

/** Limits are not enforced in this deployment (`PAY_WITHDRAWAL_LIMITS` is `off`), so there is no allowance to show. */
export const GUARD_WITHDRAWAL_LIMITS_OFF = 'pay.guard_withdrawal_limits_off' as const;
/** No allowance reader is wired into this service. */
export const GUARD_WITHDRAWAL_LIMITS_UNWIRED = 'pay.guard_withdrawal_limits_unwired' as const;

/** The published `WithdrawalAllowance` contract: base, override in force, figures in force, used and left. */
export type WithdrawalAllowanceView = WithdrawalAllowance;

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
  readonly overrideOf?: LimitOverrideOf;
}

/**
 * The customer's own remaining withdrawal allowance for one asset (D-148), read
 * the way the guard reads it (`readIdentitySide`, `limitInForce`): the tier and a
 * founder's override come from identity at the moment of the call, the base
 * figure from the owner-set table, the used amount from the same rolling window. It refuses with the guard's own typed codes where the guard
 * would, so the form never promises room the guard will not give.
 *
 * This is a read at one instant. It does not reserve anything: the guard still
 * decides at submit, under its lock.
 */
export function createWithdrawalLimitReader(deps: WithdrawalLimitReaderDeps): WithdrawalLimitReader {
  return {
    async allowance(userId, assetId) {
      if (deps.mode === 'off') throw new PayGuardRefusal(GUARD_WITHDRAWAL_LIMITS_OFF, 'unavailable');
      // A dark identity service is "unavailable", never a guessed tier or a skipped override.
      const side = await readIdentitySide(deps, userId, assetId).catch((error: unknown) => {
        throw error instanceof PayGuardRefusal ? error : new PayGuardRefusal('pay.guard_unavailable', 'unavailable');
      });
      const { base, limit } = await limitInForce(deps.source, side, assetId, deps.sql);
      const a = allowanceOf(limit, await usedInWindow(deps.sql, { userId, assetId }));
      const { tier, override } = side;
      return {
        tier,
        assetId,
        base: { perTx: formatAmount(base.perTx), rolling24h: formatAmount(base.rolling24h) },
        override: override && {
          perTx: override.perTx === null ? null : formatAmount(override.perTx),
          rolling24h: override.rolling24h === null ? null : formatAmount(override.rolling24h),
          expiresAt: override.expiresAt.toISOString(),
        },
        perTx: formatAmount(a.perTx),
        rolling24h: formatAmount(a.rolling24h),
        used24h: formatAmount(a.used24h),
        remaining: { perTx: formatAmount(a.perTx), rolling24h: formatAmount(a.left24h) },
        maxNow: formatAmount(a.maxNow),
      };
    },
    async published() {
      // Enforced but with no tier source, the guard refuses every withdrawal: say so, never show figures as the live limit.
      if (deps.mode === 'required' && !deps.tierOf) throw new PayGuardRefusal(GUARD_WITHDRAWAL_TIER_UNWIRED, 'unavailable');
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
