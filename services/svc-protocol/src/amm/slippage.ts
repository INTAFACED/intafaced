/**
 * Swap slippage floor. Exact integer bps, bigint amounts only.
 *
 * `minAmountOut` of 0 (or 1, against a real quote) lets a sandwich take the
 * output. The floor is `quoteOut × (10_000 − slippageBps) / 10_000`, floored.
 * Blank config is not 0 bps and not 50 bps — callers refuse
 * `protocol.swap_slippage_unset`. A floor that rounds to 0 does not protect,
 * so it is refused too.
 */

export const MAX_SWAP_SLIPPAGE_BPS = 5_000;
export const SLIPPAGE_DENOM = 10_000n;

export type SwapSlippageCode = 'protocol.swap_slippage_unset' | 'protocol.swap_min_out_below_bound';

export class SwapSlippageError extends Error {
  readonly code: SwapSlippageCode;

  constructor(code: SwapSlippageCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SwapSlippageError';
    this.code = code;
  }
}

/** Blank / unset / non-integer → null. Never coerces blank to 0. */
export function parseSwapSlippageBps(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

/**
 * Owner slippage tolerance in bps.
 *
 * 0 means the minimum must equal the quote. Above {@link MAX_SWAP_SLIPPAGE_BPS}
 * is refused: 10_000 bps would make the floor 0, which is an unbounded swap.
 * Blank is the same refusal — this function does not invent a tolerance.
 */
export function requireSwapSlippageBps(slippageBps: number | null | undefined): number {
  if (slippageBps == null || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SWAP_SLIPPAGE_BPS) {
    throw new SwapSlippageError(
      'protocol.swap_slippage_unset',
      `PROTOCOL_SWAP_SLIPPAGE_BPS is unset or not an integer 0–${MAX_SWAP_SLIPPAGE_BPS} — refuse rather than invent a slippage tolerance`,
    );
  }
  return slippageBps;
}

/**
 * Greatest `minAmountOut` that is still inside the tolerance.
 * Null when the floor is 0 — a minimum of 1 would not be protection.
 */
export function swapMinOutFloor(quoteOut: bigint, slippageBps: number): bigint | null {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SWAP_SLIPPAGE_BPS) return null;
  if (quoteOut <= 0n) return null;
  const floor = (quoteOut * (SLIPPAGE_DENOM - BigInt(slippageBps))) / SLIPPAGE_DENOM;
  return floor > 0n ? floor : null;
}

/** Throws before any calldata is built when `minAmountOut` is under the floor. */
export function assertMinAmountOut(minAmountOut: bigint, quoteOut: bigint, slippageBps: number | null | undefined): bigint {
  const bps = requireSwapSlippageBps(slippageBps);
  const floor = swapMinOutFloor(quoteOut, bps);
  if (floor == null || minAmountOut < floor) {
    throw new SwapSlippageError(
      'protocol.swap_min_out_below_bound',
      `minAmountOut ${minAmountOut.toString()} is below the slippage floor ${floor == null ? '0' : floor.toString()} for quote ${quoteOut.toString()} at ${bps} bps`,
    );
  }
  return floor;
}
