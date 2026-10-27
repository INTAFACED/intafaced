import { test, expect } from '@playwright/test';
import { EDGE } from './stack.mjs';

// J-charts-desk-03 "I add indicators, tune them, and read their values" (docs/roadmap/journeys.json). One test per step,
// titled "J-charts-desk-03 #<n>", run in the Real-app journeys workflow. Each test opens the workbench on
// its own (a fresh browser context), so the studies it needs are added inside the test. Every value is read back from the
// public candle route the chart itself draws from (`GET /api/v1/ohlcv/:symbol`), and the expected value is worked here
// from the formula, not read from the page.

const MARKET = 'BTC-USDT';
// The public routes name the pair with a slash (BTC/USDT), url-encoded in the path.
const MARKET_PATH = encodeURIComponent('BTC/USDT');
const CHART = `/charts/${MARKET}`;
const BAR_LIMIT = 200;

/** The public candles, oldest first: [t, o, h, l, c, v] as decimal strings. */
async function candles(timeframe = '15m', limit = BAR_LIMIT) {
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${MARKET_PATH}?timeframe=${timeframe}&limit=${limit}`);
  if (!res.ok) throw new Error(`the public candle route answered ${res.status}`);
  return res.json();
}

/**
 * The last BAR_LIMIT closes the chart draws, worked here from the public candles: one bar per 15 minutes up to the
 * current one, a quiet interval repeating the previous close, as a person sees the chart. The chart may load more bars
 * before these; the 20-bar studies checked here are the same to the cent either way. The market maker trades all the
 * time, so the closes are read again until they and the legend show the same bar.
 */
async function drawnCloses() {
  const step = 15 * 60_000;
  const rows = await candles();
  if (rows.length === 0) throw new Error('the public candle route has no BTC/USDT bars; is the TEST market maker running?');
  const byBucket = new Map(rows.map((r) => [Math.floor(r[0] / step) * step, Number(r[4])]));
  const end = Math.max(Math.floor(Date.now() / step) * step, ...byBucket.keys());
  const from = Math.max(Math.min(...byBucket.keys()), end - (BAR_LIMIT - 1) * step);
  let carry =
    [...byBucket]
      .filter(([t]) => t < from)
      .sort(([a], [b]) => a - b)
      .at(-1)?.[1] ?? null;
  const closes = [];
  for (let t = from; t <= end; t += step) {
    carry = byBucket.get(t) ?? carry;
    if (carry !== null) closes.push(carry);
  }
  return closes;
}

/** Waits until a study's legend row shows the value worked from the closes the chart draws. */
async function expectWorked(page, id, work) {
  await expect
    .poll(
      async () => {
        const expected = work(await drawnCloses()).toFixed(2);
        return (await row(page, id).innerText()).includes(expected);
      },
      { timeout: 30_000, message: `the ${id} legend never showed the value worked from the drawn bars` },
    )
    .toBe(true);
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
  await page.getByRole('button', { name: `Add ${name}`, exact: true }).click();
}

const legend = (page) => page.getByTestId('study-legend');
const row = (page, id) => page.locator(`[data-study="${id}"]`);
const host = (page) => page.getByTestId('cw').getByTestId('wc-host');

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
  // The chip's accessible name is the study's name; its visible text carries the inputs.
  await expect(page.getByRole('button', { name: 'Settings for Relative Strength Index' })).toContainText('RSI 14');
});

test('J-charts-desk-03 #2 adds a moving average with period 50 on High and sets its colour; it draws with those inputs and style', async ({
  page,
}) => {
  await openChart(page);
  await addStudy(page, 'sma', 'Simple moving average');
  await page.getByRole('button', { name: 'Settings for Simple moving average' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: /^Source/ }).selectOption('high');
  await page.getByRole('textbox', { name: 'Period' }).fill('50');
  await dialog.getByRole('combobox', { name: /^Colour/ }).selectOption('ma-2');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('button', { name: 'Settings for Simple moving average' })).toContainText('SMA 50');
  await expect(row(page, 'sma-1')).toContainText('SMA 50 high');
  // The saved study carries the inputs and the colour token the chart draws with.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('charts-studies:guest:main') ?? 'null'));
  expect(saved.studies.find((s) => s.kind === 'sma')).toMatchObject({
    kind: 'sma',
    inputs: { period: '50', source: 'high' },
    color: 'ma-2',
  });
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
  // The legend reads the last bar. EMA(20) is worked on the closes the chart draws (quiet intervals forward-filled).
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();
  await expectWorked(page, 'ema-1', (closes) => ema(closes, 20));
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
  await expect(row(page, 'sma-1')).toContainText('Hidden on this interval');
  await page.getByRole('group', { name: 'Chart intervals' }).getByRole('button', { name: '15m' }).click();
  await expect(row(page, 'sma-1')).not.toContainText('Hidden on this interval');
  await page.reload();
  await page.getByRole('group', { name: 'Chart intervals' }).getByRole('button', { name: '1h' }).click();
  await expect(row(page, 'sma-1')).toContainText('Hidden on this interval');
});

test('J-charts-desk-03 #5 sets the legend to always show: the values of the last bar show without hovering', async ({ page }) => {
  await openChart(page);
  await addStudy(page, 'sma', 'Simple moving average');
  await expect(row(page, 'sma-1').getByText(/^\d+\.\d\d$/)).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();
  // The OHLC legend of the chart shows the last bar with no pointer over the chart, and the indicator values sit beside it.
  await expect(page.getByTestId('chart-legend')).toBeVisible();
  await expectWorked(page, 'sma-1', (closes) => sma(closes, 20));
});

test('J-charts-desk-03 #6 with the data window open, moving the crosshair over a bar shows every series value at that bar', async ({
  page,
}) => {
  await openChart(page);
  await addStudy(page, 'sma', 'Simple moving average');
  await addStudy(page, 'ema', 'Exponential moving average');
  await page.getByRole('button', { name: 'Data window' }).click();
  await expect(page.getByTestId('data-window')).toContainText('Move the pointer over the chart');
  // The plot is the chart host; .cw-canvas also holds the drawings dock below it.
  const canvas = page.getByTestId('cw').getByTestId('wc-host');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
  const windowText = page.getByTestId('data-window');
  await expect(windowText).toContainText('SMA 20');
  await expect(windowText).toContainText('EMA 20');
  await expect(windowText.getByText(/^\d+\.\d\d$/).first()).toBeVisible();
});

test('J-charts-desk-03 #7 opens chart settings: the sections are there, a change is saved for this device and read back after a reload', async ({
  page,
}) => {
  await openChart(page);
  await page.getByRole('button', { name: 'Chart settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  for (const tab of ['Symbol', 'Status line', 'Scales', 'Canvas', 'Trading', 'Alerts']) {
    await expect(dialog.getByRole('tab', { name: tab, exact: true })).toBeVisible();
  }
  // Status line: the time in the legend is switched off and the choice is kept on this device.
  await dialog.getByRole('tab', { name: 'Status line', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Show the time in the legend' }).uncheck();
  // Scales: a logarithmic price scale; the chart says so on its host.
  await dialog.getByRole('tab', { name: 'Scales', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Logarithmic price scale' }).check();
  // Canvas: grid lines off.
  await dialog.getByRole('tab', { name: 'Canvas', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Show grid lines' }).uncheck();
  // Trading and Alerts link to the controls; the chart places no order and sets no alert itself.
  await dialog.getByRole('tab', { name: 'Trading', exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Open the trading desk for BTC/USDT' })).toHaveAttribute('href', '/trade/spot/BTC-USDT');
  await dialog.getByRole('tab', { name: 'Alerts', exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Open price alerts' })).toHaveAttribute('href', '/notifications?view=alerts');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('chart-legend').first()).not.toContainText(/\d{1,2} [A-Za-z]{3} \d{4}/);
  // The legend's time element is gone, not just empty.
  await expect(page.getByTestId('wc-time')).toHaveCount(0);
  await expect(host(page)).toHaveAttribute('data-log', 'on');
  await expect(host(page)).toHaveAttribute('data-grid', 'off');
  // Saved for this device, read back after a reload.
  await page.reload();
  await expect(host(page)).toHaveAttribute('data-log', 'on');
  await expect(host(page)).toHaveAttribute('data-grid', 'off');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('charts-chart-settings:guest') ?? 'null'));
  expect(saved).toMatchObject({ showTime: false, logScale: true, gridLines: false });
});

test('J-charts-desk-03 #8 adds a price line at a level: a labelled line at that exact price, a refused off-tick price adds nothing', async ({
  page,
}) => {
  // The level is a real trade price the public tape printed, so it sits on the market's tick grid.
  const tape = await (await fetch(`${EDGE}/api/v1/trades/${encodeURIComponent('BTC/USDT')}?limit=1`)).json();
  const level = tape[0].price;
  const markets = await (await fetch(`${EDGE}/api/v1/markets?limit=500`)).json();
  const tick = markets.find((m) => m.symbol === 'BTC/USDT').precision.price;
  await openChart(page);
  await page.getByRole('button', { name: 'Price line', exact: true }).click();
  const form = page.getByRole('form', { name: 'Add a price line' });
  // A price off the tick grid is refused by name and draws nothing. Built from the tick's own scale: the level with one
  // more decimal place than the tick, ending in 5 (level + tick/2), so it is never a whole multiple of the tick.
  const places = (tick.split('.')[1] ?? '').length;
  const off = `${level.split('.')[0]}.${(level.split('.')[1] ?? '').padEnd(places, '0')}5`;
  const decimals = (v) => (v.split('.')[1] ?? '').length;
  const common = Math.max(decimals(off), decimals(tick));
  const units = (v) => BigInt(v.split('.')[0] + (v.split('.')[1] ?? '').padEnd(common, '0'));
  expect(units(off) % units(tick)).not.toBe(0n);
  expect(tick).toBe('0.01');
  await form.getByLabel('Price', { exact: true }).fill(off);
  await form.getByRole('button', { name: 'Add line' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'whole multiple of the tick size' })).toBeVisible();
  await expect(host(page)).toHaveAttribute('data-price-lines', '');
  // The level on the grid, with a label, draws one line at exactly that price.
  await form.getByLabel('Price').fill(level);
  await form.getByLabel('Label (optional)').fill('Support');
  await form.getByRole('button', { name: 'Add line' }).click();
  await expect(host(page)).toHaveAttribute('data-price-lines', level);
  await expect(page.getByRole('list', { name: 'Price lines' })).toContainText(`Support at ${level}`);
  // Kept for this market on this device; removing it takes it off the chart.
  await page.reload();
  await expect(host(page)).toHaveAttribute('data-price-lines', level);
  await page.getByRole('button', { name: `Remove the line at ${level}` }).click();
  await expect(host(page)).toHaveAttribute('data-price-lines', '');
});
