import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { PricingError, assertWithinBounds, effectivePrice, minorUnitQuantum, partiesFor, quantiseFiat, quote } from './pricing.js';

/**
 * Pricing is pure, so it is tested exhaustively without a database.
 *
 * The theme: fiat is money. Every assertion here is one a `number` would have
 * failed, or one where "it rounded somewhere" is the difference between a
 * payment a bank will move and a payment a counterparty can refuse.
 */

describe('minor units come from the fiat registry, not from this service', () => {
  it('knows a two-decimal currency', () => {
    expect(formatAmount(minorUnitQuantum('USD'))).toBe('0.01');
  });

  it('knows a zero-decimal currency', () => {
    expect(formatAmount(minorUnitQuantum('JPY'))).toBe('1');
    expect(formatAmount(minorUnitQuantum('KRW'))).toBe('1');
  });

  it('knows a three-decimal currency', () => {
    expect(formatAmount(minorUnitQuantum('KWD'))).toBe('0.001');
    expect(formatAmount(minorUnitQuantum('BHD'))).toBe('0.001');
  });

  it('is case-insensitive on the code', () => {
    expect(minorUnitQuantum('usd')).toBe(minorUnitQuantum('USD'));
  });

  it('refuses a currency that is not in the registry', () => {
    expect(() => minorUnitQuantum('XYZ')).toThrow(PricingError);
  });
});

describe('quantiseFiat', () => {
  it('rounds to cents half-up', () => {
    expect(formatAmount(quantiseFiat(amt('10.005'), 'USD'))).toBe('10.01');
    expect(formatAmount(quantiseFiat(amt('10.004'), 'USD'))).toBe('10');
  });

  it('rounds a zero-decimal currency to whole units', () => {
    expect(formatAmount(quantiseFiat(amt('1234.6'), 'JPY'))).toBe('1235');
    expect(formatAmount(quantiseFiat(amt('1234.4'), 'JPY'))).toBe('1234');
  });

  it('rounds a three-decimal currency to fils', () => {
    expect(formatAmount(quantiseFiat(amt('3.14159'), 'KWD'))).toBe('3.142');
  });

  it('leaves an already-quantised amount untouched', () => {
    expect(formatAmount(quantiseFiat(amt('99.99'), 'USD'))).toBe('99.99');
  });

  it('honours an explicit rounding mode', () => {
    expect(formatAmount(quantiseFiat(amt('10.001'), 'USD', 'ceil'))).toBe('10.01');
    expect(formatAmount(quantiseFiat(amt('10.009'), 'USD', 'floor'))).toBe('10');
  });
});

describe('effectivePrice', () => {
  it('uses a fixed offer’s own price', () => {
    expect(formatAmount(effectivePrice({ priceType: 'fixed', price: amt('1.03') }))).toBe('1.03');
  });

  it('ignores a reference price on a fixed offer', () => {
    expect(formatAmount(effectivePrice({ priceType: 'fixed', price: amt('1.03'), referencePrice: amt('99') }))).toBe('1.03');
  });

  it('applies a floating margin to the reference', () => {
    // 2% over a 1.00 mark.
    expect(formatAmount(effectivePrice({ priceType: 'float', price: amt('1.02'), referencePrice: amt('1') }))).toBe('1.02');
    expect(formatAmount(effectivePrice({ priceType: 'float', price: amt('0.98'), referencePrice: amt('50000') }))).toBe('49000');
  });

  it('REFUSES a floating offer with no reference rather than inventing one', () => {
    expect(() => effectivePrice({ priceType: 'float', price: amt('1.02') })).toThrow(/refusing to take rather than invent one/);
    expect(() => effectivePrice({ priceType: 'float', price: amt('1.02'), referencePrice: null })).toThrow(
      /refusing to take rather than invent one/,
    );
    expect(() => effectivePrice({ priceType: 'float', price: amt('1.02'), referencePrice: null })).toThrow(PricingError);
  });

  it('refuses a zero or negative reference', () => {
    expect(() => effectivePrice({ priceType: 'float', price: amt('1'), referencePrice: 0n })).toThrow(PricingError);
  });

  it('refuses a non-positive offer price', () => {
    expect(() => effectivePrice({ priceType: 'fixed', price: 0n })).toThrow(PricingError);
  });
});

describe('assertWithinBounds — every rejection happens before any lock', () => {
  const bounds = { minAmt: amt('10'), maxAmt: amt('500'), remainingAmt: amt('500') };

  it('accepts an amount inside the bounds', () => {
    expect(() => assertWithinBounds(amt('100'), bounds)).not.toThrow();
  });

  it('accepts exactly the minimum and exactly the maximum', () => {
    expect(() => assertWithinBounds(amt('10'), bounds)).not.toThrow();
    expect(() => assertWithinBounds(amt('500'), bounds)).not.toThrow();
  });

  it('rejects below the minimum', () => {
    expect(() => assertWithinBounds(amt('9.999999999999999999'), bounds)).toThrow(/below the offer minimum/);
  });

  it('rejects above the maximum', () => {
    expect(() => assertWithinBounds(amt('500.000000000000000001'), bounds)).toThrow(/above the offer maximum/);
  });

  it('rejects more than the offer has left, even when inside the per-trade bounds', () => {
    expect(() => assertWithinBounds(amt('400'), { ...bounds, remainingAmt: amt('300') })).toThrow(/Offer has 300 remaining/);
  });

  it('rejects zero and negative amounts', () => {
    expect(() => assertWithinBounds(0n, bounds)).toThrow(PricingError);
    expect(() => assertWithinBounds(-1n, bounds)).toThrow(PricingError);
  });

  it('reports the specific rule that was broken, not just "invalid"', () => {
    expect(() => assertWithinBounds(amt('1'), bounds)).toThrow(expect.objectContaining({ code: 'p2p.amount_below_min' }));
    expect(() => assertWithinBounds(amt('9999'), bounds)).toThrow(expect.objectContaining({ code: 'p2p.amount_above_max' }));
    expect(() => assertWithinBounds(amt('400'), { ...bounds, remainingAmt: amt('10') })).toThrow(
      expect.objectContaining({ code: 'p2p.insufficient_offer_liquidity' }),
    );
  });
});

describe('quote', () => {
  it('prices a fixed offer and quantises the fiat leg', () => {
    const q = quote({ amount: amt('123.456789'), priceType: 'fixed', price: amt('0.97'), fiatCurrency: 'EUR' });
    // 123.456789 × 0.97 = 119.75308533 → €119.75
    expect(formatAmount(q.fiatAmount)).toBe('119.75');
    expect(formatAmount(q.price)).toBe('0.97');
    expect(formatAmount(q.amount)).toBe('123.456789');
  });

  it('quantises a zero-decimal currency to whole units', () => {
    const q = quote({ amount: amt('1'), priceType: 'fixed', price: amt('157.348'), fiatCurrency: 'JPY' });
    expect(formatAmount(q.fiatAmount)).toBe('157');
  });

  it('prices a floating offer off the reference', () => {
    const q = quote({
      amount: amt('2'),
      priceType: 'float',
      price: amt('1.05'),
      referencePrice: amt('1000'),
      fiatCurrency: 'USD',
    });
    expect(formatAmount(q.price)).toBe('1050');
    expect(formatAmount(q.fiatAmount)).toBe('2100');
  });

  it('refuses a currency that is not enabled in the registry', () => {
    // HRK is present but disabled — the registry decides what we serve.
    expect(() => quote({ amount: amt('10'), priceType: 'fixed', price: amt('1'), fiatCurrency: 'HRK' })).toThrow(
      expect.objectContaining({ code: 'p2p.unsupported_fiat' }),
    );
  });

  it('refuses a trade that rounds to zero fiat', () => {
    // The buyer would owe nothing while the seller escrows something — a trade
    // with no adjudicable outcome.
    expect(() => quote({ amount: amt('0.000000000000000001'), priceType: 'fixed', price: amt('0.0001'), fiatCurrency: 'USD' })).toThrow(
      /rounds to zero USD/,
    );
  });

  it('is exact at 18 decimal places — the case a float loses', () => {
    const q = quote({
      amount: amt('0.1'),
      priceType: 'fixed',
      price: amt('0.2'),
      fiatCurrency: 'KWD',
    });
    // 0.1 × 0.2 = 0.02 exactly, which 0.1 + 0.2 in binary floating point is not.
    expect(formatAmount(q.fiatAmount)).toBe('0.02');
  });
});

describe('partiesFor — who escrows', () => {
  it('a sell offer escrows the maker', () => {
    expect(partiesFor('sell', 'maker', 'taker')).toEqual({ sellerId: 'maker', buyerId: 'taker' });
  });

  it('a buy offer escrows the taker', () => {
    // The maker wants to BUY crypto, so the taker is the one supplying it.
    expect(partiesFor('buy', 'maker', 'taker')).toEqual({ sellerId: 'taker', buyerId: 'maker' });
  });
});
