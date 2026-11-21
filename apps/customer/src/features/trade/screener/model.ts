/**
 * The screener's rules (C-alerts-scan-07), with no React so each is unit tested (model.test.ts). The screen filters the listed
 * markets and their tickers in the client, as the slice's first cut says: quote, 24 h change, 24 h volume and a last price
 * range, over every market or one watchlist. A blank bound is not set and filters nothing; it is never a default bound.
 * Money and prices stay decimal strings and scaled bigints: no float decides a row.
 */
import {
  SCREEN_COLUMNS,
  SCREEN_TIMEFRAMES,
  recordDigest,
  type SavedScreen,
  type WatchlistsValue,
} from '@intafaced/contracts/watchlists-preferences';
import type { MarketRow, TickerRow } from '../../../data';
import { dec, ratio, str, sub } from '../../../data/decimal';

export type ScreenColumn = (typeof SCREEN_COLUMNS)[number];
export type ScreenTimeframe = (typeof SCREEN_TIMEFRAMES)[number];
export type ScreenFilters = SavedScreen['filters'];
export { SCREEN_COLUMNS, SCREEN_TIMEFRAMES };

export const BLANK_FILTERS: ScreenFilters = {
  quote: null,
  changeMin: null,
  changeMax: null,
  volumeMin: null,
  lastMin: null,
  lastMax: null,
  universe: 'all',
  listId: null,
};
export const DEFAULT_COLUMNS: readonly ScreenColumn[] = ['last', 'change', 'volume'];

/** A bound as typed: trimmed, and blank (or not a decimal) is null, never zero. */
export function boundOf(text: string): string | null {
  const plain = text.trim();
  return /^-?\d{1,18}(\.\d{1,18})?$/.test(plain) ? plain : null;
}

/** A typed bound that is neither blank nor a decimal: the form says so instead of applying it. */
export const isBadBound = (text: string) => text.trim() !== '' && boundOf(text) === null;

export interface Row {
  market: MarketRow;
  ticker: TickerRow | undefined;
}

/** The filter steps in the order they are applied; the empty state names the first that leaves nothing. */
export type FilterStep = 'universe' | 'quote' | 'changeMin' | 'changeMax' | 'volumeMin' | 'lastMin' | 'lastMax';
const STEPS: readonly FilterStep[] = ['universe', 'quote', 'changeMin', 'changeMax', 'volumeMin', 'lastMin', 'lastMax'];

/** A 24 h change ratio ("0.0512") in percent points as a scaled bigint, so it compares with a typed "5". */
const points = (ratioText: string | null | undefined): bigint | null => {
  const value = dec(ratioText);
  return value === null ? null : value * 100n;
};

/** The symbols of one watchlist, in its sections' order; null when the list is not there. */
export function listSymbols(lists: WatchlistsValue, listId: string | null): string[] | null {
  const list = lists.find((item) => item.id === listId);
  return list ? list.sections.flatMap((section) => section.symbols) : null;
}

/** Does a row pass one step? A row whose figure is unknown does not pass a bound on it (it can't be shown to fit). */
function passes(step: FilterStep, row: Row, filters: ScreenFilters, universe: ReadonlySet<string> | null): boolean {
  const { market, ticker } = row;
  const atLeast = (value: bigint | null, bound: string | null) => bound === null || (value !== null && value > dec(bound)!);
  const atMost = (value: bigint | null, bound: string | null) => bound === null || (value !== null && value < dec(bound)!);
  switch (step) {
    case 'universe':
      return universe === null || universe.has(market.symbol);
    case 'quote':
      return filters.quote === null || market.quote === filters.quote;
    case 'changeMin':
      return atLeast(points(ticker?.changePct24h), filters.changeMin);
    case 'changeMax':
      return atMost(points(ticker?.changePct24h), filters.changeMax);
    case 'volumeMin':
      return atLeast(dec(ticker?.baseVolume24h), filters.volumeMin);
    case 'lastMin': {
      const bound = filters.lastMin;
      const last = dec(ticker?.last);
      return bound === null || (last !== null && last >= dec(bound)!);
    }
    case 'lastMax': {
      const bound = filters.lastMax;
      const last = dec(ticker?.last);
      return bound === null || (last !== null && last <= dec(bound)!);
    }
  }
}

export interface Screened {
  rows: Row[];
  /** When nothing is left: the first step after which no row remained. */
  removedBy: FilterStep | null;
}

/**
 * The screen over the markets. `universe` is every listed market, or one watchlist's symbols (null for every market). The
 * rows keep the listing's order.
 */
export function screen(
  markets: readonly MarketRow[],
  tickers: Readonly<Record<string, TickerRow>> | undefined,
  filters: ScreenFilters,
  universe: readonly string[] | null,
): Screened {
  const inList = universe === null ? null : new Set(universe);
  let rows: Row[] = markets.map((market) => ({ market, ticker: tickers?.[market.symbol] }));
  for (const step of STEPS) {
    const before = rows.length;
    rows = rows.filter((row) => passes(step, row, filters, inList));
    if (rows.length === 0) return { rows, removedBy: before > 0 ? step : 'universe' };
  }
  return { rows, removedBy: null };
}

/** The open hour/day bar's start for a timeframe, in epoch ms. */
const TIMEFRAME_MS: Record<Exclude<ScreenTimeframe, '24h'>, number> = { '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
export const isCandleTimeframe = (tf: ScreenTimeframe): tf is Exclude<ScreenTimeframe, '24h'> => tf !== '24h';
export const barStart = (tf: Exclude<ScreenTimeframe, '24h'>, nowMs: number) => Math.floor(nowMs / TIMEFRAME_MS[tf]) * TIMEFRAME_MS[tf];

/** [time, open, high, low, close, volume] as the candle read sends it. */
export type CandleRow = readonly [number, string, string, string, string, string];

/**
 * The change over a timeframe: the last price against the close of the bar before the open one (the change a chart of
 * that timeframe shows for its open bar). A ratio string, or null when the read holds no bar before the open one.
 */
export function timeframeChange(
  candles: readonly CandleRow[],
  last: string | null | undefined,
  tf: Exclude<ScreenTimeframe, '24h'>,
  nowMs: number,
): string | null {
  const start = barStart(tf, nowMs);
  const before = candles.filter((candle) => candle[0] < start).at(-1);
  const close = dec(before?.[4]);
  const now = dec(last);
  if (!before || close === null || close <= 0n || now === null) return null;
  const change = ratio(sub(now, close), close);
  return change === null ? null : str(change);
}

/** A saved screen's id: a digest of its name, so the same name is the same screen on every device. */
export function screenId(name: string): string {
  return `s-${recordDigest(name.trim().toLowerCase())}`;
}

export function findByName(screens: readonly SavedScreen[], name: string): SavedScreen | undefined {
  const key = name.trim().toLowerCase();
  return screens.find((item) => item.name.trim().toLowerCase() === key);
}

/** The screens with `next` in place of the one with its id, or added at the end. */
export function withScreen(screens: readonly SavedScreen[], next: SavedScreen): SavedScreen[] {
  const at = screens.findIndex((item) => item.id === next.id);
  if (at < 0) return [...screens, next];
  return screens.map((item, index) => (index === at ? next : item));
}

/** Columns in their fixed order, whatever order they were picked in. */
export const orderedColumns = (picked: readonly ScreenColumn[]): ScreenColumn[] =>
  SCREEN_COLUMNS.filter((column) => picked.includes(column));

function cell(value: string | null | undefined): string {
  const text = value ?? '';
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_HEADER: Record<ScreenColumn, (tf: ScreenTimeframe) => string> = {
  last: () => 'last',
  change: (tf) => `change_pct_${tf}`,
  volume: () => 'volume_24h',
  high: () => 'high_24h',
  low: () => 'low_24h',
};

/**
 * The results as a CSV file: one line per row, the shown columns in their order. A figure with no value is an empty cell,
 * never a zero. `change` is the shown change for the timeframe, as a ratio (as the watchlist export writes it).
 */
export function resultsCsv(
  rows: readonly Row[],
  columns: readonly ScreenColumn[],
  tf: ScreenTimeframe,
  changeOf: (row: Row) => string | null,
): string {
  const shown = orderedColumns(columns);
  const lines = [['symbol', ...shown.map((column) => CSV_HEADER[column](tf))].join(',')];
  for (const row of rows) {
    const { ticker } = row;
    const value: Record<ScreenColumn, string | null | undefined> = {
      last: ticker?.last,
      change: changeOf(row),
      volume: ticker?.baseVolume24h,
      high: ticker?.high24h,
      low: ticker?.low24h,
    };
    lines.push([cell(row.market.symbol), ...shown.map((column) => cell(value[column]))].join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** The file name a screen downloads as: its name, or "results" for an unsaved screen. */
export function resultsFileName(name: string | null): string {
  const stem = (name ?? 'results')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `screen-${stem || 'results'}.csv`;
}
