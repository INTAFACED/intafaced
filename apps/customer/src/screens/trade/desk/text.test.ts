import { describe, expect, it } from 'vitest';
import { changeLine, dollarPrice, partialWindowStart, placesOf, signedPrice, turnoverText } from './text';

describe('desk text', () => {
  it('shows plain quote prices (no "$") and keeps the tick decimals (critic L8)', () => {
    expect(dollarPrice('65000', { quote: 'USDT', tickSize: '0.01' })).toBe('65,000.00');
    expect(dollarPrice('0.4120', { quote: 'USDT', tickSize: '0.0001' })).toBe('0.4120');
    expect(dollarPrice('2', { quote: 'BTC', tickSize: '0.0001' })).toBe('2.0000');
    expect(dollarPrice(null, { quote: 'USDT', tickSize: '0.01' })).toBe('—');
  });

  it('writes signed changes with the real minus', () => {
    expect(signedPrice('500', '0.01')).toBe('+500.00');
    expect(signedPrice('-153.5', '0.01')).toBe('−153.50');
    expect(changeLine({ change24h: '-153.5', changePct24h: '-0.0018' }, '0.01')).toBe('−153.50 (−0.18%)');
    expect(changeLine({ change24h: null, changePct24h: null }, '0.01')).toBe('—');
  });

  it('says when the 24h figures cover less than a day', () => {
    const now = 1_000_000_000_000;
    expect(partialWindowStart({ windowStart: now - 5 * 3_600_000 }, now)).toBe(now - 5 * 3_600_000);
    expect(partialWindowStart({ windowStart: now - 30 * 3_600_000 }, now)).toBeNull();
    expect(partialWindowStart({ windowStart: null }, now)).toBeNull();
  });

  it('counts decimals of a step and compacts dollar turnover', () => {
    expect(placesOf('0.00001')).toBe(5);
    expect(placesOf('1')).toBe(0);
    expect(placesOf('0.0100')).toBe(2);
    expect(turnoverText('123053.19', 'USDT')).toBe('$123.1K');
  });
});
