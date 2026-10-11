import { describe, expect, it } from 'vitest';
import { outreachInactivityDeadline } from './retention-calendar.js';

describe('approved six-calendar-month outreach inactivity deadline in UTC', () => {
  it.each([
    ['2024-08-31T23:45:02.007Z', '2025-02-28T23:45:02.007Z'],
    ['2023-08-31T09:15:00.000Z', '2024-02-29T09:15:00.000Z'],
    ['2024-02-29T09:15:00.000Z', '2024-08-29T09:15:00.000Z'],
    ['2024-03-01T00:00:00.000Z', '2024-09-01T00:00:00.000Z'],
    ['2025-10-26T02:30:00+02:00', '2026-04-26T00:30:00.000Z'],
    ['2025-10-26T02:30:00+01:00', '2026-04-26T01:30:00.000Z'],
    ['2025-03-30T03:30:00+02:00', '2025-09-30T01:30:00.000Z'],
  ])('uses calendar month clamp and the actual UTC instant: %s', (lastContact, expected) => {
    expect(outreachInactivityDeadline(new Date(lastContact)).toISOString()).toBe(expected);
  });

  it('refuses an invalid clock rather than treating unknown age as eligible', () => {
    expect(() => outreachInactivityDeadline(new Date('invalid'))).toThrowError(
      expect.objectContaining({ code: 'ops.crm.retention_clock_invalid' }),
    );
  });
});
