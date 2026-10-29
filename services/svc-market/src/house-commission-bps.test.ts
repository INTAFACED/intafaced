import { describe, expect, it } from 'vitest';
import { marketHouseCommissionBpsSchema, marketRefundWindowSecondsSchema } from './house-commission-bps.js';

describe('MARKET_HOUSE_COMMISSION_BPS — blank is unset, not 0', () => {
  it('treats missing, empty, and whitespace as unset', () => {
    for (const raw of [undefined, null, '', ' ', '  ', '\t', '\n', ' \t\n ']) {
      expect(marketHouseCommissionBpsSchema.parse(raw)).toBeUndefined();
    }
  });

  it('keeps an explicit owner 0', () => {
    expect(marketHouseCommissionBpsSchema.parse('0')).toBe(0);
    expect(marketHouseCommissionBpsSchema.parse(0)).toBe(0);
  });

  it('parses a configured rate', () => {
    expect(marketHouseCommissionBpsSchema.parse('500')).toBe(500);
  });
});

describe('MARKET_REFUND_WINDOW_SECONDS — blank is unset, never a default', () => {
  it('treats missing, empty, and whitespace as unset', () => {
    for (const raw of [undefined, null, '', ' ', '\t\n']) {
      expect(marketRefundWindowSecondsSchema.parse(raw)).toBeUndefined();
    }
  });

  it('parses whole seconds from 1 to one year', () => {
    expect(marketRefundWindowSecondsSchema.parse('3600')).toBe(3600);
    expect(marketRefundWindowSecondsSchema.parse('1')).toBe(1);
    expect(marketRefundWindowSecondsSchema.parse('31536000')).toBe(31_536_000);
  });

  it('refuses zero, negatives, fractions, words and more than a year', () => {
    for (const raw of ['0', '-1', '1.5', 'week', '31536001']) {
      expect(marketRefundWindowSecondsSchema.safeParse(raw).success).toBe(false);
    }
  });
});
