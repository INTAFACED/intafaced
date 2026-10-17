import { describe, expect, it } from 'vitest';
import { merchantEffectiveRateSchema } from '@intafaced/contracts';
import { exactFeeRate } from './effective-rate.js';

describe('exact fee rate', () => {
  it('divides fees by gross when the quotient fits 6 decimal places', () => {
    expect(exactFeeRate('1', '10')).toEqual({ fees: '1', gross: '10', rate: '0.1', rateStatus: 'exact' });
    expect(exactFeeRate('1.5', '100')).toEqual({ fees: '1.5', gross: '100', rate: '0.015', rateStatus: 'exact' });
    expect(exactFeeRate('1', '4')).toEqual({ fees: '1', gross: '4', rate: '0.25', rateStatus: 'exact' });
    expect(exactFeeRate('1', '64')).toEqual({ fees: '1', gross: '64', rate: '0.015625', rateStatus: 'exact' });
  });

  it('rounds a non-terminating quotient down to 6 decimal places and publishes that status', () => {
    const third = exactFeeRate('1', '3');
    expect(third).toEqual({ fees: '1', gross: '3', rate: '0.333333', rateStatus: 'rounded' });
    expect(merchantEffectiveRateSchema.safeParse({ assetCode: 'USDT', ...third }).success).toBe(true);
    expect(exactFeeRate('1', '7')).toEqual({ fees: '1', gross: '7', rate: '0.142857', rateStatus: 'rounded' });
    expect(exactFeeRate('1', '10000000')).toEqual({ fees: '1', gross: '10000000', rate: '0', rateStatus: 'rounded' });
  });

  it('publishes no rate for a zero gross and refuses a negative input', () => {
    expect(exactFeeRate('1', '0')).toEqual({ fees: '1', gross: '0', rate: null, rateStatus: 'no_volume' });
    expect(exactFeeRate('0', '0')).toEqual({ fees: '0', gross: '0', rate: null, rateStatus: 'no_volume' });
    const negative = exactFeeRate('-1', '3');
    expect(negative).toEqual({ fees: '-1', gross: '3', rate: null, rateStatus: 'refused' });
    expect(negative.rateStatus).not.toBe('not_terminating');
    expect(exactFeeRate('1', '-3')).toEqual({ fees: '1', gross: '-3', rate: null, rateStatus: 'refused' });
    expect(exactFeeRate('-1', '0')).toEqual({ fees: '-1', gross: '0', rate: null, rateStatus: 'refused' });
    expect(merchantEffectiveRateSchema.safeParse({ assetCode: 'USDT', ...negative }).success).toBe(true);
    expect(
      merchantEffectiveRateSchema.safeParse({ assetCode: 'USDT', fees: '1', gross: '3', rate: '0.333333', rateStatus: 'exact' }).success,
    ).toBe(false);
  });
});
