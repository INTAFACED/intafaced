import { describe, expect, it } from 'vitest';
import { DAY, MINUTE, dayStart, dayTurnWait } from './clock.mjs';

describe('dayTurnWait', () => {
  const need = 15 * MINUTE;

  it('waits nothing when the UTC day has the whole window left', () => {
    expect(dayTurnWait(Date.parse('2026-11-27T12:00:00Z'), need)).toBe(0);
    expect(dayTurnWait(Date.parse('2026-11-27T23:45:00Z'), need)).toBe(0);
  });

  it('waits into the next UTC day when the window would cross midnight (J-ops-console-07 #9 at 23:58:37Z, run 46083906028)', () => {
    const at = Date.parse('2026-11-27T23:58:37.364Z');
    const wait = dayTurnWait(at, need);
    expect(wait).toBeGreaterThan(0);
    const resumed = at + wait;
    expect(dayStart(resumed)).toBe(Date.parse('2026-11-28T00:00:00Z'));
    // Once resumed, the whole window falls in the new day, so no second wait.
    expect(dayTurnWait(resumed, need)).toBe(0);
    expect(dayStart(resumed + need)).toBe(dayStart(resumed));
  });

  it('never waits longer than the window plus the settle, and accepts a Date', () => {
    const at = new Date(Date.parse('2026-11-28T00:00:00Z') - 1);
    const wait = dayTurnWait(at, need);
    expect(wait).toBe(1 + 5_000);
    expect(wait).toBeLessThan(need + 5_000 + 1);
    expect(dayTurnWait(Date.parse('2026-11-28T00:00:00Z'), DAY)).toBe(0);
  });
});
