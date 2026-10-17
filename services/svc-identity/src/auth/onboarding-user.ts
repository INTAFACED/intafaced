/**
 * Maps a stored identity row onto the onboarding predicate.
 *
 * `identity.users` has no email-confirmation column, so email is never
 * treated as confirmed yet. Change `emailVerifiedForOnboarding` when a
 * confirmation column exists; `onboardingEligible` stays the formula.
 */

import type { OnboardingUser } from '@intafaced/auth';

/**
 * Identity has no email-confirmation signal yet, so no address counts as
 * confirmed and onboarding fails closed (Nitro 10-17: confirmed email + 2FA).
 * Read the confirmation column here once email confirmation ships.
 */
export function emailVerifiedForOnboarding(_email: string | null | undefined): boolean {
  return false;
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
