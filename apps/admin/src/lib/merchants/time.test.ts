import { describe, expect, it } from 'vitest';
import { describeFreshness, formatLag, formatUtc, STALE_AFTER_SECONDS, stalestFreshness } from './time';

describe('as-of wording', () => {
  it('formats UTC without a locale', () => {
    expect(formatUtc('2026-10-15T10:02:03.456Z')).toBe('2026-10-15 10:02:03 UTC');
    expect(formatUtc('2026-10-15T18:02:03+08:00')).toBe('2026-10-15 10:02:03 UTC');
    expect(formatUtc(null)).toBe('unknown');
    expect(formatUtc('garbage')).toBe('unknown');
  });

  it('formats lag', () => {
    expect(formatLag(null)).toBe('lag unknown');
    expect(formatLag(12)).toBe('lag 12 s');
    expect(formatLag(125)).toBe('lag 2 min 5 s');
    expect(formatLag(7260)).toBe('lag 2 h 1 min');
  });

  it('a figure with no known freshness is never live', () => {
    expect(describeFreshness({ asOf: null, lagSeconds: null }).state).toBe('unknown');
    expect(describeFreshness({ asOf: '2026-10-15T10:00:00Z', lagSeconds: null }).state).toBe('unknown');
    expect(describeFreshness({ asOf: null, lagSeconds: 3 }).state).toBe('unknown');
    expect(describeFreshness({ asOf: '2026-10-15T10:00:00Z', lagSeconds: 3 }).state).toBe('live');
    expect(describeFreshness({ asOf: '2026-10-15T10:00:00Z', lagSeconds: STALE_AFTER_SECONDS + 1 }).state).toBe('stale');
  });

  it('a page is only as fresh as its stalest read', () => {
    expect(
      stalestFreshness([
        { asOf: '2026-10-15T10:00:00Z', lagSeconds: 2 },
        { asOf: '2026-10-15T09:00:00Z', lagSeconds: 90 },
      ]),
    ).toEqual({ asOf: '2026-10-15T09:00:00Z', lagSeconds: 90 });
    expect(
      stalestFreshness([
        { asOf: '2026-10-15T10:00:00Z', lagSeconds: 2 },
        { asOf: null, lagSeconds: null },
      ]),
    ).toEqual({ asOf: null, lagSeconds: null });
    expect(stalestFreshness([])).toEqual({ asOf: null, lagSeconds: null });
  });
});
