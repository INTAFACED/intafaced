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
 * Who an account is, for a campaign's participation rules (CM-eligibility-rules-01, J-campaigns-01 #4-#5): the account
 * type chosen at sign-up, the region identity holds (ISO 3166 alpha-2, null when none is recorded), the freeze/close
 * status and the KYC tier. svc-campaigns reads it per check from `GET /internal/campaign-participant/:userId` (service
 * credentials) and keeps no copy. No name, email or document is in it.
 */
export const campaignParticipantSchema = z
  .object({
    userId: z.string().guid(),
    accountType: z.enum(['individual', 'business']),
    region: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    status: z.enum(['active', 'frozen', 'closed']),
    kycTier: kycTierSchema,
  })
  .strict();
export type CampaignParticipant = z.infer<typeof campaignParticipantSchema>;

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
 * OWN-NAME RULE (P-ads-merchant-18, J-p2p-04 #2). A service that stores a payout destination in the person's own name
 * asks identity whether the holder name it was given is the account's verified legal name. svc-identity compares, so the
 * legal name never leaves it: the caller sends a name and gets only the outcome. `POST /internal/holder-name-check`,
 * service credentials, body-bound; svc-p2p is the only caller today.
 *
 * - `match` / `mismatch`: the names compared after identity's normalising (case, Latin accents, spacing, dashes,
 *   apostrophes, full stops and commas do not count; the words and their order do).
 * - `unverified`: identity holds no verified legal name for the account. The caller refuses; it never reads as a match.
 * - `unconfigured`: identity's details key is unset, so no name can be read. The caller refuses.
 * - `inactive`: the account is frozen, closed or archived. The caller refuses.
 * The answer's userId is lower case. Unknown account: 404; a record identity cannot read: 503
 * `identity.details_unreadable`. The caller refuses on both.
 */
export const IDENTITY_HOLDER_NAME_CHECK_PATH = '/internal/holder-name-check';
export const holderNameCheckInputSchema = z
  .object({
    userId: z.string().guid(),
    name: z.string().min(1).max(200),
  })
  .strict();
export type HolderNameCheckInput = z.infer<typeof holderNameCheckInputSchema>;
export const holderNameCheckSchema = z
  .object({
    userId: z.string().guid(),
    outcome: z.enum(['match', 'mismatch', 'unverified', 'unconfigured', 'inactive']),
  })
  .strict();
export type HolderNameCheck = z.infer<typeof holderNameCheckSchema>;

/**
 * The locked-out second-step reset (I-signin-sessions-12, J-identity-05 #2/#3), svc-identity's top-level `mfaReset`.
 * `start` and `confirm` answer a view: a code sent to the masked proved address, or the wait with who was told. `sms`
 * names the missing texting rail when a proved phone could not be texted. `status` is the account's waiting reset, for
 * its own sessions; `cancel` says whether one was stopped.
 */
export const mfaResetViewSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('code_sent'),
      resetId: z.string().guid(),
      email: z.string(),
      codeExpiresAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      state: z.literal('waiting'),
      resetId: z.string().guid(),
      completesAt: z.string().datetime({ offset: true }),
      told: z.object({ email: z.string(), sms: z.literal('vendor.sms').nullable() }).strict(),
    })
    .strict(),
]);
export type MfaResetView = z.infer<typeof mfaResetViewSchema>;
export const mfaResetStatusSchema = z
  .object({
    waiting: z
      .object({
        resetId: z.string().guid(),
        waitingSince: z.string().datetime({ offset: true }),
        completesAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const mfaResetCancelSchema = z.object({ cancelled: z.boolean() }).strict();
/**
 * Support-assisted recovery (I-signin-sessions-24; J-identity-05 #5, J-identity-19), svc-identity's top-level
 * `supportRecovery`. An operator opens a case (masked proved address and live sessions, no link yet), files the
 * `approvalProposal` as a four-eyes approval that a different operator approves, then sends a one-time link to the
 * account's proved address. No answer ever carries the link. `state` reads `expired` once a sent link's lifetime ended.
 * `redeem` is the signed-out page the link opens: it answers only that the account was recovered.
 */
export const supportRecoveryCaseSchema = z
  .object({
    caseId: z.string().guid(),
    userId: z.string().guid(),
    handle: z.string(),
    state: z.enum(['open', 'link_sent', 'used', 'cancelled', 'expired']),
    reason: z.string(),
    openedBy: z.string().guid(),
    openedAt: z.string().datetime({ offset: true }),
    approvedBy: z.string().guid().nullable(),
    linkSentAt: z.string().datetime({ offset: true }).nullable(),
    linkExpiresAt: z.string().datetime({ offset: true }).nullable(),
    usedAt: z.string().datetime({ offset: true }).nullable(),
    closedAt: z.string().datetime({ offset: true }).nullable(),
    contact: z.object({ email: z.string().nullable(), emailProved: z.boolean() }).strict(),
    sessions: z.array(
      z
        .object({
          deviceLabel: z.string().nullable(),
          created: z.string().datetime({ offset: true }),
          lastSeen: z.string().datetime({ offset: true }),
        })
        .strict(),
    ),
    approvalProposal: z
      .object({
        actionType: z.literal('identity.support_recovery_link'),
        targetService: z.literal('svc-identity'),
        targetId: z.string().guid(),
        expectedVersion: z.literal('1'),
        payloadHash: z.string(),
      })
      .strict(),
  })
  .strict();
export type SupportRecoveryCase = z.infer<typeof supportRecoveryCaseSchema>;
export const supportRecoveryRedeemSchema = z.object({ recovered: z.literal(true) }).strict();
/**
 * A mail another service asks identity to send to a customer's own proved address (`POST /internal/mail`, service
 * credentials). Identity holds the address, so the caller names the account and never sees or sends one. Each purpose
 * has one link shape that identity builds from `token`, and one caller allowed to ask for it:
 * - `withdraw-address-approval` (svc-bank, W-withdraw new-address approval): `approveAddress?token=<token>`.
 *
 * `key` is the caller's business key (for example `address-approval:<addressId>:<n>`). The same key with the same body
 * answers with the first mail and sends nothing more, even after the link expired; the same key with a different body is refused
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
    /** When the link stops working, as the caller enforces it. Shown in the mail. Identity refuses a time past or more than seven days ahead. */
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ServiceMailRequest = z.infer<typeof serviceMailRequestSchema>;
export const serviceMailAcceptedSchema = z.object({ accepted: z.literal(true), mailId: z.string().guid() }).strict();
export type ServiceMailAccepted = z.infer<typeof serviceMailAcceptedSchema>;
/**
 * Whether a trusted device (the `dev` claim on an access token) may still be relied on, read by another service at the
 * moment it acts (`GET /internal/trusted-devices/:userId/:deviceId`, service credentials). A token's `dev` names the
 * device it was minted on; it does not prove the device is still trusted, so a caller that lets one device approve
 * another's request asks here each time.
 * - `live`: the device belongs to that account, is not removed, has not run past its trusted time, and the account is
 *   active.
 * - `trustedBy`: how it came to be trusted. `sign-up` (the device the account was made on) and `approval` (approved by
 *   a mailed code, or from another device that was itself proved) were proved; `sign-in` was trusted as it signed in
 *   while the new-device check was off (or was approved from such a device), so anyone holding the account's factors
 *   could have made it. Devices trusted before this was recorded read `sign-in`.
 * - `newDeviceCheck`: the owner's setting now (`IDENTITY_NEW_DEVICE_CHECK`); blank answers `off`.
 * An unknown device, or one of another account, answers 200 with `live: false` and `trustedBy: null` (never a 404), so
 * a caller relies on a device only when `live` is true.
 */
export const TRUSTED_DEVICE_READ_PATH = '/internal/trusted-devices/:userId/:deviceId' as const;
export function trustedDeviceReadPath(userId: string, deviceId: string): string {
  return `/internal/trusted-devices/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}`;
}
export const trustedDeviceTrustedBySchema = z.enum(['sign-up', 'sign-in', 'approval']);
export type TrustedDeviceTrustedBy = z.infer<typeof trustedDeviceTrustedBySchema>;
export const trustedDeviceStateSchema = z
  .object({
    live: z.boolean(),
    trustedBy: trustedDeviceTrustedBySchema.nullable(),
    newDeviceCheck: z.enum(['on', 'off']),
  })
  .strict();
export type TrustedDeviceState = z.infer<typeof trustedDeviceStateSchema>;
/**
 * Whether a message was signed by a wallet linked to an account (`POST /internal/wallet-signatures/verify`, service
 * credentials). Identity holds the links (`wallet_identities`, made by a signed EIP-4361 challenge), so a service that
 * needs a person's wallet signature on its own message asks here instead of keeping a copy. Identity recovers the signer
 * from an EIP-191 `personal_sign` signature over `message` exactly as sent; it stores nothing and decides nothing else.
 * - `linked`: the signer is a wallet linked to `userId` (`address`, lower-case).
 * - `no_wallet`: the account has no linked wallet, so nothing it signs can be checked.
 * - `not_linked`: the signature is readable but its signer is not one of the account's wallets.
 * - `account_inactive`: the account is not active (frozen, closed) or is under a security lock; nothing it signs counts.
 * - `invalid`: no signer can be recovered, or the signature is not in its one canonical form (v 27 or 28, low s), so the
 *   same signed message never verifies under two different signature strings.
 * The caller words its own message and binds what it means (its record, the person) into it.
 */
export const WALLET_SIGNATURE_VERIFY_PATH = '/internal/wallet-signatures/verify' as const;
export const walletSignatureVerifyRequestSchema = z
  .object({
    userId: z.string().guid(),
    message: z.string().min(1).max(4096),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  })
  .strict();
export type WalletSignatureVerifyRequest = z.infer<typeof walletSignatureVerifyRequestSchema>;
export const walletSignatureVerifySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('linked'), address: z.string().regex(/^0x[0-9a-f]{40}$/) }).strict(),
  z.object({ state: z.literal('no_wallet') }).strict(),
  z.object({ state: z.literal('not_linked') }).strict(),
  z.object({ state: z.literal('account_inactive') }).strict(),
  z.object({ state: z.literal('invalid') }).strict(),
]);
export type WalletSignatureVerify = z.infer<typeof walletSignatureVerifySchema>;
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
