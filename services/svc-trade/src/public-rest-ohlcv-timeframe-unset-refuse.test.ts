/**
 * Unit card — public REST OHLCV timeframe unset refuse
 *
 * 1. Promise: blank GET ohlcv does not invent 1m. Owner/query may pass 1m.
 * 2. Break: `req.query.timeframe ?? DEFAULT_OHLCV_TIMEFRAME` made a blank
 *    query look chosen (leftover after #4060 limit mill).
 * 3. Done bar: no DEFAULT_OHLCV_TIMEFRAME; blank/whitespace 400 typed;
 *    explicit 1m/1h 200; invalid 7m stays trade.invalid_timeframe.
 * 4. Class N
 * 5. Paths: public-rest.ts GET /api/v1/ohlcv/:symbol
 * 6. RED: omitting timeframe returns a 1m series
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { fakeMarket, registerPublicRest, TRADE_OHLCV_TIMEFRAME_UNSET, type PublicRestDeps } from './public-rest.js';

const market = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT' });

function deps(overrides: Partial<PublicRestDeps> = {}): PublicRestDeps {
  return {
    markets: async () => [market],
    marketBySymbol: async (symbol) => (symbol === 'BTC/USDT' ? market : null),
    depth: async () => ({ bids: [], asks: [], sequence: 0 }),
    publicTape: async () => [],
    candles: async () => [],
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

async function build(d: PublicRestDeps = deps()) {
  const app = Fastify({ logger: false });
  registerPublicRest(app, d);
  await app.ready();
  return app;
}

describe('GET public REST refuses unpublished ohlcv timeframe', () => {
  it('blank timeframe refuses and does not call candles', async () => {
    const seen: string[] = [];
    const app = await build(
      deps({
        candles: async (_id, timeframe) => {
          seen.push(timeframe);
          return [];
        },
      }),
    );
    for (const q of ['?limit=500', '?timeframe=&limit=500', '?timeframe=%20&limit=500']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/ohlcv/BTC%2FUSDT${q}` });
      expect(res.statusCode, q).toBe(400);
      expect(res.json().intafacedCode, q).toBe(TRADE_OHLCV_TIMEFRAME_UNSET);
      expect(res.json().code, q).toBe('BadRequest');
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('owner-explicit 1m is published (not invented)', async () => {
    const seen: string[] = [];
    const app = await build(
      deps({
        candles: async (_id, timeframe) => {
          seen.push(timeframe);
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ohlcv/BTC%2FUSDT?timeframe=1m&limit=500',
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual(['1m']);
    await app.close();
  });

  it('owner-explicit 1h is published', async () => {
    const seen: string[] = [];
    const app = await build(
      deps({
        candles: async (_id, timeframe) => {
          seen.push(timeframe);
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ohlcv/BTC%2FUSDT?timeframe=1h&limit=100',
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual(['1h']);
    await app.close();
  });

  it('bad timeframe stays invalid_timeframe, not unset', async () => {
    let called = false;
    const app = await build(
      deps({
        candles: async () => {
          called = true;
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ohlcv/BTC%2FUSDT?timeframe=7m&limit=500',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().intafacedCode).toBe('trade.invalid_timeframe');
    expect(called).toBe(false);
    await app.close();
  });
});
