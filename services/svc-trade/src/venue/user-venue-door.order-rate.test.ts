import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { PlaceUserOrderIntent, PreparedVenueAction } from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { OrderRateWindow, UserVenueDoor, UserVenueDoorError, publishedOrderRate, type BuilderFeeValue } from './user-venue-door.js';
import { venueRefusalReply } from './user-venue-rest.js';

// J-derivatives-04 #7 at the door: the owner's order-rate limit (TRADE_VENUE_ORDER_RATE_PER_MINUTE). Blank, the door
// counts nothing of its own and says the limit is not set (the edge's limit is the one in force); set, a venue account's
// new orders on one market are held to it, with nothing stored for a refused one. Against the TEST venue simulator over
// loopback HTTP; the orders are TEST buys of ETH-PERP and BTC-PERP far under their TEST marks, so none fills.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111f7';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333f7',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade J-derivatives-04 order rate')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}
const noStepUp: StepUpCheck = {
  async require() {
    return { stepUpEventId: 'unused', consumedAt: null, replayed: false };
  },
};

const BUILDER: BuilderFeeValue = { address: '0x00000000000000000000000000000000000000b9', feeBps: a('1') };

const buy = (k: string, over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: 'ETH-PERP',
  side: 'buy',
  type: 'limit',
  amount: a('0.01'),
  price: a('2000'),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: `order:${owner}:${k}`,
  builderFee: null,
  ...over,
});

function closeServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe('UserVenueDoor: the owner order-rate limit (J-derivatives-04 #7)', { timeout: 60_000 }, () => {
  let venue: { server: http.Server; sim: TestVenueSimulator; url: string };
  let clock = Date.parse('2026-11-23T00:00:00Z');
  const stores = { blank: new InMemoryPreparedActionStore(), two: new InMemoryPreparedActionStore() };
  const account = () => ({ venueId: venue.sim.venue.id, owner, subAccount: null });
  const door = (name: keyof typeof stores, orderRatePerMinute: number | null) =>
    new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: venue.url, timeoutMs: 5000 }),
      appEnv: 'test',
      store: stores[name],
      stepUp: noStepUp,
      builder: BUILDER,
      now: () => new Date(clock),
      listings: new StoreVenueRoutingGate(listedTestStore(['ETH-PERP', 'BTC-PERP'])),
      slippageCapBps: null,
      orderRatePerMinute,
    });
  const prepare = (d: UserVenueDoor, intent: Parameters<UserVenueDoor['prepare']>[1]['intent']) =>
    d.prepare(principal, { owner, signer, intent });

  beforeAll(async () => {
    venue = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532, ordersPerAction: 10 });
    await seedTestVenue(venue.sim);
    venue.sim.deposit(account(), 'USDC', a('100000'), 'deposit:test:jd4-order-rate');
    const d = door('blank', null);
    const run = async (intent: Parameters<UserVenueDoor['prepare']>[1]['intent'], actionKey: string) => {
      const prepared = await d.prepare(principal, { owner, signer, intent, actionKey });
      expect((await d.submit(principal, prepared.actionKey, await sign(prepared.prepared))).outcome).toMatchObject({ accepted: true });
    };
    await run({ kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('1') }, `builder:${owner}:jd4-rate`);
    for (const symbol of ['ETH-PERP', 'BTC-PERP'])
      await run({ kind: 'update_leverage', symbol, leverageBps: 50_000, marginMode: 'isolated' }, `leverage:${owner}:${symbol}`);
  });
  afterAll(async () => closeServer(venue.server));

  it('blank is not set, never unlimited by a number of ours: the door counts nothing and says so', async () => {
    for (const blank of [null, undefined, 0, -3, 1.5, Number.NaN]) expect(publishedOrderRate(blank)).toBeNull();
    expect(publishedOrderRate(1)).toBe(1);
    const d = door('blank', null);
    expect(await d.status()).toMatchObject({ available: true, orderRatePerMinute: { known: false } });
    for (let i = 0; i < 5; i += 1) expect((await prepare(d, buy(`blank-${i}`))).reused).toBe(false);
  });

  it('set, a venue account is held to it on one market, and a refused order stores nothing', async () => {
    const d = door('two', 2);
    expect(await d.status()).toMatchObject({ available: true, orderRatePerMinute: { known: true, value: 2 } });
    const first = await prepare(d, buy('one'));
    clock += 10_000;
    await prepare(d, buy('two'));
    clock += 10_000;
    // The third new order inside the minute: refused by name, with the seconds until the first leaves the minute.
    const refused = await prepare(d, buy('three')).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UserVenueDoorError);
    expect(refused).toMatchObject({ code: 'trade.venue_order_rate_limited', status: 429, retryAfterSeconds: 40 });
    expect((refused as Error).message).toContain('at most 2 new orders a minute on one market for one venue account');
    expect(await stores.two.find(USER, `order:${owner}:three`)).toBeNull();
    // A key asked again is the stored action and takes no place; another market has its own minute; an order that only
    // reduces a position is never counted or refused by the limit (the venue itself may refuse it: there is no position).
    expect(await prepare(d, buy('one'))).toMatchObject({ reused: true, prepared: { digest: first.prepared.digest } });
    expect((await prepare(d, buy('btc-one', { symbol: 'BTC-PERP', price: a('40000'), amount: a('0.001') }))).reused).toBe(false);
    const closing = await prepare(d, buy('closing', { side: 'sell', price: a('4000'), reduceOnly: true })).catch((error: unknown) => error);
    expect(closing).not.toBeInstanceOf(UserVenueDoorError);
    // More new orders in one request than the whole limit: no wait helps, so none is named.
    const actionKey = `batch:${owner}:three-at-once`;
    const batch = await prepare(d, {
      kind: 'place_orders',
      actionKey,
      orders: [1, 2, 3].map((n) =>
        buy(`batch-${n}`, { symbol: 'BTC-PERP', price: a('40000'), amount: a('0.001'), clientOrderKey: `${actionKey}:${n}` }),
      ),
    }).catch((error: unknown) => error);
    expect(batch).toMatchObject({ code: 'trade.venue_order_rate_limited', status: 429, retryAfterSeconds: undefined });
    expect(await stores.two.find(USER, actionKey)).toBeNull();
    // Once the first order has left the minute, the next one passes.
    clock += 40_000;
    expect((await prepare(d, buy('three'))).reused).toBe(false);
  });

  it('a request takes a place for each of its orders or none, and says how long until it fits', () => {
    const w = new OrderRateWindow();
    expect(w.take(['a', 'a', 'b'], 2, 1_000)).toEqual({ ok: true });
    // `a` is full, so nothing of this request is taken, `b` included.
    expect(w.take(['a', 'b'], 2, 2_000)).toEqual({ ok: false, retryAfterSeconds: 59 });
    expect(w.take(['b'], 2, 2_000)).toEqual({ ok: true });
    expect(w.take(['b'], 2, 2_000)).toEqual({ ok: false, retryAfterSeconds: 59 });
    expect(w.take(['a', 'a', 'a'], 2, 500_000)).toEqual({ ok: false, retryAfterSeconds: null });
    expect(w.take(['a', 'a'], 2, 61_000)).toEqual({ ok: true });
  });

  it('the refusal is sent as 429 RateLimitExceeded with retry-after', () => {
    const sent: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
    const reply = {
      code(status: number) {
        sent.status = status;
        return reply;
      },
      header(name: string, value: string) {
        sent.headers[name] = value;
        return reply;
      },
      send(body: unknown) {
        sent.body = body;
        return reply;
      },
    };
    venueRefusalReply(reply as never, new UserVenueDoorError('held', 'trade.venue_order_rate_limited', 429, 40));
    expect(sent).toEqual({
      status: 429,
      headers: { 'retry-after': '40' },
      body: { code: 'RateLimitExceeded', message: 'held', intafacedCode: 'trade.venue_order_rate_limited' },
    });
  });
});
