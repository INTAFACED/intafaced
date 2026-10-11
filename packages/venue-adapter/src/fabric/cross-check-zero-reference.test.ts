import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { crossCheckMids, deviationInBps, type VenueMid } from './cross-check.js';

const NOW = new Date('2026-07-30T12:00:00Z');
const mid = (venueId: string, price: string, ageMs = 0): VenueMid => ({
  venueId,
  mid: parseAmount(price),
  observedAt: new Date(NOW.getTime() - ageMs),
});

describe('deviationInBps — a zero reference is not a price', () => {
  it('throws when the reference is zero and says a zero reference is not a price', () => {
    expect(() => deviationInBps(parseAmount('1'), 0n)).toThrow(/a zero reference is not a price/);
  });

  it('returns 0 when two equal non-zero prices agree', () => {
    expect(deviationInBps(parseAmount('30000'), parseAmount('30000'))).toBe(0);
  });

  it('returns 100 for a 100 bps distance above and below a real reference', () => {
    expect(deviationInBps(parseAmount('30300'), parseAmount('30000'))).toBe(100);
    expect(deviationInBps(parseAmount('29700'), parseAmount('30000'))).toBe(100);
  });

  it('crossCheckMids of three fresh positive mids returns a consensus and does not throw', () => {
    const report = crossCheckMids('BTC/USDT', [mid('a', '30000'), mid('b', '30001'), mid('c', '29999')], { now: NOW });

    expect(report.verdict).toBe('consensus');
    expect(formatAmount(report.consensusMid!)).toBe('30000');
    expect(report.diverged).toEqual([]);
    expect(report.agreeing).toHaveLength(3);
  });
});
