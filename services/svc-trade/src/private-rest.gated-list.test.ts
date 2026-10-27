/**
 * GET /api/v1/account/gated-list (D-ops-01): the caller's own list, read with the caller's identity and region, behind
 * trade:read; a deployment that did not wire it says so with a typed 503 instead of an empty list.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { GatedContract, GatedListSubject } from './futures/gated-list.js';
import { fakeMarket } from './public-rest.js';
import { registerPrivateRest, type PrivateRestDeps } from './private-rest.js';

const SECRET = 'a-trade-private-rest-gated-list-edge-secret';
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

const CONTRACT: GatedContract = {
  symbol: 'BTC/USDT:USDT',
  marketId: 'm-1',
  open: false,
  code: 'trade.identity_level_insufficient',
  message: 'Your verification level is below what derivatives need.',
  blockers: [{ code: 'trade.identity_level_insufficient', message: 'Your verification level is below what derivatives need.' }],
};

describe('GET /api/v1/account/gated-list', () => {
  it("answers the caller's own list, asked with the caller's user, tier and region", async () => {
    const asked: GatedListSubject[] = [];
    const app = await build(
      deps({
        gatedList: async (subject) => {
          asked.push(subject);
          return [CONTRACT];
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/account/gated-list', headers: signedHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ contracts: [CONTRACT] });
    expect(asked).toEqual([{ userId: USER, tier: 'basic', region: 'DE' }]);
    await app.close();
  });

  it('refuses without a signed caller, and without trade:read, and never reads the list', async () => {
    let reads = 0;
    const app = await build(
      deps({
        gatedList: async () => {
          reads += 1;
          return [CONTRACT];
        },
      }),
    );
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/account/gated-list' });
    expect(anonymous.statusCode).toBe(401);
    const noScope = await app.inject({
      method: 'GET',
      url: '/api/v1/account/gated-list',
      headers: signedHeaders(principal({ scopes: ['trade:write'] })),
    });
    expect(noScope.statusCode).toBe(403);
    expect(reads).toBe(0);
    await app.close();
  });

  it('a deployment that did not wire the list answers a typed 503, not an empty list', async () => {
    const app = await build(deps());
    const res = await app.inject({ method: 'GET', url: '/api/v1/account/gated-list', headers: signedHeaders() });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'trade.gated_list_unmounted' });
    await app.close();
  });
});
