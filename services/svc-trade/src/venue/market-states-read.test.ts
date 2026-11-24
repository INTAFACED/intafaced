import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate, type ShownListing, type VenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { attachUserVenueRoutes } from './user-venue-rest.js';
import { UserVenueRouter } from './venue-router.js';

/**
 * J-cex-spot-14 #1 #2 through svc-trade's venue door: `GET /api/v1/venue/market-states`, signed in or not, answers each
 * market we show with the venue's own state and session and our listing beside them (opening time, delisting date,
 * routing), as of the venue read's time. A market we do not list is not there, and with the door off the read refuses
 * `trade.user_venue_off` so the app keeps its own reads. Every figure is TEST.
 */

const NOW = new Date('2026-11-24T10:00:00.000Z');
const HOUR = 3_600_000;

let app: FastifyInstance;
let server: http.Server;
let url: string;
let sim: TestVenueSimulator;
beforeAll(async () => {
  ({ server, url, sim } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
  await seedTestVenue(sim);
});
afterAll(async () => new Promise<void>((r) => server.close(() => r())));
afterEach(async () => {
  sim.setMarketStatus('BTC-USDC', 'trading');
  await app?.close();
});

/** BTC-USDC open, BTC-PERP opening in an hour, ETH-PERP open and delisting in a day; nothing else listed. */
function gate(): VenueRoutingGate {
  const shown = (opensAt: Date, delistsAt: Date | null): ShownListing => ({
    version: 1,
    opensAt,
    delistsAt,
    routing: 'show',
    open: opensAt.getTime() <= NOW.getTime(),
    delisted: delistsAt !== null && delistsAt.getTime() <= NOW.getTime(),
    maxOrderQty: null,
    maxOrderNotional: null,
  });
  const map = new Map<string, ShownListing>([
    ['BTC-USDC', shown(new Date(NOW.getTime() - HOUR), null)],
    ['BTC-PERP', shown(new Date(NOW.getTime() + HOUR), null)],
    ['ETH-PERP', shown(new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() + 24 * HOUR))],
  ]);
  const real = new StoreVenueRoutingGate(listedTestStore([]));
  return { shown: async () => map, admitPlace: (venueId, intent, at) => real.admitPlace(venueId, intent, at) };
}

async function mount(on = true) {
  app = Fastify();
  const door = new UserVenueDoor({
    connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
    appEnv: 'test',
    store: new InMemoryPreparedActionStore(),
    stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
    builder: null,
    slippageCapBps: null,
    spreadLimitBps: 100,
    now: () => NOW,
    listings: gate(),
  });
  const router = new UserVenueRouter({ doors: [door], store: new InMemoryPreparedActionStore(), now: () => NOW });
  attachUserVenueRoutes(app, on ? router : null, {
    // Signed out: the read is public, so no principal is ever asked for.
    requirePrincipal: (_req, reply) => {
      void reply.code(401).send({ code: 'AuthenticationError' });
      return null;
    },
    requireTradeJurisdiction: () => true,
    slippageCapBps: null,
  });
  await app.ready();
  return app;
}

describe('/api/v1/venue/market-states (J-cex-spot-14 #1 #2)', () => {
  it('answers each market we list, signed out, with the venue state beside our listing, as of the venue read', async () => {
    const a = await mount();
    sim.setMarketStatus('BTC-USDC', 'cancel_only');
    const res = await a.inject({ url: '/api/v1/venue/market-states' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.value.test).toBe(true);
    expect(body.value.label).toBe('TEST');
    expect(Number.isNaN(Date.parse(body.asOf))).toBe(false);
    const bySymbol = new Map(body.value.markets.map((m: { symbol: string }) => [m.symbol, m]));
    // Only what we list: the venue's other markets are not on the read.
    expect([...bySymbol.keys()].sort()).toEqual(['BTC-PERP', 'BTC-USDC', 'ETH-PERP']);
    expect(bySymbol.get('BTC-USDC')).toMatchObject({
      kind: 'spot',
      baseAsset: 'BTC',
      quoteAsset: 'USDC',
      status: 'cancel_only',
      listing: { routing: 'show', open: true, delisted: false, delistsAt: null },
    });
    expect(bySymbol.get('BTC-PERP')).toMatchObject({
      status: 'trading',
      listing: { open: false, opensAt: new Date(NOW.getTime() + HOUR).toISOString() },
    });
    expect(bySymbol.get('ETH-PERP')).toMatchObject({
      listing: { open: true, delisted: false, delistsAt: new Date(NOW.getTime() + 24 * HOUR).toISOString() },
    });
  });

  it('follows the venue: a state the venue changes is the state the next read answers', async () => {
    const a = await mount();
    const read = async () =>
      (await a.inject({ url: '/api/v1/venue/market-states' }))
        .json()
        .value.markets.find((m: { symbol: string }) => m.symbol === 'BTC-USDC');
    expect((await read()).status).toBe('trading');
    sim.setMarketStatus('BTC-USDC', 'halted');
    expect((await read()).status).toBe('halted');
    sim.setMarketStatus('BTC-USDC', null);
    expect((await read()).status).toBeNull();
  });

  it('refuses trade.user_venue_off where the door is off, so the app keeps its own reads', async () => {
    const a = await mount(false);
    const res = await a.inject({ url: '/api/v1/venue/market-states' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ intafacedCode: 'trade.user_venue_off' });
  });
});
