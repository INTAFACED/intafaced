/**
 * TRADE_MAX_OPEN_ORDERS: an owner cap on how many resting orders one user holds (PG-hard, never skipped).
 *
 * The cap is per user across every market. Unset means no cap is compared; a value that is set but is not a
 * whole number refuses new resting orders rather than silently turning the cap off. The integers below are
 * TEST FIXTURES, never product law.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toCcxtError } from '../ccxt-errors.js';
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

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_open_cap_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('TRADE_MAX_OPEN_ORDERS (PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let trade: TradeService;
  let matching: StubMatching;
  let ledger: MemoryLedger;
  let btc: Market;
  let eth: Market;
  const alice = principalFor(ALICE, ['trade:read', 'trade:write']);
  const bob = principalFor(BOB, ['trade:read', 'trade:write']);

  const rest = (p: typeof alice, market: Market, key: string, extra: Record<string, unknown> = {}) =>
    trade.placeOrder(p, {
      marketId: market.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('50'),
      clientOrderId: key,
      ...extra,
    } as never);
  const holds = () => ledger.journal().filter((tx) => tx.reason === 'order.hold').length;

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  }, 120_000);
  afterAll(async () => {
    delete process.env.TRADE_MAX_OPEN_ORDERS;
    await db?.drop();
    await stop();
  }, 30_000);
  afterEach(() => {
    delete process.env.TRADE_MAX_OPEN_ORDERS;
  });

  beforeEach(async () => {
    delete process.env.TRADE_MAX_OPEN_ORDERS;
    await db.sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    matching = new StubMatching();
    matching.asks = [['100', '5']];
    matching.bids = [['99', '5']];
    trade = new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    const list = (symbol: string, base: string) =>
      trade.listMarket({
        symbol,
        baseAsset: base,
        quoteAsset: 'USDT',
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        maxQty: amt('1000'),
        minNotional: amt('1'),
        makerBps: 10,
        takerBps: 20,
      });
    btc = await list('BTC/USDT', 'BTC');
    eth = await list('ETH/USDT', 'ETH');
    for (const user of [ALICE, BOB]) {
      await ledger.post(recipes.deposit({ userId: user, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: `${user}:u` }));
      await ledger.post(recipes.deposit({ userId: user, assetId: 'BTC', amount: amt('10'), rail: 'test', railRef: `${user}:b` }));
    }
  });

  it('with no cap published nothing is compared', async () => {
    for (let i = 0; i < 6; i += 1) await rest(alice, btc, `free-${i}`);
    expect(await db.sql`SELECT id FROM trade.orders WHERE user_id = ${ALICE}`).toHaveLength(6);
  });

  it('refuses the order past the cap with a typed 422, before any hold or row', async () => {
    process.env.TRADE_MAX_OPEN_ORDERS = '2';
    await rest(alice, btc, 'cap-1');
    await rest(alice, btc, 'cap-2');
    const holdsBefore = holds();
    let caught: unknown;
    try {
      await rest(alice, btc, 'cap-3');
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ name: 'TradeError', code: 'trade.limit_max_open_orders' });
    expect(String((caught as Error).message)).toContain('TRADE_MAX_OPEN_ORDERS');
    expect(toCcxtError(caught)?.status).toBe(422);
    expect(holds()).toBe(holdsBefore);
    expect(await db.sql`SELECT id FROM trade.orders WHERE client_order_id = 'cap-3'`).toHaveLength(0);
  });

  it('counts across every market, and per user', async () => {
    process.env.TRADE_MAX_OPEN_ORDERS = '2';
    await rest(alice, btc, 'x-1');
    await rest(alice, eth, 'x-2');
    await expect(rest(alice, eth, 'x-3')).rejects.toMatchObject({ code: 'trade.limit_max_open_orders' });
    await rest(bob, btc, 'bob-1');
    await rest(bob, btc, 'bob-2');
  });

  it('a cancel frees a slot, and a closed order never counted', async () => {
    process.env.TRADE_MAX_OPEN_ORDERS = '2';
    const first = await rest(alice, btc, 'free-1');
    await rest(alice, btc, 'free-2');
    await expect(rest(alice, btc, 'free-3')).rejects.toMatchObject({ code: 'trade.limit_max_open_orders' });
    await trade.cancelOrder(alice, first.id);
    await rest(alice, btc, 'free-3');
    await expect(rest(alice, btc, 'free-4')).rejects.toMatchObject({ code: 'trade.limit_max_open_orders' });
  });

  it('a retry of an order that already exists is not newly refused', async () => {
    process.env.TRADE_MAX_OPEN_ORDERS = '2';
    const first = await rest(alice, btc, 'retry-1');
    await rest(alice, btc, 'retry-2');
    const again = await rest(alice, btc, 'retry-1');
    expect(again.id).toBe(first.id);
  });

  it('orders that cannot rest (immediate-or-cancel, fill-or-kill, market) and reduce-only orders are exempt', async () => {
    process.env.TRADE_MAX_OPEN_ORDERS = '1';
    await rest(alice, btc, 'rest-1');
    await expect(rest(alice, btc, 'rest-2')).rejects.toMatchObject({ code: 'trade.limit_max_open_orders' });
    await rest(alice, btc, 'ioc', { tif: 'IOC' });
    await rest(alice, btc, 'fok', { tif: 'FOK' });
    await trade.placeOrder(alice, { marketId: btc.id, side: 'sell', type: 'market', qty: amt('1'), clientOrderId: 'mkt' } as never);
    await rest(alice, btc, 'reduce', { reduceOnly: true });
  });

  it('a cap that is set but not a whole number refuses new resting orders instead of turning the cap off', async () => {
    for (const bad of ['abc', '1.5', '-1', '2e3']) {
      process.env.TRADE_MAX_OPEN_ORDERS = bad;
      await expect(rest(alice, btc, `bad-${bad}`), bad).rejects.toMatchObject({ code: 'trade.max_open_orders_invalid' });
    }
    process.env.TRADE_MAX_OPEN_ORDERS = '   ';
    await rest(alice, btc, 'blank-is-unset');
  });

  it('a published 0 refuses every new resting order', async () => {
    process.env.TRADE_MAX_OPEN_ORDERS = '0';
    await expect(rest(alice, btc, 'zero')).rejects.toMatchObject({ code: 'trade.limit_max_open_orders' });
  });
});
