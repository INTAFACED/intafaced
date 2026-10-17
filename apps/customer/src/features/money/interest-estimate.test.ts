import { describe, expect, it } from 'vitest';
import { displayPlaces, estimateDays, estimateInterest } from './interest-estimate';

describe('estimated interest', () => {
  it('is amount x APR x days / 365, exact', () => {
    // 1,000 at 5.00% for a year
    expect(estimateInterest({ amount: '1000', aprBps: 500, days: 365 })).toMatchObject({ interest: '50', days: 365, belowDisplay: false });
    // 1,000 at 5.00% for 30 days = 4.10958904...
    expect(estimateInterest({ amount: '1000', aprBps: 500, days: 30 })?.interest).toBe('4.10958904');
  });
  it('never rounds up', () => {
    // 1 at 0.01% for 1 day = 0.00000027397260...
    expect(estimateInterest({ amount: '1', aprBps: 1, days: 1 })?.interest).toBe('0.00000027');
  });
  it('gives nothing for an empty, zero or unreadable amount', () => {
    for (const amount of ['', '0', 'abc', '-5', '1.1.1']) expect(estimateInterest({ amount, aprBps: 500, days: 365 })).toBeNull();
  });
  it('uses a year when the pool has no fixed term', () => {
    expect(estimateDays(null)).toBe(365);
    expect(estimateDays(90)).toBe(90);
  });

  it('compounds a loan daily like the bank: 1,000 at 9% for a year is about 94.16, not 90', () => {
    const loan = estimateInterest({ amount: '1000', aprBps: 900, days: 365, compounding: 'daily', places: 2 });
    expect(loan?.interest).toBe('94.16');
    const simple = estimateInterest({ amount: '1000', aprBps: 900, days: 365, places: 2 });
    expect(simple?.interest).toBe('90');
  });
  it('rounds each loan day down, so a tiny loan that earns nothing a day stays at nothing', () => {
    // 0.000000000000000100 at 9%: floor(1e-16 x 0.09 / 365) is below one unit every day
    expect(estimateInterest({ amount: '0.0000000000000001', aprBps: 900, days: 365, compounding: 'daily' })?.interest).toBe('0');
  });
  it('cuts down to the asset’s display places and says when it is too small to show', () => {
    expect(displayPlaces('USDT')).toBe(2);
    expect(displayPlaces('BTC')).toBe(8);
    expect(estimateInterest({ amount: '1000', aprBps: 500, days: 90, places: 2 })?.interest).toBe('12.32'); // 12.3287...
    const tiny = estimateInterest({ amount: '1', aprBps: 100, days: 1, places: 2 });
    expect(tiny).toMatchObject({ interest: '0', belowDisplay: true, smallest: '0.01' });
  });
});
