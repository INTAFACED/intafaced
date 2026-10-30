/**
 * J-copy-bots-otc-23 #5 (review 3 on #6818): a cancel never closes an order, or releases its hold, while the engine
 * has matched more of it than its fills show: the taker's settlement writes that fill after the cancel.
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

describe('a cancel waits for a matched fill (PG-hard)', () => {
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
    const row = async () =>
      (
        await db.sql<Array<{ status: string; left: string | null; absent: boolean }>>`
          SELECT status, engine_left_qty::text AS left, engine_absent_at_cancel AS absent FROM trade.orders WHERE id = ${placed.id}
        `
      )[0]!;
    const held = async () =>
      (await ledger.balances('user', ALICE))
        .filter((b) => b.account.kind === 'hold' && b.account.assetId === 'USDT')
        .reduce((acc, b) => acc + b.amount, 0n);
    return { trade, matching, market, placed, row, held };
  }

  it('the engine matched part just before the cancel: the order stays open and keeps its hold until the fill lands', async () => {
    const { trade, matching, market, placed, row, held } = await setup();
    const before = await held();
    expect(before).toBe(amt('50'));
    // The engine matched 0.4 a moment ago; the taker's settlement has not written that fill yet.
    matching.scriptLive(placed.id, market.id, '0.6');
    const answered = await trade.cancelOrder(alice, placed.id);
    expect(answered.status).toBe('open');
    expect(await row()).toEqual({ status: 'open', left: '0.600000000000000000', absent: false });
    expect(await held()).toBe(before);
    // A second cancel finds no live order at the engine, reads the first answer and still keeps the hold.
    expect((await trade.cancelOrder(alice, placed.id)).status).toBe('open');
    expect(await row()).toEqual({ status: 'open', left: '0.600000000000000000', absent: false });
    expect(await held()).toBe(before);
    // The engine's own cancel event waits for the same fill.
    await expect(trade.releaseOnCancelEvent(placed.id, '0.6', 'requested')).rejects.toMatchObject({ code: 'trade.cancel_ahead_of_fill' });
    expect(await held()).toBe(before);
  });

  it('nothing matched: the cancel closes the order and releases its hold at once, as before', async () => {
    const { trade, matching, market, placed, row, held } = await setup();
    matching.scriptLive(placed.id, market.id, '1');
    expect((await trade.cancelOrder(alice, placed.id)).status).toBe('cancelled');
    expect(await row()).toEqual({ status: 'cancelled', left: '1.000000000000000000', absent: false });
    expect(await held()).toBe(0n);
  });

  it('no live order and no earlier answer: it closes and releases as before, and says so on the row', async () => {
    const { trade, matching, placed, row, held } = await setup();
    matching.scriptCancelMiss(placed.id);
    expect((await trade.cancelOrder(alice, placed.id)).status).toBe('cancelled');
    expect(await row()).toEqual({ status: 'cancelled', left: null, absent: true });
    expect(await held()).toBe(0n);
  });

  it("an engine cancel event's answer, landed first, is what a later cancel reads", async () => {
    const { trade, matching, placed, row, held } = await setup();
    // The engine pulled the order itself with nothing matched; its event closed it.
    await trade.releaseOnCancelEvent(placed.id, '1', 'self_trade_prevention');
    expect(await row()).toEqual({ status: 'cancelled', left: '1.000000000000000000', absent: false });
    expect(await held()).toBe(0n);
    matching.scriptCancelMiss(placed.id);
    await expect(trade.cancelOrder(alice, placed.id)).rejects.toMatchObject({ code: 'trade.order_not_open' });
  });
});
