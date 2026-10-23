import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { actionApprovalSchema } from '@intafaced/contracts';
import { MemoryLedger, formatAmount, mulBps, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionApprovalConsumeError, type ActionApprovalConsumer } from './action-approval-consume.js';
import { CommerceService, type ListingSort } from './commerce/commerce-service.js';
import { MARKET_OPS_SCOPE, VendorService } from './vendor-service.js';
import type { SlotEntitlementSource, VendorEntitlement } from './stake-source.js';
import { reviewMean, ReviewsService } from './reviews/reviews-service.js';

/**
 * MARKETBE acceptance: operator sales, takedown, catalogue paging, reviews, earnings.
 * PG-hard. TEST_DATABASE_URL when set; otherwise Testcontainers. Docker is not
 * started by this file when TEST_DATABASE_URL points at the shared test server.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const VENDOR_USER = '11111111-1111-4111-8111-111111111111';
const VENDOR_USER_B = '44444444-4444-4444-8444-444444444444';
const BUYER = '22222222-2222-4222-8222-222222222222';
const OTHER = '55555555-5555-4555-8555-555555555555';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-06-01T00:00:00.000Z';

class FixedEntitlement implements SlotEntitlementSource {
  constructor(public vendorSlots = 200) {}
  async entitlementOf(): Promise<VendorEntitlement> {
    return { tierName: 'Operator', vendorSlots: this.vendorSlots };
  }
}

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_h8a_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

function floorCut(price: string, bps: number): string {
  return formatAmount(mulBps(parseAmount(price), bps, 'floor'));
}

describe('market ops depth', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let stakes: FixedEntitlement;
  let vendors: VendorService;
  let ledger: MemoryLedger;
  let commerce: CommerceService;
  let reviews: ReviewsService;

  async function approvedVendor(userId: string, name: string): Promise<string> {
    const vendor = await vendors.applyAsVendor({ userId, displayName: name, description: 'I sell trading bots' });
    await vendors.vet({
      vendorId: vendor.id,
      decision: 'approved',
      reason: 'looks fine',
      actorId: OPERATOR,
      actorScope: MARKET_OPS_SCOPE,
    });
    return vendor.id;
  }

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'market', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE market.reviews, market.listing_takedowns, market.subscription_state, market.purchases,
               market.listings, market.vendor_slots, market.vendor_status_events, market.vendors
      RESTART IDENTITY CASCADE
    `;
    stakes = new FixedEntitlement(200);
    vendors = new VendorService(sql, stakes);
    ledger = new MemoryLedger();
    commerce = new CommerceService(sql, vendors, ledger, { commissionBps: 500 });
    reviews = new ReviewsService(sql);
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('ops.sales', () => {
    it('totals two vendors at two commission snapshots and ignores a later house rate', async () => {
      const vendorA = await approvedVendor(VENDOR_USER, 'Acme');
      const vendorB = await approvedVendor(VENDOR_USER_B, 'Beta');
      const [listingA] = await sql<Array<{ id: string }>>`
        INSERT INTO market.listings (vendor_id, title, description, offer_type, asset_id, price, status)
        VALUES (${vendorA}, 'A', 'alpha listing', 'one_time', 'USDT', 10, 'active')
        RETURNING id
      `;
      const [listingB] = await sql<Array<{ id: string }>>`
        INSERT INTO market.listings (vendor_id, title, description, offer_type, asset_id, price, status)
        VALUES (${vendorB}, 'B', 'beta listing', 'one_time', 'USDT', 3, 'active')
        RETURNING id
      `;
      async function sale(
        listingId: string,
        vendorId: string,
        vendorUser: string,
        price: string,
        bps: number,
        status: 'settled' | 'rejected' | 'pending',
      ) {
        const id = randomUUID();
        await sql`
          INSERT INTO market.purchases (
            id, listing_id, buyer_id, vendor_id, vendor_user_id, asset_id, price, commission_bps,
            status, ledger_tx_id, rejection_code, created_at, settled_at
          ) VALUES (
            ${id}, ${listingId}, ${BUYER}, ${vendorId}, ${vendorUser}, 'USDT', ${price}::numeric, ${bps},
            ${status},
            ${status === 'settled' ? randomUUID() : null},
            ${status === 'rejected' ? 'market.insufficient_funds' : null},
            ${FROM}::timestamptz,
            ${status === 'settled' ? FROM : null}::timestamptz
          )
        `;
      }
      await sale(listingA!.id, vendorA, VENDOR_USER, '10', 500, 'settled');
      await sale(listingA!.id, vendorA, VENDOR_USER, '10', 1000, 'settled');
      await sale(listingA!.id, vendorA, VENDOR_USER, '99', 500, 'rejected');
      await sale(listingA!.id, vendorA, VENDOR_USER, '4', 500, 'pending');
      await sale(listingB!.id, vendorB, VENDOR_USER_B, '3', 250, 'settled');

      const later = new CommerceService(sql, vendors, ledger, { commissionBps: 100 });
      const page = await later.opsSales({
        actorScope: MARKET_OPS_SCOPE,
        from: FROM,
        to: TO,
        limit: 10,
      });
      const rowA = page.rows.find((row) => row.vendorId === vendorA);
      const rowB = page.rows.find((row) => row.vendorId === vendorB);
      expect(rowA).toEqual({
        vendorId: vendorA,
        assetId: 'USDT',
        settledVolume: '20',
        settledCount: '2',
        commission: '1.5',
      });
      expect(rowA?.commission).toBe(floorCut('10', 500).replace('0.5', '1.5'));
      expect(floorCut('10', 500)).toBe('0.5');
      expect(floorCut('10', 1000)).toBe('1');
      expect(rowB).toEqual({
        vendorId: vendorB,
        assetId: 'USDT',
        settledVolume: '3',
        settledCount: '1',
        commission: '0.075',
      });
      expect(rowB?.commission).toBe(floorCut('3', 250));
      expect(page.refusedCount).toBe('1');
      expect(page.pendingCount).toBe('1');
      expect(page.rows.some((row) => row.settledVolume === '99' || row.settledVolume === '4')).toBe(false);

      const first = await later.opsSales({ actorScope: MARKET_OPS_SCOPE, from: FROM, to: TO, limit: 1 });
      const second = await later.opsSales({
        actorScope: MARKET_OPS_SCOPE,
        from: FROM,
        to: TO,
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      const ids = [...first.rows, ...second.rows].map((row) => row.vendorId);
      expect(new Set(ids).size).toBe(2);
      expect(second.nextCursor).toBeNull();
    });

    it('refuses a vendor scope, a buyer scope, a blank window, a wide window, and a blank limit', async () => {
      await expect(commerce.opsSales({ actorScope: 'market:write', from: FROM, to: TO, limit: 10 })).rejects.toMatchObject({
        code: 'market.ops_required',
      });
      await expect(commerce.opsSales({ actorScope: 'market:read', from: FROM, to: TO, limit: 10 })).rejects.toMatchObject({
        code: 'market.ops_required',
      });
      await expect(commerce.opsSales({ actorScope: MARKET_OPS_SCOPE, to: TO, limit: 10 })).rejects.toMatchObject({
        code: 'market.ops_sales_window_unset',
      });
      await expect(
        commerce.opsSales({
          actorScope: MARKET_OPS_SCOPE,
          from: '2020-01-01T00:00:00.000Z',
          to: '2026-01-01T00:00:00.000Z',
          limit: 10,
        }),
      ).rejects.toMatchObject({ code: 'market.ops_sales_window_too_wide' });
      await expect(commerce.opsSales({ actorScope: MARKET_OPS_SCOPE, from: FROM, to: TO })).rejects.toMatchObject({
        code: 'market.ops_sales_list_limit_unset',
      });
    });
  });

  describe('ops.takedownListing', () => {
    function consumer(storedListingId: string, calls: { n: number }, mismatch = false): ActionApprovalConsumer {
      return {
        async consume(input) {
          calls.n += 1;
          if (input.targetId !== storedListingId) {
            throw new ActionApprovalConsumeError('target, version, or operation id does not match', 'action_approval.consume_failed');
          }
          const requester = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
          return actionApprovalSchema.parse({
            approvalId: input.approvalId,
            operationId: input.operationId,
            payloadHash: input.payloadHash,
            targetService: input.targetService,
            targetId: mismatch ? randomUUID() : input.targetId,
            expectedVersion: input.expectedVersion,
            actionType: mismatch ? 'market.vendor.vet' : 'market.takedown',
            requesterId: requester,
            approverId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            policyVersion: 'v1',
            createdAt: '2026-10-17T00:00:00.000Z',
            expiresAt: '2026-10-17T00:10:00.000Z',
            status: 'CONSUMED',
          });
        },
      };
    }

    async function liveSubscription() {
      await approvedVendor(VENDOR_USER, 'Acme');
      await ledger.post(
        recipes.deposit({ userId: BUYER, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test', railRef: 'buyer-td' }),
      );
      const listing = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'Feed',
        description: 'hourly access for buyers',
        offerType: 'subscription',
        assetId: 'USDT',
        price: '10',
        periodSeconds: 3600,
      });
      const bought = await commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() });
      return { listing, bought };
    }

    it('refuses without a matching approval and does not change the listing', async () => {
      const { listing } = await liveSubscription();
      const calls = { n: 0 };
      await expect(
        commerce.takedownListing(
          {
            actorId: OPERATOR,
            actorScope: MARKET_OPS_SCOPE,
            listingId: listing.id,
            reason: 'catalogue rule broken',
            clientRequestId: 'td-missing',
          },
          consumer(listing.id, calls),
        ),
      ).rejects.toBeInstanceOf(ActionApprovalConsumeError);
      expect(calls.n).toBe(0);
      expect((await commerce.getListing(listing.id))?.status).toBe('active');

      const other = randomUUID();
      await expect(
        commerce.takedownListing(
          {
            actorId: OPERATOR,
            actorScope: MARKET_OPS_SCOPE,
            listingId: listing.id,
            reason: 'catalogue rule broken',
            approvalId: 'appr-other',
            operationId: 'op-other',
            clientRequestId: 'td-other',
          },
          consumer(other, calls),
        ),
      ).rejects.toBeInstanceOf(ActionApprovalConsumeError);
      expect((await commerce.getListing(listing.id))?.status).toBe('active');

      await expect(
        commerce.takedownListing(
          {
            actorId: OPERATOR,
            actorScope: MARKET_OPS_SCOPE,
            listingId: listing.id,
            reason: 'catalogue rule broken',
            approvalId: 'appr-bad',
            operationId: 'op-bad',
            clientRequestId: 'td-bad',
          },
          consumer(listing.id, calls, true),
        ),
      ).rejects.toMatchObject({ code: 'market.takedown_approval_mismatch' });
      expect((await commerce.getListing(listing.id))?.status).toBe('active');
    });

    it('takes the listing down, keeps paid access, refuses a new purchase, and replays', async () => {
      const { listing, bought } = await liveSubscription();
      const before = await commerce.subscriptionAccess({ buyerId: BUYER, listingId: listing.id });
      const journal = ledger.journal().length;
      const calls = { n: 0 };
      const first = await commerce.takedownListing(
        {
          actorId: OPERATOR,
          actorScope: MARKET_OPS_SCOPE,
          listingId: listing.id,
          reason: 'catalogue rule broken',
          approvalId: 'appr-1',
          operationId: 'op-1',
          clientRequestId: 'td-1',
        },
        consumer(listing.id, calls),
      );
      expect(first.status).toBe('taken_down');
      expect(calls.n).toBe(1);
      expect(ledger.journal().length).toBe(journal);
      const again = await commerce.takedownListing(
        {
          actorId: OPERATOR,
          actorScope: MARKET_OPS_SCOPE,
          listingId: listing.id,
          reason: 'a different reason that must not apply',
          approvalId: 'appr-2',
          operationId: 'op-2',
          clientRequestId: 'td-1',
        },
        consumer(listing.id, calls),
      );
      expect(again).toEqual(first);
      expect(calls.n).toBe(1);
      expect(ledger.journal().length).toBe(journal);

      await expect(commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() })).rejects.toMatchObject({
        code: 'market.listing_taken_down',
      });
      await expect(commerce.archiveListing({ userId: VENDOR_USER, listingId: listing.id })).rejects.toMatchObject({
        code: 'market.listing_taken_down',
      });
      await expect(sql`UPDATE market.listings SET status = 'active' WHERE id = ${listing.id}`).rejects.toThrow(
        /market\.listing_taken_down/,
      );
      expect((await commerce.getListing(listing.id))?.status).toBe('taken_down');
      const access = await commerce.subscriptionAccess({ buyerId: BUYER, listingId: listing.id });
      expect(access).toEqual(before);
      const [row] = await sql<Array<{ status: string; ledger_tx_id: string; access_until: Date }>>`
        SELECT status, ledger_tx_id, access_until FROM market.purchases WHERE id = ${bought.id}
      `;
      expect(row?.status).toBe('settled');
      expect(row?.ledger_tx_id).toBe(bought.ledgerTxId);
      expect(row?.access_until.toISOString()).toBe(bought.accessUntil);
      expect((await commerce.publicListings({ limit: 50 })).map((item) => item.id)).not.toContain(listing.id);
    });
  });

  describe('listings paging', () => {
    it('pages 120 listings in four sorts with numeric price order and a literal percent', async () => {
      await approvedVendor(VENDOR_USER, 'Acme');
      const ids: string[] = [];
      for (let i = 0; i < 120; i += 1) {
        const listing = await commerce.createListing({
          userId: VENDOR_USER,
          title: i === 7 ? '100% cotton' : `Listing ${String(i).padStart(3, '0')}`,
          description: 'A catalogue row long enough to store',
          offerType: 'one_time',
          assetId: i % 2 === 0 ? 'USDT' : 'BTC',
          price: i === 0 ? '9.99' : i === 1 ? '10.5' : '1',
        });
        ids.push(listing.id);
      }
      const [archived] = await sql<Array<{ id: string }>>`
        INSERT INTO market.listings (vendor_id, title, description, offer_type, asset_id, price, status)
        SELECT id, 'Archived extra', 'not on the shopfront', 'one_time', 'USDT', 4, 'archived'
          FROM market.vendors WHERE user_id = ${VENDOR_USER}
        RETURNING id
      `;
      const [down] = await sql<Array<{ id: string }>>`
        INSERT INTO market.listings (
          vendor_id, title, description, offer_type, asset_id, price, status,
          taken_down_reason, taken_down_actor_id, taken_down_at
        )
        SELECT id, 'Taken down extra', 'not on the shopfront', 'one_time', 'USDT', 4, 'taken_down',
               'operator removed it', ${OPERATOR}, now()
          FROM market.vendors WHERE user_id = ${VENDOR_USER}
        RETURNING id
      `;

      async function collect(sort: ListingSort): Promise<string[]> {
        const found: string[] = [];
        let cursor: string | undefined;
        for (let pageNo = 0; pageNo < 40; pageNo += 1) {
          const page = await commerce.publicListingsPage({ limit: 7, sort, cursor });
          if (page.items.length === 0) break;
          for (const item of page.items) {
            expect(item.vendorListingCount).toBe(120);
            expect(item.status).toBe('active');
          }
          found.push(...page.items.map((item) => item.id));
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        if (!cursor && found.length === 0) return found;
        return found;
      }

      async function sqlOrder(order: string): Promise<string[]> {
        const rows = await sql.unsafe(`SELECT id FROM market.listings WHERE status = 'active' ORDER BY ${order}`);
        return rows.map((row) => String(row.id));
      }

      for (const [sort, order] of [
        ['newest', 'created_at DESC, id DESC'],
        ['priceAsc', 'price ASC, id ASC'],
        ['priceDesc', 'price DESC, id DESC'],
        ['title', 'title ASC, id ASC'],
      ] as const) {
        const found = await collect(sort);
        expect(new Set(found).size).toBe(found.length);
        expect(found).toEqual(await sqlOrder(order));
        expect(found).not.toContain(archived!.id);
        expect(found).not.toContain(down!.id);
      }

      const ascending = await collect('priceAsc');
      const priceOf = new Map<string, string>();
      const prices = await sql<Array<{ id: string; price: string }>>`
        SELECT id, price::text AS price FROM market.listings WHERE status = 'active'
      `;
      for (const row of prices) priceOf.set(row.id, row.price);
      const nine = ascending.find((id) => priceOf.get(id)?.startsWith('9.99'));
      const ten = ascending.find((id) => priceOf.get(id)?.startsWith('10.5'));
      expect(ascending.indexOf(nine!)).toBeLessThan(ascending.indexOf(ten!));
      expect('10.5' < '9.99').toBe(true);

      const literal = await commerce.publicListingsPage({ limit: 50, q: '%', sort: 'title' });
      expect(literal.items.map((item) => item.title)).toEqual(['100% cotton']);
      const usdt = await collect('title');
      const usdtOnly: string[] = [];
      let usdtCursor: string | undefined;
      for (let pageNo = 0; pageNo < 40; pageNo += 1) {
        const page = await commerce.publicListingsPage({ limit: 50, assetId: 'USDT', sort: 'title', cursor: usdtCursor });
        usdtOnly.push(...page.items.map((item) => item.id));
        expect(page.items.every((item) => item.assetId === 'USDT')).toBe(true);
        if (!page.nextCursor || page.items.length === 0) break;
        usdtCursor = page.nextCursor;
      }
      expect(usdtOnly).toHaveLength(60);
      expect(usdt.filter((id) => usdtOnly.includes(id))).toHaveLength(60);

      await expect(commerce.publicListingsPage({})).rejects.toMatchObject({
        code: 'market.public_listings_list_limit_unset',
      });
      await expect(commerce.publicListingsPage({ limit: 50 })).rejects.toMatchObject({
        code: 'market.listings_sort_unset',
      });
      await expect(commerce.publicListingsPage({ limit: 50, sort: ' ' })).rejects.toMatchObject({
        code: 'market.listings_sort_unset',
      });
      await expect(commerce.publicListingsPage({ limit: 50, sort: 'featured' })).rejects.toMatchObject({
        code: 'market.listings_sort_unknown',
      });
      expect(ids).toHaveLength(120);
    }, 180_000);
  });

  describe('reviews', () => {
    it('accepts one settled buyer review, replays it, and averages exactly', async () => {
      await approvedVendor(VENDOR_USER, 'Acme');
      const vendorId = (await vendors.myVendor(VENDOR_USER))!.id;
      await ledger.post(
        recipes.deposit({ userId: BUYER, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test', railRef: 'buyer-rv' }),
      );
      const listing = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'Bot pack',
        description: 'A useful bot',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '10',
      });
      const settled = await commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() });
      const second = await commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() });
      const rejectedId = randomUUID();
      await sql`
        INSERT INTO market.purchases (
          id, listing_id, buyer_id, vendor_id, vendor_user_id, asset_id, price, commission_bps,
          status, rejection_code
        ) VALUES (
          ${rejectedId}, ${listing.id}, ${BUYER}, ${vendorId}, ${VENDOR_USER}, 'USDT', 10, 500,
          'rejected', 'market.insufficient_funds'
        )
      `;

      await expect(reviews.submit({ buyerId: OTHER, purchaseId: settled.id, score: 5, clientRequestId: 'rv-other' })).rejects.toMatchObject(
        { code: 'market.review_not_buyer' },
      );
      await expect(
        reviews.submit({ buyerId: BUYER, purchaseId: rejectedId, score: 5, clientRequestId: 'rv-rejected' }),
      ).rejects.toMatchObject({ code: 'market.review_not_settled' });
      await expect(
        reviews.submit({ buyerId: BUYER, purchaseId: settled.id, score: 5, text: 'line\nbreak', clientRequestId: 'rv-ctrl' }),
      ).rejects.toMatchObject({ code: 'market.review_text_invalid' });

      const first = await reviews.submit({
        buyerId: BUYER,
        purchaseId: settled.id,
        score: 1,
        text: 'Solid',
        clientRequestId: 'rv-1',
      });
      const replay = await reviews.submit({
        buyerId: BUYER,
        purchaseId: settled.id,
        score: 1,
        text: 'Solid',
        clientRequestId: 'rv-1',
      });
      expect(replay).toEqual(first);
      await expect(reviews.submit({ buyerId: BUYER, purchaseId: settled.id, score: 4, clientRequestId: 'rv-2' })).rejects.toMatchObject({
        code: 'market.review_exists',
      });

      const high = await reviews.submit({
        buyerId: BUYER,
        purchaseId: second.id,
        score: 5,
        clientRequestId: 'rv-3',
      });
      const page = await reviews.list({ listingId: listing.id, limit: 10 });
      expect(page.reviews.map((review) => review.id)).toEqual([high.id, first.id]);
      expect(page.reviews.every((review) => !('buyerId' in review) && !('purchaseId' in review))).toBe(true);
      expect(JSON.stringify(page)).not.toContain(BUYER);
      const summary = await reviews.summary(vendorId);
      expect(summary.count).toBe('2');
      expect(summary.mean).toBe('3');
      expect(summary.mean).toBe(reviewMean([1, 5]));
      expect(summary.meanRounding).toBe('half-up-scale-18');

      const emptyVendor = await approvedVendor(VENDOR_USER_B, 'Beta');
      const empty = await reviews.summary(emptyVendor);
      expect(empty.count).toBe('0');
      expect(empty.mean).toBeNull();
      await expect(reviews.list({ listingId: listing.id })).rejects.toMatchObject({
        code: 'market.reviews_list_limit_unset',
      });
    });
  });

  describe('myEarnings', () => {
    it('returns exact gross, commission, and net from two snapshots and only this vendor', async () => {
      await approvedVendor(VENDOR_USER, 'Acme');
      await approvedVendor(VENDOR_USER_B, 'Beta');
      await ledger.post(
        recipes.deposit({ userId: BUYER, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test', railRef: 'buyer-earn-u' }),
      );
      await ledger.post(
        recipes.deposit({ userId: BUYER, assetId: 'BTC', amount: parseAmount('1000'), rail: 'test', railRef: 'buyer-earn-b' }),
      );
      const at500 = commerce;
      const at250 = new CommerceService(sql, vendors, ledger, { commissionBps: 250 });
      const reader = new CommerceService(sql, vendors, ledger, { commissionBps: 100 });
      const usdt = await at500.createListing({
        userId: VENDOR_USER,
        title: 'USDT pack',
        description: 'settled in tether',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '10',
      });
      const usdtLarge = await at500.createListing({
        userId: VENDOR_USER,
        title: 'USDT large',
        description: 'second tether sale',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '20',
      });
      const btc = await at500.createListing({
        userId: VENDOR_USER,
        title: 'BTC pack',
        description: 'settled in bitcoin',
        offerType: 'one_time',
        assetId: 'BTC',
        price: '40',
      });
      const other = await at500.createListing({
        userId: VENDOR_USER_B,
        title: 'Other',
        description: 'another vendor sale',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '7',
      });
      // The second USDT listing was created at price 20. The first stays 10.
      // Rebuild the 10-price listing's purchase against the original row.
      const first = await at500.purchase({ buyerId: BUYER, listingId: usdt.id, purchaseId: randomUUID() });
      const second = await at500.purchase({ buyerId: BUYER, listingId: usdtLarge.id, purchaseId: randomUUID() });
      const third = await at250.purchase({ buyerId: BUYER, listingId: btc.id, purchaseId: randomUUID() });
      const foreign = await at500.purchase({ buyerId: BUYER, listingId: other.id, purchaseId: randomUUID() });

      const report = await reader.myEarnings({ userId: VENDOR_USER, from: '2020-01-01T00:00:00.000Z', to: '2030-01-01T00:00:00.000Z' });
      expect(report.assets).toEqual([
        { assetId: 'BTC', gross: '40', commission: floorCut('40', 250), net: '39' },
        { assetId: 'USDT', gross: '30', commission: '1.5', net: '28.5' },
      ]);
      expect(floorCut('10', 500)).toBe('0.5');
      expect(floorCut('20', 500)).toBe('1');
      expect(floorCut('40', 250)).toBe('1');
      expect(report.sales.map((sale) => sale.ledgerTxId).sort()).toEqual([first.ledgerTxId, second.ledgerTxId, third.ledgerTxId].sort());
      expect(report.sales.map((sale) => sale.purchaseId)).not.toContain(foreign.id);
      expect(report.sales).toHaveLength(3);

      await expect(reader.myEarnings({ userId: OTHER, from: FROM, to: TO })).rejects.toMatchObject({
        code: 'market.earnings_vendor_required',
      });
      await expect(reader.myEarnings({ userId: VENDOR_USER })).rejects.toMatchObject({
        code: 'market.earnings_window_unset',
      });
    });
  });

  describe('setListingCategory', () => {
    const reason = 'catalogue desk filed this under bots';

    it('audits actor and reason with the slug, and replays the business key', async () => {
      await approvedVendor(VENDOR_USER, 'Acme');
      const listing = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'Bot pack',
        description: 'A useful bot',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '10',
      });
      const [before] = await sql<Array<{ category: string | null }>>`
        SELECT category FROM market.listings WHERE id = ${listing.id}
      `;
      expect(before?.category).toBeNull();

      const filed = {
        actorId: OPERATOR,
        actorScope: MARKET_OPS_SCOPE,
        listingId: listing.id,
        category: 'bots',
        reason,
        businessKey: 'cat-bots-1',
      };
      const first = await commerce.setListingCategory(filed);
      expect(first).toMatchObject({
        listingId: listing.id,
        category: 'bots',
        actorId: OPERATOR,
        reason,
        businessKey: 'cat-bots-1',
      });
      const again = await commerce.setListingCategory(filed);
      expect(again).toEqual(first);
      const [count] = await sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM market.listing_category_events
      `;
      expect(count?.n).toBe('1');
      const [after] = await sql<Array<{ category: string | null }>>`
        SELECT category FROM market.listings WHERE id = ${listing.id}
      `;
      expect(after?.category).toBe('bots');

      await expect(commerce.setListingCategory({ ...filed, reason: 'a different reason that is long enough' })).rejects.toMatchObject({
        code: 'market.idempotency_conflict',
      });
      const [still] = await sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM market.listing_category_events
      `;
      expect(still?.n).toBe('1');

      const moved = await commerce.setListingCategory({ ...filed, category: 'data', businessKey: 'cat-data-2' });
      expect(moved.category).toBe('data');
      expect(moved.businessKey).toBe('cat-data-2');
      const [two] = await sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM market.listing_category_events
      `;
      expect(two?.n).toBe('2');
      const [now] = await sql<Array<{ category: string | null }>>`
        SELECT category FROM market.listings WHERE id = ${listing.id}
      `;
      expect(now?.category).toBe('data');
      expect(again.category).toBe('bots');

      await expect(
        sql`UPDATE market.listing_category_events SET reason = 'rewritten reason text' WHERE business_key = 'cat-bots-1'`,
      ).rejects.toThrow(/append-only/);
    });

    it('does not categorise a strategy listing or write an audit', async () => {
      await approvedVendor(VENDOR_USER, 'Acme');
      const listing = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'Mean',
        description: 'A listed strategy',
        offerType: 'subscription',
        assetId: 'USDT',
        price: '12.50',
        periodSeconds: 86_400,
      });
      await expect(
        commerce.setListingCategory({
          actorId: OPERATOR,
          actorScope: MARKET_OPS_SCOPE,
          listingId: listing.id,
          category: 'bots',
          reason,
          businessKey: 'cat-strategy-1',
        }),
      ).rejects.toMatchObject({ code: 'market.category_invalid' });
      const [row] = await sql<Array<{ category: string | null }>>`
        SELECT category FROM market.listings WHERE id = ${listing.id}
      `;
      expect(row?.category).toBeNull();
      const [count] = await sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM market.listing_category_events
      `;
      expect(count?.n).toBe('0');
    });
  });
});
