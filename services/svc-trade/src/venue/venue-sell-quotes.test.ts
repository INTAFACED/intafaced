import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client/money';
import { startTestVenueServer, type TestVenueSimulator } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, UserVenueDoorError } from './user-venue-door.js';
import { MemoryVenueSellQuoteStore, VenueSellQuotes, presentVenueSellQuote } from './venue-sell-quotes.js';

// J-cex-spot-17 #8: Convert's sell quote is the venue's own preview of a market sell of that size on the customer's venue
// account, stored exactly as the venue gave it, sending nothing. Run against the TEST venue simulator over HTTP.
const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111c8';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333c8',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;
const owner = '0x00000000000000000000000000000000000000c8';
/** A TEST builder fee of 1 bp: with none published, the venue refuses `builder_fee_not_published` and nothing is quoted. */
const BUILDER = { address: '0x00000000000000000000000000000000000000b1', feeBps: a('1') };

let server: http.Server;
let sim: TestVenueSimulator;
let url: string;

beforeAll(async () => {
  ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
  const { seedTestVenue } = await import('@intafaced/venue-sim');
  await seedTestVenue(sim);
  sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'BTC', a('2'), 'deposit:test:quote-btc');
});
afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

function desk(now = () => new Date('2026-11-10T03:00:00.000Z')) {
  const door = new UserVenueDoor({
    connect: async () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
    appEnv: 'test',
    store: new InMemoryPreparedActionStore(),
    stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
    builder: BUILDER,
    now,
    listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP'])),
  });
  const store = new MemoryVenueSellQuoteStore();
  return { quotes: new VenueSellQuotes({ door, store, now }), store };
}

const intentFor = (amount: string, tick: bigint) => ({
  kind: 'place_order' as const,
  symbol: 'BTC-USDC',
  side: 'sell' as const,
  type: 'market' as const,
  amount: a(amount),
  price: tick,
  timeInForce: 'IOC' as const,
  reduceOnly: false,
  clientOrderKey: 'order:independent-check',
  builderFee: { builder: BUILDER.address, feeBps: BUILDER.feeBps },
});

describe('VenueSellQuotes: a Convert sell priced by the venue', () => {
  it("stores the venue's own fill, average price and fees for the sell size, exactly as the venue previews it", async () => {
    const { quotes } = desk();
    const q = await quotes.quote(principal, { owner, symbol: 'BTC-USDC', amount: a('1.5'), quoteKey: 'quote-key-0001' });
    // The venue's own answer for the same sell, read from the simulator directly.
    const tick = (await sim.markets(null)).value.find((m) => m.symbol === 'BTC-USDC')!.tickSize;
    const venue = await sim.preview({ venueId: sim.venue.id, owner, subAccount: null }, intentFor('1.5', tick));
    expect(q.fill).toEqual(venue.value.fill);
    expect(q.venueFee).toEqual(venue.value.venueFee);
    expect(q.builderFee).toEqual(venue.value.builderFee);
    // The seeded book's two best bids, 1 at 59990 and 1 at 59980: 1.5 fills at 59986.666…, rounded down on a sell.
    expect(q.fill).toEqual({ known: true, value: { amount: a('1.5'), averagePrice: a('59986.666666666666666666') } });
    expect(q).toMatchObject({ quoteId: `venue-sell:${USER}:quote-key-0001`, venueId: sim.venue.id, proofLevel: 'simulator' });
    expect(presentVenueSellQuote(q)).toMatchObject({
      test: true,
      amount: '1.5',
      fill: { known: true, amount: '1.5', averagePrice: '59986.666666666666666666' },
      baseAsset: 'BTC',
      quoteAsset: 'USDC',
    });
  });

  it('sends nothing to the venue: no order rests or fills, and the balance is untouched', async () => {
    const { quotes } = desk();
    const account = { venueId: sim.venue.id, owner, subAccount: null };
    const before = await sim.balances(account);
    await quotes.quote(principal, { owner, symbol: 'BTC-USDC', amount: a('0.5'), quoteKey: 'quote-key-0002' });
    expect((await sim.openOrders(account)).value).toEqual([]);
    expect((await sim.balances(account)).value).toEqual(before.value);
  });

  it('a retry under the same key returns the quote first given; the same key for another sell refuses', async () => {
    let t = new Date('2026-11-10T03:00:00.000Z');
    const { quotes, store } = desk(() => t);
    const first = await quotes.quote(principal, { owner, symbol: 'BTC-USDC', amount: a('0.25'), quoteKey: 'quote-key-0003' });
    t = new Date('2026-11-10T03:00:05.000Z');
    const again = await quotes.quote(principal, { owner, symbol: 'BTC-USDC', amount: a('0.25'), quoteKey: 'quote-key-0003' });
    expect(again).toEqual(first);
    expect(await store.latest(10)).toHaveLength(1);
    await expect(
      quotes.quote(principal, { owner, symbol: 'BTC-USDC', amount: a('0.3'), quoteKey: 'quote-key-0003' }),
    ).rejects.toMatchObject({ code: 'trade.venue_sell_quote_key_reused', status: 409 });
  });

  it('refuses a perpetual, an unknown market, a bad key and a non-positive amount, storing nothing', async () => {
    const { quotes, store } = desk();
    const ask = { owner, symbol: 'BTC-USDC', amount: a('1'), quoteKey: 'quote-key-0004' };
    await expect(quotes.quote(principal, { ...ask, symbol: 'BTC-PERP' })).rejects.toMatchObject({
      code: 'trade.venue_sell_quote_not_spot',
    });
    await expect(quotes.quote(principal, { ...ask, symbol: 'DOGE-USDC' })).rejects.toMatchObject({
      code: 'trade.venue_sell_quote_market_unknown',
    });
    await expect(quotes.quote(principal, { ...ask, quoteKey: 'short' })).rejects.toBeInstanceOf(UserVenueDoorError);
    await expect(quotes.quote(principal, { ...ask, amount: 0n })).rejects.toMatchObject({ code: 'trade.venue_request_invalid' });
    await expect(quotes.quote(principal, { ...ask, owner: 'not-an-address' })).rejects.toMatchObject({
      code: 'trade.venue_request_invalid',
    });
    expect(await store.latest(10)).toEqual([]);
  });

  it('keeps a figure the venue does not give as not known, never zero, through the store', async () => {
    const store = new MemoryVenueSellQuoteStore();
    const q = await store.insert({
      quoteId: 'venue-sell:u:quote-key-0005',
      userId: 'u',
      venueId: 'v',
      proofLevel: 'live',
      owner,
      symbol: 'BTC-USDC',
      baseAsset: 'BTC',
      quoteAsset: 'USDC',
      amount: a('1'),
      fill: { known: false },
      venueFee: { known: false },
      builderFee: { known: false },
      asOf: new Date('2026-11-10T03:00:00.000Z'),
      createdAt: new Date('2026-11-10T03:00:00.000Z'),
    });
    expect(presentVenueSellQuote(q)).toMatchObject({
      test: false,
      fill: { known: false },
      venueFee: { known: false },
      builderFee: { known: false },
    });
  });
});
