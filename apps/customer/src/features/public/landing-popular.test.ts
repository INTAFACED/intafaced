import { describe, expect, it } from 'vitest';
import { popularOf, type Line } from './HomePage';

const line = (symbol: string, last: string | undefined, volume: string): Line =>
  ({ market: { symbol }, ticker: last === undefined ? undefined : { last, quoteVolume24h: volume } }) as unknown as Line;

describe('the landing board’s Popular tab', () => {
  it('lists the markets with a last trade by 24h volume, and leaves a market with no print out', () => {
    const lines = [line('ETH/USDT', '3200.10', '500'), line('BTC/USDC', undefined, '0'), line('BTC/USDT', '67812.40', '900')];
    expect(popularOf(lines).map((l) => l.market.symbol)).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('leaves out a market whose ticker has no last price yet', () => {
    const lines = [line('SOL/USDT', '', '100'), line('XRP/USDT', '0.5230', '50')];
    expect(popularOf(lines).map((l) => l.market.symbol)).toEqual(['XRP/USDT']);
  });
});
