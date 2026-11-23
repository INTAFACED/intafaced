import { z } from 'zod';
import { asset, campaignDecimal, id, iso } from './campaigns-base.js';

/** The question a tier on a points basis waits on, named in plain words wherever it is shown. */
export const POINTS_TIER_OWNER_QUESTION =
  'Should a loyalty tier be reached on points, and with which thresholds and point values? Until the owner decides, tiers are reached on spend only.';

// ── Points programme (CM-rewards-hub-04, J-campaigns-15) ───────────────────────────────────────────────────────────

/**
 * The owner question the points programme waits on, in plain words. Until the owner answers it, every press that would
 * earn, spend, expire, release, redeem or convert points refuses `owner.decision` naming it, and no points are stored.
 */
export const POINTS_OWNER_QUESTION =
  'Whether INTAFACED runs a points programme whose points have value or convert to cash. Until the owner answers, no points are earned, kept, redeemed or converted.';

/** A programme's lifecycle (ENGINE LC-1 to LC-4), in order. */
export const POINTS_LIFECYCLE = ['draft', 'active', 'paused', 'ended'] as const;
export type PointsLifecycleStage = (typeof POINTS_LIFECYCLE)[number];

/** How points would expire: never, a rolling horizon from each earning, a calendar date, or after inactivity. */
export const POINTS_EXPIRY_MODES = ['never', 'rolling', 'calendar', 'inactivity'] as const;
export type PointsExpiryMode = (typeof POINTS_EXPIRY_MODES)[number];

/**
 * The benefits the catalogue offers for points: a fee-saver coupon (part of our builder fee off venue orders,
 * J-campaigns-09), a voucher in the reward asset (J-campaigns-08) and a place in a limited drop (J-campaigns-20). Their
 * prices in points, stock and per-person limits are owner values.
 */
export const POINTS_CATALOGUE_ITEMS = ['fee_saver', 'cash_voucher', 'drop_place'] as const;
export type PointsCatalogueItem = (typeof POINTS_CATALOGUE_ITEMS)[number];

/** A whole number of points, as a string. */
const points = z.string().regex(/^(0|[1-9]\d{0,19})$/);

/**
 * The points programme as a signed-in customer reads it. Every number is null while it is not kept or not set: no
 * balance, member count, horizon, price, stock, limit, rate or minimum is ever filled in. `blocker` names the owner
 * question while it is open.
 */
export const pointsProgrammeSchema = z.object({
  blocker: z.object({ code: z.literal('owner.decision'), question: z.string() }).nullable(),
  lifecycle: z.object({ stages: z.array(z.enum(POINTS_LIFECYCLE)), current: z.enum(POINTS_LIFECYCLE).nullable() }),
  /** The caller's own points wallet: null while no points are kept. */
  wallet: z.object({ available: points.nullable(), pending: points.nullable(), expiring: points.nullable() }),
  /** How many customers take part: null while the programme does not run. */
  members: z.object({ count: z.number().int().min(0).nullable() }),
  expiry: z.object({
    current: z.enum(POINTS_EXPIRY_MODES).nullable(),
    modes: z.array(z.object({ mode: z.enum(POINTS_EXPIRY_MODES), horizonSeconds: z.number().int().positive().nullable() })),
  }),
  /** The caller's points waiting to become available, each with when it would; none while no points are kept. */
  pending: z.array(z.object({ id, points, availableAt: iso })),
  catalogue: z.array(
    z.object({
      id: z.enum(POINTS_CATALOGUE_ITEMS),
      pricePoints: points.nullable(),
      stock: z.number().int().min(0).nullable(),
      perPersonLimit: z.number().int().positive().nullable(),
    }),
  ),
  conversion: z.object({ rate: campaignDecimal.nullable(), asset: asset.nullable(), minimumPoints: points.nullable() }),
});
export type PointsProgramme = z.infer<typeof pointsProgrammeSchema>;

export const pointsRedeemInputSchema = z.object({ itemId: z.enum(POINTS_CATALOGUE_ITEMS) }).strict();
export const pointsConvertInputSchema = z.object({}).strict();
