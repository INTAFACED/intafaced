import { describe, expect, it } from 'vitest';
import { clockTime, dayTime } from './clock';

// 2026-10-13 11:29:44 UTC
const AT = Date.UTC(2026, 9, 13, 11, 29, 44);

describe('clockTime (critic H6)', () => {
  it('names the zone when the person chose UTC or UTC+8, so "11:29" is never mistaken for local time', () => {
    expect(clockTime(AT, 'UTC')).toBe('11:29 UTC');
    expect(clockTime(AT, 'UTC+8')).toBe('19:29 UTC+8');
  });
  it('is the browser clock, with no suffix, on the device zone', () => {
    const local = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(AT);
    expect(clockTime(AT, 'device')).toBe(local);
  });
});

describe('dayTime', () => {
  it('shows the day and the time in the chosen zone, named when it is not the browser zone', () => {
    expect(dayTime('2026-10-13T11:29:44Z', 'UTC')).toMatch(/^13 Oct,? 11:29 UTC$/);
    expect(dayTime('2026-10-13T11:29:44Z', 'UTC+8')).toMatch(/^13 Oct,? 19:29 UTC\+8$/);
  });
  it('says nothing for a time it cannot read', () => {
    expect(dayTime('not a time', 'UTC')).toBeNull();
  });
});
