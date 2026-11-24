import { z } from 'zod';
import { REWARD_STATES } from './campaigns-rewards.js';

/**
 * svc-campaigns seasons, limited drops and the TGE claim (RC-campaigns-04, RC-campaigns-05; J-campaigns-20 #4-#6).
 * Shared by the service (its inputs and outputs) and the customer app (what it reads). Browser-safe: zod only.
 *
 * Counts are whole numbers. A season's points are a decimal string. A drop with no campaign is an entitlement: a claim
 * records the right and moves nothing. A drop with value names its `drop` campaign, whose reward is what each claim is
 * worth and whose budget pays it: each claim is owed once through the reward saga and paid once to the claimer's
 * connected wallet, the payment's chain reference recorded (`reward` on the claim).
 */

/** Every refusal svc-campaigns names. The code leads the tRPC message in brackets, `... [drop.sold_out]`. */
export const CAMPAIGNS_REFUSAL_CODES = [
  'campaigns.window_unset',
  'campaigns.timezone_unset',
  'campaigns.window_invalid',
  'campaigns.second_person_required',
  'campaigns.already_published',
  'campaigns.reward_saga_unwired',
  'campaigns.store_unwired',
  'season.unknown',
  'season.not_published',
  'drop.unknown',
  'drop.count_unset',
  'drop.count_invalid',
  'drop.not_open',
  'drop.sold_out',
  'drop.campaign_invalid',
  'campaign.not_active',
  'campaigns.budget_unset',
  'campaigns.budget_exhausted',
  'campaigns.budget_asset_mismatch',
  'campaigns.per_customer_limit_unset',
  'campaigns.customer_limit_reached',
  'campaigns.redemption_limit_reached',
  'launch.schedule_unset',
  'audit.external',
  'chain.go',
] as const;
export type CampaignsRefusalCode = (typeof CAMPAIGNS_REFUSAL_CODES)[number];

const id = z.string().min(1).max(128);
const iso = z.string().datetime({ offset: true });

export const SEASON_STATES = ['upcoming', 'live'] as const;
export const DROP_STATES = ['not_open', 'open', 'sold_out', 'closed'] as const;
export const PUBLISH_STATES = ['draft', 'published'] as const;
/** `entitlement`: a claim records the right and moves no value. `value`: a claim is owed and paid its campaign's reward. */
export const DROP_KINDS = ['entitlement', 'value'] as const;

const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);

/** What one claim of a drop with value is worth: its campaign's reward. */
export const dropValueSchema = z.object({ campaignId: id, asset: z.string(), amount: decimal });
export type DropValue = z.infer<typeof dropValueSchema>;

/**
 * The reward one claim of a drop with value is owed: its state in the reward saga and, once paid, the wallet it went to
 * and the chain transaction that paid it. Null on an entitlement.
 */
export const dropRewardSchema = z.object({
  rewardKey: z.string(),
  asset: z.string(),
  amount: decimal,
  state: z.enum(REWARD_STATES),
  /** The connected wallet it is paid to; null until one is read for the person. */
  payTo: z.string().nullable(),
  /** The chain transaction that paid it, once its payment is booked. */
  chainTx: z.string().nullable(),
});
export type DropReward = z.infer<typeof dropRewardSchema>;

export const seasonSchema = z.object({
  id,
  name: z.string(),
  startsAt: iso,
  endsAt: iso,
  status: z.enum(PUBLISH_STATES),
  createdBy: z.string(),
  publishedBy: z.string().nullable(),
  createdAt: iso,
  publishedAt: iso.nullable(),
});
export type Season = z.infer<typeof seasonSchema>;

export const dropSchema = z.object({
  id,
  title: z.string(),
  seasonId: id.nullable(),
  /** The fixed number of claims. */
  count: z.number().int().positive(),
  /** Claims still open. Never below zero. */
  remaining: z.number().int().min(0),
  opensAt: iso,
  closesAt: iso.nullable(),
  kind: z.enum(DROP_KINDS),
  value: dropValueSchema.nullable(),
  status: z.enum(PUBLISH_STATES),
  createdBy: z.string(),
  publishedBy: z.string().nullable(),
  createdAt: iso,
  publishedAt: iso.nullable(),
});
export type Drop = z.infer<typeof dropSchema>;

export const dropClaimSchema = z.object({
  dropId: id,
  /** `drop:<dropId>:<account>`: one claim per account, a retry returns this row. */
  claimKey: z.string(),
  kind: z.enum(DROP_KINDS),
  claimedAt: iso,
  reward: dropRewardSchema.nullable(),
});
export type DropClaim = z.infer<typeof dropClaimSchema>;

/** A published season as the customer sees it, with the caller's points summed from the season's task campaigns. */
export const seasonViewSchema = z.object({
  id,
  name: z.string(),
  startsAt: iso,
  endsAt: iso,
  state: z.enum(SEASON_STATES),
  /** Sum of the caller's reward points from this season's task campaigns, read from reward records. */
  points: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/),
  /** How many task campaigns feed the season. Zero means no points can accrue yet. */
  taskCampaigns: z.number().int().min(0),
  /**
   * Why season points are not running: `owner.decision` while the points campaign type is parked (J-campaigns-15: whether a
   * points programme whose points have value runs). Null once points run.
   */
  pointsBlocker: z.literal('owner.decision').nullable(),
});
export type SeasonView = z.infer<typeof seasonViewSchema>;

export const dropViewSchema = z.object({
  id,
  title: z.string(),
  seasonId: id.nullable(),
  count: z.number().int().positive(),
  remaining: z.number().int().min(0),
  opensAt: iso,
  closesAt: iso.nullable(),
  kind: z.enum(DROP_KINDS),
  value: dropValueSchema.nullable(),
  state: z.enum(DROP_STATES),
  /** The caller's own claim, or null. */
  mine: dropClaimSchema.nullable(),
});
export type DropView = z.infer<typeof dropViewSchema>;

export const TGE_NETWORKS = ['testnet', 'mainnet'] as const;
export type TgeNetwork = (typeof TGE_NETWORKS)[number];

/** The owner's TGE schedule. Blank: every claim refuses `launch.schedule_unset`. */
export const tgeScheduleSchema = z.object({ claimOpensAt: iso });
export type TgeSchedule = z.infer<typeof tgeScheduleSchema>;

export const tgeViewSchema = z.object({
  schedule: tgeScheduleSchema.nullable(),
  /** Why a claim cannot run today, in the order it is checked. Never says audited. */
  networks: z.array(
    z.object({
      network: z.enum(TGE_NETWORKS),
      /** The testnet path is labelled as such on every surface. */
      label: z.enum(['Testnet', 'Mainnet']),
      blocker: z.enum(['launch.schedule_unset', 'audit.external', 'chain.go']),
    }),
  ),
});
export type TgeView = z.infer<typeof tgeViewSchema>;

/** `campaigns.drops.room`: the caller's drop phase in one read. The waitlist part is read from identity. */
export const dropRoomSchema = z.object({
  season: seasonViewSchema.nullable(),
  drops: z.array(dropViewSchema),
  tge: tgeViewSchema,
});
export type DropRoom = z.infer<typeof dropRoomSchema>;

export const dropClaimInputSchema = z.object({ dropId: id }).strict();
export const dropClaimResultSchema = z.object({
  claim: dropClaimSchema,
  /** False when the account had already claimed: the first claim is returned. */
  created: z.boolean(),
  remaining: z.number().int().min(0),
});
export type DropClaimResult = z.infer<typeof dropClaimResultSchema>;

export const tgeClaimInputSchema = z.object({ network: z.enum(TGE_NETWORKS) }).strict();

/** Operator inputs (`campaigns:ops`). Dates and the count are strings so a blank one refuses by name. */
export const seasonCreateInputSchema = z
  .object({ name: z.string().trim().min(1).max(120), startsAt: z.string().max(64), endsAt: z.string().max(64) })
  .strict();
export const dropCreateInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    seasonId: id.nullish(),
    count: z.string().max(16),
    opensAt: z.string().max(64),
    closesAt: z.string().max(64).nullish(),
    /** A drop with value: its `drop` campaign, whose reward each claim is worth and whose budget pays it. */
    campaignId: id.nullish(),
  })
  .strict();
export const publishInputSchema = z.object({ id }).strict();
