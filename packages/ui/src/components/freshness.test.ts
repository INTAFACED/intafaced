import { describe, expect, it } from 'vitest';
import { asOfIso, CLOCK_SKEW_TOLERANCE_MS, formatAsOf, freshnessOf, parseAsOf } from './freshness.js';

// TEST timestamps, fixed.
const NOW = Date.UTC(2026, 9, 17, 14, 5, 0); // 2026-10-17 14:05:00 UTC
const MIN = 60_000;

describe('parseAsOf', () => {
  it('reads ISO strings, epoch numbers and epoch digit strings', () => {
    expect(parseAsOf('2026-10-17T14:03:07Z')).toBe(Date.UTC(2026, 9, 17, 14, 3, 7));
    expect(parseAsOf(NOW)).toBe(NOW);
    expect(parseAsOf(String(NOW))).toBe(NOW);
  });
  it('returns null for missing or invalid input, never 0', () => {
    for (const bad of [null, undefined, '', '   ', 'not a date', Number.NaN, Infinity, 0, -5, '0']) {
      expect(parseAsOf(bad)).toBeNull();
    }
  });
});

describe('freshnessOf', () => {
  const base = { now: NOW, staleAfterMs: 5 * MIN };
  it('refused wins over everything', () => {
    expect(freshnessOf({ ...base, asOf: NOW, refused: true })).toBe('refused');
    expect(freshnessOf({ ...base, asOf: undefined, refused: true })).toBe('refused');
  });
  it('missing or invalid asOf is unknown', () => {
    expect(freshnessOf({ ...base, asOf: null })).toBe('unknown');
    expect(freshnessOf({ ...base, asOf: 'garbage' })).toBe('unknown');
  });
  it('exactly staleAfterMs old is live, one ms more is stale', () => {
    expect(freshnessOf({ ...base, asOf: NOW - 5 * MIN })).toBe('live');
    expect(freshnessOf({ ...base, asOf: NOW - 5 * MIN - 1 })).toBe('stale');
  });
  it('fresh data is live', () => {
    expect(freshnessOf({ ...base, asOf: NOW })).toBe('live');
    expect(freshnessOf({ ...base, asOf: new Date(NOW - 1000).toISOString() })).toBe('live');
  });
  it('a future asOf beyond the 5 s clock-skew tolerance is unknown; within it is live', () => {
    expect(CLOCK_SKEW_TOLERANCE_MS).toBe(5000);
    expect(freshnessOf({ ...base, asOf: NOW + 5000 })).toBe('live');
    expect(freshnessOf({ ...base, asOf: NOW + 5001 })).toBe('unknown');
  });
  it('cannot judge without a usable staleAfterMs or now: unknown', () => {
    expect(freshnessOf({ asOf: NOW, now: NOW, staleAfterMs: undefined })).toBe('unknown');
    expect(freshnessOf({ asOf: NOW, now: NOW, staleAfterMs: Number.NaN })).toBe('unknown');
    expect(freshnessOf({ asOf: NOW, now: Number.NaN, staleAfterMs: MIN })).toBe('unknown');
  });
  it('staleAfterMs of 0 means any age above 0 is stale', () => {
    expect(freshnessOf({ asOf: NOW, now: NOW, staleAfterMs: 0 })).toBe('live');
    expect(freshnessOf({ asOf: NOW - 1, now: NOW, staleAfterMs: 0 })).toBe('stale');
  });
});

describe('formatAsOf', () => {
  const opts = { timeZone: 'UTC', locale: 'en-GB' };
  it('prints 24 h time with seconds in the given zone', () => {
    expect(formatAsOf('2026-10-17T14:03:07Z', { ...opts, now: NOW })).toBe('14:03:07');
    expect(formatAsOf('2026-10-17T09:03:07Z', { ...opts, now: NOW })).toBe('09:03:07');
  });
  it('honours the time zone', () => {
    expect(formatAsOf('2026-10-17T14:03:07Z', { timeZone: 'Asia/Makassar', locale: 'en-GB', now: NOW })).toBe('22:03:07');
  });
  it('adds the date when not the same day as now', () => {
    const text = formatAsOf('2026-10-16T23:59:59Z', { ...opts, now: NOW });
    expect(text).toContain('16');
    expect(text).toContain('Oct');
    expect(text).toContain('23:59:59');
  });
  it('never adds the date when now is not given', () => {
    expect(formatAsOf('2026-10-01T10:00:00Z', opts)).toBe('10:00:00');
  });
  it('returns null for unusable input or time zone', () => {
    expect(formatAsOf(null, opts)).toBeNull();
    expect(formatAsOf('nope', opts)).toBeNull();
    expect(formatAsOf(NOW, { timeZone: 'Not/AZone' })).toBeNull();
  });
});

describe('asOfIso', () => {
  it('gives ISO text or null', () => {
    expect(asOfIso('2026-10-17T14:03:07Z')).toBe('2026-10-17T14:03:07.000Z');
    expect(asOfIso(undefined)).toBeNull();
  });
});
