import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import {
  cancelsTakenTogether,
  venueClientOrderId,
  type PlaceUserOrderIntent,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';
import { TestVenueSimulator } from './simulator.js';

// J-cex-spot-05 at the venue: a resting order lowered in place, replaced at a new price in one signed action, and
// several cancelled in one signed action, each answered from the venue's own record. Every figure is TEST.

const a = parseAmount;
const BTC = 'BTC-USDC';
const ETH = 'ETH-USDC';

function world(opts: { amendsInPlace?: boolean; cancelsPerAction?: number } = { amendsInPlace: true, cancelsPerAction: 20 }) {
  let now = Date.UTC(2026, 10, 16, 8, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date((now += 1000)), markets: TEST_VENUE_MARKETS, chainId: 84532, ...opts });
  const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet order-change trader')));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const signer = { role: 'owner' as const, address: owner };
  const sign = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, signer, intent);
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    return { prepared, signature: { digest: prepared.digest, signature, signedBy: owner } };
  };
  const run = async (intent: VenueIntent) => {
    const { prepared, signature } = await sign(intent);
    return sim.submit(prepared, signature);
  };
  sim.deposit(account, 'USDC', a('10000'), 'chain:order-change:d1');
  return { sim, account, sign, run };
}

const buy = (key: string, over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: BTC,
  side: 'buy',
  type: 'limit',
  amount: a('0.002'),
  price: a('50000'),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: `order:order-change:${key}`,
  builderFee: null,
  ...over,
});

type W = ReturnType<typeof world>;
const cloid = (w: W, key: string) => venueClientOrderId(w.sim.venue.id, `order:order-change:${key}`);
const byId = async (w: W, id: string) => (await w.sim.orderByClientId(w.account, id)).value;
const usdc = async (w: W) => (await w.sim.balances(w.account)).value.find((b) => b.asset === 'USDC')!;
const refusalOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    return (error as { refusal?: { code: string } }).refusal?.code;
  }
  return 'none';
};

describe('TEST venue simulator: changing and cancelling resting orders (J-cex-spot-05)', () => {
  it('declares an amend in place and a batch size only when started with them', () => {
    expect(world().sim.venue.amendsInPlace).toBe(true);
    expect(cancelsTakenTogether(world().sim.venue)).toBe(20);
    const plain = world({});
    expect(plain.sim.venue.amendsInPlace).toBeUndefined();
    expect(cancelsTakenTogether(plain.sim.venue)).toBe(0);
  });

  it('switched off, declares no amend in place and refuses one; switched on again, amends', async () => {
    const w = world();
    await w.run(buy('a'));
    const lower = { kind: 'amend_order' as const, symbol: BTC, venueClientOrderId: cloid(w, 'a'), amount: a('0.001'), price: a('50000') };
    w.sim.declareAmendsInPlace(false);
    expect(w.sim.venue.amendsInPlace).toBeUndefined();
    expect(cancelsTakenTogether(w.sim.venue)).toBe(20);
    expect(await refusalOf(w.run(lower))).toBe('not_offered');
    w.sim.declareAmendsInPlace(true);
    expect(await w.run(lower)).toMatchObject({ accepted: true, order: { remaining: a('0.001') } });
  });

  it('declares a batch size for cancels only while switched on, and refuses a batch once switched off', async () => {
    const w = world({});
    await w.run(buy('a'));
    const batch = { kind: 'cancel_orders' as const, orders: [{ symbol: BTC, venueClientOrderId: cloid(w, 'a') }] };
    expect(await refusalOf(w.run(batch))).toBe('not_offered');
    w.sim.declareCancelsPerAction(20);
    expect(cancelsTakenTogether(w.sim.venue)).toBe(20);
    expect(await w.run(batch)).toMatchObject({ accepted: true, legs: [{ accepted: true }] });
    w.sim.declareCancelsPerAction(null);
    expect(cancelsTakenTogether(w.sim.venue)).toBe(0);
    expect(w.sim.venue.cancelsPerAction).toBeUndefined();
  });

  it('lowers the amount in place: the same order and price, its place kept, its lock cut, and the cut freed', async () => {
    const w = world();
    await w.run(buy('a'));
    await w.run(buy('b'));
    const before = (await byId(w, cloid(w, 'a')))!;
    expect(before.locked).toBe(a('100'));
    const answer = await w.run({
      kind: 'amend_order',
      symbol: BTC,
      venueClientOrderId: cloid(w, 'a'),
      amount: a('0.001'),
      price: a('50000'),
    });
    expect(answer).toMatchObject({ accepted: true, order: { venueOrderId: before.venueOrderId, remaining: a('0.001') } });
    const after = (await byId(w, cloid(w, 'a')))!;
    expect(after).toMatchObject({ venueOrderId: before.venueOrderId, price: before.price, remaining: a('0.001'), locked: a('50') });
    // Still first at its price: the open orders list it before the order placed after it.
    const open = (await w.sim.openOrders(w.account)).value.map((o) => o.venueClientOrderId);
    expect(open.indexOf(cloid(w, 'a'))).toBeLessThan(open.indexOf(cloid(w, 'b')));
    expect(await usdc(w)).toMatchObject({ locked: a('150'), free: a('9850') });
  });

  it('refuses an amend that raises the amount, changes the price, or that the venue does not offer; nothing moves', async () => {
    const w = world();
    await w.run(buy('a'));
    const raise = w.sim.prepare(
      w.account,
      { role: 'owner', address: w.account.owner },
      {
        kind: 'amend_order',
        symbol: BTC,
        venueClientOrderId: cloid(w, 'a'),
        amount: a('0.003'),
        price: a('50000'),
      },
    );
    expect(await refusalOf(raise)).toBe('not_offered');
    const price = w.run({ kind: 'amend_order', symbol: BTC, venueClientOrderId: cloid(w, 'a'), amount: a('0.001'), price: a('49000') });
    expect(await refusalOf(price)).toBe('not_offered');
    const plain = world({});
    await plain.run(buy('a'));
    const off = plain.run({
      kind: 'amend_order',
      symbol: BTC,
      venueClientOrderId: cloid(plain, 'a'),
      amount: a('0.001'),
      price: a('50000'),
    });
    expect(await refusalOf(off)).toBe('not_offered');
    expect((await byId(w, cloid(w, 'a')))!).toMatchObject({ remaining: a('0.002'), locked: a('100') });
    expect(await usdc(w)).toMatchObject({ locked: a('100') });
  });

  it('replaces at a new price in one signed action: the original cancelled once, the replacement under its own id; sent again, the same', async () => {
    const w = world();
    await w.run(buy('a'));
    const intent: VenueIntent = {
      kind: 'replace_order',
      symbol: BTC,
      venueClientOrderId: cloid(w, 'a'),
      order: buy('a2', { amount: a('0.002'), price: a('49000') }),
    };
    const { prepared, signature } = await w.sign(intent);
    expect(prepared.venueClientOrderId).toBe(cloid(w, 'a2'));
    const first = await w.sim.submit(prepared, signature);
    expect(first).toMatchObject({
      accepted: true,
      legs: [
        { accepted: true, order: { venueClientOrderId: cloid(w, 'a'), status: 'canceled', locked: 0n } },
        { accepted: true, order: { venueClientOrderId: cloid(w, 'a2'), status: 'open', price: a('49000'), locked: a('98') } },
      ],
    });
    expect(await w.sim.submit(prepared, signature)).toEqual(first);
    expect(await usdc(w)).toMatchObject({ locked: a('98'), free: a('9902') });
    expect((await w.sim.openOrders(w.account)).value.map((o) => o.venueClientOrderId)).toEqual([cloid(w, 'a2')]);
  });

  it('a refused replacement leaves the original cancelled and says so; an original no longer resting places nothing', async () => {
    const w = world();
    await w.run(buy('a'));
    const tooBig = await w.run({
      kind: 'replace_order',
      symbol: BTC,
      venueClientOrderId: cloid(w, 'a'),
      order: buy('big', { amount: a('1') }),
    });
    expect(tooBig).toMatchObject({
      accepted: true,
      legs: [
        { accepted: true, order: { status: 'canceled' } },
        { accepted: false, refusal: { code: 'insufficient_balance' } },
      ],
    });
    expect(await usdc(w)).toMatchObject({ locked: 0n, free: a('10000') });
    const again = await w.run({ kind: 'replace_order', symbol: BTC, venueClientOrderId: cloid(w, 'gone'), order: buy('gone2') });
    expect(again).toMatchObject({ accepted: false, refusal: { code: 'unknown_order' } });
    expect(await byId(w, cloid(w, 'gone2'))).toBeNull();
  });

  it('cancels a batch in one signed action: each answered, an unknown id reported, the rest cancelled and their locks freed', async () => {
    const w = world();
    await w.run(buy('a'));
    await w.run(buy('e', { symbol: ETH, price: a('2000'), amount: a('0.01') }));
    const answer = await w.run({
      kind: 'cancel_orders',
      orders: [
        { symbol: BTC, venueClientOrderId: cloid(w, 'a') },
        { symbol: BTC, venueClientOrderId: '0xnot-an-order' },
        { symbol: ETH, venueClientOrderId: cloid(w, 'e') },
      ],
    });
    expect(answer).toMatchObject({
      accepted: true,
      legs: [
        { accepted: true, order: { status: 'canceled' } },
        { accepted: false, refusal: { code: 'unknown_order' } },
        { accepted: true },
      ],
    });
    expect(await usdc(w)).toMatchObject({ locked: 0n, free: a('10000') });
    const plain = world({});
    expect(await refusalOf(plain.run({ kind: 'cancel_orders', orders: [{ symbol: BTC, venueClientOrderId: '0x1' }] }))).toBe('not_offered');
  });
});
