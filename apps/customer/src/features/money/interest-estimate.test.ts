import { describe, expect, it } from 'vitest';
import { estimateDays, estimateInterest } from './interest-estimate';

describe('estimated interest', () => {
  it('is amount x APR x days / 365, exact', () => {
    // 1,000 at 5.00% for a year
    expect(estimateInterest({ amount: '1000', aprBps: 500, days: 365 })).toEqual({ interest: '50', days: 365 });
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
});
