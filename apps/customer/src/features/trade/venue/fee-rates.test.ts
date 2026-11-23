import { describe, expect, it } from 'vitest';
import { bpsToPercent, feeShown, rateShown } from './fee-rates';

describe('a venue fee rate as read', () => {
  it('moves the point two places, exactly', () => {
    expect(bpsToPercent('3.5')).toBe('0.035');
    expect(bpsToPercent('100')).toBe('1');
    expect(bpsToPercent('10')).toBe('0.1');
    expect(bpsToPercent('0.8')).toBe('0.008');
    expect(bpsToPercent('-1')).toBe('-0.01');
    expect(bpsToPercent('0')).toBe('0');
    expect(bpsToPercent('0.0000')).toBe('0');
    expect(bpsToPercent('12345.5')).toBe('123.455');
  });
  it('reads zero as zero, below zero as the rebate, never a negative fee', () => {
    expect(rateShown('0')).toEqual({ kind: 'zero' });
    expect(rateShown('-1')).toEqual({ kind: 'rebate', value: '0.01' });
    expect(rateShown('3.5')).toEqual({ kind: 'fee', value: '0.035' });
    expect(feeShown('0.000000')).toEqual({ kind: 'zero' });
    expect(feeShown('-5')).toEqual({ kind: 'rebate', value: '5' });
    expect(feeShown('0.0007')).toEqual({ kind: 'fee', value: '0.0007' });
  });
});
