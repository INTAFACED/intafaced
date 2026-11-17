import { z } from 'zod';
import { asset, campaignDecimal, id, iso } from './campaigns-base.js';
import { competitionPrizeSchema } from './campaigns-competition.js';

/** The refusals a lucky draw (J-campaigns-12) names; `campaigns-kinds.ts` adds them to `CAMPAIGN_REFUSAL_CODES`. */
export const DRAW_REFUSAL_CODES = ['campaigns.draw_invalid', 'campaigns.draw_unset', 'campaigns.not_draw'] as const;

// ── Lucky draws (CM-promotions-events-02, J-campaigns-12) ──────────────────────────────────────────────────────────

/** The user types a draw caps chances by: the verification level svc-identity reports for the account. */
export const DRAW_USER_TYPES = ['none', 'basic', 'full', 'institutional'] as const;
export type DrawUserType = (typeof DRAW_USER_TYPES)[number];

/** The most chances one user type may hold: blank refuses activation `campaigns.draw_unset`, never a default. */
export const drawCapSchema = z.object({ userType: z.enum(DRAW_USER_TYPES), cap: z.number().int().min(0).max(10_000).nullable() }).strict();

/**
 * A `draw` campaign's terms. Chances are earned by activity: `chancesPerFill` for each fill the venue reports of an order
 * the entrant placed through INTAFACED after joining (our builder fee above zero), counted once per fill, up to the cap
 * for the entrant's user type. The prize table is paid from the campaign's budget, each prize to a different entrant.
 * Running, settling and paying a draw wait for the owner's decision on chance-based rewards: until it is
 * recorded they refuse `owner.decision`, and nothing is paid.
 */
export const campaignDrawSchema = z
  .object({
    chancesPerFill: z.number().int().min(1).max(100).nullable(),
    caps: z.array(drawCapSchema).max(DRAW_USER_TYPES.length),
    prizes: z.array(competitionPrizeSchema).max(100),
  })
  .strict();
export type CampaignDraw = z.infer<typeof campaignDrawSchema>;

/** The question a draw's run waits on, named in plain words wherever it refuses. */
export const DRAW_OWNER_QUESTION = 'Does INTAFACED run chance-based rewards such as a lucky draw, and under what legal form?';

/**
 * `draw.board`: a draw's terms, the odds as they stand (each prize goes to one chance drawn from every chance held, one
 * prize per entrant), the caller's own chances and the cap for their user type, and the draw's audit trail: the seed's
 * commitment (SHA-256 of the seed, fixed before any entry) and the hash of the entry list as it stands. `running` names
 * why the draw does not run; `revealed` and `winners` stay empty until a draw has run, which it never does while the
 * owner decision is open.
 */
export const drawBoardSchema = z
  .object({
    campaignId: id,
    prizeAsset: asset,
    pool: campaignDecimal,
    prizes: z.array(competitionPrizeSchema),
    chancesPerFill: z.number().int().positive(),
    caps: z.array(z.object({ userType: z.enum(DRAW_USER_TYPES), cap: z.number().int().min(0) }).strict()),
    closesAt: iso,
    closed: z.boolean(),
    entrants: z.number().int().min(0),
    totalChances: z.number().int().min(0),
    /** SHA-256 of the seed, hex. */
    commitment: z.string().regex(/^[0-9a-f]{64}$/),
    /** SHA-256 of the entry list (each entrant's id hash and chances, in join order), hex. */
    entryHash: z.string().regex(/^[0-9a-f]{64}$/),
    mine: z
      .object({
        joinedAt: iso,
        /** Null while svc-identity could not be read; chances then stay as last counted. */
        userType: z.enum(DRAW_USER_TYPES).nullable(),
        cap: z.number().int().min(0).nullable(),
        chances: z.number().int().min(0),
        fills: z.number().int().min(0),
        /** True once the chances reached the cap: further activity adds none. */
        capped: z.boolean(),
      })
      .strict()
      .nullable(),
    running: z.object({ code: z.literal('owner.decision'), question: z.string() }).strict(),
    revealed: z.object({ seed: z.string(), entryHash: z.string() }).strict().nullable(),
    winners: z.array(z.object({ rank: z.number().int().positive(), you: z.boolean(), amount: campaignDecimal }).strict()),
    asOf: iso.nullable(),
    unread: z.string().nullable(),
  })
  .strict();
export type DrawBoard = z.infer<typeof drawBoardSchema>;
export const drawBoardInputSchema = z.object({ campaignId: id }).strict();
/** `ops.campaigns.draw.run` and `ops.campaigns.draw.settle`: refused `owner.decision` while the decision is open. */
export const drawRunInputSchema = z.object({ campaignId: id, reason: z.string().trim().min(3).max(500) }).strict();
