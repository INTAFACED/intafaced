import { describe, expect, it } from 'vitest';
import {
  assertMinAmountOut,
  MAX_SWAP_SLIPPAGE_BPS,
  parseSwapSlippageBps,
  requireSwapSlippageBps,
  swapMinOutFloor,
  SwapSlippageError,
} from './slippage.js';

describe('swap slippage floor', () => {
  it('floors quote × (1 − slippage) in bigint bps', () => {
    // 19743 × 9900 / 10000 = 19545, remainder dropped — not rounded up.
    expect(swapMinOutFloor(19_743n, 100)).toBe(19_545n);
    expect(swapMinOutFloor(10_000n, 0)).toBe(10_000n);
    expect(swapMinOutFloor(10_000n, 5_000)).toBe(5_000n);
  });

  it('refuses a floor of 0, because minAmountOut of 1 is not protection', () => {
    expect(swapMinOutFloor(1n, 1)).toBeNull();
    expect(() => assertMinAmountOut(1n, 1n, 1)).toThrow(SwapSlippageError);
    try {
      assertMinAmountOut(1n, 1n, 1);
    } catch (err) {
      expect((err as SwapSlippageError).code).toBe('protocol.swap_min_out_below_bound');
    }
  });

  it('accepts minAmountOut exactly at the floor and refuses one unit under', () => {
    const floor = swapMinOutFloor(19_743n, 100);
    expect(floor).toBe(19_545n);
    expect(assertMinAmountOut(19_545n, 19_743n, 100)).toBe(19_545n);
    expect(() => assertMinAmountOut(19_544n, 19_743n, 100)).toThrow(/protocol\.swap_min_out_below_bound/);
    expect(() => assertMinAmountOut(0n, 19_743n, 100)).toThrow(/protocol\.swap_min_out_below_bound/);
  });

  it('blank, non-integer, and above the max are unset — never a default', () => {
    expect(parseSwapSlippageBps('')).toBeNull();
    expect(parseSwapSlippageBps(undefined)).toBeNull();
    expect(parseSwapSlippageBps('  ')).toBeNull();
    expect(parseSwapSlippageBps('nope')).toBeNull();
    expect(parseSwapSlippageBps('50')).toBe(50);
    for (const raw of [null, undefined, Number.NaN, 1.5, -1, MAX_SWAP_SLIPPAGE_BPS + 1, 10_000]) {
      expect(() => requireSwapSlippageBps(raw)).toThrow(/protocol\.swap_slippage_unset/);
    }
    expect(requireSwapSlippageBps(0)).toBe(0);
    expect(requireSwapSlippageBps(MAX_SWAP_SLIPPAGE_BPS)).toBe(MAX_SWAP_SLIPPAGE_BPS);
  });
});
