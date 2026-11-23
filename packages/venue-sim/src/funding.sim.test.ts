import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { add, formatAmount, parseAmount, sub } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type PreparedVenueAction, type UserVenueAccount, type VenueIntent } from '@intafaced/venue-contracts';
import { TestVenueSimulator } from './simulator.js';
import { TEST_VENUE_MARKETS } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';

/**
 * J-derivatives-08 at the venue: the TEST venue builds XFND-PERP's funding rate from its mark and index, publishes its
 * inputs, and closes a period on its TEST control, booking one payment per open position on its margin: longs pay on a
 * positive rate and receive on a negative one. A period with no published rate books nothing. Every figure is TEST.
 */

const a = parseAmount;
const XFND = TEST_VENUE_MARKETS.find((m) => m.symbol === 'XFND-PERP')!;
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
  let now = Date.UTC(2026, 10, 18, 6, 10, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: [XFND, BTC] });
  const person = testWallet('jd08-person');
  const maker = testWallet('jd08-maker');
  const main: UserVenueAccount = { venueId: sim.venue.id, owner: person.address, subAccount: null };
  const makerAccount: UserVenueAccount = { venueId: sim.venue.id, owner: maker.address, subAccount: null };
  sim.deposit(main, 'USDC', a('1000'), 'chain:jd08:person');
  sim.deposit(makerAccount, 'USDC', a('100000'), 'chain:jd08:maker');
  const run = async (who: ReturnType<typeof testWallet>, account: UserVenueAccount, intent: VenueIntent) => {
    const prepared = await sim.prepare(account, who.signer, intent);
    const outcome = await sim.submit(prepared, await who.sign(prepared));
    now += 1000;
    return outcome;
  };
  const order = (side: 'buy' | 'sell', amount: string, price: string, key: string): VenueIntent => ({
    kind: 'place_order',
    symbol: 'XFND-PERP',
    side,
    type: 'limit',
    amount: a(amount),
    price: a(price),
    timeInForce: key.startsWith('maker') ? 'GTC' : 'IOC',
    reduceOnly: false,
    clientOrderKey: key,
    builderFee: null,
  });
  const leverage: VenueIntent = { kind: 'update_leverage', symbol: 'XFND-PERP', leverageBps: 50_000, marginMode: 'isolated' };
  await run(maker, makerAccount, leverage);
  await run(person, main, leverage);
  await run(maker, makerAccount, order('sell', '10', '100', 'maker:jd08:ask'));
  await run(person, main, order('buy', '10', '100', 'order:jd08:open'));
  const market = async () => (await sim.markets(null)).value.find((m) => m.symbol === 'XFND-PERP')!;
  const margin = async (who: UserVenueAccount) => (await sim.positions(who)).value.find((p) => p.symbol === 'XFND-PERP')!.margin;
  const since = new Date(now - 3_600_000);
  return { sim, main, makerAccount, market, margin, since, tick: () => (now += 1000) };
}

describe('TEST venue funding (J-derivatives-08)', () => {
  it('publishes the rate it builds from mark and index, with its inputs and the next period it closes', async () => {
    const w = await world();
    const m = await w.market();
    expect(m.funding.known).toBe(true);
    if (!m.funding.known) return;
    const f = m.funding.value;
    // Mark 100, index 100: no premium, so the rate is the interest component alone.
    expect(formatAmount(f.rate)).toBe('0.0000125');
    expect(f.intervalSeconds).toBe(3600);
    expect(f.nextFundingAt.toISOString()).toBe('2026-11-18T07:00:00.000Z');
    expect(f.inputs).toMatchObject({ known: true });
    if (!f.inputs?.known) return;
    expect(formatAmount(f.inputs.value.premium)).toBe('0');
    expect(formatAmount(f.inputs.value.interestRate)).toBe('0.0000125');
    expect(formatAmount(f.inputs.value.rateCap)).toBe('0.04');
    expect(formatAmount(f.inputs.value.markPrice)).toBe('100');
    expect(formatAmount(f.inputs.value.indexPrice)).toBe('100');
    expect(f.inputs.value.rule.known).toBe(true);
  });

  it('closes a period: one payment per position, longs paying shorts on a positive rate, on the margin, kept in its history', async () => {
    const w = await world();
    const before = { person: await w.margin(w.main), maker: await w.margin(w.makerAccount) };
    const closed = w.sim.settleFunding('XFND-PERP');
    expect(closed).toMatchObject({ payments: 2 });
    expect(closed.periodAt.toISOString()).toBe('2026-11-18T07:00:00.000Z');
    const [paid] = (await w.sim.fundingPayments(w.main, w.since)).value;
    // 10 × 100 × 0.0000125 = 0.0125, paid by the long.
    expect(paid).toMatchObject({ symbol: 'XFND-PERP', side: 'long', asset: 'USDC' });
    expect(formatAmount(paid!.amount)).toBe('-0.0125');
    expect(formatAmount(paid!.size)).toBe('10');
    expect(formatAmount(paid!.markPrice)).toBe('100');
    const [received] = (await w.sim.fundingPayments(w.makerAccount, w.since)).value;
    expect(formatAmount(received!.amount)).toBe('0.0125');
    expect(await w.margin(w.main)).toBe(add(before.person, paid!.amount));
    expect(await w.margin(w.makerAccount)).toBe(add(before.maker, received!.amount));
    // The next period starts an interval later; the closed one is in the venue's funding history with its premium.
    const m = await w.market();
    expect(m.funding.known && m.funding.value.nextFundingAt.toISOString()).toBe('2026-11-18T08:00:00.000Z');
    const history = (await w.sim.fundingHistory('XFND-PERP', w.since)).value;
    expect(
      history.map((r) => [r.fundingAt.toISOString(), formatAmount(r.rate), r.premium === null ? null : formatAmount(r.premium!)]),
    ).toEqual([['2026-11-18T07:00:00.000Z', '0.0000125', '0']]);
  });

  it('flips the payer on a negative rate: the long receives', async () => {
    const w = await world();
    w.sim.setIndex('XFND-PERP', a('100.5'));
    const m = await w.market();
    // (100 − 100.5) ÷ 100.5 = −0.004975124378…, to eight places toward zero, plus 0.0000125.
    expect(m.funding.known && m.funding.value.inputs?.known && formatAmount(m.funding.value.inputs.value.premium)).toBe('-0.00497512');
    expect(m.funding.known && formatAmount(m.funding.value.rate)).toBe('-0.00496262');
    w.sim.settleFunding('XFND-PERP');
    const [p] = (await w.sim.fundingPayments(w.main, w.since)).value;
    expect(formatAmount(p!.amount)).toBe('4.96262');
    const [q] = (await w.sim.fundingPayments(w.makerAccount, w.since)).value;
    expect(formatAmount(q!.amount)).toBe('-4.96262');
    // The venue's net on the market is zero here, by its own booking; we never compute it.
    expect(add(p!.amount, q!.amount)).toBe(0n);
  });

  it('holds the rate within its cap either way', async () => {
    const w = await world();
    w.sim.setMark('XFND-PERP', a('110'));
    const m = await w.market();
    expect(m.funding.known && formatAmount(m.funding.value.rate)).toBe('0.04');
    w.sim.setMark('XFND-PERP', a('90'));
    const n = await w.market();
    expect(n.funding.known && formatAmount(n.funding.value.rate)).toBe('-0.04');
  });

  it('publishes no rate for a period: the market says so and closing it books nothing', async () => {
    const w = await world();
    const before = await w.margin(w.main);
    w.sim.setFundingPublished('XFND-PERP', false);
    expect((await w.market()).funding).toEqual({ known: false });
    expect(w.sim.settleFunding('XFND-PERP')).toMatchObject({ rate: null, payments: 0 });
    expect((await w.sim.fundingPayments(w.main, w.since)).value).toEqual([]);
    expect((await w.sim.fundingHistory('XFND-PERP', w.since)).value).toEqual([]);
    expect(await w.margin(w.main)).toBe(before);
    w.sim.setFundingPublished('XFND-PERP', true);
    expect(w.sim.settleFunding('XFND-PERP')).toMatchObject({ payments: 2 });
    expect(sub(await w.margin(w.main), before)).toBe(a('-0.0125'));
  });

  it('keeps mark and index samples; an index it does not publish answers not known with its reason', async () => {
    const w = await world();
    w.tick();
    w.sim.setMark('XFND-PERP', a('101'));
    w.tick();
    w.sim.setIndex('XFND-PERP', a('100.2'));
    const since = new Date(0);
    const mark = (await w.sim.priceHistory('XFND-PERP', 'mark', since)).value;
    expect(mark.known && mark.value.map((x) => formatAmount(x.price))).toEqual(['100', '101']);
    const index = (await w.sim.priceHistory('XFND-PERP', 'index', since)).value;
    expect(index.known && index.value.map((x) => formatAmount(x.price))).toEqual(['100', '100.2']);
    w.sim.setIndexPublished('XFND-PERP', false);
    expect((await w.sim.priceHistory('XFND-PERP', 'index', since)).value).toEqual({
      known: false,
      reason: 'TEST venue simulator publishes no index for XFND-PERP',
    });
    const m = await w.market();
    expect(m.index).toEqual({ known: false });
    expect(m.funding.known && m.funding.value.inputs).toEqual({ known: false });
  });

  it('refuses funding controls on a market that settles none', async () => {
    const w = await world();
    expect(() => w.sim.settleFunding('BTC-PERP')).toThrow(VenueRefusalError);
  });
});
