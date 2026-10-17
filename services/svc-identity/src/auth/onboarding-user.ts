/**
 * Maps a stored identity row onto the onboarding predicate.
 *
 * `identity.users` has no email-confirmation column. The stored address is
 * the only signal this mapper has. Change `emailVerifiedForOnboarding` when
 * a confirmation column exists; `onboardingEligible` stays the formula.
 */

import type { OnboardingUser } from '@intafaced/auth';

export function emailVerifiedForOnboarding(email: string | null | undefined): boolean {
  const stored = email?.trim() ?? '';
  return stored.length > 3 && stored.includes('@');
}

export function secondFactorEnrolled(row: { totp_secret: string | null; webauthn_creds: unknown }): boolean {
  if (row.totp_secret) return true;
  return Array.isArray(row.webauthn_creds) && row.webauthn_creds.length > 0;
}

export function onboardingUserFromRow(row: {
  status: string;
  email: string;
  totp_secret: string | null;
  webauthn_creds: unknown;
}): OnboardingUser {
  return {
    accountStatus: row.status,
    emailVerified: emailVerifiedForOnboarding(row.email),
    secondFactorEnrolled: secondFactorEnrolled(row),
  };
}
