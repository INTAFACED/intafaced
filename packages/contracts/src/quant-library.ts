/**
 * The strategy library (J-algo-dev-09, AL-library-01 and AL-library-02): a developer publishes one version of a strategy
 * after its checks pass and the realism checklist is accepted; other people browse open listings in registration order,
 * open an invite-only one only under the owner's grant, clone an open one into their own library, and review one only
 * after running their clone.
 *
 * Browser safe. Nothing here is money: every listing is free, every figure is a stored historical simulation, and a
 * listing is never ranked by return.
 */
import { z } from 'zod';

/** Who may see a listing. Open: anyone, source included. Protected: anyone, never the source. Invite: granted people. */
export const QUANT_LISTING_VISIBILITIES = ['open', 'protected', 'invite'] as const;
export type QuantListingVisibility = (typeof QUANT_LISTING_VISIBILITIES)[number];

/** The closed list of tags a listing is filed under. */
export const QUANT_LIBRARY_TAGS = ['trend', 'mean-reversion', 'momentum', 'breakout', 'swing', 'scalping'] as const;
export type QuantLibraryTag = (typeof QUANT_LIBRARY_TAGS)[number];

/** The checks a version passes before it is listed, in the order the screen shows them. */
export const QUANT_LISTING_CHECKS = ['version', 'backtest', 'costs', 'claim', 'licence'] as const;
export type QuantListingCheckId = (typeof QUANT_LISTING_CHECKS)[number];

/** The longest title and description, and the most tags: bounds on the input, not product limits. */
export const QUANT_LISTING_TITLE_MAX = 120;
export const QUANT_LISTING_DESCRIPTION_MAX = 4000;
export const QUANT_LISTING_TAGS_MAX = 3;
export const QUANT_REVIEW_TEXT_MAX = 2000;

/** The label every stored result in the library carries. */
export const QUANT_LIBRARY_RESULT_LABEL = 'Historical simulation — not a forecast' as const;

/** The owner's licence list and realism checklist as published; null is not set, and publishing then refuses by name. */
export const quantLibraryOptionsSchema = z.object({
  licences: z.array(z.string()).nullable(),
  checklist: z.object({ version: z.string(), items: z.array(z.string()) }).nullable(),
  tags: z.array(z.enum(QUANT_LIBRARY_TAGS)),
  visibilities: z.array(z.enum(QUANT_LISTING_VISIBILITIES)),
});
export type QuantLibraryOptions = z.infer<typeof quantLibraryOptionsSchema>;

const listingDetails = {
  strategyId: z.string().min(1).max(128),
  strategyVersion: z.number().int().positive(),
  title: z.string().max(QUANT_LISTING_TITLE_MAX),
  description: z.string().max(QUANT_LISTING_DESCRIPTION_MAX),
  tags: z.array(z.enum(QUANT_LIBRARY_TAGS)).max(QUANT_LISTING_TAGS_MAX),
  visibility: z.enum(QUANT_LISTING_VISIBILITIES),
  licence: z.string().max(200),
};

/** `library.check`: the publish checks of one version and its text. Writes nothing. */
export const quantListingCheckInputSchema = z.object(listingDetails);
export type QuantListingCheckInput = z.infer<typeof quantListingCheckInputSchema>;

export const quantListingCheckSchema = z.object({
  strategyId: z.string(),
  strategyVersion: z.number().int().positive(),
  passed: z.boolean(),
  checks: z.array(z.object({ id: z.enum(QUANT_LISTING_CHECKS), passed: z.boolean(), detail: z.string() })),
});
export type QuantListingCheck = z.infer<typeof quantListingCheckSchema>;

/** `library.publish`: the same details, the checklist version the screen showed, and whether every item was accepted. */
export const quantListingPublishInputSchema = z.object({
  ...listingDetails,
  checklistVersion: z.string().max(200),
  checklistAccepted: z.boolean(),
});
export type QuantListingPublishInput = z.infer<typeof quantListingPublishInputSchema>;

/** One access row of an invite-only listing, newest state per person. */
export const quantListingAccessSchema = z.object({
  userId: z.string().guid(),
  state: z.enum(['requested', 'granted', 'revoked']),
  at: z.string(),
  /** How many access rows this person has on this listing: the screen keys its next grant or revoke with it. */
  rows: z.number().int().nonnegative(),
});
export type QuantListingAccess = z.infer<typeof quantListingAccessSchema>;

/** A listing as its owner reads it. Stale: the strategy has a newer version than the one listed, or it was deleted. */
export const quantListingSchema = z.object({
  listingId: z.string(),
  strategyId: z.string(),
  strategyVersion: z.number().int().positive(),
  headVersion: z.number().int().positive().nullable(),
  stale: z.boolean(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.enum(QUANT_LIBRARY_TAGS)),
  visibility: z.enum(QUANT_LISTING_VISIBILITIES),
  licence: z.string(),
  checklistVersion: z.string(),
  listedAt: z.string(),
  access: z.array(quantListingAccessSchema),
});
export type QuantListing = z.infer<typeof quantListingSchema>;

export const quantMyListingsSchema = z.object({ listings: z.array(quantListingSchema) });
export type QuantMyListings = z.infer<typeof quantMyListingsSchema>;

/** One row of the library: what anyone may see. Never a return figure, and never sorted by one. */
export const quantLibraryEntrySchema = z.object({
  listingId: z.string(),
  title: z.string(),
  tags: z.array(z.enum(QUANT_LIBRARY_TAGS)),
  visibility: z.enum(['open', 'protected']),
  licence: z.string(),
  strategyVersion: z.number().int().positive(),
  ownerId: z.string().guid(),
  listedAt: z.string(),
});
export type QuantLibraryEntry = z.infer<typeof quantLibraryEntrySchema>;

/** `library.browse`: listings in registration order (oldest first), optionally of one tag. */
export const quantLibraryBrowseInputSchema = z.object({
  tag: z.enum(QUANT_LIBRARY_TAGS).optional().nullable(),
  limit: z.number().int().min(1).max(50),
  cursor: z.string().max(40).optional().nullable(),
});
export const quantLibraryPageSchema = z.object({ entries: z.array(quantLibraryEntrySchema), nextCursor: z.string().nullable() });
export type QuantLibraryPage = z.infer<typeof quantLibraryPageSchema>;

/** `library.preview`: the title and the caller's access, which any signed-in person may read. No results, no source. */
export const quantListingPreviewSchema = z.object({
  listingId: z.string(),
  title: z.string(),
  visibility: z.enum(QUANT_LISTING_VISIBILITIES),
  access: z.enum(['owner', 'open', 'granted', 'requested', 'revoked', 'none']),
  /** How many access rows the caller has on this listing: the screen keys its next request with it. */
  rows: z.number().int().nonnegative(),
});
export type QuantListingPreview = z.infer<typeof quantListingPreviewSchema>;

export const quantListingReviewSchema = z.object({ reviewerId: z.string().guid(), text: z.string(), createdAt: z.string() });
export type QuantListingReview = z.infer<typeof quantListingReviewSchema>;

/** `library.get`: the strategy page. Refused for an invite-only listing the caller holds no grant to. */
export const quantListingPageSchema = z.object({
  listingId: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.enum(QUANT_LIBRARY_TAGS)),
  visibility: z.enum(QUANT_LISTING_VISIBILITIES),
  licence: z.string(),
  strategyVersion: z.number().int().positive(),
  stale: z.boolean(),
  ownerId: z.string().guid(),
  listedAt: z.string(),
  mine: z.boolean(),
  /** The listed version's source; always null for a protected listing. */
  source: z.string().nullable(),
  /** The stored backtest the publish check relied on, labelled as a historical simulation. */
  result: z
    .object({
      runId: z.string(),
      label: z.literal(QUANT_LIBRARY_RESULT_LABEL),
      symbol: z.string(),
      from: z.string(),
      to: z.string(),
      startCash: z.string(),
      net: z.string(),
      endEquity: z.string(),
      trades: z.number().int().nonnegative(),
    })
    .nullable(),
  reviews: z.array(quantListingReviewSchema),
  /** The caller's own clone of this listing, if they made one. */
  clone: z.object({ strategyId: z.string() }).nullable(),
});
export type QuantListingPage = z.infer<typeof quantListingPageSchema>;

/** Where a cloned strategy came from. */
export const quantLineageSchema = z.object({
  strategyId: z.string(),
  listingId: z.string(),
  listingTitle: z.string(),
  sourceVersion: z.number().int().positive(),
  clonedAt: z.string(),
});
export type QuantLineage = z.infer<typeof quantLineageSchema>;
export const quantLineageReadSchema = z.object({ lineage: quantLineageSchema.nullable() });

/** `library.access.*`: request (any signed-in person), grant and revoke (the owner); `seq` is the rows the screen read. */
export const quantAccessRequestInputSchema = z.object({ listingId: z.string().min(1).max(64), seq: z.number().int().nonnegative() });
export const quantAccessSetInputSchema = z.object({
  listingId: z.string().min(1).max(64),
  userId: z.string().max(64),
  seq: z.number().int().nonnegative(),
});

export const quantReviewInputSchema = z.object({ listingId: z.string().min(1).max(64), text: z.string().max(QUANT_REVIEW_TEXT_MAX) });
