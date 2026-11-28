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
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import type { TestVenueTypedData } from '@intafaced/venue-sim';

/**
 * J-algo-dev-04 #2 through svc-trade's venue door: the candles of the TEST venue's own prints on the spot market we list on
 * an asset (`/spot-candles?base=BTC&interval=1m`), public and signed out, as a paper run reads them; an asset with no
 * listed spot market refuses `not_offered`.
 */

let app: FastifyInstance;
let server: http.Server;
let url: string;
let sim: TestVenueSimulator;
beforeAll(async () => {
  ({ server, url, sim } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
  await seedTestVenue(sim);
  // One TEST trader's signed buy that meets the seeded ask: the venue's own print, so there is a candle to read.
  const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet spot-candles-buyer')));
  const owner = key.address.toLowerCase();
  const account = { venueId: sim.venue.id, owner, subAccount: null };
  sim.deposit(account, 'USDC', parseAmount('100000'), 'chain:spot-candles:buyer');
  const prepared = await sim.prepare(
    account,
    { role: 'owner', address: owner },
    {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'buy',
      type: 'limit',
      amount: parseAmount('0.001'),
      price: parseAmount('61000'),
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: 'order:spot-candles:buy-1',
      builderFee: null,
    },
  );
  const typed = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  const outcome = await sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner });
  expect(outcome).toMatchObject({ accepted: true });
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

describe("svc-trade: the venue's spot candles (J-algo-dev-04 #2)", () => {
  it("answers signed out with the listed BTC spot market's candles, the venue's own", async () => {
    const venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 });
    const own = await venue.candles!('BTC-USDC', '1m', 500);
    const res = await (
      await mount(['BTC-PERP', 'BTC-USDC'])
    ).inject({
      method: 'GET',
      url: '/api/v1/venue/spot-candles?base=btc&interval=1m&limit=500',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ venueId: sim.venue.id, symbol: 'BTC-USDC', test: true });
    expect(typeof body.asOf).toBe('string');
    expect(own.value.length).toBeGreaterThan(0);
    expect(body.value).toEqual(
      own.value.map((c) => ({
        openAt: c.openAt.toISOString(),
        openPrice: formatAmount(c.openPrice),
        highPrice: formatAmount(c.highPrice),
        lowPrice: formatAmount(c.lowPrice),
        closePrice: formatAmount(c.closePrice),
        baseVolume: formatAmount(c.baseVolume),
      })),
    );
    // The buy met the seeded ask's first level, 60010.
    expect(body.value.at(-1).closePrice).toBe('60010');
  });

  it('refuses not_offered for an asset with no listed spot market, and a malformed asset or interval', async () => {
    const none = await (await mount(['BTC-PERP'])).inject({ method: 'GET', url: '/api/v1/venue/spot-candles?base=BTC&interval=1m' });
    expect(none.statusCode).toBe(422);
    expect(none.json().intafacedCode).toBe('trade.venue.not_offered');
    await app.close();
    const bad = await (await mount(['BTC-USDC'])).inject({ method: 'GET', url: '/api/v1/venue/spot-candles?base=BTC%2FUSDT&interval=1m' });
    expect(bad.statusCode).toBe(400);
    await app.close();
    const interval = await (await mount(['BTC-USDC'])).inject({ method: 'GET', url: '/api/v1/venue/spot-candles?base=BTC&interval=7m' });
    expect(interval.statusCode).toBe(400);
  });
});
