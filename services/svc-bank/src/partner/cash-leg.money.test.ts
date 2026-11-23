import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import {
  NO_CASH_LEGS,
  parseCashLegRates,
  testCashLegFor,
  testPartnerCashLegs,
  testVenuePayout,
  type CashLegAsk,
  type CashLegPayout,
} from './cash-leg.js';
import { partnerPayoutsAccount } from './partner-bank.js';
import { testPartner, testPartnerCustody } from './test-partner.js';

/**
 * The partner's cash leg of a cash convert (J-cex-spot-11 #11). Money invariants: one key is one cash move and one coin
 * payout, however often it is asked; a refusal moves nothing; the cash taken and the coin paid follow the partner's rate,
 * rounded against nobody but down to the coin's smallest unit.
 */

const OWNER = '0x1111111111111111111111111111111111111111';
const KEY = `convert-cash:${OWNER}:quote_0001`;
const ask = (over: Partial<CashLegAsk> = {}): CashLegAsk => ({
  key: KEY,
  cash: 'EUR',
  coin: 'USDC',
  spend: parseAmount('20'),
  least: parseAmount('21.6'),
  venue: { venueId: 'test-venue', owner: OWNER },
  ...over,
});

function world(opts: { failPayouts?: number } = {}) {
  const partner = testPartner();
  partner.set('u1', { custody: 'off' });
  partner.fund('u1', { fundId: 'f1', assetId: 'EUR', amount: parseAmount('100') });
  const paid: { ref: string; amount: bigint }[] = [];
  const asked: string[] = [];
  let failures = opts.failPayouts ?? 0;
  const payout: CashLegPayout = {
    async pay({ ref, amount }) {
      asked.push(ref);
      if (failures > 0) {
        failures -= 1;
        throw new Error('lost');
      }
      // The venue credits a reference once.
      if (!paid.some((p) => p.ref === ref)) paid.push({ ref, amount });
    },
  };
  const legs = testPartnerCashLegs({
    partner,
    custody: testPartnerCustody(partner),
    custodyLayer: 'on',
    rates: parseCashLegRates('EUR:USDC:1.08')!,
    payout,
  });
  const eur = () => partner.record('u1').accounts.find((a) => a.account.userId === 'u1' && a.account.assetId === 'EUR')?.amount;
  const moves = () => partner.record('u1').moves.filter((m) => m.key === KEY);
  return { partner, legs, paid, asked, eur, moves };
}

describe('the partner cash leg', () => {
  it('offers the cash it holds for a person, with its rate and what can move', async () => {
    const { legs } = world();
    const read = await legs.offers('u1');
    expect(read.reason).toBeNull();
    expect(read.offers).toEqual([
      expect.objectContaining({ cash: 'EUR', coin: 'USDC', rate: parseAmount('1.08'), available: parseAmount('100'), test: true }),
    ]);
  });

  it('carries one leg: the cash leaves once, the coin is paid once, at the rate', async () => {
    const { legs, paid, asked, eur, moves } = world();
    const [a, b] = await Promise.all([legs.carry('u1', ask()), legs.carry('u1', ask())]);
    const c = await legs.carry('u1', ask());
    // Two callers at once share one carry: the payout is asked once, and both get the one stored leg.
    expect(asked).toEqual([KEY]);
    expect(a).toEqual(b);
    expect(b).toBe(c);
    expect(c.moveId).toBe(a.moveId);
    expect(a.state).toBe('delivered');
    expect(a.paid).toBe(parseAmount('20'));
    expect(a.delivered).toBe(parseAmount('21.6'));
    expect(moves()).toHaveLength(1);
    expect(moves()[0]!.to).toEqual(partnerPayoutsAccount('EUR'));
    expect(eur()).toBe(parseAmount('80'));
    expect(paid).toEqual([{ ref: KEY, amount: parseAmount('21.6') }]);
    expect(await legs.leg('u1', KEY)).toEqual(c);
    expect(await legs.leg('u2', KEY)).toBeNull();
  });

  it('rounds the coin down to its smallest unit', async () => {
    const { legs } = world();
    const leg = await legs.carry('u1', ask({ spend: parseAmount('0.0000013'), least: parseAmount('0.000001') }));
    expect(leg.delivered).toBe(parseAmount('0.000001'));
  });

  it('a lost payout leaves the leg sending; asking again pays it once, and the cash left once', async () => {
    const { legs, paid, eur, moves } = world({ failPayouts: 1 });
    await expect(legs.carry('u1', ask())).rejects.toMatchObject({ code: 'bank.cash_leg_sending' });
    expect((await legs.leg('u1', KEY))?.state).toBe('sending');
    expect(paid).toEqual([]);
    const done = await legs.carry('u1', ask());
    expect(done.state).toBe('delivered');
    expect(paid).toHaveLength(1);
    expect(moves()).toHaveLength(1);
    expect(eur()).toBe(parseAmount('80'));
  });

  it('two Check agains at once on a sending leg pay the coin once and return the one stored leg', async () => {
    const { legs, paid, asked, eur, moves } = world({ failPayouts: 1 });
    await expect(legs.carry('u1', ask())).rejects.toMatchObject({ code: 'bank.cash_leg_sending' });
    const [a, b] = await Promise.all([legs.carry('u1', ask()), legs.carry('u1', ask())]);
    expect(a.state).toBe('delivered');
    expect(b).toBe(a);
    expect(asked).toEqual([KEY, KEY]);
    expect(paid).toHaveLength(1);
    expect(moves()).toHaveLength(1);
    expect(eur()).toBe(parseAmount('80'));
  });

  it('another body under the same key is refused and moves nothing more', async () => {
    const { legs, eur } = world();
    await legs.carry('u1', ask());
    await expect(legs.carry('u1', ask({ spend: parseAmount('30') }))).rejects.toMatchObject({ code: 'bank.partner_move_conflict' });
    expect(eur()).toBe(parseAmount('80'));
  });

  it('refuses before anything moves: not enough cash, a rate that gives less, no rate, switched off, not partner-held', async () => {
    const { legs, partner, eur, paid } = world();
    await expect(legs.carry('u1', ask({ spend: parseAmount('200'), least: parseAmount('1') }))).rejects.toMatchObject({
      code: 'bank.partner_insufficient_funds',
    });
    await expect(legs.carry('u1', ask({ least: parseAmount('21.61') }))).rejects.toMatchObject({ code: 'bank.cash_leg_rate_moved' });
    await expect(legs.carry('u1', ask({ cash: 'GBP' }))).rejects.toMatchObject({ code: 'bank.cash_leg_not_offered' });
    partner.set('u1', { notOffered: ['cash_leg'] });
    expect((await legs.offers('u1')).offers).toEqual([]);
    expect((await legs.offers('u1')).reason).toMatch(/switched cash through a coin off/);
    await expect(legs.carry('u1', ask())).rejects.toMatchObject({ code: 'bank.cash_leg_not_offered' });
    partner.set('u1', { notOffered: [], down: true });
    await expect(legs.carry('u1', ask())).rejects.toMatchObject({ code: 'bank.cash_leg_not_offered' });
    expect((await legs.offers('u2')).reason).toMatch(/does not hold this person/);
    await expect(legs.carry('u1', ask({ key: 'withdraw:1' }))).rejects.toMatchObject({ code: 'bank.cash_leg_invalid' });
    partner.set('u1', { down: false });
    expect(eur()).toBe(parseAmount('100'));
    expect(paid).toEqual([]);
  });

  it('off the TEST stack nothing is offered, and a half-set or unsafe TEST cash leg refuses to start', async () => {
    expect((await NO_CASH_LEGS.offers('u1')).offers).toEqual([]);
    await expect(NO_CASH_LEGS.carry('u1', ask())).rejects.toMatchObject({ code: 'bank.cash_leg_not_offered' });
    const partner = testPartner();
    const dev = { APP_ENV: 'test', NODE_ENV: 'test' };
    expect(testCashLegFor({ rates: undefined, venueUrl: undefined, partner: partner, env: dev })).toBeNull();
    expect(() => testCashLegFor({ rates: 'EUR:USDC:1.08', venueUrl: undefined, partner: partner, env: dev })).toThrow(/together/);
    expect(() => testCashLegFor({ rates: 'EUR:USDC:1.08', venueUrl: 'http://127.0.0.1:1', partner: null, env: dev })).toThrow(
      /BANK_TEST_PARTNER=test/,
    );
    expect(() =>
      testCashLegFor({
        rates: 'EUR:USDC:1.08',
        venueUrl: 'http://127.0.0.1:1',
        partner: partner,
        env: { APP_ENV: 'prod', NODE_ENV: 'production' },
      }),
    ).toThrow();
    expect(() => parseCashLegRates('EUR:USDC:0')).toThrow();
    expect(() => parseCashLegRates('EURO:USDC:1')).toThrow();
    expect(testCashLegFor({ rates: 'EUR:USDC:1.08', venueUrl: 'http://127.0.0.1:1', partner: partner, env: dev })?.rates).toHaveLength(1);
  });

  it('pays the coin into the TEST venue under one reference made from the key, the same on every ask', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(url.endsWith('/venue') ? { chainId: 84532 } : { credited: true }), { status: 200 });
    };
    const payout = testVenuePayout('http://127.0.0.1:9/', fetcher);
    const one = { ref: KEY, venue: { venueId: 'test-venue', owner: OWNER }, coin: 'USDC', amount: parseAmount('21.6') };
    await payout.pay(one);
    await payout.pay(one);
    const deposits = calls.filter((c) => c.url === 'http://127.0.0.1:9/test/deposit').map((c) => c.body);
    expect(deposits).toHaveLength(2);
    expect(deposits[0]).toEqual(deposits[1]);
    expect(deposits[0]).toMatchObject({
      account: { venueId: 'test-venue', owner: OWNER, subAccount: null },
      asset: 'USDC',
      amount: '21.6',
    });
    expect(deposits[0]).toMatchObject({ depositRef: expect.stringMatching(/^84532:0x[0-9a-f]{64}:0$/) });
    const down: typeof fetch = async () => new Response('{}', { status: 503 });
    await expect(testVenuePayout('http://127.0.0.1:9', down).pay(one)).rejects.toThrow(/503/);
  });
});
