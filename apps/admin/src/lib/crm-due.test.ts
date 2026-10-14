import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { calendarDaysUntil, describeDue, overdueText } from './crm-due';

describe('due wording', () => {
  const zone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  const now = Date.parse('2026-10-15T10:00:00Z');
  const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

  it('counts local calendar days, so a task 26 hours late reads as one day, never as two or as "yesterday" plus "2 days"', () => {
    // The critic's case: one task, 26 hours in the past. It is yesterday, and 1 day overdue, everywhere.
    const due = describeDue(hoursAgo(26), now);
    expect(due).toEqual({ when: 'Due yesterday', overdue: '1 day overdue', overdueDays: 1 });
  });

  it('says the same thing for the same task wherever it is shown', () => {
    for (const hours of [1, 9, 11, 26, 49, 24 * 12]) {
      const due = describeDue(hoursAgo(hours), now);
      expect(overdueText(hoursAgo(hours), now)).toBe(due.overdue);
    }
  });

  it('words past dates by calendar day, with a date once it is further back than yesterday', () => {
    expect(describeDue('2026-10-15T08:00:00Z', now)).toEqual({ when: 'Due today', overdue: 'Overdue today', overdueDays: 0 });
    expect(describeDue('2026-10-14T23:59:00Z', now)).toMatchObject({ when: 'Due yesterday', overdue: '1 day overdue' });
    expect(describeDue('2026-10-13T09:00:00Z', now)).toEqual({ when: 'Due 13 Oct', overdue: '2 days overdue', overdueDays: 2 });
    expect(describeDue('2025-10-13T09:00:00Z', now).when).toBe('Due 13 Oct 2025');
  });

  it('words future dates by calendar day and has no overdue text', () => {
    expect(describeDue('2026-10-15T18:00:00Z', now)).toEqual({ when: 'Due today', overdue: null, overdueDays: 0 });
    expect(describeDue('2026-10-16T09:00:00Z', now)).toMatchObject({ when: 'Due tomorrow', overdue: null });
    expect(describeDue('2026-10-18T09:00:00Z', now).when).toBe('Due in 3 days');
    expect(describeDue('2026-10-30T09:00:00Z', now).when).toBe('Due 30 Oct');
    expect(overdueText('2026-10-16T09:00:00Z', now)).toBeNull();
  });

  it('formats long counts with the en-GB locale and survives an unreadable date', () => {
    const spy = vi.spyOn(Number.prototype, 'toLocaleString');
    try {
      expect(overdueText('2023-01-01T00:00:00Z', now)).toBe('1,383 days overdue');
      expect(spy).toHaveBeenCalledWith('en-GB');
    } finally {
      spy.mockRestore();
    }
    expect(describeDue('not a date', now)).toEqual({ when: '', overdue: null, overdueDays: 0 });
    expect(calendarDaysUntil('not a date', now)).toBeNull();
  });
});
