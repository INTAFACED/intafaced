import { describe, expect, it } from 'vitest';
import { amount, normalizeTiers, priceQuantity } from './pricing.js';

/** M-catalogue-02 price arithmetic: exact to 18 decimals, tier rules, refusal of out-of-range amounts. */

const tiers = normalizeTiers([
  { upTo: 10, unitAmount: '1.5' },
  { upTo: 100, unitAmount: '1.25', flatAmount: '2' },
  { upTo: null, unitAmount: '0.000000000000000001' },
]);

describe('catalogue pricing', () => {
  it('per-seat multiplies exactly at 18 decimals', () => {
    expect(priceQuantity('per_seat', '0.333333333333333333', null, 3).total).toBe('0.999999999999999999');
  });
  it('flat charges the amount once', () => {
    expect(priceQuantity('flat', '49.99', null, 1).total).toBe('49.99');
  });
  it('graduated prices each slice at its own tier', () => {
    const q = priceQuantity('graduated', null, tiers, 105);
    // 10*1.5 + (90*1.25 + 2) + 5*1e-18
    expect(q.total).toBe('129.500000000000000005');
    expect(q.lines.map((l) => l.quantity)).toEqual([10, 90, 5]);
  });
  it('volume prices the whole quantity at the tier it lands in, bounds inclusive', () => {
    expect(priceQuantity('volume', null, tiers, 10).total).toBe('15');
    expect(priceQuantity('volume', null, tiers, 11).total).toBe('15.75');
  });
  it('tiers must rise, have no gap or overlap, and end open', () => {
    expect(() => normalizeTiers([{ upTo: 5, unitAmount: '1' }])).toThrow();
    expect(() =>
      normalizeTiers([
        { upTo: 5, unitAmount: '1' },
        { upTo: 5, unitAmount: '1' },
        { upTo: null, unitAmount: '1' },
      ]),
    ).toThrow();
    expect(() =>
      normalizeTiers([
        { upTo: null, unitAmount: '1' },
        { upTo: null, unitAmount: '1' },
      ]),
    ).toThrow();
    expect(() => normalizeTiers([])).toThrow();
  });
  it('refuses amounts the column cannot hold or more than 18 decimals', () => {
    expect(() => amount('100000000000000000000')).toThrow();
    expect(() => amount('1.0000000000000000001')).toThrow();
    expect(() => amount('-1')).toThrow();
    expect(amount('99999999999999999999.999999999999999999') > 0n).toBe(true);
  });
});
