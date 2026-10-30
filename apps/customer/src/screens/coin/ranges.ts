import type { ChartInterval } from './deps';

/**
 * The range pills (UI-SPEC 5.5, and 6M from J-portfolio-10 #2): 1D = 5m x 288, 1W = 1h x 168, 1M = 4h x 180,
 * 6M = 1d x 180, 1Y = 1d x 365, All = 1w.
 */
export interface RangeSpec {
  id: '1D' | '1W' | '1M' | '6M' | '1Y' | 'All';
  interval: ChartInterval;
  limit: number;
}

export const RANGES: readonly RangeSpec[] = [
  { id: '1D', interval: '5m', limit: 288 },
  { id: '1W', interval: '1h', limit: 168 },
  { id: '1M', interval: '4h', limit: 180 },
  { id: '6M', interval: '1d', limit: 180 },
  { id: '1Y', interval: '1d', limit: 365 },
  { id: 'All', interval: '1w', limit: 260 },
];

export const DEFAULT_RANGE: RangeSpec['id'] = '1D';

export const rangeById = (id: string): RangeSpec => RANGES.find((range) => range.id === id) ?? RANGES[0]!;

/**
 * A market younger than the range has too few coarse candles to draw a line (a one-day-old market has one daily
 * candle). Each range then steps to the next finer range's candles, until there are two or more, so "All" and "1Y"
 * show the whole of a young market's history instead of an empty box. The first step is the range's own candles.
 */
export function candleLadder(id: RangeSpec['id']): readonly Pick<RangeSpec, 'interval' | 'limit'>[] {
  const at = RANGES.findIndex((range) => range.id === id);
  // A step with the same candles as the one before it (6M and 1Y are both daily) could not have more of them: skipped.
  return RANGES.slice(0, Math.max(at, 0) + 1)
    .reverse()
    .filter((range, index, steps) => index === 0 || steps[index - 1]!.interval !== range.interval)
    .map(({ interval, limit }) => ({ interval, limit }));
}
