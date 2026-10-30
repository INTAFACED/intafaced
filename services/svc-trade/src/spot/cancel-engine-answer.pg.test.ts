/**
 * J-copy-bots-otc-23 #5 (review 3 on #6818): an order row keeps what the engine still held when it took the order off
 * the book, so a chase re-price never places again what the engine matched just before the cancel.
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

describe('engine_left_qty: what the engine still held at a cancel (PG-hard)', () => {
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
    const engineLeft = async () =>
      (await db.sql<Array<{ q: string | null }>>`SELECT engine_left_qty::text AS q FROM trade.orders WHERE id = ${placed.id}`)[0]!.q;
    return { trade, matching, market, placed, engineLeft };
  }

  it("a cancel keeps the engine's remaining quantity on the order row, not the row's own counter", async () => {
    const { trade, matching, market, placed, engineLeft } = await setup();
    expect(await engineLeft()).toBeNull();
    // The engine matched 0.4 a moment ago; the taker's settlement has not written that fill yet.
    matching.scriptLive(placed.id, market.id, '0.6');
    const order = await trade.cancelOrder(alice, placed.id);
    expect(order.status).toBe('cancelled');
    expect(order.filledQty).toBe(0n);
    expect(amt((await engineLeft())!)).toBe(amt('0.6'));
  });

  it('an acknowledged order the engine no longer has keeps 0: the whole order may have matched', async () => {
    const { trade, matching, placed, engineLeft } = await setup();
    matching.scriptCancelMiss(placed.id);
    expect((await trade.cancelOrder(alice, placed.id)).status).toBe('cancelled');
    expect(amt((await engineLeft())!)).toBe(0n);
  });

  it("the engine's own cancel event writes its real remainder over a cancel's 0", async () => {
    const { trade, matching, placed, engineLeft } = await setup();
    matching.scriptCancelMiss(placed.id);
    await trade.cancelOrder(alice, placed.id);
    // The engine had pulled the order itself (a self-trade pull) and its event lands after the person's cancel.
    await trade.releaseOnCancelEvent(placed.id, '1', 'self_trade_prevention');
    expect(amt((await engineLeft())!)).toBe(amt('1'));
  });

  it('a repeated cancel never overwrites the first answer', async () => {
    const { trade, matching, market, placed, engineLeft } = await setup();
    matching.scriptLive(placed.id, market.id, '0.6');
    await trade.cancelOrder(alice, placed.id);
    await expect(trade.cancelOrder(alice, placed.id)).rejects.toMatchObject({ code: 'trade.order_not_open' });
    expect(amt((await engineLeft())!)).toBe(amt('0.6'));
  });
});
