// Fixed test vectors for the study maths. Every expected value is worked by hand from the formula in math.ts.
import { describe, expect, it } from 'vitest';
import type { Candle } from '../../../data/types';
import {
  DAY_MS,
  bollinger,
  classicPivots,
  countSignals,
  cumulative,
  ema,
  formatAt,
  higherTimeframeSma,
  ichimoku,
  macd,
  priorDayFor,
  rsi,
  ratingScore,
  ratingSignals,
  roundToDecimals,
  sessionVwap,
  sma,
  stochastic,
  volumeDelta,
  volumeOf,
  volumeProfile,
  type Print,
} from './math';

const bar = (t: number, h: string, l: string, c: string, v = '1', filled = false): Candle => ({ t, o: c, h, l, c, v, filled });
const flat = (n: number, price: string, step = 60_000): Candle[] => Array.from({ length: n }, (_, i) => bar(i * step, price, price, price));

describe('rounding to the tick', () => {
  it('rounds half away from zero to the tick decimals and never shows exponent form', () => {
    expect(formatAt(2.345, 2)).toBe('2.35');
    expect(formatAt(0.1 + 0.2, 2)).toBe('0.30');
    expect(formatAt(-2.5, 0)).toBe('-3');
    expect(roundToDecimals(1.005, 2)).toBe(1.01);
    expect(formatAt(0.0000001, 8)).toBe('0.00000010');
  });

  it('rounds a true half up at chart prices, where the binary mean falls just under it', () => {
    // 19 x 64990.07 + 64991.17 = 1299802.50, a mean of exactly 64990.125; the binary sum gives 64990.124999999985.
    const closes = [...Array.from({ length: 19 }, () => 64990.07), 64991.17];
    expect(formatAt(sma(closes, 20).at(-1)!, 2)).toBe('64990.13');
    // Means of 20 two-decimal closes as the binary sum gives them, for a true 64990.055 and 65102.175.
    expect(formatAt(64990.05499999998, 2)).toBe('64990.06');
    expect(formatAt(65102.174999999974, 2)).toBe('65102.18');
    // A value a real distance under the half still rounds down.
    expect(formatAt(64990.0545, 2)).toBe('64990.05');
  });
});

describe('moving averages', () => {
  it('SMA is the mean of the last period values, null before the first full window', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('SMA is null for a window that holds a gap', () => {
    expect(sma([1, null, 3, 4], 2)).toEqual([null, null, null, 3.5]);
  });

  it('EMA seeds with the SMA of the first period, then a = 2 / (period + 1)', () => {
    // a = 0.5. Seed at index 2: (1 + 2 + 3) / 3 = 2. Index 3: 0.5 * 4 + 0.5 * 2 = 3. Index 4: 0.5 * 5 + 0.5 * 3 = 4.
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('EMA restarts its seed after a gap and never carries a value across it', () => {
    // a = 2/3. Seed at index 1: (1 + 2) / 2 = 1.5. Gap at 2. Seed at index 4: (3 + 4) / 2 = 3.5.
    // Index 5: (2/3) * 5 + (1/3) * 3.5 = 4.5.
    expect(ema([1, 2, null, 3, 4, 5], 2)).toEqual([null, 1.5, null, null, 3.5, 4.5]);
  });
});

describe('RSI (Wilder)', () => {
  it('is 100 when every change is a gain', () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 3)).toEqual([null, null, null, 100, 100, 100]);
  });

  it('follows the smoothed gains and losses for alternating moves', () => {
    // Changes +1, -1, +1, -1 with period 2. Seed gain 0.5, loss 0.5: RSI 50. Next: gain 0.75, loss 0.25: RSI 75.
    // Next: gain 0.375, loss 0.625, RS 0.6: RSI 37.5.
    const out = rsi([10, 11, 10, 11, 10], 2);
    expect(out[2]).toBeCloseTo(50, 10);
    expect(out[3]).toBeCloseTo(75, 10);
    expect(out[4]).toBeCloseTo(37.5, 10);
  });

  it('omits the value for a flat series instead of drawing zero', () => {
    expect(rsi([5, 5, 5, 5], 2)).toEqual([null, null, null, null]);
  });
});

describe('MACD', () => {
  it('is zero on a flat series, starts at the slow period and the signal after its own seed', () => {
    const out = macd(
      Array.from({ length: 40 }, () => 7),
      12,
      26,
      9,
    );
    expect(out.line[25]).toBe(0);
    expect(out.line[24]).toBeNull();
    expect(out.signal[33]).toBe(0);
    expect(out.signal[32]).toBeNull();
    expect(out.histogram[33]).toBe(0);
  });
});

describe('stochastic', () => {
  it('%K = (close - lowest low) / (highest high - lowest low) * 100 over k bars', () => {
    const bars = [bar(0, '10', '8', '9'), bar(1, '12', '9', '11'), bar(2, '11', '7', '8')];
    const out = stochastic(bars, 3, 1);
    // At index 2: highest high 12, lowest low 7, close 8: (8 - 7) / 5 * 100 = 20.
    expect(out.k[2]).toBeCloseTo(20, 10);
    expect(out.d[2]).toBeCloseTo(20, 10);
  });

  it('is null when the range is zero', () => {
    expect(stochastic(flat(3, '5'), 3, 1).k).toEqual([null, null, null]);
  });
});

describe('Bollinger Bands', () => {
  it('uses the population standard deviation (divide by the period)', () => {
    const out = bollinger([1, 2, 3, 4, 5], 3, 2);
    // Index 2: mean 2, variance (1 + 0 + 1) / 3 = 2/3, sigma = sqrt(2/3).
    expect(out.middle[2]).toBeCloseTo(2, 10);
    expect(out.upper[2]).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3), 10);
    expect(out.lower[2]).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3), 10);
    expect(out.upper[1]).toBeNull();
  });
});

describe('volume and VWAP', () => {
  it('a filled bar or a zero volume has no volume: null, not zero', () => {
    expect(volumeOf(bar(0, '1', '1', '1', '2.5'))).toBe(2.5);
    expect(volumeOf(bar(0, '1', '1', '1', '0'))).toBeNull();
    expect(volumeOf(bar(0, '1', '1', '1', '2.5', true))).toBeNull();
  });

  it('session VWAP is the volume-weighted typical price from the start of the UTC day', () => {
    // Typical price of bar 1 is 10 (volume 1), of bar 2 is 20 (volume 3): (10 * 1 + 20 * 3) / 4 = 17.5.
    const bars = [bar(0, '10', '10', '10', '1'), bar(60_000, '20', '20', '20', '3')];
    expect(sessionVwap(bars)).toEqual([10, 17.5]);
  });

  it('resets at the next UTC day and stays null while there is no volume', () => {
    const bars = [bar(0, '10', '10', '10', '1'), bar(DAY_MS, '5', '5', '5', '0')];
    expect(sessionVwap(bars)).toEqual([10, null]);
  });
});

describe('Ichimoku', () => {
  it('the conversion line is the midpoint of the highest high and lowest low over its period', () => {
    const bars = Array.from({ length: 12 }, (_, i) => bar(i * 60_000, String(10 + i), String(5 + i), String(7 + i)));
    const lines = ichimoku(bars, 9, 26, 52);
    // Index 8 covers bars 0..8: highest high 18, lowest low 5: (18 + 5) / 2 = 11.5.
    expect(lines.tenkan[8]).toBeCloseTo(11.5, 10);
    expect(lines.tenkan[7]).toBeNull();
  });

  it('with 40 bars span B (52 bars) and so the cloud are absent, while span A is present', () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(i * 60_000, String(100 + i), String(99 + i), String(100 + i)));
    const lines = ichimoku(bars, 9, 26, 52);
    expect(lines.spanB.every((v) => v === null)).toBe(true);
    expect(lines.spanA[25]).not.toBeNull();
    expect(lines.kijun[25]).not.toBeNull();
  });
});

describe('pivot points and prior day levels', () => {
  // Hourly bars over two UTC days, close 100 + i, high one above, low one below.
  const hourly = Array.from({ length: 48 }, (_, i) => {
    const c = 100 + i;
    return bar(i * 3_600_000, String(c + 1), String(c - 1), String(c));
  });

  it('the prior day is the previous whole UTC day: its high, low and last close', () => {
    const prior = priorDayFor(hourly, 3_600_000);
    expect(prior[0]).toBeNull();
    expect(prior[24]).toEqual({ high: 124, low: 99, close: 123 });
  });

  it('a prior day that is not whole in the loaded bars gives no levels', () => {
    const partial = hourly.slice(1, 30);
    expect(priorDayFor(partial, 3_600_000)[25]).toBeNull();
  });

  it('classic pivots from H, L, C', () => {
    const levels = classicPivots({ high: 124, low: 99, close: 123 });
    const P = (124 + 99 + 123) / 3;
    expect(levels.P).toBeCloseTo(P, 10);
    expect(levels.R1).toBeCloseTo(2 * P - 99, 10);
    expect(levels.S1).toBeCloseTo(2 * P - 124, 10);
    expect(levels.R2).toBeCloseTo(P + 25, 10);
    expect(levels.S2).toBeCloseTo(P - 25, 10);
    expect(levels.R3).toBeCloseTo(124 + 2 * (P - 99), 10);
    expect(levels.S3).toBeCloseTo(99 - 2 * (124 - P), 10);
  });

  it('a weekly chart has no prior day inside its own bars', () => {
    const weekly = [bar(0, '2', '1', '1.5'), bar(7 * DAY_MS, '3', '2', '2.5')];
    expect(priorDayFor(weekly, 7 * DAY_MS)).toEqual([null, null]);
  });
});

describe('technical rating', () => {
  it('counts the signals and leaves the missing ones out of the buy, neutral and sell counts', () => {
    // 210 flat bars: every moving average equals the close (neutral), MACD is 0 against 0 (neutral), and RSI and
    // Stochastic have no value on a flat series.
    const signals = ratingSignals(flat(210, '5'));
    expect(countSignals(signals)).toEqual({ buy: 0, neutral: 7, sell: 0, missing: 2 });
  });

  it('the score needs every weight; a blank weight means no score', () => {
    const signals = ratingSignals(flat(210, '5'));
    const all = Object.fromEntries(signals.map((s) => [s.id, 1]));
    expect(ratingScore(signals, all)).toBe(0);
    expect(ratingScore(signals, { ...all, rsi14: null })).toBeNull();
    expect(ratingScore(signals, { ...all, macd: undefined })).toBeNull();
  });
});

describe('tape-based series', () => {
  const step = 60_000;
  const bars = [bar(0, '1', '1', '1'), bar(step, '1', '1', '1'), bar(2 * step, '1', '1', '1')];

  it('volume delta is buy minus sell per bar; a bar with no prints is absent, not zero', () => {
    const prints: Print[] = [
      { t: 0, side: 'buy', amount: '2', price: '1' },
      { t: 30_000, side: 'sell', amount: '1', price: '1' },
      { t: step, side: 'buy', amount: '5', price: '1' },
    ];
    expect(volumeDelta(bars, prints, step)).toEqual([{ buy: 2, sell: 1, delta: 1 }, { buy: 5, sell: 0, delta: 5 }, null]);
  });

  it('a bar the tape only partly covers is absent', () => {
    const prints: Print[] = [{ t: 30_000, side: 'buy', amount: '2', price: '1' }];
    const out = volumeDelta(bars, prints, step);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
  });

  it('cumulative delta skips the bars that have no value', () => {
    expect(cumulative([1, null, 2])).toEqual([1, null, 3]);
  });

  it('volume profile sums prints into equal price bins, and the point of control is the busiest bin', () => {
    const prints: Print[] = [
      { t: 0, side: 'buy', amount: '1', price: '10' },
      { t: 1, side: 'sell', amount: '2', price: '20' },
      { t: 2, side: 'buy', amount: '1', price: '20' },
    ];
    const profile = volumeProfile(prints, 2);
    expect(profile?.bins.map((b) => [b.buy, b.sell])).toEqual([
      [1, 0],
      [1, 2],
    ]);
    expect(profile?.poc).toBe(1);
  });

  it('no prints means no profile', () => {
    expect(volumeProfile([], 4)).toBeNull();
  });

  it('a higher-timeframe average uses only bars closed by the end of the chart bar', () => {
    const hour = 3_600_000;
    const higher = [bar(0, '10', '10', '10'), bar(4 * hour, '20', '20', '20')];
    const base = Array.from({ length: 8 }, (_, i) => bar(i * hour, '1', '1', '1'));
    // A 4h bar closes at its open plus 4h. The 0h bar closes at 4h, so the 1h..2h bars have nothing closed yet.
    // The 4h bar closes at 8h, so only the 7h bar (closed by 8h) reads it.
    expect(higherTimeframeSma(base, higher, 1, 'close', hour, 4 * hour)).toEqual([null, null, null, 10, 10, 10, 10, 20]);
  });
});
