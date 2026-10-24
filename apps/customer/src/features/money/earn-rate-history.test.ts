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
    // 150 of 175 is 85.71% up from the bottom; 175 is the top; 125 is 71.43% up.
    expect(chart.points).toBe('0,14.29 100,14.29 100,0 200,0 200,28.57 300,28.57');
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
