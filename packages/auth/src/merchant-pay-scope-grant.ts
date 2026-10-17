/**
 * Merchant acquiring scope grant — named issuance (D26-P0-08 → P1-P10).
 *
 * Unpublished until 2026-10-17 because DIRECTION §8 item 4 left four answers
 * to the owner: who receives `pay:*`, which KYB predicate applies to each
 * scope, whether a sandbox grant exists, and whether suspension strips them.
 * The 2026-08-13 and 2026-08-15 ADRs froze issuance as
 * `auth.merchant_pay_scope_grant_unpublished` so an agent would not invent
 * those answers. Nitro published them on 2026-10-17 ("yes grant law"):
 *
 * 1. The owner of one merchant receives the grant. Admin, finance, developer,
 *    and viewer keep the team-role table in svc-pay; this law does not copy
 *    owner scopes onto those roles.
 * 2. Approved KYB is required for `pay:read` and `pay:write`. `pay:refund`
 *    and `pay:payout` stay withheld. There is no sandbox temporary grant.
 * 3. A suspended or closed merchant is refused. Pending (not yet active) is
 *    allowed once KYB is approved.
 * 4. The grant names one merchant id. Any other id is refused.
 *
 * Approving KYB does not itself write scopes. Call sites still have to invoke
 * `issueMerchantPayScopes`. Ordinary sessions still do not carry `pay:*`.
 *
 * ADR shape: docs/adr/2026-08-12-pay-write-kyb-grant-mechanism-shape.md
 */

import { isScope, type Scope } from './scopes.js';

/** The four merchant acquiring scopes withheld from ordinary sessions. */
export const MERCHANT_PAY_SCOPES = ['pay:read', 'pay:write', 'pay:refund', 'pay:payout'] as const;

export type MerchantPayScope = (typeof MERCHANT_PAY_SCOPES)[number];

/** Scopes this law actually issues. Refund and payout stay off it. */
export const OWNER_MERCHANT_PAY_SCOPES = ['pay:read', 'pay:write'] as const;

export type OwnerMerchantPayScope = (typeof OWNER_MERCHANT_PAY_SCOPES)[number];

/** Roles the grant request may name. Only `owner` is issued scopes. */
export const MERCHANT_PAY_GRANT_ROLES = ['owner', 'admin', 'finance', 'developer', 'viewer'] as const;

export type MerchantPayGrantRole = (typeof MERCHANT_PAY_GRANT_ROLES)[number];

/**
 * Stable residual. The law is published; a refusal is a predicate miss,
 * not an invitation to invent a second grantor.
 */
export const MERCHANT_PAY_SCOPE_GRANT_RESIDUAL =
  'DIRECTION §8 item 4 — owner of one KYB-approved merchant receives pay:read and pay:write for that merchant only; refund and payout stay withheld; suspension and closure refuse';

export type MerchantPayScopeGrantErrorCode = 'auth.merchant_pay_scope_grant_refused';

export class MerchantPayScopeGrantError extends Error {
  constructor(
    message: string,
    readonly code: MerchantPayScopeGrantErrorCode,
    readonly residual: string = MERCHANT_PAY_SCOPE_GRANT_RESIDUAL,
  ) {
    super(message);
    this.name = 'MerchantPayScopeGrantError';
  }
}

export type MerchantPayScopeGrantRequest = {
  /** Merchant the scopes would be for. Must be the merchant the actor owns. */
  merchantId: string;
  /** The merchant id the actor owns. A different id is refused. */
  ownedMerchantId?: string;
  /** Scopes requested. Refund and payout are refused, not dropped. */
  scopes: readonly string[];
  kybStatus?: 'none' | 'pending' | 'approved' | 'rejected';
  /** Operational status. Suspended and closed strip the grant. */
  merchantStatus?: 'pending' | 'active' | 'suspended' | 'closed';
  /** Person the scopes would be attached to. Must be the owner user. */
  actorUserId?: string;
  /** User id stored as the merchant owner. */
  ownerUserId?: string;
  /**
   * Team role. Only `owner` is granted here. Other roles keep the existing
   * role-table permissions and do not receive owner pay scopes.
   */
  role?: MerchantPayGrantRole;
};

function refuse(message: string): never {
  throw new MerchantPayScopeGrantError(message, 'auth.merchant_pay_scope_grant_refused', MERCHANT_PAY_SCOPE_GRANT_RESIDUAL);
}

function assertMerchantPayScopes(scopes: readonly string[]): asserts scopes is readonly MerchantPayScope[] {
  if (scopes.length === 0) {
    refuse('merchant pay scope grant requires at least one pay:* scope');
  }
  for (const scope of scopes) {
    if (!isScope(scope) || !(MERCHANT_PAY_SCOPES as readonly string[]).includes(scope)) {
      refuse(`scope "${scope}" is not a merchant acquiring pay:* scope`);
    }
  }
}

/**
 * Gate for issuing merchant `pay:*` scopes.
 *
 * Allows only `pay:read` and `pay:write`, for the owner of `merchantId`,
 * when KYB is approved and the merchant is not suspended or closed.
 */
export function assertMerchantPayScopeGrantAllowed(request: MerchantPayScopeGrantRequest): void {
  assertMerchantPayScopes(request.scopes);
  for (const scope of request.scopes) {
    if (scope === 'pay:refund' || scope === 'pay:payout') {
      refuse('pay:refund and pay:payout are not granted by the owner pay-scope law');
    }
  }
  if (request.role !== 'owner') {
    refuse('merchant pay scopes are granted only to the merchant owner');
  }
  const actor = request.actorUserId?.trim() ?? '';
  const owner = request.ownerUserId?.trim() ?? '';
  if (!actor || !owner || actor !== owner) {
    refuse('merchant pay scopes are granted only to the user who owns the merchant');
  }
  const owned = request.ownedMerchantId?.trim() ?? '';
  if (!request.merchantId || !owned || owned !== request.merchantId) {
    refuse('merchant pay scopes are granted for the owned merchant only');
  }
  if (request.kybStatus !== 'approved') {
    refuse('merchant pay scopes require approved KYB');
  }
  if (request.merchantStatus === 'suspended' || request.merchantStatus === 'closed') {
    refuse(`merchant pay scopes are refused while the merchant is ${request.merchantStatus}`);
  }
  if (request.merchantStatus !== 'active' && request.merchantStatus !== 'pending') {
    refuse('merchant pay scopes require a pending or active merchant');
  }
}

/**
 * Named issuance operation (ADR A1). Returns the requested owner scopes for
 * `merchantId`, or refuses. Never adds refund, payout, or a second merchant.
 */
export function issueMerchantPayScopes(request: MerchantPayScopeGrantRequest): {
  scopes: readonly OwnerMerchantPayScope[];
  merchantId: string;
} {
  assertMerchantPayScopeGrantAllowed(request);
  const wanted = new Set(request.scopes);
  const scopes = OWNER_MERCHANT_PAY_SCOPES.filter((scope) => wanted.has(scope));
  return { scopes, merchantId: request.merchantId };
}

/** Type guard helper for callers assembling grant requests. */
export function isMerchantPayScope(scope: Scope | string): scope is MerchantPayScope {
  return (MERCHANT_PAY_SCOPES as readonly string[]).includes(scope);
}
