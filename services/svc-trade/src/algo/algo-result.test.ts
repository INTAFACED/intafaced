/**
 * ALGORESULT — derived schedule result and scheduler honesty.
 *
 * Worked buy (and the same prices on a sell):
 *   fills 10×1, 20×1, 30.1×1
 *   notional = 60.1 exactly (each product divides by 10^18 with no remainder)
 *   average = 60.1 / 3 at 18dp, half-up
 *     60100000000000000000 / 3 = 20033333333333333333 remainder 1
 *     2×1 < 3, so no round up → 20.033333333333333333
 *   arrival 20
 *   buy shortfall  notional − 20 × 3 = 0.1 (no double rounding)
 *   sell shortfall 20 × 3 − notional = −0.1
 *   fees stored 0.01 USDT + 0.02 USDT + 0.001 BTC, fee_bps 1
 *     1 bp of these notionals is not 0.01, so a rate recomputation fails this test
 *   quote_amount is stored as 1, not the notional, so summing that column fails too
 */
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { TradeService } from '../controls/test-admission.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from '../spot/testing.js';
import { createTradeRouter, type TradeRouter } from '../router.js';
import { FORBIDDEN_PARENT_MONEY_KEYS, assertParentHasNoMoneyFields } from './present.js';
import { SqlTwapParentStore } from './parent-store.js';
import { TwapEngine } from './twap-engine.js';
import { deriveAlgoResult } from './algo-result.js';
import {
  HEARTBEAT_FRESH_INTERVALS,
  newestSchedulerHeartbeat,
  readSchedulerState,
  recordSchedulerHeartbeat,
} from './scheduler-heartbeat.js';
import type { TwapParent } from './types.js';

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

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SECRET = 'algo-result-edge-secret-long-enough-32';
const READ = ['trade:read'] as const;

const AVERAGE = '20.033333333333333333';
const BUY_SHORTFALL = '0.1';
const SELL_SHORTFALL = '-0.1';

describe('deriveAlgoResult (no database)', () => {
  it('a fill without a fee amount makes feesPaid null', () => {
    const result = deriveAlgoResult({
      side: 'buy',
      quoteAsset: 'USDT',
      arrivalPrice: parseAmount('20'),
      fills: [
        { price: parseAmount('10'), qty: parseAmount('1'), quoteAsset: 'USDT', feeAsset: 'USDT', feeAmount: parseAmount('0.01') },
        { price: parseAmount('20'), qty: parseAmount('1'), quoteAsset: 'USDT', feeAsset: 'USDT', feeAmount: null },
      ],
    });
    expect(result.quotes[0]).toMatchObject({
      filledQty: '2',
      notional: '30',
      feesPaid: null,
      feesReason: 'fee_not_recorded',
    });
  });

  it('treats a heartbeat older than three intervals as stale and one at the bound as fresh', () => {
    const intervalMs = 1_000;
    const at = new Date('2026-10-18T00:00:00.000Z');
    expect(HEARTBEAT_FRESH_INTERVALS).toBe(3);
    expect(
      readSchedulerState({
        jobsEnabled: true,
        intervalMs,
        newestTickAt: at,
        now: new Date(at.getTime() + 3 * intervalMs),
      }),
    ).toEqual({ running: true, reason: null });
    expect(
      readSchedulerState({
        jobsEnabled: true,
        intervalMs,
        newestTickAt: at,
        now: new Date(at.getTime() + 3 * intervalMs + 1),
      }),
    ).toEqual({ running: false, reason: 'heartbeat_stale' });
    expect(readSchedulerState({ jobsEnabled: false, intervalMs: null, newestTickAt: at, now: at })).toEqual({
      running: false,
      reason: 'jobs_disabled',
    });
    expect(readSchedulerState({ jobsEnabled: true, intervalMs: null, newestTickAt: null, now: at })).toEqual({
      running: null,
      reason: 'jobs_interval_unset',
    });
    expect(readSchedulerState({ jobsEnabled: true, intervalMs, newestTickAt: null, now: at })).toEqual({
      running: null,
      reason: 'heartbeat_unknown',
    });
  });
});

describe('algo.result and scheduler honesty (shared test postgres)', () => {
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let trade: TradeService;
  let marketId: string;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: testDatabaseUrl(), migrations });
    sql = db.sql;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.algo_scheduler_heartbeat, trade.fills, trade.orders, trade.algo_parents, trade.markets
      RESTART IDENTITY CASCADE
    `;
    trade = new TradeService(sql, new MemoryLedger(), new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
      algoJobsEnabled: false,
    });
    const market = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: parseAmount('0.01'),
      lotSize: parseAmount('0.001'),
      minQty: parseAmount('0.001'),
      maxQty: parseAmount('1000'),
      minNotional: parseAmount('0.01'),
      makerBps: 10,
      takerBps: 20,
    });
    marketId = market.id;
  });

  function parent(over: Partial<TwapParent> & Pick<TwapParent, 'id' | 'side' | 'status'>): TwapParent {
    const now = new Date('2026-10-18T00:00:00.000Z');
    return {
      userId: ALICE,
      subAccountId: null,
      marketId,
      symbol: 'BTC/USDT',
      kind: 'twap',
      totalQty: parseAmount('3'),
      durationMs: 60_000,
      sliceIntervalMs: 1_000,
      limitPrice: null,
      createdAt: now,
      startedAt: now,
      nextDueAt: now,
      projectedEndsAt: new Date(now.getTime() + 60_000),
      scheduleStretchReason: null,
      pausedAt: null,
      haltReason: null,
      lotSize: parseAmount('0.001'),
      participationBps: null,
      slicesPlanned: 3,
      nextSliceIndex: 3,
      children: [],
      misses: [],
      ...over,
    };
  }

  async function insertFill(
    orderId: string,
    price: string,
    qty: string,
    feeAsset: string,
    feeAmount: string,
    sequence: number,
    side: 'buy' | 'sell',
  ) {
    await sql`
      INSERT INTO orders (
        id, user_id, market_id, client_order_id, side, type, price, qty, filled_qty, status, tif, hold_asset, hold_amount
      ) VALUES (
        ${orderId}::uuid, ${ALICE}::uuid, ${marketId}::uuid, ${`c-${orderId}`}, ${side}, 'limit',
        ${price}::numeric, ${qty}::numeric, ${qty}::numeric, 'filled', 'GTC', 'USDT', 1
      )
    `;
    await sql`
      INSERT INTO fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
      ) VALUES (
        ${randomUUID()}::uuid, ${orderId}::uuid, ${randomUUID()}::uuid, ${marketId}::uuid, ${ALICE}::uuid,
        ${side}, 'maker', ${price}::numeric, ${qty}::numeric, 1, ${feeAsset}, ${feeAmount}::numeric, 1, ${sequence}
      )
    `;
  }

  async function threeChildren(id: string, side: 'buy' | 'sell', seq: number) {
    const specs = [
      { price: '10', feeAsset: 'USDT', feeAmount: '0.01' },
      { price: '20', feeAsset: 'USDT', feeAmount: '0.02' },
      { price: '30.1', feeAsset: 'BTC', feeAmount: '0.001' },
    ];
    const now = new Date('2026-10-18T00:00:00.000Z');
    const children = [];
    for (let i = 0; i < specs.length; i++) {
      const orderId = randomUUID();
      const spec = specs[i]!;
      await insertFill(orderId, spec.price, '1', spec.feeAsset, spec.feeAmount, seq + i, side);
      children.push({
        sliceIndex: i,
        orderId,
        clientOrderId: `algo:${id}:${i}`,
        qty: parseAmount('1'),
        placedAt: now,
      });
    }
    return children;
  }

  it('sums three buy fills and three sell fills to the last decimal, with opposite shortfall signs', async () => {
    const store = new SqlTwapParentStore(sql);
    const at = new Date('2026-10-18T00:00:00.000Z');
    const buyChildren = await threeChildren('algo-buy', 'buy', 1);
    const sellChildren = await threeChildren('algo-sell', 'sell', 11);
    await store.save({
      parent: parent({ id: 'algo-buy', side: 'buy', status: 'active', children: buyChildren }),
      plan: [parseAmount('1'), parseAmount('1'), parseAmount('1')],
    });
    await store.save({
      parent: parent({ id: 'algo-sell', side: 'sell', status: 'active', children: sellChildren }),
      plan: [parseAmount('1'), parseAmount('1'), parseAmount('1')],
    });
    await store.recordArrivalMark('algo-buy', parseAmount('20'), at);
    await store.recordArrivalMark('algo-sell', parseAmount('20'), at);
    expect(await store.recordArrivalMark('algo-buy', parseAmount('99'), at)).toBe(false);

    const alice = principalFor(ALICE, [...READ]);
    const buy = await trade.algoResult(alice, 'algo-buy');
    const sell = await trade.algoResult(alice, 'algo-sell');
    expect(buy.quotes).toEqual([
      {
        quoteAsset: 'USDT',
        filledQty: '3',
        notional: '60.1',
        averageFillPrice: AVERAGE,
        feesPaid: [
          { asset: 'BTC', amount: '0.001' },
          { asset: 'USDT', amount: '0.03' },
        ],
        feesReason: null,
        arrivalPrice: '20',
        arrivalReason: null,
        shortfall: BUY_SHORTFALL,
        shortfallMissing: null,
      },
    ]);
    expect(sell.quotes[0]).toMatchObject({
      filledQty: '3',
      notional: '60.1',
      averageFillPrice: AVERAGE,
      feesPaid: [
        { asset: 'BTC', amount: '0.001' },
        { asset: 'USDT', amount: '0.03' },
      ],
      shortfall: SELL_SHORTFALL,
    });
    expect(buy.quotes[0]!.shortfall!.startsWith('-')).toBe(false);
    expect(sell.quotes[0]!.shortfall!.startsWith('-')).toBe(true);
  });

  it('returns zero quantity and a null average when nothing has filled', async () => {
    const store = new SqlTwapParentStore(sql);
    await store.save({
      parent: parent({ id: 'algo-empty', side: 'buy', status: 'active', nextSliceIndex: 0, children: [] }),
      plan: [parseAmount('1')],
    });
    await store.recordArrivalMark('algo-empty', parseAmount('20'), new Date('2026-10-18T00:00:00.000Z'));
    const result = await trade.algoResult(principalFor(ALICE, [...READ]), 'algo-empty');
    expect(result.quotes[0]).toMatchObject({
      filledQty: '0',
      notional: '0',
      averageFillPrice: null,
      feesPaid: [],
      feesReason: null,
      arrivalPrice: '20',
      shortfall: null,
      shortfallMissing: { code: 'missing_input', fields: ['averageFillPrice'] },
    });
  });

  it('names arrival_not_recorded on a legacy parent and names that input on the shortfall', async () => {
    const store = new SqlTwapParentStore(sql);
    const children = await threeChildren('algo-legacy', 'buy', 21);
    await store.save({
      parent: parent({ id: 'algo-legacy', side: 'buy', status: 'active', children }),
      plan: [parseAmount('1'), parseAmount('1'), parseAmount('1')],
    });
    const result = await trade.algoResult(principalFor(ALICE, [...READ]), 'algo-legacy');
    expect(result.quotes[0]).toMatchObject({
      averageFillPrice: AVERAGE,
      arrivalPrice: null,
      arrivalReason: 'arrival_not_recorded',
      shortfall: null,
      shortfallMissing: { code: 'missing_input', fields: ['arrivalPrice'] },
    });
  });

  it('writes the arrival mark once and keeps it across a new store', async () => {
    const store = new SqlTwapParentStore(sql);
    let clock = Date.parse('2026-10-18T00:00:00.000Z');
    let markPrice = parseAmount('50');
    const writes: Promise<unknown>[] = [];
    const engineFor = (target: SqlTwapParentStore) =>
      new TwapEngine(
        {
          now: () => new Date(clock),
          randomId: () => 'arrival-restart',
          placeChild: async () => {
            throw new Error('child refused on purpose');
          },
          cancelChild: async () => undefined,
          bestOpposingPrice: async () => parseAmount('50'),
          markFor: async (id) => ({ marketId: id, price: markPrice, asOf: new Date(clock), quality: 'mid' as const }),
          recordArrivalMark: (id, mark) => target.recordArrivalMark(id, mark.price, mark.asOf),
        },
        {
          onChange: (row, plan) => {
            const write = target.save({ parent: row, plan });
            writes.push(write);
            return write;
          },
        },
      );
    const engine = engineFor(store);
    const created = engine.create(
      ALICE,
      {
        marketId,
        symbol: 'BTC/USDT',
        side: 'buy',
        totalQty: parseAmount('0.002'),
        durationMs: 2_000,
        sliceIntervalMs: 1_000,
        limitPrice: null,
        subAccountId: null,
        clientAlgoId: 'arrival',
      },
      parseAmount('0.001'),
    );
    await Promise.all(writes.splice(0));
    await engine.tick(created.id);
    await Promise.all(writes.splice(0));

    clock += 1_000;
    markPrice = parseAmount('70');
    const restarted = new SqlTwapParentStore(sql);
    const again = engineFor(restarted);
    const loaded = await restarted.load(created.id);
    again.hydrate(loaded!.parent, loaded!.plan);
    await again.tick(created.id);
    await Promise.all(writes.splice(0));

    const arrival = await new SqlTwapParentStore(sql).loadArrivalMark(created.id);
    expect(formatAmount(arrival!.price)).toBe('50');
    expect(arrival!.at.toISOString()).toBe('2026-10-18T00:00:00.000Z');
    const parentRow = await trade.getAlgo(principalFor(ALICE, [...READ]), created.id);
    assertParentHasNoMoneyFields(parentRow);
    expect(parentRow).not.toHaveProperty('arrivalPrice');
  });

  it('refuses another user and an unknown id with trade.algo_not_found', async () => {
    const store = new SqlTwapParentStore(sql);
    await store.save({ parent: parent({ id: 'algo-alice', side: 'buy', status: 'active' }), plan: [parseAmount('1')] });
    await expect(trade.algoResult(principalFor(BOB, [...READ]), 'algo-alice')).rejects.toMatchObject({ code: 'trade.algo_not_found' });
    await expect(trade.algoResult(principalFor(ALICE, [...READ]), 'missing')).rejects.toMatchObject({ code: 'trade.algo_not_found' });
    await expect(trade.getAlgo(principalFor(BOB, [...READ]), 'algo-alice')).rejects.toMatchObject({ code: 'trade.algo_not_found' });
  });

  it('keeps money keys off algo.get and sends trade.algo_not_found on the wire', async () => {
    const store = new SqlTwapParentStore(sql);
    await store.save({ parent: parent({ id: 'algo-wire', side: 'buy', status: 'active' }), plan: [parseAmount('1')] });
    const app = await mount(trade);
    const got = await get(app, 'algo.get', { algoId: 'algo-wire' });
    expect(got.statusCode).toBe(200);
    const body = got.body.result!.data!;
    const loaded = await trade.getAlgo(principalFor(ALICE, [...READ]), 'algo-wire');
    assertParentHasNoMoneyFields(loaded);
    for (const key of FORBIDDEN_PARENT_MONEY_KEYS) {
      if (key === 'filledQty') continue;
      expect(body).not.toHaveProperty(key);
    }
    expect(body.filledQty).toBe('0');
    expect(body).not.toHaveProperty('arrivalPrice');
    expect(body).not.toHaveProperty('averageFillPrice');
    expect(body.scheduler).toEqual({ running: false, reason: 'jobs_disabled' });
    expect(body.nextSliceAt).toBe('2026-10-18T00:00:00.000Z');

    const unknownGet = await get(app, 'algo.get', { algoId: 'no-such-algo' });
    const unknownResult = await get(app, 'algo.result', { algoId: 'no-such-algo' });
    expect(unknownGet.body.error?.data?.cause?.code).toBe('trade.algo_not_found');
    expect(unknownResult.body.error?.data?.cause?.code).toBe('trade.algo_not_found');
    expect(unknownGet.body.error?.data?.code).not.toBe('INTERNAL_SERVER_ERROR');
    await app.close();
  });

  it('shows nextSliceAt only while active, and jobs off as jobs_disabled', async () => {
    const store = new SqlTwapParentStore(sql);
    const alice = principalFor(ALICE, [...READ]);
    await store.save({ parent: parent({ id: 'algo-live', side: 'buy', status: 'active' }), plan: [parseAmount('1')] });
    await store.save({ parent: parent({ id: 'algo-done', side: 'buy', status: 'completed' }), plan: [parseAmount('1')] });
    await store.save({ parent: parent({ id: 'algo-stop', side: 'buy', status: 'cancelled' }), plan: [parseAmount('1')] });
    const live = await trade.algoProgress(alice, 'algo-live');
    const done = await trade.algoProgress(alice, 'algo-done');
    const stopped = await trade.algoProgress(alice, 'algo-stop');
    expect(live.scheduler).toEqual({ running: false, reason: 'jobs_disabled' });
    expect(live.nextSliceAt).toBe('2026-10-18T00:00:00.000Z');
    expect(done.nextSliceAt).toBeNull();
    expect(stopped.nextSliceAt).toBeNull();
    const page = await trade.algoList(alice, { limit: 10 });
    const byId = new Map(page.rows.map((row) => [row.id, row]));
    expect(byId.get('algo-live')?.nextSliceAt).toBe('2026-10-18T00:00:00.000Z');
    expect(byId.get('algo-done')?.nextSliceAt).toBeNull();
    expect(byId.get('algo-live')?.scheduler).toEqual({ running: false, reason: 'jobs_disabled' });
    expect(page.rows.some((row) => row.id === 'algo-wire')).toBe(false);
    const bob = await trade.algoList(principalFor(BOB, [...READ]), { limit: 10 });
    expect(bob.rows).toEqual([]);
  });

  it('counts every fill of a child past 500, and survives a child whose order row is gone', async () => {
    const store = new SqlTwapParentStore(sql);
    const orderId = randomUUID();
    await sql`
      INSERT INTO orders (
        id, user_id, market_id, client_order_id, side, type, price, qty, filled_qty, status, tif, hold_asset, hold_amount
      ) VALUES (
        ${orderId}::uuid, ${ALICE}::uuid, ${marketId}::uuid, ${`c-${orderId}`}, 'buy', 'limit',
        10, 600, 600, 'filled', 'GTC', 'USDT', 1
      )
    `;
    await sql`
      INSERT INTO fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
      )
      SELECT gen_random_uuid(), ${orderId}::uuid, gen_random_uuid(), ${marketId}::uuid, ${ALICE}::uuid,
        'buy', 'maker', 10, 1, 1, 'USDT', 0.01, 1, 1000 + g
      FROM generate_series(1, 600) AS g
    `;
    const children = [
      { sliceIndex: 0, orderId, clientOrderId: 'algo:algo-big:0', qty: parseAmount('600'), placedAt: new Date('2026-10-18T00:00:00.000Z') },
      {
        sliceIndex: 1,
        orderId: randomUUID(),
        clientOrderId: 'algo:algo-big:1',
        qty: parseAmount('1'),
        placedAt: new Date('2026-10-18T00:00:00.000Z'),
      },
    ];
    await store.save({
      parent: parent({ id: 'algo-big', side: 'buy', status: 'active', children }),
      plan: [parseAmount('600'), parseAmount('1')],
    });
    const alice = principalFor(ALICE, [...READ]);
    const result = await trade.algoResult(alice, 'algo-big');
    expect(result.quotes[0]).toMatchObject({
      filledQty: '600',
      notional: '6000',
      averageFillPrice: '10',
      feesPaid: [{ asset: 'USDT', amount: '6' }],
    });
    expect((await trade.algoProgress(alice, 'algo-big')).filledQty).toBe('600');
  });

  it('keeps one heartbeat row per host after a restart changes the pid', async () => {
    await recordSchedulerHeartbeat(sql, 'host-x:100', new Date('2026-10-18T01:00:00.000Z'));
    await recordSchedulerHeartbeat(sql, 'host-x:200', new Date('2026-10-18T01:00:05.000Z'));
    await recordSchedulerHeartbeat(sql, 'host-y:100', new Date('2026-10-18T01:00:06.000Z'));
    const rows = await sql<Array<{ instance_id: string }>>`SELECT instance_id FROM algo_scheduler_heartbeat ORDER BY 1`;
    expect(rows.map((r) => r.instance_id)).toEqual(['host-x:200', 'host-y:100']);
  });

  it('reads a fresh heartbeat as running and a stale one as heartbeat_stale, and the row survives', async () => {
    const store = new SqlTwapParentStore(sql);
    await store.save({ parent: parent({ id: 'algo-beat', side: 'buy', status: 'active' }), plan: [parseAmount('1')] });
    const tickAt = new Date('2026-10-18T01:00:00.000Z');
    await recordSchedulerHeartbeat(sql, 'instance-a', tickAt);
    const intervalMs = 1_000;
    const fresh = serviceAt(sql, new Date(tickAt.getTime() + HEARTBEAT_FRESH_INTERVALS * intervalMs), intervalMs);
    const freshView = await fresh.algoScheduler();
    expect(freshView).toEqual({ running: true, reason: null });
    const progress = await fresh.algoProgress(principalFor(ALICE, [...READ]), 'algo-beat');
    expect(progress.scheduler).toEqual({ running: true, reason: null });

    const stale = serviceAt(sql, new Date(tickAt.getTime() + HEARTBEAT_FRESH_INTERVALS * intervalMs + 1), intervalMs);
    expect(await stale.algoScheduler()).toEqual({ running: false, reason: 'heartbeat_stale' });

    const afterRestart = await newestSchedulerHeartbeat(sql);
    expect(afterRestart?.toISOString()).toBe(tickAt.toISOString());
    await expect(fresh.algoResult(principalFor(BOB, [...READ]), 'algo-beat')).rejects.toMatchObject({ code: 'trade.algo_not_found' });
    await expect(fresh.algoProgress(principalFor(ALICE, ['admin:read']), 'algo-beat')).rejects.toMatchObject({ code: 'scope.denied' });
  });
});

function serviceAt(sql: Sql, now: Date, intervalMs: number): TradeService {
  return new TradeService(sql, new MemoryLedger(), new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
    feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
    marketLifecycle: READY_MARKET_LIFECYCLE,
    algoJobsEnabled: true,
    algoJobsIntervalMs: intervalMs,
    now: () => now,
  });
}

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

function signedHeaders(p: Principal): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

async function mount(trade: TradeService) {
  const router = createTradeRouter(trade);
  const app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<TradeRouter>['trpcOptions'],
  });
  await app.ready();
  return app;
}

type WireBody = {
  result?: { data?: Record<string, unknown> };
  error?: { message?: string; data?: { code?: string; cause?: { code?: string } } };
};

async function get(app: Awaited<ReturnType<typeof mount>>, path: string, input: Record<string, unknown>) {
  const qs = encodeURIComponent(JSON.stringify(input));
  const res = await app.inject({
    method: 'GET',
    url: `/trpc/${path}?input=${qs}`,
    headers: signedHeaders(principalFor(ALICE, [...READ])),
  });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}
