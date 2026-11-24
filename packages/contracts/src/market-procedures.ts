import { z } from 'zod';
import { defineProcedure, NO_INPUT, type ReplyCheck, type Refusals, type RefusalStatus } from './procedure.js';
import { assetIdSchema } from './asset-id.js';
import { unsignedAmountSchema } from './wire-amount.js';

/**
 * svc-market's calls that anyone outside svc-market makes, one record per call: the vendor's application and slots, the
 * public shopfront (listings, sellers, reviews), a buyer's purchases and refunds, the signal marketplace, and the four
 * operator calls the admin console makes. svc-market mounts each from here (`mountRecord`), so its path, guard, input,
 * output and named refusals are this file, not its router; the customer app and the admin console call each by its record.
 *
 * Failures that are not named refusals are not listed: a door svc-market's process has not wired (`market.commerce is
 * not wired`), an outside read that failed (`market.stake_unavailable`, sent as INTERNAL_SERVER_ERROR) and an unknown error.
 */

const base = { service: 'svc-market', module: 'market', transport: 'trpc' } as const;
const PUBLIC = { caller: 'public' } as const;
/** A person's own market reads and writes: the scope, then the market's jurisdiction and tier check. */
const READ = { caller: 'scope', scope: 'market:read', module: 'market' } as const;
const WRITE = { caller: 'scope', scope: 'market:write', module: 'market' } as const;
/** The operator desk. No jurisdiction check: an operator is not the subject of the market's rules. */
const OPS = { caller: 'scope', scope: 'market:ops' } as const;

/** Each refusal by its code, with the status svc-market sends it with (`router.ts` `mapError`). */
const STATUS = {
  'market.vendor_not_found': 'NOT_FOUND',
  'market.vendor_already_applied': 'CONFLICT',
  'market.vendor_display_name_required': 'BAD_REQUEST',
  'market.vendor_description_required': 'BAD_REQUEST',
  'market.vendor_not_approved': 'FORBIDDEN',
  'market.stake_required': 'FORBIDDEN',
  'market.slots_exhausted': 'CONFLICT',
  'market.slot_ref_required': 'BAD_REQUEST',
  'market.slot_required': 'PRECONDITION_FAILED',
  'market.release_sweep_unset': 'BAD_REQUEST',
  'market.client_request_id_required': 'BAD_REQUEST',
  'market.takedown_reason_short': 'BAD_REQUEST',
  'market.ops_sales_cursor_invalid': 'BAD_REQUEST',
  'market.reviews_cursor_invalid': 'BAD_REQUEST',
  'market.review_score_invalid': 'BAD_REQUEST',
  'market.signal_recommended_amount_invalid': 'BAD_REQUEST',
  'market.listing_slot_missing': 'PRECONDITION_FAILED',
  'market.listing_over_capacity': 'PRECONDITION_FAILED',
  'market.applications_list_limit_unset': 'PRECONDITION_FAILED',
  'market.listed_vendors_list_limit_unset': 'PRECONDITION_FAILED',
  'market.commission_not_configured': 'PRECONDITION_FAILED',
  'market.public_listings_list_limit_unset': 'PRECONDITION_FAILED',
  'market.my_listings_list_limit_unset': 'PRECONDITION_FAILED',
  'market.my_purchases_list_limit_unset': 'PRECONDITION_FAILED',
  'market.ops_sales_list_limit_unset': 'PRECONDITION_FAILED',
  'market.ops_sales_window_unset': 'PRECONDITION_FAILED',
  'market.ops_sales_window_too_wide': 'PRECONDITION_FAILED',
  'market.reviews_list_limit_unset': 'PRECONDITION_FAILED',
  'market.earnings_window_unset': 'PRECONDITION_FAILED',
  'market.listing_category_unset': 'PRECONDITION_FAILED',
  'market.category_invalid': 'BAD_REQUEST',
  'market.listing_title_required': 'BAD_REQUEST',
  'market.listing_description_required': 'BAD_REQUEST',
  'market.listing_asset_required': 'BAD_REQUEST',
  'market.listing_invalid_price': 'BAD_REQUEST',
  'market.subscription_period_unset': 'PRECONDITION_FAILED',
  'market.subscription_recurring_not_built': 'PRECONDITION_FAILED',
  'market.subscription_past_due': 'PRECONDITION_FAILED',
  'market.subscription_cancelled': 'PRECONDITION_FAILED',
  'market.subscription_no_access': 'PRECONDITION_FAILED',
  'market.period_not_applicable': 'PRECONDITION_FAILED',
  'market.strategy_profit_share_forbidden': 'PRECONDITION_FAILED',
  'market.strategy_return_rank_forbidden': 'PRECONDITION_FAILED',
  'market.listing_not_found': 'NOT_FOUND',
  'market.listing_not_owned': 'CONFLICT',
  'market.listing_taken_down': 'PRECONDITION_FAILED',
  'market.takedown_approval_mismatch': 'PRECONDITION_FAILED',
  'market.purchase_not_found': 'NOT_FOUND',
  'market.purchase_id_required': 'BAD_REQUEST',
  'market.purchase_conflict': 'CONFLICT',
  'market.purchase_receipt_mismatch': 'CONFLICT',
  'market.purchase_self': 'CONFLICT',
  'market.insufficient_funds': 'PRECONDITION_FAILED',
  'market.idempotency_conflict': 'CONFLICT',
  'market.refund_forbidden': 'FORBIDDEN',
  'market.refund_not_held': 'CONFLICT',
  /** The refund window or the refund policy is blank (owner settings): no refund is asked for or paid. */
  'market.refund_window_unset': 'PRECONDITION_FAILED',
  'owner.decision': 'PRECONDITION_FAILED',
  'market.review_not_buyer': 'FORBIDDEN',
  'market.review_not_settled': 'PRECONDITION_FAILED',
  'market.review_exists': 'CONFLICT',
  'market.earnings_vendor_required': 'FORBIDDEN',
  /** The provider criteria or a monthly signal's price are blank (owner settings). */
  'market.provider_criteria_not_set': 'PRECONDITION_FAILED',
  'market.price_not_set': 'PRECONDITION_FAILED',
  'market.provider_criteria_not_met': 'FORBIDDEN',
  'market.signal_not_found': 'NOT_FOUND',
  'market.signal_key_conflict': 'CONFLICT',
  'market.signal_key_required': 'BAD_REQUEST',
  'market.signal_fee_model_invalid': 'BAD_REQUEST',
  /** A second factor is needed for an operator write (`requireMfa`). */
  'mfa.required': 'UNAUTHORIZED',
  /** The operator write has no identity-issued approval, or it does not match (`action-approval-consume.ts`). */
  'action_approval.identity_unwired': 'PRECONDITION_FAILED',
  'action_approval.missing': 'PRECONDITION_FAILED',
  'action_approval.consume_failed': 'PRECONDITION_FAILED',
} as const satisfies Record<string, RefusalStatus>;
type Code = keyof typeof STATUS;
const refuse = (...codes: Code[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, STATUS[c]])));

const ID = '11111111-1111-4111-8111-111111111111';

// ── Shapes ────────────────────────────────────────────────────────────────────────────────────────────────────────

const MARKET_VENDOR_STATUSES = ['applied', 'approved', 'rejected', 'suspended'] as const;
const vendorStatus = z.enum(MARKET_VENDOR_STATUSES);

/** A vendor's own application, as the vendor and the operator desk see it. */
export const marketVendorSchema = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  displayName: z.string(),
  description: z.string(),
  status: vendorStatus,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MarketVendor = z.output<typeof marketVendorSchema>;

/** No amount, no capacity, no tier — a slot row records only that it was taken. */
export const marketSlotSchema = z.object({
  id: z.string().guid(),
  vendorId: z.string().guid(),
  ref: z.string(),
  claimedAt: z.string().datetime(),
  releasedAt: z.string().datetime().nullable(),
});

/**
 * The public shape. Four fields, and svc-market's `PublicVendorProfile` carries the full argument for each omission — no
 * userId, no status, no tier, no slot refs, and nothing whatsoever from the operator event log.
 */
export const marketPublicVendorSchema = z.object({
  id: z.string().guid(),
  displayName: z.string(),
  description: z.string(),
  createdAt: z.string().datetime(),
});
export type MarketPublicVendor = z.output<typeof marketPublicVendorSchema>;

export const marketStatusEventSchema = z.object({
  id: z.string().guid(),
  /** `bigserial` as a string — an ordering key, never arithmetic. */
  seq: z.string(),
  vendorId: z.string().guid(),
  fromStatus: vendorStatus,
  toStatus: vendorStatus,
  reason: z.string(),
  actorId: z.string().guid(),
  actorScope: z.string(),
  createdAt: z.string().datetime(),
});

/**
 * Where a listing stands in svc-market's review (`listingReviewState`), the same for every kind of listing: its seller's
 * operator review, or taken down by an operator. A catalogue row and a seller's own row always carry one.
 */
export const LISTING_REVIEW_STATES = ['in_review', 'approved', 'rejected', 'suspended', 'taken_down'] as const;
export type ListingReviewState = (typeof LISTING_REVIEW_STATES)[number];

export const marketListingSchema = z.object({
  id: z.string().guid(),
  vendorId: z.string().guid(),
  title: z.string(),
  description: z.string(),
  offerType: z.enum(['one_time', 'subscription']),
  assetId: assetIdSchema,
  price: z.string(),
  periodSeconds: z.number().int().positive().nullable(),
  status: z.enum(['active', 'archived', 'taken_down']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MarketListing = z.output<typeof marketListingSchema>;

/** A catalogue or own-list row: the listing and its review state (`listingReviewState`), the same for every kind. */
export const marketReviewedListingSchema = marketListingSchema.extend({ reviewState: z.enum(LISTING_REVIEW_STATES) });
export type MarketReviewedListing = z.output<typeof marketReviewedListingSchema>;

/**
 * How a listing's or a seller's mean score is rounded: the sum of the integer scores divided by the count, half-up at the
 * ledger scale (18 places). No reviews is null, never "0".
 */
export const REVIEW_MEAN_ROUNDING = 'half-up-scale-18' as const;

/** Public listing detail. Strict so a seller user id cannot ride along. */
export const marketListingDetailSchema = z
  .object({
    listing: marketListingSchema.strict(),
    vendor: marketPublicVendorSchema.strict(),
    activeListingCount: z.number().int().positive(),
    reviews: z
      .object({
        count: z.string().regex(/^(0|[1-9][0-9]*)$/),
        mean: z.string().nullable(),
        meanRounding: z.literal(REVIEW_MEAN_ROUNDING),
      })
      .strict(),
    terms: z
      .object({
        offerType: z.enum(['one_time', 'subscription']),
        assetId: assetIdSchema,
        price: z.string(),
        periodSeconds: z.number().int().positive().nullable(),
      })
      .strict(),
    /**
     * The seller's track record from stored fills: how many fills of their own orders svc-trade settled, and when the
     * first was. A count, never a return or a profit. `reported: false` when svc-market can't read it; never zero.
     */
    performance: z.union([
      z.object({ reported: z.literal(false) }).strict(),
      z
        .object({
          reported: z.literal(true),
          basis: z.literal('seller_own_fills'),
          fills: z.number().int().nonnegative(),
          firstFillAt: z.string().datetime().nullable(),
        })
        .strict(),
    ]),
  })
  .strict();
export type MarketListingDetail = z.output<typeof marketListingDetailSchema>;

export const marketPurchaseSchema = z.object({
  id: z.string().guid(),
  listingId: z.string().guid(),
  buyerId: z.string().guid(),
  vendorId: z.string().guid(),
  vendorUserId: z.string().guid(),
  assetId: assetIdSchema,
  price: z.string(),
  commissionBps: z.number().int(),
  status: z.enum(['pending', 'settled', 'rejected', 'held', 'released', 'refunded']),
  ledgerTxId: z.string().guid().nullable(),
  rejectionCode: z.string().nullable(),
  createdAt: z.string().datetime(),
  settledAt: z.string().datetime().nullable(),
  accessUntil: z.string().datetime().nullable(),
  periodSeconds: z.number().int().positive().nullable(),
  flow: z.enum(['pay', 'hold']),
  refundWindowSeconds: z.number().int().positive().nullable(),
  holdPostedAt: z.string().datetime().nullable(),
  refundWindowEndsAt: z.string().datetime().nullable(),
  refundRequestedAt: z.string().datetime().nullable(),
  outcome: z.enum(['release', 'refund']).nullable(),
  outcomeTxId: z.string().guid().nullable(),
  outcomeAt: z.string().datetime().nullable(),
});
export type MarketPurchase = z.output<typeof marketPurchaseSchema>;

const marketSalesRowSchema = z.object({
  vendorId: z.string().guid(),
  assetId: assetIdSchema,
  settledVolume: z.string(),
  settledCount: z.string(),
  commission: z.string(),
});

export const marketReviewSchema = z.object({
  id: z.string().guid(),
  purchaseId: z.string().guid(),
  listingId: z.string().guid(),
  vendorId: z.string().guid(),
  buyerId: z.string().guid(),
  score: z.number().int().min(1).max(5),
  text: z.string().nullable(),
  createdAt: z.string().datetime(),
});

/** Public review. No buyer id and no purchase id — those stay on `reviews.submit`. */
export const marketPublicReviewSchema = z
  .object({
    id: z.string().guid(),
    listingId: z.string().guid(),
    vendorId: z.string().guid(),
    score: z.number().int().min(1).max(5),
    text: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const marketSignalSchema = z.object({
  id: z.string().guid(),
  title: z.string(),
  description: z.string(),
  assetId: assetIdSchema,
  recommendedAmount: z.string().nullable(),
  feeModel: z.enum(['free', 'monthly']),
  price: z.string().nullable(),
  periodSeconds: z.number().int().positive().nullable(),
  listingId: z.string().guid().nullable(),
  state: z.enum(['pending', 'published', 'archived']),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});
export type MarketSignal = z.output<typeof marketSignalSchema>;

/** The provider's one vetting against the platform's criteria, and what it saw. */
export const marketSignalVettingSchema = z.object({
  minTier: z.string(),
  minFills: z.number().int(),
  tierSeen: z.string(),
  fillsSeen: z.number().int(),
  firstFillAt: z.string().datetime().nullable(),
  passedAt: z.string().datetime(),
});
export type MarketSignalVetting = z.output<typeof marketSignalVettingSchema>;

// ── The callers' checks over an answer ────────────────────────────────────────────────────────────────────────────

/** A check over a reply its schema already parsed, read again by that schema here so the rule is typed without a cast. */
const holdsOn =
  <S extends z.ZodType>(schema: S, rule: (reply: z.output<S>) => boolean) =>
  (reply: unknown): boolean => {
    const read = schema.safeParse(reply);
    return read.success && rule(read.data);
  };
const isAmount = (value: string) => unsignedAmountSchema.safeParse(value).success;
const AMOUNT_SAYS = 'every amount is an exact unsigned decimal string';
/** A listing's price is an amount, its asset is named, and a subscription names its period. */
const listingHolds = (row: Pick<MarketListing, 'price' | 'assetId' | 'offerType' | 'periodSeconds'>) =>
  isAmount(row.price) && row.assetId.length > 0 && (row.offerType !== 'subscription' || row.periodSeconds !== null);
const LISTING_SAYS = 'the price is an exact unsigned decimal string, the asset is named, and a subscription names its period';
const listing: Record<string, ReplyCheck> = {
  listingTerms: { says: LISTING_SAYS, holds: holdsOn(marketListingSchema, listingHolds) },
};
const listings: Record<string, ReplyCheck> = {
  listingTerms: { says: LISTING_SAYS, holds: holdsOn(z.array(marketListingSchema), (rows) => rows.every(listingHolds)) },
};
/** A purchase's price is an amount, its asset is named, and its commission is a share of the price. */
const purchaseHolds = (row: MarketPurchase) =>
  isAmount(row.price) && row.assetId.trim().length > 0 && row.commissionBps >= 0 && row.commissionBps <= 10_000;
const PURCHASE_SAYS = 'the price is an exact unsigned decimal string, the asset is named, and the commission is 0 to 10000 basis points';
const purchase: Record<string, ReplyCheck> = {
  purchaseTerms: { says: PURCHASE_SAYS, holds: holdsOn(marketPurchaseSchema, purchaseHolds) },
};
const purchases: Record<string, ReplyCheck> = {
  purchaseTerms: { says: PURCHASE_SAYS, holds: holdsOn(z.array(marketPurchaseSchema), (rows) => rows.every(purchaseHolds)) },
};
const signalHolds = (row: MarketSignal) =>
  (row.price === null || isAmount(row.price)) && (row.recommendedAmount === null || isAmount(row.recommendedAmount));

const optionalLimit = (max: number) => z.object({ limit: z.number().int().positive().max(max).optional() }).optional();
const LIMIT_SAMPLES = [
  { verdict: 'accept', input: { limit: 20 } },
  { verdict: 'accept' },
  { verdict: 'refuse', input: { limit: 0 } },
] as const;
const listingIdInput = z.object({ listingId: z.string().guid() });
const LISTING_ID_SAMPLES = [
  { verdict: 'accept', input: { listingId: ID } },
  { verdict: 'refuse', input: { listingId: 'not-a-listing' } },
] as const;
const purchaseIdInput = z.object({ purchaseId: z.string().guid() });
const PURCHASE_ID_SAMPLES = [
  { verdict: 'accept', input: { purchaseId: ID } },
  { verdict: 'refuse', input: {} },
] as const;

// ── A vendor's application and slots ──────────────────────────────────────────────────────────────────────────────

/**
 * Apply to be a vendor. One application per account; status is not an input. Named `applyAsVendor` rather than `apply`
 * because tRPC reserves `apply` as a router key.
 */
export const MARKET_APPLY_AS_VENDOR = defineProcedure({
  ...base,
  name: 'market.applyAsVendor',
  kind: 'mutation',
  path: 'applyAsVendor',
  access: WRITE,
  refusals: refuse('market.vendor_already_applied', 'market.vendor_display_name_required', 'market.vendor_description_required'),
  input: z.object({ displayName: z.string().min(1).max(80), description: z.string().min(1).max(2_000) }),
  output: marketVendorSchema,
  samples: [
    { verdict: 'accept', input: { displayName: 'Shop', description: 'What I sell' } },
    { verdict: 'refuse', input: { displayName: '', description: 'What I sell' } },
  ],
});

/** The caller's own application. Null rather than a 404: "you have not applied" is an answer. */
export const MARKET_MINE = defineProcedure({
  ...base,
  name: 'market.mine',
  kind: 'query',
  path: 'mine',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: marketVendorSchema.nullable(),
  samples: [{ verdict: 'accept' }],
});

/** Give a slot back. `released: false` when it was not held — not a 404. */
export const MARKET_RELEASE_SLOT = defineProcedure({
  ...base,
  name: 'market.releaseSlot',
  kind: 'mutation',
  path: 'releaseSlot',
  access: WRITE,
  refusals: refuse('market.vendor_not_found', 'market.slot_ref_required'),
  input: z.object({ ref: z.string().min(1).max(200) }),
  output: z.object({ released: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { ref: ID } },
    { verdict: 'refuse', input: { ref: '' } },
  ],
});

/**
 * The caller's slot position, with capacity re-read from svc-token. `usable` rather than `held` answers "may this vendor
 * present as listed": a vendor who has unstaked reads `usable: 0` at once.
 */
export const MARKET_SLOTS = defineProcedure({
  ...base,
  name: 'market.slots',
  kind: 'query',
  path: 'slots',
  access: READ,
  refusals: refuse('market.vendor_not_found'),
  input: NO_INPUT,
  output: z.object({
    vendorId: z.string().guid(),
    status: vendorStatus,
    tier: z.string(),
    capacity: z.number().int().nonnegative(),
    held: z.number().int().nonnegative(),
    usable: z.number().int().nonnegative(),
    slots: z.array(marketSlotSchema),
  }),
  samples: [{ verdict: 'accept' }],
});

// ── Sellers ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One listed vendor's public profile. NOT_FOUND covers every "you cannot see this vendor" (unknown, never approved,
 * suspended, no slot, unstaked) with no code, so nobody can tell which; it is not a named refusal.
 */
export const MARKET_PROFILE = defineProcedure({
  ...base,
  name: 'market.profile',
  kind: 'query',
  path: 'profile',
  access: PUBLIC,
  refusals: refuse(),
  input: z.object({ vendorId: z.string().guid() }),
  output: marketPublicVendorSchema,
  samples: [
    { verdict: 'accept', input: { vendorId: ID } },
    { verdict: 'refuse', input: { vendorId: 'someone' } },
  ],
});

/** The public directory of listed vendors, in registration order. Omit `limit` and the service refuses by name. */
export const MARKET_LISTED = defineProcedure({
  ...base,
  name: 'market.listed',
  kind: 'query',
  path: 'listed',
  access: PUBLIC,
  refusals: refuse('market.listed_vendors_list_limit_unset'),
  input: optionalLimit(50),
  output: z.array(marketPublicVendorSchema),
  samples: LIMIT_SAMPLES,
});

// ── Listings ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether this deployment has a house commission rate, and the held-purchase refund terms. Blank config is the
 * refuse-closed default: listings, the catalogue and purchases will not invent a rate.
 */
export const MARKET_COMMERCE_PROGRAMME = defineProcedure({
  ...base,
  name: 'market.commerceProgramme',
  kind: 'query',
  path: 'commerceProgramme',
  access: PUBLIC,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({
    commissionBps: z.number().int().nullable(),
    commissionConfigured: z.boolean(),
    purchaseHold: z.boolean(),
    refundWindowSeconds: z.number().int().positive().nullable(),
    refundPolicy: z.enum(['seller_full']).nullable(),
  }),
  accept: {
    commissionNotNegative: {
      says: 'the commission is not below zero',
      holds: holdsOn(
        z.object({ commissionBps: z.number().int().nullable() }),
        ({ commissionBps }) => commissionBps === null || commissionBps >= 0,
      ),
    },
  },
  samples: [{ verdict: 'accept' }],
});

/** A listing refused before it is written: a blank owner value, a field it lacks, or a slot the seller cannot take. */
const LISTING_WRITE = [
  'market.commission_not_configured',
  'market.vendor_not_found',
  'market.vendor_not_approved',
  'market.stake_required',
  'market.slots_exhausted',
  'market.slot_required',
  'market.listing_title_required',
  'market.listing_description_required',
  'market.listing_asset_required',
  'market.listing_invalid_price',
] as const;

export const MARKET_CREATE_LISTING = defineProcedure({
  ...base,
  name: 'market.createListing',
  kind: 'mutation',
  path: 'createListing',
  access: WRITE,
  refusals: refuse(...LISTING_WRITE, 'market.subscription_period_unset', 'market.period_not_applicable', 'market.category_invalid'),
  input: z.object({
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(4_000),
    offerType: z.enum(['one_time', 'subscription']),
    assetId: assetIdSchema.min(1).max(32),
    /** Decimal string — never a number. */
    price: z.string().min(1).max(64),
    /** Whole seconds. Required when offerType is subscription. No default month. */
    periodSeconds: z.number().int().positive().optional(),
    /** Product category. Optional on one-time — omit stays uncategorised. Strategy listings stay uncategorised. */
    category: z.string().max(64).optional(),
  }),
  output: marketListingSchema,
  accept: listing,
  samples: [
    { verdict: 'accept', input: { title: 'Bot', description: 'A bot', offerType: 'one_time', assetId: 'USDC', price: '10' } },
    { verdict: 'refuse', input: { title: 'Bot', description: 'A bot', offerType: 'rental', assetId: 'USDC', price: '10' } },
  ],
});

/** A strategy on the shopfront: always a subscription with its period. No profit-share input. */
export const MARKET_CREATE_STRATEGY_LISTING = defineProcedure({
  ...base,
  name: 'market.createStrategyListing',
  kind: 'mutation',
  path: 'createStrategyListing',
  access: WRITE,
  refusals: refuse(...LISTING_WRITE),
  input: z
    .object({
      title: z.string().min(1).max(120),
      description: z.string().min(1).max(4_000),
      assetId: assetIdSchema.min(1).max(32),
      /** Decimal string — never a number. */
      price: z.string().min(1).max(64),
      /** Whole seconds. Required. No default month. */
      periodSeconds: z.number().int().positive(),
    })
    .strict(),
  output: marketListingSchema,
  accept: listing,
  samples: [
    { verdict: 'accept', input: { title: 'Grid', description: 'A grid', assetId: 'USDC', price: '10', periodSeconds: 2_592_000 } },
    { verdict: 'refuse', input: { title: 'Grid', description: 'A grid', assetId: 'USDC', price: '10' } },
  ],
});

export const MARKET_ARCHIVE_LISTING = defineProcedure({
  ...base,
  name: 'market.archiveListing',
  kind: 'mutation',
  path: 'archiveListing',
  access: WRITE,
  refusals: refuse('market.listing_not_found', 'market.listing_not_owned', 'market.listing_taken_down'),
  input: listingIdInput,
  output: marketListingSchema,
  accept: listing,
  samples: LISTING_ID_SAMPLES,
});

/** The caller's own listings, each with its review state. Omit `limit` and the service refuses by name. */
export const MARKET_MY_LISTINGS = defineProcedure({
  ...base,
  name: 'market.myListings',
  kind: 'query',
  path: 'myListings',
  access: READ,
  refusals: refuse('market.my_listings_list_limit_unset'),
  input: optionalLimit(50),
  output: z.array(marketReviewedListingSchema),
  accept: listings,
  samples: LIMIT_SAMPLES,
});

/**
 * One shopfront listing by id. Unknown and not-on-the-shopfront are both `market.listing_not_found`; a blank commission
 * is `market.commission_not_configured`, before the read. No seller user id. Performance is the seller's track record
 * from stored fills (svc-trade), or unreported when it can't be read.
 */
export const MARKET_LISTING = defineProcedure({
  ...base,
  name: 'market.listing',
  kind: 'query',
  path: 'listing',
  access: PUBLIC,
  refusals: refuse('market.commission_not_configured', 'market.listing_not_found'),
  input: listingIdInput,
  output: marketListingDetailSchema,
  accept: {
    listingTerms: {
      says: `${LISTING_SAYS}; the terms' price and the mean score are exact unsigned decimal strings`,
      holds: holdsOn(marketListingDetailSchema, (detail) => {
        return (
          listingHolds(detail.listing) &&
          isAmount(detail.terms.price) &&
          detail.terms.assetId.length > 0 &&
          (detail.reviews.mean === null || isAmount(detail.reviews.mean))
        );
      }),
    },
  },
  samples: LISTING_ID_SAMPLES,
});

/** The public catalogue: empty while the commission is blank; else listed vendors only, oldest first. */
export const MARKET_LISTINGS = defineProcedure({
  ...base,
  name: 'market.listings',
  kind: 'query',
  path: 'listings',
  access: PUBLIC,
  refusals: refuse('market.public_listings_list_limit_unset'),
  input: optionalLimit(50),
  output: z.array(marketReviewedListingSchema),
  accept: listings,
  samples: LIMIT_SAMPLES,
});

/** The product categories a one-time listing may be filed under. A product enum, not an owner list. */
export const MARKET_LISTING_CATEGORIES_READ = defineProcedure({
  ...base,
  name: 'market.listingCategories',
  kind: 'query',
  path: 'listingCategories',
  access: PUBLIC,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({ categories: z.array(z.string().min(1).max(32)) }),
  samples: [{ verdict: 'accept' }],
});

/**
 * One-time listings in one product category. Omit or blank category is not the whole catalogue, and omit limit is not
 * 50: each refuses by name. Strategy rows are excluded.
 */
export const MARKET_LISTINGS_BY_CATEGORY = defineProcedure({
  ...base,
  name: 'market.listingsByCategory',
  kind: 'query',
  path: 'listingsByCategory',
  access: PUBLIC,
  refusals: refuse('market.listing_category_unset', 'market.category_invalid', 'market.public_listings_list_limit_unset'),
  input: z.object({ category: z.string().max(64).optional(), limit: z.number().int().positive().max(50).optional() }).optional(),
  output: z.array(marketReviewedListingSchema.extend({ category: z.string().min(1).max(32) })),
  accept: listings,
  samples: [
    { verdict: 'accept', input: { category: 'bots', limit: 20 } },
    { verdict: 'accept' },
    { verdict: 'refuse', input: { category: 7 } },
  ],
});

// ── Purchases and refunds ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * One period or one-time purchase. `purchaseId` is the buyer's, so a retry is the same purchase. A blank commission
 * refuses before any post.
 */
export const MARKET_PURCHASE = defineProcedure({
  ...base,
  name: 'market.purchase',
  kind: 'mutation',
  path: 'purchase',
  access: WRITE,
  refusals: refuse(
    'market.commission_not_configured',
    'market.listing_not_found',
    'market.purchase_self',
    'market.purchase_conflict',
    'market.purchase_receipt_mismatch',
    'market.insufficient_funds',
    'market.subscription_period_unset',
    'market.subscription_past_due',
    'market.subscription_cancelled',
    'market.listing_not_owned',
    'market.listing_slot_missing',
    'market.listing_over_capacity',
    'market.refund_window_unset',
    'market.release_sweep_unset',
  ),
  input: z.object({ listingId: z.string().guid(), purchaseId: z.string().guid() }),
  output: marketPurchaseSchema,
  accept: purchase,
  samples: [
    { verdict: 'accept', input: { listingId: ID, purchaseId: ID } },
    { verdict: 'refuse', input: { listingId: ID } },
  ],
});

/** The buyer asks for a refund of a held purchase inside its window; the seller decides. Asking again returns the request. */
export const MARKET_REQUEST_REFUND = defineProcedure({
  ...base,
  name: 'market.requestRefund',
  kind: 'mutation',
  path: 'requestRefund',
  access: WRITE,
  refusals: refuse('owner.decision', 'market.purchase_not_found', 'market.refund_not_held'),
  input: purchaseIdInput,
  output: marketPurchaseSchema,
  accept: purchase,
  samples: PURCHASE_ID_SAMPLES,
});

/** The seller refunds a held purchase inside its window: the whole price returns to the buyer once. A retry returns it. */
export const MARKET_REFUND = defineProcedure({
  ...base,
  name: 'market.refund',
  kind: 'mutation',
  path: 'refund',
  access: WRITE,
  refusals: refuse('owner.decision', 'market.purchase_not_found', 'market.refund_forbidden', 'market.refund_not_held'),
  input: purchaseIdInput,
  output: marketPurchaseSchema,
  accept: purchase,
  samples: PURCHASE_ID_SAMPLES,
});

/** The seller's held purchases with a refund request, oldest first. Omit `limit` and the service refuses by name. */
export const MARKET_REFUND_REQUESTS = defineProcedure({
  ...base,
  name: 'market.refundRequests',
  kind: 'query',
  path: 'refundRequests',
  access: READ,
  refusals: refuse('market.my_purchases_list_limit_unset'),
  input: optionalLimit(50),
  output: z.array(marketPurchaseSchema),
  accept: purchases,
  samples: LIMIT_SAMPLES,
});

/** The caller's own purchases. Omit `limit` and the service refuses by name. */
export const MARKET_MY_PURCHASES = defineProcedure({
  ...base,
  name: 'market.myPurchases',
  kind: 'query',
  path: 'myPurchases',
  access: READ,
  refusals: refuse('market.my_purchases_list_limit_unset'),
  input: optionalLimit(50),
  output: z.array(marketPurchaseSchema),
  accept: purchases,
  samples: LIMIT_SAMPLES,
});

/** The buyer stops a subscription's access. It is not a refund. */
export const MARKET_CANCEL_SUBSCRIPTION = defineProcedure({
  ...base,
  name: 'market.cancelSubscription',
  kind: 'mutation',
  path: 'cancelSubscription',
  access: WRITE,
  refusals: refuse('market.listing_not_found', 'market.subscription_no_access'),
  input: listingIdInput,
  output: z.object({ listingId: z.string().guid(), buyerId: z.string().guid(), cancelledAt: z.string().datetime() }),
  samples: LISTING_ID_SAMPLES,
});

/** Whether the buyer holds a paid period of a subscription now, and until when; none is a named refusal. */
export const MARKET_SUBSCRIPTION_ACCESS = defineProcedure({
  ...base,
  name: 'market.subscriptionAccess',
  kind: 'query',
  path: 'subscriptionAccess',
  access: READ,
  refusals: refuse(
    'market.listing_not_found',
    'market.subscription_no_access',
    'market.subscription_past_due',
    'market.subscription_cancelled',
  ),
  input: listingIdInput,
  output: z.object({
    granted: z.literal(true),
    listingId: z.string().guid(),
    buyerId: z.string().guid(),
    accessUntil: z.string().datetime(),
  }),
  samples: LISTING_ID_SAMPLES,
});
export type MarketSubscriptionAccess = z.output<typeof MARKET_SUBSCRIPTION_ACCESS.output>;

// ── Reviews ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A buyer reviews a settled purchase once. `clientRequestId` makes a retry the same review. */
export const MARKET_REVIEWS_SUBMIT = defineProcedure({
  ...base,
  name: 'market.reviews.submit',
  kind: 'mutation',
  path: 'reviews.submit',
  access: WRITE,
  refusals: refuse(
    'market.purchase_not_found',
    'market.review_not_buyer',
    'market.review_score_invalid',
    'market.client_request_id_required',
    'market.review_not_settled',
    'market.review_exists',
    'market.idempotency_conflict',
  ),
  input: z.object({
    purchaseId: z.string().guid(),
    score: z.number(),
    text: z.string().max(1_000).optional(),
    clientRequestId: z.string().max(128),
  }),
  output: marketReviewSchema,
  samples: [
    { verdict: 'accept', input: { purchaseId: ID, score: 5, clientRequestId: `review:${ID}` } },
    { verdict: 'refuse', input: { purchaseId: ID, score: '5', clientRequestId: `review:${ID}` } },
  ],
});

/** One listing's public reviews, newest first. Omit `limit` and the service refuses by name. */
export const MARKET_REVIEWS_LIST = defineProcedure({
  ...base,
  name: 'market.reviews.list',
  kind: 'query',
  path: 'reviews.list',
  access: READ,
  refusals: refuse('market.reviews_list_limit_unset', 'market.reviews_cursor_invalid'),
  input: z.object({
    listingId: z.string().guid(),
    limit: z.number().int().positive().max(50).optional(),
    cursor: z.string().max(512).optional(),
  }),
  output: z.object({ reviews: z.array(marketPublicReviewSchema), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: { listingId: ID, limit: 20 } },
    { verdict: 'refuse', input: { limit: 20 } },
  ],
});

// ── Signals ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The owner's provider criteria. `set: false` while they are blank, when every publish refuses. */
export const MARKET_SIGNALS_CRITERIA = defineProcedure({
  ...base,
  name: 'market.signals.criteria',
  kind: 'query',
  path: 'signals.criteria',
  access: PUBLIC,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({ set: z.boolean(), minTier: z.string().nullable(), minFills: z.number().int().nullable() }),
  samples: [{ verdict: 'accept' }],
});

/**
 * The keys a request may use to ask for a share of followers' profit or a ranking by return. Copy law forbids both, so
 * svc-market refuses any of them sent with a value (`market.strategy_profit_share_forbidden`,
 * `market.strategy_return_rank_forbidden`) rather than dropping it unseen. Any one value is enough to be refused, so each
 * key takes any JSON scalar.
 */
const copyLawValue = z.union([z.string(), z.number(), z.boolean(), z.null()]).optional();
const profitShareKeys = {
  profitShare: copyLawValue,
  profitShareBps: copyLawValue,
  pnlFee: copyLawValue,
  pnlShare: copyLawValue,
  performanceFee: copyLawValue,
  successFee: copyLawValue,
  highWaterMark: copyLawValue,
  hurdleRate: copyLawValue,
};
const returnRankKeys = { returnRank: copyLawValue, rankByReturn: copyLawValue, returnPct: copyLawValue, pnlPct: copyLawValue };
const copyLawKeys = { ...profitShareKeys, ...returnRankKeys };
export const MARKET_PROFIT_SHARE_KEYS: readonly string[] = Object.keys(profitShareKeys);
export const MARKET_RETURN_RANK_KEYS: readonly string[] = Object.keys(returnRankKeys);

/**
 * Publish a signal. The provider is vetted once against the owner's criteria; a retried key answers the first signal.
 * Fee models are free and a monthly fee; a profit share and an automatic recurring subscription are refused by name.
 */
export const MARKET_SIGNALS_PUBLISH = defineProcedure({
  ...base,
  name: 'market.signals.publish',
  kind: 'mutation',
  path: 'signals.publish',
  access: WRITE,
  refusals: refuse(
    'market.provider_criteria_not_set',
    'market.provider_criteria_not_met',
    'market.price_not_set',
    'market.signal_key_conflict',
    'market.signal_key_required',
    'market.signal_fee_model_invalid',
    'market.signal_recommended_amount_invalid',
    'market.signal_not_found',
    'market.strategy_profit_share_forbidden',
    'market.strategy_return_rank_forbidden',
    'market.subscription_recurring_not_built',
    'market.subscription_period_unset',
    ...LISTING_WRITE,
  ),
  input: z.object({
    publishKey: z.string().min(1).max(128),
    title: z.string().max(120),
    description: z.string().max(4_000),
    assetId: assetIdSchema.max(32),
    recommendedAmount: z.string().max(64).nullish(),
    /** `free` or `monthly`; `profit_share` and `recurring` reach their named refusals. */
    feeModel: z.string().min(1).max(32),
    price: z.string().max(64).nullish(),
    periodSeconds: z.number().int().positive().nullish(),
    ...copyLawKeys,
  }),
  output: z.object({ signal: marketSignalSchema, vetting: marketSignalVettingSchema, replayed: z.boolean() }),
  accept: {
    amounts: { says: AMOUNT_SAYS, holds: holdsOn(z.object({ signal: marketSignalSchema }), ({ signal }) => signalHolds(signal)) },
  },
  samples: [
    { verdict: 'accept', input: { publishKey: 'signal:1', title: 'Breakout', description: 'Daily', assetId: 'BTC', feeModel: 'free' } },
    { verdict: 'refuse', input: { publishKey: '', title: 'Breakout', description: 'Daily', assetId: 'BTC', feeModel: 'free' } },
  ],
});

export const MARKET_SIGNALS_ARCHIVE = defineProcedure({
  ...base,
  name: 'market.signals.archive',
  kind: 'mutation',
  path: 'signals.archive',
  access: WRITE,
  refusals: refuse('market.signal_not_found'),
  input: z.object({ signalId: z.string().guid() }),
  output: marketSignalSchema,
  accept: { amounts: { says: AMOUNT_SAYS, holds: holdsOn(marketSignalSchema, signalHolds) } },
  samples: [
    { verdict: 'accept', input: { signalId: ID } },
    { verdict: 'refuse', input: { signalId: 'signal' } },
  ],
});

const signalPage = z.object({ limit: z.number().int().positive().max(50) });
const SIGNAL_PAGE_SAMPLES = [
  { verdict: 'accept', input: { limit: 20 } },
  { verdict: 'refuse', input: {} },
] as const;

/** The provider's own signals and their vetting. */
export const MARKET_SIGNALS_MINE = defineProcedure({
  ...base,
  name: 'market.signals.mine',
  kind: 'query',
  path: 'signals.mine',
  access: READ,
  refusals: refuse(),
  input: signalPage,
  output: z.object({ signals: z.array(marketSignalSchema), vetting: marketSignalVettingSchema.nullable() }),
  accept: {
    amounts: {
      says: AMOUNT_SAYS,
      holds: holdsOn(z.object({ signals: z.array(marketSignalSchema) }), ({ signals }) => signals.every(signalHolds)),
    },
  },
  samples: SIGNAL_PAGE_SAMPLES,
});

/** The published signals anyone may browse. */
export const MARKET_SIGNALS_LIST = defineProcedure({
  ...base,
  name: 'market.signals.list',
  kind: 'query',
  path: 'signals.list',
  access: PUBLIC,
  refusals: refuse(),
  input: signalPage,
  output: z.array(marketSignalSchema),
  accept: { amounts: { says: AMOUNT_SAYS, holds: holdsOn(z.array(marketSignalSchema), (rows) => rows.every(signalHolds)) } },
  samples: SIGNAL_PAGE_SAMPLES,
});

/** The provider's signal earnings per asset over a window, settled at each sale. There is no profit share. */
export const MARKET_SIGNALS_EARNINGS = defineProcedure({
  ...base,
  name: 'market.signals.earnings',
  kind: 'query',
  path: 'signals.earnings',
  access: READ,
  refusals: refuse('market.earnings_window_unset', 'market.earnings_vendor_required'),
  input: z.object({ from: z.string().max(64), to: z.string().max(64) }),
  output: z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    settlement: z.literal('at_sale'),
    assets: z.array(
      z.object({ assetId: assetIdSchema, gross: z.string(), commission: z.string(), net: z.string(), sales: z.number().int() }),
    ),
    profitShare: z.null(),
  }),
  accept: {
    amounts: {
      says: AMOUNT_SAYS,
      holds: holdsOn(
        z.object({ assets: z.array(z.object({ gross: z.string(), commission: z.string(), net: z.string() })) }),
        ({ assets }) => assets.every((a) => isAmount(a.gross) && isAmount(a.commission) && isAmount(a.net)),
      ),
    },
  },
  samples: [
    { verdict: 'accept', input: { from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z' } },
    { verdict: 'refuse', input: { from: '2026-11-01T00:00:00Z' } },
  ],
});

// ── The operator desk ─────────────────────────────────────────────────────────────────────────────────────────────

/** The operator queue: undecided applications, oldest first, unless a status is named. Omit `limit` and it refuses. */
export const MARKET_LIST_APPLICATIONS = defineProcedure({
  ...base,
  name: 'market.listApplications',
  kind: 'query',
  path: 'listApplications',
  access: OPS,
  refusals: refuse('market.applications_list_limit_unset'),
  input: z.object({ status: vendorStatus.optional(), limit: z.number().int().positive().max(50).optional() }).optional(),
  output: z.array(marketVendorSchema),
  samples: [
    { verdict: 'accept', input: { status: 'approved', limit: 50 } },
    { verdict: 'accept' },
    { verdict: 'refuse', input: { status: 'pending' } },
  ],
});

/**
 * Record an operator's decision on a vendor and apply it: a second factor and an identity-issued approval bound to this
 * action. The actor is the verified principal, never the body; a typed-in `confirmOperatorId` is display only.
 */
export const MARKET_VET = defineProcedure({
  ...base,
  name: 'market.vet',
  kind: 'mutation',
  path: 'vet',
  access: OPS,
  refusals: refuse(
    'mfa.required',
    'action_approval.identity_unwired',
    'action_approval.missing',
    'action_approval.consume_failed',
    'market.vendor_not_found',
  ),
  input: z.object({
    vendorId: z.string().guid(),
    decision: z.enum(['approved', 'rejected', 'suspended']),
    reason: z.string().min(1).max(2_000),
    confirmOperatorId: z.string().max(128).nullish(),
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  }),
  output: z.object({
    changed: z.boolean(),
    vendor: marketVendorSchema,
    event: marketStatusEventSchema.nullable(),
    confirmOperatorId: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { vendorId: ID, decision: 'approved', reason: 'Checked', approvalId: 'a-1', operationId: 'op-1' } },
    { verdict: 'refuse', input: { vendorId: ID, decision: 'applied', reason: 'Checked' } },
  ],
});

/** Settled volume, count and commission per vendor and asset over a window. A blank window or limit refuses. */
export const MARKET_OPS_SALES = defineProcedure({
  ...base,
  name: 'market.ops.sales',
  kind: 'query',
  path: 'ops.sales',
  access: OPS,
  refusals: refuse(
    'market.ops_sales_list_limit_unset',
    'market.ops_sales_cursor_invalid',
    'market.ops_sales_window_unset',
    'market.ops_sales_window_too_wide',
  ),
  input: z
    .object({
      from: z.string().max(64).optional(),
      to: z.string().max(64).optional(),
      vendorId: z.string().guid().optional(),
      limit: z.number().int().positive().max(50).optional(),
      cursor: z.string().max(512).optional(),
    })
    .optional(),
  output: z.object({
    rows: z.array(marketSalesRowSchema),
    refusedCount: z.string(),
    pendingCount: z.string(),
    nextCursor: z.string().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z', limit: 50 } },
    { verdict: 'accept' },
    { verdict: 'refuse', input: { vendorId: 'vendor' } },
  ],
});

/**
 * An operator takes a listing down: a second factor and an identity-issued `market.takedown` approval for this listing
 * and reason. `clientRequestId` makes a retry the same takedown.
 */
export const MARKET_OPS_TAKEDOWN_LISTING = defineProcedure({
  ...base,
  name: 'market.ops.takedownListing',
  kind: 'mutation',
  path: 'ops.takedownListing',
  access: OPS,
  refusals: refuse(
    'mfa.required',
    'action_approval.identity_unwired',
    'action_approval.missing',
    'action_approval.consume_failed',
    'market.listing_not_found',
    'market.listing_taken_down',
    'market.takedown_approval_mismatch',
    'market.takedown_reason_short',
    'market.client_request_id_required',
    'market.idempotency_conflict',
  ),
  input: z.object({
    listingId: z.string().guid(),
    reason: z.string().max(2_000),
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
    clientRequestId: z.string().max(128),
  }),
  output: z.object({
    listingId: z.string().guid(),
    status: z.literal('taken_down'),
    reason: z.string(),
    actorId: z.string().guid(),
    takenDownAt: z.string().datetime(),
  }),
  samples: [
    { verdict: 'accept', input: { listingId: ID, reason: 'Fraud', approvalId: 'a-1', operationId: 'op-1', clientRequestId: 'op-1' } },
    { verdict: 'refuse', input: { listingId: ID, reason: 'Fraud' } },
  ],
});

export const MARKET_PROCEDURES = [
  MARKET_APPLY_AS_VENDOR,
  MARKET_MINE,
  MARKET_RELEASE_SLOT,
  MARKET_SLOTS,
  MARKET_PROFILE,
  MARKET_LISTED,
  MARKET_COMMERCE_PROGRAMME,
  MARKET_CREATE_LISTING,
  MARKET_CREATE_STRATEGY_LISTING,
  MARKET_ARCHIVE_LISTING,
  MARKET_MY_LISTINGS,
  MARKET_LISTING,
  MARKET_LISTINGS,
  MARKET_LISTING_CATEGORIES_READ,
  MARKET_LISTINGS_BY_CATEGORY,
  MARKET_PURCHASE,
  MARKET_REQUEST_REFUND,
  MARKET_REFUND,
  MARKET_REFUND_REQUESTS,
  MARKET_MY_PURCHASES,
  MARKET_CANCEL_SUBSCRIPTION,
  MARKET_SUBSCRIPTION_ACCESS,
  MARKET_REVIEWS_SUBMIT,
  MARKET_REVIEWS_LIST,
  MARKET_SIGNALS_CRITERIA,
  MARKET_SIGNALS_PUBLISH,
  MARKET_SIGNALS_ARCHIVE,
  MARKET_SIGNALS_MINE,
  MARKET_SIGNALS_LIST,
  MARKET_SIGNALS_EARNINGS,
  MARKET_LIST_APPLICATIONS,
  MARKET_VET,
  MARKET_OPS_SALES,
  MARKET_OPS_TAKEDOWN_LISTING,
] as const;
