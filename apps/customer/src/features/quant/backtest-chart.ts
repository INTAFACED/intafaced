import type { QuantBacktestResult } from '@intafaced/contracts/quant-algo';
import { parseAmount } from '../../shared/money';
import { toCsv } from '../more/depth-csv';

export interface EquityMarker {
  readonly x: string;
  readonly y: string;
  readonly side: 'buy' | 'sell';
  readonly ts: string;
}

/**
 * The equity curve of a run as SVG points, with a marker on the bar of each fill. Coordinates come from bigint
 * division of the stored decimal strings, so no money value is turned into a float to draw it. A fill sits on the
 * equity point of the bar it filled on; a run with fewer than two points has no curve.
 */
export function equityGeometry(
  result: Pick<QuantBacktestResult, 'equity' | 'trades'>,
  width: number,
  height: number,
): { line: string; markers: EquityMarker[]; unmatched: number } | null {
  const points = result.equity;
  if (points.length < 2) return null;
  const values = points.map((point) => parseAmount(point.equity));
  const top = values.reduce((a, b) => (b > a ? b : a));
  const bottom = values.reduce((a, b) => (b < a ? b : a));
  const range = top - bottom;
  const w = BigInt(width);
  const h = BigInt(height);
  const last = BigInt(points.length - 1);
  const xOf = (i: number) => String((BigInt(i) * w) / last);
  const yOf = (value: bigint) => String(range === 0n ? h / 2n : h - ((value - bottom) * h) / range);
  const line = values.map((value, i) => `${xOf(i)},${yOf(value)}`).join(' ');
  // Matched on the instant, not the text, so two spellings of one time still meet; a fill with no point is counted.
  const indexOf = new Map(points.map((point, i) => [Date.parse(point.ts), i]));
  const markers: EquityMarker[] = [];
  let unmatched = 0;
  for (const trade of result.trades) {
    const i = indexOf.get(Date.parse(trade.ts));
    if (i === undefined) {
      unmatched += 1;
      continue;
    }
    markers.push({ x: xOf(i), y: yOf(values[i]!), side: trade.side, ts: trade.ts });
  }
  return { line, markers, unmatched };
}

export const TRADES_CSV_HEADER = ['time_utc', 'side', 'reason', 'quantity', 'bar_price', 'fill_price', 'fee', 'slippage'] as const;

/**
 * One row per fill of the run, as stored. A cell a spreadsheet would run as a formula (starting with =, +, -, @) is
 * neutralised with a leading apostrophe by the shared CSV writer.
 */
export function tradesCsv(result: Pick<QuantBacktestResult, 'trades'>): string {
  return toCsv(
    TRADES_CSV_HEADER,
    result.trades.map((trade) => [trade.ts, trade.side, trade.reason, trade.qty, trade.barPrice, trade.price, trade.fee, trade.slippage]),
  );
}

/** A file name that says which run it came from. */
export function tradesCsvName(runId: string): string {
  return `backtest-${runId.replace(/[^A-Za-z0-9_-]/g, '_')}-trades.csv`;
}
