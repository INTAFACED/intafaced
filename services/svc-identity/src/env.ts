import { z } from 'zod';
import { authEnvSchema, edgeEnvSchema, internalServiceEnvSchema, loadEnv, s2sEnvSchema, serviceEnvSchema } from '@intafaced/config';
import { founderSessionScopesFromEnv } from '@intafaced/auth';
import { assertWebauthnPosture } from './webauthn-posture.js';
import { parseInviteExpiry, parseInviteHashes } from './auth/founder-enrolment.js';
import { parseRefreshRecoverySeconds } from './auth/refresh-cookie.js';

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
       * 32-byte AES-256 key (base64 or 64-char hex) for api_keys.request_signing_secret.
       * Blank = signing opt-in refuses (no plaintext write). Prod and staging boot refuse if missing.
       */
      API_KEY_SIGNING_ENC_KEY: z.string().optional().default(''),
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
      IDENTITY_MAX_SUB_ACCOUNTS: z.preprocess((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'string' && v.trim() === '') return undefined;
        return v;
      }, z.coerce.number().int().min(1).max(10_000).optional()),
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
