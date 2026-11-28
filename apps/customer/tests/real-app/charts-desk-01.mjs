import { expect } from './journey.mjs';

export const STEP_MS = { '1m': 60_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000 };

export const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/**
 * The bars in view, as the chart writes them: logical bar indexes of its left and right edges, read together in one
 * call so a range change between them can't mix two views. NaN while the chart has written no range.
 */
export async function viewOf(chart) {
  return chart.evaluate((el) => {
    const read = (name) => (el.hasAttribute(name) ? Number(el.getAttribute(name)) : NaN);
    return { from: read('data-view-from'), to: read('data-view-to') };
  });
}

/** The bars in view once the chart has stopped moving them: the same range on two reads 200 ms apart. */
export async function settledViewOf(chart) {
  let last = null;
  let settled = null;
  await expect
    .poll(
      async () => {
        const v = await viewOf(chart);
        settled = last && Number.isFinite(v.from) && v.to - v.from > 0 && v.from === last.from && v.to === last.to ? v : null;
        last = v;
        return settled !== null;
      },
      { intervals: [200] },
    )
    .toBe(true);
  return settled;
}

/** What the drawing library holds, as the chart writes it back (see `writeDrawn` in WorkbenchChart.tsx). */
export async function drawnOf(chart) {
  return chart.evaluate((el) => ({
    type: el.getAttribute('data-drawn'),
    bars: Number(el.getAttribute('data-drawn-bars')),
    first: Number(el.getAttribute('data-drawn-first')),
    last: Number(el.getAttribute('data-drawn-last')),
    up: el.getAttribute('data-drawn-up'),
    down: el.getAttribute('data-drawn-down'),
    bg: el.getAttribute('data-drawn-bg'),
    format: el.getAttribute('data-drawn-format'),
    minMove: el.getAttribute('data-drawn-min-move'),
    held: Number(el.getAttribute('data-bars')),
    heldFirst: Number(el.getAttribute('data-first')),
    heldLast: Number(el.getAttribute('data-last')),
  }));
}

/** After an interval switch the newest bar of that interval is drawn and stays in view at the right edge. */
export async function keepsRightEdgeOf(chart, expectedLast) {
  await expect.poll(async () => (await drawnOf(chart)).heldLast, { timeout: 30_000 }).toBe(await expectedLast());
  const got = await drawnOf(chart);
  expect(got.last).toBe(got.heldLast);
  const v = await settledViewOf(chart);
  expect(v.to).toBeGreaterThanOrEqual(got.bars - 1);
  expect(v.from).toBeLessThan(got.bars - 1);
}

/**
 * The points the drawing library itself holds for the chart's main series, oldest first, read from the library's own
 * series object (`series.data()`), found through the chart component's refs on the page. No figure here is the app's
 * own copy of the bars: it is what the library draws.
 */
export async function libraryPointsOf(chart) {
  return chart.evaluate((el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    for (let fiber = key ? el[key] : null; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook && typeof hook === 'object' && 'next' in hook; hook = hook.next) {
        const series = hook.memoizedState?.current;
        if (series && typeof series.seriesType === 'function' && typeof series.data === 'function') {
          const points = series
            .data()
            .map((p) => ({ time: p.time, open: p.open, high: p.high, low: p.low, close: p.close, value: p.value }));
          const own = series.seriesType() === el.getAttribute('data-drawn') && String(points.length) === el.getAttribute('data-drawn-bars');
          return { type: series.seriesType(), points, own };
        }
      }
    }
    throw new Error('the chart holds no drawing-library series');
  });
}

/** Heikin Ashi from plain bars: close (O+H+L+C)/4, open the mean of the previous HA open and close ((O+C)/2 first). */
export function heikinAshiOf(bars) {
  const out = [];
  let prev = null;
  for (const b of bars) {
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = prev ? (prev.open + prev.close) / 2 : (b.open + b.close) / 2;
    out.push({ time: b.time, open, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), close });
    prev = { open, close };
  }
  return out;
}

/**
 * Whether the library's points are the glyph of `id` over these plain bars: point by point at the same times, each value
 * the style draws (OHLC for candles and bars, the averaged OHLC for Heikin Ashi, the close for line, area and columns).
 */
export function drawsAs(id, points, bars) {
  const start = bars.findIndex((b) => b.time === points[0]?.time);
  if (start < 0) return `the first point (${points[0]?.time}) is not one of the bars`;
  const base = bars.slice(start);
  if (points.length < base.length) return `drew ${points.length} points over ${base.length} bars`;
  if (points.length - base.length > 2) return `drew ${points.length - base.length} points past the bars`;
  const want = id === 'heikin-ashi' ? heikinAshiOf(base) : base;
  const fields = ['line', 'area', 'columns'].includes(id) ? [['value', 'close']] : ['open', 'high', 'low', 'close'].map((f) => [f, f]);
  for (let i = 0; i < points.length; i += 1) {
    const got = points[i];
    if (i >= base.length) {
      if (!(got.time > points[i - 1].time)) return `point ${i} at ${got.time} is not after the one before`;
      continue;
    }
    if (got.time !== want[i].time) return `point ${i} at ${got.time}, bar at ${want[i].time}`;
    if (i === base.length - 1) continue;
    for (const [g, f] of fields) if (!near(got[g], want[i][f])) return `point ${i} ${g} ${got[g]}, wanted ${want[i][f]}`;
  }
  return 'ok';
}
