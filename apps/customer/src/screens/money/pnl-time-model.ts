import type { LotBookAnswer, PnlOverTime, PnlPoint } from '@intafaced/contracts/tax-lot-book';
import { PNL_BREAKDOWN_MAX_DAYS } from '@intafaced/contracts/tax-lot-book';
import { dec, maxOf, minOf, ZERO, type Scaled } from '../../data/decimal';
import type { Preferences } from '../../shared/preferences';

/**
 * Profit and loss over time (J-portfolio-05 #4 and #5): which range the customer asked for, and the chart drawn from
 * `tax.pnlOverTime`. Money stays a decimal string or a scaled bigint; only times are plain numbers.
 */

export { pnlOverTimeSchema } from '@intafaced/contracts/tax-lot-book';
export type { PnlOverTime, PnlPoint };
export const BREAKDOWN_MAX_DAYS = PNL_BREAKDOWN_MAX_DAYS;

const DAY = 86_400_000;

/** The preset ranges, in the order of the switch. `all` starts on the day of the first trade or lot in the book. */
export const PNL_RANGES = ['1D', '1W', '1M', '1Y', 'all'] as const;
export type PnlRange = (typeof PNL_RANGES)[number];
const SPAN: Record<Exclude<PnlRange, 'all'>, number> = { '1D': DAY, '1W': 7 * DAY, '1M': 30 * DAY, '1Y': 365 * DAY };
const DEFAULT_RANGE: PnlRange = '1M';

export type RangeAsk =
  | { kind: 'preset'; range: PnlRange }
  /** Whole days in the customer's time zone, both included. */
  | { kind: 'custom'; fromDay: string; toDay: string }
  | { kind: 'invalid' };

const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayStart(day: string, offsetMinutes: number): number | null {
  const match = DAY_TEXT.exec(day);
  if (!match) return null;
  const [, y, m, d] = match;
  const utc = Date.UTC(Number(y), Number(m) - 1, Number(d));
  // A day that does not exist (2026-02-30) rolls over in Date.UTC: refuse it rather than chart another day.
  if (new Date(utc).toISOString().slice(0, 10) !== day) return null;
  return utc - offsetMinutes * 60_000;
}

/** `?range=1W`, or `?from=2026-10-01&to=2026-10-20` (whole days). Absent: the last month. Anything else is refused. */
export function rangeFromQuery(search: string): RangeAsk {
  const params = new URLSearchParams(search);
  const from = params.get('from');
  const to = params.get('to');
  if (from !== null || to !== null) {
    if (from === null || to === null || dayStart(from, 0) === null || dayStart(to, 0) === null || from > to) return { kind: 'invalid' };
    return { kind: 'custom', fromDay: from, toDay: to };
  }
  const raw = params.get('range');
  if (raw === null || raw === '') return { kind: 'preset', range: DEFAULT_RANGE };
  const range = PNL_RANGES.find((option) => option.toLowerCase() === raw.toLowerCase());
  return range ? { kind: 'preset', range } : { kind: 'invalid' };
}

/** The customer's zone as minutes east of UTC, for where a day starts. The device zone is read at `now`. */
export function offsetMinutes(zone: Preferences['timeZone'], now: number): number {
  if (zone === 'UTC') return 0;
  if (zone === 'UTC+8') return 480;
  return -new Date(now).getTimezoneOffset();
}

/** The earliest lot or sale in the book, or null for a book with neither. */
export function firstActivity(book: LotBookAnswer): string | null {
  const times = [...book.lots.map((lot) => lot.acquiredAt), ...book.sales.map((sale) => sale.disposedAt)];
  let first: number | null = null;
  for (const time of times) {
    const at = Date.parse(time);
    if (!Number.isNaN(at) && (first === null || at < first)) first = at;
  }
  return first === null ? null : new Date(first).toISOString();
}

/**
 * What a range's start is read from besides the clock: a key that changes only when one of them does. A preset other than
 * `all` reads neither the zone nor the first trade, so the lot book arriving or the zone loading never moves its start
 * (and never starts a fresh read of the same range).
 */
export function rangeInputs(ask: RangeAsk, offset: number, first: string | null): string {
  if (ask.kind === 'custom') return `${offset}`;
  if (ask.kind === 'preset' && ask.range === 'all') return `${offset}|${first ?? ''}`;
  return '';
}

/**
 * The `from` and `to` sent to the service. A preset ends now (no `to`); a custom range runs from the start of its first
 * day to the end of its last, in the customer's zone (the service ends it at now if that is later). Null: nothing to ask
 * (a refused link, or `all` on a book with nothing in it).
 */
export function resolveRange(ask: RangeAsk, now: number, offset: number, first: string | null): { from: string; to?: string } | null {
  if (ask.kind === 'invalid') return null;
  if (ask.kind === 'custom') {
    const from = dayStart(ask.fromDay, offset);
    const last = dayStart(ask.toDay, offset);
    if (from === null || last === null) return null;
    return { from: new Date(from).toISOString(), to: new Date(last + DAY).toISOString() };
  }
  if (ask.range !== 'all') return { from: new Date(now - SPAN[ask.range]).toISOString() };
  if (first === null) return null;
  const firstAt = Date.parse(first);
  // The start of the customer's day that holds the first trade.
  const local = firstAt + offset * 60_000;
  return { from: new Date(local - (((local % DAY) + DAY) % DAY) - offset * 60_000).toISOString() };
}

/** A text key for a range ask, so a memo keyed on it changes only when the range does (not on `view=` or `by=`). */
export function rangeKey(ask: RangeAsk): string {
  return ask.kind === 'preset' ? ask.range : ask.kind === 'custom' ? `${ask.fromDay}..${ask.toDay}` : 'invalid';
}

/** The link for a range: the room's other choices (`view`, `method`, ...) stay as they are. */
export function rangeSearch(search: string, next: { range: PnlRange } | { fromDay: string; toDay: string }): string {
  const params = new URLSearchParams(search);
  params.delete('range');
  params.delete('from');
  params.delete('to');
  if ('range' in next) {
    if (next.range !== DEFAULT_RANGE) params.set('range', next.range);
  } else {
    params.set('from', next.fromDay);
    params.set('to', next.toDay);
  }
  return params.toString();
}

/** The day `at` falls on in the customer's zone, as `YYYY-MM-DD` (for the date inputs). */
export function dayOf(at: string | number, offset: number): string {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  return new Date(ms + offset * 60_000).toISOString().slice(0, 10);
}

export interface ChartPoint {
  x: string;
  y: string;
}

export interface PnlChart {
  /** Runs of points with a figure; a missing point breaks the line, so the gap shows. */
  runs: ChartPoint[][];
  zeroY: string | null;
  /** The lowest and highest figures drawn, for the axis. */
  low: string;
  high: string;
}

/** One moment on a line over time: a USD figure, or null where it is missing. */
export interface LinePoint {
  at: string;
  usd: string | null;
}

/**
 * A line over time, in whole-number coordinates made with bigint division (no money value becomes a float). The x axis is
 * time, so a gap keeps its width. Null when no point has a figure or the points span no time.
 */
export function lineChart(points: readonly LinePoint[], width: number, height: number): PnlChart | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  const t0 = BigInt(Date.parse(first.at));
  const span = BigInt(Date.parse(last.at)) - t0;
  if (span <= 0n) return null;
  const known = points.flatMap((point) => {
    const usd = dec(point.usd);
    return usd === null ? [] : [usd];
  });
  const top = maxOf(known);
  const bottom = minOf(known);
  if (top === null || bottom === null) return null;
  const range: Scaled = top - bottom;
  const w = BigInt(width);
  const h = BigInt(height);
  const yOf = (value: Scaled) => (range === ZERO ? h / 2n : h - ((value - bottom) * h) / range);
  const runs: ChartPoint[][] = [];
  let run: ChartPoint[] = [];
  for (const point of points) {
    const usd = dec(point.usd);
    if (usd === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    run.push({ x: String(((BigInt(Date.parse(point.at)) - t0) * w) / span), y: String(yOf(usd)) });
  }
  if (run.length > 0) runs.push(run);
  const zeroOnChart = ZERO >= bottom && ZERO <= top;
  return {
    runs,
    zeroY: zeroOnChart ? String(yOf(ZERO)) : null,
    low: points.find((p) => dec(p.usd) === bottom)!.usd!,
    high: points.find((p) => dec(p.usd) === top)!.usd!,
  };
}

/** The cumulative profit and loss line's points (J-portfolio-05 #4). */
export function pnlLinePoints(points: readonly PnlPoint[]): LinePoint[] {
  return points.map((point) => ({ at: point.at, usd: point.totalUsd }));
}

/** Every coin a missing point names, once per reason, and how many points are missing. */
export function missingOf(points: readonly PnlPoint[]): { count: number; coins: PnlPoint['missing'] } {
  const seen = new Map<string, PnlPoint['missing'][number]>();
  let count = 0;
  for (const point of points) {
    if (point.totalUsd !== null) continue;
    count += 1;
    for (const item of point.missing) seen.set(`${item.assetId}|${item.reason}`, item);
  }
  return { count, coins: [...seen.values()].sort((a, b) => a.assetId.localeCompare(b.assetId) || a.reason.localeCompare(b.reason)) };
}

/** A market row's key: a market (`BTC/USDT`), `held` (the price move on what is still held), `moved:<coin>` or `swap:<coin>`. */
export type MarketKey =
  { kind: 'market'; market: string } | { kind: 'held' } | { kind: 'moved'; assetId: string } | { kind: 'swap'; assetId: string };

export function marketKey(key: string): MarketKey {
  if (key === 'held') return { kind: 'held' };
  if (key.startsWith('moved:')) return { kind: 'moved', assetId: key.slice('moved:'.length) };
  if (key.startsWith('swap:')) return { kind: 'swap', assetId: key.slice('swap:'.length) };
  return { kind: 'market', market: key };
}

export const BREAKDOWNS = ['asset', 'market', 'day'] as const;
export type Breakdown = (typeof BREAKDOWNS)[number];

/** `?by=` on /money/pnl: absent or unknown is by coin. */
export function breakdownFromQuery(search: string): Breakdown {
  const raw = new URLSearchParams(search).get('by');
  return (BREAKDOWNS as readonly string[]).includes(raw ?? '') ? (raw as Breakdown) : 'asset';
}
