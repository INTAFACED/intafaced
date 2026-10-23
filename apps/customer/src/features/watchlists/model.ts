/**
 * Watchlists, as pure functions: the account's named lists with their sections, the rows a section shows, and the quote each
 * row reads. Money stays decimal strings; nothing here turns a price into a JS number except through the scaled-bigint compare
 * in the data layer. A change returns a new list; the caller saves it through the store.
 */
import type { WatchlistsValue, WatchlistValue } from '@intafaced/contracts/watchlists-preferences';
import { type MarketRow, type TickerRow } from '../../data';
import { compareDecimal } from '../../data/decimal';

export type WatchlistSection = WatchlistValue['sections'][number];
export type WatchlistFlag = NonNullable<WatchlistValue['flag']>;

export const WATCHLIST_FLAG_IDS: readonly WatchlistFlag[] = ['red', 'amber', 'green', 'blue'];

/** Columns a row shows, in order. `symbol` is always first. */
export const WATCHLIST_COLUMNS = ['symbol', 'last', 'change', 'high', 'low', 'volume'] as const;
export type WatchlistColumn = (typeof WATCHLIST_COLUMNS)[number];
export type SortDirection = 'asc' | 'desc';
export interface SortState {
  column: WatchlistColumn;
  direction: SortDirection;
}

/** A stable id from a name: lowercase words joined by dashes, made unique among `taken`. Never random. */
export function slugId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'list';
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

export function symbolsOf(list: WatchlistValue): string[] {
  return list.sections.flatMap((section) => section.symbols);
}

export function hasSymbol(list: WatchlistValue, symbol: string): boolean {
  return symbolsOf(list).includes(symbol);
}

export function createList(lists: WatchlistsValue, name: string, flag: WatchlistFlag | null = null): WatchlistsValue {
  const trimmed = name.trim();
  const taken = new Set(lists.map((list) => list.id));
  const list: WatchlistValue = {
    id: slugId(trimmed, taken),
    name: trimmed,
    flag,
    sections: [{ id: 'main', title: 'Main', collapsed: false, symbols: [] }],
  };
  return [...lists, list];
}

function mapList(lists: WatchlistsValue, listId: string, change: (list: WatchlistValue) => WatchlistValue): WatchlistsValue {
  return lists.map((list) => (list.id === listId ? change(list) : list));
}

/** Adds a symbol to a section of a list. A symbol already on the list is not added twice (the caller says so first). */
export function addSymbol(lists: WatchlistsValue, listId: string, sectionId: string, symbol: string): WatchlistsValue {
  return mapList(lists, listId, (list) => {
    if (hasSymbol(list, symbol)) return list;
    return {
      ...list,
      sections: list.sections.map((section) =>
        section.id === sectionId ? { ...section, symbols: [...section.symbols, symbol] } : section,
      ),
    };
  });
}

export function removeSymbol(lists: WatchlistsValue, listId: string, symbol: string): WatchlistsValue {
  return mapList(lists, listId, (list) => ({
    ...list,
    sections: list.sections.map((section) => ({ ...section, symbols: section.symbols.filter((item) => item !== symbol) })),
  }));
}

export function addSection(lists: WatchlistsValue, listId: string, title: string): WatchlistsValue {
  return mapList(lists, listId, (list) => {
    const taken = new Set(list.sections.map((section) => section.id));
    const section: WatchlistSection = { id: slugId(title, taken), title: title.trim(), collapsed: false, symbols: [] };
    return { ...list, sections: [...list.sections, section] };
  });
}

export function setSectionCollapsed(lists: WatchlistsValue, listId: string, sectionId: string, collapsed: boolean): WatchlistsValue {
  return mapList(lists, listId, (list) => ({
    ...list,
    sections: list.sections.map((section) => (section.id === sectionId ? { ...section, collapsed } : section)),
  }));
}

export function setFlag(lists: WatchlistsValue, listId: string, flag: WatchlistFlag | null): WatchlistsValue {
  return mapList(lists, listId, (list) => ({ ...list, flag }));
}

/** The first section a symbol can be added to (every list has at least one). */
export function defaultSectionOf(list: WatchlistValue): WatchlistSection {
  return list.sections[0]!;
}

/** One row a section shows: the symbol, its listing and its quote (both null when the read has not arrived or names none). */
export interface WatchRow {
  symbol: string;
  market: MarketRow | undefined;
  ticker: TickerRow | undefined;
}

export function rowsOf(
  section: WatchlistSection,
  markets: readonly MarketRow[],
  tickers: Readonly<Record<string, TickerRow>> | undefined,
): WatchRow[] {
  const byName = new Map(markets.map((market) => [market.symbol, market]));
  return section.symbols.map((symbol) => ({ symbol, market: byName.get(symbol), ticker: tickers?.[symbol] }));
}

const numericField: Record<Exclude<WatchlistColumn, 'symbol'>, (row: WatchRow) => string | null> = {
  last: (row) => row.ticker?.last ?? null,
  change: (row) => row.ticker?.changePct24h ?? null,
  high: (row) => row.ticker?.high24h ?? null,
  low: (row) => row.ticker?.low24h ?? null,
  volume: (row) => row.ticker?.baseVolume24h ?? null,
};

/**
 * Rows in the sort order. Sorting compares decimal strings exactly; a row with no value sorts last whichever way the sort
 * runs, so a missing quote never reads as the top of a list.
 */
export function sortRows(rows: readonly WatchRow[], sort: SortState | null): WatchRow[] {
  if (!sort) return [...rows];
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.column === 'symbol') return sign * a.symbol.localeCompare(b.symbol, 'en');
    const left = numericField[sort.column](a);
    const right = numericField[sort.column](b);
    if (left === null && right === null) return a.symbol.localeCompare(b.symbol, 'en');
    if (left === null) return 1;
    if (right === null) return -1;
    return sign * (compareDecimal(left, right) ?? 0) || a.symbol.localeCompare(b.symbol, 'en');
  });
}

/** Next sort for a column: ascending, then descending, then off. */
export function nextSort(current: SortState | null, column: WatchlistColumn): SortState | null {
  if (!current || current.column !== column) return { column, direction: 'asc' };
  if (current.direction === 'asc') return { column, direction: 'desc' };
  return null;
}

export type QuoteState = 'live' | 'no-data';
/** A quote cell: the value as the feed sent it, or 'no-data' when there is no ticker (never a stale price shown as live). */
export function quoteState(ticker: TickerRow | undefined): QuoteState {
  return ticker && ticker.last !== null ? 'live' : 'no-data';
}

/** Symbols the listing offers that match a search, by base or quote or the pair itself; blank search matches nothing. */
export function searchMarkets(markets: readonly MarketRow[], query: string, limit = 8): MarketRow[] {
  const needle = query.trim().toUpperCase().replace('-', '/');
  if (!needle) return [];
  const starts: MarketRow[] = [];
  const contains: MarketRow[] = [];
  for (const market of markets) {
    const symbol = market.symbol.toUpperCase();
    if (symbol.startsWith(needle) || market.base.toUpperCase().startsWith(needle)) starts.push(market);
    else if (symbol.includes(needle)) contains.push(market);
  }
  return [...starts, ...contains].slice(0, limit);
}

/** The market a typed symbol names, if the listing has it (`btc-usdt`, `BTC/USDT` and `BTC-USDT` all name BTC/USDT). */
export function listedSymbol(markets: readonly MarketRow[], typed: string): MarketRow | undefined {
  const wanted = typed.trim().toUpperCase().replace('-', '/');
  return markets.find((market) => market.symbol.toUpperCase() === wanted);
}
