import type http from 'node:http';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { BankCashLeg } from '@intafaced/contracts/bank-cash-leg-procedures';
import { formatAmount, mul, parseAmount } from '@intafaced/ledger-client/money';
import type { PreparedVenueAction, UserVenueAccount } from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import type { CashLegPort } from '../convert/cash-leg-client.js';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { MemoryConvertQuoteStore, VenueConverts, cashLegKey, presentConversion, presentConvertQuote } from './venue-convert.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

/**
 * J-cex-spot-11 #11: a cash currency converts to a coin as two linked legs shown as one record, where the partner offers
 * the cash leg; otherwise it is refused by name. The partner (svc-bank) is a fake port that pays the coin into the TEST venue
 * once per key, as the TEST partner does. Money invariants: one accepted quote is one cash leg and one venue order however
 * often it is accepted; a price past its window takes nothing; the venue order never spends more coin than the leg paid.
 */
const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111c1';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333c1',
  scopes: ['trade:read', 'trade:write'],
  tier: 'full',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade J-cex-spot-11 #11')));
const owner = key.address.toLowerCase();
const FWD = { 'x-intafaced-principal': 'p', 'x-intafaced-signature': 's' };

let server: http.Server;
let sim: TestVenueSimulator;
let url: string;
let account: UserVenueAccount;

beforeAll(async () => {
  ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
  const { seedTestVenue } = await import('@intafaced/venue-sim');
  await seedTestVenue(sim);
  account = { venueId: sim.venue.id, owner, subAccount: null };
});
afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

/** The partner as svc-bank answers for it: 100 TEST EUR held, 1.08 USDC a euro, paid into the venue once per key. */
function partner(opts: { offered?: boolean; loseNext?: number; dropNext?: number; unreadable?: boolean } = {}) {
  const legs = new Map<string, BankCashLeg>();
  const asked: string[] = [];
  let held = a('100');
  let lose = opts.loseNext ?? 0;
  let drop = opts.dropNext ?? 0;
  const port: CashLegPort = {
    async offers(forwarded) {
      expect(forwarded).toEqual(FWD);
      return opts.offered === false
        ? { offers: [], reason: 'the partner has switched cash through a coin off for this person' }
        : { offers: [{ cash: 'EUR', coin: 'USDC', rate: a('1.08'), available: held, label: 'TEST partner bank', test: true }], reason: '' };
    },
    async carry(forwarded, ask) {
      expect(forwarded).toEqual(FWD);
      asked.push(ask.legKey);
      // A request lost before the partner recorded it: nothing moved and nothing is held under the key.
      if (drop > 0) {
        drop -= 1;
        return { state: 'unknown' };
      }
      let leg = legs.get(ask.legKey);
      if (!leg) {
        const spend = a(ask.spend);
        if (spend > held) return { state: 'refused', code: 'bank.partner_insufficient_funds', message: 'not enough' };
        held -= spend;
        const delivered = (mul(spend, a('1.08'), 'floor') / 10n ** 12n) * 10n ** 12n;
        sim.deposit({ venueId: ask.venue.venueId, owner: ask.venue.owner, subAccount: null }, ask.coin, delivered, `84532:${ask.legKey}:0`);
        leg = {
          legKey: ask.legKey,
          cash: ask.cash,
          coin: ask.coin,
          paid: ask.spend,
          delivered: formatAmount(delivered),
          rate: '1.08',
          venue: ask.venue,
          state: 'delivered',
          moveId: `move-${legs.size + 1}`,
          movedAt: new Date().toISOString(),
          deliveredAt: new Date().toISOString(),
          label: 'TEST partner bank',
          test: true,
        };
        legs.set(ask.legKey, leg);
      }
      if (lose > 0) {
        lose -= 1;
        return { state: 'unknown' };
      }
      return { state: 'carried', leg };
    },
    async leg(_forwarded, k) {
      if (opts.unreadable) return 'unread';
      return legs.get(k) ?? null;
    },
  };
  return { port, legs, asked, held: () => held };
}

function desk(cashLeg: CashLegPort, opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  const door = new UserVenueDoor({
    connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
    appEnv: 'test',
    store: new InMemoryPreparedActionStore(),
    stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
    builder: { address: '0x00000000000000000000000000000000000000c1', feeBps: a('1') },
    slippageCapBps: 50,
    spreadLimitBps: 100,
    now,
    listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC'])),
  });
  const converts = new VenueConverts({
    store: new MemoryConvertQuoteStore(),
    now,
    enabled: true,
    windowMs: 15_000,
    slippageCapBps: 50,
    cashLeg,
  }).forPerson(FWD);
  return { door, converts };
}

let n = 0;
const nextKey = () => `cash-key-${String(++n).padStart(4, '0')}`;
const usdc = async () => (await sim.balances(account)).value.find((b) => b.asset === 'USDC')?.total ?? 0n;

describe('venue Convert: cash through a coin (#11)', () => {
  it('where the partner offers it: EUR is listed, priced as two legs, and converts once as one record', async () => {
    const p = partner();
    const { door, converts } = desk(p.port);
    const pairs = await converts.pairs(door);
    expect(pairs.cash.map((c) => c.cash)).toEqual(['EUR']);
    expect(pairs.cashReason).toBeNull();
    const route = await converts.route(door, 'EUR', 'BTC');
    expect(route).toMatchObject({ side: 'buy', cash: { cash: 'EUR', coin: 'USDC' } });

    const q = await converts.quote(door, principal, { owner, from: 'EUR', to: 'BTC', amount: a('20'), quoteKey: nextKey() });
    expect(q.cashLeg).toMatchObject({ asset: 'EUR', coin: 'USDC', coinSpend: a('21.6'), acceptedAt: null });
    expect(q).toMatchObject({ from: 'EUR', to: 'BTC', spend: a('20'), side: 'buy' });
    // The venue order never spends more coin than the cash leg pays.
    expect(mul(q.size, q.limitPrice, 'ceil')).toBeLessThanOrEqual(a('21.6'));
    expect(presentConvertQuote(q).cashLeg).toMatchObject({ cash: 'EUR', coin: 'USDC', coinSpend: '21.6' });
    // A quote holds nothing: the partner was not asked to carry anything.
    expect(p.asked).toEqual([]);
    const before = await usdc();

    const [first, second] = await Promise.all([
      converts.accept(door, principal, { owner, quoteId: q.quoteId }),
      converts.accept(door, principal, { owner, quoteId: q.quoteId }),
    ]);
    expect(first.actionKey).toBe(second.actionKey);
    expect(first.cashLeg).toMatchObject({ state: 'delivered', paid: '20', delivered: '21.6' });
    expect(p.legs.size).toBe(1);
    expect(p.held()).toBe(a('80'));
    expect(await usdc()).toBe(before + a('21.6'));

    const signature = await sign(first.prepared);
    expect((await converts.submit(door, principal, { actionKey: first.actionKey, signature })).outcome).toMatchObject({ accepted: true });
    const again = await converts.accept(door, principal, { owner, quoteId: q.quoteId });
    expect(again.actionKey).toBe(first.actionKey);
    expect(p.legs.size).toBe(1);

    const history = await converts.history(door, principal, owner);
    const mine = history.conversions.filter((c) => c.quoteId === q.quoteId);
    expect(mine).toHaveLength(1);
    const shown = presentConversion(mine[0]!);
    expect(shown).toMatchObject({ from: 'EUR', to: 'BTC', state: 'filled', paid: { asset: 'EUR', amount: '20' } });
    expect(shown.legs?.cash).toMatchObject({ legKey: cashLegKey(owner, q.quoteId), cash: 'EUR', coin: 'USDC', delivered: '21.6' });
    expect(shown.legs?.venue).toMatchObject({ state: 'filled', paid: { asset: 'USDC' }, received: { asset: 'BTC' } });
    expect(a(shown.received.amount)).toBeGreaterThan(0n);
  });

  it('a lost answer on accept: Check again carries under the same key, once', async () => {
    const p = partner({ loseNext: 1 });
    const { door, converts } = desk(p.port);
    const q = await converts.quote(door, principal, { owner, from: 'EUR', to: 'BTC', amount: a('10'), quoteKey: nextKey() });
    await expect(converts.accept(door, principal, { owner, quoteId: q.quoteId })).rejects.toMatchObject({
      code: 'trade.convert_cash_leg_unknown',
    });
    // Listed already, as one record with its cash leg, before its venue order is signed.
    const listed = (await converts.history(door, principal, owner)).conversions.filter((c) => c.quoteId === q.quoteId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.venueLeg).toBeNull();
    const done = await converts.accept(door, principal, { owner, quoteId: q.quoteId });
    expect(done.cashLeg?.paid).toBe('10');
    expect(p.asked).toEqual([cashLegKey(owner, q.quoteId), cashLegKey(owner, q.quoteId)]);
    expect(p.legs.size).toBe(1);
    expect(p.held()).toBe(a('90'));
  });

  it('past the window, a carried cash leg is read back, never carried again, and named in the refusal', async () => {
    const p = partner({ loseNext: 1 });
    let t = Date.now();
    const { door, converts } = desk(p.port, { now: () => new Date(t) });
    const q = await converts.quote(door, principal, { owner, from: 'EUR', to: 'BTC', amount: a('10'), quoteKey: nextKey() });
    const input = { owner, quoteId: q.quoteId };
    await expect(converts.accept(door, principal, input)).rejects.toMatchObject({ code: 'trade.convert_cash_leg_unknown' });
    expect(p.held()).toBe(a('90'));
    const coin = await usdc();
    t = q.freshUntil.getTime() + 1;
    const late = converts.accept(door, principal, input);
    await expect(late).rejects.toMatchObject({ code: 'trade.convert_quote_expired' });
    await expect(late).rejects.toThrow(/cash leg was carried: 10 EUR became 10\.8 USDC/);
    // Read back, not carried: the partner was asked to carry once, inside the window.
    expect(p.asked).toEqual([cashLegKey(owner, q.quoteId)]);
    expect(p.legs.size).toBe(1);
    expect(p.held()).toBe(a('90'));
    expect(await usdc()).toBe(coin);
  });

  it('past the window, a cash leg the partner never recorded asks the partner for nothing', async () => {
    const p = partner({ dropNext: 1 });
    let t = Date.now();
    const { door, converts } = desk(p.port, { now: () => new Date(t) });
    const q = await converts.quote(door, principal, { owner, from: 'EUR', to: 'BTC', amount: a('10'), quoteKey: nextKey() });
    const input = { owner, quoteId: q.quoteId };
    await expect(converts.accept(door, principal, input)).rejects.toMatchObject({ code: 'trade.convert_cash_leg_unknown' });
    expect(p.legs.size).toBe(0);
    const coin = await usdc();
    t = q.freshUntil.getTime() + 1;
    const late = converts.accept(door, principal, input);
    await expect(late).rejects.toMatchObject({ code: 'trade.convert_quote_expired' });
    await expect(late).rejects.toThrow(/Nothing was signed or sent/);
    expect(p.asked).toEqual([cashLegKey(owner, q.quoteId)]);
    expect(p.legs.size).toBe(0);
    expect(p.held()).toBe(a('100'));
    expect(await usdc()).toBe(coin);
  });

  it('past the window, a cash leg the partner cannot read is unknown, and nothing is carried', async () => {
    const p = partner({ loseNext: 1, unreadable: true });
    let t = Date.now();
    const { door, converts } = desk(p.port, { now: () => new Date(t) });
    const q = await converts.quote(door, principal, { owner, from: 'EUR', to: 'BTC', amount: a('10'), quoteKey: nextKey() });
    const input = { owner, quoteId: q.quoteId };
    await expect(converts.accept(door, principal, input)).rejects.toMatchObject({ code: 'trade.convert_cash_leg_unknown' });
    t = q.freshUntil.getTime() + 1;
    await expect(converts.accept(door, principal, input)).rejects.toMatchObject({ code: 'trade.convert_cash_leg_unknown' });
    expect(p.asked).toEqual([cashLegKey(owner, q.quoteId)]);
    expect(p.legs.size).toBe(1);
    expect(p.held()).toBe(a('90'));
  });

  it('a price past its window asks the partner for nothing', async () => {
    const p = partner();
    let t = Date.now();
    const { door, converts } = desk(p.port, { now: () => new Date(t) });
    const q = await converts.quote(door, principal, { owner, from: 'EUR', to: 'BTC', amount: a('10'), quoteKey: nextKey() });
    t += 16_000;
    await expect(converts.accept(door, principal, { owner, quoteId: q.quoteId })).rejects.toMatchObject({
      code: 'trade.convert_quote_expired',
    });
    expect(p.asked).toEqual([]);
    expect(p.held()).toBe(a('100'));
  });

  it('more cash than the partner holds is refused before any price', async () => {
    const p = partner();
    const { door, converts } = desk(p.port);
    await expect(
      converts.quote(door, principal, { owner, from: 'EUR', to: 'BTC', amount: a('101'), quoteKey: nextKey() }),
    ).rejects.toMatchObject({ code: 'trade.convert_cash_not_enough' });
  });

  it('otherwise the screen says it is not offered: no partner cash leg, the reverse way, or no bank at all', async () => {
    const off = partner({ offered: false });
    const { door, converts } = desk(off.port);
    expect((await converts.pairs(door)).cash).toEqual([]);
    expect((await converts.pairs(door)).cashReason).toMatch(/switched cash through a coin off/);
    await expect(converts.route(door, 'EUR', 'BTC')).rejects.toMatchObject({ code: 'trade.convert_cash_not_offered' });
    const on = desk(partner().port);
    await expect(on.converts.route(on.door, 'BTC', 'EUR')).rejects.toMatchObject({ code: 'trade.convert_cash_not_offered' });
    const none = new VenueConverts({
      store: new MemoryConvertQuoteStore(),
      now: () => new Date(),
      enabled: true,
      windowMs: 1,
      slippageCapBps: 50,
    });
    await expect(none.route(door, 'EUR', 'BTC')).rejects.toMatchObject({ code: 'trade.convert_cash_not_offered' });
    expect(off.asked).toEqual([]);
  });
});
