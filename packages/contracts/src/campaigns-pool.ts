import { z } from 'zod';
import { asset, campaignDecimal, id, iso, signedDecimal } from './campaigns-base.js';

/** The refusals a reward pool paying daily (J-campaigns-13 #4 #5) names; `campaigns-kinds.ts` adds them to `CAMPAIGN_REFUSAL_CODES`. */
export const POOL_REFUSAL_CODES = [
  'campaigns.pool_invalid',
  'campaigns.pool_unset',
  'campaigns.not_pool',
  'campaigns.pool_day_open',
  'campaigns.pool_day_unknown',
] as const;

// ── Reward pools paying daily (CM-airdrop-campaigns-02, J-campaigns-13 #4 #5) ───────────────────────────────────────

/**
 * A `pool` campaign's terms. Its pool is the campaign's budget, INTAFACED's own money, paid out one day's slice at a
 * time. A day is `daySeconds` long from the campaign's start (a calendar day is 86 400). When a day has ended it is
 * settled once: each entrant's activity is the notional of the venue's fills of their orders placed through INTAFACED
 * during that day, in `activityAsset`; an entrant whose venue equity in that asset is below `minBalance` earns nothing
 * that day and is left out of the total. Each share is the slice times the entrant's activity over the total, up to
 * `perUserCap`; what a cap keeps back stays in the pool. Shares plus the unspent remainder equal the slice. Every blank
 * refuses activation `campaigns.pool_unset`.
 */
export const campaignPoolSchema = z
  .object({
    activityAsset: asset.nullable(),
    dailySlice: campaignDecimal.nullable(),
    perUserCap: campaignDecimal.nullable(),
    minBalance: campaignDecimal.nullable(),
    daySeconds: z
      .number()
      .int()
      .min(60)
      .max(31 * 86_400)
      .nullable(),
  })
  .strict();
export type CampaignPool = z.infer<typeof campaignPoolSchema>;

/** One account's line of a settled day. */
export const poolDayMineSchema = z
  .object({
    activity: campaignDecimal,
    balance: signedDecimal,
    balanceAsOf: iso,
    /** False when the venue equity was below the minimum balance: nothing that day. */
    eligible: z.boolean(),
    share: campaignDecimal,
    /** True when the per-user cap held the share back. */
    capped: z.boolean(),
    rewardKey: z.string().nullable(),
    state: z.string().nullable(),
    chainTx: z.string().nullable(),
  })
  .strict();

export const poolDaySchema = z
  .object({
    day: z.number().int().positive(),
    startsAt: iso,
    endsAt: iso,
    settledAt: iso.nullable(),
    slice: campaignDecimal,
    totalActivity: campaignDecimal.nullable(),
    sharesTotal: campaignDecimal.nullable(),
    remainder: campaignDecimal.nullable(),
    mine: poolDayMineSchema.nullable(),
  })
  .strict();
export type PoolDay = z.infer<typeof poolDaySchema>;

/** `pool.board`: a pool's terms, each day that has started with the caller's share once settled, and today as it stands. */
export const poolBoardSchema = z
  .object({
    campaignId: id,
    asset,
    pool: campaignDecimal,
    activityAsset: asset,
    dailySlice: campaignDecimal,
    perUserCap: campaignDecimal,
    minBalance: campaignDecimal,
    daySeconds: z.number().int().positive(),
    joined: z.boolean(),
    days: z.array(poolDaySchema),
    /** The day under way, with the caller's venue equity read now; null when none is under way or the caller has not joined. */
    today: z
      .object({
        day: z.number().int().positive(),
        endsAt: iso,
        balance: signedDecimal.nullable(),
        balanceAsOf: iso.nullable(),
        /** True when the balance read is below the minimum: nothing today. Null while it could not be read. */
        belowMinimum: z.boolean().nullable(),
        unread: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PoolBoard = z.infer<typeof poolBoardSchema>;
export const poolBoardInputSchema = z.object({ campaignId: id }).strict();
/** `ops.campaigns.pool.settle`: settles one ended day, once; settling it again returns the day as it was settled. */
export const poolSettleInputSchema = z
  .object({ campaignId: id, day: z.number().int().positive(), reason: z.string().trim().min(3).max(500) })
  .strict();
export const poolSettleSchema = z.object({ settled: z.boolean(), day: poolDaySchema.omit({ mine: true }) }).strict();
