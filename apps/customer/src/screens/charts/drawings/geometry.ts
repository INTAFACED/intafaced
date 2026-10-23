/**
 * The exact figures of the measuring tools. Every price here is decimal arithmetic at the market's tick size; the numbers
 * the canvas needs (channel and pitchfork lines) are computed in `render.ts` from the stored points, never stored.
 *
 * Rules, one per tool:
 * - Fibonacci retracement (points a, b): level price = b + (a - b) * level, so level 0 sits on the second point and level 1
 *   on the first. The default list is 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1 and the person can edit it.
 * - Fibonacci extension (points a, b, c): level price = c + (b - a) * level. Default list 0, 0.618, 1, 1.618, 2.618.
 * - Gann fan (points a, b): rays from a, each with slope = (b - a) per bar times a ratio from GANN_FAN_RATIOS. The 1 ratio
 *   ray passes through b.
 * - Gann box (points a, b): the box between a and b, its diagonal a to b, and the halves of both sides.
 * - Position box (long or short; points entry, stop, target): long needs stop < entry < target, short the reverse. Risk is
 *   |entry - stop|, reward is |target - entry|, ratio is reward / risk to two places. Zero risk and the wrong side refuse.
 * - Measure and info line (points a, b): bars is the difference of bar indices, the price difference is b - a at the tick,
 *   the percentage is (b - a) / a, and the time span is the difference of bar times.
 * - Collinear points (pitchfork) are checked exactly with scaled integers, not floats.
 */
import { dec, diffAtTick, percentChange, ratioText, roundToTick, sub, times, ratio, type Decimal, type Scaled } from './decimal';

export interface Pt {
  /** Bar open time, epoch seconds. */
  time: number;
  /** Decimal price at the market's tick size. */
  price: Decimal;
}

export const FIB_LEVELS: readonly Decimal[] = ['0', '0.236', '0.382', '0.5', '0.618', '0.786', '1'];
export const EXTENSION_LEVELS: readonly Decimal[] = ['0', '0.618', '1', '1.618', '2.618'];
export const GANN_FAN_RATIOS: readonly Decimal[] = ['0.125', '0.25', '0.5', '1', '2', '4', '8'];

export type Refusal = 'degenerate' | 'collinear' | 'wrong-side' | 'no-risk' | 'bad-levels' | 'bad-price' | 'bad-tick' | 'outside-bars';

export interface LevelPrice {
  level: Decimal;
  price: Decimal;
}

/** Levels from two points, each `b + (a - b) * level`, at the tick. A blank or invalid level refuses the whole list. */
export function retracementPrices(a: Pt, b: Pt, levels: readonly Decimal[], tick: Decimal): LevelPrice[] | Refusal {
  const pa = dec(a.price);
  const pb = dec(b.price);
  if (pa === null || pb === null) return 'bad-price';
  return levelsFrom(sub(pa, pb), pb, levels, tick, (base, diff, r) => base + times(diff, r));
}

/** Extension levels from three points, each `c + (b - a) * level`, at the tick. */
export function extensionPrices(a: Pt, b: Pt, c: Pt, levels: readonly Decimal[], tick: Decimal): LevelPrice[] | Refusal {
  const pa = dec(a.price);
  const pb = dec(b.price);
  const pc = dec(c.price);
  if (pa === null || pb === null || pc === null) return 'bad-price';
  return levelsFrom(sub(pb, pa), pc, levels, tick, (base, diff, r) => base + times(diff, r));
}

function levelsFrom(
  diff: Scaled,
  base: Scaled | null,
  levels: readonly Decimal[],
  tick: Decimal,
  at: (base: Scaled, diff: Scaled, r: Scaled) => Scaled,
): LevelPrice[] | Refusal {
  if (base === null) return 'bad-price';
  if (levels.length === 0) return 'bad-levels';
  const out: LevelPrice[] = [];
  for (const level of levels) {
    const r = dec(level);
    if (r === null) return 'bad-levels';
    const price = roundToTick(at(base, diff, r), tick);
    if (price === null) return 'bad-tick';
    out.push({ level, price });
  }
  return out;
}

/** Exact collinearity of three points: (b - a) x (c - a) = 0, with times as whole seconds and prices as scaled decimals. */
export function collinear(a: Pt, b: Pt, c: Pt): boolean {
  const pa = dec(a.price);
  const pb = dec(b.price);
  const pc = dec(c.price);
  if (pa === null || pb === null || pc === null) return false;
  const dt1 = BigInt(b.time - a.time);
  const dp1 = pb - pa;
  const dt2 = BigInt(c.time - a.time);
  const dp2 = pc - pa;
  return dt1 * dp2 - dt2 * dp1 === 0n;
}

export interface PositionFigures {
  side: 'long' | 'short';
  entry: Decimal;
  stop: Decimal;
  target: Decimal;
  risk: Decimal;
  reward: Decimal;
  riskPct: Decimal;
  rewardPct: Decimal;
  /** Reward to risk, two places. */
  ratio: Decimal;
}

/** Position figures; refuses a stop or target on the wrong side of the entry, and zero risk. */
export function positionFigures(side: 'long' | 'short', entry: Pt, stop: Pt, target: Pt, tick: Decimal): PositionFigures | Refusal {
  const e = dec(entry.price);
  const s = dec(stop.price);
  const t = dec(target.price);
  if (e === null || s === null || t === null || dec(tick) === null) return 'bad-price';
  const rightSide = side === 'long' ? s < e && e < t : t < e && e < s;
  if (!rightSide) return 'wrong-side';
  const riskScaled = e > s ? e - s : s - e;
  const rewardScaled = t > e ? t - e : e - t;
  if (riskScaled === 0n) return 'no-risk';
  const risk = diffAtTick(entry.price, stop.price, tick);
  const reward = diffAtTick(entry.price, target.price, tick);
  const ratioValue = ratioText(rewardScaled, riskScaled);
  const riskPct = percentChange(entry.price, stop.price);
  const rewardPct = percentChange(entry.price, target.price);
  if (risk === null || reward === null || ratioValue === null || riskPct === null || rewardPct === null) return 'bad-tick';
  return {
    side,
    entry: entry.price,
    stop: stop.price,
    target: target.price,
    risk: stripSign(risk),
    reward: stripSign(reward),
    riskPct: stripSign(riskPct),
    rewardPct: stripSign(rewardPct),
    ratio: ratioValue,
  };
}

const stripSign = (value: Decimal): Decimal => value.replace(/^-/, '');

export interface MeasureFigures {
  bars: number;
  priceDiff: Decimal;
  pct: Decimal | null;
  span: string;
}

/**
 * Measure figures between two points. `indexOf` maps a bar time to its index in the loaded bars, or null when the time has no
 * bar on this interval; such a measure refuses as outside the bars instead of counting clamped bars. The price change keeps
 * its sign: from 100 to 90 is -10 (-10.00%).
 */
export function measureFigures(a: Pt, b: Pt, tick: Decimal, indexOf: (time: number) => number | null): MeasureFigures | Refusal {
  const diff = diffAtTick(a.price, b.price, tick);
  if (diff === null) return 'bad-price';
  const ia = indexOf(a.time);
  const ib = indexOf(b.time);
  if (ia === null || ib === null) return 'outside-bars';
  return {
    bars: Math.abs(ib - ia),
    priceDiff: diff,
    pct: percentChange(a.price, b.price),
    span: formatSpan(Math.abs(b.time - a.time)),
  };
}

/** A whole-second span as "2d 04h 30m" (days, hours, minutes). */
export function formatSpan(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
}

/**
 * Magnet: among the candidate prices (the bar's open, high, low and close), the one nearest the pointer, if it is within
 * `sensitivityPx` pixels of the pointer. `yOf` maps a decimal price to a canvas y. Null means no snap.
 */
export function magnetSnap(
  candidates: readonly Decimal[],
  pointerY: number,
  yOf: (price: Decimal) => number | null,
  sensitivityPx: number,
): Decimal | null {
  let best: Decimal | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const y = yOf(candidate);
    if (y === null || !Number.isFinite(y)) continue;
    const distance = Math.abs(y - pointerY);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best !== null && bestDistance <= sensitivityPx ? best : null;
}

/** The bar's four prices as decimals, in snap order. */
export const barPrices = (bar: { o: Decimal; h: Decimal; l: Decimal; c: Decimal }): Decimal[] => [bar.o, bar.h, bar.l, bar.c];

/** Gann fan ray slopes, in price per bar: the base slope from a to b times each ratio. */
export function gannSlopes(
  a: Pt,
  b: Pt,
  tick: Decimal,
  indexOf: (time: number) => number | null,
): Array<{ ratio: Decimal; slope: Decimal }> | Refusal {
  const ia = indexOf(a.time);
  const ib = indexOf(b.time);
  if (ia === null || ib === null) return 'outside-bars';
  const dx = ib - ia;
  const pa = dec(a.price);
  const pb = dec(b.price);
  if (pa === null || pb === null) return 'bad-price';
  if (dx === 0) return 'degenerate';
  const base = ratio(pb - pa, BigInt(dx) * 10n ** 18n);
  if (base === null) return 'degenerate';
  const out: Array<{ ratio: Decimal; slope: Decimal }> = [];
  for (const r of GANN_FAN_RATIOS) {
    const rs = dec(r);
    if (rs === null) return 'bad-levels';
    const slope = roundToTick(times(base, rs), tick);
    if (slope === null) return 'bad-tick';
    out.push({ ratio: r, slope });
  }
  return out;
}
