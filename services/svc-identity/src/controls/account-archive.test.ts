import { describe, expect, it } from 'vitest';
import { parseDormancyDays } from './account-archive.js';

describe('the owner dormancy period for archive proposals', () => {
  it('is null when blank, whole days when set, and stops the service when malformed', () => {
    expect(parseDormancyDays(undefined)).toBeNull();
    expect(parseDormancyDays('  ')).toBeNull();
    expect(parseDormancyDays('365')).toBe(365);
    expect(parseDormancyDays('36500')).toBe(36500);
    for (const bad of ['0', '-1', '1.5', '36501', 'a year', '1e3', '0365'])
      expect(() => parseDormancyDays(bad), bad).toThrow(/IDENTITY_DORMANCY_DAYS/);
  });
});
