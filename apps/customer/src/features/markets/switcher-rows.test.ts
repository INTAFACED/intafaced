import { describe, expect, it } from 'vitest';
import type { MarketRow } from '../../data';
import { pickRows, readRecent, rememberRecent, rowsOf, splitMatch, targetOf, RECENT_KEY } from './switcher-rows';

const market = (symbol: string, base: string, quote: string): MarketRow => ({
  symbol,
  base,
  quote,
  orderable: true,
  tickSize: '0.01',
  lotSize: '0.001',
  minAmount: null,
  listedAt: null,
  listing: 'open',
  delistsAt: null,
});

const shown = () => false;

describe('switcher rows', () => {
  it('sends a perpetual to the futures desk and a spot pair to the spot desk, and nowhere the build hides', () => {
    expect(targetOf(market('BTC-PERP', 'BTC', 'USDC'), 'perp', shown)).toBe('/trade/futures/BTC-PERP');
    expect(targetOf(market('BTC/USDC', 'BTC', 'USDC'), 'spot', shown)).toBe('/trade/spot/BTC-USDC');
    expect(targetOf(market('BTC-PERP', 'BTC', 'USDC'), 'perp', (path) => path.startsWith('/trade/futures'))).toBeNull();
  });

  it('lists perpetuals first, the exact coin before a longer one, then the most traded', () => {
    const rows = rowsOf(
      [market('ENA-PERP', 'ENA', 'USDC'), market('ETHFI-PERP', 'ETHFI', 'USDC'), market('ETH-PERP', 'ETH', 'USDC')],
      [market('ETH/USDC', 'ETH', 'USDC'), market('ETH/USDT', 'ETH', 'USDT')],
      {
        'ETH/USDC': { quoteVolume24h: '10' } as never,
        'ETH/USDT': { quoteVolume24h: '20' } as never,
      },
      shown,
    );
    expect(pickRows(rows, 'eth', 'all', [], () => null).map((r) => r.pair)).toEqual(['ETH-PERP', 'ETHFI-PERP', 'ETH/USDT', 'ETH/USDC']);
    expect(pickRows(rows, 'ethereum', 'spot', [], (b) => (b === 'ETH' ? 'Ethereum' : null)).map((r) => r.pair)).toEqual([
      'ETH/USDT',
      'ETH/USDC',
    ]);
    expect(pickRows(rows, '', 'favorites', ['ETH/USDC'], () => null).map((r) => r.pair)).toEqual(['ETH/USDC']);
  });

  it('marks the matched part of a pair', () => {
    expect(splitMatch('ETHFI-PERP', 'eth')).toEqual(['', 'ETH', 'FI-PERP']);
    expect(splitMatch('BTC/USDC', 'usd')).toEqual(['BTC/', 'USD', 'C']);
    expect(splitMatch('BTC/USDC', '')).toEqual(['BTC/USDC', '', '']);
  });

  it('keeps the last five opened, newest first, and reads a broken store as none', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    for (const s of ['A', 'B', 'C', 'D', 'E', 'F', 'B']) rememberRecent({ symbol: s, kind: 'spot' }, storage);
    expect(readRecent(storage).map((p) => p.symbol)).toEqual(['B', 'F', 'E', 'D', 'C']);
    store.set(RECENT_KEY, '{not json');
    expect(readRecent(storage)).toEqual([]);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(rememberRecent({ symbol: 'X', kind: 'perp' }, throwing)).toEqual([{ symbol: 'X', kind: 'perp' }]);
  });
});
