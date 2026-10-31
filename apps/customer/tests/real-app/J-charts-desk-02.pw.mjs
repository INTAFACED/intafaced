import { test, expect } from './journey.mjs';
import { EDGE, tool } from './stack.mjs';

// J-charts-desk-02, in the running app (docs/roadmap/journeys.json): a person tells whether the data on a chart is live,
// delayed, quiet, stale, halted or test. One test per step, titled "J-charts-desk-02 #<n>". Expected values are worked from
// the public routes (owner values, the newest trade, the lifecycle state, the book halt), never read back from the page.
//
// Which steps are real and which are intercepted:
//   #1 real: BTC/USDT on the stack's own data class (real time), the newest trade inside the owner's boundary.
//   #2 real: ETH/USDT is set to the delayed class through the gates' `chart-class` (two-person approval), and restored
//      to real time afterwards. The chip's age is checked against the newest ETH trade on the public tape.
//   #3 real: BTC/USDT is halted with the gates' `halt` (matching's own book halt) and resumed afterwards. The chart reads
//      that halt from /api/v1/market-halt. No interception.
//   #4 INTERCEPTED (intercepted 503): the candle route (/api/v1/ohlcv) answers 503 after the chart has loaded. The stack has
//      no way to stop only the candle feed without stopping svc-trade itself, which is not cleared.
//   #5 real: the TEST label follows the lifecycle's own local-test evidence marker (the stack marks BTC/USDT as TEST).
//   #6 real stream: BTC/USDT on the 1m interval (pinned through the chart's own control), the bars move with trades, and
//      the longest main-thread task over a 10 s stream window is at or under the owner's render budget (renderBudgetMs,
//      a TEST value set by `local-test-gates.mjs charts`). No route is changed.
const J = 'J-charts-desk-02';
const CHART = '/charts/BTC-USDT';
const ETH_CHART = '/charts/ETH-USDT';
const BTC = 'BTC/USDT';
const ETH = 'ETH/USDT';

const chip = (page) => page.getByTestId('chart-status').first();
const banner = (page) => page.getByTestId('chart-banner').first();
const feedLine = (page) => page.getByTestId('chart-feed').first();
const source = (page) => page.getByTestId('chart-source').first();
const host = (page) => page.getByTestId('cw').getByTestId('wc-host').first();
const tradeButton = (page) => page.locator('button[data-testid="cw-link"]').first();

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
  // A live market has traded inside the boundary; the test waits for that trade rather than changing the market. The
  // TEST maker crosses BTC/USDT every sixth loop cycle, about 96 s apart and more under load (run 701 saw a gap over
  // 136 s, which a 90 s wait missed; #6638), so the wait spans more than two such gaps.
  test.setTimeout(300_000);
  await expect
    .poll(async () => (Date.now() - (await newestTradeMs(BTC))) / 1000, { timeout: 240_000, intervals: [2_000] })
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
    // The age on the chip is the age of the newest ETH trade now, within the poll that set the chip and the time it took to open.
    await expect
      .poll(
        async () => {
          const text = (await chip(page).textContent()) ?? '';
          const seconds = Number(text.match(/Last trade (\d+) s ago/)?.[1]);
          return Math.abs(seconds - (Date.now() - newest) / 1000);
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBeLessThanOrEqual(60);
    await expect(banner(page)).toHaveAttribute('data-kind', 'delayed');
  });
});

test.describe(`${J} #3 on a halted market (a real matching halt)`, () => {
  test.beforeAll(() => {
    // Matching's own book halt for BTC/USDT; the chart reads it through svc-trade's market-halt route.
    tool('local-test-gates.mjs', 'halt', BTC);
  });
  test.afterAll(() => {
    tool('local-test-gates.mjs', 'resume', BTC);
  });

  test(`${J} #3 opens a halted market: a banner that the market is halted, and chart order entry is off with the reason`, async ({
    page,
  }) => {
    await openChart(page);
    await expect(chip(page)).toHaveAttribute('data-status', 'halted', { timeout: 30_000 });
    await expect(banner(page)).toHaveAttribute('data-kind', 'halted');
    // The book halt carries no time, so the banner says so rather than guessing one.
    await expect(banner(page)).toContainText(/Halted as of (time unknown|\d{1,2} [A-Za-z]{3} \d{4}, \d{2}:\d{2})/);
    const trade = tradeButton(page);
    await expect(trade).toBeDisabled();
    await expect(page.locator('#cw-trade-refusal')).toHaveText('Order entry is off: this market is halted.');
    await expect(page.locator('a[data-testid="cw-link"]')).toHaveCount(0);
  });
});

test(`${J} #4 opens a market whose feed has stopped (intercepted 503): Stale or Down with the last trade time, never a frozen price shown as live`, async ({
  page,
}) => {
  // INTERCEPTED (see the header): the candle feed answers 503 after the chart has loaded. Nothing else is changed.
  await openChart(page);
  await expect(chip(page)).toHaveAttribute('data-status', /live|quiet|delayed/, { timeout: 30_000 });
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
  // The stack marks its markets with a local-test evidence marker. This step pins the branch: BTC/USDT is a TEST market
  // on the local stack, so the label must be there with its title.
  const res = await fetch(`${EDGE}/api/v1/market-lifecycle/${encodeURIComponent(BTC)}`);
  expect(res.status).toBe(200);
  const life = await res.json();
  const isTest = (life.evidenceRefs ?? []).some((ref) => ref.startsWith('local-test:'));
  expect(isTest, 'BTC/USDT carries the local-test marker on the local stack').toBe(true);
  await openChart(page);
  const label = page.getByTestId('chart-test');
  await expect(label).toHaveText('TEST');
  await expect(label).toHaveAttribute('title', /TEST: this market’s prices are test prices/);
  // The label sits on the chart's title row: the same row element as the title and the status chip, and drawn on the
  // same line (its vertical middle inside the title's height), after the title.
  const row = await page.evaluate(() => {
    const cw = document.querySelector('[data-testid="cw"]');
    const [title, test, status] = ['chart-title', 'chart-test', 'chart-status'].map((id) => cw.querySelector(`[data-testid="${id}"]`));
    const [tb, lb] = [title.getBoundingClientRect(), test.getBoundingClientRect()];
    const middle = (lb.top + lb.bottom) / 2;
    return {
      sameRow: test.parentElement === title.parentElement && status.parentElement === title.parentElement,
      onTitleLine: middle >= tb.top && middle <= tb.bottom,
      afterTitle: title.compareDocumentPosition(test) === Node.DOCUMENT_POSITION_FOLLOWING,
    };
  });
  expect(row).toEqual({ sameRow: true, onTitleLine: true, afterTitle: true });
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
  // Long tasks are recorded from before the page loads; the window is opened and read below.
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
  // Pin the 1m interval through the chart's own control: the close moves with trades on a 1m bar.
  await page.getByRole('group', { name: 'Chart intervals' }).getByRole('button', { name: '1m', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Chart intervals' }).getByRole('button', { name: '1m', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const first = await host(page).getAttribute('data-last');
  await expect.poll(async () => host(page).getAttribute('data-last'), { timeout: 70_000, intervals: [2_000] }).not.toBe(first);
  // The stream window: only the long tasks inside these 10 s count.
  await page.evaluate(() => {
    window.__longTasks = [];
  });
  await page.waitForTimeout(10_000);
  const tasks = await page.evaluate(() => window.__longTasks);
  expect(tasks, 'the browser reports long tasks (PerformanceObserver longtask)').not.toBeNull();
  const worst = Math.max(0, ...tasks);
  expect(worst, `longest main-thread task in the 10 s stream window, ms (budget ${budget} ms)`).toBeLessThanOrEqual(budget);
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
