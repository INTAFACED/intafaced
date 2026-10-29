/**
 * Unit card — public REST depth/trades/ohlcv limit unset refuse
 *
 * 1. Promise: blank GET orderbook/trades/ohlcv/markets/tickers does not invent 50/100/500.
 *    Owner/query may pass 50/100/500/1 explicitly.
 * 2. Break: parseLimit(raw ?? fallback) made a blank query look chosen
 *    (same class as matching L2 #4058/#4059).
 * 3. Done bar: no DEFAULT_DEPTH/TRADES/CANDLES; blank/non-integer/0/over-max
 *    400 typed; explicit windows 200; ticker still passes depth 1.
 * 4. Class N
 * 5. Paths: public-rest.ts parsePublicRestLimit + markets/tickers/orderbook/trades/ohlcv GET doors
 * 6. RED: omitting limit returns a 50/100/500 window
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  fakeMarket,
  parsePublicRestLimit,
  registerPublicRest,
  TRADE_MARKETS_LIMIT_UNSET,
  TRADE_OHLCV_LIMIT_UNSET,
  TRADE_ORDERBOOK_LIMIT_UNSET,
  TRADE_TICKERS_LIMIT_UNSET,
  TRADE_TRADES_LIMIT_UNSET,
  type PublicRestDeps,
} from './public-rest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
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

describe('public REST query limit parse', () => {
  it('unset / blank / non-integer / 0 / over-max refuse — never invent 50', () => {
    expect(parsePublicRestLimit(undefined, 500)).toBeUndefined();
    expect(parsePublicRestLimit('', 500)).toBeUndefined();
    expect(parsePublicRestLimit('  ', 500)).toBeUndefined();
    expect(parsePublicRestLimit('50.5', 500)).toBeUndefined();
    expect(parsePublicRestLimit('nope', 500)).toBeUndefined();
    expect(parsePublicRestLimit('0', 500)).toBeUndefined();
    expect(parsePublicRestLimit('501', 500)).toBeUndefined();
    expect(parsePublicRestLimit('1001', 1000)).toBeUndefined();
  });

  it('owner-explicit 50 / 100 / 500 / 1 are published windows', () => {
    expect(parsePublicRestLimit('50', 500)).toBe(50);
    expect(parsePublicRestLimit('100', 500)).toBe(100);
    expect(parsePublicRestLimit('500', 1000)).toBe(500);
    expect(parsePublicRestLimit('1', 500)).toBe(1);
  });
});

describe('GET public REST refuses unpublished limit', () => {
  it('public-rest.ts does not invent 50/100/500', () => {
    const src = readFileSync(join(HERE, 'public-rest.ts'), 'utf8');
    expect(src).not.toMatch(/DEFAULT_DEPTH/);
    expect(src).not.toMatch(/DEFAULT_TRADES/);
    expect(src).not.toMatch(/DEFAULT_CANDLES/);
    expect(src).not.toMatch(/raw \?\? fallback/);
    expect(src).toMatch(/TRADE_ORDERBOOK_LIMIT_UNSET/);
    expect(src).toMatch(/TRADE_TRADES_LIMIT_UNSET/);
    expect(src).toMatch(/TRADE_OHLCV_LIMIT_UNSET/);
    expect(src).toMatch(/TRADE_MARKETS_LIMIT_UNSET/);
    expect(src).toMatch(/TRADE_TICKERS_LIMIT_UNSET/);
    expect(src).toMatch(/deps\.depth\(market\.id, 1\)/);
    expect(src).not.toMatch(/app\.get\('\/api\/v1\/markets',\s*(?:publicRead,\s*)?async \(_req/);
    expect(src).not.toMatch(/deps\.markets\(MAX_MARKETS\)/);
    expect(src).not.toMatch(/app\.get\('\/api\/v1\/tickers',\s*(?:publicRead,\s*)?async \(_req/);
  });

  it('blank orderbook refuses and does not call depth', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        depth: async (_id, limit) => {
          seen.push(limit);
          return { bids: [], asks: [], sequence: 0 };
        },
      }),
    );
    for (const q of ['', '?limit=', '?limit=0', '?limit=501', '?limit=nope', '?limit=50.5']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/orderbook/BTC%2FUSDT${q}` });
      expect(res.statusCode, q || '(blank)').toBe(400);
      expect(res.json().intafacedCode, q || '(blank)').toBe(TRADE_ORDERBOOK_LIMIT_UNSET);
      expect(res.json().code, q || '(blank)').toBe('BadRequest');
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('owner-explicit orderbook 50 is published (not invented)', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        depth: async (_id, limit) => {
          seen.push(limit);
          return { bids: [], asks: [], sequence: 0 };
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/orderbook/BTC%2FUSDT?limit=50' });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([50]);
    await app.close();
  });

  it('blank trades refuses and does not call publicTape', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        publicTape: async (_id, limit) => {
          seen.push(limit);
          return [];
        },
      }),
    );
    for (const q of ['', '?limit=', '?limit=0', '?limit=501', '?limit=nope']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/trades/BTC%2FUSDT${q}` });
      expect(res.statusCode, q || '(blank)').toBe(400);
      expect(res.json().intafacedCode, q || '(blank)').toBe(TRADE_TRADES_LIMIT_UNSET);
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('owner-explicit trades 100 is published (not invented)', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        publicTape: async (_id, limit) => {
          seen.push(limit);
          return [];
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/trades/BTC%2FUSDT?limit=100' });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([100]);
    await app.close();
  });

  it('blank ohlcv refuses and does not call candles', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        candles: async (_id, _tf, limit) => {
          seen.push(limit);
          return [];
        },
      }),
    );
    for (const q of [
      '?timeframe=1m',
      '?timeframe=1m&limit=',
      '?timeframe=1m&limit=0',
      '?timeframe=1m&limit=1001',
      '?timeframe=1m&limit=nope',
    ]) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/ohlcv/BTC%2FUSDT${q}` });
      expect(res.statusCode, q || '(blank)').toBe(400);
      expect(res.json().intafacedCode, q || '(blank)').toBe(TRADE_OHLCV_LIMIT_UNSET);
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('owner-explicit ohlcv 500 is published (not invented)', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        candles: async (_id, _tf, limit) => {
          seen.push(limit);
          return [];
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/ohlcv/BTC%2FUSDT?timeframe=1m&limit=500' });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([500]);
    await app.close();
  });

  it('blank markets refuses and does not call deps.markets', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        markets: async (limit) => {
          seen.push(limit);
          return [market];
        },
      }),
    );
    for (const q of ['', '?limit=', '?limit=0', '?limit=501', '?limit=nope', '?limit=50.5']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/markets${q}` });
      expect(res.statusCode, q || '(blank)').toBe(400);
      expect(res.json().intafacedCode, q || '(blank)').toBe(TRADE_MARKETS_LIMIT_UNSET);
      expect(res.json().code, q || '(blank)').toBe('BadRequest');
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('owner-explicit markets 50 is published (not invented)', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        markets: async (limit) => {
          seen.push(limit);
          return [market];
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/markets?limit=50' });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([50]);
    await app.close();
  });

  it('blank tickers refuses and does not call deps.markets', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        markets: async (limit) => {
          seen.push(limit);
          return [market];
        },
      }),
    );
    for (const q of ['', '?limit=', '?limit=0', '?limit=501', '?limit=nope', '?limit=50.5']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/tickers${q}` });
      expect(res.statusCode, q || '(blank)').toBe(400);
      expect(res.json().intafacedCode, q || '(blank)').toBe(TRADE_TICKERS_LIMIT_UNSET);
      expect(res.json().code, q || '(blank)').toBe('BadRequest');
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('owner-explicit tickers 500 is published (not invented)', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        markets: async (limit) => {
          seen.push(limit);
          return [market];
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/tickers?limit=500' });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([500]);
    await app.close();
  });

  it('ticker still passes depth 1 explicitly', async () => {
    const seen: number[] = [];
    const app = await build(
      deps({
        depth: async (_id, limit) => {
          seen.push(limit);
          return { bids: [['100', '1']], asks: [['101', '1']], sequence: 1 };
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/ticker/BTC%2FUSDT' });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([1]);
    await app.close();
  });
});
