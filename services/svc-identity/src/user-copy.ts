/**
 * User-visible copy for `svc-identity` auth / KYC / rank refuse paths.
 *
 * Every string a client reads from a refuse or status path goes through
 * `@intafaced/i18n`. Mode is `prod` on purpose: a missing key must not throw
 * on a live sign-in refuse, and must not invent English — `tUnsafe` renders
 * the dotted key name, which is greppable and not blank.
 *
 * Catalog keys that already exist on tip are aliased from identity error codes.
 * Codes with no catalog row stay the code itself until a catalog PR adds copy.
 * Screening lists and KYC decisions are never invented here (Class X).
 */
import { createTranslator } from '@intafaced/i18n';
import { copyWithoutInsuredClaim } from './auth/insured-refuse.js';

const translator = createTranslator('en', undefined, { mode: 'prod', onMissing: () => undefined });

/**
 * Identity refuse codes that already have a catalog sentence. Unlisted codes
 * are passed through as keys — missing → dotted name, never invented copy.
 */
const CATALOG_ALIAS: Readonly<Record<string, string>> = {
  'auth.not_found': 'error.notFound',
  'auth.session_invalid': 'auth.session.expired',
  'auth.session_reused': 'auth.session.expired',
  'auth.mfa_required': 'auth.twofa.title',
  'auth.account_frozen': 'error.forbidden',
  'auth.sub_account_denied': 'error.forbidden',
  'auth.sub_account_revoked': 'error.forbidden',
  'auth.sub_account_limit': 'error.forbidden',
  'auth.privileged_enrolment_requires_invite': 'error.forbidden',
  'auth.mfa_not_enrolled': 'error.forbidden',
  'auth.webauthn_not_enrolled': 'error.forbidden',
};

/**
 * Sentences for codes that have no catalog row yet (`auth.changePassword`). They live here, in
 * one place, until a catalog PR moves them into `@intafaced/i18n`. `auth.invalid_credentials`
 * stays unkeyed on purpose (it is pinned to echo its key, same as login), and
 * `auth.mfa_required` already aliases a catalog row.
 */
const LOCAL_COPY: Readonly<Record<string, string>> = {
  'auth.password_unchanged': 'Choose a new password that is different from your current one.',
  'auth.password_policy': 'Choose a password of at least 12 characters and at most 72 bytes, and not one character repeated.',
  'auth.reset_proof_invalid': 'That reset code is not valid. Request a new one.',
  'auth.reset_unwired': 'Password reset is not available yet.',
};

export function userCopy(key: string, params: Readonly<Record<string, string | number | bigint>> = {}): string {
  const alias = typeof key === 'string' && Object.hasOwn(CATALOG_ALIAS, key) ? CATALOG_ALIAS[key] : undefined;
  if (typeof key === 'string' && Object.hasOwn(LOCAL_COPY, key)) return copyWithoutInsuredClaim(LOCAL_COPY[key]!);
  const lookup = typeof alias === 'string' ? alias : typeof key === 'string' ? key : '';
  // The catalog object inherits constructor / toString / __proto__. Passing the
  // key string is the echo; if that lookup throws or yields native source, keep the key.
  let rendered = lookup;
  try {
    const fromCatalog = translator.tUnsafe(lookup, params);
    if (typeof fromCatalog === 'string' && !fromCatalog.includes('[native code]')) rendered = fromCatalog;
  } catch {
    rendered = lookup;
  }
  return copyWithoutInsuredClaim(rendered);
}
