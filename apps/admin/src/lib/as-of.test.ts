import { describe, expect, it } from 'vitest';
import { formatAsOf, formatWhen } from './as-of';

describe('founder desk times', () => {
  it('prints a read time as a clock with its zone, matching Trade ops', () => {
    expect(formatAsOf('2026-10-18T01:09:59.123Z')).toBe('01:09:59 UTC');
  });
  it('prints an event time with its date and zone, whatever the machine zone is', () => {
    expect(formatWhen('2026-10-15T10:02:03.000Z')).toBe('15 Oct 2026, 10:02:03 UTC');
    expect(formatWhen('2026-10-15T23:30:00+08:00')).toBe('15 Oct 2026, 15:30:00 UTC');
  });
  it('never shows raw text for something that is not a time', () => {
    expect(formatAsOf('not a time')).toBe('unknown time');
    expect(formatWhen(null)).toBe('unknown time');
    expect(formatWhen(undefined)).toBe('unknown time');
  });
});
