import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { add, parseAmount, ZERO } from '@intafaced/ledger-client/money';
import type { PlaceUserOrderIntent, PreparedVenueAction, UserVenueAccount, VenueIntent } from '@intafaced/venue-contracts';
import { TestVenueSimulator } from './simulator.js';
import type { TestVenueTypedData } from './signing.js';
import { TEST_VENUE_MARKETS } from './http-server.js';

// The venue's own record of each claim of our builder fees (J-derivatives-17: "the venue records each claim of our
// builder fees"; launch money model, rule 5: Collect is posted from that record). Earned and claimed are two figures.
const a = parseAmount;
const BUILDER = '0x7e57000000000000000000000000000000000b1d';

function trader(sim: TestVenueSimulator, name: string) {
  const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST builder-claims ${name}`)));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const signer = { role: 'owner' as const, address: owner };
  const run = async (intent: VenueIntent) => {
    const prepared: PreparedVenueAction = await sim.prepare(account, signer, intent);
    const typed = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    const outcome = await sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner });
    expect(outcome).toMatchObject({ definite: true, accepted: true });
  };
  return { account, run };
}

const limit = (side: 'buy' | 'sell', key: string, builderFee: PlaceUserOrderIntent['builderFee']): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: 'BTC-USDC',
  side,
  type: 'limit',
  amount: a('0.01'),
  price: a('60000'),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: key,
  builderFee,
});

/** A buyer rests a bid; the seller sells into it carrying our builder fee, which the venue credits the builder. */
async function earnOnce(sim: TestVenueSimulator, n: number) {
  const buyer = trader(sim, `buyer ${n}`);
  const seller = trader(sim, `seller ${n}`);
  sim.deposit(buyer.account, 'USDC', a('1000'), `claims:buyer:${n}`);
  sim.deposit(seller.account, 'BTC', a('1'), `claims:seller:${n}`);
  await seller.run({ kind: 'approve_builder_fee', builder: BUILDER, maxFeeBps: a('10') });
  await buyer.run(limit('buy', `bid:${n}`, null));
  await seller.run(limit('sell', `ask:${n}`, { builder: BUILDER, feeBps: a('5') }));
}

const builderAccount = (sim: TestVenueSimulator): UserVenueAccount => ({ venueId: sim.venue.id, owner: BUILDER, subAccount: null });
const freeUsdc = async (sim: TestVenueSimulator) =>
  (await sim.balances(builderAccount(sim))).value.find((b) => b.asset === 'USDC')?.free ?? ZERO;

describe("the TEST venue's builder fee claims", () => {
  it('records nothing before a claim; a claim pays the unclaimed fees into the builder account, once', async () => {
    const sim = new TestVenueSimulator({ clock: () => new Date(Date.UTC(2026, 10, 14, 10)), markets: TEST_VENUE_MARKETS });
    await earnOnce(sim, 1);
    const totals = await sim.builderTotals(BUILDER);
    expect(totals.value.known).toBe(true);
    const earned = totals.value.known ? totals.value.value.assets.find((x) => x.asset === 'USDC')! : null;
    // 0.01 BTC at 60000 is 600 USDC of notional; 5 bps of it is 0.3 USDC.
    expect(earned).toEqual({ asset: 'USDC', earned: a('0.3'), unclaimed: a('0.3') });
    expect((await sim.builderClaims(BUILDER)).value).toEqual([]);
    expect(await freeUsdc(sim)).toBe(ZERO);

    const made = sim.claimBuilderFees(BUILDER.toUpperCase().replace('0X', '0x'));
    expect(made).toEqual([
      {
        claimId: 'sim-builder-claim-1',
        builder: BUILDER,
        asset: 'USDC',
        amount: a('0.3'),
        claimedAt: new Date(Date.UTC(2026, 10, 14, 10)),
      },
    ]);
    expect((await sim.builderClaims(BUILDER)).value).toEqual(made);
    expect(await freeUsdc(sim)).toBe(a('0.3'));
    const after = await sim.builderTotals(BUILDER);
    expect(after.value.known && after.value.value.assets).toEqual([{ asset: 'USDC', earned: a('0.3'), unclaimed: ZERO }]);

    // Nothing unclaimed: a second claim makes none and pays nothing.
    expect(sim.claimBuilderFees(BUILDER)).toEqual([]);
    expect((await sim.builderClaims(BUILDER)).value).toHaveLength(1);
    expect(await freeUsdc(sim)).toBe(a('0.3'));
  });

  it('a later claim takes only what was earned since the last one', async () => {
    const sim = new TestVenueSimulator({ clock: () => new Date(Date.UTC(2026, 10, 14, 11)), markets: TEST_VENUE_MARKETS });
    await earnOnce(sim, 1);
    sim.claimBuilderFees(BUILDER);
    await earnOnce(sim, 2);
    const second = sim.claimBuilderFees(BUILDER);
    expect(second).toEqual([expect.objectContaining({ claimId: 'sim-builder-claim-2', amount: a('0.3') })]);
    const claims = (await sim.builderClaims(BUILDER)).value;
    expect(claims.reduce((n, c) => add(n, c.amount), ZERO)).toBe(a('0.6'));
    expect(await freeUsdc(sim)).toBe(a('0.6'));
  });

  it('refuses a claim for something that is not an address, and answers venue_down when down', async () => {
    const sim = new TestVenueSimulator({ clock: () => new Date(), markets: TEST_VENUE_MARKETS });
    expect(() => sim.claimBuilderFees('not-an-address')).toThrow(/0x address/);
    sim.switches.venueDown = true;
    await expect(sim.builderClaims(BUILDER)).rejects.toMatchObject({ refusal: { code: 'venue_down' } });
  });
});
