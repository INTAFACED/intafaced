/**
 * Layer A call site — merchant `pay:*` grant path (D26-P1-P10).
 *
 * Invokes `@intafaced/auth` `assertMerchantPayScopeGrantAllowed` /
 * `issueMerchantPayScopes` so onboarding never appends scopes ad hoc.
 * The owner law is published (2026-10-17). This file does not decide the
 * predicates again. Never invents a grantor.
 *
 * Path fence: KYB writers stay elsewhere. This path only reads the status
 * the caller already loaded and hands it to the named op.
 */

import {
  MERCHANT_PAY_SCOPE_GRANT_RESIDUAL,
  MerchantPayScopeGrantError,
  assertMerchantPayScopeGrantAllowed,
  issueMerchantPayScopes,
  type MerchantPayScope,
  type MerchantPayScopeGrantRequest,
  type OwnerMerchantPayScope,
} from '@intafaced/auth';

export { MERCHANT_PAY_SCOPE_GRANT_RESIDUAL, MerchantPayScopeGrantError };

export type MerchantPayGrantPathRequest = MerchantPayScopeGrantRequest;

/**
 * Named issuance operation. Returns the scopes the published law allows
 * for one merchant, or throws `auth.merchant_pay_scope_grant_refused`.
 */
export function issueMerchantPayScopesViaGrantPath(request: MerchantPayGrantPathRequest): {
  scopes: readonly OwnerMerchantPayScope[];
  merchantId: string;
} {
  return issueMerchantPayScopes(request);
}

/**
 * Gate-only form for call sites that check before building a credential.
 */
export function assertMerchantPayGrantPathAllowed(request: MerchantPayGrantPathRequest): void {
  assertMerchantPayScopeGrantAllowed(request);
}

export type OwnerPayScopeMerchant = {
  readonly id: string;
  readonly userId: string;
  readonly kybStatus: 'none' | 'pending' | 'approved' | 'rejected';
  readonly status: 'pending' | 'active' | 'suspended' | 'closed';
  /** Absent means the caller did not load the parent. Onboarding then refuses. */
  readonly parentMerchantId?: string | null;
};

/**
 * The product path for an owner session. Looks up nothing itself: the caller
 * passes the merchant row it already proved belongs to `userId` (the row
 * whose `user_id` is that person). Team members are not owners and are not
 * passed here. A refusal is empty scopes, not a thrown error, so a login
 * can continue without pay authority.
 */
export function grantedOwnerPayScopes(
  merchant: OwnerPayScopeMerchant | null,
  userId: string,
): { merchantId: string | null; scopes: readonly MerchantPayScope[] } {
  if (!merchant || merchant.userId !== userId) return { merchantId: null, scopes: [] };
  try {
    const issued = issueMerchantPayScopesViaGrantPath({
      merchantId: merchant.id,
      ownedMerchantId: merchant.id,
      actorUserId: userId,
      ownerUserId: merchant.userId,
      role: 'owner',
      kybStatus: merchant.kybStatus,
      merchantStatus: merchant.status,
      scopes: ['pay:read', 'pay:write'],
    });
    return { merchantId: issued.merchantId, scopes: issued.scopes };
  } catch (err) {
    if (err instanceof MerchantPayScopeGrantError) return { merchantId: merchant.id, scopes: [] };
    throw err;
  }
}
