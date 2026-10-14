import { z } from 'zod';
import { authEnvSchema, edgeEnvSchema, internalServiceEnvSchema, loadEnv, serviceEnvSchema } from '@intafaced/config';
import { assertWebauthnPosture } from './webauthn-posture.js';
import { parseInviteExpiry, parseInviteHashes } from './auth/founder-enrolment.js';

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
 * An owner-published whole number of seconds. Unset or blank → undefined here; the refresh policy
 * (`resolveRefreshPolicy`, called at boot) turns that into a refusal to boot. Never defaulted.
 * Non-numeric → fail boot with the variable named.
 */
const publishedSeconds = z.preprocess((v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' && v.trim() === '') return undefined;
  return v;
}, z.coerce.number().int().optional());

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
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-identity'),
      HTTP_PORT: z.coerce.number().int().default(4002),
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
       * How long a refresh may keep carrying the `mfa` claim after the person last really verified
       * their password and second factor (`auth_time`). Past it, refresh issues `mfa: false` and the
       * person signs in again. Required: blank / unset refuses boot. Never defaulted. Recommended
       * production value to put to the owner: 43200 (12 h).
       */
      IDENTITY_MFA_MAX_AGE_SECONDS: publishedSeconds,
      /**
       * The same, for the founder pair and any `admin:*` principal. Required, never longer than the
       * value above. Blank / unset refuses boot. Recommended production value: 900 (15 min).
       */
      IDENTITY_PRIVILEGED_MFA_MAX_AGE_SECONDS: publishedSeconds,
      /**
       * Refresh grace window: a refresh token retired by a rotation is answered once, within this many
       * seconds, with the same successor pair (a lost response), instead of revoking every session.
       * 0 turns the window off. Required: blank / unset refuses boot. Recommended production value: 30.
       */
      IDENTITY_REFRESH_GRACE_SECONDS: publishedSeconds,
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
       * Optional pin for `waitlist.enabled` / `referral.queue` (packages/config
       * `envVarNameFor`). Unset or blank (compose `${VAR:-}`) follows the drop
       * clock — drop 0 opens both. Explicit `off` refuse-closes capture.
       * A blank string is not a pin.
       */
      INTAFACED_FLAG_WAITLIST_ENABLED: z.string().optional(),
      INTAFACED_FLAG_REFERRAL_QUEUE: z.string().optional(),
    }),
  );

export const env = loadEnv(schema);
// loadEnv's posture scan sees only variables that are set; the WebAuthn relying party has local defaults.
assertWebauthnPosture(env);
export type Env = typeof env;
