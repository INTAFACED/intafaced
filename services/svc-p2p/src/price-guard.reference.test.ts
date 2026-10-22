import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { evaluateFixedOfferPrice, parsePriceGuardPolicy } from './price-guard.js';

/** P-ads-merchant-03 review MINOR: a non-positive mark is a feed fault, refused typed. */
describe('evaluateFixedOfferPrice — non-positive reference', () => {
  const policy = parsePriceGuardPolicy({ maxDeviationBps: 500 });
  it('zero reference throws p2p.reference_price_invalid', () => {
    expect(() => evaluateFixedOfferPrice({ price: parseAmount('1'), policy, referencePrice: 0n })).toThrow(
      expect.objectContaining({ code: 'p2p.reference_price_invalid' }),
    );
  });
  it('negative reference throws p2p.reference_price_invalid', () => {
    expect(() => evaluateFixedOfferPrice({ price: parseAmount('1'), policy, referencePrice: -1n })).toThrow(
      expect.objectContaining({ code: 'p2p.reference_price_invalid' }),
    );
  });
  it('missing reference still passes on bounds (spec)', () => {
    expect(evaluateFixedOfferPrice({ price: parseAmount('1'), policy, referencePrice: null })).toEqual({ ok: true, checked: 'bounds' });
    expect(evaluateFixedOfferPrice({ price: parseAmount('1'), policy })).toEqual({ ok: true, checked: 'bounds' });
  });
});
