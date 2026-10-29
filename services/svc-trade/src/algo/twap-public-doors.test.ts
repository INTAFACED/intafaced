/**
 * D26-P1-T4 public door — TWAP product path through mounted Fastify+tRPC.
 *
 * Promise: create → child slices → pause → overdue resume → progress never
 * invents fills. Overdue re-space (ADR 2026-08-08) is visible on the wire
 * (projectedEndsAt + scheduleStretchReason), not engine-unit-only.
 *
 * Break class: createCaller-only stubs that never cross /trpc · progress that
 * fabricates filledQty from the schedule · resume that bursts overdue slices
 * · empty book that still reports a fill.
 *
 * Leverage: createTradeRouter + createEdgeContext (Phase A shell doors) +
 * real TwapEngine (no second scheduler). Path: services/svc-trade/src/algo/**.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { createTradeRouter, type TradeRouter } from '../router.js';
import { TradeError, type OrderSide } from '../spot/types.js';
import type { TradeService } from '../spot/trade-service.js';
import { MemoryTwapParentStore } from './parent-store.js';
import { hydrateAlgoFromStore, hydrateAlgoIfMissing, persistAlgoCancelAttempt, persistAlgoMutation } from './hydrate-on-mutate.js';
import { presentAlgoProgress, FORBIDDEN_PARENT_MONEY_KEYS } from './present.js';
import { TwapEngine, type TwapEnginePorts } from './twap-engine.js';
import type { AlgoQuotedMark, CreateTwapInput, TwapParent } from './types.js';

const previousJobs = process.env.TRADE_ALGO_JOBS_ENABLED;
beforeEach(() => {
  process.env.TRADE_ALGO_JOBS_ENABLED = 'true';
});
afterEach(() => {
  if (previousJobs === undefined) delete process.env.TRADE_ALGO_JOBS_ENABLED;
  else process.env.TRADE_ALGO_JOBS_ENABLED = previousJobs;
});

const EDGE_SECRET = 'a-trade-twap-public-door-edge-secret-32b';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const MARKET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SYMBOL = 'BTC/USDT';
const LOT = parseAmount('0.001');

const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-trade' });

type WireBody = {
  result?: { data?: Record<string, unknown> };
  error?: { message?: string; data?: { code?: string; cause?: { code?: string } } };
};

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: SESSION,
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signedHeaders(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

type TwapHarness = {
  trade: TradeService & { tickAlgo(parentId: string): Promise<unknown> };
  placed: { clientOrderId: string; orderId: string; qty: Amount; at: Date }[];
  advance: (ms: number) => void;
  engine: TwapEngine;
};

/**
 * TradeService-shaped façade: real TwapEngine + memory store, controllable
 * clock / liquidity. Children go through placeChild (ordinary order port) —
 * never invent fills on the parent.
 */
function makeTwapTrade(opts: { liquidity?: boolean; mark?: boolean; algoEnabled?: boolean; belowTier?: boolean } = {}): TwapHarness {
  let t = 1_700_000_000_000;
  const placed: TwapHarness['placed'] = [];
  const store = new MemoryTwapParentStore();
  const liquidity = opts.liquidity !== false;
  const markOk = opts.mark !== false;
  const algoEnabled = opts.algoEnabled !== false;

  const ports: TwapEnginePorts = {
    now: () => new Date(t),
    randomId: () => `algo-${placed.length}-${t}`,
    placeChild: async (req) => {
      const orderId = `order-${req.sliceIndex}-${req.parentId.slice(0, 8)}`;
      placed.push({
        clientOrderId: req.clientOrderId,
        orderId,
        qty: req.qty,
        at: new Date(t),
      });
      return { orderId };
    },
    cancelChild: async () => undefined,
    bestOpposingPrice: async () => (liquidity ? parseAmount('50') : null),
    markFor: async (marketId): Promise<AlgoQuotedMark | null> => {
      if (!markOk) return null;
      return {
        marketId,
        price: parseAmount('50'),
        asOf: new Date(t),
        quality: 'mid',
      };
    },
  };

  const engine = new TwapEngine(ports, {
    onChange: (parent, plan) => store.save({ parent, plan }),
  });

  const trade = {
    async createTwap(
      p: Principal,
      input: {
        symbol?: string;
        side: OrderSide;
        totalQty: Amount;
        durationMs: number;
        sliceIntervalMs: number;
        limitPrice?: Amount | null;
        clientAlgoId?: string;
        kind?: string;
      },
    ): Promise<TwapParent> {
      if (!algoEnabled) {
        throw new TradeError('algo execution is disabled by the operator kill-switch', 'trade.algo_disabled');
      }
      if (opts.belowTier) {
        throw new TradeError('Verification "full" is required to create a bot', 'trade.bots_verification_insufficient');
      }
      const kind = (input.kind ?? 'twap').toLowerCase();
      if (kind !== 'twap') {
        throw new TradeError(`algo kind "${kind}" is not available`, 'trade.algo_unsupported_kind');
      }
      if (!input.symbol || input.symbol !== SYMBOL) {
        throw new TradeError(`market ${input.symbol ?? '(unspecified)'} not found`, 'trade.market_not_found');
      }
      // Same refuse as TradeService.createTwap — no two-sided mark → no schedule.
      if (!markOk || !liquidity) {
        throw new TradeError(
          `${SYMBOL}: no two-sided mark at creation — refusing algo rather than inventing a feed`,
          'trade.algo_mark_missing',
        );
      }
      const createInput: CreateTwapInput = {
        marketId: MARKET,
        symbol: SYMBOL,
        side: input.side,
        totalQty: input.totalQty,
        durationMs: input.durationMs,
        sliceIntervalMs: input.sliceIntervalMs,
        limitPrice: input.limitPrice ?? null,
        subAccountId: null,
        clientAlgoId: input.clientAlgoId,
      };
      const parent = engine.create(p.userId, createInput, LOT);
      const plan = engine.planOf(parent.id) ?? [];
      await store.save({ parent, plan });
      return parent;
    },
    async getAlgo(p: Principal, parentId: string): Promise<TwapParent> {
      return hydrateAlgoIfMissing(engine, store, p.userId, parentId);
    },
    async algoProgress(p: Principal, parentId: string) {
      const parent = await trade.getAlgo(p, parentId);
      // Progress is ONLY real fills. This façade has no fill book — never
      // invent from childrenEmitted / schedule qty.
      return presentAlgoProgress(parent, 0n);
    },
    async pauseAlgo(p: Principal, parentId: string) {
      await hydrateAlgoIfMissing(engine, store, p.userId, parentId);
      return persistAlgoMutation(engine, store, engine.pause(p.userId, parentId));
    },
    async resumeAlgo(p: Principal, parentId: string) {
      await hydrateAlgoIfMissing(engine, store, p.userId, parentId);
      return persistAlgoMutation(engine, store, engine.resume(p.userId, parentId));
    },
    async cancelAlgo(p: Principal, parentId: string) {
      await hydrateAlgoIfMissing(engine, store, p.userId, parentId);
      return persistAlgoCancelAttempt(engine, store, p.userId, parentId);
    },
    async tickAlgo(parentId: string) {
      await hydrateAlgoFromStore(engine, store, parentId);
      const result = await engine.tick(parentId);
      const live = engine.get(parentId);
      if (live) await persistAlgoMutation(engine, store, live);
      return result;
    },
  };

  return {
    trade: trade as TwapHarness['trade'],
    placed,
    advance: (ms: number) => {
      t += ms;
    },
    engine,
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

async function post(
  app: Awaited<ReturnType<typeof mount>>,
  path: string,
  input: Record<string, unknown>,
  headers: Record<string, string> = signedHeaders(),
): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({ method: 'POST', url: `/trpc/${path}`, headers, payload: input });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

async function get(
  app: Awaited<ReturnType<typeof mount>>,
  path: string,
  input: Record<string, unknown>,
  headers: Record<string, string> = signedHeaders(),
): Promise<{ statusCode: number; body: WireBody }> {
  const qs = encodeURIComponent(JSON.stringify(input));
  const res = await app.inject({ method: 'GET', url: `/trpc/${path}?input=${qs}`, headers });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

describe('D26-P1-T4 public doors — TWAP children pause overdue no fake fills', () => {
  it('mounted create → tick children → pause → overdue resume re-spaces on the wire', async () => {
    const INTERVAL = 60_000;
    const harness = makeTwapTrade();
    const app = await mount(harness.trade);

    const created = await post(app, 'algo.createTwap', {
      symbol: SYMBOL,
      side: 'buy',
      totalQty: '0.010',
      durationMs: 600_000,
      sliceIntervalMs: INTERVAL,
      limitPrice: '100',
      clientAlgoId: 'public-door-1',
    });
    expect(created.statusCode).toBe(200);
    const parent = created.body.result!.data!;
    expect(parent.kind).toBe('twap');
    expect(parent.status).toBe('active');
    expect(parent.childrenEmitted).toBe(0);
    expect(parent.scheduleStretchReason).toBeNull();
    const originalEnd = String(parent.projectedEndsAt);
    const algoId = String(parent.id);
    for (const bad of FORBIDDEN_PARENT_MONEY_KEYS) {
      expect(parent).not.toHaveProperty(bad);
    }

    // Job host places first child through placeChild port (ordinary order path).
    const tick0 = await harness.trade.tickAlgo(algoId);
    expect(tick0).toMatchObject({ kind: 'placed' });
    expect(harness.placed).toHaveLength(1);
    expect(harness.placed[0]!.clientOrderId).toBe(`algo:${algoId}:0`);

    const afterPlace = await get(app, 'algo.get', { algoId });
    expect(afterPlace.statusCode).toBe(200);
    expect(afterPlace.body.result!.data!.childrenEmitted).toBe(1);
    expect(afterPlace.body.result!.data!.nextSliceIndex).toBe(1);

    const paused = await post(app, 'algo.pause', { algoId });
    expect(paused.statusCode).toBe(200);
    expect(paused.body.result!.data!.status).toBe('paused');

    // Pause blocks further children even if clock advances (job still ticks).
    harness.advance(INTERVAL);
    await harness.trade.tickAlgo(algoId);
    expect(harness.placed).toHaveLength(1);

    // Multi-interval overdue pause — unfixed engine would burst; ADR re-spaces.
    harness.advance(5 * INTERVAL);
    const resumed = await post(app, 'algo.resume', { algoId });
    expect(resumed.statusCode).toBe(200);
    const resumedBody = resumed.body.result!.data!;
    expect(resumedBody.status).toBe('active');
    expect(resumedBody.scheduleStretchReason).toBe('user_pause');
    expect(String(resumedBody.projectedEndsAt)).not.toBe(originalEnd);
    expect(Date.parse(String(resumedBody.projectedEndsAt))).toBeGreaterThan(Date.parse(originalEnd));

    // Burst window: many ticks in sub-interval wall — at most one more place.
    for (let i = 0; i < 20; i++) {
      await harness.trade.tickAlgo(algoId);
      harness.advance(400);
    }
    expect(harness.placed).toHaveLength(2);

    const children = harness.engine.get(algoId)!.children;
    for (let i = 1; i < children.length; i++) {
      const gap = children[i]!.placedAt.getTime() - children[i - 1]!.placedAt.getTime();
      expect(gap).toBeGreaterThanOrEqual(INTERVAL);
    }

    // Progress door: children exist, but filledQty stays 0 until real fills sum in.
    const progress = await get(app, 'algo.progress', { algoId });
    expect(progress.statusCode).toBe(200);
    const prog = progress.body.result!.data!;
    expect(prog.childrenEmitted).toBe(2);
    expect(prog.filledQty).toBe('0');
    expect(prog.totalQty).toBe('0.01');

    await app.close();
  });

  it('blank book at create refuses on the wire — never invents a schedule', async () => {
    const harness = makeTwapTrade({ liquidity: false });
    const app = await mount(harness.trade);
    const refused = await post(app, 'algo.createTwap', {
      symbol: SYMBOL,
      side: 'buy',
      totalQty: '0.004',
      durationMs: 8_000,
      sliceIntervalMs: 2_000,
      limitPrice: '100',
      clientAlgoId: 'blank-book',
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error?.message ?? '').toMatch(/refusing algo rather than inventing/);
    await app.close();
  });

  it('mid-schedule empty book → miss; progress door keeps filledQty at 0', async () => {
    let opposing: Amount | null = parseAmount('50');
    const store = new MemoryTwapParentStore();
    let clock = 1_700_000_000_000;
    const engine = new TwapEngine(
      {
        now: () => new Date(clock),
        randomId: () => 'algo-drain-public',
        placeChild: async (req) => ({ orderId: `order-${req.sliceIndex}` }),
        cancelChild: async () => undefined,
        bestOpposingPrice: async () => opposing,
        markFor: async (marketId) => ({
          marketId,
          price: parseAmount('50'),
          asOf: new Date(clock),
          quality: 'mid' as const,
        }),
      },
      { onChange: (p, plan) => store.save({ parent: p, plan }) },
    );
    const parent = engine.create(
      USER,
      {
        marketId: MARKET,
        symbol: SYMBOL,
        side: 'buy',
        totalQty: parseAmount('0.004'),
        durationMs: 8_000,
        sliceIntervalMs: 2_000,
        limitPrice: parseAmount('100'),
        subAccountId: null,
        clientAlgoId: 'drain-wire',
      },
      LOT,
    );

    opposing = null;
    const miss = await engine.tick(parent.id);
    expect(miss.kind).toBe('miss');
    if (miss.kind === 'miss') expect(miss.miss.code).toBe('trade.algo_no_liquidity');

    const doorTrade = {
      async getAlgo(p: Principal, parentId: string) {
        const got = engine.get(parentId);
        if (!got || got.userId !== p.userId) throw new TradeError('nf', 'trade.algo_not_found');
        return got;
      },
      async algoProgress(p: Principal, parentId: string) {
        const got = await doorTrade.getAlgo(p, parentId);
        return presentAlgoProgress(got, 0n);
      },
      createTwap: async () => {
        throw new Error('unused');
      },
      pauseAlgo: async () => {
        throw new Error('unused');
      },
      resumeAlgo: async () => {
        throw new Error('unused');
      },
      cancelAlgo: async () => {
        throw new Error('unused');
      },
    } as unknown as TradeService;

    const app = await mount(doorTrade);
    const prog = await get(app, 'algo.progress', { algoId: parent.id });
    expect(prog.statusCode).toBe(200);
    expect(prog.body.result!.data!.filledQty).toBe('0');
    expect(prog.body.result!.data!.missesRecorded).toBe(1);
    expect(prog.body.result!.data!.childrenEmitted).toBe(0);
    await app.close();
  });

  it('resume exceeding 2× duration refuses on the mounted door; parent stays paused', async () => {
    const harness = makeTwapTrade();
    const app = await mount(harness.trade);

    const created = await post(app, 'algo.createTwap', {
      symbol: SYMBOL,
      side: 'buy',
      totalQty: '0.002',
      durationMs: 60_000,
      sliceIntervalMs: 30_000,
      limitPrice: '100',
      clientAlgoId: 'too-far',
    });
    const algoId = String(created.body.result!.data!.id);

    await post(app, 'algo.pause', { algoId });
    harness.advance(90_000);

    const resume = await post(app, 'algo.resume', { algoId });
    expect(resume.statusCode).toBe(400);
    expect(resume.body.error?.message ?? '').toMatch(/more than double original duration/);

    const got = await get(app, 'algo.get', { algoId });
    expect(got.body.result!.data!.status).toBe('paused');

    await app.close();
  });

  it('tick outage (no user pause) surfaces scheduleStretchReason=tick_outage on get', async () => {
    const INTERVAL = 60_000;
    const harness = makeTwapTrade();
    const app = await mount(harness.trade);

    const created = await post(app, 'algo.createTwap', {
      symbol: SYMBOL,
      side: 'buy',
      totalQty: '0.010',
      durationMs: 600_000,
      sliceIntervalMs: INTERVAL,
      limitPrice: '100',
      clientAlgoId: 'outage',
    });
    const algoId = String(created.body.result!.data!.id);

    await harness.trade.tickAlgo(algoId);
    expect(harness.placed).toHaveLength(1);

    harness.advance(INTERVAL * 3 + 1_000);
    await harness.trade.tickAlgo(algoId);

    const got = await get(app, 'algo.get', { algoId });
    expect(got.statusCode).toBe(200);
    expect(got.body.result!.data!.scheduleStretchReason).toBe('tick_outage');
    expect(got.body.result!.data!.childrenEmitted).toBe(2);

    // Still spaced — immediate re-tick places nothing.
    const before = harness.placed.length;
    await harness.trade.tickAlgo(algoId);
    expect(harness.placed).toHaveLength(before);

    await app.close();
  });

  it('refuses anonymous callers on algo.createTwap', async () => {
    const harness = makeTwapTrade();
    const app = await mount(harness.trade);
    const res = await post(
      app,
      'algo.createTwap',
      {
        symbol: SYMBOL,
        side: 'buy',
        totalQty: '0.004',
        durationMs: 8_000,
        sliceIntervalMs: 2_000,
      },
      { 'x-intafaced-region': 'DE' },
    );
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('kill-switch refuses create on the mounted door', async () => {
    const harness = makeTwapTrade({ algoEnabled: false });
    const app = await mount(harness.trade);
    const res = await post(app, 'algo.createTwap', {
      symbol: SYMBOL,
      side: 'buy',
      totalQty: '0.004',
      durationMs: 8_000,
      sliceIntervalMs: 2_000,
      clientAlgoId: 'kill-switch',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message ?? '').toMatch(/kill-switch/);
    await app.close();
  });

  it('a caller below the bot verification level is refused 403 with its code, and no child is placed', async () => {
    const harness = makeTwapTrade({ belowTier: true });
    const app = await mount(harness.trade);
    const res = await post(app, 'algo.createTwap', {
      symbol: SYMBOL,
      side: 'buy',
      totalQty: '0.004',
      durationMs: 8_000,
      sliceIntervalMs: 2_000,
      clientAlgoId: 'below-tier',
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body)).toContain('trade.bots_verification_insufficient');
    expect(harness.placed).toHaveLength(0);
    await app.close();
  });
});
