import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { crossCheckMids, type VenueMid } from './cross-check.js';

const NOW = new Date('2026-07-30T12:00:00Z');
const mid = (venueId: string, price: string, ageMs = 0): VenueMid => ({
  venueId,
  mid: parseAmount(price),
  observedAt: new Date(NOW.getTime() - ageMs),
});

describe('crossCheckMids — a non-finite age is excluded, not fresh', () => {
  it('excludes an Invalid Date observedAt as clock_skew and consensuses the three fresh mids', () => {
    const broken: VenueMid = {
      venueId: 'broken',
      mid: parseAmount('1000000'),
      observedAt: new Date(Number.NaN),
    };
    const report = crossCheckMids('BTC/USDT', [mid('a', '30000'), mid('b', '30001'), mid('c', '29999'), broken], { now: NOW });

    expect(report.excluded).toEqual([{ venueId: 'broken', reason: 'clock_skew' }]);
    expect(report.agreeing.map((entry) => entry.venueId)).not.toContain('broken');
    expect(report.diverged.map((entry) => entry.venueId)).not.toContain('broken');
    expect(report.agreeing.map((entry) => entry.venueId).sort()).toEqual(['a', 'b', 'c']);
    // Median of the three fresh mids. Including the bad mid would average to 30000.5.
    expect(formatAmount(report.consensusMid!)).toBe('30000');
    expect(report.verdict).toBe('consensus');
  });

  it('is inconclusive when now is Invalid Date — every observation is clock_skew and fresh is empty', () => {
    const report = crossCheckMids('BTC/USDT', [mid('a', '30000'), mid('b', '30001'), mid('c', '29999')], {
      now: new Date(Number.NaN),
    });

    expect(report.verdict).toBe('inconclusive');
    expect(report.consensusMid).toBeNull();
    expect(report.excluded).toEqual([
      { venueId: 'a', reason: 'clock_skew' },
      { venueId: 'b', reason: 'clock_skew' },
      { venueId: 'c', reason: 'clock_skew' },
    ]);
    expect(report.agreeing).toEqual([]);
    expect(report.diverged).toEqual([]);
    expect(report.detail).toContain('0 fresh');
  });

  it('still excludes a finite future timestamp as clock_skew', () => {
    const report = crossCheckMids('BTC/USDT', [mid('a', '30000'), mid('b', '30001'), mid('c', '29999'), mid('skewed', '30000', -60_000)], {
      now: NOW,
    });

    expect(report.excluded).toEqual([{ venueId: 'skewed', reason: 'clock_skew' }]);
    expect(report.agreeing.map((entry) => entry.venueId)).not.toContain('skewed');
    expect(report.verdict).toBe('consensus');
  });

  it('still excludes a finite age past maxAgeMs as stale', () => {
    const report = crossCheckMids('BTC/USDT', [mid('a', '30000'), mid('b', '30001'), mid('c', '29999'), mid('lagging', '30000', 30_000)], {
      now: NOW,
    });

    expect(report.excluded).toEqual([{ venueId: 'lagging', reason: 'stale' }]);
    expect(report.agreeing.map((entry) => entry.venueId)).not.toContain('lagging');
    expect(formatAmount(report.consensusMid!)).toBe('30000');
  });
});
