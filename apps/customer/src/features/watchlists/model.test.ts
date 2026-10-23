import { describe, expect, it } from 'vitest';
import type { WatchlistsValue } from '@intafaced/contracts/watchlists-preferences';
import type { MarketRow, TickerRow } from '../../data';
import {
  addSection,
  addSymbol,
  createList,
  hasSymbol,
  listedSymbol,
  nextSort,
  quoteState,
  removeSymbol,
  rowsOf,
  searchMarkets,
  setSectionCollapsed,
  slugId,
  sortRows,
  type WatchRow,
} from './model';
import { exportFileName, exportListCsv, importSummary, readImportCsv, splitCsvLine } from './csv';
import { readWatchlistView, writeWatchlistView, DEFAULT_VIEW } from './view';

const market = (symbol: string): MarketRow => {
  const [base, quote] = symbol.split('/');
  return {
    symbol,
    base: base!,
    quote: quote!,
    orderable: true,
    tickSize: '0.01',
    lotSize: '0.00001',
    minAmount: '0.00001',
    listedAt: null,
  };
};
const ticker = (symbol: string, last: string | null, changePct24h: string | null): TickerRow => ({
  symbol,
  last,
  bid: null,
  ask: null,
  open24h: null,
  high24h: '70000',
  low24h: '60000',
  change24h: null,
  changePct24h,
  baseVolume24h: '12.5',
  quoteVolume24h: null,
  windowStart: null,
  source: 'server',
});
const listing = [market('BTC/USDT'), market('ETH/USDT'), market('BTC/USDC'), market('IFC/USDT')];

describe('watchlist lists', () => {
  it('creates a list with a stable id from its name, unique among the lists', () => {
    const once = createList([], 'Majors');
    expect(once).toEqual([
      { id: 'majors', name: 'Majors', flag: null, sections: [{ id: 'main', title: 'Main', collapsed: false, symbols: [] }] },
    ]);
    const twice = createList(once, 'Majors');
    expect(twice[1]!.id).toBe('majors-2');
    expect(slugId('  ', new Set())).toBe('list');
  });

  it('adds a symbol once, to the section named, and removes it again', () => {
    let lists: WatchlistsValue = createList([], 'Majors');
    lists = addSection(lists, lists[0]!.id, 'Layer 2');
    lists = addSymbol(lists, 'majors', 'main', 'BTC/USDT');
    lists = addSymbol(lists, 'majors', 'main', 'BTC/USDT');
    lists = addSymbol(lists, 'majors', 'layer-2', 'ETH/USDT');
    expect(lists[0]!.sections.map((section) => section.symbols)).toEqual([['BTC/USDT'], ['ETH/USDT']]);
    expect(hasSymbol(lists[0]!, 'ETH/USDT')).toBe(true);
    lists = removeSymbol(lists, 'majors', 'BTC/USDT');
    expect(lists[0]!.sections[0]!.symbols).toEqual([]);
  });

  it('minimises a section without touching its rows', () => {
    let lists: WatchlistsValue = createList([], 'Majors');
    lists = addSymbol(lists, 'majors', 'main', 'BTC/USDT');
    lists = setSectionCollapsed(lists, 'majors', 'main', true);
    expect(lists[0]!.sections[0]).toMatchObject({ collapsed: true, symbols: ['BTC/USDT'] });
  });
});

describe('sorting and quotes', () => {
  const rows: WatchRow[] = [
    { symbol: 'ETH/USDT', market: undefined, ticker: ticker('ETH/USDT', '3000.5', '-0.0100') },
    { symbol: 'BTC/USDT', market: undefined, ticker: ticker('BTC/USDT', '65000', '0.0250') },
    { symbol: 'IFC/USDT', market: undefined, ticker: ticker('IFC/USDT', null, null) },
  ];

  it('sorts by a decimal column exactly, a missing value last in both directions', () => {
    expect(sortRows(rows, { column: 'last', direction: 'asc' }).map((row) => row.symbol)).toEqual(['ETH/USDT', 'BTC/USDT', 'IFC/USDT']);
    expect(sortRows(rows, { column: 'last', direction: 'desc' }).map((row) => row.symbol)).toEqual(['BTC/USDT', 'ETH/USDT', 'IFC/USDT']);
    expect(sortRows(rows, { column: 'change', direction: 'desc' }).map((row) => row.symbol)).toEqual(['BTC/USDT', 'ETH/USDT', 'IFC/USDT']);
    expect(sortRows(rows, null).map((row) => row.symbol)).toEqual(['ETH/USDT', 'BTC/USDT', 'IFC/USDT']);
  });

  it('cycles a column through ascending, descending and off', () => {
    const first = nextSort(null, 'last');
    expect(first).toEqual({ column: 'last', direction: 'asc' });
    expect(nextSort(first, 'last')).toEqual({ column: 'last', direction: 'desc' });
    expect(nextSort({ column: 'last', direction: 'desc' }, 'last')).toBeNull();
    expect(nextSort({ column: 'last', direction: 'asc' }, 'change')).toEqual({ column: 'change', direction: 'asc' });
  });

  it('reads a quote as no data when there is no ticker or no last price, never a stale value', () => {
    expect(quoteState(undefined)).toBe('no-data');
    expect(quoteState(ticker('IFC/USDT', null, null))).toBe('no-data');
    expect(quoteState(ticker('BTC/USDT', '65000', null))).toBe('live');
  });

  it('builds the rows of a section from the listing and the tickers', () => {
    const section = { id: 'main', title: 'Main', collapsed: false, symbols: ['BTC/USDT', 'XRP/USDT'] };
    const built = rowsOf(section, listing, { 'BTC/USDT': ticker('BTC/USDT', '65000', '0.02') });
    expect(built[0]!.market?.symbol).toBe('BTC/USDT');
    expect(built[0]!.ticker?.last).toBe('65000');
    expect(built[1]!.market).toBeUndefined();
    expect(built[1]!.ticker).toBeUndefined();
  });
});

describe('search and the listing', () => {
  it('finds listed markets by base or pair, and matches nothing for a blank search', () => {
    expect(searchMarkets(listing, '')).toEqual([]);
    expect(searchMarkets(listing, 'btc').map((item) => item.symbol)).toEqual(['BTC/USDT', 'BTC/USDC']);
    expect(searchMarkets(listing, 'ETH/USDT').map((item) => item.symbol)).toEqual(['ETH/USDT']);
    expect(searchMarkets(listing, 'DOGE')).toEqual([]);
  });

  it('names a listed market from a typed pair in any separator, and nothing unlisted', () => {
    expect(listedSymbol(listing, 'btc-usdt')?.symbol).toBe('BTC/USDT');
    expect(listedSymbol(listing, 'BTC/USDT')?.symbol).toBe('BTC/USDT');
    expect(listedSymbol(listing, 'DOGE/USDT')).toBeUndefined();
  });
});

describe('CSV in and out', () => {
  it('writes one row per symbol in section order, and a missing quote as an empty cell', () => {
    const list = createList([], 'My list')[0]!;
    const withRows = { ...list, sections: [{ id: 'main', title: 'Main', collapsed: false, symbols: ['BTC/USDT', 'IFC/USDT'] }] };
    const csv = exportListCsv(withRows, { 'BTC/USDT': ticker('BTC/USDT', '65000', '0.025') });
    expect(csv).toBe(
      'symbol,section,last,change_pct_24h,high_24h,low_24h,volume_24h\nBTC/USDT,Main,65000,0.025,70000,60000,12.5\nIFC/USDT,Main,,,,,\n',
    );
    expect(exportFileName('My list / 2026')).toBe('watchlist-my-list-2026.csv');
  });

  it('reads quoted fields the way the export writes them', () => {
    expect(splitCsvLine('"BTC/USDT","a ""b"", c",3')).toEqual(['BTC/USDT', 'a "b", c', '3']);
  });

  it('adds the listed rows and refuses only the unknown ones, one row at a time', () => {
    const csv = 'symbol,section\nBTC/USDT,Main\nDOGE/USDT,Main\nETH/USDT,Main\nBTC-USDT,Main\nnot a symbol,\n';
    const result = readImportCsv(csv, listing, new Set(['ETH/USDT']));
    expect(result.accepted).toEqual(['BTC/USDT']);
    expect(result.already).toBe(2);
    expect(result.refused).toEqual([
      { line: 3, value: 'DOGE/USDT', reason: 'unknown symbol' },
      { line: 6, value: 'not a symbol', reason: 'not a symbol' },
    ]);
    expect(importSummary(result)).toBe('1 added, 1 refused: unknown symbol, 1 refused: not a symbol, 2 already listed');
  });
});

describe('the device view', () => {
  const memory = (): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } => {
    const data: Record<string, string> = {};
    return {
      data,
      getItem: (key) => (key in data ? data[key]! : null),
      setItem: (key, value) => {
        data[key] = value;
      },
    };
  };

  it('keeps the sort and column widths, and reads the defaults from a blocked or broken store', () => {
    const store = memory();
    writeWatchlistView('u1', { sort: { column: 'change', direction: 'desc' }, widths: { last: 180 } }, store);
    expect(readWatchlistView('u1', store)).toEqual({ sort: { column: 'change', direction: 'desc' }, widths: { last: 180 } });
    expect(readWatchlistView('u2', store)).toEqual(DEFAULT_VIEW);
    store.data['intafaced.customer.watchlists.view.v1:u1'] = '{"sort":{"column":"nope","direction":"asc"},"widths":{"last":9999}}';
    expect(readWatchlistView('u1', store)).toEqual({ sort: null, widths: {} });
    expect(readWatchlistView('u1', null)).toEqual(DEFAULT_VIEW);
  });
});
