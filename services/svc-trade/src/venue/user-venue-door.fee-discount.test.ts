import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { add, div, mul, parseAmount } from '@intafaced/ledger-client/money';
import type { PlaceUserOrderIntent, PreparedVenueAction } from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { FixedFeeSaver } from './fee-saver-client.js';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { UserVenueDoor, discountedBuilderFee, type BuilderFeeDiscounts, type BuilderFeeValue } from './user-venue-door.js';

// J-campaigns-09 #2 #3 (CM-vouchers-coupons-02): our builder fee on a venue order, less the larger of the person's rank
// discount and their best fee-saver coupon. The coupon is taken once per order key and only when it wins; svc-campaigns
// down leaves the order on the rank's rate (or the fee in force); an order keeps the fee it was signed with. TEST values:
// a 0.5 bp builder fee, a 25 bps-of-the-fee rank, a coupon taking half of the fee.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111c9';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333c9',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade fee discount')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
const BUILDER: BuilderFeeValue = { address: '0x00000000000000000000000000000000000000b1', feeBps: a('0.5') };
const COUPON = { voucherId: 'vch_test_fee_saver', code: 'TEST-SAVER', discountBps: 5000 };
const allowAll: StepUpCheck = {
  async require() {
    return { stepUpEventId: 'test', consumedAt: null, replayed: false };
  },
};

async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

describe('discountedBuilderFee', () => {
  it('takes a fraction of the fee and floors to the venue’s tenth of a basis point, never charging more than promised', () => {
    expect(discountedBuilderFee(a('0.5'), 5000)).toBe(a('0.2')); // 0.25 → 0.2
    expect(discountedBuilderFee(a('0.5'), 25)).toBe(a('0.4')); // 0.49875 → 0.4
    expect(discountedBuilderFee(a('1'), 5000)).toBe(a('0.5'));
    expect(discountedBuilderFee(a('1'), 10_000)).toBe(0n);
    expect(discountedBuilderFee(a('0.5'), 0)).toBe(a('0.5'));
  });
});

describe('UserVenueDoor: our builder fee at the winning discount (J-campaigns-09 #2 #3)', () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  let n = 0;

  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    const { seedTestVenue } = await import('@intafaced/venue-sim');
    await seedTestVenue(sim);
    sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'USDC', a('200000'), 'deposit:test:fee-discount');
    sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'BTC', a('1'), 'deposit:test:fee-discount-btc');
    const d = door({ rankBps: async () => 0, coupons: null });
    const approve = await d.prepare(principal, {
      owner,
      signer,
      intent: { kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('0.5') },
      actionKey: `approve-builder:${USER}:fee-discount`,
    });
    await d.submit(principal, approve.actionKey, await sign(approve.prepared));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function door(feeDiscounts: BuilderFeeDiscounts | undefined, store = new InMemoryPreparedActionStore()) {
    return new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
      appEnv: 'test',
      store,
      stepUp: allowAll,
      builder: BUILDER,
      slippageCapBps: null,
      now: () => new Date(),
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP'])),
      ...(feeDiscounts ? { feeDiscounts } : {}),
    });
  }
  // A spot sell resting above the TEST book: it carries our builder fee (a spot buy carries none).
  const sell = (over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent => ({
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'sell',
    type: 'limit',
    amount: a('0.001'),
    price: a('90000'),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${USER}:fee-discount:${++n}`,
    builderFee: null,
    ...over,
  });

  it('a coupon that beats the rank is taken once and the order is signed at its rate; a replay takes nothing more', async () => {
    const coupons = new FixedFeeSaver(COUPON, 3);
    const d = door({ rankBps: async () => 25, coupons });
    const intent = sell();
    const preview = await d.preview(principal, owner, intent);
    expect(preview.value.feeDiscount).toEqual({ source: 'coupon', bps: 5000, code: 'TEST-SAVER', voucherId: COUPON.voucherId });
    // A preview names the coupon and takes nothing.
    expect(coupons.calls.map((c) => c.mode)).toEqual(['quote']);
    const first = await d.prepare(principal, { owner, signer, intent });
    expect(first.prepared.builderFee).toEqual({ builder: BUILDER.address, feeBps: a('0.2') });
    expect(coupons.calls.filter((c) => c.mode === 'take')).toEqual([{ userId: USER, orderKey: intent.clientOrderKey, mode: 'take' }]);
    const again = await d.prepare(principal, { owner, signer, intent });
    expect(again).toMatchObject({ reused: true, prepared: { digest: first.prepared.digest } });
    expect(coupons.calls.filter((c) => c.mode === 'take')).toHaveLength(1);
    expect(coupons.usesLeft).toBe(2);
  });

  it('a rank discount that beats the coupon wins, and the coupon is left for another order', async () => {
    const coupons = new FixedFeeSaver(COUPON, 1);
    const d = door({ rankBps: async () => 6000, coupons });
    const prepared = await d.prepare(principal, { owner, signer, intent: sell() });
    expect(prepared.prepared.builderFee?.feeBps).toBe(a('0.2')); // 0.5 × 0.4
    expect(coupons.calls.map((c) => c.mode)).toEqual(['quote']);
    expect(coupons.usesLeft).toBe(1);
  });

  it('svc-campaigns down: the order carries the normal builder fee in force, and the skipped discount is logged', async () => {
    const skipped: string[] = [];
    const down = new FixedFeeSaver(undefined);
    const d = door({ rankBps: async () => 25, coupons: down, skipped: (what) => skipped.push(what) });
    expect((await d.prepare(principal, { owner, signer, intent: sell() })).prepared.builderFee?.feeBps).toBe(a('0.5'));
    const preview = await d.preview(principal, owner, sell());
    expect(preview.value.feeDiscount).toBeNull();
    expect(skipped).toEqual(['coupon', 'coupon']);
    // The rank unreadable with svc-campaigns up and no coupon: the fee in force too, with the rank's skip logged.
    const none = door({ rankBps: async () => null, coupons: new FixedFeeSaver(null), skipped: (what) => skipped.push(what) });
    expect((await none.prepare(principal, { owner, signer, intent: sell() })).prepared.builderFee?.feeBps).toBe(a('0.5'));
    expect(skipped).toEqual(['coupon', 'coupon', 'rank']);
    // Nothing wired at all: the builder fee in force.
    expect((await door(undefined).prepare(principal, { owner, signer, intent: sell() })).prepared.builderFee?.feeBps).toBe(a('0.5'));
  });

  it('the coupon runs out during an order: that order keeps the fee it was signed with; the next carries the rank rate', async () => {
    const coupons = new FixedFeeSaver(COUPON, 1);
    const d = door({ rankBps: async () => 25, coupons });
    const resting = sell();
    const firstOrder = await d.prepare(principal, { owner, signer, intent: resting });
    expect(firstOrder.prepared.builderFee?.feeBps).toBe(a('0.2'));
    expect((await d.submit(principal, firstOrder.actionKey, await sign(firstOrder.prepared))).outcome).toMatchObject({ accepted: true });
    expect(coupons.usesLeft).toBe(0);
    const next = await d.prepare(principal, { owner, signer, intent: sell() });
    expect(next.prepared.builderFee?.feeBps).toBe(a('0.4'));
    // The resting order, asked again under its key, is the stored one at its own rate.
    const replay = await d.prepare(principal, { owner, signer, intent: resting });
    expect(replay).toMatchObject({ reused: true, signed: true, prepared: { builderFee: { feeBps: a('0.2') } } });
  });

  it('the venue charges the discounted builder fee on the fill, and its own fee unchanged', async () => {
    const coupons = new FixedFeeSaver(COUPON, 1);
    const d = door({ rankBps: async () => 25, coupons });
    // A sell into the TEST bids fills now.
    const filled = await d.prepare(principal, { owner, signer, intent: sell({ price: a('50000'), timeInForce: 'IOC' }) });
    expect((await d.submit(principal, filled.actionKey, await sign(filled.prepared))).outcome).toMatchObject({ accepted: true });
    const venue = await d.venue();
    const account = await d.account(owner);
    const fills = (await venue.fills(account, new Date(0))).value.filter(
      (f) => f.venueClientOrderId === filled.prepared.venueClientOrderId,
    );
    expect(fills.length).toBeGreaterThan(0);
    // 0.2 bps of each fill's quote notional: half our 0.5 bp, floored to a tenth.
    const owed = fills.reduce((s, f) => add(s, div(mul(mul(f.price, f.amount), a('0.2')), a('10000'))), 0n);
    expect(fills.reduce((s, f) => s + f.builderFee, 0n)).toBe(owed);
    expect(fills.every((f) => f.venueFee > 0n)).toBe(true);
  });
});
