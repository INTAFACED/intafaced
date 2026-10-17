import { describe, expect, it } from 'vitest';
import { emailVerifiedForOnboarding, onboardingUserFromRow, secondFactorEnrolled } from './onboarding-user.js';

describe('onboarding user mapping', () => {
  it('treats a stored email address as the verification signal', () => {
    expect(emailVerifiedForOnboarding('a@b.co')).toBe(true);
    expect(emailVerifiedForOnboarding('   ')).toBe(false);
    expect(emailVerifiedForOnboarding('not-an-email')).toBe(false);
    expect(emailVerifiedForOnboarding(null)).toBe(false);
  });

  it('counts a TOTP secret or a security key as a second factor', () => {
    expect(secondFactorEnrolled({ totp_secret: 'BASE32', webauthn_creds: [] })).toBe(true);
    expect(secondFactorEnrolled({ totp_secret: null, webauthn_creds: [{ credentialId: 'c' }] })).toBe(true);
    expect(secondFactorEnrolled({ totp_secret: null, webauthn_creds: [] })).toBe(false);
    expect(secondFactorEnrolled({ totp_secret: '', webauthn_creds: null })).toBe(false);
  });

  it('maps a row onto the onboarding predicate inputs', () => {
    expect(onboardingUserFromRow({ status: 'active', email: 'owner@example.com', totp_secret: 'BASE32', webauthn_creds: [] })).toEqual({
      accountStatus: 'active',
      emailVerified: true,
      secondFactorEnrolled: true,
    });
    expect(onboardingUserFromRow({ status: 'frozen', email: 'owner@example.com', totp_secret: null, webauthn_creds: [] })).toEqual({
      accountStatus: 'frozen',
      emailVerified: true,
      secondFactorEnrolled: false,
    });
  });
});
