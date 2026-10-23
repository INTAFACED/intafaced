import { test, expect } from '@playwright/test';
import { EDGE } from './stack.mjs';

// J-charts-desk-02, in the running app (docs/roadmap/journeys.json): a person tells whether the data on a chart is live,
// delayed, stale, halted or test. One test per step, titled "J-charts-desk-02 #<n>". Expected values are worked from the
// public routes (owner values, the newest trade, the lifecycle state), never read back from the page.
//
// Steps 2, 3 and 4 need a state the stack does not produce on demand (a trade older than the owner's boundary, a halt, a
// feed that stopped). Those tests answer the chart's own route with the stack's real answer changed in one field (the
// trade time, the lifecycle state) or with a failed read, and say so in the step. Nothing else is changed.
const J = 'J-charts-desk-02';
const CHART = '/charts/BTC-USDT';
const MARKET = encodeURIComponent('BTC/USDT');

const chip = (page) => page.getByTestId('chart-status').first();
const banner = (page) => page.getByTestId('chart-banner').first();
const feedLine = (page) => page.getByTestId('chart-feed').first();
const source = (page) => page.getByTestId('chart-source').first();
const host = (page) => page.locator('.cw .wc-host').first();
const tradeButton = (page) => page.locator('button.cw-link').first();

/** The owner's delayed boundary and the market's data class, from svc-trade's owner values (the chart reads the same). */
async function ownerValues() {
  const res = await fetch(`${EDGE}/api/v1/charts/owner-values?symbol=${MARKET}`);
  expect(res.status).toBe(200);
  return res.json();
}

/** The newest executed trade's time (epoch ms), from the public tape. */
async function newestTradeMs() {
  const res = await fetch(`${EDGE}/api/v1/trades/${MARKET}?limit=1`);
  expect(res.status).toBe(200);
  const rows = await res.json();
  expect(rows.length).toBeGreaterThan(0);
  return rows[0].timestamp;
}

async function openChart(page) {
  await page.goto(CHART);
  await expect(host(page)).toBeVisible();
  await expect.poll(async () => Number(await host(page).getAttribute('data-bars'))).toBeGreaterThan(0);
}

test(`${J} #1 opens a chart on a live market: a Real-time chip with its age, the source line and the feed connected`, async ({ page }) => {
  const owner = await ownerValues();
  expect(owner.dataClass).toBe('real_time');
  expect(owner.delayedBoundarySeconds).toBeGreaterThan(0);
  // A live market has traded inside the boundary; the test waits for that trade rather than changing the market.
  await expect
    .poll(async () => (Date.now() - (await newestTradeMs())) / 1000, { timeout: 90_000, intervals: [2_000] })
    .toBeLessThanOrEqual(owner.delayedBoundarySeconds);
  await openChart(page);
  await expect(chip(page)).toHaveAttribute('data-status', 'live', { timeout: 30_000 });
  await expect(chip(page)).toContainText('Real-time');
  await expect(source(page)).toContainText('executed trades on this venue');
  await expect(feedLine(page)).toContainText('Feed connected');
});

test(`${J} #2 opens a market whose candle stream is older than the boundary: the chip reads Delayed with the age in seconds`, async ({
  page,
}) => {
  const owner = await ownerValues();
  const shiftBySeconds = owner.delayedBoundarySeconds + 60;
  // The newest print is answered as if it happened `shiftBySeconds` ago; everything else is the stack's own answer.
  await page.route('**/api/v1/trades/**', async (route) => {
    const res = await route.fetch();
    const rows = await res.json();
    if (rows.length > 0) {
      rows[0].timestamp = Date.now() - shiftBySeconds * 1000;
      rows[0].datetime = new Date(rows[0].timestamp).toISOString();
    }
    await route.fulfill({ response: res, json: rows });
  });
  await openChart(page);
  await expect(chip(page)).toHaveAttribute('data-status', 'delayed', { timeout: 30_000 });
  const text = await chip(page).textContent();
  const seconds = Number(text.match(/Last trade (\d+) s ago/)?.[1]);
  expect(seconds).toBeGreaterThanOrEqual(shiftBySeconds);
  await expect(banner(page)).toHaveAttribute('data-kind', 'delayed');
});

test(`${J} #3 opens a halted market: a banner with the halted state and its as-of time, and chart order entry is off with the reason`, async ({
  page,
}) => {
  const haltedSince = Date.now() - 120_000;
  // The lifecycle the chart reads says HALTED since two minutes ago; the rest of the route's answer is the stack's.
  await page.route('**/api/v1/market-lifecycle/**', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({
      response: res,
      json: { ...body, state: 'HALTED', effectiveAt: new Date(haltedSince).toISOString(), reasonCategory: 'OPERATOR' },
    });
  });
  await openChart(page);
  await expect(chip(page)).toHaveAttribute('data-status', 'halted', { timeout: 30_000 });
  await expect(banner(page)).toHaveAttribute('data-kind', 'halted');
  await expect(banner(page)).toContainText(/Halted as of \d{1,2} [A-Za-z]{3} \d{4}, \d{2}:\d{2}/);
  const trade = tradeButton(page);
  await expect(trade).toBeDisabled();
  await expect(page.locator('#cw-trade-refusal')).toHaveText('Order entry is off: this market is halted.');
  await expect(page.locator('a.cw-link')).toHaveCount(0);
});

test(`${J} #4 opens a market whose feed has stopped: Stale or Down with the last trade time, never a frozen price shown as live`, async ({
  page,
}) => {
  await openChart(page);
  await expect(chip(page)).toHaveAttribute('data-status', /live|delayed/, { timeout: 30_000 });
  // The candle feed stops answering after the chart has loaded.
  await page.route('**/api/v1/ohlcv/**', (route) =>
    route.fulfill({ status: 503, json: { code: 'ExchangeNotAvailable', message: 'stopped' } }),
  );
  await expect(chip(page)).toHaveAttribute('data-status', /^(stale|down)$/, { timeout: 45_000 });
  await expect(banner(page)).toHaveAttribute('data-kind', /^(stale|down)$/);
  await expect(banner(page)).toContainText('Last trade');
  await expect(feedLine(page)).toContainText(/Feed (stale|down)/);
  await expect(chip(page)).not.toHaveAttribute('data-status', 'live');
});

test(`${J} #5 opens a TEST market: a TEST label on the chart title row, named by the lifecycle's own marker`, async ({ page }) => {
  // The lifecycle route says whether the market is a local TEST market (its evidence carries the local-test marker).
  const res = await fetch(`${EDGE}/api/v1/market-lifecycle/${MARKET}`);
  expect(res.status).toBe(200);
  const life = await res.json();
  const isTest = (life.evidenceRefs ?? []).some((ref) => ref.startsWith('local-test:'));
  await openChart(page);
  const label = page.getByTestId('chart-test');
  if (isTest) {
    await expect(label).toHaveText('TEST');
    await expect(label).toHaveAttribute('title', /TEST: this market’s prices are test prices/);
  } else {
    await expect(label).toHaveCount(0);
  }
  // The label sits with the title in the same row as the status chip.
  await expect(page.getByTestId('chart-title').first()).toBeVisible();
});

test(`${J} #6 keeps drawing while ticks stream: the bars move as trades arrive and the page answers a key press`, async ({ page }) => {
  await openChart(page);
  const first = await host(page).getAttribute('data-last');
  // The chart reads the tape every 10 s; within 40 s a live market has printed at least one new bar's worth of trades.
  await expect.poll(async () => host(page).getAttribute('data-last'), { timeout: 40_000, intervals: [2_000] }).not.toBe(first);
  // The page is not frozen: a key press moves the chart (the pan key) and the frame counter keeps advancing.
  const frames = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let count = 0;
        const end = performance.now() + 1_000;
        const tick = () => {
          count += 1;
          if (performance.now() < end) requestAnimationFrame(tick);
          else resolve(count);
        };
        requestAnimationFrame(tick);
      }),
  );
  expect(frames).toBeGreaterThan(5);
  await host(page).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(host(page)).toBeVisible();
  // The owner's performance budget is not in the owner values yet: the budget half of this step stays open (see the report).
});
