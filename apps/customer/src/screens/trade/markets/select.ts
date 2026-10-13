/**
 * Pure rules for the markets list: which rows show, in what order, which cards sit above the table, and the
 * small text/number helpers a row needs. No React here, so every rule is unit tested (select.test.ts).
 * Money is decimal strings and bigint only; floats appear once, to place the range marker (drawing).
 */
import { compareDecimal, dec, fmtAmount, fmtPrice, fmtUsd, normalizePair, ratio, signOf, SCALE } from './deps';
import type { Decimal, MarketData, TickerRow } from './deps';

export type TickerMap = Record<string, TickerRow> | undefined;

/** Columns the table can show, in the order they are drawn. */
export type MarketColumn = 'name' | 'price' | 'change' | 'spark' | 'range' | 'volume' | 'action';
export const ALL_COLUMNS: readonly MarketColumn[] = ['name', 'price', 'change', 'spark', 'range', 'volume', 'action'];

export type Mode = 'simple' | 'pro';
export type Tab = 'favorites' | 'spot';
export type Chip = 'all' | 'gainers' | 'losers' | 'new';
export type SortKey = 'name' | 'price' | 'change' | 'volume';
export type SortDir = 'asc' | 'desc';
export interface Sort {
  key: SortKey;
  dir: SortDir;
}

export const isUsdQuote = (quote: string) => quote === 'USDT' || quote === 'USDC' || quote === 'USD';

/** Compare two nullable decimals; unknown values sort last in either direction. */
function byDecimal(a: Decimal | null | undefined, b: Decimal | null | undefined, dir: SortDir): number {
  const aKnown = dec(a) !== null;
  const bKnown = dec(b) !== null;
  if (!aKnown || !bKnown) return aKnown === bKnown ? 0 : aKnown ? -1 : 1;
  const order = compareDecimal(a, b) ?? 0;
  return dir === 'asc' ? order : -order;
}

/** Click a header: a number column starts high-to-low, Name starts A-Z; a third click puts the default order back. */
export function nextSort(current: Sort | null, key: SortKey): Sort | null {
  const first: SortDir = key === 'name' ? 'asc' : 'desc';
  const second: SortDir = first === 'asc' ? 'desc' : 'asc';
  if (!current || current.key !== key) return { key, dir: first };
  return current.dir === first ? { key, dir: second } : null;
}

export interface FilterState {
  tab: Tab;
  chip: Chip;
  /** Quote currency filter ("USDT"), or null for every quote. */
  quote: string | null;
  query: string;
  sort: Sort | null;
  /** Saved favourite symbols, oldest first. */
  favorites: readonly string[];
}

export interface Entry {
  market: MarketData;
  ticker: TickerRow | undefined;
}

export function entriesFor(markets: readonly MarketData[], tickers: TickerMap): Entry[] {
  return markets.filter((market) => market.orderable).map((market) => ({ market, ticker: tickers?.[market.symbol] }));
}

/** Quote currencies present, USDT and USDC first. */
export function quotesOf(markets: readonly MarketData[]): string[] {
  const rank = (quote: string) => ['USDT', 'USDC'].indexOf(quote);
  return [...new Set(markets.map((market) => market.quote))].sort((a, b) => {
    const ra = rank(a) < 0 ? 9 : rank(a);
    const rb = rank(b) < 0 ? 9 : rank(b);
    return ra - rb || a.localeCompare(b);
  });
}

const normalise = (text: string) => text.toLowerCase().replace(/[\s/_-]+/g, '');

/** Match "btc", "BTC/USDT", "btc-usdt" or a plain name such as "bitcoin". */
export function matchesQuery(market: MarketData, query: string, name: string | null): boolean {
  const needle = normalise(query.trim());
  if (!needle) return true;
  return [market.symbol, `${market.base}${market.quote}`, name ?? ''].some((text) => normalise(text).includes(needle));
}

const hasListed = (entry: Entry) => entry.market.listedAt !== null && !Number.isNaN(Date.parse(entry.market.listedAt));
const listedMs = (entry: Entry) => (hasListed(entry) ? Date.parse(entry.market.listedAt as string) : 0);

/** True when at least one open market carries a listing date, so a "New" filter has something to filter on. */
export function anyListed(entries: readonly Entry[]): boolean {
  return entries.some(hasListed);
}

/**
 * The rows for the current tab, chip, quote, search and sort. With no explicit sort the order is the one that
 * makes the chip useful: biggest gain first for Gainers, biggest fall for Losers, newest for New, most traded
 * first otherwise; markets without a figure keep the service's order after those that have one.
 */
export function visibleEntries(
  entries: readonly Entry[],
  state: FilterState,
  nameOf: (base: string) => string | null = () => null,
): Entry[] {
  let rows = [...entries];
  if (state.tab === 'favorites') {
    const order = new Map(state.favorites.map((symbol, index) => [symbol, index]));
    rows = rows.filter((entry) => order.has(entry.market.symbol));
    rows.sort((a, b) => (order.get(a.market.symbol) ?? 0) - (order.get(b.market.symbol) ?? 0));
  }
  if (state.quote) rows = rows.filter((entry) => entry.market.quote === state.quote);
  if (state.chip === 'gainers') rows = rows.filter((entry) => signOf(entry.ticker?.changePct24h) === 1);
  if (state.chip === 'losers') rows = rows.filter((entry) => signOf(entry.ticker?.changePct24h) === -1);
  if (state.chip === 'new') rows = rows.filter(hasListed);
  if (state.query.trim()) rows = rows.filter((entry) => matchesQuery(entry.market, state.query, nameOf(entry.market.base)));

  const index = new Map(entries.map((entry, position) => [entry.market.symbol, position]));
  const original = (a: Entry, b: Entry) => (index.get(a.market.symbol) ?? 0) - (index.get(b.market.symbol) ?? 0);
  const sort = state.sort;
  if (sort) {
    const compare = (a: Entry, b: Entry): number => {
      switch (sort.key) {
        case 'name': {
          const order = a.market.base.localeCompare(b.market.base) || a.market.quote.localeCompare(b.market.quote);
          return sort.dir === 'asc' ? order : -order;
        }
        case 'price':
          return byDecimal(a.ticker?.last, b.ticker?.last, sort.dir);
        case 'change':
          return byDecimal(a.ticker?.changePct24h, b.ticker?.changePct24h, sort.dir);
        case 'volume':
          return byDecimal(a.ticker?.quoteVolume24h, b.ticker?.quoteVolume24h, sort.dir);
      }
    };
    return rows.sort((a, b) => compare(a, b) || original(a, b));
  }
  if (state.chip === 'gainers')
    return rows.sort((a, b) => byDecimal(a.ticker?.changePct24h, b.ticker?.changePct24h, 'desc') || original(a, b));
  if (state.chip === 'losers')
    return rows.sort((a, b) => byDecimal(a.ticker?.changePct24h, b.ticker?.changePct24h, 'asc') || original(a, b));
  if (state.chip === 'new') return rows.sort((a, b) => listedMs(b) - listedMs(a) || original(a, b));
  if (state.tab === 'favorites') return rows; // the order they were starred in
  return rows.sort((a, b) => byDecimal(a.ticker?.quoteVolume24h, b.ticker?.quoteVolume24h, 'desc') || original(a, b));
}

export type CardId = 'popular' | 'new' | 'gainers';
export interface Card {
  id: CardId;
  entries: Entry[];
}

/**
 * The three cards above the table (UI-SPEC 5.6). Popular is the most traded; New listings needs listing dates
 * (left out when the service sends none); Top gainers needs a market that is up (left out otherwise). A short
 * market list would only repeat itself, so under four markets there are no cards.
 */
export function topCards(entries: readonly Entry[], size = 3): Card[] {
  if (entries.length <= size) return [];
  const base: FilterState = { tab: 'spot', chip: 'all', quote: null, query: '', sort: null, favorites: [] };
  // One row per coin: BTC/USDT and BTC/USDC in the same card would read as a repeat.
  const pick = (rows: Entry[]) =>
    rows.filter((entry, i) => rows.findIndex((other) => other.market.base === entry.market.base) === i).slice(0, size);
  const cards: Card[] = [{ id: 'popular', entries: pick(visibleEntries(entries, base)) }];
  const fresh = pick(visibleEntries(entries, { ...base, chip: 'new' }));
  if (fresh.length > 0) cards.push({ id: 'new', entries: fresh });
  const up = pick(visibleEntries(entries, { ...base, chip: 'gainers' }));
  if (up.length > 0) cards.push({ id: 'gainers', entries: up });
  return cards;
}

/**
 * Where a row (or its Buy/Trade button) goes. Simple opens the coin page (or the Buy card while it is hidden); Pro always opens the desk,
 * whose route writes the pair with a dash ("BTC-USDT") although the service names it "BTC/USDT".
 */
export function marketTarget(market: MarketData, mode: Mode, isHidden: (path: string) => boolean): string {
  if (mode === 'simple' && !isHidden('/coin/:asset')) return `/coin/${encodeURIComponent(market.base)}`;
  if (mode === 'simple' && !isHidden('/trade/buy')) return `/trade/buy?asset=${encodeURIComponent(market.base)}`;
  return `/trade/spot/${normalizePair(market.symbol)}`;
}

/** "$67,812.40" for a dollar-quoted market, "0.0123 BTC" otherwise; an unknown price is a bare "—". */
export function priceText(market: MarketData, value: Decimal | null | undefined): string {
  const price = fmtPrice(value, market.tickSize);
  if (price === '—') return price;
  return isUsdQuote(market.quote) ? `$${price}` : `${price} ${market.quote}`;
}

/** 24h volume in the quote currency: "$1.2M" for dollar quotes, else the plain amount with its unit. */
export function volumeText(market: MarketData, ticker: TickerRow | undefined): string {
  const value = ticker?.quoteVolume24h ?? null;
  if (dec(value) === null) return '—';
  return isUsdQuote(market.quote) ? fmtUsd(value, { compact: true }) : `${fmtAmount(value, { places: 2 })} ${market.quote}`;
}

/** Where the last price sits between the day's low and high, 0 to 100, for drawing the marker. Null when unknown. */
export function rangePosition(ticker: TickerRow | undefined): number | null {
  const low = dec(ticker?.low24h);
  const high = dec(ticker?.high24h);
  const last = dec(ticker?.last);
  if (low === null || high === null || last === null || high <= low) return null;
  const clamped = last < low ? low : last > high ? high : last;
  const share = ratio(clamped - low, high - low);
  if (share === null) return null;
  return Number((share * 10000n) / SCALE) / 100;
}
