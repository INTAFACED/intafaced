import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import type { UserVenueAccount, VenueIntent } from '@intafaced/venue-contracts';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { attachUserVenueRoutes } from './user-venue-rest.js';
import { UserVenueRouter } from './venue-router.js';

/**
 * J-derivatives-08 through svc-trade's venue door: the funding the TEST venue charged or paid on the person's own
 * positions (`/funding-payments`, private, read since a time), its public funding history with the premium and the rate a
 * year (`/funding-history`), and its public mark and index series (`/price-history`), an unpublished index answering null
 * with the venue's reason. Every figure is the venue's own, as a decimal string; every figure is TEST.
 */

const USER = { userId: '11111111-1111-4111-8111-1111111111d8', sid: 's-8', scopes: ['trade:read', 'trade:write'] } as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade funding reads')));
const owner = key.address.toLowerCase();
const SYMBOL = 'XFND-PERP';

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

async function mount(signedIn = true) {
  app = Fastify();
  const door = new UserVenueDoor({
    connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
    appEnv: 'test',
    store: new InMemoryPreparedActionStore(),
    stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
    builder: null,
    slippageCapBps: null,
    spreadLimitBps: 100,
    now: () => new Date(),
    listings: new StoreVenueRoutingGate(listedTestStore(['BTC-PERP', SYMBOL])),
  });
  const router = new UserVenueRouter({ doors: [door], store: new InMemoryPreparedActionStore(), now: () => new Date() });
  attachUserVenueRoutes(app, router, {
    requirePrincipal: (_req, reply) => {
      if (signedIn) return USER;
      void reply.code(401).send({ code: 'AuthenticationError', message: 'signed out', intafacedCode: 'auth.required' });
      return null;
    },
    requireTradeJurisdiction: () => signedIn,
    slippageCapBps: null,
  });
  await app.ready();
  return app;
}

/** The person's TEST long of 2 XFND-PERP, taken from the TEST makers' ladder (signed with their own key, on the venue). */
async function openLong() {
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  sim.deposit(account, 'USDC', parseAmount('1000'), `chain:jd08-rest:${Date.now()}`);
  const send = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, { role: 'owner', address: owner }, intent);
    const typed = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    return sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner });
  };
  await send({ kind: 'update_leverage', symbol: SYMBOL, leverageBps: 50_000, marginMode: 'isolated' });
  const filled = await send({
    kind: 'place_order',
    symbol: SYMBOL,
    side: 'buy',
    type: 'limit',
    amount: parseAmount('2'),
    price: parseAmount('100.2'),
    timeInForce: 'IOC',
    reduceOnly: false,
    clientOrderKey: `order:jd08-rest:${Date.now()}`,
    builderFee: null,
  });
  expect(filled).toMatchObject({ definite: true, accepted: true });
}

describe('/api/v1/venue funding reads (J-derivatives-08)', () => {
  it("funding-payments answers the venue's own payments on the person's positions since a time, as decimal strings", async () => {
    await mount();
    const since = new Date(Date.now() - 60_000).toISOString();
    expect((await app.inject({ method: 'GET', url: `/api/v1/venue/funding-payments?owner=${owner}&since=${since}` })).json().value).toEqual(
      [],
    );
    expect((await app.inject({ method: 'GET', url: `/api/v1/venue/funding-payments?owner=${owner}` })).statusCode).toBe(400);
    await openLong();
    const closed = sim.settleFunding(SYMBOL);
    const res = await app.inject({ method: 'GET', url: `/api/v1/venue/funding-payments?owner=${owner}&since=${since}` });
    expect(res.statusCode).toBe(200);
    const [payment, ...more] = res.json().value;
    expect(more).toEqual([]);
    // Mark 100, index 100: the rate is the interest component, 0.0000125; 2 × 100 × 0.0000125 = 0.0025, paid by the long.
    expect(payment).toMatchObject({
      symbol: SYMBOL,
      side: 'long',
      size: '2',
      markPrice: '100',
      rate: '0.0000125',
      amount: '-0.0025',
      asset: 'USDC',
    });
    expect(payment.periodAt).toBe(closed.periodAt.toISOString());
  });

  it('funding-history carries each period premium and its rate a year; price-history the mark and index, an unpublished index null with its reason', async () => {
    await mount(false);
    const since = encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString());
    sim.settleFunding(SYMBOL);
    const history = await app.inject({ method: 'GET', url: `/api/v1/venue/funding-history?base=XFND&since=${since}` });
    expect(history.statusCode).toBe(200);
    const rows = history.json().value;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // 0.0000125 an hour, 8760 hours a year: 0.1095.
    for (const row of rows) expect(row).toMatchObject({ rate: '0.0000125', premium: '0', annualisedRate: '0.1095' });

    const mark = await app.inject({
      method: 'GET',
      url: `/api/v1/venue/price-history?symbol=${SYMBOL}&kind=mark&since=1970-01-01T00:00:00Z`,
    });
    expect(mark.statusCode).toBe(200);
    expect(mark.json()).toMatchObject({ symbol: SYMBOL, kind: 'mark', reason: null, test: true });
    expect(mark.json().series.map((s: { price: string }) => s.price)).toEqual(['100']);
    sim.setIndexPublished(SYMBOL, false);
    try {
      const index = await app.inject({
        method: 'GET',
        url: `/api/v1/venue/price-history?symbol=${SYMBOL}&kind=index&since=1970-01-01T00:00:00Z`,
      });
      expect(index.json()).toMatchObject({ series: null, reason: 'TEST venue simulator publishes no index for XFND-PERP' });
    } finally {
      sim.setIndexPublished(SYMBOL, true);
    }
    // A market we do not list, and a bad kind, are refused by name.
    const unlisted = await app.inject({ method: 'GET', url: `/api/v1/venue/price-history?symbol=XLIQ-PERP&kind=mark&since=${since}` });
    expect(unlisted.json().intafacedCode).toBe('trade.venue.not_offered');
    const bad = await app.inject({ method: 'GET', url: `/api/v1/venue/price-history?symbol=${SYMBOL}&kind=last&since=${since}` });
    expect(bad.statusCode).toBe(400);
    // The person's payments stay private: signed out, they refuse.
    expect((await app.inject({ method: 'GET', url: `/api/v1/venue/funding-payments?owner=${owner}&since=${since}` })).statusCode).toBe(401);
  });
});
