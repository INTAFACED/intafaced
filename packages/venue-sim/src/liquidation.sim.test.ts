import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { add, formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  encodeVenueWire,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { TEST_ADL_RULES, TEST_INSURANCE_FUND_START, TestVenueSimulator } from './simulator.js';
import { TEST_VENUE_MARKETS } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';

/**
 * J-derivatives-07 at the venue: the TEST venue liquidates a position its mark reaches, in two parts, charges its fee
 * into its TEST insurance fund, publishes its auto-deleveraging rules, deleverages an account it is told to, and keeps
 * public alerts with no account in them. Every figure is TEST.
 */

const a = parseAmount;
const XLIQ = TEST_VENUE_MARKETS.find((m) => m.symbol === 'XLIQ-PERP')!;
const BTC = TEST_VENUE_MARKETS.find((m) => m.symbol === 'BTC-PERP')!;

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

async function world() {
  let now = Date.UTC(2026, 10, 18, 6, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: [XLIQ, BTC] });
  const person = testWallet('jd07-person');
  const maker = testWallet('jd07-maker');
  const main: UserVenueAccount = { venueId: sim.venue.id, owner: person.address, subAccount: null };
  const makerAccount: UserVenueAccount = { venueId: sim.venue.id, owner: maker.address, subAccount: null };
  sim.deposit(main, 'USDC', a('1000'), 'chain:jd07:person');
  sim.deposit(makerAccount, 'USDC', a('100000'), 'chain:jd07:maker');
  const run = async (who: ReturnType<typeof testWallet>, account: UserVenueAccount, intent: VenueIntent) => {
    const prepared = await sim.prepare(account, who.signer, intent);
    const outcome = await sim.submit(prepared, await who.sign(prepared));
    now += 1000;
    return outcome;
  };
  const order = (side: 'buy' | 'sell', amount: string, price: string, key: string): VenueIntent => ({
    kind: 'place_order',
    symbol: 'XLIQ-PERP',
    side,
    type: 'limit',
    amount: a(amount),
    price: a(price),
    timeInForce: key.startsWith('maker') || key.endsWith(':rest') ? 'GTC' : 'IOC',
    reduceOnly: false,
    clientOrderKey: key,
    builderFee: null,
  });
  const leverage: VenueIntent = { kind: 'update_leverage', symbol: 'XLIQ-PERP', leverageBps: 100_000, marginMode: 'isolated' };
  await run(maker, makerAccount, leverage);
  await run(person, main, leverage);
  const usdc = async () => (await sim.balances(main)).value.find((b) => b.asset === 'USDC')!;
  const position = async () => (await sim.positions(main)).value.find((p) => p.symbol === 'XLIQ-PERP') ?? null;
  const tick = () => {
    now += 1000;
  };
  return { sim, person, maker, main, makerAccount, run, order, usdc, position, tick };
}

describe('TEST venue liquidation (J-derivatives-07)', () => {
  it('liquidates half a long at the mark that reaches its liquidation price, refuses changes meanwhile, then closes the rest', async () => {
    const w = await world();
    expect(await w.run(w.maker, w.makerAccount, w.order('sell', '5', '100.1', 'maker:jd07:ask'))).toMatchObject({
      definite: true,
      accepted: true,
    });
    expect(await w.run(w.person, w.main, w.order('buy', '1', '100.1', 'order:jd07:open'))).toMatchObject({
      definite: true,
      accepted: true,
    });
    // A resting order of the person's on the market, which the liquidation cancels.
    expect(await w.run(w.person, w.main, w.order('buy', '1', '80', 'order:jd07:rest'))).toMatchObject({ definite: true, accepted: true });
    const p = (await w.position())!;
    expect(p.liquidationPrice.known).toBe(true);
    const liq = p.liquidationPrice.known ? p.liquidationPrice.value : a('0');
    expect(formatAmount(liq)).toBe('92.092');
    expect((await w.sim.liquidationStatus(w.main, 'XLIQ-PERP')).value).toMatchObject({ state: 'none', liquidationId: null });
    const freeBefore = (await w.usdc()).free;
    const [resting] = (await w.sim.openOrders(w.main)).value;
    expect(resting).toMatchObject({ venueClientOrderId: expect.any(String), status: 'open' });

    // Above the liquidation price: nothing happens.
    w.sim.setMark('XLIQ-PERP', a('92.1'));
    expect((await w.sim.liquidationStatus(w.main, 'XLIQ-PERP')).value.state).toBe('none');

    // The mark reaches it: half the long closes at the mark, the fee is 1% of its value, and it is in progress.
    w.tick();
    w.sim.setMark('XLIQ-PERP', a('92'));
    const status = (await w.sim.liquidationStatus(w.main, 'XLIQ-PERP')).value;
    expect(status).toMatchObject({ state: 'in_progress', liquidationId: 'liq-1' });
    expect(status.priceRule).toContain('closes half the position at the mark');
    expect(status.feeRule).toContain('1% of each part');
    expect(formatAmount((await w.position())!.size)).toBe('0.5');
    expect((await w.sim.openOrders(w.main)).value).toEqual([]);
    const [first] = (await w.sim.liquidations(w.main, new Date(0))).value;
    expect(first!.parts).toHaveLength(1);
    expect(first!.parts[0]).toMatchObject({ partId: 'liq-1-1', feeAsset: 'USDC' });
    expect(formatAmount(first!.parts[0]!.size)).toBe('0.5');
    expect(formatAmount(first!.parts[0]!.price)).toBe('92');
    expect(formatAmount(first!.parts[0]!.fee)).toBe('0.46');
    // Margin released 5.005, result -4.05, fee 0.46: 0.495 back to free, and the cancelled order's lock with it.
    expect((await w.usdc()).free).toBe(add(add(freeBefore, resting!.locked), a('0.495')));

    // Meanwhile the venue takes no change to the position, in words, at prepare.
    const margin: VenueIntent = {
      kind: 'update_isolated_margin',
      symbol: 'XLIQ-PERP',
      direction: 'add',
      amount: a('5'),
      changeKey: 'margin:jd07:add:1',
    };
    await expect(w.sim.prepare(w.main, w.person.signer, margin)).rejects.toThrow(VenueRefusalError);
    await expect(w.sim.prepare(w.main, w.person.signer, margin)).rejects.toThrow(/XLIQ-PERP is being liquidated \(liq-1\)/);
    // Another market is not held.
    await expect(
      w.sim.prepare(w.main, w.person.signer, { kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' }),
    ).resolves.toBeTruthy();

    // The next mark closes the rest; its fee is capped at what the part leaves.
    w.tick();
    w.sim.setMark('XLIQ-PERP', a('91'));
    expect((await w.sim.liquidationStatus(w.main, 'XLIQ-PERP')).value.state).toBe('done');
    expect(await w.position()).toBeNull();
    const [done] = (await w.sim.liquidations(w.main, new Date(0))).value;
    expect(done!.state).toBe('done');
    expect(done!.parts.map((x) => [x.partId, formatAmount(x.size), formatAmount(x.price), formatAmount(x.fee)])).toEqual([
      ['liq-1-1', '0.5', '92', '0.46'],
      ['liq-1-2', '0.5', '91', '0.455'],
    ]);
    // Done, a change is taken again.
    await expect(w.sim.prepare(w.main, w.person.signer, margin)).rejects.toThrow(/venue_rejected: no po/);

    // The fund rose by exactly the two fees.
    const fund = (await w.sim.insuranceFund()).value;
    expect(fund.known).toBe(true);
    if (fund.known) expect(formatAmount(fund.value.balance)).toBe(formatAmount(add(a(TEST_INSURANCE_FUND_START), a('0.915'))));

    // The public alerts name the market, side, size and price, newest first, and no account.
    const alerts = (await w.sim.liquidationAlerts('XLIQ-PERP', 10)).value;
    expect(alerts.map((x) => [x.kind, x.side, formatAmount(x.size), formatAmount(x.price)])).toEqual([
      ['liquidation', 'long', '0.5', '91'],
      ['liquidation', 'long', '0.5', '92'],
    ]);
    expect(JSON.stringify(encodeVenueWire(alerts))).not.toContain(w.person.address);
  });

  it('a market it runs no liquidation on refuses the read in words', async () => {
    const w = await world();
    await expect(w.sim.liquidationStatus(w.main, 'BTC-PERP')).rejects.toThrow(/runs no liquidation on BTC-PERP/);
  });

  it('publishes its fund or none, never a zero, and its auto-deleveraging rules by version', async () => {
    const w = await world();
    w.sim.setInsuranceFundPublished(false);
    expect((await w.sim.insuranceFund()).value).toEqual({ known: false });
    w.sim.setInsuranceFundPublished(true);
    expect((await w.sim.adlRules()).value).toEqual(TEST_ADL_RULES);
    w.sim.setAdlRules({ version: 'TEST-adl-2', text: 'TEST rule: new words.' });
    expect((await w.sim.adlRules()).value).toEqual({ version: 'TEST-adl-2', text: 'TEST rule: new words.' });
    w.sim.setAdlRules(null);
    expect((await w.sim.adlRules()).value).toBeNull();
  });

  it('deleverages a short at the price it is given, with no fee and its notice, and alerts it without the account', async () => {
    const w = await world();
    expect(await w.run(w.maker, w.makerAccount, w.order('buy', '5', '99.9', 'maker:jd07:bid'))).toMatchObject({
      definite: true,
      accepted: true,
    });
    expect(await w.run(w.person, w.main, w.order('sell', '1', '99.9', 'order:jd07:short'))).toMatchObject({
      definite: true,
      accepted: true,
    });
    const before = await w.usdc();
    const p = (await w.position())!;
    const d = w.sim.deleverage(w.main, 'XLIQ-PERP', a('95'));
    expect(d).toMatchObject({ adlId: 'adl-1', symbol: 'XLIQ-PERP', side: 'short' });
    expect(formatAmount(d.realisedPnl)).toBe('4.9');
    expect(d.notice).toContain('auto-deleveraging closed your short of 1 XLIQ-PERP at 95');
    expect(await w.position()).toBeNull();
    // Margin and result back to free; nothing charged.
    expect((await w.usdc()).free).toBe(add(add(before.free, p.margin), a('4.9')));
    expect((await w.sim.deleverages(w.main, new Date(0))).value).toEqual([d]);
    const [alert] = (await w.sim.liquidationAlerts(null, 5)).value;
    expect(alert).toMatchObject({ kind: 'deleverage', symbol: 'XLIQ-PERP', side: 'short', size: a('1'), price: a('95') });
    expect(() => w.sim.deleverage(w.main, 'XLIQ-PERP', a('95'))).toThrow(/no open position/);
  });
});
