import type { ChartInterval } from './deps';

/**
 * The range pills (UI-SPEC 5.5): 1D = 5m x 288, 1W = 1h x 168, 1M = 4h x 180, 1Y = 1d x 365, All = 1w.
 * A market younger than a week has fewer than two weekly candles, so All falls back to daily ones
 * (`ALL_FALLBACK`) rather than drawing nothing.
 */
export interface RangeSpec {
  id: '1D' | '1W' | '1M' | '1Y' | 'All';
  interval: ChartInterval;
  limit: number;
}

export const RANGES: readonly RangeSpec[] = [
  { id: '1D', interval: '5m', limit: 288 },
  { id: '1W', interval: '1h', limit: 168 },
  { id: '1M', interval: '4h', limit: 180 },
  { id: '1Y', interval: '1d', limit: 365 },
  { id: 'All', interval: '1w', limit: 260 },
];

export const ALL_FALLBACK: Pick<RangeSpec, 'interval' | 'limit'> = { interval: '1d', limit: 1000 };

export const DEFAULT_RANGE: RangeSpec['id'] = '1D';

export const rangeById = (id: string): RangeSpec => RANGES.find((range) => range.id === id) ?? RANGES[0]!;
