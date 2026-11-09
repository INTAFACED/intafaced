import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  decodeVenueWire,
  encodeVenueWire,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS, answerTestVenue, seedTestVenue } from './http-server.js';
import { buildTypedData, digestOf, type TestVenueTypedData } from './signing.js';
import { TestVenueSimulator } from './simulator.js';

// J-derivatives-21 at the venue: the stack's TEST gold perpetual (XAU-PERP), its published rules, its leverage cap and
// its stale-feed rule, on the same market list and seed the stack's TEST venue runs (http-server.ts). Every figure TEST.

const a = parseAmount;
const XAU = 'XAU-PERP';
const STALE_RULE = 'While the oracle is stale the mark holds at the last oracle price and only reduce-only orders are taken.';

function world() {
  let now = Date.UTC(2026, 10, 9, 12, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: TEST_VENUE_MARKETS, chainId: 84532 });
  const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet gold trader')));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const signer = { role: 'owner' as const, address: owner };
  const sign = async (prepared: PreparedVenueAction) => {
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    return { digest: prepared.digest, signature, signedBy: owner };
  };
  const run = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, signer, intent);
    return sim.submit(prepared, await sign(prepared));
  };
  /** A prepared action built by hand, skipping prepare's checks, so submit's own checks are what refuse it. */
  const forged = async (intent: VenueIntent, nonce: string) => {
    const typedData = buildTypedData(sim.venue.id, account, signer, intent, nonce, sim.chainId);
    const prepared: PreparedVenueAction = {
      venueId: sim.venue.id,
      account,
      signer,
      intent,
      nonce,
      venueClientOrderId: null,
      typedData,
      digest: digestOf(typedData),
      builderFee: null,
      preparedAt: new Date(now),
    };
    return sim.submit(prepared, await sign(prepared));
  };
  return { sim, account, signer, run, forged, tick: (ms: number) => (now += ms), now: () => new Date(now) };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof VenueRefusalError) return err.refusal;
  }
  throw new Error('expected a VenueRefusalError');
};

const order = (over: Partial<PlaceUserOrderIntent>): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: XAU,
  side: 'buy',
  type: 'market',
  amount: a('0.5'),
  price: a('2700'),
  timeInForce: 'IOC',
  reduceOnly: false,
  clientOrderKey: 'order:gold-trader:open:1',
  builderFee: null,
  ...over,
});

const fiveX: VenueIntent = { kind: 'update_leverage', symbol: XAU, leverageBps: 50_000, marginMode: 'isolated' };

async function funded() {
  const w = world();
  await seedTestVenue(w.sim);
  w.sim.deposit(w.account, 'USDC', a('5000'), 'chain:gold:d1');
  return w;
}

describe('TEST venue simulator: the TEST gold perpetual (J-derivatives-21)', () => {
  it("#1 lists XAU-PERP with the venue's own listing, oracle and mark rules, cap, hours and live feed; BTC keeps its rules unpublished", async () => {
    const w = world();
    const markets = (await w.sim.markets(null)).value;
    expect(markets.map((m) => m.symbol)).toEqual(['BTC-USDC', 'BTC-PERP', 'ETH-USDC', XAU]);
    const xau = markets.find((m) => m.symbol === XAU)!;
    expect(xau).toMatchObject({
      kind: 'perpetual',
      baseAsset: 'XAU',
      quoteAsset: 'USDC',
      marginModes: ['isolated'],
      maxLeverageBps: 100_000,
      tickSize: a('0.1'),
      lotSize: a('0.01'),
      listedBy: { known: true, value: { kind: 'hip3', name: 'TEST gold deployer' } },
      oracleRule: { known: true, value: expect.stringContaining('TEST oracle') },
      markRule: { known: true, value: 'The mark price is the oracle price; fills do not move it.' },
      tradingHours: { known: true, value: '24/7, no close' },
      feed: { known: true, value: { state: 'live', lastOracleUpdateAt: w.now(), staleRule: { known: true, value: STALE_RULE } } },
    });
    const btc = markets.find((m) => m.symbol === 'BTC-PERP')!;
    expect(btc.listedBy).toEqual({ known: true, value: { kind: 'venue', name: 'TEST venue simulator' } });
    for (const field of ['oracleRule', 'markRule', 'tradingHours', 'feed'] as const) expect(btc[field]).toEqual({ known: false });
  });

  it("seeds XAU-PERP's ladder around its own price, and BTC's around 60000 as before", async () => {
    const w = world();
    expect((await seedTestVenue(w.sim)).orders).toBe(30);
    // The book is read through what a taker meets: a market buy of one lot fills at the best ask.
    w.sim.deposit(w.account, 'USDC', a('100000'), 'chain:gold:seed');
    await w.run(fiveX);
    await w.run({ ...fiveX, symbol: 'BTC-PERP' });
    await w.run(order({ amount: a('0.01'), clientOrderKey: 'order:gold-trader:seed-xau' }));
    await w.run(order({ symbol: 'BTC-PERP', amount: a('0.001'), price: a('61000'), clientOrderKey: 'order:gold-trader:seed-btc' }));
    const fills = (await w.sim.fills(w.account, new Date(0))).value;
    expect(fills.find((f) => f.symbol === XAU)!.price).toBe(a('2650.5'));
    expect(fills.find((f) => f.symbol === 'BTC-PERP')!.price).toBe(a('60010'));
  });

  it('#2 opens a position within the cap: entry from the fill, mark from the oracle (the fill does not move it), liquidation price', async () => {
    const w = await funded();
    await w.run(fiveX);
    const out = await w.run(order({}));
    expect(out).toMatchObject({ definite: true, accepted: true, order: { status: 'filled' } });
    const [p] = (await w.sim.positions(w.account)).value;
    expect(p).toMatchObject({
      symbol: XAU,
      side: 'long',
      size: a('0.5'),
      entryPrice: a('2650.5'),
      markPrice: a('2650'),
      leverageBps: 50_000,
    });
    expect(p!.liquidationPrice.known).toBe(true);
  });

  it("#3 a leverage above XAU-PERP's cap is refused leverage_above_cap naming the cap, at prepare and at submit; nothing moves", async () => {
    const w = await funded();
    const before = (await w.sim.balances(w.account)).value;
    const r = await refusal(w.sim.prepare(w.account, w.signer, { ...fiveX, leverageBps: 200_000 }));
    expect(r).toMatchObject({ code: 'leverage_above_cap', detail: expect.stringContaining('XAU-PERP allows at most 10x') });
    expect(await refusal(w.sim.preview(w.account, order({})))).toMatchObject({ code: 'leverage_not_set' });
    const sent = await w.forged({ ...fiveX, leverageBps: 200_000 }, '1');
    expect(sent).toMatchObject({ definite: true, accepted: false, refusal: { code: 'leverage_above_cap' } });
    expect((sent as { refusal: { detail: string } }).refusal.detail).toContain('XAU-PERP allows at most 10x');
    expect((await w.sim.leverage(w.account, XAU)).value).toBeNull();
    expect((await w.sim.positions(w.account)).value).toEqual([]);
    expect((await w.sim.balances(w.account)).value).toEqual(before);
    // The cap itself is allowed.
    await w.run({ ...fiveX, leverageBps: 100_000 });
    expect((await w.sim.leverage(w.account, XAU)).value).toMatchObject({ leverageBps: 100_000 });
  });

  it("#4 a stale feed: the venue publishes it with its rule, the mark holds, an opening order refuses feed_stale with the rule's words, reduce-only is taken", async () => {
    const w = await funded();
    await w.run(fiveX);
    await w.run(order({}));
    const wentStale = w.now();
    w.sim.setFeed(XAU, 'stale');
    w.tick(60_000);
    const feed = (await w.sim.markets(null)).value.find((m) => m.symbol === XAU)!.feed;
    expect(feed).toEqual({
      known: true,
      value: { state: 'stale', lastOracleUpdateAt: wentStale, staleRule: { known: true, value: STALE_RULE } },
    });
    // The mark holds: an oracle update is refused while stale, and a fill does not move it.
    expect(await refusal(Promise.resolve().then(() => w.sim.setMark(XAU, a('2700'))))).toMatchObject({ code: 'feed_stale' });
    const open = order({ clientOrderKey: 'order:gold-trader:open:2' });
    expect(await refusal(w.sim.prepare(w.account, w.signer, open))).toEqual({
      venueId: w.sim.venue.id,
      code: 'feed_stale',
      detail: STALE_RULE,
    });
    expect(await refusal(w.sim.preview(w.account, open))).toMatchObject({ code: 'feed_stale' });
    const forged = await w.forged(open, '2');
    expect(forged).toMatchObject({ definite: true, accepted: false, refusal: { code: 'feed_stale', detail: STALE_RULE } });
    expect((await w.sim.positions(w.account)).value[0]).toMatchObject({ size: a('0.5'), markPrice: a('2650') });
    // Reduce-only is taken: the position closes at the bid, with the venue's realised result.
    const close = await w.run(order({ side: 'sell', price: a('2600'), reduceOnly: true, clientOrderKey: 'close:gold-trader:1' }));
    expect(close).toMatchObject({ definite: true, accepted: true, order: { status: 'filled' } });
    expect((await w.sim.positions(w.account)).value).toEqual([]);
    const closing = (await w.sim.fills(w.account, new Date(0))).value.filter((f) => f.realisedPnl !== null);
    expect(closing).toHaveLength(1);
    expect(closing[0]!.realisedPnl).toBe(a('-0.5')); // (2649.5 - 2650.5) x 0.5
    expect((await w.sim.markets(null)).value.find((m) => m.symbol === XAU)!.feed).toMatchObject({ value: { state: 'stale' } });
    // Live again: the oracle updates with the clock, and an opening order is taken.
    w.sim.setFeed(XAU, 'live');
    expect((await w.sim.markets(null)).value.find((m) => m.symbol === XAU)!.feed).toMatchObject({
      value: { state: 'live', lastOracleUpdateAt: w.now() },
    });
    expect(await w.run(open)).toMatchObject({ definite: true, accepted: true });
  });

  it('a market priced by no oracle has no feed to switch', async () => {
    const w = world();
    expect(await refusal(Promise.resolve().then(() => w.sim.setFeed('BTC-PERP', 'stale')))).toMatchObject({ code: 'not_offered' });
  });

  it('HTTP: /test/feed switches the feed and answers it; a bad state answers 400', async () => {
    const w = world();
    const call = async (path: string, body: unknown) => {
      const [status, out] = await answerTestVenue(w.sim, 'POST', path, JSON.stringify(encodeVenueWire(body)));
      return { status, out: decodeVenueWire<any>(JSON.parse(JSON.stringify(out))) };
    };
    const stale = await call('/test/feed', { symbol: XAU, state: 'stale' });
    expect(stale.status).toBe(200);
    expect(stale.out).toMatchObject({
      label: 'TEST',
      feed: { known: true, value: { state: 'stale', staleRule: { known: true, value: STALE_RULE } } },
    });
    expect((await call('/test/feed', { symbol: XAU, state: 'paused' })).status).toBe(400);
    expect((await call('/test/feed', { symbol: 'BTC-PERP', state: 'stale' })).status).toBe(422);
    expect((await call('/test/feed', { symbol: XAU, state: 'live' })).out.feed.value.state).toBe('live');
    const markets = await call('/markets', { account: null });
    expect(markets.out.value.find((m: { symbol: string }) => m.symbol === XAU).oracleRule.value).toContain('TEST oracle');
  });
});
