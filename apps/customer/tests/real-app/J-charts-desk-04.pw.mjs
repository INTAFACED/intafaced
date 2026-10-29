import { test, expect } from '@playwright/test';
import { EDGE } from './stack.mjs';

// J-charts-desk-04 "I add advanced studies and market analytics series" (docs/roadmap/journeys.json). One test per step,
// titled "J-charts-desk-04 #<n>". This is a DRAFT: it has not been run against the local stack. Each test opens the
// workbench on its own, so the studies it needs are added inside the test. Expected values are worked here from the
// formula on the public candle and trade routes (`/api/v1/ohlcv/:symbol`, `/api/v1/trades/:symbol`), not read from the page.

const MARKET = 'BTC-USDT';
const MARKET_NAME = 'BTC/USDT';
// The public routes name the pair with a slash, url-encoded in the path.
const MARKET_PATH = encodeURIComponent(MARKET_NAME);
const CHART = `/charts/${MARKET}`;

async function candles(timeframe, limit) {
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${MARKET_PATH}?timeframe=${timeframe}&limit=${limit}`);
  if (!res.ok) throw new Error(`the public candle route answered ${res.status}`);
  return res.json();
}

async function trades(limit = 500) {
  const res = await fetch(`${EDGE}/api/v1/trades/${MARKET_PATH}?limit=${limit}`);
  if (!res.ok) throw new Error(`the public trades route answered ${res.status}`);
  return res.json();
}

async function openChart(page, query = '') {
  await page.goto(`${CHART}${query}`);
  await expect(page.getByRole('heading', { name: 'Charts' })).toBeVisible();
  await expect(page.getByTestId('studies')).toBeVisible();
}

async function addStudy(page, search, name) {
  await page.getByRole('button', { name: 'Indicators' }).click();
  await page.getByRole('searchbox', { name: 'Search indicators' }).fill(search);
  await page.getByRole('button', { name: `Add ${name}`, exact: true }).click();
}

const legend = (page) => page.getByTestId('study-legend');
const row = (page, id) => page.locator(`[data-study="${id}"]`);

test('J-charts-desk-04 #1 adds Ichimoku with 40 bars loaded: the lines that need 52 bars are absent and the legend says so', async ({
  page,
}) => {
  // The 52-bar rule is about the loaded bars. The TEST history covers a few days, so the 2h interval loads between 26
  // and 52 bars (the base line draws, span B cannot); the count is read from the public route, not assumed.
  const loaded = await candles('2h', 240);
  expect(loaded.length).toBeGreaterThanOrEqual(26);
  expect(loaded.length).toBeLessThan(52);
  await openChart(page, '?interval=2h');
  await addStudy(page, 'ichimoku', 'Ichimoku Cloud');
  await expect(row(page, 'ichimoku-1')).toContainText('Leading B: Needs 52 bars');
});

test('J-charts-desk-04 #2 adds pivot points and auto levels on the daily interval: the levels come from the prior day by the stated formula', async ({
  page,
}) => {
  const daily = await candles('1d', 3);
  // Prior day = the bar before the last one: high, low and close as the route sends them.
  const [, , prevHigh, prevLow, prevClose] = daily[daily.length - 2];
  const H = Number(prevHigh);
  const L = Number(prevLow);
  const C = Number(prevClose);
  const P = (H + L + C) / 3;
  await openChart(page, '?interval=1d');
  await addStudy(page, 'pivot', 'Pivot points');
  await addStudy(page, 'auto', 'Auto levels');
  // Values show with the legend always shown (or under the pointer); the last bar's levels come from the prior day.
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();
  await expect(row(page, 'pivots-1')).toContainText(`${H.toFixed(2)} / ${L.toFixed(2)} / ${C.toFixed(2)}`);
  await expect(row(page, 'pivots-1')).toContainText('R1');
  // The formula: P = (H + L + C) / 3, shown to the tick.
  await expect(row(page, 'pivots-1')).toContainText(P.toFixed(2));
  await expect(row(page, 'auto-levels-1')).toContainText('Prior high');
});

test('J-charts-desk-04 #3 reads the technical rating: the rating with its inputs and its counts', async ({ page }) => {
  await openChart(page);
  await addStudy(page, 'rating', 'Technical rating');
  const rating = row(page, 'rating-1');
  // The counts are the nine signals at the last bar: buy, neutral, sell and no value.
  await expect(rating).toContainText('Buy');
  await expect(rating).toContainText('Neutral');
  await expect(rating).toContainText('Sell');
  await expect(rating).toContainText('No value');
  // No weights are entered, so there is no score: the rating says why, and shows no number for it.
  await expect(rating).toContainText('Enter every rating weight to see a score.');
  await expect(rating).not.toContainText('Score');
});

test('J-charts-desk-04 #4 adds volume delta and a volume profile: series from the public tape, or a refusal when there is no tape', async ({
  page,
}) => {
  const tape = await trades(500);
  await openChart(page);
  await addStudy(page, 'delta', 'Volume delta');
  await addStudy(page, 'profile', 'Volume profile');
  if (tape.length === 0) {
    await expect(legend(page)).toContainText('No public trades for this market.');
    return;
  }
  await expect(row(page, 'volume-delta-1')).toContainText('Public trades read');
  await expect(row(page, 'volume-profile-1')).toContainText('Point of control');
});

test('J-charts-desk-04 #5 adds a higher-timeframe study: the study at a coarser interval, aligned to the chart', async ({ page }) => {
  await openChart(page, '?interval=15m');
  await addStudy(page, 'htf', 'Higher-timeframe moving average');
  await page.getByRole('button', { name: 'Settings for Higher-timeframe moving average' }).click();
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: /^Interval/ })
    .selectOption('1h');
  await page.getByRole('button', { name: 'Apply' }).click();
  // The study reads only the hourly bars that end by the chart's last 15m bar (no look-ahead past the chart). In the last
  // quarter of an hour that includes the forming hour, which ends with the forming 15m bar. Worked from the public routes
  // at the moment of each check: a bar that closes while the test runs changes the count on the page and on the route.
  await expect(async () => {
    const quarter = await candles('15m', 1);
    const chartEnd = Number(quarter[quarter.length - 1][0]) + 900_000;
    const hourly = await candles('1h', 240);
    const closed = hourly.filter((bar) => Number(bar[0]) + 3_600_000 <= chartEnd).length;
    await expect(row(page, 'htf-sma-1')).toContainText(`Higher bars read: ${closed}`, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
});

test('J-charts-desk-04 #6 adds open interest, funding and an on-chain series: each is refused by name on a spot market, nothing drawn', async ({
  page,
}) => {
  await openChart(page);
  await addStudy(page, 'open interest', 'Open interest');
  await addStudy(page, 'funding', 'Funding rate');
  await addStudy(page, 'on chain', 'On-chain series');
  await expect(legend(page)).toContainText(`Open interest is not published for ${MARKET_NAME}.`);
  await expect(legend(page)).toContainText(`Funding rate is not published for ${MARKET_NAME}.`);
  await expect(legend(page)).toContainText(`On-chain series is not published for ${MARKET_NAME}.`);
});
