import { compare, formatAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { PayGuardRefusal, type PartialPayGuards } from '../seams/guards.js';
import { allowanceOf, usedInWindow } from './allowance.js';
import { loadWithdrawalLimitMode, loadWithdrawalLimits, type WithdrawalLimitMode, type WithdrawalLimits } from './config.js';
import { staticLimitSource, type LimitSource } from './source.js';

/**
 * D-148: per-customer withdrawal limits, by KYC tier, per transaction and over a
 * rolling 24 hours. Runs in `beforeUserMoneyWithdrawal`, inside the transaction
 * that claims the withdrawal, so a refusal leaves no claim, hold or ledger entry.
 *
 * The rolling sum (allowance.ts) counts every withdrawal of the same asset that
 * can still move value in the last 24 hours, except the claim being retried. A
 * per-customer advisory lock is taken before the sum is read, so two parallel
 * requests cannot both read the same headroom.
 *
 * Fail closed: no limit for the customer's tier and asset refuses
 * (`pay.guard_withdrawal_limit_unset`); no tier source wired refuses
 * (`pay.guard_withdrawal_tier_unwired`). Replays and recoveries are never
 * refused: their hold is booked and refusing would strand it.
 */
export const GUARD_WITHDRAWAL_LIMIT_UNSET = 'pay.guard_withdrawal_limit_unset' as const;
export const GUARD_WITHDRAWAL_LIMIT_EXCEEDED = 'pay.guard_withdrawal_limit_exceeded' as const;
export const GUARD_WITHDRAWAL_TIER_UNWIRED = 'pay.guard_withdrawal_tier_unwired' as const;

/** The customer's KYC tier from the identity service. Omitted until that read is wired. */
export type KycTierOf = (userId: string) => Promise<string>;

export interface WithdrawalLimitGuardDeps {
  readonly sql: Sql;
  readonly env?: Record<string, string | undefined>;
  readonly tierOf?: KycTierOf;
  /** Where the owner-set figures live. Without it the guard uses `limits`, or the retired environment source. */
  readonly source?: LimitSource;
  /** Test seam: preset parsed config. */
  readonly mode?: WithdrawalLimitMode;
  readonly limits?: WithdrawalLimits;
}

export function createWithdrawalLimitGuards(deps: WithdrawalLimitGuardDeps): PartialPayGuards {
  const env = deps.env ?? process.env;
  const mode = deps.mode ?? loadWithdrawalLimitMode(env);
  if (mode === 'off') return {};
  const source = deps.source ?? staticLimitSource(deps.limits ?? loadWithdrawalLimits(env));

  return {
    beforeUserMoneyWithdrawal: async (ctx) => {
      if (ctx.replay.kind !== 'fresh') return;
      if (!deps.tierOf) throw new PayGuardRefusal(GUARD_WITHDRAWAL_TIER_UNWIRED, 'unavailable');
      const tier = await deps.tierOf(ctx.userId);
      const limit = await source.get(tier, ctx.assetId);
      if (!limit) throw new PayGuardRefusal(GUARD_WITHDRAWAL_LIMIT_UNSET, 'refused');

      await ctx.tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.withdrawal_limit:${ctx.userId}`}))`;
      const used = await usedInWindow(ctx.tx, { userId: ctx.userId, assetId: ctx.assetId, exceptClientRef: ctx.clientRef });
      const allowance = allowanceOf(limit, used);
      if (compare(ctx.amount, limit.perTx) > 0 || compare(ctx.amount, allowance.left24h) > 0) {
        throw new PayGuardRefusal(GUARD_WITHDRAWAL_LIMIT_EXCEEDED, 'refused', {
          perTx: formatAmount(limit.perTx),
          rolling24h: formatAmount(allowance.left24h),
        });
      }
    },
  };
}
