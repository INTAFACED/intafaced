import { describe, expect, it } from 'vitest';
import { direction, fmtAmount, fmtChangeLine, fmtPct, fmtPctPoints, fmtPrice, fmtUsd, fmtUsdChange, UNKNOWN } from './format';

describe('fmtUsd', () => {
  it('shows 2 decimals with grouping', () => {
    expect(fmtUsd('0')).toBe('$0.00');
    expect(fmtUsd('1')).toBe('$1.00');
    expect(fmtUsd('1234.5')).toBe('$1,234.50');
    expect(fmtUsd('1234567.891')).toBe('$1,234,567.89');
  });
  it('rounds half up on the exact digits, not on a float', () => {
    expect(fmtUsd('0.285')).toBe('$0.285');
    expect(fmtUsd('1.005')).toBe('$1.01');
    expect(fmtUsd('2.675')).toBe('$2.68');
    expect(fmtUsd('99999999999999999.995')).toBe('$100,000,000,000,000,000.00');
  });
  it('keeps up to 4 decimals below $1', () => {
    expect(fmtUsd('0.0412')).toBe('$0.0412');
    expect(fmtUsd('0.5')).toBe('$0.50');
    expect(fmtUsd('0.04')).toBe('$0.04');
    expect(fmtUsd('0.041')).toBe('$0.041');
    expect(fmtUsd('0.99996')).toBe('$1.00');
  });
  it('never shows a non-zero value as zero', () => {
    expect(fmtUsd('0.00001')).toBe('<$0.0001');
    expect(fmtUsd('0.0001')).toBe('$0.0001');
  });
  it('uses a typographic minus and optional plus', () => {
    expect(fmtUsd('-12')).toBe('−$12.00');
    expect(fmtUsdChange('134.46')).toBe('+$134.46');
    expect(fmtUsdChange('-134.46')).toBe('−$134.46');
    expect(fmtUsdChange('0')).toBe('$0.00');
    expect(fmtUsd('-0.001')).toBe('−$0.001');
  });
  it('marks a tiny negative as below the smallest shown value', () => {
    expect(fmtUsd('-0.00001')).toBe('−<$0.0001');
  });
  it('compacts volumes only when asked', () => {
    expect(fmtUsd('1234567', { compact: true })).toBe('$1.2M');
    expect(fmtUsd('999', { compact: true })).toBe('$999.00');
    expect(fmtUsd('1000', { compact: true })).toBe('$1.0K');
    expect(fmtUsd('999950', { compact: true })).toBe('$1.0M');
    expect(fmtUsd('2500000000', { compact: true })).toBe('$2.5B');
    expect(fmtUsd('1234567')).toBe('$1,234,567.00');
  });
  it('returns the dash for unknown input, never 0', () => {
    expect(fmtUsd(null)).toBe(UNKNOWN);
    expect(fmtUsd(undefined)).toBe(UNKNOWN);
    expect(fmtUsd('')).toBe(UNKNOWN);
    expect(fmtUsd('abc')).toBe(UNKNOWN);
    expect(fmtUsdChange(null)).toBe(UNKNOWN);
  });
});

describe('fmtPrice', () => {
  it('uses the tick size as the number of decimals, fixed', () => {
    expect(fmtPrice('65242.3', '0.01')).toBe('65,242.30');
    expect(fmtPrice('1.0036', '0.0001')).toBe('1.0036');
    expect(fmtPrice('1.00364', '0.0001')).toBe('1.0036');
    expect(fmtPrice('3000', '1')).toBe('3,000');
    expect(fmtPrice('0.00001234', '0.00000001')).toBe('0.00001234');
  });
  it('treats a tick like 10 as zero decimals', () => {
    expect(fmtPrice('12345', '10')).toBe('12,345');
  });
  it('falls back to the value digits when the tick is unknown', () => {
    expect(fmtPrice('65242.3', null)).toBe('65,242.3');
  });
  it('never shows a non-zero price as zero', () => {
    expect(fmtPrice('0.000000001', '0.01')).toBe('0.000000001');
  });
  it('dash for unknown', () => {
    expect(fmtPrice(null, '0.01')).toBe(UNKNOWN);
    expect(fmtPrice('x', '0.01')).toBe(UNKNOWN);
  });
});

describe('fmtAmount', () => {
  it('trims trailing zeros by default and keeps them in fixed columns', () => {
    expect(fmtAmount('3.74800000')).toBe('3.748');
    expect(fmtAmount('3.748', { places: 4, fixed: true })).toBe('3.7480');
    expect(fmtAmount('15.11')).toBe('15.11');
    expect(fmtAmount('1000')).toBe('1,000');
  });
  it('rounds to the asset precision, half up or down', () => {
    expect(fmtAmount('0.123456789', { places: 8 })).toBe('0.12345679');
    expect(fmtAmount('0.123456789', { places: 8, round: 'down' })).toBe('0.12345678');
  });
  it('never rounds a non-zero amount to zero', () => {
    expect(fmtAmount('0.000000001', { places: 8 })).toBe('0.000000001');
    expect(fmtAmount('0.000000001', { places: 8, round: 'down' })).toBe('0.000000001');
  });
  it('shows a true zero as 0', () => {
    expect(fmtAmount('0')).toBe('0');
    expect(fmtAmount('0', { places: 2, fixed: true })).toBe('0.00');
  });
  it('keeps 18-place precision in the grouped integer part (no float)', () => {
    expect(fmtAmount('123456789012345678.123456789012345678', { places: 18 })).toBe('123,456,789,012,345,678.123456789012345678');
  });
  it('dash for unknown', () => {
    expect(fmtAmount(null)).toBe(UNKNOWN);
    expect(fmtAmount('1e5')).toBe(UNKNOWN);
  });
});

describe('fmtPctPoints', () => {
  it('reads a CCXT percent (already x100) and prints the same text as fmtPct', () => {
    expect(fmtPctPoints('-0.597971947108675048')).toBe('−0.60%');
    expect(fmtPctPoints('2.5')).toBe('+2.50%');
    expect(fmtPctPoints('0')).toBe('0.00%');
    expect(fmtPctPoints('4.02')).toBe(fmtPct('0.0402'));
  });
  it('is unknown, never zero, for a missing value', () => {
    expect(fmtPctPoints(null)).toBe(UNKNOWN);
    expect(fmtPctPoints('abc')).toBe(UNKNOWN);
  });
});

describe('fmtPct', () => {
  it('takes a ratio and prints a signed percent with a typographic minus', () => {
    expect(fmtPct('-0.0028')).toBe('−0.28%');
    expect(fmtPct('0.0402')).toBe('+4.02%');
    expect(fmtPct('0.0124')).toBe('+1.24%');
    expect(fmtPct('1.5')).toBe('+150.00%');
  });
  it('rounds on the exact digits', () => {
    expect(fmtPct('0.00285')).toBe('+0.29%');
    expect(fmtPct('-0.00285')).toBe('−0.29%');
    expect(fmtPct('0.002849999')).toBe('+0.28%');
  });
  it('shows zero and near-zero without a sign', () => {
    expect(fmtPct('0')).toBe('0.00%');
    expect(fmtPct('0.00001')).toBe('0.00%');
    expect(fmtPct('-0.00001')).toBe('0.00%');
  });
  it('can drop the plus sign', () => {
    expect(fmtPct('0.0402', { signed: false })).toBe('4.02%');
    expect(fmtPct('-0.0402', { signed: false })).toBe('−4.02%');
  });
  it('dash for unknown', () => {
    expect(fmtPct(null)).toBe(UNKNOWN);
    expect(fmtPct('nope')).toBe(UNKNOWN);
  });
});

describe('fmtChangeLine and direction', () => {
  it('joins the dollar and percent change', () => {
    expect(fmtChangeLine('134.46', '0.0402')).toBe('+$134.46 (+4.02%)');
    expect(fmtChangeLine('-5', '-0.01')).toBe('−$5.00 (−1.00%)');
  });
  it('drops the percent when only that is unknown, and dashes when the amount is', () => {
    expect(fmtChangeLine('134.46', null)).toBe('+$134.46');
    expect(fmtChangeLine(null, '0.01')).toBe(UNKNOWN);
  });
  it('reports a direction for the glyph', () => {
    expect(direction('0.01')).toBe('up');
    expect(direction('-0.01')).toBe('down');
    expect(direction('0')).toBe('flat');
    expect(direction(null)).toBeNull();
  });
});
