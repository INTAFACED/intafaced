import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  houseFees,
  userAvailable,
  recipes,
  type LedgerTx,
  type PostRequest,
} from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLedgerClient } from '../ledger-client.js';
import { MARKET_OPS_SCOPE, VendorService } from '../vendor-service.js';
import type { SlotEntitlementSource, VendorEntitlement } from '../stake-source.js';
import { CommerceService } from './commerce-service.js';

/**
 * market.commerce Stage C3 — listing subscriptions.
 *
 * Period from the listing (no default month). One period posts existing
 * marketPurchase. Cancel stops new access without a reverse recipe. Past-due
 * is a named refuse, not a fake paid state. Catalogue is honest.
 *
 * Recurring subscribe stays Q-market refuse — this file does not invent an
 * automatic charge product.
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
const PERIOD = 3_600;

/**
 * The excluding `max(access_until)` read. Pausing after this query, before the
 * caller writes, is the window where two renewals otherwise store one end.
 */
function isExcludedAccessMax(text: string): boolean {
  return /max\s*\(\s*access_until\s*\)/i.test(text) && /<>/.test(text);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Forward postgres.js, and hold the connection across a pause after the excluded max read. */
function pauseAfterExcludedAccessMax(inner: Sql, afterRead: () => Promise<void>): Sql {
  const wrap = (source: Sql): Sql => {
    const proxy = new Proxy(source as unknown as object, {
      apply(target, _thisArg, argList: unknown[]) {
        const strings = argList[0] as TemplateStringsArray | undefined;
        const text = strings && Array.isArray(strings) ? strings.join('') : '';
        const run = Reflect.apply(target as (...args: unknown[]) => unknown, target, argList) as Promise<unknown>;
        if (!isExcludedAccessMax(text)) return run;
        return Promise.resolve(run).then(async (rows) => {
          await afterRead();
          return rows;
        });
      },
      get(target, prop, receiver) {
        if (prop === 'begin') {
          const begin = Reflect.get(target, prop, receiver) as (...args: unknown[]) => unknown;
          return (...beginArgs: unknown[]) => {
            const cbIndex = beginArgs.findIndex((arg) => typeof arg === 'function');
            if (cbIndex === -1) return begin.apply(target, beginArgs);
            const cb = beginArgs[cbIndex] as (tx: Sql) => unknown;
            const args = beginArgs.slice();
            args[cbIndex] = (tx: Sql) => cb(wrap(tx));
            return begin.apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    return proxy as Sql;
  };
  return wrap(inner);
}

/**
 * A session blocked on the two-int advisory lock whose keys are hashtext(listing)
 * and hashtext(buyer). objsubid 2 is that pair, not a single bigint key.
 */
async function listingBuyerLockWaiting(db: Sql, listingId: string, buyerId: string): Promise<boolean> {
  const [row] = await db<Array<{ waiters: number }>>`
    SELECT count(*)::int AS waiters
      FROM pg_locks
     WHERE locktype = 'advisory'
       AND NOT granted
       AND objsubid = 2
       AND classid = hashtext(${listingId})::oid
       AND objid = hashtext(${buyerId})::oid
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  `;
  return Number(row?.waiters ?? 0) > 0;
}

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
      `H8a: market commerce-subscriptions is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('market.commerce C3 subscriptions PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });

  it('subscribe named-refuses recurring — no invented automatic charge', async () => {
    const commerce = new CommerceService(
      (() => {
        throw new Error('sql must not run on recurring refuse');
      }) as never,
      {} as never,
      {
        post: async () => {
          throw new Error('ledger must not post on recurring refuse');
        },
      } as never,
      { commissionBps: 500 },
    );
    await expect(commerce.subscribe({ listingId: randomUUID() })).rejects.toMatchObject({
      code: 'market.subscription_recurring_not_built',
    });
  });
});

describe('Stage C3 listing subscriptions', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let stakes: FixedEntitlement;
  let vendors: VendorService;
  let ledger: MemoryLedger;
  let clock: Date;
  let commerce: CommerceService;

  async function approvedVendor(): Promise<void> {
    const v = await vendors.applyAsVendor({
      userId: VENDOR_USER,
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
  }

  async function fundBuyer(): Promise<void> {
    await ledger.post(
      recipes.deposit({
        userId: BUYER,
        assetId: 'USDT',
        amount: amt('1000'),
        rail: 'test',
        railRef: `buyer-seed-${randomUUID()}`,
      }),
    );
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
    clock = new Date('2026-08-16T00:00:00.000Z');
    commerce = new CommerceService(sql, vendors, ledger, {
      commissionBps: 500,
      now: () => new Date(clock.getTime()),
    });
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('keeps an actual HTTP committed/lost-ACK claim pending through later gate and funds refusals', async () => {
    await approvedVendor();
    await fundBuyer();
    const listing = await commerce.createListing({
      userId: VENDOR_USER,
      title: 'Feed',
      description: 'Hourly',
      offerType: 'subscription',
      assetId: 'USDT',
      price: '100',
      periodSeconds: PERIOD,
    });
    const purchaseId = randomUUID();
    const requests: PostRequest[] = [];
    let committed: LedgerTx | undefined;
    let mode: 'lost' | 'funds' | 'ok' = 'lost';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as {
        idempotencyKey: string;
        module: string;
        reason: string;
        meta: Record<string, unknown>;
        entries: Array<{ account: PostRequest['entries'][number]['account']; direction: 'credit' | 'debit'; amount: string }>;
      };
      const request: PostRequest = { ...wire, entries: wire.entries.map((entry) => ({ ...entry, amount: amt(entry.amount) })) };
      requests.push(request);
      if (mode === 'funds')
        return new Response(JSON.stringify({ code: 'ledger.insufficient_funds', message: 'later attempt refused' }), { status: 400 });
      committed = await ledger.post(request);
      if (mode === 'lost') throw new Error('ACK lost after actual ledger commit');
      return new Response(JSON.stringify({ txId: committed.id, hash: committed.hash, postedAt: committed.postedAt.toISOString() }), {
        status: 200,
      });
    });
    try {
      const http = createLedgerClient('http://ledger.test', 'internal-secret-internal-secret-32');
      const active = new CommerceService(sql, vendors, http, { commissionBps: 500, now: () => clock });
      await expect(active.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId })).rejects.toThrow('ACK lost');
      expect(committed?.idempotencyKey).toBe(`market.purchase:${purchaseId}`);
      // The shared client retries a lost response (a network error) twice before it gives up: three identical posts of
      // the one key, which the ledger answers with the one booking.
      expect(requests).toHaveLength(3);
      const closed = new CommerceService(sql, vendors, http, { commissionBps: null, now: () => clock });
      await expect(closed.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId })).rejects.toMatchObject({
        code: 'market.commission_not_configured',
      });
      expect(requests).toHaveLength(3);
      mode = 'funds';
      await expect(active.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId })).rejects.toMatchObject({
        code: 'market.insufficient_funds',
      });
      // A ledger refusal is an answer, not a flake: sent once.
      expect(requests).toHaveLength(4);
      const [pending] =
        await sql`SELECT status, ledger_tx_id, rejection_code, access_until, price::text, commission_bps, period_seconds FROM market.purchases WHERE id = ${purchaseId}`;
      expect(pending).toMatchObject({
        status: 'pending',
        ledger_tx_id: null,
        rejection_code: null,
        access_until: null,
        price: '100.000000000000000000',
        commission_bps: 500,
        period_seconds: PERIOD,
      });
      mode = 'ok';
      const settled = await active.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId });
      expect(settled.ledgerTxId).toBe(committed!.id);
      expect(settled.accessUntil).toBe(new Date(clock.getTime() + PERIOD * 1000).toISOString());
      expect(requests).toHaveLength(5);
      for (const request of requests) expect(request).toEqual(requests[0]);
      expect((await closed.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId })).ledgerTxId).toBe(settled.ledgerTxId);
      expect(requests).toHaveLength(5);
      expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('900');
      expect(formatAmount((await ledger.balance(userAvailable(VENDOR_USER, 'USDT'))).amount)).toBe('95');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refuses an actual same-key rich receipt for another buyer without settling or granting access', async () => {
    await approvedVendor();
    await fundBuyer();
    const listing = await commerce.createListing({
      userId: VENDOR_USER,
      title: 'Feed',
      description: 'Hourly',
      offerType: 'subscription',
      assetId: 'USDT',
      price: '100',
      periodSeconds: PERIOD,
    });
    const purchaseId = randomUUID();
    const other = randomUUID();
    await ledger.post(recipes.deposit({ userId: other, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: randomUUID() }));
    await ledger.post(
      recipes.marketPurchase({
        purchaseId,
        listingId: listing.id,
        buyerId: other,
        vendorUserId: VENDOR_USER,
        assetId: 'USDT',
        price: amt('100'),
        commissionBps: 500,
      }),
    );
    await expect(commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId })).rejects.toMatchObject({
      code: 'market.purchase_receipt_mismatch',
    });
    await expect(commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId })).rejects.toMatchObject({
      code: 'market.purchase_receipt_mismatch',
    });
    const [row] = await sql`SELECT status, ledger_tx_id, access_until FROM market.purchases WHERE id = ${purchaseId}`;
    expect(row).toMatchObject({ status: 'pending', ledger_tx_id: null, access_until: null });
    expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('1000');
  });

  it('recovers a matching rich committed receipt using the original period when fresh gates close', async () => {
    await approvedVendor();
    await fundBuyer();
    const listing = await commerce.createListing({
      userId: VENDOR_USER,
      title: 'Feed',
      description: 'Hourly',
      offerType: 'subscription',
      assetId: 'USDT',
      price: '100',
      periodSeconds: PERIOD,
    });
    const purchaseId = randomUUID();
    const originalPost = ledger.post.bind(ledger);
    const post = vi.spyOn(ledger, 'post').mockImplementationOnce(async (request) => {
      await originalPost(request);
      throw new Error('rich ACK lost after commit');
    });
    try {
      await expect(commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId })).rejects.toThrow('rich ACK lost');
      const actual = await ledger.getTxByKey(`market.purchase:${purchaseId}`);
      expect(actual).not.toBeNull();
      await commerce.archiveListing({ userId: VENDOR_USER, listingId: listing.id });
      await sql`UPDATE market.listings SET period_seconds = ${PERIOD * 2}, price = 999 WHERE id = ${listing.id}`;
      await sql`UPDATE market.vendors SET status = 'suspended' WHERE user_id = ${VENDOR_USER}`;
      const closed = new CommerceService(sql, vendors, ledger, { commissionBps: null, now: () => clock });
      const resumed = await closed.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId });
      expect(resumed).toMatchObject({
        status: 'settled',
        ledgerTxId: actual!.id,
        price: '100',
        commissionBps: 500,
        periodSeconds: PERIOD,
        accessUntil: new Date(clock.getTime() + PERIOD * 1000).toISOString(),
      });
      expect(post).toHaveBeenCalledTimes(1);
      expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('900');
    } finally {
      post.mockRestore();
    }
  });

  it('purchases a subscription period via marketPurchase and grants time-bounded access', async () => {
    await approvedVendor();
    await fundBuyer();
    const listing = await commerce.createListing({
      userId: VENDOR_USER,
      title: 'Feed',
      description: 'hourly access',
      offerType: 'subscription',
      assetId: 'USDT',
      price: '100',
      periodSeconds: PERIOD,
    });
    expect(listing.periodSeconds).toBe(PERIOD);
    expect((await commerce.publicListings({ limit: 50 })).items.map((l) => l.id)).toContain(listing.id);

    const bought = await commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() });
    expect(bought.status).toBe('settled');
    expect(bought.accessUntil).toBe(new Date(clock.getTime() + PERIOD * 1000).toISOString());
    expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('900');
    expect(formatAmount((await ledger.balance(userAvailable(VENDOR_USER, 'USDT'))).amount)).toBe('95');
    expect(formatAmount((await ledger.balance(houseFees('market', 'USDT'))).amount)).toBe('5');

    const access = await commerce.subscriptionAccess({ buyerId: BUYER, listingId: listing.id });
    expect(access.granted).toBe(true);
    expect(access.accessUntil).toBe(bought.accessUntil);
  });

  it('refuses subscription purchase when commission is blank', async () => {
    await approvedVendor();
    const listing = await commerce.createListing({
      userId: VENDOR_USER,
      title: 'Feed',
      description: 'hourly',
      offerType: 'subscription',
      assetId: 'USDT',
      price: '10',
      periodSeconds: PERIOD,
    });
    const blank = new CommerceService(sql, vendors, ledger, { commissionBps: null, now: () => clock });
    await expect(blank.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() })).rejects.toMatchObject({
      code: 'market.commission_not_configured',
    });
    expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('0');
  });

  it('refuses access as past-due after the paid window — not a fake paid state', async () => {
    await approvedVendor();
    await fundBuyer();
    const listing = await commerce.createListing({
      userId: VENDOR_USER,
      title: 'Feed',
      description: 'hourly',
      offerType: 'subscription',
      assetId: 'USDT',
      price: '10',
      periodSeconds: PERIOD,
    });
    await commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() });
    clock = new Date(clock.getTime() + (PERIOD + 1) * 1000);
    await expect(commerce.subscriptionAccess({ buyerId: BUYER, listingId: listing.id })).rejects.toMatchObject({
      code: 'market.subscription_past_due',
    });
  });

  it('cancel stops new access and does not reverse the ledger', async () => {
    await approvedVendor();
    await fundBuyer();
    const listing = await commerce.createListing({
      userId: VENDOR_USER,
      title: 'Feed',
      description: 'hourly',
      offerType: 'subscription',
      assetId: 'USDT',
      price: '100',
      periodSeconds: PERIOD,
    });
    await commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() });
    const houseAfterPay = formatAmount((await ledger.balance(houseFees('market', 'USDT'))).amount);

    const cancelled = await commerce.cancelSubscription({ buyerId: BUYER, listingId: listing.id });
    expect(cancelled.cancelledAt).toBeTruthy();
    // Paid window still grants access — cancel is not a silent refund.
    await expect(commerce.subscriptionAccess({ buyerId: BUYER, listingId: listing.id })).resolves.toMatchObject({
      granted: true,
    });
    expect(formatAmount((await ledger.balance(houseFees('market', 'USDT'))).amount)).toBe(houseAfterPay);
    expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('900');

    await expect(commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: randomUUID() })).rejects.toMatchObject({
      code: 'market.subscription_cancelled',
    });

    clock = new Date(clock.getTime() + (PERIOD + 1) * 1000);
    await expect(commerce.subscriptionAccess({ buyerId: BUYER, listingId: listing.id })).rejects.toMatchObject({
      code: 'market.subscription_cancelled',
    });
  });

  it('replays a settled marketPurchase without a second post when getTxByKey throws', async () => {
    await approvedVendor();
    const book = new MemoryLedger();
    await book.post(
      recipes.deposit({
        userId: BUYER,
        assetId: 'USDT',
        amount: amt('1000'),
        rail: 'test',
        railRef: `buyer-seed-retry-${randomUUID()}`,
      }),
    );

    // Same factory index.ts passes into CommerceService. Its getTxByKey throws.
    const http = createLedgerClient('http://ledger.test', 'internal-secret-internal-secret-32');
    await expect(http.getTxByKey(`market.purchase:${randomUUID()}`)).rejects.toThrow(
      'getTxByKey is not exposed over the internal ledger API',
    );

    const posts: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/trpc/post')) {
        return new Response('no door', { status: 404 });
      }
      const wire = JSON.parse(String(init?.body ?? '{}')) as {
        idempotencyKey: string;
        module: string;
        reason: string;
        meta?: Record<string, unknown>;
        correlationId?: string;
        entries: Array<{
          account: PostRequest['entries'][number]['account'];
          direction: 'debit' | 'credit';
          amount: string;
        }>;
      };
      posts.push(wire.idempotencyKey);
      const tx = await book.post({
        idempotencyKey: wire.idempotencyKey,
        module: wire.module,
        reason: wire.reason,
        meta: wire.meta ?? {},
        correlationId: wire.correlationId,
        entries: wire.entries.map((entry) => ({
          account: entry.account,
          direction: entry.direction,
          amount: amt(entry.amount),
        })),
      });
      return new Response(JSON.stringify({ txId: tx.id, hash: tx.hash, postedAt: tx.postedAt.toISOString() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const open = new CommerceService(sql, vendors, http, {
        commissionBps: 500,
        now: () => new Date(clock.getTime()),
      });

      await expect(
        open.createListing({
          userId: VENDOR_USER,
          title: 'Blank',
          description: 'no price',
          offerType: 'subscription',
          assetId: 'USDT',
          price: '   ',
          periodSeconds: PERIOD,
        }),
      ).rejects.toMatchObject({ code: 'market.listing_invalid_price' });
      expect(posts).toEqual([]);

      const passListing = await open.createListing({
        userId: VENDOR_USER,
        title: 'Still open',
        description: 'gates still pass',
        offerType: 'subscription',
        assetId: 'USDT',
        price: '100',
        periodSeconds: PERIOD,
      });
      const passId = randomUUID();
      const first = await open.purchase({ buyerId: BUYER, listingId: passListing.id, purchaseId: passId });
      expect(first.status).toBe('settled');
      expect(first.ledgerTxId).toBeTruthy();
      expect(posts).toEqual([`market.purchase:${passId}`]);

      const accessUntil = new Date(clock.getTime() + PERIOD * 1000).toISOString();
      const passAgain = await open.purchase({ buyerId: BUYER, listingId: passListing.id, purchaseId: passId });
      expect(passAgain.status).toBe('settled');
      expect(passAgain.ledgerTxId).toBe(first.ledgerTxId);
      expect(passAgain.price).toBe('100');
      expect(passAgain.commissionBps).toBe(500);
      expect(passAgain.accessUntil).toBe(accessUntil);
      expect(posts).toEqual([`market.purchase:${passId}`]);

      const pendingListing = await open.createListing({
        userId: VENDOR_USER,
        title: 'Posted',
        description: 'already settled',
        offerType: 'subscription',
        assetId: 'USDT',
        price: '100',
        periodSeconds: PERIOD,
      });
      const pendingId = randomUUID();
      const pending = await open.purchase({ buyerId: BUYER, listingId: pendingListing.id, purchaseId: pendingId });
      expect(pending.ledgerTxId).toBeTruthy();

      const stuckListing = await open.createListing({
        userId: VENDOR_USER,
        title: 'Stuck',
        description: 'settled without access',
        offerType: 'subscription',
        assetId: 'USDT',
        price: '100',
        periodSeconds: PERIOD,
      });
      const stuckId = randomUUID();
      const stuck = await open.purchase({ buyerId: BUYER, listingId: stuckListing.id, purchaseId: stuckId });
      expect(posts).toEqual([`market.purchase:${passId}`, `market.purchase:${pendingId}`, `market.purchase:${stuckId}`]);

      await open.cancelSubscription({ buyerId: BUYER, listingId: pendingListing.id });
      await open.cancelSubscription({ buyerId: BUYER, listingId: stuckListing.id });
      await open.archiveListing({ userId: VENDOR_USER, listingId: pendingListing.id });
      await open.archiveListing({ userId: VENDOR_USER, listingId: stuckListing.id });
      await sql`UPDATE market.purchases SET access_until = NULL WHERE id = ${stuckId}`;
      const mine = await vendors.myVendor(VENDOR_USER);
      await vendors.vet({
        vendorId: mine!.id,
        decision: 'suspended',
        reason: 'gates must not block a posted purchase',
        actorId: OPERATOR,
        actorScope: MARKET_OPS_SCOPE,
      });
      await sql`
        UPDATE market.listings SET price = '999'::numeric
         WHERE id IN (${passListing.id}, ${pendingListing.id}, ${stuckListing.id})
      `;

      const hostile = new CommerceService(sql, vendors, http, {
        commissionBps: null,
        now: () => new Date(clock.getTime()),
      });

      const resumed = await hostile.purchase({ buyerId: BUYER, listingId: pendingListing.id, purchaseId: pendingId });
      expect(resumed.status).toBe('settled');
      expect(resumed.ledgerTxId).toBe(pending.ledgerTxId);
      expect(resumed.price).toBe('100');
      expect(resumed.commissionBps).toBe(500);
      expect(resumed.accessUntil).toBe(accessUntil);
      expect(posts).toHaveLength(3);
      expect(formatAmount((await book.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('700');
      expect(formatAmount((await book.balance(userAvailable(VENDOR_USER, 'USDT'))).amount)).toBe('285');
      expect(formatAmount((await book.balance(houseFees('market', 'USDT'))).amount)).toBe('15');

      await expect(hostile.subscriptionAccess({ buyerId: BUYER, listingId: pendingListing.id })).resolves.toEqual({
        granted: true,
        listingId: pendingListing.id,
        buyerId: BUYER,
        accessUntil,
      });
      await expect(hostile.subscriptionAccess({ buyerId: BUYER, listingId: stuckListing.id })).resolves.toEqual({
        granted: true,
        listingId: stuckListing.id,
        buyerId: BUYER,
        accessUntil,
      });

      const stuckAgain = await hostile.purchase({ buyerId: BUYER, listingId: stuckListing.id, purchaseId: stuckId });
      expect(stuckAgain.status).toBe('settled');
      expect(stuckAgain.ledgerTxId).toBe(stuck.ledgerTxId);
      expect(stuckAgain.price).toBe('100');
      expect(stuckAgain.commissionBps).toBe(500);
      expect(stuckAgain.accessUntil).toBe(accessUntil);
      expect(posts).toHaveLength(3);

      await expect(hostile.purchase({ buyerId: BUYER, listingId: passListing.id, purchaseId: randomUUID() })).rejects.toMatchObject({
        code: 'market.commission_not_configured',
      });
      expect(posts).toHaveLength(3);
      expect(formatAmount((await book.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('700');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('stacks two overlapping renewals so the second period starts at the first end', async () => {
    await approvedVendor();
    await fundBuyer();
    const listing = await commerce.createListing({
      userId: VENDOR_USER,
      title: 'Feed',
      description: 'hourly access',
      offerType: 'subscription',
      assetId: 'USDT',
      price: '100',
      periodSeconds: PERIOD,
    });

    // Both purchases stay in flight. After each excluded max read, the first
    // one waits until the other has either read the same window or blocked on
    // the (listing, buyer) lock. Two sequential purchases cannot reach that
    // wait, and a missing lock lets both reads finish before either write.
    let active = 0;
    let purchasesOverlapped = false;
    let firstWaiting = false;
    let readsOverlappedBeforeWrite = false;
    let lockHeldAcrossRead = false;
    let arrived = 0;

    const afterRead = async () => {
      const n = ++arrived;
      if (n > 1) {
        if (firstWaiting) readsOverlappedBeforeWrite = true;
        return;
      }
      firstWaiting = true;
      const deadline = Date.now() + 4_000;
      try {
        while (Date.now() < deadline) {
          if (readsOverlappedBeforeWrite) return;
          if (await listingBuyerLockWaiting(sql, listing.id, BUYER)) {
            lockHeldAcrossRead = true;
            return;
          }
          await delay(20);
        }
      } finally {
        firstWaiting = false;
      }
      throw new Error('overlapping renewals neither shared the max(access_until) read nor waited on the (listing, buyer) lock');
    };

    const racing = new CommerceService(pauseAfterExcludedAccessMax(sql, afterRead), vendors, ledger, {
      commissionBps: 500,
      now: () => new Date(clock.getTime()),
    });

    const idA = randomUUID();
    const idB = randomUUID();
    const buy = async (purchaseId: string) => {
      active += 1;
      if (active > 1) purchasesOverlapped = true;
      try {
        return await racing.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId });
      } finally {
        active -= 1;
      }
    };

    const [left, right] = await Promise.all([buy(idA), buy(idB)]);
    const firstEnd = new Date(clock.getTime() + PERIOD * 1000).toISOString();
    const secondEnd = new Date(Date.parse(firstEnd) + PERIOD * 1000).toISOString();

    expect(purchasesOverlapped).toBe(true);
    expect(readsOverlappedBeforeWrite || lockHeldAcrossRead).toBe(true);
    expect([left.accessUntil, right.accessUntil].sort()).toEqual([firstEnd, secondEnd]);
    expect(left.accessUntil).not.toBe(right.accessUntil);
    expect(lockHeldAcrossRead).toBe(true);
    expect(readsOverlappedBeforeWrite).toBe(false);

    await expect(commerce.subscriptionAccess({ buyerId: BUYER, listingId: listing.id })).resolves.toEqual({
      granted: true,
      listingId: listing.id,
      buyerId: BUYER,
      accessUntil: secondEnd,
    });

    expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('800');
    expect(formatAmount((await ledger.balance(userAvailable(VENDOR_USER, 'USDT'))).amount)).toBe('190');
    expect(formatAmount((await ledger.balance(houseFees('market', 'USDT'))).amount)).toBe('10');
    const purchaseKeys = ledger
      .journal()
      .map((tx) => tx.idempotencyKey)
      .filter((key) => key.startsWith('market.purchase:'));
    expect(purchaseKeys).toHaveLength(2);
    expect(purchaseKeys).toEqual(expect.arrayContaining([`market.purchase:${idA}`, `market.purchase:${idB}`]));

    const paidA = left.id === idA ? left : right;
    const replay = await commerce.purchase({ buyerId: BUYER, listingId: listing.id, purchaseId: idA });
    expect(replay.status).toBe('settled');
    expect(replay.accessUntil).toBe(paidA.accessUntil);
    expect(replay.ledgerTxId).toBe(paidA.ledgerTxId);
    expect(replay.price).toBe('100');
    expect(
      ledger
        .journal()
        .map((tx) => tx.idempotencyKey)
        .filter((key) => key.startsWith('market.purchase:')),
    ).toEqual(purchaseKeys);
    expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('800');
  }, 20_000);
});
