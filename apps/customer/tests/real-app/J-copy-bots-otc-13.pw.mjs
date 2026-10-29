import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, journeyState, tool } from './stack.mjs';
import { awayBid, fundedTrader, signIn } from './desk.mjs';
import { followOnScreen, listLeader } from './copy.mjs';

// J-copy-bots-otc-13, in the running app (docs/roadmap/journeys.json): support finds a customer's follows, bots and OTC
// quotes and reads the module numbers, on the founder console. One test per step, titled "J-copy-bots-otc-13 #<n>", run
// in order. #2 makes the customer: a verified TEST account following a TEST leader once, with two TEST bots made through
// its own algo door. The founder signs in with the lookup scope; the stack has no support agent without it, so #3 uses a
// founder session whose scope list leaves lookup out (`local-test-gates.mjs scoped-session`).
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: the console has no copy, bots and OTC module view (metrics, customer lookup, quote desk list), and the
//   stack has no scoped support session.
const J = 'J-copy-bots-otc-13';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

async function moduleRoom(page) {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops/copy-bots-otc`);
  await expect(page.getByRole('heading', { name: 'Copy, bots and OTC', level: 1 })).toBeVisible(UNBUILT);
}

test(`${J} #1 opens the module metrics: counts with their window and as-of time; a failed source reads "Could not load", never zero`, async ({
  page,
}) => {
  run.reset({});
  await moduleRoom(page);
  const metrics = page.getByRole('region', { name: 'Module metrics' });
  await expect(metrics).toContainText(/Active copiers\s*(\d+|Could not load)/);
  await expect(metrics).toContainText(/As of \d/);
  await expect(metrics).toContainText(/Window/);
});

test(`${J} #2 looks up a customer with one follow and two bots: listed with their statuses`, async ({ page, browser }) => {
  test.setTimeout(360_000);
  const tag = Date.now().toString(36);
  const leader = await fundedTrader(page, 'jcl13', '10');
  const leaderRef = await listLeader(leader, `Journey Lookup ${tag}`);
  const customer = await fundedTrader(page, 'jcc13', '1000');
  await signIn(page, customer);
  await followOnScreen(page, customer, leaderRef, { perOrder: '20', total: '40', fixed: '10' });
  // Two bots through the customer's own algo door: TWAP buys resting far under the book.
  const limitPrice = await awayBid(50);
  for (const n of [1, 2]) {
    const made = await (
      await api(customer)
    ).post('/api/trade/trpc/algo.createTwap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      totalQty: '0.002',
      durationMs: 600_000,
      sliceIntervalMs: 60_000,
      limitPrice,
      clientAlgoId: `${J}-2-${n}-${tag}`,
      kind: 'twap',
    });
    expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  }
  run.write({ customer, leaderRef });
  const desk = await (await browser.newContext()).newPage();
  await moduleRoom(desk);
  await desk.getByRole('searchbox', { name: 'Find a customer' }).fill(customer.email);
  await desk.getByRole('searchbox', { name: 'Find a customer' }).press('Enter');
  await expect(desk.getByRole('table', { name: 'Follows' }).locator('tbody tr')).toHaveCount(1);
  await expect(desk.getByRole('table', { name: 'Follows' })).toContainText('Active');
  await expect(desk.getByRole('table', { name: 'Bots' }).locator('tbody tr')).toHaveCount(2);
  await desk.context().close();
});

test(`${J} #3 looks up as an agent without the lookup scope: refused`, async ({ page }) => {
  await page.goto(`${ADMIN}/login`);
  const out = JSON.parse(tool('local-test-gates.mjs', 'scoped-session', '--without', 'trade.copy.lookup'));
  await page.context().addCookies(out.cookies);
  await page.goto(`${ADMIN}/trade-ops/copy-bots-otc?customer=${encodeURIComponent(state('customer').email)}`);
  await expect(page.getByText(/You don’t have the lookup permission/)).toBeVisible();
});

test(`${J} #4 opens the quote desk list: open and settled RFQs with statuses; a failed settlement listed with its saga key`, async ({
  page,
}) => {
  await moduleRoom(page);
  await page.getByRole('tab', { name: 'Quote desk' }).click();
  const rfqs = page.getByRole('table', { name: 'Quotes' });
  await expect(rfqs.or(page.getByText('No quotes.'))).toBeVisible();
  const exceptions = page.getByRole('table', { name: 'Settlement exceptions' });
  await expect(exceptions.or(page.getByText('No settlement exceptions.'))).toBeVisible();
  if (await exceptions.isVisible()) await expect(exceptions.locator('tbody tr').first()).toContainText(/otc\.settle:[\w-]+/);
});
