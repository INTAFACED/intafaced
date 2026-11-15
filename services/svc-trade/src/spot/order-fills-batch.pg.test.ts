/**
 * #4677: the order reads take every fill of several orders in one read (`everyFillOfOrders`), so an order's cost,
 * average and fee are what its fills paid. Only the caller's own fills come back, grouped by order, oldest first.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TradeService } from '../controls/test-admission.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from './testing.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '33333333-3333-4333-8333-333333333333';
const alice = principalFor(ALICE, ['trade:read', 'trade:write']);

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_order_fills_batch_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('everyFillOfOrders (PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  it('reads the caller’s fills of several orders in one read, grouped by order, oldest first', async () => {
    await db.sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    const trade = new TradeService(db.sql, ledger, new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    const market = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.0001'),
      minQty: amt('0.0001'),
      maxQty: amt('1000'),
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'ofb:u' }));
    const base = { marketId: market.id, side: 'buy' as const, type: 'limit' as const, qty: amt('1'), price: amt('50') };
    const a = await trade.placeOrder(alice, { ...base, clientOrderId: 'ofb-a' });
    const b = await trade.placeOrder(alice, { ...base, clientOrderId: 'ofb-b' });
    const c = await trade.placeOrder(alice, { ...base, clientOrderId: 'ofb-c' });

    const insert = (id: string, orderId: string, userId: string, sequence: number, qty: string, quote: string, ts: string) => db.sql`
      INSERT INTO trade.fills (id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence, ts)
      VALUES (${id}, ${orderId}, ${c.id}, ${market.id}, ${userId}, 'buy', 'taker',
        '50'::numeric, ${qty}::numeric, ${quote}::numeric, 'BTC', '0.0001'::numeric, 20, ${sequence}, ${ts}::timestamptz)`;
    await insert('f0000000-0000-4000-8000-000000000002', a.id, ALICE, 2, '0.4', '20', '2026-01-01T00:00:02Z');
    await insert('f0000000-0000-4000-8000-000000000001', a.id, ALICE, 1, '0.6', '30', '2026-01-01T00:00:01Z');
    await insert('f0000000-0000-4000-8000-000000000003', b.id, ALICE, 3, '1', '50', '2026-01-01T00:00:03Z');
    // Someone else's row on a's id is never the caller's fill.
    await insert('f0000000-0000-4000-8000-000000000004', a.id, BOB, 4, '9', '450', '2026-01-01T00:00:04Z');

    const got = await trade.everyFillOfOrders(alice, [a.id, b.id, c.id]);
    expect([...got.keys()].sort()).toEqual([a.id, b.id].sort());
    expect(got.get(a.id)!.map((f) => [f.id, f.qty])).toEqual([
      ['f0000000-0000-4000-8000-000000000001', amt('0.6')],
      ['f0000000-0000-4000-8000-000000000002', amt('0.4')],
    ]);
    expect(got.get(b.id)!.map((f) => f.quoteAmount)).toEqual([amt('50')]);
    expect(got.has(c.id)).toBe(false);
    expect((await trade.everyFillOfOrders(alice, [])).size).toBe(0);
  });
});
