import { expect } from '@playwright/test';

// What a person does on the chart workbench's drawing tools in the running app, shared by the charts-desk journeys. The
// drawings are kept on this device, so one journey keeps one browser context for all its steps (see its own file).

export const WORKBENCH = '/charts/BTC-USDT';

export async function openWorkbench(page) {
  await page.goto(WORKBENCH);
  await expect(page.locator('.cw .wc-host')).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Drawing tools' })).toBeVisible();
}

/** A point on the chart as a fraction of its width and height, in page pixels. Bars are placed by fraction, not by index. */
export async function plot(page, fx, fy) {
  const box = await page.locator('.cw .wc-host').boundingBox();
  if (!box) throw new Error('the chart has no box on the page');
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
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
export const pointText = (row) => row.locator('[data-testid="drawing-points"]');
export const figureLines = (row) => row.locator('[data-testid="drawing-figures"] li');

/** The prices in a row's point text, in the order stored: "... · 65000.10 | ... · 65100.50" gives ["65000.10", "65100.50"]. */
export const pricesOf = (text) => [...text.matchAll(/· (-?\d+(?:\.\d+)?)/g)].map((m) => m[1]);

/** The stored bar times of a row, as the tree shows them (UTC, to the minute). */
export const timesOf = (text) => [...text.matchAll(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC/g)].map((m) => m[1]);

/** A row by its name, as the tree names it ("Trend line 1"). */
export const rowNamed = (page, pattern) => page.locator('[data-drawing-id]').filter({ has: page.getByRole('button', { name: pattern }) });
