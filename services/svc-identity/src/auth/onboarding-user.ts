/**
 * Maps a stored identity row onto the onboarding predicate.
 *
 * Confirmed email means `users.email_verified_at` is a real instant.
 * Changing the email clears that stamp (and consumes open proofs), so a
 * later address is not confirmed. `onboardingEligible` stays the formula:
 * active account, this confirmation, and a second factor.
 */

import type { OnboardingUser } from '@intafaced/auth';
import type { Sql } from 'postgres';
import { isEmailConfirmed } from './email-confirmation.js';

/**
 * True only when the confirmation stamp is a real instant. A missing column,
 * null, or junk fails closed. The address text is not a confirmation.
 */
export function emailVerifiedForOnboarding(row: { readonly email_verified_at?: Date | string | null }): boolean {
  return isEmailConfirmed(row);
}

export function secondFactorEnrolled(row: { totp_secret: string | null; webauthn_creds: unknown }): boolean {
  if (row.totp_secret) return true;
  return Array.isArray(row.webauthn_creds) && row.webauthn_creds.length > 0;
}

export type OnboardingStoredRow = {
  status: string;
  email: string;
  email_verified_at: Date | string | null;
  totp_secret: string | null;
  webauthn_creds: unknown;
};

export function onboardingUserFromRow(row: {
  status: string;
  email: string;
  email_verified_at?: Date | string | null;
  totp_secret: string | null;
  webauthn_creds: unknown;
}): OnboardingUser {
  return {
    accountStatus: row.status,
    emailVerified: emailVerifiedForOnboarding(row),
    secondFactorEnrolled: secondFactorEnrolled(row),
  };
}

/**
 * The one read that builds an onboarding user. Callers must not select a
 * narrower column list: omitting `email_verified_at` would look unconfirmed.
 */
export async function selectOnboardingUser(sql: Sql, userId: string): Promise<OnboardingUser | null> {
  const rows = await sql<OnboardingStoredRow[]>`
    SELECT status, email::text AS email, email_verified_at, totp_secret, webauthn_creds
    FROM users WHERE id = ${userId} LIMIT 1
  `;
  const row = rows[0];
  return row ? onboardingUserFromRow(row) : null;
}
