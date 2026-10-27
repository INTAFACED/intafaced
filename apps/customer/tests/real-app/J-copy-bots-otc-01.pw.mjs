import { test, expect } from '@playwright/test';
import { api, fund, journeyState, tool, signOutBrowser } from './stack.mjs';
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

  await signOutBrowser(page.context());
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
  const metric = (key) => page.locator(`[data-testid="cb-metric"][data-metric=${key}]`);
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

/** A permission end a week ahead, in the datetime-local box's own format. */
function weekAhead() {
  const when = new Date(Date.now() + 7 * 24 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/** Start copying from the lead page, through the country and market steps, to the limits step. */
async function openWizardAtLimits(page) {
  await page.goto(`/trade/copy/${state('spotRef')}`);
  await page.getByRole('button', { name: 'Start copying' }).click();
  const wizard = page.getByRole('dialog');
  await expect(wizard.getByText(state('spotName'))).toBeVisible();
  await wizard.getByLabel('Your country').fill('DE');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByText('BTC/USDT', { exact: true }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  return wizard;
}

async function fillLimits(wizard, { perOrder, total, fixed }) {
  await wizard.getByLabel('Most per order (USDT)').fill(perOrder);
  await wizard.getByLabel('Most in total (USDT)').fill(total);
  await wizard.getByLabel('Fixed amount per copied order (USDT)').fill(fixed);
  await wizard.getByLabel('Permission ends').fill(weekAhead());
}

test(`${J} #5 presses Start copying below the copy verification level: refused by name, and nothing is followed`, async ({ page }) => {
  // Signing up and funding a new account takes most of a minute.
  test.setTimeout(240_000);
  // Verified at basic, which opens the copy room, but the TEST copy level is full.
  const unverified = await signUp(page, 'jcn');
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: 'Basic' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  tool('local-test-gates.mjs', 'verify');
  fund(unverified.email, 'USDT', '1000');
  await signOutBrowser(page.context());
  await signIn(page, unverified);
  const wizard = await openWizardAtLimits(page);
  await fillLimits(wizard, { perOrder: '50', total: '200', fixed: '20' });
  await wizard.getByRole('button', { name: 'Next' }).click();
  const answer = page.waitForResponse((res) => res.url().includes('copy.follow'));
  await wizard.getByRole('button', { name: 'Start copying' }).click();
  expect((await answer).status()).toBe(403);
  await expect(wizard.getByRole('alert').filter({ hasText: 'More verification needed' })).toBeVisible();
  await expect(wizard.getByText('Reference trade.tier_insufficient')).toBeVisible();

  // Nothing was written: no follow, and the balance is untouched.
  await page.keyboard.press('Escape');
  await page.goto('/trade/copy?tab=follows');
  await expect(page.getByText('You aren’t following anyone')).toBeVisible();
  expect((await (await api(unverified)).balances()).USDT).toMatchObject({ free: '1000', used: '0' });
});

// Step 6 was "reads and accepts the copy disclosure". Deferred until launch prep (owner decision 2026-10-27): no risk
// disclosure is asked for, so this step proves the review asks for none and Start is on once the limits are valid.
test(`${J} #6 reaches the review with no risk disclosure to accept, and Start copying is on`, async ({ page }) => {
  const follower = state('follower');
  fund(follower.email, 'USDT', '1000');
  await signIn(page, follower);
  const wizard = await openWizardAtLimits(page);
  await fillLimits(wizard, { perOrder: '50', total: '200', fixed: '20' });
  await wizard.getByRole('button', { name: 'Next' }).click();

  await expect(wizard.getByRole('region', { name: 'What it costs' })).toBeVisible();
  await expect(wizard.getByRole('region', { name: 'Copy risk disclosure' })).toHaveCount(0);
  await expect(wizard.getByRole('checkbox', { name: /disclosure/ })).toHaveCount(0);
  await expect(wizard.getByRole('button', { name: 'Start copying' })).toBeEnabled();
});

test(`${J} #7 enters a fixed amount and starts: zero and above-cap refused, the reserve is held from the free balance, and the same request returns the same follow`, async ({
  page,
}) => {
  const follower = state('follower');
  const before = (await (await api(follower)).balances()).USDT;
  await signIn(page, follower);
  const wizard = await openWizardAtLimits(page);

  await fillLimits(wizard, { perOrder: '50', total: '200', fixed: '0' });
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByText('Enter an amount above zero')).toBeVisible();
  await wizard.getByLabel('Fixed amount per copied order (USDT)').fill('60');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByText('The most per order is 50 USDT')).toBeVisible();
  // More than the free balance is refused on the screen, before the service is asked.
  await wizard.getByLabel('Fixed amount per copied order (USDT)').fill('20');
  await wizard.getByLabel('Most in total (USDT)').fill('5000');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByText('That is more than your free USDT')).toBeVisible();
  await wizard.getByLabel('Most in total (USDT)').fill('200');
  await expect(wizard.getByText('Reserved for this copy')).toBeVisible();
  await wizard.getByRole('button', { name: 'Next' }).click();

  const answer = page.waitForResponse((res) => res.url().includes('copy.follow'));
  await wizard.getByRole('button', { name: 'Start copying' }).click();
  expect((await answer).status()).toBe(200);
  await expect(page).toHaveURL(/tab=follows/);
  // The follows table is a grid: its second row group holds one row per follow.
  const row = page.getByRole('grid', { name: 'My follows' }).getByRole('rowgroup').nth(1).getByRole('row');
  await expect(row).toHaveCount(1);
  await row.first().getByRole('button', { name: 'Manage' }).click();
  const detail = page.getByRole('dialog');
  await expect(detail.getByText('Reserved for this copy')).toBeVisible();
  await expect(detail).toContainText('200 USDT');
  await expect(detail).toContainText('20 USDT');

  // The reserve is a limit, not a hold: the ledger balance is what it was.
  expect((await (await api(follower)).balances()).USDT).toEqual(before);

  // The same request sent twice is one follow (here to the futures leader, by the API the screen uses).
  const me = await api(follower);
  const request = {
    leaderRef: await futuresRef(me),
    region: 'DE',
    permittedMarkets: ['BTC/USDT'],
    maxNotionalPerOrder: '50',
    maxAggregateExposure: '100',
    fixedOrderSize: '10',
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    clientRequestId: `journey-start:${state('tag')}`,
  };
  const first = await me.post('/api/trade/trpc/copy.follow', request);
  const second = await me.post('/api/trade/trpc/copy.follow', request);
  expect(first.status, JSON.stringify(first.body).slice(0, 300)).toBe(200);
  expect(second.body.result.data.followId).toBe(first.body.result.data.followId);
  expect(second.body.result.data.reserve).toEqual({ asset: 'USDT', amount: '100', released: false });
});

/** The futures leader's public ref, read from the directory the way the screen reads it. */
async function futuresRef(me) {
  const input = encodeURIComponent(JSON.stringify({ limit: 50, marketMode: 'futures', q: state('futuresName') }));
  const page = await me.get(`/api/trade/trpc/copy.listLeaders?input=${input}`);
  const ref = page.body?.result?.data?.leaders?.[0]?.leaderRef;
  if (!ref) throw new Error(`no futures leader listed: ${JSON.stringify(page.body).slice(0, 300)}`);
  return ref;
}

test(`${J} #8 sees the first copied trade: the leader's next buy is copied once as the follower at the fixed amount, and listed on the follow`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const follower = state('follower');
  await signIn(page, follower);
  await page.goto('/trade/copy?tab=follows');
  // #7 followed the spot leader on screen and the futures leader by the API; this is the spot leader's follow.
  const row = page
    .getByRole('grid', { name: 'My follows' })
    .getByRole('rowgroup')
    .nth(1)
    .getByRole('row')
    .filter({ hasText: state('spotRef') });
  await row.first().getByRole('button', { name: 'Manage' }).click();
  const detail = page.getByRole('dialog');
  // Start copying in #7 also turned automatic copying on; nothing is copied before the leader trades again.
  await expect(detail.getByRole('button', { name: 'Turn off automatic copying' })).toBeVisible();
  await expect(detail.getByText('No copied orders')).toBeVisible();

  // The lead buys on the TEST book; the copy driver places the follower's copy at the leader's price, 20 USDT worth.
  await takeBest(state('leader'), 'buy', '0.001', `${J}-8-buy-${state('tag')}`);
  const copied = detail.getByRole('table', { name: 'Copied orders' }).locator('tbody tr:not([data-slot="table-empty-row"])');
  await expect(async () => {
    await page.reload();
    await row.first().getByRole('button', { name: 'Manage' }).click();
    await expect(copied).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(copied.first()).toContainText('BTC/USDT');
  await expect(copied.first()).toContainText('Buy');
  // The copy is the fixed amount at the leader's price, stepped down to the market's lot: never more than 20 USDT.
  const cells = copied.first().locator('td');
  const number = async (i) => Number((await cells.nth(i).innerText()).replace(/[^\d.]/g, ''));
  const notional = (await number(2)) * (await number(4));
  expect(notional).toBeGreaterThan(0);
  expect(notional).toBeLessThanOrEqual(20);
  // The list reads the follower's own order book, so this row is an order placed as them.

  // A second sweep places nothing more: still one copied order a few seconds later.
  await page.waitForTimeout(5_000);
  await page.reload();
  await row.first().getByRole('button', { name: 'Manage' }).click();
  await expect(copied).toHaveCount(1);
});
