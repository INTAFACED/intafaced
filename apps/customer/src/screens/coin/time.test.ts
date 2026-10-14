import { describe, expect, it } from 'vitest';
import { dayAndTime, updatedAt } from './time';

// 2026-10-13 11:01:12 UTC, which is 19:01 in UTC+8
const AT = Date.UTC(2026, 9, 13, 11, 1, 12);

describe('updatedAt: the footer under the chart', () => {
  it('names the picked zone and its offset', () => {
    expect(updatedAt(AT, 'UTC')).toBe('13 Oct 2026, 11:01 (UTC)');
    expect(updatedAt(AT, 'UTC+8')).toBe('13 Oct 2026, 19:01 (UTC+8)');
  });
  it('names the offset of the device zone too', () => {
    expect(updatedAt(AT, 'device')).toMatch(/^13 Oct 2026, \d{2}:\d{2} \(UTC([+-]\d{1,2}(:\d{2})?)?\)$/);
  });
});

describe('dayAndTime: the time under the crosshair', () => {
  it('is "13 Oct, 19:01" in the picked zone', () => {
    expect(dayAndTime(AT, 'UTC+8')).toBe('13 Oct, 19:01');
    expect(dayAndTime(AT, 'UTC')).toBe('13 Oct, 11:01');
  });
});
