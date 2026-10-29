import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { TradeService } from '../controls/test-admission.js';
import { installIcebergPlace } from '../spot/iceberg-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from '../spot/testing.js';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import type { PlaceOrderInput } from '../spot/trade-service.js';
import {
  attachIcebergDisplay,
  memoryIcebergDisplay,
  sqlIcebergDisplay,
  TRADE_ICEBERG_DISPLAY_INVALID,
  TRADE_ICEBERG_SYMBOL_CAP,
} from '../spot/iceberg-door.js';
import { SqlTwapParentStore } from '../algo/parent-store.js';
import { TwapEngine } from '../algo/twap-engine.js';
import { presentAlgoDesk } from '../algo/present.js';
import type { AlgoStatus, TwapParent } from '../algo/types.js';
import { listAlgoParents, TRADE_ALGO_LIST_FROM_BEFORE_WINDOW, TRADE_ALGO_LIST_LIMIT_UNSET } from '../algo/algo-list.js';
import { listAlgoReports } from '../orders/order-events.js';
import { listOptionsCatalogue, OPTIONS_NO_QUOTE_FEED, TRADE_OPTIONS_CATALOGUE_LIMIT_UNSET } from '../spot/options-catalogue.js';
import { optionsExercises, optionsMarginPreview, optionsPositions, TRADE_OPTIONS_MODEL_UNSET } from '../spot/options-doors.js';
import { OPTIONS_FIXING_UNCONFIGURED, OPTIONS_SETTLEMENT_LAW_UNSET } from '../spot/options-policy.js';
import { exportRfqHistory, listRfqHistory, TRADE_RFQ_LIST_WINDOW_TOO_WIDE, TRADE_RFQ_LIST_WINDOW_UNSET } from '../otc/rfq-history.js';
import { attachRfqExportRoute } from '../otc/rfq-history-rest.js';
import {
  createScaleGroup,
  SCALE_REMAINDER_LEVEL,
  TRADE_SCALE_CHILD_REFUSED,
  TRADE_SCALE_GROUP_NOT_FOUND,
  TRADE_SCALE_INSUFFICIENT_BALANCE,
  TRADE_SCALE_LEVEL_INVALID,
  TRADE_SCALE_ROLLBACK_INCOMPLETE,
  type ScaleGroupPorts,
} from '../spot/scale-group.js';
import { TradeError, type Market } from '../spot/types.js';

installIcebergPlace(TradeService);

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
const SECRET = 'a-trade-private-rest-edge-secret-long-enough';
const BOTH = ['trade:read', 'trade:write'] as const;

function monthsAgo(from: Date, months: number): Date {
  const copy = new Date(from);
  copy.setUTCMonth(copy.getUTCMonth() - months);
  return copy;
}

function parentRow(over: Partial<TwapParent> & Pick<TwapParent, 'id' | 'userId' | 'marketId' | 'status' | 'createdAt'>): TwapParent {
  return {
    subAccountId: null,
    symbol: 'BTC/USDT',
    side: 'buy',
    kind: 'twap',
    totalQty: parseAmount('1'),
    durationMs: 60_000,
    sliceIntervalMs: 2_000,
    limitPrice: parseAmount('100'),
    startedAt: over.createdAt,
    nextDueAt: over.createdAt,
    projectedEndsAt: over.createdAt,
    scheduleStretchReason: null,
    pausedAt: null,
    haltReason: null,
    lotSize: parseAmount('0.001'),
    participationBps: null,
    slicesPlanned: 1,
    nextSliceIndex: 0,
    children: [],
    misses: [],
    ...over,
  };
}

describe('desk doors (no database)', () => {
  it('refuses an iceberg display that is not a smaller lot-sized limit peak', async () => {
    const market = {
      id: '33333333-3333-4333-8333-333333333333',
      symbol: 'BTC/USDT',
      lotSize: parseAmount('0.1'),
    } as Market;
    const qty = parseAmount('10');
    const base = { symbol: 'BTC/USDT', side: 'buy' as const, type: 'limit' as const, qty, price: parseAmount('100'), clientOrderId: 'ice' };
    const deps = {
      marketBySymbol: async () => market,
      lifecycleForMarket: async () => READY_MARKET_LIFECYCLE.snapshot(market),
    };
    const ok = await attachIcebergDisplay(deps, base, { type: 'limit', symbol: 'BTC/USDT' }, '2');
    expect(formatAmount((ok.input as unknown as { displayQty: bigint }).displayQty)).toBe('2');
    await expect(attachIcebergDisplay(deps, base, { type: 'limit', symbol: 'BTC/USDT' }, '10')).rejects.toMatchObject({
      code: TRADE_ICEBERG_DISPLAY_INVALID,
    });
    await expect(attachIcebergDisplay(deps, base, { type: 'limit', symbol: 'BTC/USDT' }, '0')).rejects.toMatchObject({
      code: TRADE_ICEBERG_DISPLAY_INVALID,
    });
    await expect(attachIcebergDisplay(deps, base, { type: 'limit', symbol: 'BTC/USDT' }, '0.15')).rejects.toMatchObject({
      code: TRADE_ICEBERG_DISPLAY_INVALID,
    });
    await expect(attachIcebergDisplay(deps, base, { type: 'market', symbol: 'BTC/USDT' }, '2')).rejects.toMatchObject({
      code: TRADE_ICEBERG_DISPLAY_INVALID,
    });
    const closed = {
      marketBySymbol: deps.marketBySymbol,
      lifecycleForMarket: async () => {
        const snap = await READY_MARKET_LIFECYCLE.snapshot(market);
        return { ...snap, allowedActions: snap.allowedActions.filter((action) => action !== 'PLACE' && action !== 'PLACE_POST_ONLY') };
      },
    };
    await expect(attachIcebergDisplay(closed, base, { type: 'limit', symbol: 'BTC/USDT' }, '2')).rejects.toMatchObject({
      code: TRADE_ICEBERG_DISPLAY_INVALID,
    });
    await expect(
      attachIcebergDisplay({ marketBySymbol: deps.marketBySymbol }, base, { type: 'limit', symbol: 'BTC/USDT' }, '2'),
    ).rejects.toMatchObject({
      code: 'trade.lifecycle_authority_unavailable',
    });
  });

  it('echoes displayQty on POST /api/v1/orders and replays the first order', async () => {
    const placed: Array<{ clientOrderId?: string; iceberg?: boolean; displayQty?: bigint }> = [];
    const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const store = memoryIcebergDisplay();
    const market = {
      id: '33333333-3333-4333-8333-333333333333',
      symbol: 'BTC/USDT',
      lotSize: parseAmount('0.1'),
    } as Market;
    const app = Fastify();
    registerPrivateRest(app, {
      edgeSecret: SECRET,
      serviceName: 'svc-trade',
      icebergDisplay: store,
      marketBySymbol: async () => market,
      marketById: async () => market,
      lifecycleForMarket: () => READY_MARKET_LIFECYCLE.snapshot(market),
      placeOrder: async (principal: Principal, input: PlaceOrderInput) => {
        const tagged = input as typeof input & { iceberg?: boolean; displayQty?: bigint };
        const prior = placed.find((row) => row.clientOrderId === input.clientOrderId);
        if (prior)
          return fakeOrder({
            id: firstId,
            userId: principal.userId,
            marketId: market.id,
            clientOrderId: input.clientOrderId,
            qty: input.qty,
            price: input.price,
          });
        placed.push({ clientOrderId: input.clientOrderId, iceberg: tagged.iceberg, displayQty: tagged.displayQty });
        return fakeOrder({
          id: firstId,
          userId: principal.userId,
          marketId: market.id,
          clientOrderId: input.clientOrderId,
          qty: input.qty,
          price: input.price,
        });
      },
    } as unknown as PrivateRestDeps);
    const headers = signedHeaders();
    const body = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '10', price: '100', clientOrderId: 'ice-1', displayQty: '2' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: body });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ id: firstId, displayQty: '2' });
    expect(placed).toHaveLength(1);
    expect(placed[0]?.iceberg).toBe(true);
    expect(formatAmount(placed[0]!.displayQty!)).toBe('2');
    const replay = await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: { ...body, displayQty: '3' } });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ id: firstId, displayQty: '2' });
    expect(placed).toHaveLength(1);
    const marketOrder = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers,
      payload: { symbol: 'BTC/USDT', type: 'market', side: 'buy', amount: '10', clientOrderId: 'ice-mkt', displayQty: '2' },
    });
    expect(marketOrder.statusCode).toBe(400);
    expect(marketOrder.json().intafacedCode).toBe(TRADE_ICEBERG_DISPLAY_INVALID);
    expect(placed).toHaveLength(1);
    await app.close();
  });

  it('options doors refuse blank law, blank fixing, and a missing model, and write nothing', () => {
    const read = principalFor(ALICE, ['trade:read']);
    expect(optionsPositions(read, { settlementAssetLaw: '', settlementFixing: '' }).code).toBe(OPTIONS_SETTLEMENT_LAW_UNSET);
    expect(optionsExercises(read, { settlementAssetLaw: 'USDT', settlementFixing: '' }).code).toBe(OPTIONS_FIXING_UNCONFIGURED);
    expect(optionsMarginPreview(read, { settlementAssetLaw: 'USDT', settlementFixing: 'stamp' }).code).toBe(TRADE_OPTIONS_MODEL_UNSET);
    expect(optionsExercises(read, { settlementAssetLaw: '', settlementFixing: '', jobsEnabled: false }).jobsEnabled).toBe(false);
    expect(() => optionsPositions(principalFor(ALICE, ['admin:read']), { settlementAssetLaw: '', settlementFixing: '' })).toThrow(
      expect.objectContaining({ code: 'scope.denied' }),
    );
  });
});

describe('desk acceptance (shared test postgres)', () => {
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let matching: StubMatching;
  let trade: TradeService;
  let btc: Market;
  let scaleMarket: Market;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: testDatabaseUrl(), migrations });
    sql = db.sql;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.order_iceberg_display, trade.scale_groups, trade.fills, trade.orders,
               trade.algo_parents, trade.otc_desk_quotes, trade.markets
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    matching = new StubMatching();
    trade = new TradeService(sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    btc = await trade.listMarket({
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
    scaleMarket = await trade.listMarket({
      symbol: 'SCALE/USDT',
      baseAsset: 'SCALE',
      quoteAsset: 'USDT',
      tickSize: parseAmount('1'),
      lotSize: parseAmount('0.1'),
      minQty: parseAmount('0.1'),
      maxQty: parseAmount('100'),
      minNotional: parseAmount('1'),
      makerBps: 10,
      takerBps: 20,
    });
  });

  async function fund(userId: string, assetId: string, amount: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId,
        amount: parseAmount(amount),
        rail: 'test',
        railRef: `${userId}:${assetId}:${amount}:${randomUUID()}`,
      }),
    );
  }

  it('lists the caller’s algo parents, pages without gaps, and refuses an earlier from', async () => {
    const store = new SqlTwapParentStore(sql);
    const now = new Date();
    const alice = principalFor(ALICE, [...BOTH]);
    const statuses: AlgoStatus[] = ['active', 'paused', 'cancelled'];
    const ids = ['p-new', 'p-mid', 'p-old'];
    for (let i = 0; i < 3; i++) {
      const createdAt = new Date(now.getTime() - i * 3_600_000);
      await store.save({
        parent: parentRow({ id: ids[i]!, userId: ALICE, marketId: btc.id, status: statuses[i]!, createdAt, symbol: btc.symbol }),
        plan: [parseAmount('1')],
      });
    }
    await store.save({
      parent: parentRow({
        id: 'p-ancient',
        userId: ALICE,
        marketId: btc.id,
        status: 'completed',
        createdAt: monthsAgo(now, 4),
        symbol: btc.symbol,
      }),
      plan: [parseAmount('1')],
    });
    await store.save({
      parent: parentRow({ id: 'p-bob', userId: BOB, marketId: btc.id, status: 'active', createdAt: now, symbol: btc.symbol }),
      plan: [parseAmount('1')],
    });
    await fund(ALICE, 'USDT', '100');
    await fund(BOB, 'BTC', '1');
    const maker = await trade.placeOrder(alice, {
      marketId: btc.id,
      side: 'buy',
      type: 'limit',
      qty: parseAmount('0.002'),
      price: parseAmount('100'),
      clientOrderId: 'algo:p-new:0',
    });
    matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: ALICE, price: '100', qty: '0.001' }]);
    await trade.placeOrder(principalFor(BOB, [...BOTH]), {
      marketId: btc.id,
      side: 'sell',
      type: 'limit',
      qty: parseAmount('0.001'),
      price: parseAmount('100'),
      clientOrderId: 'bob-hit',
    });
    await store.save({
      parent: parentRow({
        id: 'p-new',
        userId: ALICE,
        marketId: btc.id,
        status: 'active',
        createdAt: now,
        symbol: btc.symbol,
        children: [{ sliceIndex: 0, orderId: maker.id, clientOrderId: 'algo:p-new:0', qty: parseAmount('0.002'), placedAt: now }],
      }),
      plan: [parseAmount('1')],
    });

    const first = await trade.algoList(alice, { limit: 2 });
    const second = await trade.algoList(alice, { limit: 2, cursor: first.nextCursor ?? '' });
    const seen = [...first.rows, ...second.rows].map((row) => row.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(['p-mid', 'p-new', 'p-old']);
    expect(second.nextCursor).toBeNull();
    expect(first.rows[0]?.id).toBe('p-new');
    expect(first.rows[0]?.filledQty).toBe('0.001');
    expect(first.rows[0]?.totalQty).toBe('1');
    const paused = await listAlgoParents(sql, alice, { status: 'paused', limit: 50 }, now);
    expect(paused.rows.map((row) => row.id)).toEqual(['p-mid']);
    const bob = await trade.algoList(principalFor(BOB, ['trade:read']), { limit: 50 });
    expect(bob.rows.map((row) => row.id)).toEqual(['p-bob']);
    expect(bob.rows.some((row) => row.id.startsWith('p-') && row.id !== 'p-bob')).toBe(false);
    await expect(trade.algoList(alice, { from: monthsAgo(now, 4).toISOString(), limit: 50 })).rejects.toMatchObject({
      code: TRADE_ALGO_LIST_FROM_BEFORE_WINDOW,
    });
    await expect(trade.algoList(alice, {})).rejects.toMatchObject({ code: TRADE_ALGO_LIST_LIMIT_UNSET });
    await expect(trade.algoList(principalFor(ALICE, ['admin:read']), { limit: 10 })).rejects.toMatchObject({ code: 'scope.denied' });
  });

  it('returns two children and one miss after restart, and filled qty from child fills', async () => {
    await fund(ALICE, 'USDT', '100');
    await fund(BOB, 'BTC', '1');
    const store = new SqlTwapParentStore(sql);
    const writes: Promise<unknown>[] = [];
    let t = Date.now();
    let probes = 0;
    const engine = new TwapEngine(
      {
        now: () => new Date(t),
        randomId: () => 'twap-restart',
        placeChild: async (req) => {
          const order = await trade.placeOrder(principalFor(ALICE, [...BOTH]), {
            marketId: req.marketId,
            side: req.side,
            type: 'limit',
            qty: req.qty,
            price: req.limitPrice ?? parseAmount('100'),
            clientOrderId: req.clientOrderId,
          });
          return { orderId: order.id };
        },
        cancelChild: async () => undefined,
        bestOpposingPrice: async () => {
          probes += 1;
          return probes >= 3 ? null : parseAmount('50');
        },
        markFor: async (marketId) => ({ marketId, price: parseAmount('50'), asOf: new Date(t), quality: 'mid' as const }),
      },
      {
        onChange: (parent, plan) => {
          const write = store.save({ parent, plan });
          writes.push(write);
          return write;
        },
      },
    );
    const created = engine.create(
      ALICE,
      {
        marketId: btc.id,
        symbol: btc.symbol,
        side: 'buy',
        totalQty: parseAmount('0.003'),
        durationMs: 6_000,
        sliceIntervalMs: 2_000,
        limitPrice: parseAmount('100'),
        subAccountId: null,
        clientAlgoId: 'desk',
      },
      btc.lotSize,
    );
    await Promise.all(writes.splice(0));
    await engine.tick(created.id);
    await Promise.all(writes.splice(0));
    t += 2_000;
    await engine.tick(created.id);
    await Promise.all(writes.splice(0));
    t += 2_000;
    const missed = await engine.tick(created.id);
    expect(missed.kind).toBe('miss');
    await Promise.all(writes);
    const restarted = new SqlTwapParentStore(sql);
    const loaded = await restarted.load(created.id);
    expect(loaded?.parent.children).toHaveLength(2);
    expect(loaded?.parent.misses).toHaveLength(1);
    expect(loaded?.parent.misses[0]?.code).toBe('trade.algo_no_liquidity');
    const child = loaded!.parent.children[0]!;
    matching.scriptFills([{ makerOrderId: child.orderId, makerAccountId: ALICE, price: '100', qty: '0.001' }]);
    await trade.placeOrder(principalFor(BOB, [...BOTH]), {
      marketId: btc.id,
      side: 'sell',
      type: 'limit',
      qty: parseAmount('0.001'),
      price: parseAmount('100'),
      clientOrderId: 'bob-slice',
    });
    const progress = await trade.algoProgress(principalFor(ALICE, ['trade:read']), created.id);
    const desk = presentAlgoDesk(loaded!.parent, progress.filledQty);
    expect(desk.children).toHaveLength(2);
    expect(desk.misses).toEqual([expect.objectContaining({ code: 'trade.algo_no_liquidity', sliceIndex: 2 })]);
    expect(desk.filledQty).toBe('0.001');
    expect(desk.filledQty).not.toBe(String(desk.children.length));
    const again = await new SqlTwapParentStore(sql).load(created.id);
    expect(again?.parent.children.map((row) => row.orderId)).toEqual(loaded?.parent.children.map((row) => row.orderId));
    expect(again?.parent.misses.map((row) => row.code)).toEqual(['trade.algo_no_liquidity']);
  });

  it('rests an iceberg whose visible slice is displayQty', async () => {
    await fund(ALICE, 'USDT', '2000');
    const attached = await attachIcebergDisplay(
      { marketBySymbol: async () => btc, lifecycleForMarket: (market) => READY_MARKET_LIFECYCLE.snapshot(market) },
      { symbol: btc.symbol, side: 'buy', type: 'limit', qty: parseAmount('10'), price: parseAmount('100'), clientOrderId: 'ice-rest' },
      { type: 'limit', symbol: btc.symbol },
      '2',
    );
    const order = await trade.placeOrder(principalFor(ALICE, [...BOTH]), attached.input);
    expect(order.status).toBe('open');
    expect(matching.submitted[0]?.request.displayQty).toBe('2');
    expect(matching.submitted).toHaveLength(1);
    const replay = await trade.placeOrder(principalFor(ALICE, [...BOTH]), attached.input);
    expect(replay.id).toBe(order.id);
    expect(matching.submitted).toHaveLength(1);
  });

  it('places five scale children that sum to totalQty, replays, and cancels once', async () => {
    await fund(ALICE, 'USDT', '10000');
    const alice = principalFor(ALICE, [...BOTH]);
    const created = await trade.scaleCreate(alice, {
      market: scaleMarket.symbol,
      side: 'buy',
      totalQty: '5.1',
      levels: 5,
      priceFrom: '100',
      priceTo: '104',
      clientGroupId: 'ladder-1',
    });
    expect(created.children).toHaveLength(5);
    expect(created.remainderLevel).toBe(SCALE_REMAINDER_LEVEL);
    let sum = 0n;
    for (const child of created.children) sum += parseAmount(child.qty);
    expect(formatAmount(sum)).toBe('5.1');
    expect(created.children.map((child) => child.qty)).toEqual(['1', '1', '1', '1', '1.1']);
    expect(created.children.map((child) => child.price)).toEqual(['100', '101', '102', '103', '104']);
    expect(created.children.map((child) => child.clientOrderId)).toEqual([
      'scale:ladder-1:0',
      'scale:ladder-1:1',
      'scale:ladder-1:2',
      'scale:ladder-1:3',
      'scale:ladder-1:4',
    ]);
    expect(matching.submitted).toHaveLength(5);
    const replay = await trade.scaleCreate(alice, {
      market: scaleMarket.symbol,
      side: 'buy',
      totalQty: '5.1',
      levels: 5,
      priceFrom: '100',
      priceTo: '104',
      clientGroupId: 'ladder-1',
    });
    expect(replay.groupId).toBe(created.groupId);
    expect(matching.submitted).toHaveLength(5);
    const cancelled = await trade.scaleCancel(alice, created.groupId);
    expect(cancelled.state).toBe('cancelled');
    expect(matching.cancelledOrders).toHaveLength(5);
    const again = await trade.scaleCancel(alice, created.groupId);
    expect(again.state).toBe('cancelled');
    expect(matching.cancelledOrders).toHaveLength(5);
    await expect(trade.scaleGet(principalFor(BOB, ['trade:read']), created.groupId)).rejects.toMatchObject({
      code: TRADE_SCALE_GROUP_NOT_FOUND,
    });
    await expect(trade.scaleGet(principalFor(ALICE, ['admin:read']), created.groupId)).rejects.toMatchObject({ code: 'scope.denied' });
  });

  it('places no scale children when a level fails validation or the hold is short', async () => {
    await fund(ALICE, 'USDT', '10000');
    const alice = principalFor(ALICE, [...BOTH]);
    await expect(
      trade.scaleCreate(alice, {
        market: scaleMarket.symbol,
        side: 'buy',
        totalQty: '5.1',
        levels: 5,
        priceFrom: '100.5',
        priceTo: '104.5',
        clientGroupId: 'bad-tick',
      }),
    ).rejects.toMatchObject({ code: TRADE_SCALE_LEVEL_INVALID });
    expect(matching.submitted).toHaveLength(0);
    const rows = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM scale_groups`;
    expect(rows[0]?.n).toBe(0);
    ledger = new MemoryLedger();
    trade = new TradeService(sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    await fund(ALICE, 'USDT', '1');
    await expect(
      trade.scaleCreate(alice, {
        market: scaleMarket.symbol,
        side: 'buy',
        totalQty: '5.1',
        levels: 5,
        priceFrom: '100',
        priceTo: '104',
        clientGroupId: 'short',
      }),
    ).rejects.toMatchObject({ code: TRADE_SCALE_INSUFFICIENT_BALANCE });
    expect(matching.submitted).toHaveLength(0);
  });

  it('cancels a scale ladder when a child is refused and does not replay it as a live group', async () => {
    await fund(ALICE, 'USDT', '10000');
    const alice = principalFor(ALICE, [...BOTH]);
    const before = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
    let refuseLevel2 = true;
    const ports: ScaleGroupPorts = {
      sql,
      marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
      cancelOrder: (principal, orderId) => trade.cancelOrder(principal, orderId),
      findClientOrder: (principal, input) => trade.findClientOrder(principal, input),
      available: async (userId, assetId) => (await ledger.balance(userAvailable(userId, assetId))).amount,
      placeOrder: async (principal, input) => {
        const clientOrderId = input.clientOrderId ?? '';
        if (refuseLevel2 && (clientOrderId === 'scale:fail-ladder:2' || clientOrderId === 'fail-ladder:2')) {
          refuseLevel2 = false;
          throw new TradeError('level 2 refused', 'trade.invalid_price');
        }
        return trade.placeOrder(principal, input);
      },
    };
    const input = {
      market: scaleMarket.symbol,
      side: 'buy' as const,
      totalQty: '5.1',
      levels: 5,
      priceFrom: '100',
      priceTo: '104',
      clientGroupId: 'fail-ladder',
    };
    const refused = await createScaleGroup(ports, alice, input).then(
      () => null,
      (err: unknown) => err,
    );
    const openAfter = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM trade.orders WHERE user_id = ${ALICE}::uuid AND status = 'open'
    `;
    expect(openAfter[0]?.n).toBe(0);
    expect(refused).toMatchObject({
      code: TRADE_SCALE_CHILD_REFUSED,
      message: expect.stringMatching(/scale child 2 refused: trade\.invalid_price/),
    });
    const groupsAfter = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM scale_groups`;
    const cancelled = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM trade.orders
      WHERE user_id = ${ALICE}::uuid AND status = 'cancelled' AND client_order_id LIKE 'scale:fail-ladder:%'
    `;
    expect(groupsAfter[0]?.n).toBe(0);
    expect(cancelled[0]?.n).toBe(2);
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(before);
    await expect(createScaleGroup(ports, alice, input)).rejects.toMatchObject({
      code: TRADE_SCALE_CHILD_REFUSED,
      message: expect.stringContaining('trade.order_not_open'),
    });
    const openRetry = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM trade.orders WHERE user_id = ${ALICE}::uuid AND status = 'open'
    `;
    const groupsRetry = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM scale_groups`;
    expect(openRetry[0]?.n).toBe(0);
    expect(groupsRetry[0]?.n).toBe(0);
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(before);
  });

  it('rolls back a scale child whose placeOrder threw after its row exists', async () => {
    await fund(ALICE, 'USDT', '10000');
    const alice = principalFor(ALICE, [...BOTH]);
    const before = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
    const ports: ScaleGroupPorts = {
      sql,
      marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
      cancelOrder: (principal, orderId) => trade.cancelOrder(principal, orderId),
      findClientOrder: (principal, input) => trade.findClientOrder(principal, input),
      available: async (userId, assetId) => (await ledger.balance(userAvailable(userId, assetId))).amount,
      placeOrder: async (principal, input) => {
        if (input.clientOrderId === 'scale:lost-ladder:2') {
          await trade.placeOrder(principal, input);
          throw new TradeError('lost reply', 'trade.hold_unknown');
        }
        return trade.placeOrder(principal, input);
      },
    };
    const input = {
      market: scaleMarket.symbol,
      side: 'buy' as const,
      totalQty: '5.1',
      levels: 5,
      priceFrom: '100',
      priceTo: '104',
      clientGroupId: 'lost-ladder',
    };
    await expect(createScaleGroup(ports, alice, input)).rejects.toMatchObject({ code: TRADE_SCALE_CHILD_REFUSED });
    const live = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM trade.orders
      WHERE user_id = ${ALICE}::uuid AND status IN ('open', 'pending', 'recovery_required', 'hold_unknown')
    `;
    const groups = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM scale_groups`;
    expect(live[0]?.n).toBe(0);
    expect(groups[0]?.n).toBe(0);
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(before);
  });

  it('names the order when rollback of a thrown scale child cannot cancel it', async () => {
    await fund(ALICE, 'USDT', '10000');
    const alice = principalFor(ALICE, [...BOTH]);
    let level2Id = '';
    const ports: ScaleGroupPorts = {
      sql,
      marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
      findClientOrder: (principal, input) => trade.findClientOrder(principal, input),
      available: async (userId, assetId) => (await ledger.balance(userAvailable(userId, assetId))).amount,
      placeOrder: async (principal, input) => {
        const order = await trade.placeOrder(principal, input);
        if (input.clientOrderId === 'scale:lost-ladder:2') {
          level2Id = order.id;
          throw new TradeError('lost reply', 'trade.hold_unknown');
        }
        return order;
      },
      cancelOrder: async (principal, orderId) => {
        if (orderId === level2Id) throw new TradeError('cancel failed', 'trade.matching_unavailable');
        return trade.cancelOrder(principal, orderId);
      },
    };
    const refused = await createScaleGroup(ports, alice, {
      market: scaleMarket.symbol,
      side: 'buy',
      totalQty: '5.1',
      levels: 5,
      priceFrom: '100',
      priceTo: '104',
      clientGroupId: 'lost-ladder',
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(level2Id.length).toBeGreaterThan(0);
    expect(refused).toMatchObject({
      code: TRADE_SCALE_ROLLBACK_INCOMPLETE,
      message: expect.stringContaining(level2Id),
    });
  });

  it('places scale children in a private id namespace so a manual order is not a child', async () => {
    await fund(ALICE, 'USDT', '10000');
    const alice = principalFor(ALICE, [...BOTH]);
    const manual = await trade.placeOrder(alice, {
      symbol: scaleMarket.symbol,
      side: 'buy',
      type: 'limit',
      qty: parseAmount('1'),
      price: parseAmount('100'),
      clientOrderId: 'ladder-x:0',
    });
    const created = await trade.scaleCreate(alice, {
      market: scaleMarket.symbol,
      side: 'buy',
      totalQty: '5.1',
      levels: 5,
      priceFrom: '100',
      priceTo: '104',
      clientGroupId: 'ladder-x',
    });
    expect(created.children).toHaveLength(5);
    expect(created.children.some((child) => child.orderId === manual.id)).toBe(false);
    expect(created.children.map((child) => child.clientOrderId)).toEqual([
      'scale:ladder-x:0',
      'scale:ladder-x:1',
      'scale:ladder-x:2',
      'scale:ladder-x:3',
      'scale:ladder-x:4',
    ]);
  });

  it('pages listed option terms with null quotes, and an empty page while the law is blank', async () => {
    const expiry = '2026-12-31T08:00:00.000Z';
    await sql`
      INSERT INTO trade.markets (
        symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, option_type, option_style, option_strike, option_expiry_at, settlement_fixing
      ) VALUES
        ('BTC-C-100', 'BTC', 'USDT', 'options', 0.01, 0.001, 0.001, 0.01, 10, 20, 'pending', 'BTC-C-100', 'call', 'european', 100, ${expiry}, 'stamp-a'),
        ('BTC-P-90', 'BTC', 'USDT', 'options', 0.01, 0.001, 0.001, 0.01, 10, 20, 'pending', 'BTC-P-90', 'put', 'european', 90, ${expiry}, 'stamp-b')
    `;
    const read = principalFor(ALICE, ['trade:read']);
    const blank = await trade.optionsCatalogue(read, { limit: 10 });
    expect(blank.rows).toEqual([]);
    expect(blank.reason).toBe(OPTIONS_SETTLEMENT_LAW_UNSET);
    await expect(listOptionsCatalogue(sql, read, {}, '')).rejects.toMatchObject({ code: TRADE_OPTIONS_CATALOGUE_LIMIT_UNSET });
    const page = await listOptionsCatalogue(sql, read, { limit: 1 }, 'USDT');
    expect(page.reason).toBeNull();
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      symbol: 'BTC-C-100',
      underlying: 'BTC',
      type: 'call',
      style: 'european',
      strike: '100',
      settlement: 'stamp-a',
      bid: null,
      ask: null,
      iv: null,
      openInterest: null,
      volume: null,
      quoteReason: OPTIONS_NO_QUOTE_FEED,
    });
    const rest = await listOptionsCatalogue(sql, read, { limit: 1, cursor: page.nextCursor ?? '' }, 'USDT');
    expect(rest.rows.map((row) => row.symbol)).toEqual(['BTC-P-90']);
    expect(optionsPositions(read, { settlementAssetLaw: '', settlementFixing: 'stamp' }).code).toBe(OPTIONS_SETTLEMENT_LAW_UNSET);
    expect(trade.optionsExercises(read, false)).toMatchObject({ refused: true, code: OPTIONS_SETTLEMENT_LAW_UNSET, jobsEnabled: false });
    expect(trade.optionsMarginPreview(read).code).toBe(OPTIONS_SETTLEMENT_LAW_UNSET);
    const doorDeps = {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    };
    const lawOnly = new TradeService(sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      ...doorDeps,
      optionsSettlementAssetLaw: 'USDT',
      optionsSettlementFixing: '',
    });
    expect(lawOnly.optionsPositions(read).code).toBe(OPTIONS_FIXING_UNCONFIGURED);
    expect(lawOnly.optionsExercises(read, false).code).toBe(OPTIONS_FIXING_UNCONFIGURED);
    expect(lawOnly.optionsMarginPreview(read).code).toBe(OPTIONS_FIXING_UNCONFIGURED);
    const bothSet = new TradeService(sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      ...doorDeps,
      optionsSettlementAssetLaw: 'USDT',
      optionsSettlementFixing: 'stamp',
    });
    expect(bothSet.optionsPositions(read).code).toBe(TRADE_OPTIONS_MODEL_UNSET);
    expect(bothSet.optionsExercises(read, false)).toMatchObject({ code: TRADE_OPTIONS_MODEL_UNSET, jobsEnabled: false });
    const before = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.orders`;
    trade.optionsPositions(read);
    const after = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.orders`;
    expect(after[0]?.n).toBe(before[0]?.n);
    expect(() => trade.optionsPositions(principalFor(ALICE, []))).toThrow(expect.objectContaining({ code: 'scope.denied' }));
  });

  it('lists the caller’s RFQs and exports amounts as escaped strings', async () => {
    const from = '2026-10-01T00:00:00.000Z';
    const to = '2026-10-18T00:00:00.000Z';
    async function quote(id: string, userId: string, lifecycle: 'open' | 'bound' | 'settled', base: string, qty: string) {
      const settled = lifecycle === 'settled';
      const bound = lifecycle === 'bound' || settled;
      await sql`
        INSERT INTO otc_desk_quotes (
          quote_id, user_id, lifecycle, side, base_asset, quote_asset, qty, mid_price, quoted_price,
          mid_notional, user_notional, spread_bps, spread_notional, counterparty, counterparty_id,
          created_at, expires_at, accepted_at, fill_price, fill_notional, settled_at
        ) VALUES (
          ${id}, ${userId}, ${lifecycle}, 'buy', ${base}, 'USDT', ${qty}, 10, 10,
          10, 10, 0, 0.01, 'platform', 'desk',
          ${'2026-10-10T00:00:00.000Z'}, ${'2026-10-11T00:00:00.000Z'},
          ${bound ? '2026-10-10T01:00:00.000Z' : null},
          ${bound ? '10' : null},
          ${bound ? '10' : null},
          ${settled ? '2026-10-10T02:00:00.000Z' : null}
        )
      `;
    }
    await quote('q-open', ALICE, 'open', 'BTC', '1.230000000000000001');
    await quote('q-bound', ALICE, 'bound', '=1+1', '2');
    await quote('q-settled', ALICE, 'settled', 'ETH', '3');
    await quote('q-bob', BOB, 'open', 'BTC', '9');
    const read = principalFor(ALICE, ['trade:read']);
    const page = await trade.rfqList(read, { from, to, limit: 10 });
    expect(page.rows.map((row) => `${row.quoteId}:${row.state}`).sort()).toEqual(['q-bound:bound', 'q-open:open', 'q-settled:settled']);
    expect(page.rows.find((row) => row.quoteId === 'q-open')?.qty).toBe(formatAmount(parseAmount('1.230000000000000001')));
    expect(page.rows.some((row) => row.quoteId === 'q-bob')).toBe(false);
    await expect(trade.rfqList(read, { limit: 10 })).rejects.toMatchObject({ code: TRADE_RFQ_LIST_WINDOW_UNSET });
    await expect(
      trade.rfqList(read, { from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z', limit: 10 }),
    ).rejects.toMatchObject({
      code: TRADE_RFQ_LIST_WINDOW_TOO_WIDE,
    });
    await expect(trade.rfqList(principalFor(ALICE, ['trade:write']), { from, to, limit: 10 })).rejects.toMatchObject({
      code: 'scope.denied',
    });
    const csv = await exportRfqHistory(sql, read, { from, to });
    expect(csv).toContain(formatAmount(parseAmount('1.230000000000000001')));
    expect(csv).toContain(`"'=1+1"`);
    expect(csv).not.toContain('q-bob');
    const app = Fastify();
    attachRfqExportRoute(
      app,
      (principal, query) => exportRfqHistory(sql, principal, query),
      () => read,
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/rfq/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`"'=1+1"`);
    await app.close();
  });

  it('appends rest, partial and cancel for a child and refuses another user', async () => {
    await fund(ALICE, 'USDT', '1000');
    await fund(BOB, 'BTC', '1');
    const parentId = 'parent-exe-1';
    const alice = principalFor(ALICE, [...BOTH]);
    const order = await trade.placeOrder(alice, {
      marketId: btc.id,
      side: 'buy',
      type: 'limit',
      qty: parseAmount('1'),
      price: parseAmount('100'),
      clientOrderId: `algo:${parentId}:0`,
    });
    expect(order.status).toBe('open');
    matching.scriptFills([{ makerOrderId: order.id, makerAccountId: ALICE, price: '100', qty: '0.4' }]);
    await trade.placeOrder(principalFor(BOB, [...BOTH]), {
      marketId: btc.id,
      side: 'sell',
      type: 'limit',
      qty: parseAmount('0.4'),
      price: parseAmount('100'),
      clientOrderId: 'bob-partial',
    });
    await trade.cancelOrder(alice, order.id);
    const store = new SqlTwapParentStore(sql);
    const now = new Date();
    await store.save({
      parent: parentRow({
        id: parentId,
        userId: ALICE,
        marketId: btc.id,
        status: 'active',
        createdAt: now,
        symbol: btc.symbol,
        children: [{ sliceIndex: 0, orderId: order.id, clientOrderId: `algo:${parentId}:0`, qty: parseAmount('1'), placedAt: now }],
      }),
      plan: [parseAmount('1')],
    });
    const report = await trade.algoReports(principalFor(ALICE, ['trade:read']), { algoId: parentId, limit: 20 });
    const kinds = report.rows.map((row) => row.kind);
    const rest = kinds.indexOf('rest');
    const partial = kinds.indexOf('partial');
    const cancel = kinds.indexOf('cancel');
    expect(rest).toBeGreaterThanOrEqual(0);
    expect(partial).toBeGreaterThan(rest);
    expect(cancel).toBeGreaterThan(partial);
    const eventId = report.rows[0]?.id;
    if (!eventId) throw new Error('expected an execution report row');
    await expect(sql`UPDATE order_events SET code = 'rewritten' WHERE id = ${eventId}`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`DELETE FROM order_events WHERE id = ${eventId}`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`TRUNCATE order_events`).rejects.toMatchObject({ code: '23514' });
    await expect(trade.algoReports(principalFor(BOB, ['trade:read']), { algoId: parentId, limit: 20 })).rejects.toMatchObject({
      code: 'trade.algo_not_found',
    });
    await expect(listAlgoReports(sql, principalFor(ALICE, ['admin:read']), { algoId: parentId, limit: 20 })).rejects.toMatchObject({
      code: 'scope.denied',
    });
  });

  it('lists execution reports only for the parent’s stored children', async () => {
    await fund(ALICE, 'USDT', '5000');
    await fund(BOB, 'USDT', '5000');
    const parentId = 'parent-report-scope';
    const alice = principalFor(ALICE, [...BOTH]);
    const child = await trade.placeOrder(alice, {
      marketId: btc.id,
      side: 'buy',
      type: 'limit',
      qty: parseAmount('1'),
      price: parseAmount('100'),
      clientOrderId: `algo:${parentId}:0`,
    });
    const now = new Date();
    await new SqlTwapParentStore(sql).save({
      parent: parentRow({
        id: parentId,
        userId: ALICE,
        marketId: btc.id,
        status: 'active',
        createdAt: now,
        symbol: btc.symbol,
        children: [{ sliceIndex: 0, orderId: child.id, clientOrderId: `algo:${parentId}:0`, qty: parseAmount('1'), placedAt: now }],
      }),
      plan: [parseAmount('1')],
    });
    const bob = await trade.placeOrder(principalFor(BOB, [...BOTH]), {
      marketId: btc.id,
      side: 'buy',
      type: 'limit',
      qty: parseAmount('1'),
      price: parseAmount('90'),
      clientOrderId: `algo:${parentId}:9`,
    });
    const manual = await trade.placeOrder(alice, {
      marketId: btc.id,
      side: 'buy',
      type: 'limit',
      qty: parseAmount('1'),
      price: parseAmount('90'),
      clientOrderId: `algo:${parentId}:99`,
    });
    const report = await trade.algoReports(principalFor(ALICE, ['trade:read']), { algoId: parentId, limit: 20 });
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows.every((row) => row.orderId === child.id)).toBe(true);
    expect(report.rows.some((row) => row.orderId === bob.id)).toBe(false);
    expect(report.rows.some((row) => row.orderId === manual.id)).toBe(false);
  });

  it('refuses displayQty on a replay of a plain limit and writes no peak', async () => {
    await fund(ALICE, 'USDT', '2000');
    const app = Fastify();
    registerPrivateRest(app, {
      edgeSecret: SECRET,
      serviceName: 'svc-trade',
      icebergDisplay: sqlIcebergDisplay(sql),
      findClientOrder: (principal: Principal, input: { symbol?: string; marketId?: string; clientOrderId?: string }) =>
        trade.findClientOrder(principal, input),
      marketBySymbol: (symbol: string) => trade.marketBySymbol(symbol),
      marketById: (marketId: string) => trade.marketById(marketId),
      lifecycleForMarket: (market: Market) => READY_MARKET_LIFECYCLE.snapshot(market),
      placeOrder: (principal: Principal, input: PlaceOrderInput) => trade.placeOrder(principal, input),
    } as unknown as PrivateRestDeps);
    const headers = signedHeaders();
    const body = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '10', price: '100', clientOrderId: 'plain-1' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: body });
    expect(first.statusCode).toBe(201);
    const orderId = first.json().id as string;
    const replay = await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: { ...body, displayQty: '1' } });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().intafacedCode).toBe(TRADE_ICEBERG_DISPLAY_INVALID);
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM trade.order_iceberg_display WHERE order_id = ${orderId}::uuid
    `;
    expect(rows[0]?.n).toBe(0);
    await app.close();
  });

  function icebergDoor(replaced: unknown[] = []): ReturnType<typeof Fastify> {
    const app = Fastify();
    registerPrivateRest(app, {
      edgeSecret: SECRET,
      serviceName: 'svc-trade',
      icebergDisplay: sqlIcebergDisplay(sql),
      findClientOrder: (principal: Principal, input: { symbol?: string; marketId?: string; clientOrderId?: string }) =>
        trade.findClientOrder(principal, input),
      marketBySymbol: (symbol: string) => trade.marketBySymbol(symbol),
      marketById: (marketId: string) => trade.marketById(marketId),
      lifecycleForMarket: (market: Market) => READY_MARKET_LIFECYCLE.snapshot(market),
      placeOrder: (principal: Principal, input: PlaceOrderInput) => trade.placeOrder(principal, input),
      replaceOrder: async (...args: unknown[]) => {
        replaced.push(args);
        throw new Error('the replace saga must not be reached');
      },
    } as unknown as PrivateRestDeps);
    return app;
  }

  const iceberg = (clientOrderId: string, symbol = 'BTC/USDT') => ({
    symbol,
    type: 'limit',
    side: 'buy',
    amount: '3',
    price: '100',
    clientOrderId,
    displayQty: '1',
  });

  async function aliceOrders(): Promise<Array<{ id: string; client_order_id: string; status: string }>> {
    return sql<Array<{ id: string; client_order_id: string; status: string }>>`
      SELECT id, client_order_id, status::text AS status FROM trade.orders WHERE user_id = ${ALICE} ORDER BY created_at
    `;
  }

  it('refuses a second live iceberg on the same market by name, places nothing for it, and frees the slot once the first is done', async () => {
    await fund(ALICE, 'USDT', '5000');
    const app = icebergDoor();
    const headers = signedHeaders();
    const first = await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: iceberg('ice-cap-1') });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().id as string;
    const heldAfterFirst = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;

    const second = await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: iceberg('ice-cap-2') });
    expect(second.statusCode).toBe(409);
    expect(second.json().intafacedCode).toBe(TRADE_ICEBERG_SYMBOL_CAP);
    // Nothing changed: no second order row, no second hold, no second peak.
    expect((await aliceOrders()).map((o) => o.client_order_id)).toEqual(['ice-cap-1']);
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(heldAfterFirst);
    const peaks = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.order_iceberg_display`;
    expect(peaks[0]?.n).toBe(1);

    // A replay of the first iceberg is not a second one: it answers the same order.
    const replay = await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: iceberg('ice-cap-1') });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ id: firstId, displayQty: '1' });
    // An iceberg on another market is not capped.
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: iceberg('ice-cap-other', 'SCALE/USDT') })).statusCode,
    ).toBe(201);
    // A plain limit on the same market is not capped.
    const plain = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100', clientOrderId: 'plain-cap' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: plain })).statusCode).toBe(201);

    // Once the first is cancelled the slot is free.
    await trade.cancelOrder(principalFor(ALICE, [...BOTH]), firstId);
    const third = await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: iceberg('ice-cap-3') });
    expect(third.statusCode).toBe(201);
    await app.close();
  });

  it('lets exactly one of two icebergs sent at once on one market through', async () => {
    await fund(ALICE, 'USDT', '5000');
    const app = icebergDoor();
    const headers = signedHeaders();
    const answers = await Promise.all(
      ['ice-race-a', 'ice-race-b'].map((id) => app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: iceberg(id) })),
    );
    expect(answers.map((a) => a.statusCode).sort()).toEqual([201, 409]);
    expect(answers.find((a) => a.statusCode === 409)!.json().intafacedCode).toBe(TRADE_ICEBERG_SYMBOL_CAP);
    expect((await aliceOrders()).filter((o) => o.status === 'open' || o.status === 'pending')).toHaveLength(1);
    await app.close();
  });

  it('answers two sends of the same iceberg at once with the one order, not a cap refusal', async () => {
    await fund(ALICE, 'USDT', '5000');
    const app = icebergDoor();
    const headers = signedHeaders();
    const answers = await Promise.all(
      [1, 2].map(() => app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: iceberg('ice-twice') })),
    );
    expect(answers.map((a) => a.statusCode)).toEqual([201, 201]);
    expect(answers[0]!.json().id).toBe(answers[1]!.json().id);
    expect(answers.map((a) => a.json().displayQty)).toEqual(['1', '1']);
    expect((await aliceOrders()).map((o) => o.client_order_id)).toEqual(['ice-twice']);
    await app.close();
  });

  it('refuses an iceberg on an order replacement and leaves the original resting', async () => {
    await fund(ALICE, 'USDT', '5000');
    const replaced: unknown[] = [];
    const app = icebergDoor(replaced);
    const headers = signedHeaders();
    const plain = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '3', price: '100', clientOrderId: 'plain-to-replace' };
    const original = await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: plain });
    expect(original.statusCode).toBe(201);
    const before = await aliceOrders();
    const balance = (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
    for (const extra of [{ displayQty: '1' }, { iceberg: true }]) {
      const answer = await app.inject({
        method: 'POST',
        url: `/api/v1/orders/${original.json().id}/replace`,
        headers,
        payload: { ...plain, clientOrderId: 'plain-replaced', ...extra },
      });
      expect(answer.statusCode).toBe(400);
      expect(answer.json().intafacedCode).toBe(TRADE_ICEBERG_DISPLAY_INVALID);
    }
    expect(replaced).toEqual([]);
    expect(await aliceOrders()).toEqual(before);
    expect((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount).toBe(balance);
    await app.close();
  });

  it('returns the iceberg and its peak when a lost reply is retried with the same body', async () => {
    await fund(ALICE, 'USDT', '2000');
    let calls = 0;
    const app = Fastify();
    registerPrivateRest(app, {
      edgeSecret: SECRET,
      serviceName: 'svc-trade',
      icebergDisplay: sqlIcebergDisplay(sql),
      findClientOrder: (principal: Principal, input: { symbol?: string; marketId?: string; clientOrderId?: string }) =>
        trade.findClientOrder(principal, input),
      marketBySymbol: (symbol: string) => trade.marketBySymbol(symbol),
      marketById: (marketId: string) => trade.marketById(marketId),
      lifecycleForMarket: (market: Market) => READY_MARKET_LIFECYCLE.snapshot(market),
      placeOrder: async (principal: Principal, input: PlaceOrderInput) => {
        const order = await trade.placeOrder(principal, input);
        calls += 1;
        if (calls === 1) throw new TradeError('lost reply', 'trade.hold_unknown');
        return order;
      },
    } as unknown as PrivateRestDeps);
    const headers = signedHeaders();
    const body = {
      symbol: 'BTC/USDT',
      type: 'limit',
      side: 'buy',
      amount: '10',
      price: '100',
      clientOrderId: 'ice-lost-1',
      displayQty: '1',
    };
    const first = await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: body });
    expect(first.statusCode).not.toBe(201);
    const retry = await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: body });
    expect(retry.statusCode).toBe(201);
    const orderId = retry.json().id as string;
    expect(retry.json().displayQty).toBe('1');
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM trade.order_iceberg_display WHERE order_id = ${orderId}::uuid
    `;
    expect(rows[0]?.n).toBe(1);
    await app.close();
  });
});

function signedHeaders(): Record<string, string> {
  const principal: Principal = {
    sub: ALICE,
    userId: ALICE,
    sid: '99999999-9999-4999-8999-999999999999',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
    'content-type': 'application/json',
  };
}
