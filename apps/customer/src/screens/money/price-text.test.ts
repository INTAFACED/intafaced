import { describe, expect, it } from 'vitest';
import { fmtCoinPrice, marketName } from './price-text';

describe('fmtCoinPrice', () => {
  it('shows cents from a dollar up, four places under it, and a tiny price in full', () => {
    expect(fmtCoinPrice('65168.125')).toBe('$65,168.13');
    expect(fmtCoinPrice('1')).toBe('$1.00');
    expect(fmtCoinPrice('0.6173')).toBe('$0.6173');
    expect(fmtCoinPrice('0.00001234')).toBe('$0.00001234');
  });
});

describe('marketName', () => {
  it('splits base and quote at the last hyphen only', () => {
    expect(marketName('BTC-USDT')).toBe('BTC/USDT');
    expect(marketName('X-1-USDT')).toBe('X-1/USDT');
  });
});
