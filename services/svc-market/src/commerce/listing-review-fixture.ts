import type { Sql } from 'postgres';
import type { VendorService } from '../vendor-service.js';
import type { ActionApprovalConsumer } from '../action-approval-consume.js';
import { CommerceService, type ListingReviewDecision } from './commerce-service.js';

/**
 * Test fixture: two founders' review of one listing, through svc-market's own door (`decideListingReview`), so a test
 * whose subject is a purchase, a takedown or a catalogue read starts from a listing the founders approved, as the
 * product requires (MC-market-03). The approval is a stand-in for identity's: a different founder, consumed, bound to
 * the same action type, listing and payload. Never wired in a running service.
 */
export const TEST_REVIEW_FOUNDER_A = '0000000a-0000-4000-8000-00000000000a';
export const TEST_REVIEW_FOUNDER_B = '0000000b-0000-4000-8000-00000000000b';
export const TEST_REVIEW_RULES = { criteria: ['TEST criteria: the listing says what it sells'], windowSeconds: 86_400 } as const;

export function reviewApprovals(requesterId = TEST_REVIEW_FOUNDER_A, approverId = TEST_REVIEW_FOUNDER_B): ActionApprovalConsumer {
  return {
    async consume(input) {
      return {
        approvalId: input.approvalId,
        operationId: input.operationId,
        actionType: 'market.listing.review',
        targetService: input.targetService,
        targetId: input.targetId,
        expectedVersion: input.expectedVersion,
        payloadHash: input.payloadHash,
        requesterId,
        approverId,
        policyVersion: 'v1',
        createdAt: '2026-11-06T00:00:00.000Z',
        expiresAt: '2026-11-06T00:10:00.000Z',
        status: 'CONSUMED',
      } as never;
    },
  };
}

/** Two TEST founders decide `listingId` (approved by default). */
export async function reviewListing(
  sql: Sql,
  vendors: VendorService,
  listingId: string,
  decision: ListingReviewDecision = 'approved',
  reason = 'TEST review decision for this unit test',
): Promise<void> {
  const reviewer = new CommerceService(sql, vendors, {} as never, { commissionBps: null, review: TEST_REVIEW_RULES });
  await reviewer.decideListingReview(
    {
      actorId: TEST_REVIEW_FOUNDER_A,
      actorScope: 'market:ops',
      listingId,
      decision,
      reason,
      approvalId: `test-approval-${listingId}`,
      operationId: `test-operation-${listingId}`,
    },
    reviewApprovals(),
  );
}

/**
 * A CommerceService whose every new listing two TEST founders then approve through `decideListingReview`, for tests
 * whose subject comes after the review (a purchase, a takedown, a catalogue read). A test of the review itself uses
 * `new CommerceService` and decides explicitly.
 */
export function approvingCommerce(...args: ConstructorParameters<typeof CommerceService>): CommerceService {
  const [sql, vendors] = args;
  const commerce = new CommerceService(...args);
  const create = commerce.createListing.bind(commerce);
  commerce.createListing = async (input) => {
    const row = await create(input);
    await reviewListing(sql, vendors, row.id);
    return { ...row, reviewState: 'approved' };
  };
  return commerce;
}
