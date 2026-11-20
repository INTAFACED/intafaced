/**
 * The venue grid's store on real PostgreSQL (J-copy-bots-otc-14): a bot saved once and read back whole, the status moved
 * only from the states named, and each order row written once under its business key. Rows are TEST.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { gridClientOrderId } from './types.js';
import { SqlVenueGridStore, type VenueGridBot, type VenueGridOrder } from './venue-grid-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is required (runs/test-db.env). This suite does not start Docker.');
  const url = new URL(raw);
  if (url.pathname === '/test') url.pathname = '/intafaced_test';
  return url.toString();
}

const A = (v: string) => parseAmount(v);
const BOT = '5a5a5a5a-0000-5000-8000-0000000000a1';
const AT = new Date('2026-11-20T06:00:00Z');

const bot = (): VenueGridBot => ({
  botId: BOT,
  userId: '11111111-1111-4111-8111-111111111111',
  clientRequestId: 'grid-req-1',
  requestHash: 'h',
  venueId: 'test-venue',
  owner: '0x1111111111111111111111111111111111111111',
  agentAddress: '0x2222222222222222222222222222222222222222',
  region: 'DE',
  symbol: 'BTC-USDC',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  lowerPrice: A('59000'),
  upperPrice: A('61000'),
  gridCount: 2,
  investment: A('200'),
  levels: [
    { index: 0, price: A('59000'), qty: A('0.001'), hold: A('59') },
    { index: 1, price: A('61000'), qty: A('0.001'), hold: A('61') },
  ],
  status: 'signing',
  statusReason: null,
  createdAt: AT,
  updatedAt: AT,
});

const order = (): VenueGridOrder => ({
  orderKey: gridClientOrderId(BOT, 0, 'buy', 0),
  botId: BOT,
  levelIndex: 0,
  side: 'buy',
  cycle: 0,
  price: A('59000'),
  qty: A('0.001'),
  status: 'open',
  filled: A('0'),
  venueFee: A('0'),
  builderFee: A('0'),
  feeAsset: null,
  pairProfit: null,
  placedAt: AT,
  closedAt: null,
});

describe('SqlVenueGridStore (shared test postgres)', () => {
  let db: TestDatabase;
  let store: SqlVenueGridStore;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: testDatabaseUrl(), migrations });
    store = new SqlVenueGridStore(db.sql);
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.venue_grid_orders, trade.venue_grid_bots`;
  });

  it('saves a bot once and reads it back whole', async () => {
    expect((await store.insertOnce(bot())).created).toBe(true);
    const again = await store.insertOnce({ ...bot(), requestHash: 'other' });
    expect(again.created).toBe(false);
    expect(again.bot).toEqual(bot());
    expect(await store.listForUser(bot().userId)).toEqual([bot()]);
    // A signing bot waits for the person: the tick does not take it.
    expect(await store.live()).toEqual([]);
  });

  it('moves the status only from the states named', async () => {
    await store.insertOnce(bot());
    expect(await store.setStatus({ botId: BOT, status: 'running', reason: null, at: AT, from: ['initializing'] })).toBe(false);
    expect(await store.setStatus({ botId: BOT, status: 'initializing', reason: null, at: AT, from: ['signing'] })).toBe(true);
    expect(
      await store.setStatus({
        botId: BOT,
        status: 'paused_range',
        reason: 'mark_outside_range',
        at: AT,
        from: ['initializing', 'running'],
      }),
    ).toBe(true);
    expect((await store.find(BOT))?.statusReason).toBe('mark_outside_range');
    expect((await store.live()).map((b) => b.botId)).toEqual([BOT]);
  });

  it('writes each order once under its business key and keeps what the venue reported', async () => {
    await store.insertOnce(bot());
    expect(await store.insertOrder(order())).toEqual(order());
    expect(await store.insertOrder({ ...order(), price: A('1') })).toEqual(order());
    const filled = { ...order(), status: 'filled' as const, filled: A('0.001'), venueFee: A('0.0000001'), feeAsset: 'BTC', closedAt: AT };
    await store.updateOrder(filled);
    expect(await store.orders(BOT)).toEqual([filled]);
    // An order key that is not this bot's is refused by the table.
    await expect(store.insertOrder({ ...order(), orderKey: 'grid:other:0:b0' })).rejects.toThrow();
  });
});
