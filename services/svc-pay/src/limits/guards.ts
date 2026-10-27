import { compare, formatAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { PayGuardRefusal, type PartialPayGuards } from '../seams/guards.js';
import { allowanceOf, inForce, usedInWindow } from './allowance.js';
import {
  loadWithdrawalLimitMode,
  loadWithdrawalLimits,
  type WithdrawalLimit,
  type WithdrawalLimitMode,
  type WithdrawalLimits,
} from './config.js';
import type { LimitOverride, LimitOverrideOf } from './identity-override.js';
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
 * A founder's override for the customer and asset (J-ops-console-04 #12), read
 * from identity per request beside the tier (`readIdentitySide`), replaces the
 * base figure it names until its stored end time (`limitInForce`). Both reads run
 * together before the advisory lock, so that lock is never held across them.
 *
 * Fail closed: no limit for the customer's tier and asset refuses
 * (`pay.guard_withdrawal_limit_unset`), with or without an override; no tier
 * source wired refuses (`pay.guard_withdrawal_tier_unwired`), and no override
 * read wired refuses (`pay.guard_withdrawal_override_unwired`), since a founder's
 * lowered limit must never be skipped. A failed read throws, which is
 * `pay.guard_unavailable`. Replays and recoveries are never refused: their hold
 * is booked and refusing would strand it.
 */
export const GUARD_WITHDRAWAL_LIMIT_UNSET = 'pay.guard_withdrawal_limit_unset' as const;
export const GUARD_WITHDRAWAL_LIMIT_EXCEEDED = 'pay.guard_withdrawal_limit_exceeded' as const;
export const GUARD_WITHDRAWAL_TIER_UNWIRED = 'pay.guard_withdrawal_tier_unwired' as const;
export const GUARD_WITHDRAWAL_OVERRIDE_UNWIRED = 'pay.guard_withdrawal_override_unwired' as const;

/** The customer's KYC tier from the identity service. Omitted until that read is wired. */
export type KycTierOf = (userId: string) => Promise<string>;

export interface WithdrawalLimitGuardDeps {
  readonly sql: Sql;
  readonly env?: Record<string, string | undefined>;
  readonly tierOf?: KycTierOf;
  /** A founder's override for the customer and asset, from identity. Omitted until that read is wired. */
  readonly overrideOf?: LimitOverrideOf;
  /** Where the owner-set figures live. Without it the guard uses `limits`, or the retired environment source. */
  readonly source?: LimitSource;
  /** Test seam: preset parsed config. */
  readonly mode?: WithdrawalLimitMode;
  readonly limits?: WithdrawalLimits;
}

/** What identity says about a customer and asset for the limit: their KYC tier and a founder's override in force. */
export interface IdentityLimitSide {
  readonly tier: string;
  readonly override: LimitOverride | null;
}

/**
 * Both identity reads, together, for the guard and the allowance read alike. An unwired read refuses by name; a failed
 * read throws (the guard's composer and the reader both make that `pay.guard_unavailable`).
 */
export async function readIdentitySide(
  deps: { readonly tierOf?: KycTierOf; readonly overrideOf?: LimitOverrideOf },
  userId: string,
  assetId: string,
): Promise<IdentityLimitSide> {
  if (!deps.tierOf) throw new PayGuardRefusal(GUARD_WITHDRAWAL_TIER_UNWIRED, 'unavailable');
  if (!deps.overrideOf) throw new PayGuardRefusal(GUARD_WITHDRAWAL_OVERRIDE_UNWIRED, 'unavailable');
  const [tier, override] = await Promise.all([deps.tierOf(userId), deps.overrideOf(userId, assetId)]);
  return { tier, override };
}

/** The owner-set base for the tier, read on `q`, and the figures in force on top of it. No base refuses, override or not. */
export async function limitInForce(
  source: LimitSource,
  side: IdentityLimitSide,
  assetId: string,
  q: Sql,
): Promise<{ base: WithdrawalLimit; limit: WithdrawalLimit }> {
  const base = await source.get(side.tier, assetId, q);
  if (!base) throw new PayGuardRefusal(GUARD_WITHDRAWAL_LIMIT_UNSET, 'refused');
  return { base, limit: inForce(base, side.override) };
}

export function createWithdrawalLimitGuards(deps: WithdrawalLimitGuardDeps): PartialPayGuards {
  const env = deps.env ?? process.env;
  const mode = deps.mode ?? loadWithdrawalLimitMode(env);
  if (mode === 'off') return {};
  const source = deps.source ?? staticLimitSource(deps.limits ?? loadWithdrawalLimits(env));

  return {
    beforeUserMoneyWithdrawal: async (ctx) => {
      if (ctx.replay.kind !== 'fresh') return;
      const side = await readIdentitySide(deps, ctx.userId, ctx.assetId);
      await ctx.tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.withdrawal_limit:${ctx.userId}`}))`;
      // Read on the claim's own transaction, after the lock: no second pool connection, and the figure is the one in force for this claim.
      const { limit } = await limitInForce(source, side, ctx.assetId, ctx.tx);
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
