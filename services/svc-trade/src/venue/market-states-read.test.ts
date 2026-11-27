import { formatAmount } from '@intafaced/ledger-client/money';
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

async function mount(
  on = true,
  opts: {
    maintenanceBoard?: () => Promise<{
      windows: { id: string; title: string; markets: string[]; startsAt: string | null; endsAt: string | null }[];
    } | null>;
    signedIn?: boolean;
  } = {},
) {
  app = Fastify();
  const door = new UserVenueDoor({
    connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
    appEnv: 'test',
    store: new InMemoryPreparedActionStore(),
    stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
    builder: null,
    slippageCapBps: null,
    closeSlippageBps: 1000,
    spreadLimitBps: 100,
    now: () => NOW,
    listings: gate(),
    ...(opts.maintenanceBoard ? { maintenanceBoard: opts.maintenanceBoard } : {}),
  });
  const router = new UserVenueRouter({ doors: [door], store: new InMemoryPreparedActionStore(), now: () => NOW });
  attachUserVenueRoutes(app, on ? router : null, {
    // Signed out by default: public reads never ask for a principal.
    requirePrincipal: (_req, reply) => {
      if (opts.signedIn) return { userId: 'u-test', kycLevel: 2, jurisdiction: 'US', scopes: ['trade:read', 'trade:write'] } as never;
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
    for (const path of [
      '/api/v1/venue/market-states',
      '/api/v1/venue/public-book?symbol=BTC-USDC',
      '/api/v1/venue/tickers',
      '/api/v1/venue/spreads',
      '/api/v1/venue/analytics?symbol=BTC-USDC&window=1h',
    ]) {
      const res = await a.inject({ url: path });
      expect(res.statusCode, path).toBe(404);
      expect(res.json(), path).toMatchObject({ intafacedCode: 'trade.user_venue_off' });
    }
  });

  it('attaches upcomingMaintenance and serves public-book, tickers, spreads, analytics (refusing blank window) and RPI refusal', async () => {
    const startsAt = new Date(NOW.getTime() + HOUR).toISOString();
    const a = await mount(true, {
      signedIn: true,
      maintenanceBoard: async () => ({
        windows: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            title: 'TEST BTC maintenance',
            startsAt,
            endsAt: null,
            markets: ['market-btc-usdc'],
          },
        ],
      }),
    });
    const statesRes = await a.inject({ url: '/api/v1/venue/market-states' });
    expect(statesRes.statusCode, statesRes.body).toBe(200);
    const btcState = statesRes.json().value.markets.find((m: { symbol: string }) => m.symbol === 'BTC-USDC');
    expect(btcState.upcomingMaintenance).toMatchObject({
      status: 'scheduled',
      noticeId: '00000000-0000-4000-8000-000000000001',
      startsAt,
      endsAt: null,
    });

    const bookRes = await a.inject({ url: '/api/v1/venue/public-book?symbol=BTC-USDC&depth=10' });
    expect(bookRes.statusCode, bookRes.body).toBe(200);
    expect(typeof bookRes.json().value.sequence).toBe('number');

    const tickersRes = await a.inject({ url: '/api/v1/venue/tickers' });
    expect(tickersRes.statusCode, tickersRes.body).toBe(200);
    expect(tickersRes.json().value['BTC-USDC']).toMatchObject({ symbol: 'BTC-USDC' });
    // Each listed perpetual is priced from the venue's own published prices: its mark, with no last print.
    const marks = new Map((await sim.perpetualPrices()).value.map((p) => [p.symbol, formatAmount(p.markPrice)]));
    for (const symbol of ['BTC-PERP', 'ETH-PERP']) {
      expect(marks.get(symbol), symbol).toMatch(/^\d/);
      expect(tickersRes.json().value[symbol], symbol).toMatchObject({ symbol, mark: marks.get(symbol), last: null });
    }

    const spreadsRes = await a.inject({ url: '/api/v1/venue/spreads' });
    expect(spreadsRes.statusCode, spreadsRes.body).toBe(200);
    expect(spreadsRes.json().value.some((r: { symbol: string }) => r.symbol === 'BTC-USDC')).toBe(true);

    const analyticsRes = await a.inject({ url: '/api/v1/venue/analytics?symbol=BTC-USDC&window=1h' });
    expect(analyticsRes.statusCode, analyticsRes.body).toBe(200);
    expect(analyticsRes.json()).toMatchObject({ symbol: 'BTC-USDC', window: '1h' });

    const blankWindow = await a.inject({ url: '/api/v1/venue/analytics?symbol=BTC-USDC' });
    expect(blankWindow.statusCode).toBe(400);
    expect(blankWindow.json()).toMatchObject({ intafacedCode: 'trade.analytics_window_unset' });

    const rpiPrepare = await a.inject({
      method: 'POST',
      url: '/api/v1/venue/prepare',
      payload: {
        owner: '0x1111111111111111111111111111111111111111',
        signer: { role: 'owner', address: '0x1111111111111111111111111111111111111111' },
        rpi: true,
        intent: {
          kind: 'place_order',
          symbol: 'BTC-USDC',
          side: 'buy',
          type: 'limit',
          amount: '0.01',
          price: '50000',
          timeInForce: 'GTC',
          reduceOnly: false,
          clientOrderKey: 'order:rpi:1',
        },
      },
    });
    expect(rpiPrepare.statusCode).toBe(400);
    expect(rpiPrepare.json()).toMatchObject({ intafacedCode: 'trade.rpi_unavailable' });

    const rpiPreview = await a.inject({
      method: 'POST',
      url: '/api/v1/venue/preview',
      payload: {
        owner: '0x1111111111111111111111111111111111111111',
        intent: {
          kind: 'place_order',
          symbol: 'BTC-USDC',
          side: 'buy',
          type: 'limit',
          amount: '0.01',
          price: '50000',
          timeInForce: 'GTC',
          reduceOnly: false,
          clientOrderKey: 'order:rpi:2',
          rpi: true,
        },
      },
    });
    expect(rpiPreview.statusCode).toBe(400);
    expect(rpiPreview.json()).toMatchObject({ intafacedCode: 'trade.rpi_unavailable' });
  });
});
