import { test, expect } from '@playwright/test';
import { EDGE } from './stack.mjs';

// J-charts-desk-01, in the running app (docs/roadmap/journeys.json): a person opens the chart workbench signed out,
// switches interval and style, reads history and the numbers the chart plots. One test per step, titled
// "J-charts-desk-01 #<n>". The bars are the stack's own TEST trades (pnpm local:market), read through Edge.
const J = 'J-charts-desk-01';
const CHART = '/charts/BTC-USDT';

const title = (page) => page.getByTestId('chart-title').first();
const canvas = (page) => page.getByRole('img', { name: 'Price chart of BTC/USDT' }).first();
const pressedInterval = (page) => page.getByRole('group', { name: 'Chart intervals' }).first().locator('button[aria-pressed="true"]');

/** The bars in view, as the chart writes them: logical bar indexes of its left and right edges. */
async function view(page) {
  const c = canvas(page);
  return { from: Number(await c.getAttribute('data-view-from')), to: Number(await c.getAttribute('data-view-to')) };
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
  const bars = Number(await canvas(page).getAttribute('data-bars'));
  expect(bars).toBeGreaterThan(0);
  expect(bars).toBeLessThanOrEqual(240);
  // The chart draws on a real canvas, not a placeholder.
  await expect(canvas(page).locator('canvas').first()).toBeVisible();
  // The spot desk has its chart for the same market.
  await page.goto('/trade/spot/BTC-USDT');
  await expect(page.getByRole('img', { name: /chart/i }).first()).toBeVisible();
});

test(`${J} #2 picks 1h, then another interval from More, and the pressed one is marked`, async ({ page }) => {
  await openChart(page);
  await page.getByRole('group', { name: 'Chart intervals' }).first().getByRole('button', { name: '1h', exact: true }).click();
  await expect(title(page)).toHaveText('BTC/USDT · 1h');
  await expect(pressedInterval(page)).toHaveText('1h');
  await page.getByRole('button', { name: /More/ }).first().click();
  await page.getByRole('menuitem', { name: '30m', exact: true }).click();
  await expect(title(page)).toHaveText('BTC/USDT · 30m');
  await expect(page.locator('[data-testid="cw-more"][data-active]').first()).toContainText('30m');
  await expect(pressedInterval(page)).toHaveCount(0);
  await expect.poll(async () => Number(await canvas(page).getAttribute('data-bars'))).toBeGreaterThan(0);
});

test(`${J} #3 switches between candles, bars, line, area, columns and Heikin Ashi, and the choice is kept`, async ({ page }) => {
  await openChart(page);
  const styles = page.getByRole('group', { name: 'Chart style' }).first();
  for (const [label, id] of [
    ['Bars', 'bars'],
    ['Line', 'line'],
    ['Area', 'area'],
    ['Columns', 'columns'],
    ['Heikin Ashi', 'heikin-ashi'],
    ['Candles', 'candles'],
  ]) {
    await styles.getByRole('button', { name: label, exact: true }).click();
    await expect(canvas(page)).toHaveAttribute('data-style', id);
    await expect(styles.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await styles.getByRole('button', { name: 'Heikin Ashi', exact: true }).click();
  await page.reload();
  await expect(canvas(page)).toHaveAttribute('data-style', 'heikin-ashi');
});

test(`${J} #4 scrolls back to the oldest bar, more history loads with a stated depth, and keys zoom and pan`, async ({ page }) => {
  await openChart(page, `${CHART}?interval=1m`);
  const before = Number(await canvas(page).getAttribute('data-bars'));
  // Opening the chart reads only the recent bars; the older block waits until the person scrolls back.
  await expect(page.getByTestId('chart-depth').first()).toContainText(`${before} bars loaded. Scroll back for more.`);
  const firstBefore = Number(await canvas(page).getAttribute('data-first'));
  // Zoom and pan by keyboard, read back as the bars in view (logical bar indexes the chart writes on itself).
  await canvas(page).focus();
  const v0 = await view(page);
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  // Zooming in keeps the newest edge and shows fewer bars.
  await expect.poll(async () => (await view(page)).to - (await view(page)).from).toBeLessThan(v0.to - v0.from);
  const v1 = await view(page);
  expect(Math.abs(v1.to - v0.to)).toBeLessThan(1);
  // One arrow key pans ten bars back: both edges move by the same ten bars.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await view(page)).to).toBeCloseTo(v1.to - 10, 0);
  expect((await view(page)).from).toBeCloseTo(v1.from - 10, 0);
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
  const v2 = await view(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await view(page)).from).toBeLessThan(v2.from - 1);
  const v3 = await view(page);
  expect(v3.to - v3.from).toBeCloseTo(v2.to - v2.from, 0);
});

test(`${J} #5 jumps to a date and sees it, or is told there is no data that far back`, async ({ page }) => {
  await openChart(page, `${CHART}?interval=15m`);
  const date = page.getByLabel('Go to date').first();
  // Two years back: further than this TEST market has traded and than the 720 bars a 15m chart keeps (7.5 days), so the chart says one or the other, and draws nothing invented.
  const old = `${new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10)}T00:00`;
  await date.fill(old);
  await page.getByRole('button', { name: 'Go', exact: true }).first().click();
  await expect(page.getByTestId('chart-date-note')).toContainText(/no data that far back|older than the 720 bars/);
  // A minute that has bars (the newest bar's own time): the chart moves there and the note goes away.
  const newest = new Date(Number(await canvas(page).getAttribute('data-last')));
  const local = new Date(newest.getTime() - newest.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await date.fill(local);
  await page.getByRole('button', { name: 'Go', exact: true }).first().click();
  await expect(page.getByTestId('chart-date-note')).toHaveCount(0);
});

test(`${J} #6 changes the colour scheme and the price source; a source the market does not serve is refused`, async ({ page }) => {
  await openChart(page);
  await page.getByLabel('Colours').first().selectOption({ label: 'Red up, green down' });
  await expect(canvas(page)).toHaveAttribute('data-scheme', 'inverted');
  await page.reload();
  await expect(canvas(page)).toHaveAttribute('data-scheme', 'inverted');
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
  // BTC/USDT's tick size is 0.01: two decimals everywhere the chart writes a price.
  for (let i = 0; i < 4; i += 1) await expect(legend.locator('b').nth(i)).toHaveText(/^[\d,]+\.\d{2}$/);
});

test(`${J} #8 opens a symbol at an interval the feed does not offer and is told so by name`, async ({ page }) => {
  await openChart(page, `${CHART}?interval=3d`);
  const note = page.locator('[data-code="trade.datafeed.interval_unsupported"]');
  await expect(note).toContainText('doesn’t offer the 3d interval');
  await expect(title(page)).toHaveText('BTC/USDT · 15m');
  await expect(page.getByRole('group', { name: 'Chart intervals' }).first().getByRole('button', { name: '3d' })).toHaveCount(0);
});
