import { loadProfile } from '../owner-settings.mjs';
import path from 'node:path';
import { confirmFounderEmails } from '../local-test-founders.mjs';
import { founderTotp, makeContext } from '../local-test-gates.mjs';
import { LOCAL_TEST_DEVICE_KEY } from '../local-test-device.mjs';

/** One labelled TEST value from this service's profile file; a missing one names the file instead of a bare TypeError. */
function testValue(name) {
  const entry = loadProfile().values[name];
  if (!entry) throw new Error(`${name} is missing from tooling/profiles/test-owner-values/identity.json.`);
  return entry.value;
}

/**
 * LOCAL TEST ONLY. A founder's address is confirmed like anyone's, so a new browser in the console is mailed its approval
 * code. Only a console sign-in from a new browser needs it, so a failure is named and the stack still starts.
 */
export async function confirmLocalFounderEmails({ STATE, marker, edgeUrl, say }) {
  let ctx;
  try {
    await confirmFounderEmails({
      stateDir: STATE,
      marker,
      edgeUrl,
      log: say,
      signIn: async (f) => {
        ctx ??= await makeContext({ log: () => {} });
        const login = await ctx.edge.mutate('identity', 'auth.login', {
          identifier: f.handle,
          password: f.password,
          totpCode: await founderTotp(ctx, f.key, f.totpSecret),
          deviceKey: LOCAL_TEST_DEVICE_KEY,
        });
        const token = login.json?.result?.data?.accessToken;
        if (typeof token !== 'string') throw new Error(`founder ${f.key} could not sign in to confirm their email (${login.status})`);
        return token;
      },
    });
  } catch (err) {
    say(
      `  founders: email addresses not confirmed, so a new browser in the console gets no mailed code: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export default ({ c, secrets, dbUrl, urlOf, PORTS, STATE, CUSTOMER_LOCALHOST_ORIGIN, identityFounderEnv }) => ({
  name: 'identity',
  env: () => ({
    ...c('svc-identity', PORTS.identity),
    DATABASE_URL: dbUrl('svc_identity', secrets),
    LEDGER_URL: urlOf('ledger'),
    REGISTRATION_OPEN: 'true',
    // LOCAL TEST ONLY: passkeys on. Relying-party ID must be a hostname, so use localhost and open
    // http://localhost:3210 for passkeys. Not the production relying party.
    WEBAUTHN_ENABLED: 'true',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: 'INTAFACED (LOCAL TEST)',
    WEBAUTHN_ORIGIN: CUSTOMER_LOCALHOST_ORIGIN,
    IDENTITY_TRADE_ADMISSION_SECRET: secrets.tradeAdmission,
    IDENTITY_PAY_ADMISSION_SECRET: secrets.payAdmission,
    // Owner pay-scope grant. Identity asks pay at login. Unset leaves sessions without pay:*.
    PAY_URL: urlOf('pay'),
    // Edge reads each caller's current account authority with this key; without it
    // Edge refuses every signed-in token as 'invalid' and forwards anonymously.
    IDENTITY_EDGE_AUTHORITY_SECRET: secrets.edgeAuthority,
    // LOCAL TEST ONLY (Nitro, option B, 2026-10-13). Required, no default, owner-unpublished: how long a
    // two-person action approval lives. 600 s is a local test value, not an owner decision. The labelled
    // local test operators (tooling/scripts/local-test-gates.mjs) use it to open markets and verify
    // test accounts; "LOCAL TEST — not a real approval".
    IDENTITY_ACTION_APPROVAL_TTL_SECONDS: '600',
    // LOCAL TEST ONLY. The identity service refuses email confirmation until a mail
    // transport, a lifetime, and a rate budget are published. local-outbox is refused
    // at boot unless APP_ENV is exactly dev or test. These numbers are for this stack,
    // not an owner decision. The confirm link is written to the outbox file, labelled
    // LOCAL-TEST, and the merchant populate step reads it back through auth.confirmEmail.
    IDENTITY_MAIL_TRANSPORT: 'local-outbox',
    IDENTITY_LOCAL_MAIL_OUTBOX: path.join(STATE, 'email-outbox.log'),
    IDENTITY_EMAIL_CONFIRM_TTL_SECONDS: '600',
    IDENTITY_EMAIL_CONFIRM_RATE_MAX: '5',
    IDENTITY_EMAIL_CONFIRM_RATE_WINDOW_SECONDS: '3600',
    // LOCAL TEST ONLY. Sign-up refuses until the owner publishes its numbers (I-signin-sessions-18,
    // I-kyc-compliance-06). These are for this stack, not owner decisions: a code lives 10 minutes, five wrong
    // codes lock it, a new code after 30 seconds, ten sign-ups per address an hour. AQ is closed so the
    // journey can show the per-country switch refusing; it says nothing about any real country.
    IDENTITY_FLOW_SUBJECT_KEY: secrets.identityFlowSubject,
    IDENTITY_SIGNUP_MIN_AGE_YEARS: '18',
    IDENTITY_SIGNUP_CODE_TTL_SECONDS: '600',
    IDENTITY_SIGNUP_CODE_MAX_ATTEMPTS: '5',
    IDENTITY_SIGNUP_RESEND_SECONDS: '30',
    IDENTITY_SIGNUP_REQUEST_MAX: '10',
    IDENTITY_SIGNUP_REQUEST_WINDOW_SECONDS: '3600',
    IDENTITY_SIGNUP_CLOSED_COUNTRIES: 'AQ',
    // Sign-in by a mailed code (J-identity-02 #3): TEST values from the profile file, not owner decisions.
    IDENTITY_LOGIN_CODE_TTL_SECONDS: testValue('IDENTITY_LOGIN_CODE_TTL_SECONDS'),
    IDENTITY_LOGIN_CODE_MAX_ATTEMPTS: testValue('IDENTITY_LOGIN_CODE_MAX_ATTEMPTS'),
    IDENTITY_LOGIN_CODE_RESEND_SECONDS: testValue('IDENTITY_LOGIN_CODE_RESEND_SECONDS'),
    IDENTITY_LOGIN_CODE_REQUEST_MAX: testValue('IDENTITY_LOGIN_CODE_REQUEST_MAX'),
    IDENTITY_LOGIN_CODE_REQUEST_WINDOW_SECONDS: testValue('IDENTITY_LOGIN_CODE_REQUEST_WINDOW_SECONDS'),
    // Handle change cap (J-pay-03 #2): a TEST value from the profile file, not an owner decision.
    IDENTITY_HANDLE_CHANGE_MAX: testValue('IDENTITY_HANDLE_CHANGE_MAX'),
    // Password reset and username recovery (J-identity-03): TEST values from the profile file, not owner decisions.
    IDENTITY_PASSWORD_RESET_TTL_SECONDS: testValue('IDENTITY_PASSWORD_RESET_TTL_SECONDS'),
    IDENTITY_BREACHED_PASSWORDS_FILE: testValue('IDENTITY_BREACHED_PASSWORDS_FILE'),
    IDENTITY_PASSWORD_RESET_MAX_ATTEMPTS: testValue('IDENTITY_PASSWORD_RESET_MAX_ATTEMPTS'),
    IDENTITY_PASSWORD_RESET_REQUEST_MAX: testValue('IDENTITY_PASSWORD_RESET_REQUEST_MAX'),
    IDENTITY_PASSWORD_RESET_REQUEST_WINDOW_SECONDS: testValue('IDENTITY_PASSWORD_RESET_REQUEST_WINDOW_SECONDS'),
    IDENTITY_NEW_DEVICE_CHECK: testValue('IDENTITY_NEW_DEVICE_CHECK'),
    IDENTITY_NEW_DEVICE_TTL_SECONDS: testValue('IDENTITY_NEW_DEVICE_TTL_SECONDS'),
    IDENTITY_NEW_DEVICE_MAX_ATTEMPTS: testValue('IDENTITY_NEW_DEVICE_MAX_ATTEMPTS'),
    IDENTITY_MFA_RESET_WAIT_SECONDS: testValue('IDENTITY_MFA_RESET_WAIT_SECONDS'),
    IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS: testValue('IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS'),
    IDENTITY_KYC_REQUIREMENTS_BY_LEVEL: testValue('IDENTITY_KYC_REQUIREMENTS_BY_LEVEL'),
    IDENTITY_KYC_REVIEW_HOURS_BY_LEVEL: testValue('IDENTITY_KYC_REVIEW_HOURS_BY_LEVEL'),
    IDENTITY_KYC_REJECT_REASONS: testValue('IDENTITY_KYC_REJECT_REASONS'),
    IDENTITY_KYC_CAPABILITIES_BY_LEVEL: testValue('IDENTITY_KYC_CAPABILITIES_BY_LEVEL'),
    IDENTITY_KYC_CAPABILITY_REASONS: testValue('IDENTITY_KYC_CAPABILITY_REASONS'),
    IDENTITY_KYC_DOCUMENT_TYPES_BY_COUNTRY: testValue('IDENTITY_KYC_DOCUMENT_TYPES_BY_COUNTRY'),
    IDENTITY_KYC_UPLOAD_MAX_BYTES: testValue('IDENTITY_KYC_UPLOAD_MAX_BYTES'),
    IDENTITY_KYC_UPLOAD_TYPES: testValue('IDENTITY_KYC_UPLOAD_TYPES'),
    // `LOCAL_STACK_IDENTITY_POA_RULE=off` on a start or restart leaves the recency rule blank, so its refusal can be seen
    // too (J-identity-08 #5).
    ...(process.env.LOCAL_STACK_IDENTITY_POA_RULE === 'off'
      ? {}
      : { IDENTITY_KYC_POA_MAX_AGE_DAYS: testValue('IDENTITY_KYC_POA_MAX_AGE_DAYS') }),
    IDENTITY_KYC_POA_TYPES_BY_COUNTRY: testValue('IDENTITY_KYC_POA_TYPES_BY_COUNTRY'),
    IDENTITY_KYC_HANDOFF_TTL_SECONDS: testValue('IDENTITY_KYC_HANDOFF_TTL_SECONDS'),
    IDENTITY_KYC_MAX_DENIALS: testValue('IDENTITY_KYC_MAX_DENIALS'),
    IDENTITY_KYC_DENIAL_WINDOW_HOURS: testValue('IDENTITY_KYC_DENIAL_WINDOW_HOURS'),
    IDENTITY_KYC_LOCKOUT_HOURS: testValue('IDENTITY_KYC_LOCKOUT_HOURS'),
    IDENTITY_SUPPORT_RECOVERY_LINK_TTL_SECONDS: testValue('IDENTITY_SUPPORT_RECOVERY_LINK_TTL_SECONDS'),
    // LOCAL TEST ONLY, not an owner decision (W-withdraw-09): a security lock ends one day after its unlock is asked
    // for, so a journey can see the lock still holding with its end time.
    IDENTITY_SECURITY_LOCK_UNLOCK_WAIT_SECONDS: '86400',
    // Sealing key for operator second factors (TOTP). Generated per machine in secrets.json.
    IDENTITY_TOTP_SECRET_KEY: secrets.identityTotp,
    // LOCAL TEST ONLY: seals each API key's request-signing secret (secrets.json); a key that places orders signs
    // every request (DV-auth-01), so without it such a key is refused at creation.
    API_KEY_SIGNING_ENC_KEY: secrets.identityApiKeySigning,
    // The request-signing timestamp window (J-developer-04 #2, J-developer-02 #6): a TEST value, not an owner decision.
    // `LOCAL_STACK_IDENTITY_REQUEST_SIGN_WINDOW=off` on a start or restart leaves it blank, as production is until the
    // owner sets it, so a journey can see every signed request refused with auth.request_window_unset.
    IDENTITY_REQUEST_SIGN_WINDOW_SECONDS:
      process.env.LOCAL_STACK_IDENTITY_REQUEST_SIGN_WINDOW === 'off' ? '' : testValue('IDENTITY_REQUEST_SIGN_WINDOW_SECONDS'),
    // LOCAL TEST ONLY: the KYC document vault's key, generated for this stack (secrets.json, mode 600). Without it the vault is
    // off and the founder console's document list and viewer refuse kyc_doc.unwired.
    IDENTITY_KYC_DOC_KEY: secrets.identityKycDoc,
    // LOCAL TEST, not the lead's grant (which founder holds which scope is the lead's call for a real stack). The
    // operator reads the founder console makes: svc-bank's desks (admin:read), svc-p2p's
    // operator lists (admin:compliance), svc-market's vendor desk (market:ops), every svc-support operator door
    // (support:ops: the queue and request workspace at /support, help articles, help-centre and attachment settings,
    // contact channels and request forms), the support desk's read-only lookup of one customer's records in another
    // module (support:lookup: copy follows, bots and quotes on the trade desk), the notify desk's writes (admin:write: the status page and notices) and the
    // campaigns desk (campaigns:ops: build, ask, approve, go live). admin:write is platform wide: it also opens the other services' admin:write doors to a founder's
    // session here (svc-trade's insurance top-up among them), the same scope the local gates' operator tokens already
    // carry. Identity adds these only to a founder's own signed-in session with a second factor, never to an API key or a
    // sub-account. admin:treasury and every pay: scope stay off.
    IDENTITY_FOUNDER_SESSION_SCOPES: 'admin:read,admin:write,admin:compliance,market:ops,support:ops,support:lookup,campaigns:ops',
    // Sub-account cap: an explicit LOCAL TEST value, not an owner limit (the owner has not published one; blank
    // refuses every create with auth.sub_account_cap_unset). 10 live sub-accounts per account on this stack only.
    IDENTITY_MAX_SUB_ACCOUNTS: '10',
    // Watchlist and saved-screen caps (C-alerts-scan-05, -07): explicit LOCAL TEST values, not owner limits (the owner
    // has not published them; blank refuses every write that needs one). 10 named lists, 100 symbols per list, 10 screens.
    IDENTITY_WATCHLIST_LIST_CAP: '10',
    IDENTITY_WATCHLIST_SYMBOL_CAP: '100',
    IDENTITY_SAVED_SCREEN_CAP: '10',
    // The closure checks a close runs first (customer closure and the console's staff close): svc-bank, svc-trade and
    // svc-p2p answer for their own open products and balances, signed with this stack's shared service secret.
    IDENTITY_CLOSURE_BANK_URL: urlOf('bank'),
    IDENTITY_CLOSURE_TRADE_URL: urlOf('trade'),
    IDENTITY_CLOSURE_P2P_URL: urlOf('p2p'),
    // API key cap per verification level: an explicit LOCAL TEST value, not an owner limit (blank refuses every key
    // create in the developer room with identity.key_cap_unset). Three live keys per account on this stack, so
    // J-developer-03 can show the fourth refused.
    IDENTITY_API_KEYS_MAX_BY_TIER: 'none=3,basic=3,full=3,institutional=3',
    // LOCAL TEST named developer sandboxes (J-developer-02 #2, #3), labelled in the same profile, never an owner decision.
    // The code keeps no default: blank refuses a second sandbox with identity.sandbox_cap_unset, and
    // `LOCAL_STACK_IDENTITY_SANDBOX_CAP=off` on a start or restart leaves it blank so that refusal can be seen.
    ...(process.env.LOCAL_STACK_IDENTITY_SANDBOX_CAP === 'off'
      ? {}
      : { IDENTITY_SANDBOXES_MAX_BY_TIER: testValue('IDENTITY_SANDBOXES_MAX_BY_TIER') }),
    IDENTITY_SANDBOX_BASE_URL: testValue('IDENTITY_SANDBOX_BASE_URL'),
    // LOCAL TEST idle period for API keys (J-developer-03 #9), labelled in the same profile, never an owner decision: the
    // key detail shows it; no dormant sweep is built, so it ends no key. Blank shows `not set`.
    IDENTITY_API_KEY_IDLE_EXPIRY_SECONDS: testValue('IDENTITY_API_KEY_IDLE_EXPIRY_SECONDS'),
    // LOCAL TEST account tiers (J-ops-console-04 #11), labelled TEST, never an owner decision: the owner has published no
    // tiers (blank refuses every move with identity.account_tiers_unset). TEST Premier leaves its monthly fee blank on
    // purpose, so the console shows a tier that cannot be assigned (identity.tier_terms_unset).
    // One copy: the labelled TEST value in tooling/profiles/test-owner-values/identity.json.
    IDENTITY_ACCOUNT_TIERS: testValue('IDENTITY_ACCOUNT_TIERS'),
    // LOCAL TEST limit override policy (J-ops-console-04 #12), labelled TEST in the same profile, never an owner decision:
    // blank refuses every override with identity.limit_ceiling_unset.
    IDENTITY_LIMIT_OVERRIDE_POLICY: testValue('IDENTITY_LIMIT_OVERRIDE_POLICY'),
    // LOCAL TEST referral attach window and code length (J-campaigns-05), labelled TEST in the same profile. Blank refuses
    // every link attach (referral.attach_window_unset) and every new code (referral.code_length_unset).
    IDENTITY_REFERRAL_ATTACH_WINDOW_SECONDS: testValue('IDENTITY_REFERRAL_ATTACH_WINDOW_SECONDS'),
    IDENTITY_REFERRAL_CODE_LENGTH: testValue('IDENTITY_REFERRAL_CODE_LENGTH'),
    // LOCAL TEST referral lapse period and sweep cadence (J-campaigns-05 #7), same profile. Blank period refuses the sweep
    // (referral.lapse_period_unset); a blank cadence leaves the sweep timer off.
    IDENTITY_REFERRAL_LAPSE_PERIOD_SECONDS: testValue('IDENTITY_REFERRAL_LAPSE_PERIOD_SECONDS'),
    IDENTITY_REFERRAL_LAPSE_SWEEP_SECONDS: testValue('IDENTITY_REFERRAL_LAPSE_SWEEP_SECONDS'),
    // LOCAL TEST waitlist wave size (J-campaigns-20 #3), same profile. Blank refuses every release (drop.wave_unset).
    IDENTITY_WAITLIST_WAVE_SIZE: testValue('IDENTITY_WAITLIST_WAVE_SIZE'),
    // LOCAL TEST founder pair only: local_test_founder_a / local_test_founder_b from
    // <state>/founders.json. Absent until that vault exists. Never the Docker vault.
    ...identityFounderEnv(),
  }),
});
