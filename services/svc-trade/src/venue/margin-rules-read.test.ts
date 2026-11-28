import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { attachUserVenueRoutes } from './user-venue-rest.js';
import { UserVenueRouter } from './venue-router.js';

/**
 * J-algo-dev-02 #5 through svc-trade's venue door: the margin rules the TEST venue publishes for the listed perpetual on an
 * asset (`/margin-rules?base=BTC`), public and signed out, as a margin backtest reads them: its maximum leverage and its one
 * maintenance rate, each the venue's own; an asset with no listed perpetual refuses `not_offered`.
 */

let app: FastifyInstance;
let server: http.Server;
let url: string;
let sim: TestVenueSimulator;
beforeAll(async () => {
  ({ server, url, sim } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
  await seedTestVenue(sim);
});
afterAll(async () => new Promise<void>((r) => server.close(() => r())));
afterEach(async () => app?.close());

async function mount(listed: string[]) {
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
    now: () => new Date(),
    listings: new StoreVenueRoutingGate(listedTestStore(listed)),
  });
  const router = new UserVenueRouter({ doors: [door], store: new InMemoryPreparedActionStore(), now: () => new Date() });
  attachUserVenueRoutes(app, router, {
    // Signed out: the route is public market data and never asks for a principal.
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

describe("svc-trade: the venue's published margin rules (J-algo-dev-02 #5)", () => {
  it("answers signed out with the listed BTC perpetual's maximum leverage and maintenance rate, as the venue publishes them", async () => {
    const res = await (await mount(['BTC-PERP', 'BTC-USDC'])).inject({ method: 'GET', url: '/api/v1/venue/margin-rules?base=btc' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      venueId: sim.venue.id,
      symbol: 'BTC-PERP',
      maxLeverageBps: 200_000,
      maintenanceRate: '0.005',
      test: true,
    });
    expect(typeof body.asOf).toBe('string');
  });

  it('reads a tiered perpetual as publishing no single maintenance rate', async () => {
    const res = await (await mount(['XRSK-PERP'])).inject({ method: 'GET', url: '/api/v1/venue/margin-rules?base=XRSK' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ symbol: 'XRSK-PERP', maintenanceRate: null });
  });

  it('refuses not_offered for an asset with no listed perpetual, and a malformed asset', async () => {
    const none = await (await mount(['BTC-USDC'])).inject({ method: 'GET', url: '/api/v1/venue/margin-rules?base=BTC' });
    expect(none.statusCode).toBe(422);
    expect(none.json().intafacedCode).toBe('trade.venue.not_offered');
    await app.close();
    const bad = await (await mount(['BTC-PERP'])).inject({ method: 'GET', url: '/api/v1/venue/margin-rules?base=BTC%2FUSDT' });
    expect(bad.statusCode).toBe(400);
  });
});
