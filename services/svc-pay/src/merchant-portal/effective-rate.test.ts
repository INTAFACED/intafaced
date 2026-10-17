import { describe, expect, it } from 'vitest';
import { exactFeeRate } from './effective-rate.js';

describe('exact fee rate', () => {
  it('divides fees by gross when the quotient fits 18 decimal places', () => {
    expect(exactFeeRate('1', '10')).toEqual({ fees: '1', gross: '10', rate: '0.1', rateStatus: 'exact' });
    expect(exactFeeRate('1.5', '100')).toEqual({ fees: '1.5', gross: '100', rate: '0.015', rateStatus: 'exact' });
    expect(exactFeeRate('1', '4')).toEqual({ fees: '1', gross: '4', rate: '0.25', rateStatus: 'exact' });
  });

  it('refuses to round a non-terminating quotient or to treat a zero gross as zero', () => {
    expect(exactFeeRate('1', '3')).toEqual({ fees: '1', gross: '3', rate: null, rateStatus: 'not_terminating' });
    expect(exactFeeRate('1', '0')).toEqual({ fees: '1', gross: '0', rate: null, rateStatus: 'gross_zero' });
    expect(exactFeeRate('0', '0')).toEqual({ fees: '0', gross: '0', rate: null, rateStatus: 'gross_zero' });
  });
});
