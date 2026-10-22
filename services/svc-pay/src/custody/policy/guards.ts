import type { Sql } from 'postgres';
import { PayGuardRefusal, type PartialPayGuards } from '../../seams/guards.js';
import { evaluatePolicy } from './engine.js';
import { loadPublishedPolicy, withdrawalsUsedInWindow } from './service.js';

/**
 * The custody transaction policy inside the withdrawal claim (W-custody-ops-07). Runs in `beforeUserMoneyWithdrawal`,
 * on the claim's own transaction, so a refusal leaves no claim, hold or ledger entry. The existing guards (limits,
 * halts, treasury) stay as the floor; this only adds refusals.
 *
 * Fail closed when switched on: no published policy refuses (`unset`), a transaction no rule matches refuses
 * (`no_match`), `block` refuses. `approve` and `additional_signers` refuse too (`approval_unwired`): routing a
 * customer withdrawal into an approval group is not built in this slice, and letting it through would skip the
 * approvers. Replays and recoveries are never refused: their hold is booked and refusing would strand it.
 *
 * `PAY_CUSTODY_POLICY=off|required`, default `off`; any other value fails boot so a typo never turns it off.
 */
export const PAY_CUSTODY_POLICY_MODE_ENV = 'PAY_CUSTODY_POLICY';
export const GUARD_CUSTODY_POLICY_UNSET = 'pay.guard_custody_policy_unset' as const;
export const GUARD_CUSTODY_POLICY_BLOCKED = 'pay.guard_custody_policy_blocked' as const;
export const GUARD_CUSTODY_POLICY_NO_MATCH = 'pay.guard_custody_policy_no_match' as const;
export const GUARD_CUSTODY_POLICY_APPROVAL_UNWIRED = 'pay.guard_custody_policy_approval_unwired' as const;

export type CustodyPolicyMode = 'off' | 'required';

export function loadCustodyPolicyMode(env: Record<string, string | undefined>): CustodyPolicyMode {
  const raw = env[PAY_CUSTODY_POLICY_MODE_ENV];
  if (raw === undefined) return 'off';
  if (raw === 'off' || raw === 'required') return raw;
  throw new Error(`${PAY_CUSTODY_POLICY_MODE_ENV} must be "off" or "required" (got ${JSON.stringify(raw)}); refusing to boot`);
}

export function createCustodyPolicyGuards(deps: {
  readonly sql: Sql;
  readonly env?: Record<string, string | undefined>;
  readonly mode?: CustodyPolicyMode;
}): PartialPayGuards {
  const mode = deps.mode ?? loadCustodyPolicyMode(deps.env ?? process.env);
  if (mode === 'off') return {};
  return {
    beforeUserMoneyWithdrawal: async (ctx) => {
      if (ctx.replay.kind !== 'fresh') return;
      // Same per-customer lock as the D-148 guard, so two parallel claims cannot both read the same cumulative headroom.
      await ctx.tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.withdrawal_limit:${ctx.userId}`}))`;
      const policy = await loadPublishedPolicy(ctx.tx);
      if (!policy) throw new PayGuardRefusal(GUARD_CUSTODY_POLICY_UNSET, 'refused');
      const decision = await evaluatePolicy(
        policy.rules,
        {
          initiator: ctx.userId,
          assetId: ctx.assetId,
          amount: ctx.amount,
          network: ctx.rail,
          destinationKind: ctx.destination.kind,
          destinationRef: ctx.destination.ref,
          txType: 'transfer',
        },
        withdrawalsUsedInWindow(ctx.tx, ctx.clientRef),
      );
      switch (decision.outcome) {
        case 'allow':
          return;
        case 'block':
          throw new PayGuardRefusal(GUARD_CUSTODY_POLICY_BLOCKED, 'refused');
        case 'no_match':
          throw new PayGuardRefusal(GUARD_CUSTODY_POLICY_NO_MATCH, 'refused');
        default:
          throw new PayGuardRefusal(GUARD_CUSTODY_POLICY_APPROVAL_UNWIRED, 'refused');
      }
    },
  };
}
