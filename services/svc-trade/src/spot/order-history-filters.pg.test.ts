/**
 * orderHistory filters by side, status and an inclusive until, with since, in SQL (PG-hard, never skipped).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
const T1 = Date.parse('2026-10-01T00:00:00.000Z');
const T2 = Date.parse('2026-10-02T00:00:00.000Z');
const T3 = Date.parse('2026-10-03T00:00:00.000Z');

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_history_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('orderHistory filters (PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let trade: TradeService;
  let market: Market;
  let ids: { a: string; b: string; c: string; other: string };
  const alice = principalFor(ALICE, ['trade:read', 'trade:write']);
  const history = async (extra: Record<string, unknown> = {}) =>
    (await trade.orderHistory(alice, { limit: 50, ...extra } as never)).map((o) => o.id);

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
    const ledger = new MemoryLedger();
    trade = new TradeService(db.sql, ledger, new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    market = await trade.listMarket({
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
    for (const user of [ALICE, BOB]) {
      await ledger.post(recipes.deposit({ userId: user, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: `${user}:u` }));
      await ledger.post(recipes.deposit({ userId: user, assetId: 'BTC', amount: amt('10'), rail: 'test', railRef: `${user}:b` }));
    }
    const limit = (p: ReturnType<typeof principalFor>, side: 'buy' | 'sell', price: string, key: string) =>
      trade.placeOrder(p, { marketId: market.id, side, type: 'limit', qty: amt('1'), price: amt(price), clientOrderId: key });
    const a = await limit(alice, 'buy', '50', 'hist-a');
    const b = await limit(alice, 'buy', '51', 'hist-b');
    const c = await limit(alice, 'sell', '200', 'hist-c');
    const other = await limit(principalFor(BOB, ['trade:read', 'trade:write']), 'buy', '52', 'hist-bob');
    for (const o of [a, b, c]) await trade.cancelOrder(alice, o.id);
    // b closed as filled; a, c stay cancelled; created_at fixed so the windows are exact.
    await db.sql`UPDATE trade.orders SET status = 'filled' WHERE id = ${b.id}`;
    await db.sql`UPDATE trade.orders SET created_at = ${new Date(T1)} WHERE id = ${a.id}`;
    await db.sql`UPDATE trade.orders SET created_at = ${new Date(T2)} WHERE id = ${b.id}`;
    await db.sql`UPDATE trade.orders SET created_at = ${new Date(T3)} WHERE id = ${c.id}`;
    ids = { a: a.id, b: b.id, c: c.id, other: other.id };
  });

  it('with no filter returns the caller’s terminal orders, newest first, never another user’s', async () => {
    expect(await history()).toEqual([ids.c, ids.b, ids.a]);
  });

  it('filters by side', async () => {
    expect(await history({ side: 'buy' })).toEqual([ids.b, ids.a]);
    expect(await history({ side: 'sell' })).toEqual([ids.c]);
  });

  it('filters by status', async () => {
    expect(await history({ status: 'filled' })).toEqual([ids.b]);
    expect(await history({ status: 'cancelled' })).toEqual([ids.c, ids.a]);
    expect(await history({ status: 'rejected' })).toEqual([]);
  });

  it('filters by order type, telling a stop-limit from a plain limit by its stored trigger', async () => {
    await db.sql`INSERT INTO trade.order_stop_trigger (order_id, user_id, stop_price) VALUES (${ids.b}, ${ALICE}, 45)`;
    expect(await history({ type: 'stop_limit' })).toEqual([ids.b]);
    expect(await history({ type: 'limit' })).toEqual([ids.c, ids.a]);
    expect(await history({ type: 'market' })).toEqual([]);
    expect(await history({ type: 'stop_limit', side: 'sell' })).toEqual([]);
  });

  it('until is inclusive and pairs with since to page a window', async () => {
    expect(await history({ untilMs: T2 })).toEqual([ids.b, ids.a]);
    expect(await history({ sinceMs: T2, untilMs: T2 })).toEqual([ids.b]);
    expect(await history({ untilMs: T1 - 1 })).toEqual([]);
  });

  it('filters combine, and a symbol filter still applies', async () => {
    expect(await history({ side: 'buy', status: 'cancelled', untilMs: T2, marketId: market.id })).toEqual([ids.a]);
  });

  it('pages by the previous page’s last order: no order twice, none skipped, even when orders share a creation instant', async () => {
    // a and b share one instant to the microsecond: a cursor that compared milliseconds or the time alone would repeat or skip one.
    await db.sql`UPDATE trade.orders SET created_at = '2026-10-02T00:00:00.123456Z' WHERE id IN (${ids.a}, ${ids.b})`;
    const all = await history();
    expect(all).toHaveLength(3);
    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = (await trade.orderHistory(alice, { limit: 1, ...(before ? { before } : {}) })).map((o) => o.id);
      if (page.length === 0) break;
      seen.push(...page);
      before = page[page.length - 1];
    }
    expect(seen).toEqual(all);
    expect(await history({ before: all[0], side: 'buy' })).toEqual(all.slice(1).filter((id) => id !== ids.c));
  });

  it('refuses a cursor that is not one of the caller’s orders', async () => {
    await expect(trade.orderHistory(alice, { limit: 5, before: ids.other })).rejects.toMatchObject({ code: 'trade.invalid_cursor' });
    await expect(trade.orderHistory(alice, { limit: 5, before: '33333333-3333-4333-8333-333333333333' })).rejects.toMatchObject({
      code: 'trade.invalid_cursor',
    });
  });

  it('orderAmendments lists amends and replace links oldest first, owner only', async () => {
    expect(await trade.orderAmendments(alice, ids.a)).toEqual([]);
    await db.sql`INSERT INTO trade.order_events (order_id, kind, quantity, price, code, at) VALUES (${ids.a}, 'amend', 2, 55, 'amend:2', ${new Date(T3)})`;
    await db.sql`INSERT INTO trade.order_events (order_id, kind, quantity, price, code, at) VALUES (${ids.a}, 'amend', 3, 54, 'amend:1', ${new Date(T2)})`;
    await db.sql`UPDATE trade.orders SET replacement_of = ${ids.a}, replacement_request_hash = 'h', created_at = ${new Date(T3 + 1000)} WHERE id = ${ids.b}`;
    const listed = await trade.orderAmendments(alice, ids.a);
    expect(listed.map((r) => [r.kind, r.version, r.relatedOrderId, r.direction])).toEqual([
      ['amend', '1', null, null],
      ['amend', '2', null, null],
      ['replace', null, ids.b, 'replaced_by'],
    ]);
    expect(listed[0]).toMatchObject({ quantity: '3.000000000000000000', price: '54.000000000000000000' });
    const back = await trade.orderAmendments(alice, ids.b);
    expect(back.map((r) => [r.kind, r.relatedOrderId, r.direction])).toEqual([['replace', ids.a, 'replaces']]);
    await expect(trade.orderAmendments(principalFor(ALICE, ['market:read']), ids.a)).rejects.toThrow();
    await expect(trade.orderAmendments(alice, ids.other)).rejects.toMatchObject({ code: 'trade.order_not_found' });
  });
});
