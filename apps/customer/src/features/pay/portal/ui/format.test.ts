import { describe, expect, it } from 'vitest';
import { effectiveFeeRate, formatDay, formatMoney, isRounded, moneyPlaces } from './format';

describe('formatMoney', () => {
  it('pads fiat and stablecoins to two places and groups thousands', () => {
    expect(formatMoney('118.2', 'USD')).toBe('118.20');
    expect(formatMoney('20', 'USDT')).toBe('20.00');
    expect(formatMoney('1234567.5', 'USD')).toBe('1,234,567.50');
    expect(moneyPlaces('USD')).toBe(2);
    expect(moneyPlaces('BTC')).toBe(8);
  });
  it('gives other assets two to eight places', () => {
    expect(formatMoney('20', 'BTC')).toBe('20.00');
    expect(formatMoney('0.5', 'BTC')).toBe('0.50');
    expect(formatMoney('0.123456789', 'BTC')).toBe('0.12345679');
  });
  it('never rounds a figure through a float, and never shows a real amount as zero', () => {
    expect(formatMoney('9007199254740993.005', 'USD')).toBe('9,007,199,254,740,993.01');
    expect(formatMoney('0.001', 'USD')).toBe('0.001');
    expect(formatMoney('0.1', 'USD')).toBe('0.10');
  });
  it('shows every digit when exact, at least two places', () => {
    expect(formatMoney('12.345678', 'USDT', { exact: true })).toBe('12.345678');
    expect(formatMoney('12', 'USDT', { exact: true })).toBe('12.00');
    expect(formatMoney('-1234.5', 'USD', { exact: true })).toBe('−1,234.50');
  });
  it('signs a fee or a debit, but never zero', () => {
    expect(formatMoney('1.2', 'USD', { sign: 'minus' })).toBe('−1.20');
    expect(formatMoney('3', 'USD', { sign: 'plus' })).toBe('+3.00');
    expect(formatMoney('0', 'USD', { sign: 'minus' })).toBe('0.00');
  });
  it('says so when the input is not a decimal', () => {
    expect(formatMoney('abc', 'USD')).toBe('—');
    expect(formatMoney('abc', 'USD', { exact: true })).toBe('—');
  });
  it('knows when the compact figure hides digits', () => {
    expect(isRounded('12.345678', 'USDT')).toBe(true);
    expect(isRounded('12.3', 'USDT')).toBe(false);
  });
});

describe('effectiveFeeRate', () => {
  it('is fees divided by gross, exactly', () => {
    expect(effectiveFeeRate('1.5', '100')).toBe('1.50%');
    expect(effectiveFeeRate('1.20', '47.13')).toBe('2.55%');
    expect(effectiveFeeRate('0.30', '0.30')).toBe('100.00%');
  });
  it('has no rate without a gross to divide by', () => {
    expect(effectiveFeeRate('1', '0')).toBeNull();
    expect(effectiveFeeRate('1', 'x')).toBeNull();
  });
});

describe('formatDay', () => {
  it('is a date only, in the zone asked for', () => {
    expect(formatDay('2026-10-15T00:00:00.000Z', 'en', 'UTC')).toBe('Oct 15, 2026');
    expect(formatDay('nope', 'en')).toBeNull();
  });
});
