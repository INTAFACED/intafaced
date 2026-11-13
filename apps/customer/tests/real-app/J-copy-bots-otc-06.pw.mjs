// World: book
import { test, expect } from './journey.mjs';
import { api, journeyState, signOutBrowser, toUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { copiedOrders, followOnScreen, leadFill, listLeader, openFollow } from './copy.mjs';

// J-copy-bots-otc-06, in the running app (docs/roadmap/journeys.json): see what copying costs me and what a lead earns.
// One test per step, titled "J-copy-bots-otc-06 #<n>", run in order. #1 makes the journey's start: a TEST leader listed by
// the stack's TEST founder, a verified follower who follows it on screen, and two copied buys (the leader's own fills on
// the TEST book), so the fee share has settled fills to show. The fee share is the stack's TEST copy fee share.
// #2 to #6 run on what #1 made: the follower's copied position by average entry, then the leader's own desk (/trade/copy
// ?tab=lead) and the leaderboard tab. Steps that are written but not built yet fail at their first missing part, quickly
// (UNBUILT):
// - #1: money activity has no fee-share row per copied fill (copying through the venue door, where our builder fee is
//   earned, is not built; the TEST book has no builder fee).
const J = 'J-copy-bots-otc-06';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const SCALE = 10n ** 18n;
/** A scaled amount as the service writes it: no trailing zeros, no grouping. */
function fromUnits(units) {
  const whole = units / SCALE;
  const frac = (units % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
/** Quote paid over base filled, rounded half up at 18 places, as svc-trade divides. */
function averageEntry(fills) {
  const qty = fills.reduce((a, f) => a + toUnits(String(f.amount)), 0n);
  const cost = fills.reduce((a, f) => a + toUnits(String(f.cost)), 0n);
  const scaled = cost * SCALE;
  let q = scaled / qty;
  if ((scaled % qty) * 2n >= qty) q += 1n;
  return fromUnits(q);
}
const ungroup = (text) => text.replace(/,/g, '').trim();
/** The leader's earnings as the service answers them, for the leader's own key. */
async function leadEarnings(who) {
  const res = await (await api(who)).get(`/api/trade/trpc/copy.leadEarnings?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}
/** A tRPC refusal's own code. */
const refusalCode = (body) => body?.error?.data?.cause?.code ?? JSON.stringify(body).slice(0, 300);

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
  const follower = state('follower');
  // The follower's own fills, as the spot API reports them: the follower is new, so these are the two copied buys.
  const { body } = await (await api(follower)).get('/api/v1/account/trades?symbol=BTC%2FUSDT&limit=100');
  const fills = (Array.isArray(body) ? body : (body.trades ?? [])).filter((f) => f.side === 'buy');
  expect(fills, JSON.stringify(body).slice(0, 300)).toHaveLength(2);
  const expected = averageEntry(fills);

  await signIn(page, follower);
  const detail = await openFollow(page, state('leaderRef'));
  await detail.getByRole('tab', { name: 'Positions' }).click();
  const position = detail.getByRole('table', { name: 'Copied position by market' });
  const row = position.locator('tbody tr').filter({ hasText: 'BTC/USDT' });
  await expect(row).toHaveCount(1);
  const header = await position.locator('thead th').allInnerTexts();
  const cell = (name) => row.locator('td').nth(header.findIndex((h) => h.trim() === name));
  await expect(cell('Fills')).toHaveText('2');
  expect(ungroup(await cell('Average entry').innerText())).toBe(expected);
  await expect(cell('Funding')).toHaveText('Not set');
});

test(`${J} #3 as a lead opens the earnings panel: the profit-share refusal text and the fee-share facts only`, async ({ page }) => {
  const leader = state('leader');
  const earnings = await leadEarnings(leader);
  await signIn(page, leader);
  await page.goto('/trade/copy?tab=lead');
  const panel = page.getByRole('region', { name: 'Your earnings' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Leaders are paid a share of the trading fee only, never a share of profit.');
  // The fee-share facts: what was earned per asset (or that none is recorded), the share of our fee, and one history
  // row per recorded fee share, each with its fill.
  const earned = earnings.totals.length ? earnings.totals.map((x) => `${x.amount} ${x.assetId}`).join(', ') : 'None recorded';
  expect(ungroup(await panel.innerText())).toMatch(new RegExp(`Fee share earned\\s*${earned.replace(/[.]/g, '\\.')}`));
  await expect(panel).toContainText('Leader’s share of the fee');
  await expect(panel).toContainText(/Profit share\s*Not offered/);
  const history = panel.getByRole('table', { name: 'Fee share history' }).locator('tbody tr:not([data-slot="table-empty-row"])');
  await expect(history).toHaveCount(earnings.items.length);
  // Only fee-share facts: no profit, loss, return or unrealised figure anywhere in the panel.
  await expect(panel).not.toContainText(/P&L|PnL|ROI|unreali[sz]ed|realised profit|return/i);
});

test(`${J} #4 tries to set a pre-deduction of profit: refused as profit share forbidden, and no fee row is written`, async ({ page }) => {
  const leader = state('leader');
  const before = await leadEarnings(leader);
  await signIn(page, leader);
  await page.goto('/trade/copy?tab=lead');
  const panel = page.getByRole('region', { name: 'Your earnings' });
  await panel.getByLabel('Profit share, %').fill('10');
  await panel.getByRole('button', { name: 'Set a profit share' }).click();
  await expect(panel.getByRole('alert')).toContainText('Reference trade.copy_pnl_fee_forbidden');
  // The same refusal straight from the service, and nothing written: the fee-share rows are as they were.
  const direct = await (await api(leader)).post('/api/trade/trpc/copy.setProfitShare', { percent: '10' });
  expect(direct.status).toBe(403);
  expect(refusalCode(direct.body)).toBe('trade.copy_pnl_fee_forbidden');
  const after = await leadEarnings(leader);
  expect(after.items).toEqual(before.items);
  expect(after.totals).toEqual(before.totals);
});

test(`${J} #5 opens the level view: the level and "Maximum ratio: not set by the platform"; setting a ratio is refused`, async ({
  page,
}) => {
  const leader = state('leader');
  await signIn(page, leader);
  await page.goto('/trade/copy?tab=lead');
  const level = page.getByRole('region', { name: 'Your level' });
  // The owner has published no level thresholds, so the level is shown as not set, never as a made-up tier.
  await expect(level).toContainText(/Level\s*Not set: the platform has not published level thresholds/);
  await expect(level).toContainText(state('leaderRef'));
  await expect(level).toContainText('Maximum ratio: not set by the platform');
  await level.getByLabel('Maximum ratio').fill('0.5');
  await level.getByRole('button', { name: 'Set a maximum ratio' }).click();
  await expect(level.getByRole('alert')).toContainText('Reference trade.copy_pnl_fee_forbidden');
  // Any caller: the leader, and a follower who is no lead at all.
  for (const who of [leader, state('follower')]) {
    const set = await (await api(who)).post('/api/trade/trpc/copy.setMaxRatio', { ratio: '0.5' });
    expect(set.status).toBe(403);
    expect(refusalCode(set.body)).toBe('trade.copy_pnl_fee_forbidden');
  }
  const read = await (await api(leader)).get('/api/trade/trpc/copy.leadLevel');
  expect(read.body.result.data).toMatchObject({ level: null, maxRatio: null });
});

test(`${J} #6 looks for a leaderboard: the ranking categories refused, and only the stated empty state shows`, async ({ page }) => {
  const follower = state('follower');
  for (const ask of [{ category: 'top_return' }, { category: 'most_copied' }, { trending: true }]) {
    const res = await (
      await api(follower)
    ).get(`/api/trade/trpc/copy.listLeaders?input=${encodeURIComponent(JSON.stringify({ limit: 50, ...ask }))}`);
    expect(res.status, JSON.stringify(ask)).toBe(403);
    expect(refusalCode(res.body)).toBe('trade.copy_ranking_forbidden');
  }
  await signIn(page, follower);
  await page.goto('/trade/copy?tab=leaderboard');
  await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
  await expect(page.getByText('Leaders are not ranked by returns here.')).toBeVisible();
  const categories = page.getByRole('list', { name: 'Ranked categories' }).getByRole('listitem');
  await expect(categories).toHaveCount(3);
  for (const item of await categories.all()) {
    await expect(item).toContainText('Refused');
    await expect(item).toContainText('Reference trade.copy_ranking_forbidden');
  }
  await expect(page.getByRole('table', { name: 'Leaderboard' })).toHaveCount(0);
  await expect(page.getByRole('grid', { name: 'Leaderboard' })).toHaveCount(0);
  await signOutBrowser(page.context());
});
