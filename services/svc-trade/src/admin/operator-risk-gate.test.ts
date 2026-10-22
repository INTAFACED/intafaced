/**
 * J-cex-spot-04: the operator price band is a fraction around the middle of the book, and the open-order cap counts
 * only orders that can rest. Both refusals carry the numbers the desk names (band edges; cap and how many are open).
 */
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';
import { assertOperatorRiskOnPlace, priceBandFor, type Touch } from './risk.js';

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

describe('assertOperatorRiskOnPlace', () => {
  const order = { side: 'buy' as const, price: p('100'), qty: p('1'), rests: true };

  it('no approved row: nothing is checked and the book is not read', async () => {
    let read = false;
    await assertOperatorRiskOnPlace(fakeSql(null), MARKET, 'u', order, async () => {
      read = true;
      return { bid: null, ask: null };
    });
    expect(read).toBe(false);
  });

  it('a buy above the band refuses trade.price_band with the edges; one at the edge goes', async () => {
    const sql = fakeSql({ collar: '0.1' });
    const error = await refusal(assertOperatorRiskOnPlace(sql, MARKET, 'u', { ...order, price: p('110.01') }, touch('99.99', '100.01')));
    expect(error.code).toBe('trade.price_band');
    expect(error.data).toEqual({ low: '90', high: '110', collar: '0.1' });
    await assertOperatorRiskOnPlace(sql, MARKET, 'u', { ...order, price: p('110') }, touch('99.99', '100.01'));
    // A buy far under the market rests harmlessly: the band guards the side that would cross.
    await assertOperatorRiskOnPlace(sql, MARKET, 'u', { ...order, price: p('1') }, touch('99.99', '100.01'));
  });

  it('a sell below the band refuses; a sell above it goes', async () => {
    const sql = fakeSql({ collar: '0.1' });
    const error = await refusal(
      assertOperatorRiskOnPlace(sql, MARKET, 'u', { ...order, side: 'sell', price: p('89.99') }, touch('99.99', '100.01')),
    );
    expect(error.code).toBe('trade.price_band');
    await assertOperatorRiskOnPlace(sql, MARKET, 'u', { ...order, side: 'sell', price: p('500') }, touch('99.99', '100.01'));
  });

  it("a market's first quote on an empty book rests: there is nothing for it to trade against", async () => {
    await assertOperatorRiskOnPlace(fakeSql({ collar: '0.1' }), MARKET, 'u', { ...order, price: p('1000000') }, touch(null, null));
  });

  it("a bracket's protective exit is never refused by the band", async () => {
    const sql = fakeSql({ collar: '0.1', throttle: '1' }, '5');
    await assertOperatorRiskOnPlace(
      sql,
      MARKET,
      'u',
      { ...order, side: 'sell', price: p('50'), rests: false, protective: true },
      touch('99.99', '100.01'),
    );
  });

  it('a market order (no price) is not judged against the band', async () => {
    await assertOperatorRiskOnPlace(fakeSql({ collar: '0.1' }), MARKET, 'u', { ...order, price: null }, touch(null, null));
  });

  it('the open-order cap refuses an order that can rest with the cap and the count, and lets one that cannot rest go', async () => {
    const sql = fakeSql({ throttle: '3' }, '3');
    const error = await refusal(assertOperatorRiskOnPlace(sql, MARKET, 'u', order, touch(null, null)));
    expect(error.code).toBe('trade.operator_throttle');
    expect(error.data).toEqual({ cap: '3', open: '3' });
    await assertOperatorRiskOnPlace(sql, MARKET, 'u', { ...order, rests: false }, touch(null, null));
    await assertOperatorRiskOnPlace(fakeSql({ throttle: '3' }, '2'), MARKET, 'u', order, touch(null, null));
  });
});
