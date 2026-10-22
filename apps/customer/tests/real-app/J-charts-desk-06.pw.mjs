import { test, expect } from '@playwright/test';
import { clickPlot, figureLines, openWorkbench, pick, plot, pointText, pricesOf, rowNamed, rows, timesOf } from './charts-desk.mjs';

// J-charts-desk-06 "I mark up a trade idea with Fibonacci, channels, patterns and position boxes", in the running app. One
// test per step, titled "J-charts-desk-06 #<n>", run in order in one browser context (drawings are kept on this device).
// The figures are checked against the same arithmetic on the stored points, at the tick size (BTC-USDT, 0.01).
//
// Gaps this draft does not close: the brush needs the owner's point cap set on this workbench (a TEST value); until it is,
// step 4's stroke is refused with its typed message and the step fails on purpose. Bar 50 and bar 80 are placed by
// fraction of the chart's width, so the figures are checked against the stored points, not the bar indexes.
const J = 'J-charts-desk-06';
const LEVELS = ['0', '0.236', '0.382', '0.5', '0.618', '0.786', '1'];
const EXTENSION = ['0', '0.618', '1', '1.618', '2.618'];
const GANN = ['0.125', '0.25', '0.5', '1', '2', '4', '8'];

/** Test arithmetic only: the expected figure at two decimals, for the fixture's own points. */
const cents = (value) => (Math.round(value * 100) / 100).toFixed(2);

test.describe.configure({ mode: 'serial' });

let page;
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  await openWorkbench(page);
});
test.afterAll(async () => {
  await page?.context().close();
});

test(`${J} #1 draws a Fibonacci retracement, and its levels are the figures of the two points at the tick`, async () => {
  await pick(page, 'Fib retracement');
  await clickPlot(page, 0.3, 0.3);
  await clickPlot(page, 0.6, 0.6);
  const row = rowNamed(page, /^Fib retracement \d+$/);
  const [a, b] = pricesOf(await pointText(row).textContent()).map(Number);
  const expected = LEVELS.map((level) => `${level} at ${cents(b + (a - b) * Number(level))}`);
  const shown = await figureLines(row).allTextContents();
  expect(shown).toEqual(expected);
});

test(`${J} #2 draws a parallel channel and a pitchfork, and a moved point keeps the other points where they are`, async () => {
  await pick(page, 'Parallel channel');
  await clickPlot(page, 0.2, 0.5);
  await clickPlot(page, 0.5, 0.4);
  await clickPlot(page, 0.4, 0.7);
  const channel = rowNamed(page, /^Parallel channel \d+$/);
  const before = pricesOf(await pointText(channel).textContent());
  // Drag the channel's second point; the channel's own lines are re-planned from the points, so they stay parallel.
  const from = await plot(page, 0.5, 0.4);
  const to = await plot(page, 0.55, 0.35);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  const after = pricesOf(await pointText(channel).textContent());
  expect(after[0]).toBe(before[0]);
  expect(after[2]).toBe(before[2]);
  expect(after[1]).not.toBe(before[1]);

  await pick(page, 'Pitchfork');
  await clickPlot(page, 0.2, 0.6);
  await clickPlot(page, 0.5, 0.3);
  await clickPlot(page, 0.5, 0.8);
  await expect(page.locator('[data-drawing-id][data-kind="pitchfork"]')).toHaveCount(1);
});

test(`${J} #3 adds a Gann fan and a Fibonacci extension, each from its stated rule`, async () => {
  await pick(page, 'Gann fan');
  await clickPlot(page, 0.2, 0.8);
  await clickPlot(page, 0.4, 0.6);
  const fan = rowNamed(page, /^Gann fan \d+$/);
  await expect(figureLines(fan)).toHaveCount(GANN.length);

  await pick(page, 'Fib extension');
  await clickPlot(page, 0.2, 0.7);
  await clickPlot(page, 0.4, 0.5);
  await clickPlot(page, 0.5, 0.6);
  const extension = rowNamed(page, /^Fib extension \d+$/);
  const [a, b, c] = pricesOf(await pointText(extension).textContent()).map(Number);
  const expected = EXTENSION.map((level) => `${level} at ${cents(c + (b - a) * Number(level))}`);
  expect(await figureLines(extension).allTextContents()).toEqual(expected);
});

test(`${J} #4 draws a pattern and a shape, and uses the brush: each is stored and editable like any drawing`, async () => {
  await pick(page, 'Pattern XABCD');
  for (const [fx, fy] of [
    [0.1, 0.5],
    [0.2, 0.3],
    [0.3, 0.6],
    [0.4, 0.35],
    [0.5, 0.55],
  ]) {
    await clickPlot(page, fx, fy);
  }
  const pattern = rowNamed(page, /^Pattern \d+$/);
  await expect(pattern).toHaveAttribute('data-kind', 'pattern');
  expect(pricesOf(await pointText(pattern).textContent())).toHaveLength(5);

  await pick(page, 'Ellipse');
  await clickPlot(page, 0.6, 0.3);
  await clickPlot(page, 0.75, 0.45);
  await expect(page.locator('[data-drawing-id][data-kind="ellipse"]')).toHaveCount(1);

  await pick(page, 'Brush');
  const start = await plot(page, 0.6, 0.6);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) await page.mouse.move(start.x + i * 12, start.y + (i % 2) * 10, { steps: 2 });
  await page.mouse.up();
  const brush = rowNamed(page, /^Brush \d+$/);
  await expect(brush).toHaveAttribute('data-kind', 'brush');
  expect(pricesOf(await pointText(brush).textContent()).length).toBeGreaterThanOrEqual(2);
});

test(`${J} #5 places a long position box with entry, stop and target: the risk to reward and the distances, and no order`, async () => {
  await pick(page, 'Long position');
  await clickPlot(page, 0.3, 0.5);
  await clickPlot(page, 0.4, 0.6);
  await clickPlot(page, 0.5, 0.4);
  const box = rowNamed(page, /^Long position \d+$/);
  const [entry, stop, target] = pricesOf(await pointText(box).textContent()).map(Number);
  const ratio = ((target - entry) / (entry - stop)).toFixed(2);
  const lines = await figureLines(box).allTextContents();
  expect(lines.some((line) => line === `Risk to reward ${ratio}` || line === `Reward to risk ${ratio}`)).toBe(true);
  expect(lines.some((line) => line.includes('places no order'))).toBe(true);
});

test(`${J} #6 measures between two bars and two prices: the bars, the price difference at the tick and the time span`, async () => {
  await pick(page, 'Measure');
  await clickPlot(page, 0.2, 0.3);
  await clickPlot(page, 0.7, 0.7);
  const measure = rowNamed(page, /^Measure \d+$/);
  const prices = pricesOf(await pointText(measure).textContent()).map(Number);
  const times = timesOf(await pointText(measure).textContent()).map((t) => Date.parse(`${t.replace(' ', 'T')}:00Z`) / 1000);
  // The chart opens at 15m (the default interval): bars are the time difference over 900 seconds.
  const bars = Math.abs(times[1] - times[0]) / 900;
  const diff = cents(Math.abs(prices[1] - prices[0]));
  const span = Math.abs(times[1] - times[0]);
  const days = Math.floor(span / 86_400);
  const hours = String(Math.floor((span % 86_400) / 3_600)).padStart(2, '0');
  const minutes = String(Math.floor((span % 3_600) / 60)).padStart(2, '0');
  const lines = await figureLines(measure).allTextContents();
  expect(lines).toContain(`${bars} bars`);
  expect(lines).toContain(`Price difference ${diff}`);
  expect(lines).toContain(`Time span ${days}d ${hours}h ${minutes}m`);
});
