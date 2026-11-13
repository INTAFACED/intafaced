import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type PlaceUserOrderIntent, type PreparedVenueAction, type VenueIntent } from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, type BuilderFeeValue } from './user-venue-door.js';
import { UserVenueRouter } from './venue-router.js';

/**
 * Our good-till-date (J-cex-spot-03 #7; project-state #2260): the owner's wallet signs the cancel before the order, with
 * the expiry as its nonce; our service sends it at the expiry. Against the TEST simulator over loopback HTTP.
 */
const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111110d1';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333330d1',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade good till date')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}
const BUILDER: BuilderFeeValue = { address: '0x00000000000000000000000000000000000000b1', feeBps: a('1') };

function closeServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe('our good-till-date on a venue that offers none (J-cex-spot-03 #7)', () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  const account = () => ({ venueId: sim.venue.id, owner, subAccount: null });

  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    const { seedTestVenue } = await import('@intafaced/venue-sim');
    await seedTestVenue(sim);
    sim.deposit(account(), 'USDC', a('100000'), 'deposit:test:gtd');
  });
  afterAll(async () => closeServer(server));

  function world(refuseSend: (p: PreparedVenueAction) => boolean = () => false) {
    let now = Date.now();
    const store = new InMemoryPreparedActionStore();
    const d = new UserVenueDoor({
      connect: async () => {
        const inner = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 });
        return Object.assign(Object.create(inner) as typeof inner, {
          submit: async (p: PreparedVenueAction, sig: Parameters<typeof inner.submit>[1]) => {
            if (refuseSend(p)) throw new VenueRefusalError({ venueId: inner.venue.id, code: 'venue_rejected', detail: 'TEST: refused' });
            return inner.submit(p, sig);
          },
        });
      },
      appEnv: 'test',
      store,
      stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
      builder: BUILDER,
      slippageCapBps: null,
      now: () => new Date(now),
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC'])),
    });
    const router = new UserVenueRouter({ doors: [d], store, now: () => new Date(now) });
    return { d, store, router, at: () => now, advance: (ms: number) => (now += ms) };
  }

  const order = (n: string): PlaceUserOrderIntent => ({
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: a('0.1'),
    price: a('50000'),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${USER}:gtd:${n}`,
    builderFee: null,
  });
  const cancelAt = (n: string, sendAt: number): VenueIntent => ({
    kind: 'cancel_order',
    symbol: 'BTC-USDC',
    clientOrderKey: `order:${USER}:gtd:${n}`,
    sendAt: String(sendAt),
  });
  const usdc = async () => (await sim.balances(account())).value.find((b) => b.asset === 'USDC')!;

  it('the cancel is signed first and stored; the order rests; at the expiry our sweep cancels it, the lock comes back once, and it reads expired', async () => {
    const w = world();
    const before = await usdc();
    const expiry = w.at() + 90_000;
    const cancel = await w.d.prepare(principal, { owner, signer, intent: cancelAt('1', expiry) });
    expect(cancel.actionKey).toBe(`gtd:order:${USER}:gtd:1`);
    const scheduled = await w.d.schedule(principal, cancel.actionKey, await sign(cancel.prepared));
    expect(scheduled).toEqual({ actionKey: cancel.actionKey, expiresAt: new Date(expiry).toISOString(), replayed: false });
    // Sent before its time, through the plain submit: refused, and nothing reaches the venue.
    await expect(w.d.submit(principal, cancel.actionKey, await sign(cancel.prepared))).rejects.toMatchObject({ code: 'trade.gtd_not_due' });

    const placed = await w.d.prepare(principal, { owner, signer, intent: order('1') });
    const sent = await w.d.submit(principal, placed.actionKey, await sign(placed.prepared));
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true, order: { status: 'open' } });
    const locked = (await usdc()).locked;
    expect(locked > before.locked).toBe(true);
    expect((await w.d.goodTillDates(principal, owner)).map((g) => g.state)).toEqual(['scheduled']);

    // Before the expiry the sweep sends nothing.
    expect((await w.router.sweepGoodTillDate()).sent).toBe(0);
    expect((await sim.orderByClientId(account(), placed.prepared.venueClientOrderId!)).value?.status).toBe('open');

    w.advance(90_000);
    expect((await w.router.sweepGoodTillDate()).sent).toBe(1);
    expect((await sim.orderByClientId(account(), placed.prepared.venueClientOrderId!)).value?.status).toBe('canceled');
    const after = await usdc();
    expect(after.locked).toBe(before.locked);
    expect(after.free).toBe(before.free);
    const [gtd] = await w.d.goodTillDates(principal, owner);
    expect(gtd).toMatchObject({ state: 'expired', expiresAt: new Date(expiry).toISOString(), refusal: null });
    // Once answered, it is never sent again.
    w.advance(10_000);
    expect((await w.router.sweepGoodTillDate()).sent).toBe(0);
  });

  it('a past time is refused at prepare and at schedule, and nothing is stored as signed', async () => {
    const w = world();
    await expect(w.d.prepare(principal, { owner, signer, intent: cancelAt('2', w.at() - 1) })).rejects.toMatchObject({
      code: 'trade.gtd_expiry_past',
    });
    const cancel = await w.d.prepare(principal, { owner, signer, intent: cancelAt('3', w.at() + 5_000) });
    w.advance(6_000);
    await expect(w.d.schedule(principal, cancel.actionKey, await sign(cancel.prepared))).rejects.toMatchObject({
      code: 'trade.gtd_expiry_past',
    });
    expect((await w.store.find(USER, cancel.actionKey))?.signature).toBeNull();
    expect(await w.d.goodTillDates(principal, owner)).toEqual([]);
  });

  it('the cancel is never signed after the order, never by a session key, and the gtd: key holds nothing else', async () => {
    const w = world();
    const placed = await w.d.prepare(principal, { owner, signer, intent: order('4') });
    await w.d.submit(principal, placed.actionKey, await sign(placed.prepared));
    await expect(w.d.prepare(principal, { owner, signer, intent: cancelAt('4', w.at() + 60_000) })).rejects.toMatchObject({
      code: 'trade.gtd_after_order',
    });
    await expect(
      w.d.prepare(principal, { owner, signer: { role: 'agent', address: owner }, intent: cancelAt('5', w.at() + 60_000) }),
    ).rejects.toMatchObject({ code: 'trade.gtd_owner_signs' });
    await expect(
      w.d.prepare(principal, {
        owner,
        signer,
        actionKey: `gtd:order:${USER}:gtd:6`,
        intent: { kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('1') },
      }),
    ).rejects.toMatchObject({ code: 'trade.venue_action_key_reserved' });
    // Clean up the resting order this test placed.
    const c = await w.d.prepare(principal, {
      owner,
      signer,
      intent: { kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey: placed.actionKey },
    });
    await w.d.submit(principal, c.actionKey, await sign(c.prepared));
  });

  it('an order the person cancelled before its expiry: the cancel at the expiry changes nothing and reads not_open', async () => {
    const w = world();
    const cancel = await w.d.prepare(principal, { owner, signer, intent: cancelAt('7', w.at() + 30_000) });
    await w.d.schedule(principal, cancel.actionKey, await sign(cancel.prepared));
    const placed = await w.d.prepare(principal, { owner, signer, intent: order('7') });
    await w.d.submit(principal, placed.actionKey, await sign(placed.prepared));
    const own = await w.d.prepare(principal, {
      owner,
      signer,
      intent: { kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey: placed.actionKey },
    });
    await w.d.submit(principal, own.actionKey, await sign(own.prepared));
    const before = await usdc();
    w.advance(30_000);
    expect((await w.router.sweepGoodTillDate()).sent).toBe(1);
    expect(await usdc()).toEqual(before);
    const [gtd] = await w.d.goodTillDates(principal, owner);
    expect(gtd!.state).toBe('not_open');
  });

  it('a cancel the venue refuses is recorded failed and shown so, and never holds the cancels due after it', async () => {
    const w = world((p) => p.intent.kind === 'cancel_order' && p.intent.sendAt != null && p.intent.clientOrderKey.endsWith(':8'));
    for (const n of ['8', '9']) {
      const c = await w.d.prepare(principal, { owner, signer, intent: cancelAt(n, w.at() + (n === '8' ? 10_000 : 20_000)) });
      await w.d.schedule(principal, c.actionKey, await sign(c.prepared));
      const o = await w.d.prepare(principal, { owner, signer, intent: order(n) });
      await w.d.submit(principal, o.actionKey, await sign(o.prepared));
    }
    w.advance(20_000);
    const swept = await w.router.sweepGoodTillDate();
    expect(swept).toEqual({ sent: 2, failed: [] });
    const states = Object.fromEntries((await w.d.goodTillDates(principal, owner)).map((g) => [g.clientOrderKey.split(':').at(-1), g]));
    expect(states['8']).toMatchObject({ state: 'failed', refusal: { code: 'venue_rejected' } });
    expect(states['9']).toMatchObject({ state: 'expired' });
    // A failed one is answered for good: not sent again.
    expect((await w.router.sweepGoodTillDate()).sent).toBe(0);
    // Clean up the order whose cancel was refused.
    const c = await w.d.prepare(principal, {
      owner,
      signer,
      intent: { kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey: order('8').clientOrderKey },
    });
    await w.d.submit(principal, c.actionKey, await sign(c.prepared));
  });
});
