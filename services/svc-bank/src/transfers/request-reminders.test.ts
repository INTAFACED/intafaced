import { describe, expect, it } from 'vitest';
import { readRequestReminderPolicy } from './request-reminders.js';

describe('the owner reminder policy (PP-send-request-13, J-pay-05 #4)', () => {
  it('reads both keys together, and both blank as no policy', () => {
    expect(readRequestReminderPolicy('3600', '2')).toEqual({ spacingSeconds: 3600, cap: 2 });
    expect(readRequestReminderPolicy(undefined, undefined)).toBeNull();
    expect(readRequestReminderPolicy(' ', '')).toBeNull();
  });

  it('refuses one key without the other, and anything out of range or not whole', () => {
    expect(() => readRequestReminderPolicy('3600', undefined)).toThrow(/set together/);
    expect(() => readRequestReminderPolicy(undefined, '1')).toThrow(/set together/);
    expect(() => readRequestReminderPolicy('59', '1')).toThrow(/SPACING_SECONDS/);
    expect(() => readRequestReminderPolicy(String(30 * 86_400 + 1), '1')).toThrow(/SPACING_SECONDS/);
    expect(() => readRequestReminderPolicy('3600', '0')).toThrow(/CAP/);
    expect(() => readRequestReminderPolicy('3600', '21')).toThrow(/CAP/);
    expect(() => readRequestReminderPolicy('1.5', '1')).toThrow(/SPACING_SECONDS/);
    expect(() => readRequestReminderPolicy('3600', '-1')).toThrow(/CAP/);
  });
});
