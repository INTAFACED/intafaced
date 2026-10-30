import { test, expect } from '@playwright/test';
import { EDGE } from './stack.mjs';
import {
  atTick,
  barTimeText,
  centred,
  clickPlot,
  openWorkbench,
  pick,
  plot,
  pointerAt,
  pointText,
  pricesOf,
  rowNamed,
  rows,
  timesOf,
} from './charts-desk.mjs';

// J-charts-desk-05 "I draw on the chart: lines, text, select and move, lock, undo and delete", in the running app. One test
// per step, titled "J-charts-desk-05 #<n>", run in order in one browser context: drawings are kept on this device, so the
// steps share the page. Drawings are placed by fractions of the chart's width and height, never by a bar index.
const J = 'J-charts-desk-05';

test.describe.configure({ mode: 'serial' });

let page;
/** The trend line's two points as step 1 placed them (bar centres, in page pixels). */
let trendPoints;
test.beforeAll(async ({ browser }) => {
  // Tall enough for the whole workbench: the page never scrolls, so a pixel read on the chart is the pixel then clicked.
  const context = await browser.newContext({ viewport: { width: 1440, height: 2200 } });
  page = await context.newPage();
  await openWorkbench(page);
});
test.afterAll(async () => {
  await page?.context().close();
});

test(`${J} #1 opens the drawing toolbar and picks the trend line, then two clicks place it as bar times and decimal prices`, async () => {
  await pick(page, 'Trend line');
  // What the chart reads under each click: the bar's time and the price at that height.
  trendPoints = [await centred(page, await plot(page, 0.3, 0.4)), await centred(page, await plot(page, 0.6, 0.5))];
  // Each click, then what the chart reads at that same pixel (read after it, so both see the page as it was clicked).
  const at = [];
  for (const point of trendPoints) {
    await page.mouse.click(point.x, point.y);
    at.push(await pointerAt(page, point));
  }
  await expect(rows(page)).toHaveCount(1);
  const text = await pointText(rows(page).first()).textContent();
  // Two points, each stored as that bar's time and that price at the tick's places (two for BTC-USDT's 0.01 tick).
  expect(timesOf(text)).toEqual(at.map((p) => barTimeText(p.time)));
  expect(pricesOf(text)).toHaveLength(2);
  pricesOf(text).forEach((price, i) => {
    expect(price).toMatch(/^\d+\.\d{2}$/);
    expect(atTick(price, at[i].price), `point ${i + 1}: stored ${price}, pointer ${at[i].price}`).toBe(true);
  });
});

test(`${J} #2 adds an info line, a horizontal line and a ray, each on the price pane`, async () => {
  await pick(page, 'Info line');
  await clickPlot(page, 0.2, 0.7);
  await clickPlot(page, 0.4, 0.6);
  await pick(page, 'Horizontal line');
  await clickPlot(page, 0.5, 0.3);
  await pick(page, 'Ray');
  await clickPlot(page, 0.7, 0.8);
  await clickPlot(page, 0.8, 0.75);
  // The object tree lists the newest first: ray, horizontal, info, trend.
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).nth(0)).toHaveAttribute('data-kind', 'ray');
  await expect(rows(page).nth(1)).toHaveAttribute('data-kind', 'horizontal');
  await expect(rows(page).nth(2)).toHaveAttribute('data-kind', 'info');
  // On the price pane: the library draws the drawings on the main series' pane, pane 0, with the price.
  await expect(page.getByTestId('cw').getByTestId('wc-host')).toHaveAttribute('data-drawings-pane', '0');
});

test(`${J} #3 adds text at the chosen point, with its own label`, async () => {
  await pick(page, 'Text');
  await page.getByLabel('Text to place or edit').first().fill('Support');
  const point = await centred(page, await plot(page, 0.25, 0.55));
  await page.mouse.click(point.x, point.y);
  const at = await pointerAt(page, point);
  // The text is stored with the drawing and shown in the object tree.
  await expect(page.locator('[data-drawing-id][data-kind="text"]')).toHaveCount(1);
  await expect(page.locator('[data-drawing-id][data-kind="text"]').getByRole('textbox', { name: 'Text to place or edit' })).toHaveValue(
    'Support',
  );
  // At the chosen point: stored as the bar under the click and the price at its height.
  const stored = await pointText(page.locator('[data-drawing-id][data-kind="text"]')).textContent();
  expect(timesOf(stored)).toEqual([barTimeText(at.time)]);
  expect(atTick(pricesOf(stored)[0], at.price), `stored ${pricesOf(stored)[0]}, pointer ${at.price}`).toBe(true);
  // Font size and colour are not offered in this build: the text takes the default size and the neutral tone.
});

test(`${J} #4 drags a line's middle handle, and both points move by the same bar and price delta`, async () => {
  const trend = rowNamed(page, /^Trend line \d+$/);
  await trend.getByRole('button', { name: /^Trend line \d+$/ }).click();
  const beforeText = await pointText(trend).textContent();
  const before = pricesOf(beforeText);
  // The line's middle handle, between the two points step 1 placed.
  const [a, b] = trendPoints;
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x + 40, middle.y - 12, { steps: 8 });
  await page.mouse.up();
  const afterText = await pointText(trend).textContent();
  const after = pricesOf(afterText);
  expect(after).not.toEqual(before);
  // The same bar delta: both points moved by the same time, a whole number of bars, and not by zero.
  const ms = (t) => Date.parse(`${t.replace(' ', 'T')}:00Z`);
  const [tb, ta] = [timesOf(beforeText).map(ms), timesOf(afterText).map(ms)];
  expect(ta[0] - tb[0]).toBe(ta[1] - tb[1]);
  expect(ta[0] - tb[0]).not.toBe(0);
  expect((ta[0] - tb[0]) % (15 * 60_000)).toBe(0);
  const deltaA = Number(after[0]) - Number(before[0]);
  const deltaB = Number(after[1]) - Number(before[1]);
  expect(deltaA).toBeCloseTo(deltaB, 2);
});

test(`${J} #5 locks a drawing so it cannot move, and turns magnet on`, async () => {
  // Step 4 moved the first line, so this step draws its own line on points it knows, and works on that selected drawing.
  await pick(page, 'Trend line');
  const a = await plot(page, 0.3, 0.4);
  const b = await plot(page, 0.6, 0.5);
  await clickPlot(page, 0.3, 0.4);
  await clickPlot(page, 0.6, 0.5);
  const line = page.locator('[data-drawing-id][data-selected]');
  await expect(line).toHaveCount(1);
  const before = await pointText(line).textContent();
  const actions = page.getByRole('group', { name: 'Drawing actions' });
  await actions.getByRole('button', { name: 'Lock', exact: true }).click();
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x + 60, middle.y, { steps: 6 });
  await page.mouse.up();
  await expect(pointText(line)).toHaveText(before);
  await expect(page.getByRole('alert').filter({ hasText: 'locked' })).toBeVisible();
  // Magnet snaps a placed point to the open, high, low or close of the nearest bar: it is switched on here.
  await pick(page, 'Magnet off');
  await expect(page.getByRole('button', { name: 'Magnet on', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Unlock and delete the line this step drew, so step 6 lists the five drawings of this journey.
  await actions.getByRole('button', { name: 'Unlock', exact: true }).click();
  await actions.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(rows(page)).toHaveCount(5);
  // With magnet on, a placed point snaps to the bar's close (the check adds a line and deletes it again).
  await magnetSnapsToClose();
  await expect(rows(page)).toHaveCount(5);
});

/**
 * With magnet on, a point placed a few pixels off a bar's close is stored at one of that bar's open, high, low or close,
 * not at the pointer's price: the bar under the pointer is read from the chart, its prices from Edge's candles, and the
 * height of the close found by reading the price up the plot.
 */
async function magnetSnapsToClose() {
  const x = await centred(page, await plot(page, 0.5, 0.3));
  const bar = await pointerAt(page, x);
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent('BTC/USDT')}?timeframe=15m&limit=240`);
  const rows15 = (await res.json()).sort((p, q) => p[0] - q[0]);
  // The bar's open, high, low and close: its own candle's, or the previous close four times when the bucket had no trade
  // (a filled bar).
  const candle = rows15.filter((r) => r[0] <= bar.time * 1000).at(-1);
  const ohlc = candle[0] === bar.time * 1000 ? candle.slice(1, 5).map(Number) : Array(4).fill(Number(candle[4]));
  const close = ohlc[3];
  const box = await page.getByTestId('cw').getByTestId('wc-host').boundingBox();
  let best = null;
  // Up the price pane only (the top 70 %: the Volume pane and the time axis sit below it), reading the price at each height.
  const cell = page.locator('[data-crosshair]').first();
  for (let y = box.y + 5; y < box.y + box.height * 0.7; y += 2) {
    await page.mouse.move(x.x, y);
    const price = Number((await cell.getAttribute('data-crosshair-price')) || NaN);
    if (Number.isFinite(price) && (!best || Math.abs(price - close) < Math.abs(best.price - close))) best = { y, price };
  }
  expect(best, 'the price pane reads a price at some height').not.toBeNull();
  // Three pixels off the close: the price there is not the close at the tick, so only the magnet can store the close.
  const off = await pointerAt(page, { x: x.x, y: best.y + 3 });
  expect(atTick(close.toFixed(2), off.price), 'three pixels off the close reads another price').toBe(false);
  await pick(page, 'Horizontal line');
  await page.mouse.click(x.x, best.y + 3);
  const placed = page.locator('[data-drawing-id][data-selected]');
  await expect(placed).toHaveAttribute('data-kind', 'horizontal');
  // Stored at one of the bar's four prices (the nearest within the magnet's reach), not at the pointer's own price.
  const placedText = await pointText(placed).textContent();
  const [stored] = pricesOf(placedText);
  expect(timesOf(placedText)).toEqual([barTimeText(bar.time)]);
  expect(
    ohlc.map((p) => p.toFixed(2)),
    `stored ${stored}; pointer ${off.price}`,
  ).toContain(stored);
  expect(atTick(stored, off.price)).toBe(false);
  await page.getByRole('group', { name: 'Drawing actions' }).getByRole('button', { name: 'Delete', exact: true }).click();
}

test(`${J} #6 lists every drawing in the object tree, and hides a group together`, async () => {
  // Trend line, info line, horizontal line, ray and text: five drawings.
  await expect(rows(page)).toHaveCount(5);
  const checks = page.getByRole('checkbox', { name: /^Select / });
  await checks.nth(0).check();
  await checks.nth(1).check();
  await page.getByRole('button', { name: /^Group checked/ }).click();
  await page.getByRole('button', { name: 'Hide group', exact: true }).click();
  await expect(page.locator('[data-visible="false"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Show group', exact: true }).click();
  await expect(page.locator('[data-visible="false"]')).toHaveCount(0);
});

test(`${J} #7 deletes a line, and Undo brings it back with its original points`, async () => {
  const line = rowNamed(page, /^Horizontal line \d+$/);
  await line.getByRole('button', { name: /^Horizontal line \d+$/ }).click();
  const before = await pointText(line).textContent();
  const count = await rows(page).count();
  await page.keyboard.press('Delete');
  await expect(rows(page)).toHaveCount(count - 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(rows(page)).toHaveCount(count);
  await expect(pointText(rowNamed(page, /^Horizontal line \d+$/))).toHaveText(before);
});

test(`${J} #8 hides all drawings, then clears them after a confirmation`, async () => {
  await pick(page, 'Hide all');
  await expect(page.getByRole('button', { name: 'Show all', exact: true })).toBeVisible();
  // Every drawing is hidden: as many hidden rows as drawings, and none shown.
  const count = await rows(page).count();
  expect(count).toBeGreaterThan(0);
  await expect(page.locator('[data-drawing-id][data-visible="false"]')).toHaveCount(count);
  await expect(page.locator('[data-drawing-id][data-visible="true"]')).toHaveCount(0);
  await pick(page, 'Show all');
  await pick(page, 'Clear all');
  // The clear waits for the in-app dialog: nothing goes until it is confirmed.
  await expect(rows(page)).not.toHaveCount(0);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear all', exact: true }).click();
  await expect(rows(page)).toHaveCount(0);
  // The cleared layout stays cleared on this device.
  await page.reload();
  await expect(rows(page)).toHaveCount(0);
});
