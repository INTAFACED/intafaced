import { z } from 'zod';
import { authEnvSchema, edgeEnvSchema, internalServiceEnvSchema, loadEnv, s2sEnvSchema, serviceEnvSchema } from '@intafaced/config';
import { founderSessionScopesFromEnv } from '@intafaced/auth';
import { assertWebauthnPosture } from './webauthn-posture.js';
import { parseInviteExpiry, parseInviteHashes } from './auth/founder-enrolment.js';
import { parseRefreshRecoverySeconds } from './auth/refresh-cookie.js';
import { parseDisplayCurrencyList } from './preferences/account-display.js';
import { parseMembershipTiers } from './membership/membership-offer.js';
import { parseSelfFreezeLiftWait } from './auth/self-freeze-lift.js';
import { parseSecurityLockUnlockWait } from './auth/security-lock.js';
import { parseMfaResetWait } from './auth/mfa-reset.js';

// Self-mounts /trpc — must authenticate the edge principal (see packages/contracts/src/edge.ts).
// INTERNAL_SERVICE_SECRET is required because rank.awardXp is a serviceProcedure
// (user sessions carry identity:write and must never mint rank).
const boolish = z
  .union([z.boolean(), z.string()])
  .default(true)
  .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase())));

/** Owner-published registration gate. Blank / unset → unpublished, never invented true. */
const registrationOpen = z.preprocess((v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' && v.trim() === '') return undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(s)) return true;
    if (['0', 'false', 'off', 'no'].includes(s)) return false;
  }
  return v;
}, z.boolean().optional());

/**
 * A founder-invite value that is either unset/blank (→ undefined, enrolment closed)
 * or valid. A malformed value fails boot with the parser's message; it is never
 * silently dropped, because a typo here would otherwise look like a closed door.
 */
function founderInviteVar<T>(parse: (raw: string) => T | undefined) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): string | undefined => {
      try {
        return parse(raw ?? '') === undefined ? undefined : (raw ?? '').trim();
      } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: err instanceof Error ? err.message : 'invalid' });
        return z.NEVER;
      }
    });
}

const schema = serviceEnvSchema
  .merge(authEnvSchema)
  .merge(edgeEnvSchema)
  .merge(internalServiceEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-identity'),
      HTTP_PORT: z.coerce.number().int().default(4002),
      /**
       * Seconds a just-rotated refresh token may be presented again (two tabs).
       * Default 10. 0 disables the grace window. Ceiling 120.
       */
      REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(120).default(10),
      /**
       * Owner-published seconds after rotation during which a lost refresh reply
       * may be presented again, past the grace window. Blank, 0, or unset is off
       * (today's reuse burn). Never a default — blank is not 120. Ceiling 600.
       * Do not set this in compose or in a local env file; the lead publishes it.
       */
      REFRESH_RECOVERY_SECONDS: z
        .unknown()
        .optional()
        .transform((raw, ctx): number | undefined => {
          try {
            return parseRefreshRecoverySeconds(raw);
          } catch (err) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: err instanceof Error ? err.message : 'REFRESH_RECOVERY_SECONDS must be an integer',
            });
            return z.NEVER;
          }
        }),
      /** Existing verified platform UUIDs. Missing/malformed/duplicate pair disables controls. */
      IDENTITY_FOUNDER_NITRO_USER_ID: z.string().optional(),
      IDENTITY_FOUNDER_PHANTOM_USER_ID: z.string().optional(),
      /**
       * Founder enrolment (`auth.registerFounder`): two lowercase sha256 hex values,
       * comma-separated, of the single-use invite codes made by
       * `pnpm --filter @intafaced/svc-identity founder:invites`. Hashes only; the
       * codes are never configured. Blank / unset → enrolment closed. Never defaulted.
       * Malformed → fail boot.
       */
      IDENTITY_FOUNDER_INVITE_HASHES: founderInviteVar(parseInviteHashes),
      /**
       * ISO 8601 instant (with a zone) after which the invites above are refused,
       * about 72 h after they were generated. Blank / unset → enrolment closed.
       * Never defaulted. Malformed → fail boot.
       */
      IDENTITY_FOUNDER_INVITE_EXPIRES_AT: founderInviteVar(parseInviteExpiry),
      /** Independent owner keys; generic service/read credentials cannot admit operations. */
      IDENTITY_TRADE_ADMISSION_SECRET: z.string().min(32).optional(),
      IDENTITY_PAY_ADMISSION_SECRET: z.string().min(32).optional(),
      /** Dedicated private-stream read key; never the generic or owner admission key. */
      IDENTITY_WS_AUTHORITY_SECRET: z.string().min(32).optional(),
      /** Dedicated HTTP perimeter read key, scoped to authority and key policy. */
      IDENTITY_EDGE_AUTHORITY_SECRET: z.string().min(32).optional(),
      /**
       * Registration open? §11 gates this behind the drop sequence.
       * Blank / unset → unpublished; register refuses (`identity.registration_open_unset`).
       * Never git-default true — that looks published. Owner-explicit true is allowed.
       * Malformed → fail boot.
       */
      REGISTRATION_OPEN: registrationOpen,
      /**
       * WebAuthn relying party. Defaults suit local dev; production must set
       * the real registrable domain and HTTPS origin.
       */
      WEBAUTHN_RP_ID: z.string().min(1).default('localhost'),
      WEBAUTHN_RP_NAME: z.string().min(1).default('INTAFACED'),
      /** Comma-separated allowed origins for clientDataJSON.origin. */
      WEBAUTHN_ORIGIN: z.string().min(1).default('http://localhost:3000'),
      /** Kill-switch for the WebAuthn procedures without a redeploy of TOTP. */
      WEBAUTHN_ENABLED: boolish,
      /**
       * Owner-published affiliate commission accrual tiers (DIRECTION §8).
       * Blank / unset → unpublished; accrue refuses unless the request supplies
       * tiers. JSON shape: { "published": true, "tiers": [{ "hop": 0, "rate": "0.10" }] }.
       * Malformed → fail boot (parseAccrualTierLawJson throws). Never invent rates.
       */
      IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON: z.string().optional().default(''),
      /**
       * Owner-published DMA broker / desk / shift hierarchy law (M01-R06/R07).
       * Blank / unset → unpublished; createDmaHierarchyProduct refuses.
       * JSON shape: { "published": true } — never a broker tree.
       * Malformed → fail boot (parseDmaHierarchyLawJson throws).
       */
      IDENTITY_DMA_HIERARCHY_LAW_JSON: z.string().optional().default(''),
      /**
       * 32-byte AES-256 key (base64 or 64-char hex) for §10 KYC document store.
       * Blank = store refuses put/get (no improvised key). Vendor integration Class X.
       */
      IDENTITY_KYC_DOC_KEY: z.string().optional().default(''),
      /**
       * 32-byte AES-256 key (base64 or 64-char hex) for users.totp_secret at rest.
       * Blank = TOTP enrol refuses (no plaintext write). Prod boot refuses if missing.
       * Dual-read still accepts legacy unprefixed plaintext until re-enrol.
       */
      IDENTITY_TOTP_SECRET_KEY: z.string().optional().default(''),
      /**
       * Access-token signing keys for rotation: `id:secret,id2:secret2` (each secret at least 32 characters;
       * the id `legacy` is JWT_ACCESS_SECRET). Blank = no rotation possible; `authKeys.rotate` refuses.
       */
      IDENTITY_AUTH_KEYS: z.string().optional().default(''),
      /**
       * 32-byte AES-256 key (base64 or 64-char hex) for api_keys.request_signing_secret.
       * Blank = signing opt-in refuses (no plaintext write). Prod and staging boot refuse if missing.
       */
      API_KEY_SIGNING_ENC_KEY: z.string().optional().default(''),
      /**
       * The owner's request-signing timestamp window, whole seconds from 1 to 3600 (DV-auth-01): how far a signed
       * request's time may be from the server's, either way. Blank = unset: every signed request refuses
       * `auth.request_window_unset` and the published policy shows the window as not set.
       */
      IDENTITY_REQUEST_SIGN_WINDOW_SECONDS: z.string().optional().default(''),
      /**
       * The owner's `API_KEY_SIGNING_OPTIONAL` (DV-auth-01): `true` lets a key that places orders turn signing off,
       * with a fresh factor. Blank (or anything else): signing stays required on such a key.
       */
      API_KEY_SIGNING_OPTIONAL: z.string().optional().default(''),
      /**
       * svc-ledger base URL for the ONE money path this service has: the
       * affiliate / IB commission fan-out (§0.6 — identity stores no balances).
       *
       * OPTIONAL AND UNDEFAULTED, unlike the sibling services that default to
       * `http://localhost:4001`. A default here would have svc-identity claim a
       * ledger connection in every deployment, including ones where affiliates
       * are off — and the payout path would then fail at post time against a
       * host that is not there, instead of refusing up front with
       * `affiliate.payout.ledger_unwired`. Unset is a legible state, not a gap.
       */
      LEDGER_URL: z.string().url().optional(),
      /**
       * svc-pay base URL. Used for the owner pay-scope grant at session issue,
       * and for claiming a merchant email invite once this account's email is
       * confirmed. Unset → sessions stay on ordinary scopes and invites stay
       * pending. No localhost default.
       */
      PAY_URL: z.string().url().optional(),
      /**
       * Owner-published max *live* (non-revoked) sub-accounts per identity
       * (SPEC-SUBACCOUNTS §4 / §8). Blank / unset → unpublished; create refuses
       * (`auth.sub_account_cap_unset`). Never git-default 25 — that looks published.
       * Owner-explicit 25 is allowed. Malformed / out of range → fail boot.
       */
      /** Owner setting: most passkeys one account may hold. Blank = no limit stated, nothing refused. */
      PASSKEY_MAX_PER_ACCOUNT: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(100).optional()),
      /**
       * Owner setting: the sub-account kinds beyond `standard` that may be created, comma separated
       * (managed, spot, derivatives). Blank = only standard is offered. Derivatives is also refused until the
       * main account's derivatives eligibility can be read.
       */
      IDENTITY_SUB_ACCOUNT_KINDS: z.preprocess(
        (v) =>
          typeof v === 'string'
            ? v
                .split(',')
                .map((k) => k.trim())
                .filter(Boolean)
            : undefined,
        z.array(z.enum(['managed', 'derivatives', 'spot'])).optional(),
      ),
      /**
       * Owner setting: which trading features each sub-account kind may have turned on. `kind:feature+feature`, kinds
       * separated by commas, e.g. `standard:spot+convert,managed:spot`. Features: spot, convert, futures, algo, copy.
       * NO DEFAULT. Blank, or any unknown kind or feature, offers nothing and `subAccounts.setFeatures` refuses
       * (`identity.sub_account_features_unset`). Futures stays refused until the main account's derivatives eligibility
       * can be read.
       */
      IDENTITY_SUB_ACCOUNT_FEATURES: z.string().optional(),
      /**
       * Owner-published API key cap per verification level (`basic=3,full=5`, levels none, basic, full, institutional).
       * Blank, or a level left out, refuses every key create in the developer room (`identity.key_cap_unset`).
       * Never git-default. Parsed at start by `parseApiKeyCapByTier`; a malformed value stops the service.
       */
      IDENTITY_API_KEYS_MAX_BY_TIER: z.string().optional(),
      /**
       * Owner setting: whole seconds an API key may go unused before it is due to end (DV-keys-03, ENGINE KS-7). The key
       * detail shows it; no dormant sweep is built yet, so a set value ends no key today and the detail says so. NO
       * DEFAULT. Blank: the detail shows the idle expiry as `not set`. Parsed at start by `parseApiKeyIdleExpirySeconds`;
       * a value that is not a positive whole number stops the service.
       */
      IDENTITY_API_KEY_IDLE_EXPIRY_SECONDS: z.string().optional(),
      /**
       * Owner setting: the account product tiers an operator may move an account onto (J-ops-console-04 #11). A JSON list of
       * `{ id, name, terms: { ratePercent, monthlyFee, feeAssetId, dailyLimit, clearingDays } }`, terms as decimal strings or
       * null. NO DEFAULT. Blank or invalid: `accountControls.tiers` answers `identity.account_tiers_unset` and every move
       * refuses. A tier with a null term cannot be assigned (`identity.tier_terms_unset`).
       */
      IDENTITY_ACCOUNT_TIERS: z.string().optional(),
      /**
       * Owner setting: whole days a closed, unarchived customer record stays without a change or a new session before identity
       * proposes it for archive (J-ops-console-04 #10). NO DEFAULT. Blank: no proposal is made and the console says the
       * period is not set. A proposal is only that: a person archives each one with a second approver. Parsed at start by
       * `parseDormancyDays`; malformed stops the service.
       */
      IDENTITY_DORMANCY_DAYS: z.string().optional(),
      /**
       * Owner setting (I-kyc-compliance-05): what each verification level asks for, a JSON object of level -> requirement
       * keys from `KYC_REQUIREMENT_KEYS` (`@intafaced/contracts/identity-kyc-levels`), for example
       * `{"basic":["legal_name","date_of_birth","id_document"]}`. NO DEFAULT. A level left out is unpublished and
       * /verification says none are published for it, never an empty list. Parsed at start by
       * `parseKycRequirementsByLevel`; an empty list, an unknown key or malformed JSON stops the service.
       */
      IDENTITY_KYC_REQUIREMENTS_BY_LEVEL: z.string().optional(),
      /**
       * Owner setting (I-kyc-compliance-05): the review time the owner states per verification level, `level=hours`
       * pairs, for example `basic=24,full=72` (whole hours, 1 to 8760). NO DEFAULT. A level left out has no stated review
       * time and /verification says so. Parsed at start by `parseKycReviewHoursByLevel`; malformed stops the service.
       */
      IDENTITY_KYC_REVIEW_HOURS_BY_LEVEL: z.string().optional(),
      /**
       * Owner setting (I-kyc-compliance-01): the reasons a verification can be rejected for, a JSON array of
       * `{"code","reason","guidance"}` (code lower case with underscores; reason up to 200 characters, what the customer
       * reads; guidance up to 500, what to do next). NO DEFAULT. Unset, every `kyc.reject` refuses
       * `kyc.reason_codes_unset`. Parsed at start by `parseKycRejectReasons`; a repeated code or a malformed entry stops
       * the service.
       */
      IDENTITY_KYC_REJECT_REASONS: z.string().optional(),
      /**
       * Owner setting (I-kyc-compliance-07): which capabilities each verification level grants, a JSON object of level
       * -> capabilities (`custody_crypto`, `custody_fiat`, `transfer_crypto`, `transfer_fiat`, `trade_crypto`). A level
       * grants its own and every lower level's. NO DEFAULT. Unset, an approval grants no capability and /verification
       * says so. Parsed at start by `parseKycCapabilitiesByLevel`; a capability mapped twice or a malformed entry stops
       * the service.
       */
      IDENTITY_KYC_CAPABILITIES_BY_LEVEL: z.string().optional(),
      /**
       * Owner setting (I-kyc-compliance-07): the reasons compliance may switch a capability off for, the same shape as
       * `IDENTITY_KYC_REJECT_REASONS` (`{"code","reason","guidance"}`). NO DEFAULT. Unset, every
       * `kyc.capabilities.set` refuses `kyc.reason_codes_unset`. Parsed at start; malformed stops the service.
       */
      IDENTITY_KYC_CAPABILITY_REASONS: z.string().optional(),
      /**
       * Owner settings (I-kyc-compliance-08). The accepted ID types per country, as JSON
       * `{"<country>": [{"type", "label", "originalRequired"}]}`: a country not listed reads "not published". The ID
       * photo's caps, set together: the largest file in bytes (at most 760 KiB, so its base64 and the JSON around it fit one 1 MiB request body) and a comma list of content
       * types. NO DEFAULT: unset caps refuse every upload. Parsed at start; malformed stops the service.
       */
      IDENTITY_KYC_DOCUMENT_TYPES_BY_COUNTRY: z.string().optional(),
      IDENTITY_KYC_UPLOAD_MAX_BYTES: z.string().optional(),
      IDENTITY_KYC_UPLOAD_TYPES: z.string().optional(),
      /**
       * Owner settings (I-kyc-compliance-11), NO DEFAULT. How many days old a proof of address may be (unset refuses
       * every submission `kyc.poa_rule_unset`), and per country which documents count and which never do, as JSON
       * `{"<country>": {"accepted": [{"type","label"}], "rejected": [...]}}` (a country not listed reads not published).
       * Parsed at start; malformed stops the service.
       */
      IDENTITY_KYC_POA_MAX_AGE_DAYS: z.string().optional(),
      IDENTITY_KYC_POA_TYPES_BY_COUNTRY: z.string().optional(),
      /**
       * Owner settings (I-kyc-compliance-09), NO DEFAULT. How many seconds a phone hand-off link for the selfie lasts
       * (60 to 3600; unset refuses every hand-off `kyc.handoff_unset`), and the comma-separated actions that ask for a
       * liveness re-check (unset is none). Parsed at start; malformed stops the service.
       */
      IDENTITY_KYC_HANDOFF_TTL_SECONDS: z.string().optional(),
      IDENTITY_KYC_LIVENESS_RECHECK_FOR: z.string().optional(),
      /**
       * Owner settings (I-kyc-compliance-10), set together or not at all: how many rejected verification requests a
       * person may have inside `IDENTITY_KYC_DENIAL_WINDOW_HOURS`, and for how many hours after the last of them a new
       * request is refused `kyc.attempts_exhausted`. NO DEFAULT. All unset is no limit, and /verification says so.
       * Parsed at start by `parseKycAttemptLimit`; only some set, or malformed, stops the service.
       */
      IDENTITY_KYC_MAX_DENIALS: z.string().optional(),
      IDENTITY_KYC_DENIAL_WINDOW_HOURS: z.string().optional(),
      IDENTITY_KYC_LOCKOUT_HOURS: z.string().optional(),
      /**
       * Owner setting for account limit overrides (J-ops-console-04 #12): a JSON object
       * `{ "maxLifetimeHours": "<whole hours>", "ceilings": { "<rail>": { "<asset>": "<decimal>" } } }`. NO DEFAULT. Blank,
       * not JSON or invalid means unset: every override refuses `identity.limit_ceiling_unset` and the console says "not
       * set". An override above the ceiling for its rail and asset needs the other founder. Parsed by `parseLimitPolicy`.
       */
      IDENTITY_LIMIT_OVERRIDE_POLICY: z.string().optional(),
      /**
       * Owner setting: how long after sign-up a person may still attach a referrer through a link, in whole seconds
       * (CM-referral-01, J-campaigns-05 #4-#5). NO DEFAULT. Blank refuses every link attach (`referral.attach_window_unset`);
       * past it, `referral.attach_window_closed`. Parsed at start by `parseAttachWindowSeconds`; malformed stops the service.
       */
      IDENTITY_REFERRAL_ATTACH_WINDOW_SECONDS: z.string().optional(),
      /**
       * Owner setting: how many characters a short referral code has, 4 to 16 (CM-referral-01, J-campaigns-05 #1).
       * NO DEFAULT. Blank refuses making a code (`referral.code_length_unset`); the share link still works.
       */
      IDENTITY_REFERRAL_CODE_LENGTH: z.string().optional(),
      /**
       * Owner setting: how long a referral relationship lasts without a fee event (any, whether or not it earns commission) by the referred
       * person, in whole seconds (CM-referral-01 RF-4, J-campaigns-05 #7). NO DEFAULT. Blank: the lapse sweep refuses
       * (`referral.lapse_period_unset`) and does not run. Parsed at start by `parseLapsePeriodSeconds`.
       */
      IDENTITY_REFERRAL_LAPSE_PERIOD_SECONDS: z.string().optional(),
      /** Owner setting: how often the lapse sweep runs, in whole seconds. NO DEFAULT. Blank leaves the sweep timer off. */
      IDENTITY_REFERRAL_LAPSE_SWEEP_SECONDS: z.string().optional(),
      /**
       * Owner setting: how many waiting entries one waitlist wave releases (RC-campaigns-03, J-campaigns-20 #3). NO DEFAULT.
       * Blank refuses every release (`drop.wave_unset`) and releases nobody. Parsed at start by `parseWaveSize`.
       */
      IDENTITY_WAITLIST_WAVE_SIZE: z.string().optional(),
      IDENTITY_MAX_SUB_ACCOUNTS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(10_000).optional()),
      /**
       * Owner-published watchlist caps (C-alerts-scan-05, -07): named lists per account, symbols per list, saved screens per
       * account. Blank / unset → unpublished; a write that needs the cap refuses (`identity.watchlist_*_cap_unset`). Never
       * a default: the stack sets labelled TEST values only.
       */
      IDENTITY_WATCHLIST_LIST_CAP: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(20).optional()),
      IDENTITY_WATCHLIST_SYMBOL_CAP: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(1000).optional()),
      IDENTITY_SAVED_SCREEN_CAP: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(50).optional()),
      /**
       * Owner-published lifetime cap on handle changes per account (PP-send-request-03). Blank / unset → unpublished;
       * every handle change refuses (`identity.handle_change_cap_unset`). Never invent a default: the stack sets a
       * labelled TEST value only.
       */
      IDENTITY_HANDLE_CHANGE_MAX: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(100).optional()),
      /**
       * Owner-published lifetime of an OAuth authorisation code, in seconds. Blank / unset → unpublished; an
       * authorise decision and a code exchange refuse (`oauth.lifetime_unset`). Never git-default.
       */
      OAUTH_CODE_TTL_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(86_400).optional()),
      /**
       * Owner-published lifetime of an OAuth access token, in seconds. Blank / unset → unpublished; no token is
       * issued (`oauth.lifetime_unset`). Never git-default.
       */
      OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(31_536_000).optional()),
      /**
       * Owner-published lifetime for an action-bound approval, in seconds.
       * Blank / unset → unpublished; propose refuses (`action_approval.ttl_unset`).
       * Never git-default 900 or 15 minutes.
       */
      IDENTITY_ACTION_APPROVAL_TTL_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(10_000_000).optional()),
      /**
       * Owner-published lifetime of a social sign-in flow, in seconds. Blank / unset →
       * unpublished; a start refuses (`identity.social_flow_ttl_unset`). Never git-default.
       */
      IDENTITY_SOCIAL_FLOW_TTL_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(3600).optional()),
      /**
       * W-balances-04. Owner-published membership tiers (JSON list of { id, name, price, assetId,
       * periodDays, perks }). Blank / unset → "Membership is not offered". Never defaulted.
       */
      IDENTITY_MEMBERSHIP_TIERS: z
        .string()
        .optional()
        .transform((v, ctx) => {
          try {
            return parseMembershipTiers(v);
          } catch (error) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
            return z.NEVER;
          }
        }),
      /**
       * W-security-accounts-03. Owner-set wait, in seconds, from a self-freeze to when the owner may lift it.
       * Blank / unset → the lift refuses (`identity.self_freeze_lift_wait_unset`). Zero is a published "no wait".
       */
      IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS: z
        .string()
        .optional()
        .transform((v, ctx) => {
          try {
            return parseSelfFreezeLiftWait(v);
          } catch (error) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
            return z.NEVER;
          }
        }),
      /**
       * I-signin-sessions-12. Owner-set wait, in seconds, from a confirmed locked-out second-factor reset to when the next
       * password sign-in may remove the authenticator app. NO DEFAULT: blank / unset → the reset refuses
       * (`identity.mfa_reset_unconfigured`) and the sign-in page points to Support. Zero is a published "no wait". A
       * change applies to later resets, never to one already waiting.
       */
      IDENTITY_MFA_RESET_WAIT_SECONDS: z
        .string()
        .optional()
        .transform((v, ctx) => {
          try {
            return parseMfaResetWait(v);
          } catch (error) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
            return z.NEVER;
          }
        }),
      /**
       * I-signin-sessions-24. Owner-set lifetime, in seconds, of the one-time recovery link a Support case mails (1 to
       * 86400). NO DEFAULT: blank / unset → sending the link refuses (`identity.support_recovery_unconfigured`) before the
       * case's approval is spent. A change applies to links sent later, never to one already sent.
       */
      IDENTITY_SUPPORT_RECOVERY_LINK_TTL_SECONDS: z
        .string()
        .optional()
        .transform((v, ctx) => {
          if (v === undefined || v.trim() === '') return undefined;
          const n = /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
          if (!Number.isInteger(n) || n < 1 || n > 86_400) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'IDENTITY_SUPPORT_RECOVERY_LINK_TTL_SECONDS must be whole seconds from 1 to 86400',
            });
            return z.NEVER;
          }
          return n;
        }),
      /**
       * W-withdraw-09. Owner-set wait, in seconds, from an unlock request to when the customer security lock ends. NO
       * DEFAULT: blank / unset → the unlock request refuses (`identity.security_lock_unlock_wait_unset`); locking still
       * works. Zero is a published "no wait". A change applies to later requests, never to one already made.
       */
      IDENTITY_SECURITY_LOCK_UNLOCK_WAIT_SECONDS: z
        .string()
        .optional()
        .transform((v, ctx) => {
          try {
            return parseSecurityLockUnlockWait(v);
          } catch (error) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
            return z.NEVER;
          }
        }),
      /**
       * Owner-published display currencies, comma-separated codes. Blank / unset →
       * nothing is listed: an account can only keep "no choice" (USD is shown) and the
       * display page says the list is not set. Malformed → fail boot.
       */
      IDENTITY_DISPLAY_CURRENCIES: z
        .string()
        .optional()
        .transform((v, ctx) => {
          try {
            return parseDisplayCurrencyList(v);
          } catch (error) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
            return z.NEVER;
          }
        }),
      /**
       * Owner-published lifetime for a signed-out password-reset proof, in seconds.
       * Blank / unset → unpublished; the reset request refuses (`auth.reset_unwired`).
       * Never git-default 900 or 15 minutes. One day is the ceiling.
       */
      IDENTITY_PASSWORD_RESET_TTL_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(86_400).optional()),
      /**
       * Owner-published wrong-code cap for a password reset. Blank / unset → unpublished; a reset request
       * refuses (`auth.reset_unwired`). The ceiling is 5. A higher number is not a published cap.
       */
      IDENTITY_PASSWORD_RESET_MAX_ATTEMPTS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(5).optional()),
      /**
       * Owner-published reset and username-recovery requests per address per window. Blank / unset, or a
       * window without a max, stays unpublished and the request refuses (`auth.reset_unwired`). The
       * ceiling is technical. It is not a default budget.
       */
      IDENTITY_PASSWORD_RESET_REQUEST_MAX: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(1_000).optional()),
      IDENTITY_PASSWORD_RESET_REQUEST_WINDOW_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(86_400).optional()),
      /**
       * Secret that turns an address into the identifier recovery flows are counted by (an HMAC key).
       * Blank / unset → unpublished; recovery requests refuse (`auth.reset_unwired`). At least 32 characters.
       */
      IDENTITY_FLOW_SUBJECT_KEY: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.string().min(32).optional()),
      /**
       * When true, an address with no account is mailed a "no account here" notice. Unset, blank, false,
       * off, or 0 stays off: nothing is mailed to an address that is not ours by default.
       */
      IDENTITY_RESET_NOTIFY_UNKNOWN: z.preprocess((v) => {
        if (v === undefined || v === null) return false;
        if (typeof v === 'boolean') return v;
        if (typeof v === 'string') {
          const text = v.trim().toLowerCase();
          if (text === '' || text === '0' || text === 'false' || text === 'off' || text === 'no') return false;
          if (text === '1' || text === 'true' || text === 'on' || text === 'yes') return true;
        }
        return v;
      }, z.boolean().default(false)),
      /**
       * Owner-published lifetime for an email or phone change proof, in seconds.
       * Blank / unset → unpublished; the change refuses (`auth.change_unwired`).
       * Never git-default a lifetime. One day is the ceiling.
       */
      IDENTITY_CONTACT_CHANGE_TTL_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(86_400).optional()),
      /**
       * Owner-published wrong-code cap for a contact-change proof.
       * Blank / unset → unpublished; the change refuses (`auth.change_unwired`).
       * The ceiling is 5. A higher number is not a published cap.
       */
      IDENTITY_CONTACT_CHANGE_MAX_ATTEMPTS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(5).optional()),
      /**
       * Mail transport. Blank / unset → unwired; confirmation and reset requests
       * refuse. `local-outbox` is the only implemented transport and is refused
       * at boot unless APP_ENV is exactly dev or test. Any other name refuses
       * at boot. No provider is configured here.
       */
      IDENTITY_MAIL_TRANSPORT: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return typeof v === 'string' ? v.trim() : v;
      }, z.string().optional()),
      /** Absolute file path for the local-outbox transport. Required when that transport is selected. */
      IDENTITY_LOCAL_MAIL_OUTBOX: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return typeof v === 'string' ? v.trim() : v;
      }, z.string().optional()),
      /**
       * Owner-published lifetime for an email-confirmation proof, in seconds.
       * Blank / unset → unpublished; the request refuses (`auth.email_confirm_unwired`).
       * Never git-default a lifetime. One day is the ceiling.
       */
      IDENTITY_EMAIL_CONFIRM_TTL_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(86_400).optional()),
      /**
       * Owner-published confirmation requests per window. Blank / unset, or a
       * window without a max, stays unpublished and the request refuses.
       * The ceiling is technical. It is not a default budget.
       */
      IDENTITY_EMAIL_CONFIRM_RATE_MAX: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(1_000).optional()),
      IDENTITY_EMAIL_CONFIRM_RATE_WINDOW_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(86_400).optional()),
      /**
       * Owner-published minimum age to open an account (I-kyc-compliance-06). NO DEFAULT: blank / unset refuses
       * every sign-up (`identity.age_rule_unset`). Never invent 18.
       */
      IDENTITY_SIGNUP_MIN_AGE_YEARS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(25).optional()),
      /**
       * Owner-published lifetime of a sign-up code, in seconds. NO DEFAULT: blank / unset refuses every sign-up
       * (`identity.signup_unwired`), as do the four sign-up numbers below. One day is the ceiling.
       */
      IDENTITY_SIGNUP_CODE_TTL_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(86400).optional()),
      /**
       * Owner-published wrong codes allowed per sign-up before it locks. NO DEFAULT (`identity.signup_unwired`).
       * The ceiling is 5.
       */
      IDENTITY_SIGNUP_CODE_MAX_ATTEMPTS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(5).optional()),
      /**
       * Owner-published seconds before another sign-up code may be sent. NO DEFAULT (`identity.signup_unwired`).
       */
      IDENTITY_SIGNUP_RESEND_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(86400).optional()),
      /**
       * Owner-published sign-ups and resends per address per window. NO DEFAULT (`identity.signup_unwired`).
       * The ceiling is technical, not a default budget.
       */
      IDENTITY_SIGNUP_REQUEST_MAX: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(1000).optional()),
      /**
       * The window for IDENTITY_SIGNUP_REQUEST_MAX, in seconds. NO DEFAULT (`identity.signup_unwired`).
       */
      IDENTITY_SIGNUP_REQUEST_WINDOW_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(86400).optional()),
      /**
       * Owner-published lifetime of a sign-in code, in seconds (I-signin-sessions-19). NO DEFAULT: blank / unset refuses
       * every code sign-in (`auth.codes_unwired`), as do the four sign-in code numbers below. One day is the ceiling.
       */
      IDENTITY_LOGIN_CODE_TTL_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(86400).optional()),
      /**
       * Owner-published wrong codes allowed per sign-in code before it locks. NO DEFAULT (`auth.codes_unwired`).
       * The ceiling is 5.
       */
      IDENTITY_LOGIN_CODE_MAX_ATTEMPTS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(5).optional()),
      /**
       * Owner-published seconds before another sign-in code may be sent. NO DEFAULT (`auth.codes_unwired`).
       */
      IDENTITY_LOGIN_CODE_RESEND_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(86400).optional()),
      /**
       * Owner-published sign-in codes per email or handle per window, resends included. NO DEFAULT
       * (`auth.codes_unwired`). The ceiling is technical, not a default budget.
       */
      IDENTITY_LOGIN_CODE_REQUEST_MAX: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(1000).optional()),
      /**
       * The window for IDENTITY_LOGIN_CODE_REQUEST_MAX, in seconds. NO DEFAULT (`auth.codes_unwired`).
       */
      IDENTITY_LOGIN_CODE_REQUEST_WINDOW_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(86400).optional()),
      /**
       * The owner's breached-password list (I-signin-sessions-04): a file of SHA-1 digests, one per line (`HASH` or
       * `HASH:count`), read once at boot. A new password on it is refused (`auth.password_breached`). Blank: nothing is
       * screened. A relative path is read from the svc-identity folder. A path that cannot be read stops the boot.
       */
      IDENTITY_BREACHED_PASSWORDS_FILE: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.string().min(1).optional()),
      /**
       * New-device check (I-signin-sessions-07): `on` or `off`. Blank leaves it off, and the Security page says the owner
       * has not turned it on. With it on, a sign-in from a browser with no trusted device for the account waits for
       * approval by a mailed code or from a trusted session.
       */
      IDENTITY_NEW_DEVICE_CHECK: z.preprocess(
        (v) => {
          if (v === undefined || v === null) return undefined;
          if (typeof v === 'string' && v.trim() === '') return undefined;
          return v;
        },
        z.enum(['on', 'off']).optional(),
      ),
      /**
       * Owner-published lifetime of a waiting new-device sign-in, in seconds. NO DEFAULT: with the check on and this
       * blank, a new-device sign-in is refused (`auth.device_check_unwired`). One day is the ceiling.
       */
      IDENTITY_NEW_DEVICE_TTL_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(86400).optional()),
      /**
       * Owner-published wrong mailed codes allowed per new-device sign-in (ceiling 5). Blank: no code is mailed and only
       * a trusted session can approve.
       */
      IDENTITY_NEW_DEVICE_MAX_ATTEMPTS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(5).optional()),
      /** Owner-published seconds a device stays trusted. Blank: until the person removes it (the Security page says so). */
      IDENTITY_TRUSTED_DEVICE_TTL_SECONDS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(315360000).optional()),
      /**
       * The owner's per-country off switch for sign-up: comma-separated ISO country codes. Blank closes none,
       * because sign-up is open everywhere the sanctions screening allows (owner decision 2026-10-22). A code
       * that is not two letters refuses boot.
       */
      IDENTITY_SIGNUP_CLOSED_COUNTRIES: z.preprocess(
        (v) =>
          typeof v === 'string'
            ? v
                .split(',')
                .map((c) => c.trim().toUpperCase())
                .filter(Boolean)
            : v === undefined || v === null
              ? []
              : v,
        z.array(z.string().regex(/^[A-Z]{2}$/)),
      ),
      /**
       * Optional pin for `waitlist.enabled` / `referral.queue` (packages/config
       * `envVarNameFor`). Unset or blank (compose `${VAR:-}`) follows the drop
       * clock — drop 0 opens both. Explicit `off` refuse-closes capture.
       * A blank string is not a pin.
       */
      /**
       * When true, a trading restriction on accountControls.change needs a consumed
       * `trading.restrict` approval. Unset, blank, false, off, or 0 stays off: identity
       * does not start requiring two people, and does not apply trading restrictions.
       * Any other string refuses boot. This ships off. Turning it on is a lead decision.
       */
      /**
       * Operator scopes added to a live founder's interactive MFA session.
       * Comma-separated allowlist. Blank or unset grants nothing — which
       * founder holds which scope is the lead's decision, not a default here.
       * A name outside the allowlist, or any unknown scope, refuses boot
       * (`identity.founder_scope_invalid`). Do not set this in compose.
       */
      IDENTITY_FOUNDER_SESSION_SCOPES: z
        .string()
        .optional()
        .transform((raw, ctx) => {
          try {
            return founderSessionScopesFromEnv(raw);
          } catch (err) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: err instanceof Error ? err.message : 'identity.founder_scope_invalid' });
            return z.NEVER;
          }
        }),
      /**
       * Account closure. Unset, blank, false, off, or 0 stays off.
       * Do not set this in compose or in a local env file. The lead turns it on.
       */
      IDENTITY_ACCOUNT_CLOSE_ENABLED: z.preprocess((v) => {
        if (v === undefined || v === null) return false;
        if (typeof v === 'boolean') return v;
        if (typeof v === 'string') {
          const text = v.trim().toLowerCase();
          if (text === '' || text === '0' || text === 'false' || text === 'off' || text === 'no') return false;
          if (text === '1' || text === 'true' || text === 'on' || text === 'yes') return true;
        }
        return v;
      }, z.boolean().default(false)),
      /**
       * Owner-published cooling-off, in days, from 1 to 90.
       * Blank or unset refuses `identity.close_cooling_off_unset`. Never a default.
       * Do not set this in compose or in any env file.
       */
      IDENTITY_ACCOUNT_CLOSE_COOLING_OFF_DAYS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(90).optional()),
      /** Owning-service closure checks. Blank refuses the check as unavailable. Do not invent a host. */
      IDENTITY_CLOSURE_BANK_URL: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return typeof v === 'string' ? v.trim() : v;
      }, z.string().optional()),
      IDENTITY_CLOSURE_TRADE_URL: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return typeof v === 'string' ? v.trim() : v;
      }, z.string().optional()),
      IDENTITY_CLOSURE_P2P_URL: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return typeof v === 'string' ? v.trim() : v;
      }, z.string().optional()),
      IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v !== 'string') return v;
        const text = v.trim().toLowerCase();
        if (text === '') return undefined;
        if (text === '0' || text === 'false' || text === 'off') return false;
        if (text === '1' || text === 'true' || text === 'on') return true;
        return v;
      }, z.boolean().optional()),
      INTAFACED_FLAG_WAITLIST_ENABLED: z.string().optional(),
      INTAFACED_FLAG_REFERRAL_QUEUE: z.string().optional(),
    }),
  );

export const env = loadEnv(schema);
// loadEnv's posture scan sees only variables that are set; the WebAuthn relying party has local defaults.
assertWebauthnPosture(env);
export type Env = typeof env;
