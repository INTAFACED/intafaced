/**
 * Liquidity maths (J-dex-protocol-12 #4, #6, #7), against the figures the steps and the spec name (TEST amounts):
 * 100:100 into 1000:2000 pulls 50:100; a position entered at 1000:2000 with reserves moved to 1414:1414 shows the held
 * amounts, the share amounts and the difference, matching the closed form (`il.matches-closed-form`); a transferred share
 * has no entry; swap-and-add of 100 into a 1:1 pool swaps about half.
 */
import { describe, expect, it } from 'vitest';
import { amountOut, entryOf, floorBy, optimalPair, parseFeeTiers, positionFigures, sharesFor, sqrt, swapPart } from './maths.js';

const A = 10n ** 6n; // TEST Token A has 6 decimals on the stack
const B = 10n ** 18n; // TEST Token B has 18
const ZERO = '0x0000000000000000000000000000000000000000';

describe('optimalPair (AMM-4)', () => {
  it('pulls only 50:100 of 100:100 offered to a 1000:2000 pool, across different decimals', () => {
    expect(optimalPair(1000n * A, 2000n * B, 100n * A, 100n * B)).toEqual({ amount0: 50n * A, amount1: 100n * B });
    expect(optimalPair(1000n * A, 2000n * B, 10n * A, 100n * B)).toEqual({ amount0: 10n * A, amount1: 20n * B });
  });
  it('takes both amounts as offered into an empty pool, and refuses a zero side', () => {
    expect(optimalPair(0n, 0n, 7n, 9n)).toEqual({ amount0: 7n, amount1: 9n });
    expect(() => optimalPair(1n, 1n, 0n, 1n)).toThrow(RangeError);
  });
});

describe('sharesFor', () => {
  it('locks 1,000 shares at the first deposit and mints pro rata after it', () => {
    const first = sharesFor(0n, 0n, 0n, 1000n * A, 2000n * B);
    expect(first).toBe(sqrt(1000n * A * 2000n * B) - 1000n);
    const supply = first + 1000n;
    expect(sharesFor(supply, 1000n * A, 2000n * B, 50n * A, 100n * B)).toBe((50n * A * supply) / (1000n * A));
  });
});

describe('swapPart (swap-and-add)', () => {
  it('swaps about half of 100 into a 1:1 pool, and the rest then sits at the pool ratio', () => {
    const r = 1000n * B;
    const s = swapPart(r, 100n * B, 30);
    expect(s > 48n * B && s < 50n * B).toBe(true);
    const out = amountOut(s, r, r, 30);
    // kept : out equals the new reserves' ratio, to within rounding
    const kept = 100n * B - s;
    const lhs = kept * (r - out);
    const rhs = out * (r + s);
    expect(lhs > rhs ? lhs - rhs : rhs - lhs).toBeLessThan(rhs / 10n ** 12n);
  });
});

describe('entryOf', () => {
  it('sums the account’s own deposits', () => {
    const entry = entryOf([
      { from: ZERO, value: 10n, deposit: { amount0: 4n, amount1: 9n } },
      { from: ZERO, value: 5n, deposit: { amount0: 2n, amount1: 4n } },
    ]);
    expect(entry).toEqual({ shares: 15n, amount0: 6n, amount1: 13n, rootK: sqrt(36n) + sqrt(8n) });
  });
  it('is unknown when any share arrived from another address', () => {
    expect(entryOf([{ from: '0x00000000000000000000000000000000000a11ce', value: 1n, deposit: null }])).toBeNull();
    expect(
      entryOf([
        { from: ZERO, value: 10n, deposit: { amount0: 4n, amount1: 9n } },
        { from: '0x00000000000000000000000000000000000a11ce', value: 1n, deposit: null },
      ]),
    ).toBeNull();
    expect(entryOf([])).toBeNull();
  });
});

describe('positionFigures (D-liquidity-04 impermanent loss)', () => {
  // Entered at 1000:2000 (the seed of a fresh pool, every share but the locked 1,000), price moved to 1414:1414.
  const entry0 = 1000n * A;
  const entry1 = 2000n * B;
  const supply = sqrt(entry0 * entry1);
  const mine = supply - 1000n;
  const entry = { shares: mine, amount0: entry0, amount1: entry1, rootK: sqrt(entry0 * entry1) };
  const r0 = sqrt(entry0 * entry1 * A) / sqrt(B); // √k in token0 units: 1414.21… TEST Token A
  const r1 = (entry0 * entry1) / r0; // keeps k: 1414.21… TEST Token B

  it('shows the held amounts, the share amounts and the difference, matching the closed form', () => {
    const f = positionFigures(mine, supply, r0, r1, entry);
    const il = f.impermanentLoss!;
    // held: the entry, for the shares still held
    expect(il.held0).toBe((entry0 * mine) / mine);
    expect(il.held1).toBe(entry1);
    // in the pool: 1414:1414
    expect(il.now0 / A).toBe(1414n);
    expect(il.now1 / B).toBe(1414n);
    expect(il.diff0).toBe(il.now0 - il.held0);
    expect(il.diff1 < 0n).toBe(true);
    // the closed form 2√r/(1+r) − 1 for r = 1/2 is −5.719%, −572 bps rounded down; the measured difference matches it (no fees here)
    expect(il.closedFormBps).toBe(-572);
    expect(Math.abs(il.diffBps - il.closedFormBps)).toBeLessThanOrEqual(1);
    expect(f.feesEarned!.amount0).toBe(0n);
  });

  it('scales the entry to the shares still held after some were sent away', () => {
    const f = positionFigures(mine / 10n, supply, r0, r1, entry);
    expect(f.impermanentLoss!.held1).toBe((entry1 * (mine / 10n)) / mine);
  });

  it('counts fees as the growth of √k per share, and gives no entry figures without an entry', () => {
    const grown = positionFigures(mine, supply, (r0 * 1001n) / 1000n, (r1 * 1001n) / 1000n, entry);
    expect(grown.feesEarned!.amount0 > 0n && grown.feesEarned!.amount1 > 0n).toBe(true);
    const unknown = positionFigures(mine, supply, r0, r1, null);
    expect(unknown.feesEarned).toBeNull();
    expect(unknown.impermanentLoss).toBeNull();
    expect(unknown.amount0).toBe((mine * r0) / supply);
  });
});

describe('floorBy and parseFeeTiers', () => {
  it('floors an amount by the slippage ceiling', () => {
    expect(floorBy(10_000n, 300)).toBe(9_700n);
  });
  it('reads the owner’s tiers, blank as unset, and refuses anything that is not a list of 0 to 1000 bps', () => {
    expect(parseFeeTiers('100, 5,30,30')).toEqual([5, 30, 100]);
    expect(parseFeeTiers('')).toBeNull();
    expect(parseFeeTiers(undefined)).toBeNull();
    expect(() => parseFeeTiers('1001')).toThrow();
    expect(() => parseFeeTiers('0.3')).toThrow();
  });
});
