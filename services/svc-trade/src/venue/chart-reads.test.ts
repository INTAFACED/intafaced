import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator } from '@intafaced/venue-sim';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { attachUserVenueRoutes } from './user-venue-rest.js';
import { UserVenueRouter } from './venue-router.js';

/**
 * J-charts-desk-01 through svc-trade's public venue chart routes: signed out, `/api/v1/venue/chart-markets` returns the
 * listed venue markets with their tick sizes and offered intervals, and `/api/v1/venue/chart-candles` returns the venue's
 * own candles up to 720 bars with an optional `since`. Door off refuses 404 `trade.user_venue_off`.
 */

let app: FastifyInstance;
let server: http.Server;
let url: string;
let sim: TestVenueSimulator;

beforeAll(async () => {
  ({ server, url, sim } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
  await seedTestVenue(sim);
  // Seed 300 one-minute TEST prints spanning 310 minutes in the past so history > 240 bars and `since` filtering are tested.
  const nowBucket = Math.floor(Date.now() / 60_000) * 60_000;
  const entries = Array.from({ length: 300 }, (_, i) => ({
    tradedAt: new Date(nowBucket - (310 - i) * 60_000),
    price: parseAmount(String(60000 + (i % 17))),
    amount: parseAmount('0.01'),
    takerSide: (i % 2 === 0 ? 'buy' : 'sell') as 'buy' | 'sell',
  }));
  sim.testSeedPrints('BTC-USDC', entries);
});
afterAll(async () => new Promise<void>((r) => server.close(() => r())));
afterEach(async () => app?.close());

async function mount(listed: string[] | null) {
  app = Fastify();
  let router: UserVenueRouter | null = null;
  if (listed !== null) {
    const door = new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
      builder: null,
      slippageCapBps: null,
      spreadLimitBps: 100,
      now: () => new Date(),
      listings: new StoreVenueRoutingGate(listedTestStore(listed)),
    });
    router = new UserVenueRouter({ doors: [door], store: new InMemoryPreparedActionStore(), now: () => new Date() });
  }
  attachUserVenueRoutes(app, router, {
    // Signed out: both routes are public market data and must never require a principal.
    requirePrincipal: (_req, reply) => {
      void reply.code(401).send({ code: 'AuthenticationError', message: 'signed out', intafacedCode: 'auth.required' });
      return null;
    },
    requireTradeJurisdiction: () => true,
    slippageCapBps: null,
  });
  await app.ready();
  return app;
}

describe('svc-trade: public venue chart markets and candles (J-charts-desk-01)', () => {
  it('lists venue chart markets and reads up to 720 candles with `since` signed out', async () => {
    const serverApp = await mount(['BTC-USDC', 'BTC-PERP']);
    const markets = await serverApp.inject({ method: 'GET', url: '/api/v1/venue/chart-markets' });
    expect(markets.statusCode, markets.body).toBe(200);
    const marketsBody = markets.json();
    expect(marketsBody).toMatchObject({ venueId: sim.venue.id, test: true });
    expect(marketsBody.intervals).toEqual(expect.arrayContaining(['1m', '15m', '30m', '1h', '1d', '1w']));
    const btc = marketsBody.value.find((m: { symbol: string }) => m.symbol === 'BTC-USDC');
    expect(btc).toMatchObject({ symbol: 'BTC-USDC', kind: 'spot', baseAsset: 'BTC', quoteAsset: 'USDC', tickSize: '1' });

    // Initial 240-bar read and deep 720-bar read match the simulator's own candles.
    const venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 });
    const recent = await serverApp.inject({ method: 'GET', url: '/api/v1/venue/chart-candles?symbol=BTC-USDC&interval=1m&limit=240' });
    expect(recent.statusCode, recent.body).toBe(200);
    expect(recent.json().value).toHaveLength(240);
    expect(recent.json().depth).toBe(720);

    const since = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 280 * 60_000);
    const deep = await serverApp.inject({
      method: 'GET',
      url: `/api/v1/venue/chart-candles?symbol=BTC-USDC&interval=1m&limit=720&since=${encodeURIComponent(since.toISOString())}`,
    });
    expect(deep.statusCode, deep.body).toBe(200);
    const ownDeep = await venue.candles!('BTC-USDC', '1m', { limit: 720, since });
    expect(ownDeep.value.length).toBeGreaterThan(240);
    expect(deep.json().value).toEqual(
      ownDeep.value.map((c) => ({
        openAt: c.openAt.toISOString(),
        openPrice: formatAmount(c.openPrice),
        highPrice: formatAmount(c.highPrice),
        lowPrice: formatAmount(c.lowPrice),
        closePrice: formatAmount(c.closePrice),
        baseVolume: formatAmount(c.baseVolume),
      })),
    );
  });

  it('refuses unlisted symbols, unsupported intervals, bad since, and door-off with typed codes', async () => {
    const serverApp = await mount(['BTC-USDC']);
    const unlisted = await serverApp.inject({ method: 'GET', url: '/api/v1/venue/chart-candles?symbol=ETH-USDC&interval=1m' });
    expect(unlisted.statusCode).toBe(422);
    expect(unlisted.json().intafacedCode).toBe('trade.venue.not_offered');

    const badInterval = await serverApp.inject({ method: 'GET', url: '/api/v1/venue/chart-candles?symbol=BTC-USDC&interval=3d' });
    expect(badInterval.statusCode).toBe(400);
    expect(badInterval.json().intafacedCode).toBe('trade.venue_request_invalid');

    const badSince = await serverApp.inject({ method: 'GET', url: '/api/v1/venue/chart-candles?symbol=BTC-USDC&interval=1m&since=nope' });
    expect(badSince.statusCode).toBe(400);
    expect(badSince.json().intafacedCode).toBe('trade.venue_request_invalid');

    await app.close();
    const offApp = await mount(null);
    for (const path of ['/api/v1/venue/chart-markets', '/api/v1/venue/chart-candles?symbol=BTC-USDC&interval=1m']) {
      const res = await offApp.inject({ method: 'GET', url: path });
      expect(res.statusCode, path).toBe(404);
      expect(res.json().intafacedCode, path).toBe('trade.user_venue_off');
    }
  });
});
