/**
 * The grid store on real PostgreSQL (CB-bots-02): the migration's checks, the one-transaction create under the
 * reserve lock, the idempotent order save, and the unused-reserve sum. Rows are TEST.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { GridError } from './errors.js';
import { SqlGridStore } from './store.js';
import { gridClientOrderId, gridReserveKey, type GridBot, type GridOrder, type GridReserve } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is required (runs/test-db.env). This suite does not start Docker.');
  const url = new URL(raw);
  if (url.pathname === '/test') url.pathname = '/intafaced_test';
  return url.toString();
}

const A = (v: string) => parseAmount(v);
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOT = '5a5a5a5a-0000-5000-8000-000000000001';
const AT = new Date('2026-10-29T12:00:00Z');

function bot(botId = BOT): GridBot {
  return {
    botId,
    userId: ALICE,
    clientRequestId: `req-${botId}`,
    requestHash: 'h',
    marketId: 'BTC-USDT',
    symbol: 'BTC/USDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    lowerPrice: A('60000'),
    upperPrice: A('70000'),
    gridCount: 2,
    investment: A('200'),
    levels: [
      { index: 0, price: A('60000'), qty: A('0.00166'), hold: A('99.6') },
      { index: 1, price: A('70000'), qty: A('0.00142'), hold: A('99.4') },
    ],
    status: 'running',
    statusReason: null,
    placeGrant: { scopes: ['trade:write'], sid: 'sid-test', tier: 'full', mfa: false },
    createdAt: AT,
    updatedAt: AT,
  };
}

const reserve = (botId = BOT, amount = '200'): GridReserve => ({
  reserveKey: gridReserveKey(botId),
  botId,
  userId: ALICE,
  asset: 'USDT',
  amount: A(amount),
  heldAt: AT,
  releasedAt: null,
});

const buy = (botId = BOT, hold = '99.6'): GridOrder => ({
  clientOrderId: gridClientOrderId(botId, 0, 'buy', 0),
  botId,
  levelIndex: 0,
  side: 'buy',
  cycle: 0,
  orderId: `o-${botId}`,
  price: A('60000'),
  qty: A('0.00166'),
  holdAmount: A(hold),
  status: 'open',
  pairProfit: null,
  placedAt: AT,
  closedAt: null,
});

describe('SqlGridStore (shared test postgres)', () => {
  let db: TestDatabase;
  let store: SqlGridStore;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: testDatabaseUrl(), migrations });
    store = new SqlGridStore(db.sql);
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.grid_bot_orders, trade.grid_bot_reserves, trade.grid_bots`;
  });

  it('writes the bot and its reserve once, and reads both back', async () => {
    const first = await store.createWithReserve(bot(), reserve(), async () => {});
    expect(first.created).toBe(true);
    const again = await store.createWithReserve(bot(), reserve(), async () => {
      throw new Error('the check must not run for an id already stored');
    });
    expect(again.created).toBe(false);
    expect(again.bot.botId).toBe(BOT);
    const read = (await store.findBot(BOT))!;
    expect(read.levels).toEqual(bot().levels);
    expect(read.investment).toBe(A('200'));
    expect(read.placeGrant.tier).toBe('full');
    expect(await store.getReserve(BOT)).toEqual(reserve());
  });

  it('a refused check rolls the bot back with the reserve', async () => {
    await expect(
      store.createWithReserve(bot(), reserve(), async () => {
        throw new GridError('no', 'trade.grid_reserve_exceeds_balance');
      }),
    ).rejects.toMatchObject({ code: 'trade.grid_reserve_exceeds_balance' });
    expect(await store.findBot(BOT)).toBeNull();
    expect(await store.getReserve(BOT)).toBeNull();
  });

  it('the reserve key must be bots.grid.reserve:<botId>', async () => {
    await expect(store.createWithReserve(bot(), { ...reserve(), reserveKey: 'bots.grid.reserve:other' }, async () => {})).rejects.toThrow(
      /grid_bot_reserves_key_ck/,
    );
    expect(await store.findBot(BOT)).toBeNull();
  });

  it('unused reserve is the amount less open buy holds; a released reserve counts nothing', async () => {
    await store.createWithReserve(bot(), reserve(), async () => {});
    expect(await store.sumUnusedReserves(ALICE, 'USDT')).toBe(A('200'));
    await store.saveOrder(buy());
    expect(await store.sumUnusedReserves(ALICE, 'USDT')).toBe(A('100.4'));
    // The check sees the other bot's unused reserve under the lock.
    const other = '5a5a5a5a-0000-5000-8000-000000000002';
    let seen = -1n;
    await store.createWithReserve(bot(other), reserve(other, '50'), async (unused) => {
      seen = unused;
    });
    expect(seen).toBe(A('100.4'));
    await store.releaseReserve(BOT, AT);
    expect(await store.sumUnusedReserves(ALICE, 'USDT')).toBe(A('50'));
  });

  it('an order saves once by clientOrderId and closes once', async () => {
    await store.createWithReserve(bot(), reserve(), async () => {});
    await store.saveOrder(buy());
    const second = await store.saveOrder({ ...buy(), orderId: 'o-other' });
    expect(second.orderId).toBe(`o-${BOT}`);
    await store.closeOrder(buy().clientOrderId, 'filled', null, AT);
    await store.closeOrder(buy().clientOrderId, 'cancelled', null, AT);
    expect((await store.listOrders(BOT)).map((o) => o.status)).toEqual(['filled']);
  });

  it('a part filled order closes as partial with no profit', async () => {
    await store.createWithReserve(bot(), reserve(), async () => {});
    await store.saveOrder(buy());
    await store.closeOrder(buy().clientOrderId, 'partial', null, AT);
    expect((await store.listOrders(BOT)).map((o) => [o.status, o.pairProfit])).toEqual([['partial', null]]);
  });

  it('a status writes only from the statuses named, so a stop is never undone', async () => {
    await store.createWithReserve(bot(), reserve(), async () => {});
    expect(await store.setStatus(BOT, 'stopped', 'owner_stop', AT, ['running', 'paused_range'])).toBe(true);
    expect(await store.setStatus(BOT, 'paused_range', 'mark_outside_range', AT, ['running'])).toBe(false);
    expect(await store.setStatus(BOT, 'running', null, AT, ['paused_range'])).toBe(false);
    const read = (await store.findBot(BOT))!;
    expect([read.status, read.statusReason]).toEqual(['stopped', 'owner_stop']);
  });

  it('a stopped bot winds down until its reserve is released; a live one never does', async () => {
    await store.createWithReserve(bot(), reserve(), async () => {});
    expect(await store.listWindingDown()).toEqual([]);
    await store.setStatus(BOT, 'stopped', 'owner_stop', AT, ['running']);
    expect((await store.listWindingDown()).map((b) => b.botId)).toEqual([BOT]);
    await store.releaseReserve(BOT, AT);
    expect(await store.listWindingDown()).toEqual([]);
  });

  it('a bot initializing is stale only once its status was written before the cut-off, and only while initializing', async () => {
    await store.createWithReserve({ ...bot(), status: 'initializing', updatedAt: AT }, reserve(), async () => {});
    expect(await store.listStaleInitializing(AT)).toEqual([]);
    const later = new Date(AT.getTime() + 1);
    expect((await store.listStaleInitializing(later)).map((b) => b.botId)).toEqual([BOT]);
    expect(await store.listLiveBots()).toEqual([]);
    expect(await store.setStatus(BOT, 'running', null, AT, ['initializing'])).toBe(true);
    expect(await store.listStaleInitializing(later)).toEqual([]);
  });

  it('pair profit is only for a filled sell', async () => {
    await store.createWithReserve(bot(), reserve(), async () => {});
    await store.saveOrder(buy());
    await expect(store.closeOrder(buy().clientOrderId, 'filled', A('1'), AT)).rejects.toThrow(/grid_bot_orders_profit_ck/);
  });
});
