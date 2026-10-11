import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { crossCheckMids, deviationInBps, median, type VenueMid } from './cross-check.js';

const NOW = new Date('2026-07-30T12:00:00Z');
const mid = (venueId: string, price: string, ageMs = 0): VenueMid => ({
  venueId,
  mid: parseAmount(price),
  observedAt: new Date(NOW.getTime() - ageMs),
});

describe('crossCheckMids — a venue disagreeing with every other is a signal, not a price', () => {
  it('reports consensus when everyone agrees', () => {
    const report = crossCheckMids('BTC/USDT', [mid('a', '30000'), mid('b', '30001'), mid('c', '29999'), mid('d', '30000.5')], { now: NOW });

    expect(report.verdict).toBe('consensus');
    expect(formatAmount(report.consensusMid!)).toBe('30000.25');
    expect(report.agreeing).toHaveLength(4);
    expect(report.diverged).toEqual([]);
  });

  it('flags the ONE venue that is wrong, not the four that are right', () => {
    // The mean would be dragged toward the outlier and the check would invert.
    const report = crossCheckMids('BTC/USDT', [mid('a', '30000'), mid('b', '30001'), mid('c', '29999'), mid('halted', '27000')], {
      now: NOW,
    });

    expect(report.verdict).toBe('divergence-detected');
    expect(report.diverged.map((d) => d.venueId)).toEqual(['halted']);
    expect(report.agreeing.map((d) => d.venueId).sort()).toEqual(['a', 'b', 'c']);
    expect(report.diverged[0]!.direction).toBe('below');
    expect(report.detail).toContain('halted');
  });

  it('survives a MAJORITY-adjacent outlier because the median ignores magnitude', () => {
    const report = crossCheckMids('BTC/USDT', [mid('a', '30000'), mid('b', '30000'), mid('mad', '300000')], { now: NOW });
    expect(formatAmount(report.consensusMid!)).toBe('30000');
    expect(report.diverged.map((d) => d.venueId)).toEqual(['mad']);
  });

  it('is INCONCLUSIVE on two venues — not a pass, and not a failure', () => {
    // Both are equidistant from their own midpoint. The arithmetic cannot say
    // which one is wrong, so saying "consensus" would be a lie.
    const report = crossCheckMids('BTC/USDT', [mid('a', '30000'), mid('b', '27000')], { now: NOW });

    expect(report.verdict).toBe('inconclusive');
    expect(report.consensusMid).toBeNull();
    expect(report.agreeing).toEqual([]);
    expect(report.diverged).toEqual([]);
    expect(report.detail).toContain('this is not a pass');
  });

  it('is inconclusive when staleness drops the venue count below the minimum', () => {
    const report = crossCheckMids('BTC/USDT', [mid('a', '30000'), mid('b', '30001'), mid('lagging', '30000', 30_000)], { now: NOW });

    expect(report.verdict).toBe('inconclusive');
    expect(report.excluded).toEqual([{ venueId: 'lagging', reason: 'stale' }]);
  });

  it('excludes a mid dated in the FUTURE as a broken clock, not as very fresh', () => {
    const report = crossCheckMids('BTC/USDT', [mid('a', '30000'), mid('b', '30001'), mid('c', '29999'), mid('skewed', '30000', -60_000)], {
      now: NOW,
    });
    expect(report.excluded).toEqual([{ venueId: 'skewed', reason: 'clock_skew' }]);
    expect(report.verdict).toBe('consensus');
  });

  it('excludes a venue with no mid rather than reading zero as a price', () => {
    const report = crossCheckMids('BTC/USDT', [mid('a', '30000'), mid('b', '30001'), mid('c', '29999'), mid('empty', '0')], { now: NOW });
    expect(report.excluded).toEqual([{ venueId: 'empty', reason: 'no_mid' }]);
    expect(report.verdict).toBe('consensus');
  });

  it('never substitutes — a diverged venue is reported, and no price is put in its place', () => {
    const report = crossCheckMids('BTC/USDT', [mid('a', '30000'), mid('b', '30001'), mid('c', '29999'), mid('bad', '40000')], { now: NOW });
    const reported = report.diverged[0]!;
    expect(reported.venueId).toBe('bad');
    // Its OWN mid travels with the exclusion. Nothing has been swapped in
    // under its name — that is the failure the honesty rule exists to forbid.
    expect(formatAmount(reported.mid)).toBe('40000');
    expect(report.agreeing.map((d) => d.venueId)).not.toContain('bad');
  });

  it('honours a wider tolerance for a genuinely wider market', () => {
    // c is ~66bps from the median of 30001 — outside the 50bps default, inside 100.
    const observations = [mid('a', '30000'), mid('b', '30001'), mid('c', '30200')];
    expect(crossCheckMids('X', observations, { now: NOW }).verdict).toBe('divergence-detected');
    expect(crossCheckMids('X', observations, { now: NOW, toleranceBps: 100 }).verdict).toBe('consensus');
  });

  it('reports zero venues honestly rather than throwing', () => {
    const report = crossCheckMids('BTC/USDT', [], { now: NOW });
    expect(report.verdict).toBe('inconclusive');
    expect(report.consensusMid).toBeNull();
  });

  it('is inconclusive on an empty book even when minVenues is 0 — 0 is not a mid', () => {
    const report = crossCheckMids('BTC/USDT', [], { minVenues: 0 });
    expect(report.verdict).toBe('inconclusive');
    expect(report.consensusMid).toBeNull();
  });
});

describe('median', () => {
  it('takes the middle of an odd count and the average of the two middles of an even one', () => {
    expect(formatAmount(median([parseAmount('3'), parseAmount('1'), parseAmount('2')]))).toBe('2');
    expect(formatAmount(median([parseAmount('4'), parseAmount('1'), parseAmount('2'), parseAmount('3')]))).toBe('2.5');
  });

  it('is unmoved by an outlier of any size — the entire reason it is not a mean', () => {
    const withOutlier = [parseAmount('30000'), parseAmount('30001'), parseAmount('30002'), parseAmount('1000000')];
    expect(formatAmount(median(withOutlier))).toBe('30001.5');
  });

  it('refuses an empty list rather than printing 0 as a mid', () => {
    expect(() => median([])).toThrow(/not a price/);
  });
});

describe('deviationInBps', () => {
  it('measures absolute distance in bps, in integer arithmetic', () => {
    expect(deviationInBps(parseAmount('30300'), parseAmount('30000'))).toBe(100);
    expect(deviationInBps(parseAmount('29700'), parseAmount('30000'))).toBe(100);
    expect(deviationInBps(parseAmount('30000'), parseAmount('30000'))).toBe(0);
  });

  it('refuses a zero reference rather than reporting agreement', () => {
    expect(() => deviationInBps(parseAmount('1'), 0n)).toThrow(/a zero reference is not a price/);
  });
});
