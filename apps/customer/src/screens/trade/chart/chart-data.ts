/** Candles and markers turned into what the vendored Lightweight Charts draws. */
import { TIMEFRAME_MS } from '@intafaced/exchange-contract/schemas';
import { dec, decOrNull, fractionDigits, ratio, sub } from '../../../data/decimal';
import { fmtPct, fmtPrice } from '../../../data/format';
import type { Candle, Decimal } from '../../../data/types';
import { chartValue } from '../../../shared/chart-value';

/** Seconds since the epoch: what the chart wants as `time`. */
export const toSeconds = (ms: number): number => Math.floor(ms / 1000);

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export const toBar = (c: Candle): Bar => ({
  time: toSeconds(c.t),
  open: chartValue(c.o),
  high: chartValue(c.h),
  low: chartValue(c.l),
  close: chartValue(c.c),
});

/** A thin market's band: each candle as a box from its low to its high, the range it traded in. */
export const toBand = (c: Candle): Bar => ({
  time: toSeconds(c.t),
  open: chartValue(c.h),
  high: chartValue(c.h),
  low: chartValue(c.l),
  close: chartValue(c.l),
});

/** A thin market's line: the middle of each candle's own range, (high + low) / 2. */
export const toMidPoint = (c: Candle): { time: number; value: number } => ({
  time: toSeconds(c.t),
  value: (chartValue(c.h) + chartValue(c.l)) / 2,
});

/**
 * How many of the traded candles stayed inside the pair's own spread (low at or above the best bid, high at or below the
 * best ask), when that is most of them: a market that only trades across its own spread, whose candles say nothing of a
 * price moving. Null when most candles moved outside it, or when nothing traded.
 */
export function thinShare(candles: readonly Candle[], bid: Decimal, ask: Decimal): { inside: number; total: number } | null {
  const lo = chartValue(bid);
  const hi = chartValue(ask);
  const traded = candles.filter((c) => !c.filled);
  const inside = traded.filter((c) => chartValue(c.l) >= lo && chartValue(c.h) <= hi).length;
  return traded.length > 0 && inside * 2 > traded.length ? { inside, total: traded.length } : null;
}

/** A thin market's axis: at least 5% either side of the last price, so a narrow spread sits calm in the middle. */
export function thinRange(last: number, range: { minValue: number; maxValue: number } | null): { minValue: number; maxValue: number } {
  return {
    minValue: Math.min(range?.minValue ?? last, last * 0.95),
    maxValue: Math.max(range?.maxValue ?? last, last * 1.05),
  };
}

/** A `#rgb` or `#rrggbb` colour at `alpha`, as the chart engine takes it; any other colour as it is. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? [...hex].map((x) => x + x).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const toLinePoint = (c: Candle): { time: number; value: number } => ({ time: toSeconds(c.t), value: chartValue(c.c) });

export function toVolumeBar(c: Candle, colors: { up: string; down: string }): { time: number; value: number; color: string } {
  return { time: toSeconds(c.t), value: chartValue(c.v), color: chartValue(c.c) >= chartValue(c.o) ? colors.up : colors.down };
}

/** Simple moving average of the closes. The first `period - 1` candles have no value. */
export function movingAverage(candles: readonly Candle[], period: number): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  let sum = 0;
  const closes = candles.map((c) => chartValue(c.c));
  for (let i = 0; i < closes.length; i += 1) {
    sum += closes[i]!;
    if (i >= period) sum -= closes[i - period]!;
    if (i >= period - 1) out.push({ time: toSeconds(candles[i]!.t), value: sum / period });
  }
  return out;
}

/**
 * The step a chart draws prices at: the market's tick, but never finer than `figures` significant figures of the price
 * (a venue that prices by significant figures may publish a tick of 0.00000001 for a 4.53 coin, which would draw
 * "4.53420000"). Only the drawing uses it; an order on the chart still keeps to the market's own tick.
 */
export function shownTick(tick: Decimal, price: Decimal | null, figures = 5): Decimal {
  const places = fractionDigits(tick) ?? 0;
  if (price === null || !/^-?\d+(\.\d+)?$/.test(price)) return tick;
  const [whole = '', frac = ''] = price.replace('-', '').split('.');
  const digits = whole.replace(/^0+/, '').length;
  const want = digits > 0 ? Math.max(0, figures - digits) : (/^0*/.exec(frac)?.[0].length ?? 0) + figures;
  if (want >= places) return tick;
  return want === 0 ? '1' : `0.${'0'.repeat(want - 1)}1`;
}

/**
 * Axis price format from the market's tick: "0.01" draws two decimals and moves by 0.01. The digits are grouped and
 * pointed as the person's locale writes them ("65 000,00" in French).
 */
export function priceFormat(tickSize: Decimal, locale = 'en'): { type: 'custom'; formatter: (price: number) => string; minMove: number } {
  const precision = fractionDigits(tickSize) ?? 2;
  const move = chartValue(tickSize);
  const format = new Intl.NumberFormat(locale, { minimumFractionDigits: precision, maximumFractionDigits: precision });
  return {
    type: 'custom',
    formatter: (price) => format.format(price),
    minMove: Number.isFinite(move) && move > 0 ? move : 10 ** -precision,
  };
}

export interface FillMark {
  /** Epoch ms of the fill. */
  at: number;
  side: 'buy' | 'sell';
}

export interface Marker {
  time: number;
  position: 'belowBar' | 'aboveBar';
  shape: 'arrowUp' | 'arrowDown';
  color: string;
  text: string;
}

/**
 * B/S markers for the person's own fills: placed on the candle the fill happened in, buys below the bar and
 * sells above. A fill older than the first candle on screen is skipped. Sorted by time, as the chart requires.
 */
export function fillMarkers(
  fills: readonly FillMark[],
  candles: readonly Candle[],
  stepMs: number,
  colors: { up: string; down: string },
  labels: { buy: string; sell: string },
): Marker[] {
  const present = new Set(candles.map((c) => c.t));
  const markers: Marker[] = [];
  for (const fill of fills) {
    const bucket = Math.floor(fill.at / stepMs) * stepMs;
    if (!present.has(bucket)) continue;
    markers.push(
      fill.side === 'buy'
        ? { time: toSeconds(bucket), position: 'belowBar', shape: 'arrowUp', color: colors.up, text: labels.buy }
        : { time: toSeconds(bucket), position: 'aboveBar', shape: 'arrowDown', color: colors.down, text: labels.sell },
    );
  }
  return markers.sort((a, b) => a.time - b.time);
}

export const stepOf = (interval: keyof typeof TIMEFRAME_MS): number => TIMEFRAME_MS[interval];

export interface LegendValues {
  open: string;
  high: string;
  low: string;
  close: string;
  /** "−69.30 (−0.08%)" from the candle's own open and close, in exact arithmetic. */
  change: string;
  direction: 'up' | 'down' | 'flat';
}

/** The OHLC legend line for one candle, text from the decimal strings, in the person's locale. */
export function legendValues(c: Candle, tickSize: Decimal, locale = 'en'): LegendValues {
  const open = dec(c.o);
  const close = dec(c.c);
  let change = '—';
  let direction: LegendValues['direction'] = 'flat';
  if (open !== null && close !== null) {
    const diff = sub(close, open);
    direction = diff > 0n ? 'up' : diff < 0n ? 'down' : 'flat';
    const pct = open > 0n ? fmtPct(decOrNull(ratio(diff, open)), { locale }) : '—';
    change = `${fmtPrice(decOrNull(diff), tickSize, { locale })} (${pct})`.replace(/^([^−+])/, diff > 0n ? '+$1' : '$1');
  }
  return {
    open: fmtPrice(c.o, tickSize, { locale }),
    high: fmtPrice(c.h, tickSize, { locale }),
    low: fmtPrice(c.l, tickSize, { locale }),
    close: fmtPrice(c.c, tickSize, { locale }),
    change,
    direction,
  };
}

/**
 * How to feed a changed candle list to a series that already holds the previous one: `update` for the newest
 * candles when the window is the same one (no re-mount, no flicker), `reset` when it moved or the series is new.
 */
export function planUpdate(prev: readonly Candle[] | null, next: readonly Candle[]): { kind: 'reset' } | { kind: 'update'; from: number } {
  if (!prev || prev.length === 0 || next.length === 0) return { kind: 'reset' };
  if (prev[0]!.t !== next[0]!.t) return { kind: 'reset' };
  const lastPrev = prev[prev.length - 1]!;
  const at = next.findIndex((c) => c.t === lastPrev.t);
  if (at === -1) return { kind: 'reset' };
  // Every candle before the previous last one must be unchanged for an update to be enough.
  for (let i = 0; i < at; i += 1) {
    const a = prev[i]!;
    const b = next[i]!;
    if (a.t !== b.t || a.c !== b.c || a.o !== b.o || a.h !== b.h || a.l !== b.l || a.v !== b.v) return { kind: 'reset' };
  }
  return { kind: 'update', from: at };
}
