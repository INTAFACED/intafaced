/**
 * What the workbench hands out of a chart: a CSV of the bars on screen, the address of the chart (market, interval and
 * style, never anything about the account), and a PNG file name. Prices are the exact strings the service sent.
 */
import type { Candle } from '../../data/types';
import { pairOf } from '../trade/desk/market';
import type { ChartInterval } from '../trade/chart/candles';
import type { ChartStyle } from './chart-style';

/**
 * A text cell that starts with a formula character is prefixed so a spreadsheet reads it as text. A minus sign followed by
 * a digit is a negative price, not a formula, and is left as it is.
 */
const FORMULA_START = /^(?:[=+@\t\r]|-(?!\d))/;
function cell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One row per bar, oldest first, times in UTC; the first line names the market, the interval and the viewer's zone. */
export function barsCsv(bars: readonly Candle[], symbol: string, interval: ChartInterval, viewerZone: string): string {
  const head = `# ${symbol} ${interval} bars; times are UTC; viewer time zone ${viewerZone}; filled = a quiet interval repeating the previous close`;
  const rows = bars.map((b) => [new Date(b.t).toISOString(), b.o, b.h, b.l, b.c, b.v, b.filled ? 'yes' : 'no'].map(cell).join(','));
  return [head, 'time_utc,open,high,low,close,volume,filled', ...rows].join('\n');
}

/**
 * The bars in the visible logical range, clamped to the bars there are. A bar counts when its centre is in view: an edge
 * bar half off screen is left out, as the chart draws it.
 */
export function visibleBars(bars: readonly Candle[], range: { from: number; to: number } | null): readonly Candle[] {
  if (!range) return bars;
  const from = Math.max(0, Math.round(range.from));
  const to = Math.min(bars.length - 1, Math.round(range.to));
  return to < from ? [] : bars.slice(from, to + 1);
}

/** The internal link to this chart: market, interval and style only. */
export function chartLink(origin: string, symbol: string, interval: ChartInterval, style: ChartStyle): string {
  const query = new URLSearchParams({ interval, style });
  return `${origin}/charts/${encodeURIComponent(pairOf(symbol))}?${query.toString()}`;
}

export const fileStem = (symbol: string, interval: ChartInterval): string => `chart-${pairOf(symbol)}-${interval}`;
