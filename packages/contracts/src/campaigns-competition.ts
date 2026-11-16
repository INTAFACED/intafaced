import { z } from 'zod';
import { asset, campaignDecimal, id, iso } from './campaigns-base.js';

/** The refusals a trading competition (J-campaigns-11) names; `campaigns-kinds.ts` adds them to `CAMPAIGN_REFUSAL_CODES`. */
export const COMPETITION_REFUSAL_CODES = [
  'campaigns.competition_invalid',
  'campaigns.competition_unset',
  'campaigns.prize_pool_short',
  'campaigns.seats_full',
  'campaigns.not_competition',
  'campaigns.fills_unread',
] as const;

// ── Trading competitions (CM-promotions-events-01, J-campaigns-11) ─────────────────────────────────────────────────

/**
 * What a competition ranks by. Only `volume` is built: ranking by returns waits for the owner (OWNER 87) and refuses
 * activation `owner.decision`.
 */
export const COMPETITION_BASES = ['volume', 'returns'] as const;
export type CompetitionBasis = (typeof COMPETITION_BASES)[number];

/** One prize of the table: the place it is for, and what that place is paid from the pool. */
export const competitionPrizeSchema = z.object({ rank: z.number().int().min(1).max(100), amount: campaignDecimal }).strict();
/** A milestone tier: the volume that reaches it, and the prize each entrant who reaches it is queued once. */
export const competitionMilestoneSchema = z.object({ volume: campaignDecimal, amount: campaignDecimal }).strict();

/**
 * A `competition` campaign's terms. The prize pool is the campaign's budget (its asset and limit): every prize is
 * INTAFACED's own money, owed once and paid once to the winner's connected wallet. Volume is the notional of the venue's
 * own fills of orders placed through INTAFACED, in `volumeAsset` (the quote asset of the markets that count), counted once
 * per fill; a fill with no builder fee of ours (zero or below) adds nothing. `threshold` is the volume an entrant needs to
 * rank for a place prize; `seats` how many may enter. Every value is the operator's: blank refuses activation
 * `campaigns.competition_unset`, never a default.
 */
export const campaignCompetitionSchema = z
  .object({
    basis: z.enum(COMPETITION_BASES),
    volumeAsset: asset.nullable(),
    threshold: campaignDecimal.nullable(),
    seats: z.number().int().min(1).max(100_000).nullable(),
    prizes: z.array(competitionPrizeSchema).max(100),
    milestones: z.array(competitionMilestoneSchema).max(10),
  })
  .strict();
export type CampaignCompetition = z.infer<typeof campaignCompetitionSchema>;

/** One place on the leaderboard: entrants are shown by their seat, never by who they are, and the caller is marked. */
export const competitionStandingSchema = z
  .object({
    rank: z.number().int().positive(),
    seat: z.number().int().positive(),
    you: z.boolean(),
    volume: campaignDecimal,
    fills: z.number().int().min(0),
    /** True once the volume reaches the threshold, so the place can win its prize. */
    qualifies: z.boolean(),
  })
  .strict();

/** A milestone as the caller sees it: reached or not, and its prize queued (owed) once when reached. */
export const competitionMilestoneViewSchema = z
  .object({
    tier: z.number().int().positive(),
    volume: campaignDecimal,
    amount: campaignDecimal,
    reached: z.boolean(),
    reachedAt: iso.nullable(),
    rewardKey: z.string().nullable(),
  })
  .strict();

/**
 * `competition.board`: the competition's terms, seats left, the leaderboard (volume, high to low; a tie keeps the
 * earlier seat first, so the order never changes between reads), the caller's own entry and milestones, and the period's
 * settlement once it closed. `asOf` is when the venue's fills were last read; `unread` names a read that failed.
 */
export const competitionBoardSchema = z
  .object({
    campaignId: id,
    period: z.string(),
    basis: z.enum(COMPETITION_BASES),
    volumeAsset: asset,
    threshold: campaignDecimal,
    prizeAsset: asset,
    pool: campaignDecimal,
    prizes: z.array(competitionPrizeSchema),
    seats: z.number().int().positive(),
    seatsLeft: z.number().int().min(0),
    closesAt: iso,
    closed: z.boolean(),
    standings: z.array(competitionStandingSchema).max(500),
    mine: z
      .object({ seat: z.number().int().positive(), joinedAt: iso, volume: campaignDecimal, rank: z.number().int().positive() })
      .strict()
      .nullable(),
    milestones: z.array(competitionMilestoneViewSchema),
    settlement: z
      .object({
        settledAt: iso,
        winners: z.array(
          z
            .object({ rank: z.number().int().positive(), seat: z.number().int().positive(), you: z.boolean(), amount: campaignDecimal })
            .strict(),
        ),
        /** Every prize owed from the pool: places and milestones. */
        prizesTotal: campaignDecimal,
        /** What is left of the pool: pool less every prize. */
        remainder: campaignDecimal,
      })
      .strict()
      .nullable(),
    asOf: iso.nullable(),
    unread: z.string().nullable(),
  })
  .strict();
export type CompetitionBoard = z.infer<typeof competitionBoardSchema>;
export const competitionBoardInputSchema = z.object({ campaignId: id }).strict();
