import { describe, expect, it } from 'vitest';
import type { MarketRow, TickerRow } from '../../../data';
import {
  BLANK_FILTERS,
  boundOf,
  findByName,
  isBadBound,
  listSymbols,
  orderedColumns,
  resultsCsv,
  resultsFileName,
  screen,
  screenId,
  timeframeChange,
  withScreen,
  type CandleRow,
} from './model';

const market = (symbol: string): MarketRow => {
  const [base, quote] = symbol.split('/') as [string, string];
  return { symbol, base, quote, orderable: true, tickSize: '0.01', lotSize: '0.0001', minAmount: null, listedAt: null };
};
const ticker = (symbol: string, last: string, changePct24h: string | null, volume = '10'): TickerRow => ({
  symbol,
  last,
  bid: null,
  ask: null,
  open24h: null,
  high24h: null,
  low24h: null,
  change24h: null,
  changePct24h,
  baseVolume24h: volume,
  quoteVolume24h: null,
  windowStart: null,
  source: 'server',
});

const markets = ['BTC/USDT', 'ETH/USDT', 'ETH/BTC', 'IFC/USDT'].map(market);
const tickers = {
  'BTC/USDT': ticker('BTC/USDT', '65000', '0.0612'),
  'ETH/USDT': ticker('ETH/USDT', '3000', '0.05'),
  'ETH/BTC': ticker('ETH/BTC', '0.05', '0.09'),
  'IFC/USDT': ticker('IFC/USDT', '1.2', null, '0'),
};
const symbols = (result: ReturnType<typeof screen>) => result.rows.map((row) => row.market.symbol);

describe('screen', () => {
  it('keeps the rows matching both "change above 5 percent" and "quote USDT", strictly above the bound', () => {
    const result = screen(markets, tickers, { ...BLANK_FILTERS, quote: 'USDT', changeMin: '5' }, null);
    expect(symbols(result)).toEqual(['BTC/USDT']);
    expect(result.removedBy).toBeNull();
  });

  it('ignores a blank bound: every market passes, a market with no change too', () => {
    expect(symbols(screen(markets, tickers, BLANK_FILTERS, null))).toEqual(['BTC/USDT', 'ETH/USDT', 'ETH/BTC', 'IFC/USDT']);
  });

  it('never lets a market with an unknown figure pass a bound on it', () => {
    expect(symbols(screen(markets, tickers, { ...BLANK_FILTERS, changeMin: '-100' }, null))).not.toContain('IFC/USDT');
    expect(symbols(screen(markets, undefined, { ...BLANK_FILTERS, lastMin: '0' }, null))).toEqual([]);
  });

  it('names the first filter that left no row', () => {
    expect(screen(markets, tickers, { ...BLANK_FILTERS, quote: 'USDT', changeMin: '900' }, null).removedBy).toBe('changeMin');
    expect(screen(markets, tickers, { ...BLANK_FILTERS, quote: 'EUR', changeMin: '900' }, null).removedBy).toBe('quote');
    expect(screen(markets, tickers, { ...BLANK_FILTERS, lastMax: '0.01' }, null).removedBy).toBe('lastMax');
  });

  it('screens one watchlist only, and an empty list leaves nothing, named as the list', () => {
    expect(symbols(screen(markets, tickers, BLANK_FILTERS, ['ETH/USDT', 'DOGE/USDT']))).toEqual(['ETH/USDT']);
    expect(screen(markets, tickers, BLANK_FILTERS, []).removedBy).toBe('universe');
  });

  it('holds the last price range inclusive and the volume bound strict', () => {
    expect(symbols(screen(markets, tickers, { ...BLANK_FILTERS, lastMin: '3000', lastMax: '65000' }, null))).toEqual([
      'BTC/USDT',
      'ETH/USDT',
    ]);
    expect(symbols(screen(markets, tickers, { ...BLANK_FILTERS, volumeMin: '0' }, null))).toEqual(['BTC/USDT', 'ETH/USDT', 'ETH/BTC']);
  });
});

describe('bounds', () => {
  it('reads a typed bound as a decimal, and blank as not set', () => {
    expect(boundOf(' 5 ')).toBe('5');
    expect(boundOf('-0.5')).toBe('-0.5');
    expect(boundOf('')).toBeNull();
    expect(isBadBound('')).toBe(false);
    expect(isBadBound('5%')).toBe(true);
    expect(isBadBound('1e3')).toBe(true);
  });
});

describe('timeframeChange', () => {
  const hour = 3_600_000;
  const now = 100 * hour + 600_000;
  it('measures the last price against the close of the bar before the open one', () => {
    const candles: CandleRow[] = [
      [99 * hour, '100', '100', '100', '100', '1'],
      [100 * hour, '100', '110', '100', '110', '1'],
    ];
    expect(timeframeChange(candles, '110', '1h', now)).toBe('0.1');
  });
  it('uses the newest earlier bar when the open bar has no trades yet', () => {
    expect(timeframeChange([[97 * hour, '1', '1', '1', '200', '1']], '100', '1h', now)).toBe('-0.5');
  });
  it('is null with no bar before the open one, or no last price', () => {
    expect(timeframeChange([[100 * hour, '1', '1', '1', '1', '1']], '1', '1h', now)).toBeNull();
    expect(timeframeChange([[99 * hour, '1', '1', '1', '1', '1']], null, '1h', now)).toBeNull();
  });
});

describe('saved screens', () => {
  const momentum = { id: screenId('Momentum'), name: 'Momentum', filters: BLANK_FILTERS, columns: [], changeTimeframe: '24h' as const };
  it('gives one name one id, whatever its case', () => {
    expect(screenId(' momentum ')).toBe(screenId('Momentum'));
    expect(screenId('Momentum')).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    expect(findByName([momentum], 'MOMENTUM')).toBe(momentum);
  });
  it('replaces a screen in place, or adds a new one at the end', () => {
    const updated = { ...momentum, filters: { ...BLANK_FILTERS, changeMin: '5' } };
    expect(withScreen([momentum], updated)).toEqual([updated]);
    const other = { ...momentum, id: screenId('Other'), name: 'Other' };
    expect(withScreen([momentum], other)).toEqual([momentum, other]);
  });
});

describe('export', () => {
  it('writes the shown columns in their fixed order, an unknown figure as an empty cell', () => {
    const rows = screen(markets, tickers, { ...BLANK_FILTERS, quote: 'USDT' }, null).rows;
    const csv = resultsCsv(rows, ['volume', 'last', 'change'], '1h', (row) => (row.market.symbol === 'BTC/USDT' ? '0.01' : null));
    expect(csv.trim().split('\n')).toEqual([
      'symbol,last,change_pct_1h,volume_24h',
      'BTC/USDT,65000,0.01,10',
      'ETH/USDT,3000,,10',
      'IFC/USDT,1.2,,0',
    ]);
    expect(resultsFileName('My Momentum!')).toBe('screen-my-momentum.csv');
    expect(resultsFileName(null)).toBe('screen-results.csv');
  });
  it('orders picked columns as the table draws them', () => {
    expect(orderedColumns(['low', 'last', 'change'])).toEqual(['last', 'change', 'low']);
  });
  it('reads a watchlist in section order', () => {
    const lists = [
      {
        id: 'main',
        name: 'Watchlist',
        flag: null,
        sections: [
          { id: 'a', title: 'A', collapsed: false, symbols: ['ETH/USDT'] },
          { id: 'b', title: 'B', collapsed: false, symbols: ['BTC/USDT'] },
        ],
      },
    ];
    expect(listSymbols(lists, 'main')).toEqual(['ETH/USDT', 'BTC/USDT']);
    expect(listSymbols(lists, 'gone')).toBeNull();
  });
});
