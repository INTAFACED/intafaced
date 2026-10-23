import { describe, expect, it } from 'vitest';
import type { Candle } from '../../data/types';
import { heikinAshi, isChartStyle, percentBase, rebasePoints, seriesPoints, type DrawnPoint } from './chart-style';

// TEST candles, not market data.
const bar = (t: number, o: string, h: string, l: string, c: string): Candle => ({ t, o, h, l, c, v: '1', filled: false });

describe('chart styles', () => {
  it('builds Heikin Ashi from the stated rule', () => {
    const [first, second] = heikinAshi([bar(60_000, '10', '14', '8', '12'), bar(120_000, '12', '16', '11', '15')]);
    expect(first).toEqual({ time: 60, open: 11, high: 14, low: 8, close: 11 });
    // close (12+16+11+15)/4 = 13.5; open (11+11)/2 = 11; high max(16, 11, 13.5); low min(11, 11, 13.5)
    expect(second).toEqual({ time: 120, open: 11, high: 16, low: 11, close: 13.5 });
  });

  it('draws the same bars as lines, areas and coloured columns', () => {
    const bars = [bar(60_000, '10', '14', '8', '12'), bar(120_000, '12', '13', '9', '9')];
    const colors = { up: 'U', down: 'D', line: 'L' };
    expect(seriesPoints('line', bars, colors)).toEqual([
      { time: 60, value: 12 },
      { time: 120, value: 9 },
    ]);
    expect(seriesPoints('columns', bars, colors)).toEqual([
      { time: 60, value: 12, color: 'U' },
      { time: 120, value: 9, color: 'D' },
    ]);
    expect(seriesPoints('bars', bars, colors)[0]).toEqual({ time: 60, open: 10, high: 14, low: 8, close: 12 });
  });

  it('knows the offered styles only', () => {
    expect(isChartStyle('area')).toBe(true);
    expect(isChartStyle('renko')).toBe(false);
  });

  it('rebases every series to its own first point, so that point is 0%', () => {
    const bars = [bar(60_000, '10', '14', '8', '12'), bar(120_000, '12', '13', '9', '9')];
    const points = seriesPoints('bars', bars, { up: 'U', down: 'D', line: 'L' }) as DrawnPoint[];
    expect(percentBase(points)).toBe(12);
    const rebased = rebasePoints(points, 12);
    expect(rebased[0]).toEqual({ time: 60, open: (10 / 12 - 1) * 100, high: (14 / 12 - 1) * 100, low: (8 / 12 - 1) * 100, close: 0 });
    expect(rebased[1]).toMatchObject({ time: 120, close: -25 });
    // A line with no first point, or a first price that is not positive, has no base to rebase to.
    expect(percentBase([])).toBeNull();
    expect(percentBase([{ time: 1, value: 0 }])).toBeNull();
  });
});
