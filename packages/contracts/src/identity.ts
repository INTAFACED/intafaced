import { z } from 'zod';

/**
 * IDENTITY CONTRACT — the reference example of the zod-first pattern (§3).
 *
 * The pattern, in order:
 *   1. Declare zod schemas for input and output. They are the contract.
 *   2. Derive TypeScript types from them — never hand-write a duplicate type.
 *   3. Declare the router shape with `satisfies`, so the implementing service
 *      is checked against this file rather than the other way around.
 *
 * Callers import types from here. They never import svc-identity.
 */

export const kycTierSchema = z.enum(['none', 'basic', 'full', 'institutional']);
export type KycTierValue = z.infer<typeof kycTierSchema>;

/**
 * ACCOUNT STATE — the whole of what a support operator may read about an
 * account, and svc-identity is the only place it can be read FROM.
 *
 * Three fields, and the SHORTNESS is the contract. `identity.users.status` and
 * the derived KYC tier answer the two questions a desk actually needs — "can
 * this person use the platform" and "how far are they verified" — and nothing
 * else is here to leak.
 *
 * WHAT IS DELIBERATELY ABSENT, because a support desk is exactly where these
 * grow back:
 *
 *   · No balance, no equity, no PnL. §0.6 — a balance rendered on a ticket is a
 *     second book the moment somebody caches it, and support has no reason to
 *     see one that reading the ledger's own surface would not serve better.
 *   · No document bytes, no legal name, no date of birth, no jurisdiction. §10
 *     PII isolation — `identity.kyc_documents` is an encrypted vault whose read
 *     path is operator tooling only (a688e231), and this projection must not
 *     become the hole in its wall. A support view references a document by the
 *     opaque id identity already holds; it never carries one.
 *   · No email, no phone. Nothing a ticket body would then quote back.
 *
 * This mirrors `AccountProjectionFixture` in svc-agents' support agent, whose
 * own comment says it best: "status + KYC tier and literally nothing else:
 * there is no balance field to leak, invent, or drift." That shape was fixture
 * data with no producer. This is the same shape, published, so the human desk
 * and the agent read one contract rather than two that agree by luck.
 */
export const accountStateSchema = z.object({
  userId: z.string().guid(),
  /** `identity.users.status` — the freeze/close fact, read never written here. */
  status: z.enum(['active', 'frozen', 'closed']),
  /** Highest approved, unexpired tier. Derived by identity, not stored twice. */
  kycTier: kycTierSchema,
});
export type AccountState = z.infer<typeof accountStateSchema>;

/**
 * Whether the account's current email address is proved (RC-identity-01), for a service that gates an action on it:
 * svc-trade refuses a new custodial order while it is `missing`. Read per request from svc-identity's
 * `GET /internal/email-proof/:userId`, service-authenticated; never copied. A separate shape from `AccountState` on
 * purpose: that projection is status and KYC tier "and literally nothing else", and support stores it as cited.
 * No address in it, only the fact.
 */
export const emailProofSchema = z
  .object({
    userId: z.string().guid(),
    emailProof: z.enum(['accepted', 'missing']),
  })
  .strict();
export type EmailProof = z.infer<typeof emailProofSchema>;

/**
 * CUSTOMER SECURITY LOCK (W-withdraw-09, wallet-withdraw-015). The account owner's own switch that stops withdrawals and
 * changes to withdrawal addresses, the password and verification until they unlock it. Locking applies at once; unlocking
 * is a request that takes effect only after the owner-set wait, and a repeated request never moves that time earlier.
 * svc-identity stores it and refuses its own password changes while it holds; a service that moves money out reads it per
 * request from `GET /internal/security-lock/:userId` (service credentials) and refuses while `locked` is true. It is not
 * the staff freeze (`users.status`), not the owner's self-freeze and not the ledger posting freeze.
 */
export const securityLockSchema = z
  .object({
    userId: z.string().guid(),
    /** True while the lock holds: set, and either no unlock requested or the requested time not reached. */
    locked: z.boolean(),
    lockedAt: z.string().datetime({ offset: true }).nullable(),
    /** Who set the lock that holds. Support can set one and can never lift it. */
    setBy: z.enum(['self', 'support']).nullable(),
    unlockRequestedAt: z.string().datetime({ offset: true }).nullable(),
    /** When the lock ends, fixed when the unlock was requested. Null while no unlock is requested. */
    unlocksAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type SecurityLockView = z.infer<typeof securityLockSchema>;
/**
 * A mail another service asks identity to send to a customer's own proved address (`POST /internal/mail`, service
 * credentials). Identity holds the address, so the caller names the account and never sees or sends one. Each purpose
 * has one link shape that identity builds from `token`, and one caller allowed to ask for it:
 * - `withdraw-address-approval` (svc-bank, W-withdraw new-address approval): `approveAddress?token=<token>`.
 *
 * `key` is the caller's business key (for example `address-approval:<addressId>:<n>`). The same key with the same body
 * answers with the first mail and sends nothing more; the same key with a different body is refused
 * (`identity.mail_key_conflict`). `detail` is a short plain line shown in the mail (for example the network and the
 * address's first and last characters) so the customer can see what they approve.
 */
export const SERVICE_MAIL_PATH = '/internal/mail' as const;
export const serviceMailPurposeSchema = z.enum(['withdraw-address-approval']);
export type ServiceMailPurpose = z.infer<typeof serviceMailPurposeSchema>;
export const serviceMailRequestSchema = z
  .object({
    key: z
      .string()
      .min(8)
      .max(200)
      .regex(/^[A-Za-z0-9:._-]+$/),
    userId: z.string().guid(),
    purpose: serviceMailPurposeSchema,
    /** The secret the link carries. Identity never logs it and clears it from its outbox once the mail is handed off. */
    token: z
      .string()
      .min(16)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
    detail: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9 .:,()_-]+$/)
      .optional(),
    /** When the link stops working, as the caller enforces it. Shown in the mail; at most seven days ahead. */
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ServiceMailRequest = z.infer<typeof serviceMailRequestSchema>;
export const serviceMailAcceptedSchema = z.object({ accepted: z.literal(true), mailId: z.string().guid() }).strict();
export type ServiceMailAccepted = z.infer<typeof serviceMailAcceptedSchema>;
/** The step-up door for an unlock request (see `CUSTOMER_STEP_UP_DOORS`). Locking needs none: it only takes power away. */
export const SECURITY_LOCK_UNLOCK_STEP_UP_SCOPE = 'identity.step_up.security_lock_unlock' as const;
export const SECURITY_LOCK_UNLOCK_STEP_UP_PURPOSE = 'account.securityLock.unlock' as const;

/**
 * The perk table other services query (§4.1). Machine-readable on purpose:
 * svc-trade reads `feeDiscountBps` and applies it without knowing what a rank
 * means, which is why rank can be re-tuned without touching a second service.
 */
export const rankPerksSchema = z.object({
  feeDiscountBps: z.number().int().min(0).max(10_000),
  p2pLimitMultiplier: z.number().min(1),
  copyFollowerCap: z.number().int().min(0),
  lobbyHostRights: z.boolean(),
  cardTier: z.enum(['none', 'standard', 'metal', 'obsidian']),
  otcAccess: z.boolean(),
  launchpadTier: z.number().int().min(0),
});
export type RankPerks = z.infer<typeof rankPerksSchema>;

export const rankStateSchema = z.object({
  userId: z.string().guid(),
  rank: z.number().int().min(0),
  xp: z.string(),
  seasonXp: z.string(),
  nextRankAt: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type RankState = z.infer<typeof rankStateSchema>;

export const getRankInput = z.object({ userId: z.string().guid() });
export const getPerksInput = z.object({ userId: z.string().guid() });

export const awardXpInput = z.object({
  userId: z.string().guid(),
  sourceModule: z.string().min(1),
  action: z.string().min(1),
  xpDelta: z.number().int(),
  /** Dedupe key — the same achievement must never be paid twice. */
  idempotencyKey: z.string().min(8),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const principalSummarySchema = z.object({
  userId: z.string().guid(),
  handle: z.string(),
  tier: kycTierSchema,
  region: z.string().length(2).nullable(),
  rank: z.number().int(),
  modes: z.array(z.enum(['trader', 'merchant', 'creator', 'student'])),
  blueprintId: z.string().guid().nullable(),
});
export type PrincipalSummary = z.infer<typeof principalSummarySchema>;

/**
 * The shape svc-identity must implement. Declaring it here means a breaking
 * change to identity's API is a compile error in this package — caught in the
 * contracts PR, before any consumer is touched (§15.2).
 *
 * Deliberately absent: `certPerk` / `grantCertPerk` / `applyCertMap`.
 * A certification is an XP source (`rank.awardXp`). Perks stay `rank.perks`
 * (§4.1 SoT). Shared refuse-closed law: `./academy-cert-perks.ts`.
 */
export interface IdentityContract {
  rank: {
    get(input: z.infer<typeof getRankInput>): Promise<RankState>;
    perks(input: z.infer<typeof getPerksInput>): Promise<RankPerks>;
    awardXp(input: z.infer<typeof awardXpInput>): Promise<RankState>;
  };
  me(): Promise<PrincipalSummary>;
}

/** Default perks at rank 0 — what an unranked account gets everywhere. */
export const BASE_PERKS: RankPerks = {
  feeDiscountBps: 0,
  p2pLimitMultiplier: 1,
  copyFollowerCap: 0,
  lobbyHostRights: false,
  cardTier: 'none',
  otcAccess: false,
  launchpadTier: 0,
};

/**
 * S2S ownership snapshot for a sub-account (svc-trade placeOrder gate).
 *
 * Internal only — not the interactive list shape. Caller compares
 * `parentUserId` to the edge principal and refuses when `revoked`.
 */
export const subAccountOwnershipSchema = z.object({
  id: z.string().guid(),
  parentUserId: z.string().guid(),
  revoked: z.boolean(),
});
export type SubAccountOwnership = z.infer<typeof subAccountOwnershipSchema>;

/**
 * S2S ownership snapshot for an API key (place gate).
 *
 * Internal only — not the interactive list shape. Caller refuses when
 * `revoked`. Scopes are deliberately absent: revoke is a hard flag, not a
 * flatten, and this snapshot must not leak or invent them.
 */
export const apiKeyOwnershipSchema = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  revoked: z.boolean(),
});
export type ApiKeyOwnership = z.infer<typeof apiKeyOwnershipSchema>;

/**
 * S2S ownership snapshot for a session (place gate).
 *
 * Internal only — not the interactive list shape. Caller refuses when
 * `revoked`. No scopes, no jurisdiction or tier — those live on the user.
 */
export const sessionOwnershipSchema = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  revoked: z.boolean(),
});
export type SessionOwnership = z.infer<typeof sessionOwnershipSchema>;

/**
 * ANTI-PHISHING CODE (I-signin-sessions-25). A word the account owner picks so a real security message from us can be
 * told from a fake one. 4 to 20 letters and digits. `profile.antiPhishing.get` answers the caller's own code (null when
 * none is set) and nothing else; `profile.antiPhishing.set` takes the code, or '' to clear it, with a step-up.
 */
export const ANTI_PHISHING_CODE_PATTERN = /^[A-Za-z0-9]{4,20}$/;
/** The step-up door for a set or clear (see `CUSTOMER_STEP_UP_DOORS`): its scope and purpose, named once. */
export const ANTI_PHISHING_STEP_UP_SCOPE = 'identity.step_up.anti_phishing_set' as const;
export const ANTI_PHISHING_STEP_UP_PURPOSE = 'account.antiPhishing.set' as const;
export const antiPhishingCodeSchema = z.object({
  code: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
});
export type AntiPhishingCodeView = z.infer<typeof antiPhishingCodeSchema>;
export const antiPhishingSetResultSchema = antiPhishingCodeSchema.extend({ changed: z.boolean() });
export type AntiPhishingSetResult = z.infer<typeof antiPhishingSetResultSchema>;

/**
 * SERVER TIME (I-signin-sessions-13). Authenticator codes depend on the clock, so "my codes do not work" compares the
 * device's clock with ours. `serverTime` is public and answers only the service's current time.
 */
export const SERVER_TIME_PROCEDURE = 'serverTime' as const;
export const serverTimeSchema = z.object({ now: z.string().datetime({ offset: true }) });
export type ServerTime = z.infer<typeof serverTimeSchema>;
/** Each authenticator code lasts this long (svc-identity issues and checks codes with it); the one before and after also count. */
export const TOTP_STEP_SECONDS = 30;
