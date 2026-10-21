import { PayGuardRefusal, type PartialPayGuards } from '../../seams/guards.js';
import { allowlistLockKey, decideDestination } from './service.js';

export const GUARD_DESTINATION_NOT_ALLOWLISTED = 'pay.guard_destination_not_allowlisted' as const;

/**
 * The allowlist gate inside the withdrawal claim (W-withdraw-10). It runs in `claimWithdrawal`'s own transaction, on the
 * connection the claim already holds, so it asks for no further pool connection.
 *
 * - It takes the per-user list lock the list edits take, so a removal or a suspension that committed first is always seen:
 *   a withdrawal never claims against an entry that is gone.
 * - Only FRESH work is checked. A hold that is already booked, a withdrawal already sent and a replay were admitted by an
 *   earlier call; refusing them would strand the held funds (see REPLAY AND RECOVERY in `seams/guards.ts`).
 * - The decision is `decideDestination`: mode off passes, mode on needs an active entry of the same asset or a one-time send
 *   within the approved ceiling. A refusal is `pay.guard_destination_not_allowlisted`; the direct door's own pre-check
 *   (`assertDirectAllowed`) gives the friendlier `pay.destination_not_allowlisted` first, and this is what holds under a race.
 * - A listed address that is used stamps the entry's last use, once per claim.
 */
export function createAllowlistGuards(): PartialPayGuards {
  return {
    beforeUserMoneyWithdrawal: async (ctx) => {
      if (ctx.replay.kind !== 'fresh') return;
      await ctx.tx`SELECT pg_advisory_xact_lock(hashtext(${allowlistLockKey(ctx.userId)}))`;
      const decision = await decideDestination(ctx.tx, ctx.userId, ctx.assetId, ctx.amount, ctx.destination);
      if (!decision.allowed) throw new PayGuardRefusal(GUARD_DESTINATION_NOT_ALLOWLISTED, 'refused');
      if (decision.via === 'entry' && !ctx.stopAfterHold) {
        await ctx.tx`UPDATE pay.allowlist_entries SET last_used_at = now() WHERE id = ${decision.entryId!}`;
      }
    },
  };
}
