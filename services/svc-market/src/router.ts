import { AuthError, requireMfa } from '@intafaced/auth';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { publicProcedure, router, scopedProcedure } from '@intafaced/contracts';
import { DualControlError } from './dual-control.js';
import {
  ActionApprovalConsumeError,
  type ActionApprovalConsumer,
  marketActionPayloadHash,
  readApprovalIds,
  unwiredApprovalConsumer,
} from './action-approval-consume.js';
import { MARKET_OPS_SCOPE, MarketError, type VendorService } from './vendor-service.js';
import type { CommerceService } from './commerce/commerce-service.js';
import type { ReviewsService } from './reviews/reviews-service.js';
import { REVIEW_MEAN_ROUNDING } from './reviews/reviews-service.js';
import { userCopy } from './user-copy.js';
import { createStrategyListing } from './strategy/strategy-listing.js';
import type { PerpProposalService } from './perp-proposal-service.js';
import {
  MARKET_L3_UNAVAILABLE,
  MARKET_NOT_NATIVE_EXECUTABLE,
  MARKET_REFERENCE_NOT_BOOK,
  describeMarketDataHonesty,
  presentQuote,
  quotePriceSchema,
  requestBook,
} from './market-data-honesty.js';
import { MARKET_LISTING_PIN_IEEE, MARKET_LISTING_PIN_UNSET, MARKET_LISTING_SET_UNSET, listLiveMarkets } from './live-markets.js';

/**
 * THE VENDOR LIFECYCLE ROUTER — Stage 3 (§8.7, `market.vendors`).
 *
 * ── WHY THE SCHEMAS STILL LIVE HERE AND NOT IN `packages/contracts` ────────
 *
 * §15.2 requires a contracts PR first for CROSS-SERVICE work, and Stage 1's
 * comment here predicted that Stage 2's stake read would earn one. On building
 * it, that turned out to be wrong, and the correction is worth writing down.
 *
 * The stake read is an outbound `fetch` to an HTTP endpoint svc-token ALREADY
 * publishes (`/internal/stake/:userId`), authenticated with the shared service
 * credential. It declares no new inter-service shape: nothing about svc-token
 * changes, and no other service needs to know svc-market calls it. The two
 * existing consumers of that exact endpoint — `svc-academy/src/stake-source.ts`
 * and `svc-trade/src/otc/stake-source.ts` — both do it the same way, and neither
 * has a contracts module. A contracts declaration is owed when a SHAPE crosses
 * the boundary and both sides must agree on it; a client for somebody else's
 * published endpoint is not that.
 *
 * Every shape below is still consumed only by svc-market's own clients through
 * the edge.
 *
 * ── WHICH PROCEDURES CARRY THE JURISDICTION GUARD, AND WHY NOT ALL OF THEM ──
 *
 * `applyAsVendor` and `mine` pass `{ module: 'market' }`, so the JURISDICTION_MATRIX is
 * live rather than decorative: `market` is `OPEN_BASIC`, so applying needs
 * verification tier `basic` and a region that is not blocked.
 *
 * The operator procedures deliberately do NOT. An operator is not the subject of
 * the rule — the matrix asks "may this USER trade/apply/list here, at their
 * verification tier", and gating a vetting queue on it would refuse a desk
 * operator whose own account is tier `none`, or one working from a region the
 * platform does not sell into. Their authority comes from `market:ops`, which is
 * never on a user session (packages/auth WITHHELD_FROM_SESSION).
 *
 * ── AND WHY STAGE 3's TWO READS CARRY NEITHER ──────────────────────────────
 *
 * `profile` and `listed` are `publicProcedure`: no scope, no jurisdiction guard,
 * and genuinely reachable unauthenticated — svc-edge forwards a request with no
 * token, or with a refused one, as ANONYMOUS rather than rejecting it at the door
 * (`services/svc-edge/src/index.ts` "forwarding anonymous"), so these are the
 * marketplace a visitor sees before they have an account.
 *
 * No scope, because a shopfront nobody can look at is not a shopfront. No
 * `{ module: 'market' }` either: the matrix asks "may this USER apply/list here,
 * at their verification tier", and an anonymous reader is not a user — gating a
 * public page on a KYC tier would refuse everybody who has not signed up, which
 * is the entire audience. Halting the module is still possible and still lands
 * before this code: `/api/market` is in svc-edge `UPSTREAMS`, so the kill-switch
 * closes the door in an `onRequest` hook.
 */

const vendorStatus = z.enum(['applied', 'approved', 'rejected', 'suspended']);

const vendorOut = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  displayName: z.string(),
  description: z.string(),
  status: vendorStatus,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** No amount, no capacity, no tier — a slot row records only that it was taken. */
const slotOut = z.object({
  id: z.string().guid(),
  vendorId: z.string().guid(),
  ref: z.string(),
  claimedAt: z.string().datetime(),
  releasedAt: z.string().datetime().nullable(),
});

/**
 * The public shape. Four fields, and `vendor-service.ts` `PublicVendorProfile`
 * carries the full argument for each omission — no userId, no status, no tier,
 * no slot refs, and nothing whatsoever from the operator event log.
 */
const publicVendorOut = z.object({
  id: z.string().guid(),
  displayName: z.string(),
  description: z.string(),
  createdAt: z.string().datetime(),
});

const statusEventOut = z.object({
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
 * Error codes are preserved, not flattened.
 *
 * `market.stake_required` (stake at all) and `market.slots_exhausted` (release
 * one, or stake for a higher tier) are both "you cannot take a slot", and a
 * client that cannot tell them apart cannot tell the vendor what to do next.
 */
function mapError(err: unknown): never {
  if (err instanceof DualControlError || err instanceof ActionApprovalConsumeError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  if (err instanceof AuthError) {
    throw new TRPCError({ code: err.code === 'mfa.required' ? 'UNAUTHORIZED' : 'FORBIDDEN', message: err.message, cause: err });
  }
  if (err instanceof MarketError) {
    const message = userCopy(err.code);
    if (err.code === 'market.vendor_not_found') throw new TRPCError({ code: 'NOT_FOUND', message, cause: err });
    if (err.code === 'market.vendor_already_applied') throw new TRPCError({ code: 'CONFLICT', message, cause: err });
    if (err.code === 'market.vet_operator_required' || err.code === 'market.ops_required') {
      throw new TRPCError({ code: 'FORBIDDEN', message, cause: err });
    }
    if (err.code === 'market.earnings_vendor_required' || err.code === 'market.review_not_buyer') {
      throw new TRPCError({ code: 'FORBIDDEN', message, cause: err });
    }
    if (err.code === 'market.stake_required' || err.code === 'market.vendor_not_approved') {
      throw new TRPCError({ code: 'FORBIDDEN', message, cause: err });
    }
    // CONFLICT rather than FORBIDDEN: the vendor IS entitled, the capacity is
    // simply taken. Retrying after a release is correct client behaviour and a
    // 403 would tell them not to.
    if (err.code === 'market.slots_exhausted') throw new TRPCError({ code: 'CONFLICT', message, cause: err });
    if (err.code === 'market.stake_unavailable' || err.code === 'market.vendor_listing_count_unreadable') {
      // OUR infrastructure, not the caller's request, and the distinction
      // matters to a client: a 403 sends somebody off to go and stake, and
      // telling them that because svc-token was unreachable sends them to do
      // something they have already done. A 500 says "try again". Same mapping,
      // and the same reasoning, as `academy.stake_unavailable`. An unreadable
      // active-listing count is the same class: the row is there, the count is not.
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message, cause: err });
    }
    if (
      err.code === 'market.commission_not_configured' ||
      err.code === 'market.listing_category_unset' ||
      err.code === 'market.subscription_not_built' ||
      err.code === 'market.subscription_recurring_not_built' ||
      err.code === 'market.subscription_period_unset' ||
      err.code === 'market.subscription_past_due' ||
      err.code === 'market.subscription_cancelled' ||
      err.code === 'market.subscription_no_access' ||
      err.code === 'market.period_not_applicable' ||
      err.code === 'market.strategy_profit_share_forbidden' ||
      err.code === 'market.strategy_return_rank_forbidden' ||
      err.code === 'market.listed_vendors_list_limit_unset' ||
      err.code === 'market.public_listings_list_limit_unset' ||
      err.code === 'market.my_listings_list_limit_unset' ||
      err.code === 'market.my_purchases_list_limit_unset' ||
      err.code === 'market.applications_list_limit_unset' ||
      err.code === 'market.history_limit_unset' ||
      err.code === 'market.ops_sales_list_limit_unset' ||
      err.code === 'market.ops_sales_window_unset' ||
      err.code === 'market.ops_sales_window_too_wide' ||
      err.code === 'market.reviews_list_limit_unset' ||
      err.code === 'market.earnings_window_unset' ||
      err.code === 'market.listing_taken_down' ||
      err.code === 'market.takedown_approval_mismatch' ||
      err.code === 'market.review_not_settled' ||
      err.code === 'market.refund_policy_unset' ||
      err.code === 'market.refund_window_closed' ||
      err.code === 'market.purchase_not_refundable' ||
      err.code === MARKET_LISTING_PIN_UNSET ||
      err.code === MARKET_LISTING_PIN_IEEE ||
      err.code === MARKET_LISTING_SET_UNSET ||
      err.code === MARKET_L3_UNAVAILABLE ||
      err.code === MARKET_NOT_NATIVE_EXECUTABLE ||
      err.code === MARKET_REFERENCE_NOT_BOOK
    ) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });
    }
    // Orphan listing / missing slot / over-quota after unstake — preconditions, not bad payloads.
    if (err.code === 'market.listing_slot_missing' || err.code === 'market.slot_required' || err.code === 'market.listing_over_capacity') {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });
    }
    if (err.code === 'market.listing_not_found' || err.code === 'market.purchase_not_found') {
      throw new TRPCError({ code: 'NOT_FOUND', message, cause: err });
    }
    if (
      err.code === 'market.purchase_conflict' ||
      err.code === 'market.purchase_already_held' ||
      err.code === 'market.purchase_receipt_mismatch' ||
      err.code === 'market.purchase_self' ||
      err.code === 'market.listing_not_owned' ||
      err.code === 'market.review_exists' ||
      err.code === 'market.idempotency_conflict'
    ) {
      throw new TRPCError({ code: 'CONFLICT', message, cause: err });
    }
    if (err.code === 'market.insufficient_funds') {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });
    }
    // Omitted catalogue sort is a bad request. There is no default order.
    if (err.code === 'market.listings_sort_unset') {
      throw new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
    }
    throw new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
  }
  throw err;
}

export const listingOut = z.object({
  id: z.string().guid(),
  vendorId: z.string().guid(),
  title: z.string(),
  description: z.string(),
  offerType: z.enum(['one_time', 'subscription']),
  assetId: z.string(),
  price: z.string(),
  periodSeconds: z.number().int().positive().nullable(),
  status: z.enum(['active', 'archived', 'taken_down']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * A listing stores no copy-leader, bot or signal id, so this read has no
 * performance source. `reported: false` carries no figure.
 */
const NO_LISTING_PERFORMANCE = { reported: false } as const;

/** Public listing detail. Strict so a seller user id cannot ride along. */
export const listingDetailOut = z
  .object({
    listing: listingOut.strict(),
    vendor: publicVendorOut.strict(),
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
        assetId: z.string(),
        price: z.string(),
        periodSeconds: z.number().int().positive().nullable(),
      })
      .strict(),
    performance: z.object({ reported: z.literal(false) }).strict(),
  })
  .strict();

const purchaseOut = z.object({
  id: z.string().guid(),
  listingId: z.string().guid(),
  buyerId: z.string().guid(),
  vendorId: z.string().guid(),
  vendorUserId: z.string().guid(),
  assetId: z.string(),
  price: z.string(),
  commissionBps: z.number().int(),
  status: z.enum(['pending', 'settled', 'rejected']),
  ledgerTxId: z.string().guid().nullable(),
  rejectionCode: z.string().nullable(),
  createdAt: z.string().datetime(),
  settledAt: z.string().datetime().nullable(),
  accessUntil: z.string().datetime().nullable(),
  periodSeconds: z.number().int().positive().nullable(),
  refundWindowSeconds: z.number().int().positive().nullable(),
  hold: z
    .object({
      state: z.enum(['held', 'refunded', 'released']),
      heldAmount: z.string(),
      heldAt: z.string().datetime(),
      windowEndsAt: z.string().datetime(),
      refundRequestedAt: z.string().datetime().nullable(),
      refundedAt: z.string().datetime().nullable(),
      refundTxId: z.string().guid().nullable(),
      releasedAt: z.string().datetime().nullable(),
      releaseTxId: z.string().guid().nullable(),
    })
    .nullable(),
});

const salesRowOut = z.object({
  vendorId: z.string().guid(),
  assetId: z.string(),
  settledVolume: z.string(),
  settledCount: z.string(),
  commission: z.string(),
});

const reviewOut = z.object({
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
export const reviewPublicOut = z
  .object({
    id: z.string().guid(),
    listingId: z.string().guid(),
    vendorId: z.string().guid(),
    score: z.number().int().min(1).max(5),
    text: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

const takedownOut = z.object({
  listingId: z.string().guid(),
  status: z.literal('taken_down'),
  reason: z.string(),
  actorId: z.string().guid(),
  takenDownAt: z.string().datetime(),
});

const categorySetOut = z.object({
  listingId: z.string().guid(),
  category: z.string().min(1).max(32),
  actorId: z.string().guid(),
  reason: z.string(),
  businessKey: z.string().min(1).max(128),
  recordedAt: z.string().datetime(),
});

export function createMarketRouter(
  vendors: VendorService,
  commerce?: CommerceService,
  perpProposals?: PerpProposalService,
  approvals: ActionApprovalConsumer = unwiredApprovalConsumer(),
  reviews?: ReviewsService,
) {
  return router({
    /**
     * Apply to be a vendor. One application per account; status is not an input.
     *
     * Named `applyAsVendor` rather than `apply` because tRPC reserves `apply` as a
     * router key — a bare `apply` compiles and then throws at router construction.
     */
    applyAsVendor: scopedProcedure('market:write', { module: 'market' })
      .input(z.object({ displayName: z.string().min(1).max(80), description: z.string().min(1).max(2_000) }))
      .output(vendorOut)
      .mutation(async ({ ctx, input }) => {
        try {
          return await vendors.applyAsVendor({ userId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /** The caller's own application. Null rather than a 404: "you have not applied" is an answer. */
    mine: scopedProcedure('market:read', { module: 'market' })
      .output(vendorOut.nullable())
      .query(async ({ ctx }) => {
        return vendors.myVendor(ctx.principal!.userId);
      }),

    /**
     * The operator queue. Defaults to undecided applications, oldest first.
     *
     * `limit` is optional here so omit reaches the service named refuse
     * (`market.applications_list_limit_unset`) instead of a Zod "Required"
     * that looks like a typo. Blank is not 50; pass 50 explicitly when that is
     * the page you want.
     */
    listApplications: scopedProcedure(MARKET_OPS_SCOPE)
      .input(z.object({ status: vendorStatus.optional(), limit: z.number().int().positive().max(50).optional() }).optional())
      .output(z.array(vendorOut))
      .query(async ({ input }) => {
        try {
          return await vendors.listApplications({ status: input?.status ?? 'applied', limit: input?.limit });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Record an operator's decision and apply it.
     *
     * `decision` and `reason` come from the operator. `actorId` and `actorScope`
     * come from the verified principal and the guard above — never from the
     * request body, or the audit row records who the caller said they were.
     *
     * MFA + identity-issued action-bound approval. Typed-in `confirmOperatorId`
     * is display attribution only — a second name is not a second person.
     * `market:ops` is not INTERACTIVE_ONLY, so MFA is local like kyc.approve.
     */
    vet: scopedProcedure(MARKET_OPS_SCOPE)
      .input(
        z.object({
          vendorId: z.string().guid(),
          decision: z.enum(['approved', 'rejected', 'suspended']),
          reason: z.string().min(1).max(2_000),
          confirmOperatorId: z.string().max(128).nullish(),
          approvalId: z.string().max(128).nullish(),
          operationId: z.string().max(128).nullish(),
        }),
      )
      .output(
        z.object({
          changed: z.boolean(),
          vendor: vendorOut,
          event: statusEventOut.nullable(),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          requireMfa(ctx.principal!);
          void input.confirmOperatorId;
          const ids = readApprovalIds(input);
          const consumed = await approvals.consume({
            approvalId: ids.approvalId,
            operationId: ids.operationId,
            payloadHash: marketActionPayloadHash('market.vendor.vet', {
              vendorId: input.vendorId,
              decision: input.decision,
              reason: input.reason,
            }),
            targetService: 'svc-market',
            targetId: 'market.vendor.vet',
            expectedVersion: '1',
          });
          const confirmOperatorId = consumed.approverId ?? consumed.requesterId;
          const result = await vendors.vet({
            vendorId: input.vendorId,
            decision: input.decision,
            reason: input.reason,
            actorId: ctx.principal!.userId,
            actorScope: MARKET_OPS_SCOPE,
          });
          return { ...result, confirmOperatorId };
        } catch (err) {
          mapError(err);
        }
      }),

    ops: router({
      /**
       * Settled volume, count, and commission per vendor and asset.
       * Commission uses each purchase row's stored bps, floored like marketPurchase.
       * Blank window or limit refuses. A session without market:ops never reaches this.
       */
      sales: scopedProcedure(MARKET_OPS_SCOPE)
        .input(
          z
            .object({
              from: z.string().max(64).optional(),
              to: z.string().max(64).optional(),
              vendorId: z.string().guid().optional(),
              limit: z.number().int().positive().max(50).optional(),
              cursor: z.string().max(512).optional(),
            })
            .optional(),
        )
        .output(
          z.object({
            rows: z.array(salesRowOut),
            refusedCount: z.string(),
            pendingCount: z.string(),
            nextCursor: z.string().nullable(),
          }),
        )
        .query(async ({ input }) => {
          requireCommerce(commerce);
          try {
            return await commerce.opsSales({
              actorScope: MARKET_OPS_SCOPE,
              from: input?.from,
              to: input?.to,
              vendorId: input?.vendorId,
              limit: input?.limit,
              cursor: input?.cursor,
            });
          } catch (err) {
            mapError(err);
          }
        }),

      /**
       * Operator takedown. MFA is local because market:ops is not INTERACTIVE_ONLY.
       * Identity approval type `market.takedown`, target id = listing id, expectedVersion `1`.
       * Payload hash is marketActionPayloadHash('market.takedown', { listingId, reason }).
       */
      takedownListing: scopedProcedure(MARKET_OPS_SCOPE)
        .input(
          z.object({
            listingId: z.string().guid(),
            reason: z.string().max(2_000),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
            clientRequestId: z.string().max(128),
          }),
        )
        .output(takedownOut)
        .mutation(async ({ ctx, input }) => {
          requireCommerce(commerce);
          try {
            requireMfa(ctx.principal!);
            return await commerce.takedownListing(
              {
                actorId: ctx.principal!.userId,
                actorScope: MARKET_OPS_SCOPE,
                listingId: input.listingId,
                reason: input.reason,
                approvalId: input.approvalId,
                operationId: input.operationId,
                clientRequestId: input.clientRequestId,
              },
              approvals,
            );
          } catch (err) {
            mapError(err);
          }
        }),

      /**
       * File a one-time listing under a product category. MFA is local because
       * market:ops is not INTERACTIVE_ONLY. Actor is the principal, not the body.
       * The slug and the audit row commit together. Replay is the business key.
       * Strategy listings stay uncategorised in this slice.
       */
      setListingCategory: scopedProcedure(MARKET_OPS_SCOPE)
        .input(
          z.object({
            listingId: z.string().guid(),
            /** Product slug. A string that is not the enum is market.category_invalid. */
            category: z.string().max(64),
            reason: z.string().max(2_000),
            businessKey: z.string().max(128),
          }),
        )
        .output(categorySetOut)
        .mutation(async ({ ctx, input }) => {
          requireCommerce(commerce);
          try {
            requireMfa(ctx.principal!);
            return await commerce.setListingCategory({
              actorId: ctx.principal!.userId,
              actorScope: MARKET_OPS_SCOPE,
              listingId: input.listingId,
              category: input.category,
              reason: input.reason,
              businessKey: input.businessKey,
            });
          } catch (err) {
            mapError(err);
          }
        }),
    }),

    /**
     * Take a listing slot, if the caller's stake tier has one free.
     *
     * `ref` names what the slot is for and makes a retry idempotent — a dropped
     * connection must not consume a second slot for the same listing. Stage 3
     * passes a listing id.
     *
     * The applicant is always the PRINCIPAL: there is no vendorId input, because
     * a slot claim that named its own vendor would let anyone spend somebody
     * else's capacity.
     */
    claimSlot: scopedProcedure('market:write', { module: 'market' })
      .input(z.object({ ref: z.string().min(1).max(200) }))
      .output(z.object({ claimed: z.boolean(), slot: slotOut }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await vendors.claimSlot({ userId: ctx.principal!.userId, ref: input.ref });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Give a slot back. `released: false` when it was not held — not a 404. */
    releaseSlot: scopedProcedure('market:write', { module: 'market' })
      .input(z.object({ ref: z.string().min(1).max(200) }))
      .output(z.object({ released: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await vendors.releaseSlot({ userId: ctx.principal!.userId, ref: input.ref });
        } catch (err) {
          mapError(err);
        }
      }),

    proposePerpMarket: scopedProcedure('market:write', { module: 'market' })
      .input(
        z
          .object({
            clientProposalId: z.string().guid(),
            // Empty strings reach the domain gate so the caller receives its
            // typed missing-owner-decision code instead of an opaque Zod 400.
            symbol: z.string().max(80),
            settle: z.string().max(128),
            oracleSource: z.string().max(256),
            leverageCap: z.string().max(64),
          })
          .strict(),
      )
      .output(
        z.object({
          id: z.string().guid(),
          proposerId: z.string().guid(),
          symbol: z.string(),
          settle: z.string(),
          oracleSource: z.string(),
          leverageCap: z.string(),
          status: z.enum(['proposed', 'listed_unorderable', 'orderable']),
          orderable: z.boolean(),
          createdAt: z.string().datetime(),
          updatedAt: z.string().datetime(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (!perpProposals) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'market perpetual proposals are not wired in this process' });
        }
        try {
          return await perpProposals.propose({ ...input, proposerId: ctx.principal!.userId });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * The caller's slot position, with capacity re-read from svc-token.
     *
     * `usable` rather than `held` is the number that answers "may this vendor
     * present as listed" — see `slot-access.ts`. A vendor who has unstaked reads
     * `usable: 0` here immediately, which is what makes DoD clause 5 hold
     * without svc-market subscribing to an unstake event that does not exist.
     */
    slots: scopedProcedure('market:read', { module: 'market' })
      .output(
        z.object({
          vendorId: z.string().guid(),
          status: vendorStatus,
          tier: z.string(),
          capacity: z.number().int().nonnegative(),
          held: z.number().int().nonnegative(),
          usable: z.number().int().nonnegative(),
          slots: z.array(slotOut),
        }),
      )
      .query(async ({ ctx }) => {
        try {
          return await vendors.slotStatus(ctx.principal!.userId);
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * One listed vendor's public profile (Stage 3).
     *
     * NOT_FOUND covers every "you cannot see this vendor" — unknown id, never
     * approved, suspended, holds no slot, or has unstaked below the tier that
     * paid for their slots. One answer for all five, so nobody can use this
     * endpoint to work out who was suspended. See `publicProfile`.
     *
     * `market.stake_unavailable` is deliberately NOT flattened into that: it
     * reaches `mapError` and becomes a 500. A 404 would tell a caller this vendor
     * does not exist, which is false, cacheable, and would still be being served
     * long after svc-token came back.
     */
    profile: publicProcedure
      .input(z.object({ vendorId: z.string().guid() }))
      .output(publicVendorOut)
      .query(async ({ input }) => {
        let profile;
        try {
          profile = await vendors.publicProfile(input.vendorId);
        } catch (err) {
          mapError(err);
        }
        if (!profile) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No listed vendor with that id.' });
        }
        return profile;
      }),

    /**
     * The public directory of listed vendors, in registration order.
     *
     * Registration order and nothing else: ranking and featured placement are the
     * owner's (§8). A page can be shorter than `limit` when a vendor on it has
     * dropped below their tier, and an svc-token outage empties it — nobody
     * appears rather than everybody.
     *
     * `limit` is optional here so omit reaches the service named refuse
     * (`market.listed_vendors_list_limit_unset`) instead of a Zod "Required"
     * that looks like a typo. Blank is not 20; pass 20 explicitly when that is
     * the page you want.
     */
    listed: publicProcedure
      .input(z.object({ limit: z.number().int().positive().max(50).optional() }).optional())
      .output(z.array(publicVendorOut))
      .query(async ({ input }) => {
        try {
          return await vendors.listedVendors({ limit: input?.limit });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * The audit trail for one application, newest first.
     *
     * `limit` is optional here so omit reaches the service named refuse
     * (`market.history_limit_unset`) instead of a Zod "Required" that looks
     * like a typo. Blank is not 50; pass 50 explicitly when that is the page
     * you want.
     */
    history: scopedProcedure(MARKET_OPS_SCOPE)
      .input(z.object({ vendorId: z.string().guid(), limit: z.number().int().positive().max(200).optional() }))
      .output(z.array(statusEventOut))
      .query(async ({ input }) => {
        try {
          return await vendors.history(input.vendorId, input.limit);
        } catch (err) {
          mapError(err);
        }
      }),

    // ── market.commerce ──────────────────────────────────────────────────────

    /**
     * Whether this deployment has a house commission rate. Blank config is the
     * refuse-closed default — createListing, public catalogue, and purchase
     * will not invent a rate (D26-P1-M2).
     */
    commerceProgramme: publicProcedure
      .output(z.object({ commissionBps: z.number().int().nullable(), commissionConfigured: z.boolean() }))
      .query(() => {
        if (!commerce) {
          return { commissionBps: null, commissionConfigured: false };
        }
        return commerce.programme();
      }),

    createListing: scopedProcedure('market:write', { module: 'market' })
      .input(
        z.object({
          title: z.string().min(1).max(120),
          description: z.string().min(1).max(4_000),
          offerType: z.enum(['one_time', 'subscription']),
          assetId: z.string().min(1).max(32),
          /** Decimal string — never a number. */
          price: z.string().min(1).max(64),
          /** Whole seconds. Required when offerType is subscription. No default month. */
          periodSeconds: z.number().int().positive().optional(),
          /**
           * Product category. Optional on one-time — omit stays uncategorised.
           * Checked only when sent. Strategy listings stay uncategorised.
           */
          category: z.string().max(64).optional(),
        }),
      )
      .output(listingOut)
      .mutation(async ({ ctx, input }) => {
        requireCommerce(commerce);
        try {
          // Blank MARKET_HOUSE_COMMISSION_BPS refuses before insert/slot claim.
          return await commerce.createListing({ userId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Strategy marketplace publish — same shop as createListing.
     * Always a subscription with periodSeconds. Stake gate is claimSlot.
     * No profit-share input. Catalogue ranking is not this door.
     */
    createStrategyListing: scopedProcedure('market:write', { module: 'market' })
      .input(
        z
          .object({
            title: z.string().min(1).max(120),
            description: z.string().min(1).max(4_000),
            assetId: z.string().min(1).max(32),
            /** Decimal string — never a number. */
            price: z.string().min(1).max(64),
            /** Whole seconds. Required. No default month. */
            periodSeconds: z.number().int().positive(),
          })
          .strict(),
      )
      .output(listingOut)
      .mutation(async ({ ctx, input }) => {
        requireCommerce(commerce);
        try {
          return await createStrategyListing(commerce, { userId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * One-time listing that names a product category. Not a strategy.
     * Blank category and blank price refuse by name. An unknown slug is
     * market.category_invalid. createListing may omit the category.
     */
    createNonStrategyListing: scopedProcedure('market:write', { module: 'market' })
      .input(
        z
          .object({
            title: z.string().min(1).max(120),
            description: z.string().min(1).max(4_000),
            assetId: z.string().min(1).max(32),
            /** Decimal string. Blank reaches the service refuse — not a free price. */
            price: z.string().max(64).optional(),
            /** Product slug. Omit and whitespace are `market.listing_category_unset`. */
            category: z.string().max(64).optional(),
          })
          .strict(),
      )
      .output(listingOut.extend({ category: z.string().min(1).max(32) }))
      .mutation(async ({ ctx, input }) => {
        requireCommerce(commerce);
        try {
          return await commerce.createNonStrategyListing({ userId: ctx.principal!.userId, ...input });
        } catch (err) {
          mapError(err);
        }
      }),

    archiveListing: scopedProcedure('market:write', { module: 'market' })
      .input(z.object({ listingId: z.string().guid() }))
      .output(listingOut)
      .mutation(async ({ ctx, input }) => {
        requireCommerce(commerce);
        try {
          return await commerce.archiveListing({ userId: ctx.principal!.userId, listingId: input.listingId });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Caller's listings. `limit` optional so omit reaches
     * `market.my_listings_list_limit_unset`. Blank is not 50; pass 50
     * explicitly when that is the page you want.
     */
    myListings: scopedProcedure('market:read', { module: 'market' })
      .input(z.object({ limit: z.number().int().positive().max(50).optional() }).optional())
      .output(z.array(listingOut))
      .query(async ({ ctx, input }) => {
        requireCommerce(commerce);
        try {
          return await commerce.myListings(ctx.principal!.userId, { limit: input?.limit });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * PTX-M06-R06 / R09 — public market-data honesty door.
     * L3/queue/executable L3 refuse by name. Index/mark never a bid/ask.
     */
    marketData: router({
      policy: publicProcedure.query(() => describeMarketDataHonesty()),
      book: publicProcedure
        .input(
          z.object({
            marketId: z.string().min(1).max(128),
            product: z.enum(['L1', 'L2', 'L3', 'queue', 'executable_l3']),
          }),
        )
        .query(({ input }) => {
          try {
            return requestBook(input);
          } catch (err) {
            mapError(err);
          }
        }),
      quote: publicProcedure
        .input(
          z.object({
            kind: z.enum(['native_executable', 'implied', 'synthetic', 'indicative', 'index', 'mark']),
            price: quotePriceSchema,
            asNativeExecutable: z.boolean().optional(),
            asBidAsk: z.boolean().optional(),
          }),
        )
        .query(({ input }) => {
          try {
            return presentQuote(input);
          } catch (err) {
            mapError(err);
          }
        }),
    }),

    /**
     * Live venue catalogue. Listing which assets is owner SOCKET (P0-06).
     * Unpinned / pin-is-not-a-set named-refuse. Never invents a market id.
     * Public so a missing procedure cannot look like 404.
     */
    liveMarkets: publicProcedure.query(() => {
      try {
        listLiveMarkets();
      } catch (err) {
        mapError(err);
      }
    }),

    /** Alias of `liveMarkets` — a `/trpc/listedAssets` 404 would look like "not a door". */
    listedAssets: publicProcedure.query(() => {
      try {
        listLiveMarkets();
      } catch (err) {
        mapError(err);
      }
    }),

    /**
     * One shopfront listing by id (MC-market-01). Public, like `listings`.
     * Unknown and not-on-the-shopfront are both `market.listing_not_found`.
     * Blank commission is `market.commission_not_configured`, before the read.
     * No seller user id. Performance is unreported: there is no source id to read.
     */
    listing: publicProcedure
      .input(z.object({ listingId: z.string().guid() }))
      .output(listingDetailOut)
      .query(async ({ input }) => {
        requireCommerce(commerce);
        try {
          const detail = await commerce.publicListing(input.listingId);
          if (!detail) throw new MarketError('market.listing_not_found', 'market.listing_not_found');
          requireReviews(reviews);
          const summary = await reviews.summaryForListing(input.listingId);
          return {
            listing: detail.listing,
            vendor: detail.vendor,
            activeListingCount: detail.activeListingCount,
            reviews: summary,
            terms: {
              offerType: detail.listing.offerType,
              assetId: detail.listing.assetId,
              price: detail.listing.price,
              periodSeconds: detail.listing.periodSeconds,
            },
            performance: NO_LISTING_PERFORMANCE,
          };
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Public catalogue — empty when commission blank; else listed vendors only.
     * `limit` optional so omit reaches `market.public_listings_list_limit_unset`.
     * Blank is not 50; pass 50 explicitly when that is the page you want.
     * Order is `created_at ASC, id ASC`. Search and paging are `listingsPage`.
     */
    listings: publicProcedure
      .input(z.object({ limit: z.number().int().positive().max(50).optional() }).optional())
      .output(z.array(listingOut))
      .query(async ({ input }) => {
        requireCommerce(commerce);
        try {
          return await commerce.publicListings({ limit: input?.limit });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Paged public catalogue. `sort` is required: omit or blank is
     * `market.listings_sort_unset` (BAD_REQUEST). No default order.
     * `limit` optional so omit reaches `market.public_listings_list_limit_unset`.
     */
    listingsPage: publicProcedure
      .input(
        z
          .object({
            q: z.string().max(120).optional(),
            offerType: z.enum(['one_time', 'subscription']).optional(),
            assetId: z.string().max(32).optional(),
            sort: z.enum(['newest', 'priceAsc', 'priceDesc', 'title']).optional(),
            limit: z.number().int().positive().max(50).optional(),
            cursor: z.string().max(512).optional(),
          })
          .optional(),
      )
      .output(
        z.object({
          items: z.array(listingOut.extend({ vendorListingCount: z.number().int().nonnegative() })),
          nextCursor: z.string().nullable(),
        }),
      )
      .query(async ({ input }) => {
        requireCommerce(commerce);
        try {
          return await commerce.publicListingsPage({
            q: input?.q,
            offerType: input?.offerType,
            assetId: input?.assetId,
            sort: input?.sort,
            limit: input?.limit,
            cursor: input?.cursor,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Product category enum for one-time listings. Not an owner env list.
     * Strategy listings stay uncategorised for now.
     */
    listingCategories: publicProcedure.output(z.object({ categories: z.array(z.string().min(1).max(32)) })).query(() => {
      requireCommerce(commerce);
      try {
        return { categories: [...commerce.listingCategories()] };
      } catch (err) {
        mapError(err);
      }
    }),

    /**
     * One-time listings in one product category. Omit / blank category is
     * not the whole catalogue. Omit limit is not 50. Strategy rows are excluded.
     * Short page only — a cursor for this page is a later slice.
     */
    listingsByCategory: publicProcedure
      .input(
        z
          .object({
            category: z.string().max(64).optional(),
            limit: z.number().int().positive().max(50).optional(),
          })
          .optional(),
      )
      .output(z.array(listingOut.extend({ category: z.string().min(1).max(32) })))
      .query(async ({ input }) => {
        requireCommerce(commerce);
        try {
          return await commerce.publicListingsByCategory({
            category: input?.category,
            limit: input?.limit,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Automatic recurring charge is not built (no second recipe / scheduler).
     * One period is `purchase`. Public so a missing procedure cannot look like 404.
     */
    subscribe: publicProcedure.input(z.object({ listingId: z.string().guid().optional() }).optional()).mutation(async () => {
      try {
        refuseRecurringSubscribe();
      } catch (err) {
        mapError(err);
      }
    }),

    /** Alias of `subscribe` — a `/trpc/recurring` 404 would look like "not a door". */
    recurring: publicProcedure.input(z.object({ listingId: z.string().guid().optional() }).optional()).mutation(async () => {
      try {
        refuseRecurringSubscribe();
      } catch (err) {
        mapError(err);
      }
    }),

    /**
     * One-time purchase. `purchaseId` is client-supplied so a retry is the same
     * purchase. Blank commission config refuses before any post.
     */
    purchase: scopedProcedure('market:write', { module: 'market' })
      .input(z.object({ listingId: z.string().guid(), purchaseId: z.string().guid() }))
      .output(purchaseOut)
      .mutation(async ({ ctx, input }) => {
        requireCommerce(commerce);
        try {
          return await commerce.purchase({
            buyerId: ctx.principal!.userId,
            listingId: input.listingId,
            purchaseId: input.purchaseId,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * The buyer asks for a held purchase's whole amount back, inside its refund window. Blank refund policy refuses
     * `market.refund_policy_unset`; after the window `market.refund_window_closed`; a direct sale
     * `market.purchase_not_refundable`. A retry after the refund posted returns the same refunded purchase.
     */
    refundPurchase: scopedProcedure('market:write', { module: 'market' })
      .input(z.object({ purchaseId: z.string().guid() }))
      .output(purchaseOut)
      .mutation(async ({ ctx, input }) => {
        requireCommerce(commerce);
        try {
          return await commerce.refundPurchase({ buyerId: ctx.principal!.userId, purchaseId: input.purchaseId });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Caller's purchases. `limit` optional so omit reaches
     * `market.my_purchases_list_limit_unset`. Blank is not 50; pass 50
     * explicitly when that is the page you want.
     */
    myPurchases: scopedProcedure('market:read', { module: 'market' })
      .input(z.object({ limit: z.number().int().positive().max(50).optional() }).optional())
      .output(z.array(purchaseOut))
      .query(async ({ ctx, input }) => {
        requireCommerce(commerce);
        try {
          return await commerce.purchasesOf(ctx.principal!.userId, { limit: input?.limit });
        } catch (err) {
          mapError(err);
        }
      }),

    /**
     * Caller's settled sales. Window is required. Commission is each row's snapshot.
     * `sales` are the ledger postings. A non-vendor is refused. No payout batch.
     */
    myEarnings: scopedProcedure('market:read', { module: 'market' })
      .input(z.object({ from: z.string().max(64).optional(), to: z.string().max(64).optional() }).optional())
      .output(
        z.object({
          from: z.string().datetime(),
          to: z.string().datetime(),
          assets: z.array(
            z.object({
              assetId: z.string(),
              gross: z.string(),
              commission: z.string(),
              net: z.string(),
            }),
          ),
          sales: z.array(
            z.object({
              purchaseId: z.string().guid(),
              listingId: z.string().guid(),
              assetId: z.string(),
              gross: z.string(),
              commission: z.string(),
              net: z.string(),
              ledgerTxId: z.string().guid(),
              settledAt: z.string().datetime(),
            }),
          ),
        }),
      )
      .query(async ({ ctx, input }) => {
        requireCommerce(commerce);
        try {
          return await commerce.myEarnings({
            userId: ctx.principal!.userId,
            from: input?.from,
            to: input?.to,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    reviews: router({
      submit: scopedProcedure('market:write', { module: 'market' })
        .input(
          z.object({
            purchaseId: z.string().guid(),
            score: z.number(),
            text: z.string().max(1_000).optional(),
            clientRequestId: z.string().max(128),
          }),
        )
        .output(reviewOut)
        .mutation(async ({ ctx, input }) => {
          requireReviews(reviews);
          try {
            return await reviews.submit({ buyerId: ctx.principal!.userId, ...input });
          } catch (err) {
            mapError(err);
          }
        }),

      list: scopedProcedure('market:read', { module: 'market' })
        .input(
          z.object({
            listingId: z.string().guid(),
            limit: z.number().int().positive().max(50).optional(),
            cursor: z.string().max(512).optional(),
          }),
        )
        .output(z.object({ reviews: z.array(reviewPublicOut), nextCursor: z.string().nullable() }))
        .query(async ({ input }) => {
          requireReviews(reviews);
          try {
            return await reviews.list({
              listingId: input.listingId,
              limit: input.limit,
              cursor: input.cursor,
            });
          } catch (err) {
            mapError(err);
          }
        }),

      summary: scopedProcedure('market:read', { module: 'market' })
        .input(z.object({ vendorId: z.string().guid() }))
        .output(
          z.object({
            vendorId: z.string().guid(),
            count: z.string(),
            mean: z.string().nullable(),
            meanRounding: z.literal(REVIEW_MEAN_ROUNDING),
          }),
        )
        .query(async ({ input }) => {
          requireReviews(reviews);
          try {
            return await reviews.summary(input.vendorId);
          } catch (err) {
            mapError(err);
          }
        }),
    }),

    cancelSubscription: scopedProcedure('market:write', { module: 'market' })
      .input(z.object({ listingId: z.string().guid() }))
      .output(
        z.object({
          listingId: z.string().guid(),
          buyerId: z.string().guid(),
          cancelledAt: z.string().datetime(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireCommerce(commerce);
        try {
          return await commerce.cancelSubscription({ buyerId: ctx.principal!.userId, listingId: input.listingId });
        } catch (err) {
          mapError(err);
        }
      }),

    subscriptionAccess: scopedProcedure('market:read', { module: 'market' })
      .input(z.object({ listingId: z.string().guid() }))
      .output(
        z.object({
          granted: z.literal(true),
          listingId: z.string().guid(),
          buyerId: z.string().guid(),
          accessUntil: z.string().datetime(),
        }),
      )
      .query(async ({ ctx, input }) => {
        requireCommerce(commerce);
        try {
          return await commerce.subscriptionAccess({ buyerId: ctx.principal!.userId, listingId: input.listingId });
        } catch (err) {
          mapError(err);
        }
      }),
  });
}

function refuseRecurringSubscribe(): never {
  throw new MarketError(
    'Automatic recurring subscribe is not built — buy one period with purchase',
    'market.subscription_recurring_not_built',
  );
}

function requireReviews(reviews: ReviewsService | undefined): asserts reviews is ReviewsService {
  if (!reviews) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'market.reviews is not wired in this process',
    });
  }
}

function requireCommerce(commerce: CommerceService | undefined): asserts commerce is CommerceService {
  if (!commerce) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'market.commerce is not wired in this process',
    });
  }
}

export type MarketRouter = ReturnType<typeof createMarketRouter>;
