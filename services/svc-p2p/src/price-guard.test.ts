import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { PriceGuardError, assertFixedOfferPrice, evaluateFixedOfferPrice, parsePriceGuardPolicy } from './price-guard.js';

const A = (s: string) => parseAmount(s);

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof PriceGuardError ? e.code : 'other';
  }
  return undefined;
}

describe('P-ads-merchant-03 fixed-price guard: policy save', () => {
  it('blank deviation threshold refuses admin save with p2p.config_unset', () => {
    expect(code(() => parsePriceGuardPolicy({}))).toBe('p2p.config_unset');
    expect(code(() => parsePriceGuardPolicy({ maxDeviationBps: '  ' }))).toBe('p2p.config_unset');
    expect(code(() => parsePriceGuardPolicy({ maxDeviationBps: null }))).toBe('p2p.config_unset');
  });
  it('rejects malformed values', () => {
    for (const v of ['0', '10001', '1.5', '-3', 'abc']) {
      expect(code(() => parsePriceGuardPolicy({ maxDeviationBps: v }))).toBe('p2p.invalid_amount');
    }
    expect(code(() => parsePriceGuardPolicy({ maxDeviationBps: 500, minPrice: '0' }))).toBe('p2p.invalid_amount');
    expect(code(() => parsePriceGuardPolicy({ maxDeviationBps: 500, minPrice: 'x' }))).toBe('p2p.invalid_amount');
    expect(code(() => parsePriceGuardPolicy({ maxDeviationBps: 500, minPrice: '10', maxPrice: '9' }))).toBe('p2p.invalid_amount');
  });
  it('parses a valid policy exactly', () => {
    expect(parsePriceGuardPolicy({ maxDeviationBps: '500', minPrice: '15000.50', maxPrice: '' })).toEqual({
      maxDeviationBps: 500,
      minPrice: A('15000.50'),
      maxPrice: null,
    });
  });
});

describe('P-ads-merchant-03 fixed-price guard: evaluate', () => {
  const policy = parsePriceGuardPolicy({ maxDeviationBps: 500, minPrice: '90', maxPrice: '120' });

  it('unset policy never hides or refuses an ad', () => {
    expect(evaluateFixedOfferPrice({ price: A('1'), policy: null, referencePrice: A('100') })).toEqual({
      ok: true,
      checked: 'unset',
    });
    expect(() => assertFixedOfferPrice({ price: A('999999'), policy: null })).not.toThrow();
  });
  it('no reference price: fixed ad still works (bounds only)', () => {
    expect(evaluateFixedOfferPrice({ price: A('110'), policy, referencePrice: null })).toEqual({
      ok: true,
      checked: 'bounds',
    });
  });
  it('min/max bounds refuse with price_out_of_range', () => {
    expect(evaluateFixedOfferPrice({ price: A('89.99'), policy })).toMatchObject({ ok: false, detail: 'below_min' });
    expect(evaluateFixedOfferPrice({ price: A('120.01'), policy })).toMatchObject({ ok: false, detail: 'above_max' });
    expect(code(() => assertFixedOfferPrice({ price: A('89.99'), policy }))).toBe('p2p.price_out_of_range');
  });
  it('deviation boundary is exact (5.00% allowed, 5.000000000000000001% refused)', () => {
    const ref = A('100');
    expect(evaluateFixedOfferPrice({ price: A('105'), policy, referencePrice: ref }).ok).toBe(true);
    expect(evaluateFixedOfferPrice({ price: A('95'), policy, referencePrice: ref }).ok).toBe(true);
    expect(evaluateFixedOfferPrice({ price: A('105.000000000000000001'), policy, referencePrice: ref })).toMatchObject({
      ok: false,
      detail: 'deviation',
    });
    expect(evaluateFixedOfferPrice({ price: A('94.999999999999999999'), policy, referencePrice: ref })).toMatchObject({
      ok: false,
      detail: 'deviation',
    });
  });
  it('non-positive price is invalid', () => {
    expect(code(() => evaluateFixedOfferPrice({ price: 0n, policy: null }))).toBe('p2p.invalid_amount');
  });
});
