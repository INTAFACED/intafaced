import { describe, expect, it } from 'vitest';
import { fitsPlaces, parseQuickSizes, quickSizesText } from './trading-settings';

describe('quick sizes', () => {
  it('reads a list of positive exact decimals, drops repeats and keeps the order', () => {
    expect(parseQuickSizes('0.1, 0.5 1; 0.5')).toEqual({ ok: true, sizes: ['0.1', '0.5', '1'] });
    expect(quickSizesText(['0.1', '1'])).toBe('0.1, 1');
  });
  it('treats blank text as the empty list, which shows no buttons', () => {
    expect(parseQuickSizes('')).toEqual({ ok: true, sizes: [] });
    expect(parseQuickSizes('  , ')).toEqual({ ok: true, sizes: [] });
  });
  it('refuses zero, negatives, exponents, separators and too many places, without rounding', () => {
    for (const bad of ['0', '0.0', '-1', '1e3', '1,000.5x', '.5', '1.', '0.1234567890123456789', 'abc'])
      expect(parseQuickSizes(bad), bad).toEqual({ ok: false, reason: 'invalid' });
  });
  it('refuses more than 6 sizes', () => {
    expect(parseQuickSizes('1 2 3 4 5 6')).toMatchObject({ ok: true });
    expect(parseQuickSizes('1 2 3 4 5 6 7')).toEqual({ ok: false, reason: 'tooMany' });
  });
  it('knows whether a size fits the market precision', () => {
    expect(fitsPlaces('0.25', 2)).toBe(true);
    expect(fitsPlaces('0.255', 2)).toBe(false);
    expect(fitsPlaces('5', 0)).toBe(true);
  });
});
