import { describe, expect, it } from 'vitest';
import type { MarketRow, TickerRow } from '../../data';
import { buildRows, changeOver, DEFAULT_FILTERS, emptyReason, resultsCsv, screenRows, type ScreenRow } from './model';

const market = (symbol: string): MarketRow => {
  const [base, quote] = symbol.split('/');
  return { symbol, base: base!, quote: quote!, orderable: true, tickSize: '0.01', lotSize: '0.00001', minAmount: null, listedAt: null };
};
const ticker = (symbol: string, last: string, changePct24h: string, volume: string): TickerRow => ({
  symbol,
  last,
  bid: null,
  ask: null,
  open24h: null,
  high24h: '70000',
  low24h: '60000',
  change24h: null,
  changePct24h,
  baseVolume24h: volume,
  quoteVolume24h: null,
  windowStart: null,
  source: 'server',
});

const markets = [market('BTC/USDT'), market('ETH/USDT'), market('IFC/USDT'), market('BTC/USDC')];
const tickers = {
  'BTC/USDT': ticker('BTC/USDT', '65000', '0.0523', '12.5'),
  'ETH/USDT': ticker('ETH/USDT', '3000', '0.0100', '900'),
  'IFC/USDT': ticker('IFC/USDT', '0.5', '0.0600', '1000000'),
  'BTC/USDC': ticker('BTC/USDC', '64990', '-0.0200', '4'),
};

function rowsFor(timeframe: '24h' | '1h' | '1d' | '4h' = '24h', closes?: Record<string, string | null>): ScreenRow[] {
  return buildRows(markets, tickers, closes, timeframe, null);
}

describe('screener filters', () => {
  it('keeps the markets that pass both filters, change above 5 percent and quote USDT, with the count', () => {
    const result = screenRows(rowsFor(), { ...DEFAULT_FILTERS, quote: 'USDT', changeMin: '5' }, '24h');
    expect(result.rows.map((row) => row.symbol)).toEqual(['BTC/USDT', 'IFC/USDT']);
    expect(result.stages.map((stage) => stage.id)).toEqual(['universe', 'quote', 'change']);
  });

  it('names the filter that removed every market when nothing matches', () => {
    const result = screenRows(rowsFor(), { ...DEFAULT_FILTERS, quote: 'USDT', changeMin: '90' }, '24h');
    expect(result.rows).toEqual([]);
    expect(emptyReason(result.stages)).toBe('change');
    const quoteOnly = screenRows(rowsFor(), { ...DEFAULT_FILTERS, quote: 'EUR' }, '24h');
    expect(emptyReason(quoteOnly.stages)).toBe('quote');
  });

  it('does not apply a blank bound, and never a default one', () => {
    const result = screenRows(rowsFor(), { ...DEFAULT_FILTERS, changeMax: null, volumeMin: null }, '24h');
    expect(result.rows).toHaveLength(4);
    expect(result.stages.map((stage) => stage.id)).toEqual(['universe']);
  });

  it('compares a change bound exactly as a percent (0.0523 is 5.23 percent; 5 keeps it, 5.24 does not)', () => {
    expect(screenRows(rowsFor(), { ...DEFAULT_FILTERS, changeMin: '5.23' }, '24h').rows.map((row) => row.symbol)).toContain('BTC/USDT');
    expect(screenRows(rowsFor(), { ...DEFAULT_FILTERS, changeMin: '5.24' }, '24h').rows.map((row) => row.symbol)).not.toContain('BTC/USDT');
  });

  it('refuses a change filter over 4 h, since that timeframe is not served', () => {
    const result = screenRows(rowsFor('4h'), { ...DEFAULT_FILTERS, changeMin: '5' }, '4h');
    expect(result.rows).toEqual([]);
    expect(emptyReason(result.stages)).toBe('change');
    expect(changeOver('4h', tickers['BTC/USDT'], '60000')).toBeNull();
  });

  it('keeps the universe to one watchlist when the screen names one', () => {
    const universe = new Set(['ETH/USDT', 'BTC/USDC']);
    const rows = buildRows(markets, tickers, undefined, '24h', universe);
    expect(rows.map((row) => row.symbol)).toEqual(['ETH/USDT', 'BTC/USDC']);
  });
});

describe('per-column timeframe', () => {
  it('reads 24 h from the ticker and 1 h or 1 d from the close one bar back, as an exact ratio', () => {
    expect(changeOver('24h', tickers['BTC/USDT'], undefined)).toBe('0.0523');
    // 65000 against 62000 an hour ago: (65000 - 62000) / 62000.
    const change = changeOver('1h', tickers['BTC/USDT'], '62000');
    expect(change).not.toBeNull();
    expect(Number(change)).toBeCloseTo(3000 / 62000, 12);
  });

  it('shows no change when the close is missing, and not served for 4 h', () => {
    expect(changeOver('1d', tickers['BTC/USDT'], null)).toBeNull();
    expect(changeOver('4h', tickers['BTC/USDT'], '1')).toBeNull();
  });
});

describe('results as a file', () => {
  it('writes the symbol and the chosen columns, with an empty cell where a value is missing', () => {
    const rows = rowsFor().filter((row) => row.symbol === 'IFC/USDT');
    const csv = resultsCsv(rows, ['last', 'change'], '24h');
    expect(csv).toBe('symbol,last,change_24h\nIFC/USDT,0.5,0.0600\n');
    const missing = resultsCsv([{ ...rows[0]!, last: null }], ['last'], '24h');
    expect(missing).toBe('symbol,last\nIFC/USDT,\n');
  });
});
