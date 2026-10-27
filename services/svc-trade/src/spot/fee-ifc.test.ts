import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsufficientFundsError, LedgerError, parseAmount as amt, type PostRequest } from '@intafaced/ledger-client';
import { parseFeeScheduleJson } from './fee-schedule.js';
import {
  PAID_IN_RECEIVED,
  chargeIfcLeg,
  createIfcDiscountSource,
  ifcDecisionFromRow,
  ifcFeeAtPlacement,
  ifcFeeChoice,
  ifcGross,
  ifcNet,
  sameFeeCurrency,
  UNWIRED_IFC_DISCOUNT,
  type IfcFeeFallback,
} from './fee-ifc.js';
import { TradeError } from './types.js';

const TERMS = { tokenAsset: 'IFC', perUnit: { BTC: '50000', USDT: '2' } };
const USER = '11111111-1111-4111-8111-111111111111';

function codeOf(fn: () => unknown): Promise<string | undefined> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => undefined,
      (err: unknown) => (err instanceof TradeError ? err.code : String(err)),
    );
}

describe('the owner terms in the fee schedule', () => {
  const rows = (ifcFee: unknown) =>
    JSON.stringify({
      published: true,
      version: 'v',
      defaultPairGroup: 'g',
      rows: [{ pairGroup: 'g', tierId: 'regular', zeroFee: false, makerBps: '5', takerBps: '10', minFee: null }],
      ifcFee,
    });

  it('reads the token and its conversions, and absent terms as none', () => {
    const parsed = parseFeeScheduleJson(rows(TERMS));
    expect(parsed.published === true && parsed.ifcFee).toEqual(TERMS);
    const blank = parseFeeScheduleJson(rows(undefined));
    expect(blank.published === true && blank.ifcFee).toBeNull();
  });

  it.each([
    ['a JSON number', { tokenAsset: 'IFC', perUnit: { BTC: 50000 } }],
    ['zero', { tokenAsset: 'IFC', perUnit: { BTC: '0' } }],
    ['a negative figure', { tokenAsset: 'IFC', perUnit: { BTC: '-1' } }],
    ['no conversions', { tokenAsset: 'IFC', perUnit: {} }],
    ['the token converting to itself', { tokenAsset: 'IFC', perUnit: { IFC: '1' } }],
    ['an extra field', { tokenAsset: 'IFC', perUnit: { BTC: '1' }, discountBps: 2000 }],
    ['a lower-case asset id', { tokenAsset: 'ifc', perUnit: { BTC: '1' } }],
  ])('refuses %s as a blank schedule, never a guessed price', (_name, ifcFee) => {
    expect(() => parseFeeScheduleJson(rows(ifcFee))).toThrow(expect.objectContaining({ code: 'trade.fee_schedule_blank' }));
  });
});

describe('the choice at placement', () => {
  it('pays in the received asset when nothing or that asset is asked, whatever the terms', () => {
    expect(ifcFeeChoice(undefined, 'BTC', null)).toBeNull();
    expect(ifcFeeChoice(' btc ', 'BTC', null)).toBeNull();
  });

  it('takes the token named by the terms, in any case', () => {
    expect(ifcFeeChoice('ifc', 'BTC', TERMS)).toEqual({ tokenAsset: 'IFC' });
  });

  it.each([
    ['IFC', null, 'trade.fee_currency_ifc_unset'],
    ['ETH', null, 'trade.fee_currency_unsupported'],
    ['ETH', TERMS, 'trade.fee_currency_unsupported'],
  ])('refuses %s with terms %j by name', async (asked, terms, code) => {
    expect(await codeOf(() => ifcFeeChoice(asked, 'BTC', terms))).toBe(code);
  });

  it('refuses a fee asset the terms give no conversion for', async () => {
    expect(await codeOf(() => ifcFeeChoice('IFC', 'ETH', TERMS))).toBe('trade.fee_ifc_index_unset');
  });

  it('reads the stake discount only for an own spot order that asks for the token', async () => {
    const discount = { discountBps: vi.fn(async () => 2000) };
    const terms = async () => TERMS;
    expect(await ifcFeeAtPlacement('IFC', 'BTC', true, terms, discount, USER)).toEqual({ tokenAsset: 'IFC', discountBps: 2000 });
    expect(await ifcFeeAtPlacement(undefined, 'BTC', true, terms, discount, USER)).toBeNull();
    expect(await ifcFeeAtPlacement('BTC', 'BTC', false, terms, discount, USER)).toBeNull();
    expect(discount.discountBps).toHaveBeenCalledTimes(1);
    expect(await codeOf(() => ifcFeeAtPlacement('IFC', 'BTC', false, terms, discount, USER))).toBe('trade.fee_currency_unsupported');
    expect(discount.discountBps).toHaveBeenCalledTimes(1);
  });

  it('refuses when the discount cannot be read, before anything is held', async () => {
    expect(await codeOf(() => ifcFeeAtPlacement('IFC', 'BTC', true, async () => TERMS, UNWIRED_IFC_DISCOUNT, USER))).toBe(
      'trade.fee_ifc_discount_unavailable',
    );
  });

  it('treats a retry as the same order only when it asks for the same fee currency', () => {
    expect(sameFeeCurrency(null, undefined, 'BTC')).toBe(true);
    expect(sameFeeCurrency(null, 'btc', 'BTC')).toBe(true);
    expect(sameFeeCurrency('IFC', 'ifc', 'BTC')).toBe(true);
    expect(sameFeeCurrency('IFC', undefined, 'BTC')).toBe(false);
    expect(sameFeeCurrency(null, 'IFC', 'BTC')).toBe(false);
  });
});

describe('the conversion', () => {
  it('floors the token amount and rounds the discount in the payer favour, as feeCharge does', () => {
    expect(ifcGross(amt('0.002'), '50000')).toBe(amt('100'));
    // 0.000000000000000003 BTC at 0.5 IFC each is 0.0000000000000000015 IFC: floored to one unit.
    expect(ifcGross(3n, '0.5')).toBe(1n);
    expect(ifcNet(amt('100'), 2000)).toBe(amt('80'));
    // 3 units at 3333 bps: the discount is ceil(0.9999) = 1 unit, so the payer pays 2.
    expect(ifcNet(3n, 3333)).toBe(2n);
  });
});

describe('charging one leg', () => {
  const leg: Parameters<typeof chargeIfcLeg>[1] = {
    legId: 'leg-1',
    userId: USER,
    feeAsset: 'BTC',
    fee: amt('0.002'),
    discountBps: 2000,
    terms: TERMS,
    rebateFill: false,
  };

  function ledger(outcome: 'ok' | 'short' | 'short-but-booked' | 'down') {
    const posts: PostRequest[] = [];
    return {
      posts,
      post: async (req: PostRequest) => {
        posts.push(req);
        if (outcome === 'ok') return { id: 'tx' };
        if (outcome === 'down') throw new Error('socket hang up');
        throw new InsufficientFundsError('user:test', 'IFC', '80', '10');
      },
      getTxByKey: async (key: string) => (outcome === 'short-but-booked' && key === 'fee:trade:ifc:leg-1' ? { id: 'tx' } : null),
    };
  }

  it('posts feeCharge in token mode under the leg key, at the order discount', async () => {
    const l = ledger('ok');
    expect(await chargeIfcLeg(l, leg)).toEqual({ charged: { tokenAsset: 'IFC', net: amt('80') }, fallback: null });
    expect(l.posts).toHaveLength(1);
    expect(l.posts[0]).toMatchObject({
      idempotencyKey: 'fee:trade:ifc:leg-1',
      module: 'trade',
      reason: 'trade.fill.fee_ifc',
      meta: { mode: 'token', discountBps: 2000, gross: amt('100').toString() },
    });
  });

  it.each<[string, Partial<typeof leg>, IfcFeeFallback | null]>([
    ['no fee on the leg', { fee: 0n }, null],
    ['a fill whose taker fee pays a maker rebate', { rebateFill: true }, 'trade.fee_ifc_rebate_fill'],
    ['terms gone from the version charged', { terms: null as never }, 'trade.fee_ifc_index_unset'],
    ['a fee asset the terms do not convert', { feeAsset: 'ETH' }, 'trade.fee_ifc_index_unset'],
    ['a fee under one unit of the token', { fee: 1n, terms: { tokenAsset: 'IFC', perUnit: { BTC: '0.1' } } }, 'trade.fee_ifc_dust'],
  ])('pays in the received asset on %s, posting nothing', async (_name, change, fallback) => {
    const l = ledger('ok');
    const decision = await chargeIfcLeg(l, { ...leg, ...change });
    expect(decision).toEqual(fallback === null ? PAID_IN_RECEIVED : { charged: null, fallback });
    expect(l.posts).toHaveLength(0);
  });

  it('falls back for funds, and names it on the leg', async () => {
    expect(await chargeIfcLeg(ledger('short'), leg)).toEqual({ charged: null, fallback: 'trade.fee_ifc_insufficient' });
    const coded = {
      post: async () => {
        throw new LedgerError('short', 'ledger.insufficient_funds');
      },
      getTxByKey: async () => null,
    };
    expect(await chargeIfcLeg(coded, leg)).toEqual({ charged: null, fallback: 'trade.fee_ifc_insufficient' });
  });

  it('falls back when the ledger refuses this charge itself, and retries the fill on any other refusal', async () => {
    const refusing = (code: string) => ({
      post: async () => {
        throw new LedgerError('refused', code);
      },
      getTxByKey: async () => null,
    });
    expect(await chargeIfcLeg(refusing('ledger.invalid_entry'), leg)).toEqual({ charged: null, fallback: 'trade.fee_ifc_refused' });
    expect(await chargeIfcLeg(refusing('ledger.caller_forbidden'), leg)).toEqual({ charged: null, fallback: 'trade.fee_ifc_refused' });
    for (const code of ['ledger.frozen', 'ledger.idempotency_conflict', 'ledger.writes_blocked_store_unavailable']) {
      await expect(chargeIfcLeg(refusing(code), leg)).rejects.toThrow('refused');
    }
  });

  it('counts a charge the ledger already booked under the key as charged, even when a retry is refused for funds', async () => {
    expect(await chargeIfcLeg(ledger('short-but-booked'), leg)).toEqual({ charged: { tokenAsset: 'IFC', net: amt('80') }, fallback: null });
  });

  it('throws any other ledger failure, so the fill is retried and never settled half-decided', async () => {
    await expect(chargeIfcLeg(ledger('down'), leg)).rejects.toThrow('socket hang up');
  });

  it('reads a written leg back as the decision it recorded', () => {
    expect(ifcDecisionFromRow({ fee_asset: 'IFC', fee_amount: '80', fee_fallback: null }, 'BTC', 'IFC')).toEqual({
      charged: { tokenAsset: 'IFC', net: amt('80') },
      fallback: null,
    });
    expect(ifcDecisionFromRow({ fee_asset: 'BTC', fee_amount: '0.002', fee_fallback: 'trade.fee_ifc_insufficient' }, 'BTC', 'IFC')).toEqual(
      {
        charged: null,
        fallback: 'trade.fee_ifc_insufficient',
      },
    );
  });
});

describe("svc-token's discount", () => {
  afterEach(() => vi.unstubAllGlobals());

  const reply = (status: number, body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
    );

  it('reads feeDiscountBps from the stake route', async () => {
    reply(200, { staked: '150', tier: { name: 'Base' }, feeDiscountBps: 2000 });
    expect(await createIfcDiscountSource('http://token.test/', 'svc-trade-ifc-test-secret-0123456789').discountBps(USER)).toBe(2000);
    const [url] = (globalThis.fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0]!;
    expect(url).toBe(`http://token.test/internal/stake/${USER}`);
  });

  it.each([
    ['a refusal, naming it', 500, { message: 'token_params.fee_discount_schedule is unset' }, 'fee_discount_schedule is unset'],
    ['a reply with no discount', 200, { staked: '1' }, 'carried no discount'],
    ['a discount out of range', 200, { feeDiscountBps: 10_000 }, 'carried no discount'],
  ])('fails closed on %s', async (_name, status, body, text) => {
    reply(status, body);
    const err = await createIfcDiscountSource('http://token.test', 'svc-trade-ifc-test-secret-0123456789')
      .discountBps(USER)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TradeError);
    expect((err as TradeError).code).toBe('trade.fee_ifc_discount_unavailable');
    expect((err as TradeError).message).toContain(text);
  });
});
