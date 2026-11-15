import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  decodeVenueWire,
  encodeVenueWire,
  type PlaceUserOrderIntent,
  type UserVenueAccount,
  type UserVenueMarket,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';
import { TestVenueSimulator } from './simulator.js';

// J-derivatives-02 at the venue: the TEST perpetual XRSK-PERP publishes its margin tiers, what it takes as margin with
// its haircut, and an open-interest cap, and follows its own tiers. Every figure is TEST.

const a = parseAmount;
const XRSK = 'XRSK-PERP';

function world() {
  const now = Date.UTC(2026, 10, 15, 8, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: TEST_VENUE_MARKETS, chainId: 84532 });
  const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet tiers trader')));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const signer = { role: 'owner' as const, address: owner };
  const run = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, signer, intent);
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

const open = (amount: string, over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: XRSK,
  side: 'buy',
  type: 'limit',
  amount: a(amount),
  price: a('100'),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: `order:tiers-trader:open:${amount}`,
  builderFee: null,
  ...over,
});

const marketOf = async (w: ReturnType<typeof world>, symbol = XRSK) => (await w.sim.markets(null)).value.find((m) => m.symbol === symbol)!;

describe('TEST venue simulator: published margin tiers and collateral (J-derivatives-02)', () => {
  it('publishes XRSK-PERP tiers, its collateral with haircut and its open interest; BTC-PERP publishes neither list', async () => {
    const w = world();
    const m = await marketOf(w);
    expect(m.marginTiers).toEqual({
      known: true,
      value: [
        { fromNotional: a('0'), maxLeverageBps: 200_000, maintenanceRate: a('0.025') },
        { fromNotional: a('5000'), maxLeverageBps: 100_000, maintenanceRate: a('0.05') },
        { fromNotional: a('25000'), maxLeverageBps: 50_000, maintenanceRate: a('0.1') },
      ],
    });
    expect(m.collateral).toEqual({ known: true, value: [{ asset: 'USDC', haircut: { known: true, value: a('0') } }] });
    expect(m.openInterest).toEqual({ known: true, value: { size: a('0'), capSize: a('1000') } });
    const btc = await marketOf(w, 'BTC-PERP');
    expect(btc.marginTiers).toEqual({ known: false });
    expect(btc.collateral).toEqual({ known: false });
  });

  it('carries tiers and collateral over the wire as decimal strings and back exactly', async () => {
    const m = await marketOf(world());
    const wire = JSON.parse(JSON.stringify(encodeVenueWire(m))) as Record<string, any>;
    expect(wire.marginTiers.value[1]).toEqual({ fromNotional: '5000', maxLeverageBps: 100_000, maintenanceRate: '0.05' });
    expect(wire.collateral.value[0]).toEqual({ asset: 'USDC', haircut: { known: true, value: '0' } });
    const back = decodeVenueWire<UserVenueMarket>(wire);
    expect(back.marginTiers).toEqual(m.marginTiers);
    expect(back.collateral).toEqual(m.collateral);
  });

  it('refuses an open whose position notional reaches a tier that allows less leverage, naming the tier; a smaller one is taken', async () => {
    const w = world();
    w.sim.deposit(w.account, 'USDC', a('10000'), 'chain:tiers:d1');
    expect(await w.run({ kind: 'update_leverage', symbol: XRSK, leverageBps: 150_000, marginMode: 'isolated' })).toMatchObject({
      accepted: true,
    });
    // 60 XRSK at 100 is 6,000 USDC: tier 2, at most 10x; 15x is above it.
    const r = await refusal(w.sim.preview(w.account, open('60')));
    expect(r.code).toBe('leverage_above_cap');
    expect(r.detail).toBe('a position of 6000 USDC on XRSK-PERP is in tier 2, which allows at most 10x; 15x is above it');
    expect((await refusal(w.sim.prepare(w.account, w.signer, open('60')))).code).toBe('leverage_above_cap');
    // 40 XRSK is 4,000 USDC: tier 1, up to 20x.
    expect((await w.sim.preview(w.account, open('40'))).value).toBeTruthy();
  });

  it('refuses an open past the open-interest cap with the cap and the open size named', async () => {
    const w = world();
    w.sim.deposit(w.account, 'USDC', a('10000'), 'chain:tiers:d2');
    await w.run({ kind: 'update_leverage', symbol: XRSK, leverageBps: 20_000, marginMode: 'isolated' });
    w.sim.setOpenInterestCap(XRSK, a('5'));
    const r = await refusal(w.sim.preview(w.account, open('6')));
    expect(r.code).toBe('open_interest_above_cap');
    expect(r.detail).toBe(
      `${w.sim.venue.displayName} caps XRSK-PERP's open interest at 5 XRSK; 0 XRSK is open, so 6 XRSK more would pass the cap`,
    );
  });
});
