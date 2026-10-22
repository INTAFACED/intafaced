import { describe, expect, it } from 'vitest';
import type { Candle } from '../../data/types';
import { deepSince, HISTORY_DEPTH, locateDate, olderBars, withHistory } from './history';

// TEST bars, not market data.
const M = 60_000;
const bar = (t: number, c = '1'): Candle => ({ t, o: c, h: c, l: c, c, v: '1', filled: false });

describe('chart history', () => {
  it('asks for the deepest window the service serves: 720 buckets ending now', () => {
    expect(deepSince('1m', 1000 * M + 5)).toBe((1000 - (HISTORY_DEPTH - 1)) * M);
  });

  it('keeps only bars older than the loaded ones and fills a quiet bucket with the last close', () => {
    const rows: Array<[number, string, string, string, string, string]> = [
      [1 * M, '5', '5', '5', '5', '1'],
      [3 * M, '7', '7', '7', '7', '1'],
      [10 * M, '9', '9', '9', '9', '1'],
    ];
    const older = olderBars(rows, '1m', 10 * M);
    expect(older.map((c) => [c.t / M, c.c, c.filled])).toEqual([
      [1, '5', false],
      [2, '5', true],
      [3, '7', false],
      [4, '7', true],
      [5, '7', true],
      [6, '7', true],
      [7, '7', true],
      [8, '7', true],
      [9, '7', true],
    ]);
    expect(olderBars([[10 * M, '9', '9', '9', '9', '1']], '1m', 10 * M)).toEqual([]);
  });

  it('puts older bars in front with no bar twice', () => {
    const merged = withHistory([bar(3 * M), bar(4 * M)], [bar(1 * M), bar(2 * M), bar(3 * M)]);
    expect(merged.map((c) => c.t / M)).toEqual([1, 2, 3, 4]);
  });

  it("places a date on a bar, before the window's first trade, beyond the depth or in the future", () => {
    const bars = [bar(10 * M), bar(11 * M), bar(12 * M)];
    expect(locateDate(bars, 11 * M + 30_000, 0, 20 * M)).toEqual({ kind: 'show', index: 1 });
    expect(locateDate(bars, 5 * M, 0, 20 * M)).toEqual({ kind: 'no-trades-until', earliest: 10 * M });
    expect(locateDate(bars, 5 * M, 8 * M, 20 * M)).toEqual({ kind: 'beyond-depth', oldestReachable: 8 * M });
    expect(locateDate(bars, 30 * M, 0, 20 * M)).toEqual({ kind: 'future' });
  });
});
