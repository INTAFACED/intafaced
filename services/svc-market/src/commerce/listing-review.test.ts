import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MARKET_OPS_SCOPE, VendorService } from '../vendor-service.js';
import { CommerceService } from './commerce-service.js';
import { TEST_REVIEW_FOUNDER_A, TEST_REVIEW_FOUNDER_B, TEST_REVIEW_RULES, reviewApprovals } from './listing-review-fixture.js';

// MC-market-03 and RC-more-catalogue-19 (J-more-catalogue-04): every listing of every kind waits in `applied` until two
// founders decide it; only an approved listing is public or sold; a rejection carries its reason to the seller; a
// takedown leaves the public list with its reason in the same audit; a blank owner rule keeps the queue waiting.

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SELLER = '41111111-1111-4111-8111-111111111111';
const BUYER = '42222222-2222-4222-8222-222222222222';
const OPERATOR = '43333333-3333-4333-8333-333333333333';
const REASON = 'TEST the listing says what it sells and names its terms';

const url = process.env.TEST_DATABASE_URL?.trim();
if (!url) throw new Error('Listing review tests need an isolated TEST_DATABASE_URL (no skip-green)');

describe('listing review: applied, two founders decide, only approved is public', () => {
  let db: TestDatabase;
  let vendors: VendorService;
  let ledger: MemoryLedger;
  const service = (review: { criteria: readonly string[] | null; windowSeconds: number | null } = TEST_REVIEW_RULES) =>
    new CommerceService(db.sql, vendors, ledger, { commissionBps: 100, review });
  const decide = (
    commerce: CommerceService,
    listingId: string,
    decision: 'approved' | 'rejected',
    opts: { actorId?: string; approvals?: ReturnType<typeof reviewApprovals>; reason?: string } = {},
  ) =>
    commerce.decideListingReview(
      {
        actorId: opts.actorId ?? TEST_REVIEW_FOUNDER_A,
        actorScope: MARKET_OPS_SCOPE,
        listingId,
        decision,
        reason: opts.reason ?? REASON,
        approvalId: `approval-${randomUUID()}`,
        operationId: `operation-${randomUUID()}`,
      },
      opts.approvals ?? reviewApprovals(),
    );

  async function listing(kind: 'strategy' | 'data'): Promise<string> {
    const commerce = service();
    const row =
      kind === 'strategy'
        ? await commerce.createListing({
            userId: SELLER,
            title: 'TEST strategy',
            description: 'TEST strategy subscription',
            offerType: 'subscription',
            assetId: 'USDT',
            price: '10',
            periodSeconds: 86_400,
          })
        : await commerce.createNonStrategyListing({
            userId: SELLER,
            title: 'TEST data',
            description: 'TEST data feed',
            assetId: 'USDT',
            price: '5',
            category: 'data',
          });
    expect(row.reviewState).toBe('applied');
    return row.id;
  }

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'market', url: url!, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE market.listing_review_decisions, market.purchases, market.vendor_slots, market.listings, market.vendor_status_events, market.vendors CASCADE`;
    vendors = new VendorService(db.sql, { entitlementOf: async () => ({ tierName: 'TEST', vendorSlots: 5 }) });
    ledger = new MemoryLedger();
    const v = await vendors.applyAsVendor({ userId: SELLER, displayName: 'TEST seller', description: 'TEST seller' });
    await vendors.vet({ vendorId: v.id, decision: 'approved', reason: 'TEST approved', actorId: OPERATOR, actorScope: MARKET_OPS_SCOPE });
  });

  it('a new listing of every kind waits in applied: in the queue with its seller and terms, not public, not sold', async () => {
    const strategy = await listing('strategy');
    const data = await listing('data');
    const commerce = service();
    const queue = await commerce.listingReviewQueue({ actorScope: MARKET_OPS_SCOPE, limit: 50 });
    expect(queue).toMatchObject({ criteria: TEST_REVIEW_RULES.criteria.join('; '), windowSeconds: 86_400, queueState: 'open' });
    expect(queue.rows.map((r) => [r.id, r.offerType, r.sellerName, r.price, r.reviewState])).toEqual([
      [strategy, 'subscription', 'TEST seller', '10', 'applied'],
      [data, 'one_time', 'TEST seller', '5', 'applied'],
    ]);
    expect(queue.rows.every((r) => r.reviewDueAt !== null)).toBe(true);
    expect(await commerce.publicListings({ limit: 50 })).toEqual([]);
    expect(await commerce.publicListingsByCategory({ category: 'data', limit: 50 })).toEqual([]);
    expect(await commerce.publicListing(data)).toBeNull();
    await ledger.post(recipes.deposit({ userId: BUYER, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: randomUUID() }));
    await expect(commerce.purchase({ buyerId: BUYER, listingId: data, purchaseId: randomUUID() })).rejects.toMatchObject({
      code: 'market.listing_not_approved',
    });
    expect((await db.sql`SELECT count(*)::int AS n FROM market.purchases`)[0]!.n).toBe(0);
  });

  it('two founders approve: approved, public, gone from the queue, one audit row; the same decision again writes nothing', async () => {
    const data = await listing('data');
    const commerce = service();
    const result = await decide(commerce, data, 'approved');
    expect(result).toMatchObject({
      reviewState: 'approved',
      decision: 'approved',
      actorId: TEST_REVIEW_FOUNDER_A,
      approverId: TEST_REVIEW_FOUNDER_B,
      businessKey: `market:review:${data}:1`,
    });
    expect((await commerce.publicListings({ limit: 50 })).map((r) => [r.id, r.reviewState])).toEqual([[data, 'approved']]);
    expect((await commerce.listingReviewQueue({ actorScope: MARKET_OPS_SCOPE, limit: 50 })).rows).toEqual([]);
    const again = await decide(commerce, data, 'approved');
    expect(again.businessKey).toBe(result.businessKey);
    const audit = await commerce.listingReviewDecisions({ actorScope: MARKET_OPS_SCOPE, limit: 50 });
    expect(audit.map((d) => [d.listingId, d.decision, d.reason, d.actorId, d.approverId])).toEqual([
      [data, 'approved', REASON, TEST_REVIEW_FOUNDER_A, TEST_REVIEW_FOUNDER_B],
    ]);
  });

  it('one founder alone (requester is the approver) is refused, and the listing still waits', async () => {
    const data = await listing('data');
    const commerce = service();
    await expect(
      decide(commerce, data, 'approved', { approvals: reviewApprovals(TEST_REVIEW_FOUNDER_A, TEST_REVIEW_FOUNDER_A) }),
    ).rejects.toMatchObject({ code: 'market.review_approval_mismatch' });
    expect(await commerce.publicListings({ limit: 50 })).toEqual([]);
    expect(await commerce.listingReviewDecisions({ actorScope: MARKET_OPS_SCOPE, limit: 50 })).toEqual([]);
  });

  it('a seller never decides their own listing', async () => {
    const data = await listing('data');
    await expect(decide(service(), data, 'approved', { actorId: SELLER })).rejects.toMatchObject({ code: 'market.review_self_forbidden' });
  });

  it('a rejection carries its reason to the seller, stays off the public list, and a later approve is refused', async () => {
    const strategy = await listing('strategy');
    const commerce = service();
    const reason = 'TEST rejected: the description names no strategy';
    await decide(commerce, strategy, 'rejected', { reason });
    expect(await commerce.myListings(SELLER, { limit: 50 })).toEqual([
      expect.objectContaining({ id: strategy, reviewState: 'rejected', reviewReason: reason }),
    ]);
    expect(await commerce.publicListings({ limit: 50 })).toEqual([]);
    await expect(decide(commerce, strategy, 'approved')).rejects.toMatchObject({ code: 'market.review_not_pending' });
  });

  it('blank criteria or window: the queue says it is waiting and a decision refuses by name, before any approval is spent', async () => {
    const data = await listing('data');
    let consumed = 0;
    const counting = reviewApprovals();
    const spy = { consume: async (input: Parameters<typeof counting.consume>[0]) => (consumed++, counting.consume(input)) };
    const noCriteria = service({ criteria: null, windowSeconds: 86_400 });
    expect(await noCriteria.listingReviewQueue({ actorScope: MARKET_OPS_SCOPE, limit: 50 })).toMatchObject({
      criteria: null,
      queueState: 'waiting',
      queueNote: 'waiting: no listing can be approved until the review criteria are set',
    });
    await expect(decide(noCriteria, data, 'approved', { approvals: spy })).rejects.toMatchObject({ code: 'market.review_criteria_unset' });
    const noWindow = service({ criteria: ['TEST criteria'], windowSeconds: null });
    expect((await noWindow.listingReviewQueue({ actorScope: MARKET_OPS_SCOPE, limit: 50 })).queueState).toBe('waiting');
    await expect(decide(noWindow, data, 'approved', { approvals: spy })).rejects.toMatchObject({ code: 'market.review_window_unset' });
    expect(consumed).toBe(0);
    expect((await noCriteria.listingReviewQueue({ actorScope: MARKET_OPS_SCOPE, limit: 50 })).rows.map((r) => r.id)).toEqual([data]);
  });

  it('the queue and the audit need market:ops and a page size', async () => {
    const commerce = service();
    await expect(commerce.listingReviewQueue({ actorScope: 'market:read', limit: 50 })).rejects.toMatchObject({
      code: 'market.ops_required',
    });
    await expect(commerce.listingReviewQueue({ actorScope: MARKET_OPS_SCOPE })).rejects.toMatchObject({
      code: 'market.review_queue_list_limit_unset',
    });
    await expect(commerce.listingReviewDecisions({ actorScope: MARKET_OPS_SCOPE })).rejects.toMatchObject({
      code: 'market.review_queue_list_limit_unset',
    });
  });

  it('a takedown of an approved listing leaves the public list and writes its reason to the same audit, with both founders', async () => {
    const data = await listing('data');
    const commerce = service();
    await decide(commerce, data, 'approved');
    const reason = 'TEST takedown: withdrawn for this unit test';
    const takedownApprovals = {
      consume: async (input: Parameters<ReturnType<typeof reviewApprovals>['consume']>[0]) => ({
        ...(await reviewApprovals().consume(input)),
        actionType: 'market.takedown',
      }),
    };
    await commerce.takedownListing(
      {
        actorId: TEST_REVIEW_FOUNDER_A,
        actorScope: MARKET_OPS_SCOPE,
        listingId: data,
        reason,
        approvalId: 'takedown-approval',
        operationId: 'takedown-operation',
        clientRequestId: 'takedown-1',
      },
      takedownApprovals as never,
    );
    expect(await commerce.publicListings({ limit: 50 })).toEqual([]);
    expect(await commerce.myListings(SELLER, { limit: 50 })).toEqual([
      expect.objectContaining({ id: data, reviewState: 'taken_down', reviewReason: reason }),
    ]);
    const audit = await commerce.listingReviewDecisions({ actorScope: MARKET_OPS_SCOPE, limit: 50 });
    expect(audit.map((d) => [d.decision, d.reason, d.actorId, d.approverId])).toEqual([
      ['taken_down', reason, TEST_REVIEW_FOUNDER_A, TEST_REVIEW_FOUNDER_B],
      ['approved', REASON, TEST_REVIEW_FOUNDER_A, TEST_REVIEW_FOUNDER_B],
    ]);
  });
});
