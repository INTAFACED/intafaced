import type { Amount } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';

/**
 * TWAP slice plan — pure schedule math. No I/O, no fills, no prices.
 *
 * Splits `totalQty` into N equal slices (last absorbs remainder) where
 * N = floor(durationMs / sliceIntervalMs), at least 1. Each slice is snapped
 * down to `lotSize` so child orders pass `assertQty`; remainder that cannot
 * form a full lot is dropped from the schedule (honest shortfall, not invent).
 */

export interface TwapSlicePlan {
  readonly slices: readonly Amount[];
  readonly plannedQty: Amount;
  /** Portion of totalQty that could not form a lot-aligned slice. */
  readonly droppedQty: Amount;
}

/** Largest seed a schedule accepts: an unsigned 32-bit integer, the PRNG's whole state. */
export const MAX_ALGO_SEED = 0xffff_ffff;

export function planTwapSlices(input: {
  totalQty: Amount;
  durationMs: number;
  sliceIntervalMs: number;
  lotSize: Amount;
  /** Set: slice sizes are random but fixed by this seed, the same seed always giving the same sizes. */
  randomSeed?: number | null;
}): TwapSlicePlan {
  if (input.totalQty <= 0n) {
    throw new TradeError('TWAP total quantity must be strictly positive', 'trade.algo_invalid_qty');
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) {
    throw new TradeError('TWAP durationMs must be > 0', 'trade.algo_invalid_schedule');
  }
  if (!Number.isFinite(input.sliceIntervalMs) || input.sliceIntervalMs <= 0) {
    throw new TradeError('TWAP sliceIntervalMs must be > 0', 'trade.algo_invalid_schedule');
  }
  if (input.sliceIntervalMs > input.durationMs) {
    throw new TradeError('TWAP sliceIntervalMs must not exceed durationMs', 'trade.algo_invalid_schedule');
  }
  if (input.lotSize <= 0n) {
    throw new TradeError('lot size must be positive', 'trade.algo_invalid_qty');
  }

  const n = Math.max(1, Math.floor(input.durationMs / input.sliceIntervalMs));
  if (input.randomSeed != null) return planRandomSlices(input.totalQty, n, input.lotSize, input.randomSeed);
  const base = input.totalQty / BigInt(n);
  const rem = input.totalQty % BigInt(n);

  const raw: Amount[] = [];
  for (let i = 0; i < n; i++) {
    raw.push(i === n - 1 ? base + rem : base);
  }

  const slices: Amount[] = [];
  let planned = 0n;
  for (const q of raw) {
    const snapped = q - (q % input.lotSize);
    if (snapped > 0n) {
      slices.push(snapped);
      planned += snapped;
    }
  }

  if (slices.length === 0) {
    throw new TradeError(`TWAP total ${input.totalQty} is below one lot (${input.lotSize}) after schedule split`, 'trade.algo_invalid_qty');
  }

  return { slices, plannedQty: planned, droppedQty: input.totalQty - planned };
}

/**
 * Random slice sizes fixed by a seed. Every slice holds at least one lot; the lots left over are spread by weights
 * drawn from the seed (each 0.5x to 1.5x of an even share), largest remainder first, so the sizes sum exactly to the
 * lot-aligned total. Integer math only: the same seed gives the same sizes on every machine and after a restart.
 */
function planRandomSlices(totalQty: Amount, n: number, lotSize: Amount, seed: number): TwapSlicePlan {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_ALGO_SEED) {
    throw new TradeError(`TWAP seed must be an integer 0..${MAX_ALGO_SEED}`, 'trade.algo_invalid_schedule');
  }
  const lots = totalQty / lotSize;
  if (lots < BigInt(n)) {
    throw new TradeError(
      `TWAP total ${totalQty} is fewer than one lot (${lotSize}) per slice, so sizes cannot be random across ${n} slices`,
      'trade.algo_invalid_qty',
    );
  }
  const next = mulberry32(seed);
  const weights = Array.from({ length: n }, () => 500n + BigInt(next() % 1001));
  const weightSum = weights.reduce((a, w) => a + w, 0n);
  const spare = lots - BigInt(n);
  const share = weights.map((w) => (spare * w) / weightSum);
  let left = spare - share.reduce((a, q) => a + q, 0n);
  // Largest remainder first; ties go to the earlier slice.
  const order = weights.map((w, i) => ({ i, rem: (spare * w) % weightSum })).sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of order) {
    if (left === 0n) break;
    share[i] = share[i]! + 1n;
    left -= 1n;
  }
  const slices = share.map((q) => (q + 1n) * lotSize);
  const planned = slices.reduce((a, q) => a + q, 0n);
  return { slices, plannedQty: planned, droppedQty: totalQty - planned };
}

/** A small seeded PRNG (mulberry32): unsigned 32-bit outputs, deterministic for a seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}
