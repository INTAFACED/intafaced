import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable, orderHoldAccount } from '@intafaced/ledger-client';
import './oco-place.js';
import './oco-cancel.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import { type Market } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-trade oco-buy is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const tpOf = (id: string) => `${id}:tp`;
const slOf = (id: string) => `${id}:sl`;

describe('svc-trade buy OCO: one quote hold funds both legs at the worse price (H8a PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let matching: StubMatching;
  let trade: TradeService;
  let btcusdt: Market;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function fund(userId: string, assetId: string, amount: string) {
    await ledger.post(
      recipes.deposit({ userId, assetId, amount: amt(amount), rail: 'test', railRef: `${userId}:${assetId}:${amount}:${Math.random()}` }),
    );
  }
  const avail = async (userId: string, assetId: string) => formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
  const heldFor = async (userId: string, assetId: string, orderId: string) =>
    formatAmount((await ledger.balance(orderHoldAccount(userId, assetId, orderId))).amount);

  beforeEach(async () => {
    await sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    matching = new StubMatching();
    trade = new TradeService(sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    btcusdt = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.0001'),
      minQty: amt('0.0001'),
      maxQty: amt('1000'),
      minNotional: amt('1'),
      makerBps: 0,
      takerBps: 0,
    });
  });

  /** Take-profit buys at 90 (below the market), the stop triggers at 120 and may pay at most 125. */
  const buyOco = (over: Record<string, unknown> = {}) =>
    ({
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      clientOrderId: 'oco-buy-1',
      takeProfit: { stopPrice: '90' },
      stopLoss: { stopPrice: '120', price: '125' },
      ...over,
    }) as Parameters<TradeService['placeOrder']>[1];

  it('places one hold sized at the stop-loss limit (the worse of the two leg prices) and hands the engine the limit', async () => {
    await fund(ALICE, 'USDT', '1000');
    const placed = await trade.placeOrder(principalFor(ALICE), buyOco());
    expect(placed.status).toBe('open');
    expect(await heldFor(ALICE, 'USDT', placed.id)).toBe('125');
    expect(await avail(ALICE, 'USDT')).toBe('875');
    expect(matching.submitted).toHaveLength(1);
    expect(matching.submitted[0]?.request).toMatchObject({
      oco: true,
      side: 'buy',
      takeProfit: '90',
      stopLoss: '120',
      stopLossLimit: '125',
    });
  });

  it('ignores the price the caller typed on the parent: the legs set it', async () => {
    await fund(ALICE, 'USDT', '1000');
    const placed = await trade.placeOrder(principalFor(ALICE), buyOco({ price: amt('1') }));
    expect(await heldFor(ALICE, 'USDT', placed.id)).toBe('125');
  });

  it('refuses a buy OCO with no stop-loss limit: a market stop has no worst price to hold against', async () => {
    await fund(ALICE, 'USDT', '1000');
    await expect(trade.placeOrder(principalFor(ALICE), buyOco({ stopLoss: { stopPrice: '120' } }))).rejects.toMatchObject({
      code: 'trade.oco_stop_limit_required',
    });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  it('refuses a take-profit at or above the stop trigger', async () => {
    await fund(ALICE, 'USDT', '1000');
    await expect(trade.placeOrder(principalFor(ALICE), buyOco({ takeProfit: { stopPrice: '120' } }))).rejects.toMatchObject({
      code: 'trade.oco_price_order',
    });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  it('refuses a stop-loss limit below the stop trigger', async () => {
    await fund(ALICE, 'USDT', '1000');
    await expect(trade.placeOrder(principalFor(ALICE), buyOco({ stopLoss: { stopPrice: '120', price: '119' } }))).rejects.toMatchObject({
      code: 'trade.oco_price_order',
    });
    expect(matching.submitted).toHaveLength(0);
  });

  it('a sell OCO still goes to the engine as a market stop (no limit forwarded)', async () => {
    await fund(ALICE, 'BTC', '1');
    await trade.placeOrder(principalFor(ALICE), {
      marketId: btcusdt.id,
      side: 'sell',
      type: 'limit',
      qty: amt('1'),
      price: amt('110'),
      clientOrderId: 'oco-sell-1',
      takeProfit: { stopPrice: '110' },
      stopLoss: { stopPrice: '90', price: '85' },
    } as Parameters<TradeService['placeOrder']>[1]);
    expect(matching.submitted[0]?.request).not.toHaveProperty('stopLossLimit');
  });

  it('a take-profit fill at 90 spends 90 and releases the other 35 of the hold, nothing stranded', async () => {
    await fund(ALICE, 'USDT', '1000');
    await fund(BOB, 'BTC', '1');
    const oco = await trade.placeOrder(principalFor(ALICE), buyOco());
    matching.scriptCancelMiss(oco.id);
    matching.scriptLive(`${oco.id}:tp`, btcusdt.id, '1', 1, ALICE);
    matching.scriptLive(`${oco.id}:sl`, btcusdt.id, '1', 1, ALICE);
    matching.script1((request, next) => {
      const sequence = next();
      return {
        accepted: true,
        sequence,
        fills: [
          {
            sequence: next(),
            makerOrderId: `${oco.id}:tp`,
            makerAccountId: ALICE,
            takerOrderId: request.orderId,
            takerAccountId: BOB,
            takerSide: 'sell',
            price: '90',
            qty: '1',
          },
        ],
        resting: null,
        rejected: null,
        cancellations: [{ orderId: `${oco.id}:sl`, accountId: ALICE, remainingQty: '1', sequence: next(), reason: 'oco_sibling_filled' }],
        triggered: [],
      };
    });
    matching.scriptCancelMiss(`${oco.id}:sl`);
    matching.scriptCancelMiss(`${oco.id}:tp`);
    await trade.placeOrder(principalFor(BOB), {
      marketId: btcusdt.id,
      side: 'sell',
      type: 'limit',
      qty: amt('1'),
      price: amt('90'),
      clientOrderId: 'bob-sell-1',
      tif: 'IOC',
    });
    expect(await heldFor(ALICE, 'USDT', oco.id)).toBe('0');
    expect(await avail(ALICE, 'USDT')).toBe('910');
    expect((await trade.findOrder(oco.id))?.status).toBe('filled');
  });

  it('a stop-loss fill at 121 (inside the 125 limit) spends 121 and releases the rest of the hold', async () => {
    await fund(ALICE, 'USDT', '1000');
    await fund(BOB, 'BTC', '1');
    const oco = await trade.placeOrder(principalFor(ALICE), buyOco());
    matching.scriptCancelMiss(oco.id);
    matching.scriptLive(`${oco.id}:tp`, btcusdt.id, '1', 1, ALICE);
    matching.scriptLive(`${oco.id}:sl`, btcusdt.id, '1', 1, ALICE);
    const bobSell = await trade.placeOrder(principalFor(BOB), {
      marketId: btcusdt.id,
      side: 'sell',
      type: 'limit',
      qty: amt('1'),
      price: amt('121'),
      clientOrderId: 'bob-sell-2',
    });
    // The stop triggers on a print, then takes Bob's resting ask: the stop leg is the taker.
    matching.scriptCancelMiss(`${oco.id}:tp`);
    matching.scriptCancelMiss(`${oco.id}:sl`);
    await trade.settleFillEvent({
      marketId: btcusdt.id,
      makerOrderId: bobSell.id,
      takerOrderId: `${oco.id}:sl`,
      price: '121',
      qty: '1',
      sequence: 1,
      makerAccountId: BOB,
      takerAccountId: ALICE,
    });
    expect(await heldFor(ALICE, 'USDT', oco.id)).toBe('0');
    expect(await avail(ALICE, 'USDT')).toBe('879');
    // base received net of the published test fee schedule (20 bps taker)
    expect(await avail(ALICE, 'BTC')).toBe('0.998');
  });
});
