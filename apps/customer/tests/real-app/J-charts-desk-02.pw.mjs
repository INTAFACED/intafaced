import { test, expect } from '@playwright/test';
import { EDGE, tool } from './stack.mjs';

// J-charts-desk-02, in the running app (docs/roadmap/journeys.json): a person tells whether the data on a chart is live,
// delayed, stale, halted or test. One test per step, titled "J-charts-desk-02 #<n>". Expected values are worked from the
// public routes (owner values, the newest trade, the lifecycle state), never read back from the page.
//
// Which steps are real and which are answered by a route interception:
//   #1 real: BTC/USDT on the stack's own data class (real time), the newest trade inside the owner's boundary.
//   #2 real: ETH/USDT is set to the delayed class through the gates' `chart-class` (two-person approval), and restored
//      to real time afterwards. The chip's age is checked against the newest ETH trade on the public tape.
//   #3 INTERCEPTED: the market-lifecycle route answers HALTED. The stack has no HTTP control that moves a market to
//      HALTED (trade.markets.status='halted' has no route), and a per-market halt (`halt <SYMBOL>`) is not reflected in
//      the lifecycle state, so a halted book reads as live on the chart. That gap is reported, not hidden by this step.
//   #4 INTERCEPTED: the candle route (/api/v1/ohlcv) answers 503 after the chart has loaded. The stack has no way to stop
//      the candle feed without stopping svc-trade itself, which the coordinator has not cleared.
//   #5 real: the TEST label follows the lifecycle's own local-test evidence marker.
//   #6 real stream, with the render budget read from the owner values (renderBudgetMs, TEST value in
//      tooling/profiles/test-owner-values.json). Only the rendering is measured; no route is changed.
const J = 'J-charts-desk-02';
const CHART = '/charts/BTC-USDT';
const ETH_CHART = '/charts/ETH-USDT';
const BTC = 'BTC/USDT';
const ETH = 'ETH/USDT';

const chip = (page) => page.getByTestId('chart-status').first();
const banner = (page) => page.getByTestId('chart-banner').first();
const feedLine = (page) => page.getByTestId('chart-feed').first();
const source = (page) => page.getByTestId('chart-source').first();
const host = (page) => page.locator('.cw .wc-host').first();
const tradeButton = (page) => page.locator('button.cw-link').first();

/** The owner values for one market, from svc-trade's public read (the chart reads the same route). */
async function ownerValues(symbol = BTC) {
  const res = await fetch(`${EDGE}/api/v1/charts/owner-values?symbol=${encodeURIComponent(symbol)}`);
  expect(res.status).toBe(200);
  return res.json();
}

/** The newest executed trade's time (epoch ms), from the public tape. */
async function newestTradeMs(symbol = BTC) {
  const res = await fetch(`${EDGE}/api/v1/trades/${encodeURIComponent(symbol)}?limit=1`);
  expect(res.status).toBe(200);
  const rows = await res.json();
  expect(rows.length).toBeGreaterThan(0);
  return rows[0].timestamp;
}

async function openChart(page, path = CHART) {
  await page.goto(path);
  await expect(host(page)).toBeVisible();
  await expect.poll(async () => Number(await host(page).getAttribute('data-bars'))).toBeGreaterThan(0);
}

test(`${J} #1 opens a chart on a live market: a Real-time chip with its age, the source line and the feed connected`, async ({ page }) => {
  const owner = await ownerValues(BTC);
  expect(owner.dataClass).toBe('real_time');
  expect(owner.delayedBoundarySeconds).toBeGreaterThan(0);
  // A live market has traded inside the boundary; the test waits for that trade rather than changing the market.
  await expect
    .poll(async () => (Date.now() - (await newestTradeMs(BTC))) / 1000, { timeout: 90_000, intervals: [2_000] })
    .toBeLessThanOrEqual(owner.delayedBoundarySeconds);
  await openChart(page);
  await expect(chip(page)).toHaveAttribute('data-status', 'live', { timeout: 30_000 });
  await expect(chip(page)).toContainText('Real-time');
  await expect(source(page)).toContainText('executed trades on this venue');
  await expect(feedLine(page)).toContainText('Feed connected');
});

test.describe(`${J} #2 on a delayed market`, () => {
  test.beforeAll(() => {
    // The owner's flow, on the local stack: ETH/USDT moves to the delayed class with a second operator's approval.
    tool('local-test-gates.mjs', 'chart-class', ETH, 'delayed');
  });
  test.afterAll(() => {
    tool('local-test-gates.mjs', 'chart-class', ETH, 'real_time');
  });

  test(`${J} #2 opens a market whose data class is delayed: the chip reads Delayed with the age of its newest trade`, async ({ page }) => {
    const owner = await ownerValues(ETH);
    expect(owner.dataClass).toBe('delayed');
    const newest = await newestTradeMs(ETH);
    await openChart(page, ETH_CHART);
    await expect(chip(page)).toHaveAttribute('data-status', 'delayed', { timeout: 30_000 });
    await expect(chip(page)).toContainText('Delayed');
    const seconds = Number((await chip(page).textContent()).match(/Last trade (\d+) s ago/)?.[1]);
    const expected = (Date.now() - newest) / 1000;
    // The chip reads the age when the page loaded; allow the time the page took to open and the next poll.
    expect(Math.abs(seconds - expected)).toBeLessThanOrEqual(60);
    await expect(banner(page)).toHaveAttribute('data-kind', 'delayed');
  });
});

test(`${J} #3 opens a halted market: a banner with the halted state and its as-of time, and chart order entry is off with the reason`, async ({
  page,
}) => {
  // INTERCEPTED (see the header): the lifecycle the chart reads says HALTED since two minutes ago; the rest is the stack's.
  const haltedSince = Date.now() - 120_000;
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
  // INTERCEPTED (see the header): the candle feed stops answering after the chart has loaded.
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
  const res = await fetch(`${EDGE}/api/v1/market-lifecycle/${encodeURIComponent(BTC)}`);
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

test(`${J} #6 keeps drawing while ticks stream: the bars move, the frame counter advances, and no task holds the page past the render budget`, async ({
  page,
}) => {
  // The owner's render budget (renderBudgetMs). A blank value is a missing owner setting: the step fails by name.
  const owner = await ownerValues(BTC);
  const budget = owner.renderBudgetMs;
  if (budget === null || budget === undefined) {
    throw new Error('budget not set: svc-trade has no renderBudgetMs for BTC/USDT, so the render budget cannot be asserted');
  }
  // Long tasks are recorded from before the page loads, so nothing in the first paint is missed.
  await page.addInitScript(() => {
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      window.__longTasks = null;
    }
  });
  await openChart(page);
  const first = await host(page).getAttribute('data-last');
  // The chart reads the tape every 10 s; within 40 s a live market has printed at least one new bar's worth of trades.
  await expect.poll(async () => host(page).getAttribute('data-last'), { timeout: 40_000, intervals: [2_000] }).not.toBe(first);
  // A stream window with the page open: 10 s of ticks and polls.
  await page.waitForTimeout(10_000);
  const tasks = await page.evaluate(() => window.__longTasks);
  expect(tasks, 'the browser reports long tasks (PerformanceObserver longtask)').not.toBeNull();
  const worst = Math.max(0, ...tasks);
  expect(worst, `longest main-thread task while streaming, ms (budget ${budget} ms)`).toBeLessThanOrEqual(budget);
  // The page is not frozen: the frame counter keeps advancing.
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
  // A key press moves the chart (the pan key) and the page keeps answering.
  await host(page).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(host(page)).toBeVisible();
});
