import { describe, expect, it } from 'vitest';
import { crossingCount, parseCount, planHold, planScale, splitLots, type ScaleInput } from './scale-math';

const market = { tickSize: '0.01', lotSize: '0.0001', minAmount: '0.0001', minCost: null as string | null };
const strict = { ...market, minCost: '1' };
const base: ScaleInput = { side: 'buy', from: '100', to: '104', count: '5', total: '0.1', spread: 'even' };
const ok = (input: Partial<ScaleInput>, m = market) => {
  const plan = planScale({ ...base, ...input }, m);
  if (!plan.ok) throw new Error(`expected a plan, got ${JSON.stringify(plan.problem)}`);
  return plan;
};
const problem = (input: Partial<ScaleInput>, m = market) => {
  const plan = planScale({ ...base, ...input }, m);
  if (plan.ok) throw new Error('expected a problem');
  return plan.problem;
};

describe('scale plan: prices', () => {
  it('spreads equal steps from the first price to the last, ends included', () => {
    expect(ok({}).rows.map((row) => row.price)).toEqual(['100', '101', '102', '103', '104']);
  });

  it('rounds each price to the market step (half up) and never repeats one', () => {
    expect(ok({ from: '100', to: '100.05', count: '4', total: '0.1' }).rows.map((row) => row.price)).toEqual([
      '100',
      '100.02',
      '100.03',
      '100.05',
    ]);
  });

  it('runs downwards when the first price is the higher one', () => {
    expect(ok({ from: '104', to: '100' }).rows.map((row) => row.price)).toEqual(['104', '103', '102', '101', '100']);
    expect(ok({ from: '100.05', to: '100', count: '4' }).rows.map((row) => row.price)).toEqual(['100.05', '100.03', '100.02', '100']);
  });

  it('refuses a range too narrow for that many orders instead of stacking orders on one price', () => {
    expect(problem({ from: '100', to: '100.01', count: '5' })).toEqual({ kind: 'tooNarrow', count: 5 });
  });

  it('refuses equal, empty and off-step prices', () => {
    expect(problem({ from: '100', to: '100' })).toEqual({ kind: 'samePrice' });
    expect(problem({ from: '', to: '104' })).toEqual({ kind: 'priceEmpty' });
    expect(problem({ from: '100.005', to: '104' })).toEqual({ kind: 'priceTick', tick: '0.01' });
    expect(problem({ to: '0' })).toEqual({ kind: 'priceEmpty' });
  });
});

describe('scale plan: sizes', () => {
  it('splits evenly and the amounts add up to exactly the total', () => {
    const plan = ok({ total: '0.001' });
    expect(plan.rows.map((row) => row.amount)).toEqual(['0.0002', '0.0002', '0.0002', '0.0002', '0.0002']);
    expect(plan.totalAmount).toBe('0.001');
  });

  it('hands leftover steps to the last orders, never losing or inventing size', () => {
    const plan = ok({ total: '0.0011' });
    expect(plan.rows.map((row) => row.amount)).toEqual(['0.0002', '0.0002', '0.0002', '0.0002', '0.0003']);
    expect(plan.totalAmount).toBe('0.0011');
  });

  it('weights 1, 2, 3 ... from the first price to the last', () => {
    const plan = ok({ from: '100', to: '102', count: '3', total: '0.0006', spread: 'weighted' });
    expect(plan.rows.map((row) => row.amount)).toEqual(['0.0001', '0.0002', '0.0003']);
  });

  it('weighted sizes always add up to the total, whatever the count', () => {
    for (const count of [2, 3, 5, 7, 13, 20]) {
      for (const lots of [count * count + 1, 997, 1000]) {
        const split = splitLots(BigInt(lots), count, 'weighted');
        expect(split.reduce((sum, l) => sum + l, 0n)).toBe(BigInt(lots));
        const even = splitLots(BigInt(lots), count, 'even');
        expect(even.reduce((sum, l) => sum + l, 0n)).toBe(BigInt(lots));
      }
    }
  });

  it('refuses a total that cannot give every order a whole step', () => {
    expect(problem({ total: '0.0004' })).toEqual({ kind: 'tooSmall', count: 5, lot: '0.0001' });
    // Weighted: the first order would round to nothing.
    expect(problem({ from: '100', to: '102', count: '3', total: '0.0004', spread: 'weighted' })).toEqual({
      kind: 'tooSmall',
      count: 3,
      lot: '0.0001',
    });
  });

  it('refuses an amount off the amount step or empty', () => {
    expect(problem({ total: '0.00015' })).toEqual({ kind: 'amountLot', lot: '0.0001' });
    expect(problem({ total: '' })).toEqual({ kind: 'amountEmpty' });
  });

  it('refuses an order under the market minimum amount or value', () => {
    expect(problem({ total: '0.001' }, { ...market, minAmount: '0.0003' })).toEqual({ kind: 'amountMin', min: '0.0003' });
    expect(problem({ total: '0.001' }, strict)).toEqual({ kind: 'valueMin', min: '1' });
  });

  it('totals the value exactly, floored per order', () => {
    const plan = ok({ total: '1', from: '10', to: '10.04', count: '5' }, strict);
    expect(plan.totalValue).toBe('10.02');
    expect(plan.rows.map((row) => row.value)).toEqual(['2', '2.002', '2.004', '2.006', '2.008']);
  });
});

describe('scale plan: the count', () => {
  it('takes whole numbers from 2 to 20 only', () => {
    expect(parseCount('2')).toBe(2);
    expect(parseCount(' 20 ')).toBe(20);
    for (const text of ['', '1', '21', '2.5', 'abc', '-3', '1e1', '0x5']) expect(parseCount(text)).toBeNull();
    expect(problem({ count: '1' })).toEqual({ kind: 'count', min: 2, max: 20 });
  });
});

describe('scale plan: helpers', () => {
  it('counts orders that would trade at once against the book', () => {
    const rows = ok({}).rows;
    expect(crossingCount('buy', rows, { bestBid: '99', bestAsk: '102' })).toBe(3);
    expect(crossingCount('sell', rows, { bestBid: '102', bestAsk: '110' })).toBe(3);
    expect(crossingCount('buy', rows, null)).toBe(0);
    expect(crossingCount('buy', rows, { bestBid: null, bestAsk: null })).toBe(0);
  });

  it('a buy holds the value, a sell holds the base amount', () => {
    const plan = ok({ total: '1', from: '10', to: '10.04', count: '5' }, strict);
    expect(planHold('buy', plan)).toBe(plan.totalValue);
    expect(planHold('sell', plan)).toBe('1');
  });
});
