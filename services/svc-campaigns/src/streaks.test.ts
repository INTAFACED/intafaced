import { describe, expect, it } from 'vitest';
import { localDay, streakOf, zoneMidnight } from './streaks.js';

const at = (iso: string) => new Date(iso);

describe('streak days in the platform time zone', () => {
  it('reads the calendar day and its midnight in the zone, across a daylight-saving change', () => {
    expect(localDay(at('2026-10-24T23:30:00Z'), 'UTC')).toBe('2026-10-24');
    expect(localDay(at('2026-10-24T23:30:00Z'), 'Europe/Berlin')).toBe('2026-10-25');
    expect(zoneMidnight('2026-10-25', 'UTC').toISOString()).toBe('2026-10-25T00:00:00.000Z');
    expect(zoneMidnight('2026-10-25', 'Europe/Berlin').toISOString()).toBe('2026-10-24T22:00:00.000Z');
    // Berlin leaves summer time on 25 Oct 2026: the next midnight is an hour later in UTC.
    expect(zoneMidnight('2026-10-26', 'Europe/Berlin').toISOString()).toBe('2026-10-25T23:00:00.000Z');
    // Santiago starts summer time at midnight (6 Sep 2026): 00:00 does not exist, the day starts at 01:00 (-03).
    expect(zoneMidnight('2026-09-06', 'America/Santiago').toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(zoneMidnight('2026-10-25', 'Asia/Kolkata').toISOString()).toBe('2026-10-24T18:30:00.000Z');
  });

  it('counts consecutive days, once a day, and resets after a missed day at the zone boundary', () => {
    const now = at('2026-10-24T12:00:00Z');
    expect(streakOf([], 'UTC', now)).toEqual({ days: 0, best: 0, lastRun: 0, lastDay: null, resetsAt: null });
    const two = [at('2026-10-23T09:00:00Z'), at('2026-10-24T08:00:00Z'), at('2026-10-24T10:00:00Z')];
    expect(streakOf(two, 'UTC', now)).toEqual({
      days: 2,
      best: 2,
      lastRun: 2,
      lastDay: '2026-10-24',
      resetsAt: at('2026-10-26T00:00:00Z'),
    });
    // Yesterday still keeps the run alive today; the day after, it reads 0.
    expect(streakOf([at('2026-10-23T09:00:00Z')], 'UTC', now).days).toBe(1);
    const missed = [at('2026-10-21T09:00:00Z'), at('2026-10-22T09:00:00Z')];
    expect(streakOf(missed, 'UTC', now)).toEqual({ days: 0, best: 2, lastRun: 2, lastDay: '2026-10-22', resetsAt: null });
    // A gap restarts the run.
    expect(streakOf([...missed, at('2026-10-24T09:00:00Z')], 'UTC', now)).toMatchObject({ days: 1, best: 2, lastRun: 1 });
    // The run a missed day broke is the last one, not the best.
    expect(streakOf([...missed, at('2026-10-20T09:00:00Z'), at('2026-10-22T09:00:00Z')], 'UTC', at('2026-10-26T12:00:00Z'))).toMatchObject({
      days: 0,
      best: 3,
      lastRun: 3,
    });
    const broke = [at('2026-10-15T09:00:00Z'), at('2026-10-16T09:00:00Z'), at('2026-10-17T09:00:00Z'), at('2026-10-20T09:00:00Z')];
    expect(streakOf(broke, 'UTC', now)).toMatchObject({ days: 0, best: 3, lastRun: 1 });
  });

  it('puts an event on the day of the zone, not of UTC', () => {
    // 23:30 UTC on the 23rd is the 24th in Berlin: two Berlin days in a row, one UTC day.
    const events = [at('2026-10-23T09:00:00Z'), at('2026-10-23T23:30:00Z')];
    expect(streakOf(events, 'UTC', at('2026-10-24T12:00:00Z')).best).toBe(1);
    expect(streakOf(events, 'Europe/Berlin', at('2026-10-24T12:00:00Z')).best).toBe(2);
  });
});
