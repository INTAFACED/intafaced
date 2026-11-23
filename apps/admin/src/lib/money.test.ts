import { describe, expect, it } from 'vitest';
import {
  addDecimal,
  amountFor,
  compareDecimal,
  describeAmounts,
  formatAmount,
  formatMoney,
  isDecimalString,
  permille,
  sumByAsset,
  toScaled,
} from './money';

describe('decimal strings, no floats', () => {
  it('accepts only the wire format', () => {
    for (const ok of ['0', '12', '0.5', '1234567890123456789.123456789012345678']) expect(isDecimalString(ok)).toBe(true);
    for (const bad of ['', '-1', '1.', '.5', '1e3', '1,000', ' 1', '1.1234567890123456789', 12, null])
      expect(isDecimalString(bad)).toBe(false);
  });

  it('keeps precision a JS number would lose', () => {
    // 0.1 + 0.2 and 2^53+1 both go wrong as numbers.
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    expect(addDecimal('9007199254740993', '1')).toBe('9007199254740994');
    expect(addDecimal('0.000000000000000001', '0.000000000000000001')).toBe('0.000000000000000002');
    expect(toScaled('1')).toBe(10n ** 18n);
  });

  it('compares exactly', () => {
    expect(compareDecimal('10', '9.99')).toBe(1);
    expect(compareDecimal('1.10', '1.1')).toBe(0);
    expect(compareDecimal('0.000000000000000001', '0')).toBe(1);
    expect(compareDecimal('9007199254740992', '9007199254740993')).toBe(-1);
  });
});

describe('display', () => {
  it('groups thousands, keeps at least two places and never drops a real digit', () => {
    expect(formatAmount('1234567.5')).toBe('1,234,567.50');
    expect(formatAmount('0')).toBe('0.00');
    expect(formatAmount('1000.123456789')).toBe('1,000.123456789');
    expect(formatAmount('12.10')).toBe('12.10');
    expect(formatMoney('5', 'USDT')).toBe('5.00 USDT');
  });

  it('shows a dash for something that is not an amount rather than inventing one', () => {
    expect(formatAmount('abc')).toBe('—');
    expect(formatAmount('-5')).toBe('—');
  });

  it('describes per-asset lists and treats empty as none, not zero', () => {
    expect(describeAmounts([])).toBe('none');
    expect(
      describeAmounts([
        { assetCode: 'USD', amount: '1' },
        { assetCode: 'USDT', amount: '2.5' },
      ]),
    ).toBe('1.00 USD · 2.50 USDT');
  });
});

describe('per-asset totals', () => {
  it('never adds two assets together', () => {
    const { totals } = sumByAsset([
      { assetCode: 'USDT', amount: '1.5' },
      { assetCode: 'USD', amount: '2' },
      { assetCode: 'USDT', amount: '0.25' },
    ]);
    expect(totals).toEqual([
      { assetCode: 'USD', amount: '2' },
      { assetCode: 'USDT', amount: '1.75' },
    ]);
  });

  it('skips and counts a malformed amount instead of guessing', () => {
    const { totals, skipped } = sumByAsset([
      { assetCode: 'USD', amount: '1' },
      { assetCode: 'USD', amount: 'NaN' },
    ]);
    expect(skipped).toBe(1);
    expect(totals).toEqual([{ assetCode: 'USD', amount: '1' }]);
  });

  it('amountFor returns null when the asset is absent, which is not zero', () => {
    expect(amountFor([{ assetCode: 'USD', amount: '0' }], 'USD')).toBe('0');
    expect(amountFor([{ assetCode: 'USD', amount: '0' }], 'USDT')).toBeNull();
  });
});

describe('bar ratios', () => {
  it('computes permille in bigint and clamps', () => {
    expect(permille('50', '200')).toBe(250);
    expect(permille('200', '200')).toBe(1000);
    expect(permille('300', '200')).toBe(1000);
    expect(permille('5', '0')).toBe(0);
    expect(permille('0.000000000000000001', '1')).toBe(0);
  });
});
