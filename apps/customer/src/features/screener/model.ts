/**
 * The screener, as pure functions. A screen is a set of filters over the listed markets and their tickers; the change column can
 * measure over 24 h (the ticker), 1 h or 1 d (the candle read: the close one bar back), and 4 h is not served, so a change shown
 * over 4 h reads 'not served' and a change filter on it removes every market with the reason named. Every comparison is exact:
 * decimal strings become scaled bigints, and no number is a JS float.
 */
import type { SavedScreen, SavedScreensValue } from '@intafaced/contracts/watchlists-preferences';
import type { MarketRow, TickerRow } from '../../data';
import { dec, str, sub, ratio, times } from '../../data/decimal';

export type ScreenFilters = SavedScreen['filters'];
export type ScreenColumn = SavedScreen['columns'][number];
export type ChangeTimeframe = SavedScreen['changeTimeframe'];

export const DEFAULT_FILTERS: ScreenFilters = {
  quote: null,
  changeMin: null,
  changeMax: null,
  volumeMin: null,
  lastMin: null,
  lastMax: null,
  universe: 'all',
  listId: null,
};
export const DEFAULT_COLUMNS: ScreenColumn[] = ['last', 'change', 'volume'];
export const DEFAULT_TIMEFRAME: ChangeTimeframe = '24h';
export const COLUMN_IDS: readonly ScreenColumn[] = ['last', 'change', 'volume', 'high', 'low'];
export const TIMEFRAME_IDS: readonly ChangeTimeframe[] = ['24h', '1h', '1d', '4h'];

/** The change over a timeframe is served by the ticker (24 h) or the candle read (1 h, 1 d). 4 h is not served. */
export function isServed(timeframe: ChangeTimeframe): boolean {
  return timeframe !== '4h';
}

/** One market as the screener sees it: decimal strings only. `change` is a ratio ("0.0523" is 5.23 %). */
export interface ScreenRow {
  symbol: string;
  base: string;
  quote: string;
  tickSize: string;
  last: string | null;
  change: string | null;
  volume: string | null;
  high: string | null;
  low: string | null;
}

/** The most markets the listing read asks for (the same limit the markets fetch uses). A list at this size may be cut short. */
export const SCREENER_MARKET_LIMIT = 500;

/**
 * The change over a timeframe. 24 h is the ticker's own figure. 1 h and 1 d compare the last price with `close`, the close one
 * full period back (1 h: 60 minutes back, from 1 m candles; 1 d: 24 hours back, from 1 h candles; see `screener/data.ts`).
 * Anything not served, or with a missing price, is null.
 */
export function changeOver(timeframe: ChangeTimeframe, ticker: TickerRow | undefined, close: string | null | undefined): string | null {
  if (timeframe === '24h') return ticker?.changePct24h ?? null;
  if (!isServed(timeframe)) return null;
  const last = dec(ticker?.last);
  const before = dec(close);
  if (last === null || before === null || before === 0n) return null;
  const moved = ratio(sub(last, before), before);
  return moved === null ? null : str(moved);
}

/** The listed markets a universe names: every listed market, or the markets on one watchlist. */
export function universeSymbols(filters: ScreenFilters, listSymbols: readonly string[] | null): Set<string> | null {
  if (filters.universe === 'all') return null;
  return new Set(listSymbols ?? []);
}

export function buildRows(
  markets: readonly MarketRow[],
  tickers: Readonly<Record<string, TickerRow>> | undefined,
  closes: Readonly<Record<string, string | null>> | undefined,
  timeframe: ChangeTimeframe,
  universe: ReadonlySet<string> | null,
): ScreenRow[] {
  return markets
    .filter((market) => universe === null || universe.has(market.symbol))
    .map((market) => {
      const ticker = tickers?.[market.symbol];
      return {
        symbol: market.symbol,
        base: market.base,
        quote: market.quote,
        tickSize: market.tickSize,
        last: ticker?.last ?? null,
        change: changeOver(timeframe, ticker, closes?.[market.symbol]),
        volume: ticker?.baseVolume24h ?? null,
        high: ticker?.high24h ?? null,
        low: ticker?.low24h ?? null,
      };
    });
}

export type StageId = 'universe' | 'quote' | 'change' | 'volume' | 'last';
export interface Stage {
  id: StageId;
  before: number;
  after: number;
}
export interface ScreenResult {
  rows: ScreenRow[];
  stages: Stage[];
}

const PERCENT = dec('100') ?? 0n;
/** A bound the person typed: a decimal string, or null when it is blank (not set, never a default). */
const bound = (value: string | null): bigint | null => (value === null ? null : dec(value));

/**
 * Applies the filters in order and counts what each one left. A blank bound is not applied. A change filter compares percent:
 * the ratio times 100, exactly. A row with no value for a filtered column never passes that filter.
 */
export function screenRows(rows: readonly ScreenRow[], filters: ScreenFilters, timeframe: ChangeTimeframe): ScreenResult {
  const stages: Stage[] = [];
  let current = [...rows];
  const step = (id: StageId, keep: (row: ScreenRow) => boolean) => {
    const before = current.length;
    current = current.filter(keep);
    stages.push({ id, before, after: current.length });
  };
  step('universe', () => true);
  if (filters.quote !== null) {
    const quote = filters.quote.toUpperCase();
    step('quote', (row) => row.quote.toUpperCase() === quote);
  }
  const changeMin = bound(filters.changeMin);
  const changeMax = bound(filters.changeMax);
  if (changeMin !== null || changeMax !== null) {
    step('change', (row) => {
      if (!isServed(timeframe) || row.change === null) return false;
      const pct = times(dec(row.change) ?? 0n, PERCENT);
      if (changeMin !== null && pct < changeMin) return false;
      if (changeMax !== null && pct > changeMax) return false;
      return true;
    });
  }
  const volumeMin = bound(filters.volumeMin);
  if (volumeMin !== null) step('volume', (row) => row.volume !== null && (dec(row.volume) ?? -1n) >= volumeMin);
  const lastMin = bound(filters.lastMin);
  const lastMax = bound(filters.lastMax);
  if (lastMin !== null || lastMax !== null) {
    step('last', (row) => {
      const price = dec(row.last);
      if (price === null) return false;
      if (lastMin !== null && price < lastMin) return false;
      if (lastMax !== null && price > lastMax) return false;
      return true;
    });
  }
  return { rows: current, stages };
}

/** The filter that removed every market, when a screen ends empty: the first stage that went from some to none. */
export function emptyReason(stages: readonly Stage[]): StageId | null {
  const cut = stages.find((stage) => stage.before > 0 && stage.after === 0);
  return cut ? cut.id : null;
}

/** A value a column shows for a row, as the decimal string the feed sent (formatting happens in the screen). */
export function cellValue(row: ScreenRow, column: ScreenColumn): string | null {
  return row[column === 'change' ? 'change' : column];
}

/** A cell as CSV. A cell a spreadsheet would read as a formula gets a leading apostrophe; a negative number is left alone. */
function csvCell(value: string): string {
  const safe = /^[=+@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The screened rows as CSV: the symbol, then each chosen column. Empty cells stay empty; nothing is zero-filled. */
export function resultsCsv(rows: readonly ScreenRow[], columns: readonly ScreenColumn[], timeframe: ChangeTimeframe): string {
  const header = ['symbol', ...columns.map((column) => (column === 'change' ? `change_${timeframe}` : column))];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    const cells = columns.map((column) => csvCell(cellValue(row, column) ?? ''));
    lines.push([csvCell(row.symbol), ...cells].join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** The record a screen saves as, from what the form holds. */
export function screenRecord(
  id: string,
  name: string,
  filters: ScreenFilters,
  columns: readonly ScreenColumn[],
  timeframe: ChangeTimeframe,
): SavedScreen {
  return { id, name: name.trim(), filters, columns: [...columns], changeTimeframe: timeframe };
}

/** Saved screens with one replaced or added, the record the account keeps. */
export function withScreen(screens: SavedScreensValue, next: SavedScreen): SavedScreensValue {
  const exists = screens.some((screen) => screen.id === next.id);
  return exists ? screens.map((screen) => (screen.id === next.id ? next : screen)) : [...screens, next];
}
