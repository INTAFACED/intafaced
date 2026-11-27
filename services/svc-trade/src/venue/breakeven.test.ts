import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client/money';
import { feeAdjustedBreakeven, openingFeesOf } from './breakeven.js';

// The fee-adjusted breakeven of an open perp position, worked by hand. Every figure is TEST.
const a = parseAmount;
const at = (n: number) => new Date(Date.UTC(2026, 10, 27, 0, 0, n));
const fill = (side: 'buy' | 'sell', amount: string, venueFee: string, builderFee: string, n: number) => ({
  side,
  amount: a(amount),
  venueFee: a(venueFee),
  builderFee: a(builderFee),
  filledAt: at(n),
});

describe('feeAdjustedBreakeven (#11070), against hand-worked examples', () => {
  // A 2 ETH position at 3000. Opening: one taker fill of 6000 notional, the venue's 4.5 bps (2.7) and our 1 bp (0.6):
  // F = 3.3. The close pays the venue's taker 4.5 bps and our 1 bp: r = 5.5 bps = 0.00055. ETH's tick is 0.01.
  const common = { size: a('2'), entryPrice: a('3000'), openingFees: a('3.3'), closeFeeBps: a('5.5'), tick: a('0.01') };

  it('a long: P = (E·Q + F) / (Q·(1 − r)) = 6003.3 / 1.9989 = 3003.30181…, its stop rounded up to 5 figures: 3003.4', () => {
    const be = feeAdjustedBreakeven({ ...common, side: 'long' });
    // 6003.3 / 1.9989 = 3003.301815998799339636800240132072639951… (exact), up at the 18th place.
    expect(be.exact).toBe(a('3003.301815998799339637'));
    expect(be.price).toBe(a('3003.4'));
    // By hand, closing 2 at 3003.4 nets 6.8 − 3.30374 − 3.3 = +0.19626; at 3003.3 it nets 6.6 − 3.30363 − 3.3 = −0.00363.
  });

  it('a short: P = (E·Q − F) / (Q·(1 + r)) = 5996.7 / 2.0011 = 2996.70181…, its stop rounded down to 5 figures: 2996.7', () => {
    const be = feeAdjustedBreakeven({ ...common, side: 'short' });
    // 5996.7 / 2.0011 = 2996.701814002298735695… (exact), down at the 18th place.
    expect(be.exact).toBe(a('2996.701814002298735695'));
    expect(be.price).toBe(a('2996.7'));
    // By hand, buying 2 back at 2996.7 nets 6.6 − 3.29637 − 3.3 = +0.00363 ≥ 0.
  });

  it('with no fees, breakeven is the entry; below 1, five significant figures keep more places', () => {
    expect(feeAdjustedBreakeven({ ...common, side: 'long', openingFees: ZERO, closeFeeBps: ZERO }).price).toBe(a('3000'));
    // 1000 at 0.123456, F = 0.05, r = 4.5 bps: P = (123.456 + 0.05) / (1000·0.99955) = 0.12356160272…, up: 0.12357.
    const small = feeAdjustedBreakeven({
      side: 'long',
      size: a('1000'),
      entryPrice: a('0.123456'),
      openingFees: a('0.05'),
      closeFeeBps: a('4.5'),
      tick: a('0.000001'),
    });
    expect(small.price).toBe(a('0.12357'));
  });

  it('refuses what has no breakeven: no size, a rate of 100% or more, a short whose fees exceed its value', () => {
    expect(() => feeAdjustedBreakeven({ ...common, side: 'long', size: ZERO })).toThrow(RangeError);
    expect(() => feeAdjustedBreakeven({ ...common, side: 'long', closeFeeBps: a('10000') })).toThrow(RangeError);
    expect(() => feeAdjustedBreakeven({ ...common, side: 'short', openingFees: a('6000') })).toThrow(RangeError);
  });
});

describe('openingFeesOf (#11070): the fees still open on the position, from its own fills', () => {
  it('adds what opened, keeps the open share after a partial close, and keeps the new side’s share after a turn over', () => {
    const fills = [
      fill('buy', '1', '1.35', '0.3', 1), // long 1: 1.65
      fill('buy', '1', '1.35', '0.3', 2), // long 2: 3.3
      fill('sell', '0.5', '0.9', '0.2', 3), // long 1.5: 3.3 × 1.5 / 2 = 2.475
      fill('sell', '3.5', '7', '1', 4), // short 2: of 8 paid, the 2 past zero of 3.5 sold opened it: 8 × 2 / 3.5
    ];
    expect(openingFeesOf({ side: 'long', size: a('2') }, fills.slice(0, 2))).toBe(a('3.3'));
    expect(openingFeesOf({ side: 'long', size: a('1.5') }, fills.slice(0, 3))).toBe(a('2.475'));
    expect(openingFeesOf({ side: 'short', size: a('2') }, fills)).toBe(a('4.571428571428571428'));
  });

  it('starts again after the position went flat, and reads the fills oldest first whatever order they come in', () => {
    const fills = [fill('buy', '1', '9', '9', 1), fill('sell', '1', '9', '9', 2), fill('sell', '2', '2.7', '0.6', 3)];
    expect(openingFeesOf({ side: 'short', size: a('2') }, [...fills].reverse())).toBe(a('3.3'));
  });

  it('is null, never a guess, when the fills do not add up to the position the venue holds', () => {
    expect(openingFeesOf({ side: 'long', size: a('2') }, [fill('buy', '1', '1', '0', 1)])).toBeNull();
    expect(openingFeesOf({ side: 'long', size: a('1') }, [])).toBeNull();
  });
});
