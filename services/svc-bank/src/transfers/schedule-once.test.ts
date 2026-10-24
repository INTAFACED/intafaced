import { describe, expect, it } from 'vitest';
import { dueOccurrence, lastOccurrenceBefore, occurrenceStart, planDue } from './schedule.js';

const startsAt = new Date('2026-11-02T09:00:00.000Z');

describe('a one-off payment is occurrence 0 on its date, and nothing after it', () => {
  it('is due only from its date, and its window is occurrence 0 whatever the end', () => {
    expect(occurrenceStart(startsAt, 'once', 0)).toEqual(startsAt);
    expect(() => occurrenceStart(startsAt, 'once', 1)).toThrow(RangeError);
    expect(dueOccurrence(startsAt, 'once', new Date('2026-11-02T08:59:59.999Z'))).toBeNull();
    expect(dueOccurrence(startsAt, 'once', startsAt)).toBe(0);
    expect(dueOccurrence(startsAt, 'once', new Date('2027-11-02T09:00:00.000Z'))).toBe(0);
    expect(lastOccurrenceBefore(startsAt, 'once', null)).toBe(0);
  });

  it('plans nothing before the date, one firing on it, and completes after it', () => {
    const before = planDue({ startsAt, cadence: 'once', endsAt: null, lastFired: null, now: new Date('2026-11-01T09:00:00.000Z') });
    expect(before).toEqual({ occurrences: [], nextRunAt: startsAt, completed: false });

    const on = planDue({ startsAt, cadence: 'once', endsAt: null, lastFired: null, now: new Date('2026-11-05T09:00:00.000Z') });
    expect(on).toEqual({ occurrences: [0], nextRunAt: startsAt, completed: true });

    const after = planDue({ startsAt, cadence: 'once', endsAt: null, lastFired: 0, now: new Date('2026-12-05T09:00:00.000Z') });
    expect(after).toEqual({ occurrences: [], nextRunAt: startsAt, completed: true });
  });
});
