import { parseAmount } from '@intafaced/ledger-client';
import { PayGuardRefusal, type PartialPayGuards } from '../../seams/guards.js';
import { approvalLockKey, policyAppliesTo } from './service.js';

export const GUARD_WITHDRAWAL_APPROVAL_REQUIRED = 'pay.guard_withdrawal_approval_required' as const;
export const GUARD_WITHDRAWAL_APPROVAL_TERMS = 'pay.guard_withdrawal_approval_terms' as const;

/**
 * The approval gate inside the withdrawal claim (W-withdraw-11). It runs in `claimWithdrawal`'s own transaction, on the
 * connection `withdraw` already holds, so it asks for no further pool connection while the payout lock is held.
 *
 * - It takes the per-(user, asset) lock `propose` takes, so the window sum it reads always includes any withdrawal or request
 *   that committed before it: two withdrawals that are each under the threshold and together over it cannot both claim.
 * - A reference that names a request sends only that request's frozen terms, and only once it can be sent (approved or
 *   executed, or pending with its hold placed at submission). Any other terms on that reference are refused, so the caller's
 *   own amount or destination can never ride an approved request.
 * - Any other fresh withdrawal meets the policy: refused when it needs approvals.
 *
 * The direct door's own pre-check (`assertDirectAllowed`) gives the typed error first; this is what holds under a race.
 */
export function createWithdrawalApprovalGuards(deps: { now?: () => Date } = {}): PartialPayGuards {
  const now = deps.now ?? (() => new Date());
  return {
    beforeUserMoneyWithdrawal: async (ctx) => {
      await ctx.tx`SELECT pg_advisory_xact_lock(hashtext(${approvalLockKey(ctx.userId, ctx.assetId)}))`;
      const [request] = await ctx.tx<
        Array<{
          status: string;
          hold_at_submit: boolean;
          asset_id: string;
          amount: string;
          rail: string;
          destination: { kind: string; ref: string };
        }>
      >`
        SELECT status, hold_at_submit, asset_id, amount::text AS amount, rail, destination
          FROM pay.withdrawal_approval_requests
         WHERE user_id = ${ctx.userId} AND client_ref = ${ctx.clientRef}`;
      if (request) {
        const frozen =
          request.asset_id === ctx.assetId &&
          parseAmount(request.amount) === ctx.amount &&
          request.rail === ctx.rail &&
          request.destination.kind === ctx.destination.kind &&
          request.destination.ref === ctx.destination.ref;
        if (!frozen) throw new PayGuardRefusal(GUARD_WITHDRAWAL_APPROVAL_TERMS, 'refused');
        const sendable =
          request.status === 'approved' || request.status === 'executed' || (request.status === 'pending' && request.hold_at_submit);
        if (!sendable) throw new PayGuardRefusal(GUARD_WITHDRAWAL_APPROVAL_REQUIRED, 'refused');
        return;
      }
      if (ctx.replay.kind !== 'fresh') return;
      if (await policyAppliesTo(ctx.tx, now(), ctx.userId, ctx.assetId, ctx.amount, ctx.clientRef)) {
        throw new PayGuardRefusal(GUARD_WITHDRAWAL_APPROVAL_REQUIRED, 'refused');
      }
    },
  };
}
