import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  formatAmount,
  houseFees,
  marketPurchaseEscrowAccount,
  parseAmount,
  recipes,
  userAvailable,
  type AccountRef,
} from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_OPS_SCOPE, VendorService } from '../vendor-service.js';
import type { SlotEntitlementSource, VendorEntitlement } from '../stake-source.js';
import type { AffiliateMarketFeeLeg } from '../affiliate-accrue.js';
import { CommerceService } from './commerce-service.js';
import type { PurchaseHoldConfig } from './held-purchase.js';

/**
 * MC-market-02 (J-more-catalogue-02 #4 to #6): a purchase held until its refund window ends, then released to the seller
 * or refunded to the buyer, exactly once. Postgres-backed (TEST_DATABASE_URL, a `*_test` admin URL) with the in-memory
 * ledger, so each step reads real balances: the buyer's, the purchase's pot, the seller's and the house's.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrationFiles = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const HOLD_MIGRATION = '20261029213109_market_purchase_hold';
const url = process.env.TEST_DATABASE_URL?.trim();
if (!url) throw new Error('Held purchase tests require an isolated TEST_DATABASE_URL');

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';
const WINDOW = 3600;
const START = new Date('2026-10-30T00:00:00.000Z');
const SWEEP = 5;
const ON: PurchaseHoldConfig = { on: true, refundWindowSeconds: WINDOW, releaseSweepSeconds: SWEEP };

class FixedEntitlement implements SlotEntitlementSource {
  async entitlementOf(): Promise<VendorEntitlement> {
    return { tierName: 'Operator', vendorSlots: 10 };
  }
}

describe('market held purchase (MC-market-02)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let vendors: VendorService;
  let ledger: MemoryLedger;
  let now: Date;
  let accrue: ReturnType<typeof vi.fn<(leg: AffiliateMarketFeeLeg) => Promise<void>>>;
  let payout: ReturnType<typeof vi.fn<(feeEventId: string) => Promise<void>>>;
  let sweepErrors: Array<{ purchaseId: string; err: unknown }>;

  const service = (hold: PurchaseHoldConfig | undefined, clock: () => Date = () => now) =>
    new CommerceService(sql, vendors, ledger, {
      commissionBps: 500,
      hold,
      now: clock,
      affiliateAccrue: { accrueMarketFee: accrue },
      affiliatePayout: { payoutMarketFee: payout },
      onSweepError: (purchaseId, err) => sweepErrors.push({ purchaseId, err }),
    });

  const balance = async (account: AccountRef) => formatAmount((await ledger.balance(account)).amount);
  const buyer = () => balance(userAvailable(BUYER, 'USDT'));
  const seller = () => balance(userAvailable(SELLER, 'USDT'));
  const house = () => balance(houseFees('market', 'USDT'));
  const pot = (purchaseId: string) => balance(marketPurchaseEscrowAccount(BUYER, 'USDT', purchaseId));
  const later = (seconds: number) => {
    now = new Date(now.getTime() + seconds * 1000);
  };

  async function fund(userId: string, amount: string): Promise<void> {
    await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: parseAmount(amount), rail: 'test', railRef: randomUUID() }));
  }

  async function listing(opts: { offerType?: 'one_time' | 'subscription'; price?: string } = {}): Promise<string> {
    const offerType = opts.offerType ?? 'one_time';
    const created = await service(undefined).createListing({
      userId: SELLER,
      title: `TEST ${offerType}`,
      description: 'TEST listing',
      offerType,
      assetId: 'USDT',
      price: opts.price ?? '10',
      ...(offerType === 'subscription' ? { periodSeconds: 30 * 86_400 } : {}),
    });
    return created.id;
  }

  async function rows(purchaseId: string): Promise<number> {
    const [row] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM market.purchases WHERE id = ${purchaseId}`;
    return Number(row!.n);
  }

  async function held(listingId: string, commerce = service(ON)) {
    const purchaseId = randomUUID();
    const purchase = await commerce.purchase({ buyerId: BUYER, listingId, purchaseId });
    expect(purchase.status).toBe('held');
    return purchase;
  }

  async function sqlState(run: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await run();
    } catch (err) {
      return (err as { code?: string }).code;
    }
    return undefined;
  }

  beforeAll(async () => {
    db = await createTestDatabase({
      service: 'market',
      url: url!,
      migrations: migrationFiles.map((f) => readFileSync(join(drizzle, f), 'utf8')),
    });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE market.subscription_state, market.purchases, market.listings, market.vendor_slots,
               market.vendor_status_events, market.vendors
      RESTART IDENTITY CASCADE
    `;
    vendors = new VendorService(sql, new FixedEntitlement());
    ledger = new MemoryLedger();
    now = START;
    accrue = vi.fn<(leg: AffiliateMarketFeeLeg) => Promise<void>>(async () => undefined);
    payout = vi.fn<(feeEventId: string) => Promise<void>>(async () => undefined);
    sweepErrors = [];
    const vendor = await vendors.applyAsVendor({ userId: SELLER, displayName: 'TEST seller', description: 'TEST' });
    await vendors.vet({ vendorId: vendor.id, decision: 'approved', reason: 'TEST', actorId: OPERATOR, actorScope: MARKET_OPS_SCOPE });
    await fund(BUYER, '100');
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  describe('the owner switch', () => {
    it('off: the purchase pays through as before, with no pot and no window', async () => {
      const id = randomUUID();
      const paid = await service({ on: false, refundWindowSeconds: WINDOW, releaseSweepSeconds: SWEEP }).purchase({
        buyerId: BUYER,
        listingId: await listing(),
        purchaseId: id,
      });
      expect(paid).toMatchObject({ status: 'settled', flow: 'pay', refundWindowSeconds: null, refundWindowEndsAt: null });
      expect(await ledger.getTxByKey(`market.purchase:${id}`)).not.toBeNull();
      expect(await ledger.getTxByKey(`market:hold:${id}`)).toBeNull();
      expect([await buyer(), await seller(), await house(), await pot(id)]).toEqual(['90', '9.5', '0.5', '0']);
    });

    it('on with a blank window: refuses market.refund_window_unset before any claim row, and nothing moves', async () => {
      const listingId = await listing();
      for (const refundWindowSeconds of [null, 0]) {
        const id = randomUUID();
        await expect(
          service({ on: true, refundWindowSeconds, releaseSweepSeconds: SWEEP }).purchase({ buyerId: BUYER, listingId, purchaseId: id }),
        ).rejects.toMatchObject({
          code: 'market.refund_window_unset',
        });
        expect(await rows(id)).toBe(0);
        expect(await ledger.getTxByKey(`market:hold:${id}`)).toBeNull();
      }
      expect(await buyer()).toBe('100');
    });

    it('on with a blank release sweep: refuses market.release_sweep_unset before any claim row, and nothing moves', async () => {
      const listingId = await listing();
      for (const releaseSweepSeconds of [null, 0]) {
        const id = randomUUID();
        await expect(
          service({ on: true, refundWindowSeconds: WINDOW, releaseSweepSeconds }).purchase({ buyerId: BUYER, listingId, purchaseId: id }),
        ).rejects.toMatchObject({ code: 'market.release_sweep_unset' });
        expect(await rows(id)).toBe(0);
        expect(await ledger.getTxByKey(`market:hold:${id}`)).toBeNull();
      }
      expect(await buyer()).toBe('100');
    });

    it('a claimed purchase keeps its flow when the switch changes before its retry', async () => {
      const listingId = await listing();
      // Claimed held, refused for funds, retried after the switch went off: still held.
      const poor = randomUUID();
      const spend = vi
        .spyOn(ledger, 'post')
        .mockRejectedValueOnce(Object.assign(new Error('Insufficient USDT'), { code: 'ledger.insufficient_funds' }));
      await expect(service(ON).purchase({ buyerId: BUYER, listingId, purchaseId: poor })).rejects.toMatchObject({
        code: 'market.insufficient_funds',
      });
      spend.mockRestore();
      expect(
        await service({ on: false, refundWindowSeconds: null, releaseSweepSeconds: null }).purchase({
          buyerId: BUYER,
          listingId,
          purchaseId: poor,
        }),
      ).toMatchObject({
        status: 'held',
        flow: 'hold',
        refundWindowSeconds: WINDOW,
      });
      // Claimed pay-through, retried after the switch went on: still pays through.
      const plain = randomUUID();
      const fail = vi.spyOn(ledger, 'post').mockRejectedValueOnce(new Error('ledger down'));
      await expect(
        service({ on: false, refundWindowSeconds: null, releaseSweepSeconds: null }).purchase({
          buyerId: BUYER,
          listingId,
          purchaseId: plain,
        }),
      ).rejects.toThrow('ledger down');
      fail.mockRestore();
      expect(await service(ON).purchase({ buyerId: BUYER, listingId, purchaseId: plain })).toMatchObject({
        status: 'settled',
        flow: 'pay',
      });
    });
  });

  describe('hold', () => {
    it('charges the price into the purchase pot once, under market:hold:<id>, and starts the window', async () => {
      const purchase = await held(await listing());
      expect(purchase).toMatchObject({ flow: 'hold', refundWindowSeconds: WINDOW, outcome: null, settledAt: null });
      expect(purchase.holdPostedAt).toBe(START.toISOString());
      expect(purchase.refundWindowEndsAt).toBe(new Date(START.getTime() + WINDOW * 1000).toISOString());
      const tx = await ledger.getTxByKey(`market:hold:${purchase.id}`);
      expect(tx?.id).toBe(purchase.ledgerTxId);
      expect([await buyer(), await pot(purchase.id), await seller(), await house()]).toEqual(['90', '10', '0', '0']);
    });

    it('a second Buy with the same request returns the same purchase and charges nothing more', async () => {
      const listingId = await listing();
      const first = await held(listingId);
      const again = await service(ON).purchase({ buyerId: BUYER, listingId, purchaseId: first.id });
      expect(again).toMatchObject({ id: first.id, status: 'held', ledgerTxId: first.ledgerTxId });
      expect([await buyer(), await pot(first.id)]).toEqual(['90', '10']);
    });

    it('a lost ledger reply holds the money once: the retry posts the same key and gets the original transaction', async () => {
      const listingId = await listing();
      const id = randomUUID();
      const real = ledger.post.bind(ledger);
      const lost = vi.spyOn(ledger, 'post').mockImplementationOnce(async (request) => {
        await real(request);
        throw new Error('reply lost');
      });
      await expect(service(ON).purchase({ buyerId: BUYER, listingId, purchaseId: id })).rejects.toThrow('reply lost');
      lost.mockRestore();
      const [pending] = await sql<Array<{ status: string }>>`SELECT status FROM market.purchases WHERE id = ${id}`;
      expect(pending?.status).toBe('pending');
      const posted = await ledger.getTxByKey(`market:hold:${id}`);
      const retried = await service(ON).purchase({ buyerId: BUYER, listingId, purchaseId: id });
      expect(retried).toMatchObject({ status: 'held', ledgerTxId: posted!.id });
      expect([await buyer(), await pot(id)]).toEqual(['90', '10']);
    });

    it('a posted hold whose row was not updated is finished from the ledger even after the listing is archived', async () => {
      const listingId = await listing();
      const id = randomUUID();
      const real = ledger.post.bind(ledger);
      const lost = vi.spyOn(ledger, 'post').mockImplementationOnce(async (request) => {
        await real(request);
        throw new Error('reply lost');
      });
      await expect(service(ON).purchase({ buyerId: BUYER, listingId, purchaseId: id })).rejects.toThrow('reply lost');
      lost.mockRestore();
      await service(ON).archiveListing({ userId: SELLER, listingId });
      const posted = await ledger.getTxByKey(`market:hold:${id}`);
      const retried = await service(ON).purchase({ buyerId: BUYER, listingId, purchaseId: id });
      expect(retried).toMatchObject({ status: 'held', ledgerTxId: posted!.id });
      expect([await buyer(), await pot(id)]).toEqual(['90', '10']);
      later(WINDOW);
      expect(await service(ON).held.sweep()).toEqual({ released: 1, refunded: 0, failed: 0 });
      expect([await pot(id), await seller(), await house()]).toEqual(['0', '9.5', '0.5']);
    });

    it('a claimed hold that never posted meets the live gates on retry: an archived listing refuses and nothing moves', async () => {
      const listingId = await listing();
      const id = randomUUID();
      const down = vi.spyOn(ledger, 'post').mockRejectedValueOnce(new Error('ledger down'));
      await expect(service(ON).purchase({ buyerId: BUYER, listingId, purchaseId: id })).rejects.toThrow('ledger down');
      down.mockRestore();
      await service(ON).archiveListing({ userId: SELLER, listingId });
      await expect(service(ON).purchase({ buyerId: BUYER, listingId, purchaseId: id })).rejects.toMatchObject({
        code: 'market.listing_not_found',
      });
      expect(await ledger.getTxByKey(`market:hold:${id}`)).toBeNull();
      expect([await buyer(), await pot(id)]).toEqual(['100', '0']);
    });

    it('too little balance refuses market.insufficient_funds, keeps the claim, and holds once funded', async () => {
      const listingId = await listing({ price: '150' });
      const id = randomUUID();
      await expect(service(ON).purchase({ buyerId: BUYER, listingId, purchaseId: id })).rejects.toMatchObject({
        code: 'market.insufficient_funds',
      });
      expect(await rows(id)).toBe(1);
      expect([await buyer(), await pot(id)]).toEqual(['100', '0']);
      await fund(BUYER, '50');
      expect(await service(ON).purchase({ buyerId: BUYER, listingId, purchaseId: id })).toMatchObject({ status: 'held' });
      expect([await buyer(), await pot(id)]).toEqual(['0', '150']);
    });

    it('a held subscription grants access from the hold; a refunded one does not', async () => {
      const listingId = await listing({ offerType: 'subscription' });
      const purchase = await held(listingId);
      const until = new Date(START.getTime() + 30 * 86_400 * 1000).toISOString();
      expect(purchase.accessUntil).toBe(until);
      await expect(service(ON).subscriptionAccess({ buyerId: BUYER, listingId })).resolves.toMatchObject({
        granted: true,
        accessUntil: until,
      });
      await service(ON).held.refund({ sellerUserId: SELLER, purchaseId: purchase.id });
      await expect(service(ON).subscriptionAccess({ buyerId: BUYER, listingId })).rejects.toMatchObject({
        code: 'market.subscription_no_access',
      });
    });

    it('a next subscription period waits until the held one is released, so a refund never leaves its period stacked', async () => {
      const listingId = await listing({ offerType: 'subscription' });
      const first = await held(listingId);
      const next = randomUUID();
      await expect(service(ON).purchase({ buyerId: BUYER, listingId, purchaseId: next })).rejects.toMatchObject({
        code: 'market.purchase_already_held',
      });
      expect(await rows(next)).toBe(0);
      expect(await buyer()).toBe('90');
      later(WINDOW);
      expect(await service(ON).held.sweep()).toEqual({ released: 1, refunded: 0, failed: 0 });
      const second = await service(ON).purchase({ buyerId: BUYER, listingId, purchaseId: next });
      expect(second).toMatchObject({ status: 'held' });
      expect(second.accessUntil).toBe(new Date(new Date(first.accessUntil!).getTime() + 30 * 86_400 * 1000).toISOString());
    });
  });

  describe('refund request', () => {
    it('the buyer asks once inside the window; a second ask keeps the first time', async () => {
      const purchase = await held(await listing());
      later(60);
      const asked = await service(ON).held.requestRefund({ buyerId: BUYER, purchaseId: purchase.id });
      expect(asked.refundRequestedAt).toBe(now.toISOString());
      later(60);
      const again = await service(ON).held.requestRefund({ buyerId: BUYER, purchaseId: purchase.id });
      expect(again.refundRequestedAt).toBe(asked.refundRequestedAt);
      expect((await service(ON).held.refundRequests(SELLER, 10)).map((p) => p.id)).toEqual([purchase.id]);
      expect(await service(ON).held.refundRequests(STRANGER, 10)).toEqual([]);
      expect([await buyer(), await pot(purchase.id)]).toEqual(['90', '10']);
    });

    it('refuses another user (market.purchase_not_found), after the window and on a pay-through purchase (market.refund_not_held)', async () => {
      const listingId = await listing();
      const purchase = await held(listingId);
      await expect(service(ON).held.requestRefund({ buyerId: STRANGER, purchaseId: purchase.id })).rejects.toMatchObject({
        code: 'market.purchase_not_found',
      });
      const paid = await service(undefined).purchase({ buyerId: BUYER, listingId, purchaseId: randomUUID() });
      await expect(service(ON).held.requestRefund({ buyerId: BUYER, purchaseId: paid.id })).rejects.toMatchObject({
        code: 'market.refund_not_held',
      });
      later(WINDOW);
      await expect(service(ON).held.requestRefund({ buyerId: BUYER, purchaseId: purchase.id })).rejects.toMatchObject({
        code: 'market.refund_not_held',
      });
    });
  });

  describe('refund', () => {
    it('the seller refunds inside the window: the whole price returns to the buyer once, under market:refund:<id>:1', async () => {
      const purchase = await held(await listing());
      await service(ON).held.requestRefund({ buyerId: BUYER, purchaseId: purchase.id });
      const refunded = await service(ON).held.refund({ sellerUserId: SELLER, purchaseId: purchase.id });
      const tx = await ledger.getTxByKey(`market:refund:${purchase.id}:1`);
      expect(refunded).toMatchObject({ status: 'refunded', outcome: 'refund', outcomeTxId: tx!.id, settledAt: null });
      expect([await buyer(), await pot(purchase.id), await seller(), await house()]).toEqual(['100', '0', '0', '0']);
      const again = await service(ON).held.refund({ sellerUserId: SELLER, purchaseId: purchase.id });
      expect(again).toMatchObject({ status: 'refunded', outcomeTxId: tx!.id });
      expect(await buyer()).toBe('100');
      expect(await service(ON).held.refundRequests(SELLER, 10)).toEqual([]);
    });

    it('refuses anyone but the seller (market.refund_forbidden), the buyer included, and nothing moves', async () => {
      const purchase = await held(await listing());
      for (const who of [BUYER, STRANGER]) {
        await expect(service(ON).held.refund({ sellerUserId: who, purchaseId: purchase.id })).rejects.toMatchObject({
          code: 'market.refund_forbidden',
        });
      }
      await expect(service(ON).held.refund({ sellerUserId: SELLER, purchaseId: randomUUID() })).rejects.toMatchObject({
        code: 'market.purchase_not_found',
      });
      expect([await buyer(), await pot(purchase.id)]).toEqual(['90', '10']);
      expect(await ledger.getTxByKey(`market:refund:${purchase.id}:1`)).toBeNull();
    });

    it('refuses a pay-through purchase, an expired window and a released purchase (market.refund_not_held)', async () => {
      const listingId = await listing();
      const paid = await service(undefined).purchase({ buyerId: BUYER, listingId, purchaseId: randomUUID() });
      await expect(service(ON).held.refund({ sellerUserId: SELLER, purchaseId: paid.id })).rejects.toMatchObject({
        code: 'market.refund_not_held',
      });
      const purchase = await held(listingId);
      later(WINDOW);
      await expect(service(ON).held.refund({ sellerUserId: SELLER, purchaseId: purchase.id })).rejects.toMatchObject({
        code: 'market.refund_not_held',
      });
      await service(ON).held.sweep();
      await expect(service(ON).held.refund({ sellerUserId: SELLER, purchaseId: purchase.id })).rejects.toMatchObject({
        code: 'market.refund_not_held',
      });
      expect(await ledger.getTxByKey(`market:refund:${purchase.id}:1`)).toBeNull();
    });

    it('a crash after the refund is claimed is finished by a retry or the sweep, with one refund', async () => {
      const listingId = await listing();
      const purchase = await held(listingId);
      const down = vi.spyOn(ledger, 'post').mockRejectedValueOnce(new Error('ledger down'));
      await expect(service(ON).held.refund({ sellerUserId: SELLER, purchaseId: purchase.id })).rejects.toThrow('ledger down');
      down.mockRestore();
      const [claimed] = await sql<
        Array<{ status: string; outcome: string }>
      >`SELECT status, outcome FROM market.purchases WHERE id = ${purchase.id}`;
      expect(claimed).toEqual({ status: 'held', outcome: 'refund' });
      // The window ends before anyone retries: the claimed refund still wins over a release.
      later(WINDOW);
      expect(await service(ON).held.sweep()).toEqual({ released: 0, refunded: 1, failed: 0 });
      expect([await buyer(), await pot(purchase.id), await seller()]).toEqual(['100', '0', '0']);
      expect(await ledger.getTxByKey(`market:release:${purchase.id}`)).toBeNull();

      // A lost reply on the refund post: the retry gets the original transaction.
      now = START;
      const second = await held(listingId);
      const real = ledger.post.bind(ledger);
      const lost = vi.spyOn(ledger, 'post').mockImplementationOnce(async (request) => {
        await real(request);
        throw new Error('reply lost');
      });
      await expect(service(ON).held.refund({ sellerUserId: SELLER, purchaseId: second.id })).rejects.toThrow('reply lost');
      lost.mockRestore();
      const tx = await ledger.getTxByKey(`market:refund:${second.id}:1`);
      expect(await service(ON).held.refund({ sellerUserId: SELLER, purchaseId: second.id })).toMatchObject({
        status: 'refunded',
        outcomeTxId: tx!.id,
      });
      expect([await buyer(), await pot(second.id)]).toEqual(['100', '0']);
    });
  });

  describe('release', () => {
    it('nothing is released before the window ends', async () => {
      const purchase = await held(await listing());
      later(WINDOW - 1);
      expect(await service(ON).held.sweep()).toEqual({ released: 0, refunded: 0, failed: 0 });
      expect([await pot(purchase.id), await seller()]).toEqual(['10', '0']);
    });

    it('after the window the sweep pays the seller net and the house commission once, under market:release:<id>', async () => {
      const purchase = await held(await listing());
      const statusAtAccrue: string[] = [];
      accrue.mockImplementation(async () => {
        const [row] = await sql<Array<{ status: string }>>`SELECT status FROM market.purchases WHERE id = ${purchase.id}`;
        statusAtAccrue.push(row!.status);
      });
      later(WINDOW);
      expect(await service(ON).held.sweep()).toEqual({ released: 1, refunded: 0, failed: 0 });
      const tx = await ledger.getTxByKey(`market:release:${purchase.id}`);
      const [row] = await service(ON).purchasesOf(BUYER, { limit: 10 });
      expect(row).toMatchObject({
        id: purchase.id,
        status: 'released',
        outcome: 'release',
        outcomeTxId: tx!.id,
        settledAt: now.toISOString(),
      });
      expect(tx!.meta).toMatchObject({
        commissionBps: 500,
        commission: parseAmount('0.5').toString(),
        vendorNet: parseAmount('9.5').toString(),
      });
      expect([await buyer(), await pot(purchase.id), await seller(), await house()]).toEqual(['90', '0', '9.5', '0.5']);
      expect(accrue).toHaveBeenCalledTimes(1);
      // The legs go before the row is marked released, so a crash between them leaves a held row the sweep finishes.
      expect(statusAtAccrue).toEqual(['held']);
      expect(payout).toHaveBeenCalledTimes(1);
      expect(await service(ON).held.sweep()).toEqual({ released: 0, refunded: 0, failed: 0 });
      expect(await seller()).toBe('9.5');
      expect(accrue).toHaveBeenCalledTimes(1);
    });

    it("one row's failure leaves it held for the next sweep and does not stop the others", async () => {
      const listingId = await listing();
      const first = await held(listingId);
      const second = await held(listingId);
      later(WINDOW);
      const down = vi.spyOn(ledger, 'post').mockRejectedValueOnce(new Error('ledger down'));
      expect(await service(ON).held.sweep()).toEqual({ released: 1, refunded: 0, failed: 1 });
      down.mockRestore();
      expect(sweepErrors).toHaveLength(1);
      const stuck = sweepErrors[0]!.purchaseId;
      expect([first.id, second.id]).toContain(stuck);
      const [row] = await sql<Array<{ status: string; outcome: string }>>`SELECT status, outcome FROM market.purchases WHERE id = ${stuck}`;
      expect(row).toEqual({ status: 'held', outcome: 'release' });
      expect(await service(ON).held.sweep()).toEqual({ released: 1, refunded: 0, failed: 0 });
      expect([await pot(first.id), await pot(second.id), await seller(), await house()]).toEqual(['0', '0', '19', '1']);
    });

    it('rows that keep failing never fill every sweep: a good row behind them is still released', async () => {
      const listingId = await listing();
      const stuck = [await held(listingId), await held(listingId)];
      later(1);
      const good = await held(listingId);
      later(WINDOW);
      const real = ledger.post.bind(ledger);
      const frozen = vi.spyOn(ledger, 'post').mockImplementation(async (request) => {
        if (stuck.some((p) => request.idempotencyKey === `market:release:${p.id}`)) throw new Error('seller account frozen');
        return real(request);
      });
      // Two rows per sweep, the two stuck ones first by window end: the good row is reached all the same.
      for (let round = 0; round < 40 && (await pot(good.id)) !== '0'; round += 1) await service(ON).held.sweep(2);
      frozen.mockRestore();
      expect([await pot(good.id), await pot(stuck[0]!.id), await pot(stuck[1]!.id)]).toEqual(['0', '10', '10']);
    });

    it("a pot short of the price is reported as market.held_pot_short, never as the buyer's balance", async () => {
      const listingId = await listing();
      const released = await held(listingId);
      const refunded = await held(listingId);
      const short = () => Object.assign(new Error('Insufficient USDT'), { code: 'ledger.insufficient_funds' });
      const refuse = vi.spyOn(ledger, 'post').mockRejectedValueOnce(short());
      await expect(service(ON).held.refund({ sellerUserId: SELLER, purchaseId: refunded.id })).rejects.toMatchObject({
        code: 'market.held_pot_short',
      });
      refuse.mockRestore();
      later(WINDOW);
      const refuseAgain = vi.spyOn(ledger, 'post').mockRejectedValue(short());
      expect(await service(ON).held.sweep()).toEqual({ released: 0, refunded: 0, failed: 2 });
      refuseAgain.mockRestore();
      expect(sweepErrors.map((e) => (e.err as { code?: string }).code)).toEqual(['market.held_pot_short', 'market.held_pot_short']);
      expect([await pot(released.id), await pot(refunded.id), await buyer()]).toEqual(['10', '10', '80']);
    });

    it('a lost reply on the release post is finished by the next sweep with one release', async () => {
      const purchase = await held(await listing());
      later(WINDOW);
      const real = ledger.post.bind(ledger);
      const lost = vi.spyOn(ledger, 'post').mockImplementationOnce(async (request) => {
        await real(request);
        throw new Error('reply lost');
      });
      expect(await service(ON).held.sweep()).toEqual({ released: 0, refunded: 0, failed: 1 });
      lost.mockRestore();
      expect(await service(ON).held.sweep()).toEqual({ released: 1, refunded: 0, failed: 0 });
      expect([await pot(purchase.id), await seller(), await house()]).toEqual(['0', '9.5', '0.5']);
    });
  });

  describe('a refund and a release race', () => {
    it('exactly one wins, every time, and the pot ends at zero', async () => {
      const listingId = await listing();
      for (let round = 0; round < 6; round += 1) {
        now = START;
        const purchase = await held(listingId);
        const ends = new Date(purchase.refundWindowEndsAt!);
        const seller_ = service(ON, () => new Date(ends.getTime() - 1));
        const sweeper = service(ON, () => ends);
        const [refund, sweep] = await Promise.allSettled([
          seller_.held.refund({ sellerUserId: SELLER, purchaseId: purchase.id }),
          sweeper.held.sweep(),
        ]);
        // The sweep may finish a refund the seller claimed first; the loser either refuses or finds no row to release.
        const finished = await sweeper.held.sweep();
        expect(finished.failed).toBe(0);
        const [row] = await sql<
          Array<{ status: string; outcome: string }>
        >`SELECT status, outcome FROM market.purchases WHERE id = ${purchase.id}`;
        const refundTx = await ledger.getTxByKey(`market:refund:${purchase.id}:1`);
        const releaseTx = await ledger.getTxByKey(`market:release:${purchase.id}`);
        expect([refundTx, releaseTx].filter(Boolean)).toHaveLength(1);
        if (row!.status === 'refunded') {
          expect(refund.status).toBe('fulfilled');
          expect(releaseTx).toBeNull();
        } else {
          expect(row).toEqual({ status: 'released', outcome: 'release' });
          expect(refund).toMatchObject({ status: 'rejected', reason: { code: 'market.refund_not_held' } });
          expect(refundTx).toBeNull();
        }
        expect(sweep.status).toBe('fulfilled');
        expect(await pot(purchase.id)).toBe('0');
      }
    });

    it('the database refuses a second outcome and a finish that does not match the claimed one', async () => {
      const purchase = await held(await listing());
      await sql`UPDATE market.purchases SET outcome = 'release' WHERE id = ${purchase.id}`;
      expect(await sqlState(() => sql`UPDATE market.purchases SET outcome = 'refund' WHERE id = ${purchase.id}`)).toBe('23514');
      expect(await sqlState(() => sql`UPDATE market.purchases SET outcome = NULL WHERE id = ${purchase.id}`)).toBe('23514');
      expect(
        await sqlState(
          () =>
            sql`UPDATE market.purchases SET status = 'refunded', outcome_tx_id = ${randomUUID()}, outcome_at = now() WHERE id = ${purchase.id}`,
        ),
      ).toBe('23514');
    });
  });

  describe('schema', () => {
    it('refuses rows whose flow and status disagree, and illegal transitions', async () => {
      const listingId = await listing();
      const purchase = await held(listingId);
      const paid = await service(undefined).purchase({ buyerId: BUYER, listingId, purchaseId: randomUUID() });
      // A flow, window, charge or hold time once written never changes.
      expect(
        await sqlState(() => sql`UPDATE market.purchases SET flow = 'pay', refund_window_seconds = NULL WHERE id = ${purchase.id}`),
      ).toBe('23514');
      expect(
        await sqlState(() => sql`UPDATE market.purchases SET refund_window_ends_at = now() + interval '1 year' WHERE id = ${purchase.id}`),
      ).toBe('23514');
      expect(await sqlState(() => sql`UPDATE market.purchases SET ledger_tx_id = ${randomUUID()} WHERE id = ${purchase.id}`)).toBe('23514');
      // held → released needs a claimed release with its posting; settled stays terminal; settled needs flow pay.
      expect(
        await sqlState(
          () =>
            sql`UPDATE market.purchases SET status = 'released', outcome_tx_id = ${randomUUID()}, outcome_at = now(), settled_at = now() WHERE id = ${purchase.id}`,
        ),
      ).toBe('23514');
      expect(await sqlState(() => sql`UPDATE market.purchases SET status = 'held' WHERE id = ${paid.id}`)).toBe('23514');
      expect(await sqlState(() => sql`UPDATE market.purchases SET status = 'settled', settled_at = now() WHERE id = ${purchase.id}`)).toBe(
        '23514',
      );
      // Written directly, a released or refunded row without its claimed outcome is refused too (a NULL-safe check).
      for (const status of ['released', 'refunded'])
        expect(
          await sqlState(
            () => sql`
              INSERT INTO market.purchases (id, listing_id, buyer_id, vendor_id, vendor_user_id, asset_id, price, commission_bps,
                     status, ledger_tx_id, flow, refund_window_seconds, hold_posted_at, refund_window_ends_at, outcome_tx_id,
                     outcome_at, settled_at)
              SELECT ${randomUUID()}, listing_id, buyer_id, vendor_id, vendor_user_id, asset_id, price, commission_bps,
                     ${status}, ${randomUUID()}, 'hold', 60, now(), now(), ${randomUUID()}, now(),
                     ${status === 'released' ? new Date() : null}
                FROM market.purchases WHERE id = ${purchase.id}`,
          ),
        ).toBe('23514');
      // A pay-through purchase cannot carry a window, nor a held one lack it.
      expect(await sqlState(() => sql`UPDATE market.purchases SET refund_window_seconds = 60 WHERE id = ${paid.id}`)).toBe('23514');
    });

    it('the down migration refuses while a held purchase exists, and leaves the schema as it was', async () => {
      const purchase = await held(await listing());
      const down = readFileSync(join(drizzle, `${HOLD_MIGRATION}.down.sql`), 'utf8');
      expect(await sqlState(() => sql.begin((tx) => tx.unsafe(down)))).toBe('23514');
      const [row] = await sql<Array<{ status: string; flow: string }>>`SELECT status, flow FROM market.purchases WHERE id = ${purchase.id}`;
      expect(row).toEqual({ status: 'held', flow: 'hold' });
    });
  });

  describe('what the seller and the operators read', () => {
    it('earnings count a sale only once released, citing the release; ops sales count a held purchase as pending', async () => {
      const listingId = await listing();
      const kept = await held(listingId);
      const refunded = await held(listingId);
      await service(ON).held.refund({ sellerUserId: SELLER, purchaseId: refunded.id });
      const window = {
        from: new Date(START.getTime() - 86_400_000).toISOString(),
        to: new Date(START.getTime() + 2 * 86_400_000).toISOString(),
      };
      expect((await service(ON).myEarnings({ userId: SELLER, ...window })).sales).toEqual([]);
      const before = await service(ON).opsSales({ actorScope: MARKET_OPS_SCOPE, limit: 10, ...window });
      expect(before).toMatchObject({ rows: [], pendingCount: '1', refusedCount: '0' });

      later(WINDOW);
      await service(ON).held.sweep();
      const releaseTx = await ledger.getTxByKey(`market:release:${kept.id}`);
      const earnings = await service(ON).myEarnings({ userId: SELLER, ...window });
      expect(earnings.sales).toEqual([
        expect.objectContaining({ purchaseId: kept.id, gross: '10', commission: '0.5', net: '9.5', ledgerTxId: releaseTx!.id }),
      ]);
      const after = await service(ON).opsSales({ actorScope: MARKET_OPS_SCOPE, limit: 10, ...window });
      expect(after).toMatchObject({
        pendingCount: '0',
        rows: [expect.objectContaining({ settledVolume: '10', settledCount: '1', commission: '0.5' })],
      });
    });
  });

  describe('invariant', () => {
    it('across held, refunded and released purchases every pot ends at zero and no unit is made or lost', async () => {
      const listingId = await listing();
      await fund(BUYER, '900');
      const purchases = [];
      for (let i = 0; i < 8; i += 1) purchases.push(await held(listingId));
      for (const p of purchases.filter((_, i) => i % 3 === 0)) await service(ON).held.refund({ sellerUserId: SELLER, purchaseId: p.id });
      await service(ON).held.requestRefund({ buyerId: BUYER, purchaseId: purchases[1]!.id });
      later(WINDOW);
      expect(await service(ON).held.sweep()).toEqual({ released: 5, refunded: 0, failed: 0 });
      for (const p of purchases) expect(await pot(p.id)).toBe('0');
      const total = [await buyer(), await seller(), await house()].map(parseAmount).reduce((a, b) => a + b, 0n);
      expect(formatAmount(total)).toBe('1000');
      expect([await buyer(), await seller(), await house()]).toEqual(['950', '47.5', '2.5']);
    });
  });
});
