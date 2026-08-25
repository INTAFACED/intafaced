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
  userId: z.string().uuid(),
  /** `identity.users.status` — the freeze/close fact, read never written here. */
  status: z.enum(['active', 'frozen', 'closed']),
  /** Highest approved, unexpired tier. Derived by identity, not stored twice. */
  kycTier: kycTierSchema,
});
export type AccountState = z.infer<typeof accountStateSchema>;

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
  userId: z.string().uuid(),
  rank: z.number().int().min(0),
  xp: z.string(),
  seasonXp: z.string(),
  nextRankAt: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type RankState = z.infer<typeof rankStateSchema>;

export const getRankInput = z.object({ userId: z.string().uuid() });
export const getPerksInput = z.object({ userId: z.string().uuid() });

export const awardXpInput = z.object({
  userId: z.string().uuid(),
  sourceModule: z.string().min(1),
  action: z.string().min(1),
  xpDelta: z.number().int(),
  /** Dedupe key — the same achievement must never be paid twice. */
  idempotencyKey: z.string().min(8),
  meta: z.record(z.unknown()).optional(),
});

export const principalSummarySchema = z.object({
  userId: z.string().uuid(),
  handle: z.string(),
  tier: kycTierSchema,
  region: z.string().length(2).nullable(),
  rank: z.number().int(),
  modes: z.array(z.enum(['trader', 'merchant', 'creator', 'student'])),
  blueprintId: z.string().uuid().nullable(),
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
  id: z.string().uuid(),
  parentUserId: z.string().uuid(),
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
  id: z.string().uuid(),
  userId: z.string().uuid(),
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
  id: z.string().uuid(),
  userId: z.string().uuid(),
  revoked: z.boolean(),
});
export type SessionOwnership = z.infer<typeof sessionOwnershipSchema>;
