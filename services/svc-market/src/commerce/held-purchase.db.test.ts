import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  formatAmount,
  houseFees,
  marketPurchaseEscrowAccount,
  MemoryLedger,
  parseAmount,
  recipes,
  userAvailable,
} from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MARKET_OPS_SCOPE, VendorService } from '../vendor-service.js';
import { CommerceService } from './commerce-service.js';

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

  it('refuses the 0012 reversal while any purchase was claimed with a refund window', async () => {
    await held.purchase({ buyerId: BUYER, listingId, purchaseId: randomUUID() });
    await expect(sql.begin((tx) => tx.unsafe(down0012))).rejects.toMatchObject({ code: '23514' });
    const [table] = await sql<Array<{ t: string | null }>>`SELECT to_regclass('market.purchase_holds')::text AS t`;
    expect(table!.t).toBe('purchase_holds');
  });
});
