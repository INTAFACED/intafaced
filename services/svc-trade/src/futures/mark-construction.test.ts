import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import {
  constructMark,
  indexPlusBasis,
  markSourceWithConstruction,
  medianOfThree,
  parseMarkConstruction,
  type MarkConstructionInputs,
} from './mark-construction.js';
import type { MarkSource } from './liquidation-tick.js';

// TEST figures only.
const AT = new Date('2026-10-20T12:00:00.000Z');
const inputs = (over: Partial<MarkConstructionInputs> = {}): MarkConstructionInputs => ({
  index: amt('100'),
  basis: amt('0.5'),
  mid: amt('101'),
  last: amt('99'),
  observedAt: AT,
  ...over,
});

describe('mark constructions', () => {
  it("blank selection is null and keeps today's source object", () => {
    expect(parseMarkConstruction(undefined)).toBeNull();
    expect(parseMarkConstruction('  ')).toBeNull();
    const base: MarkSource = { markPrice: async () => '1' };
    expect(markSourceWithConstruction(base, null, async () => null)).toBe(base);
  });

  it('refuses an unknown selection rather than falling back', () => {
    expect(() => parseMarkConstruction('ema_of_nothing')).toThrow(/must be one of/);
  });

  it('index plus basis adds a signed basis', () => {
    expect(formatAmount(indexPlusBasis(amt('100'), amt('0.5'))!)).toBe('100.5');
    expect(formatAmount(indexPlusBasis(amt('100'), amt('-0.5'))!)).toBe('99.5');
    expect(indexPlusBasis(amt('1'), amt('-1'))).toBeNull();
  });

  it('median of three is the middle in any order', () => {
    const [a, b, c] = [amt('3'), amt('1'), amt('2')];
    expect(formatAmount(medianOfThree(a, b, c))).toBe('2');
    expect(formatAmount(medianOfThree(c, a, b))).toBe('2');
    expect(formatAmount(medianOfThree(amt('5'), amt('5'), amt('1')))).toBe('5');
  });

  it('constructs each selection from its inputs', () => {
    expect(formatAmount(constructMark('index_plus_basis', inputs())!)).toBe('100.5');
    // median(100.5, 101, 99) = 100.5
    expect(formatAmount(constructMark('median_of_three', inputs())!)).toBe('100.5');
    // a wild last print cannot move the median of three
    expect(formatAmount(constructMark('median_of_three', inputs({ last: amt('1000000') }))!)).toBe('101');
  });

  it('a missing input is null, never zero', () => {
    expect(constructMark('index_plus_basis', inputs({ index: null }))).toBeNull();
    expect(constructMark('index_plus_basis', inputs({ basis: null }))).toBeNull();
    expect(constructMark('median_of_three', inputs({ last: null }))).toBeNull();
    expect(constructMark('median_of_three', inputs({ mid: null }))).toBeNull();
  });

  it('a selected construction answers through the quote port with index quality and the oldest observation time', async () => {
    const base: MarkSource = { markPrice: async () => '1' };
    const source = markSourceWithConstruction(base, 'index_plus_basis', async () => inputs());
    const quote = await source.quote!({ marketId: 'm1', at: AT });
    expect(quote).toMatchObject({ marketId: 'm1', quality: 'index' });
    expect(quote!.asOf).toEqual(AT);
    expect(await source.markPrice({ marketId: 'm1', at: AT })).toBe('100.5');
    const none = markSourceWithConstruction(base, 'index_plus_basis', async () => null);
    expect(await none.markPrice({ marketId: 'm1', at: AT })).toBeNull();
  });
});
