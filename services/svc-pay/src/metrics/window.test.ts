import { describe, expect, it } from 'vitest';
import { MAX_WINDOW_DAYS, resolveRange, resolveWindow } from './window.js';

const now = new Date('2026-10-15T23:59:59.999Z');

describe('metrics windows are whole UTC day buckets', () => {
  it('presets end with today and are counted in buckets', () => {
    expect(resolveWindow({ kind: 'preset', preset: 'today' }, now)).toEqual({ from: '2026-10-15', to: '2026-10-16' });
    expect(resolveWindow({ kind: 'preset', preset: 'rolling_7d' }, now)).toEqual({ from: '2026-10-09', to: '2026-10-16' });
    expect(resolveWindow({ kind: 'preset', preset: 'rolling_30d' }, now)).toEqual({ from: '2026-09-16', to: '2026-10-16' });
  });

  it('a range must sit on UTC midnights, in order, within the maximum span', () => {
    expect(resolveRange('2026-10-01T00:00:00Z', '2026-10-08T00:00:00.000Z')).toEqual({ from: '2026-10-01', to: '2026-10-08' });
    expect(() => resolveRange('2026-10-01T00:00:01Z', '2026-10-08T00:00:00Z')).toThrow(
      expect.objectContaining({ code: 'pay.metrics_window_unaligned' }),
    );
    // 08:00+08:00 is UTC midnight, so it is accepted; 00:00+08:00 is not.
    expect(resolveRange('2026-10-01T08:00:00+08:00', '2026-10-02T08:00:00+08:00')).toEqual({ from: '2026-10-01', to: '2026-10-02' });
    expect(() => resolveRange('2026-10-01T00:00:00+08:00', '2026-10-02T00:00:00+08:00')).toThrow(
      expect.objectContaining({ code: 'pay.metrics_window_unaligned' }),
    );
    expect(() => resolveRange('2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')).toThrow(
      expect.objectContaining({ code: 'pay.metrics_window_invalid' }),
    );
    expect(() => resolveRange('2025-10-13T00:00:00Z', '2026-10-15T00:00:00Z')).toThrow(
      expect.objectContaining({ code: 'pay.metrics_window_too_wide' }),
    );
    expect(MAX_WINDOW_DAYS).toBe(366);
  });
});
