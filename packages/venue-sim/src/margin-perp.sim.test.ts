import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount, ZERO } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  encodeVenueWire,
  type PlaceUserOrderIntent,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS, answerTestVenue, seedTestVenue } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';
import { TestVenueSimulator } from './simulator.js';

// J-derivatives-27 #7 #8 at the venue: the stack's second TEST stock perpetual (XSTD-PERP), whose TEST HIP-3 deployer
// keeps its own margin account for it, apart from the main account, and caps its open interest. Every figure is TEST.

const a = parseAmount;
const XSTD = 'XSTD-PERP';
const MARGIN = 'TEST stock margin deployer margin';

function world() {
  const now = Date.UTC(2026, 10, 12, 8, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: TEST_VENUE_MARKETS, chainId: 84532 });
  const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet margin trader')));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const signer = { role: 'owner' as const, address: owner };
  const run = async (intent: VenueIntent, on: UserVenueAccount = account) => {
    const prepared = await sim.prepare(on, signer, intent);
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    return sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner });
  };
  return { sim, account, signer, run };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof VenueRefusalError) return err.refusal;
  }
  throw new Error('expected a VenueRefusalError');
};

const open = (over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: XSTD,
  side: 'buy',
  type: 'market',
  amount: a('2'),
  price: a('105'),
  timeInForce: 'IOC',
  reduceOnly: false,
  clientOrderKey: 'order:margin-trader:open:1',
  builderFee: null,
  ...over,
});

const move = (amount: string, direction: 'into_market' | 'out_of_market' = 'into_market', over: object = {}): VenueIntent => ({
  kind: 'market_margin_transfer',
  symbol: XSTD,
  direction,
  asset: 'USDC',
  amount: a(amount),
  moveKey: `market-margin:margin-trader:${direction}:${amount}`,
  ...over,
});

async function funded() {
  const w = world();
  await seedTestVenue(w.sim);
  w.sim.deposit(w.account, 'USDC', a('1000'), 'chain:margin:d1');
  expect(await w.run({ kind: 'update_leverage', symbol: XSTD, leverageBps: 50_000, marginMode: 'isolated' })).toMatchObject({
    accepted: true,
  });
  return w;
}

const mainUsdc = async (w: ReturnType<typeof world>) => (await w.sim.balances(w.account)).value.find((b) => b.asset === 'USDC')!;
const margin = async (w: ReturnType<typeof world>) => (await w.sim.marketMargin(w.account, XSTD)).value;
const marketOf = async (w: ReturnType<typeof world>) => (await w.sim.markets(null)).value.find((m) => m.symbol === XSTD)!;

describe("TEST venue simulator: a market on its deployer's own margin account (J-derivatives-27 #7 #8)", () => {
  it('lists XSTD-PERP with its HIP-3 deployer, its margin account rule and its open interest; other markets have neither', async () => {
    const w = world();
    const markets = (await w.sim.markets(null)).value;
    const m = markets.find((x) => x.symbol === XSTD)!;
    expect(m.listedBy).toEqual({ known: true, value: { kind: 'hip3', name: 'TEST stock margin deployer' } });
    expect(m.marginAccount).toEqual({ known: true, value: { name: MARGIN, collateralAsset: 'USDC', marginMode: 'isolated' } });
    expect(m.openInterest).toEqual({ known: true, value: { size: ZERO, capSize: a('500') } });
    for (const other of markets.filter((x) => x.symbol !== XSTD)) {
      expect(other.marginAccount).toEqual({ known: false });
      expect(other.openInterest).toEqual({ known: false });
    }
    expect(await refusal(w.sim.marketMargin(w.account, 'XSTK-PERP'))).toMatchObject({ code: 'not_offered' });
  });

  it("#7 an open draws on the market's own margin only: refused with main-account USDC alone, placed once collateral is moved in", async () => {
    const w = await funded();
    // USDC on the main account does not margin this market.
    expect(await w.run(open())).toMatchObject({
      accepted: false,
      refusal: { code: 'insufficient_balance', detail: `free USDC in ${MARGIN} does not cover what this order locks` },
    });
    // The owner's signed move puts collateral in, and nothing leaves the venue.
    expect(await w.run(move('300'))).toMatchObject({ accepted: true });
    expect(await mainUsdc(w)).toMatchObject({ free: a('700'), locked: ZERO });
    expect(await margin(w)).toEqual({
      symbol: XSTD,
      name: MARGIN,
      collateralAsset: 'USDC',
      marginMode: 'isolated',
      free: a('300'),
      locked: ZERO,
      total: a('300'),
    });
    const placed = await w.run(open());
    expect(placed).toMatchObject({ accepted: true, order: { status: 'filled' } });
    // The position's margin is held in the market's account; the main account is untouched.
    const m = await margin(w);
    expect(m.locked > ZERO).toBe(true);
    // The open's fees came out of the market's account too: less than what was moved in, never from the main account.
    expect(m.total < a('300')).toBe(true);
    expect(await mainUsdc(w)).toMatchObject({ free: a('700'), locked: ZERO });
    expect((await marketOf(w)).openInterest).toEqual({ known: true, value: { size: a('2'), capSize: a('500') } });
    // A close returns the margin to the market's account, and the owner moves free collateral back, signed.
    expect(await w.run(open({ side: 'sell', price: a('95'), reduceOnly: true, clientOrderKey: 'close:margin-trader:1' }))).toMatchObject({
      accepted: true,
    });
    const after = await margin(w);
    expect(after.locked).toBe(ZERO);
    expect(await w.run(move('50', 'out_of_market'))).toMatchObject({ accepted: true });
    expect((await margin(w)).free).toBe(after.free - a('50'));
    expect((await mainUsdc(w)).free).toBe(a('750'));
  });

  it("#7 a move is the owner's own, on the main account, in the deployer's collateral only, and never more than is free", async () => {
    const w = await funded();
    expect(await refusal(w.sim.prepare(w.account, w.signer, move('10', 'into_market', { asset: 'BTC' })))).toMatchObject({
      code: 'venue_rejected',
      detail: `${MARGIN} takes USDC only, as its deployer set it`,
    });
    expect(await refusal(w.sim.prepare(w.account, w.signer, move('10', 'into_market', { symbol: 'XSTK-PERP' })))).toMatchObject({
      code: 'not_offered',
    });
    expect(await w.run(move('5000'))).toMatchObject({ accepted: false, refusal: { code: 'insufficient_balance' } });
    expect(await w.run(move('1', 'out_of_market', { moveKey: 'market-margin:margin-trader:out:empty' }))).toMatchObject({
      accepted: false,
      refusal: { code: 'insufficient_balance' },
    });
    const agent = { role: 'agent' as const, address: '0x1111111111111111111111111111111111111111' };
    expect(await refusal(w.sim.prepare(w.account, agent, move('10')))).toMatchObject({ code: 'agent_not_permitted' });
    expect(await mainUsdc(w)).toMatchObject({ free: a('1000') });
  });

  it("#8 an open that would pass the deployer's open-interest cap is refused at preview and prepare, naming the cap; a close passes", async () => {
    const w = await funded();
    await w.run(move('500'));
    await w.run(open());
    // The deployer lowers its cap to one more than is open: an order of two would pass it.
    w.sim.setOpenInterestCap(XSTD, a('3'));
    const detail = "XSTD-PERP's deployer caps its open interest at 3 XSTD; 2 XSTD is open, so 2 XSTD more would pass the cap";
    const second = open({ clientOrderKey: 'order:margin-trader:open:2' });
    expect(await refusal(w.sim.preview(w.account, second))).toEqual({ venueId: w.sim.venue.id, code: 'open_interest_above_cap', detail });
    expect(await refusal(w.sim.prepare(w.account, w.signer, second))).toMatchObject({ code: 'open_interest_above_cap', detail });
    // One more fits under the cap, exactly.
    expect(await w.run(open({ amount: a('1'), clientOrderKey: 'order:margin-trader:open:3' }))).toMatchObject({ accepted: true });
    // A reduce-only close is never held to the cap.
    expect(
      await w.run(open({ side: 'sell', price: a('95'), reduceOnly: true, amount: a('3'), clientOrderKey: 'close:margin-trader:2' })),
    ).toMatchObject({ accepted: true });
    // The close sold to the TEST bid maker, now long: the market's open size is the maker's, not the person's.
    w.sim.setOpenInterestCap(XSTD, null);
    expect((await marketOf(w)).openInterest).toEqual({ known: true, value: { size: a('3'), capSize: null } });
    expect(() => w.sim.setOpenInterestCap('XSTK-PERP', a('1'))).toThrow(VenueRefusalError);
  });

  it('serves the margin read and the open-interest control over HTTP, the cap travelling as a decimal string', async () => {
    const w = await funded();
    await w.run(move('100'));
    const call = async (path: string, body: unknown) => {
      const [status, out] = await answerTestVenue(w.sim, 'POST', path, JSON.stringify(encodeVenueWire(body)));
      return { status, out: JSON.parse(JSON.stringify(out)) };
    };
    const read = await call('/market-margin', { account: w.account, symbol: XSTD });
    expect(read.status).toBe(200);
    expect(read.out.value).toMatchObject({ free: '100', locked: '0', name: MARGIN, collateralAsset: 'USDC' });
    const capped = await call('/test/open-interest-cap', { symbol: XSTD, capSize: '40' });
    expect(capped).toEqual({ status: 200, out: { openInterest: { known: true, value: { size: '0', capSize: '40' } }, label: 'TEST' } });
    expect((await call('/test/open-interest-cap', { symbol: XSTD, capSize: 40 })).status).toBe(400);
  });
});
