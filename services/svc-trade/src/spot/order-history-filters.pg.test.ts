/**
 * orderHistory filters by side, status and an inclusive until, with since, in SQL (PG-hard, never skipped).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TradeService } from '../controls/test-admission.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from './testing.js';
import type { Market } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const T1 = Date.parse('2026-10-01T00:00:00.000Z');
const T2 = Date.parse('2026-10-02T00:00:00.000Z');
const T3 = Date.parse('2026-10-03T00:00:00.000Z');

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_history_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('orderHistory filters (PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let trade: TradeService;
  let market: Market;
  let ids: { a: string; b: string; c: string; other: string };
  const alice = principalFor(ALICE, ['trade:read', 'trade:write']);
  const history = async (extra: Record<string, unknown> = {}) =>
    (await trade.orderHistory(alice, { limit: 50, ...extra } as never)).map((o) => o.id);

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    trade = new TradeService(db.sql, ledger, new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    market = await trade.listMarket({
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
    for (const user of [ALICE, BOB]) {
      await ledger.post(recipes.deposit({ userId: user, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: `${user}:u` }));
      await ledger.post(recipes.deposit({ userId: user, assetId: 'BTC', amount: amt('10'), rail: 'test', railRef: `${user}:b` }));
    }
    const limit = (p: ReturnType<typeof principalFor>, side: 'buy' | 'sell', price: string, key: string) =>
      trade.placeOrder(p, { marketId: market.id, side, type: 'limit', qty: amt('1'), price: amt(price), clientOrderId: key });
    const a = await limit(alice, 'buy', '50', 'hist-a');
    const b = await limit(alice, 'buy', '51', 'hist-b');
    const c = await limit(alice, 'sell', '200', 'hist-c');
    const other = await limit(principalFor(BOB, ['trade:read', 'trade:write']), 'buy', '52', 'hist-bob');
    for (const o of [a, b, c]) await trade.cancelOrder(alice, o.id);
    // b closed as filled; a, c stay cancelled; created_at fixed so the windows are exact.
    await db.sql`UPDATE trade.orders SET status = 'filled' WHERE id = ${b.id}`;
    await db.sql`UPDATE trade.orders SET created_at = ${new Date(T1)} WHERE id = ${a.id}`;
    await db.sql`UPDATE trade.orders SET created_at = ${new Date(T2)} WHERE id = ${b.id}`;
    await db.sql`UPDATE trade.orders SET created_at = ${new Date(T3)} WHERE id = ${c.id}`;
    ids = { a: a.id, b: b.id, c: c.id, other: other.id };
  });

  it('with no filter returns the caller’s terminal orders, newest first, never another user’s', async () => {
    expect(await history()).toEqual([ids.c, ids.b, ids.a]);
  });

  it('filters by side', async () => {
    expect(await history({ side: 'buy' })).toEqual([ids.b, ids.a]);
    expect(await history({ side: 'sell' })).toEqual([ids.c]);
  });

  it('filters by status', async () => {
    expect(await history({ status: 'filled' })).toEqual([ids.b]);
    expect(await history({ status: 'cancelled' })).toEqual([ids.c, ids.a]);
    expect(await history({ status: 'rejected' })).toEqual([]);
  });

  it('until is inclusive and pairs with since to page a window', async () => {
    expect(await history({ untilMs: T2 })).toEqual([ids.b, ids.a]);
    expect(await history({ sinceMs: T2, untilMs: T2 })).toEqual([ids.b]);
    expect(await history({ untilMs: T1 - 1 })).toEqual([]);
  });

  it('filters combine, and a symbol filter still applies', async () => {
    expect(await history({ side: 'buy', status: 'cancelled', untilMs: T2, marketId: market.id })).toEqual([ids.a]);
  });
});
