/**
 * J-cex-spot-04: the operator price band is a fraction around the middle of the book, and the open-order cap counts
 * only orders that can rest. Both refusals carry the numbers the desk names (band edges; cap and how many are open).
 */
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';
import { assertOperatorRiskOnPlace, priceBandFor, validateLimits, type Touch } from './risk.js';

const TICK = parseAmount('0.01');
const MARKET = { id: '00000000-0000-4000-8000-000000000001', tickSize: TICK };
const p = (v: string) => parseAmount(v);

/** A stand-in for the two reads the gate makes: the latest risk row and the open-order count. */
function fakeSql(row: Record<string, string | null> | null, open = '0'): Sql {
  const tag = (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('operator_risk_limits')) {
      return Promise.resolve(
        row
          ? [
              {
                market_id: MARKET.id,
                version: '1',
                collar: null,
                fat_finger: null,
                slippage_cap: null,
                throttle: null,
                circuit_breaker: null,
                operator_id: 'op',
                approver_id: 'ap',
                reason: 'test',
                approval_id: 'a',
                created_at: new Date(0),
                ...row,
              },
            ]
          : [],
      );
    }
    if (text.includes('count(*)')) return Promise.resolve([{ n: open }]);
    throw new Error(`unexpected query ${text}`);
  };
  return tag as unknown as Sql;
}

const touch = (bid: string | null, ask: string | null) => async (): Promise<Touch> => ({
  bid: bid == null ? null : p(bid),
  ask: ask == null ? null : p(ask),
});

async function refusal(run: Promise<void>): Promise<TradeError> {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TradeError);
  return error as TradeError;
}

describe('validateLimits: the band is a fraction above 0 and below 1', () => {
  const blank = { collar: null, fatFinger: null, slippageCap: null, throttle: null, circuitBreaker: null };
  it('takes 0.1 and 0.999', () => {
    expect(validateLimits({ ...blank, collar: '0.1' }).collar).toBe('0.1');
    expect(validateLimits({ ...blank, collar: '0.999' }).collar).toBe('0.999');
  });
  it('refuses 0, 1 and more', () => {
    for (const collar of ['0', '1', '1.5', '65000']) {
      expect(() => validateLimits({ ...blank, collar })).toThrow(expect.objectContaining({ code: 'risk_limit_not_exact' }));
    }
  });
});

describe('priceBandFor', () => {
  it('centres on the middle of the best bid and ask and keeps both edges on the tick, inside the band', () => {
    const band = priceBandFor('0.1', { bid: p('99.99'), ask: p('100.01') }, TICK);
    expect(band).toEqual({ low: p('90'), high: p('110') });
    const odd = priceBandFor('0.05', { bid: p('100.01'), ask: p('100.04') }, TICK);
    // mid 100.025, width 5.00125: low 95.02375 rounds up to 95.03, high 105.02625 rounds down to 105.02
    expect(odd).toEqual({ low: p('95.03'), high: p('105.02') });
  });

  it('uses the one side that shows when the other is empty', () => {
    expect(priceBandFor('0.1', { bid: null, ask: p('200') }, TICK)).toEqual({ low: p('180'), high: p('220') });
    expect(priceBandFor('0.1', { bid: p('200'), ask: null }, TICK)).toEqual({ low: p('180'), high: p('220') });
  });

  it('an empty book has no band: no reference is invented', () => {
    expect(priceBandFor('0.1', { bid: null, ask: null }, TICK)).toBeNull();
  });
});

/** The band and cap mechanics, on a pair where publishing is not what is being tested. */
const bandAndCap = (
  sql: Sql,
  market: typeof MARKET,
  user: string,
  input: Parameters<typeof assertOperatorRiskOnPlace>[3],
  t: () => Promise<Touch>,
) => assertOperatorRiskOnPlace(sql, market, user, input, t, false);

describe('published pair rules (J-cex-spot-04 step 6)', () => {
  const order = { side: 'buy' as const, price: p('100'), qty: p('1'), rests: true };
  const book = touch('99.99', '100.01');

  it('no band published: a priced order refuses trade.price_band_unset, never a default band', async () => {
    for (const row of [null, { throttle: '20' }]) {
      const error = await refusal(assertOperatorRiskOnPlace(fakeSql(row), MARKET, 'u', order, book));
      expect(error.code).toBe('trade.price_band_unset');
      expect(error.data).toEqual({ rule: 'price band' });
    }
    // A market order has no price to band; its protection is the slippage cap, refused elsewhere when unset.
    await assertOperatorRiskOnPlace(fakeSql({ throttle: '20' }), MARKET, 'u', { ...order, price: null, rests: false }, book);
  });

  it('no cap published: an order that can rest refuses trade.open_orders_cap_unset; one that cannot rest goes', async () => {
    const error = await refusal(assertOperatorRiskOnPlace(fakeSql({ collar: '0.1' }), MARKET, 'u', order, book));
    expect(error.code).toBe('trade.open_orders_cap_unset');
    expect(error.data).toEqual({ rule: 'open-order cap' });
    await assertOperatorRiskOnPlace(fakeSql({ collar: '0.1' }), MARKET, 'u', { ...order, rests: false }, book);
  });

  it('both published: the order goes', async () => {
    await assertOperatorRiskOnPlace(fakeSql({ collar: '0.1', throttle: '20' }), MARKET, 'u', order, book);
  });

  it("a bracket's protective exit is never refused for a rule the pair has not published", async () => {
    await assertOperatorRiskOnPlace(fakeSql(null), MARKET, 'u', { ...order, side: 'sell', rests: false, protective: true }, book);
  });
});

describe('assertOperatorRiskOnPlace', () => {
  const order = { side: 'buy' as const, price: p('100'), qty: p('1'), rests: true };

  it('no approved row: nothing is checked and the book is not read', async () => {
    let read = false;
    await bandAndCap(fakeSql(null), MARKET, 'u', order, async () => {
      read = true;
      return { bid: null, ask: null };
    });
    expect(read).toBe(false);
  });

  it('a buy above the band refuses trade.price_band with the edges; one at the edge goes', async () => {
    const sql = fakeSql({ collar: '0.1' });
    const error = await refusal(bandAndCap(sql, MARKET, 'u', { ...order, price: p('110.01') }, touch('99.99', '100.01')));
    expect(error.code).toBe('trade.price_band');
    expect(error.data).toEqual({ low: '90', high: '110', collar: '0.1' });
    await bandAndCap(sql, MARKET, 'u', { ...order, price: p('110') }, touch('99.99', '100.01'));
    // A buy far under the market rests harmlessly: the band guards the side that would cross.
    await bandAndCap(sql, MARKET, 'u', { ...order, price: p('1') }, touch('99.99', '100.01'));
  });

  it('a sell below the band refuses; a sell above it goes', async () => {
    const sql = fakeSql({ collar: '0.1' });
    const error = await refusal(bandAndCap(sql, MARKET, 'u', { ...order, side: 'sell', price: p('89.99') }, touch('99.99', '100.01')));
    expect(error.code).toBe('trade.price_band');
    await bandAndCap(sql, MARKET, 'u', { ...order, side: 'sell', price: p('500') }, touch('99.99', '100.01'));
  });

  it("a market's first quote on an empty book rests: there is nothing for it to trade against", async () => {
    await bandAndCap(fakeSql({ collar: '0.1' }), MARKET, 'u', { ...order, price: p('1000000') }, touch(null, null));
  });

  it("a bracket's protective exit is never refused by the band", async () => {
    const sql = fakeSql({ collar: '0.1', throttle: '1' }, '5');
    await bandAndCap(
      sql,
      MARKET,
      'u',
      { ...order, side: 'sell', price: p('50'), rests: false, protective: true },
      touch('99.99', '100.01'),
    );
  });

  it('a market order (no price) is not judged against the band', async () => {
    await bandAndCap(fakeSql({ collar: '0.1' }), MARKET, 'u', { ...order, price: null }, touch(null, null));
  });

  it('the open-order cap refuses an order that can rest with the cap and the count, and lets one that cannot rest go', async () => {
    const sql = fakeSql({ throttle: '3' }, '3');
    const error = await refusal(bandAndCap(sql, MARKET, 'u', order, touch(null, null)));
    expect(error.code).toBe('trade.operator_throttle');
    expect(error.data).toEqual({ cap: '3', open: '3' });
    await bandAndCap(sql, MARKET, 'u', { ...order, rests: false }, touch(null, null));
    await bandAndCap(fakeSql({ throttle: '3' }, '2'), MARKET, 'u', order, touch(null, null));
  });
});
