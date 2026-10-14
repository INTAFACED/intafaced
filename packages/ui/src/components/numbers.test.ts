import { describe, expect, it } from 'vitest';
import { signDirection } from './numbers.js';
import { sparklineGeometry, thinSeries } from './sparkline.js';

describe('signDirection (reads a formatted, signed string)', () => {
  it('reads the leading sign', () => {
    expect(signDirection('+$134.46 (+4.02%)')).toBe('up');
    expect(signDirection('+1.24%')).toBe('up');
    expect(signDirection('−0.28%')).toBe('down'); // U+2212
    expect(signDirection('-0.28%')).toBe('down');
    expect(signDirection('−$1.20 (−0.30%)')).toBe('down');
  });

  it('treats an all-zero change as flat whatever its sign', () => {
    expect(signDirection('0.00%')).toBe('flat');
    expect(signDirection('+0.00%')).toBe('flat');
    expect(signDirection('+$0.00 (+0.00%)')).toBe('flat');
    expect(signDirection('−0.00%')).toBe('flat');
  });

  it('treats unknown and unsigned text as flat', () => {
    expect(signDirection(null)).toBe('flat');
    expect(signDirection(undefined)).toBe('flat');
    expect(signDirection('')).toBe('flat');
    expect(signDirection('—')).toBe('flat');
    expect(signDirection('1.24%')).toBe('flat');
  });
});

describe('thinSeries', () => {
  it('keeps short series as they are', () => {
    expect(thinSeries([1, 2, 3], 48)).toEqual([1, 2, 3]);
  });

  it('thins to at most max points and keeps the first and the last', () => {
    const series = Array.from({ length: 200 }, (_, i) => i);
    const out = thinSeries(series, 48);
    expect(out).toHaveLength(48);
    expect(out[0]).toBe(0);
    expect(out[47]).toBe(199);
  });
});

describe('sparklineGeometry (drawing math only)', () => {
  it('draws nothing for fewer than two real points', () => {
    expect(sparklineGeometry([], 154, 56)).toBeNull();
    expect(sparklineGeometry(['100'], 154, 56)).toBeNull();
    expect(sparklineGeometry([null, undefined, '', 'x'], 154, 56)).toBeNull();
  });

  it('skips unknown points instead of drawing them as zero', () => {
    const g = sparklineGeometry(['10', null, '12'], 100, 40, 0);
    expect(g?.points.split(' ')).toHaveLength(2);
  });

  it('colours by first versus last', () => {
    expect(sparklineGeometry(['100', '101', '105'], 100, 40)?.direction).toBe('up');
    expect(sparklineGeometry(['105', '101', '100'], 100, 40)?.direction).toBe('down');
    expect(sparklineGeometry(['100', '120', '100'], 100, 40)?.direction).toBe('flat');
  });

  it('maps the highest value to the top padding and the lowest to the bottom padding', () => {
    const g = sparklineGeometry(['1', '3'], 100, 50, 5)!;
    const [first, last] = g.points.split(' ').map((p) => p.split(',').map(Number)) as [number[], number[]];
    expect(first).toEqual([5, 45]); // lowest, left
    expect(last).toEqual([95, 5]); // highest, right
    expect(g.baselineY).toBe(45); // dotted baseline at the first value
    expect([g.lastX, g.lastY]).toEqual([95, 5]);
  });

  it('draws a flat series in the middle, not on an edge', () => {
    const g = sparklineGeometry(['1', '1', '1'], 100, 50)!;
    expect(g.points.split(' ').every((p) => p.endsWith(',25'))).toBe(true);
  });

  it('never emits more than 48 points', () => {
    const g = sparklineGeometry(
      Array.from({ length: 500 }, (_, i) => String(i)),
      154,
      56,
    )!;
    expect(g.points.split(' ')).toHaveLength(48);
  });
});
