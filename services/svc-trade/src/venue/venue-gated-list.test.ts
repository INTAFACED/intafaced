import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { startTestVenueServer } from '@intafaced/venue-sim';
import { parseAmount } from '@intafaced/ledger-client/money';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate, type ListedVenueMarket, type ShownListing } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, type BuilderFeeValue } from './user-venue-door.js';
import { attachUserVenueRoutes } from './user-venue-rest.js';
import { UserVenueRouter } from './venue-router.js';
import { venueGatedList } from './venue-gated-list.js';

// J-derivatives-01 #2: the venue desk's gated list, each perpetual open or blocked for this account with every reason.

const USER = { userId: '11111111-1111-4111-8111-1111111111d2', sid: 's-1', scopes: ['trade:read'] } as unknown as Principal;
const BUILDER: BuilderFeeValue = { address: '0x00000000000000000000000000000000000000b1', feeBps: parseAmount('1') };
const PERPS = ['BTC-PERP', 'XAU-PERP', 'XSTK-PERP', 'XSTD-PERP'];

let app: FastifyInstance;
let server: http.Server;
let url: string;
beforeAll(async () => {
  ({ server, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
});
afterAll(async () => new Promise<void>((r) => server.close(() => r())));
afterEach(async () => app?.close());

async function mount(builder: BuilderFeeValue | null, account: { code: string; message: string } | null) {
  app = Fastify();
  const door = new UserVenueDoor({
    connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
    appEnv: 'test',
    store: new InMemoryPreparedActionStore(),
    stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
    builder,
    now: () => new Date(),
    listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', ...PERPS])),
  });
  const router = new UserVenueRouter({ doors: [door], store: new InMemoryPreparedActionStore(), now: () => new Date() });
  attachUserVenueRoutes(app, router, {
    requirePrincipal: () => USER,
    // The routes it guards refuse; the gated list must not, so this one refusing would fail the read.
    requireTradeJurisdiction: (_req, reply) => {
      if (!account) return true;
      void reply.code(403).send({ code: 'PermissionDenied', message: account.message, intafacedCode: account.code });
      return false;
    },
    tradeAccessBlocker: () => account,
  });
  await app.ready();
}

const read = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/venue/gated-list' });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as {
    value: { symbol: string; open: boolean; code: string | null; blockers: { code: string }[] }[];
    asOf: string;
  };
  return { contracts: body.value, asOf: body.asOf };
};

async function marketStatus(symbol: string, status: string) {
  const res = await fetch(`${url}/test/market-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol, status }),
  });
  expect(res.status).toBe(200);
}

describe('GET /api/v1/venue/gated-list', () => {
  it('a verified account with our builder fee published: every perpetual we show is open, with no reason; spot is not listed', async () => {
    await mount(BUILDER, null);
    const body = await read();
    expect(body.contracts.map((c) => c.symbol).sort()).toEqual([...PERPS].sort());
    for (const c of body.contracts) expect(c).toMatchObject({ open: true, code: null, blockers: [] });
    expect(Number.isNaN(Date.parse(body.asOf))).toBe(false);
  });

  it('the region and level gate is a reason on every contract, not a refusal of the list', async () => {
    await mount(BUILDER, { code: 'denied.region_blocked', message: 'TEST region may not trade' });
    for (const c of (await read()).contracts) {
      expect(c).toMatchObject({ open: false, code: 'denied.region_blocked' });
      expect(c.blockers.map((b) => b.code)).toEqual(['denied.region_blocked']);
    }
  });

  it('our builder fee unpublished blocks every perpetual with its code; with the region gate too, both reasons show, region first', async () => {
    await mount(null, { code: 'denied.kyc_required', message: 'TEST level' });
    for (const c of (await read()).contracts) {
      expect(c.open).toBe(false);
      expect(c.blockers.map((b) => b.code)).toEqual(['denied.kyc_required', 'trade.venue.builder_fee_not_published']);
    }
  });

  it("the venue's own halt blocks that contract only, named as the venue's word; trading again, it is open", async () => {
    await mount(BUILDER, null);
    try {
      await marketStatus('XAU-PERP', 'halted');
      const body = await read();
      const xau = body.contracts.find((c) => c.symbol === 'XAU-PERP')!;
      expect(xau).toMatchObject({ open: false, code: 'trade.venue.market_halted' });
      for (const c of body.contracts.filter((x) => x.symbol !== 'XAU-PERP')) expect(c.open).toBe(true);
    } finally {
      await marketStatus('XAU-PERP', 'trading');
    }
    expect((await read()).contracts.find((c) => c.symbol === 'XAU-PERP')!.open).toBe(true);
  });
});

describe('venueGatedList: our listing', () => {
  const listing = (over: Partial<ShownListing>): ShownListing => ({
    version: 1,
    opensAt: new Date('2026-01-01T00:00:00Z'),
    delistsAt: null,
    routing: 'show',
    open: true,
    delisted: false,
    maxOrderQty: null,
    maxOrderNotional: null,
    ...over,
  });
  const market = (symbol: string, l: Partial<ShownListing>, status: ListedVenueMarket['status'] = 'trading') =>
    ({ symbol, kind: 'perpetual', status, listing: listing(l) }) as unknown as ListedVenueMarket;
  const codes = (m: ListedVenueMarket) =>
    venueGatedList({ markets: [m], account: null, builderFeePublished: () => true, venueName: 'TEST venue' })[0]!.blockers.map(
      (b) => b.code,
    );

  it('each of our routing states and dates is its own reason; a market with none is open', () => {
    expect(codes(market('A-PERP', {}))).toEqual([]);
    expect(codes(market('A-PERP', { routing: 'stop' }))).toEqual(['trade.venue_routing_stopped']);
    expect(codes(market('A-PERP', { routing: 'close_only' }))).toEqual(['trade.venue_routing_close_only']);
    expect(codes(market('A-PERP', { open: false, opensAt: new Date('2027-01-01T00:00:00Z') }))).toEqual(['trade.venue_market_not_open']);
    expect(codes(market('A-PERP', { delisted: true, delistsAt: new Date('2026-02-01T00:00:00Z') }))).toEqual([
      'trade.venue_market_delisted',
    ]);
  });

  it("the venue's cancel-only and delisted states are reasons in the venue's name; a market the venue reports no state for is open", () => {
    expect(codes(market('A-PERP', {}, 'cancel_only'))).toEqual(['trade.venue.market_cancel_only']);
    expect(codes(market('A-PERP', {}, 'delisted'))).toEqual(['trade.venue.market_delisted']);
    expect(codes(market('A-PERP', {}, null))).toEqual([]);
  });
});
