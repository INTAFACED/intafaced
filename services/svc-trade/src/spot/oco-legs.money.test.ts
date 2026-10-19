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
      `H8a: svc-trade oco-legs is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}
const ALICE = '11111111-1111-4111-8111-111111111111';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

const BOB = '22222222-2222-4222-8222-222222222222';

const tpOf = (id: string) => `${id}:tp`;
const slOf = (id: string) => `${id}:sl`;

describe('svc-trade sell OCO legs draw on one hold (H8a PG-hard)', () => {
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

  /** Alice's sell OCO (1 BTC, one hold) and Bob's resting buy that her take-profit leg trades against. */
  async function setup() {
    await fund(ALICE, 'BTC', '1');
    await fund(BOB, 'USDT', '1000');
    const oco = await trade.placeOrder(principalFor(ALICE), {
      marketId: btcusdt.id,
      side: 'sell',
      type: 'limit',
      qty: amt('1'),
      price: amt('110'),
      clientOrderId: 'oco-legs-1',
      takeProfit: { stopPrice: '110' },
      stopLoss: { stopPrice: '90' },
    } as Parameters<TradeService['placeOrder']>[1]);
    const bob = await trade.placeOrder(principalFor(BOB), {
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('110'),
      clientOrderId: 'bob-buy-1',
    });
    // The engine rests the two legs under derived ids; the parent id never rests.
    matching.scriptLive(tpOf(oco.id), btcusdt.id, '1');
    matching.scriptLive(slOf(oco.id), btcusdt.id, '1');
    return { oco, bob };
  }

  const fillLeg = (legId: string, bobId: string, qty: string, sequence: number) =>
    trade.settleFillEvent({
      marketId: btcusdt.id,
      makerOrderId: legId,
      takerOrderId: bobId,
      price: '110',
      qty,
      sequence,
      makerAccountId: ALICE,
      takerAccountId: BOB,
    });

  it('settles a fill on a leg against the parent order and its one hold', async () => {
    const { oco, bob } = await setup();
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('1');
    await fillLeg(tpOf(oco.id), bob.id, '0.4', 1);
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0.6');
    expect(await avail(ALICE, 'USDT')).toBe('43.956');
    const rows = await sql<Array<{ order_id: string }>>`SELECT order_id FROM trade.fills WHERE order_id = ${oco.id}`;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('HAZARD: the sibling leg cancelled on a partial first fill must not release the hold the remaining leg rests on', async () => {
    const { oco, bob } = await setup();
    await fillLeg(tpOf(oco.id), bob.id, '0.4', 1);
    // The engine cancels the sibling on ANY first fill; the take-profit remainder (0.6) still rests.
    matching.scriptCancelMiss(slOf(oco.id));
    await trade.releaseOnCancelEvent(slOf(oco.id));

    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0.6');
    expect((await trade.findOrder(oco.id))?.status).toBe('open');
  });

  it('releases the remainder exactly once when the last live leg goes, even on redelivery', async () => {
    const { oco, bob } = await setup();
    await fillLeg(tpOf(oco.id), bob.id, '0.4', 1);
    matching.scriptCancelMiss(slOf(oco.id));
    await trade.releaseOnCancelEvent(slOf(oco.id));
    matching.scriptCancelMiss(tpOf(oco.id));
    await trade.releaseOnCancelEvent(tpOf(oco.id));
    await trade.releaseOnCancelEvent(tpOf(oco.id));

    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0');
    expect(await avail(ALICE, 'BTC')).toBe('0.6');
    expect((await trade.findOrder(oco.id))?.status).toBe('cancelled');
  });

  it('a redelivered fill on a leg settles once', async () => {
    const { oco, bob } = await setup();
    await fillLeg(tpOf(oco.id), bob.id, '0.4', 1);
    await fillLeg(tpOf(oco.id), bob.id, '0.4', 1);
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0.6');
    expect(await avail(ALICE, 'USDT')).toBe('43.956');
  });

  it('a full fill on a leg closes the parent as filled with nothing left held', async () => {
    const { oco, bob } = await setup();
    await fillLeg(tpOf(oco.id), bob.id, '1', 1);
    matching.scriptCancelMiss(slOf(oco.id));
    await trade.releaseOnCancelEvent(slOf(oco.id));
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0');
    // proceeds net of the published test fee schedule
    expect(await avail(ALICE, 'USDT')).toBe('109.89');
    expect((await trade.findOrder(oco.id))?.status).toBe('filled');
  });

  it('keeps the hold when the engine cannot be asked whether the other leg is still live', async () => {
    const { oco, bob } = await setup();
    await fillLeg(tpOf(oco.id), bob.id, '0.4', 1);
    matching.listOrders = async () => {
      throw new Error('svc-matching is unreachable');
    };
    await trade.releaseOnCancelEvent(slOf(oco.id));
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0.6');
    expect((await trade.findOrder(oco.id))?.status).toBe('open');
  });

  it('never holds more than the one base quantity: a sell OCO places one hold, not one per leg', async () => {
    const { oco } = await setup();
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('1');
    expect(await heldFor(ALICE, 'BTC', tpOf(oco.id))).toBe('0');
    expect(await heldFor(ALICE, 'BTC', slOf(oco.id))).toBe('0');
  });

  it('refuses a buy-side OCO: one hold cannot cover both legs at their worst price yet', async () => {
    await fund(ALICE, 'USDT', '1000');
    await expect(
      trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'oco-buy-1',
        takeProfit: { stopPrice: '90' },
        stopLoss: { stopPrice: '110' },
      } as Parameters<TradeService['placeOrder']>[1]),
    ).rejects.toMatchObject({ code: 'trade.order_type_unsupported' });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  it('lets the user cancel the take-profit remainder after a partial fill, releasing the unfilled hold once', async () => {
    const { oco, bob } = await setup();
    await fillLeg(tpOf(oco.id), bob.id, '0.4', 1);
    matching.scriptCancelMiss(slOf(oco.id));
    matching.script1((request, next) => {
      const sequence = next();
      return {
        accepted: false,
        sequence,
        fills: [],
        resting: null,
        rejected: { code: 'oco_sibling_terminal', message: 'terminal' },
        cancellations: [],
        triggered: [],
      };
    });
    const cancelled = await trade.cancelOrder(principalFor(ALICE), oco.id);
    expect(matching.cancelledOrders).toContain(tpOf(oco.id));
    expect(cancelled.status).toBe('cancelled');
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0');
    expect(await avail(ALICE, 'BTC')).toBe('0.6');
  });
});
