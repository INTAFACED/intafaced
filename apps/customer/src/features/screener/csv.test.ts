import { describe, expect, it } from 'vitest';
import { resultsCsv, type ScreenRow } from './model';

const row: ScreenRow = {
  symbol: 'BTC/USDT',
  base: 'BTC',
  quote: 'USDT',
  tickSize: '0.01',
  last: '100.5',
  change: '-0.0200',
  volume: null,
  high: '101',
  low: '99',
};

describe('resultsCsv', () => {
  it('keeps numbers as sent, leaves an empty cell empty, and names the change column by its timeframe', () => {
    const csv = resultsCsv([row], ['last', 'change', 'volume'], '1h');
    expect(csv).toBe('symbol,last,change_1h,volume\nBTC/USDT,100.5,-0.0200,\n');
  });

  it('guards a cell a spreadsheet would read as a formula', () => {
    const csv = resultsCsv([{ ...row, last: '=1+1' }], ['last'], '24h');
    expect(csv.split('\n')[1]).toBe("BTC/USDT,'=1+1");
  });
});
