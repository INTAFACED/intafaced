import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import {
  FUTURES_PRICE_BAND_UNSET,
  SCALE,
  adverseDistance,
  adverseNumerator,
  fillMargin,
  fillWithinLimit,
  limitWithinBand,
  marginNeed,
  orderHoldAmount,
  parsePriceBand,
  priceBandAround,
  protectiveLimit,
  weightedEntry,
} from './matched-order-plan.js';

const A = (s: string) => parseAmount(s);

/** Deterministic pseudo-random bigints in [min, max], so a failure reproduces. */
function rng(seed: number) {
  let x = seed >>> 0;
  return (max: bigint): bigint => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return BigInt(x) % (max + 1n);
  };
}

describe('matched order plan: the owner band', () => {
  it('blank is unset, never a default', () => {
    expect(parsePriceBand('')).toBeNull();
    expect(parsePriceBand('   ')).toBeNull();
    expect(parsePriceBand(undefined)).toBeNull();
    expect(FUTURES_PRICE_BAND_UNSET).toBe('trade.futures_price_band_unset');
  });

  it('a fraction strictly between 0 and 1 parses; anything else is an error at boot', () => {
    expect(parsePriceBand('0.05')).toBe(A('0.05'));
    expect(() => parsePriceBand('0')).toThrow(/TRADE_FUTURES_PRICE_BAND/);
    expect(() => parsePriceBand('1')).toThrow(/TRADE_FUTURES_PRICE_BAND/);
    expect(() => parsePriceBand('1.5')).toThrow(/TRADE_FUTURES_PRICE_BAND/);
    expect(() => parsePriceBand('-0.1')).toThrow();
    expect(() => parsePriceBand('five')).toThrow();
  });

  it('the band is the mark plus or minus the fraction, and a limit is inside it', () => {
    const band = priceBandAround(A('100'), A('0.05'));
    expect(band.low).toBe(A('95'));
    expect(band.high).toBe(A('105'));
    expect(limitWithinBand(A('105'), band)).toBe(true);
    expect(limitWithinBand(A('95'), band)).toBe(true);
    expect(limitWithinBand(A('105.000000000000000001'), band)).toBe(false);
    expect(limitWithinBand(A('94.999999999999999999'), band)).toBe(false);
  });

  it('a market order takes the band edge on its own side', () => {
    const band = priceBandAround(A('100'), A('0.05'));
    expect(protectiveLimit('buy', band)).toBe(A('105'));
    expect(protectiveLimit('sell', band)).toBe(A('95'));
  });
});

describe('matched order plan: adverse distance and fills', () => {
  it('a price at or better than the mark carries no adverse distance', () => {
    expect(adverseDistance('buy', A('100'), A('100'))).toBe(0n);
    expect(adverseDistance('buy', A('99'), A('100'))).toBe(0n);
    expect(adverseDistance('sell', A('101'), A('100'))).toBe(0n);
    expect(adverseDistance('buy', A('103'), A('100'))).toBe(A('3'));
    expect(adverseDistance('sell', A('97'), A('100'))).toBe(A('3'));
  });

  it('a fill inside its own limit, on its own side only', () => {
    expect(fillWithinLimit('buy', A('100'), A('100'))).toBe(true);
    expect(fillWithinLimit('buy', A('100.000000000000000001'), A('100'))).toBe(false);
    expect(fillWithinLimit('sell', A('100'), A('100'))).toBe(true);
    expect(fillWithinLimit('sell', A('99.999999999999999999'), A('100'))).toBe(false);
  });

  it('the hold is the fill-at-limit need, and a fill at the mark owes only initial margin', () => {
    // 1 unit at mark 100, leverage 10: initial margin 10, no adverse distance.
    const hold = orderHoldAmount({ side: 'buy', qty: A('1'), limit: A('100'), mark: A('100'), leverage: A('10') });
    expect(hold).toBe(A('10'));
    // The same order with a limit of 105 holds the adverse distance as well.
    const held = orderHoldAmount({ side: 'buy', qty: A('1'), limit: A('105'), mark: A('100'), leverage: A('10') });
    expect(held).toBe(A('15'));
    const first = fillMargin(
      { filled: 0n, adverseNum: 0n },
      { side: 'buy', qty: A('1'), price: A('100'), mark: A('100'), leverage: A('10') },
    );
    expect(first.amount).toBe(A('10'));
  });

  it('a fill at a better price than its limit posts less than the hold; the rest is not used by it', () => {
    const hold = orderHoldAmount({ side: 'buy', qty: A('1'), limit: A('105'), mark: A('100'), leverage: A('10') });
    const step = fillMargin(
      { filled: 0n, adverseNum: 0n },
      { side: 'buy', qty: A('1'), price: A('102'), mark: A('100'), leverage: A('10') },
    );
    expect(step.amount).toBe(A('12'));
    expect(step.amount <= hold).toBe(true);
  });

  it('need never falls and the fills telescope exactly to the need of the total', () => {
    const r = rng(7);
    for (let trial = 0; trial < 200; trial++) {
      const side = trial % 2 === 0 ? 'buy' : 'sell';
      const mark = A('100') + r(A('50'));
      const leverage = A('1') + r(A('9'));
      const limit = side === 'buy' ? mark + r(A('8')) : mark - r(A('8'));
      const qty = A('1') + r(A('20'));
      const hold = orderHoldAmount({ side, qty, limit, mark, leverage });
      let before = { filled: 0n, adverseNum: 0n };
      let spent = 0n;
      let remaining = qty;
      while (remaining > 0n) {
        const want = A('1') + r(A('3'));
        const q = want > remaining ? remaining : want;
        // A fill prices within its own limit, anywhere between the mark and the limit.
        const towardLimit = side === 'buy' ? (limit > mark ? limit - mark : 0n) : mark > limit ? mark - limit : 0n;
        const price =
          side === 'buy' ? mark + (towardLimit === 0n ? 0n : r(towardLimit)) : mark - (towardLimit === 0n ? 0n : r(towardLimit));
        const step = fillMargin(before, { side, qty: q, price, mark, leverage });
        expect(step.amount >= 0n).toBe(true);
        expect(step.need >= before.filled).toBe(true);
        spent += step.amount;
        before = { filled: step.filled, adverseNum: step.adverseNum };
        remaining -= q;
      }
      // Telescoping: the sum of what every fill posted is the need of the whole order at its fill prices.
      expect(spent).toBe(marginNeed({ ...before, mark, leverage }));
      // And it never exceeds the hold, which was computed at the limit.
      expect(spent <= hold).toBe(true);
      expect(adverseNumerator(side, qty, limit, mark) >= before.adverseNum).toBe(true);
    }
  });

  it('a weighted entry is the size-weighted average, floored', () => {
    expect(weightedEntry({ size: 0n, entryPrice: 0n }, { qty: A('2'), price: A('100') })).toBe(A('100'));
    expect(weightedEntry({ size: A('2'), entryPrice: A('100') }, { qty: A('2'), price: A('110') })).toBe(A('105'));
    expect(SCALE).toBe(10n ** 18n);
  });
});
