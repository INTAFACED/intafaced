/**
 * An order tag is stored on the row and read back: a label for the caller, never part of the idempotency key.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import type { MarketStateSnapshot } from '@intafaced/exchange-contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TradeService } from '../controls/test-admission.js';
import { decideMarketAction, type MarketLifecyclePort } from '../market-lifecycle.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from './testing.js';
import type { Market } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_order_tag_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

/** The same fixture as an open market, with the stored mode changed. */
function lifecycleIn(state: MarketStateSnapshot['state']): MarketLifecyclePort {
  return {
    snapshot: (market, options) => ({ ...READY_MARKET_LIFECYCLE.snapshot(market, options), state }) as MarketStateSnapshot,
    admit: (snapshot, action) => decideMarketAction(snapshot, action),
  };
}

describe('order tag (PG-hard)', () => {
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

  async function setup(lifecycle: MarketLifecyclePort) {
    await db.sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    const trade = new TradeService(db.sql, ledger, new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: lifecycle,
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
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'lo:u' }));
    return { trade, ledger, market };
  }

  const alice = principalFor(ALICE, ['trade:read', 'trade:write']);

  it('stores the tag on the order and a retry with another tag returns the first order', async () => {
    const { trade, market } = await setup(lifecycleIn('OPEN'));
    const base = { marketId: market.id, side: 'buy' as const, type: 'limit', qty: amt('1'), price: amt('50'), clientOrderId: 'tag-1' };
    const first = await trade.placeOrder(alice, { ...base, tag: 'desk-1' });
    expect(first.tag).toBe('desk-1');
    const [row] = await db.sql<Array<{ tag: string | null }>>`SELECT tag FROM trade.orders WHERE id = ${first.id}`;
    expect(row?.tag).toBe('desk-1');
    const retry = await trade.placeOrder(alice, { ...base, tag: 'desk-2' });
    expect(retry.id).toBe(first.id);
    expect(retry.tag).toBe('desk-1');
  });

  it('keeps tag null when none was sent, and the column refuses a 17 character label', async () => {
    const { trade, market } = await setup(lifecycleIn('OPEN'));
    const order = await trade.placeOrder(alice, {
      marketId: market.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('50'),
      clientOrderId: 'tag-2',
    });
    expect(order.tag).toBeNull();
    await expect(db.sql`UPDATE trade.orders SET tag = ${'x'.repeat(17)} WHERE id = ${order.id}`).rejects.toThrow();
  });
});
