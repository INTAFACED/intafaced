import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { type PreparedVenueAction, type UserVenueAccount, type VenueIntent } from '@intafaced/venue-contracts';
import { CROSS_RULE, TEST_INSURANCE_FUND_START, TestVenueSimulator } from './simulator.js';
import { TEST_VENUE_MARKETS } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';

/**
 * J-derivatives-26 at the venue: cross positions share the account's equity; the TEST venue calls for margin below their
 * maintenance requirement, liquidates every cross position once equity falls to the account's liquidation level, takes
 * its fee into its TEST insurance fund, and on a gap past the account's equity ends the account at zero, the fund paying
 * the rest. Every figure is TEST.
 */

const a = parseAmount;
const XCRS = TEST_VENUE_MARKETS.find((m) => m.symbol === 'XCRS-PERP')!;

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
  let now = Date.UTC(2026, 10, 19, 6, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: [XCRS] });
  const maker = testWallet('jd26-maker');
  const makerAccount: UserVenueAccount = { venueId: sim.venue.id, owner: maker.address, subAccount: null };
  sim.deposit(makerAccount, 'USDC', a('100000'), 'chain:jd26:maker');
  const run = async (who: ReturnType<typeof testWallet>, account: UserVenueAccount, intent: VenueIntent) => {
    const prepared = await sim.prepare(account, who.signer, intent);
    const outcome = await sim.submit(prepared, await who.sign(prepared));
    now += 1000;
    return outcome;
  };
  const order = (side: 'buy' | 'sell', amount: string, price: string, key: string): VenueIntent => ({
    kind: 'place_order',
    symbol: 'XCRS-PERP',
    side,
    type: 'limit',
    amount: a(amount),
    price: a(price),
    timeInForce: key.startsWith('maker') ? 'GTC' : 'IOC',
    reduceOnly: false,
    clientOrderKey: key,
    builderFee: null,
  });
  const cross: VenueIntent = { kind: 'update_leverage', symbol: 'XCRS-PERP', leverageBps: 200_000, marginMode: 'cross' };
  await run(maker, makerAccount, cross);
  /** A person with TEST 300 USDC and a cross long of 50 XCRS-PERP at 100, 20x: maintenance 125, equity 297.75. */
  const person = async (name: string) => {
    const who = testWallet(name);
    const account: UserVenueAccount = { venueId: sim.venue.id, owner: who.address, subAccount: null };
    sim.deposit(account, 'USDC', a('300'), `chain:${name}`);
    await run(who, account, cross);
    expect(await run(maker, makerAccount, order('sell', '50', '100', `maker:${name}:ask`))).toMatchObject({ accepted: true });
    expect(await run(who, account, order('buy', '50', '100', `order:${name}:open`))).toMatchObject({ accepted: true });
    const usdc = async () => (await sim.balances(account)).value.find((b) => b.asset === 'USDC')!;
    const summary = async () => (await sim.accountSummary(account)).value;
    const position = async () => (await sim.positions(account)).value.find((p) => p.symbol === 'XCRS-PERP') ?? null;
    return { who, account, usdc, summary, position };
  };
  return { sim, run, person };
}

describe('TEST venue cross margin (J-derivatives-26)', () => {
  it('calls for margin below maintenance, moving nothing, then liquidates the account once at its liquidation level', async () => {
    const w = await world();
    const p = await w.person('jd26-one');
    const pos = (await p.position())!;
    expect(pos).toMatchObject({ side: 'long', marginMode: 'cross', liquidationPrice: { known: false } });
    const start = (await p.summary()).cross!;
    expect(start.state).toBe('healthy');
    expect(formatAmount(start.equity)).toBe('297.75');
    expect(formatAmount(start.maintenanceMargin)).toBe('125');
    expect(formatAmount(start.liquidationEquity)).toBe('62.5');
    expect(start.rule).toBe(CROSS_RULE);

    // Below maintenance: one margin call, and nothing moves.
    const before = await p.usdc();
    w.sim.setMark('XCRS-PERP', a('96.5'));
    const call = (await p.summary()).cross!;
    expect(call.state).toBe('margin_call');
    expect(formatAmount(call.equity)).toBe('122.75');
    expect(await p.usdc()).toEqual(before);
    expect((await w.sim.liquidations(p.account, new Date(0))).value).toEqual([]);
    // What the cross loss takes is not free to leave.
    const out = await w.sim.prepare(p.account, p.who.signer, {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('1'),
      destination: p.who.address,
    } as VenueIntent);
    expect(await w.sim.submit(out, await p.who.sign(out))).toMatchObject({ accepted: false, refusal: { code: 'insufficient_balance' } });

    // Just above the liquidation level: still a margin call.
    w.sim.setMark('XCRS-PERP', a('95.3'));
    expect((await p.summary()).cross!.state).toBe('margin_call');
    expect((await w.sim.liquidations(p.account, new Date(0))).value).toEqual([]);

    // At it: the venue closes the cross long at the mark, once, with its 1% fee into the fund.
    const fund = (await w.sim.insuranceFund()).value;
    w.sim.setMark('XCRS-PERP', a('95.29'));
    const [liq, ...more] = (await w.sim.liquidations(p.account, new Date(0))).value;
    expect(more).toEqual([]);
    expect(liq).toMatchObject({ symbol: 'XCRS-PERP', side: 'long', state: 'done' });
    expect(liq!.parts).toHaveLength(1);
    expect(liq!.parts[0]).toMatchObject({ feeAsset: 'USDC' });
    expect(formatAmount(liq!.parts[0]!.size)).toBe('50');
    expect(formatAmount(liq!.parts[0]!.price)).toBe('95.29');
    expect(formatAmount(liq!.parts[0]!.fee)).toBe('47.645');
    expect(formatAmount((await p.position())?.size ?? a('0'))).toBe('0');
    // 47.75 free + 250 margin − 235.5 loss − 47.645 fee.
    const after = await p.usdc();
    expect([formatAmount(after.free), formatAmount(after.locked)]).toEqual(['14.605', '0']);
    expect((await p.summary()).cross).toBeNull();
    const fundAfter = (await w.sim.insuranceFund()).value;
    expect(fund.known && fundAfter.known && formatAmount(fundAfter.value.balance)).toBe(
      formatAmount(a(TEST_INSURANCE_FUND_START) + a('47.645')),
    );

    // The mark again, and lower: nothing more.
    w.sim.setMark('XCRS-PERP', a('95.29'));
    w.sim.setMark('XCRS-PERP', a('90'));
    expect((await w.sim.liquidations(p.account, new Date(0))).value).toHaveLength(1);
    expect(await p.usdc()).toEqual(after);
  });

  it('on a gap past the account’s equity ends the account at zero, never below, the fund paying the rest', async () => {
    const w = await world();
    const p = await w.person('jd26-two');
    const fund = (await w.sim.insuranceFund()).value;
    // One step from 100 to 80: a 1000 loss on 297.75 of equity.
    w.sim.setMark('XCRS-PERP', a('80'));
    const [liq] = (await w.sim.liquidations(p.account, new Date(0))).value;
    expect(formatAmount(liq!.parts[0]!.price)).toBe('80');
    expect(formatAmount(liq!.parts[0]!.fee)).toBe('0');
    const after = await p.usdc();
    expect([formatAmount(after.free), formatAmount(after.locked), formatAmount(after.total)]).toEqual(['0', '0', '0']);
    const fundAfter = (await w.sim.insuranceFund()).value;
    // 297.75 − 1000: the fund pays 702.25.
    expect(fund.known && fundAfter.known && formatAmount(fund.value.balance - fundAfter.value.balance)).toBe('702.25');
  });
});
