/**
 * How the workbench draws a market's bars: the chart style (candles, bars, line, area, columns, Heikin Ashi), the colour
 * scheme and the price basis. All three are the person's own display choice, kept per workbench on this device.
 *
 * Numbers here are canvas coordinates only (the same rule as `trade/chart/chart-data.ts`): the legend and every price
 * shown as text are still formatted from the service's decimal strings.
 */
import type { Candle } from '../../data/types';
import { toSeconds } from '../trade/chart/chart-data';

export const CHART_STYLES = ['candles', 'bars', 'line', 'area', 'columns', 'heikin-ashi'] as const;
export type ChartStyle = (typeof CHART_STYLES)[number];
export const isChartStyle = (value: unknown): value is ChartStyle => (CHART_STYLES as readonly unknown[]).includes(value);

/** Colour schemes are pairs of app tokens, never free colours: the theme (light or dark) still comes from the app. */
export const COLOUR_SCHEMES = ['standard', 'inverted', 'mono'] as const;
export type ColourScheme = (typeof COLOUR_SCHEMES)[number];
export const isColourScheme = (value: unknown): value is ColourScheme => (COLOUR_SCHEMES as readonly unknown[]).includes(value);

/**
 * The price a bar is built from. Candles are aggregated from the taker fill tape (svc-trade `/ohlcv`), so Last is the
 * only basis the service publishes; Bid and Mark are offered and refused with this code until a series exists for them.
 */
export const PRICE_BASES = ['last', 'bid', 'mark'] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];
export const PUBLISHED_BASES: readonly PriceBasis[] = ['last'];
export const BASIS_UNPUBLISHED = 'trade.chart.basis_unpublished' as const;

export interface SchemeColors {
  up: string;
  down: string;
  line: string;
}
/** Token names per scheme; the chart reads their values from the page at draw time. */
export const SCHEME_TOKENS: Readonly<Record<ColourScheme, { up: string; down: string; line: string }>> = {
  standard: { up: '--if-up', down: '--if-down', line: '--if-lime' },
  inverted: { up: '--if-down', down: '--if-up', line: '--if-lime' },
  mono: { up: '--if-fg', down: '--if-fg-3', line: '--if-fg' },
};

/**
 * Heikin Ashi: close = (O+H+L+C)/4; open = (previous HA open + previous HA close)/2, the first bar's open = (O+C)/2;
 * high = max(H, HA open, HA close); low = min(L, HA open, HA close). A derived series for drawing only: the legend keeps
 * the raw OHLC of the hovered bar.
 */
export function heikinAshi(candles: readonly Candle[]): Array<{ time: number; open: number; high: number; low: number; close: number }> {
  const out: Array<{ time: number; open: number; high: number; low: number; close: number }> = [];
  let prev: { open: number; close: number } | null = null;
  for (const c of candles) {
    const o = Number(c.o);
    const h = Number(c.h);
    const l = Number(c.l);
    const cl = Number(c.c);
    const close = (o + h + l + cl) / 4;
    const open: number = prev ? (prev.open + prev.close) / 2 : (o + cl) / 2;
    out.push({ time: toSeconds(c.t), open, high: Math.max(h, open, close), low: Math.min(l, open, close), close });
    prev = { open, close };
  }
  return out;
}

/** The library series a style is drawn with. */
export type SeriesKind = 'CandlestickSeries' | 'BarSeries' | 'LineSeries' | 'AreaSeries' | 'HistogramSeries';
export const SERIES_KIND: Readonly<Record<ChartStyle, SeriesKind>> = {
  candles: 'CandlestickSeries',
  bars: 'BarSeries',
  line: 'LineSeries',
  area: 'AreaSeries',
  columns: 'HistogramSeries',
  'heikin-ashi': 'CandlestickSeries',
};

/** Every point of the series for a style, oldest first. */
export function seriesPoints(style: ChartStyle, candles: readonly Candle[], colors: SchemeColors): unknown[] {
  if (style === 'heikin-ashi') return heikinAshi(candles);
  if (style === 'line' || style === 'area') return candles.map((c) => ({ time: toSeconds(c.t), value: Number(c.c) }));
  if (style === 'columns')
    return candles.map((c) => ({ time: toSeconds(c.t), value: Number(c.c), color: Number(c.c) >= Number(c.o) ? colors.up : colors.down }));
  return candles.map((c) => ({ time: toSeconds(c.t), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c) }));
}

/** Library options for the main series of a style in a scheme. */
export function seriesOptions(style: ChartStyle, colors: SchemeColors): Record<string, unknown> {
  switch (style) {
    case 'line':
      return { color: colors.line, lineWidth: 2 };
    case 'area':
      return { lineColor: colors.line, topColor: colors.line, bottomColor: 'transparent', lineWidth: 2 };
    case 'columns':
      return { color: colors.up };
    case 'bars':
      return { upColor: colors.up, downColor: colors.down, thinBars: false };
    default:
      return { upColor: colors.up, downColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down, borderVisible: false };
  }
}

/** Percent mode: the price axis and the price labels of every series read as percent change from the series' base. */
export const PERCENT_PRICE_FORMAT = { type: 'custom', minMove: 0.01, formatter: (value: number) => `${value.toFixed(2)}%` } as const;

/** A point as the chart draws it: a time and its prices (OHLC, or one `value` for a line, area or column). */
export type DrawnPoint = { time: number } & Partial<Record<'open' | 'high' | 'low' | 'close' | 'value', unknown>>;
const PRICE_FIELDS = ['open', 'high', 'low', 'close', 'value'] as const;

/**
 * The base a series is rebased to: the close (or value) of its first point, the first bar it draws. Null when there is
 * no first point or it is not a positive price, so percent mode refuses rather than divides by nothing.
 */
export function percentBase(points: readonly DrawnPoint[]): number | null {
  const first = points[0];
  if (!first) return null;
  const base = Number(first.close ?? first.value);
  return Number.isFinite(base) && base > 0 ? base : null;
}

/** Percent mode: every price of a series as percent change from its base, so its first point is 0%. */
export function rebasePoints(points: readonly DrawnPoint[], base: number): DrawnPoint[] {
  return points.map((point) => {
    const out: DrawnPoint = { ...point };
    for (const field of PRICE_FIELDS) {
      const price = point[field];
      if (typeof price === 'number') out[field] = (price / base - 1) * 100;
    }
    return out;
  });
}
