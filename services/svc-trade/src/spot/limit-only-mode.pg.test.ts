/**
 * Limit-only mode (PG-hard, never skipped): a market order is refused with `trade.mode_limit_only` before any hold
 * or order row; a limit order is accepted; an open market still takes a market order.
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
    .withDatabase('intafaced_limit_only_test')
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

describe('limit-only mode (PG-hard)', () => {
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

  it('refuses a market order with trade.mode_limit_only: no order row, no hold', async () => {
    const { trade, ledger, market } = await setup(lifecycleIn('LIMIT_ONLY'));
    const avail = async () => formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount);
    const before = await avail();
    expect(before).toBe('1000');
    await expect(
      trade.placeOrder(alice, { marketId: market.id, side: 'buy', type: 'market', qty: amt('1'), clientOrderId: 'lo-market' }),
    ).rejects.toMatchObject({ code: 'trade.mode_limit_only' });
    expect(await avail()).toBe(before);
    const rows = await db.sql`SELECT count(*)::int AS n FROM trade.orders`;
    expect(rows[0]?.n).toBe(0);
  });

  it('accepts a limit order', async () => {
    const { trade, market } = await setup(lifecycleIn('LIMIT_ONLY'));
    const order = await trade.placeOrder(alice, {
      marketId: market.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('50'),
      clientOrderId: 'lo-limit',
    });
    expect(order.type).toBe('limit');
    expect(order.status).not.toBe('rejected');
  });

  it('an open market still takes a market order (the refusal is the mode’s, not market orders’)', async () => {
    const { trade, market } = await setup(READY_MARKET_LIFECYCLE);
    let code: string | null = null;
    try {
      await trade.placeOrder(alice, { marketId: market.id, side: 'buy', type: 'market', qty: amt('1'), clientOrderId: 'open-market' });
    } catch (err) {
      code = (err as { code?: string }).code ?? null;
    }
    expect(code).not.toBe('trade.mode_limit_only');
  });
});
