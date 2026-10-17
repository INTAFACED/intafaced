import { describe, expect, it } from 'vitest';
import { PERIOD_PRESETS, periodRange } from './periods';

const now = new Date('2026-10-17T05:30:00Z');

describe('spending windows', () => {
  it('has four presets', () => {
    expect([...PERIOD_PRESETS]).toEqual(['7d', '30d', 'month', 'lastMonth']);
  });
  it('counts back from now', () => {
    expect(periodRange('7d', now)).toEqual({ from: '2026-10-10T05:30:00.000Z', to: '2026-10-17T05:30:00.000Z' });
    expect(periodRange('30d', now).from).toBe('2026-09-17T05:30:00.000Z');
  });
  it('covers this month so far, and the whole of last month', () => {
    expect(periodRange('month', now)).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-17T05:30:00.000Z' });
    expect(periodRange('lastMonth', now)).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' });
  });
  it('rolls back over a year boundary', () => {
    expect(periodRange('lastMonth', new Date('2026-01-05T00:00:00Z'))).toEqual({
      from: '2025-12-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
    });
  });
  it('always starts before it ends', () => {
    for (const preset of PERIOD_PRESETS) {
      const { from, to } = periodRange(preset, now);
      expect(Date.parse(from)).toBeLessThan(Date.parse(to));
    }
  });
});
