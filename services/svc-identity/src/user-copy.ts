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
  'auth.email_confirm_invalid': 'That confirmation link is not valid. Request a new one.',
  'auth.email_confirm_unwired': 'Email confirmation is not available yet.',
  'auth.email_confirm_rate_limited': 'Too many confirmation emails. Try again later.',
  'auth.change_unwired': 'Changing this contact is not available yet.',
  'auth.step_up_required': "Confirm it's you with a passkey or authenticator code.",
  'auth.step_up_expired': 'That confirmation expired. Confirm again.',
  'identity.contact_code_invalid': 'That code is not valid. Request a new one.',
  'identity.email_invalid': 'Enter a valid email address.',
  'identity.phone_invalid': 'Enter a phone number in international format, starting with +.',
  'identity.phone_missing': 'There is no phone number on this account.',
  'identity.passkey_limit': 'This account has reached the number of passkeys it can hold. Remove one to add another.',
  'identity.passkey_label_invalid': 'Use 1 to 64 characters for a passkey name, with no control characters.',
  'identity.step_up_required': 'Confirm this change with your passkey or authenticator code first.',
  'identity.totp_label_invalid': 'Use a name of 1 to 64 characters, without hidden or control characters.',
  'identity.second_factor_required': 'Add a passkey or authenticator app first, then confirm this change with it.',
  'identity.step_up_expired': 'That confirmation expired. Confirm the change again.',
  'identity.step_up_used': 'That confirmation was already used. Confirm the change again.',
  'identity.step_up_not_yours': 'That confirmation belongs to a different sign-in. Confirm the change again.',
  'identity.step_up_target': 'That confirmation does not match this change. Confirm it again.',
  'identity.delegated_refused': 'Sign in on this device. An API key or a sub-account cannot change this.',
  'identity.region_change_requires_review': 'Region is reviewed by the desk. You cannot change it here.',
  'identity.profile_version_conflict': 'Your profile was updated somewhere else. Review it and try again.',
  'identity.display_name_invalid': 'Use a display name of 1 to 60 characters, without hidden or control characters.',
  'identity.handle_impersonation': "That display name matches someone else's handle. Choose a different name.",
  'identity.locale_unsupported': 'That language is not available.',
  'identity.profile_no_change': 'Nothing in your profile changed.',
  'identity.profile_missing': 'Your profile is not available.',
  'identity.profile_unwired': 'Profile edits are not available yet.',
  'identity.account_unwired': 'Contact changes are not available yet.',
  'identity.close_disabled': 'Closing an account is not available yet.',
  'identity.close_cooling_off_unset': 'Closing an account is not available yet. The cooling-off period is not published.',
  'identity.close_account_not_active': 'This account cannot be closed while it is not active.',
  'identity.close_founder_forbidden': 'This account cannot be closed.',
  'identity.close_restricted': 'This account is restricted. Clear the restriction, then try again.',
  'identity.close_delegated': 'Sign in on this device. An API key or a sub-account cannot close this account.',
  'identity.account_frozen_self': 'You froze this account. Lift the freeze before doing this.',
  'identity.close_blocked': 'Something on this account is still open. Clear it, then try again.',
  'identity.close_check_unavailable': 'We could not confirm that nothing is still open. Try again later.',
  'identity.close_nothing_open': 'There is no open closure request to cancel.',
  'identity.sub_account_delete_delegated': 'Sign in on this device. An API key or a sub-account cannot delete a sub-account.',
  'identity.sub_account_not_found': 'That sub-account was not found.',
  'identity.sub_account_delete_blocked': 'This sub-account still has assets or open orders. Move or clear them, then try again.',
  'identity.sub_account_check_unavailable': 'We could not confirm that this sub-account is empty. Try again later.',
  'identity.close_finalize_limit_unset': 'The finalize limit is not set.',
  'identity.closure_list_limit_unset': 'The list limit is not set.',
  'identity.closure_list_cursor_invalid': 'That page cursor is not valid.',
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
