import type { PayBusinessAuthority } from '../../pay-api';
import { canOwnerWrite, type Access } from './resolve';

/**
 * The older Business Pay tools and a few pages still take a `PayBusinessAuthority`. It is made here from the
 * resolved access and nowhere else, and only for the account owner: team members use the portal's own reads.
 * An owner whose session cannot change things (an API key, no MFA) is given read scope only. `pay:refund` and `pay:payout`
 * are never in `scopes` unless the session itself carries them (`session-scopes.ts`): the owner of an active account
 * may instead CONFIRM them (`confirmable`), which opens a short confirmation step before the money call (`step-up.ts`).
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
          ...(sessionScopes?.has('pay:refund') ? ['pay:refund'] : []),
          ...(sessionScopes?.has('pay:payout') ? ['pay:payout'] : []),
        ],
    confirmable: canOwnerWrite(access) ? ['pay:refund', 'pay:payout'] : [],
  };
}
