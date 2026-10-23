import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { EDGE, journeyState } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-charts-desk-12, in the running app (docs/roadmap/journeys.json): screen the market by filters, pick columns and a timeframe
// per column, save the screen and reopen it, switch between table and chart views, and screen one watchlist. One test per step,
// titled "J-charts-desk-12 #<n>", run in order on one TEST account (the run file keeps it). Expected counts come from the public
// market and ticker routes, never from the page.
const J = 'J-charts-desk-12';
const SCREENER = '/trade/screener';

const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** The listed spot markets (real, not paper) and their tickers from Edge: the numbers the screen must agree with. */
async function publicMarkets() {
  const markets = await (await fetch(`${EDGE}/api/v1/markets?limit=500`)).json();
  const tickers = await (await fetch(`${EDGE}/api/v1/tickers?limit=500`)).json();
  return markets.filter((m) => m.spot && !m.paper).map((m) => ({ symbol: m.symbol, quote: m.quote, ticker: tickers[m.symbol] ?? null }));
}

const countText = (page) =>
  page
    .getByRole('status')
    .filter({ hasText: /markets match|markets listed|No market|Loading/ })
    .first();

test(`${J} #1 applies "change above 5 percent and quote USDT": rows matching both, with the count; no match shows the empty state naming the filter`, async ({
  page,
}) => {
  const who = await signUp(page, 'sc');
  run.reset({ account: who });
  await signIn(page, who);
  await page.goto(SCREENER);
  await page.getByRole('combobox', { name: 'Quote' }).selectOption('USDT');
  await page.getByRole('textbox', { name: 'Change above, percent' }).fill('5');
  const expected = (await publicMarkets()).filter(
    (m) => m.quote === 'USDT' && m.ticker?.percentage !== undefined && Number(m.ticker.percentage) >= 5,
  );
  await expect(countText(page)).toHaveText(`${expected.length} markets match`);
  for (const m of expected) await expect(page.locator(`tr[data-symbol="${m.symbol}"]`)).toBeVisible();
  // No match: a bound no market reaches names the change filter.
  await page.getByRole('textbox', { name: 'Change above, percent' }).fill('90');
  await expect(countText(page)).toContainText('change filter removed every market');
});

test(`${J} #2 picks columns and a per-column timeframe; the columns change, and 4 h reads not served`, async ({ page }) => {
  await signIn(page, account());
  await page.goto(SCREENER);
  await page.getByRole('textbox', { name: 'Change above, percent' }).fill('');
  await page.getByRole('checkbox', { name: 'Volume' }).uncheck();
  await page.getByRole('checkbox', { name: 'High' }).check();
  await expect(page.locator('table[data-view="table"] thead th')).toContainText(['High']);
  await expect(page.locator('table[data-view="table"] thead th')).not.toContainText(['Volume']);
  await page.getByRole('combobox', { name: 'Change over' }).selectOption('1h');
  await expect(page.locator('table[data-view="table"] thead th')).toContainText(['Change 1h']);
  const cell = page.locator('tr[data-symbol="BTC/USDT"] td[data-column="change"]');
  await expect(cell).not.toHaveText('not served');
  await page.getByRole('combobox', { name: 'Change over' }).selectOption('4h');
  await expect(cell).toHaveText('not served');
  await expect(page.locator('tr[data-symbol="BTC/USDT"] td[data-column="last"]')).not.toHaveText('not served');
});

test(`${J} #3 saves the screen and reopens it with its filters; saving the same name asks to replace`, async ({ page }) => {
  await signIn(page, account());
  await page.goto(SCREENER);
  await page.getByRole('combobox', { name: 'Quote' }).selectOption('USDT');
  await page.getByRole('textbox', { name: 'Change above, percent' }).fill('5');
  await page.getByRole('textbox', { name: 'Screen name' }).fill('Momentum');
  await page.getByRole('button', { name: 'Save screen' }).click();
  await expect(page.getByRole('status')).toContainText('Saved as Momentum');
  await page.reload();
  await page.getByRole('combobox', { name: 'Quote' }).selectOption('');
  await page.getByRole('textbox', { name: 'Change above, percent' }).fill('');
  await page.getByRole('button', { name: 'Open Momentum' }).click();
  await expect(page.getByRole('combobox', { name: 'Quote' })).toHaveValue('USDT');
  await expect(page.getByRole('textbox', { name: 'Change above, percent' })).toHaveValue('5');
  // The same name again asks first.
  await page.getByRole('textbox', { name: 'Screen name' }).fill('Momentum');
  await page.getByRole('button', { name: 'Save screen' }).click();
  await expect(page.getByText('A screen named Momentum exists. Replace it?')).toBeVisible();
});

test(`${J} #4 switches between table and chart view; the same results appear in each`, async ({ page }) => {
  await signIn(page, account());
  await page.goto(SCREENER);
  const inTable = await page
    .locator('table[data-view="table"] tbody tr[data-symbol]')
    .evaluateAll((rows) => rows.map((r) => r.dataset.symbol));
  await page.getByRole('button', { name: 'Chart', exact: true }).click();
  const inChart = await page.locator('ul[data-view="chart"] li[data-symbol]').evaluateAll((items) => items.map((i) => i.dataset.symbol));
  expect(inChart).toEqual(inTable);
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page.locator('table[data-view="table"]')).toBeVisible();
});

test(`${J} #5 screens one watchlist only, and exports the results as a file`, async ({ page }) => {
  await signIn(page, account());
  // A watchlist with two markets, made on the chart workbench's panel.
  await page.goto('/charts/BTC-USDT');
  const panel = page.getByRole('region', { name: 'Watchlists' });
  await panel.getByRole('searchbox', { name: 'Add a market' }).fill('btc');
  await panel.getByRole('button', { name: 'Add BTC/USDT' }).click();
  await panel.getByRole('searchbox', { name: 'Add a market' }).fill('eth/usdt');
  await panel.getByRole('button', { name: 'Add ETH/USDT' }).click();
  await page.goto(SCREENER);
  await page.getByRole('combobox', { name: 'Markets' }).selectOption({ label: 'One watchlist: Watchlist' });
  await expect(page.locator('tbody tr[data-symbol]')).toHaveCount(2);
  await expect(page.locator('tr[data-symbol="BTC/USDT"]')).toBeVisible();
  await expect(page.locator('tr[data-symbol="ETH/USDT"]')).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export results' }).click();
  const download = await downloading;
  const lines = readFileSync(await download.path(), 'utf8')
    .trim()
    .split('\n');
  expect(lines[0].startsWith('symbol,')).toBe(true);
  expect(
    lines
      .slice(1)
      .map((line) => line.split(',')[0])
      .sort(),
  ).toEqual(['BTC/USDT', 'ETH/USDT']);
});
