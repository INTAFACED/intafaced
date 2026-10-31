import { test, expect } from './journey.mjs';
import { api, journeyState, signOutBrowser } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { copiedOrders, followOnScreen, leadFill, listLeader, openFollow } from './copy.mjs';

// J-copy-bots-otc-06, in the running app (docs/roadmap/journeys.json): see what copying costs me and what a lead earns.
// One test per step, titled "J-copy-bots-otc-06 #<n>", run in order. #1 makes the journey's start: a TEST leader listed by
// the stack's TEST founder, a verified follower who follows it on screen, and two copied buys (the leader's own fills on
// the TEST book), so the fee share has settled fills to show. The fee share is the stack's TEST copy fee share.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: money activity has no fee-share row per copied fill.
// - #2: no copied position view with average entry and funding.
// - #3, #4: no lead earnings panel and no profit pre-deduction door to refuse.
// - #5: no lead level view; #6: no leaderboard empty state (rankings are refused, J-copy-bots-otc-01 #3).
const J = 'J-copy-bots-otc-06';
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

test(`${J} #1 as a follower opens money activity after a copied fill: one fee-share row with fill, lead, asset, amount; no profit share`, async ({
  page,
}) => {
  test.setTimeout(360_000);
  const tag = Date.now().toString(36);
  const leader = await fundedTrader(page, 'jcl6', '2000');
  const leaderName = `Journey Costs ${tag}`;
  const leaderRef = await listLeader(leader, leaderName);
  const follower = await fundedTrader(page, 'jcf6', '1000');
  run.reset({ tag, leader, leaderName, leaderRef, follower });
  await signIn(page, follower);
  await followOnScreen(page, follower, leaderRef, { perOrder: '50', total: '300', fixed: '20' });
  await leadFill(leader, 'buy', '0.001', `${J}-1-a-${tag}`);
  await leadFill(leader, 'buy', '0.001', `${J}-1-b-${tag}`);
  await expect(async () => {
    await expect(copiedOrders(await openFollow(page, leaderRef))).toHaveCount(2, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });

  await page.goto('/money/activity');
  const rows = page.getByRole('row').filter({ hasText: 'Copy fee share' });
  await expect(rows.first()).toBeVisible(UNBUILT);
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row).toContainText(leaderName);
    await expect(row).toContainText('USDT');
    await expect(row).toContainText(/Fill [0-9a-f-]{8}/);
  }
  await expect(page.getByText(/profit share/i)).toHaveCount(0);
});

test(`${J} #2 opens a copied position with two fills and no funding data: average entry from the two fills; funding "Not set"`, async ({
  page,
}) => {
  await signIn(page, state('follower'));
  const detail = await openFollow(page, state('leaderRef'));
  await detail.getByRole('tab', { name: 'Positions' }).click(UNBUILT);
  const row = detail.getByRole('table', { name: 'Copied positions' }).locator('tbody tr').first();
  const prices = await copiedOrders(detail).locator('td:nth-child(5)').allInnerTexts();
  const avg = prices.map((p) => Number(p.replace(/[^\d.]/g, ''))).reduce((a, b) => a + b, 0) / prices.length;
  await expect(row).toContainText(String(Math.round(avg)).slice(0, 3));
  await expect(row).toContainText(/Funding\s*Not set/);
});

test(`${J} #3 as a lead opens the earnings panel: the profit-share refusal text and the fee-share facts only`, async ({ page }) => {
  await signIn(page, state('leader'));
  await page.goto('/trade/copy?tab=lead');
  const earnings = page.getByRole('region', { name: 'Your earnings' });
  await expect(earnings).toBeVisible(UNBUILT);
  await expect(earnings).toContainText('Leaders are paid a share of the trading fee only, never a share of profit.');
  await expect(earnings).toContainText(/Fee share earned\s*[\d.]+ USDT/);
});

test(`${J} #4 tries to set a pre-deduction of profit: refused as profit share forbidden, and no fee row is written`, async ({ page }) => {
  const leader = state('leader');
  const before = (await (await api(leader)).get('/api/trade/trpc/copy.feeShares?input=%7B%7D')).body?.result?.data?.items?.length ?? 0;
  await signIn(page, leader);
  await page.goto('/trade/copy?tab=lead');
  await page.getByRole('button', { name: 'Set a profit share' }).click(UNBUILT);
  await expect(page.getByText('Reference trade.copy_profit_share_forbidden')).toBeVisible();
  const after = (await (await api(leader)).get('/api/trade/trpc/copy.feeShares?input=%7B%7D')).body?.result?.data?.items?.length ?? 0;
  expect(after).toBe(before);
});

test(`${J} #5 opens the level view: the level and "Maximum ratio: not set by the platform"; setting a ratio is refused`, async ({
  page,
}) => {
  const leader = state('leader');
  await signIn(page, leader);
  await page.goto('/trade/copy?tab=lead');
  const level = page.getByRole('region', { name: 'Your level' });
  await expect(level).toContainText('Maximum ratio: not set by the platform', UNBUILT);
  const set = await (await api(leader)).post('/api/trade/trpc/copy.setMaxRatio', { ratio: '0.5' });
  expect(set.status).toBeGreaterThanOrEqual(400);
});

test(`${J} #6 looks for a leaderboard: the ranking categories refused, and only the stated empty state shows`, async ({ page }) => {
  await signIn(page, state('follower'));
  await page.goto('/trade/copy?tab=leaderboard');
  await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible(UNBUILT);
  await expect(page.getByText('Leaders are not ranked by returns here.')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Leaderboard' })).toHaveCount(0);
  await signOutBrowser(page.context());
});
