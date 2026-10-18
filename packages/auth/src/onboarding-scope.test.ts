import { describe, expect, it } from 'vitest';
import { issueMerchantOnboardingScope, onboardingEligible, type OnboardingUser } from './onboarding-scope.js';

const eligible: OnboardingUser = { accountStatus: 'active', emailVerified: true, secondFactorEnrolled: true };

describe('onboardingEligible', () => {
  it('requires an active account, a verified email, and a second factor', () => {
    expect(onboardingEligible(eligible)).toBe(true);
    expect(onboardingEligible({ ...eligible, accountStatus: 'frozen' })).toBe(false);
    expect(onboardingEligible({ ...eligible, emailVerified: false })).toBe(false);
    expect(onboardingEligible({ ...eligible, secondFactorEnrolled: false })).toBe(false);
  });
});

describe('issueMerchantOnboardingScope', () => {
  it('grants pay:onboard when there is no merchant', () => {
    expect(issueMerchantOnboardingScope({ user: eligible, merchant: null })).toEqual(['pay:onboard']);
  });

  it('grants it to the owner of a root merchant that is pending or active', () => {
    expect(issueMerchantOnboardingScope({ user: eligible, merchant: { parentMerchantId: null, status: 'pending' } })).toEqual([
      'pay:onboard',
    ]);
    expect(issueMerchantOnboardingScope({ user: eligible, merchant: { parentMerchantId: null, status: 'active' } })).toEqual([
      'pay:onboard',
    ]);
  });

  it('refuses a child row, a suspended merchant, a closed merchant, and an ineligible person', () => {
    const child = { parentMerchantId: '11111111-1111-4111-8111-111111111111', status: 'active' as const };
    expect(issueMerchantOnboardingScope({ user: eligible, merchant: child })).toEqual([]);
    expect(issueMerchantOnboardingScope({ user: eligible, merchant: { parentMerchantId: null, status: 'suspended' } })).toEqual([]);
    expect(issueMerchantOnboardingScope({ user: eligible, merchant: { parentMerchantId: null, status: 'closed' } })).toEqual([]);
    expect(issueMerchantOnboardingScope({ user: { ...eligible, emailVerified: false }, merchant: null })).toEqual([]);
  });
});
