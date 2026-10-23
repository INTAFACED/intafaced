/**
 * A long-lived key keeps the scopes it was minted with. This recheck refuses
 * `pay:read` and `pay:write` when the caller's own merchant no longer grants
 * them, and `pay:onboard` (session only) once that merchant is suspended or
 * closed, as `issueMerchantOnboardingScope` would at the next sign-in.
 *
 * A caller who owns no merchant is left to the role table for `pay:read` and
 * `pay:write`. For `pay:onboard`, which opens the merchant's own reads, a
 * caller who owns none but is an active team member of a suspended or closed
 * merchant is refused too, so a team session cannot keep reading a business
 * that was shut.
 */

import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { TRPCError } from '@intafaced/contracts';
import { grantedOwnerPayScopes, type OwnerPayScopeMerchant } from './merchant-pay-grant-path.js';

export type OwnedMerchantLookup = (userId: string) => Promise<OwnerPayScopeMerchant | null>;

/** Statuses of the merchants `userId` is an ACTIVE team member of. */
export type TeamMerchantStatusLookup = (userId: string) => Promise<ReadonlyArray<OwnerPayScopeMerchant['status']>>;

/** A merchant in one of these statuses grants nothing, to its owner or its team. */
export const SHUT: ReadonlySet<OwnerPayScopeMerchant['status']> = new Set(['suspended', 'closed']);

export function teamMerchantStatusesFromSql(sql: Sql): TeamMerchantStatusLookup {
  return async (userId) => {
    const rows = await sql<Array<{ status: OwnerPayScopeMerchant['status'] }>>`
      SELECT m.status::text AS status
        FROM pay.merchant_team_members t
        JOIN pay.merchants m ON m.id = t.merchant_id
       WHERE t.user_id = ${userId} AND t.status = 'active'`;
    return rows.map((row) => row.status);
  };
}

export async function assertOwnerPayScopeStillGranted(
  principal: Principal,
  scope: 'pay:read' | 'pay:write' | 'pay:onboard',
  lookup: OwnedMerchantLookup,
  teamStatuses?: TeamMerchantStatusLookup,
): Promise<void> {
  const merchant = await lookup(principal.userId);
  if (!merchant || merchant.userId !== principal.userId) {
    if (scope === 'pay:onboard' && teamStatuses && (await teamStatuses(principal.userId)).some((status) => SHUT.has(status))) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'pay.owner_grant_withdrawn' });
    }
    return;
  }
  if (scope === 'pay:onboard') {
    if (SHUT.has(merchant.status)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'pay.owner_grant_withdrawn' });
    }
    return;
  }
  const granted = grantedOwnerPayScopes(merchant, principal.userId);
  if (!granted.scopes.includes(scope)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'pay.owner_grant_withdrawn' });
  }
}
