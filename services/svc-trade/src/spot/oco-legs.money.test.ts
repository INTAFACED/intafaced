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

  /** Alice's sell OCO (1 BTC, one hold). Bob's buys are the takers that trade against her legs. */
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
    // The engine rests the two legs under derived ids; the parent id never rests.
    // The real engine never lists the parent id: only its legs rest.
    matching.scriptCancelMiss(oco.id);
    matching.scriptLive(tpOf(oco.id), btcusdt.id, '1', 1, ALICE);
    matching.scriptLive(slOf(oco.id), btcusdt.id, '1', 1, ALICE);
    return { oco };
  }

  let bobSeq = 0;
  /**
   * Bob's buy trades `qty` against one of Alice's legs. The engine's answer carries the fill and the cancellation
   * of the other leg (it cancels the sibling on ANY first fill). `liveAfter` are the legs still resting.
   */
  async function bobTakes(oco: { id: string }, leg: 'tp' | 'sl', qty: string, liveAfter: Array<'tp' | 'sl'>, siblingCancelled = true) {
    const legId = leg === 'tp' ? tpOf(oco.id) : slOf(oco.id);
    const other = leg === 'tp' ? slOf(oco.id) : tpOf(oco.id);
    matching.script1((request, next) => {
      const sequence = next();
      return {
        accepted: true,
        sequence,
        fills: [
          {
            sequence: next(),
            makerOrderId: legId,
            makerAccountId: ALICE,
            takerOrderId: request.orderId,
            takerAccountId: BOB,
            takerSide: 'buy',
            price: '110',
            qty,
          },
        ],
        resting: null,
        rejected: null,
        cancellations: siblingCancelled
          ? [{ orderId: other, accountId: ALICE, remainingQty: '1', sequence: next(), reason: 'oco_sibling_filled' }]
          : [],
        triggered: [],
      };
    });
    matching.scriptCancelMiss(other);
    if (!liveAfter.includes(leg)) matching.scriptCancelMiss(legId);
    await trade.placeOrder(principalFor(BOB), {
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      qty: amt(qty),
      price: amt('110'),
      clientOrderId: `bob-${++bobSeq}`,
      tif: 'IOC',
    });
  }

  it('settles a fill on a leg against the parent order and its one hold', async () => {
    const { oco } = await setup();
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('1');
    await bobTakes(oco, 'tp', '0.4', ['tp']);
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0.6');
    expect(await avail(ALICE, 'USDT')).toBe('43.956');
    const rows = await sql<Array<{ order_id: string }>>`SELECT order_id FROM trade.fills WHERE order_id = ${oco.id}`;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('HAZARD: the sibling cancelled on a partial first fill must not release the hold the remaining leg rests on', async () => {
    const { oco } = await setup();
    await bobTakes(oco, 'tp', '0.4', ['tp']);
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0.6');
    expect((await trade.findOrder(oco.id))?.status).toBe('open');
  });

  it('a full fill on a leg closes the parent as filled with nothing left held', async () => {
    const { oco } = await setup();
    await bobTakes(oco, 'tp', '1', []);
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0');
    // proceeds net of the published test fee schedule
    expect(await avail(ALICE, 'USDT')).toBe('109.89');
    expect((await trade.findOrder(oco.id))?.status).toBe('filled');
  });

  it('a redelivered fill event on a leg settles once', async () => {
    const { oco } = await setup();
    await bobTakes(oco, 'tp', '0.4', ['tp']);
    const bob = await sql<Array<{ id: string }>>`SELECT id FROM trade.orders WHERE user_id = ${BOB} LIMIT 1`;
    const seq = await sql<Array<{ sequence: string }>>`SELECT sequence FROM trade.fills WHERE order_id = ${oco.id} LIMIT 1`;
    await trade.settleFillEvent({
      marketId: btcusdt.id,
      makerOrderId: tpOf(oco.id),
      takerOrderId: bob[0]!.id,
      price: '110',
      qty: '0.4',
      sequence: Number(seq[0]!.sequence),
      makerAccountId: ALICE,
      takerAccountId: BOB,
    });
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0.6');
    expect(await avail(ALICE, 'USDT')).toBe('43.956');
  });

  it('a stop-loss remainder cancelled after the take-profit leg is gone closes the parent and releases once', async () => {
    const { oco } = await setup();
    await bobTakes(oco, 'sl', '0.4', []);
    // the stop filled 0.4 as a market order; its remainder was cancelled; the tp sibling went with the first fill
    matching.script1((request, next) => {
      const sequence = next();
      return {
        accepted: true,
        sequence,
        fills: [],
        resting: null,
        rejected: null,
        cancellations: [{ orderId: slOf(oco.id), accountId: ALICE, remainingQty: '0.6', sequence: next(), reason: 'market_remainder' }],
        triggered: [],
      };
    });
    await trade.placeOrder(principalFor(BOB), {
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('1'),
      clientOrderId: 'bob-noise',
    });
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0');
    expect(await avail(ALICE, 'BTC')).toBe('0.6');
    expect((await trade.findOrder(oco.id))?.status).toBe('cancelled');
  });

  it("TWO TAKERS, ONE LEG: the first settlement must not release the hold the second taker's unsettled fill spends", async () => {
    const { oco } = await setup();
    // Carol takes the last 0.6 of the take-profit leg after the engine matched Bob's 0.4 but before Bob's settlement
    // runs, so when Bob's settlement asks the book, no leg is left: the leg is gone because it FILLED, not cancelled.
    await bobTakes(oco, 'tp', '0.4', []);
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0.6');
    expect((await trade.findOrder(oco.id))?.status).toBe('open');
    // Carol's fill settles afterwards and finds its hold, then the order closes as filled.
    await bobTakes(oco, 'tp', '0.6', [], false);
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0');
    expect((await trade.findOrder(oco.id))?.status).toBe('filled');
    expect(await avail(ALICE, 'BTC')).toBe('0');
    expect(await avail(ALICE, 'USDT')).toBe('109.89');
  });

  it('a bare cancel event for a leg never releases the shared hold', async () => {
    const { oco } = await setup();
    matching.scriptCancelMiss(slOf(oco.id));
    matching.scriptCancelMiss(tpOf(oco.id));
    await trade.releaseOnCancelEvent(slOf(oco.id), '1');
    await trade.releaseOnCancelEvent(tpOf(oco.id), '1');
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('1');
    expect((await trade.findOrder(oco.id))?.status).toBe('open');
  });

  it('keeps the hold when the engine cannot be asked whether the other leg is still live', async () => {
    const { oco } = await setup();
    await bobTakes(oco, 'tp', '0.4', ['tp']);
    matching.listOrders = async () => {
      throw new Error('svc-matching is unreachable');
    };
    matching.script1((request, next) => {
      const sequence = next();
      return {
        accepted: true,
        sequence,
        fills: [],
        resting: null,
        rejected: null,
        cancellations: [{ orderId: tpOf(oco.id), accountId: ALICE, remainingQty: '0.6', sequence: next(), reason: 'market_remainder' }],
        triggered: [],
      };
    });
    await trade.placeOrder(principalFor(BOB), {
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('1'),
      clientOrderId: 'bob-noise-2',
    });
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0.6');
    expect((await trade.findOrder(oco.id))?.status).toBe('open');
  });

  it('never holds more than the one base quantity: a sell OCO places one hold, not one per leg', async () => {
    const { oco } = await setup();
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('1');
    expect(await heldFor(ALICE, 'BTC', tpOf(oco.id))).toBe('0');
    expect(await heldFor(ALICE, 'BTC', slOf(oco.id))).toBe('0');
  });

  it('mass-cancel with a resting OCO closes the parent once instead of failing on a leg id', async () => {
    const { oco } = await setup();
    const out = await trade.massCancelOrders(principalFor(ALICE), btcusdt.id);
    expect(out.filter((o) => o.id === oco.id)).toHaveLength(1);
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0');
    expect(await avail(ALICE, 'BTC')).toBe('1');
  });

  it('refuses a buy OCO with no stop-loss limit (the old blanket buy refusal is gone)', async () => {
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
    ).rejects.toMatchObject({ code: 'trade.oco_stop_limit_required' });
    expect(matching.submitted).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
  });

  it('lets the user cancel the take-profit remainder after a partial fill, releasing the unfilled hold once', async () => {
    const { oco } = await setup();
    await bobTakes(oco, 'tp', '0.4', ['tp']);
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

  it('a user cancel does not release over a leg fill the engine printed but this service has not settled', async () => {
    const { oco } = await setup();
    // The engine took 0.4 off the take-profit leg after the book was read; Bob's settlement has not run yet.
    matching.scriptLive(tpOf(oco.id), btcusdt.id, '0.6', 1, ALICE);
    await expect(trade.cancelOrder(principalFor(ALICE), oco.id)).rejects.toMatchObject({ code: 'trade.matching_unavailable' });
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('1');
    expect((await trade.findOrder(oco.id))?.status).toBe('open');
  });

  it('reconcile of a live OCO pulls both legs from the engine before it releases the hold', async () => {
    const { oco } = await setup();
    const result = await trade.reconcileOrder(oco.id);
    expect(result.engineLive).toBe(true);
    expect(matching.cancelledOrders).toEqual(expect.arrayContaining([tpOf(oco.id), slOf(oco.id)]));
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('0');
    expect(await avail(ALICE, 'BTC')).toBe('1');
  });

  it('a transient listing failure then success on user cancel never releases over resting legs', async () => {
    const { oco } = await setup();
    const realList = matching.listOrders.bind(matching);
    let calls = 0;
    matching.listOrders = async (marketId: string, orderId?: string) => {
      calls += 1;
      if (calls === 1) throw new Error('svc-matching is unreachable');
      return realList(marketId, orderId);
    };
    await expect(trade.cancelOrder(principalFor(ALICE), oco.id)).rejects.toBeDefined();
    expect(await heldFor(ALICE, 'BTC', oco.id)).toBe('1');
    expect((await trade.findOrder(oco.id))?.status).not.toBe('cancelled');
  });
});
