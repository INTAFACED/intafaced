import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  formatAmount,
  houseFees,
  LedgerError,
  marketPurchaseEscrowAccount,
  MemoryLedger,
  parseAmount,
  POST_IN_FLIGHT_BOUND_SECONDS,
  recipes,
  stampPostAttempts,
  userAvailable,
  type PostRequest,
} from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MARKET_OPS_SCOPE, VendorService } from '../vendor-service.js';
import { ReviewsService } from '../reviews/reviews-service.js';
import { CommerceService } from './commerce-service.js';
import { RECONCILE_AFTER_SECONDS } from './held-purchase.js';

/**
 * A purchase held until its refund window ends (J-more-catalogue-02 #4 to #6), on Postgres and the in-memory ledger.
 *
 * Every balance is read back from the ledger; every refusal is one typed code with the record re-read after it.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL?.trim();
if (!ADMIN_URL) throw new Error('Held purchase tests require an isolated TEST_DATABASE_URL');
const drizzle = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const ups = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const migrations = ups.map((f) => readFileSync(join(drizzle, f), 'utf8'));
const down0012 = readFileSync(join(drizzle, '0012_market_purchase_holds.down.sql'), 'utf8');
const down0013 = readFileSync(join(drizzle, '0013_market_hold_claims.down.sql'), 'utf8');

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '44444444-4444-4444-8444-444444444444';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const WINDOW = 3600;
const START = new Date('2026-10-29T12:00:00.000Z');
const DEPOSIT = '100';

describe('market held purchase', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let vendors: VendorService;
  let clock: Date;
  let held: CommerceService;
  let listingId: string;

  const at = () => clock;
  const service = (refundWindowSeconds: number | null) =>
    new CommerceService(sql, vendors, ledger, { commissionBps: 500, now: at, refundWindowSeconds });
  const balance = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
  const books = async (purchaseId: string) => ({
    buyer: await balance(userAvailable(BUYER, 'USDT')),
    pot: await balance(marketPurchaseEscrowAccount(BUYER, 'USDT', purchaseId)),
    seller: await balance(userAvailable(SELLER, 'USDT')),
    house: await balance(houseFees('market', 'USDT')),
  });
  const holdRow = async (purchaseId: string) => {
    const [row] = await sql<Array<{ state: string; refund_requested_at: Date | null }>>`
      SELECT state, refund_requested_at FROM market.purchase_holds WHERE purchase_id = ${purchaseId}
    `;
    return row ?? null;
  };

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'market', url: ADMIN_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`ALTER TABLE market.purchase_holds DISABLE TRIGGER purchase_holds_no_delete_trg`;
    await sql`DELETE FROM market.purchase_holds`;
    await sql`ALTER TABLE market.purchase_holds ENABLE TRIGGER purchase_holds_no_delete_trg`;
    await sql`
      TRUNCATE market.subscription_state, market.purchases, market.listings, market.vendor_slots,
               market.vendor_status_events, market.vendors
      RESTART IDENTITY CASCADE
    `;
    clock = START;
    ledger = new MemoryLedger();
    vendors = new VendorService(sql, { entitlementOf: async () => ({ tierName: 'fixture', vendorSlots: 3 }) });
    const vendor = await vendors.applyAsVendor({ userId: SELLER, displayName: 'TEST seller', description: 'TEST' });
    await vendors.vet({ vendorId: vendor.id, decision: 'approved', reason: 'TEST', actorId: OPERATOR, actorScope: MARKET_OPS_SCOPE });
    held = service(WINDOW);
    const listing = await held.createListing({
      userId: SELLER,
      title: 'TEST strategy',
      description: 'TEST',
      offerType: 'one_time',
      assetId: 'USDT',
      price: '10',
    });
    listingId = listing.id;
    await ledger.post(
      recipes.deposit({ userId: BUYER, assetId: 'USDT', amount: parseAmount(DEPOSIT), rail: 'test', railRef: 'buyer-seed' }),
    );
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('holds the price in the buyer pot, pays the seller nothing yet, and records the window from the settle', async () => {
    const purchaseId = randomUUID();
    const bought = await held.purchase({ buyerId: BUYER, listingId, purchaseId });
    expect(bought).toMatchObject({ status: 'settled', refundWindowSeconds: WINDOW });
    expect(bought.hold).toMatchObject({
      state: 'held',
      heldAmount: '10',
      heldAt: START.toISOString(),
      windowEndsAt: new Date(START.getTime() + WINDOW * 1000).toISOString(),
      refundRequestedAt: null,
      releaseTxId: null,
      refundTxId: null,
    });
    expect(await books(purchaseId)).toEqual({ buyer: '90', pot: '10', seller: '0', house: '0' });
    const [mine] = await held.purchasesOf(BUYER, { limit: 10 });
    expect(mine).toMatchObject({ id: purchaseId, hold: { state: 'held' } });
    const earnings = await held.myEarnings({ userId: SELLER, from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });
    expect(earnings.sales).toEqual([]);
  });

  it('refunds the whole amount inside the window, once, and the release then has nothing to pay', async () => {
    const purchaseId = randomUUID();
    await held.purchase({ buyerId: BUYER, listingId, purchaseId });
    clock = new Date(START.getTime() + 60_000);
    const refunded = await held.refundPurchase({ buyerId: BUYER, purchaseId });
    expect(refunded.hold).toMatchObject({ state: 'refunded', refundedAt: clock.toISOString(), releaseTxId: null });
    expect(refunded.hold!.refundTxId).toEqual(expect.any(String));
    expect(await books(purchaseId)).toEqual({ buyer: '100', pot: '0', seller: '0', house: '0' });

    const again = await held.refundPurchase({ buyerId: BUYER, purchaseId });
    expect(again.hold).toEqual(refunded.hold);
    expect(await books(purchaseId)).toEqual({ buyer: '100', pot: '0', seller: '0', house: '0' });

    clock = new Date(START.getTime() + (WINDOW + 1) * 1000);
    expect(await held.held.releaseDue()).toBe(0);
    expect(await books(purchaseId)).toEqual({ buyer: '100', pot: '0', seller: '0', house: '0' });
    expect((await holdRow(purchaseId))?.state).toBe('refunded');
  });

  it('refuses a refund once the window has ended, then releases the seller net and the house commission', async () => {
    const purchaseId = randomUUID();
    await held.purchase({ buyerId: BUYER, listingId, purchaseId });
    clock = new Date(START.getTime() + WINDOW * 1000);
    await expect(held.refundPurchase({ buyerId: BUYER, purchaseId })).rejects.toMatchObject({ code: 'market.refund_window_closed' });
    expect(await holdRow(purchaseId)).toEqual({ state: 'held', refund_requested_at: null });
    expect(await books(purchaseId)).toEqual({ buyer: '90', pot: '10', seller: '0', house: '0' });

    expect(await held.held.releaseDue()).toBe(1);
    expect(await books(purchaseId)).toEqual({ buyer: '90', pot: '0', seller: '9.5', house: '0.5' });
    const [mine] = await held.purchasesOf(BUYER, { limit: 10 });
    expect(mine!.hold).toMatchObject({ state: 'released', releasedAt: clock.toISOString() });
    const earnings = await held.myEarnings({ userId: SELLER, from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });
    expect(earnings.sales.map((s) => [s.purchaseId, s.net, s.ledgerTxId])).toEqual([[purchaseId, '9.5', mine!.hold!.releaseTxId]]);

    expect(await held.held.releaseDue()).toBe(0);
    await expect(held.refundPurchase({ buyerId: BUYER, purchaseId })).rejects.toMatchObject({ code: 'market.refund_window_closed' });
    expect(await books(purchaseId)).toEqual({ buyer: '90', pot: '0', seller: '9.5', house: '0.5' });
  });

  it('does not release a hold before its window ends', async () => {
    const purchaseId = randomUUID();
    await held.purchase({ buyerId: BUYER, listingId, purchaseId });
    clock = new Date(START.getTime() + WINDOW * 1000 - 1);
    expect(await held.held.releaseDue()).toBe(0);
    expect(await holdRow(purchaseId)).toEqual({ state: 'held', refund_requested_at: null });
    expect(await books(purchaseId)).toEqual({ buyer: '90', pot: '10', seller: '0', house: '0' });
  });

  it('with the refund policy blank, sells directly and refuses a refund ask with market.refund_policy_unset', async () => {
    const blank = service(null);
    const purchaseId = randomUUID();
    const bought = await blank.purchase({ buyerId: BUYER, listingId, purchaseId });
    expect(bought).toMatchObject({ status: 'settled', refundWindowSeconds: null, hold: null });
    expect(await books(purchaseId)).toEqual({ buyer: '90', pot: '0', seller: '9.5', house: '0.5' });
    await expect(blank.refundPurchase({ buyerId: BUYER, purchaseId })).rejects.toMatchObject({ code: 'market.refund_policy_unset' });
    expect(await holdRow(purchaseId)).toBeNull();
    expect(await books(purchaseId)).toEqual({ buyer: '90', pot: '0', seller: '9.5', house: '0.5' });
  });

  it('refuses a refund on a direct sale once the policy is set, and on another buyer’s purchase', async () => {
    const purchaseId = randomUUID();
    await service(null).purchase({ buyerId: BUYER, listingId, purchaseId });
    await expect(held.refundPurchase({ buyerId: BUYER, purchaseId })).rejects.toMatchObject({ code: 'market.purchase_not_refundable' });
    await expect(held.refundPurchase({ buyerId: STRANGER, purchaseId })).rejects.toMatchObject({ code: 'market.purchase_not_found' });
    await expect(held.refundPurchase({ buyerId: BUYER, purchaseId: randomUUID() })).rejects.toMatchObject({
      code: 'market.purchase_not_found',
    });
    expect(await holdRow(purchaseId)).toBeNull();
    expect(await books(purchaseId)).toEqual({ buyer: '90', pot: '0', seller: '9.5', house: '0.5' });

    const heldId = randomUUID();
    await held.purchase({ buyerId: BUYER, listingId, purchaseId: heldId });
    await expect(held.refundPurchase({ buyerId: STRANGER, purchaseId: heldId })).rejects.toMatchObject({
      code: 'market.purchase_not_found',
    });
    expect(await holdRow(heldId)).toEqual({ state: 'held', refund_requested_at: null });
  });

  it('refuses buying again while a purchase of the listing is held, and allows it after the refund', async () => {
    const first = randomUUID();
    await held.purchase({ buyerId: BUYER, listingId, purchaseId: first });
    const second = randomUUID();
    await expect(held.purchase({ buyerId: BUYER, listingId, purchaseId: second })).rejects.toMatchObject({
      code: 'market.purchase_already_held',
    });
    const rows = await sql<Array<{ id: string; status: string }>>`SELECT id, status FROM market.purchases ORDER BY created_at, id`;
    expect(rows).toEqual([{ id: first, status: 'settled' }]);
    expect(await books(first)).toEqual({ buyer: '90', pot: '10', seller: '0', house: '0' });

    await held.refundPurchase({ buyerId: BUYER, purchaseId: first });
    const bought = await held.purchase({ buyerId: BUYER, listingId, purchaseId: second });
    expect(bought.hold).toMatchObject({ state: 'held', heldAmount: '10' });
    expect(await balance(userAvailable(BUYER, 'USDT'))).toBe('90');
  });

  it('of two buy-again claims racing, exactly one holds', async () => {
    const ids = [randomUUID(), randomUUID()];
    const outcomes = await Promise.allSettled(ids.map((purchaseId) => held.purchase({ buyerId: BUYER, listingId, purchaseId })));
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'market.purchase_already_held' });
    const [holds] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM market.purchase_holds WHERE state = 'held'`;
    expect(holds!.n).toBe('1');
    expect(await balance(userAvailable(BUYER, 'USDT'))).toBe('90');
  });

  it('a claim whose hold posted before a crash still settles on retry while a newer claim is pending', async () => {
    const first = randomUUID();
    // The first claim is cleared and its hold posts; the process stops before the hold row is written.
    const settleHeld = held.held.settleHeld.bind(held.held);
    held.held.settleHeld = async () => {
      throw new Error('crash after the hold posted');
    };
    await expect(held.purchase({ buyerId: BUYER, listingId, purchaseId: first })).rejects.toThrow('crash after the hold posted');
    held.held.settleHeld = settleHeld;
    expect(await books(first)).toEqual({ buyer: '90', pot: '10', seller: '0', house: '0' });
    expect(await holdRow(first)).toBeNull();

    // A newer claim of the same listing is written and not yet checked when the first is retried.
    const second = randomUUID();
    await sql`
      INSERT INTO market.purchases (id, listing_id, buyer_id, vendor_id, vendor_user_id, asset_id, price, commission_bps, status, period_seconds, refund_window_seconds)
      SELECT ${second}, listing_id, buyer_id, vendor_id, vendor_user_id, asset_id, price, commission_bps, 'pending', period_seconds, refund_window_seconds
        FROM market.purchases WHERE id = ${first}
    `;
    const retried = await held.purchase({ buyerId: BUYER, listingId, purchaseId: first });
    expect(retried).toMatchObject({ status: 'settled', hold: { state: 'held', heldAmount: '10' } });
    expect(await holdRow(first)).toEqual({ state: 'held', refund_requested_at: null });
    expect(await books(first)).toEqual({ buyer: '90', pot: '10', seller: '0', house: '0' });

    // The newer claim is the one refused (by the live hold, before its claim is resumed), and nothing of it posts.
    await expect(held.purchase({ buyerId: BUYER, listingId, purchaseId: second })).rejects.toMatchObject({
      code: 'market.purchase_already_held',
    });
    const [row] = await sql<Array<{ status: string; cleared: boolean }>>`
      SELECT p.status, EXISTS (SELECT 1 FROM market.purchase_hold_clearances c WHERE c.purchase_id = p.id) AS cleared
        FROM market.purchases p WHERE p.id = ${second}
    `;
    expect(row).toEqual({ status: 'pending', cleared: false });
    expect(await balance(marketPurchaseEscrowAccount(BUYER, 'USDT', second))).toBe('0');
    expect(await balance(userAvailable(BUYER, 'USDT'))).toBe('90');
  });

  /** The ledger answers this key's posts with `fail` (stamped as one attempt, as the HTTP client does) until restored. */
  const failPosts = (match: (request: PostRequest) => boolean, fail: () => Error) => {
    const post = ledger.post.bind(ledger);
    ledger.post = async (request) => {
      if (!match(request)) return post(request);
      const err = fail();
      stampPostAttempts(err, 1);
      throw err;
    };
    return () => {
      ledger.post = post;
    };
  };
  const purchaseRow = async (id: string) => {
    const [row] = await sql<Array<{ status: string; rejection_code: string | null }>>`
      SELECT status, rejection_code FROM market.purchases WHERE id = ${id}
    `;
    return row ?? null;
  };
  const afterBound = () => new Date(clock.getTime() + (POST_IN_FLIGHT_BOUND_SECONDS + 1) * 1000);

  it('a hold refused for funds releases its claim, so the buyer buys again after a top-up', async () => {
    const poor = randomUUID();
    const restore = failPosts(
      (r) => r.idempotencyKey === `market:hold:${poor}`,
      () => new LedgerError('Insufficient USDT', 'ledger.insufficient_funds'),
    );
    await expect(held.purchase({ buyerId: BUYER, listingId, purchaseId: poor })).rejects.toMatchObject({
      code: 'market.insufficient_funds',
    });
    restore();
    expect(await purchaseRow(poor)).toEqual({ status: 'rejected', rejection_code: 'market.insufficient_funds' });
    expect(await books(poor)).toEqual({ buyer: '100', pot: '0', seller: '0', house: '0' });

    const again = randomUUID();
    const bought = await held.purchase({ buyerId: BUYER, listingId, purchaseId: again });
    expect(bought.hold).toMatchObject({ state: 'held', heldAmount: '10' });
    expect(await books(again)).toEqual({ buyer: '90', pot: '10', seller: '0', house: '0' });
  });

  it('a hold whose outcome is unknown keeps its claim until the sweep finds it never posted, then frees the listing', async () => {
    const lost = randomUUID();
    const restore = failPosts(
      (r) => r.idempotencyKey === `market:hold:${lost}`,
      () => new Error('socket hang up'),
    );
    await expect(held.purchase({ buyerId: BUYER, listingId, purchaseId: lost })).rejects.toThrow('socket hang up');
    restore();
    expect(await purchaseRow(lost)).toEqual({ status: 'pending', rejection_code: null });
    // Inside the in-flight bound the claim still holds the place and the sweep leaves it.
    await expect(held.purchase({ buyerId: BUYER, listingId, purchaseId: randomUUID() })).rejects.toMatchObject({
      code: 'market.purchase_already_held',
    });
    expect(await held.held.sweepStaleClaims()).toBe(0);
    expect(await purchaseRow(lost)).toEqual({ status: 'pending', rejection_code: null });

    clock = afterBound();
    expect(await held.held.sweepStaleClaims()).toBe(1);
    expect(await purchaseRow(lost)).toEqual({ status: 'rejected', rejection_code: 'market.purchase_hold_not_posted' });
    expect(await holdRow(lost)).toBeNull();
    expect(await books(lost)).toEqual({ buyer: '100', pot: '0', seller: '0', house: '0' });

    const again = randomUUID();
    expect((await held.purchase({ buyerId: BUYER, listingId, purchaseId: again })).hold).toMatchObject({ state: 'held' });
    expect(await books(again)).toEqual({ buyer: '90', pot: '10', seller: '0', house: '0' });
  });

  it('the sweep settles a hold that posted before a crash, with no retry from the buyer', async () => {
    const crashed = randomUUID();
    const settleHeld = held.held.settleHeld.bind(held.held);
    held.held.settleHeld = async () => {
      throw new Error('crash after the hold posted');
    };
    await expect(held.purchase({ buyerId: BUYER, listingId, purchaseId: crashed })).rejects.toThrow('crash after the hold posted');
    held.held.settleHeld = settleHeld;
    // The seller archives the listing meanwhile: the sweep still settles what the ledger booked.
    await sql`UPDATE market.listings SET status = 'archived' WHERE id = ${listingId}`;
    clock = afterBound();
    expect(await held.held.sweepStaleClaims()).toBe(1);
    expect(await purchaseRow(crashed)).toEqual({ status: 'settled', rejection_code: null });
    expect(await holdRow(crashed)).toEqual({ state: 'held', refund_requested_at: null });
    expect(await books(crashed)).toEqual({ buyer: '90', pot: '10', seller: '0', house: '0' });
    const refunded = await held.refundPurchase({ buyerId: BUYER, purchaseId: crashed });
    expect(refunded.hold).toMatchObject({ state: 'refunded' });
    expect(await books(crashed)).toEqual({ buyer: '100', pot: '0', seller: '0', house: '0' });
  });

  it('a buyer retry after the hold posted settles before any gate is read again', async () => {
    const crashed = randomUUID();
    const settleHeld = held.held.settleHeld.bind(held.held);
    held.held.settleHeld = async () => {
      throw new Error('crash after the hold posted');
    };
    await expect(held.purchase({ buyerId: BUYER, listingId, purchaseId: crashed })).rejects.toThrow('crash after the hold posted');
    held.held.settleHeld = settleHeld;
    await sql`UPDATE market.listings SET status = 'archived' WHERE id = ${listingId}`;
    const retried = await held.purchase({ buyerId: BUYER, listingId, purchaseId: crashed });
    expect(retried).toMatchObject({ status: 'settled', hold: { state: 'held', heldAmount: '10' } });
    expect(await books(crashed)).toEqual({ buyer: '90', pot: '10', seller: '0', house: '0' });
  });

  it('one hold whose release keeps failing waits its turn and never holds up the others', async () => {
    const stuck = randomUUID();
    await held.purchase({ buyerId: BUYER, listingId, purchaseId: stuck });
    const other = await held.createListing({
      userId: SELLER,
      title: 'TEST other',
      description: 'TEST',
      offerType: 'one_time',
      assetId: 'USDT',
      price: '5',
    });
    // Held a second later, so its window ends after the stuck one's: the oldest-first order alone would try the stuck one.
    clock = new Date(START.getTime() + 1000);
    const fine = randomUUID();
    await held.purchase({ buyerId: BUYER, listingId: other.id, purchaseId: fine });
    clock = new Date(START.getTime() + (WINDOW + 2) * 1000);
    const restore = failPosts(
      (r) => r.idempotencyKey === `market:release:${stuck}`,
      () => new Error('ledger unavailable'),
    );
    expect(await held.held.releaseDue(1)).toBe(0);
    expect(await held.held.releaseDue(1)).toBe(1);
    expect((await holdRow(fine))?.state).toBe('released');
    expect((await holdRow(stuck))?.state).toBe('held');
    restore();
    clock = new Date(clock.getTime() + 61_000);
    expect(await held.held.releaseDue()).toBe(1);
    expect((await holdRow(stuck))?.state).toBe('released');
  });

  it('a new period after a refunded subscription starts at its own settle, not at the refunded end', async () => {
    const PERIOD = 2_592_000;
    const sub = await held.createListing({
      userId: SELLER,
      title: 'TEST feed',
      description: 'TEST',
      offerType: 'subscription',
      assetId: 'USDT',
      price: '10',
      periodSeconds: PERIOD,
    });
    const first = randomUUID();
    const a = await held.purchase({ buyerId: BUYER, listingId: sub.id, purchaseId: first });
    expect(a.accessUntil).toBe(new Date(START.getTime() + PERIOD * 1000).toISOString());
    await held.refundPurchase({ buyerId: BUYER, purchaseId: first });
    clock = new Date(START.getTime() + 60_000);
    const b = await held.purchase({ buyerId: BUYER, listingId: sub.id, purchaseId: randomUUID() });
    expect(b.accessUntil).toBe(new Date(clock.getTime() + PERIOD * 1000).toISOString());
  });

  it('a held or refunded purchase is no verified buy for a review; a released one is', async () => {
    const reviews = new ReviewsService(sql);
    const review = (purchaseId: string) => reviews.submit({ buyerId: BUYER, purchaseId, score: 5, clientRequestId: randomUUID() });
    const refunded = randomUUID();
    await held.purchase({ buyerId: BUYER, listingId, purchaseId: refunded });
    await expect(review(refunded)).rejects.toMatchObject({ code: 'market.review_not_settled' });
    await held.refundPurchase({ buyerId: BUYER, purchaseId: refunded });
    await expect(review(refunded)).rejects.toMatchObject({ code: 'market.review_not_settled' });
    const [none] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM market.reviews WHERE purchase_id = ${refunded}`;
    expect(none!.n).toBe('0');

    const released = randomUUID();
    await held.purchase({ buyerId: BUYER, listingId, purchaseId: released });
    clock = new Date(START.getTime() + (WINDOW + 1) * 1000);
    expect(await held.held.releaseDue()).toBe(1);
    expect(await review(released)).toMatchObject({ purchaseId: released, score: 5 });
  });

  it('a released sale counts in the seller’s earnings on the day it was released', async () => {
    const purchaseId = randomUUID();
    await held.purchase({ buyerId: BUYER, listingId, purchaseId });
    const releasedAt = new Date(START.getTime() + (WINDOW + 1) * 1000);
    clock = releasedAt;
    expect(await held.held.releaseDue()).toBe(1);
    const heldHour = await held.myEarnings({
      userId: SELLER,
      from: START.toISOString(),
      to: new Date(START.getTime() + WINDOW * 1000).toISOString(),
    });
    expect(heldHour.sales).toEqual([]);
    const releaseHour = await held.myEarnings({
      userId: SELLER,
      from: new Date(START.getTime() + WINDOW * 1000).toISOString(),
      to: new Date(releasedAt.getTime() + 60_000).toISOString(),
    });
    expect(releaseHour.sales).toEqual([expect.objectContaining({ purchaseId, gross: '10', settledAt: releasedAt.toISOString() })]);
  });

  it('an ask written before a crash wins over the release once the window ends', async () => {
    const purchaseId = randomUUID();
    await held.purchase({ buyerId: BUYER, listingId, purchaseId });
    // The ask committed; the process stopped before the refund posted.
    await sql`UPDATE market.purchase_holds SET refund_requested_at = ${new Date(START.getTime() + 1000).toISOString()}::timestamptz WHERE purchase_id = ${purchaseId}`;
    clock = new Date(START.getTime() + (WINDOW + 10) * 1000);
    expect(await held.held.releaseDue()).toBe(1);
    expect((await holdRow(purchaseId))?.state).toBe('refunded');
    expect(await books(purchaseId)).toEqual({ buyer: '100', pot: '0', seller: '0', house: '0' });
    // The buyer's retry after the window returns the refund it asked for; nothing posts twice.
    const retry = await held.refundPurchase({ buyerId: BUYER, purchaseId });
    expect(retry.hold!.state).toBe('refunded');
    expect(await books(purchaseId)).toEqual({ buyer: '100', pot: '0', seller: '0', house: '0' });
  });

  it('keeps every unit across holds, refunds and releases (invariant)', async () => {
    const total = async (ids: string[]) => {
      const pots = await Promise.all(ids.map((id) => ledger.balance(marketPurchaseEscrowAccount(BUYER, 'USDT', id))));
      const rest = await Promise.all([
        ledger.balance(userAvailable(BUYER, 'USDT')),
        ledger.balance(userAvailable(SELLER, 'USDT')),
        ledger.balance(houseFees('market', 'USDT')),
      ]);
      return formatAmount([...pots, ...rest].reduce((sum, b) => sum + b.amount, 0n));
    };
    const second = await held.createListing({
      userId: SELLER,
      title: 'TEST second',
      description: 'TEST',
      offerType: 'one_time',
      assetId: 'USDT',
      price: '7.25',
    });
    const ids: string[] = [];
    const buy = async (listing: string) => {
      const id = randomUUID();
      ids.push(id);
      await held.purchase({ buyerId: BUYER, listingId: listing, purchaseId: id });
      expect(await total(ids)).toBe(DEPOSIT);
      return id;
    };
    const a = await buy(listingId);
    await buy(second.id);
    await held.refundPurchase({ buyerId: BUYER, purchaseId: a });
    expect(await total(ids)).toBe(DEPOSIT);
    await buy(listingId);
    clock = new Date(START.getTime() + (WINDOW + 1) * 1000);
    expect(await held.held.releaseDue()).toBe(2);
    expect(await total(ids)).toBe(DEPOSIT);
    expect(await balance(userAvailable(BUYER, 'USDT'))).toBe('82.75');
    expect(await balance(userAvailable(SELLER, 'USDT'))).toBe('16.3875');
    expect(await balance(houseFees('market', 'USDT'))).toBe('0.8625');
    for (const id of ids) expect(await balance(marketPurchaseEscrowAccount(BUYER, 'USDT', id))).toBe('0');
  });

  it('locks the claim snapshot and the hold record', async () => {
    const purchaseId = randomUUID();
    await held.purchase({ buyerId: BUYER, listingId, purchaseId });
    await expect(sql`UPDATE market.purchases SET refund_window_seconds = 60 WHERE id = ${purchaseId}`).rejects.toMatchObject({
      code: '23514',
    });
    await expect(sql`UPDATE market.purchase_holds SET held_amount = 1 WHERE purchase_id = ${purchaseId}`).rejects.toMatchObject({
      code: '23514',
    });
    await expect(sql`DELETE FROM market.purchase_holds WHERE purchase_id = ${purchaseId}`).rejects.toMatchObject({ code: '23514' });
    await sql`UPDATE market.purchase_holds SET refund_requested_at = now() WHERE purchase_id = ${purchaseId}`;
    await expect(
      sql`UPDATE market.purchase_holds SET state = 'released', release_tx_id = ${randomUUID()}, released_at = now(), refund_requested_at = NULL WHERE purchase_id = ${purchaseId}`,
    ).rejects.toMatchObject({ code: '23514' });
    await held.held.releaseDue();
    expect((await holdRow(purchaseId))?.state).toBe('refunded');
    await expect(sql`UPDATE market.purchase_holds SET refunded_at = now() WHERE purchase_id = ${purchaseId}`).rejects.toMatchObject({
      code: '23514',
    });
  });

  const ledgerHold = (id: string) => ledger.getTxByKey(`market:hold:${id}`);
  const clearanceRow = async (id: string) => {
    const [row] = await sql<Array<{ attempt_no: number; reconciled: boolean; refunded: boolean }>>`
      SELECT attempt_no, reconciled_at IS NOT NULL AS reconciled, reconcile_refund_tx_id IS NOT NULL AS refunded
        FROM market.purchase_hold_clearances WHERE purchase_id = ${id}
    `;
    return row ?? null;
  };
  const afterReconcile = () => new Date(START.getTime() + (RECONCILE_AFTER_SECONDS + 1) * 1000);

  it('a claim the sweep released while its gates were slow never posts its hold', async () => {
    const slow = randomUUID();
    // The claim clears, then its gates take longer than the in-flight bound; the sweep runs meanwhile.
    const clearHold = held.held.clearHold.bind(held.held);
    held.held.clearHold = async (input) => {
      const clearance = await clearHold(input);
      clock = afterBound();
      expect(await held.held.sweepStaleClaims()).toBe(1);
      return clearance;
    };
    await expect(held.purchase({ buyerId: BUYER, listingId, purchaseId: slow })).rejects.toMatchObject({
      code: 'market.purchase_conflict',
    });
    held.held.clearHold = clearHold;
    expect(await purchaseRow(slow)).toEqual({ status: 'rejected', rejection_code: 'market.purchase_hold_not_posted' });
    expect(await ledgerHold(slow)).toBeNull();
    expect(await clearanceRow(slow)).toEqual({ attempt_no: 0, reconciled: false, refunded: false });
    expect(await books(slow)).toEqual({ buyer: '100', pot: '0', seller: '0', house: '0' });
  });

  it('of two requests for one purchase id, the one provably refused never rejects the one that books', async () => {
    const id = randomUUID();
    // Request A begins post 1; request B begins post 2 and books; only then is A's post refused for funds.
    const beginHoldPost = held.held.beginHoldPost.bind(held.held);
    let begun = 0;
    let aBegun!: () => void;
    const first = new Promise<void>((resolve) => {
      aBegun = resolve;
    });
    let bothBegun!: () => void;
    const both = new Promise<void>((resolve) => {
      bothBegun = resolve;
    });
    held.held.beginHoldPost = async (input) => {
      const attempt = await beginHoldPost(input);
      begun += 1;
      if (begun === 1) aBegun();
      if (begun === 2) bothBegun();
      return attempt;
    };
    const post = ledger.post.bind(ledger);
    let calls = 0;
    let bBooked!: () => void;
    const booked = new Promise<void>((resolve) => {
      bBooked = resolve;
    });
    ledger.post = async (request) => {
      if (request.idempotencyKey !== `market:hold:${id}`) return post(request);
      calls += 1;
      if (calls === 1) {
        await both;
        await booked;
        const err = new LedgerError('Insufficient USDT', 'ledger.insufficient_funds');
        stampPostAttempts(err, 1);
        throw err;
      }
      const tx = await post(request);
      bBooked();
      return tx;
    };
    const [a, b] = await Promise.allSettled([
      held.purchase({ buyerId: BUYER, listingId, purchaseId: id }),
      first.then(() => held.purchase({ buyerId: BUYER, listingId, purchaseId: id })),
    ]);
    ledger.post = post;
    held.held.beginHoldPost = beginHoldPost;
    expect(a).toMatchObject({ status: 'rejected', reason: { code: 'market.insufficient_funds' } });
    expect(b).toMatchObject({ status: 'fulfilled', value: { status: 'settled', hold: { state: 'held', heldAmount: '10' } } });
    expect(await purchaseRow(id)).toEqual({ status: 'settled', rejection_code: null });
    expect(await holdRow(id)).toEqual({ state: 'held', refund_requested_at: null });
    expect(await clearanceRow(id)).toEqual({ attempt_no: 2, reconciled: false, refunded: false });
    expect(await books(id)).toEqual({ buyer: '90', pot: '10', seller: '0', house: '0' });
  });

  it('a hold that books after the sweep released its claim is refunded to the buyer whole, once', async () => {
    const late = randomUUID();
    const restore = failPosts(
      (r) => r.idempotencyKey === `market:hold:${late}`,
      () => new Error('socket hang up'),
    );
    await expect(held.purchase({ buyerId: BUYER, listingId, purchaseId: late })).rejects.toThrow('socket hang up');
    restore();
    clock = afterBound();
    expect(await held.held.sweepStaleClaims()).toBe(1);
    expect(await purchaseRow(late)).toEqual({ status: 'rejected', rejection_code: 'market.purchase_hold_not_posted' });

    // The lost post lands after all: the buyer's money sits in the rejected claim's pot.
    const [claim] = await sql<Array<{ asset_id: string; price: string }>>`
      SELECT asset_id, price::text AS price FROM market.purchases WHERE id = ${late}
    `;
    await ledger.post(
      held.held.holdRequest({ id: late, listingId, buyerId: BUYER, assetId: claim!.asset_id, price: parseAmount(claim!.price) }),
    );
    expect(await books(late)).toEqual({ buyer: '90', pot: '10', seller: '0', house: '0' });

    // Not before twice the bound since its post began; then the pot goes back whole and the claim stays rejected.
    expect(await held.held.reconcileRejectedClaims()).toBe(0);
    clock = afterReconcile();
    expect(await held.held.reconcileRejectedClaims()).toBe(1);
    expect(await books(late)).toEqual({ buyer: '100', pot: '0', seller: '0', house: '0' });
    expect((await ledger.getTxByKey(`market:refund:${late}:1`))?.id).toBeDefined();
    expect(await clearanceRow(late)).toEqual({ attempt_no: 1, reconciled: true, refunded: true });
    expect(await purchaseRow(late)).toEqual({ status: 'rejected', rejection_code: 'market.purchase_hold_not_posted' });
    expect(await holdRow(late)).toBeNull();
    expect(await held.held.reconcileRejectedClaims()).toBe(0);
    expect(await books(late)).toEqual({ buyer: '100', pot: '0', seller: '0', house: '0' });
    await expect(
      sql`UPDATE market.purchase_hold_clearances SET reconcile_refund_tx_id = NULL WHERE purchase_id = ${late}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a refused claim with no hold on the book is reconciled with nothing moved', async () => {
    const poor = randomUUID();
    const restore = failPosts(
      (r) => r.idempotencyKey === `market:hold:${poor}`,
      () => new LedgerError('Insufficient USDT', 'ledger.insufficient_funds'),
    );
    await expect(held.purchase({ buyerId: BUYER, listingId, purchaseId: poor })).rejects.toMatchObject({
      code: 'market.insufficient_funds',
    });
    restore();
    clock = afterReconcile();
    expect(await held.held.reconcileRejectedClaims()).toBe(1);
    expect(await clearanceRow(poor)).toEqual({ attempt_no: 1, reconciled: true, refunded: false });
    expect(await ledger.getTxByKey(`market:refund:${poor}:1`)).toBeNull();
    expect(await books(poor)).toEqual({ buyer: '100', pot: '0', seller: '0', house: '0' });
  });

  it('with the refund window off, a direct purchase does not stack on a purchase still held', async () => {
    const kept = randomUUID();
    await held.purchase({ buyerId: BUYER, listingId, purchaseId: kept });
    const direct = randomUUID();
    await expect(service(null).purchase({ buyerId: BUYER, listingId, purchaseId: direct })).rejects.toMatchObject({
      code: 'market.purchase_already_held',
    });
    expect(await purchaseRow(direct)).toBeNull();
    expect(await books(kept)).toEqual({ buyer: '90', pot: '10', seller: '0', house: '0' });
  });

  it('refuses the 0012 reversal while any purchase was claimed with a refund window', async () => {
    await held.purchase({ buyerId: BUYER, listingId, purchaseId: randomUUID() });
    await expect(sql.begin((tx) => tx.unsafe(down0012))).rejects.toMatchObject({ code: '23514' });
    const [table] = await sql<Array<{ t: string | null }>>`SELECT to_regclass('market.purchase_holds')::text AS t`;
    expect(table!.t).toBe('purchase_holds');
  });

  it('keeps a clearance for good, and refuses the 0013 reversal while a cleared claim is pending', async () => {
    const lost = randomUUID();
    const restore = failPosts(
      (r) => r.idempotencyKey === `market:hold:${lost}`,
      () => new Error('socket hang up'),
    );
    await expect(held.purchase({ buyerId: BUYER, listingId, purchaseId: lost })).rejects.toThrow('socket hang up');
    restore();
    await expect(sql`DELETE FROM market.purchase_hold_clearances WHERE purchase_id = ${lost}`).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`UPDATE market.purchase_hold_clearances SET last_post_at = last_post_at - interval '1 hour' WHERE purchase_id = ${lost}`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(sql`UPDATE market.purchase_hold_clearances SET attempt_no = 0 WHERE purchase_id = ${lost}`).rejects.toMatchObject({
      code: '23514',
    });
    await expect(sql.begin((tx) => tx.unsafe(down0013))).rejects.toMatchObject({ code: '23514' });
    // Rejected by the sweep, it is still unreconciled: the reversal stays refused until the reconcile has run.
    clock = afterBound();
    expect(await held.held.sweepStaleClaims()).toBe(1);
    await expect(sql.begin((tx) => tx.unsafe(down0013))).rejects.toMatchObject({ code: '23514' });
    const [table] = await sql<Array<{ t: string | null }>>`SELECT to_regclass('market.purchase_hold_clearances')::text AS t`;
    expect(table!.t).toBe('purchase_hold_clearances');
  });
});
