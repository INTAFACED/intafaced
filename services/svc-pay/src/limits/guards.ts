import { compare, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { PayGuardRefusal, type PartialPayGuards } from '../seams/guards.js';
import { loadWithdrawalLimitMode, loadWithdrawalLimits, type WithdrawalLimitMode, type WithdrawalLimits } from './config.js';

/**
 * D-148: per-customer withdrawal limits, by KYC tier, per transaction and over a
 * rolling 24 hours. Runs in `beforeUserMoneyWithdrawal`, inside the transaction
 * that claims the withdrawal, so a refusal leaves no claim, hold or ledger entry.
 *
 * The rolling sum counts every non-failed withdrawal of the same asset created in
 * the last 24 hours (`pending`, `held` and `sent`), except the claim being
 * retried. A per-customer advisory lock is taken before the sum is read, so two
 * parallel requests cannot both read the same headroom.
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
  /** Test seam: preset parsed config. */
  readonly mode?: WithdrawalLimitMode;
  readonly limits?: WithdrawalLimits;
}

export function createWithdrawalLimitGuards(deps: WithdrawalLimitGuardDeps): PartialPayGuards {
  const env = deps.env ?? process.env;
  const mode = deps.mode ?? loadWithdrawalLimitMode(env);
  if (mode === 'off') return {};
  const limits = deps.limits ?? loadWithdrawalLimits(env);

  return {
    beforeUserMoneyWithdrawal: async (ctx) => {
      if (ctx.replay.kind !== 'fresh') return;
      if (!deps.tierOf) throw new PayGuardRefusal(GUARD_WITHDRAWAL_TIER_UNWIRED, 'unavailable');
      const tier = await deps.tierOf(ctx.userId);
      const limit = limits.byTier.get(tier)?.get(ctx.assetId);
      if (!limit) throw new PayGuardRefusal(GUARD_WITHDRAWAL_LIMIT_UNSET, 'refused');

      await ctx.tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.withdrawal_limit:${ctx.userId}`}))`;
      const rows = await ctx.tx<Array<{ used: string }>>`
        SELECT COALESCE(SUM(amount), 0)::text AS used
          FROM pay.withdrawals
         WHERE user_id = ${ctx.userId} AND asset_id = ${ctx.assetId}
           AND status IN ('pending', 'held', 'sent')
           AND created_at > now() - interval '24 hours'
           AND client_ref <> ${ctx.clientRef}
      `;
      const used: Amount = parseAmount(rows[0]?.used ?? '0');
      const left24h = limit.rolling24h > used ? limit.rolling24h - used : 0n;
      if (compare(ctx.amount, limit.perTx) > 0 || compare(ctx.amount, left24h) > 0) {
        throw new PayGuardRefusal(GUARD_WITHDRAWAL_LIMIT_EXCEEDED, 'refused', {
          perTx: formatAmount(limit.perTx),
          rolling24h: formatAmount(left24h),
        });
      }
    },
  };
}
