import { describe, expect, it } from 'vitest';
import { SESSION_SCOPES, WITHHELD_FROM_SESSION } from './scopes.js';
import {
  MERCHANT_PAY_SCOPE_GRANT_RESIDUAL,
  MERCHANT_PAY_SCOPES,
  MerchantPayScopeGrantError,
  assertMerchantPayScopeGrantAllowed,
  isMerchantPayScope,
  issueMerchantPayScopes,
  type MerchantPayScopeGrantRequest,
} from './merchant-pay-scope-grant.js';

const MERCHANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const OWNER = '22222222-2222-4222-8222-222222222222';

function ownerRequest(patch: Partial<MerchantPayScopeGrantRequest> = {}): MerchantPayScopeGrantRequest {
  return {
    merchantId: MERCHANT,
    ownedMerchantId: MERCHANT,
    scopes: ['pay:read', 'pay:write'],
    kybStatus: 'approved',
    merchantStatus: 'active',
    actorUserId: OWNER,
    ownerUserId: OWNER,
    role: 'owner',
    ...patch,
  };
}

function refusal(request: MerchantPayScopeGrantRequest): MerchantPayScopeGrantError {
  try {
    issueMerchantPayScopes(request);
  } catch (err) {
    expect(err).toBeInstanceOf(MerchantPayScopeGrantError);
    return err as MerchantPayScopeGrantError;
  }
  throw new Error('expected the grant to refuse');
}

describe('merchant pay scope grant (owner law, 2026-10-17)', () => {
  it('keeps all four pay:* scopes out of ordinary sessions', () => {
    for (const scope of MERCHANT_PAY_SCOPES) {
      expect(SESSION_SCOPES).not.toContain(scope);
      expect(WITHHELD_FROM_SESSION[scope]).toMatch(/merchant/i);
    }
  });

  it('grants pay:read and pay:write to the owner of one approved merchant', () => {
    const issued = issueMerchantPayScopes(ownerRequest());
    expect(issued).toEqual({ scopes: ['pay:read', 'pay:write'], merchantId: MERCHANT });
    expect(issued.scopes).not.toContain('pay:refund');
    expect(issued.scopes).not.toContain('pay:payout');
    expect(() => assertMerchantPayScopeGrantAllowed(ownerRequest())).not.toThrow();
  });

  it('grants the same scopes while the merchant is still pending, once KYB is approved', () => {
    expect(issueMerchantPayScopes(ownerRequest({ merchantStatus: 'pending' })).scopes).toEqual(['pay:read', 'pay:write']);
  });

  it('refuses the owner when KYB is pending, rejected, or unset', () => {
    for (const kybStatus of ['pending', 'rejected', 'none', undefined] as const) {
      const err = refusal(ownerRequest({ kybStatus }));
      expect(err.code).toBe('auth.merchant_pay_scope_grant_refused');
      expect(err.message).toMatch(/approved KYB/);
      expect(err.residual).toBe(MERCHANT_PAY_SCOPE_GRANT_RESIDUAL);
    }
  });

  it('refuses admin, finance, developer, and viewer — the role table is not an owner grant', () => {
    for (const role of ['admin', 'finance', 'developer', 'viewer'] as const) {
      const err = refusal(ownerRequest({ role }));
      expect(err.code).toBe('auth.merchant_pay_scope_grant_refused');
      expect(err.message).toMatch(/only to the merchant owner/);
    }
    expect(refusal(ownerRequest({ role: undefined })).message).toMatch(/only to the merchant owner/);
  });

  it('refuses a grant for a merchant id the caller does not own', () => {
    const err = refusal(ownerRequest({ merchantId: OTHER }));
    expect(err.code).toBe('auth.merchant_pay_scope_grant_refused');
    expect(err.message).toMatch(/owned merchant only/);
    expect(refusal(ownerRequest({ ownedMerchantId: OTHER })).message).toMatch(/owned merchant only/);
  });

  it('refuses a suspended or closed merchant', () => {
    expect(refusal(ownerRequest({ merchantStatus: 'suspended' })).message).toMatch(/suspended/);
    expect(refusal(ownerRequest({ merchantStatus: 'closed' })).message).toMatch(/closed/);
    expect(refusal(ownerRequest({ merchantStatus: undefined })).message).toMatch(/pending or active/);
  });

  it('refuses refund and payout instead of dropping them from an otherwise valid grant', () => {
    expect(refusal(ownerRequest({ scopes: ['pay:read', 'pay:write', 'pay:refund'] })).message).toMatch(/not granted/);
    expect(refusal(ownerRequest({ scopes: ['pay:payout'] })).message).toMatch(/not granted/);
  });

  it('refuses an actor who is not the stored owner, and an empty scope list', () => {
    expect(refusal(ownerRequest({ actorUserId: OTHER })).message).toMatch(/user who owns/);
    expect(refusal(ownerRequest({ scopes: [] })).message).toMatch(/at least one/);
    expect(refusal(ownerRequest({ scopes: ['trade:write'] })).message).toMatch(/not a merchant acquiring/);
  });

  it('identifies merchant pay scopes', () => {
    expect(isMerchantPayScope('pay:write')).toBe(true);
    expect(isMerchantPayScope('pay:refund')).toBe(true);
    expect(isMerchantPayScope('trade:write')).toBe(false);
  });
});
