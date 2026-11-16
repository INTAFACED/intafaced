/**
 * #8560, the reconcile's engine-miss branch: an order the engine filled in full leaves the book at once, while the fill
 * reaches trade.fills later (the taker's settlement, the fill consumer). In that window the book does not list the order
 * and trade.fills shows no fill, which is exactly what an order the engine lost looks like. The operator's single-order
 * reconcile must not release the hold on that one look: the fill draws all of it.
 *
 * Real trade service, real Postgres; the engine is scripted (StubMatching) and the taker's submit answer is held back by
 * the test, which is "the taker's settlement is still on its way".
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
    .withDatabase('intafaced_engine_miss_release_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('#8560: an engine miss is not proof of no fill (PG-hard)', () => {
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
   * Alice rests a buy of 1 BTC at 50 (a 50 USDT hold). Bob sells 1 into it: the engine fills Alice's order in full and
   * takes it off the book, but the answer to Bob, and with it the settlement of that fill, is held back until
   * `deliver()` is called.
   */
  async function filledButNotSettled() {
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
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'miss:a-usdt' }));
    await ledger.post(recipes.deposit({ userId: BOB, assetId: 'BTC', amount: amt('1'), rail: 'test', railRef: 'miss:b-btc' }));

    const resting = await trade.placeOrder(alice, {
      marketId: market.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('50'),
      clientOrderId: 'miss-rest',
    });

    // Bob's sell takes all of Alice's order. The engine's book moves at once; Bob's answer waits.
    matching.scriptFills([{ makerOrderId: resting.id, makerAccountId: ALICE, price: '50', qty: '1' }]);
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
        // The book after the match: neither order rests any more.
        matching.scriptCancelMiss(request.orderId);
        matching.scriptCancelMiss(resting.id);
        matched();
        await delivered;
      }
      return answer;
    };
    const taker = trade.placeOrder(bob, {
      marketId: market.id,
      side: 'sell',
      type: 'limit',
      qty: amt('1'),
      price: amt('50'),
      clientOrderId: 'miss-take',
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

  it("the operator's single-order reconcile, while the engine's full fill of the order is unsettled, keeps the 50 USDT that fill draws", async () => {
    const t = await filledButNotSettled();
    expect(await t.hold()).toBe(amt('50'));

    // The book no longer lists the order and trade.fills shows nothing yet: one look cannot tell this from a lost order.
    const result = await t.trade.reconcileOrder(t.resting.id);
    // Soft, so a failing run also shows what then happens to the taker's fill.
    expect.soft(result.action).not.toBe('released');
    expect.soft(await t.hold()).toBe(amt('50'));
    expect.soft(await t.status()).toBe('open');

    t.deliver();
    const taken = await t.takerSettled;
    expect(taken.ok, taken.ok ? '' : String((taken as { error: unknown }).error)).toBe(true);
    expect(await t.fillsOfResting()).toBe('1.000000000000000000');
    expect(await t.status()).toBe('filled');
    expect(await t.hold()).toBe(0n);
  });
});
