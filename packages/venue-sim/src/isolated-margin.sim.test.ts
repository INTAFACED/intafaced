import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { add, div, formatAmount, parseAmount, sub } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueIntent,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import { TestVenueSimulator, type SimMarketConfig } from './simulator.js';
import type { TestVenueTypedData } from './signing.js';

/**
 * J-derivatives-06 #1 #2 #3 at the venue: the account's margin summary as the TEST venue reports it, and one signed
 * margin change on an isolated position: an addition moves free into the position's margin once, and a removal is
 * allowed down to the venue's limit (its entry value at its leverage) and refused in words past it, before anything is
 * signed and again at submit. Every figure is TEST.
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
  const person = testWallet('jd06-person');
  const maker = testWallet('jd06-maker');
  const main: UserVenueAccount = { venueId: sim.venue.id, owner: person.address, subAccount: null };
  const makerAccount: UserVenueAccount = { venueId: sim.venue.id, owner: maker.address, subAccount: null };
  sim.deposit(main, 'USDC', a(funds), 'chain:jd06:person');
  sim.deposit(makerAccount, 'USDC', a('100000'), 'chain:jd06:maker');
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
  accepted(await run(maker, makerAccount, order('sell', 'order:jd06-maker:1', 'GTC')));
  // The person's long: 0.01 BTC at 60000, margin 60 at 10x.
  accepted(await run(person, main, leverage(100_000)));
  accepted(await run(person, main, order('buy', 'order:jd06-person:1', 'IOC')));
  const margin = (direction: 'add' | 'remove', amount: string, key: string): VenueIntent => ({
    kind: 'update_isolated_margin',
    symbol: 'BTC-PERP',
    direction,
    amount: a(amount),
    changeKey: `margin:jd06-person:${key}`,
  });
  const usdc = async () => (await sim.balances(main)).value.find((b) => b.asset === 'USDC')!;
  return { sim, person, main, run, leverage, margin, usdc, maker, makerAccount };
}

function accepted(outcome: VenueSubmitOutcome) {
  if (!outcome.definite || !outcome.accepted) throw new Error(`expected accepted, got ${JSON.stringify(outcome)}`);
  return outcome;
}

describe('TEST venue simulator: J-derivatives-06 isolated margin', () => {
  it('reports the account summary: equity, free, used margin, maintenance and the ratio, exact', async () => {
    const w = await world();
    const s = (await w.sim.accountSummary(w.main)).value;
    const b = await w.usdc();
    // 1000 in, 60 margin at 10x, the taker fee paid; the mark still at entry, so no unrealised result.
    expect(s).toMatchObject({ asset: 'USDC', free: b.free, usedMargin: a('60'), maintenanceMargin: a('3') });
    expect(s.equity).toBe(add(b.free, b.locked));
    expect(s.marginRatio).toEqual({ known: true, value: div(a('3'), s.equity, 'ceil') });
  });

  it('adds margin once: free to the position, and the liquidation price moves away', async () => {
    const w = await world();
    const before = await w.usdc();
    const read = (await w.sim.isolatedMargin(w.main, 'BTC-PERP')).value;
    expect(read).toMatchObject({ margin: a('60'), minimumMargin: a('60'), removable: a('0'), free: before.free, asset: 'USDC' });
    const liqBefore = read.liquidationPrice;
    const prepared = await w.sim.prepare(w.main, w.person.signer, w.margin('add', '5.123456', 'a1'));
    const signature = await w.person.sign(prepared);
    accepted(await w.sim.submit(prepared, signature));
    // The same signed change sent again is the same answer, and moves nothing more.
    accepted(await w.sim.submit(prepared, signature));
    const after = await w.usdc();
    expect(after.free).toBe(sub(before.free, a('5.123456')));
    expect(after.locked).toBe(add(before.locked, a('5.123456')));
    const now = (await w.sim.isolatedMargin(w.main, 'BTC-PERP')).value;
    expect(now).toMatchObject({ margin: a('65.123456'), removable: a('5.123456') });
    expect(liqBefore.known && now.liquidationPrice.known && now.liquidationPrice.value < liqBefore.value).toBe(true);
  });

  it('removes margin down to the limit; one past it is refused in words before signing and at submit, moving nothing', async () => {
    const w = await world();
    accepted(await w.run(w.person, w.main, w.margin('add', '10', 'a1')));
    await expect(w.sim.prepare(w.main, w.person.signer, w.margin('remove', '10.000001', 'r0'))).rejects.toThrow(
      /below this venue's minimum of 60 .*at most 10 can be removed/,
    );
    accepted(await w.run(w.person, w.main, w.margin('remove', '4', 'r1')));
    expect((await w.sim.isolatedMargin(w.main, 'BTC-PERP')).value).toMatchObject({ margin: a('66'), removable: a('6') });
    // At submit too: a removal prepared while it fitted, sent after the room left is gone, is refused.
    const late = await w.sim.prepare(w.main, w.person.signer, w.margin('remove', '6', 'r2'));
    accepted(await w.run(w.person, w.main, w.margin('remove', '1', 'r3')));
    const before = await w.usdc();
    const outcome = await w.sim.submit(late, await w.person.sign(late));
    expect(outcome.definite && !outcome.accepted && outcome.refusal).toMatchObject({ code: 'venue_rejected' });
    expect(await w.usdc()).toEqual(before);
    accepted(await w.run(w.person, w.main, w.margin('remove', '5', 'r4')));
    expect((await w.sim.isolatedMargin(w.main, 'BTC-PERP')).value).toMatchObject({ margin: a('60'), removable: a('0') });
  });

  it('refuses an addition free cannot cover, and a change with no position open', async () => {
    const w = await world();
    const free = (await w.usdc()).free;
    const outcome = await w.run(w.person, w.main, w.margin('add', formatAmount(add(free, a('1'))), 'big'));
    expect(outcome.definite && !outcome.accepted && outcome.refusal.code).toBe('insufficient_balance');
    const flat: UserVenueAccount = { venueId: w.sim.venue.id, owner: testWallet('jd06-flat').address, subAccount: null };
    await expect(w.sim.isolatedMargin(flat, 'BTC-PERP')).rejects.toBeInstanceOf(VenueRefusalError);
    await expect(w.sim.prepare(flat, { role: 'owner', address: flat.owner }, w.margin('add', '1', 'flat'))).rejects.toThrow(
      /no position is open/,
    );
  });
});
