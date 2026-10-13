/**
 * Candles and markers turned into what the vendored Lightweight Charts draws.
 *
 * This is the one place in the desk where decimal strings become JS numbers, because a canvas needs coordinates:
 * `Number()` here is for drawing only (UI-SPEC principle 5). Text shown to the person (legend, prices) is still
 * produced from the decimal strings by `data/format.ts`, never from these numbers.
 */
import { TIMEFRAME_MS } from '@intafaced/exchange-contract/schemas';
import { dec, decOrNull, fractionDigits, ratio, sub } from '../../../data/decimal';
import { fmtPct, fmtPrice } from '../../../data/format';
import type { Candle, Decimal } from '../../../data/types';

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
  open: Number(c.o),
  high: Number(c.h),
  low: Number(c.l),
  close: Number(c.c),
});

export const toLinePoint = (c: Candle): { time: number; value: number } => ({ time: toSeconds(c.t), value: Number(c.c) });

export function toVolumeBar(c: Candle, colors: { up: string; down: string }): { time: number; value: number; color: string } {
  return { time: toSeconds(c.t), value: Number(c.v), color: Number(c.c) >= Number(c.o) ? colors.up : colors.down };
}

/** Simple moving average of the closes. The first `period - 1` candles have no value. */
export function movingAverage(candles: readonly Candle[], period: number): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  let sum = 0;
  const closes = candles.map((c) => Number(c.c));
  for (let i = 0; i < closes.length; i += 1) {
    sum += closes[i]!;
    if (i >= period) sum -= closes[i - period]!;
    if (i >= period - 1) out.push({ time: toSeconds(candles[i]!.t), value: sum / period });
  }
  return out;
}

/** Axis price format from the market's tick: "0.01" draws two decimals and moves by 0.01. */
export function priceFormat(tickSize: Decimal): { type: 'custom'; formatter: (price: number) => string; minMove: number } {
  const precision = fractionDigits(tickSize) ?? 2;
  const move = Number(tickSize);
  const format = new Intl.NumberFormat('en', { minimumFractionDigits: precision, maximumFractionDigits: precision });
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

/** The OHLC legend line for one candle, text from the decimal strings. */
export function legendValues(c: Candle, tickSize: Decimal): LegendValues {
  const open = dec(c.o);
  const close = dec(c.c);
  let change = '—';
  let direction: LegendValues['direction'] = 'flat';
  if (open !== null && close !== null) {
    const diff = sub(close, open);
    direction = diff > 0n ? 'up' : diff < 0n ? 'down' : 'flat';
    const pct = open > 0n ? fmtPct(decOrNull(ratio(diff, open))) : '—';
    change = `${fmtPrice(decOrNull(diff), tickSize)} (${pct})`.replace(/^([^−+])/, diff > 0n ? '+$1' : '$1');
  }
  return {
    open: fmtPrice(c.o, tickSize),
    high: fmtPrice(c.h, tickSize),
    low: fmtPrice(c.l, tickSize),
    close: fmtPrice(c.c, tickSize),
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
