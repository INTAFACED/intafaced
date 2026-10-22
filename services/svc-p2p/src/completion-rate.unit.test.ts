import { describe, expect, it } from 'vitest';
import { percentString } from './completion-rate.js';

describe('completion percent string (P-trade-orders-21)', () => {
  it('formats integer-exact, rounded half up, two places', () => {
    expect(percentString(0, 0)).toBe('0.00');
    expect(percentString(1, 1)).toBe('100.00');
    expect(percentString(1, 3)).toBe('33.33');
    expect(percentString(2, 3)).toBe('66.67');
    expect(percentString(1, 8)).toBe('12.50');
    expect(percentString(1, 1000)).toBe('0.10');
    expect(percentString(1, 30000)).toBe('0.00');
  });
});
