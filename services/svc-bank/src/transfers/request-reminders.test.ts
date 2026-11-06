import { describe, expect, it } from 'vitest';
import { readRequestReminderTerms } from './request-reminders.js';

describe('the owner reminder terms (J-pay-05 #4)', () => {
  it('reads both keys together, and both blank as no terms', () => {
    expect(readRequestReminderTerms('3600', '1')).toEqual({ windowSeconds: 3600, cap: 1 });
    expect(readRequestReminderTerms(undefined, undefined)).toBeNull();
    expect(readRequestReminderTerms(' ', '')).toBeNull();
  });

  it('refuses one key without the other, and anything out of range or not whole', () => {
    expect(() => readRequestReminderTerms('3600', undefined)).toThrow(/set together/);
    expect(() => readRequestReminderTerms(undefined, '1')).toThrow(/set together/);
    expect(() => readRequestReminderTerms('59', '1')).toThrow(/WINDOW_SECONDS/);
    expect(() => readRequestReminderTerms(String(30 * 86_400 + 1), '1')).toThrow(/WINDOW_SECONDS/);
    expect(() => readRequestReminderTerms('3600', '0')).toThrow(/CAP/);
    expect(() => readRequestReminderTerms('3600', '21')).toThrow(/CAP/);
    expect(() => readRequestReminderTerms('1.5', '1')).toThrow(/WINDOW_SECONDS/);
    expect(() => readRequestReminderTerms('3600', '-1')).toThrow(/CAP/);
  });
});
