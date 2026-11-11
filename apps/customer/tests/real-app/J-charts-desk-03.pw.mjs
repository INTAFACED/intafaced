// World: none
import { test, expect } from './journey.mjs';
import { signUp } from './desk.mjs';
import { EDGE } from './stack.mjs';
import { chartBars, expectLines, F } from './charts-desk-studies.mjs';

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

/**
 * Waits until a study's legend row shows the value worked from the closes the chart draws. `work` returns the value as
 * the legend writes it: two decimals (BTC/USDT's 0.01 tick), rounded half away from zero (studies/math.ts formatAt).
 */
async function expectWorked(page, id, work) {
  await expect
    .poll(
      async () => {
        const expected = work(await drawnCloses());
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

/**
 * A simple moving average of the closes, worked from the formula: the mean of the last `period` closes, in exact whole
 * cents and rounded half away from zero, as the legend writes it. A mean of 20 two-decimal closes lands exactly on a half
 * cent once in 20 windows; a binary `toFixed(2)` of that mean rounds about half of those down (64909.635 -> "64909.63")
 * while the legend rounds the half up ("64909.64"), and with the market quiet the two stayed a cent apart for the whole
 * poll. Worked in whole cents, the expected value does not depend on where the binary sum happens to land.
 */
function sma(closes, period) {
  const sum = closes.slice(-period).reduce((a, b) => a + BigInt(Math.round(b * 100)), 0n);
  const cents = (2n * sum + BigInt(period)) / (2n * BigInt(period));
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
/** A worked value as the legend writes it at BTC/USDT's 0.01 tick: half away from zero, the tie decided in decimal. */
const twoDecimals = (value) => (Math.round(Number((value * 100).toPrecision(15))) / 100).toFixed(2);
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
  // Drawn with that style: the library's line for sma-1 is a line on the price pane in the ma-2 token's colour.
  const ma2 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--if-ma-2').trim());
  expect(ma2).not.toBe('');
  await expect
    .poll(async () => JSON.parse((await host(page).getAttribute('data-study-series')) ?? '[]').find((x) => x.key === 'sma-1'))
    .toEqual({ key: 'sma-1', pane: 0, type: 'Line', color: ma2 });
  // Drawn with those inputs: the value at the last bar is the mean of the last 50 highs.
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();
  await expectLines(page, 'sma-1', 2, (bars) => ({
    'SMA 50 high': F.sma(
      bars.map((b) => b.h),
      50,
      bars.length - 1,
    ),
  }));
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
  await expectWorked(page, 'ema-1', (closes) => twoDecimals(ema(closes, 20)));
  await expect(legend(page)).not.toContainText('This market has no volume in the loaded bars.');
  // Every other study's lines at the last bar, worked here from the bars the chart holds (BTC/USDT: price 0.01, so two
  // decimals; volume at the 0.00001 lot, five; Stochastic in percent, two).
  const at = (bars) => bars.length - 1;
  const closesOf = (bars) => bars.map((b) => b.c);
  await expectLines(page, 'volume-1', 5, (bars) => {
    const b = bars[at(bars)];
    return { Volume: b.filled || !(b.v > 0) ? null : b.v };
  });
  await expectLines(page, 'macd-1', 2, (bars) => {
    const m = F.macd(closesOf(bars), 12, 26, 9);
    return { 'MACD 12 26 9': m.line[at(bars)], Signal: m.signal[at(bars)], Histogram: m.histogram[at(bars)] };
  });
  await expectLines(page, 'stochastic-1', 2, (bars) => {
    const k = bars.map((_, i) => F.stochK(bars, 14, i));
    const i = at(bars);
    const d = k.slice(i - 2, i + 1).some((x) => x === null) ? null : (k[i] + k[i - 1] + k[i - 2]) / 3;
    return { '%K 14': k[i], '%D 3': d };
  });
  await expectLines(page, 'bollinger-1', 2, (bars) => {
    const b = F.bollinger(closesOf(bars), 20, 2, at(bars));
    return { Upper: b.upper, Middle: b.middle, Lower: b.lower };
  });
  await expectLines(page, 'vwap-1', 2, (bars) => ({ VWAP: F.vwap(bars, at(bars)) }));

  // A market with no volume says so. Volume is the sum of the market's executed trades (Edge's candles are built from
  // fills), so a listed spot market that the public candle route serves no bar for has no volume at all: its chart says
  // there were no trades and no volume, and draws no volume, no bar and no study value to read as one.
  const listed = await (await fetch(`${EDGE}/api/v1/markets?limit=500`)).json();
  let quiet = null;
  for (const m of listed.filter((x) => x.spot === true && x.active === true && x.symbol !== 'BTC/USDT')) {
    const res = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent(m.symbol)}?timeframe=15m&limit=${BAR_LIMIT}`);
    if (res.ok && (await res.json()).length === 0) {
      quiet = m.symbol;
      break;
    }
  }
  expect(quiet, 'the stack lists a spot market with no trades (no volume)').not.toBeNull();
  await page.goto(`/charts/${quiet.replace('/', '-')}`);
  await expect(page.getByRole('heading', { name: 'Charts' })).toBeVisible();
  const chart = page.getByTestId('cw').first();
  await expect(chart).toContainText('No trades in this period.');
  await expect(chart).toContainText('This market has no volume in the loaded bars.');
  await expect(host(page)).toHaveCount(0);
  await expect(page.getByTestId('study-legend')).toHaveCount(0);
});

test('J-charts-desk-03 #4 hides an indicator on one interval only; it shows on the others and the setting is remembered', async ({
  page,
}) => {
  await openChart(page);
  await addStudy(page, 'sma', 'Simple moving average');
  // An EMA shown on every interval: once it is drawn, the chart has drawn this interval's studies.
  await addStudy(page, 'ema', 'Exponential moving average');
  await page.getByRole('button', { name: 'Settings for Simple moving average' }).click();
  await page.getByRole('checkbox', { name: 'Shown on 1h' }).uncheck();
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();
  // Hidden on 1h: the row says so and the chart draws no SMA series. Shown on 15m: the series is drawn and its value is
  // the formula's. The same holds after a reload, on both intervals.
  const interval = (name) => page.getByRole('group', { name: 'Chart intervals' }).getByRole('button', { name }).click();
  const drawn = async () => JSON.parse((await host(page).getAttribute('data-study-series')) ?? '[]').map((x) => x.key);
  const drawnSma = async () => JSON.parse((await host(page).getAttribute('data-study-series')) ?? '[]').find((x) => x.key === 'sma-1');
  const hiddenHere = async () => {
    await expect(row(page, 'sma-1')).toContainText('Hidden on this interval');
    const emaWithoutSma = async () => {
      const keys = await drawn();
      return keys.includes('ema-1') && !keys.includes('sma-1');
    };
    await expect.poll(emaWithoutSma).toBe(true);
    // Still no SMA a moment later: it is not drawn late.
    await page.waitForTimeout(500);
    expect(await emaWithoutSma()).toBe(true);
  };
  const shownHere = async () => {
    await expect(row(page, 'sma-1')).not.toContainText('Hidden on this interval');
    await expect.poll(drawnSma).toMatchObject({ key: 'sma-1', type: 'Line', pane: 0 });
    await expectWorked(page, 'sma-1', (closes) => sma(closes, 20));
  };
  await interval('1h');
  await hiddenHere();
  await interval('15m');
  await shownHere();
  await page.reload();
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();
  await interval('15m');
  await shownHere();
  await interval('1h');
  await hiddenHere();
});

test('J-charts-desk-03 #5 sets the legend to always show: the values of the last bar show without hovering', async ({ page }) => {
  await openChart(page);
  await addStudy(page, 'sma', 'Simple moving average');
  await expect(row(page, 'sma-1').getByText(/^\d+\.\d\d$/)).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();
  // The OHLC legend of the chart shows the last bar with no pointer over the chart: its open, high, low and close are the
  // last bar's, worked from the public candles. The indicator values sit beside it.
  await page.mouse.move(0, 0);
  await expect
    .poll(
      async () => {
        const bars = await chartBars();
        const last = bars[bars.length - 1];
        const shown = await page.getByTestId('chart-legend').locator('b').allTextContents();
        return (
          shown
            .slice(0, 4)
            .map((x) => Number(x.replace(/,/g, '')))
            .join(' ') ===
          [last.o, last.h, last.l, last.c]
            .map((x) => x.toFixed(2))
            .map(Number)
            .join(' ')
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
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
  // Every value at the hovered bar (the window names its time): that bar's open, high, low and close, and each study's
  // value at that bar, worked here from the bars the chart holds.
  await expect
    .poll(
      async () => {
        const cursor = Number(await windowText.getAttribute('data-cursor'));
        const bars = await chartBars();
        const i = bars.findIndex((b) => b.t === cursor * 1000);
        if (i < 20) return `hovered bar ${cursor} not found far enough in`;
        const b = bars[i];
        const ohlc = (await windowText.locator('dd').allTextContents()).map(Number);
        const lines = Object.fromEntries(
          (await windowText.locator('li').allTextContents()).map((x) => {
            const m = /^(.*) (\S+)$/.exec(x.trim());
            return [m[1], m[2]];
          }),
        );
        const closes = bars.map((x) => x.c);
        const near = (text, value) => Math.abs(Number(text) - value) <= 0.005 + 1e-9;
        return [
          ohlc.join(' ') === [b.o, b.h, b.l, b.c].join(' '),
          near(lines['SMA 20'], F.sma(closes, 20, i)),
          near(lines['EMA 20'], F.emaLine(closes, 20)[i]),
        ].join(' ');
      },
      { timeout: 30_000 },
    )
    .toBe('true true true');
});

/** BTC/USDT's last price as Edge serves it, in whole cents (its 0.01 tick). */
async function lastCents() {
  const res = await fetch(`${EDGE}/api/v1/ticker/${MARKET_PATH}`);
  expect(res.status).toBe(200);
  const [whole, frac = ''] = String((await res.json()).last).split('.');
  return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
}

/** A price alert on BTC/USDT at half the last price, set on the alerts page: it never fires during the step. */
async function setFarAlert(page) {
  const cents = (await lastCents()) / 2n;
  const level = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  await page.goto('/notifications?view=alerts');
  const form = page.getByTestId('alerts-form');
  const market = form.getByRole('combobox', { name: /^Market/ });
  await expect(market, 'the alert form opens once its data has loaded').toBeEnabled();
  await market.selectOption({ label: 'BTC/USDT' });
  await form.getByLabel('Notify me when the price is').selectOption({ label: 'At or below' });
  await form.getByLabel('Price (USDT)').fill(level);
  await form.getByLabel('Name (optional)').fill('TEST chart settings');
  await form.getByRole('button', { name: 'Review alert' }).click();
  await page.getByRole('button', { name: 'Save alert' }).click();
  await expect(page.getByTestId('alerts-notices').getByRole('status')).toHaveText('Alert saved. It is active and appears in your list.');
  return level;
}

/** Moves the pointer onto the middle of the price pane, as a person does before ordering from the price scale. */
async function hoverPricePane(page) {
  const box = await host(page).boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4 - 1);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
}

test('J-charts-desk-03 #7 opens chart settings: symbol, status line, scales, canvas, trading and alert options are saved for this device and read back after a reload', async ({
  page,
}) => {
  // A signed-in person with a price alert on this market: the chart draws its level and offers the order button.
  await signUp(page, 'jcd03');
  const level = await setFarAlert(page);
  await openChart(page);
  const alertLine = page.getByTestId('chart-alert-line').filter({ hasText: `${level} USDT` });
  const alertRow = page.getByTestId('chart-alert-row').filter({ hasText: `${level} USDT` });
  await expect(alertLine).toHaveCount(1);
  await expect(alertRow).toHaveCount(1);
  await hoverPricePane(page);
  await expect(page.getByTestId('chart-axis-plus')).toBeVisible();

  await page.getByRole('button', { name: 'Chart settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  for (const tab of ['Symbol', 'Status line', 'Scales', 'Canvas', 'Trading', 'Alerts']) {
    await expect(dialog.getByRole('tab', { name: tab, exact: true })).toBeVisible();
  }
  // Symbol: the market and its tick size, and the market name taken out of the chart title.
  await expect(dialog.getByRole('tabpanel')).toContainText('Market BTC/USDT, tick size 0.01.');
  await expect(dialog.getByRole('tabpanel')).toContainText('Saved on this device.');
  await dialog.getByRole('checkbox', { name: 'Show the market name in the chart title' }).uncheck();
  // Status line: the time in the legend is switched off.
  await dialog.getByRole('tab', { name: 'Status line', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Show the time in the legend' }).uncheck();
  // Scales: a logarithmic price scale; the chart says so on its host.
  await dialog.getByRole('tab', { name: 'Scales', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Logarithmic price scale' }).check();
  // Canvas: grid lines off.
  await dialog.getByRole('tab', { name: 'Canvas', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Show grid lines' }).uncheck();
  // Trading: the order button on the price scale off. The desk is still linked; the dialog places no order.
  await dialog.getByRole('tab', { name: 'Trading', exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Open the trading desk for BTC/USDT' })).toHaveAttribute('href', '/trade/spot/BTC-USDT');
  await expect(dialog.getByRole('tabpanel')).toContainText('Saved on this device.');
  await dialog.getByRole('checkbox', { name: 'Show the order button on the price scale' }).uncheck();
  // Alerts: the alert levels off the chart. The alerts page is still linked; the dialog sets no alert.
  await dialog.getByRole('tab', { name: 'Alerts', exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Open price alerts' })).toHaveAttribute('href', '/notifications?view=alerts');
  await expect(dialog.getByRole('tabpanel')).toContainText('Saved on this device.');
  await dialog.getByRole('checkbox', { name: 'Show my price alert levels on the chart' }).uncheck();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Each option took effect on the chart.
  const optionsHold = async () => {
    await expect(page.getByTestId('chart-title').first()).toHaveText('15m');
    await expect(page.getByTestId('wc-time')).toHaveCount(0);
    await expect(host(page)).toHaveAttribute('data-log', 'on');
    await expect(host(page)).toHaveAttribute('data-grid', 'off');
    // No alert level on the chart, while the alert itself stays listed under it.
    await expect(alertRow).toHaveCount(1);
    await expect(page.getByTestId('chart-alert-line')).toHaveCount(0);
    // No order button over the price pane, however the pointer moves.
    await hoverPricePane(page);
    await page.waitForTimeout(500);
    await expect(page.getByTestId('chart-axis-plus')).toHaveCount(0);
  };
  await expect(page.getByTestId('chart-legend').first()).not.toContainText(/\d{1,2} [A-Za-z]{3} \d{4}/);
  await optionsHold();

  // Saved for this device, read back after a reload: every changed option, on the chart and in the dialog.
  await page.reload();
  await expect(host(page)).toBeVisible();
  await optionsHold();
  const saved = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('charts-chart-settings:') && k !== 'charts-chart-settings:guest');
    return key ? JSON.parse(localStorage.getItem(key) ?? 'null') : null;
  });
  expect(saved).toMatchObject({
    showName: false,
    showTime: false,
    logScale: true,
    gridLines: false,
    orderButton: false,
    alertLevels: false,
  });
  await page.getByRole('button', { name: 'Chart settings', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Show the market name in the chart title' })).not.toBeChecked();
  await dialog.getByRole('tab', { name: 'Status line', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Show the time in the legend' })).not.toBeChecked();
  await dialog.getByRole('tab', { name: 'Scales', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Logarithmic price scale' })).toBeChecked();
  await dialog.getByRole('tab', { name: 'Canvas', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Show grid lines' })).not.toBeChecked();
  await dialog.getByRole('tab', { name: 'Trading', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Show the order button on the price scale' })).not.toBeChecked();
  await dialog.getByRole('tab', { name: 'Alerts', exact: true }).click();
  const levels = dialog.getByRole('checkbox', { name: 'Show my price alert levels on the chart' });
  await expect(levels).not.toBeChecked();
  // Switched back on, the level returns to the chart.
  await levels.check();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(alertLine).toHaveCount(1);
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
