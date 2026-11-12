/**
 * Signal listings and the one card payment for access (J-copy-bots-otc-21 #1 #2), against Postgres and the reference
 * ledger. The money: the partner takes the payment; our ledger records our revenue once and the partner's settlement
 * into our reserve there once; no customer account is touched; a crash or a lost answer at each point is finished by a
 * retry under the same keys, never charged or posted twice.
 *
 * Postgres: TEST_DATABASE_URL (CI), else the default local admin URL. A database that is down fails the suite.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, chargeReceivable, houseFees, parseAmount, partnerReserve, type LedgerClient } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MarketError } from '../vendor-service.js';
import { testCardPartner, type CardPartner } from './card-partner.js';
import { SignalMarket, paymentKey } from './signal-market.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';

let db: TestDatabase;
let sql: Sql;
let ledger: MemoryLedger;

beforeAll(async () => {
  db = await createTestDatabase({ service: 'market', migrations });
  sql = db.sql;
}, 120_000);
afterAll(async () => {
  await db?.drop();
}, 30_000);
beforeEach(async () => {
  await sql`TRUNCATE market.signal_payments, market.signal_listings`;
  ledger = new MemoryLedger();
});

const partner = () => testCardPartner('test', undefined);

async function listed(market: SignalMarket, price: string | null = '5') {
  return market.publish(PROVIDER, { clientListingId: 'l1', title: 'TEST signal', description: 'TEST', assetId: 'USDC', price });
}

async function revenue(l: LedgerClient) {
  return (await l.balance(houseFees('market', 'USDC'))).amount;
}
async function reserve(l: LedgerClient) {
  return (await l.balance(partnerReserve('test-card', 'USDC'))).amount;
}
async function owed(l: LedgerClient) {
  return (await l.balance(chargeReceivable('market', BUYER, 'USDC'))).amount;
}

describe('signal listings', () => {
  it('publishes once per client id, and lists in registration order with no payment and no access', async () => {
    const market = new SignalMarket(sql, ledger, partner());
    const a = await listed(market);
    const b = await listed(market);
    expect(b.id).toBe(a.id);
    const rows = await market.listings(BUYER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: a.id, price: '5', payment: null, access: false });
    expect(await market.access(a.id, BUYER)).toEqual({ access: false, title: 'TEST signal' });
  });

  it('refuses a price that is not an amount above zero', async () => {
    const market = new SignalMarket(sql, ledger, partner());
    await expect(listed(market, '0')).rejects.toMatchObject({ code: 'market.signal_price_invalid' });
  });
});

describe('the one card payment for access', () => {
  it('pays once: our revenue and the partner settlement each posted once, no customer balance touched, access granted', async () => {
    const market = new SignalMarket(sql, ledger, partner());
    const l = await listed(market);
    const first = await market.buy(BUYER, l.id);
    const second = await market.buy(BUYER, l.id);
    expect(second.paymentId).toBe(first.paymentId);
    expect(first).toMatchObject({ status: 'paid', method: 'card', partner: 'test-card', amount: '5', test: true });
    // Invariant: revenue up by the price once, our reserve at the partner holds it once (an own-funds place goes
    // below zero for money of ours there), and what the buyer owes us is back to zero.
    expect(await revenue(ledger)).toBe(parseAmount('5'));
    expect(await reserve(ledger)).toBe(-parseAmount('5'));
    expect(await owed(ledger)).toBe(0n);
    // No customer account exists for the buyer in our book.
    expect(await ledger.balances('user', BUYER)).toEqual([]);
    expect(await market.access(l.id, BUYER)).toEqual({ access: true, title: 'TEST signal' });
    expect(await market.payments(BUYER)).toHaveLength(1);
  });

  it('refuses a blank price, a missing partner, and the provider buying their own, writing nothing', async () => {
    const blank = new SignalMarket(sql, ledger, partner());
    const unpriced = await listed(blank, null);
    await expect(blank.buy(BUYER, unpriced.id)).rejects.toMatchObject({ code: 'market.signal_price_unset' });
    await sql`TRUNCATE market.signal_payments, market.signal_listings`;
    const none = new SignalMarket(sql, ledger, null);
    const l = await listed(none);
    await expect(none.buy(BUYER, l.id)).rejects.toMatchObject({ code: 'market.signal_payment_partner_unset' });
    await expect(none.buy(PROVIDER, l.id)).rejects.toMatchObject({ code: 'market.purchase_self' });
    await expect(none.buy(BUYER, '33333333-3333-4333-8333-333333333333')).rejects.toMatchObject({ code: 'market.listing_not_found' });
    expect(await sql`SELECT 1 FROM market.signal_payments`).toHaveLength(0);
    expect(await revenue(ledger)).toBe(0n);
  });

  it('a lost partner answer keeps the row pending and posts nothing; the retry asks under the same key and pays once', async () => {
    const keys: string[] = [];
    let fail = true;
    const flaky: CardPartner = {
      ...partner(),
      async pay(request) {
        keys.push(request.key);
        if (fail) throw new Error('socket hang up');
        return partner().pay(request);
      },
    };
    const market = new SignalMarket(sql, ledger, flaky);
    const l = await listed(market);
    await expect(market.buy(BUYER, l.id)).rejects.toMatchObject({ code: 'market.signal_payment_unknown' });
    const [row] = await sql<{ status: string }[]>`SELECT status FROM market.signal_payments`;
    expect(row!.status).toBe('pending');
    expect(await revenue(ledger)).toBe(0n);
    fail = false;
    expect((await market.buy(BUYER, l.id)).status).toBe('paid');
    expect(keys).toEqual([paymentKey(l.id, BUYER), paymentKey(l.id, BUYER)]);
    expect(await revenue(ledger)).toBe(parseAmount('5'));
  });

  it('a crash after the revenue post leaves the row approved; the next read finishes it under the same keys, once', async () => {
    let posts = 0;
    const crashing: LedgerClient = Object.assign(Object.create(ledger) as LedgerClient, {
      post: async (req: Parameters<LedgerClient['post']>[0]) => {
        posts += 1;
        if (posts === 2) throw new Error('connection reset');
        return ledger.post(req);
      },
    });
    const market = new SignalMarket(sql, crashing, partner());
    const l = await listed(market);
    await expect(market.buy(BUYER, l.id)).rejects.toMatchObject({ code: 'market.signal_payment_unknown' });
    const [row] = await sql<{ status: string }[]>`SELECT status FROM market.signal_payments`;
    expect(row!.status).toBe('approved');
    // Revenue earned, not yet collected: the buyer owes it (the receivable is below zero) and access is not granted.
    expect(await revenue(ledger)).toBe(parseAmount('5'));
    expect(await owed(ledger)).toBe(-parseAmount('5'));
    expect(await market.access(l.id, BUYER)).toEqual({ access: false, title: 'TEST signal' });
    const rows = await market.listings(BUYER);
    expect(rows[0]).toMatchObject({ access: true });
    expect(await revenue(ledger)).toBe(parseAmount('5'));
    expect(await reserve(ledger)).toBe(-parseAmount('5'));
    expect(await owed(ledger)).toBe(0n);
  });

  it('a declined payment posts nothing and grants no access', async () => {
    const declining: CardPartner = { ...partner(), pay: async () => ({ status: 'declined', code: 'card_declined' }) };
    const market = new SignalMarket(sql, ledger, declining);
    const l = await listed(market);
    expect(await market.buy(BUYER, l.id)).toMatchObject({ status: 'declined', code: 'card_declined' });
    expect(await revenue(ledger)).toBe(0n);
    expect(await market.access(l.id, BUYER)).toEqual({ access: false, title: 'TEST signal' });
  });

  it('the TEST partner card refuses to run outside APP_ENV dev or test', () => {
    expect(() => testCardPartner('production', undefined)).toThrow(/TEST partner card/);
    expect(() => testCardPartner('test', 'production')).toThrow(/TEST partner card/);
  });

  it('a ledger refusal is answered by its own code and leaves the row approved', async () => {
    const refusing: LedgerClient = Object.assign(Object.create(ledger) as LedgerClient, {
      post: async () => {
        const { LedgerError } = await import('@intafaced/ledger-client');
        throw new LedgerError('frozen', 'ledger.posting_frozen');
      },
    });
    const market = new SignalMarket(sql, refusing, partner());
    const l = await listed(market);
    const out = await market.buy(BUYER, l.id).catch((e: unknown) => e);
    expect(out).toBeInstanceOf(MarketError);
    expect(out).toMatchObject({ code: 'ledger.posting_frozen' });
    const [row] = await sql<{ status: string }[]>`SELECT status FROM market.signal_payments`;
    expect(row!.status).toBe('approved');
  });
});
