/**
 * Private REST: GET /api/v1/orders/closed takes side, status (CCXT words) and until beside symbol, since and limit.
 * A bad filter is refused with a typed 400 before orderHistory runs; nothing is guessed.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { fakeMarket } from './public-rest.js';
import { registerPrivateRest, type PrivateRestDeps } from './private-rest.js';

const SECRET = 'a-trade-private-rest-closed-filters-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';

function signedHeaders(): Record<string, string> {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

type Seen = Parameters<PrivateRestDeps['orderHistory']>[1];

async function get(query: string) {
  const market = fakeMarket({ symbol: 'BTC/USDT' });
  const seen: Seen[] = [];
  const app = Fastify({ logger: false });
  registerPrivateRest(app, {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    orderHistory: async (_p: Principal, input: Seen) => {
      seen.push(input);
      return [];
    },
    marketBySymbol: async (symbol: string) => (symbol === market.symbol ? market : null),
    marketById: async (id: string) => (id === market.id ? market : null),
  } as unknown as PrivateRestDeps);
  await app.ready();
  const res = await app.inject({ method: 'GET', url: `/api/v1/orders/closed${query}`, headers: signedHeaders() });
  await app.close();
  return { res, seen };
}

describe('GET /api/v1/orders/closed filters', () => {
  it('passes side, status, since and until through as exact values', async () => {
    const { res, seen } = await get('?limit=50&side=sell&status=canceled&since=1000&until=2000');
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([{ marketId: undefined, limit: 50, sinceMs: 1000, untilMs: 2000, side: 'sell', status: 'cancelled' }]);
  });

  it('maps every CCXT status word to the stored status', async () => {
    const words: Array<[string, string]> = [
      ['closed', 'filled'],
      ['canceled', 'cancelled'],
      ['rejected', 'rejected'],
      ['expired', 'expired'],
    ];
    for (const [wire, stored] of words) {
      const { res, seen } = await get(`?limit=10&status=${wire}`);
      expect(res.statusCode, wire).toBe(200);
      expect(seen[0]?.status, wire).toBe(stored);
    }
  });

  it('passes a type filter through and refuses an unknown one', async () => {
    for (const type of ['market', 'limit', 'stop_limit']) {
      const { res, seen } = await get(`?limit=10&type=${type}`);
      expect(res.statusCode, type).toBe(200);
      expect(seen[0]?.type, type).toBe(type);
    }
    for (const type of ['stop', 'trailing', 'toString']) {
      const { res, seen } = await get(`?limit=10&type=${type}`);
      expect(res.statusCode, type).toBe(400);
      expect(seen, type).toEqual([]);
    }
  });

  it('without filters nothing extra is sent', async () => {
    const { res, seen } = await get('?limit=10');
    expect(res.statusCode).toBe(200);
    expect(seen[0]).toMatchObject({ limit: 10 });
    expect(seen[0]?.side).toBeUndefined();
    expect(seen[0]?.status).toBeUndefined();
    expect(seen[0]?.type).toBeUndefined();
    expect(seen[0]?.untilMs).toBeUndefined();
  });

  it('refuses a bad side, status or until before orderHistory runs', async () => {
    for (const q of [
      'side=up',
      'status=open',
      'status=filled',
      'status=toString',
      'status=constructor',
      'until=-1',
      'until=soon',
      'since=5000&until=4000',
    ]) {
      const { res, seen } = await get(`?limit=10&${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().code, q).toBe('BadRequest');
      expect(seen, q).toEqual([]);
    }
  });
});
