import { describe, expect, it } from 'vitest';
import { timeLeft } from './time-left';

describe('timeLeft', () => {
  it('rounds up in the largest whole unit', () => {
    expect(timeLeft(0.2, 'en')).toBe('1 second');
    expect(timeLeft(59, 'en')).toBe('59 seconds');
    expect(timeLeft(61, 'en')).toBe('2 minutes');
    expect(timeLeft(3_601, 'en')).toBe('2 hours');
    expect(timeLeft(2 * 86_400, 'en')).toBe('2 days');
  });

  it('says a rounded-up hour as 1 hour, whichever second of it the page draws in (J-campaigns-03 #2)', () => {
    for (const s of [3_540.5, 3_541, 3_599.4, 3_599.9, 3_600]) expect(timeLeft(s, 'en')).toBe('1 hour');
    expect(timeLeft(3_540, 'en')).toBe('59 minutes');
  });

  it('carries the same way into minutes and days', () => {
    expect(timeLeft(59.5, 'en')).toBe('1 minute');
    expect(timeLeft(86_000, 'en')).toBe('1 day');
    expect(timeLeft(82_800, 'en')).toBe('23 hours');
  });
});
