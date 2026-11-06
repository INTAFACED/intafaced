/**
 * Unit card — GET /api/v1/rulebook and /api/v1/rulebook/versions (RC-cex-spot-08)
 *
 * 1. Promise: customers read the trading rulebook svc-matching publishes, as matching serves it; svc-trade adds no text.
 * 2. Break: an absent or failing reader answered 200 with an empty or invented rulebook.
 * 3. Done bar: both routes pass matching's body through; no reader, a thrown read or a non-object answer 503
 *    trade.rulebook_unavailable; the reader calls matching's public doors, unsigned, and a non-2xx throws.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { fakeMarket, registerPublicRest, type PublicRestDeps } from './public-rest.js';
import { createMatchingRulebookReader } from './spot/matching-rulebook.js';

const market = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT' });

function deps(overrides: Partial<PublicRestDeps> = {}): PublicRestDeps {
  return {
    markets: async () => [market],
    marketBySymbol: async () => market,
    depth: async () => ({ bids: [], asks: [], sequence: 0 }),
    publicTape: async () => [],
    candles: async () => [],
    ...overrides,
  };
}

async function get(d: PublicRestDeps, url: string) {
  const app = Fastify({ logger: false });
  registerPublicRest(app, d);
  await app.ready();
  const res = await app.inject({ method: 'GET', url });
  await app.close();
  return res;
}

describe('GET /api/v1/rulebook', () => {
  it('passes matching’s rulebook and history through', async () => {
    const current = { published: true, version: 'TEST-v1', sections: [{ id: 'fees', title: 'fees', body: 'TEST fees.' }] };
    const versions = { current: 'TEST-v1', versions: [{ version: 'TEST-v1' }] };
    const d = deps({ rulebook: async (which) => (which === 'current' ? current : versions) });
    const a = await get(d, '/api/v1/rulebook');
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual(current);
    const b = await get(d, '/api/v1/rulebook/versions');
    expect(b.json()).toEqual(versions);
  });

  it('passes an unpublished rulebook through as matching refuses it', async () => {
    const body = { published: false, version: null, rejected: { code: 'matching.rulebook_unpublished' }, upcoming: [] };
    const res = await get(deps({ rulebook: async () => body }), '/api/v1/rulebook');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
  });

  it('answers 503 trade.rulebook_unavailable with no reader, a failed read or a non-object', async () => {
    for (const d of [deps(), deps({ rulebook: async () => Promise.reject(new Error('down')) }), deps({ rulebook: async () => 'x' })]) {
      for (const url of ['/api/v1/rulebook', '/api/v1/rulebook/versions']) {
        const res = await get(d, url);
        expect(res.statusCode).toBe(503);
        expect(res.json().code).toBe('trade.rulebook_unavailable');
      }
    }
  });
});

describe('createMatchingRulebookReader', () => {
  it('reads matching’s public doors unsigned and throws on a refusal', async () => {
    const seen: { url: string; headers: unknown }[] = [];
    const ok = createMatchingRulebookReader('http://matching:4005/', {
      fetchFn: (async (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers });
        return new Response(JSON.stringify({ published: false }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await expect(ok('current')).resolves.toEqual({ published: false });
    await ok('versions');
    expect(seen).toEqual([
      { url: 'http://matching:4005/rulebook', headers: undefined },
      { url: 'http://matching:4005/rulebook/versions', headers: undefined },
    ]);
    const refused = createMatchingRulebookReader('http://matching:4005', {
      fetchFn: (async () => new Response('no', { status: 500 })) as unknown as typeof fetch,
    });
    await expect(refused('current')).rejects.toThrow(/failed \(500\)/);
  });
});
