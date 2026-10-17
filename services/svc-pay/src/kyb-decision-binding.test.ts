import { describe, expect, it } from 'vitest';
import {
  PAY_KYB_DECIDE,
  PAY_MERCHANT_DECIDE_KYB,
  kybApprovalFields,
  kybBindingMatches,
  kybDecisionFields,
  kybDecisionPayloadHash,
  kybIdentityHash,
} from './kyb-decision-binding.js';

const IDENTITY = {
  legalName: 'Shop Ltd',
  address: { line1: '1 Market', line2: null, city: 'Berlin', region: null, postalCode: '10115', country: 'DE' },
  statementDescriptor: 'SHOP',
  industry: 'Retail',
};

describe('KYB decision binding', () => {
  it('changes the approval hash when the profile version or the identity changes', () => {
    const identityHash = kybIdentityHash(IDENTITY);
    const reviewed = kybDecisionFields({
      merchantId: 'm',
      decision: 'approved',
      profileVersion: '1',
      identityHash,
    });
    const proposed = kybDecisionPayloadHash(PAY_MERCHANT_DECIDE_KYB, reviewed);
    expect(proposed).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(proposed).not.toBe(
      kybDecisionPayloadHash(
        PAY_MERCHANT_DECIDE_KYB,
        kybDecisionFields({ merchantId: 'm', decision: 'approved', profileVersion: '2', identityHash }),
      ),
    );
    expect(proposed).not.toBe(
      kybDecisionPayloadHash(
        PAY_MERCHANT_DECIDE_KYB,
        kybDecisionFields({
          merchantId: 'm',
          decision: 'approved',
          profileVersion: '1',
          identityHash: kybIdentityHash({ ...IDENTITY, legalName: 'Other Ltd' }),
        }),
      ),
    );
    expect(proposed).not.toBe(kybDecisionPayloadHash(PAY_KYB_DECIDE, reviewed));
    const withReason = kybApprovalFields({
      merchantId: 'm',
      decision: 'approved',
      profileVersion: '1',
      identityHash,
      reason: 'dossier matches',
    });
    expect(withReason).toEqual({ ...reviewed, reason: 'dossier matches' });
    expect(kybDecisionPayloadHash(PAY_KYB_DECIDE, withReason)).not.toBe(
      kybDecisionPayloadHash(
        PAY_KYB_DECIDE,
        kybApprovalFields({ merchantId: 'm', decision: 'approved', profileVersion: '1', identityHash, reason: 'other reason' }),
      ),
    );
    expect(kybApprovalFields({ merchantId: 'm', decision: 'approved', profileVersion: '1', identityHash })).toEqual(reviewed);
    expect(kybIdentityHash({ ...IDENTITY, statementDescriptor: 'OTHER' })).not.toBe(identityHash);
    expect(kybIdentityHash({ ...IDENTITY, industry: 'Other' })).not.toBe(identityHash);
    expect(
      kybIdentityHash({
        ...IDENTITY,
        address: { ...IDENTITY.address, line1: '2 Market' },
      }),
    ).not.toBe(identityHash);
  });

  it('matches only the version and identity hash that were reviewed', () => {
    const identityHash = kybIdentityHash(IDENTITY);
    const live = { profileVersion: '3', identityHash };
    expect(kybBindingMatches(live, { profileVersion: '3', identityHash })).toBe(true);
    expect(kybBindingMatches(live, { profileVersion: '2', identityHash })).toBe(false);
    expect(kybBindingMatches(live, { profileVersion: '3', identityHash: kybIdentityHash({ ...IDENTITY, legalName: null }) })).toBe(false);
  });
});
