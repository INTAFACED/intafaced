import { describe, expect, it } from 'vitest';
import { parseGridCount, previewGridPrices } from './grid-plan';

const range = { min: 2, max: 100 };

describe('previewGridPrices', () => {
  it('spaces levels evenly from lower to upper inclusive, floored onto the tick', () => {
    expect(previewGridPrices({ lower: '100', upper: '110', count: 3, tick: '0.1', range })).toEqual({
      kind: 'levels',
      prices: ['100', '105', '110'],
    });
    expect(previewGridPrices({ lower: '100', upper: '101', count: 4, tick: '0.1', range })).toEqual({
      kind: 'levels',
      prices: ['100', '100.3', '100.6', '101'],
    });
  });
  it('plans twenty levels for twenty grids', () => {
    const plan = previewGridPrices({ lower: '60000', upper: '80000', count: 20, tick: '0.01', range });
    expect(plan.kind === 'levels' ? plan.prices.length : 0).toBe(20);
  });
  it('previews nothing while a bound or the count is blank, out of range or inverted', () => {
    for (const input of [
      { lower: '', upper: '110', count: 3 },
      { lower: '100', upper: '', count: 3 },
      { lower: '100', upper: '110', count: null },
      { lower: '100', upper: '110', count: 1 },
      { lower: '100', upper: '110', count: 101 },
      { lower: '110', upper: '100', count: 3 },
      { lower: '100', upper: '100.1', count: 5 },
    ])
      expect(previewGridPrices({ ...input, tick: '0.1', range }), JSON.stringify(input)).toEqual({ kind: 'none' });
    expect(previewGridPrices({ lower: '100', upper: '110', count: 3, tick: '0.1', range: null })).toEqual({ kind: 'none' });
  });
});

describe('parseGridCount', () => {
  it('reads a whole number and nothing else', () => {
    expect(parseGridCount(' 20 ')).toBe(20);
    expect(parseGridCount('')).toBeNull();
    expect(parseGridCount('2.5')).toBeNull();
    expect(parseGridCount('-1')).toBeNull();
  });
});
