import { describe, expect, it } from 'vitest';
import { blankParts, canAccept, holdProgress, spreadPercent, validUntilClock } from './breakdown';

const good = { inAmount: '2608.05', outAmount: '1', convertSpreadBps: 20 };

describe('spreadPercent', () => {
  it('builds the percent with integer math', () => {
    expect(spreadPercent(20)).toBe('0.20%');
    expect(spreadPercent(5)).toBe('0.05%');
    expect(spreadPercent(0)).toBe('0.00%');
    expect(spreadPercent(125)).toBe('1.25%');
    expect(spreadPercent(10_000)).toBe('100.00%');
  });
  it('refuses anything that is not a whole, non-negative number', () => {
    for (const bad of [NaN, -1, 1.5, Infinity, null, undefined]) expect(spreadPercent(bad as number)).toBeNull();
  });
});

describe('canAccept (BEG-0009)', () => {
  it('accepts a complete quote, including a zero spread', () => {
    expect(canAccept(good)).toBe(true);
    expect(canAccept({ ...good, convertSpreadBps: 0 })).toBe(true);
  });
  it('refuses when pay, get or spread is blank or unreadable', () => {
    expect(canAccept({ ...good, inAmount: '' })).toBe(false);
    expect(canAccept({ ...good, inAmount: '  ' })).toBe(false);
    expect(canAccept({ ...good, outAmount: 'abc' })).toBe(false);
    expect(canAccept({ ...good, outAmount: null })).toBe(false);
    expect(canAccept({ ...good, convertSpreadBps: NaN })).toBe(false);
    expect(canAccept({ ...good, convertSpreadBps: undefined })).toBe(false);
    expect(canAccept(null)).toBe(false);
  });
  it('names what is missing', () => {
    expect(blankParts({ inAmount: '', outAmount: '', convertSpreadBps: null })).toEqual(['pay', 'get', 'spread']);
    expect(blankParts(good)).toEqual([]);
  });
});

describe('validUntilClock', () => {
  it('formats the expiry as a clock time in the given zone', () => {
    expect(validUntilClock('2026-10-17T10:00:15.000Z', { timeZone: 'UTC', locale: 'en-GB' })).toBe('10:00:15');
  });
  it('is null for an unreadable time', () => {
    expect(validUntilClock('not a time')).toBeNull();
  });
});

describe('holdProgress', () => {
  it('stays inside 0..max', () => {
    expect(holdProgress(10, 15_000)).toEqual({ now: 10, max: 15 });
    expect(holdProgress(99, 15_000)).toEqual({ now: 15, max: 15 });
    expect(holdProgress(null, 15_000)).toEqual({ now: 0, max: 15 });
    expect(holdProgress(3, 0)).toEqual({ now: 3, max: 15 });
  });
});
