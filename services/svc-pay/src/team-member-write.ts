import type { Sql } from 'postgres';
import { hasScope, requireScope, type Scope } from '@intafaced/auth';
import { anyScopeProcedure, type ServiceCheck, TRPCError } from '@intafaced/contracts/trpc';
import { wrapOps } from './merchant-ops/errors.js';
import { SHUT } from './owner-pay-grant-recheck.js';

/** `pay:write`, or `pay:onboard`: the scopes a team member's write is guarded with (`anyScopeProcedure`). */
export const PAY_OR_ONBOARD: readonly [Scope, Scope] = ['pay:write', 'pay:onboard'];

/**
 * A team member's writes on the business they work for (J-merchant-01 #4, the team part).
 *
 * The owner grant law (packages/auth merchant-pay-scope-grant.ts) issues `pay:write` to the owner
 * of a KYB-approved merchant only: "admin, finance, developer, and viewer keep the team-role table
 * in svc-pay". So a team member's session never carried `pay:write`, and every write the role
 * table gives a role (answering a dispute, sending an invoice, managing the team or webhooks) was
 * refused to everyone but the owner. These writes now take `pay:write` or `pay:onboard`:
 *
 * - An owner still needs a live `pay:write`, rechecked against the merchant, so the KYB predicate
 *   on the owner's writes is unchanged.
 * - A caller who owns no business and holds `pay:write` is unchanged.
 * - Otherwise the caller (on `pay:onboard`, which is interactive and needs a second factor) must be
 *   an ACTIVE team member of a merchant whose KYB is approved and which is not shut (`SHUT`).
 *   The role table then decides each action, in the service method (`assertPermission`).
 *
 * Refunds and payouts are untouched: they keep their step-up scopes.
 *
 * The guard is `anyScopeProcedure(PAY_OR_ONBOARD, { module: 'pay', check })` with this check, run last, so a call
 * record names it (`access: { caller: 'anyScope', ..., check: 'teamMember' }`) and its mount runs the same function.
 */
export function teamMemberCheck(sql: () => Sql): ServiceCheck {
  return async (ctx) => {
    const principal = ctx.principal;
    // `sql()` refuses with the typed `pay.merchant_ops_unavailable` when the service has no database.
    const db = await wrapOps(() => sql());
    const owned = await db<Array<{ id: string }>>`SELECT id FROM pay.merchants WHERE user_id = ${principal.userId} LIMIT 1`;
    if (owned[0] || hasScope(principal.scopes, 'pay:write')) {
      if (!hasScope(principal.scopes, 'pay:write')) refuse();
      requireScope(principal, 'pay:write');
      // anyScopeProcedure moves on to `pay:onboard` when `pay:write` is withdrawn, so recheck the one this path needs.
      await ctx.ownerPayGrant?.assertStillGranted(principal, 'pay:write');
      return;
    }
    const member = await db<Array<{ merchant_id: string }>>`
      SELECT t.merchant_id
        FROM pay.merchant_team_members t
        JOIN pay.merchants m ON m.id = t.merchant_id
       WHERE t.user_id = ${principal.userId} AND t.status = 'active'
         AND m.kyb_status = 'approved' AND NOT (m.status::text = ANY(${[...SHUT]}))
       LIMIT 1`;
    if (!member[0]) refuse();
  };
}

/**
 * A person's own notification preferences (J-merchant-01 #6): `pay:write` or `pay:onboard`, both rechecked live, so an
 * owner whose verification is not done yet saves their own choices like any teammate. A preference is the caller's own
 * row, moves no money and changes nothing anyone else sees, so it takes no KYB gate; the role table still decides it
 * (`notifications.manage`, in the service method), and a suspended or closed business loses `pay:onboard` at once.
 */
export function ownPreferenceWrite() {
  return anyScopeProcedure(PAY_OR_ONBOARD, { module: 'pay' });
}

/**
 * Accepting an invitation addressed to the caller: the caller's own membership, so `pay:onboard`
 * is enough (the person has no business of their own to hold `pay:write` for), still rechecked
 * live. The method refuses API keys and sessions without a second factor.
 */
export function invitationAccept() {
  return anyScopeProcedure(PAY_OR_ONBOARD, { module: 'pay' });
}

/**
 * Declining an invitation or leaving a team only takes access away, so it is open even while the
 * business is suspended or closed (when the live recheck withdraws `pay:onboard`): a member is never
 * stuck on a shut business's team. The scope itself is still required, with its second factor. The guard is
 * `signedInProcedure({ check: membershipExit })`, so a call record names it (`check: 'membershipExit'`).
 */
export const membershipExit: ServiceCheck = (ctx) => {
  const held = PAY_OR_ONBOARD.find((scope) => hasScope(ctx.principal.scopes, scope));
  if (!held) refuse();
  try {
    requireScope(ctx.principal, held);
  } catch (err) {
    const mfa = (err as { code?: string }).code === 'mfa.required';
    throw new TRPCError({ code: mfa ? 'UNAUTHORIZED' : 'FORBIDDEN', message: (err as Error).message, cause: err });
  }
};

function refuse(): never {
  throw new TRPCError({ code: 'FORBIDDEN', message: 'Scope "pay:write" is required' });
}
