/**
 * A long-lived key keeps the scopes it was minted with. This recheck refuses
 * `pay:read` and `pay:write` when the caller's own merchant no longer grants
 * them. A caller who owns no merchant is a team member and is left to the
 * role table.
 */

import type { Principal } from '@intafaced/auth';
import { TRPCError } from '@intafaced/contracts';
import { grantedOwnerPayScopes, type OwnerPayScopeMerchant } from './merchant-pay-grant-path.js';

export type OwnedMerchantLookup = (userId: string) => Promise<OwnerPayScopeMerchant | null>;

export async function assertOwnerPayScopeStillGranted(
  principal: Principal,
  scope: 'pay:read' | 'pay:write',
  lookup: OwnedMerchantLookup,
): Promise<void> {
  const merchant = await lookup(principal.userId);
  if (!merchant || merchant.userId !== principal.userId) return;
  const granted = grantedOwnerPayScopes(merchant, principal.userId);
  if (!granted.scopes.includes(scope)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'pay.owner_grant_withdrawn' });
  }
}
