/**
 * The numbers on the coin page, all from decimal strings in exact arithmetic (`data/decimal.ts`): nothing here turns a
 * price into a JS number. The chart itself draws from numbers in `CoinChart.tsx`; text never comes from those.
 */
import { dec, decOrNull, fractionDigits, ratio, roundScaled, sub, toFixedString } from './deps';
import type { Candle, Decimal } from './deps';

export type Direction = 'up' | 'down' | 'flat';

export interface Move {
  /** What the range started at: the first candle's open. */
  base: Decimal;
  /** The price shown (live, or the candle under the crosshair). */
  price: Decimal;
  /** price - base, exact. */
  change: Decimal;
  /** change / base as a ratio string ("0.0275"), null when base is 0. */
  changeRatio: Decimal | null;
  direction: Direction;
}

/** The change of `price` since the range started. Null when either side is unknown. */
export function moveSince(candles: readonly Candle[], price: Decimal | null): Move | null {
  const base = candles[0]?.o;
  const from = dec(base);
  const to = dec(price);
  if (base === undefined || from === null || to === null) return null;
  const diff = sub(to, from);
  return {
    base,
    price: price as Decimal,
    change: decOrNull(diff) as Decimal,
    changeRatio: decOrNull(ratio(diff, from)),
    direction: diff > 0n ? 'up' : diff < 0n ? 'down' : 'flat',
  };
}

/** A price rounded to the market's tick as the string HeroNumber animates, with its decimals. */
export function heroPrice(price: Decimal | null, tickSize: Decimal | null): { value: string | null; decimals: number } {
  const parsed = dec(price);
  const decimals = fractionDigits(tickSize) ?? 2;
  if (parsed === null) return { value: null, decimals };
  return { value: toFixedString(roundScaled(parsed, decimals), decimals), decimals };
}

export interface Extreme {
  /** Index into the candle list. */
  index: number;
  price: Decimal;
}

/**
 * The highest and lowest close on the line, for the two labels (UI-SPEC 5.5). The line is drawn from closes, so the
 * labels name closes. A line that never moves has no high and low to name.
 */
export function highLow(candles: readonly Candle[]): { high: Extreme; low: Extreme } | null {
  let high: { index: number; value: bigint } | null = null;
  let low: { index: number; value: bigint } | null = null;
  candles.forEach((candle, index) => {
    const value = dec(candle.c);
    if (value === null) return;
    if (!high || value > high.value) high = { index, value };
    if (!low || value < low.value) low = { index, value };
  });
  const top = high as { index: number; value: bigint } | null;
  const bottom = low as { index: number; value: bigint } | null;
  if (!top || !bottom || top.value === bottom.value) return null;
  return {
    high: { index: top.index, price: candles[top.index]!.c },
    low: { index: bottom.index, price: candles[bottom.index]!.c },
  };
}

/**
 * True when the market has less history than the range asks for, so the change is "since" its first trade and the
 * screen says so instead of calling it a week or a year.
 */
export function startsLate(candles: readonly Candle[], stepMs: number, spanMs: number, nowMs: number): boolean {
  const first = candles[0];
  if (!first) return false;
  const wanted = Math.floor(nowMs / stepMs) * stepMs - spanMs + stepMs;
  return first.t > wanted + stepMs;
}
