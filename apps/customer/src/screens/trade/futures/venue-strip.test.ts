import { describe, expect, it } from 'vitest';
import { intervalText, percentOf } from './VenueFuturesDesk';

// J-derivatives-01 #4: the strip shows the venue's funding rate as a percent, digit for digit, sign kept.
describe('percentOf', () => {
  it('moves the decimal point two places and keeps every digit', () => {
    expect(percentOf('0.0000125')).toBe('0.00125');
    expect(percentOf('0.0001')).toBe('0.01');
    expect(percentOf('0.01')).toBe('1');
    expect(percentOf('1.5')).toBe('150');
    expect(percentOf('2')).toBe('200');
    expect(percentOf('0')).toBe('0');
  });
  it('keeps a negative rate negative, and never writes -0', () => {
    expect(percentOf('-0.0000125')).toBe('-0.00125');
    expect(percentOf('-0.0')).toBe('0');
  });
});

describe('intervalText', () => {
  it('names whole hours in hours, anything else in seconds', () => {
    expect(intervalText(3600)).toBe('1h');
    expect(intervalText(28_800)).toBe('8h');
    expect(intervalText(90)).toBe('90s');
  });
});
