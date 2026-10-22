/**
 * Unit card — private REST history/fills limit unset refuse
 *
 * 1. Promise: blank GET orders/open, orders/closed, account/trades, positions/closed
 *    (and admin open, adl-events) do not invent 100/500. Owner/query may pass 100/500.
 * 2. Break: parseLimit(raw ?? fallback) made a blank query look chosen
 *    (leftover after #4060 public limit mill).
 * 3. Done bar: no DEFAULT_HISTORY/DEFAULT_FILLS; blank/non-integer/0/over-max
 *    400 typed; explicit 100/1 200.
 * 4. Class N
 * 5. Paths: private-rest.ts parsePrivateRestLimit + four GET doors
 * 6. RED: omitting limit returns a 100 window
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { fakeMarket } from './public-rest.js';
import {
  parsePrivateRestLimit,
  registerPrivateRest,
  TRADE_ACCOUNT_TRADES_LIMIT_UNSET,
  TRADE_ADL_EVENTS_LIMIT_UNSET,
  TRADE_ADMIN_ORDERS_LIMIT_UNSET,
  TRADE_ORDERS_CLOSED_LIMIT_UNSET,
  TRADE_ORDERS_OPEN_LIMIT_UNSET,
  TRADE_POSITIONS_CLOSED_LIMIT_UNSET,
  type PrivateRestDeps,
} from './private-rest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
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
    icebergDisplayRule: null,
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

describe('private REST history query limit parse', () => {
  it('unset / blank / non-integer / 0 / over-max refuse — never invent 100', () => {
    expect(parsePrivateRestLimit(undefined, 500)).toBeUndefined();
    expect(parsePrivateRestLimit('', 500)).toBeUndefined();
    expect(parsePrivateRestLimit('  ', 500)).toBeUndefined();
    expect(parsePrivateRestLimit('100.5', 500)).toBeUndefined();
    expect(parsePrivateRestLimit('nope', 500)).toBeUndefined();
    expect(parsePrivateRestLimit('0', 500)).toBeUndefined();
    expect(parsePrivateRestLimit('501', 500)).toBeUndefined();
  });

  it('owner-explicit 100 / 1 are published windows', () => {
    expect(parsePrivateRestLimit('100', 500)).toBe(100);
    expect(parsePrivateRestLimit('1', 500)).toBe(1);
  });
});

describe('GET private REST refuses unpublished history limit', () => {
  it('blank orders/open refuses and does not call openOrders', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        openOrders: async (_p, _marketId, limit) => {
          if (limit !== undefined) seen.push(limit);
          return [];
        },
      }),
    );
    for (const q of ['', '?limit=', '?limit=0', '?limit=501', '?limit=nope']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/orders/open${q}`,
        headers: signedHeaders(),
      });
      expect(res.statusCode, q || '(blank)').toBe(400);
      expect(res.json().intafacedCode, q || '(blank)').toBe(TRADE_ORDERS_OPEN_LIMIT_UNSET);
      expect(res.json().code, q || '(blank)').toBe('BadRequest');
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('owner-explicit orders/open 100 is published (not invented)', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        openOrders: async (_p, _marketId, limit) => {
          if (limit !== undefined) seen.push(limit);
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/open?limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([100]);
    await app.close();
  });

  it('private-rest.ts does not invent 100', () => {
    const src = readFileSync(join(HERE, 'private-rest.ts'), 'utf8');
    expect(src).not.toMatch(/DEFAULT_HISTORY/);
    expect(src).not.toMatch(/DEFAULT_FILLS/);
    expect(src).not.toMatch(/raw \?\? fallback/);
    expect(src).toMatch(/TRADE_ORDERS_CLOSED_LIMIT_UNSET/);
    expect(src).toMatch(/TRADE_ORDERS_OPEN_LIMIT_UNSET/);
    expect(src).toMatch(/TRADE_ACCOUNT_TRADES_LIMIT_UNSET/);
    expect(src).toMatch(/TRADE_POSITIONS_CLOSED_LIMIT_UNSET/);
    expect(src).toMatch(/TRADE_ADMIN_ORDERS_LIMIT_UNSET/);
    expect(src).toMatch(/TRADE_ADL_EVENTS_LIMIT_UNSET/);
  });

  it('blank orders/closed refuses and does not call orderHistory', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        orderHistory: async (_p, input) => {
          if (input.limit !== undefined) seen.push(input.limit);
          return [];
        },
      }),
    );
    for (const q of ['', '?limit=', '?limit=0', '?limit=501', '?limit=nope']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/orders/closed${q}`,
        headers: signedHeaders(),
      });
      expect(res.statusCode, q || '(blank)').toBe(400);
      expect(res.json().intafacedCode, q || '(blank)').toBe(TRADE_ORDERS_CLOSED_LIMIT_UNSET);
      expect(res.json().code, q || '(blank)').toBe('BadRequest');
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('owner-explicit orders/closed 100 is published (not invented)', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        orderHistory: async (_p, input) => {
          if (input.limit !== undefined) seen.push(input.limit);
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/closed?limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([100]);
    await app.close();
  });

  it('blank account/trades refuses and does not call myFills', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        myFills: async (_p, limit) => {
          seen.push(limit);
          return [];
        },
      }),
    );
    for (const q of ['', '?limit=', '?limit=0', '?limit=501', '?limit=nope']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/account/trades${q}`,
        headers: signedHeaders(),
      });
      expect(res.statusCode, q || '(blank)').toBe(400);
      expect(res.json().intafacedCode, q || '(blank)').toBe(TRADE_ACCOUNT_TRADES_LIMIT_UNSET);
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('owner-explicit account/trades 100 is published (not invented)', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        myFills: async (_p, limit) => {
          seen.push(limit);
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/trades?limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([100]);
    await app.close();
  });

  it('blank positions/closed refuses and does not call listClosedPositions', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        listClosedPositions: async (_p, input) => {
          if (input.limit !== undefined) seen.push(input.limit);
          return [];
        },
      }),
    );
    for (const q of ['', '?limit=', '?limit=0', '?limit=501', '?limit=nope']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/positions/closed${q}`,
        headers: signedHeaders(),
      });
      expect(res.statusCode, q || '(blank)').toBe(400);
      expect(res.json().intafacedCode, q || '(blank)').toBe(TRADE_POSITIONS_CLOSED_LIMIT_UNSET);
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('owner-explicit positions/closed 100 is published (not invented)', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        listClosedPositions: async (_p, input) => {
          if (input.limit !== undefined) seen.push(input.limit);
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/positions/closed?limit=100',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([100]);
    await app.close();
  });

  it('blank admin orders refuses after admin:read and does not list', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        adminOpenOrders: async (_p, limit) => {
          if (limit !== undefined) seen.push(limit);
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders/open',
      headers: signedHeaders(principal({ scopes: ['admin:read'] })),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().intafacedCode).toBe(TRADE_ADMIN_ORDERS_LIMIT_UNSET);
    expect(seen).toEqual([]);
    await app.close();
  });

  it('owner-explicit admin orders 100 is published (not invented)', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        adminOpenOrders: async (_p, limit) => {
          if (limit !== undefined) seen.push(limit);
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders/open?limit=100',
      headers: signedHeaders(principal({ scopes: ['admin:read'] })),
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([100]);
    await app.close();
  });

  it('blank adl-events refuses and does not call listAdlDisclosureEvents', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        listAdlDisclosureEvents: async (_p, limit) => {
          seen.push(limit);
          return [];
        },
      }),
    );
    for (const q of ['', '?limit=', '?limit=0', '?limit=501', '?limit=nope']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/futures/adl-events${q}`,
        headers: signedHeaders(),
      });
      expect(res.statusCode, q || '(blank)').toBe(400);
      expect(res.json().intafacedCode, q || '(blank)').toBe(TRADE_ADL_EVENTS_LIMIT_UNSET);
      expect(res.json().code, q || '(blank)').toBe('BadRequest');
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('owner-explicit adl-events 500 is published (not invented)', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        listAdlDisclosureEvents: async (_p, limit) => {
          seen.push(limit);
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/futures/adl-events?limit=500',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([500]);
    await app.close();
  });
});
