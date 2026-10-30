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

/** The lines a drawing was last painted with, in pixels ([x1, y1, x2, y2]), read from the chart (`readDrawnLines`). */
async function drawnLines(row) {
  const id = await row.getAttribute('data-drawing-id');
  // Painted on the chart's next frame: wait for this drawing's plan before reading it.
  const host = page.getByTestId('cw').getByTestId('wc-host');
  await expect
    .poll(async () => host.evaluate((el, want) => (el.readDrawnLines?.().find((d) => d.id === want)?.lines.length ?? 0) > 0, id))
    .toBe(true);
  return page
    .getByTestId('cw')
    .getByTestId('wc-host')
    .evaluate((el, want) => el.readDrawnLines?.().find((d) => d.id === want)?.lines ?? null, id);
}
const slope = ([x1, y1, x2, y2]) => (y2 - y1) / (x2 - x1);
/** Two slopes are the same direction on screen (to a hundredth of a pixel per pixel). */
const sameSlope = (a, b) => Math.abs(slope(a) - slope(b)) <= 0.01 * Math.max(1, Math.abs(slope(a)));
/** A shown number is the worked value at two decimals (within half a cent). */
const atCents = (text, value) => /^-?\d+\.\d{2}$/.test(text) && Math.abs(Number(text) - value) <= 0.005 + 1e-9;
/** Selects a drawing from its tree row (the row's button toggles, so it is pressed only when not already selected). */
async function select(row, name) {
  const button = row.getByRole('button', { name });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}
const ms = (t) => Date.parse(`${t.replace(' ', 'T')}:00Z`);

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
  // The channel as drawn: its base line and the line through the third point have the same direction on screen.
  const lines = await drawnLines(channel);
  expect(lines?.length, 'the channel paints its base, its parallel and the dashed width').toBe(3);
  expect(sameSlope(lines[0], lines[1]), `base ${slope(lines[0])}, parallel ${slope(lines[1])}`).toBe(true);

  await pick(page, 'Pitchfork');
  await clickPlot(page, 0.2, 0.6);
  await clickPlot(page, 0.5, 0.3);
  await clickPlot(page, 0.5, 0.8);
  const fork = page.locator('[data-drawing-id][data-kind="pitchfork"]');
  await expect(fork).toHaveCount(1);
  // The pitchfork as drawn: the median from the first point runs through the midpoint of the other two, and both tines,
  // starting at those two points, run parallel to it.
  const [median, tineA, tineB] = await drawnLines(fork);
  expect(sameSlope(median, tineA) && sameSlope(median, tineB), `median ${slope(median)}, tines ${slope(tineA)} ${slope(tineB)}`).toBe(true);
  const mid = [(tineA[0] + tineB[0]) / 2, (tineA[1] + tineB[1]) / 2];
  const cross = (median[2] - median[0]) * (mid[1] - median[1]) - (median[3] - median[1]) * (mid[0] - median[0]);
  const length = Math.hypot(median[2] - median[0], median[3] - median[1]);
  expect(Math.abs(cross) / length, 'the midpoint lies on the median, in pixels').toBeLessThan(1);
});

test(`${J} #3 adds a Gann fan and a Fibonacci extension, each from its stated rule`, async () => {
  await pick(page, 'Gann fan');
  await clickPlot(page, 0.2, 0.8);
  await clickPlot(page, 0.4, 0.6);
  const fan = rowNamed(page, /^Gann fan \d+$/);
  await expect(figureLines(fan)).toHaveCount(GANN.length);
  // Its stated rule: the base slope is the price change per bar between the two points, and each line's slope is the base
  // times its ratio, at the tick.
  const fanText = await pointText(fan).textContent();
  const [pa, pb] = pricesOf(fanText).map(Number);
  const [ta, tb] = timesOf(fanText).map(ms);
  const base = (pb - pa) / ((tb - ta) / 900_000);
  const shownFan = await figureLines(fan).allTextContents();
  GANN.forEach((ratio, i) => {
    const m = new RegExp(`^Ratio ${ratio.replace('.', '\\.')}: (-?\\d+\\.\\d{2}) per bar$`).exec(shownFan[i]);
    expect(m && atCents(m[1], base * Number(ratio)), `${shownFan[i]} (worked ${base * Number(ratio)})`).toBe(true);
  });

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
  // Editable like any drawing: dragging its first point moves that point only.
  await select(pattern, /^Pattern \d+$/);
  const patternBefore = pricesOf(await pointText(pattern).textContent());
  const x0 = await plot(page, 0.1, 0.5);
  await page.mouse.move(x0.x, x0.y);
  await page.mouse.down();
  await page.mouse.move(x0.x, x0.y - 30, { steps: 6 });
  await page.mouse.up();
  const patternAfter = pricesOf(await pointText(pattern).textContent());
  expect(patternAfter[0]).not.toBe(patternBefore[0]);
  expect(patternAfter.slice(1)).toEqual(patternBefore.slice(1));

  await pick(page, 'Ellipse');
  await clickPlot(page, 0.6, 0.3);
  await clickPlot(page, 0.75, 0.45);
  const ellipse = page.locator('[data-drawing-id][data-kind="ellipse"]');
  await expect(ellipse).toHaveCount(1);
  // Editable: dragging its middle moves both points by the same price.
  const ellipseBefore = pricesOf(await pointText(ellipse).textContent()).map(Number);
  const [e1, e2] = [await plot(page, 0.6, 0.3), await plot(page, 0.75, 0.45)];
  await page.mouse.move((e1.x + e2.x) / 2, (e1.y + e2.y) / 2);
  await page.mouse.down();
  await page.mouse.move((e1.x + e2.x) / 2, (e1.y + e2.y) / 2 + 25, { steps: 6 });
  await page.mouse.up();
  const ellipseAfter = pricesOf(await pointText(ellipse).textContent()).map(Number);
  expect(ellipseAfter[0]).not.toBe(ellipseBefore[0]);
  expect(Math.abs(ellipseAfter[0] - ellipseBefore[0] - (ellipseAfter[1] - ellipseBefore[1]))).toBeLessThan(0.005);

  await pick(page, 'Brush');
  const start = await plot(page, 0.6, 0.6);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) await page.mouse.move(start.x + i * 12, start.y + (i % 2) * 10, { steps: 2 });
  await page.mouse.up();
  const brush = rowNamed(page, /^Brush \d+$/);
  await expect(brush).toHaveAttribute('data-kind', 'brush');
  const stroke = await pointText(brush).textContent();
  expect(pricesOf(stroke).length).toBeGreaterThanOrEqual(2);
  // Editable like any drawing: it can be selected and deleted, and Undo brings the same stroke back.
  await select(brush, /^Brush \d+$/);
  const count = await rows(page).count();
  await page.keyboard.press('Delete');
  await expect(rows(page)).toHaveCount(count - 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(pointText(rowNamed(page, /^Brush \d+$/))).toHaveText(stroke);
});

test(`${J} #5 places a long position box with entry, stop and target: the risk to reward and the distances, and no order`, async () => {
  await pick(page, 'Long position');
  await clickPlot(page, 0.3, 0.5);
  await clickPlot(page, 0.4, 0.6);
  await clickPlot(page, 0.5, 0.4);
  const box = rowNamed(page, /^Long position \d+$/);
  const [entry, stop, target] = pricesOf(await pointText(box).textContent()).map(Number);
  const lines = await figureLines(box).allTextContents();
  // The distances: risk is entry minus stop and reward is target minus entry, at the tick, each with its percent of the
  // entry; then the reward to risk ratio; and no order is placed.
  const [risk, reward] = [entry - stop, target - entry];
  const riskLine = /^Risk (\d+\.\d{2}) \((\d+\.\d+)%\)$/.exec(lines[0]);
  const rewardLine = /^Reward (\d+\.\d{2}) \((\d+\.\d+)%\)$/.exec(lines[1]);
  expect(riskLine && atCents(riskLine[1], risk), `${lines[0]} (risk ${risk})`).toBe(true);
  expect(rewardLine && atCents(rewardLine[1], reward), `${lines[1]} (reward ${reward})`).toBe(true);
  expect(Math.abs(Number(riskLine[2]) - (risk / entry) * 100)).toBeLessThanOrEqual(0.005 + 1e-9);
  expect(Math.abs(Number(rewardLine[2]) - (reward / entry) * 100)).toBeLessThanOrEqual(0.005 + 1e-9);
  const ratio = /^Reward to risk (\d+\.\d{2})$/.exec(lines[2]);
  expect(ratio && atCents(ratio[1], reward / risk), `${lines[2]} (worked ${reward / risk})`).toBe(true);
  expect(lines[3]).toContain('places no order');
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
  // The price difference keeps its sign: a fall from the first point to the second is negative.
  const diff = cents(prices[1] - prices[0]);
  const span = Math.abs(times[1] - times[0]);
  const days = Math.floor(span / 86_400);
  const hours = String(Math.floor((span % 86_400) / 3_600)).padStart(2, '0');
  const minutes = String(Math.floor((span % 3_600) / 60)).padStart(2, '0');
  const lines = await figureLines(measure).allTextContents();
  expect(lines).toContain(`${bars} bars`);
  expect(lines).toContain(`Price difference ${diff}`);
  expect(lines).toContain(`Time span ${days}d ${hours}h ${minutes}m`);
});
