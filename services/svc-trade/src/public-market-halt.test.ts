/**
 * Unit card — GET /api/v1/market-halt/:symbol (the chart's book halt read)
 *
 * 1. Promise: the answer says whether matching's book for this market (and the venue) is halted. A halt that cannot be
 *    read answers 503 trade.book_halt_unavailable: a chart reads that as refused, never as open.
 * 2. Break: an absent or throwing reader answered open, so a halted book read as live.
 * 3. Done bar: halted and open books answer 200 with both flags; no reader, a thrown read and an unknown symbol do not
 *    answer 200.
 * 4. Since: each halt in force says when it began (haltedSince, venueHaltedSince), as matching journaled it. A start
 *    matching did not give, a blank or malformed one, and the start of a halt no longer in force all read null: "time
 *    unknown", never a guess.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { fakeMarket, registerPublicRest, type PublicRestDeps } from './public-rest.js';
import { bookHaltFromBoard } from './spot/matching-client.js';

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

  it('says when each halt in force began, as matching journaled it', async () => {
    const res = await get(
      deps({
        bookHalt: async () => ({
          halted: true,
          venueHalted: true,
          haltedSince: '2026-10-30T10:00:00.000Z',
          venueHaltedSince: '2026-10-30T10:03:00.000Z',
        }),
      }),
      '/api/v1/market-halt/BTC%2FUSDT',
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ haltedSince: '2026-10-30T10:00:00.000Z', venueHaltedSince: '2026-10-30T10:03:00.000Z' });
  });

  it('a halt whose start matching did not say reads null (time unknown), and an open book carries no start', async () => {
    const unknown = await get(deps({ bookHalt: async () => ({ halted: true, venueHalted: false }) }), '/api/v1/market-halt/BTC%2FUSDT');
    expect(unknown.json()).toMatchObject({ halted: true, haltedSince: null, venueHaltedSince: null });
    const stale = await get(
      deps({
        bookHalt: async () => ({
          halted: false,
          venueHalted: false,
          haltedSince: '2026-10-30T10:00:00.000Z',
          venueHaltedSince: '2026-10-30T10:00:00.000Z',
        }),
      }),
      '/api/v1/market-halt/BTC%2FUSDT',
    );
    expect(stale.json()).toMatchObject({ halted: false, haltedSince: null, venueHalted: false, venueHaltedSince: null });
  });

  it('a blank or malformed start reads null, never served as a time', async () => {
    for (const bad of ['', 'not-a-date', '2026-13-45T99:99:99Z', '30/10/2026 10:00']) {
      const res = await get(
        deps({ bookHalt: async () => ({ halted: true, venueHalted: true, haltedSince: bad, venueHaltedSince: bad }) }),
        '/api/v1/market-halt/BTC%2FUSDT',
      );
      expect(res.json(), bad).toMatchObject({ halted: true, haltedSince: null, venueHalted: true, venueHaltedSince: null });
    }
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

describe("bookHaltFromBoard: one market read from matching's board", () => {
  it('reads the flags and the start by market id, and null where the board gives none', () => {
    const board = {
      markets: ['m-btc', 'm-eth'],
      halted: ['m-btc', 'm-eth'],
      haltedSince: { 'm-btc': '2026-10-30T10:00:00.000Z' },
      venueHalted: true,
      venueHaltedSince: '2026-10-30T10:03:00.000Z',
    };
    expect(bookHaltFromBoard(board, 'm-btc')).toEqual({
      halted: true,
      venueHalted: true,
      haltedSince: '2026-10-30T10:00:00.000Z',
      venueHaltedSince: '2026-10-30T10:03:00.000Z',
    });
    expect(bookHaltFromBoard(board, 'm-eth')).toMatchObject({ halted: true, haltedSince: null });
    expect(bookHaltFromBoard({ markets: ['m-btc'], halted: [], venueHalted: false }, 'm-btc')).toEqual({
      halted: false,
      venueHalted: false,
      haltedSince: null,
      venueHaltedSince: null,
    });
  });

  it('a board with no halt fields is no halt state: it throws, never an open book', () => {
    expect(() => bookHaltFromBoard({ markets: ['m-btc'] }, 'm-btc')).toThrow('matching reports no halt state');
  });
});
