import { describe, expect, it } from 'vitest';
import { candleLadder, DEFAULT_RANGE, RANGES, rangeById, type RangeSpec } from './ranges';

describe('range pills (UI-SPEC 5.5)', () => {
  it('are 1D, 1W, 1M, 6M, 1Y and All, in that order', () => {
    expect(RANGES.map((range) => range.id)).toEqual(['1D', '1W', '1M', '6M', '1Y', 'All']);
  });
  it('read the candles the spec names', () => {
    expect(RANGES.map((range) => `${range.interval}x${range.limit}`)).toEqual(['5mx288', '1hx168', '4hx180', '1dx180', '1dx365', '1wx260']);
  });
  it('start on the last day and fall back to it for anything unknown', () => {
    expect(DEFAULT_RANGE).toBe('1D');
    expect(rangeById('nonsense').id).toBe('1D');
    expect(rangeById('1Y').interval).toBe('1d');
  });
  it('never ask the service for more than its 1000-candle cap', () => {
    for (const range of RANGES) expect(range.limit).toBeLessThanOrEqual(1000);
  });
  it('step to finer candles for a market younger than the range, never to coarser ones', () => {
    const names = (id: RangeSpec['id']) => candleLadder(id).map((spec) => `${spec.interval}x${spec.limit}`);
    expect(names('1D')).toEqual(['5mx288']);
    expect(names('1W')).toEqual(['1hx168', '5mx288']);
    expect(names('6M')).toEqual(['1dx180', '4hx180', '1hx168', '5mx288']);
    expect(names('1Y')).toEqual(['1dx365', '4hx180', '1hx168', '5mx288']);
    expect(names('All')).toEqual(['1wx260', '1dx365', '4hx180', '1hx168', '5mx288']);
  });
});
