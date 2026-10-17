import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONVERSION_HOLD_SWEEP_MS,
  CONVERSION_LATE_FILL_BACKOFF_CAPS_MS,
  CONVERSION_LATE_FILL_HORIZON_MS,
  CONVERSION_LATE_FILL_TICK_MS,
  CONVERSION_LATE_FILL_VENUE_CALLS_PER_TICK,
  lateFillBackoffMs,
} from './late-fill-schedule.js';

describe('late-fill schedule', () => {
  it('keeps each backoff at or under its cap and agrees across replicas', () => {
    expect(CONVERSION_LATE_FILL_HORIZON_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(CONVERSION_LATE_FILL_TICK_MS).toBe(60_000);
    expect(CONVERSION_HOLD_SWEEP_MS).toBe(5 * 60 * 1000);
    expect(CONVERSION_LATE_FILL_VENUE_CALLS_PER_TICK).toBeGreaterThan(0);
    expect(CONVERSION_LATE_FILL_VENUE_CALLS_PER_TICK).toBeLessThan(50);
    const rowId = '11111111-1111-4111-8111-111111111111';
    for (let checks = 1; checks <= 6; checks++) {
      const cap = CONVERSION_LATE_FILL_BACKOFF_CAPS_MS[Math.min(checks, CONVERSION_LATE_FILL_BACKOFF_CAPS_MS.length) - 1]!;
      const delay = lateFillBackoffMs(rowId, checks);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(cap / 2));
      expect(delay).toBeLessThanOrEqual(cap);
      expect(lateFillBackoffMs(rowId, checks)).toBe(delay);
    }
  });

  it('starts the hold sweep on the 5-minute timer and keeps the founder trigger', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8');
    expect(src).toContain('CONVERSION_HOLD_SWEEP_MS');
    expect(src).toContain("sweepOrphanHolds('hold-sweep')");
    expect(src).toContain('CONVERSION_LATE_FILL_TICK_MS');
    expect(src).toContain('clearInterval(holdSweep)');
  });
});
