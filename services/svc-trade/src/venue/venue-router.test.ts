import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import type { PlaceUserOrderIntent, PreparedVenueAction } from '@intafaced/venue-contracts';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate, type VenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, UserVenueDoorError } from './user-venue-door.js';
import { UserVenueRouter, parseUserVenueUrls } from './venue-router.js';
import { HOUSE_EXPOSURE_ROUTED, routingReport, routingReportWire } from './routing-report.js';

// J-derivatives-28 #1 to #5 against two TEST venue simulators over loopback HTTP: A with a thin TEST ladder (1 BTC a
// level, as the stack's first venue) and B with a deep one (5 BTC a level). Every figure is TEST.

const USER = { userId: '11111111-1111-4111-8111-1111111128a1', sid: 's-28', scopes: ['trade:read', 'trade:write'] } as unknown as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade venue router')));
const owner = key.address.toLowerCase();
const BUILDER = { address: '0x00000000000000000000000000000000000b0028', feeBps: parseAmount('2') };

const A = 'test-venue-a';
const B = 'test-venue-b';
let servers: { server: http.Server; sim: TestVenueSimulator; url: string }[] = [];

beforeAll(async () => {
  for (const [id, size] of [
    [A, '1'],
    [B, '5'],
  ] as const) {
    const started = await startTestVenueServer({
      host: '127.0.0.1',
      port: 0,
      appEnv: 'test',
      chainId: 84532,
      id,
      displayName: `TEST venue ${id.slice(-1).toUpperCase()}`,
    });
    await seedTestVenue(started.sim, { levelSize: size });
    servers.push(started);
  }
});
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.server.close(() => r()))));
  servers = [];
});

const sim = (id: string) => servers.find((s) => s.sim.venue.id === id)!.sim;
const fund = (id: string, who: string, asset: string, amount: string, ref: string) =>
  sim(id).deposit({ venueId: id, owner: who, subAccount: null }, asset, parseAmount(amount), ref);

function gate(): VenueRoutingGate {
  const gates = new Map([A, B].map((id) => [id, new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP'], id))]));
  return {
    shown: (venueId, at) => gates.get(venueId)!.shown(venueId, at),
    admitPlace: (venueId, intent, at) => gates.get(venueId)!.admitPlace(venueId, intent, at),
  };
}

function router() {
  const store = new InMemoryPreparedActionStore();
  const listings = gate();
  const doors = servers.map(
    (s) =>
      new UserVenueDoor({
        connect: () => HttpUserVenue.connect({ baseUrl: s.url, timeoutMs: 2000 }),
        appEnv: 'test',
        store,
        stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
        builder: BUILDER,
        now: () => new Date(),
        listings,
      }),
  );
  return { router: new UserVenueRouter({ doors, store, now: () => new Date() }), store, doors };
}

const buy = (amount: string, n: string): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: 'BTC-USDC',
  side: 'buy',
  type: 'market',
  amount: parseAmount(amount),
  price: parseAmount('60100'),
  timeInForce: 'IOC',
  reduceOnly: false,
  clientOrderKey: `order:${USER.userId}:router:${n}`,
  builderFee: null,
});

async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

describe('UserVenueRouter', () => {
  it('parses TRADE_USER_VENUE_URLS: blank is none, a non-URL stops the boot', () => {
    expect(parseUserVenueUrls('')).toEqual([]);
    expect(parseUserVenueUrls(' http://127.0.0.1:1 , http://127.0.0.1:2 ')).toEqual(['http://127.0.0.1:1', 'http://127.0.0.1:2']);
    expect(() => parseUserVenueUrls('127.0.0.1:1')).toThrow(/http/);
  });

  it('#1: every venue for the market with its own book and fees; signable where the wallet has an account, else connect', async () => {
    const { router: r } = router();
    const who = privateKeyToAccount(keccak256(toHex('router #1'))).address.toLowerCase();
    fund(A, who, 'USDC', '1000', 'r1:a');
    const read = await r.marketVenues(who, 'BTC-USDC');
    expect(read.venues.map((v) => [v.venueId, v.account, v.health.state, v.listed])).toEqual([
      [A, 'signable', 'up', true],
      [B, 'connect', 'up', true],
    ]);
    for (const v of read.venues) {
      const book = (await sim(v.venueId!).book('BTC-USDC', 5)).value;
      expect(v.book!.value.asks.map((l) => [formatAmount(l.price), formatAmount(l.amount)])).toEqual(
        book.asks.map((l) => [formatAmount(l.price), formatAmount(l.amount)]),
      );
      expect(v.market!.takerFeeBps).toEqual({ known: true, value: parseAmount('3.5') });
    }
    // A spot buy carries no builder fee; a sell carries ours.
    expect(read.venues[0]!.builderFee).toEqual({ published: true, carries: false });
    expect((await r.marketVenues(who, 'BTC-USDC', 'sell')).venues[0]!.builderFee).toEqual({
      published: true,
      carries: true,
      feeBps: BUILDER.feeBps,
    });
    // A fee the venue does not publish reads as not known, never zero.
    sim(B).setMarketFees('BTC-USDC', { makerFeeBps: { known: false }, takerFeeBps: { known: false } });
    try {
      expect((await r.marketVenues(who, 'BTC-USDC')).venues[1]!.market!.takerFeeBps).toEqual({ known: false });
    } finally {
      sim(B).setMarketFees('BTC-USDC', {
        makerFeeBps: { known: true, value: parseAmount('1') },
        takerFeeBps: { known: true, value: parseAmount('3.5') },
      });
    }
  });

  it('#2: the order A cannot fill whole goes to B with the reason; an unpublished fee is named; equal books tie by id', async () => {
    const { router: r } = router();
    fund(A, owner, 'USDC', '1000000', 'r2:a');
    fund(B, owner, 'USDC', '1000000', 'r2:b');
    const aBest = (await sim(A).book('BTC-USDC', 1)).value.asks[0]!;
    const size = formatAmount(aBest.amount + parseAmount('0.5'));
    const p = await r.routePreview(USER, owner, buy(size, 'p2'));
    // A fills it only by walking past its shown best level; B fills all of it at its best: B costs less.
    expect(p.chosen?.venueId).toBe(B);
    expect(p.reason).toBe('lowest_cost');
    expect(p.others.map((o) => o.venueId)).toEqual([A]);
    expect(p.others[0]!.shownBest).toEqual({ price: aBest.price, amount: aBest.amount });
    expect(p.chosen!.cost.fillsWhole).toBe(true);
    expect(p.chosen!.cost.total < p.others[0]!.total).toBe(true);

    sim(B).setMarketFees('BTC-USDC', { makerFeeBps: { known: false }, takerFeeBps: { known: false } });
    try {
      const unknown = await r.routePreview(USER, owner, buy(size, 'p2b'));
      expect(unknown.chosen?.venueId).toBe(B);
      expect(unknown.chosen!.preview.value.venueFee).toEqual({ known: false });
      expect(unknown.chosen!.cost.unknownFees).toEqual(['venue_fee']);
    } finally {
      sim(B).setMarketFees('BTC-USDC', {
        makerFeeBps: { known: true, value: parseAmount('1') },
        takerFeeBps: { known: true, value: parseAmount('3.5') },
      });
    }

    // A size both fill whole at the same best ask: the cost decides, and equal cost is decided by id, stably.
    const small = await r.routePreview(USER, owner, buy('0.01', 'p2c'));
    expect(small.chosen?.venueId).toBe(A);
    expect(['tie_by_id', 'lowest_cost']).toContain(small.reason);
    expect((await r.routePreview(USER, owner, buy('0.01', 'p2d'))).chosen?.venueId).toBe(small.chosen?.venueId);
  });

  it('#3 and #5: prepared on the chosen venue, signed once, sent once there; a retry re-sends the same client id', async () => {
    const { router: r } = router();
    fund(B, owner, 'USDC', '1000000', 'r3:b');
    const intent = buy('0.2', 'p3');
    const d = await r.door(B);
    const prep = await d.prepare(USER, { owner, signer: { role: 'owner', address: owner }, intent });
    expect(prep.prepared.venueId).toBe(B);
    const signature = await sign(prep.prepared);
    // The primary door refuses to send B's action; the router sends it on B.
    await expect(r.primary.submit(USER, prep.actionKey, signature)).rejects.toMatchObject({ code: 'trade.venue_action_other_venue' });
    const first = await r.submit(USER, prep.actionKey, signature);
    expect(first.outcome).toMatchObject({ definite: true, accepted: true });
    const again = await r.submit(USER, prep.actionKey, signature);
    expect(again.outcome).toEqual(first.outcome);
    const acct = { venueId: B, owner, subAccount: null };
    const fills = (await sim(B).fills(acct, new Date(0))).value.filter((f) => f.venueClientOrderId === prep.prepared.venueClientOrderId);
    expect(fills.reduce((s, f) => s + f.amount, 0n)).toBe(parseAmount('0.2'));
    expect((await sim(A).orderByClientId({ venueId: A, owner, subAccount: null }, prep.prepared.venueClientOrderId!)).value).toBeNull();
    // A second prepare of the key is the stored action: no second prompt.
    expect((await d.prepare(USER, { owner, signer: { role: 'owner', address: owner }, intent })).reused).toBe(true);
  });

  it('#4: a venue that goes down is marked down with since when and why, left out of the preview, and marked up when back', async () => {
    const { router: r } = router();
    fund(A, owner, 'USDC', '1000000', 'r4:a');
    fund(B, owner, 'USDC', '1000000', 'r4:b');
    sim(B).switches.venueDown = true;
    try {
      const read = await r.marketVenues(owner, 'BTC-USDC');
      expect(read.venues[1]).toMatchObject({ venueId: B, health: { state: 'down' } });
      expect(read.venues[1]!.health.reason).toMatch(/down/);
      const p = await r.routePreview(USER, owner, buy('3', 'p4'));
      expect(p.chosen?.venueId).toBe(A);
      expect(p.excluded).toEqual([expect.objectContaining({ venueId: B, code: 'venue_down' })]);
      sim(A).switches.venueDown = true;
      const none = await r.routePreview(USER, owner, buy('3', 'p4b'));
      expect(none.chosen).toBeNull();
      expect(none.reason).toBe('no_signable_venue_up');
      expect(none.excluded.map((e) => [e.venueId, e.code])).toEqual([
        [A, 'venue_down'],
        [B, 'venue_down'],
      ]);
    } finally {
      sim(A).switches.venueDown = false;
      sim(B).switches.venueDown = false;
    }
    const back = await r.marketVenues(owner, 'BTC-USDC');
    expect(back.venues.map((v) => v.health.state)).toEqual(['up', 'up']);
  });

  it('#8 and #6: the approval names B and our published fee, the order then fills there; the report shows it by venue', async () => {
    const { router: r, store, doors } = router();
    const from = new Date(Date.now() - 1000);
    fund(B, owner, 'BTC', '1', 'r6:b');
    const d = await r.door(B);
    const signer = { role: 'owner' as const, address: owner };
    const sell: PlaceUserOrderIntent = { ...buy('0.3', 'p6'), side: 'sell', price: parseAmount('59900') };
    // Never approved: the venue refuses the order before anything is signed for it.
    const refused = await d.prepare(USER, { owner, signer, intent: sell }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ refusal: { code: 'builder_fee_not_approved', venueId: B } });
    // An agent key can't sign the approval.
    const agent = { role: 'agent' as const, address: '0x00000000000000000000000000000000000a6e70' };
    const approve = { kind: 'approve_builder_fee' as const, builder: BUILDER.address, maxFeeBps: BUILDER.feeBps };
    await expect(
      d.prepare(USER, { owner, signer: agent, intent: approve, actionKey: `builder-approval:${owner}:${B}:2:agent` }),
    ).rejects.toMatchObject({
      refusal: { code: 'agent_not_permitted' },
    });
    const ap = await d.prepare(USER, { owner, signer, intent: approve, actionKey: `builder-approval:${owner}:${B}:2` });
    expect(ap.prepared.venueId).toBe(B);
    expect((await r.submit(USER, ap.actionKey, await sign(ap.prepared))).outcome).toMatchObject({ definite: true, accepted: true });
    expect((await sim(B).builderFeeApproval({ venueId: B, owner, subAccount: null }, BUILDER.address)).value).toBe(BUILDER.feeBps);
    const prep = await d.prepare(USER, { owner, signer, intent: sell });
    expect(prep.prepared.intent).toMatchObject({ builderFee: { builder: BUILDER.address, feeBps: BUILDER.feeBps } });
    expect((await r.submit(USER, prep.actionKey, await sign(prep.prepared))).outcome).toMatchObject({ definite: true, accepted: true });

    const report = await routingReport({ doors, store }, from, new Date(Date.now() + 1000));
    const fills = (await sim(B).fills({ venueId: B, owner, subAccount: null }, from)).value.filter(
      (f) => f.venueClientOrderId === prep.prepared.venueClientOrderId,
    );
    const volume = fills.reduce((t, f) => t + (f.price * f.amount) / 10n ** 18n, 0n);
    const fees = fills.reduce((t, f) => t + f.builderFee, 0n);
    expect(fees > 0n).toBe(true);
    const rowB = report.venues.find((v) => v.venueId === B)!;
    expect(rowB).toMatchObject({ state: 'up', orders: 1, fills: fills.length, houseExposure: HOUSE_EXPOSURE_ROUTED });
    expect(rowB.volume).toEqual([{ asset: 'USDC', amount: volume }]);
    expect(rowB.builderFees).toEqual([{ asset: fills[0]!.feeAsset, amount: fees }]);
    expect(report.venues.find((v) => v.venueId === A)).toMatchObject({ orders: 0, volume: [], builderFees: [] });
    expect(report.houseExposure).toBe('none: routed');
    // As the operator console reads it over tRPC: plain JSON, every amount a decimal string, never a bigint.
    const wire = JSON.parse(JSON.stringify(routingReportWire(report)));
    const wireB = wire.venues.find((v: { venueId: string }) => v.venueId === B);
    expect(wireB.volume).toEqual([{ asset: 'USDC', amount: formatAmount(volume) }]);
    expect(wireB.builderFees).toEqual([{ asset: fills[0]!.feeAsset, amount: formatAmount(fees) }]);
    expect(wire.volume).toEqual([{ asset: 'USDC', amount: formatAmount(volume) }]);
    expect([typeof wire.from, typeof wire.to, typeof wireB.asOf]).toEqual(['string', 'string', 'string']);

    sim(B).switches.venueDown = true;
    try {
      const downReport = await routingReport({ doors, store }, from, new Date(Date.now() + 1000));
      expect(downReport.venues.find((v) => v.venueId === B)).toMatchObject({ state: 'down' });
      expect(downReport.totalsExclude).toEqual([B]);
    } finally {
      sim(B).switches.venueDown = false;
    }
    await expect(routingReport({ doors, store }, new Date(), new Date(0))).rejects.toMatchObject({
      code: 'trade.venue_routing_period_invalid',
    });
  });

  it('a venue id no configured venue has is refused', async () => {
    const { router: r } = router();
    await expect(r.door('nowhere')).rejects.toBeInstanceOf(UserVenueDoorError);
    expect(await r.door(null)).toBe(r.primary);
  });
});
