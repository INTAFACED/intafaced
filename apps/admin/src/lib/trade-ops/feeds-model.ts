/**
 * Market feed health (C-ops-01, J-charts-desk-18 #1 #2): what svc-trade `admin.feedHealth.*` answers, parsed. Client-safe.
 *
 * A stream's state is decided by svc-trade against the owner's delayed boundary; this file only reads it. A value the
 * service did not send is "—", never zero.
 */

export type FeedState = 'live' | 'stale' | 'no_ticks' | 'threshold_not_set';

export interface FeedRow {
  readonly symbol: string;
  readonly test: boolean;
  readonly lastTickAt: string | null;
  readonly ageSeconds: number | null;
  readonly state: FeedState;
}

export interface FeedListView {
  readonly asOf: string;
  readonly boundarySeconds: number | null;
  readonly watcher: { readonly intervalMs: number; readonly writing: boolean };
  readonly markets: readonly FeedRow[];
}

export interface FeedGap {
  readonly from: string;
  readonly to: string;
  readonly minutes: number;
}

export interface FeedEvent {
  readonly id: string;
  readonly kind: 'drop' | 'reconnect';
  readonly at: string;
  readonly observedAt: string;
  readonly reason: string;
  readonly actor: 'system';
}

export interface FeedMarketView extends FeedListView {
  readonly market: FeedRow;
  readonly gapWindowMinutes: number;
  readonly gaps: readonly FeedGap[];
  readonly gapsTruncated: boolean;
  readonly journal: readonly FeedEvent[];
}

/** The gap window the page asks for when the operator has not typed one. Shown in the field; not a service value. */
export const DEFAULT_GAP_WINDOW_MINUTES = 60;

export const FEED_STATE_LABEL: Readonly<Record<FeedState, string>> = {
  live: 'live',
  stale: 'stale',
  no_ticks: 'no ticks yet',
  threshold_not_set: 'threshold not set',
};

/** The drill-down's address: the symbol with its "/" encoded, as the markets room does (BTC%2FUSDT). */
export const feedHref = (symbol: string): string => `/trade-ops/feeds/${encodeURIComponent(symbol)}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): v is string => typeof v === 'string';
const intOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isInteger(v));
const STATES: readonly FeedState[] = ['live', 'stale', 'no_ticks', 'threshold_not_set'];

function parseRow(raw: unknown): FeedRow | null {
  if (!isObj(raw) || !str(raw.symbol) || typeof raw.test !== 'boolean') return null;
  if (!(raw.lastTickAt === null || str(raw.lastTickAt)) || !intOrNull(raw.ageSeconds)) return null;
  if (!STATES.includes(raw.state as FeedState)) return null;
  return {
    symbol: raw.symbol,
    test: raw.test,
    lastTickAt: raw.lastTickAt as string | null,
    ageSeconds: raw.ageSeconds as number | null,
    state: raw.state as FeedState,
  };
}

export function parseFeedListView(raw: unknown): FeedListView | null {
  if (!isObj(raw) || !str(raw.asOf) || !intOrNull(raw.boundarySeconds) || !Array.isArray(raw.markets)) return null;
  const w = raw.watcher;
  if (!isObj(w) || typeof w.intervalMs !== 'number' || typeof w.writing !== 'boolean') return null;
  const markets = raw.markets.map(parseRow);
  if (markets.some((m) => m === null)) return null;
  return {
    asOf: raw.asOf,
    boundarySeconds: raw.boundarySeconds as number | null,
    watcher: { intervalMs: w.intervalMs, writing: w.writing },
    markets: markets as FeedRow[],
  };
}

export function parseFeedMarketView(raw: unknown): FeedMarketView | null {
  const list = parseFeedListView(raw);
  if (!list || !isObj(raw)) return null;
  const market = parseRow(raw.market);
  if (!market || typeof raw.gapWindowMinutes !== 'number' || typeof raw.gapsTruncated !== 'boolean') return null;
  if (!Array.isArray(raw.gaps) || !Array.isArray(raw.journal)) return null;
  const gaps: FeedGap[] = [];
  for (const g of raw.gaps) {
    if (!isObj(g) || !str(g.from) || !str(g.to) || typeof g.minutes !== 'number') return null;
    gaps.push({ from: g.from, to: g.to, minutes: g.minutes });
  }
  const journal: FeedEvent[] = [];
  for (const e of raw.journal) {
    if (!isObj(e) || !str(e.id) || !str(e.at) || !str(e.observedAt) || !str(e.reason)) return null;
    if ((e.kind !== 'drop' && e.kind !== 'reconnect') || e.actor !== 'system') return null;
    journal.push({ id: e.id, kind: e.kind, at: e.at, observedAt: e.observedAt, reason: e.reason, actor: 'system' });
  }
  return { ...list, market, gapWindowMinutes: raw.gapWindowMinutes, gaps, gapsTruncated: raw.gapsTruncated, journal };
}

/** A time as the desk shows it: UTC, to the second. */
export const utcSecond = (iso: string): string => `${iso.slice(0, 19).replace('T', ' ')} UTC`;
