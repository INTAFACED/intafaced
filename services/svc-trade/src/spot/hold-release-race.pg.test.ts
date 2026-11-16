/**
 * #8560: money held for an order is never released while the engine has matched part of that order and that fill is
 * not yet settled. The order of events is the one the OneHold model's checker printed (`model/OneHold.tla`): the
 * engine matches part of a resting order; a closer is handled before that fill is written; the fill then lands.
 *
 * Each closer below runs on the real trade service and a real Postgres. The engine is scripted (StubMatching), and the
 * taker's submit answer is held back by the test, which is exactly "the taker's settlement is still on its way".
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TradeService } from '../controls/test-admission.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from './testing.js';
import type { EngineSubmitRequest, EngineSubmitResult } from './matching-client.js';
import type { Market } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const alice = principalFor(ALICE, ['trade:read', 'trade:write']);
const bob = principalFor(BOB, ['trade:read', 'trade:write']);

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_hold_release_race_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('#8560: no closer releases a hold a matched fill still needs (PG-hard)', () => {
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

  /**
   * Alice rests a buy of 1 BTC at 50 (a 50 USDT hold). Bob sells 0.4 into it: the engine matches 0.4 and leaves 0.6
   * of Alice's order on the book, but the answer to Bob, and with it the settlement of that fill, is held back until
   * `deliver()` is called.
   */
  async function matchedButNotSettled() {
    await db.sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    const matching = new StubMatching();
    const trade = new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
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
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'race:a-usdt' }));
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'BTC', amount: amt('1'), rail: 'test', railRef: 'race:a-btc' }));
    await ledger.post(recipes.deposit({ userId: BOB, assetId: 'BTC', amount: amt('1'), rail: 'test', railRef: 'race:b-btc' }));

    const resting = await trade.placeOrder(alice, {
      marketId: market.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('50'),
      clientOrderId: 'race-rest',
    });

    // Bob's sell takes 0.4 of Alice's order. The engine's book moves at once; Bob's answer waits.
    matching.scriptFills([{ makerOrderId: resting.id, makerAccountId: ALICE, price: '50', qty: '0.4' }]);
    const engineSubmit = matching.submit.bind(matching);
    let deliver!: () => void;
    const delivered = new Promise<void>((resolve) => (deliver = resolve));
    let matched!: () => void;
    const hasMatched = new Promise<void>((resolve) => (matched = resolve));
    let held = true;
    matching.submit = async (marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> => {
      const answer = await engineSubmit(marketId, request);
      if (held) {
        held = false;
        // The book after the match: Bob's IOC-like sell filled in full, Alice's buy rests with 0.6.
        matching.scriptCancelMiss(request.orderId);
        matching.scriptLive(resting.id, market.id, '0.6', 1, ALICE);
        matched();
        await delivered;
      }
      return answer;
    };
    const taker = trade.placeOrder(bob, {
      marketId: market.id,
      side: 'sell',
      type: 'limit',
      qty: amt('0.4'),
      price: amt('50'),
      clientOrderId: 'race-take',
    });
    // Keep an unhandled rejection from ending the run before the assertions read it.
    const takerSettled = taker.then(
      (order) => ({ ok: true as const, order }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await hasMatched;

    const hold = async () =>
      (await ledger.balances('user', ALICE))
        .filter((b) => b.account.kind === 'hold' && b.account.assetId === 'USDT')
        .reduce((acc, b) => acc + b.amount, 0n);
    const status = async () =>
      (await db.sql<Array<{ status: string }>>`SELECT status FROM trade.orders WHERE id = ${resting.id}`)[0]?.status;
    const fillsOfResting = async () =>
      (await db.sql<Array<{ qty: string }>>`SELECT COALESCE(SUM(qty), 0)::text AS qty FROM trade.fills WHERE order_id = ${resting.id}`)[0]
        ?.qty;
    return { trade, matching, ledger, market, resting, deliver, takerSettled, hold, status, fillsOfResting };
  }

  it('"cancel all" (mass cancel) while 0.4 is matched and unsettled keeps the 20 USDT that fill draws, and the fill then settles', async () => {
    const t = await matchedButNotSettled();
    expect(await t.hold()).toBe(amt('50'));

    await t.trade.massCancelOrders(alice, t.market.id);
    // The fill the engine matched still needs 0.4 x 50 = 20 USDT of this hold.
    // Soft, so a failing run also shows what then happens to the taker's fill.
    expect.soft(await t.hold()).toBeGreaterThanOrEqual(amt('20'));
    expect.soft(await t.status()).toBe('open');

    t.deliver();
    const taken = await t.takerSettled;
    expect(taken.ok, taken.ok ? '' : String((taken as { error: unknown }).error)).toBe(true);
    expect(await t.fillsOfResting()).toBe('0.400000000000000000');

    // The engine's own cancel event for the mass cancel closes the order once the fill is written.
    await t.trade.releaseOnCancelEvent(t.resting.id, '0.6', 'requested');
    expect(await t.status()).toBe('cancelled');
    expect(await t.hold()).toBe(0n);
  });

  it('a self-trade pull of the resting order, while 0.4 of it is matched and unsettled, keeps the 20 USDT that fill draws', async () => {
    const t = await matchedButNotSettled();
    expect(await t.hold()).toBe(amt('50'));

    // Alice now sells at her own bid: the engine pulls her resting buy (cancel resting, continue taker) and reports
    // the pull as a cancellation in the same answer, with the 0.6 it took off the book.
    t.matching.scriptSelfTradePrevention(t.resting.id, ALICE, '0.6');
    await t.trade.placeOrder(alice, {
      marketId: t.market.id,
      side: 'sell',
      type: 'limit',
      qty: amt('0.5'),
      price: amt('50'),
      clientOrderId: 'race-self',
    });
    // Soft, so a failing run also shows what then happens to the taker's fill.
    expect.soft(await t.hold()).toBeGreaterThanOrEqual(amt('20'));
    expect.soft(await t.status()).toBe('open');

    t.deliver();
    const taken = await t.takerSettled;
    expect(taken.ok, taken.ok ? '' : String((taken as { error: unknown }).error)).toBe(true);
    expect(await t.fillsOfResting()).toBe('0.400000000000000000');

    // The engine published the pull as an order.cancelled too; that event closes the order once the fill is written.
    await t.trade.releaseOnCancelEvent(t.resting.id, '0.6', 'self_trade_prevention');
    expect(await t.status()).toBe('cancelled');
    expect(await t.hold()).toBe(0n);
  });

  it('the reconcile sweep cancelling a live order while 0.4 of it is matched and unsettled keeps the 20 USDT that fill draws', async () => {
    const t = await matchedButNotSettled();
    expect(await t.hold()).toBe(amt('50'));

    const result = await t.trade.reconcileOrder(t.resting.id);
    expect.soft(result.action).not.toBe('released');
    // Soft, so a failing run also shows what then happens to the taker's fill.
    expect.soft(await t.hold()).toBeGreaterThanOrEqual(amt('20'));
    expect.soft(await t.status()).toBe('open');

    t.deliver();
    const taken = await t.takerSettled;
    expect(taken.ok, taken.ok ? '' : String((taken as { error: unknown }).error)).toBe(true);
    expect(await t.fillsOfResting()).toBe('0.400000000000000000');

    await t.trade.releaseOnCancelEvent(t.resting.id, '0.6', 'requested');
    expect(await t.status()).toBe('cancelled');
    expect(await t.hold()).toBe(0n);
  });

  it("an expiry of the resting order reported in another submission's answer, while 0.4 of it is matched and unsettled, keeps the 20 USDT", async () => {
    const t = await matchedButNotSettled();
    expect(await t.hold()).toBe(amt('50'));

    // Bob places again; the engine's answer also reports that Alice's resting buy reached its expiry, with 0.6 left.
    t.matching.script1((request, next) => {
      const sequence = next();
      return {
        accepted: true,
        sequence,
        fills: [],
        resting: {
          kind: 'book',
          orderId: request.orderId,
          accountId: request.accountId,
          side: request.side,
          price: request.price ?? '0',
          remaining: request.qty,
          sequence,
        },
        rejected: null,
        cancellations: [{ orderId: t.resting.id, accountId: ALICE, remainingQty: '0.6', sequence: next(), reason: 'expired' }],
        triggered: [],
      };
    });
    await t.trade.placeOrder(bob, {
      marketId: t.market.id,
      side: 'sell',
      type: 'limit',
      qty: amt('0.1'),
      price: amt('60'),
      clientOrderId: 'race-expiry',
    });
    expect.soft(await t.hold()).toBeGreaterThanOrEqual(amt('20'));
    expect.soft(await t.status()).toBe('open');

    t.deliver();
    const taken = await t.takerSettled;
    expect(taken.ok, taken.ok ? '' : String((taken as { error: unknown }).error)).toBe(true);
    expect(await t.fillsOfResting()).toBe('0.400000000000000000');

    await t.trade.releaseOnCancelEvent(t.resting.id, '0.6', 'expired');
    expect(await t.status()).toBe('expired');
    expect(await t.hold()).toBe(0n);
  });

  it("a person's own cancel in the same window already waits (the guarded closer, as before)", async () => {
    const t = await matchedButNotSettled();
    expect((await t.trade.cancelOrder(alice, t.resting.id)).status).toBe('open');
    expect(await t.hold()).toBe(amt('50'));

    t.deliver();
    const taken = await t.takerSettled;
    expect(taken.ok, taken.ok ? '' : String((taken as { error: unknown }).error)).toBe(true);
    await t.trade.releaseOnCancelEvent(t.resting.id, '0.6', 'requested');
    expect(await t.status()).toBe('cancelled');
    expect(await t.hold()).toBe(0n);
  });
});
