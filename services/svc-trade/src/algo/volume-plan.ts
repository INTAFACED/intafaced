/**
 * VWAP slice plan — volume weights from observed non-seeded taker candles.
 *
 * Does not invent a volume curve. Missing lookback buckets are 0 (absent tape,
 * never interpolated). All-zero lookback refuses rather than falling back to TWAP.
 *
 * Slice interval must match a listed OHLCV timeframe — we do not invent a
 * finer bucket than the public candle grain.
 */

import { TIMEFRAME_MS, type Timeframe } from '@intafaced/exchange-contract';
import type { Amount } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';
import type { Candle } from '../spot/types.js';
import type { TwapSlicePlan } from './schedule.js';

export function timeframeForSliceInterval(sliceIntervalMs: number): Timeframe | null {
  for (const [tf, ms] of Object.entries(TIMEFRAME_MS) as [Timeframe, number][]) {
    if (ms === sliceIntervalMs) return tf;
  }
  return null;
}

export function sliceCount(durationMs: number, sliceIntervalMs: number): number {
  return Math.max(1, Math.floor(durationMs / sliceIntervalMs));
}

/**
 * Map lookback candles onto N schedule slots ending at `windowEndMs`.
 * A slot with no candle is 0 — we do not fill holes with neighbouring volume.
 */
export function alignLookbackVolumes(candles: readonly Candle[], n: number, sliceIntervalMs: number, windowEndMs: number): Amount[] {
  const byOpen = new Map<number, Amount>();
  for (const c of candles) byOpen.set(c.openTimeMs, c.volume);
  const volumes: Amount[] = [];
  for (let i = 0; i < n; i++) {
    const slotStart = windowEndMs - (n - i) * sliceIntervalMs;
    volumes.push(byOpen.get(slotStart) ?? 0n);
  }
  return volumes;
}

/**
 * A VWAP lookback has no observed volume.
 *
 * `describeAlgoPolicy().vwapPovImmatureRefused` is true, and `algo-policy.ts`
 * names no bucket-count threshold under that flag. Missing slots are already
 * zeros (`alignLookbackVolumes` does not interpolate). Immature means every
 * slot is zero, including a null or empty profile. One positive slot is observed.
 */
export function vwapLookbackImmature(volumes: readonly Amount[] | null | undefined): boolean {
  if (volumes == null || volumes.length === 0) return true;
  for (const volume of volumes) {
    if (volume > 0n) return false;
  }
  return true;
}

export function planVwapSlices(input: { totalQty: Amount; volumes: readonly Amount[]; lotSize: Amount }): TwapSlicePlan {
  if (input.totalQty <= 0n) {
    throw new TradeError('VWAP total quantity must be strictly positive', 'trade.algo_invalid_qty');
  }
  if (input.lotSize <= 0n) {
    throw new TradeError('lot size must be positive', 'trade.algo_invalid_qty');
  }
  if (input.volumes.length === 0) {
    throw new TradeError('VWAP has no lookback volume buckets — refuse rather than invent a curve', 'trade.algo_volume_immature');
  }

  let sumV = 0n;
  for (const v of input.volumes) {
    if (v < 0n) {
      throw new TradeError('VWAP lookback volume cannot be negative', 'trade.algo_volume_immature');
    }
    sumV += v;
  }
  if (sumV === 0n) {
    throw new TradeError(
      'VWAP lookback has no non-seeded taker volume — market is immature for volume-weighted slices, not missing candles',
      'trade.algo_volume_immature',
    );
  }

  const n = input.volumes.length;
  const raw: Amount[] = [];
  let allocated = 0n;
  for (let i = 0; i < n; i++) {
    if (i === n - 1) {
      raw.push(input.totalQty - allocated);
    } else {
      const q = (input.totalQty * input.volumes[i]!) / sumV;
      raw.push(q);
      allocated += q;
    }
  }

  const slices: Amount[] = [];
  let planned = 0n;
  for (const q of raw) {
    const snapped = q <= 0n ? 0n : q - (q % input.lotSize);
    slices.push(snapped);
    planned += snapped;
  }

  if (planned <= 0n) {
    throw new TradeError(
      `VWAP total ${input.totalQty} is below one lot (${input.lotSize}) after volume-weighted split`,
      'trade.algo_invalid_qty',
    );
  }

  return { slices, plannedQty: planned, droppedQty: input.totalQty - planned };
}

/** Plan VWAP directly from observed fill quantities; an empty tape refuses. */
export function planVwapSlicesFromFills(input: {
  totalQty: Amount;
  fills: readonly { qty: Amount; liquidity?: 'maker' | 'taker' }[];
  lotSize: Amount;
}): TwapSlicePlan {
  const fills = input.fills.filter((fill) => fill.liquidity === undefined || fill.liquidity === 'taker');
  if (fills.length === 0) {
    throw new TradeError(
      'VWAP has no observed fills — market is immature; refuse rather than invent a curve',
      'trade.algo_volume_immature',
    );
  }
  return planVwapSlices({ totalQty: input.totalQty, volumes: fills.map((fill) => fill.qty), lotSize: input.lotSize });
}

/** POV child qty = participation of observed interval volume, capped by remaining schedule, lot-aligned. */
export function planPovSliceQty(input: {
  intervalVolume: Amount;
  participationBps: number;
  remainingQty: Amount;
  lotSize: Amount;
}): Amount {
  if (input.remainingQty <= 0n) return 0n;
  if (input.intervalVolume <= 0n) return 0n;
  if (!Number.isInteger(input.participationBps) || input.participationBps < 1 || input.participationBps > 10_000) {
    throw new TradeError(
      'POV participationBps must be an integer 1..10000 — refuse rather than invent a participation rate',
      'trade.algo_invalid_schedule',
    );
  }
  const raw = (input.intervalVolume * BigInt(input.participationBps)) / 10_000n;
  const capped = raw < input.remainingQty ? raw : input.remainingQty;
  const snapped = capped - (capped % input.lotSize);
  return snapped > 0n ? snapped : 0n;
}
