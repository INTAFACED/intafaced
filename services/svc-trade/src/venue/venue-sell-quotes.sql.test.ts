import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import { SqlVenueSellQuoteStore, presentVenueSellQuote, type VenueSellQuote } from './venue-sell-quotes.js';

/**
 * Convert's venue sell quotes on Postgres (J-cex-spot-17 #8, drizzle/20261110023522_venue_sell_quotes.sql): a quote is
 * stored exactly as the venue gave it, to the last of 18 decimals, written once under its business key, newest first, and
 * a figure the venue did not give stays not known. The database refuses a known figure with no amount, an unknown one
 * with an amount, and a fill larger than the sell.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The venue sell quote Postgres test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const a = parseAmount;
const T0 = new Date('2026-11-10T03:00:00.000Z');
const quote = (over: Partial<VenueSellQuote> = {}): VenueSellQuote => ({
  quoteId: 'venue-sell:user-1:quote-key-0001',
  userId: 'user-1',
  venueId: 'test-venue-sim',
  proofLevel: 'simulator',
  owner: '0x00000000000000000000000000000000000000c8',
  symbol: 'BTC-USDC',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  amount: a('1.5'),
  fill: { known: true, value: { amount: a('1.5'), averagePrice: a('59986.666666666666666666') } },
  venueFee: { known: true, value: { asset: 'USDC', amount: a('35.992') } },
  builderFee: { known: true, value: { asset: 'USDC', amount: a('8.998') } },
  asOf: new Date('2026-11-10T02:59:59.123Z'),
  createdAt: T0,
  ...over,
});

describe('SqlVenueSellQuoteStore (Postgres)', () => {
  let db: TestDatabase | undefined;
  let store: SqlVenueSellQuoteStore;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
    store = new SqlVenueSellQuoteStore(db.sql);
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);
  beforeEach(async () => {
    await db!.sql`TRUNCATE trade.venue_sell_quotes`;
  });

  it('stores the quote exactly as given and reads it back to the last decimal', async () => {
    const q = quote();
    expect(await store.insert(q)).toEqual(q);
    expect(await store.get(q.quoteId)).toEqual(q);
    expect(presentVenueSellQuote((await store.get(q.quoteId))!)).toMatchObject({
      test: true,
      amount: '1.5',
      fill: { known: true, amount: '1.5', averagePrice: '59986.666666666666666666' },
      venueFee: { known: true, asset: 'USDC', amount: '35.992' },
      builderFee: { known: true, asset: 'USDC', amount: '8.998' },
      asOf: '2026-11-10T02:59:59.123Z',
    });
  });

  it('writes a quote once: a second insert under the same key returns the first', async () => {
    const first = quote();
    await store.insert(first);
    const again = await store.insert(quote({ amount: a('2'), createdAt: new Date(T0.getTime() + 1000) }));
    expect(again).toEqual(first);
    expect(await store.latest(10)).toHaveLength(1);
  });

  it('keeps a figure the venue did not give as not known, never zero', async () => {
    const q = quote({ fill: { known: false }, venueFee: { known: false }, builderFee: { known: false } });
    expect(await store.insert(q)).toEqual(q);
    expect(presentVenueSellQuote((await store.get(q.quoteId))!)).toMatchObject({
      fill: { known: false },
      venueFee: { known: false },
      builderFee: { known: false },
    });
  });

  it('a book that takes none of the sell: filled 0 with no average price', async () => {
    const q = quote({ fill: { known: true, value: { amount: 0n, averagePrice: null } } });
    expect(await store.insert(q)).toEqual(q);
  });

  it('lists newest first', async () => {
    await store.insert(quote({ quoteId: 'venue-sell:user-1:old-key-0001', createdAt: T0 }));
    await store.insert(quote({ quoteId: 'venue-sell:user-1:new-key-0001', createdAt: new Date(T0.getTime() + 60_000) }));
    expect((await store.latest(10)).map((q) => q.quoteId)).toEqual(['venue-sell:user-1:new-key-0001', 'venue-sell:user-1:old-key-0001']);
    expect(await store.latest(1)).toHaveLength(1);
  });

  it('the database refuses a known figure with no amount, an unknown one with an amount, and a fill above the sell', async () => {
    const insertRaw = (over: Record<string, unknown>) => {
      const row = {
        quote_id: `venue-sell:user-1:raw-${Math.random().toString(36).slice(2, 10)}`,
        user_id: 'user-1',
        venue_id: 'test-venue-sim',
        proof_level: 'simulator',
        owner: '0x00000000000000000000000000000000000000c8',
        symbol: 'BTC-USDC',
        base_asset: 'BTC',
        quote_asset: 'USDC',
        amount: '1',
        fill_known: true,
        fill_amount: '1',
        fill_average_price: '60000',
        venue_fee_known: true,
        venue_fee_amount: '1',
        venue_fee_asset: 'USDC',
        builder_fee_known: true,
        builder_fee_amount: '1',
        builder_fee_asset: 'USDC',
        as_of: T0.toISOString(),
        created_at: T0.toISOString(),
        ...over,
      };
      return db!.sql`INSERT INTO trade.venue_sell_quotes ${db!.sql(row)}`;
    };
    await expect(insertRaw({})).resolves.toBeDefined();
    await expect(insertRaw({ fill_amount: null })).rejects.toThrow(/venue_sell_quotes_fill_ck/);
    await expect(insertRaw({ fill_known: false })).rejects.toThrow(/venue_sell_quotes_fill_ck/);
    await expect(insertRaw({ fill_amount: '1.000000000000000001' })).rejects.toThrow(/venue_sell_quotes_fill_ck/);
    await expect(insertRaw({ fill_amount: '0' })).rejects.toThrow(/venue_sell_quotes_fill_ck/);
    await expect(insertRaw({ venue_fee_amount: null })).rejects.toThrow(/venue_sell_quotes_venue_fee_ck/);
    await expect(insertRaw({ venue_fee_known: false })).rejects.toThrow(/venue_sell_quotes_venue_fee_ck/);
    await expect(insertRaw({ builder_fee_asset: null })).rejects.toThrow(/venue_sell_quotes_builder_fee_ck/);
    await expect(insertRaw({ builder_fee_known: false })).rejects.toThrow(/venue_sell_quotes_builder_fee_ck/);
    await expect(insertRaw({ amount: '0', fill_amount: '0', fill_average_price: null })).rejects.toThrow(/venue_sell_quotes_amount_ck/);
    await expect(insertRaw({ owner: '0xABC' })).rejects.toThrow(/venue_sell_quotes_owner_ck/);
  });
});
