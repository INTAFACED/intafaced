import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { CCXT_CAPABILITY_MATRIX } from '../ccxt-capability-matrix.js';
import { fakeMarket, registerPublicRest, type PublicRestDeps } from '../public-rest.js';
import { FUTURES_RESTING_UNSUPPORTED } from './conditional-orders/resting.js';
import {
  buildFuturesOrderTypeCatalogue,
  FUTURES_ORDER_TYPE_UNSUPPORTED,
  FUTURES_ORDER_TYPES,
  FUTURES_TIME_IN_FORCE,
} from './order-type-catalogue.js';

const perp = fakeMarket({ id: '00000000-0000-4000-8000-0000000000a1', symbol: 'TEST/USDT-PERP', kind: 'futures' });
const spot = fakeMarket({ symbol: 'TEST/USDT', kind: 'spot' });

function deps(overrides: Partial<PublicRestDeps> = {}): PublicRestDeps {
  return {
    markets: async () => [spot, perp],
    marketBySymbol: async () => null,
    depth: async () => ({ bids: [], asks: [], sequence: 0 }),
    publicTape: async () => [],
    candles: async () => [],
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

async function get(d: PublicRestDeps) {
  const app = Fastify();
  registerPublicRest(app, d);
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/api/v1/futures/order-types' });
  await app.close();
  return res;
}

describe('futures order-type catalogue (D-orders-01)', () => {
  it('lists every type: market and reduce-only available, resting types refused with the resting code', () => {
    const c = buildFuturesOrderTypeCatalogue('TEST/USDT-PERP');
    expect(c.orderTypes.map((t) => t.id)).toEqual([...FUTURES_ORDER_TYPES]);
    expect(c.timeInForce.map((t) => t.id)).toEqual([...FUTURES_TIME_IN_FORCE]);
    expect(c.orderTypes.find((t) => t.id === 'market')).toEqual({ id: 'market', state: 'available' });
    expect(c.flags.find((f) => f.id === 'reduceOnly')).toEqual({ id: 'reduceOnly', state: 'available' });
    const refusedEntries = [...c.orderTypes, ...c.timeInForce, ...c.flags].filter((e) => e.id !== 'market' && e.id !== 'reduceOnly');
    expect(refusedEntries.length).toBe(FUTURES_ORDER_TYPES.length - 1 + FUTURES_TIME_IN_FORCE.length + 1);
    for (const e of refusedEntries) {
      expect(e, e.id).toMatchObject({ state: 'refused', code: FUTURES_RESTING_UNSUPPORTED });
      expect(e.state === 'refused' && e.reason.length > 0).toBe(true);
    }
  });

  it('derives from the matrix: open door not supported → market and reduce-only refuse too', () => {
    const matrix = CCXT_CAPABILITY_MATRIX.map((r) => (r.name === 'openPosition' ? { ...r, kind: 'refuse' as const } : r));
    const c = buildFuturesOrderTypeCatalogue('TEST/USDT-PERP', matrix);
    expect(c.orderTypes.find((t) => t.id === 'market')).toMatchObject({ state: 'refused', code: FUTURES_ORDER_TYPE_UNSUPPORTED });
    expect(c.flags.find((f) => f.id === 'reduceOnly')).toMatchObject({ state: 'refused', code: FUTURES_ORDER_TYPE_UNSUPPORTED });
  });

  it('open door missing from the matrix → refused, never assumed available', () => {
    const c = buildFuturesOrderTypeCatalogue(
      'TEST/USDT-PERP',
      CCXT_CAPABILITY_MATRIX.filter((r) => r.name !== 'openPosition'),
    );
    expect([...c.orderTypes, ...c.timeInForce, ...c.flags].every((e) => e.state === 'refused')).toBe(true);
  });

  it('GET /api/v1/futures/order-types serves futures markets only', async () => {
    const res = await get(deps());
    expect(res.statusCode).toBe(200);
    const body = res.json() as { asOfMs: number; markets: Array<{ market: string }> };
    expect(body.asOfMs).toBe(1_700_000_000_000);
    expect(body.markets.map((m) => m.market)).toEqual(['TEST/USDT-PERP']);
  });

  it('no listed futures market → empty list, no sample catalogue', async () => {
    const res = await get(deps({ markets: async () => [spot] }));
    expect(res.statusCode).toBe(200);
    expect(res.json().markets).toEqual([]);
  });

  it('test-labelled futures market is hidden unless the test seed is on', async () => {
    const seeded = { ...perp, test: true };
    expect((await get(deps({ markets: async () => [seeded] }))).json().markets).toEqual([]);
    const shown = await get(deps({ markets: async () => [seeded], futuresTestSeed: true }));
    expect(shown.json().markets.map((m: { market: string }) => m.market)).toEqual(['TEST/USDT-PERP']);
  });

  it('market read failure → error status, never a fallback list', async () => {
    const res = await get(
      deps({
        markets: async () => {
          throw new Error('db down');
        },
      }),
    );
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.json())).not.toMatch(/orderTypes/);
  });

  it('the route is claimed in the capability matrix', () => {
    expect(CCXT_CAPABILITY_MATRIX.find((r) => r.name === 'fetchFuturesOrderTypes')).toMatchObject({
      path: '/api/v1/futures/order-types',
      auth: 'public',
      kind: 'supported',
    });
  });
});
