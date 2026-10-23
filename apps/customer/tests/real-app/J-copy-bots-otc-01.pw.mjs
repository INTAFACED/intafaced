import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { fundedTrader, signIn, signUp, verify } from './desk.mjs';
import { listLeader, takeBest } from './copy.mjs';

// J-copy-bots-otc-01, in the running app (docs/roadmap/journeys.json): follow a lead trader with a fixed amount and see
// the first copied trade. One test per step this build serves, titled "J-copy-bots-otc-01 #<n>", run in order. The
// follower starts signed in and verified; the leaders are TEST accounts the stack's TEST founder lists through
// svc-trade's own operator door, and the lead's trades are its own real fills on the TEST book.
const J = 'J-copy-bots-otc-01';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const TABS = ['Leaders', 'Futures', 'Spot', 'Bots', 'Signal', 'My follows', 'Rules'];

test(`${J} #1 opens Copy trading: every tab, an empty tab says so with no placeholder row, the desk state is read`, async ({ page }) => {
  const follower = await signUp(page, 'jcf');
  await verify(page, follower);
  run.reset({ follower, tag: Date.now().toString(36) });
  await signIn(page, follower);

  await page.goto('/trade/copy');
  await expect(page.getByRole('heading', { name: 'Copy trading', level: 1 })).toBeVisible();
  const tabs = page.getByRole('tablist', { name: 'Copy trading sections' });
  for (const name of TABS) await expect(tabs.getByRole('tab', { name, exact: true })).toBeVisible();

  // No journey ever lists a signal leader, so that tab is the empty directory: the words, and no row at all.
  await tabs.getByRole('tab', { name: 'Signal', exact: true }).click();
  await expect(page).toHaveURL(/tab=signal/);
  await expect(page.getByText('No leaders are listed')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Leaders' }).getByRole('button', { name: /^Follow / })).toHaveCount(0);

  // The desk state comes from the service (TEST fee share and country list are published on this stack).
  await expect(page.getByText('Copy desk open')).toBeVisible();
  await tabs.getByRole('tab', { name: 'Rules', exact: true }).click();
  await expect(page.getByText('10%')).toBeVisible();
});

test(`${J} #2 chooses the Futures tab and searches a name: only futures leaders, matched on the server in any case`, async ({ page }) => {
  // Funding the leader on the TEST book takes most of a minute.
  test.setTimeout(240_000);
  const tag = state('tag');
  const leader = await fundedTrader(page, 'jcl', '1000');
  const spotName = `Journey Spot ${tag}`;
  const futuresName = `Journey Futures ${tag}`;
  const spotRef = await listLeader(leader, spotName, { tenureStart: '2026-01-01T00:00:00.000Z' });
  const futuresLeader = await signUp(page, 'jcx');
  await listLeader(futuresLeader, futuresName, { marketMode: 'futures' });
  run.write({ leader, spotName, spotRef, futuresName });

  await page.context().clearCookies();
  await signIn(page, state('follower'));
  await page.goto('/trade/copy?tab=futures');
  const table = page.getByRole('table', { name: 'Leaders' });
  await expect(table.getByRole('link', { name: futuresName })).toBeVisible();
  await expect(table.getByRole('link', { name: spotName })).toHaveCount(0);

  // The search goes to the service with the tab's market: the screen does not filter a second time.
  const asked = page.waitForRequest((req) => {
    if (!req.url().includes('copy.listLeaders')) return false;
    const input = JSON.parse(new URL(req.url()).searchParams.get('input') ?? '{}');
    return input.marketMode === 'futures' && input.q === `futures ${tag}`.toUpperCase();
  });
  await page.getByLabel('Search leaders').fill(`futures ${tag}`.toUpperCase());
  await asked;
  await expect(table.getByRole('link', { name: futuresName })).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(1);

  // The same search on the Spot tab finds no futures leader.
  await page.goto('/trade/copy?tab=spot');
  await page.getByLabel('Search leaders').fill(`FUTURES ${tag}`);
  await expect(page.getByText('No leader matches that name')).toBeVisible();
  await page.getByLabel('Search leaders').fill(`spot ${tag}`);
  await expect(table.getByRole('link', { name: spotName })).toBeVisible();
});

test(`${J} #3 opens a ranked category and the trending row: a typed refusal, and no returns-ranked board`, async ({ page }) => {
  await signIn(page, state('follower'));
  await page.goto('/trade/copy');
  const rankings = page.getByRole('group', { name: 'Ranked lists' });
  for (const name of ['Top return', 'Trending']) {
    const answer = page.waitForResponse(
      (res) => res.url().includes('copy.listLeaders') && res.url().includes(name === 'Trending' ? 'trending' : 'category'),
    );
    await rankings.getByRole('button', { name }).click();
    expect((await answer).status()).toBe(403);
    await expect(page.getByRole('alert').filter({ hasText: 'Rankings aren’t offered' })).toBeVisible();
    await expect(page.getByText('Reference trade.copy_ranking_forbidden')).toBeVisible();
  }
});

test(`${J} #4 opens a lead profile: metrics only with a definition, and the lead's real trades with entry, margin, TP/SL, close and ROI`, async ({
  page,
}) => {
  const tag = state('tag');
  // The lead trades on the TEST book at the best price: two buys, then a sell that closes the first one. The taker fee
  // is paid in the bought asset, so the second buy is what lets the sell close the first in full.
  const leader = state('leader');
  await takeBest(leader, 'buy', '0.001', `${J}-4-buy-${tag}`);
  await takeBest(leader, 'buy', '0.0005', `${J}-4-open-${tag}`);
  await takeBest(leader, 'sell', '0.001', `${J}-4-sell-${tag}`);

  await signIn(page, state('follower'));
  await page.goto('/trade/copy?tab=spot');
  await page.getByLabel('Search leaders').fill(`spot ${tag}`);
  await page
    .getByRole('table', { name: 'Leaders' })
    .getByRole('link', { name: state('spotName') })
    .click();
  await expect(page).toHaveURL(new RegExp(`/trade/copy/${state('spotRef')}$`));
  await expect(page.getByRole('heading', { name: state('spotName'), level: 1 })).toBeVisible();

  // Return and drawdown carry the TEST definitions; this listing publishes no figure, so each reads Not published.
  const metric = (key) => page.locator(`.cb-metric[data-metric=${key}]`);
  await expect(metric('publishedReturn')).toContainText('Not published');
  await expect(metric('publishedReturn')).toContainText('TEST definition');
  // No definition is published for these, so no number is shown.
  await expect(metric('winRate')).toHaveText(/Win rate\s*Not set by the platform/);
  await expect(metric('sharpeRatio')).toHaveText(/Sharpe ratio\s*Not set by the platform/);

  const trades = page.getByRole('table', { name: 'Leader trades' });
  const rows = trades.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  // Newest first: the open buy, then the closed round trip.
  await expect(rows.nth(0)).toContainText('Open');
  await expect(rows.nth(0)).toContainText('Still open');
  await expect(rows.nth(1)).toContainText('Closed');
  await expect(rows.nth(1)).toContainText('None set');
  await expect(rows.nth(1)).toContainText(/[−]?\d+\.\d\d%/);
  for (const header of ['Entry price', 'Margin', 'TP / SL', 'Close price', 'Return before fees']) {
    await expect(trades.getByRole('columnheader', { name: header })).toBeVisible();
  }

  // An unknown leader page is a typed not-found, never an empty profile.
  await page.goto('/trade/copy/no-such-leader');
  await expect(page.getByText('That leader was not found')).toBeVisible();
});
