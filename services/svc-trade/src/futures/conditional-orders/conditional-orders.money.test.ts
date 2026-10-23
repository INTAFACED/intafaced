import './../position-mode.js';
import { PositionService } from '../../controls/test-admission.js';
/**
 * Conditional orders against Postgres: store, claim-once trigger, protection, resting refusal.
 * H8a PG-hard. Uses TEST_DATABASE_URL when it is set. Does not start Docker itself.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { MemoryEventBus } from '@intafaced/events';
import { FuturesError } from '../position-service.js';
import { memoryMarkBook } from '../mark-source.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from '../profit-source.js';
import { TEST_MAX_LEVERAGE_AMOUNT } from '../initial-margin.test-harness.js';
import { createConditionalOrderService, type ConditionalOrderService } from './service.js';
import { FUTURES_RESTING_UNSUPPORTED, refuseFuturesRestingLimit, type RestingLimitInput } from './resting.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
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
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-08-06T12:00:00.000Z');

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('futures conditional orders', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let positions: PositionService;
  let marks: ReturnType<typeof memoryMarkBook>;
  let mark = '50000';
  let orders: ConditionalOrderService;
  let placed: RestingLimitInput[];

  const PROFIT_SOURCE = formatAccountRef(recipeProfitFundingAccount('USDT'));

  function feed(price: string) {
    mark = price;
    marks.set({ marketId: MARKET, price, quality: 'mid', asOfMs: NOW.getTime() });
  }

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.futures_conditional_orders, trade.futures_protection_requests,
        trade.positions, trade.fills, trade.orders, trade.markets,
        trade.position_close_intents, trade.position_close_batches,
        trade.futures_open_requests, trade.account_position_modes
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    marks = memoryMarkBook();
    positions = new PositionService(sql, ledger, {
      marks: marks.source(),
      profitSource: profitSourceFromConfig(PROFIT_SOURCE),
      maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
      bus: new MemoryEventBus('svc-trade'),
      now: () => NOW,
    });
    placed = [];
    orders = createConditionalOrderService({
      sql,
      triggerScheduled: true,
      publishedMark: async () => mark,
      closeQuantity: (userId, positionId, input) => positions.closeQuantity(userId, positionId, input),
      placeLimit: async (input) => {
        placed.push(input);
        return { orderId: 'lim-once' };
      },
    });
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, 'BTC/USDT:USDT', 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC/USDT:USDT', now()
      )
    `;
    feed('50000');
    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: `fund-${randomUUID()}` }),
    );
  });

  async function openAlice(clientOpenId: string, side: 'long' | 'short' = 'long') {
    return positions.open({
      clientOpenId,
      userId: ALICE,
      symbol: 'BTC/USDT:USDT',
      side,
      size: amt('1'),
      leverage: amt('10'),
      positionMode: 'one_way',
    });
  }

  async function conditionalCount(): Promise<string> {
    const [row] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM trade.futures_conditional_orders`;
    return row?.n ?? '0';
  }

  async function bookCount(): Promise<string> {
    const [row] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM trade.orders`;
    return row?.n ?? '0';
  }

  it('stores each kind, refuses a stop that would not reduce, and replays the first clientOrderId', async () => {
    await openAlice('open-kinds');
    const stop = await orders.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'stop_market',
      side: 'sell',
      quantity: '1',
      triggerPrice: '49000',
      clientOrderId: 'k-stop',
    });
    const limit = await orders.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'stop_limit',
      side: 'sell',
      quantity: '0.5',
      triggerPrice: '49000',
      limitPrice: '48900',
      clientOrderId: 'k-limit',
    });
    const profit = await orders.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'take_profit',
      side: 'sell',
      quantity: '1',
      triggerPrice: '51000',
      clientOrderId: 'k-tp',
    });
    const trail = await orders.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'trailing_stop',
      side: 'sell',
      quantity: '1',
      trailingDistance: '1000',
      clientOrderId: 'k-trail',
    });
    expect(stop.order.reduceOnly).toBe(true);
    expect(limit.order.limitPrice).toBe(formatAmount(amt('48900')));
    expect(profit.order.kind).toBe('take_profit');
    expect(trail.order.trailExtreme).toBe(formatAmount(amt('50000')));
    expect(trail.order.triggerPrice).toBe(formatAmount(amt('49000')));
    expect(await conditionalCount()).toBe('4');

    const again = await orders.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'stop_market',
      side: 'sell',
      quantity: '1',
      triggerPrice: '49000',
      clientOrderId: 'k-stop',
    });
    expect(again.replay).toBe(true);
    expect(again.order.id).toBe(stop.order.id);
    expect(await conditionalCount()).toBe('4');

    await expect(
      orders.create(ALICE, {
        market: 'BTC/USDT:USDT',
        kind: 'stop_market',
        side: 'sell',
        quantity: '1',
        triggerPrice: '48000',
        clientOrderId: 'k-stop',
      }),
    ).rejects.toMatchObject({ code: 'trade.client_order_id_conflict' });

    await expect(
      orders.create(ALICE, {
        market: 'BTC/USDT:USDT',
        kind: 'stop_market',
        side: 'buy',
        quantity: '1',
        triggerPrice: '51000',
        clientOrderId: 'k-buy',
      }),
    ).rejects.toMatchObject({ code: 'trade.conditional_would_increase' });
    expect(await conditionalCount()).toBe('4');

    const listed = await orders.list(ALICE);
    expect(listed).toHaveLength(4);
    expect(await orders.list(BOB)).toEqual([]);
    await expect(orders.get(BOB, stop.order.id)).rejects.toMatchObject({ code: 'trade.conditional_not_found' });
  });

  it('cancel is idempotent and another account is not found', async () => {
    await openAlice('open-cancel');
    const created = await orders.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'stop_market',
      side: 'sell',
      quantity: '1',
      triggerPrice: '49000',
      clientOrderId: 'c-cancel',
    });
    const first = await orders.cancel(ALICE, created.order.id);
    const second = await orders.cancel(ALICE, created.order.id);
    expect(first.status).toBe('cancelled');
    expect(second.status).toBe('cancelled');
    expect(second.id).toBe(first.id);
    await expect(orders.cancel(BOB, created.order.id)).rejects.toMatchObject({ code: 'trade.conditional_not_found' });
  });

  it('lists every live order and only the most recent finished ones', async () => {
    await openAlice('open-list');
    const short = createConditionalOrderService({
      sql,
      triggerScheduled: true,
      publishedMark: async () => mark,
      closeQuantity: (userId, positionId, input) => positions.closeQuantity(userId, positionId, input),
      placeLimit: async () => ({ orderId: 'unused' }),
      listFinishedLimit: 2,
    });
    const ids: string[] = [];
    for (const [i, price] of ['49000', '48000', '47000', '46000'].entries()) {
      const created = await short.create(ALICE, {
        market: 'BTC/USDT:USDT',
        kind: 'stop_market',
        side: 'sell',
        quantity: '0.1',
        triggerPrice: price,
        clientOrderId: `list-${i}`,
      });
      ids.push(created.order.id);
      await sql`UPDATE trade.futures_conditional_orders SET created_at = ${new Date(NOW.getTime() + i * 1000)} WHERE id = ${created.order.id}`;
    }
    // The oldest stays armed; the other three are cancelled, and only the two newest of those are listed.
    for (const id of ids.slice(1)) await short.cancel(ALICE, id);
    expect((await short.list(ALICE)).map((o) => [o.id, o.status])).toEqual([
      [ids[0], 'armed'],
      [ids[2], 'cancelled'],
      [ids[3], 'cancelled'],
    ]);
    expect(await short.list(BOB)).toEqual([]);
  });

  it('does not fire while the flag is off, and two workers fire a crossed stop once', async () => {
    await openAlice('open-fire');
    const created = await orders.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'stop_market',
      side: 'sell',
      quantity: '1',
      triggerPrice: '49000',
      clientOrderId: 'c-fire',
    });
    feed('48000');
    const quiet = await orders.evaluate({ enabled: false });
    expect(quiet.fired).toBe(0);
    expect((await orders.get(ALICE, created.order.id)).status).toBe('armed');
    const [intentsBefore] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM trade.position_close_intents`;
    expect(intentsBefore?.n).toBe('0');

    const [a, b] = await Promise.all([orders.evaluate({ enabled: true }), orders.evaluate({ enabled: true })]);
    expect(a.fired + b.fired).toBe(1);
    expect((await orders.get(ALICE, created.order.id)).status).toBe('filled');
    const [pos] = await sql<{ status: string }[]>`SELECT status FROM trade.positions WHERE user_id = ${ALICE}`;
    expect(pos?.status).toBe('closed');
    const [intents] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM trade.position_close_intents`;
    expect(intents?.n).toBe('1');
  });

  it('moves a trailing stop only when the mark improves', async () => {
    await openAlice('open-trail');
    const created = await orders.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'trailing_stop',
      side: 'sell',
      quantity: '1',
      trailingDistance: '1000',
      clientOrderId: 'c-trail',
    });
    feed('51000');
    await orders.evaluate({ enabled: true });
    const raised = await orders.get(ALICE, created.order.id);
    expect(raised.status).toBe('armed');
    expect(raised.trailExtreme).toBe(formatAmount(amt('51000')));
    expect(raised.triggerPrice).toBe(formatAmount(amt('50000')));
    feed('50500');
    await orders.evaluate({ enabled: true });
    const held = await orders.get(ALICE, created.order.id);
    expect(held.status).toBe('armed');
    expect(held.trailExtreme).toBe(formatAmount(amt('51000')));
    expect(held.triggerPrice).toBe(formatAmount(amt('50000')));
  });

  it('places a stop-limit through the limit path and records a refusal when that path refuses', async () => {
    await openAlice('open-limit');
    const created = await orders.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'stop_limit',
      side: 'sell',
      quantity: '1',
      triggerPrice: '49000',
      limitPrice: '48900',
      clientOrderId: 'c-slim',
    });
    feed('48000');
    await orders.evaluate({ enabled: true });
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({
      side: 'sell',
      quantity: formatAmount(amt('1')),
      limitPrice: formatAmount(amt('48900')),
      reduceOnly: true,
    });
    expect((await orders.get(ALICE, created.order.id)).status).toBe('filled');
    const [pos] = await sql<{ status: string }[]>`SELECT status FROM trade.positions WHERE user_id = ${ALICE}`;
    expect(pos?.status).toBe('open');

    const refusing = createConditionalOrderService({
      sql,
      triggerScheduled: true,
      publishedMark: async () => mark,
      closeQuantity: async () => {
        throw new Error('stop-limit must not close at the mark');
      },
      placeLimit: refuseFuturesRestingLimit,
    });
    const second = await refusing.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'stop_limit',
      side: 'sell',
      quantity: '0.4',
      triggerPrice: '49000',
      limitPrice: '48800',
      clientOrderId: 'c-slim-refuse',
    });
    await refusing.evaluate({ enabled: true });
    const failed = await refusing.get(ALICE, second.order.id);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe(FUTURES_RESTING_UNSUPPORTED);
    expect(await bookCount()).toBe('0');
  });

  it('records a failed close and leaves it visible', async () => {
    await openAlice('open-fail');
    const failing = createConditionalOrderService({
      sql,
      triggerScheduled: true,
      publishedMark: async () => mark,
      closeQuantity: async () => {
        throw new FuturesError('close failed', 'trade.close_refused', 400);
      },
      placeLimit: async () => ({ orderId: 'unused' }),
    });
    const created = await failing.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'stop_market',
      side: 'sell',
      quantity: '1',
      triggerPrice: '49000',
      clientOrderId: 'c-fail',
    });
    feed('48000');
    await failing.evaluate({ enabled: true });
    const row = await failing.get(ALICE, created.order.id);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('trade.close_refused');
    const [pos] = await sql<{ status: string }[]>`SELECT status FROM trade.positions WHERE user_id = ${ALICE}`;
    expect(pos?.status).toBe('open');
  });

  it('cancels an armed order when the position is gone', async () => {
    const pos = await openAlice('open-gone');
    const created = await orders.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'take_profit',
      side: 'sell',
      quantity: '1',
      triggerPrice: '51000',
      clientOrderId: 'c-gone',
    });
    await positions.close(ALICE, pos.id!);
    await orders.evaluate({ enabled: true });
    const row = await orders.get(ALICE, created.order.id);
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('position_gone');
  });

  it('replaces protection atomically, refuses the wrong side, and clears both when the position closes', async () => {
    const pos = await openAlice('open-protect');
    const first = await orders.replaceProtection(ALICE, pos.id!, {
      takeProfit: '51000',
      stopLoss: '49000',
      clientRequestId: 'prot-1',
    });
    expect(first.takeProfit?.triggerPrice).toBe(formatAmount(amt('51000')));
    expect(first.stopLoss?.triggerPrice).toBe(formatAmount(amt('49000')));

    await expect(
      orders.replaceProtection(ALICE, pos.id!, {
        takeProfit: '49000',
        stopLoss: '48000',
        clientRequestId: 'prot-2',
      }),
    ).rejects.toMatchObject({ code: 'trade.protection_wrong_side' });
    const still = await orders.get(ALICE, first.takeProfit!.id);
    expect(still.status).toBe('armed');
    expect(still.triggerPrice).toBe(formatAmount(amt('51000')));
    const stillStop = await orders.get(ALICE, first.stopLoss!.id);
    expect(stillStop.status).toBe('armed');

    const swapped = await orders.replaceProtection(ALICE, pos.id!, {
      takeProfit: '52000',
      stopLoss: '48000',
      clientRequestId: 'prot-3',
    });
    expect((await orders.get(ALICE, first.takeProfit!.id)).cancelReason).toBe('replaced');
    expect((await orders.get(ALICE, first.stopLoss!.id)).cancelReason).toBe('replaced');
    expect(swapped.takeProfit?.status).toBe('armed');
    expect(swapped.stopLoss?.triggerPrice).toBe(formatAmount(amt('48000')));

    const replay = await orders.replaceProtection(ALICE, pos.id!, {
      takeProfit: '52000',
      stopLoss: '48000',
      clientRequestId: 'prot-3',
    });
    expect(replay.takeProfit?.id).toBe(swapped.takeProfit?.id);
    expect(replay.stopLoss?.id).toBe(swapped.stopLoss?.id);

    await positions.close(ALICE, pos.id!);
    expect((await orders.get(ALICE, swapped.takeProfit!.id)).cancelReason).toBe('position_closed');
    expect((await orders.get(ALICE, swapped.stopLoss!.id)).cancelReason).toBe('position_closed');
  });

  it('refuses to arm a conditional order or a protection leg while the trigger job is not scheduled', async () => {
    const pos = await openAlice('open-unscheduled');
    const unscheduled = createConditionalOrderService({
      sql,
      triggerScheduled: false,
      publishedMark: async () => mark,
      closeQuantity: (userId, positionId, input) => positions.closeQuantity(userId, positionId, input),
      placeLimit: async () => ({ orderId: 'unused' }),
    });

    await expect(
      unscheduled.create(ALICE, {
        market: 'BTC/USDT:USDT',
        kind: 'stop_market',
        side: 'sell',
        quantity: '1',
        triggerPrice: '49000',
        clientOrderId: 'off-stop',
      }),
    ).rejects.toMatchObject({ code: 'trade.conditional_trigger_off', status: 503 });
    expect(await conditionalCount()).toBe('0');

    await expect(
      unscheduled.replaceProtection(ALICE, pos.id!, {
        takeProfit: '51000',
        stopLoss: '49000',
        clientRequestId: 'off-protect',
      }),
    ).rejects.toMatchObject({ code: 'trade.conditional_trigger_off', status: 503 });
    const [none] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM trade.futures_protection_requests`;
    expect(none?.n).toBe('0');

    const armed = await orders.replaceProtection(ALICE, pos.id!, {
      takeProfit: '51000',
      stopLoss: '49000',
      clientRequestId: 'on-protect',
    });
    expect(armed.takeProfit?.status).toBe('armed');
    expect(armed.stopLoss?.status).toBe('armed');

    await expect(
      unscheduled.replaceProtection(ALICE, pos.id!, {
        takeProfit: '52000',
        stopLoss: '48000',
        clientRequestId: 'off-replace',
      }),
    ).rejects.toMatchObject({ code: 'trade.conditional_trigger_off' });
    expect((await orders.get(ALICE, armed.takeProfit!.id)).status).toBe('armed');
    expect((await orders.get(ALICE, armed.stopLoss!.id)).status).toBe('armed');
    const [stillOne] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM trade.futures_protection_requests`;
    expect(stillOne?.n).toBe('1');

    const cleared = await unscheduled.replaceProtection(ALICE, pos.id!, { clientRequestId: 'off-clear' });
    expect(cleared.takeProfit).toBeNull();
    expect(cleared.stopLoss).toBeNull();
    expect((await orders.get(ALICE, armed.takeProfit!.id)).cancelReason).toBe('replaced');
    expect((await orders.get(ALICE, armed.stopLoss!.id)).cancelReason).toBe('replaced');

    const first = await orders.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'stop_market',
      side: 'sell',
      quantity: '1',
      triggerPrice: '49000',
      clientOrderId: 'scheduled-replay',
    });
    const replay = await unscheduled.create(ALICE, {
      market: 'BTC/USDT:USDT',
      kind: 'stop_market',
      side: 'sell',
      quantity: '1',
      triggerPrice: '49000',
      clientOrderId: 'scheduled-replay',
    });
    expect(replay.replay).toBe(true);
    expect(replay.order.id).toBe(first.order.id);
  });

  it('refuses a resting futures order and writes no row', async () => {
    await expect(orders.placeResting()).rejects.toMatchObject({ code: FUTURES_RESTING_UNSUPPORTED });
    await expect(orders.placeResting()).rejects.toMatchObject({ code: FUTURES_RESTING_UNSUPPORTED });
    expect(await conditionalCount()).toBe('0');
    expect(await bookCount()).toBe('0');
  });
});
