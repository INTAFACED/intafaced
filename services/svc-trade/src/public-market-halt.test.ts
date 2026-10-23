/**
 * Unit card — GET /api/v1/market-halt/:symbol (the chart's book halt read)
 *
 * 1. Promise: the answer says whether matching's book for this market (and the venue) is halted. A halt that cannot be
 *    read answers 503 trade.book_halt_unavailable: a chart reads that as refused, never as open.
 * 2. Break: an absent or throwing reader answered open, so a halted book read as live.
 * 3. Done bar: halted and open books answer 200 with both flags; no reader, a thrown read and an unknown symbol do not
 *    answer 200.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { fakeMarket, registerPublicRest, type PublicRestDeps } from './public-rest.js';

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

async function get(d: PublicRestDeps, url: string) {
  const app = Fastify({ logger: false });
  registerPublicRest(app, d);
  await app.ready();
  const res = await app.inject({ method: 'GET', url });
  await app.close();
  return res;
}

describe('GET /api/v1/market-halt/:symbol', () => {
  it('answers the book halt for this market and the venue', async () => {
    const res = await get(deps({ bookHalt: async () => ({ halted: true, venueHalted: false }) }), '/api/v1/market-halt/BTC%2FUSDT');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ symbol: 'BTC/USDT', halted: true, venueHalted: false, serverTime: 1_700_000_000_000 });
  });

  it('answers an open book as open only when the reader says so', async () => {
    const res = await get(deps({ bookHalt: async () => ({ halted: false, venueHalted: false }) }), '/api/v1/market-halt/BTC%2FUSDT');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ halted: false, venueHalted: false });
  });

  it('refuses with trade.book_halt_unavailable when no reader is mounted', async () => {
    const res = await get(deps(), '/api/v1/market-halt/BTC%2FUSDT');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'trade.book_halt_unavailable' });
  });

  it('refuses with trade.book_halt_unavailable when the read throws, never open', async () => {
    const res = await get(
      deps({
        bookHalt: async () => {
          throw new Error('matching unreachable');
        },
      }),
      '/api/v1/market-halt/BTC%2FUSDT',
    );
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'trade.book_halt_unavailable' });
  });

  it('does not answer 200 for a symbol that is not listed', async () => {
    const res = await get(deps({ bookHalt: async () => ({ halted: false, venueHalted: false }) }), '/api/v1/market-halt/NOPE%2FUSDT');
    expect(res.statusCode).not.toBe(200);
  });
});
