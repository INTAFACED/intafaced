import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { PlaceUserOrderIntent, PreparedVenueAction, VenueSignature } from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { MemoryTradingRestrictionRead, addsExposure, createIdentityTradingRestrictionRead } from './trading-restriction.js';

// J-support-public-20 #7: "the app refuses the customer's new orders" on the launch model. While identity holds a
// trading restriction on the person (a support agent's account freeze), the user-venue door prepares and sends no new
// order that adds exposure, and refuses when the restriction can't be read; a cancel and a reduce-only order still go,
// and an order prepared before the freeze is refused at its first send. Against the TEST venue simulator over loopback.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111120a7';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333320a7',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade J-support-public-20 #7 restriction')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
async function sign(prepared: PreparedVenueAction): Promise<VenueSignature> {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}
const noStepUp: StepUpCheck = { require: async () => ({ stepUpEventId: 'unused', consumedAt: null, replayed: false }) };
const order = (over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent =>
  ({
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: a('0.01'),
    price: a('30000'),
    timeInForce: 'GTC',
    reduceOnly: false,
    builderFee: null,
    ...over,
  }) as PlaceUserOrderIntent;

describe('UserVenueDoor refuses new orders while identity restricts trading', () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  let n = 0;

  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    await seedTestVenue(sim);
    sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'USDC', a('100000'), 'deposit:test:20a7');
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const openOnVenue = async () => (await sim.openOrders({ venueId: sim.venue.id, owner, subAccount: null })).value.length;

  function door(restriction: MemoryTradingRestrictionRead, store = new InMemoryPreparedActionStore()): UserVenueDoor {
    return new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }) as never,
      appEnv: 'test',
      store,
      stepUp: noStepUp,
      builder: null,
      now: () => new Date(),
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC'])),
      ordersPageMax: 50,
      slippageCapBps: null,
      closeSlippageBps: 1000,
      tradingRestriction: restriction,
    });
  }
  const keyed = () => `order:${owner}:btc-usdc:r${++n}`;

  it('places a new order while no restriction holds', async () => {
    const d = door(new MemoryTradingRestrictionRead());
    const before = await openOnVenue();
    const prepared = await d.prepare(principal, { owner, signer, intent: { ...order(), clientOrderKey: keyed() } });
    const sent = await d.submit(principal, prepared.actionKey, await sign(prepared.prepared));
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
    expect(await openOnVenue()).toBe(before + 1);
  });

  it('refuses a new order by name while restricted: nothing prepared, stored or sent', async () => {
    const restriction = new MemoryTradingRestrictionRead();
    restriction.restrictedUsers.add(USER);
    const store = new InMemoryPreparedActionStore();
    const d = door(restriction, store);
    const before = await openOnVenue();
    const clientOrderKey = keyed();
    await expect(d.prepare(principal, { owner, signer, intent: { ...order(), clientOrderKey } })).rejects.toMatchObject({
      code: 'trade.account_restricted',
      status: 403,
    });
    expect(await store.find(USER, clientOrderKey)).toBeNull();
    expect(await openOnVenue()).toBe(before);
  });

  it('refuses while the restriction cannot be read (fail closed)', async () => {
    const restriction = new MemoryTradingRestrictionRead();
    restriction.down = true;
    const d = door(restriction);
    await expect(d.prepare(principal, { owner, signer, intent: { ...order(), clientOrderKey: keyed() } })).rejects.toMatchObject({
      code: 'trade.account_restriction_unavailable',
      status: 503,
    });
  });

  it('an order prepared before the restriction is refused at its first send, and never reaches the venue', async () => {
    const restriction = new MemoryTradingRestrictionRead();
    const d = door(restriction);
    const before = await openOnVenue();
    const prepared = await d.prepare(principal, { owner, signer, intent: { ...order(), clientOrderKey: keyed() } });
    restriction.restrictedUsers.add(USER);
    await expect(d.submit(principal, prepared.actionKey, await sign(prepared.prepared))).rejects.toMatchObject({
      code: 'trade.account_restricted',
    });
    expect(await openOnVenue()).toBe(before);
  });

  it('a cancel of an order already resting still goes while restricted, so funds are never stranded', async () => {
    const restriction = new MemoryTradingRestrictionRead();
    const d = door(restriction);
    const clientOrderKey = keyed();
    const placed = await d.prepare(principal, { owner, signer, intent: { ...order(), clientOrderKey } });
    await d.submit(principal, placed.actionKey, await sign(placed.prepared));
    const resting = await openOnVenue();
    restriction.restrictedUsers.add(USER);
    const cancel = await d.prepare(principal, { owner, signer, intent: { kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey } });
    const sent = await d.submit(principal, cancel.actionKey, await sign(cancel.prepared));
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
    expect(await openOnVenue()).toBe(resting - 1);
  });

  it('only an order that adds exposure is checked', () => {
    expect(addsExposure(order())).toBe(true);
    expect(addsExposure(order({ reduceOnly: true }))).toBe(false);
    expect(addsExposure({ kind: 'place_orders', orders: [order({ reduceOnly: true }), order()] } as never)).toBe(true);
    expect(addsExposure({ kind: 'place_orders', orders: [order({ reduceOnly: true })] } as never)).toBe(false);
    expect(addsExposure({ kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey: 'k' })).toBe(false);
  });
});

describe("identity's trading restriction read", () => {
  const ID = '11111111-1111-4111-8111-1111111120a8';
  const reading = (answer: (url: string) => Response) =>
    createIdentityTradingRestrictionRead({
      baseUrl: 'http://identity.test/',
      internalSecret: 'a-trading-restriction-read-test-secret-32x',
      fetchFn: (async (input: string | URL | Request) => answer(String(input))) as typeof fetch,
    });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('asks the record path for the person and answers its restricted flag', async () => {
    const asked: string[] = [];
    const read = reading((url) => {
      asked.push(url);
      return json({ userId: ID, restricted: true });
    });
    expect(await read.restricted(ID)).toBe(true);
    expect(asked).toEqual([`http://identity.test/internal/trading-restriction/${ID}`]);
  });

  it('a refusal, an answer for another person, or a reply off the record is unavailable, never unrestricted', async () => {
    await expect(
      reading(() => json({ error: 'account not found', code: 'identity.account_not_found' }, 404)).restricted(ID),
    ).rejects.toMatchObject({
      name: 'TradingRestrictionUnavailable',
    });
    await expect(
      reading(() => json({ userId: '11111111-1111-4111-8111-1111111120a9', restricted: false })).restricted(ID),
    ).rejects.toMatchObject({ name: 'TradingRestrictionUnavailable' });
    await expect(reading(() => json({ userId: ID })).restricted(ID)).rejects.toMatchObject({ name: 'TradingRestrictionUnavailable' });
    await expect(
      reading(() => {
        throw new Error('TEST: connection refused');
      }).restricted(ID),
    ).rejects.toMatchObject({ name: 'TradingRestrictionUnavailable' });
  });
});
