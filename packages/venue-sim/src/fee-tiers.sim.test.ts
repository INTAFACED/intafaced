import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { PlaceUserOrderIntent, UserVenueAccount } from '@intafaced/venue-contracts';
import { TestVenueSimulator, type SimMarketConfig } from './simulator.js';
import type { TestVenueTypedData } from './signing.js';
import { TEST_VENUE_FEE_TIERS, TEST_VENUE_MARKETS, answerTestVenue } from './http-server.js';

// J-cex-spot-10 #4 #6: the venue's published fee tiers, the tier its update places an account in from the account's own
// fills, the rates it then charges, and a maker rebate charged as a fee below zero, never clamped to zero.
const a = parseAmount;
const START = Date.UTC(2026, 10, 18, 10, 0, 0);
let now = new Date(START);

const SPOT: SimMarketConfig = {
  symbol: 'TST-USDC',
  kind: 'spot',
  baseAsset: 'TST',
  quoteAsset: 'USDC',
  orderTypes: ['limit'],
  timeInForce: ['GTC', 'IOC'],
  marginModes: [],
  maxLeverageBps: null,
  tickSize: a('1'),
  lotSize: a('0.001'),
  makerFeeBps: { known: true, value: a('1') },
  takerFeeBps: { known: true, value: a('3.5') },
};

function trader(sim: TestVenueSimulator, name: string) {
  const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST fee tiers ${name}`)));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  let n = 0;
  const place = async (side: 'buy' | 'sell', price: string, amount: string, timeInForce: 'GTC' | 'IOC') => {
    const intent: PlaceUserOrderIntent = {
      kind: 'place_order',
      symbol: SPOT.symbol,
      side,
      type: 'limit',
      amount: a(amount),
      price: a(price),
      timeInForce,
      reduceOnly: false,
      clientOrderKey: `order:${owner}:fee-tiers-${(n += 1)}`,
      builderFee: null,
    };
    const prepared = await sim.prepare(account, { role: 'owner', address: owner }, intent);
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    return sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner });
  };
  return { owner, account, place };
}

function world() {
  now = new Date(START);
  const sim = new TestVenueSimulator({ clock: () => now, markets: [SPOT], feeSchedule: TEST_VENUE_FEE_TIERS });
  const maker = trader(sim, 'maker');
  const taker = trader(sim, 'taker');
  for (const t of [maker, taker]) {
    sim.deposit(t.account, 'USDC', a('1000000'), `chain:${t.owner}:usdc`);
    sim.deposit(t.account, 'TST', a('100'), `chain:${t.owner}:tst`);
  }
  return { sim, maker, taker };
}

const buyFrom = (fills: readonly { side: string; venueFee: bigint }[]) => fills.find((f) => f.side === 'buy')!;

describe("the venue's fee tiers", () => {
  it('are published without an account, and an account starts in the base tier with no update yet', async () => {
    const { sim, taker } = world();
    const pub = (await sim.feeStatus(null)).value;
    expect(pub.account).toBeNull();
    expect(pub.schedule.tiers?.map((t) => t.name)).toEqual(['TEST base', 'TEST tier 1', 'TEST tier 2']);
    const own = (await sim.feeStatus(taker.account)).value.account!;
    expect(own).toMatchObject({ tierName: 'TEST base', volume: { known: false }, tierUpdatedAt: null });
  });

  it("moves an account only at the venue's update, by its own counted volume, and then charges the tier's rates", async () => {
    const { sim, maker, taker } = world();
    // 2 TST at 60,000 = 120,000 USDC of the taker's volume: above tier 1 (100,000).
    await maker.place('sell', '60000', '2', 'GTC');
    await taker.place('buy', '60000', '2', 'IOC');
    expect(buyFrom((await sim.fills(taker.account, new Date(0))).value).venueFee).toBe(a('0.0007')); // 2 TST × 3.5 bps
    expect((await sim.feeStatus(taker.account)).value.account?.tierName).toBe('TEST base');

    const updated = sim.updateFeeTier(taker.owner);
    expect(updated).toMatchObject({ index: 1, volume: a('120000') });
    const status = (await sim.feeStatus(taker.account)).value.account!;
    expect(status).toMatchObject({ tierName: 'TEST tier 1', volume: { known: true, value: a('120000') }, tierUpdatedAt: now });
    expect(status.spot).toEqual(TEST_VENUE_FEE_TIERS.tiers[1]!.spot);

    // The next fill pays tier 1's taker rate (3 bps), and the preview reports it before anything is sent.
    await maker.place('sell', '60000', '1', 'GTC');
    const preview = (
      await sim.preview(taker.account, {
        kind: 'place_order',
        symbol: SPOT.symbol,
        side: 'buy',
        type: 'limit',
        amount: a('1'),
        price: a('60000'),
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: 'order:preview',
        builderFee: null,
      })
    ).value;
    expect(preview.rates).toEqual({ makerFeeBps: { known: true, value: a('0.8') }, takerFeeBps: { known: true, value: a('3') } });
    expect(preview.venueFee).toEqual({ known: true, value: { asset: 'TST', amount: a('0.0003') } });
    await taker.place('buy', '60000', '1', 'IOC');
    const fills = (await sim.fills(taker.account, new Date(0))).value.filter((f) => f.amount === a('1'));
    expect(fills[0]?.venueFee).toBe(a('0.0003'));
    // The maker was never updated: it still pays the market's own rate.
    expect((await sim.feeStatus(maker.account)).value.account?.tierName).toBe('TEST base');
  });

  it("counts only the schedule's days of fills", async () => {
    const { sim, maker, taker } = world();
    await maker.place('sell', '60000', '2', 'GTC');
    await taker.place('buy', '60000', '2', 'IOC');
    now = new Date(now.getTime() + (TEST_VENUE_FEE_TIERS.volumeDays + 1) * 86_400_000);
    expect(sim.updateFeeTier(taker.owner)).toMatchObject({ index: 0, volume: a('0') });
  });
});

describe("the venue's maker rebate", () => {
  it('is a fee below zero on the maker fill, credited, never a zero or a negative taker rate', async () => {
    const { sim, maker, taker } = world();
    sim.setMarketFees(SPOT.symbol, { makerFeeBps: { known: true, value: a('-1') }, takerFeeBps: { known: true, value: a('3.5') } });
    const before = (await sim.balances(maker.account)).value.find((b) => b.asset === 'USDC')!.free;
    await maker.place('sell', '50000', '1', 'GTC');
    await taker.place('buy', '50000', '1', 'IOC');
    const fill = (await sim.fills(maker.account, new Date(0))).value.at(-1)!;
    expect(fill).toMatchObject({ role: 'maker', venueFee: a('-5'), feeAsset: 'USDC' }); // 50,000 × -1 bps
    const after = (await sim.balances(maker.account)).value.find((b) => b.asset === 'USDC')!.free;
    expect(after - before).toBe(a('50005'));
    expect(() =>
      sim.setFeeSchedule({
        ...TEST_VENUE_FEE_TIERS,
        tiers: [
          { ...TEST_VENUE_FEE_TIERS.tiers[0]!, spot: { makerFeeBps: { known: false }, takerFeeBps: { known: true, value: a('-1') } } },
        ],
      }),
    ).toThrow('a taker rate is never below zero');
  });

  // J-derivatives-12 #2: the venue's settlement and other fees, as it charges them, or none published.
  it("publishes its settlement fee and each liquidating market's liquidation fee, and none while the switch withholds them", async () => {
    const sim = new TestVenueSimulator({ clock: () => now, markets: TEST_VENUE_MARKETS, feeSchedule: TEST_VENUE_FEE_TIERS });
    const fees = (await sim.feeStatus(null)).value.otherFees!;
    expect(fees[0]).toMatchObject({ kind: 'settlement', symbol: null, feeBps: a('0') });
    const liquidating = TEST_VENUE_MARKETS.filter((m) => m.liquidation).map((m) => m.symbol);
    expect(liquidating).toEqual(['XLIQ-PERP', 'XBIL-PERP']);
    expect(fees.filter((f) => f.kind === 'liquidation').map((f) => [f.symbol, f.feeBps])).toEqual(liquidating.map((s) => [s, a('100')]));
    const [status] = await answerTestVenue(sim, 'POST', '/test/switches', JSON.stringify({ otherFeesUnpublished: true }));
    expect(status).toBe(200);
    expect((await sim.feeStatus(null)).value.otherFees).toBeNull();
  });
});
