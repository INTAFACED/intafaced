import { test, expect } from '@playwright/test';
import { clickPlot, openWorkbench, pick, plot, pointText, pricesOf, rowNamed, rows } from './charts-desk.mjs';

// J-charts-desk-05 "I draw on the chart: lines, text, select and move, lock, undo and delete", in the running app. One test
// per step, titled "J-charts-desk-05 #<n>", run in order in one browser context: drawings are kept on this device, so the
// steps share the page. Drawings are placed by fractions of the chart's width and height, never by a bar index.
const J = 'J-charts-desk-05';

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

test(`${J} #1 opens the drawing toolbar and picks the trend line, then two clicks place it as bar times and decimal prices`, async () => {
  await pick(page, 'Trend line');
  await clickPlot(page, 0.3, 0.4);
  await clickPlot(page, 0.6, 0.5);
  await expect(rows(page)).toHaveCount(1);
  const text = await pointText(rows(page).first()).textContent();
  // Two points, each a bar time and a price with the tick's places (two for BTC-USDT's 0.01 tick).
  expect(pricesOf(text)).toHaveLength(2);
  for (const price of pricesOf(text)) expect(price).toMatch(/^\d+\.\d{2}$/);
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
});

test(`${J} #3 adds text at the chosen point, with its own label`, async () => {
  await pick(page, 'Text');
  await page.getByLabel('Text to place or edit').first().fill('Support');
  await clickPlot(page, 0.25, 0.9);
  // The text is stored with the drawing and shown in the object tree.
  await expect(page.locator('[data-drawing-id][data-kind="text"]')).toHaveCount(1);
  await expect(page.locator('[data-drawing-id][data-kind="text"]').getByRole('textbox', { name: 'Text to place or edit' })).toHaveValue(
    'Support',
  );
  // Font size and colour are not offered in this build: the text takes the default size and the neutral tone.
});

test(`${J} #4 drags a line's middle handle, and both points move by the same bar and price delta`, async () => {
  const trend = rowNamed(page, /^Trend line \d+$/);
  await trend.getByRole('button', { name: /^Trend line \d+$/ }).click();
  const before = pricesOf(await pointText(trend).textContent());
  const a = await plot(page, 0.3, 0.4);
  const b = await plot(page, 0.6, 0.5);
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x + 40, middle.y - 12, { steps: 8 });
  await page.mouse.up();
  const after = pricesOf(await pointText(trend).textContent());
  expect(after).not.toEqual(before);
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
});

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
  await expect(page.locator('[data-visible="false"]').first()).toBeVisible();
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
