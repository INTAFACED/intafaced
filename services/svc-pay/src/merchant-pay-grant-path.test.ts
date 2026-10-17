import { describe, expect, it } from 'vitest';
import { MerchantPayScopeGrantError, grantedOwnerPayScopes, issueMerchantPayScopesViaGrantPath } from './merchant-pay-grant-path.js';

const MERCHANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const OWNER = '22222222-2222-4222-8222-222222222222';

const approved = {
  id: MERCHANT,
  userId: OWNER,
  kybStatus: 'approved' as const,
  status: 'active' as const,
};

describe('merchant pay grant path call site', () => {
  it('issues pay:read and pay:write for the approved owner through the named op', () => {
    const issued = issueMerchantPayScopesViaGrantPath({
      merchantId: MERCHANT,
      ownedMerchantId: MERCHANT,
      scopes: ['pay:read', 'pay:write'],
      kybStatus: 'approved',
      merchantStatus: 'active',
      actorUserId: OWNER,
      ownerUserId: OWNER,
      role: 'owner',
    });
    expect(issued).toEqual({ scopes: ['pay:read', 'pay:write'], merchantId: MERCHANT });
    expect(grantedOwnerPayScopes(approved, OWNER)).toEqual({
      merchantId: MERCHANT,
      scopes: ['pay:read', 'pay:write'],
    });
  });

  it('refuses pending and rejected KYB, a non-owner row, and a different merchant id', () => {
    expect(grantedOwnerPayScopes({ ...approved, kybStatus: 'pending' }, OWNER).scopes).toEqual([]);
    expect(grantedOwnerPayScopes({ ...approved, kybStatus: 'rejected' }, OWNER).scopes).toEqual([]);
    expect(grantedOwnerPayScopes(approved, OTHER)).toEqual({ merchantId: null, scopes: [] });
    expect(grantedOwnerPayScopes(null, OWNER)).toEqual({ merchantId: null, scopes: [] });
    expect(() =>
      issueMerchantPayScopesViaGrantPath({
        merchantId: OTHER,
        ownedMerchantId: MERCHANT,
        scopes: ['pay:read', 'pay:write'],
        kybStatus: 'approved',
        merchantStatus: 'active',
        actorUserId: OWNER,
        ownerUserId: OWNER,
        role: 'owner',
      }),
    ).toThrow(MerchantPayScopeGrantError);
  });

  it('refuses suspended and closed merchants and does not grant team roles', () => {
    expect(grantedOwnerPayScopes({ ...approved, status: 'suspended' }, OWNER).scopes).toEqual([]);
    expect(grantedOwnerPayScopes({ ...approved, status: 'closed' }, OWNER).scopes).toEqual([]);
    expect(() =>
      issueMerchantPayScopesViaGrantPath({
        merchantId: MERCHANT,
        ownedMerchantId: MERCHANT,
        scopes: ['pay:read', 'pay:write'],
        kybStatus: 'approved',
        merchantStatus: 'active',
        actorUserId: OWNER,
        ownerUserId: OWNER,
        role: 'viewer',
      }),
    ).toThrow(MerchantPayScopeGrantError);
  });
});
