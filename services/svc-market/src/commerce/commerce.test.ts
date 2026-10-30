import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount as amt, houseFees, userAvailable, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MARKET_OPS_SCOPE, VendorService } from '../vendor-service.js';
import type { SlotEntitlementSource, VendorEntitlement } from '../stake-source.js';
import { CommerceService } from './commerce-service.js';

/**
 * market.commerce — listings + one-time purchase + house commission.
 *
 * Proves: blank commission refuses; eligibility from vendors (no is_listed);
 * purchase posts marketPurchase once; suspended/unstaked refuse; money strings.
 * Recurring sub still refuse — no invented period / no subscription happy path.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `market.*` SQL stays on `market`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const VENDOR_USER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '33333333-3333-4333-8333-333333333333';

const H8A_IMAGE = 'postgres:16-alpine';

class FixedEntitlement implements SlotEntitlementSource {
  constructor(public vendorSlots = 3) {}
  async entitlementOf(): Promise<VendorEntitlement> {
    return { tierName: 'Operator', vendorSlots: this.vendorSlots };
  }
}

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: market commerce is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('market.commerce PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('market.commerce', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let stakes: FixedEntitlement;
  let vendors: VendorService;
  let ledger: MemoryLedger;
  let commerce: CommerceService;

  async function approvedVendor(userId: string): Promise<string> {
    const v = await vendors.applyAsVendor({
      userId,
      displayName: 'Acme Bots',
      description: 'I sell trading bots',
    });
    await vendors.vet({
      vendorId: v.id,
      decision: 'approved',
      reason: 'looks fine',
      actorId: OPERATOR,
      actorScope: MARKET_OPS_SCOPE,
    });
    return v.id;
  }

  /**
   * A leftover `offer_type=subscription` row — the shape createListing used
   * to write before this refuse. Schema still stores it (C3 later); the API
   * must not. Tests that prove leftover honesty go through this, not create.
   */
  async function insertLegacySubscription(vendorId: string): Promise<{ id: string }> {
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO market.listings (vendor_id, title, description, offer_type, asset_id, price, status)
      VALUES (
        ${vendorId},
        'Legacy sub',
        'pre-refuse leftover',
        'subscription',
        'USDT',
        '10',
        'active'
      )
      RETURNING id
    `;
    if (!row) throw new Error('legacy subscription insert returned no row');
    await vendors.claimSlot({ userId: VENDOR_USER, ref: row.id });
    return row;
  }

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'market', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE market.subscription_state, market.purchases, market.listings, market.vendor_slots,
               market.vendor_status_events, market.vendors
      RESTART IDENTITY CASCADE
    `;
    stakes = new FixedEntitlement(3);
    vendors = new VendorService(sql, stakes);
    ledger = new MemoryLedger();
    commerce = new CommerceService(sql, vendors, ledger, { commissionBps: 500 });
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('refuse-closed commission', () => {
    it('refuses purchase when commission bps is not configured', async () => {
      await approvedVendor(VENDOR_USER);
      const blank = new CommerceService(sql, vendors, ledger, { commissionBps: null });
      // Need a listing first under a configured service, then purchase under blank.
      const listing = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'Bot pack',
        description: 'A useful bot',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '10',
      });
      await expect(blank.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() })).rejects.toMatchObject({
        code: 'market.commission_not_configured',
      });
      // Nothing moved.
      expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('0');
    });

    it('refuses createListing when commission bps is not configured (no slot burn)', async () => {
      await approvedVendor(VENDOR_USER);
      const blank = new CommerceService(sql, vendors, ledger, { commissionBps: null });
      await expect(
        blank.createListing({
          userId: VENDOR_USER,
          title: 'Orphan bait',
          description: 'Must not claim a slot',
          offerType: 'one_time',
          assetId: 'USDT',
          price: '10',
        }),
      ).rejects.toMatchObject({ code: 'market.commission_not_configured' });

      const status = await vendors.slotStatus(VENDOR_USER);
      expect(status.held).toBe(0);
      const [count] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM market.listings WHERE vendor_id = (
          SELECT id FROM market.vendors WHERE user_id = ${VENDOR_USER}
        )
      `;
      expect(count?.n).toBe('0');
    });

    it('public catalogue is empty when commission is blank (no unsellable shopfront)', async () => {
      await approvedVendor(VENDOR_USER);
      const listing = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'Hidden while blank',
        description: 'Configured create, blank catalogue',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '10',
      });
      expect((await commerce.publicListings({ limit: 50 })).some((l) => l.id === listing.id)).toBe(true);

      const blank = new CommerceService(sql, vendors, ledger, { commissionBps: null });
      await expect(blank.publicListings({ limit: 50 })).resolves.toEqual([]);
    });

    it('programme reports unconfigured when null', () => {
      const blank = new CommerceService(sql, vendors, ledger, { commissionBps: null });
      expect(blank.programme()).toEqual({
        commissionBps: null,
        commissionConfigured: false,
        purchaseHold: false,
        refundWindowSeconds: null,
        refundPolicy: null,
      });
    });
  });

  describe('listings', () => {
    it('refuses create when vendor is not eligible', async () => {
      await vendors.applyAsVendor({
        userId: VENDOR_USER,
        displayName: 'Acme',
        description: 'pending',
      });
      await expect(
        commerce.createListing({
          userId: VENDOR_USER,
          title: 'Bot',
          description: 'desc',
          offerType: 'one_time',
          assetId: 'USDT',
          price: '5',
        }),
      ).rejects.toMatchObject({ code: 'market.vendor_not_approved' });
    });

    it('creates a listing and claims a slot named by listing id', async () => {
      await approvedVendor(VENDOR_USER);
      const listing = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'Bot pack',
        description: 'A useful bot',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '25.50',
      });
      expect(listing.status).toBe('active');
      expect(listing.price).toMatch(/^25\.5/);
      const slots = await vendors.slotStatus(VENDOR_USER);
      expect(slots.held).toBe(1);
      expect(slots.slots[0]?.ref).toBe(listing.id);
    });

    it('drops a listing from the public catalogue when the vendor unstakes', async () => {
      await approvedVendor(VENDOR_USER);
      await commerce.createListing({
        userId: VENDOR_USER,
        title: 'Bot pack',
        description: 'A useful bot',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '10',
      });
      expect((await commerce.publicListings({ limit: 50 })).length).toBe(1);
      stakes.vendorSlots = 0;
      expect((await commerce.publicListings({ limit: 50 })).length).toBe(0);
    });
  });

  describe('purchase — Class M money path', () => {
    async function liveListing() {
      await approvedVendor(VENDOR_USER);
      return commerce.createListing({
        userId: VENDOR_USER,
        title: 'Bot pack',
        description: 'A useful bot',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '100',
      });
    }

    it('settles buyer → vendor net + house commission once', async () => {
      const listing = await liveListing();
      await ledger.post(
        recipes.deposit({
          userId: BUYER,
          assetId: 'USDT',
          amount: amt('1000'),
          rail: 'test',
          railRef: 'buyer-seed',
        }),
      );

      const purchaseId = randomUUID();
      const first = await commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId });
      expect(first.status).toBe('settled');
      expect(first.commissionBps).toBe(500);
      expect(first.ledgerTxId).toBeTruthy();

      const second = await commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId });
      expect(second.id).toBe(first.id);
      expect(second.ledgerTxId).toBe(first.ledgerTxId);

      expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('900');
      expect(formatAmount((await ledger.balance(userAvailable(VENDOR_USER, 'USDT'))).amount)).toBe('95');
      expect(formatAmount((await ledger.balance(houseFees('market', 'USDT'))).amount)).toBe('5');
    });

    it('refuses when the vendor is no longer listed (stake dropped)', async () => {
      const listing = await liveListing();
      await ledger.post(
        recipes.deposit({
          userId: BUYER,
          assetId: 'USDT',
          amount: amt('1000'),
          rail: 'test',
          railRef: 'buyer-seed-2',
        }),
      );
      stakes.vendorSlots = 0;
      await expect(commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() })).rejects.toMatchObject({
        code: 'market.stake_required',
      });
    });

    it('refuses self-purchase', async () => {
      const listing = await liveListing();
      await expect(commerce.purchase({ buyerId: VENDOR_USER, listingId: listing.id, purchaseId: randomUUID() })).rejects.toMatchObject({
        code: 'market.purchase_self',
      });
    });

    it('refuses createListing for a subscription when period is unset (no default month)', async () => {
      const vendorId = await approvedVendor(VENDOR_USER);
      await expect(
        commerce.createListing({
          userId: VENDOR_USER,
          title: 'Sub',
          description: 'monthly',
          offerType: 'subscription',
          assetId: 'USDT',
          price: '10',
        }),
      ).rejects.toMatchObject({ code: 'market.subscription_period_unset' });

      expect((await vendors.slotStatus(VENDOR_USER)).held).toBe(0);
      const [count] = await sql<Array<{ n: string }>>`
        SELECT COUNT(*)::text AS n FROM market.listings WHERE vendor_id = ${vendorId}
      `;
      expect(count?.n).toBe('0');
    });

    it('refuses purchase of a leftover subscription row with no period', async () => {
      const vendorId = await approvedVendor(VENDOR_USER);
      const leftover = await insertLegacySubscription(vendorId);
      await expect(commerce.purchase({ buyerId: BUYER, listingId: leftover.id, purchaseId: randomUUID() })).rejects.toMatchObject({
        code: 'market.subscription_period_unset',
      });
    });

    it('refuses a conflicting reuse of the same purchaseId', async () => {
      const listing = await liveListing();
      await ledger.post(
        recipes.deposit({
          userId: BUYER,
          assetId: 'USDT',
          amount: amt('1000'),
          rail: 'test',
          railRef: 'buyer-seed-3',
        }),
      );
      const purchaseId = randomUUID();
      await commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId });

      const other = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'Other',
        description: 'other bot',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '50',
      });
      await expect(commerce.purchase({ buyerId: BUYER, listingId: other.id, purchaseId })).rejects.toMatchObject({
        code: 'market.purchase_conflict',
      });
    });

    it('refuses purchase when the buyer has insufficient funds', async () => {
      const listing = await liveListing();
      // No deposit — buyer balance is zero.
      await expect(commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() })).rejects.toMatchObject({
        code: 'market.insufficient_funds',
      });
      const [row] = await sql<Array<{ status: string; rejection_code: string | null }>>`
        SELECT status, rejection_code FROM market.purchases WHERE buyer_id = ${BUYER}
      `;
      expect(row?.status).toBe('pending');
      expect(row?.rejection_code).toBeNull();
    });

    it('refuses purchase when the vendor is suspended', async () => {
      const listing = await liveListing();
      await ledger.post(
        recipes.deposit({
          userId: BUYER,
          assetId: 'USDT',
          amount: amt('1000'),
          rail: 'test',
          railRef: 'buyer-seed-susp',
        }),
      );
      const mine = await vendors.myVendor(VENDOR_USER);
      await vendors.vet({
        vendorId: mine!.id,
        decision: 'suspended',
        reason: 'policy',
        actorId: OPERATOR,
        actorScope: MARKET_OPS_SCOPE,
      });
      await expect(commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() })).rejects.toMatchObject({
        code: 'market.vendor_not_approved',
      });
    });

    it('refuses purchase when the listing has no live slot (crash orphan)', async () => {
      await approvedVendor(VENDOR_USER);
      // Simulate insert-without-claim: active listing, no slot row for its id.
      const [orphan] = await sql<Array<{ id: string }>>`
        INSERT INTO market.listings (vendor_id, title, description, offer_type, asset_id, price, status)
        SELECT id, 'Orphan', 'no slot', 'one_time', 'USDT', 10::numeric, 'active'
          FROM market.vendors WHERE user_id = ${VENDOR_USER}
        RETURNING id
      `;
      // Give the vendor ANOTHER live slot so vendor-level listed is true.
      await vendors.claimSlot({ userId: VENDOR_USER, ref: 'unrelated-ref' });
      await ledger.post(
        recipes.deposit({
          userId: BUYER,
          assetId: 'USDT',
          amount: amt('1000'),
          rail: 'test',
          railRef: 'buyer-seed-orphan',
        }),
      );
      await expect(commerce.purchase({ buyerId: BUYER, listingId: orphan!.id, purchaseId: randomUUID() })).rejects.toMatchObject({
        code: 'market.listing_slot_missing',
      });
      expect((await commerce.publicListings({ limit: 50 })).map((l) => l.id)).not.toContain(orphan!.id);
    });

    it('resumes a crash after ledger post before settle (same purchaseId)', async () => {
      const listing = await liveListing();
      await ledger.post(
        recipes.deposit({
          userId: BUYER,
          assetId: 'USDT',
          amount: amt('1000'),
          rail: 'test',
          railRef: 'buyer-seed-crash',
        }),
      );
      const purchaseId = randomUUID();
      // Simulate: claim row pending + ledger already posted, settle never ran.
      await sql`
        INSERT INTO market.purchases (
          id, listing_id, buyer_id, vendor_id, vendor_user_id,
          asset_id, price, commission_bps, status
        )
        SELECT ${purchaseId}, ${listing.id}, ${BUYER}, id, ${VENDOR_USER},
               'USDT', '100'::numeric, 500, 'pending'
          FROM market.vendors WHERE user_id = ${VENDOR_USER}
      `;
      await ledger.post(
        recipes.marketPurchase({
          purchaseId,
          listingId: listing.id,
          buyerId: BUYER,
          vendorUserId: VENDOR_USER,
          assetId: 'USDT',
          price: amt('100'),
          commissionBps: 500,
        }),
      );

      const resumed = await commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId });
      expect(resumed.status).toBe('settled');
      expect(resumed.ledgerTxId).toBeTruthy();
      // Idempotent: money moved once.
      expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('900');
      expect(formatAmount((await ledger.balance(userAvailable(VENDOR_USER, 'USDT'))).amount)).toBe('95');
      expect(formatAmount((await ledger.balance(houseFees('market', 'USDT'))).amount)).toBe('5');

      const again = await commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId });
      expect(again.ledgerTxId).toBe(resumed.ledgerTxId);
    });

    it('settles with explicit zero house commission (owner free rate)', async () => {
      await approvedVendor(VENDOR_USER);
      const free = new CommerceService(sql, vendors, ledger, { commissionBps: 0 });
      const listing = await free.createListing({
        userId: VENDOR_USER,
        title: 'Free commission pack',
        description: 'Owner set 0 bps',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '40',
      });
      await ledger.post(
        recipes.deposit({
          userId: BUYER,
          assetId: 'USDT',
          amount: amt('100'),
          rail: 'test',
          railRef: 'buyer-seed-free',
        }),
      );
      const p = await free.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() });
      expect(p.status).toBe('settled');
      expect(p.commissionBps).toBe(0);
      expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('60');
      expect(formatAmount((await ledger.balance(userAvailable(VENDOR_USER, 'USDT'))).amount)).toBe('40');
      expect(formatAmount((await ledger.balance(houseFees('market', 'USDT'))).amount)).toBe('0');
    });

    it('refuses purchase of an archived listing', async () => {
      const listing = await liveListing();
      await commerce.archiveListing({ userId: VENDOR_USER, listingId: listing.id });
      await ledger.post(
        recipes.deposit({
          userId: BUYER,
          assetId: 'USDT',
          amount: amt('1000'),
          rail: 'test',
          railRef: 'buyer-seed-arch',
        }),
      );
      await expect(commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() })).rejects.toMatchObject({
        code: 'market.listing_not_found',
      });
      expect((await commerce.publicListings({ limit: 50 })).map((l) => l.id)).not.toContain(listing.id);
    });
  });

  describe('listings honesty residual', () => {
    it('archive releases the listing slot so capacity returns', async () => {
      await approvedVendor(VENDOR_USER);
      const listing = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'Temp',
        description: 'will archive',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '10',
      });
      expect((await vendors.slotStatus(VENDOR_USER)).held).toBe(1);
      const archived = await commerce.archiveListing({ userId: VENDOR_USER, listingId: listing.id });
      expect(archived.status).toBe('archived');
      expect((await vendors.slotStatus(VENDOR_USER)).held).toBe(0);
    });

    it('create refuses when stake capacity is exhausted and leaves no orphan listing', async () => {
      stakes.vendorSlots = 1;
      await approvedVendor(VENDOR_USER);
      await commerce.createListing({
        userId: VENDOR_USER,
        title: 'Only one',
        description: 'fills capacity',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '10',
      });
      await expect(
        commerce.createListing({
          userId: VENDOR_USER,
          title: 'Overflow',
          description: 'no slot left',
          offerType: 'one_time',
          assetId: 'USDT',
          price: '10',
        }),
      ).rejects.toMatchObject({ code: 'market.slots_exhausted' });
      const countRows = await sql<Array<{ n: string }>>`
        SELECT COUNT(*)::text AS n FROM market.listings WHERE status = 'active'
      `;
      expect(Number(countRows[0]?.n)).toBe(1);
    });

    it('hides leftover subscription rows without a period from the public catalogue', async () => {
      const vendorId = await approvedVendor(VENDOR_USER);
      const leftover = await insertLegacySubscription(vendorId);
      const oneTime = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'One-shot',
        description: 'buy once',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '10',
      });
      const publicIds = (await commerce.publicListings({ limit: 50 })).map((l) => l.id);
      expect(publicIds).toContain(oneTime.id);
      expect(publicIds).not.toContain(leftover.id);
    });

    it('unset subscription period leaves capacity for a one-time listing', async () => {
      stakes.vendorSlots = 1;
      await approvedVendor(VENDOR_USER);
      await expect(
        commerce.createListing({
          userId: VENDOR_USER,
          title: 'Sub plan',
          description: 'must not steal the only slot',
          offerType: 'subscription',
          assetId: 'USDT',
          price: '10',
        }),
      ).rejects.toMatchObject({ code: 'market.subscription_period_unset' });

      const oneTime = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'One-shot',
        description: 'the slot that would have been stolen',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '10',
      });
      expect((await commerce.publicListings({ limit: 50 })).map((l) => l.id)).toEqual([oneTime.id]);
    });
  });

  describe('over-capacity listing prune', () => {
    it('when stake drops under held slots, only the oldest listings stay sellable', async () => {
      stakes.vendorSlots = 3;
      await approvedVendor(VENDOR_USER);
      const a = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'A first',
        description: 'oldest',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '10',
      });
      const b = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'B second',
        description: 'middle',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '10',
      });
      const c = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'C third',
        description: 'newest',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '10',
      });
      // Partial drop — vendor still listed (usable=1) but only one listing sells.
      stakes.vendorSlots = 1;
      const publicIds = (await commerce.publicListings({ limit: 50 })).map((l) => l.id);
      expect(publicIds).toEqual([a.id]);
      expect(publicIds).not.toContain(b.id);
      expect(publicIds).not.toContain(c.id);

      await ledger.post(
        recipes.deposit({
          userId: BUYER,
          assetId: 'USDT',
          amount: amt('1000'),
          rail: 'test',
          railRef: 'buyer-seed-overcap',
        }),
      );
      const buyA = await commerce.purchase({ buyerId: BUYER, listingId: a.id, purchaseId: randomUUID() });
      expect(buyA.status).toBe('settled');
      await expect(commerce.purchase({ buyerId: BUYER, listingId: b.id, purchaseId: randomUUID() })).rejects.toMatchObject({
        code: 'market.listing_over_capacity',
      });
      await expect(commerce.purchase({ buyerId: BUYER, listingId: c.id, purchaseId: randomUUID() })).rejects.toMatchObject({
        code: 'market.listing_over_capacity',
      });
    });
  });

  describe('Class M re-drive snapshot', () => {
    it('settles a pending claim at the bps stored on the row even if env bps later changes', async () => {
      await approvedVendor(VENDOR_USER);
      const listing = await commerce.createListing({
        userId: VENDOR_USER,
        title: 'Bot pack',
        description: 'A useful bot',
        offerType: 'one_time',
        assetId: 'USDT',
        price: '100',
      });
      await ledger.post(
        recipes.deposit({
          userId: BUYER,
          assetId: 'USDT',
          amount: amt('1000'),
          rail: 'test',
          railRef: 'buyer-seed-bps-snap',
        }),
      );
      const purchaseId = randomUUID();
      await sql`
        INSERT INTO market.purchases (
          id, listing_id, buyer_id, vendor_id, vendor_user_id,
          asset_id, price, commission_bps, status
        )
        SELECT ${purchaseId}, ${listing.id}, ${BUYER}, id, ${VENDOR_USER},
               'USDT', '100'::numeric, 500, 'pending'
          FROM market.vendors WHERE user_id = ${VENDOR_USER}
      `;
      // Live service now has a different rate — must not stuck or re-split.
      const moved = new CommerceService(sql, vendors, ledger, { commissionBps: 100 });
      const settled = await moved.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId });
      expect(settled.status).toBe('settled');
      expect(settled.commissionBps).toBe(500);
      expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('900');
      expect(formatAmount((await ledger.balance(userAvailable(VENDOR_USER, 'USDT'))).amount)).toBe('95');
      expect(formatAmount((await ledger.balance(houseFees('market', 'USDT'))).amount)).toBe('5');
    });

    it('retains the same claim after insufficient funds and settles that key when funded', async () => {
      const listing = await (async () => {
        await approvedVendor(VENDOR_USER);
        return commerce.createListing({
          userId: VENDOR_USER,
          title: 'Bot pack',
          description: 'A useful bot',
          offerType: 'one_time',
          assetId: 'USDT',
          price: '100',
        });
      })();
      const purchaseId = randomUUID();
      await expect(commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId })).rejects.toMatchObject({
        code: 'market.insufficient_funds',
      });
      await ledger.post(
        recipes.deposit({
          userId: BUYER,
          assetId: 'USDT',
          amount: amt('1000'),
          rail: 'test',
          railRef: 'buyer-seed-after-insuf',
        }),
      );
      const ok = await commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId });
      expect(ok.status).toBe('settled');
      expect(ok.id).toBe(purchaseId);
      expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('900');
    });
  });

  describe('schema honesty', () => {
    it('has no balance-shaped columns on market listings/purchases', async () => {
      const cols = await sql<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name
          FROM information_schema.columns
         WHERE table_schema = 'market'
           AND table_name IN ('listings', 'purchases')
      `;
      const banned = /balance|total|running|cached|available|held|accrued|outstanding/i;
      for (const c of cols) {
        expect(c.column_name).not.toMatch(banned);
      }
      // price/commission exist as intent records, not balances — listed explicitly.
      expect(cols.some((c) => c.column_name === 'price')).toBe(true);
    });
  });

  /**
   * Unit card A2 — concurrent create wrap residual
   * Promise: claimSlot FOR UPDATE + create rolls back orphan on claim refuse
   * Done bar: N concurrent creates against capacity C admit exactly C active
   * listings + C held slots; extras refuse market.slots_exhausted; no orphan active.
   * Class P · RED first under Postgres.
   */
  describe('concurrent create wrap residual', () => {
    it('concurrent creates cannot double-allocate beyond stake capacity', async () => {
      stakes.vendorSlots = 2;
      await approvedVendor(VENDOR_USER);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          commerce.createListing({
            userId: VENDOR_USER,
            title: `Listing ${i}`,
            description: 'concurrent create wrap',
            offerType: 'one_time',
            assetId: 'USDT',
            price: '10',
          }),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(2);
      expect(failed).toHaveLength(4);
      for (const f of failed) {
        expect(f).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ code: 'market.slots_exhausted' }) });
      }
      const countRows = await sql<Array<{ n: string }>>`
        SELECT COUNT(*)::text AS n FROM market.listings WHERE status = 'active'
      `;
      expect(Number(countRows[0]?.n)).toBe(2);
      expect((await vendors.slotStatus(VENDOR_USER)).held).toBe(2);
    });
  });
});
