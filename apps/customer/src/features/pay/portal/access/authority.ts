import type { PayBusinessAuthority } from '../../pay-api';
import { canOwnerWrite, type Access } from './resolve';

/**
 * The older Business Pay tools and a few pages still take a `PayBusinessAuthority`. It is made here from the
 * resolved access and nowhere else, and only for the account owner: team members use the portal's own reads.
 * An owner whose session cannot change things (an API key, no MFA) is given read scope only. `pay:refund` and `pay:payout`
 * come from the session's own scopes (`session-scopes.ts`), never from the role.
 */
export function authorityFromAccess(
  access: Access,
  sessionUserId: string | null,
  sessionScopes: ReadonlySet<string> | null = null,
): PayBusinessAuthority | null {
  if (access.status !== 'ready' || access.role !== 'owner' || !sessionUserId) return null;
  const name = access.displayName ?? access.legalName ?? 'Your business';
  return {
    verified: true,
    companyId: access.merchantId,
    companyName: name,
    userId: sessionUserId,
    merchantId: access.merchantId,
    scopes: !canOwnerWrite(access)
      ? ['pay:read']
      : [
          'pay:read',
          'pay:write',
          // Refund and payout are held only when the signed-in session carries them. Identity does not mint them today.
          ...(sessionScopes?.has('pay:refund') ? ['pay:refund'] : []),
          ...(sessionScopes?.has('pay:payout') ? ['pay:payout'] : []),
        ],
  };
}
