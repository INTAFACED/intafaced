import { describe, expect, it } from 'vitest';
import { USD_UNIT, usdToBtc, valueText } from './display-unit';

// TEST figures only.
describe('usdToBtc', () => {
  it('divides by the price and rounds half-up to 8 places once', () => {
    expect(usdToBtc('65000', '65000')).toBe('1.00000000');
    expect(usdToBtc('1', '65000')).toBe('0.00001538');
    // 0.000000005 BTC exactly: half rounds up.
    expect(usdToBtc('0.0005', '100000')).toBe('0.00000001');
    expect(usdToBtc('0.00049', '100000')).toBe('0.00000000');
    expect(usdToBtc('-1', '65000')).toBe('-0.00001538');
  });

  it('gives nothing for an unknown value or a price that is not positive', () => {
    expect(usdToBtc(null, '65000')).toBeNull();
    expect(usdToBtc('bad', '65000')).toBeNull();
    expect(usdToBtc('1', '0')).toBeNull();
  });
});

describe('valueText', () => {
  const usd = (value: string) => `$${value}`;
  it('formats dollars through the screen formatter and BTC with its sign', () => {
    expect(valueText(USD_UNIT, '12.5', usd)).toBe('$12.5');
    expect(valueText({ code: 'BTC', priceUsd: '50000' }, '12.5', usd)).toBe('₿0.00025000');
    expect(valueText({ code: 'BTC', priceUsd: '50000' }, null, usd)).toBeNull();
  });
});
