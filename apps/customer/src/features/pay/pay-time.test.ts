import { describe, expect, it } from 'vitest';
import { payTimeText } from './components';

const NOW = Date.parse('2026-10-18T04:00:00Z');

describe('payTimeText', () => {
  it('reads like the rest of the app: day, short month, 24-hour clock, and always names UTC', () => {
    expect(payTimeText('2026-10-17T21:43:08Z', 'en', NOW)).toBe('17 Oct, 21:43 UTC');
    expect(payTimeText('2026-10-17T21:43:08Z', 'en', NOW)).not.toMatch(/10\/17\/2026|PM/);
  });
  it('adds the year only for another year', () => {
    expect(payTimeText('2025-10-17T21:43:08Z', 'en', NOW)).toBe('17 Oct 2025, 21:43 UTC');
  });
  it('uses the shown language for the month', () => {
    expect(payTimeText('2026-10-17T21:43:08Z', 'es', NOW)).toContain('oct');
    expect(payTimeText('2026-10-17T21:43:08Z', 'fr', NOW)).toMatch(/oct\.?, 21:43 UTC$/);
  });
  it('an unreadable time is not formatted into a made-up one', () => {
    expect(payTimeText('yesterday', 'en', NOW)).toBeNull();
  });
});
