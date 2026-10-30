import { expect } from '@playwright/test';

// What a person does on the chart workbench's drawing tools in the running app, shared by the charts-desk journeys. The
// drawings are kept on this device, so one journey keeps one browser context for all its steps (see its own file).

export const WORKBENCH = '/charts/BTC-USDT';

export async function openWorkbench(page) {
  await page.goto(WORKBENCH);
  await expect(page.getByTestId('cw').getByTestId('wc-host')).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Drawing tools' })).toBeVisible();
}

// The centres of the loaded bars, found from the chart itself: the grid cell marks its crosshair time while the pointer is
// over a bar, so a sweep across the plot gives each bar's horizontal extent. Cached per page: the bars only change when
// the feed brings new ones, and a journey step never changes them.
const centres = new WeakMap();

async function barCentres(page, box) {
  if (centres.has(page)) return centres.get(page);
  let bars = [];
  // The bars may still be arriving; sweep again for a few seconds before saying there are none.
  for (let attempt = 0; attempt < 10 && bars.length < 2; attempt++) {
    const extent = new Map();
    const steps = 200;
    for (let i = 0; i <= steps; i++) {
      const fx = i / steps;
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * 0.5);
      const time = await page.locator('[data-crosshair]').first().getAttribute('data-crosshair');
      if (!time) continue;
      const seen = extent.get(time);
      if (seen) seen.max = fx;
      else extent.set(time, { min: fx, max: fx });
    }
    bars = [...extent.values()].map((r) => (r.min + r.max) / 2).sort((a, b) => a - b);
    if (bars.length < 2) await page.waitForTimeout(500);
  }
  if (bars.length < 2) throw new Error('the chart shows fewer than two loaded bars');
  centres.set(page, bars);
  return bars;
}

/**
 * A point on the chart: `fx` picks one of the loaded bars (0 is the first, 1 the last, rounded to the nearest bar), so the
 * point is always on a bar and two points with different fractions are on different bars. `fy` is a fraction of the height.
 */
export async function plot(page, fx, fy) {
  const box = await page.getByTestId('cw').getByTestId('wc-host').boundingBox();
  if (!box) throw new Error('the chart has no box on the page');
  const bars = await barCentres(page, box);
  const index = Math.round(fx * (bars.length - 1));
  return { x: box.x + box.width * bars[index], y: box.y + box.height * fy };
}

export async function clickPlot(page, fx, fy) {
  const p = await plot(page, fx, fy);
  await page.mouse.click(p.x, p.y);
}

/** Pick a tool, a toolbar action or a toggle by its name (exact). */
export async function pick(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
}

export const rows = (page) => page.locator('[data-drawing-id]');
export const pointText = (row) => row.getByTestId('drawing-points');
export const figureLines = (row) => row.getByTestId('drawing-figures').locator('li');

/** The prices in a row's point text, in the order stored: "... · 65000.10 | ... · 65100.50" gives ["65000.10", "65100.50"]. */
export const pricesOf = (text) => [...text.matchAll(/· (-?\d+(?:\.\d+)?)/g)].map((m) => m[1]);

/** The stored bar times of a row, as the tree shows them (UTC, to the minute). */
export const timesOf = (text) => [...text.matchAll(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC/g)].map((m) => m[1]);

/** A row by its name, as the tree names it ("Trend line 1"). */
export const rowNamed = (page, pattern) => page.locator('[data-drawing-id]').filter({ has: page.getByRole('button', { name: pattern }) });

/** A bar time (epoch seconds) as the object tree writes it: UTC, to the minute. */
export const barTimeText = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');

/**
 * What the chart reads under a pixel: the bar time (epoch seconds) and the price at that height, as the library reports
 * them on the grid cell (`data-crosshair`, `data-crosshair-price`). The pointer is moved there to read them.
 */
export async function pointerAt(page, point) {
  const cell = page.locator('[data-crosshair]').first();
  // Cleared first, so what is read below is what the chart wrote for this position, not for the last one.
  await cell.evaluate((el) => {
    el.setAttribute('data-crosshair', '');
    el.setAttribute('data-crosshair-price', '');
  });
  await page.mouse.move(point.x - 1, point.y);
  await page.mouse.move(point.x, point.y);
  await expect.poll(async () => Number(await cell.getAttribute('data-crosshair'))).toBeGreaterThan(0);
  await expect.poll(async () => (await cell.getAttribute('data-crosshair-price')) ?? '').not.toBe('');
  return { time: Number(await cell.getAttribute('data-crosshair')), price: Number(await cell.getAttribute('data-crosshair-price')) };
}

/** A stored price is the pointer's price at the tick (0.01 for BTC-USDT): within half a tick of it. */
export const atTick = (stored, price, tick = 0.01) => Math.abs(Number(stored) - price) <= tick / 2 + 1e-9;
