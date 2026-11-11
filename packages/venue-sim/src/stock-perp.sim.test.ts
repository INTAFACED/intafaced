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

// J-derivatives-27 at the venue: the stack's TEST stock perpetual (XSTK-PERP), its published rules, its leverage cap
// and its TEST home market's session with the venue's off-hours mode, on the same market list and seed the stack's TEST
// venue runs (http-server.ts). Every figure and word is TEST.

const a = parseAmount;
const XSTK = 'XSTK-PERP';
const OFF_HOURS_RULE =
  'Off hours XSTK-PERP takes no market orders, and only limit orders within 5% of the closing mark at up to 2x; market orders wait for the home market to reopen.';

function world() {
  let now = Date.UTC(2026, 10, 11, 12, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: TEST_VENUE_MARKETS, chainId: 84532 });
  const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet stock trader')));
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
  symbol: XSTK,
  side: 'buy',
  type: 'market',
  amount: a('2'),
  price: a('210'),
  timeInForce: 'IOC',
  reduceOnly: false,
  clientOrderKey: 'order:stock-trader:open:1',
  builderFee: null,
  ...over,
});

const leverage = (times: number): VenueIntent => ({
  kind: 'update_leverage',
  symbol: XSTK,
  leverageBps: times * 10_000,
  marginMode: 'isolated',
});

async function funded() {
  const w = world();
  await seedTestVenue(w.sim);
  w.sim.deposit(w.account, 'USDC', a('5000'), 'chain:stock:d1');
  return w;
}

const marketOf = async (w: ReturnType<typeof world>) => (await w.sim.markets(null)).value.find((m) => m.symbol === XSTK)!;

describe('TEST venue simulator: the TEST stock perpetual (J-derivatives-27)', () => {
  it("#1 lists XSTK-PERP with the venue's listing, feed and mark rules, cap, hours, and its home market open; other markets have no session", async () => {
    const w = world();
    const markets = (await w.sim.markets(null)).value;
    expect(markets.map((m) => m.symbol)).toEqual(['BTC-USDC', 'BTC-PERP', 'ETH-USDC', 'XAU-PERP', XSTK]);
    const m = markets.find((x) => x.symbol === XSTK)!;
    expect(m).toMatchObject({
      kind: 'perpetual',
      maxLeverageBps: 100_000,
      listedBy: { known: true, value: { kind: 'hip3', name: 'TEST stock deployer' } },
      markRule: { known: true, value: 'The mark price is the feed price; fills do not move it.' },
      feed: { known: true, value: { state: 'live' } },
    });
    expect(m.oracleRule.known && m.tradingHours.known).toBe(true);
    expect(m.session).toEqual({
      known: true,
      value: {
        state: 'open',
        homeMarket: 'TEST home exchange',
        offHoursMode: {
          known: true,
          value: 'The mark holds at the last open-hours price; only limit orders inside the band are taken, at reduced leverage.',
        },
        offHoursBand: { known: true, value: 'Limit prices within 5% of the mark when the home market closed.' },
        offHoursMaxLeverageBps: 20_000,
        reopensAt: null,
        offHoursRule: { known: true, value: OFF_HOURS_RULE },
      },
    });
    for (const other of markets.filter((x) => x.symbol !== XSTK)) expect(other.session).toEqual({ known: false });
  });

  it('#2 #3 opens within the cap while the home market is open; above the cap is refused with the cap named, nothing applied', async () => {
    const w = await funded();
    expect(await refusal(w.sim.prepare(w.account, w.signer, leverage(20)))).toEqual({
      venueId: w.sim.venue.id,
      code: 'leverage_above_cap',
      detail: 'XSTK-PERP allows at most 10x; 20x is above its cap',
    });
    expect((await w.sim.leverage(w.account, XSTK)).value).toBeNull();
    await w.run(leverage(5));
    expect(await w.run(order({}))).toMatchObject({ definite: true, accepted: true, order: { status: 'filled' } });
    const [p] = (await w.sim.positions(w.account)).value;
    // 1 at the TEST ladder's 200.1 and 1 at 200.2; the mark is the feed's 200 and a fill does not move it.
    expect(p).toMatchObject({
      symbol: XSTK,
      side: 'long',
      size: a('2'),
      entryPrice: a('200.15'),
      markPrice: a('200'),
      leverageBps: 50_000,
    });
    expect(p!.liquidationPrice.known).toBe(true);
  });

  it("#4 #5 off hours: the venue publishes its mode, band, leverage and reopen time; it refuses what its rule refuses in the rule's words, and takes the rest", async () => {
    const w = await funded();
    await w.run(leverage(5));
    await w.run(order({}));
    const closedAt = w.now();
    w.sim.setSession(XSTK, 'off_hours');
    w.tick(60_000);
    const session = (await marketOf(w)).session;
    expect(session).toMatchObject({
      known: true,
      value: { state: 'off_hours', offHoursMaxLeverageBps: 20_000, reopensAt: new Date(closedAt.getTime() + 3_600_000) },
    });
    // The mark holds at the last open-hours price.
    expect(await refusal(Promise.resolve().then(() => w.sim.setMark(XSTK, a('205'))))).toMatchObject({ code: 'market_off_hours' });

    // A market order is refused at prepare, at preview and at submit (a hand-built prepared action), in the rule's words.
    const open = order({ clientOrderKey: 'order:stock-trader:open:2' });
    const want = { venueId: w.sim.venue.id, code: 'market_off_hours', detail: OFF_HOURS_RULE };
    expect(await refusal(w.sim.prepare(w.account, w.signer, open))).toEqual(want);
    expect(await refusal(w.sim.preview(w.account, open))).toEqual(want);
    expect(await w.forged(open, '2')).toMatchObject({ definite: true, accepted: false, refusal: want });
    // A limit within the band, at the account's 5x: refused, above the off-hours 2x.
    const limit = order({ type: 'limit', timeInForce: 'GTC', price: a('199'), clientOrderKey: 'order:stock-trader:open:3' });
    expect(await refusal(w.sim.prepare(w.account, w.signer, limit))).toEqual(want);
    // At 2x: a limit outside the 5% band is refused; one inside it rests.
    await w.run(leverage(2));
    expect(await refusal(w.sim.prepare(w.account, w.signer, { ...limit, price: a('189.99') }))).toEqual(want);
    expect(await refusal(w.sim.prepare(w.account, w.signer, { ...limit, price: a('210.01') }))).toEqual(want);
    expect(await w.run(limit)).toMatchObject({ definite: true, accepted: true, order: { status: 'open' } });
    // A reduce-only close is taken off hours.
    const close = await w.run(
      order({ side: 'sell', type: 'market', price: a('190'), reduceOnly: true, clientOrderKey: 'close:stock-trader:1' }),
    );
    expect(close).toMatchObject({ definite: true, accepted: true, order: { status: 'filled' } });
    expect((await w.sim.positions(w.account)).value).toEqual([]);

    // Open again: no reopen time, and a market order is taken.
    w.sim.setSession(XSTK, 'open');
    expect((await marketOf(w)).session).toMatchObject({ value: { state: 'open', reopensAt: null } });
    await w.run({ kind: 'cancel_order', symbol: XSTK, clientOrderKey: 'order:stock-trader:open:3' });
    expect(await w.run(open)).toMatchObject({ definite: true, accepted: true });
  });

  it('a market with no home market has no session to switch', async () => {
    const w = world();
    expect(await refusal(Promise.resolve().then(() => w.sim.setSession('XAU-PERP', 'off_hours')))).toMatchObject({ code: 'not_offered' });
  });

  it('HTTP: /test/session switches the session and answers it, its reopen time as ISO; a bad state answers 400', async () => {
    const w = world();
    const call = async (path: string, body: unknown) => {
      const [status, out] = await answerTestVenue(w.sim, 'POST', path, JSON.stringify(encodeVenueWire(body)));
      return { status, raw: out as any, out: decodeVenueWire<any>(JSON.parse(JSON.stringify(out))) };
    };
    const closed = await call('/test/session', { symbol: XSTK, state: 'off_hours' });
    expect(closed.status).toBe(200);
    expect(closed.out).toMatchObject({ label: 'TEST', session: { known: true, value: { state: 'off_hours' } } });
    expect(closed.out.session.value.reopensAt).toBeInstanceOf(Date);
    expect((await call('/test/session', { symbol: XSTK, state: 'paused' })).status).toBe(400);
    expect((await call('/test/session', { symbol: 'BTC-PERP', state: 'off_hours' })).status).toBe(422);
    const markets = await call('/markets', { account: null });
    // The venue's words travel as text, never read as money.
    const wire = markets.raw.value.find((m: { symbol: string }) => m.symbol === XSTK).session.value;
    expect(wire.offHoursRule).toEqual({ known: true, value: OFF_HOURS_RULE });
    expect((await call('/test/session', { symbol: XSTK, state: 'open' })).out.session.value).toMatchObject({
      state: 'open',
      reopensAt: null,
    });
  });
});
