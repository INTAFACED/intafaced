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
 * J-derivatives-14 #4 through svc-trade's venue door: a perpetual's open interest with the venue's count of accounts long
 * and short and their ratio (`/open-interest`), and its risk-limit tiers (`/risk-limits`), `ladder_unset` while the venue
 * publishes no ladder. Every figure is the venue's own, from its positions; every figure is TEST.
 */

const USER = { userId: '11111111-1111-4111-8111-1111111111d4', sid: 's-14', scopes: ['trade:read'] } as Principal;
const SYMBOL = 'XDEV-PERP';

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

async function mount() {
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
    listings: new StoreVenueRoutingGate(listedTestStore(['BTC-PERP', 'XRSK-PERP', SYMBOL])),
  });
  const router = new UserVenueRouter({ doors: [door], store: new InMemoryPreparedActionStore(), now: () => new Date() });
  attachUserVenueRoutes(app, router, {
    requirePrincipal: () => USER,
    requireTradeJurisdiction: () => true,
    slippageCapBps: null,
  });
  await app.ready();
  return app;
}

/** One TEST trader's signed order on XDEV-PERP, straight on the venue with its own key. */
async function trade(name: string, side: 'buy' | 'sell', amount: string, timeInForce: 'GTC' | 'IOC') {
  const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet svc-trade open interest ${name}`)));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  sim.deposit(account, 'USDC', parseAmount('1000'), `chain:jd14-rest:${name}`);
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
  const placed = await send({
    kind: 'place_order',
    symbol: SYMBOL,
    side,
    type: 'limit',
    amount: parseAmount(amount),
    price: parseAmount('100'),
    timeInForce,
    reduceOnly: false,
    clientOrderKey: `order:jd14-rest:${name}`,
    builderFee: null,
  });
  expect(placed).toMatchObject({ definite: true, accepted: true });
}

describe('/api/v1/venue open interest and risk limits (J-derivatives-14 #4)', () => {
  it("answers open interest and the ratio from the venue's own positions: 3 long and 1 short read 3 to 1", async () => {
    const a = await mount();
    const before = await a.inject({ url: `/api/v1/venue/open-interest?symbol=${SYMBOL}` });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toMatchObject({
      symbol: SYMBOL,
      openInterest: { size: '0', capSize: null },
      longAccounts: 0,
      shortAccounts: 0,
      longShortRatio: null,
      reason: null,
      test: true,
    });
    // One TEST trader rests a sell of 3 and three others each buy 1 from it: three accounts long, one short.
    await trade('short', 'sell', '3', 'GTC');
    for (const n of ['long-1', 'long-2', 'long-3']) await trade(n, 'buy', '1', 'IOC');
    const after = await a.inject({ url: `/api/v1/venue/open-interest?symbol=${SYMBOL}` });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json()).toMatchObject({
      symbol: SYMBOL,
      openInterest: { size: '3', capSize: null },
      longAccounts: 3,
      shortAccounts: 1,
      longShortRatio: '3',
      reason: null,
    });
    // The same counts the venue publishes on its own market.
    const market = (await sim.markets(null)).value.find((m) => m.symbol === SYMBOL)!;
    expect(market.longShort).toEqual({ known: true, value: { longAccounts: 3, shortAccounts: 1 } });
  });

  it("answers null with the venue's reason where it publishes no count, and refuses a market we do not list", async () => {
    const a = await mount();
    const none = await a.inject({ url: '/api/v1/venue/open-interest?symbol=BTC-PERP' });
    expect(none.statusCode, none.body).toBe(200);
    expect(none.json()).toMatchObject({
      symbol: 'BTC-PERP',
      openInterest: null,
      longAccounts: null,
      shortAccounts: null,
      longShortRatio: null,
      reason: `${sim.venue.displayName} publishes no long and short count for BTC-PERP`,
    });
    const unlisted = await a.inject({ url: '/api/v1/venue/open-interest?symbol=XFND-PERP' });
    expect(unlisted.statusCode).toBe(422);
    expect(unlisted.json()).toMatchObject({ intafacedCode: 'trade.venue.not_offered' });
  });

  it("answers the venue's published risk-limit tiers, and ladder_unset while it publishes none", async () => {
    const a = await mount();
    const unset = await a.inject({ url: `/api/v1/venue/risk-limits?symbol=${SYMBOL}` });
    expect(unset.statusCode, unset.body).toBe(200);
    expect(unset.json()).toMatchObject({ symbol: SYMBOL, tiers: null, reason: 'ladder_unset', test: true });
    const published = await a.inject({ url: '/api/v1/venue/risk-limits?symbol=XRSK-PERP' });
    expect(published.statusCode, published.body).toBe(200);
    const venueTiers = (await sim.markets(null)).value.find((m) => m.symbol === 'XRSK-PERP')!.marginTiers;
    expect(venueTiers?.known).toBe(true);
    const body = published.json();
    expect(body).toMatchObject({ symbol: 'XRSK-PERP', reason: null });
    expect(body.tiers).toHaveLength(venueTiers?.known ? venueTiers.value.length : -1);
    expect(body.tiers.length).toBeGreaterThan(1);
  });
});
