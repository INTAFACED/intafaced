import { describe, expect, it } from 'vitest';
import { kybDecisionBindingSchema } from '@intafaced/contracts';
import {
  PAY_KYB_DECIDE,
  PAY_MERCHANT_DECIDE_KYB,
  kybApprovalFields,
  kybBindingMatches,
  kybDecisionBindingView,
  kybDecisionFields,
  kybDecisionPayloadHash,
  kybIdentityHash,
  type KybDecisionBinding,
} from './kyb-decision-binding.js';

const IDENTITY = {
  legalName: 'Shop Ltd',
  address: { line1: '1 Market', line2: null, city: 'Berlin', region: null, postalCode: '10115', country: 'DE' },
  statementDescriptor: 'SHOP',
  industry: 'Retail',
};

describe('KYB decision binding', () => {
  it('binds the approval to the identity hash and leaves profile version out', () => {
    const identityHash = kybIdentityHash(IDENTITY);
    const reviewed = kybDecisionFields({ merchantId: 'm', decision: 'approved', identityHash });
    expect(reviewed).toEqual({ decision: 'approved', identityHash, merchantId: 'm' });
    expect(reviewed).not.toHaveProperty('profileVersion');
    const proposed = kybDecisionPayloadHash(PAY_MERCHANT_DECIDE_KYB, reviewed);
    expect(proposed).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(proposed).not.toBe(
      kybDecisionPayloadHash(
        PAY_MERCHANT_DECIDE_KYB,
        kybDecisionFields({
          merchantId: 'm',
          decision: 'approved',
          identityHash: kybIdentityHash({ ...IDENTITY, legalName: 'Other Ltd' }),
        }),
      ),
    );
    expect(proposed).not.toBe(kybDecisionPayloadHash(PAY_KYB_DECIDE, reviewed));
    const withReason = kybApprovalFields({
      merchantId: 'm',
      decision: 'approved',
      identityHash,
      reason: 'dossier matches',
    });
    expect(withReason).toEqual({ ...reviewed, reason: 'dossier matches' });
    expect(kybDecisionPayloadHash(PAY_KYB_DECIDE, withReason)).not.toBe(
      kybDecisionPayloadHash(
        PAY_KYB_DECIDE,
        kybApprovalFields({ merchantId: 'm', decision: 'approved', identityHash, reason: 'other reason' }),
      ),
    );
    expect(kybApprovalFields({ merchantId: 'm', decision: 'approved', identityHash })).toEqual(reviewed);
    expect(kybIdentityHash({ ...IDENTITY, statementDescriptor: 'OTHER' })).not.toBe(identityHash);
    expect(kybIdentityHash({ ...IDENTITY, industry: 'Other' })).not.toBe(identityHash);
    expect(
      kybIdentityHash({
        ...IDENTITY,
        address: { ...IDENTITY.address, line1: '2 Market' },
      }),
    ).not.toBe(identityHash);
    expect(kybIdentityHash(IDENTITY)).toBe(identityHash);
  });

  it('matches only the identity hash that was reviewed', () => {
    const identityHash = kybIdentityHash(IDENTITY);
    expect(kybBindingMatches({ identityHash }, { identityHash })).toBe(true);
    expect(kybBindingMatches({ identityHash }, { identityHash: kybIdentityHash({ ...IDENTITY, legalName: null }) })).toBe(false);
    expect(kybBindingMatches({ identityHash }, { identityHash: '' })).toBe(false);
  });

  it('the compliance read is the identity fields plus the hash', () => {
    const identityHash = kybIdentityHash(IDENTITY);
    const binding: KybDecisionBinding = {
      merchantId: '11111111-1111-4111-8111-111111111111',
      identity: IDENTITY,
      identityHash,
      fields: () => ({}),
    };
    const view = kybDecisionBindingView(binding);
    expect(kybDecisionBindingSchema.parse(view)).toEqual({
      merchantId: binding.merchantId,
      legalName: 'Shop Ltd',
      address: IDENTITY.address,
      statementDescriptor: 'SHOP',
      industry: 'Retail',
      identityHash,
    });
    expect(kybDecisionBindingSchema.safeParse({ ...view, profileVersion: '3' }).success).toBe(false);
    expect(kybDecisionBindingSchema.safeParse({ ...view, website: 'https://shop.example' }).success).toBe(false);
  });
});
