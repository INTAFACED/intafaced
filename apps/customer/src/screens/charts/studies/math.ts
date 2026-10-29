/**
 * Indicator maths for the chart workbench. Pure functions, no I/O, no React.
 *
 * Bars are the chart's own candles, whose prices are decimal strings. The arithmetic below reads them as numbers (display
 * arithmetic, the same use the desk's chart-data makes), and every value a study shows or draws is rounded to the market's
 * tick (`roundToDecimals`, `formatAt`) before it leaves the study layer. A study value never feeds an order or a ledger.
 *
 * `null` means "no value here": too few bars, a flat series, a bucket with no volume or no prints. It is never zero.
 */
import type { Candle } from '../../../data/types';

export type Maybe = number | null;
export const DAY_MS = 86_400_000;

export const SOURCES = ['close', 'open', 'high', 'low', 'median', 'typical', 'weighted'] as const;
export type SourceName = (typeof SOURCES)[number];

/** The price a study reads from one bar. median = (H+L)/2; typical = (H+L+C)/3; weighted = (H+L+2C)/4. */
export function sourceValue(candle: Candle, source: SourceName): number {
  const o = Number(candle.o);
  const h = Number(candle.h);
  const l = Number(candle.l);
  const c = Number(candle.c);
  const pick: Record<SourceName, number> = {
    close: c,
    open: o,
    high: h,
    low: l,
    median: (h + l) / 2,
    typical: (h + l + c) / 3,
    weighted: (h + l + 2 * c) / 4,
  };
  return pick[source];
}

export const sourceSeries = (bars: readonly Candle[], source: SourceName): number[] => bars.map((bar) => sourceValue(bar, source));

/**
 * Round half away from zero to `digits` decimals. A value worked in binary arithmetic lands a little under a true half
 * (the mean of 20 closes, 64990.055, sums to 64990.05499999998), so the nudge that lifts it back over the half grows with
 * the value: a fixed 1e-9 is under one unit in the last place once the scaled value passes a few million, and the legend
 * then showed 64990.05 where the formula gives 64990.06. 1e-13 of the value is far above that error and far below the
 * gap between a real value and the half (a mean of two-decimal prices is never nearer to it than 0.05 of the last digit).
 */
export function roundToDecimals(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = Math.abs(value) * factor;
  const rounded = Math.round(scaled + Math.max(1e-9, scaled * 1e-13)) / factor;
  return value < 0 ? -rounded : rounded;
}

/** The text shown for a value: rounded to `digits` decimals (the market tick's decimals), never in exponent form. */
export const formatAt = (value: number, digits: number): string => roundToDecimals(value, digits).toFixed(digits);

/**
 * Simple moving average: the mean of the last `period` values. SMA_i = (v_(i-p+1) + ... + v_i) / p. The first p-1 entries
 * are null; a window that holds a null is null.
 */
export function sma(values: readonly Maybe[], period: number): Maybe[] {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let k = i - period + 1; k <= i; k += 1) {
      const v = values[k];
      if (v === null || v === undefined) return null;
      sum += v;
    }
    return sum / period;
  });
}

/**
 * Exponential moving average. Seed: the SMA of the first p values. Then EMA_i = a * v_i + (1 - a) * EMA_(i-1) with
 * a = 2 / (p + 1). A null value restarts the seed: no value is carried across a gap.
 */
export function ema(values: readonly Maybe[], period: number): Maybe[] {
  const out: Maybe[] = values.map(() => null);
  const a = 2 / (period + 1);
  let run = 0;
  let prev: number | null = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v === null || v === undefined) {
      run = 0;
      prev = null;
      continue;
    }
    run += 1;
    if (prev === null) {
      if (run < period) continue;
      let sum = 0;
      for (let k = i - period + 1; k <= i; k += 1) sum += values[k] as number;
      prev = sum / period;
    } else {
      prev = a * v + (1 - a) * prev;
    }
    out[i] = prev;
  }
  return out;
}

const rsiValue = (gain: number, loss: number): Maybe => {
  // A flat window (no gain and no loss) has no RSI: the value is omitted, never drawn as 0 or 50.
  if (gain === 0 && loss === 0) return null;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
};

/**
 * Relative Strength Index with Wilder's smoothing. Changes d_i = C_i - C_(i-1). The first average gain and loss are the
 * mean of the first p changes; then avg_i = (avg_(i-1) * (p - 1) + current) / p. RSI = 100 - 100 / (1 + avgGain / avgLoss).
 */
export function rsi(closes: readonly number[], period: number): Maybe[] {
  const out: Maybe[] = closes.map(() => null);
  if (period < 1 || closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = rsiValue(gain, loss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsiValue(gain, loss);
  }
  return out;
}

/** MACD: line = EMA(fast) - EMA(slow); signal = EMA(signal period) of the line; histogram = line - signal. */
export function macd(closes: readonly number[], fast: number, slow: number, signalPeriod: number) {
  const fastLine = ema(closes, fast);
  const slowLine = ema(closes, slow);
  const line: Maybe[] = closes.map((_, i) => (fastLine[i] == null || slowLine[i] == null ? null : fastLine[i]! - slowLine[i]!));
  const signal = ema(line, signalPeriod);
  const histogram: Maybe[] = line.map((m, i) => (m == null || signal[i] == null ? null : m - signal[i]!));
  return { line, signal, histogram };
}

/**
 * Stochastic: %K = (C - lowest low over k bars) / (highest high - lowest low) * 100, null when that range is 0.
 * %D = SMA of %K over d bars.
 */
export function stochastic(bars: readonly Candle[], k: number, d: number): { k: Maybe[]; d: Maybe[] } {
  const kLine: Maybe[] = bars.map((_, i) => {
    if (i < k - 1) return null;
    let high = -Infinity;
    let low = Infinity;
    for (let j = i - k + 1; j <= i; j += 1) {
      high = Math.max(high, Number(bars[j]!.h));
      low = Math.min(low, Number(bars[j]!.l));
    }
    const range = high - low;
    return range === 0 ? null : ((Number(bars[i]!.c) - low) / range) * 100;
  });
  return { k: kLine, d: sma(kLine, d) };
}

/**
 * Bollinger Bands: middle = SMA(p); upper / lower = middle +/- m * sigma, where sigma is the POPULATION standard deviation
 * of the last p values (divide by p, not p - 1).
 */
export function bollinger(values: readonly number[], period: number, multiplier: number) {
  const middle = sma(values, period);
  const upper: Maybe[] = [];
  const lower: Maybe[] = [];
  values.forEach((_, i) => {
    const mid = middle[i];
    if (mid === null || mid === undefined) {
      upper.push(null);
      lower.push(null);
      return;
    }
    let variance = 0;
    for (let k = i - period + 1; k <= i; k += 1) variance += (values[k]! - mid) ** 2;
    const sigma = Math.sqrt(variance / period);
    upper.push(mid + multiplier * sigma);
    lower.push(mid - multiplier * sigma);
  });
  return { upper, middle, lower };
}

/** The volume of one bar, or null when the bar carries none (a filled bar or a zero volume: no volume data, not zero). */
export function volumeOf(candle: Candle): Maybe {
  if (candle.filled) return null;
  const v = Number(candle.v);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Session VWAP. Typical price T = (H + L + C) / 3. VWAP = sum(T * V) / sum(V) from the start of the UTC day: the session
 * resets at each UTC midnight. A bar without volume adds nothing; the value is null until a bar with volume is seen.
 */
export function sessionVwap(bars: readonly Candle[]): Maybe[] {
  let sumPV = 0;
  let sumV = 0;
  let day = Number.NaN;
  return bars.map((bar) => {
    const d = Math.floor(bar.t / DAY_MS);
    if (d !== day) {
      day = d;
      sumPV = 0;
      sumV = 0;
    }
    const v = volumeOf(bar);
    if (v !== null) {
      const typical = (Number(bar.h) + Number(bar.l) + Number(bar.c)) / 3;
      sumPV += typical * v;
      sumV += v;
    }
    return sumV === 0 ? null : sumPV / sumV;
  });
}

/** Midpoint of the highest high and lowest low over n bars: (HH + LL) / 2. The first n-1 entries are null. */
export function midpoint(bars: readonly Candle[], n: number): Maybe[] {
  return bars.map((_, i) => {
    if (i < n - 1) return null;
    let high = -Infinity;
    let low = Infinity;
    for (let j = i - n + 1; j <= i; j += 1) {
      high = Math.max(high, Number(bars[j]!.h));
      low = Math.min(low, Number(bars[j]!.l));
    }
    return (high + low) / 2;
  });
}

export interface IchimokuLines {
  /** Conversion line: midpoint over `tenkan` bars. */
  tenkan: Maybe[];
  /** Base line: midpoint over `kijun` bars. */
  kijun: Maybe[];
  /** Leading span A: (tenkan + kijun) / 2, drawn `shift` bars ahead. Index-aligned to the bar it was computed on. */
  spanA: Maybe[];
  /** Leading span B: midpoint over `senkou` bars, drawn `shift` bars ahead. */
  spanB: Maybe[];
  /** Lagging span: the close, drawn `shift` bars back. Index-aligned to the bar the close belongs to. */
  lagging: Maybe[];
}

/**
 * Ichimoku. The displacement is the Kijun period (the standard sets them equal). Span B needs `senkou` bars: with fewer
 * bars it is all null, and so is the cloud between A and B, so no cloud is invented. Span A needs the Kijun.
 */
export function ichimoku(bars: readonly Candle[], tenkan: number, kijun: number, senkou: number): IchimokuLines {
  const t = midpoint(bars, tenkan);
  const k = midpoint(bars, kijun);
  const a: Maybe[] = bars.map((_, i) => (t[i] == null || k[i] == null ? null : (t[i]! + k[i]!) / 2));
  return { tenkan: t, kijun: k, spanA: a, spanB: midpoint(bars, senkou), lagging: bars.map((bar) => Number(bar.c)) };
}

export interface PriorDay {
  high: number;
  low: number;
  close: number;
}

/**
 * The prior UTC day's high, low and close, for each bar's day (null where the prior day is not whole in the loaded bars).
 * A day is whole when its first bar opens at midnight and its last bar covers the end of the day. `stepMs` must be a day
 * or finer: a weekly chart has no daily levels.
 */
export function priorDayFor(bars: readonly Candle[], stepMs: number): Array<PriorDay | null> {
  const days = new Map<number, { first: number; last: number; high: number; low: number; close: number }>();
  for (const bar of bars) {
    const key = Math.floor(bar.t / DAY_MS);
    const high = Number(bar.h);
    const low = Number(bar.l);
    const cur = days.get(key);
    if (!cur) {
      days.set(key, { first: bar.t, last: bar.t, high, low, close: Number(bar.c) });
      continue;
    }
    cur.high = Math.max(cur.high, high);
    cur.low = Math.min(cur.low, low);
    cur.first = Math.min(cur.first, bar.t);
    if (bar.t >= cur.last) {
      cur.last = bar.t;
      cur.close = Number(bar.c);
    }
  }
  const whole = (key: number): boolean => {
    const day = days.get(key);
    return day !== undefined && day.first === key * DAY_MS && day.last + stepMs >= (key + 1) * DAY_MS;
  };
  return bars.map((bar) => {
    const key = Math.floor(bar.t / DAY_MS);
    if (!whole(key - 1)) return null;
    const prior = days.get(key - 1)!;
    return { high: prior.high, low: prior.low, close: prior.close };
  });
}

export interface PivotLevels {
  P: number;
  R1: number;
  R2: number;
  R3: number;
  S1: number;
  S2: number;
  S3: number;
}

/**
 * Classic pivot points from the prior day's H, L, C:
 *   P = (H + L + C) / 3
 *   R1 = 2P - L        S1 = 2P - H
 *   R2 = P + (H - L)   S2 = P - (H - L)
 *   R3 = H + 2(P - L)  S3 = L - 2(H - P)
 */
export function classicPivots(prior: PriorDay): PivotLevels {
  const { high: H, low: L, close: C } = prior;
  const P = (H + L + C) / 3;
  return {
    P,
    R1: 2 * P - L,
    S1: 2 * P - H,
    R2: P + (H - L),
    S2: P - (H - L),
    R3: H + 2 * (P - L),
    S3: L - 2 * (H - P),
  };
}

export type Signal = 1 | 0 | -1;
export interface RatingSignal {
  id: string;
  label: string;
  /** +1 buy, 0 neutral, -1 sell; null when the study has no value at the last bar. */
  value: Signal | null;
}
export interface RatingCounts {
  buy: number;
  neutral: number;
  sell: number;
  missing: number;
}

/**
 * The signals of the technical rating, read at the last bar. Fixed rules: a moving average is a buy when the close is
 * above it and a sell when below (equal: neutral); RSI(14) below 30 is a buy and above 70 a sell; Stochastic %K(14)
 * below 20 is a buy and above 80 a sell; MACD(12, 26, 9) is a buy when its line is above the signal line.
 */
export function ratingSignals(bars: readonly Candle[]): RatingSignal[] {
  const closes = bars.map((bar) => Number(bar.c));
  const last = closes.length - 1;
  const at = (series: readonly Maybe[]): Maybe => (last < 0 ? null : (series[last] ?? null));
  // Floating point: an average of a flat series can sit a rounding error above or below the close. Within that error the
  // two are equal (neutral), so a flat market is not read as a buy or a sell.
  const against = (value: Maybe, compare: Maybe): Signal | null => {
    if (value === null || compare === null) return null;
    const eps = 1e-9 * Math.max(1, Math.abs(compare));
    return value - compare > eps ? 1 : compare - value > eps ? -1 : 0;
  };
  const out: RatingSignal[] = [];
  for (const period of [20, 50, 200]) {
    out.push({ id: `sma${period}`, label: `SMA ${period}`, value: against(at(closes), at(sma(closes, period))) });
    out.push({ id: `ema${period}`, label: `EMA ${period}`, value: against(at(closes), at(ema(closes, period))) });
  }
  const rsiNow = at(rsi(closes, 14));
  out.push({ id: 'rsi14', label: 'RSI 14', value: rsiNow === null ? null : rsiNow < 30 ? 1 : rsiNow > 70 ? -1 : 0 });
  const stochNow = at(stochastic(bars, 14, 3).k);
  out.push({ id: 'stoch14', label: 'Stochastic %K 14', value: stochNow === null ? null : stochNow < 20 ? 1 : stochNow > 80 ? -1 : 0 });
  const m = macd(closes, 12, 26, 9);
  out.push({ id: 'macd', label: 'MACD 12 26 9', value: against(at(m.line), at(m.signal)) });
  return out;
}

export function countSignals(signals: readonly RatingSignal[]): RatingCounts {
  const counts: RatingCounts = { buy: 0, neutral: 0, sell: 0, missing: 0 };
  for (const s of signals) {
    if (s.value === null) counts.missing += 1;
    else if (s.value === 1) counts.buy += 1;
    else if (s.value === -1) counts.sell += 1;
    else counts.neutral += 1;
  }
  return counts;
}

/**
 * The weighted rating score in [-1, 1]: sum(weight * signal) / sum(weight), over the signals that have a value. Every
 * weight must be set (a number, zero or more) or there is no score. The weights are the owner's decision: this function
 * never fills one in.
 */
export function ratingScore(signals: readonly RatingSignal[], weights: Readonly<Record<string, number | null | undefined>>): number | null {
  let total = 0;
  let weightSum = 0;
  for (const s of signals) {
    const w = weights[s.id];
    if (w === null || w === undefined) return null;
    if (s.value === null) continue;
    total += w * s.value;
    weightSum += w;
  }
  return weightSum > 0 ? total / weightSum : null;
}

/** A public print of the tape, with the amount and price as the service sent them (decimal strings). */
export interface Print {
  /** Epoch ms. */
  t: number;
  side: 'buy' | 'sell';
  amount: string;
  price: string;
}

/**
 * Buy and sell volume per bar from the tape. A print belongs to the bar whose bucket holds it. The tape covers a bar only
 * from the first whole bucket after its first print: a bar the tape only partly covers is null, as is a bar with no prints.
 * Absent, never zero.
 */
/** The first bar time the tape covers: the first whole bucket after its first print. Null with no prints. */
export function tapeCoveredFrom(prints: readonly Print[], stepMs: number): number | null {
  if (prints.length === 0) return null;
  const first = prints.reduce((min, p) => Math.min(min, p.t), Number.POSITIVE_INFINITY);
  const bucketStart = Math.floor(first / stepMs) * stepMs;
  return first === bucketStart ? bucketStart : bucketStart + stepMs;
}

export function volumeDelta(bars: readonly Candle[], prints: readonly Print[], stepMs: number) {
  const coveredFrom = tapeCoveredFrom(prints, stepMs);
  const index = new Map<number, number>();
  bars.forEach((bar, i) => index.set(bar.t, i));
  const buy: number[] = bars.map(() => 0);
  const sell: number[] = bars.map(() => 0);
  const seen: boolean[] = bars.map(() => false);
  for (const print of prints) {
    const i = index.get(Math.floor(print.t / stepMs) * stepMs);
    if (i === undefined) continue;
    seen[i] = true;
    if (print.side === 'buy') buy[i] = buy[i]! + Number(print.amount);
    else sell[i] = sell[i]! + Number(print.amount);
  }
  return bars.map((bar, i) => {
    if (!seen[i] || coveredFrom === null || bar.t < coveredFrom) return null;
    return { buy: buy[i]!, sell: sell[i]!, delta: buy[i]! - sell[i]! };
  });
}

/** A running total over the values that are present (a null adds nothing and has no total). */
export function cumulative(values: readonly Maybe[]): Maybe[] {
  let total = 0;
  return values.map((v) => {
    if (v === null) return null;
    total += v;
    return total;
  });
}

export interface ProfileBin {
  low: number;
  high: number;
  buy: number;
  sell: number;
}
export interface Profile {
  bins: ProfileBin[];
  /** Index of the bin with the most volume (the first one on a tie). */
  poc: number | null;
}

/**
 * Volume profile: the prints' amounts summed into `count` equal price bins between the lowest and highest print price.
 * A print at the top price goes in the last bin. No prints: no profile (null), not bins of zeros.
 */
export function volumeProfile(prints: readonly Print[], count: number): Profile | null {
  if (prints.length === 0 || count < 1) return null;
  const prices = prints.map((p) => Number(p.price));
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const width = (hi - lo) / count;
  const bins: ProfileBin[] = Array.from({ length: count }, (_, i) => ({
    low: width === 0 ? lo : lo + i * width,
    high: width === 0 ? hi : lo + (i + 1) * width,
    buy: 0,
    sell: 0,
  }));
  prints.forEach((print, n) => {
    const raw = width === 0 ? 0 : Math.floor((prices[n]! - lo) / width);
    const bin = bins[Math.min(Math.max(raw, 0), count - 1)]!;
    if (print.side === 'buy') bin.buy += Number(print.amount);
    else bin.sell += Number(print.amount);
  });
  let poc: number | null = null;
  let best = -1;
  bins.forEach((bin, i) => {
    const total = bin.buy + bin.sell;
    if (total > best) {
      best = total;
      poc = i;
    }
  });
  return { bins, poc };
}

/**
 * A higher-timeframe simple moving average, aligned to the chart's bars. A higher bar is closed at its open plus its
 * interval. For a chart bar the value is that of the last higher bar closed by the end of the chart bar (its open plus the
 * chart step): a bar still forming is never read (no look-ahead).
 */
export function higherTimeframeSma(
  bars: readonly Candle[],
  higher: readonly Candle[],
  period: number,
  source: SourceName,
  stepMs: number,
  higherStepMs: number,
): Maybe[] {
  const values = sma(sourceSeries(higher, source), period);
  let k = -1;
  return bars.map((bar) => {
    const closedBy = bar.t + stepMs;
    while (k + 1 < higher.length && higher[k + 1]!.t + higherStepMs <= closedBy) k += 1;
    return k >= 0 ? (values[k] ?? null) : null;
  });
}
