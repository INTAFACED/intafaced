import { describe, expect, it } from 'vitest';
import type { Candle } from '../../data/types';
import { heikinAshi, isChartStyle, seriesPoints } from './chart-style';

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
});
