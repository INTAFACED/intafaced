import { describe, expect, it } from 'vitest';
import { CADENCES, MAX_CATCH_UP_PER_PASS, dueOccurrence, lastOccurrenceBefore, occurrenceStart, planDue } from './schedule.js';

const utc = (y: number, m: number, d: number, h = 12) => new Date(Date.UTC(y, m - 1, d, h, 0, 0, 0));

describe('subscription schedule arithmetic (transplant from bank)', () => {
  it('exposes the three cadences and a catch-up bound', () => {
    expect([...CADENCES]).toEqual(['daily', 'weekly', 'monthly']);
    expect(MAX_CATCH_UP_PER_PASS).toBe(12);
  });

  it('computes daily and weekly from the anchor', () => {
    const start = utc(2026, 1, 1);
    expect(occurrenceStart(start, 'daily', 0).toISOString()).toBe(start.toISOString());
    expect(occurrenceStart(start, 'daily', 3).toISOString()).toBe(utc(2026, 1, 4).toISOString());
    expect(occurrenceStart(start, 'weekly', 2).toISOString()).toBe(utc(2026, 1, 15).toISOString());
  });

  /**
   * Load-bearing: monthly from anchor, not prev+1.
   * 31 Jan → Feb clamps to 28 → Mar returns to 31.
   */
  it('keeps monthly 31st after short months (anchor arithmetic)', () => {
    const start = utc(2026, 1, 31);
    expect(occurrenceStart(start, 'monthly', 0).getUTCDate()).toBe(31);
    expect(occurrenceStart(start, 'monthly', 1).getUTCDate()).toBe(28); // Feb 2026
    expect(occurrenceStart(start, 'monthly', 2).getUTCDate()).toBe(31); // Mar
  });

  it('refuses a non-integer occurrence', () => {
    expect(() => occurrenceStart(utc(2026, 1, 1), 'daily', -1)).toThrow(RangeError);
    expect(() => occurrenceStart(utc(2026, 1, 1), 'daily', 1.5)).toThrow(RangeError);
  });

  it('dueOccurrence is null before start and floors daily elapsed', () => {
    const start = utc(2026, 6, 10);
    expect(dueOccurrence(start, 'daily', utc(2026, 6, 9))).toBeNull();
    expect(dueOccurrence(start, 'daily', utc(2026, 6, 10))).toBe(0);
    expect(dueOccurrence(start, 'daily', utc(2026, 6, 13))).toBe(3);
  });

  it('planDue is empty before start and points nextRunAt at occurrence 0', () => {
    const start = utc(2026, 8, 1);
    const plan = planDue({
      startsAt: start,
      cadence: 'daily',
      endsAt: null,
      lastFired: null,
      now: utc(2026, 7, 1),
    });
    expect(plan.occurrences).toEqual([]);
    expect(plan.nextRunAt.toISOString()).toBe(start.toISOString());
    expect(plan.completed).toBe(false);
  });

  it('planDue fires from lastFired+1 and bounds catch-up', () => {
    const start = utc(2026, 1, 1);
    const plan = planDue({
      startsAt: start,
      cadence: 'daily',
      endsAt: null,
      lastFired: null,
      now: utc(2026, 1, 20),
      maxCatchUp: 5,
    });
    expect(plan.occurrences).toEqual([0, 1, 2, 3, 4]);
    expect(plan.completed).toBe(false);

    const next = planDue({
      startsAt: start,
      cadence: 'daily',
      endsAt: null,
      lastFired: 4,
      now: utc(2026, 1, 20),
      maxCatchUp: 5,
    });
    expect(next.occurrences).toEqual([5, 6, 7, 8, 9]);
  });

  it('planDue leaves an omitted endsAt open and does not emit for an inverted window', () => {
    const start = utc(2026, 1, 1);
    const now = utc(2026, 6, 1);

    const open = planDue({
      startsAt: start,
      cadence: 'daily',
      endsAt: null,
      lastFired: null,
      now,
      maxCatchUp: 3,
    });
    expect(open.occurrences).toEqual([0, 1, 2]);
    expect(open.completed).toBe(false);

    for (const cadence of CADENCES) {
      for (const endsAt of [start, utc(2025, 12, 1)]) {
        const plan = planDue({
          startsAt: start,
          cadence,
          endsAt,
          lastFired: null,
          now,
        });
        expect(plan.occurrences).toEqual([]);
        expect(plan.completed).toBe(true);
        expect(plan.nextRunAt.toISOString()).toBe(endsAt.toISOString());

        const later = planDue({
          startsAt: start,
          cadence,
          endsAt,
          lastFired: null,
          now: utc(2027, 1, 1),
        });
        expect(later.occurrences).toEqual([]);
        expect(later.completed).toBe(true);
      }
    }
  });

  it('planDue marks completed when past endsAt window', () => {
    const start = utc(2026, 1, 1);
    const endsAt = utc(2026, 1, 4); // occurrences 0..2 (end exclusive of end day in lastOccurrenceBefore)
    const windowEnd = lastOccurrenceBefore(start, 'daily', endsAt);
    expect(windowEnd).not.toBeNull();

    const plan = planDue({
      startsAt: start,
      cadence: 'daily',
      endsAt,
      lastFired: windowEnd,
      now: utc(2026, 2, 1),
    });
    expect(plan.occurrences).toEqual([]);
    expect(plan.completed).toBe(true);
  });

  it('default catch-up is MAX_CATCH_UP_PER_PASS', () => {
    const start = utc(2020, 1, 1);
    const plan = planDue({
      startsAt: start,
      cadence: 'daily',
      endsAt: null,
      lastFired: null,
      now: utc(2026, 1, 1),
    });
    expect(plan.occurrences).toHaveLength(MAX_CATCH_UP_PER_PASS);
  });
});
