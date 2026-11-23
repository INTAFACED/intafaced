import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import {
  venueClientOrderId,
  type PlaceUserOrderIntent,
  type PlaceUserOrdersIntent,
  type PreparedVenueAction,
} from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, type BuilderFeeValue } from './user-venue-door.js';

// J-derivatives-03 #9 at the door: a close and an open signed together (`place_orders`) on a venue that takes them in one
// signed action. Each order is checked as an order alone (our builder fee, the listing gate), the action is stored under
// its one business key, a retry is the stored action and places nothing new, and each order's builder fee is ours to the
// builder-fee poster exactly as an order sent alone. Against the TEST venue simulator over loopback HTTP.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111e9';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333e9',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade J-derivatives-03 reverse')));
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

const leg = (clientOrderKey: string, reduceOnly: boolean): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: 'ETH-PERP',
  side: 'sell',
  type: 'market',
  amount: a('1'),
  price: a('2900'),
  timeInForce: 'IOC',
  reduceOnly,
  clientOrderKey,
  builderFee: null,
});
const reverse = (k: string): PlaceUserOrdersIntent => ({
  kind: 'place_orders',
  actionKey: k,
  orders: [leg(`${k}:close`, true), leg(`${k}:open`, false)],
});

function closeServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe('UserVenueDoor: orders signed together (J-derivatives-03 #9)', { timeout: 60_000 }, () => {
  let together: { server: http.Server; sim: TestVenueSimulator; url: string };
  let alone: { server: http.Server; sim: TestVenueSimulator; url: string };

  beforeAll(async () => {
    together = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532, ordersPerAction: 10 });
    alone = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 });
    for (const { sim } of [together, alone]) {
      await seedTestVenue(sim);
      sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'USDC', a('100000'), 'deposit:test:dv03-reverse');
    }
  });
  afterAll(async () => {
    await closeServer(together.server);
    await closeServer(alone.server);
  });

  function door(url: string, store = new InMemoryPreparedActionStore()) {
    return {
      store,
      d: new UserVenueDoor({
        connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 5000 }),
        appEnv: 'test',
        store,
        stepUp: noStepUp,
        builder: BUILDER,
        now: () => new Date(),
        listings: new StoreVenueRoutingGate(listedTestStore(['ETH-PERP'])),
        slippageCapBps: null,
      }),
    };
  }

  async function run(d: UserVenueDoor, intent: Parameters<UserVenueDoor['prepare']>[1]['intent'], actionKey?: string) {
    const prepared = await d.prepare(principal, { owner, signer, intent, ...(actionKey ? { actionKey } : {}) });
    return d.submit(principal, prepared.actionKey, await sign(prepared.prepared));
  }

  /** Approved our builder fee, 5x isolated, and long 1 ETH-PERP on the door's venue. */
  async function long(d: UserVenueDoor, tag: string) {
    expect(
      (await run(d, { kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('1') }, `builder:${owner}:${tag}`)).outcome,
    ).toMatchObject({ accepted: true });
    expect(
      (
        await run(
          d,
          { kind: 'update_leverage', symbol: 'ETH-PERP', leverageBps: 50_000, marginMode: 'isolated' },
          `leverage:${owner}:${tag}`,
        )
      ).outcome,
    ).toMatchObject({ accepted: true });
    const entry = { ...leg(`order:${owner}:${tag}:entry`, false), side: 'buy' as const, price: a('3100') };
    expect((await run(d, entry)).outcome).toMatchObject({ accepted: true, order: { status: 'filled' } });
  }

  it('status says how many orders the venue takes in one signed action', async () => {
    expect(await door(together.url).d.status()).toMatchObject({ available: true, ordersPerAction: 10 });
    expect(await door(alone.url).d.status()).toMatchObject({ available: true, ordersPerAction: 1 });
  });

  it('one signature: both orders carry our builder fee, each is answered, a retry is the stored action and places nothing new', async () => {
    const { d, store } = door(together.url);
    await long(d, 'r1');
    const k = `reverse:${owner}:r1`;
    const prepared = await d.prepare(principal, { owner, signer, intent: reverse(k) });
    expect(prepared).toMatchObject({ actionKey: k, reused: false, signed: false });
    const intent = prepared.prepared.intent as PlaceUserOrdersIntent;
    // Each order went through the order checks alone: our builder fee is attached to each.
    for (const o of intent.orders) expect(o.builderFee).toEqual({ builder: BUILDER.address, feeBps: a('1') });
    const signature = await sign(prepared.prepared);
    const first = await d.submit(principal, k, signature);
    expect(first).toMatchObject({ replayed: false, readBack: null, outcome: { definite: true, accepted: true } });
    if (!first.outcome.definite || !first.outcome.accepted) throw new Error('not accepted');
    expect(first.outcome.legs).toHaveLength(2);
    expect(first.outcome.legs![0]).toMatchObject({ accepted: true, order: { reduceOnly: true, status: 'filled' } });
    expect(first.outcome.legs![1]).toMatchObject({ accepted: true, order: { reduceOnly: false, status: 'filled' } });
    const account = { venueId: together.sim.venue.id, owner, subAccount: null };
    expect((await together.sim.positions(account)).value.find((p) => p.symbol === 'ETH-PERP')).toMatchObject({
      side: 'short',
      size: a('1'),
    });

    // The same action asked again: the stored bytes, already signed; sent again, its first answer, nothing new placed.
    const fills = (await together.sim.fills(account, new Date(0))).value.length;
    expect(await d.prepare(principal, { owner, signer, intent: reverse(k) })).toMatchObject({ reused: true, signed: true });
    const again = await d.submit(principal, k, signature);
    expect(again.replayed).toBe(true);
    expect(again.outcome).toEqual(first.outcome);
    expect((await together.sim.fills(account, new Date(0))).value).toHaveLength(fills);

    // Each order's builder fee is ours to the poster and the recon, by its own client id.
    const ids = intent.orders.map((o) => venueClientOrderId(together.sim.venue.id, o.clientOrderKey));
    expect([...(await store.sentBuilderFeeOrders(together.sim.venue.id, { owner, subAccount: null }, ids))].sort()).toEqual(
      [...ids].sort(),
    );
    expect([...(await store.builderFeeOrders(together.sim.venue.id, ids)).entries()].sort()).toEqual(ids.map((id) => [id, a('1')]).sort());
    expect((await store.routedOrders(new Date(), 50)).map((o) => o.venueClientOrderId)).toEqual(expect.arrayContaining(ids));
  });

  it('a venue that takes one order per signature refuses it before anything is stored or signed', async () => {
    const { d, store } = door(alone.url);
    await long(d, 'r2');
    const k = `reverse:${owner}:r2`;
    await expect(d.prepare(principal, { owner, signer, intent: reverse(k) })).rejects.toMatchObject({
      refusal: { code: 'not_offered' },
    });
    expect(await store.find(USER, k)).toBeNull();
  });

  it('refused at the door: an agent key, one order alone, and an order not keyed under the action', async () => {
    const { d, store } = door(together.url);
    const k = `reverse:${owner}:r3`;
    await expect(d.prepare(principal, { owner, signer: { role: 'agent', address: owner }, intent: reverse(k) })).rejects.toMatchObject({
      code: 'trade.venue_together_owner_only',
      status: 403,
    });
    await expect(
      d.prepare(principal, { owner, signer, intent: { kind: 'place_orders', actionKey: k, orders: [leg(`${k}:close`, true)] } }),
    ).rejects.toMatchObject({ code: 'trade.venue_request_invalid' });
    await expect(
      d.prepare(principal, {
        owner,
        signer,
        intent: { kind: 'place_orders', actionKey: k, orders: [leg(`${k}:close`, true), leg(`order:${owner}:elsewhere`, false)] },
      }),
    ).rejects.toMatchObject({ code: 'trade.venue_request_invalid' });
    expect(await store.find(USER, k)).toBeNull();
  });

  it('an order the listing gate would refuse alone is refused inside the action too', async () => {
    const { d } = door(together.url);
    const k = `reverse:${owner}:r4`;
    const intent: PlaceUserOrdersIntent = {
      kind: 'place_orders',
      actionKey: k,
      orders: [leg(`${k}:close`, true), { ...leg(`${k}:open`, false), symbol: 'BTC-PERP', price: a('59000') }],
    };
    await expect(d.prepare(principal, { owner, signer, intent })).rejects.toMatchObject({ status: 422 });
  });
});
