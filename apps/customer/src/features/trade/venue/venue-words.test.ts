import { describe, expect, it } from 'vitest';
import { ianaZone } from './venue-words';

describe('ianaZone', () => {
  it('names a zone Intl accepts for every clock setting, so an "as of" line never falls back to a raw ISO time', () => {
    for (const zone of ['UTC', 'UTC+8', 'device'] as const) {
      expect(() => new Intl.DateTimeFormat('en-GB', { timeZone: ianaZone(zone), timeStyle: 'medium' }).format(new Date(0))).not.toThrow();
    }
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: ianaZone('UTC+8'), timeStyle: 'short' }).format(new Date(0))).toBe('08:00');
  });
});
