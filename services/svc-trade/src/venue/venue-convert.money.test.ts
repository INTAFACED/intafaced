import type http from 'node:http';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { MemoryLedger, houseFees, parseAmount } from '@intafaced/ledger-client';
import { mul } from '@intafaced/ledger-client/money';
import { encodeVenueWire, type PreparedVenueAction, type UserVenueAccount } from '@intafaced/venue-contracts';
import { answerTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { postBuilderFees } from '../builder-fee/builder-fee-poster.js';
import { InMemoryBuilderFeeStore } from '../builder-fee/builder-fee-store.js';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, type BuilderFeeValue } from './user-venue-door.js';
import { MemoryConvertQuoteStore, VenueConverts, cashLegKey, convertKey, presentConvertQuote } from './venue-convert.js';
import { MemoryCashLegStore, TestCashPartner, cashPartnerFor, type CashPartner } from './cash-partner.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

/**
 * J-cex-spot-11 on the launch money model: a conversion is one venue order the person's wallet signs. Against the TEST
 * venue simulator over loopback HTTP, the door's in-memory action store and the in-memory ledger. TEST amounts only.
 */
const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111e1';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333e1',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade J-cex-spot-11')));
const owner = key.address.toLowerCase();
const BUILDER: BuilderFeeValue = { address: '0x00000000000000000000000000000000000000e1', feeBps: a('1') };
const WINDOW_MS = 15_000;

async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

let server: http.Server;
let sim: TestVenueSimulator;
let url: string;
let account: UserVenueAccount;
const start = new Date(Date.now() - 60_000);

beforeAll(async () => {
  ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
  const { seedTestVenue } = await import('@intafaced/venue-sim');
  await seedTestVenue(sim);
  account = { venueId: sim.venue.id, owner, subAccount: null };
  sim.deposit(account, 'USDC', a('100000'), 'deposit:test:convert-usdc');
  sim.deposit(account, 'BTC', a('1'), 'deposit:test:convert-btc');
});
afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

function desk(
  opts: {
    now?: () => Date;
    windowMs?: number | null;
    enabled?: boolean;
    cashPartner?: CashPartner | null;
    quotes?: MemoryConvertQuoteStore;
  } = {},
) {
  const now = opts.now ?? (() => new Date());
  const actions = new InMemoryPreparedActionStore();
  const door = new UserVenueDoor({
    connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
    appEnv: 'test',
    store: actions,
    stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
    builder: BUILDER,
    slippageCapBps: 50,
    spreadLimitBps: 100,
    now,
    listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC'])),
  });
  const quotes = opts.quotes ?? new MemoryConvertQuoteStore();
  const converts = new VenueConverts({
    store: quotes,
    now,
    enabled: opts.enabled ?? true,
    windowMs: opts.windowMs === undefined ? WINDOW_MS : opts.windowMs,
    slippageCapBps: 50,
    cashPartner: opts.cashPartner ?? null,
  });
  return { door, converts, actions, quotes };
}

const openOrders = async () => (await sim.openOrders(account)).value;
const ordersWithId = async (cloid: string) => (await sim.orderByClientId(account, cloid)).value;
const fillsOf = async (cloid: string) => (await sim.fills(account, start)).value.filter((f) => f.venueClientOrderId === cloid);
const switches = async (body: Record<string, unknown>) => {
  const [status] = await answerTestVenue(sim, 'POST', '/test/account-switches', JSON.stringify(encodeVenueWire({ owner, ...body })));
  expect(status).toBe(200);
};

let n = 0;
const nextKey = () => `quote-key-${String(++n).padStart(4, '0')}`;

describe('venue Convert: a quote holds nothing', () => {
  it('prices a buy from the venue best ask inside the slippage cap, never costing more than the spend; nothing is sent or locked', async () => {
    const { door, converts } = desk();
    const before = (await sim.balances(account)).value;
    const q = await converts.quote(door, principal, { owner, from: 'USDC', to: 'BTC', amount: a('100'), quoteKey: nextKey() });
    const best = (await sim.bestPrices('BTC-USDC')).value.ask!;
    expect(q).toMatchObject({ side: 'buy', market: 'BTC-USDC', from: 'USDC', to: 'BTC', builderFee: { kind: 'none', reason: 'buy' } });
    expect(q.bestPrice.price).toBe(best);
    // 50 bps over the best ask, rounded up to the tick: the worst price the IOC order fills at.
    expect(q.limitPrice).toBeGreaterThan(best);
    expect(q.limitPrice).toBeLessThanOrEqual(
      (best * 10_050n) / 10_000n + (await sim.markets(null)).value.find((m) => m.symbol === 'BTC-USDC')!.tickSize,
    );
    expect(mul(q.size, q.limitPrice, 'ceil')).toBeLessThanOrEqual(a('100'));
    expect(q.venueFee.known).toBe(true);
    expect(presentConvertQuote(q)).toMatchObject({ held: false, test: true });
    expect(await openOrders()).toEqual([]);
    expect((await sim.balances(account)).value).toEqual(before);
  });

  it('a sell carries our builder fee in the quote asset, as the venue previews it', async () => {
    const { door, converts } = desk();
    const q = await converts.quote(door, principal, { owner, from: 'BTC', to: 'USDC', amount: a('0.01'), quoteKey: nextKey() });
    expect(q.side).toBe('sell');
    expect(q.builderFee).toMatchObject({ kind: 'quote_asset', bps: a('1') });
  });

  it('refuses a paused Convert, a blank window and a blank slippage cap by name, storing nothing', async () => {
    const ask = { owner, from: 'USDC', to: 'BTC', amount: a('100'), quoteKey: nextKey() };
    const paused = desk({ enabled: false });
    await expect(paused.converts.quote(paused.door, principal, ask)).rejects.toMatchObject({ code: 'trade.convert_disabled' });
    const blank = desk({ windowMs: null });
    await expect(blank.converts.quote(blank.door, principal, ask)).rejects.toMatchObject({ code: 'trade.convert_window_unset' });
    const noCap = desk();
    const capless = new VenueConverts({
      store: new MemoryConvertQuoteStore(),
      now: () => new Date(),
      enabled: true,
      windowMs: 1,
      slippageCapBps: null,
      cashPartner: null,
    });
    await expect(capless.quote(noCap.door, principal, ask)).rejects.toMatchObject({ code: 'trade.slippage_cap_unset' });
  });

  it('a cash currency is not offered and an unjoined pair is unlisted; nothing is priced', async () => {
    const { door, converts } = desk();
    await expect(converts.route(door, 'EUR', 'BTC')).rejects.toMatchObject({ code: 'trade.convert_cash_not_offered' });
    await expect(converts.route(door, 'BTC', 'DOGE')).rejects.toMatchObject({ code: 'trade.convert_pair_unlisted' });
  });
});

describe('venue Convert: accepting signs one swap', () => {
  it('the same quote accepted twice is one prepared action, one signature and one venue order', async () => {
    const { door, converts } = desk();
    const q = await converts.quote(door, principal, { owner, from: 'USDC', to: 'BTC', amount: a('100'), quoteKey: nextKey() });
    const first = await converts.accept(door, principal, { owner, quoteId: q.quoteId });
    const second = await converts.accept(door, principal, { owner, quoteId: q.quoteId });
    expect(first.actionKey).toBe(convertKey(owner, q.quoteId));
    expect(second).toMatchObject({ actionKey: first.actionKey, reused: true });
    expect(second.prepared.digest).toBe(first.prepared.digest);
    const signature = await sign(first.prepared);
    const sent = await converts.submit(door, principal, { actionKey: first.actionKey, signature });
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
    const again = await converts.submit(door, principal, { actionKey: first.actionKey, signature });
    expect(again.replayed).toBe(true);
    const cloid = first.prepared.venueClientOrderId!;
    expect((await ordersWithId(cloid))?.status).toBe('filled');
    const fills = await fillsOf(cloid);
    expect(fills.length).toBeGreaterThan(0);
    // At the limit price or better, and never more than the spend.
    for (const f of fills) expect(f.price).toBeLessThanOrEqual(q.limitPrice);
    expect(fills.reduce((s, f) => s + mul(f.price, f.amount), 0n)).toBeLessThanOrEqual(a('100'));
    // Accepting again after it filled is still the one action, never a second order.
    const later = await converts.accept(door, principal, { owner, quoteId: q.quoteId });
    expect(later).toMatchObject({ reused: true, signed: true });
    expect(await fillsOf(cloid)).toHaveLength(fills.length);
  });

  it('a price past its window signs nothing: accept refuses, and an action prepared in time is not sent after it', async () => {
    let t = new Date();
    const { door, converts, actions } = desk({ now: () => t });
    const q = await converts.quote(door, principal, { owner, from: 'USDC', to: 'BTC', amount: a('100'), quoteKey: nextKey() });
    t = new Date(q.freshUntil.getTime() + 1);
    await expect(converts.accept(door, principal, { owner, quoteId: q.quoteId })).rejects.toMatchObject({
      code: 'trade.convert_quote_expired',
      status: 409,
    });
    expect(await actions.find(USER, convertKey(owner, q.quoteId))).toBeNull();

    t = new Date();
    const q2 = await converts.quote(door, principal, { owner, from: 'USDC', to: 'BTC', amount: a('100'), quoteKey: nextKey() });
    const prepared = await converts.accept(door, principal, { owner, quoteId: q2.quoteId });
    t = new Date(q2.freshUntil.getTime() + 1);
    await expect(
      converts.submit(door, principal, { actionKey: prepared.actionKey, signature: await sign(prepared.prepared) }),
    ).rejects.toMatchObject({
      code: 'trade.convert_quote_expired',
    });
    expect((await actions.find(USER, prepared.actionKey))?.signature).toBeNull();
    expect(await ordersWithId(prepared.prepared.venueClientOrderId!)).toBeNull();
  });

  it('a lost reply is read back by client id, and Check again cannot swap twice', async () => {
    const { door, converts } = desk();
    const q = await converts.quote(door, principal, { owner, from: 'USDC', to: 'BTC', amount: a('50'), quoteKey: nextKey() });
    const prepared = await converts.accept(door, principal, { owner, quoteId: q.quoteId });
    const signature = await sign(prepared.prepared);
    await switches({ loseAnswers: 1 });
    try {
      const sent = await converts.submit(door, principal, { actionKey: prepared.actionKey, signature });
      expect(sent.outcome.definite).toBe(false);
      expect(sent.readBack).toEqual({ venueClientOrderId: prepared.prepared.venueClientOrderId });
    } finally {
      await switches({ loseAnswers: 0 });
    }
    // Check again: the same quote accepted again is the signed action; reading by its key finds the one venue order.
    const check = await converts.accept(door, principal, { owner, quoteId: q.quoteId });
    expect(check).toMatchObject({ reused: true, signed: true });
    const read = await door.orderByKey(principal, prepared.actionKey);
    expect(read).toMatchObject({ state: 'accepted', order: { status: 'filled' } });
    const fillsBefore = (await fillsOf(prepared.prepared.venueClientOrderId!)).length;
    const resent = await converts.submit(door, principal, { actionKey: prepared.actionKey, signature });
    expect(resent.outcome).toMatchObject({ definite: true });
    expect(await fillsOf(prepared.prepared.venueClientOrderId!)).toHaveLength(fillsBefore);
    expect((await ordersWithId(prepared.prepared.venueClientOrderId!))?.filled).toBe(q.size);
  });

  it('the plain prepare and submit routes refuse a convert key, so no window is walked around', async () => {
    const { door } = desk();
    await expect(
      door.prepare(principal, {
        owner,
        signer: { role: 'owner', address: owner },
        intent: {
          kind: 'place_order',
          symbol: 'BTC-USDC',
          side: 'buy',
          type: 'limit',
          amount: a('0.001'),
          price: a('60000'),
          timeInForce: 'IOC',
          reduceOnly: false,
          clientOrderKey: convertKey(owner, 'quote-key-9999'),
          builderFee: null,
        },
      }),
    ).rejects.toMatchObject({ code: 'trade.venue_convert_only', status: 403 });
  });

  it('a limit convert rests one venue order at the target rate; placing it again is the same order', async () => {
    const { door, converts } = desk();
    const ask = { owner, from: 'USDC', to: 'BTC', amount: a('100'), price: a('30000'), limitKey: 'limit-key-0001' };
    const first = await converts.limit(door, principal, ask);
    await converts.submit(door, principal, { actionKey: first.actionKey, signature: await sign(first.prepared) });
    const again = await converts.limit(door, principal, ask);
    expect(again).toMatchObject({ actionKey: first.actionKey, reused: true, signed: true });
    const resting = (await openOrders()).filter((o) => o.venueClientOrderId === first.prepared.venueClientOrderId);
    expect(resting).toHaveLength(1);
    expect(resting[0]).toMatchObject({ price: a('30000'), timeInForce: 'GTC', status: 'open' });
    const history = await converts.history(door, principal, owner);
    expect(history.conversions.find((c) => c.actionKey === first.actionKey)).toMatchObject({ kind: 'limit', state: 'resting' });
  });
});

describe('venue Convert: the money invariant', () => {
  it('the ledger posts nothing for a buy, and a sell posts our builder fee once per fill however often the poster runs', async () => {
    const { door, converts, actions } = desk();
    const approve = await door.prepare(principal, {
      owner,
      signer: { role: 'owner', address: owner },
      intent: { kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('1') },
      actionKey: `approve-builder:${USER}:convert`,
    });
    await door.submit(principal, approve.actionKey, await sign(approve.prepared));
    const ledger = new MemoryLedger({ idempotencyConflict: 'refuse' });
    const feeStore = new InMemoryBuilderFeeStore(() => [{ userId: USER, account, since: start }]);
    const poster = () =>
      postBuilderFees({
        venue: () => door.venue(),
        ledger,
        store: feeStore,
        ourOrders: (venueId, acct, ids) => actions.sentBuilderFeeOrders(venueId, acct, ids),
        now: () => new Date(),
      });
    const convert = async (from: string, to: string, amount: string) => {
      const q = await converts.quote(door, principal, { owner, from, to, amount: a(amount), quoteKey: nextKey() });
      const p = await converts.accept(door, principal, { owner, quoteId: q.quoteId });
      await converts.submit(door, principal, { actionKey: p.actionKey, signature: await sign(p.prepared) });
      return p.prepared.venueClientOrderId!;
    };

    const bought = await convert('USDC', 'BTC', '200');
    await poster();
    await poster();
    expect((await fillsOf(bought)).every((f) => f.builderFee === 0n)).toBe(true);
    expect(ledger.journal()).toEqual([]);

    const sold = await convert('BTC', 'USDC', '0.002');
    await poster();
    await poster();
    const fills = await fillsOf(sold);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((f) => f.builderFee > 0n && f.feeAsset === 'USDC')).toBe(true);
    const earned = ledger.journal().filter((t) => t.reason === 'trade.builder_fee.earned');
    expect(earned).toHaveLength(fills.length);
    expect(ledger.journal()).toHaveLength(fills.length);
    expect((await ledger.balance(houseFees('builder', 'USDC'))).amount).toBe(fills.reduce((s, f) => s + f.builderFee, 0n));

    // Recent conversions: the two accepted conversions with the venue's paid and received amounts, newest first.
    const { conversions } = await converts.history(door, principal, owner);
    const sale = conversions.find((c) => c.venueClientOrderId === sold)!;
    expect(sale).toMatchObject({ kind: 'instant', state: 'filled', from: 'BTC', to: 'USDC' });
    expect(sale.paid).toEqual({ asset: 'BTC', amount: a('0.002') });
    const gross = fills.reduce((s, f) => s + mul(f.price, f.amount), 0n);
    const fees = fills.reduce((s, f) => s + f.venueFee + f.builderFee, 0n);
    expect(sale.received).toEqual({ asset: 'USDC', amount: gross - fees });
    expect(sale.filledAt).not.toBeNull();
  });
});

/**
 * #11 from a cash currency: two linked legs. The TEST cash partner offers EUR at a TEST 1.1 USDC per EUR and a TEST fee of
 * 1 EUR, at most 1000 EUR a leg, and delivers its USDC to the person's venue account through the TEST venue's deposit,
 * under the leg's id. Every figure is TEST.
 */
const CATALOGUE = { stable: 'USDC', currencies: { EUR: { rate: '1.1', fee: '1', max: '1000' } } };

function cashDesk(opts: { catalogue?: typeof CATALOGUE; store?: MemoryCashLegStore; failDelivery?: () => boolean } = {}) {
  const store = opts.store ?? new MemoryCashLegStore();
  const deliveries: string[] = [];
  const partner = new TestCashPartner(opts.catalogue ?? CATALOGUE, {
    store,
    now: () => new Date(),
    deliver: async (acct, asset, amount, ref) => {
      if (opts.failDelivery?.()) throw new Error('TEST delivery down');
      deliveries.push(ref);
      sim.deposit(acct, asset, amount, ref);
    },
  });
  return { ...desk({ cashPartner: partner }), partner, store, deliveries };
}

const arrivalsUnder = async (ref: string) => (await sim.arrivals(account)).value.filter((x) => x.arrivalId === ref);

describe('venue Convert from a cash currency: two linked legs where the partner offers it', () => {
  it('no partner is set by default, and the TEST partner is refused outside APP_ENV dev or test and without its catalogue', () => {
    const deps = { store: new MemoryCashLegStore(), now: () => new Date(), deliver: async () => undefined };
    const json = JSON.stringify(CATALOGUE);
    expect(cashPartnerFor('', json, 'test', deps)).toBeNull();
    for (const appEnv of ['production', 'staging', undefined])
      expect(() => cashPartnerFor('test', json, appEnv, deps)).toThrow(/refused outside/);
    expect(() => cashPartnerFor('test', '', 'test', deps)).toThrow(/catalogue/);
    expect(() => cashPartnerFor('acme', json, 'test', deps)).toThrow(/leave it blank/);
    expect(cashPartnerFor('test', json, 'dev', deps)?.offers('EUR')).toBe(true);
  });

  it('with no partner, a currency it does not offer, or toward cash, the route says not offered and nothing is priced', async () => {
    const none = desk();
    await expect(none.converts.route(none.door, 'EUR', 'BTC')).rejects.toMatchObject({ code: 'trade.convert_cash_not_offered' });
    const { door, converts } = cashDesk();
    await expect(converts.route(door, 'GBP', 'BTC')).rejects.toMatchObject({ code: 'trade.convert_cash_not_offered' });
    await expect(converts.route(door, 'BTC', 'EUR')).rejects.toMatchObject({ code: 'trade.convert_cash_not_offered' });
    await expect(converts.route(door, 'EUR', 'BTC')).resolves.toMatchObject({
      side: 'buy',
      market: { symbol: 'BTC-USDC' },
      cash: { currency: 'EUR', stable: 'USDC' },
    });
    await expect(
      converts.limit(door, principal, { owner, from: 'EUR', to: 'BTC', amount: a('100'), price: a('30000'), limitKey: 'limit-cash-01' }),
    ).rejects.toMatchObject({ code: 'trade.convert_cash_not_offered' });
  });

  it('a quote prices the cash leg at the partner and sizes the venue leg from its stablecoin; nothing is taken, delivered or sent', async () => {
    const { door, converts, partner, deliveries } = cashDesk();
    const before = (await sim.balances(account)).value;
    const q = await converts.quote(door, principal, { owner, from: 'EUR', to: 'BTC', amount: a('101'), quoteKey: nextKey() });
    expect(q.cash).toEqual({ currency: 'EUR', cash: a('101'), fee: a('1'), rate: a('1.1'), stable: 'USDC', stableAmount: a('110') });
    expect(q).toMatchObject({ from: 'EUR', to: 'BTC', side: 'buy', market: 'BTC-USDC', spend: a('101') });
    expect(mul(q.size, q.limitPrice, 'ceil')).toBeLessThanOrEqual(a('110'));
    expect(presentConvertQuote(q).cash).toMatchObject({ currency: 'EUR', stableAmount: '110' });
    expect(await partner.legOf(cashLegKey(owner, q.quoteId))).toBeNull();
    expect(deliveries).toEqual([]);
    expect((await sim.balances(account)).value).toEqual(before);
    await expect(
      converts.quote(door, principal, { owner, from: 'EUR', to: 'BTC', amount: a('1001'), quoteKey: nextKey() }),
    ).rejects.toMatchObject({ code: 'trade.convert_cash_leg_refused' });
  });

  it('accepting settles one cash leg and one venue order per key under retry and at the same moment; one record; the ledger posts nothing', async () => {
    const { door, converts, actions, partner, deliveries } = cashDesk();
    const q = await converts.quote(door, principal, { owner, from: 'EUR', to: 'BTC', amount: a('56'), quoteKey: nextKey() });
    const p = await converts.accept(door, principal, { owner, quoteId: q.quoteId });
    expect((await converts.accept(door, principal, { owner, quoteId: q.quoteId })).actionKey).toBe(p.actionKey);
    const signature = await sign(p.prepared);
    const [x, y] = await Promise.allSettled([
      converts.submit(door, principal, { actionKey: p.actionKey, signature }),
      converts.submit(door, principal, { actionKey: p.actionKey, signature }),
    ]);
    const answered = [x, y].filter((r) => r.status === 'fulfilled');
    expect(answered.length).toBeGreaterThan(0);
    for (const r of [x, y]) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'idempotency.in_progress' });
    const again = await converts.submit(door, principal, { actionKey: p.actionKey, signature });
    expect(again.outcome).toMatchObject({ definite: true, accepted: true });

    // The partner's own record: one leg under the business key, settled, its USDC credited once under its id.
    const leg = (await partner.legOf(cashLegKey(owner, q.quoteId)))!;
    expect(leg).toMatchObject({ state: 'settled', currency: 'EUR', cash: a('56'), stable: 'USDC', stableAmount: a('60.5') });
    expect(new Set(deliveries)).toEqual(new Set([leg.legId]));
    expect(await arrivalsUnder(leg.legId)).toHaveLength(1);
    expect((await arrivalsUnder(leg.legId))[0]).toMatchObject({ asset: 'USDC', amount: a('60.5') });
    // The venue's own record: one order under the client id, filled for the quote's size.
    const cloid = p.prepared.venueClientOrderId!;
    expect((await ordersWithId(cloid))?.status).toBe('filled');
    expect((await sim.orderHistory(account)).value.filter((r) => r.order.venueClientOrderId === cloid)).toHaveLength(1);
    const fills = await fillsOf(cloid);
    expect(fills.reduce((s, f) => s + f.amount, 0n)).toBe(q.size);

    // One record with both legs.
    const record = (await converts.history(door, principal, owner)).conversions.filter((c) => c.quoteId === q.quoteId);
    expect(record).toHaveLength(1);
    expect(record[0]).toMatchObject({
      state: 'filled',
      from: 'USDC',
      to: 'BTC',
      venueClientOrderId: cloid,
      cashLeg: { key: cashLegKey(owner, q.quoteId), legId: leg.legId, state: 'settled', currency: 'EUR', cash: a('56') },
    });

    // The ledger posts nothing for either leg: the builder-fee poster over the account finds nothing to post.
    const ledger = new MemoryLedger({ idempotencyConflict: 'refuse' });
    const feeStore = new InMemoryBuilderFeeStore(() => [{ userId: USER, account, since: start }]);
    await postBuilderFees({
      venue: () => door.venue(),
      ledger,
      store: feeStore,
      ourOrders: (venueId, acct, ids) => actions.sentBuilderFeeOrders(venueId, acct, ids),
      now: () => new Date(),
    });
    expect(fills.every((f) => f.builderFee === 0n)).toBe(true);
    expect(ledger.journal()).toEqual([]);
  });

  it('a cash leg the partner refuses sends nothing to the venue, and the key stays refused', async () => {
    const store = new MemoryCashLegStore();
    const offered = cashDesk({ store });
    const q = await offered.converts.quote(offered.door, principal, {
      owner,
      from: 'EUR',
      to: 'BTC',
      amount: a('20'),
      quoteKey: nextKey(),
    });
    const p = await offered.converts.accept(offered.door, principal, { owner, quoteId: q.quoteId });
    // The partner stops offering EUR before the person signs: the same record, a catalogue without EUR.
    const stopped = new VenueConverts({
      store: offered.quotes,
      now: () => new Date(),
      enabled: true,
      windowMs: WINDOW_MS,
      slippageCapBps: 50,
      cashPartner: new TestCashPartner(
        { stable: 'USDC', currencies: {} },
        { store, now: () => new Date(), deliver: async () => expect.unreachable('nothing is delivered') },
      ),
    });
    const signature = await sign(p.prepared);
    for (let i = 0; i < 2; i++)
      await expect(stopped.submit(offered.door, principal, { actionKey: p.actionKey, signature })).rejects.toMatchObject({
        code: 'trade.convert_cash_leg_refused',
      });
    expect(await store.get(cashLegKey(owner, q.quoteId))).toMatchObject({ state: 'refused' });
    expect((await offered.actions.find(USER, p.actionKey))?.signature).toBeNull();
    expect(await ordersWithId(p.prepared.venueClientOrderId!)).toBeNull();
    expect(offered.deliveries).toEqual([]);
  });

  it('a cash leg that fails sends nothing to the venue; trying again finishes the same leg once and sends the one order', async () => {
    let down = true;
    const { door, converts, actions, partner, deliveries } = cashDesk({ failDelivery: () => down });
    const q = await converts.quote(door, principal, { owner, from: 'EUR', to: 'BTC', amount: a('30'), quoteKey: nextKey() });
    const p = await converts.accept(door, principal, { owner, quoteId: q.quoteId });
    const signature = await sign(p.prepared);
    await expect(converts.submit(door, principal, { actionKey: p.actionKey, signature })).rejects.toMatchObject({
      code: 'trade.convert_cash_leg_failed',
      status: 502,
    });
    const pending = (await partner.legOf(cashLegKey(owner, q.quoteId)))!;
    expect(pending.state).toBe('pending');
    expect(await arrivalsUnder(pending.legId)).toEqual([]);
    expect((await actions.find(USER, p.actionKey))?.signature).toBeNull();
    expect(await ordersWithId(p.prepared.venueClientOrderId!)).toBeNull();

    down = false;
    const sent = await converts.submit(door, principal, { actionKey: p.actionKey, signature });
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
    expect(await partner.legOf(cashLegKey(owner, q.quoteId))).toMatchObject({ legId: pending.legId, state: 'settled' });
    expect(deliveries).toEqual([pending.legId]);
    expect(await arrivalsUnder(pending.legId)).toHaveLength(1);
    expect((await ordersWithId(p.prepared.venueClientOrderId!))?.status).toBe('filled');
  });

  it('a signature that does not check runs no cash leg', async () => {
    const { door, converts, partner, deliveries } = cashDesk();
    const q = await converts.quote(door, principal, { owner, from: 'EUR', to: 'BTC', amount: a('25'), quoteKey: nextKey() });
    const p = await converts.accept(door, principal, { owner, quoteId: q.quoteId });
    const signature = { ...(await sign(p.prepared)), signature: `0x${'1'.repeat(130)}` };
    await expect(converts.submit(door, principal, { actionKey: p.actionKey, signature })).rejects.toMatchObject({
      refusal: { code: 'signature_mismatch' },
    });
    expect(await partner.legOf(cashLegKey(owner, q.quoteId))).toBeNull();
    expect(deliveries).toEqual([]);
    expect(await ordersWithId(p.prepared.venueClientOrderId!)).toBeNull();
  });
});
