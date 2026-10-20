import { describe, expect, it } from 'vitest';
import { averageScore, formatShare, ratingWindow, readRatingSummary } from './ratings';

const raw = (over: Record<string, unknown> = {}) => ({
  from: '2026-09-20T00:00:00.000Z',
  to: '2026-10-20T00:00:00.000Z',
  solved: 3,
  responses: 2,
  perScore: { '1': 0, '2': 0, '3': 0, '4': 2, '5': 0 },
  ratedShareBasisPoints: 6666,
  ...over,
});

describe('rating summary reader', () => {
  it('reads a well-formed summary', () => {
    expect(readRatingSummary(raw())).toMatchObject({ solved: 3, responses: 2, ratedShareBasisPoints: 6666 });
  });

  it('reads nothing solved with a null share', () => {
    const zero = raw({ solved: 0, responses: 0, perScore: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }, ratedShareBasisPoints: null });
    expect(readRatingSummary(zero)?.ratedShareBasisPoints).toBeNull();
  });

  it('refuses anything that does not add up, rather than showing it', () => {
    expect(readRatingSummary(null)).toBeNull();
    expect(readRatingSummary(raw({ responses: 3 }))).toBeNull();
    expect(readRatingSummary(raw({ responses: 4, solved: 3, perScore: { '1': 0, '2': 0, '3': 0, '4': 4, '5': 0 } }))).toBeNull();
    expect(readRatingSummary(raw({ perScore: { '1': 0, '2': 0, '3': 0, '4': 2 } }))).toBeNull();
    expect(readRatingSummary(raw({ perScore: { '1': 0, '2': 0, '3': 0, '4': 2.5, '5': 0 } }))).toBeNull();
    expect(readRatingSummary(raw({ ratedShareBasisPoints: 10_001 }))).toBeNull();
    expect(readRatingSummary(raw({ ratedShareBasisPoints: null }))).toBeNull();
    expect(readRatingSummary(raw({ from: 'nope' }))).toBeNull();
  });
});

describe('rating figures', () => {
  it('cuts a share to one decimal and shows a dash for none', () => {
    expect(formatShare(6666)).toBe('66.6%');
    expect(formatShare(10_000)).toBe('100%');
    expect(formatShare(null)).toBe('—');
  });

  it('shows an average only with responses', () => {
    const base = readRatingSummary(raw())!;
    expect(averageScore(base)).toBe('4.0');
    const mixed = readRatingSummary(raw({ responses: 2, perScore: { '1': 0, '2': 0, '3': 1, '4': 1, '5': 0 } }))!;
    expect(averageScore(mixed)).toBe('3.5');
    const none = readRatingSummary(
      raw({ solved: 0, responses: 0, perScore: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }, ratedShareBasisPoints: null }),
    )!;
    expect(averageScore(none)).toBeNull();
  });

  it('states a window that ends now and starts the picked days earlier', () => {
    const w = ratingWindow(7, new Date('2026-10-20T00:00:00.000Z'));
    expect(w).toEqual({ from: '2026-10-13T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z' });
  });
});
