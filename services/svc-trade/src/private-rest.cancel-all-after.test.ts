/**
 * Private REST: the cancel-all-after door arms, disarms and refuses with typed errors.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { fakeMarket } from './public-rest.js';
import { registerPrivateRest, type PrivateRestDeps } from './private-rest.js';
import { TradeError } from './spot/types.js';

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

const post = (app: Awaited<ReturnType<typeof build>>, payload: unknown, p: Principal = principal()) =>
  app.inject({ method: 'POST', url: '/api/v1/orders/cancel-all-after', headers: signedHeaders(p), payload: payload as never });

describe('POST /api/v1/orders/cancel-all-after', () => {
  it('arms with a whole-second timeout and answers the trigger time', async () => {
    const calls: Array<[string, number]> = [];
    const deadline = new Date('2026-10-19T12:00:10.000Z');
    const app = await build(
      deps({
        armCancelAllAfter: async (p, timeoutSec) => {
          calls.push([p.userId, timeoutSec]);
          return { armed: true, timeoutSec, deadline };
        },
      }),
    );
    const res = await post(app, { timeout: 10 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ armed: true, timeout: 10, triggerTime: deadline.toISOString() });
    expect(calls).toEqual([[USER, 10]]);
  });

  it('timeout 0 disarms', async () => {
    const app = await build(deps({ armCancelAllAfter: async () => ({ armed: false, timeoutSec: 0, deadline: null }) }));
    const res = await post(app, { timeout: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ armed: false, timeout: 0, triggerTime: null });
  });

  it.each([{}, { timeout: '10' }, { timeout: 1.5 }, { timeout: null }])(
    'a non-integer timeout %j is refused before arming',
    async (body) => {
      const app = await build(
        deps({
          armCancelAllAfter: async () => {
            throw new Error('must not arm');
          },
        }),
      );
      const res = await post(app, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ intafacedCode: 'trade.cancel_all_after_rejected' });
    },
  );

  it('maps a rejected timeout to 400 and a blank owner set to 503, both typed', async () => {
    const rejected = await build(
      deps({
        armCancelAllAfter: async () => {
          throw new TradeError('not published', 'trade.cancel_all_after_rejected');
        },
      }),
    );
    const r1 = await post(rejected, { timeout: 15 });
    expect(r1.statusCode).toBe(400);
    expect(r1.json()).toMatchObject({ code: 'InvalidOrder', intafacedCode: 'trade.cancel_all_after_rejected' });

    const unset = await build(
      deps({
        armCancelAllAfter: async () => {
          throw new TradeError('no timeouts published', 'trade.cancel_all_after_unset');
        },
      }),
    );
    const r2 = await post(unset, { timeout: 10 });
    expect(r2.statusCode).toBe(503);
    expect(r2.json()).toMatchObject({ intafacedCode: 'trade.cancel_all_after_unset' });
  });

  it('refuses an unsigned caller', async () => {
    const app = await build(deps({ armCancelAllAfter: async () => ({ armed: false, timeoutSec: 0, deadline: null }) }));
    const res = await app.inject({ method: 'POST', url: '/api/v1/orders/cancel-all-after', payload: { timeout: 10 } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe('GET /api/v1/orders/cancel-all-after', () => {
  const get = (app: Awaited<ReturnType<typeof build>>, p: Principal = principal()) =>
    app.inject({ method: 'GET', url: '/api/v1/orders/cancel-all-after', headers: signedHeaders(p) });

  it("answers the caller's countdown and the published timeouts", async () => {
    const deadline = new Date('2026-10-19T12:01:00.000Z');
    const seen: string[] = [];
    const app = await build(
      deps({
        readCancelAllAfter: async (p) => {
          seen.push(p.userId);
          return { armed: true, timeoutSec: 60, deadline, published: [10, 60] };
        },
      }),
    );
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ armed: true, timeout: 60, triggerTime: '2026-10-19T12:01:00.000Z', timeouts: [10, 60] });
    expect(seen).toEqual([USER]);
  });

  it('says "not published" as null timeouts, and not armed as a null trigger time', async () => {
    const app = await build(deps({ readCancelAllAfter: async () => ({ armed: false, timeoutSec: 0, deadline: null, published: null }) }));
    expect((await get(app)).json()).toEqual({ armed: false, timeout: 0, triggerTime: null, timeouts: null });
  });

  it('refuses where the door is not mounted, and an unsigned caller', async () => {
    const app = await build();
    const res = await get(app);
    expect(res.json()).toMatchObject({ intafacedCode: 'trade.cancel_all_after_unset' });
    const unsigned = await app.inject({ method: 'GET', url: '/api/v1/orders/cancel-all-after' });
    expect(unsigned.statusCode).toBeGreaterThanOrEqual(400);
    expect(unsigned.statusCode).toBeLessThan(500);
  });
});
