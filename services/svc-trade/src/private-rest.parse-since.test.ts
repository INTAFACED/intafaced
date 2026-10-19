import { describe, expect, it } from 'vitest';
import { parseSince } from './private-rest.js';

describe('parseSince', () => {
  it('reads absent, empty and ordinary millisecond timestamps', () => {
    expect(parseSince(undefined)).toEqual({ ok: true, sinceMs: undefined });
    expect(parseSince('')).toEqual({ ok: true, sinceMs: undefined });
    expect(parseSince('0')).toEqual({ ok: true, sinceMs: 0 });
    expect(parseSince('1700000000000.9')).toEqual({ ok: true, sinceMs: 1_700_000_000_000 });
  });

  it('refuses negative and non-numeric values', () => {
    for (const raw of ['-1', 'soon', 'Infinity', 'NaN']) expect(parseSince(raw).ok, raw).toBe(false);
  });

  it('refuses a value past the last time a Date can hold, instead of letting it reach the database as an invalid date', () => {
    // 8.64e15 ms is the last instant a JavaScript Date represents; one more is an Invalid Date.
    expect(parseSince('8640000000000000')).toEqual({ ok: true, sinceMs: 8_640_000_000_000_000 });
    for (const raw of ['8640000000000001', '1e300', '1e21']) expect(parseSince(raw).ok, raw).toBe(false);
  });
});
