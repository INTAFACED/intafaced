/**
 * The /api/v1 route inventory (J-developer-01 #5): every route declares who may call it where it is registered, the
 * boot stops on a route without a declaration, and the declared scope is held for API keys on the real mounts.
 */

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import {
  ROUTE_INVENTORY_PATH,
  TRADE_ROUTE_SCOPE_MISMATCH,
  TRADE_ROUTE_UNDECLARED,
  installRouteInventory,
  internalRoute,
  privateRead,
  privateWith,
  privateWrite,
  publicRead,
  type InventoryRoute,
} from './route-inventory.js';
import { registerPrivateRest, type PrivateRestDeps } from './private-rest.js';
import { fakeMarket, registerPublicRest, type PublicRestDeps } from './public-rest.js';

const SECRET = 'a-route-inventory-test-edge-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';

const SCOPE_DENIED = (scope: string) => ({
  code: 'PermissionDenied',
  message: `Scope "${scope}" is required`,
  intafacedCode: 'scope.denied',
  docs: '/developers/permissions',
});

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

function signedHeaders(p: Principal, region = 'DE'): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, region),
    'x-intafaced-region': region,
  };
}

const keyWith = (scopes: string[]) => signedHeaders(principal({ kid: 'key-1', scopes } as Partial<Principal>));

function bare(): { app: FastifyInstance; routes: () => readonly InventoryRoute[] } {
  const app = Fastify();
  const routes = installRouteInventory(app, { edgeSecret: SECRET, serviceName: 'svc-trade' });
  return { app, routes };
}

/** Registration may throw at once or when the app boots; either way the boot is refused with this message. */
async function bootRefusal(register: (app: FastifyInstance) => void): Promise<string> {
  const { app } = bare();
  try {
    register(app);
    await app.ready();
  } catch (err) {
    return (err as Error).message;
  }
  return 'booted';
}

describe('route inventory: declarations', () => {
  it('refuses to boot an /api/v1 route registered without a declaration', async () => {
    const message = await bootRefusal((app) => app.get('/api/v1/undeclared', async () => ({})));
    expect(message).toBe(`${TRADE_ROUTE_UNDECLARED}: GET /api/v1/undeclared declares no access`);
  });

  it('refuses to boot a write route declared with only the read scope', async () => {
    const message = await bootRefusal((app) => app.post('/api/v1/mismatch', privateRead, async () => ({})));
    expect(message).toBe(`${TRADE_ROUTE_SCOPE_MISMATCH}: POST /api/v1/mismatch must declare trade:write`);
  });

  it('lists each declared route exactly once, without HEAD and without routes outside /api/v1', async () => {
    const { app, routes } = bare();
    app.get('/api/v1/a', publicRead, async () => ({}));
    app.post('/api/v1/b', privateWrite, async () => ({}));
    app.get('/api/v1/c', privateWith('trade:read', 'admin:read'), async () => ({}));
    app.post('/api/v1/d', internalRoute, async () => ({}));
    app.get('/health', async () => ({}));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: ROUTE_INVENTORY_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      routes: [
        { method: 'GET', path: ROUTE_INVENTORY_PATH, access: 'public', scopes: ['trade:read'] },
        { method: 'GET', path: '/api/v1/a', access: 'public', scopes: ['trade:read'] },
        { method: 'POST', path: '/api/v1/b', access: 'private', scopes: ['trade:write'] },
        { method: 'GET', path: '/api/v1/c', access: 'private', scopes: ['trade:read', 'admin:read'] },
        { method: 'POST', path: '/api/v1/d', access: 'internal' },
      ],
    });
    expect(routes()).toEqual(res.json().routes);
  });
});

describe('route inventory: the declared scope is held for API keys', () => {
  async function mounted() {
    const { app } = bare();
    const reached: string[] = [];
    app.post('/api/v1/write', privateWrite, async () => {
      reached.push('write');
      return { ok: true };
    });
    app.get('/api/v1/admin', privateWith('trade:read', 'admin:read'), async () => {
      reached.push('admin');
      return { ok: true };
    });
    app.post('/api/v1/internal', internalRoute, async () => {
      reached.push('internal');
      return { ok: true };
    });
    await app.ready();
    return { app, reached };
  }

  it('refuses a key without the declared scope with the edge refusal, before the handler runs', async () => {
    const { app, reached } = await mounted();
    const write = await app.inject({ method: 'POST', url: '/api/v1/write', headers: keyWith(['trade:read']), payload: {} });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toEqual(SCOPE_DENIED('trade:write'));
    const admin = await app.inject({ method: 'GET', url: '/api/v1/admin', headers: keyWith(['trade:read']) });
    expect(admin.statusCode).toBe(403);
    expect(admin.json()).toEqual(SCOPE_DENIED('admin:read'));
    expect(reached).toEqual([]);
  });

  it('lets a key holding the scopes, a session without them, and any caller of an internal route through', async () => {
    const { app, reached } = await mounted();
    const key = await app.inject({ method: 'POST', url: '/api/v1/write', headers: keyWith(['trade:write']), payload: {} });
    expect(key.statusCode).toBe(200);
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/write',
      headers: signedHeaders(principal({ scopes: [] })),
      payload: {},
    });
    expect(session.statusCode).toBe(200);
    const internal = await app.inject({ method: 'POST', url: '/api/v1/internal', headers: keyWith([]), payload: {} });
    expect(internal.statusCode).toBe(200);
    expect(reached).toEqual(['write', 'write', 'internal']);
  });
});

function publicDeps(): PublicRestDeps {
  const markets = [fakeMarket({ symbol: 'BTC/USDT', kind: 'spot' })];
  return {
    markets: async () => markets,
    marketBySymbol: async (symbol) => markets.find((m) => m.symbol === symbol) ?? null,
    depth: async () => ({ bids: [], asks: [], sequence: 0 }),
    publicTape: async () => [],
    candles: async () => [],
  };
}

function privateDeps(): PrivateRestDeps {
  const never = (name: string) => async () => {
    throw new Error(`${name} must not run: the request is refused before the handler`);
  };
  return {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    openOrders: never('openOrders'),
    orderHistory: never('orderHistory'),
    getOrder: never('getOrder'),
    placeOrder: never('placeOrder'),
    cancelOrder: never('cancelOrder'),
    cancelAllOrders: never('cancelAllOrders'),
    massCancelOrders: never('massCancelOrders'),
    myFills: never('myFills'),
    marketBySymbol: never('marketBySymbol'),
    marketById: never('marketById'),
    markets: never('markets'),
    userBalances: never('userBalances'),
    listPositions: never('listPositions'),
    listClosedPositions: never('listClosedPositions'),
    getPosition: never('getPosition'),
    openPosition: never('openPosition'),
    closePosition: never('closePosition'),
    setLeverage: never('setLeverage'),
    addIsolatedMargin: never('addIsolatedMargin'),
    reduceIsolatedMargin: never('reduceIsolatedMargin'),
    getOpenMarginCall: never('getOpenMarginCall'),
    getAdlDisclosure: never('getAdlDisclosure'),
    ackAdlDisclosure: never('ackAdlDisclosure'),
    listAdlDisclosureEvents: never('listAdlDisclosureEvents'),
  } as PrivateRestDeps;
}

const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, 'x');

describe('route inventory: the public and private REST mounts', () => {
  async function restApp() {
    const { app, routes } = bare();
    // Fastify's own record of what is mounted, kept apart from the inventory's.
    const mounted: string[] = [];
    app.addHook('onRoute', (options) => {
      const methods = Array.isArray(options.method) ? options.method : [options.method];
      for (const method of methods) {
        if (method !== 'HEAD' && options.url.startsWith('/api/v1/')) mounted.push(`${method} ${options.url}`);
      }
    });
    registerPublicRest(app, publicDeps());
    registerPrivateRest(app, privateDeps());
    await app.ready();
    return { app, inventory: routes(), mounted };
  }

  it('lists every mounted /api/v1 route exactly once', async () => {
    const { inventory, mounted } = await restApp();
    const listed = inventory.filter((r) => r.path !== ROUTE_INVENTORY_PATH).map((r) => `${r.method} ${r.path}`);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...mounted].sort());
  });

  it('refuses a key with no scopes on every public and private route, each exactly once, with the scope it declares', async () => {
    const { app, inventory } = await restApp();
    const asked: string[] = [];
    for (const route of inventory) {
      if (route.access === 'internal') throw new Error(`${route.path}: no internal route is mounted here`);
      asked.push(`${route.method} ${route.path}`);
      const res = await app.inject({
        method: route.method as 'GET',
        url: concrete(route.path),
        headers: keyWith([]),
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
      });
      expect({ route: asked.at(-1), status: res.statusCode, body: res.json() }).toEqual({
        route: asked.at(-1),
        status: 403,
        body: SCOPE_DENIED(route.scopes[0]!),
      });
    }
    expect(asked).toEqual(inventory.map((r) => `${r.method} ${r.path}`));
    expect(new Set(asked).size).toBe(asked.length);
  });

  it('refuses a signed-out caller on every private route with the private REST 401, each exactly once', async () => {
    const { app, inventory } = await restApp();
    const privateRoutes = inventory.filter((r) => r.access === 'private');
    expect(privateRoutes.length).toBeGreaterThan(0);
    for (const route of privateRoutes) {
      const res = await app.inject({
        method: route.method as 'GET',
        url: concrete(route.path),
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
      });
      expect({ route: `${route.method} ${route.path}`, status: res.statusCode, body: res.json() }).toEqual({
        route: `${route.method} ${route.path}`,
        status: 401,
        body: { code: 'AuthenticationError', message: 'Authentication required', intafacedCode: 'auth.required' },
      });
    }
  });
});
