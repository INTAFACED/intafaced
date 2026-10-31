import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { vestedAmount, vestedShare } from './vesting.js';

/** ENGINE LC-7 linear vesting with a cliff. Every figure is TEST. */
const schedule = {
  startAt: new Date('2026-12-01T00:00:00Z'),
  cliffAt: null,
  endAt: new Date('2026-12-04T00:00:00Z'),
};
const at = (iso: string) => new Date(iso);

describe('vested share', () => {
  it('is zero before the start, linear between, everything from the end on', () => {
    expect(vestedShare(schedule, at('2026-11-30T23:59:59Z'))).toEqual({ phase: 'before_start', share: 0n });
    expect(vestedShare(schedule, at('2026-12-01T00:00:00Z'))).toEqual({ phase: 'vesting', share: 0n });
    expect(formatAmount(vestedShare(schedule, at('2026-12-02T12:00:00Z')).share)).toBe('0.5');
    expect(vestedShare(schedule, at('2026-12-04T00:00:00Z'))).toEqual({ phase: 'vested', share: amt('1') });
    expect(vestedShare(schedule, at('2027-01-01T00:00:00Z'))).toEqual({ phase: 'vested', share: amt('1') });
  });

  it('floors a share that does not divide evenly', () => {
    // One day of three: 1/3, floored at 18 places.
    expect(formatAmount(vestedShare(schedule, at('2026-12-02T00:00:00Z')).share)).toBe('0.333333333333333333');
  });

  it('vests nothing before the cliff, then what accrued from the start', () => {
    const cliffed = { ...schedule, cliffAt: at('2026-12-03T00:00:00Z') };
    expect(vestedShare(cliffed, at('2026-12-02T23:59:59Z'))).toEqual({ phase: 'before_cliff', share: 0n });
    expect(formatAmount(vestedShare(cliffed, at('2026-12-03T00:00:00Z')).share)).toBe('0.666666666666666666');
  });
});

describe('vested amount', () => {
  it('is half of an allocation halfway through, floored; the rest stays unreleased', () => {
    const half = vestedShare(schedule, at('2026-12-02T12:00:00Z')).share;
    expect(formatAmount(vestedAmount(amt('1001'), half))).toBe('500.5');
    const third = vestedShare(schedule, at('2026-12-02T00:00:00Z')).share;
    const allocation = amt('0.000000000000000002');
    expect(vestedAmount(allocation, third)).toBe(0n);
    expect(vestedAmount(allocation, amt('1'))).toBe(allocation);
  });
});
