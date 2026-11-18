import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { add, parseAmount, sub, ZERO } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  positionModesOf,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueIntent,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import { TestVenueSimulator, type SimMarketConfig } from './simulator.js';
import type { TestVenueTypedData } from './signing.js';

/**
 * J-derivatives-05 #2 #3 #4 at the venue: the TEST venue holds one net position per contract; it reports each position's maintenance margin; and a leverage change on an open position states the margin
 * difference before anything is signed, then posts or releases exactly that difference, once. Every figure is TEST.
 */

const a = parseAmount;

function testWallet(name: string) {
  const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet ${name}`)));
  const address = key.address.toLowerCase();
  return {
    address,
    signer: { role: 'owner', address } as const,
    async sign(prepared: PreparedVenueAction) {
      const typed = prepared.typedData as TestVenueTypedData;
      const signature = await key.signTypedData({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      });
      return { digest: prepared.digest, signature, signedBy: address };
    },
  };
}

const PERP: SimMarketConfig = {
  symbol: 'BTC-PERP',
  kind: 'perpetual',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC'],
  marginModes: ['isolated'],
  maxLeverageBps: 200_000,
  tickSize: a('1'),
  lotSize: a('0.001'),
  makerFeeBps: { known: true, value: a('1.5') },
  takerFeeBps: { known: true, value: a('4.5') },
  maintenanceMarginRate: a('0.005'),
  markPrice: a('60000'),
};

async function world(funds = '1000') {
  let now = Date.UTC(2026, 10, 18, 6, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: [PERP] });
  const person = testWallet('jd05-person');
  const maker = testWallet('jd05-maker');
  const main: UserVenueAccount = { venueId: sim.venue.id, owner: person.address, subAccount: null };
  const makerAccount: UserVenueAccount = { venueId: sim.venue.id, owner: maker.address, subAccount: null };
  sim.deposit(main, 'USDC', a(funds), 'chain:jd05:person');
  sim.deposit(makerAccount, 'USDC', a('100000'), 'chain:jd05:maker');
  const run = async (who: ReturnType<typeof testWallet>, account: UserVenueAccount, intent: VenueIntent) => {
    const prepared = await sim.prepare(account, who.signer, intent);
    const outcome = await sim.submit(prepared, await who.sign(prepared));
    now += 1000;
    return outcome;
  };
  const leverage = (leverageBps: number): VenueIntent => ({
    kind: 'update_leverage',
    symbol: 'BTC-PERP',
    leverageBps,
    marginMode: 'isolated',
  });
  const order = (side: 'buy' | 'sell', key: string, timeInForce: 'GTC' | 'IOC'): VenueIntent => ({
    kind: 'place_order',
    symbol: 'BTC-PERP',
    side,
    type: 'limit',
    amount: a('0.01'),
    price: a('60000'),
    timeInForce,
    reduceOnly: false,
    clientOrderKey: key,
    builderFee: null,
  });
  accepted(await run(maker, makerAccount, leverage(100_000)));
  accepted(await run(maker, makerAccount, order('sell', 'order:jd05-maker:1', 'GTC')));
  // The person's long: 0.01 BTC at 60000, margin 60 at 10x.
  accepted(await run(person, main, leverage(100_000)));
  accepted(await run(person, main, order('buy', 'order:jd05-person:1', 'IOC')));
  const usdc = async () => (await sim.balances(main)).value.find((b) => b.asset === 'USDC')!;
  return { sim, person, main, run, leverage, usdc };
}

function accepted(outcome: VenueSubmitOutcome) {
  if (!outcome.definite || !outcome.accepted) throw new Error(`expected accepted, got ${JSON.stringify(outcome)}`);
  return outcome;
}

describe('TEST venue simulator: J-derivatives-05 positions', () => {
  it('declares one-way only, as the venue it stands for', () => {
    const sim = new TestVenueSimulator({ clock: () => new Date(), markets: [PERP] });
    expect(positionModesOf(sim.venue)).toEqual(['one_way']);
  });

  it('reports the maintenance margin of a position: entry notional at the maintenance rate', async () => {
    const w = await world();
    const [p] = (await w.sim.positions(w.main)).value;
    expect(p).toMatchObject({ size: a('0.01'), entryPrice: a('60000'), margin: a('60'), leverageBps: 100_000 });
    expect(p!.maintenanceMargin).toEqual({ known: true, value: a('3') });
  });

  it('states the margin difference before signing, and the signed change posts exactly that from free, once', async () => {
    const w = await world();
    const before = await w.usdc();
    const change = (await w.sim.leverageChange(w.main, 'BTC-PERP', 50_000, 'isolated')).value;
    expect(change).toEqual({
      symbol: 'BTC-PERP',
      leverageBps: 50_000,
      marginMode: 'isolated',
      maxLeverageBps: 200_000,
      positionSize: a('0.01'),
      marginNow: a('60'),
      marginAfter: a('120'),
      difference: a('60'),
    });
    // Nothing changed by the read.
    expect(await w.usdc()).toEqual(before);
    accepted(await w.run(w.person, w.main, w.leverage(50_000)));
    const after = await w.usdc();
    expect(after.free).toBe(sub(before.free, change.difference));
    expect(after.locked).toBe(add(before.locked, change.difference));
    const [p] = (await w.sim.positions(w.main)).value;
    expect(p).toMatchObject({ margin: a('120'), leverageBps: 50_000 });
  });

  it('a higher leverage releases the difference to free', async () => {
    const w = await world();
    const before = await w.usdc();
    const change = (await w.sim.leverageChange(w.main, 'BTC-PERP', 200_000, 'isolated')).value;
    expect(change.difference).toBe(a('-30'));
    accepted(await w.run(w.person, w.main, w.leverage(200_000)));
    expect((await w.usdc()).free).toBe(add(before.free, a('30')));
  });

  it('refuses a leverage above the published cap, on the read and at prepare; a change free cannot cover moves nothing', async () => {
    const w = await world('100');
    await expect(w.sim.leverageChange(w.main, 'BTC-PERP', 210_000, 'isolated')).rejects.toBeInstanceOf(VenueRefusalError);
    await expect(w.sim.prepare(w.main, w.person.signer, w.leverage(210_000))).rejects.toBeInstanceOf(VenueRefusalError);
    const before = await w.usdc();
    // 5x needs 60 more margin; free is under 40.
    const outcome = await w.run(w.person, w.main, w.leverage(50_000));
    expect(outcome.definite && !outcome.accepted && outcome.refusal.code).toBe('insufficient_balance');
    expect(await w.usdc()).toEqual(before);
    expect((await w.sim.positions(w.main)).value[0]).toMatchObject({ margin: a('60'), leverageBps: 100_000 });
  });

  it('with no position open, every margin figure is zero', async () => {
    const sim = new TestVenueSimulator({ clock: () => new Date(), markets: [PERP] });
    const account = { venueId: sim.venue.id, owner: testWallet('jd05-flat').address, subAccount: null };
    expect((await sim.leverageChange(account, 'BTC-PERP', 50_000, 'isolated')).value).toMatchObject({
      positionSize: ZERO,
      marginNow: ZERO,
      marginAfter: ZERO,
      difference: ZERO,
    });
  });
});
