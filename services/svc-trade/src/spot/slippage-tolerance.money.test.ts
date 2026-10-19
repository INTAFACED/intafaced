/**
 * Per-order slippage tolerance on a market order (PG-hard, never skipped).
 *
 * The caller may only TIGHTEN the owner cap: the hold and the engine limit use the tighter protection price. A value
 * looser than the cap, malformed, or on a limit order is refused before any hold.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TradeService } from '../controls/test-admission.js';
import { carryPlacementBody } from './placement-extras.js';
import { protectionPriceFor, sellProtectionPriceFor } from './risk.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from './testing.js';
import type { Market } from './types.js';
import type { PlaceOrderInput } from './trade-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const OWNER_CAP_BPS = 200;

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_slippage_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('per-order slippage tolerance (PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let matching: StubMatching;
  let market: Market;

  const service = (marketSlippageCapBps: number | undefined) =>
    new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      ...(marketSlippageCapBps === undefined ? {} : { marketSlippageCapBps }),
    });
  const place = (trade: TradeService, side: 'buy' | 'sell', clientOrderId: string, body: Record<string, unknown>) =>
    trade.placeOrder(
      principalFor(ALICE),
      carryPlacementBody({ marketId: market.id, side, type: 'market', qty: amt('1'), clientOrderId } as PlaceOrderInput, body),
    );
  const avail = async (assetId: string) => formatAmount((await ledger.balance(userAvailable(ALICE, assetId))).amount);

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
    ledger = new MemoryLedger();
    matching = new StubMatching();
    matching.asks = [['100', '5']];
    matching.bids = [['99', '5']];
    market = await service(OWNER_CAP_BPS).listMarket({
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
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: `${ALICE}:usdt` }));
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'BTC', amount: amt('10'), rail: 'test', railRef: `${ALICE}:btc` }));
  });

  it('a market buy without a tolerance keeps the owner cap price', async () => {
    const trade = service(OWNER_CAP_BPS);
    await place(trade, 'buy', 'buy-plain', {});
    expect(matching.submitted.at(-1)?.request.price).toBe(formatAmount(protectionPriceFor(market, amt('100'), OWNER_CAP_BPS)));
  });

  it('a market buy with a tighter tolerance is funded and sent at the tighter price', async () => {
    const trade = service(OWNER_CAP_BPS);
    const tight = formatAmount(protectionPriceFor(market, amt('100'), 50));
    const loose = formatAmount(protectionPriceFor(market, amt('100'), OWNER_CAP_BPS));
    expect(amt(tight)).toBeLessThan(amt(loose));
    const order = await place(trade, 'buy', 'buy-tight', { maxSlippageBps: 50 });
    expect(matching.submitted.at(-1)?.request.price).toBe(tight);
    expect(order.protectionPrice).toBe(amt(tight));
    expect(await avail('USDT')).toBe(formatAmount(amt('1000') - amt(tight)));
  });

  it('a market sell with a tighter tolerance raises the price floor, never lowers it', async () => {
    const trade = service(OWNER_CAP_BPS);
    const floor = sellProtectionPriceFor(market, amt('99'), 50);
    expect(floor).toBeGreaterThan(sellProtectionPriceFor(market, amt('99'), OWNER_CAP_BPS));
    const order = await place(trade, 'sell', 'sell-tight', { maxSlippageBps: 50 });
    expect(order.protectionPrice).toBe(floor);
    expect(matching.submitted.at(-1)?.request.price).toBe(formatAmount(floor));
  });

  it('refuses a tolerance looser than the owner cap, malformed, or on a limit order, before any hold', async () => {
    const trade = service(OWNER_CAP_BPS);
    for (const [i, bad] of [OWNER_CAP_BPS + 1, 0, -5, 1.5, '50', Number.NaN].entries()) {
      await expect(place(trade, 'buy', `bad-${i}`, { maxSlippageBps: bad })).rejects.toMatchObject({
        code: 'trade.slippage_tolerance_invalid',
      });
    }
    await expect(
      trade.placeOrder(
        principalFor(ALICE),
        carryPlacementBody(
          {
            marketId: market.id,
            side: 'buy',
            type: 'limit',
            qty: amt('1'),
            price: amt('100'),
            clientOrderId: 'bad-limit',
          } as PlaceOrderInput,
          { maxSlippageBps: 50 },
        ),
      ),
    ).rejects.toMatchObject({ code: 'trade.slippage_tolerance_invalid' });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail('USDT')).toBe('1000');
    expect(ledger.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(0);
  });

  it('an unpublished owner cap still refuses; a tolerance never stands in for it', async () => {
    const trade = service(undefined);
    await expect(place(trade, 'buy', 'no-cap-buy', { maxSlippageBps: 50 })).rejects.toMatchObject({
      code: 'trade.slippage_cap_unset',
    });
    await expect(place(trade, 'sell', 'no-cap-sell', { maxSlippageBps: 50 })).rejects.toMatchObject({
      code: 'trade.protection_unset',
    });
    expect(matching.submitted).toHaveLength(0);
  });
});
