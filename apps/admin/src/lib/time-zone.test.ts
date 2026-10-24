import { describe, expect, it } from 'vitest';
import { formatInZone, isoToZonedInput, zonedInputToIso } from './time-zone';

describe('times in a founder’s own time zone', () => {
  it('reads a typed wall clock in the zone, both sides of a clock change', () => {
    expect(zonedInputToIso('2026-10-24T12:00', 'Europe/Berlin')).toBe('2026-10-24T10:00:00.000Z');
    expect(zonedInputToIso('2026-10-26T12:00', 'Europe/Berlin')).toBe('2026-10-26T11:00:00.000Z');
    expect(zonedInputToIso('2026-10-24T12:00', 'UTC')).toBe('2026-10-24T12:00:00.000Z');
    expect(zonedInputToIso('2026-10-24T12:00', 'Asia/Kolkata')).toBe('2026-10-24T06:30:00.000Z');
  });

  it('round-trips an instant through the input', () => {
    for (const tz of ['Europe/Berlin', 'America/New_York', 'Asia/Dubai', 'UTC']) {
      const input = isoToZonedInput('2026-10-24T10:15:00.000Z', tz);
      expect(zonedInputToIso(input, tz)).toBe('2026-10-24T10:15:00.000Z');
    }
  });

  it('prints the zone with the time, and never the raw text of a bad value', () => {
    expect(formatInZone('2026-10-24T10:00:00.000Z', 'Europe/Berlin')).toBe('24 Oct 2026, 12:00 (Europe/Berlin)');
    expect(formatInZone('not a time', 'UTC')).toBe('unknown time');
    expect(zonedInputToIso('24/10/2026 12:00', 'UTC')).toBeNull();
    expect(zonedInputToIso('2026-10-24T12:00', 'Mars/Olympus')).toBeNull();
    expect(zonedInputToIso('2026-02-30T12:00', 'UTC')).toBeNull();
    expect(zonedInputToIso('2026-10-24T24:00', 'UTC')).toBeNull();
    expect(zonedInputToIso('2026-10-24T12:60', 'UTC')).toBeNull();
    // 02:30 on 29 March 2026 does not happen in Berlin: the clocks go from 02:00 to 03:00.
    expect(zonedInputToIso('2026-03-29T02:30', 'Europe/Berlin')).toBeNull();
  });
});
