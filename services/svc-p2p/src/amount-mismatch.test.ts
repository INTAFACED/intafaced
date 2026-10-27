import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { assertMismatchAmount, classifyMismatch, parseToleranceBps } from './amount-mismatch.js';

describe('amount mismatch band (P-trade-orders-20)', () => {
  it('is within at exactly the band and outside one minor unit past it, either way', () => {
    // 1 % of 100 EUR is 1 EUR.
    expect(classifyMismatch(amt('99'), amt('100'), 100)).toBe('within_tolerance');
    expect(classifyMismatch(amt('101'), amt('100'), 100)).toBe('within_tolerance');
    expect(classifyMismatch(amt('98.99'), amt('100'), 100)).toBe('outside_tolerance');
    expect(classifyMismatch(amt('101.01'), amt('100'), 100)).toBe('outside_tolerance');
  });

  it('a zero band holds only the exact amount, and a blank band classifies nothing', () => {
    expect(classifyMismatch(amt('99.99'), amt('100'), 0)).toBe('outside_tolerance');
    expect(classifyMismatch(amt('1'), amt('100'), null)).toBe('reported');
  });

  it('reads the owner value: blank, negative or past 100 % is unset', () => {
    expect(parseToleranceBps(null)).toBeNull();
    expect(parseToleranceBps(undefined)).toBeNull();
    expect(parseToleranceBps(-1)).toBeNull();
    expect(parseToleranceBps(10_001)).toBeNull();
    expect(parseToleranceBps(0)).toBe(0);
    expect(parseToleranceBps(10_000)).toBe(10_000);
  });

  it('refuses a received amount that contradicts the kind or is finer than the currency', () => {
    expect(() => assertMismatchAmount('under', amt('9.19'), amt('9.2'), 'EUR')).not.toThrow();
    expect(() => assertMismatchAmount('over', amt('9.21'), amt('9.2'), 'EUR')).not.toThrow();
    for (const [kind, received] of [
      ['under', '9.2'],
      ['partial', '9.3'],
      ['over', '9.2'],
      ['under', '9.191'],
      ['under', '0'],
    ] as const) {
      expect(() => assertMismatchAmount(kind, amt(received), amt('9.2'), 'EUR')).toThrow(
        expect.objectContaining({ code: 'p2p.invalid_amount' }),
      );
    }
  });
});
