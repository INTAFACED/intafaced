import { describe, expect, it } from 'vitest';
import type { WatchlistValue } from '@intafaced/contracts/watchlists-preferences';
import type { MarketRow } from '../../data';
import { exportListCsv, IMPORT_MAX_ROWS, readImportCsv } from './csv';

const markets = [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }] as unknown as MarketRow[];

function list(title: string): WatchlistValue {
  return {
    id: 'main',
    name: 'Main',
    flag: null,
    sections: [{ id: 's1', title, collapsed: false, symbols: ['BTC/USDT'] }],
  };
}

describe('exportListCsv', () => {
  it('guards a section title that a spreadsheet would read as a formula', () => {
    const csv = exportListCsv(list('=HYPERLINK("x")'), undefined);
    expect(csv.split('\n')[1]).toBe(`BTC/USDT,"'=HYPERLINK(""x"")",,,,,`);
  });

  it('leaves a plain section title alone', () => {
    expect(exportListCsv(list('Majors'), undefined).split('\n')[1]).toBe('BTC/USDT,Majors,,,,,');
  });
});

describe('readImportCsv', () => {
  it('adds listed symbols, refuses unknown ones and counts repeats', () => {
    const result = readImportCsv('symbol\nBTC/USDT\nDOGE/USDT\nBTC/USDT\n', markets, new Set());
    expect(result.accepted).toEqual(['BTC/USDT']);
    expect(result.refused).toEqual([{ line: 3, value: 'DOGE/USDT', reason: 'unknown symbol' }]);
    expect(result.already).toBe(1);
    expect(result.tooMany).toBe(false);
  });

  it('refuses the whole file when it has more rows than the cap', () => {
    const text = `${Array.from({ length: IMPORT_MAX_ROWS + 1 }, () => 'BTC/USDT').join('\n')}\n`;
    const result = readImportCsv(text, markets, new Set());
    expect(result.tooMany).toBe(true);
    expect(result.accepted).toEqual([]);
  });

  it('truncates a long refused value in the refusal', () => {
    const long = `${'A'.repeat(100)}/USDT`;
    const result = readImportCsv(`${long}\n`, markets, new Set());
    expect(result.refused[0]!.value.length).toBeLessThanOrEqual(65);
  });
});
