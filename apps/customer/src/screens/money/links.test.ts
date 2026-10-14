import { describe, expect, it } from 'vitest';
import { buyHref } from './links';

describe('buyHref', () => {
  it('Simple opens the Buy card, with the coin and side', () => {
    expect(buyHref(null, null, false)).toBe('/trade/buy?side=buy');
    expect(buyHref(null, null, true)).toBe('/trade/buy?side=sell');
    expect(buyHref('BTC', 'BTC/USDT', true)).toBe('/trade/buy?asset=BTC&side=sell');
  });
  it('Pro opens the desk, spelling the pair with a dash even when the market symbol has a slash', () => {
    expect(buyHref(null, null, false, 'pro')).toBe('/trade/spot/BTC-USDT');
    expect(buyHref('ETH', 'ETH/USDT', false, 'pro')).toBe('/trade/spot/ETH-USDT');
    expect(buyHref('ETH', 'ETH/USDT', true, 'pro')).toBe('/trade/spot/ETH-USDT?side=sell');
  });
});
