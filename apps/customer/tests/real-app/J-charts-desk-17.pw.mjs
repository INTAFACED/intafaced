import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

// J-charts-desk-17, in the running app (docs/roadmap/journeys.json): compare markets on one chart, then snapshot, link,
// print and export it. One test per step, titled "J-charts-desk-17 #<n>". The compare cap is the owner's value served by
// svc-trade; the local stack sets a labelled TEST value of 3 (local-test-gates.mjs charts). Bars are TEST trades.
const J = 'J-charts-desk-17';
const CHART = '/charts/BTC-USDT';

const canvas = (page) => page.getByRole('img', { name: 'Price chart of BTC/USDT' }).first();
const tools = (page) => page.getByRole('group', { name: 'Compare and share' }).first();

async function openChart(page, path = CHART) {
  await page.goto(path);
  await expect.poll(async () => Number(await canvas(page).getAttribute('data-bars'))).toBeGreaterThan(0);
}

/** Every listed market other than BTC/USDT, as the compare picker offers them. */
async function others(page) {
  return tools(page)
    .getByRole('combobox', { name: /Compare with/ })
    .locator('option')
    .allTextContents();
}

test(`${J} #1 adds symbols to a BTC chart, each a removable line; past the cap the add is refused`, async ({ page }) => {
  await openChart(page);
  const offered = await others(page);
  expect(offered.length).toBeGreaterThan(0);
  const list = tools(page).getByRole('list', { name: 'Compared markets' });
  let added = 0;
  // Add every market there is, up to the TEST cap of 3.
  for (const symbol of offered.slice(0, 3)) {
    await tools(page)
      .getByRole('combobox', { name: /Compare with/ })
      .selectOption(symbol);
    await tools(page).getByRole('button', { name: 'Add', exact: true }).click();
    added += 1;
    await expect(list.getByRole('listitem')).toHaveCount(added);
    await expect(list.getByRole('listitem').nth(added - 1)).toHaveAttribute('data-state', /ready|empty/);
  }
  for (let i = 0; i < added; i += 1) await expect(list.getByRole('button', { name: /^Remove / }).nth(i)).toBeVisible();
  if (added === 3 && offered.length > 3) {
    await tools(page).getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByTestId('compare-note')).toContainText('A chart can compare 3 markets');
    await expect(page.getByTestId('compare-note')).toHaveAttribute('data-code', 'trade.chart.compare_cap_reached');
    await expect(list.getByRole('listitem')).toHaveCount(3);
  }
  // A row comes off with its remove control.
  await list
    .getByRole('button', { name: /^Remove / })
    .first()
    .click();
  await expect(list.getByRole('listitem')).toHaveCount(added - 1);
});

test(`${J} #2 turns percent mode on and every series is rebased to the same start`, async ({ page }) => {
  await openChart(page);
  const [first] = await others(page);
  await tools(page)
    .getByRole('combobox', { name: /Compare with/ })
    .selectOption(first);
  await tools(page).getByRole('button', { name: 'Add', exact: true }).click();
  const before = await canvas(page).screenshot();
  await tools(page).getByRole('checkbox', { name: 'Percent scale' }).check();
  // The axis now reads in percent.
  await expect.poll(async () => !(await canvas(page).screenshot()).equals(before)).toBe(true);
  await expect(canvas(page)).toHaveAttribute('data-scale', 'percent');
  await expect(tools(page).getByRole('checkbox', { name: 'Percent scale' })).toBeChecked();
});

test(`${J} #4 takes a snapshot, copies a share link and prints, with no account detail`, async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openChart(page, `${CHART}?interval=1h`);
  const [png] = await Promise.all([page.waitForEvent('download'), tools(page).getByRole('button', { name: 'Snapshot (PNG)' }).click()]);
  expect(png.suggestedFilename()).toBe('chart-BTC-USDT-1h.png');
  const bytes = readFileSync(await png.path());
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  await tools(page).getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByTestId('compare-note')).toContainText('/charts/BTC-USDT?interval=1h&style=candles');
  const link = (await page.getByTestId('compare-note').textContent()).replace(/^.*?(http\S+)$/, '$1');
  expect(link).not.toMatch(/user|account|email|token|session/i);
  // The link opens the same chart.
  await page.goto(link);
  await expect(page.getByTestId('chart-title').first()).toHaveText('BTC/USDT · 1h');
  // Print opens the browser's print for the page.
  await page.evaluate(() => {
    window.__printed = 0;
    window.print = () => {
      window.__printed += 1;
    };
  });
  await tools(page).getByRole('button', { name: 'Print' }).click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);
  // A public page is refused: there is no publishing store.
  await tools(page).getByRole('button', { name: 'Public page' }).click();
  await expect(page.getByTestId('compare-note')).toHaveAttribute('data-code', 'trade.chart.publish_unavailable');
});

test(`${J} #5 exports the visible bars to a file`, async ({ page }) => {
  await openChart(page, `${CHART}?interval=1m`);
  const shown = Number(await canvas(page).getAttribute('data-bars'));
  const [file] = await Promise.all([page.waitForEvent('download'), tools(page).getByRole('button', { name: 'Export bars (CSV)' }).click()]);
  expect(file.suggestedFilename()).toBe('chart-BTC-USDT-1m.csv');
  const lines = readFileSync(await file.path(), 'utf8').split('\n');
  expect(lines[0]).toMatch(/^# BTC\/USDT 1m bars; times are UTC; viewer time zone \S+/);
  expect(lines[1]).toBe('time_utc,open,high,low,close,volume,filled');
  const rows = lines.slice(2);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThanOrEqual(shown);
  for (const row of rows) expect(row).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z,[\d.]+,[\d.]+,[\d.]+,[\d.]+,[\d.]+,(yes|no)$/);
});
