/**
 * J-copy-bots-otc-23 #5 (review 3 on #6818): a cancel answers what the engine still held of the order, so a chase
 * re-price can tell a child the engine matched just before the cancel, whose fills land later.
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
import type { TradeServiceInternal } from './trade-service.js';
import { cancelOrderWithEngineAnswer } from './trade-service/order-change.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from './testing.js';
import type { Market } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const alice = principalFor(ALICE, ['trade:read', 'trade:write']);

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_cancel_engine_answer_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('a cancel answers what the engine still held (PG-hard)', () => {
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

  async function setup() {
    await db.sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    const matching = new StubMatching();
    const trade = new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    const market: Market = await trade.listMarket({
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
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'cea:u' }));
    const placed = await trade.placeOrder(alice, {
      marketId: market.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('50'),
      clientOrderId: 'cea-1',
    });
    // The service's own internals, as the algo engine's cancel port reaches them.
    const internal = (trade as unknown as { internal: TradeServiceInternal }).internal;
    return { trade, matching, market, placed, internal };
  }

  it("a cancel answers the engine's remaining quantity, not the order row's", async () => {
    const { matching, market, placed, internal } = await setup();
    // The engine matched 0.4 a moment ago; the taker's settlement has not written that fill yet.
    matching.scriptLive(placed.id, market.id, '0.6');
    const { order, engineLeftQty } = await cancelOrderWithEngineAnswer(internal, alice, placed.id);
    expect(engineLeftQty).toBe(amt('0.6'));
    expect(order.status).toBe('cancelled');
    expect(order.filledQty).toBe(0n);
  });

  it('an engine with no such live order answers 0: the whole order may have matched', async () => {
    const { matching, placed, internal } = await setup();
    matching.scriptCancelMiss(placed.id);
    const { order, engineLeftQty } = await cancelOrderWithEngineAnswer(internal, alice, placed.id);
    expect(engineLeftQty).toBe(0n);
    expect(order.status).toBe('cancelled');
  });

  it('cancelOrder still answers the order record alone, and a second cancel is refused', async () => {
    const { trade, placed, internal } = await setup();
    const cancelled = await trade.cancelOrder(alice, placed.id);
    expect(cancelled.id).toBe(placed.id);
    expect(cancelled.status).toBe('cancelled');
    await expect(cancelOrderWithEngineAnswer(internal, alice, placed.id)).rejects.toMatchObject({ code: 'trade.order_not_open' });
  });
});
