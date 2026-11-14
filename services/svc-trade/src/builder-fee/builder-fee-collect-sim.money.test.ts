import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MemoryLedger, formatAmount, parseAmount, recipes, venueBuilderAccount, venueBuilderFeeReceivable } from '@intafaced/ledger-client';
import type { PlaceUserOrderIntent, UserVenueAccount, VenueIntent } from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS, TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { collectBuilderFees } from './builder-fee-collect.js';
import { claimReader } from './wire.js';

/**
 * Collect against the TEST venue's own claim record (J-derivatives-17; launch money model, rule 5): the collect job's
 * reader reads the venue's claims, and each posts `builderFeeReceive` once, keyed on the venue's claim id. TEST amounts.
 */
const a = parseAmount;
const BUILDER = '0x7e57000000000000000000000000000000000b1d';
const USER = '11111111-1111-4111-8111-1111111111c1';

function trader(sim: TestVenueSimulator, name: string) {
  const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST collect-sim ${name}`)));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const run = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, { role: 'owner', address: owner }, intent);
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    expect(await sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner })).toMatchObject({ accepted: true });
  };
  return { account, run };
}

const order = (side: 'buy' | 'sell', key: string, fee: PlaceUserOrderIntent['builderFee']): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: 'BTC-USDC',
  side,
  type: 'limit',
  amount: a('0.01'),
  price: a('60000'),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: key,
  builderFee: fee,
});

describe('collect on the TEST venue claim record', () => {
  it('posts each claim the venue records once, and nothing before the builder claims', async () => {
    const sim = new TestVenueSimulator({ clock: () => new Date(Date.UTC(2026, 10, 14, 12)), markets: TEST_VENUE_MARKETS });
    const ledger = new MemoryLedger();
    const buyer = trader(sim, 'buyer');
    const seller = trader(sim, 'seller');
    sim.deposit(buyer.account, 'USDC', a('1000'), 'collect-sim:buyer');
    sim.deposit(seller.account, 'BTC', a('1'), 'collect-sim:seller');
    await seller.run({ kind: 'approve_builder_fee', builder: BUILDER, maxFeeBps: a('10') });
    await buyer.run(order('buy', 'order:buyer:bid', null));
    await seller.run(order('sell', 'order:seller:ask', { builder: BUILDER, feeBps: a('5') }));
    // Earned: what the poster posts from the fill (0.3 USDC: 5 bps of 600).
    await ledger.post(
      recipes.builderFeeEarn({
        venueId: sim.venue.id,
        venueAccount: seller.account.owner,
        fillId: 'sim-fill-1',
        assetId: 'USDC',
        amount: a('0.3'),
        userId: USER,
      }),
    );

    const reader = claimReader(sim);
    expect(reader).not.toBeNull();
    expect(await collectBuilderFees({ reader, builder: BUILDER, ledger })).toMatchObject({ status: 'ran', read: 0, posted: 0 });

    const [claim] = sim.claimBuilderFees(BUILDER);
    const first = await collectBuilderFees({ reader, builder: BUILDER, ledger });
    const again = await collectBuilderFees({ reader, builder: BUILDER, ledger });
    expect(first).toEqual({ status: 'ran', venueId: sim.venue.id, read: 1, posted: 1, notOurs: 0, refused: [] });
    expect(again).toMatchObject({ read: 1, refused: [] });
    expect(ledger.journal().filter((t) => t.reason === 'trade.builder_fee.received')).toHaveLength(1);
    expect(await ledger.getTxByKey(`builder-fee-payout:${sim.venue.id}:${claim!.claimId}`)).not.toBeNull();
    // Our builder account at the venue now holds the claim; the venue owes us nothing more.
    expect(formatAmount((await ledger.balance(venueBuilderAccount(sim.venue.id, 'USDC'))).amount)).toBe('-0.3');
    expect(formatAmount((await ledger.balance(venueBuilderFeeReceivable(sim.venue.id, 'USDC'))).amount)).toBe('0');
  });

  it('a venue whose adapter reads no claim record has no reader, so the job waits and says why', async () => {
    const sim = new TestVenueSimulator({ clock: () => new Date(), markets: TEST_VENUE_MARKETS });
    const noClaims = Object.assign(Object.create(Object.getPrototypeOf(sim)), sim, { builderClaims: undefined });
    expect(claimReader(noClaims)).toBeNull();
    expect(await collectBuilderFees({ reader: null, builder: BUILDER, ledger: new MemoryLedger() })).toEqual({
      status: 'waiting',
      reason: 'trade.builder_fee_claim_read_missing',
    });
  });
});
