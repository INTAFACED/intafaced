import { expect } from '@playwright/test';
import { EDGE } from './stack.mjs';

// What the charts-desk study journeys share: the bars the workbench chart holds, worked from the public candle route the
// chart itself reads, and each study's formula worked here, independently of the app (studies/math.ts states them).

const SYMBOL = 'BTC/USDT';
export const STEP_MS = { '1m': 60_000, '15m': 900_000, '1h': 3_600_000, '2h': 7_200_000, '1d': 86_400_000 };

/**
 * The bars the chart holds at an interval, worked here from the public candles as the chart builds them: the last 240 buckets up
 * to the current one (from the first that traded when the market is younger), a quiet bucket filled with the previous
 * close (o = h = l = c, no volume). Each bar: { t, o, h, l, c, v, filled } with numbers.
 */
export async function chartBars(interval = '15m') {
  const step = STEP_MS[interval];
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent(SYMBOL)}?timeframe=${interval}&limit=240`);
  if (!res.ok) throw new Error(`the public candle route answered ${res.status}`);
  const rows = (await res.json()).sort((a, b) => a[0] - b[0]);
  if (rows.length === 0) throw new Error('the public candle route has no BTC/USDT bars; is the TEST market maker running?');
  const byBucket = new Map(rows.map((r) => [Math.floor(r[0] / step) * step, r]));
  const end = Math.max(Math.floor(Date.now() / step) * step, ...byBucket.keys());
  const from = Math.max(Math.min(...byBucket.keys()), end - 239 * step);
  let carry = null;
  for (const [t, r] of [...byBucket].sort(([a], [b]) => a - b)) if (t < from) carry = Number(r[4]);
  const bars = [];
  for (let t = from; t <= end; t += step) {
    const r = byBucket.get(t);
    if (r) {
      bars.push({ t, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]), filled: false });
      carry = Number(r[4]);
    } else if (carry !== null) bars.push({ t, o: carry, h: carry, l: carry, c: carry, v: 0, filled: true });
  }
  return bars;
}

/** Each formula, worked independently of the app (the definitions in studies/math.ts's comments). Index i is a bar. */
export const F = {
  /** Wilder RSI: the first average gain and loss over `p` changes, then smoothed (p - 1) / p. */
  rsiLine(xs, p) {
    const out = xs.map(() => null);
    if (xs.length <= p) return out;
    let [gain, loss] = [0, 0];
    for (let i = 1; i <= p; i += 1) {
      const d = xs[i] - xs[i - 1];
      if (d > 0) gain += d;
      else loss -= d;
    }
    [gain, loss] = [gain / p, loss / p];
    // A flat window has no RSI (no value, never 0 or 50).
    const value = (g, l) => (g === 0 && l === 0 ? null : l === 0 ? 100 : 100 - 100 / (1 + g / l));
    out[p] = value(gain, loss);
    for (let i = p + 1; i < xs.length; i += 1) {
      const d = xs[i] - xs[i - 1];
      gain = (gain * (p - 1) + Math.max(d, 0)) / p;
      loss = (loss * (p - 1) + Math.max(-d, 0)) / p;
      out[i] = value(gain, loss);
    }
    return out;
  },
  /** The midpoint of the highest high and lowest low over the last `p` bars (Ichimoku's lines). */
  midpoint(bars, p, i) {
    if (i < p - 1) return null;
    const win = bars.slice(i - p + 1, i + 1);
    return (Math.max(...win.map((b) => b.h)) + Math.min(...win.map((b) => b.l))) / 2;
  },
  /** Classic pivots from the prior day's high, low and close. */
  pivots({ high: H, low: L, close: C }) {
    const P = (H + L + C) / 3;
    return { P, R1: 2 * P - L, S1: 2 * P - H, R2: P + (H - L), S2: P - (H - L), R3: H + 2 * (P - L), S3: L - 2 * (H - P) };
  },
  sma: (xs, p, i) => (i < p - 1 ? null : xs.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p),
  emaLine(xs, p) {
    const a = 2 / (p + 1);
    const out = xs.map(() => null);
    let prev = null;
    let run = 0;
    xs.forEach((x, i) => {
      if (x === null) {
        run = 0;
        prev = null;
        return;
      }
      run += 1;
      if (prev === null) {
        if (run < p) return;
        prev = xs.slice(i - p + 1, i + 1).reduce((s, y) => s + y, 0) / p;
      } else prev = a * x + (1 - a) * prev;
      out[i] = prev;
    });
    return out;
  },
  macd(closes, fast, slow, signal) {
    const [f, s] = [F.emaLine(closes, fast), F.emaLine(closes, slow)];
    const line = closes.map((_, i) => (f[i] === null || s[i] === null ? null : f[i] - s[i]));
    const sig = F.emaLine(line, signal);
    return { line, signal: sig, histogram: line.map((m, i) => (m === null || sig[i] === null ? null : m - sig[i])) };
  },
  stochK(bars, k, i) {
    if (i < k - 1) return null;
    const win = bars.slice(i - k + 1, i + 1);
    const [hi, lo] = [Math.max(...win.map((b) => b.h)), Math.min(...win.map((b) => b.l))];
    return hi === lo ? null : ((bars[i].c - lo) / (hi - lo)) * 100;
  },
  bollinger(closes, p, m, i) {
    const mid = F.sma(closes, p, i);
    const sigma = Math.sqrt(closes.slice(i - p + 1, i + 1).reduce((a, x) => a + (x - mid) ** 2, 0) / p);
    return { upper: mid + m * sigma, middle: mid, lower: mid - m * sigma };
  },
  vwap(bars, i) {
    const day = Math.floor(bars[i].t / 86_400_000);
    let pv = 0;
    let v = 0;
    for (const b of bars.slice(0, i + 1)) {
      if (Math.floor(b.t / 86_400_000) !== day || b.filled || !(b.v > 0)) continue;
      pv += ((b.h + b.l + b.c) / 3) * b.v;
      v += b.v;
    }
    return v === 0 ? null : pv / v;
  },
};

/** A study line's shown value at the legend's bar, by the series name the legend writes. */
export const shownValue = (page, id, name) =>
  page.locator(`[data-study="${id}"]`).locator(`[data-series="${name}"] .st-value-text`).first();

/**
 * Waits until every listed line of a study shows its worked value to the tick: the shown number is the worked value
 * rounded at `digits` (within half a unit of the last digit, so an exact half rounds either way), or "—" where the
 * formula has no value. `work(bars)` returns { name: value or null } at the last bar.
 */
export async function expectLines(page, id, digits, work, interval = '15m') {
  await expect
    .poll(
      async () => {
        const values = work(await chartBars(interval));
        const checks = [];
        for (const [name, value] of Object.entries(values)) {
          const text = (
            (await shownValue(page, id, name)
              .textContent({ timeout: 2_000 })
              .catch(() => null)) ?? ''
          ).trim();
          const ok =
            value === null
              ? text === '—'
              : /^-?\d+(\.\d+)?$/.test(text) &&
                text.split('.')[1]?.length === (digits || undefined) &&
                Math.abs(Number(text) - value) <= 0.5 * 10 ** -digits + 1e-9;
          checks.push(ok);
          if (!ok) return false;
        }
        return checks.length > 0;
      },
      { timeout: 30_000, message: `the ${id} legend never showed the values worked from the bars` },
    )
    .toBe(true);
}
