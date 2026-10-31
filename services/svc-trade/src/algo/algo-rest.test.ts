import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';
import { attachAlgoRestRoutes, type AlgoRestPort } from './algo-rest.js';
import type { TwapParent } from './types.js';

const OWNER = { userId: '11111111-1111-4111-8111-111111111111', sid: 's-1', scopes: ['trade:read', 'trade:write'] } as unknown as Principal;
const T0 = new Date('2026-10-31T00:00:00Z');

function parent(over: Partial<TwapParent> = {}): TwapParent {
  return {
    id: 'algo-1',
    symbol: 'BTC/USDT',
    side: 'buy',
    kind: 'twap',
    totalQty: parseAmount('0.002'),
    durationMs: 600_000,
    sliceIntervalMs: 60_000,
    limitPrice: parseAmount('50000'),
    status: 'active',
    slicesPlanned: 10,
    nextSliceIndex: 0,
    children: [],
    misses: [],
    haltReason: null,
    participationBps: null,
    createdAt: T0,
    startedAt: T0,
    nextDueAt: T0,
    projectedEndsAt: T0,
    scheduleStretchReason: null,
    triggerPrice: null,
    triggeredAt: null,
    ...over,
  } as unknown as TwapParent;
}

/** An algo port that records each call and answers what the test sets. */
function fakeAlgo(answers: Partial<Record<keyof AlgoRestPort, (...args: unknown[]) => unknown>> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const algo = new Proxy(
    {},
    {
      get:
        (_t, name: string) =>
        async (...args: unknown[]) => {
          calls.push([name, args.slice(1)]);
          const answer = answers[name as keyof AlgoRestPort];
          if (!answer) throw new Error(`unexpected call ${name}`);
          return answer(...args);
        },
    },
  ) as AlgoRestPort;
  return { algo, calls };
}

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

async function mount(algo: AlgoRestPort | undefined, opts: { allowed?: boolean; principal?: Principal | null } = {}) {
  app = Fastify();
  attachAlgoRestRoutes(app, algo, {
    requirePrincipal: (_req, reply) => {
      const principal = opts.principal === undefined ? OWNER : opts.principal;
      if (!principal) void reply.code(401).send({ code: 'AuthenticationError' });
      return principal;
    },
    requireTradeJurisdiction: (_req, reply) => {
      if (opts.allowed === false) void reply.code(403).send({ code: 'PermissionDenied', intafacedCode: 'access.region_blocked' });
      return opts.allowed !== false;
    },
  });
  await app.ready();
  return app;
}

const TWAP = {
  symbol: 'BTC/USDT',
  side: 'buy',
  totalQty: '0.002',
  durationMs: 600_000,
  sliceIntervalMs: 60_000,
  limitPrice: '50000',
  clientAlgoId: 'J19-7',
};

describe('the algo order public API (CB-execution-08, J-copy-bots-otc-19 #7)', () => {
  it('places a TWAP through the web engine with its kind and client algo id, and answers the parent', async () => {
    const { algo, calls } = fakeAlgo({ createTwap: async () => parent() });
    await mount(algo);
    const res = await app.inject({ method: 'POST', url: '/api/v1/algo/twap', payload: TWAP });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'algo-1', kind: 'twap', totalQty: '0.002', limitPrice: '50000', status: 'active' });
    const [[name, [input]]] = calls as [[string, [Record<string, unknown>]]];
    expect(name).toBe('createTwap');
    expect(input).toMatchObject({ symbol: 'BTC/USDT', side: 'buy', kind: 'twap', clientAlgoId: 'J19-7', durationMs: 600_000 });
    expect(input.totalQty).toEqual(parseAmount('0.002'));
  });

  it('refuses each kind no engine runs by name, and an unknown kind or a malformed body as invalid, before the engine is asked', async () => {
    const { algo, calls } = fakeAlgo();
    await mount(algo);
    for (const kind of ['trigger', 'oco', 'conditional', 'trailing']) {
      const res = await app.inject({ method: 'POST', url: `/api/v1/algo/${kind}`, payload: TWAP });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'NotSupported', intafacedCode: 'trade.algo_kind_not_built', data: { kind } });
    }
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/algo/iceberg', payload: TWAP });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: 'InvalidOrder', intafacedCode: 'trade.validation_failed' });
    const malformed = await app.inject({ method: 'POST', url: '/api/v1/algo/twap', payload: { ...TWAP, totalQty: 2 } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ intafacedCode: 'trade.validation_failed' });
    expect(calls).toEqual([]);
  });

  it("refuses amend of the caller's own parent as immutable, and another person's as not found", async () => {
    const { algo, calls } = fakeAlgo({
      getAlgo: async (_p, id) => {
        if (id === 'algo-1') return parent();
        throw new TradeError('Algo order not found', 'trade.algo_not_found');
      },
    });
    await mount(algo);
    const own = await app.inject({ method: 'PATCH', url: '/api/v1/algo/algo-1', payload: { totalQty: '0.003' } });
    expect(own.statusCode).toBe(400);
    expect(own.json()).toMatchObject({ intafacedCode: 'trade.algo_params_immutable', data: { algoId: 'algo-1' } });
    const other = await app.inject({ method: 'PATCH', url: '/api/v1/algo/algo-9', payload: { totalQty: '0.003' } });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toMatchObject({ intafacedCode: 'trade.algo_not_found' });
    expect(calls.map(([name]) => name)).toEqual(['getAlgo', 'getAlgo']);
  });

  it('reads one parent with its filled quantity, lists with the query, and cancels', async () => {
    const { algo, calls } = fakeAlgo({
      getAlgo: async () => parent(),
      algoProgress: async () => ({ filledQty: '0.001' }),
      algoList: async () => ({ rows: [], nextCursor: null }),
      cancelAlgo: async () => parent({ status: 'cancelled' }),
    });
    await mount(algo);
    const one = await app.inject({ method: 'GET', url: '/api/v1/algo/algo-1' });
    expect(one.json()).toMatchObject({ id: 'algo-1', filledQty: '0.001' });
    const list = await app.inject({ method: 'GET', url: '/api/v1/algo?status=active&limit=5' });
    expect(list.statusCode).toBe(200);
    const cancel = await app.inject({ method: 'POST', url: '/api/v1/algo/algo-1/cancel' });
    expect(cancel.json()).toMatchObject({ id: 'algo-1', status: 'cancelled' });
    expect(calls).toEqual([
      ['getAlgo', ['algo-1']],
      ['algoProgress', ['algo-1']],
      ['algoList', [{ status: 'active', limit: 5 }]],
      ['cancelAlgo', ['algo-1']],
    ]);
  });

  it('a key without trade:write is refused scope.denied, and a write from a region that may not trade is refused, with no engine call', async () => {
    const { algo, calls } = fakeAlgo();
    await mount(algo, { principal: { ...OWNER, scopes: ['trade:read'] } as unknown as Principal });
    const write = await app.inject({ method: 'POST', url: '/api/v1/algo/twap', payload: TWAP });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ code: 'PermissionDenied', intafacedCode: 'scope.denied' });
    await app.close();
    await mount(algo, { allowed: false });
    const blocked = await app.inject({ method: 'POST', url: '/api/v1/algo/algo-1/cancel' });
    expect(blocked.statusCode).toBe(403);
    await app.close();
    await mount(algo, { principal: null });
    expect((await app.inject({ method: 'GET', url: '/api/v1/algo' })).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it("answers the engine's own refusal through the shared mapping, with its data", async () => {
    const { algo } = fakeAlgo({
      createTwap: async () => {
        throw new TradeError('Bots need verification level full', 'trade.bots_verification_insufficient', { required: 'full' });
      },
    });
    await mount(algo);
    const res = await app.inject({ method: 'POST', url: '/api/v1/algo/twap', payload: TWAP });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ intafacedCode: 'trade.bots_verification_insufficient', data: { required: 'full' } });
  });

  it('with no algo engine mounted every door answers 503 trade.algo_unavailable', async () => {
    await mount(undefined);
    const res = await app.inject({ method: 'GET', url: '/api/v1/algo' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'ExchangeNotAvailable', intafacedCode: 'trade.algo_unavailable' });
  });
});
