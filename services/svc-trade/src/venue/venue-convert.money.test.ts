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
import { MemoryConvertQuoteStore, VenueConverts, convertKey, presentConvertQuote } from './venue-convert.js';
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

function desk(opts: { now?: () => Date; windowMs?: number | null; enabled?: boolean } = {}) {
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
  const converts = new VenueConverts({
    store: new MemoryConvertQuoteStore(),
    now,
    enabled: opts.enabled ?? true,
    windowMs: opts.windowMs === undefined ? WINDOW_MS : opts.windowMs,
    slippageCapBps: 50,
  });
  return { door, converts, actions };
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
