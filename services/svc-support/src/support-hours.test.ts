import { describe, expect, it } from 'vitest';
import { supportHoursIntervalsProblem, supportHoursSetInputSchema, type SupportHours } from '@intafaced/contracts';
import { businessSeconds, isOpen, MemoryHoursBook, outOfHoursReplyFor, SupportHoursError } from './support-hours.js';

/** SP-sla-02 pure functions: the instant's own local date and zone decide, so daylight-saving days work. */

const hours = (over: Partial<SupportHours> = {}): SupportHours => ({
  timeZone: 'Europe/Berlin',
  intervals: [
    { day: 'mon', open: '09:00', close: '17:00', closesNextDay: false },
    { day: 'tue', open: '09:00', close: '17:00', closesNextDay: false },
  ],
  holidays: [],
  outOfHoursReply: 'We are closed and will reply when we open.',
  revision: 1,
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('isOpen', () => {
  it('holiday Monday noon -> closed', () => {
    // 2026-10-19 is a Monday; noon Berlin (CEST) is 10:00Z.
    const at = new Date('2026-10-19T10:00:00Z');
    expect(isOpen(hours(), at)).toBe(true);
    expect(isOpen(hours({ holidays: ['2026-10-19'] }), at)).toBe(false);
  });

  it('spring-forward day follows zone', () => {
    // 2026-03-30 Monday after the 2026-03-29 change: 09:00 Berlin is 07:00Z (CEST), not 08:00Z.
    expect(isOpen(hours(), new Date('2026-03-30T07:00:00Z'))).toBe(true);
    expect(isOpen(hours(), new Date('2026-03-30T06:59:00Z'))).toBe(false);
    // The Monday before (CET) opens at 08:00Z.
    expect(isOpen(hours(), new Date('2026-03-23T07:30:00Z'))).toBe(false);
    expect(isOpen(hours(), new Date('2026-03-23T08:00:00Z'))).toBe(true);
  });

  it('interval past midnight covers 01:00 next day', () => {
    const h = hours({ timeZone: 'UTC', intervals: [{ day: 'fri', open: '22:00', close: '02:00', closesNextDay: true }] });
    expect(isOpen(h, new Date('2026-10-23T23:00:00Z'))).toBe(true); // Friday 23:00
    expect(isOpen(h, new Date('2026-10-24T01:00:00Z'))).toBe(true); // Saturday 01:00
    expect(isOpen(h, new Date('2026-10-24T02:00:00Z'))).toBe(false);
    expect(isOpen(h, new Date('2026-10-23T21:59:00Z'))).toBe(false);
  });

  it('a Sunday interval past midnight wraps into Monday', () => {
    const h = hours({ timeZone: 'UTC', intervals: [{ day: 'sun', open: '23:00', close: '01:00', closesNextDay: true }] });
    expect(isOpen(h, new Date('2026-10-26T00:30:00Z'))).toBe(true); // Monday 00:30
  });

  it('refuses support.hours_unset while the zone or intervals are blank', () => {
    expect(() => isOpen(hours({ timeZone: null, intervals: [] }), new Date())).toThrow(SupportHoursError);
    expect(() => isOpen(hours({ intervals: [] }), new Date())).toThrow('support.hours_unset');
    expect(() => businessSeconds(hours({ timeZone: null }), new Date(0), new Date(1))).toThrow('support.hours_unset');
  });

  it('refuses support.timezone_unknown for a zone the runtime does not know', () => {
    expect(() => isOpen(hours({ timeZone: 'Mars/Olympus' }), new Date())).toThrow('support.timezone_unknown');
  });
});

describe('businessSeconds', () => {
  it('counts only open time across days, and 0 when to is not after from', () => {
    const h = hours({ timeZone: 'UTC' });
    // Mon 2026-10-19 16:00Z -> Tue 10:00Z = 1h Monday + 1h Tuesday.
    expect(businessSeconds(h, new Date('2026-10-19T16:00:00Z'), new Date('2026-10-20T10:00:00Z'))).toBe(7200);
    expect(businessSeconds(h, new Date('2026-10-20T10:00:00Z'), new Date('2026-10-19T16:00:00Z'))).toBe(0);
  });

  it('a holiday removes its whole local date', () => {
    const h = hours({ timeZone: 'UTC', holidays: ['2026-10-19'] });
    expect(businessSeconds(h, new Date('2026-10-19T00:00:00Z'), new Date('2026-10-21T00:00:00Z'))).toBe(8 * 3600);
  });

  it('a 01:00-04:00 span on a spring-forward night counts two real hours', () => {
    const h = hours({ intervals: [{ day: 'sun', open: '01:00', close: '04:00', closesNextDay: false }] });
    expect(businessSeconds(h, new Date('2026-03-28T00:00:00Z'), new Date('2026-03-30T00:00:00Z'))).toBe(2 * 3600);
  });

  it('an overnight span counts both sides of midnight', () => {
    const h = hours({ timeZone: 'UTC', intervals: [{ day: 'fri', open: '22:00', close: '02:00', closesNextDay: true }] });
    expect(businessSeconds(h, new Date('2026-10-23T00:00:00Z'), new Date('2026-10-25T00:00:00Z'))).toBe(4 * 3600);
  });

  it('refuses a range longer than the work guard', () => {
    expect(() => businessSeconds(hours(), new Date('2020-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))).toThrow(RangeError);
  });
});

describe('outOfHoursReplyFor', () => {
  it('sends the text only while closed, and nothing with blank text or blank hours', () => {
    const closed = new Date('2026-10-19T20:00:00Z');
    const open = new Date('2026-10-19T10:00:00Z');
    expect(outOfHoursReplyFor(hours(), closed)).toBe('We are closed and will reply when we open.');
    expect(outOfHoursReplyFor(hours(), open)).toBeNull();
    expect(outOfHoursReplyFor(hours({ outOfHoursReply: null }), closed)).toBeNull();
    expect(outOfHoursReplyFor(hours({ timeZone: null, intervals: [] }), closed)).toBeNull();
  });
});

describe('set input refusals', () => {
  const base = { timeZone: 'UTC', holidays: [], outOfHoursReply: null, expectedRevision: 0, reason: 'Owner set the hours' };
  const message = (input: unknown) => {
    const r = supportHoursSetInputSchema.safeParse(input);
    return r.success ? null : r.error.issues.map((i) => i.message);
  };

  it('support.hours_interval_invalid: open not before close, overlap, or longer than a day', () => {
    expect(message({ ...base, intervals: [{ day: 'mon', open: '17:00', close: '09:00' }] })).toContain('support.hours_interval_invalid');
    expect(
      message({
        ...base,
        intervals: [
          { day: 'mon', open: '09:00', close: '12:00' },
          { day: 'mon', open: '11:00', close: '13:00' },
        ],
      }),
    ).toContain('support.hours_interval_invalid');
    expect(supportHoursIntervalsProblem([{ day: 'mon', open: '09:00', close: '10:00', closesNextDay: true }])).toBe('longer_than_a_day');
    expect(
      supportHoursIntervalsProblem([
        { day: 'sun', open: '23:00', close: '02:00', closesNextDay: true },
        { day: 'mon', open: '01:00', close: '03:00', closesNextDay: false },
      ]),
    ).toBe('overlap');
  });

  it('several intervals per day are fine', () => {
    expect(
      message({
        ...base,
        intervals: [
          { day: 'mon', open: '09:00', close: '12:00' },
          { day: 'mon', open: '13:00', close: '17:00' },
        ],
      }),
    ).toBeNull();
  });

  it('support.timezone_unknown and support.hours_unset', () => {
    expect(message({ ...base, timeZone: 'Nowhere/Land', intervals: [] })).toContain('support.timezone_unknown');
    expect(message({ ...base, timeZone: null, intervals: [{ day: 'mon', open: '09:00', close: '10:00' }] })).toContain(
      'support.hours_unset',
    );
  });
});

describe('MemoryHoursBook', () => {
  const change = (over: Record<string, unknown> = {}) => ({
    value: { timeZone: 'UTC', intervals: [], holidays: [], outOfHoursReply: 'Closed' },
    expectedRevision: 0,
    by: 'lead-1',
    reason: 'Owner set the hours',
    at: '2026-10-20T00:00:00.000Z',
    ...over,
  });

  it('is blank until set, replays a lost reply and refuses a stale revision', async () => {
    const book = new MemoryHoursBook();
    expect(await book.get()).toMatchObject({ timeZone: null, intervals: [], revision: 0, updatedAt: null });
    const first = await book.set(change());
    expect(first.revision).toBe(1);
    expect(await book.set(change())).toEqual(first);
    await expect(book.set(change({ value: { ...change().value, outOfHoursReply: 'Other' } }))).rejects.toMatchObject({
      code: 'support.hours_revision_stale',
    });
    expect(book.log).toHaveLength(1);
  });
});
