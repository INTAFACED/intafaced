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

  it("cancel-all narrowed to spot cancels only spot markets' orders and leaves another product's alone", async () => {
    await rest(alice, btc, 'kind-spot');
    await rest(alice, eth, 'kind-other');
    // Stand-in for another product: the filter reads the market's kind, nothing else about it.
    await db.sql`UPDATE trade.markets SET kind = 'futures' WHERE id = ${eth.id}`;
    const cancelled = await trade.cancelAllOrders(alice, undefined, 'spot');
    expect(cancelled.map((o) => o.clientOrderId)).toEqual(['kind-spot']);
    const left = await db.sql<Array<{ client_order_id: string; status: string }>>`
      SELECT client_order_id, status FROM trade.orders WHERE user_id = ${ALICE} ORDER BY client_order_id`;
    expect(left).toEqual([
      { client_order_id: 'kind-other', status: 'open' },
      { client_order_id: 'kind-spot', status: 'cancelled' },
    ]);
    // With no kind, every market's orders go.
    expect((await trade.cancelAllOrders(alice)).map((o) => o.clientOrderId)).toEqual(['kind-other']);
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

  it('a replacement is never refused by a cap that dropped below the count, and its original is not cancelled for nothing', async () => {
    process.env.TRADE_MAX_OPEN_ORDERS = '5';
    const first = await rest(alice, btc, 'rp-1');
    const secondOrder = await rest(alice, btc, 'rp-2');
    await rest(alice, btc, 'rp-3');
    process.env.TRADE_MAX_OPEN_ORDERS = '2';
    const outcome = await trade.replaceOrder(alice, first.id, {
      marketId: btc.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('51'),
      clientOrderId: 'rp-new',
    } as never);
    expect(outcome.code).toBe('REPLACED');
    await expect(rest(alice, btc, 'rp-fresh')).rejects.toMatchObject({ code: 'trade.limit_max_open_orders' });
    process.env.TRADE_MAX_OPEN_ORDERS = 'oops';
    const again = await trade.replaceOrder(alice, secondOrder.id, {
      marketId: btc.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('52'),
      clientOrderId: 'rp-new-2',
    } as never);
    expect(again.code).toBe('REPLACED');
  });

  it('paper markets never count toward the live cap', async () => {
    process.env.TRADE_MAX_OPEN_ORDERS = '2';
    await rest(alice, btc, 'pp-1');
    await rest(alice, btc, 'pp-2');
    await expect(rest(alice, eth, 'pp-3')).rejects.toMatchObject({ code: 'trade.limit_max_open_orders' });
    await db.sql`UPDATE trade.markets SET paper = true WHERE id = ${btc.id}`;
    await rest(alice, eth, 'pp-4');
  });

  it('the exit of a stored bracket intent is exempt, but the name alone is not enough', async () => {
    process.env.TRADE_MAX_OPEN_ORDERS = '1';
    const entry = await rest(alice, btc, 'br-entry');
    const exit = (entryId: string, user: typeof alice) =>
      trade.placeOrder(user, {
        marketId: btc.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('60'),
        clientOrderId: `bracket:${entryId}:exit`,
      } as never);
    // No stored intent: the name is just a name, so the cap applies.
    await expect(exit(entry.id, alice)).rejects.toMatchObject({ code: 'trade.limit_max_open_orders' });
    await db.sql`INSERT INTO trade.order_bracket_intent (order_id, user_id, take_profit, stop_loss) VALUES (${entry.id}, ${ALICE}, 60, 40)`;
    // Another user cannot borrow Alice's intent: fill Bob to the cap, then his exit of Alice's entry is refused.
    await rest(bob, btc, 'br-bob-1');
    await expect(exit(entry.id, bob)).rejects.toMatchObject({ code: 'trade.limit_max_open_orders' });
    // A name that is not a uuid never reaches the stored-intent lookup: it is the typed refusal, not a database error.
    await expect(exit('-'.repeat(36), alice)).rejects.toMatchObject({ code: 'trade.limit_max_open_orders' });
    const placed = await exit(entry.id, alice);
    expect(placed.clientOrderId).toBe(`bracket:${entry.id}:exit`);
    await db.sql`UPDATE trade.order_bracket_intent SET exit_order_id = ${placed.id} WHERE order_id = ${entry.id}`;
    // Once the exit is placed the intent no longer exempts anything.
    await expect(rest(alice, btc, 'br-after')).rejects.toMatchObject({ code: 'trade.limit_max_open_orders' });
  });

  it('the close of a stored OTO intent is exempt the same way, and only under its own kind', async () => {
    process.env.TRADE_MAX_OPEN_ORDERS = '1';
    const entry = await rest(alice, btc, 'oto-entry');
    const named = (clientOrderId: string) =>
      trade.placeOrder(alice, {
        marketId: btc.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('60'),
        clientOrderId,
      } as never);
    await db.sql`
      INSERT INTO trade.order_bracket_intent (order_id, user_id, kind, take_profit, stop_loss) VALUES (${entry.id}, ${ALICE}, 'oto', 60, NULL)`;
    // A bracket name over an OTO intent, or a mixed name, is just a name: the cap applies.
    await expect(named(`bracket:${entry.id}:exit`)).rejects.toMatchObject({ code: 'trade.limit_max_open_orders' });
    await expect(named(`oto:${entry.id}:exit`)).rejects.toMatchObject({ code: 'trade.limit_max_open_orders' });
    const placed = await named(`oto:${entry.id}:close`);
    expect(placed.clientOrderId).toBe(`oto:${entry.id}:close`);
  });

  it("the operator's open-order cap exempts a stored bracket exit the same way, but not a reduce-only order", async () => {
    // TEST FIXTURE: an operator cap of 1 on BTC, as an approved row (the owner cap stays unset).
    await db.sql`
      INSERT INTO trade.operator_risk_limits
        (id, market_id, version, collar, fat_finger, slippage_cap, throttle, circuit_breaker, operator_id, approver_id, reason, approval_id)
      VALUES (gen_random_uuid(), ${btc.id}, 1, NULL, NULL, NULL, '1', NULL, 'op', 'ap', 'test', gen_random_uuid())`;
    const entry = await rest(alice, btc, 'ob-entry');
    const exit = () =>
      trade.placeOrder(alice, {
        marketId: btc.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('60'),
        clientOrderId: `bracket:${entry.id}:exit`,
      } as never);
    await expect(exit()).rejects.toMatchObject({ code: 'trade.operator_throttle', data: { cap: '1', open: '1' } });
    // A reduce-only order that can rest counts like any other: spot has no position for it to shrink.
    await expect(rest(alice, btc, 'ob-reduce', { reduceOnly: true })).rejects.toMatchObject({ code: 'trade.operator_throttle' });
    await db.sql`INSERT INTO trade.order_bracket_intent (order_id, user_id, take_profit, stop_loss) VALUES (${entry.id}, ${ALICE}, 60, 40)`;
    // The entry still rests: the stored intent alone does not exempt its exit from the operator cap.
    await expect(exit()).rejects.toMatchObject({ code: 'trade.operator_throttle' });
    await db.sql`UPDATE trade.orders SET status = 'filled' WHERE id = ${entry.id}`;
    // Another order takes the one slot, so only the exemption lets the exit through.
    await rest(alice, btc, 'ob-second');
    expect((await exit()).clientOrderId).toBe(`bracket:${entry.id}:exit`);
    await expect(rest(alice, btc, 'ob-after')).rejects.toMatchObject({ code: 'trade.operator_throttle' });
  });

  it("the operator band never refuses a bracket's stop below it once the entry stopped resting", async () => {
    // TEST FIXTURE: a 10% band around the stub book's middle (99.5), so a sell below 89.55 is outside it.
    await db.sql`
      INSERT INTO trade.operator_risk_limits
        (id, market_id, version, collar, fat_finger, slippage_cap, throttle, circuit_breaker, operator_id, approver_id, reason, approval_id)
      VALUES (gen_random_uuid(), ${btc.id}, 1, '0.1', NULL, NULL, NULL, NULL, 'op', 'ap', 'test', gen_random_uuid())`;
    const entry = await rest(alice, btc, 'band-entry');
    const stop = () =>
      trade.placeOrder(alice, {
        marketId: btc.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('40'),
        clientOrderId: `bracket:${entry.id}:exit`,
      } as never);
    await expect(stop()).rejects.toMatchObject({ code: 'trade.price_band', data: { low: '89.55', high: '109.45' } });
    await db.sql`INSERT INTO trade.order_bracket_intent (order_id, user_id, take_profit, stop_loss) VALUES (${entry.id}, ${ALICE}, 120, 40)`;
    // The intent alone is not enough while the entry still rests.
    await expect(stop()).rejects.toMatchObject({ code: 'trade.price_band' });
    await db.sql`UPDATE trade.orders SET status = 'filled' WHERE id = ${entry.id}`;
    // The same name on another market borrows nothing: the exemption is the entry's own market.
    await db.sql`
      INSERT INTO trade.operator_risk_limits
        (id, market_id, version, collar, fat_finger, slippage_cap, throttle, circuit_breaker, operator_id, approver_id, reason, approval_id)
      VALUES (gen_random_uuid(), ${eth.id}, 1, '0.1', NULL, NULL, NULL, NULL, 'op', 'ap', 'test', gen_random_uuid())`;
    await expect(
      trade.placeOrder(alice, {
        marketId: eth.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('40'),
        clientOrderId: `bracket:${entry.id}:exit`,
      } as never),
    ).rejects.toMatchObject({ code: 'trade.price_band' });
    expect((await stop()).clientOrderId).toBe(`bracket:${entry.id}:exit`);
    // Any other sell that far under the market is still refused.
    await expect(rest(alice, btc, 'band-other', { side: 'sell', price: amt('40') })).rejects.toMatchObject({ code: 'trade.price_band' });
  });

  it('a replacement priced outside the band is refused before the original is cancelled', async () => {
    // TEST FIXTURE: a 10% band around the stub book's middle (99.5): buys above 109.45 are outside it.
    await db.sql`
      INSERT INTO trade.operator_risk_limits
        (id, market_id, version, collar, fat_finger, slippage_cap, throttle, circuit_breaker, operator_id, approver_id, reason, approval_id)
      VALUES (gen_random_uuid(), ${btc.id}, 1, '0.1', NULL, NULL, '20', NULL, 'op', 'ap', 'test', gen_random_uuid())`;
    const original = await rest(alice, btc, 'rb-original', { price: amt('95') });
    const heldBefore = holds();
    const replace = (price: string, key: string) =>
      trade.replaceOrder(alice, original.id, {
        marketId: btc.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt(price),
        clientOrderId: key,
      } as never);
    const refused = await replace('150', 'rb-out');
    expect(refused).toMatchObject({ accepted: false, code: 'LIMIT_REFUSED', reasonCode: 'trade.price_band', replacement: null });
    const [still] = await db.sql<Array<{ status: string }>>`SELECT status FROM trade.orders WHERE id = ${original.id}`;
    expect(still?.status).toBe('open');
    expect(holds()).toBe(heldBefore);
    expect((await replace('96', 'rb-in')).code).toBe('REPLACED');
  });

  it('the production default: a pair with no band or cap published refuses with the missing rule named, before any hold', async () => {
    const strict = new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
      allowUnpublishedPairRules: false,
    });
    const place = (key: string, extra: Record<string, unknown> = {}) =>
      strict.placeOrder(alice, {
        marketId: btc.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('99'),
        clientOrderId: key,
        ...extra,
      } as never);
    const before = holds();
    await expect(place('pub-1')).rejects.toMatchObject({ code: 'trade.price_band_unset', data: { rule: 'price band' } });
    await db.sql`
      INSERT INTO trade.operator_risk_limits
        (id, market_id, version, collar, fat_finger, slippage_cap, throttle, circuit_breaker, operator_id, approver_id, reason, approval_id)
      VALUES (gen_random_uuid(), ${btc.id}, 1, '0.1', NULL, NULL, NULL, NULL, 'op', 'ap', 'test', gen_random_uuid())`;
    const caught = await place('pub-2').catch((e: unknown) => e);
    expect(caught).toMatchObject({ code: 'trade.open_orders_cap_unset', data: { rule: 'open-order cap' } });
    expect(toCcxtError(caught)?.status).toBe(503);
    expect(holds()).toBe(before);
    expect(await db.sql`SELECT id FROM trade.orders WHERE user_id = ${ALICE}`).toHaveLength(0);
    // An order that cannot rest needs no cap.
    await place('pub-ioc', { tif: 'IOC' });
    await db.sql`
      INSERT INTO trade.operator_risk_limits
        (id, market_id, version, collar, fat_finger, slippage_cap, throttle, circuit_breaker, operator_id, approver_id, reason, approval_id)
      VALUES (gen_random_uuid(), ${btc.id}, 2, '0.1', NULL, NULL, '20', NULL, 'op', 'ap', 'test', gen_random_uuid())`;
    await place('pub-3');
  });
});
