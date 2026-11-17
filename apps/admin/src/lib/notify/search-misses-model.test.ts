import { describe, expect, it } from 'vitest';
import { readSearchMisses } from './search-misses-model';

describe('search misses (HM-navigation-04)', () => {
  const ok = {
    kind: 'search_miss',
    from: '2026-11-01',
    to: '2026-11-14',
    approximate: true,
    days: [
      { day: '2026-11-09', count: 3 },
      { day: '2026-11-10', count: 2 },
    ],
  };
  it('reads the per-day counts and their total', () => {
    expect(readSearchMisses(ok)).toEqual({ from: '2026-11-01', to: '2026-11-14', days: ok.days, total: 5 });
    expect(readSearchMisses({ ...ok, days: [] })).toMatchObject({ days: [], total: 0 });
  });
  it('is no answer, never zero, for anything else', () => {
    for (const bad of [
      null,
      {},
      { ...ok, kind: 'other' },
      { ...ok, approximate: false },
      { ...ok, days: [{ day: 'x', count: 1 }] },
      { ...ok, days: [{ day: '2026-11-09', count: -1 }] },
      { ...ok, days: [{ day: '2026-11-09', count: 1.5 }] },
    ])
      expect(readSearchMisses(bad)).toBeNull();
  });
});
