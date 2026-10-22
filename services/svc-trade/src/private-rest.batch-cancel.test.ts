/**
 * Private REST: batch cancel by id list is sequential, per-item, and refuses request-wide before any item.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { fakeMarket } from './public-rest.js';
import { registerPrivateRest, type PrivateRestDeps } from './private-rest.js';
import { TradeError } from './spot/types.js';
import { fakeOrder } from './private-rest.js';
import { BATCH_CANCEL_MAX } from '@intafaced/exchange-contract';

const SECRET = 'a-trade-private-rest-history-unset-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signedHeaders(p: Principal = principal(), region = 'DE'): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, region),
    'x-intafaced-region': region,
  };
}

function deps(over: Partial<PrivateRestDeps> = {}): PrivateRestDeps {
  const market = fakeMarket({ symbol: 'BTC/USDT' });
  return {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    openOrders: async () => [],
    adminOpenOrders: async () => [],
    orderHistory: async () => [],
    getOrder: async () => {
      throw new Error('getOrder should not run');
    },
    placeOrder: async () => {
      throw new Error('placeOrder should not run');
    },
    cancelOrder: async () => {
      throw new Error('cancelOrder should not run');
    },
    cancelAllOrders: async () => [],
    massCancelOrders: async () => [],
    myFills: async () => [],
    marketBySymbol: async (symbol) => (symbol === market.symbol ? market : null),
    marketById: async (id) => (id === market.id ? market : null),
    markets: async () => [market],
    userBalances: async () => [],
    listPositions: async () => [],
    listClosedPositions: async () => [],
    getPosition: async () => {
      throw new Error('getPosition should not run');
    },
    openPosition: async () => {
      throw new Error('openPosition should not run');
    },
    closePosition: async () => {
      throw new Error('closePosition should not run');
    },
    setLeverage: async () => {
      throw new Error('setLeverage should not run');
    },
    addIsolatedMargin: async () => {
      throw new Error('addIsolatedMargin should not run');
    },
    reduceIsolatedMargin: async () => {
      throw new Error('reduceIsolatedMargin should not run');
    },
    getOpenMarginCall: async () => null,
    getAdlDisclosure: async () => ({
      version: 'DIRECTION-2026-07-31:34',
      copy: 'stub',
      acknowledged: false,
      acknowledgedAt: null,
    }),
    ackAdlDisclosure: async () => ({
      version: 'DIRECTION-2026-07-31:34',
      copy: 'stub',
      acknowledged: true,
      acknowledgedAt: new Date(0).toISOString(),
    }),
    listAdlDisclosureEvents: async () => [],
    ...over,
  };
}

async function build(d: PrivateRestDeps = deps()) {
  const app = Fastify({ logger: false });
  registerPrivateRest(app, d);
  await app.ready();
  return app;
}

const ID1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ID2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const ID3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const post = (app: Awaited<ReturnType<typeof build>>, payload: unknown, p: Principal = principal()) =>
  app.inject({ method: 'POST', url: '/api/v1/orders/batch-cancel', headers: signedHeaders(p), payload: payload as never });

describe('POST /api/v1/orders/batch-cancel', () => {
  it('cancels each id in order through cancelOrder and reports per-item results', async () => {
    const seen: string[] = [];
    const app = await build(
      deps({
        cancelOrder: async (p, id) => {
          expect(p.userId).toBe(USER);
          seen.push(id);
          if (id === ID2) throw new TradeError('order is not open', 'trade.order_not_open');
          return fakeOrder({ id, status: 'cancelled' });
        },
      }),
    );
    const res = await post(app, { ids: [ID1, ID2, ID3] });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([ID1, ID2, ID3]);
    const body = res.json() as { atomic: boolean; results: Array<{ index: number; orderId: string; status: string }> };
    expect(body.atomic).toBe(false);
    expect(body.results.map((r) => [r.index, r.orderId, r.status])).toEqual([
      [0, ID1, 'success'],
      [1, ID2, 'refused'],
      [2, ID3, 'success'],
    ]);
  });

  it('accepts a bare array and an orders list of {id}', async () => {
    const app = await build(deps({ cancelOrder: async (_p, id) => fakeOrder({ id, status: 'cancelled' }) }));
    expect((await post(app, [ID1])).statusCode).toBe(200);
    expect((await post(app, { orders: [{ id: ID1 }, ID2] })).statusCode).toBe(200);
  });

  it('an unmapped failure is unknown, and later items still run', async () => {
    const app = await build(
      deps({
        cancelOrder: async (_p, id) => {
          if (id === ID1) throw new Error('engine socket reset');
          return fakeOrder({ id, status: 'cancelled' });
        },
      }),
    );
    const res = await post(app, { ids: [ID1, ID2] });
    const results = (res.json() as { results: Array<{ status: string; error?: { intafacedCode: string } }> }).results;
    expect(results[0]).toMatchObject({ status: 'unknown', error: { intafacedCode: 'trade.batch_outcome_unknown' } });
    expect(results[1]?.status).toBe('success');
  });

  it('refuses a repeated id and a non-string id without calling cancel for them', async () => {
    let calls = 0;
    const app = await build(
      deps({
        cancelOrder: async (_p, id) => {
          calls += 1;
          return fakeOrder({ id, status: 'cancelled' });
        },
      }),
    );
    const res = await post(app, { ids: [ID1, ID1, 5, ''] });
    const results = (res.json() as { results: Array<{ status: string; error?: { intafacedCode: string } }> }).results;
    expect(results.map((r) => r.status)).toEqual(['success', 'refused', 'refused', 'refused']);
    expect(results[1]?.error?.intafacedCode).toBe('trade.batch_duplicate');
    expect(calls).toBe(1);
  });

  it.each([[{}], [{ ids: 'x' }], [{ ids: [] }]])('a bad body %j is refused request-wide with no cancel', async (body) => {
    const app = await build(
      deps({
        cancelOrder: async () => {
          throw new Error('must not cancel');
        },
      }),
    );
    const res = await post(app, body);
    expect(res.statusCode).toBe(400);
  });

  it('refuses over 100 ids and a read-only credential before any cancel', async () => {
    const app = await build(
      deps({
        cancelOrder: async () => {
          throw new Error('must not cancel');
        },
      }),
    );
    const many = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    expect((await post(app, { ids: many })).statusCode).toBe(400);
    const ro = await post(app, { ids: [ID1] }, principal({ scopes: ['trade:read'] }));
    expect(ro.statusCode).toBeGreaterThanOrEqual(400);
    expect(ro.statusCode).toBeLessThan(500);
  });
});

describe('POST /api/v1/orders/cancel-batch (SP-lifecycle-history-02)', () => {
  const postTo = (app: Awaited<ReturnType<typeof build>>, payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/v1/orders/cancel-batch', headers: signedHeaders(), payload: payload as never });

  it('51 ids refuse trade.batch_too_large before any cancel; 50 run', async () => {
    let cancels = 0;
    const app = await build(
      deps({
        cancelOrder: async (_p, id) => {
          cancels += 1;
          return fakeOrder({ id, status: 'cancelled' });
        },
      }),
    );
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`);
    const tooMany = await postTo(app, { ids: ids(BATCH_CANCEL_MAX + 1) });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().intafacedCode).toBe('trade.batch_too_large');
    expect(cancels).toBe(0);
    const ok = await postTo(app, { ids: ids(BATCH_CANCEL_MAX) });
    expect(ok.statusCode).toBe(200);
    expect(cancels).toBe(BATCH_CANCEL_MAX);
    await app.close();
  });

  it('one id of another user in a batch of two: that item is order not found, the other is cancelled', async () => {
    const app = await build(
      deps({
        cancelOrder: async (_p, id) => {
          if (id === ID2) throw new TradeError('order not found', 'trade.order_not_found');
          return fakeOrder({ id, status: 'cancelled' });
        },
      }),
    );
    const res = await postTo(app, { ids: [ID1, ID2] });
    expect(res.statusCode).toBe(200);
    const results = res.json().results as Array<{ status: string; error?: { intafacedCode?: string } }>;
    expect(results[0]!.status).toBe('success');
    expect(results[1]!.status).toBe('refused');
    expect(results[1]!.error?.intafacedCode).toBe('trade.order_not_found');
    await app.close();
  });

  it('a client id resolves in the caller namespace; unknown or foreign client id is not found and never cancelled', async () => {
    const cancelled: string[] = [];
    const app = await build(
      deps({
        findClientOrder: async (p, input) => {
          expect(p.userId).toBe(USER);
          if (input.clientOrderId === 'mine') return fakeOrder({ id: ID3, userId: USER });
          if (input.clientOrderId === 'theirs') return fakeOrder({ id: ID2, userId: '99999999-9999-4999-8999-999999999999' });
          return null;
        },
        cancelOrder: async (_p, id) => {
          cancelled.push(id);
          return fakeOrder({ id, status: 'cancelled' });
        },
      }),
    );
    const res = await postTo(app, {
      orders: [
        { clientOrderId: 'mine', symbol: 'BTC/USDT' },
        { clientOrderId: 'theirs', symbol: 'BTC/USDT' },
        { clientOrderId: 'nope', symbol: 'BTC/USDT' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const results = res.json().results as Array<{ status: string; orderId: string | null; error?: { intafacedCode?: string } }>;
    expect(results.map((r) => r.status)).toEqual(['success', 'refused', 'refused']);
    expect(results[0]!.orderId).toBe(ID3);
    expect(results[1]!.error?.intafacedCode).toBe('trade.order_not_found');
    expect(results[2]!.error?.intafacedCode).toBe('trade.order_not_found');
    expect(cancelled).toEqual([ID3]);
    await app.close();
  });

  it('a client id twice resolving to the same order is refused as a duplicate', async () => {
    const app = await build(
      deps({
        findClientOrder: async () => fakeOrder({ id: ID1, userId: USER }),
        cancelOrder: async (_p, id) => fakeOrder({ id, status: 'cancelled' }),
      }),
    );
    const res = await postTo(app, { orders: [{ clientOrderId: 'a', symbol: 'BTC/USDT' }, { id: ID1 }] });
    const results = res.json().results as Array<{ status: string; error?: { intafacedCode?: string } }>;
    expect(results.map((r) => r.status)).toEqual(['success', 'refused']);
    expect(results[1]!.error?.intafacedCode).toBe('trade.batch_duplicate');
    await app.close();
  });

  it('a client-id item without symbol refuses trade.order_symbol_required before any cancel or lookup', async () => {
    let cancels = 0;
    let lookups = 0;
    const app = await build(
      deps({
        // Mirrors the real TradeService.findClientOrder: no symbol or marketId → null.
        findClientOrder: async (_p, input) => {
          lookups += 1;
          return input.symbol || input.marketId ? fakeOrder({ id: ID1, userId: USER }) : null;
        },
        cancelOrder: async (_p, id) => {
          cancels += 1;
          return fakeOrder({ id, status: 'cancelled' });
        },
      }),
    );
    for (const item of [{ clientOrderId: 'a' }, { clientOrderId: 'a', symbol: '' }, { clientOrderId: 'a', symbol: '   ' }]) {
      const res = await postTo(app, { orders: [{ id: ID2 }, item] });
      expect(res.statusCode).toBe(400);
      expect(res.json().intafacedCode).toBe('trade.order_symbol_required');
    }
    expect(cancels).toBe(0);
    expect(lookups).toBe(0);
    await app.close();
  });

  it('the old batch-cancel route keeps its cap of 100: 51 and 100 run, 101 refuses', async () => {
    expect(BATCH_CANCEL_MAX).toBe(50);
    let cancels = 0;
    const app = await build(
      deps({
        cancelOrder: async (_p, id) => {
          cancels += 1;
          return fakeOrder({ id, status: 'cancelled' });
        },
      }),
    );
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, '0')}`);
    expect((await post(app, { ids: ids(51) })).statusCode).toBe(200);
    expect((await post(app, { ids: ids(100) })).statusCode).toBe(200);
    expect(cancels).toBe(151);
    const tooMany = await post(app, { ids: ids(101) });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().intafacedCode).toBe('trade.batch_too_large');
    expect(cancels).toBe(151);
    await app.close();
  });
});
