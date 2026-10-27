import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { EDGE, journeyState, signOutBrowser } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-charts-desk-11, in the running app (docs/roadmap/journeys.json): watchlists beside the chart, kept on the account, with live
// quotes, a row click or drag opening its chart, symbol details, and CSV export and import. One test per step, titled
// "J-charts-desk-11 #<n>", run in order on one TEST account (the run file keeps it). Quotes are the stack's TEST prices, read
// through Edge; nothing here is typed from the page.
const J = 'J-charts-desk-11';
const CHART = '/charts/BTC-USDT';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

const panel = (page) => page.getByRole('region', { name: 'Watchlists' });
const row = (page, symbol) => panel(page).locator(`tr[data-symbol="${symbol}"]`);

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

async function openWorkbench(page) {
  await page.goto(CHART);
  await expect(panel(page)).toBeVisible();
}

/** The public ticker Edge serves for a symbol: the value the page must agree with. */
async function publicTicker(symbol) {
  const res = await fetch(`${EDGE}/api/v1/ticker/${encodeURIComponent(symbol)}`);
  expect(res.status).toBe(200);
  return res.json();
}

async function addMarket(page, query, symbol) {
  await panel(page).getByRole('searchbox', { name: 'Add a market' }).fill(query);
  await panel(page)
    .getByRole('button', { name: `Add ${symbol}` })
    .click();
}

test(`${J} #1 adds BTC-USDT by search to a list; it appears at the end and survives reload, and shows on another device`, async ({
  page,
  browser,
}) => {
  const who = await signUp(page, 'wl');
  run.reset({ account: who });
  // Sign-up leaves this browser signed in, and /login resets its form once the session refresh answers, which can wipe
  // the typed email. Start the sign-in signed out, as the other steps do.
  await signOutBrowser(page.context());
  await signIn(page, who);
  await openWorkbench(page);
  await addMarket(page, 'eth', 'ETH/USDT');
  await expect(row(page, 'ETH/USDT')).toBeVisible();
  // The save reply must land before the reload or the second device, or they would read the version before this write.
  const saved = page.waitForResponse((res) => /preferences/.test(res.url()) && res.request().method() !== 'GET' && res.ok());
  await addMarket(page, 'btc', 'BTC/USDT');
  await saved;
  const order = await panel(page)
    .locator('tbody tr[data-symbol]')
    .evaluateAll((rows) => rows.map((r) => r.dataset.symbol));
  expect(order).toEqual(['ETH/USDT', 'BTC/USDT']);
  // Survives reload on this device.
  await page.reload();
  await expect(row(page, 'BTC/USDT')).toBeVisible();
  // And on another device: a second browser context signs in and sees the same list from the account.
  const other = await browser.newContext({ baseURL: 'http://127.0.0.1:3210' });
  try {
    const second = await other.newPage();
    await signIn(second, who);
    await second.goto(CHART);
    await expect(panel(second).locator('tr[data-symbol="BTC/USDT"]')).toBeVisible();
    await expect(panel(second).locator('tr[data-symbol="ETH/USDT"]')).toBeVisible();
  } finally {
    await other.close();
  }
});

test(`${J} #2 sorts the list, resizes a column, adds a section and a second named list; the arrangement is kept`, async ({ page }) => {
  const who = run.read().account;
  await signIn(page, who);
  await openWorkbench(page);
  await panel(page).getByRole('button', { name: 'Sort by Last' }).click();
  await expect(panel(page).locator('table')).toHaveAttribute('data-sorted', 'last:asc');
  // Resize the Last column by dragging its separator to the right.
  const th = panel(page).getByRole('separator', { name: 'Resize Last column' });
  const before = await th.evaluate((el) => el.parentElement.getBoundingClientRect().width);
  const box = await th.boundingBox();
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => th.evaluate((el) => el.parentElement.getBoundingClientRect().width)).toBeGreaterThan(before + 40);
  // A section, then a second named list.
  await panel(page).getByRole('textbox', { name: 'New section name' }).fill('Layer 2');
  await panel(page).getByRole('button', { name: 'Add section' }).click();
  await expect(panel(page).getByRole('button', { name: 'Minimise Layer 2' })).toBeVisible();
  await panel(page).getByRole('button', { name: 'New list' }).click();
  await panel(page).getByRole('textbox', { name: 'New list name' }).fill('Alts');
  await panel(page).getByRole('button', { name: 'Create list' }).click();
  await expect(panel(page).getByRole('combobox', { name: 'List' })).toContainText('Alts');
  // Back to the first list after a reload: its sort and sections are kept.
  await page.reload();
  await panel(page).getByRole('combobox', { name: 'List' }).selectOption({ label: 'Watchlist' });
  await expect(panel(page).getByRole('button', { name: 'Minimise Layer 2' })).toBeVisible();
  await expect(panel(page).locator('table')).toHaveAttribute('data-sorted', 'last:asc');
});

test(`${J} #3 shows the last price and change of each row live, from the stack's own quotes`, async ({ page }) => {
  await signIn(page, account());
  await openWorkbench(page);
  const ticker = await publicTicker('BTC/USDT');
  await expect(row(page, 'BTC/USDT').locator('td[data-column="last"]')).toHaveAttribute('data-state', 'live');
  const cellText = row(page, 'BTC/USDT').locator('td[data-column="last"]');
  await expect(cellText).not.toHaveText('no data');
  // The page shows the same price Edge serves: within half a percent, since the quote may tick between the two reads.
  const shown = Number((await cellText.innerText()).replace(/[^0-9.-]/g, ''));
  const served = Number(ticker.last);
  expect(served).toBeGreaterThan(0);
  expect(Math.abs(shown - served) / served).toBeLessThan(0.005);
});

test(`${J} #4 a row click shows that market on the chart at the interval the workbench has; a drag onto the chart does the same`, async ({
  page,
}) => {
  await signIn(page, account());
  await page.goto('/charts/BTC-USDT?interval=15m');
  await expect(page.getByTestId('chart-title').first()).toHaveText('BTC/USDT · 15m');
  await row(page, 'ETH/USDT').getByRole('link', { name: 'ETH/USDT' }).click();
  await expect(page).toHaveURL(/\/charts\/ETH-USDT/);
  await expect(page.getByTestId('chart-title').first()).toHaveText('ETH/USDT · 15m');
  // Drag a row onto the chart, in steps: a single-jump dragTo never starts the browser's native drag here.
  const from = await row(page, 'BTC/USDT').boundingBox();
  const to = await page.getByTestId('cw-split-chart').boundingBox();
  await page.mouse.move(from.x + 12, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + from.height / 2, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect(page).toHaveURL(/\/charts\/BTC-USDT/);
  await expect(page.getByTestId('chart-title').first()).toHaveText('BTC/USDT · 15m');
});

test(`${J} #5 opens a symbol's details: statistics and market rules, with a stat the service does not serve shown as not served`, async ({
  page,
}) => {
  await signIn(page, account());
  await openWorkbench(page);
  await row(page, 'BTC/USDT').getByRole('button', { name: 'Details for BTC/USDT' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'BTC/USDT details' })).toBeVisible();
  const ticker = await publicTicker('BTC/USDT');
  await expect(dialog.getByRole('definition').first()).toHaveText(ticker.last ? ticker.last : 'not served');
  await expect(dialog.locator('dl[aria-label="Statistics"]')).toContainText('not served (spot market)');
  await expect(dialog.locator('dl[aria-label="Market rules"]')).toContainText('Price step');
  await page.keyboard.press('Escape');
});

test(`${J} #6 exports the list as a CSV file, and an import adds only the listed markets and reports the rest`, async ({ page }) => {
  await signIn(page, account());
  await openWorkbench(page);
  const downloading = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^watchlist-.*\.csv$/);
  const exported = readFileSync(await download.path(), 'utf8');
  expect(exported.split('\n')[0]).toBe('symbol,section,last,change_pct_24h,high_24h,low_24h,volume_24h');
  // Import a file: one listed market already on the list, one listed, one unknown.
  await panel(page)
    .getByLabel('Import CSV file')
    .setInputFiles({
      name: 'import.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('symbol\nIFC/USDT\nDOGE/USDT\nETH/USDT\n'),
    });
  const summary = panel(page).getByRole('status').filter({ hasText: 'added' });
  await expect(summary).toHaveCount(1);
  await expect(summary).toContainText('1 added');
  await expect(summary).toContainText('1 refused: unknown symbol');
  await expect(summary).toContainText('1 already listed');
  await expect(row(page, 'IFC/USDT')).toBeVisible();
  await expect(row(page, 'DOGE/USDT')).toHaveCount(0);
});
