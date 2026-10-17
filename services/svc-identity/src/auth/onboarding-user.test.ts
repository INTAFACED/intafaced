import { describe, expect, it } from 'vitest';
import { issueMerchantOnboardingScope } from '@intafaced/auth';
import { emailVerifiedForOnboarding, onboardingUserFromRow, secondFactorEnrolled } from './onboarding-user.js';

const stamp = new Date('2026-10-17T00:00:00.000Z');

describe('onboarding user mapping', () => {
  it('treats a real confirmation stamp as verified and ignores the address text', () => {
    expect(emailVerifiedForOnboarding({ email_verified_at: stamp })).toBe(true);
    expect(emailVerifiedForOnboarding({ email_verified_at: '2026-10-17T00:00:00.000Z' })).toBe(true);
    expect(emailVerifiedForOnboarding({ email_verified_at: null })).toBe(false);
    expect(emailVerifiedForOnboarding({ email_verified_at: '' })).toBe(false);
    expect(emailVerifiedForOnboarding({ email_verified_at: 'not-a-date' })).toBe(false);
    expect(emailVerifiedForOnboarding({})).toBe(false);
  });

  it('counts a TOTP secret or a security key as a second factor', () => {
    expect(secondFactorEnrolled({ totp_secret: 'BASE32', webauthn_creds: [] })).toBe(true);
    expect(secondFactorEnrolled({ totp_secret: null, webauthn_creds: [{ credentialId: 'c' }] })).toBe(true);
    expect(secondFactorEnrolled({ totp_secret: null, webauthn_creds: [] })).toBe(false);
    expect(secondFactorEnrolled({ totp_secret: '', webauthn_creds: null })).toBe(false);
  });

  it('maps a row onto the onboarding predicate inputs', () => {
    expect(
      onboardingUserFromRow({
        status: 'active',
        email: 'owner@example.com',
        email_verified_at: stamp,
        totp_secret: 'BASE32',
        webauthn_creds: [],
      }),
    ).toEqual({
      accountStatus: 'active',
      emailVerified: true,
      secondFactorEnrolled: true,
    });
    expect(
      onboardingUserFromRow({
        status: 'active',
        email: 'owner@example.com',
        email_verified_at: null,
        totp_secret: 'BASE32',
        webauthn_creds: [],
      }),
    ).toEqual({
      accountStatus: 'active',
      emailVerified: false,
      secondFactorEnrolled: true,
    });
    expect(onboardingUserFromRow({ status: 'frozen', email: 'owner@example.com', totp_secret: null, webauthn_creds: [] })).toEqual({
      accountStatus: 'frozen',
      emailVerified: false,
      secondFactorEnrolled: false,
    });
  });

  it('issues pay:onboard only for an active confirmed account with a second factor', () => {
    const confirmed = onboardingUserFromRow({
      status: 'active',
      email: 'owner@example.com',
      email_verified_at: stamp,
      totp_secret: 'BASE32',
      webauthn_creds: [],
    });
    expect(issueMerchantOnboardingScope({ user: confirmed, merchant: null })).toEqual(['pay:onboard']);
    expect(
      issueMerchantOnboardingScope({
        user: onboardingUserFromRow({ ...confirmedRow(), email_verified_at: null }),
        merchant: null,
      }),
    ).toEqual([]);
    expect(
      issueMerchantOnboardingScope({
        user: onboardingUserFromRow({ ...confirmedRow(), totp_secret: null, webauthn_creds: [] }),
        merchant: null,
      }),
    ).toEqual([]);
    expect(
      issueMerchantOnboardingScope({
        user: onboardingUserFromRow({ ...confirmedRow(), status: 'frozen' }),
        merchant: null,
      }),
    ).toEqual([]);
  });
});

function confirmedRow() {
  return {
    status: 'active',
    email: 'owner@example.com',
    email_verified_at: stamp,
    totp_secret: 'BASE32' as string | null,
    webauthn_creds: [] as unknown,
  };
}
