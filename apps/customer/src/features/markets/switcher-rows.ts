/**
 * Pure rules for the pair switcher: which markets it lists, how a search narrows them, the order (perpetuals, then spot),
 * where each one goes, and the last five a person opened, kept on this device. No React here (switcher-rows.test.ts).
 */
import type { Decimal, MarketRow, TickerRow } from '../../data';
import { normalizePair } from '../../app/navigation';

export type PairKind = 'perp' | 'spot';
export type Scope = 'all' | 'favorites' | 'perp' | 'spot';

export interface SwitcherRow {
  /** The market's own symbol, as the data layer keys it ("BTC-PERP", "BTC/USDC"). */
  symbol: string;
  kind: PairKind;
  base: string;
  quote: string;
  /** How the row names the market: BTC-PERP for a perpetual, BTC/USDC for a spot pair. */
  pair: string;
  market: MarketRow;
  ticker: TickerRow | undefined;
  /** The desk it opens, or null where the build hides that desk. */
  href: string | null;
}

/** A perpetual reads by its contract (BTC-PERP); a spot pair by base and quote. */
const pairOf = (market: Pick<MarketRow, 'base' | 'quote'>, kind: PairKind) =>
  kind === 'perp' ? `${market.base}-PERP` : `${market.base}/${market.quote}`;

/** A perpetual opens the futures desk on its contract, a spot pair the spot desk (BTC-USDC); null where the desk is hidden. */
export function targetOf(market: MarketRow, kind: PairKind, isHidden: (path: string) => boolean): string | null {
  if (kind === 'perp') return isHidden('/trade/futures') ? null : `/trade/futures/${encodeURIComponent(market.symbol)}`;
  const desk = `/trade/spot/${normalizePair(market.symbol)}`;
  return isHidden(desk) ? null : desk;
}

export function rowsOf(
  perps: readonly MarketRow[],
  spot: readonly MarketRow[],
  tickers: Record<string, TickerRow> | undefined,
  isHidden: (path: string) => boolean,
): SwitcherRow[] {
  const make = (market: MarketRow, kind: PairKind): SwitcherRow => ({
    symbol: market.symbol,
    kind,
    base: market.base,
    quote: market.quote,
    pair: pairOf(market, kind),
    market,
    ticker: kind === 'spot' ? tickers?.[market.symbol] : undefined,
    href: targetOf(market, kind, isHidden),
  });
  return [...perps.map((m) => make(m, 'perp')), ...spot.map((m) => make(m, 'spot'))];
}

const squash = (text: string) => text.toLowerCase().replace(/[\s/_-]+/g, '');

/**
 * How well a row answers the search: 0 when its coin is the search ("eth" → ETH), 1 when its coin starts with it
 * ("eth" → ETHFI), 2 when its pair or name holds it anywhere, null when it does not match. An empty search matches all.
 */
function matchRank(row: SwitcherRow, query: string, name: string | null): number | null {
  const needle = squash(query.trim());
  if (!needle) return 2;
  const base = squash(row.base);
  if (base === needle) return 0;
  if (base.startsWith(needle)) return 1;
  const pairText = squash(row.pair);
  if (pairText.startsWith(needle) || pairText.includes(needle) || squash(`${row.base}${row.quote}`).includes(needle)) return 2;
  if (name && squash(name).includes(needle)) return 2;
  return null;
}

const volumeOf = (row: SwitcherRow): number => {
  const raw = row.ticker?.quoteVolume24h;
  // Ordering only: a float is fine to rank by, never shown or added.
  return raw == null ? -1 : Number(raw);
};

/**
 * The rows for a search and scope: perpetuals first, then spot; inside each, the closest match first, then the most
 * traded, then the service's order.
 */
export function pickRows(
  rows: readonly SwitcherRow[],
  query: string,
  scope: Scope,
  favorites: readonly string[],
  nameOf: (base: string) => string | null,
): SwitcherRow[] {
  const fav = new Set(favorites);
  const ranked: Array<{ row: SwitcherRow; rank: number; at: number }> = [];
  rows.forEach((row, at) => {
    if (scope === 'perp' && row.kind !== 'perp') return;
    if (scope === 'spot' && row.kind !== 'spot') return;
    if (scope === 'favorites' && !fav.has(row.symbol)) return;
    const rank = matchRank(row, query, nameOf(row.base));
    if (rank !== null) ranked.push({ row, rank, at });
  });
  const kindOrder = (row: SwitcherRow) => (row.kind === 'perp' ? 0 : 1);
  return ranked
    .sort((a, b) => kindOrder(a.row) - kindOrder(b.row) || a.rank - b.rank || volumeOf(b.row) - volumeOf(a.row) || a.at - b.at)
    .map((entry) => entry.row);
}

/** The text of `label` split around the first place `query` appears in it, for drawing the match. */
export function splitMatch(label: string, query: string): [string, string, string] {
  const needle = query.trim();
  if (!needle) return [label, '', ''];
  const at = label.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return [label, '', ''];
  return [label.slice(0, at), label.slice(at, at + needle.length), label.slice(at + needle.length)];
}

/** The 24h change a row shows: spot carries it from its ticker; a perpetual has no price on this list yet. */
export const changeOf = (row: SwitcherRow): Decimal | null => row.ticker?.changePct24h ?? null;

// The last markets opened from the switcher, newest first, on this device only.
export const RECENT_KEY = 'intafaced.pair-switcher.recent.v1';
const RECENT_LIMIT = 5;

export interface RecentPair {
  symbol: string;
  kind: PairKind;
}

const isRecent = (value: unknown): value is RecentPair =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as RecentPair).symbol === 'string' &&
  ((value as RecentPair).kind === 'perp' || (value as RecentPair).kind === 'spot');

/** The stored recents; an unreadable or blocked store reads as none. */
export function readRecent(storage: Pick<Storage, 'getItem'> | null = safeStorage()): RecentPair[] {
  try {
    const raw = storage?.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Puts `pair` first and keeps five; a store that refuses the write changes nothing else. Returns the new list. */
export function rememberRecent(pair: RecentPair, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): RecentPair[] {
  const next = [pair, ...readRecent(storage).filter((p) => !(p.symbol === pair.symbol && p.kind === pair.kind))].slice(0, RECENT_LIMIT);
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private mode or a full store: the switcher still opens the market, it just will not remember it.
  }
  return next;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
