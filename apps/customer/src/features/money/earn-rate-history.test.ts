import { describe, expect, it } from 'vitest';
import { COMPARE_MAX, rowDiffers, stepChart, togglePick } from './earn-rate-history';

const changes = [
  { rateBps: 150, effectiveAt: '2026-10-01T00:00:00.000Z' },
  { rateBps: 175, effectiveAt: '2026-10-11T00:00:00.000Z' },
  { rateBps: 125, effectiveAt: '2026-10-21T00:00:00.000Z' },
];

describe('stepChart', () => {
  it('draws one flat step per record from its date, then up or down, and nothing before the first', () => {
    const chart = stepChart(changes, Date.parse('2026-10-31T00:00:00.000Z'), 300, 100)!;
    expect(chart.topBps).toBe(175);
    expect(chart.marks.map((m) => [m.x, m.rateBps])).toEqual([
      [0, 150],
      [100, 175],
      [200, 125],
    ]);
    // The scale tops out at 175 × 1.25 = 218.75: 150 is 68.57% up from the bottom, 175 is 80% up, 125 is 57.14% up.
    expect(chart.points).toBe('0,31.43 100,31.43 100,20 200,20 200,42.86 300,42.86');
  });

  it('draws one rate on record inside the box, not on its top edge', () => {
    const chart = stepChart([{ rateBps: 100, effectiveAt: '2026-11-22T00:00:00.000Z' }], Date.parse('2026-11-23T09:00:00.000Z'), 600, 160)!;
    expect(chart.marks[0]!.y).toBe(32);
    expect(chart.points).toBe('0,32 600,32');
  });

  it('draws nothing when the bank recorded nothing', () => {
    expect(stepChart([], Date.now(), 300, 100)).toBeNull();
  });
});

describe('the side-by-side table', () => {
  it('marks a row whose cells are not all the same', () => {
    expect(rowDiffers(['4%', '4%'])).toBe(false);
    expect(rowDiffers(['4%', '6%'])).toBe(true);
    expect(rowDiffers(['Not set'])).toBe(false);
  });

  it('holds two to four pools: a fifth pick changes nothing, and a pick toggles off', () => {
    let picked: string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e']) picked = togglePick(picked, id);
    expect(picked).toEqual(['a', 'b', 'c', 'd']);
    expect(picked).toHaveLength(COMPARE_MAX);
    expect(togglePick(picked, 'b')).toEqual(['a', 'c', 'd']);
  });
});
