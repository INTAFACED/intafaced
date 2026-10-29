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
  'auth.password_breached': 'That password is known from a data breach. Choose a different one.',
  'auth.reset_proof_invalid': 'That reset code is not valid. Request a new one.',
  'auth.reset_unwired': 'Password reset is not available yet.',
  'auth.email_confirm_invalid': 'That confirmation link is not valid. Request a new one.',
  'auth.email_confirm_unwired': 'Email confirmation is not available yet.',
  'auth.email_confirm_rate_limited': 'Too many confirmation emails. Try again later.',
  'kyc.attempts_exhausted': 'Too many rejected verification requests. Try again when the wait on the verification page ends.',
  'auth.change_unwired': 'Changing this contact is not available yet.',
  'auth.step_up_required': "Confirm it's you with a passkey or authenticator code.",
  'auth.step_up_expired': 'That confirmation expired. Confirm again.',
  'identity.contact_code_invalid': 'That code is not valid. Request a new one.',
  'identity.email_invalid': 'Enter a valid email address.',
  'identity.phone_invalid': 'Enter a phone number in international format, starting with +.',
  'identity.phone_missing': 'There is no phone number on this account.',
  'identity.passkey_limit': 'This account has reached the number of passkeys it can hold. Remove one to add another.',
  'identity.passkey_label_invalid': 'Use 1 to 64 characters for a passkey name, with no control characters.',
  'identity.passkey_purposes_invalid': 'Choose signing in, moving money out or security changes, or none for every action.',
  'auth.second_step_expired': 'This sign-in step timed out. Enter your password again.',
  'identity.step_up_required': 'Confirm this change with your passkey or authenticator code first.',
  'identity.last_signin_method': 'This is your last way to sign in. Add another before you remove it.',
  'identity.method_taken': 'That wallet already signs in to another account.',
  'identity.method_unverified': 'Prove your email address first, then you can sign in with a mailed code.',
  'identity.method_not_linked': 'That way to sign in is not on this account.',
  'identity.method_already_linked': 'That way to sign in is already on this account.',
  'identity.method_invalid': 'That is not a way to sign in this account can use.',
  'identity.wallet_kind_unsupported':
    'That wallet signs through a contract, which we cannot check without a chain call. Use a wallet with its own key.',
  'identity.wallet_signature_invalid': 'That signature is not from this wallet. Nothing was changed.',
  'identity.wallet_challenge_invalid': 'That wallet message expired or was already answered. Start again.',
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
  'identity.self_freeze_lift_wait_unset': 'Lifting a freeze is not available yet. The waiting time is not published.',
  'identity.self_freeze_lift_too_soon': 'Your freeze can be lifted later. Try again after the waiting time.',
  'identity.security_locked': 'Your security lock is on, so this change is refused until the lock ends.',
  'identity.security_lock_unlock_wait_unset': 'Unlocking is not available. The waiting time is not published.',
  'identity.security_lock_not_found': 'That account was not found.',
  'identity.mfa_reset_unconfigured': 'Resetting the second step is not available yet. The waiting time is not published. Write to Support.',
  'identity.mfa_reset_not_enrolled': 'This account has no authenticator app to reset.',
  'identity.mfa_reset_no_proved_address': 'This account has no proved email address to send the reset code to. Write to Support.',
  'identity.support_recovery_not_found': 'There is no such recovery case or account.',
  'identity.support_recovery_self': 'You cannot open a recovery case for your own account.',
  'identity.support_recovery_account_inactive': 'This account is not active, so it cannot be recovered through Support.',
  'identity.support_recovery_no_proved_address': 'This account has no proved email address to send a recovery link to.',
  'identity.support_recovery_request_reused': 'That request id was already used for a different case.',
  'identity.support_recovery_not_open': 'This case is closed. Open a new one to send a link.',
  'identity.support_recovery_approval_required': 'A second person must approve this case before the link is sent.',
  'identity.support_recovery_unconfigured': 'Recovery links are not available yet. Their lifetime is not published.',
  'identity.support_recovery_link_invalid':
    'This recovery link does not work: it was already used, it expired, or the case was closed. Write to Support again.',
  'identity.death_notice_not_found': 'There is no such death notice or account.',
  'identity.death_notice_self': 'You cannot record or decide a death notice for your own account.',
  'identity.death_notice_account_closed': 'This account is closed, so a death notice cannot be recorded or confirmed for it.',
  'identity.death_notice_case_reused': 'That case reference was already recorded for this account with another reporter or other evidence.',
  'identity.death_notice_not_open': 'This notice was already decided.',
  'identity.death_notice_already_confirmed': 'Another death notice for this account is already confirmed.',
  'identity.death_notice_approval_required': 'A second person must approve this notice before it is confirmed.',
  'identity.close_blocked': 'Something on this account is still open. Clear it, then try again.',
  'identity.close_check_unavailable': 'We could not confirm that nothing is still open. Try again later.',
  'identity.close_nothing_open': 'There is no open closure request to cancel.',
  'identity.sub_account_delete_delegated': 'Sign in on this device. An API key or a sub-account cannot delete a sub-account.',
  'identity.sub_account_not_found': 'That sub-account was not found.',
  'identity.sub_account_delete_blocked': 'This sub-account still has assets or open orders. Move or clear them, then try again.',
  'identity.sub_account_check_unavailable': 'We could not confirm that this sub-account is empty. Try again later.',
  'identity.sub_account_revoked': 'That sub-account has been deleted.',
  'identity.sub_account_edit_delegated': 'Sign in on this device. An API key or a sub-account cannot edit a sub-account.',
  'identity.client_request_id_invalid': 'This request could not be read. Reload the page and try again.',
  'identity.sub_account_edit_unavailable': 'Editing sub-accounts is not available right now. Try again later.',
  'identity.sub_account_label_invalid': 'Use a label of 1 to 64 characters and a purpose of up to 200, with no control characters.',
  'identity.sub_account_frozen': 'This sub-account is frozen. Unfreeze it before changing its trading features.',
  'identity.sub_account_features_delegated': 'Sign in on this device. An API key or a sub-account cannot change trading features.',
  'identity.sub_account_features_unset': 'Trading features for sub-accounts are not available yet.',
  'identity.sub_account_feature_not_offered': 'That trading feature is not available for this kind of sub-account.',
  'identity.sub_account_feature_unavailable': 'That trading feature is not available for sub-accounts yet.',
  'identity.close_finalize_limit_unset': 'The finalize limit is not set.',
  'identity.closure_list_limit_unset': 'The list limit is not set.',
  'identity.closure_list_cursor_invalid': 'That page cursor is not valid.',
  'identity.anti_phishing_delegated': 'Sign in on this device. An API key or a sub-account cannot read or change the anti-phishing code.',
  'identity.anti_phishing_invalid': 'Use 4 to 20 letters and digits for the anti-phishing code.',
  'identity.anti_phishing_guessable': 'Pick a code that is not your handle, your email or your password.',
  'identity.anti_phishing_key_unset': 'Anti-phishing codes cannot be stored on this service: its encryption key is not set.',
  'identity.anti_phishing_unavailable': 'The anti-phishing code is not available on this service.',
  'identity.anti_phishing_unreadable': 'Your anti-phishing code cannot be read on this service. Set a new one, or remove it.',
  'identity.session_not_live': 'This sign-in has ended. Sign in again.',
  'auth.scope_empty': 'Choose at least one permission for the key.',
  'auth.scope_unknown': 'A permission on this key does not exist.',
  'auth.scope_interactive_only': 'A permission you chose cannot be put on a key made here.',
  'auth.scope_not_held': 'A key cannot hold a permission your sign-in does not have.',
  'auth.ip_invalid': 'Enter single IPv4 or IPv6 addresses, one per line.',
  'identity.key_name_invalid': 'Use a key name of 1 to 64 characters, with no control characters.',
  'identity.key_name_taken': 'You already have a key with this name. Choose another name.',
  'identity.key_expiry_invalid': 'Choose an end date in the future.',
  'identity.key_cap_unset': 'API keys cannot be made yet. The number of keys an account may hold is not set.',
  'identity.key_cap_reached': 'This account holds as many API keys as it may. Revoke one to make another.',
  'identity.key_request_conflict': 'This request was already used for a different key. Reload the page and try again.',
  'auth.passkey_missing': 'Add a passkey on Security first. Only an account with a passkey can hold API keys.',
  'auth.passkey_verify_unavailable': 'Use your passkey once to sign in or confirm, then make the key.',
  'identity.sandbox_name_invalid': 'Use a sandbox name of 1 to 40 characters, with no control characters.',
  'identity.sandbox_name_taken': 'You already have a sandbox with this name. Choose another name.',
  'identity.sandbox_cap_unset': 'Another sandbox cannot be made yet. The number of sandboxes an account may hold is not set.',
  'identity.sandbox_cap_reached': 'This account holds as many sandboxes as it may.',
  'identity.sandbox_request_conflict': 'This request was already used for a different sandbox. Reload the page and try again.',
  'identity.sandbox_not_found': 'This sandbox is not on your account.',
  'env.scope_not_sandboxable':
    'This permission can’t be used in a sandbox, so no key was made. A sandbox key can read and make test payments.',
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
