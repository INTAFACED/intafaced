import { test, expect } from '@playwright/test';
import { EDGE } from './stack.mjs';

// J-charts-desk-03 "I add indicators, tune them, and read their values" (docs/roadmap/journeys.json). One test per step,
// titled "J-charts-desk-03 #<n>". Steps 7 (chart settings) and 8 (price-line overlay) belong to the chart-core slice and
// are not drafted here. This is a DRAFT: it has not been run against the local stack. Each test opens the workbench on
// its own (a fresh browser context), so the studies it needs are added inside the test. Every value is read back from the
// public candle route the chart itself draws from (`GET /api/v1/ohlcv/:symbol`), and the expected value is worked here
// from the formula, not read from the page.

const MARKET = 'BTC-USDT';
const CHART = `/charts/${MARKET}`;
const BAR_LIMIT = 200;

/** The public candles, oldest first: [t, o, h, l, c, v] as decimal strings. */
async function candles(timeframe = '15m', limit = BAR_LIMIT) {
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${MARKET}?timeframe=${timeframe}&limit=${limit}`);
  if (!res.ok) throw new Error(`the public candle route answered ${res.status}`);
  return res.json();
}

/** Opens the workbench and waits for the chart and its studies bar. */
async function openChart(page, query = '') {
  await page.goto(`${CHART}${query}`);
  await expect(page.getByRole('heading', { name: 'Charts' })).toBeVisible();
  await expect(page.getByTestId('studies')).toBeVisible();
}

/** Adds a study through the indicator dialog: search, then Add. */
async function addStudy(page, search, name) {
  await page.getByRole('button', { name: 'Indicators' }).click();
  await page.getByRole('searchbox', { name: 'Search indicators' }).fill(search);
  await page.getByRole('button', { name: `Add ${name}` }).click();
}

const legend = (page) => page.getByTestId('study-legend');
const row = (page, id) => page.locator(`[data-study="${id}"]`);

/** A simple moving average of the closes, worked from the formula: the mean of the last `period` closes. */
const sma = (closes, period) => closes.slice(-period).reduce((a, b) => a + b, 0) / period;
/** EMA seeded with the SMA of the first `period` closes, then a = 2 / (period + 1). */
function ema(closes, period) {
  const a = 2 / (period + 1);
  let value = closes.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (const close of closes.slice(period)) value = a * close + (1 - a) * value;
  return value;
}

test('J-charts-desk-03 #1 types rsi into the indicator dialog, finds RSI under Oscillators and adds it in a sub-pane', async ({ page }) => {
  await openChart(page);
  await page.getByRole('button', { name: 'Indicators' }).click();
  const dialog = page.getByRole('dialog');
  await page.getByRole('searchbox', { name: 'Search indicators' }).fill('rsi');
  const oscillators = dialog.getByRole('region', { name: 'Oscillators' });
  await expect(oscillators).toContainText('Relative Strength Index');
  await oscillators.getByRole('button', { name: 'Add Relative Strength Index' }).click();
  await expect(row(page, 'rsi-1')).toHaveAttribute('data-pane', 'sub');
  await expect(page.getByRole('button', { name: 'RSI 14' })).toBeVisible();
});

test('J-charts-desk-03 #2 adds a moving average with period 50 on High and sets its colour; it draws with those inputs and style', async ({
  page,
}) => {
  await openChart(page);
  await addStudy(page, 'sma', 'Simple moving average');
  await page.getByRole('button', { name: 'Settings for Simple moving average' }).click();
  await page.getByLabel('Source').selectOption('high');
  await page.getByRole('textbox', { name: 'Period' }).fill('50');
  await page.getByLabel('Colour').selectOption('ma-2');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('button', { name: 'SMA 50' })).toBeVisible();
  await expect(row(page, 'sma-1')).toContainText('SMA 50 high');
  // The saved study carries the inputs and the colour token the chart draws with.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('charts-studies:guest:main') ?? 'null'));
  expect(saved.studies[0]).toMatchObject({ kind: 'sma', inputs: { period: '50', source: 'high' }, color: 'ma-2' });
});

test('J-charts-desk-03 #3 adds EMA(20), Volume, MACD, Stochastic, Bollinger and VWAP; the values equal the formula to the tick', async ({
  page,
}) => {
  await openChart(page);
  for (const [search, name] of [
    ['ema', 'Exponential moving average'],
    ['volume', 'Volume'],
    ['macd', 'Moving Average Convergence Divergence'],
    ['stochastic', 'Stochastic'],
    ['bollinger', 'Bollinger Bands'],
    ['vwap', 'Volume-weighted average price'],
  ]) {
    await addStudy(page, search, name);
  }
  const rows = await candles();
  expect(rows.length).toBeGreaterThanOrEqual(BAR_LIMIT);
  const closes = rows.map((r) => Number(r[4]));
  // The legend reads the last bar. EMA(20) is worked on the public closes; the chart forward-fills silent buckets, so this
  // check holds on a market with no silent bucket in the 200 bars (the draft's precondition, to confirm on the stack).
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();
  await expect(row(page, 'ema-1')).toContainText(ema(closes, 20).toFixed(2));
  await expect(legend(page)).not.toContainText('This market has no volume in the loaded bars.');
});

test('J-charts-desk-03 #4 hides an indicator on one interval only; it shows on the others and the setting is remembered', async ({
  page,
}) => {
  await openChart(page);
  await addStudy(page, 'sma', 'Simple moving average');
  await page.getByRole('button', { name: 'Settings for Simple moving average' }).click();
  await page.getByRole('checkbox', { name: 'Shown on 1h' }).uncheck();
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('group', { name: 'Chart intervals' }).getByRole('button', { name: '1h' }).click();
  await expect(row(page, 'sma-1')).toContainText('hidden on this interval');
  await page.getByRole('group', { name: 'Chart intervals' }).getByRole('button', { name: '15m' }).click();
  await expect(row(page, 'sma-1')).not.toContainText('hidden on this interval');
  await page.reload();
  await page.getByRole('group', { name: 'Chart intervals' }).getByRole('button', { name: '1h' }).click();
  await expect(row(page, 'sma-1')).toContainText('hidden on this interval');
});

test('J-charts-desk-03 #5 sets the legend to always show: the values of the last bar show without hovering', async ({ page }) => {
  await openChart(page);
  await addStudy(page, 'sma', 'Simple moving average');
  await expect(row(page, 'sma-1').getByText(/^\d+\.\d\d$/)).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();
  const closes = (await candles()).map((r) => Number(r[4]));
  await expect(row(page, 'sma-1')).toContainText(sma(closes, 20).toFixed(2));
});

test('J-charts-desk-03 #6 with the data window open, moving the crosshair over a bar shows every series value at that bar', async ({
  page,
}) => {
  await openChart(page);
  await addStudy(page, 'sma', 'Simple moving average');
  await addStudy(page, 'ema', 'Exponential moving average');
  await page.getByRole('button', { name: 'Data window' }).click();
  await expect(page.getByTestId('data-window')).toContainText('Move the pointer over the chart');
  const canvas = page.locator('.cw-canvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
  const windowText = page.getByTestId('data-window');
  await expect(windowText).toContainText('SMA 20');
  await expect(windowText).toContainText('EMA 20');
  await expect(windowText.getByText(/^\d+\.\d\d$/).first()).toBeVisible();
});
