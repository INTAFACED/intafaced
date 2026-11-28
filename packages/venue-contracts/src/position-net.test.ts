import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { netIfClosedAt, openingFeesOf } from './position-net.js';

// A perp position's result after fees, worked by hand. Every figure is TEST.
const a = parseAmount;
const at = (n: number) => new Date(Date.UTC(2026, 10, 27, 0, 0, n));
const fill = (side: 'buy' | 'sell', amount: string, venueFee: string, builderFee: string, n: number) => ({
  side,
  amount: a(amount),
  venueFee: a(venueFee),
  builderFee: a(builderFee),
  filledAt: at(n),
});

describe('netIfClosedAt (J-derivatives-32): closing the whole position at a price, after every fee', () => {
  // 2 ETH at 3000, opening fees 3.3, the close at 5.5 bps (the venue's 4.5 and our 1), as breakeven.test.ts works it.
  const common = { size: a('2'), entryPrice: a('3000'), openingFees: a('3.3'), closeFeeBps: a('5.5') };
  it('a long at 3100 makes 200 less 3.3 and 3.41 of close fees; at the breakeven stop 3003.4 it nets +0.19626', () => {
    expect(netIfClosedAt({ ...common, side: 'long', price: a('3100') })).toBe(a('193.29'));
    expect(netIfClosedAt({ ...common, side: 'long', price: a('3003.4') })).toBe(a('0.19626'));
    expect(netIfClosedAt({ ...common, side: 'long', price: a('3003.3') })).toBe(a('-0.00363'));
  });
  it('a short makes what the price falls, less the same fees; a loss reads as a loss', () => {
    expect(netIfClosedAt({ ...common, side: 'short', price: a('2996.7') })).toBe(a('0.00363'));
    expect(netIfClosedAt({ ...common, side: 'short', price: a('3100') })).toBe(a('-206.71'));
  });
  it('rounds a fraction of the last place against the person', () => {
    const n = netIfClosedAt({
      side: 'long',
      size: a('1'),
      entryPrice: a('1'),
      openingFees: a('0'),
      closeFeeBps: a('1'),
      price: a('0.000000000000000001'),
    });
    expect(n).toBe(-a('1'));
    // −0.999999999999999999 less a 0.0001-bp fee of 1e-22: −0.9999999999999999990001, floored to −1.
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
