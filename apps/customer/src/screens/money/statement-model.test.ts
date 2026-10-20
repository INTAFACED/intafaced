import { describe, expect, it } from 'vitest';
import { decodeBase64, lastFullMonth, monthIsOver, monthRange, shortFingerprint } from './statement-model';

describe('monthRange', () => {
  it('spans the first to the last millisecond of the month in UTC', () => {
    expect(monthRange('2026-10')).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01T00:00:00.000Z', to: '2028-02-29T23:59:59.999Z' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01T00:00:00.000Z', to: '2026-12-31T23:59:59.999Z' });
  });
  it('refuses anything that is not a month', () => {
    for (const bad of ['', '2026-13', '2026-00', '2026-1', 'October', '2026-10-01']) expect(monthRange(bad)).toBeNull();
  });
});

describe('lastFullMonth and monthIsOver', () => {
  it('steps back one month, across a year', () => {
    expect(lastFullMonth(new Date('2026-10-20T02:00:00Z'))).toBe('2026-09');
    expect(lastFullMonth(new Date('2026-01-03T00:00:00Z'))).toBe('2025-12');
  });
  it('calls only a finished month over', () => {
    const now = new Date('2026-10-20T02:00:00Z');
    expect(monthIsOver('2026-09', now)).toBe(true);
    expect(monthIsOver('2026-10', now)).toBe(false);
    expect(monthIsOver('2026-11', now)).toBe(false);
  });
});

describe('decodeBase64 and shortFingerprint', () => {
  it('decodes bytes and refuses junk', () => {
    expect(Array.from(decodeBase64('aGk=') ?? [])).toEqual([104, 105]);
    expect(decodeBase64('***')).toBeNull();
  });
  it('groups the start of a hash', () => {
    expect(shortFingerprint('abcdef0123456789')).toBe('abcd ef01 2345');
  });
});
