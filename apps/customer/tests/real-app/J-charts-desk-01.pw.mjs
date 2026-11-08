// World: none
import { test, expect } from './journey.mjs';
import { EDGE } from './stack.mjs';

// J-charts-desk-01, in the running app (docs/roadmap/journeys.json): a person opens the chart workbench signed out,
// switches interval and style, reads history and the numbers the chart plots. One test per step, titled
// "J-charts-desk-01 #<n>". The bars are the stack's own TEST trades (pnpm local:market), read through Edge.
const J = 'J-charts-desk-01';
const CHART = '/charts/BTC-USDT';

const title = (page) => page.getByTestId('chart-title').first();
const canvas = (page) => page.getByRole('img', { name: 'Price chart of BTC/USDT' }).first();
const pressedInterval = (page) => page.getByRole('group', { name: 'Chart intervals' }).first().locator('button[aria-pressed="true"]');

/**
 * The bars in view, as the chart writes them: logical bar indexes of its left and right edges, read together in one
 * call so a range change between them can't mix two views. NaN while the chart has written no range.
 */
async function view(page) {
  return canvas(page).evaluate((el) => {
    const read = (name) => (el.hasAttribute(name) ? Number(el.getAttribute(name)) : NaN);
    return { from: read('data-view-from'), to: read('data-view-to') };
  });
}

/** The bars in view once the chart has stopped moving them: the same range on two reads 200 ms apart. */
async function settledView(page) {
  let last = null;
  let settled = null;
  await expect
    .poll(
      async () => {
        const v = await view(page);
        settled = last && Number.isFinite(v.from) && v.to - v.from > 0 && v.from === last.from && v.to === last.to ? v : null;
        last = v;
        return settled !== null;
      },
      { intervals: [200] },
    )
    .toBe(true);
  return settled;
}

async function openChart(page, path = CHART) {
  await page.goto(path);
  await expect(canvas(page)).toBeVisible();
  // Bars arrived from the service (the chart writes how many it holds).
  await expect.poll(async () => Number(await canvas(page).getAttribute('data-bars'))).toBeGreaterThan(0);
}

/**
 * A price as whole cents of the 0.01 tick, rounded half up the way the chart writes it, or null when it is not a price.
 * Edge writes the shortest decimal ("65000.5"); the legend pads and groups it ("65,000.50"). Both read as 6500050n.
 */
const cents = (text) => {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(String(text ?? '').replace(/[,\s]/g, ''));
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(3, '0');
  return BigInt(m[1]) * 100n + BigInt(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1n : 0n);
};

const STEP_MS = { '1m': 60_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000 };

/** What the drawing library holds, as the chart writes it back (see `writeDrawn` in WorkbenchChart.tsx). */
async function drawn(page) {
  return canvas(page).evaluate((el) => ({
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

/**
 * The bars the chart should open with at an interval: the last 240 buckets up to the current one, from Edge's own
 * candles, starting at the first bucket that traded when the market is younger than that.
 */
async function expectedWindow(interval) {
  const step = STEP_MS[interval];
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent('BTC/USDT')}?timeframe=${interval}&limit=240`);
  expect(res.status).toBe(200);
  const rows = (await res.json()).sort((a, b) => a[0] - b[0]);
  expect(rows.length, `Edge serves BTC/USDT ${interval} candles`).toBeGreaterThan(0);
  const now = Math.floor(Date.now() / step) * step;
  const first = Math.max(Math.floor(rows[0][0] / step) * step, now - 239 * step);
  return { first, last: now, bars: (now - first) / step + 1 };
}

/** A market as Edge publishes it (its tick size is `precision.price`). */
async function marketOf(symbol) {
  const res = await fetch(`${EDGE}/api/v1/markets?limit=500`);
  expect(res.status).toBe(200);
  const body = await res.json();
  const list = Array.isArray(body) ? body : Object.values(body).find(Array.isArray);
  const market = list.find((m) => m.symbol === symbol);
  expect(market, `${symbol} is published`).toBeTruthy();
  return market;
}

/** The newest TEST candle Edge serves for BTC/USDT at an interval. */
async function lastCandle(interval) {
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent('BTC/USDT')}?timeframe=${interval}&limit=1`);
  expect(res.status).toBe(200);
  const rows = await res.json();
  expect(rows.length).toBeGreaterThan(0);
  return rows[rows.length - 1];
}

test(`${J} #1 opens /charts/BTC-USDT and sees the last bars at the saved interval with a header naming both`, async ({ page }) => {
  await openChart(page);
  await expect(title(page)).toHaveText('BTC/USDT · 15m');
  await expect(pressedInterval(page)).toHaveText('15m');
  // The last bars: the 240 buckets up to the current one (or from the first that traded), as the library draws them.
  await expect
    .poll(
      async () => {
        const [want, got] = [await expectedWindow('15m'), await drawn(page)];
        return [got.heldFirst === want.first, got.heldLast === want.last, got.held === want.bars, got.bars === got.held];
        // A bucket that rolls over mid-check shows on the chart's next 10 s poll.
      },
      { timeout: 30_000 },
    )
    .toEqual([true, true, true, true]);
  // The chart draws on a real canvas, not a placeholder.
  await expect(canvas(page).locator('canvas').first()).toBeVisible();
  // The saved interval: a person who picks 1h opens the chart at 1h next time, header and bars both.
  await page.getByRole('group', { name: 'Chart intervals' }).first().getByRole('button', { name: '1h', exact: true }).click();
  await expect(title(page)).toHaveText('BTC/USDT · 1h');
  await page.goto(CHART);
  await expect(title(page)).toHaveText('BTC/USDT · 1h');
  await expect(pressedInterval(page)).toHaveText('1h');
  await expect.poll(async () => (await drawn(page)).heldLast, { timeout: 30_000 }).toBe((await expectedWindow('1h')).last);
  // The spot desk shows the same market's chart: at 1m its newest close is the newest 1m close Edge serves.
  await page.goto('/trade/spot/BTC-USDT');
  const desk = page.getByRole('img', { name: 'Price chart of BTC/USDT', exact: true }).first();
  await expect(desk).toBeVisible();
  const deskIntervals = page.getByTestId('dk-chart').getByRole('group', { name: 'Chart intervals' });
  await deskIntervals.getByRole('button', { name: '1m', exact: true }).click();
  await expect(deskIntervals.getByRole('button', { name: '1m', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(
      async () => {
        const [, , , , close] = await lastCandle('1m');
        return cents(await desk.getByTestId('pc-legend').locator('b').nth(3).textContent()) === cents(close);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
});

/** After an interval switch the newest bar of that interval is drawn and stays in view at the right edge. */
async function keepsRightEdge(page, interval) {
  await expect.poll(async () => (await drawn(page)).heldLast, { timeout: 30_000 }).toBe((await expectedWindow(interval)).last);
  const got = await drawn(page);
  expect(got.last).toBe(got.heldLast);
  const v = await settledView(page);
  expect(v.to).toBeGreaterThanOrEqual(got.bars - 1);
  expect(v.from).toBeLessThan(got.bars - 1);
}

test(`${J} #2 picks 1h, then another interval from More, and the pressed one is marked`, async ({ page }) => {
  await openChart(page);
  await page.getByRole('group', { name: 'Chart intervals' }).first().getByRole('button', { name: '1h', exact: true }).click();
  await expect(title(page)).toHaveText('BTC/USDT · 1h');
  await expect(pressedInterval(page)).toHaveText('1h');
  await keepsRightEdge(page, '1h');
  await page.getByRole('button', { name: /More/ }).first().click();
  await page.getByRole('menuitem', { name: '30m', exact: true }).click();
  await expect(title(page)).toHaveText('BTC/USDT · 30m');
  await expect(page.locator('[data-testid="cw-more"][data-active]').first()).toContainText('30m');
  await expect(pressedInterval(page)).toHaveCount(0);
  await keepsRightEdge(page, '30m');
});

/**
 * The points the drawing library itself holds for the chart's main series, oldest first, read from the library's own
 * series object (`series.data()`), found through the chart component's refs on the page. No figure here is the app's
 * own copy of the bars: it is what the library draws.
 */
async function libraryPoints(page) {
  return canvas(page).evaluate((el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    for (let fiber = key ? el[key] : null; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook && typeof hook === 'object' && 'next' in hook; hook = hook.next) {
        const series = hook.memoizedState?.current;
        if (series && typeof series.seriesType === 'function' && typeof series.data === 'function') {
          return {
            type: series.seriesType(),
            points: series.data().map((p) => ({ time: p.time, open: p.open, high: p.high, low: p.low, close: p.close, value: p.value })),
          };
        }
      }
    }
    throw new Error('the chart holds no drawing-library series');
  });
}

/** Heikin Ashi from plain bars: close (O+H+L+C)/4, open the mean of the previous HA open and close ((O+C)/2 first). */
function heikinAshiOf(bars) {
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

const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/**
 * Whether the library's points are the glyph of `id` over exactly these plain bars: the same times, and each value the
 * style draws (OHLC for candles and bars, the averaged OHLC for Heikin Ashi, the close for line, area and columns). The
 * newest bar is still trading and may move between two reads, so its time is checked and its values only up to it.
 */
function drawsAs(id, points, bars) {
  if (points.length !== bars.length) return `drew ${points.length} points over ${bars.length} bars`;
  const want = id === 'heikin-ashi' ? heikinAshiOf(bars) : bars;
  for (let i = 0; i < bars.length; i += 1) {
    const [got, w] = [points[i], want[i]];
    if (got.time !== w.time) return `point ${i} at ${got.time}, bar at ${w.time}`;
    if (i === bars.length - 1) continue;
    const fields = ['line', 'area', 'columns'].includes(id) ? [['value', 'close']] : ['open', 'high', 'low', 'close'].map((f) => [f, f]);
    for (const [g, f] of fields) if (!near(got[g], w[f])) return `point ${i} ${g} ${got[g]}, wanted ${w[f]}`;
  }
  return 'ok';
}

test(`${J} #3 switches between candles, bars, line, area, columns and Heikin Ashi, and the choice is kept`, async ({ page }) => {
  await openChart(page);
  const styles = page.getByRole('group', { name: 'Chart style' }).first();
  const pick = async (label, id) => {
    await styles.getByRole('button', { name: label, exact: true }).click();
    await expect(canvas(page)).toHaveAttribute('data-style', id);
    await expect(styles.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
  };

  // The plain bars: what the library draws as candles, and those are Edge's own candles, open, high, low and close,
  // at every time Edge serves within them (an empty bucket between trades is the chart's, not Edge's).
  await pick('Candles', 'candles');
  let bars = [];
  await expect
    .poll(async () => {
      const got = await libraryPoints(page);
      const held = await drawn(page);
      bars = got.points;
      return [got.type, got.points.length === held.held, got.points[0]?.time * 1000 === held.heldFirst];
    })
    .toEqual(['Candlestick', true, true]);
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent('BTC/USDT')}?timeframe=15m&limit=240`);
  expect(res.status).toBe(200);
  const edge = new Map((await res.json()).map((row) => [row[0] / 1000, row]));
  const shared = bars.slice(0, -1).filter((b) => edge.has(b.time));
  expect(shared.length, 'Edge serves candles among the bars the chart draws').toBeGreaterThan(0);
  for (const b of shared) {
    const [, o, h, l, c] = edge.get(b.time).map(Number);
    expect([b.open, b.high, b.low, b.close], `the candle at ${b.time}`).toEqual([o, h, l, c]);
  }
  // Heikin Ashi is not plain candles redrawn: its averaged values differ from the bars somewhere in the window.
  expect(
    heikinAshiOf(bars)
      .slice(0, -1)
      .some((ha, i) => !near(ha.close, bars[i].close) || !near(ha.open, bars[i].open)),
  ).toBe(true);

  // Each style is drawn by the library's own series of that kind, over the same bars, with that style's values.
  for (const [label, id, kind] of [
    ['Bars', 'bars', 'Bar'],
    ['Line', 'line', 'Line'],
    ['Area', 'area', 'Area'],
    ['Columns', 'columns', 'Histogram'],
    ['Heikin Ashi', 'heikin-ashi', 'Candlestick'],
    ['Candles', 'candles', 'Candlestick'],
  ]) {
    await pick(label, id);
    await expect
      .poll(async () => {
        const got = await libraryPoints(page);
        return [got.type, drawsAs(id, got.points, bars)];
      })
      .toEqual([kind, 'ok']);
  }

  // The choice is kept on this device: after a reload Heikin Ashi is pressed and drawn, averaged, over the same bars.
  await pick('Heikin Ashi', 'heikin-ashi');
  await page.reload();
  await expect(canvas(page)).toHaveAttribute('data-style', 'heikin-ashi');
  await expect(styles.getByRole('button', { name: 'Heikin Ashi', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => {
      const got = await libraryPoints(page);
      const common = got.points.filter((p) => p.time >= bars[0].time && p.time <= bars[bars.length - 2].time);
      const base = bars.filter((b) => b.time >= got.points[0].time);
      return [got.type, common.length > 0 && drawsAs('heikin-ashi', got.points.slice(0, base.length), base)];
    })
    .toEqual(['Candlestick', 'ok']);
});

test(`${J} #4 scrolls back to the oldest bar, more history loads with a stated depth, and keys zoom and pan`, async ({ page }) => {
  await openChart(page, `${CHART}?interval=1m`);
  const before = Number(await canvas(page).getAttribute('data-bars'));
  // Opening the chart reads only the recent bars; the older block waits until the person scrolls back.
  await expect(page.getByTestId('chart-depth').first()).toContainText(`${before} bars loaded. Scroll back for more.`);
  const firstBefore = Number(await canvas(page).getAttribute('data-first'));
  // Zoom and pan by keyboard, read back as the bars in view (logical bar indexes the chart writes on itself).
  await canvas(page).focus();
  const v0 = await settledView(page);
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  // Zooming in keeps the newest edge and shows fewer bars.
  await expect
    .poll(async () => {
      const v = await view(page);
      return v.to - v.from;
    })
    .toBeLessThan(v0.to - v0.from);
  const v1 = await settledView(page);
  expect(Math.abs(v1.to - v0.to)).toBeLessThan(1);
  // One arrow key pans ten bars back: both edges move by the same ten bars.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await view(page)).to).toBeCloseTo(v1.to - 10, 0);
  const panned = await settledView(page);
  expect(panned.from).toBeCloseTo(v1.from - 10, 0);
  expect(panned.to).toBeCloseTo(v1.to - 10, 0);
  // Mouse wheel over the plot zooms too: fewer bars in view.
  const plotBox = await canvas(page).boundingBox();
  await page.mouse.move(plotBox.x + plotBox.width / 2, plotBox.y + plotBox.height / 2);
  await page.mouse.wheel(0, -400);
  await expect
    .poll(async () => {
      const v = await view(page);
      return v.to - v.from;
    })
    .toBeLessThan(panned.to - panned.from - 1);
  await settledView(page);
  // Zoom right out and pan to the oldest bar: the chart asks the service for the older block once. The stack's TEST
  // history reaches back further than the 240 bars the chart opens with, so the older block adds bars in front.
  for (let i = 0; i < 12; i += 1) await page.keyboard.press('-');
  for (let i = 0; i < 40; i += 1) await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('chart-depth').first()).toContainText(/bars loaded, from .+\. This interval keeps the last 720 bars/);
  const after = Number(await canvas(page).getAttribute('data-bars'));
  expect(after).toBeGreaterThan(before);
  expect(Number(await canvas(page).getAttribute('data-first'))).toBeLessThan(firstBefore);
  // The stated depth is the count the chart holds.
  await expect(page.getByTestId('chart-depth').first()).toContainText(`${after} bars loaded, from `);
  // Mouse: dragging the plot to the right brings older bars into view.
  const box = await canvas(page).boundingBox();
  await page.keyboard.press('Home');
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  const v2 = await settledView(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await view(page)).from).toBeLessThan(v2.from - 1);
  const v3 = await settledView(page);
  expect(v3.to - v3.from).toBeCloseTo(v2.to - v2.from, 0);
});

test(`${J} #5 jumps to a date and sees it, or is told there is no data that far back`, async ({ page }) => {
  await openChart(page, `${CHART}?interval=15m`);
  const date = page.getByLabel('Go to date').first();
  const go = async (ms) => {
    const at = new Date(ms);
    await date.fill(new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    await page.getByRole('button', { name: 'Go', exact: true }).first().click();
  };
  const note = page.getByTestId('chart-date-note');
  // Two years back: older than the 720 bars a 15m chart keeps (7.5 days). Said in those words; nothing invented.
  await go(Date.now() - 730 * 86_400_000);
  await expect(note).toContainText('older than the 720 bars this interval keeps');
  // Inside those 720 bars but two hours before the first one that traded (read from Edge's deepest 15m window): no data.
  const step = STEP_MS['15m'];
  const since = (Math.floor(Date.now() / step) - 719) * step;
  const deep = await (await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent('BTC/USDT')}?timeframe=15m&since=${since}&limit=720`)).json();
  const earliest = Math.min(...deep.map((row) => row[0]));
  expect(earliest - 2 * 3_600_000, 'the TEST history starts inside the 7.5 days a 15m chart keeps').toBeGreaterThan(since);
  await go(earliest - 2 * 3_600_000);
  await expect(note).toContainText('There’s no data that far back: this market has no trades from that date until');
  // A time that has bars, 100 bars before the newest: the chart moves that bar to the middle of the view and the note goes.
  // Zoomed in first, so the view is narrower than the bars and a move shows.
  await canvas(page).focus();
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('+');
  const before = await drawn(page);
  const target = before.heldLast - 100 * STEP_MS['15m'];
  await go(target);
  await expect(note).toHaveCount(0);
  await expect
    .poll(async () => {
      const [got, v] = [await drawn(page), await view(page)];
      const index = (target - got.heldFirst) / STEP_MS['15m'];
      return Math.abs((v.from + v.to) / 2 - index) <= 1 && v.to < got.bars - 1;
    })
    .toBe(true);
});

test(`${J} #6 changes the colour scheme and the price source; a source the market does not serve is refused`, async ({ page }) => {
  await openChart(page);
  // The chart follows the app theme: the library draws on the theme's own background token.
  const themeBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--if-bg').trim());
  expect(themeBg).not.toBe('');
  await expect.poll(async () => (await drawn(page)).bg).toBe(themeBg);
  const standard = await drawn(page);
  expect(standard.up).not.toBe(standard.down);
  await page.getByLabel('Colours').first().selectOption({ label: 'Red up, green down' });
  await expect(canvas(page)).toHaveAttribute('data-scheme', 'inverted');
  // The candles the library draws swap colours: up is drawn in the standard down colour, and down in the standard up.
  await expect.poll(async () => [(await drawn(page)).up, (await drawn(page)).down]).toEqual([standard.down, standard.up]);
  await page.reload();
  await expect(canvas(page)).toHaveAttribute('data-scheme', 'inverted');
  await expect.poll(async () => [(await drawn(page)).up, (await drawn(page)).down]).toEqual([standard.down, standard.up]);
  await page.getByLabel('Price source').first().selectOption({ label: 'Best bid' });
  const refusal = page.locator('[data-code="trade.chart.basis_unpublished"]').first();
  await expect(refusal).toContainText('can’t draw Best bid');
  await expect(refusal).toContainText('last trade prices');
  await expect(page.getByLabel('Price source').first()).toHaveValue('last');
  await page.getByLabel('Price source').first().selectOption({ label: 'Mark price' });
  await expect(refusal).toContainText('can’t draw Mark price');
});

test(`${J} #7 reads the numbers the chart plots: the service's bars, the axis format from the tick size`, async ({ page }) => {
  await openChart(page, `${CHART}?interval=1m`);
  const legend = page.getByTestId('chart-legend').first();
  // The legend shows the newest bar; it equals the newest candle Edge serves (re-read while the market maker trades).
  // Edge writes the shortest decimal (65000.5) and the legend pads to the tick (65,000.50): compare cents, not text.
  await expect
    .poll(
      async () => {
        const [, , , , close] = await lastCandle('1m');
        const shown = cents(await legend.locator('b').nth(3).textContent());
        return shown !== null && shown === cents(close);
      },
      // The stack's market maker crosses about every 30 s: one more trade's worth of time if the legend lags a frame.
      { timeout: 60_000 },
    )
    .toBe(true);
  // Bar times: the library's bars (epoch seconds there, written back in ms) are the chart's own minute buckets, its
  // newest is the current minute, and Edge's newest 1m candle sits on one of them (a quiet minute repeats the last close).
  await expect
    .poll(
      async () => {
        const [got, edge] = [await drawn(page), Number((await lastCandle('1m'))[0])];
        return [got.last === got.heldLast, got.first === got.heldFirst, got.last % 60_000, (got.last - edge) % 60_000, edge <= got.last];
      },
      { timeout: 30_000 },
    )
    .toEqual([true, true, 0, 0, true]);
  // The price axis formats from the market's tick size, read from Edge: BTC/USDT 0.01 gives two decimals, and a
  // market with a 0.0001 tick (IFC/USDT) gives four, on the axis and in the legend alike.
  for (const [path, pair, digits] of [
    [CHART, 'BTC/USDT', 2],
    ['/charts/IFC-USDT', 'IFC/USDT', 4],
  ]) {
    const tick = (await marketOf(pair)).precision.price;
    expect(tick).toBe(digits === 2 ? '0.01' : '0.0001');
    if (path !== CHART) await page.goto(`${path}?interval=1m`);
    const chart = page.getByRole('img', { name: `Price chart of ${pair}` }).first();
    await expect(chart).toHaveAttribute('data-drawn-format', `0.${'0'.repeat(digits)}`);
    await expect(chart).toHaveAttribute('data-drawn-min-move', String(Number(tick)));
    const shown = page.getByTestId('chart-legend').first().locator('b');
    for (let i = 0; i < 4; i += 1) await expect(shown.nth(i)).toHaveText(new RegExp(`^[\\d,]+\\.\\d{${digits}}$`));
  }
});

test(`${J} #8 opens a symbol at an interval the feed does not offer and is told so by name`, async ({ page }) => {
  await openChart(page, `${CHART}?interval=3d`);
  const note = page.locator('[data-code="trade.datafeed.interval_unsupported"]');
  await expect(note).toContainText('doesn’t offer the 3d interval');
  await expect(title(page)).toHaveText('BTC/USDT · 15m');
  await expect(page.getByRole('group', { name: 'Chart intervals' }).first().getByRole('button', { name: '3d' })).toHaveCount(0);
});
