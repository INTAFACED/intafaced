import type { PayBusinessAuthority } from '../../pay-api';
import { canOwnerWrite, type Access } from './resolve';

/**
 * The older Business Pay tools and a few pages still take a `PayBusinessAuthority`. It is made here from the
 * resolved access and nowhere else, and only for the account owner: team members use the portal's own reads.
 * An owner whose session cannot change things (an API key, no MFA) is given read scope only.
 */
export function authorityFromAccess(access: Access, sessionUserId: string | null): PayBusinessAuthority | null {
  if (access.status !== 'ready' || access.role !== 'owner' || !sessionUserId) return null;
  const name = access.displayName ?? access.legalName ?? 'Your business';
  return {
    verified: true,
    companyId: access.merchantId,
    companyName: name,
    userId: sessionUserId,
    merchantId: access.merchantId,
    scopes: canOwnerWrite(access) ? ['pay:read', 'pay:write', 'pay:refund', 'pay:payout'] : ['pay:read'],
  };
}
