import { describe, expect, it } from 'vitest';
import { spotOrdersOf } from './venue-desk';

describe('spotOrdersOf', () => {
  const markets = [
    { symbol: 'BTC-USDC', kind: 'spot' as const },
    { symbol: 'BTC-PERP', kind: 'perpetual' as const },
  ];
  it('keeps the spot desk to spot orders: a perpetual order belongs on the futures desk; an unlisted market stays', () => {
    const orders = { asOf: 'x', value: [{ symbol: 'BTC-USDC' }, { symbol: 'BTC-PERP' }, { symbol: 'NEW-USDC' }] };
    expect(spotOrdersOf(orders, markets)?.value.map((o) => o.symbol)).toEqual(['BTC-USDC', 'NEW-USDC']);
    expect(spotOrdersOf(null, markets)).toBeNull();
  });
});
