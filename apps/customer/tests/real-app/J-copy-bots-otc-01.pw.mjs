import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, api, fromUnits, fund, journeyState, tool, signOutBrowser, toUnits } from './stack.mjs';
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

  // A control with no back end answers with a typed refusal, never a dead button: a ranked list is not offered, so
  // pressing one asks the service, which refuses by code, and the room says so in words.
  await tabs.getByRole('tab', { name: 'Leaders', exact: true }).click();
  const ranked = page.getByRole('group', { name: 'Ranked lists' }).getByRole('button', { name: 'Top return' });
  await expect(ranked).toBeEnabled();
  const ranking = page.waitForResponse((res) => res.url().includes('copy.listLeaders') && res.url().includes('category'));
  await ranked.click();
  expect((await ranking).status()).toBe(403);
  await expect(page.getByRole('alert').filter({ hasText: 'Rankings aren’t offered' })).toBeVisible();
  await expect(page.getByText('Reference trade.copy_ranking_forbidden')).toBeVisible();

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
  const leaders = page.getByRole('table', { name: 'Leaders' });
  await expect(leaders).toBeVisible();
  const order = async () => (await leaders.locator('tbody tr').allInnerTexts()).map((row) => row.trim());
  // The list as loaded: real leader rows with their Follow buttons, never the loading placeholder.
  await expect(leaders.getByRole('button', { name: /^Follow / }).first()).toBeVisible();
  await expect(leaders.locator('tbody')).not.toContainText('Loading');
  const before = await order();
  expect(before.length, 'the leader list has leaders to compare').toBeGreaterThan(0);
  for (const name of ['Top return', 'Trending']) {
    const answer = page.waitForResponse(
      (res) => res.url().includes('copy.listLeaders') && res.url().includes(name === 'Trending' ? 'trending' : 'category'),
    );
    await rankings.getByRole('button', { name }).click();
    expect((await answer).status()).toBe(403);
    await expect(page.getByRole('alert').filter({ hasText: 'Rankings aren’t offered' })).toBeVisible();
    await expect(page.getByText('Reference trade.copy_ranking_forbidden')).toBeVisible();
    // No returns-ranked board: the only table is still the plain leader list, in the same order, with no rank column.
    await expect(page.getByRole('table')).toHaveCount(1);
    await expect.poll(order, { message: `the leader list after ${name}` }).toEqual(before);
    await expect(leaders.getByRole('columnheader', { name: /rank/i })).toHaveCount(0);
  }
});

test(`${J} #4 opens a lead profile: metrics only with a definition, and the lead's real trades with entry, margin, TP/SL, close and ROI`, async ({
  page,
}) => {
  const tag = state('tag');
  // The lead trades on the TEST book at the best price: two buys, then a sell that closes the first one. The taker fee
  // is paid in the bought asset, so the second buy is what lets the sell close the first in full.
  const leader = state('leader');
  const closedBuy = await takeBest(leader, 'buy', '0.001', `${J}-4-buy-${tag}`);
  const openBuy = await takeBest(leader, 'buy', '0.0005', `${J}-4-open-${tag}`);
  const sell = await takeBest(leader, 'sell', '0.001', `${J}-4-sell-${tag}`);
  // What each row must show, from the leader's own fills (not from the profile read): spot margin is the quote paid, the
  // entry and close are quote over amount, and the return is (close − entry) / entry.
  // The ledger settles a fill a moment after the order reads filled, so the read waits until all three orders' fills are in.
  const leaderApi = await api(leader);
  let fills = [];
  await expect
    .poll(
      async () => {
        const { status, body } = await leaderApi.get(`/api/v1/account/trades?symbol=${encodeURIComponent('BTC/USDT')}&limit=100`);
        expect(status).toBe(200);
        fills = Array.isArray(body) ? body : (body.trades ?? []);
        return [closedBuy, openBuy, sell].every((order) => fills.some((f) => f.order === order.id));
      },
      { timeout: 30_000, message: "the leader's three orders each have their fills" },
    )
    .toBe(true);
  const summed = (order) => {
    const own = fills.filter((f) => f.order === order.id);
    const quote = own.reduce((sum, f) => sum + toUnits(f.cost), 0n);
    const qty = own.reduce((sum, f) => sum + toUnits(f.amount), 0n);
    expect(fromUnits(qty), `the fills of order ${order.id} add up to the order`).toBe(fromUnits(toUnits(order.filled)));
    return { quote, price: (quote * 10n ** 18n) / qty };
  };
  const [closedIn, openIn, out] = [summed(closedBuy), summed(openBuy), summed(sell)];

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
  const headers = (await trades.locator('thead th').allInnerTexts()).map((h) => h.trim());
  for (const header of ['Entry price', 'Margin', 'TP / SL', 'Close price', 'Return before fees']) {
    expect(headers, `the trade table has a ${header} column`).toContain(header);
  }
  const cell = async (row, header) => (await rows.nth(row).locator('td').nth(headers.indexOf(header)).innerText()).trim();
  const amountOf = (text) => toUnits(text.replace(/,/g, '').replace('−', '-'));
  // Within one unit of the eighth place: the service floors its division, this side truncates.
  const near = (shown, expected, what) =>
    expect(
      Math.abs(Number(amountOf(shown) - expected)),
      `${what}: shown ${shown}, from the fills ${fromUnits(expected)}`,
    ).toBeLessThanOrEqual(1e10);
  // The open buy: its own entry and margin, no close.
  near(await cell(0, 'Entry price'), openIn.price, 'open row entry');
  expect(amountOf(await cell(0, 'Margin')), 'open row margin is the quote paid').toBe(openIn.quote);
  expect(await cell(0, 'Close price')).toBe('Still open');
  // The round trip: the first buy's entry and margin, the sell's close, and the return between them.
  near(await cell(1, 'Entry price'), closedIn.price, 'closed row entry');
  expect(amountOf(await cell(1, 'Margin')), 'closed row margin is the quote paid').toBe(closedIn.quote);
  near(await cell(1, 'Close price'), out.price, 'closed row close');
  // The return as the service computes it (18 places, half up), then shown to the cent, half up, as the room does.
  const diff = (out.price - closedIn.price) * 100n * 10n ** 18n;
  const half = closedIn.price / 2n;
  const roi18 = diff >= 0n ? (diff + half) / closedIn.price : -((-diff + half) / closedIn.price);
  const roiAbs = roi18 < 0n ? -roi18 : roi18;
  const roiCents = roiAbs / 10n ** 16n + ((roiAbs / 10n ** 15n) % 10n >= 5n ? 1n : 0n);
  const roiShown = `${roi18 < 0n && roiCents > 0n ? '−' : ''}${roiCents / 100n}.${String(roiCents % 100n).padStart(2, '0')}%`;
  expect(await cell(1, 'Return before fees'), 'the return, from the fills').toBe(roiShown);

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

test(`${J} #5 presses Start copying: below the copy verification level, under a blank country list and as a sub-account, each refused by name, and nothing is followed`, async ({
  page,
}) => {
  // Signing up and funding a new account takes most of a minute, and the country-list restart two more.
  test.setTimeout(420_000);
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

  // A blank country list refuses every follow, a verified person's too, and writes nothing.
  const follower = state('follower');
  const me = await api(follower);
  const followsBefore = await myFollows(me);
  try {
    await copyCountries('blank');
    const refused = await (
      await api(follower)
    ).post('/api/trade/trpc/copy.follow', {
      leaderRef: state('spotRef'),
      region: 'DE',
      permittedMarkets: ['BTC/USDT'],
      maxNotionalPerOrder: '50',
      maxAggregateExposure: '200',
      fixedOrderSize: '20',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      clientRequestId: `journey-blank-countries:${state('tag')}`,
    });
    expect(
      refused.body?.error?.data?.cause?.code ?? refused.body?.error?.data?.intafacedCode,
      JSON.stringify(refused.body).slice(0, 300),
    ).toBe('trade.copy_jurisdiction_blank');
    expect(await myFollows(await api(follower)), 'no follow was started under a blank country list').toEqual(followsBefore);
    await signIn(page, follower);
    await page.goto('/trade/copy');
    await expect(page.getByRole('heading', { name: 'Copy trading', level: 1 })).toBeVisible();
    await expect(page.getByText('Copy desk closed')).toBeVisible();
    await expect(page.getByText('Copy desk open')).toHaveCount(0);
  } finally {
    await copyCountries('set');
  }

  // A sub-account is refused (trade.copy_subaccount_refused). No sign-in in the product yet issues a sub-account session,
  // so this clause cannot be shown in the running app: the step fails here by name until one exists.
  throw new Error('BLOCKED: no sub-account sign-in exists, so the sub-account refusal cannot be shown in the running app');
});

/** Restart trade with the copy country list blank (`blank`) or as the TEST profile sets it (`set`), by its stack switch. */
async function copyCountries(state) {
  const before = process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION;
  if (state === 'blank') process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION = 'blank';
  else delete process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION;
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION;
    else process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION = before;
  }
  // A restart outlasts Edge's idle timeout: drop the closed kept-alive sockets before the next write (as in J-14).
  for (let i = 0, live = 0; i < 20 && live < 3; i++) {
    try {
      await fetch(`${EDGE}/api/v1/orderbook/${encodeURIComponent('BTC/USDT')}?limit=1`, { headers: { origin: ORIGIN } }).then((r) =>
        r.arrayBuffer(),
      );
      live += 1;
    } catch (error) {
      if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
      live = 0;
    }
  }
}

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
  const me = await api(follower);
  // The service itself refuses each amount the screen refuses below, by its typed code, and starts no follow: a zero
  // fixed amount, one above the most per order, and a total above the free balance.
  const ask = (over) =>
    me.post('/api/trade/trpc/copy.follow', {
      leaderRef: state('spotRef'),
      region: 'DE',
      permittedMarkets: ['BTC/USDT'],
      maxNotionalPerOrder: '50',
      maxAggregateExposure: '200',
      fixedOrderSize: '20',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      clientRequestId: `${J}-7-refused-${Date.now()}`,
      ...over,
    });
  for (const [over, code] of [
    [{ fixedOrderSize: '0' }, 'trade.copy_envelope_invalid'],
    [{ fixedOrderSize: '60' }, 'trade.copy_fixed_size_above_cap'],
    [{ maxAggregateExposure: fromUnits(toUnits(before.free) + toUnits('1')) }, 'trade.copy_reserve_exceeds_balance'],
  ]) {
    const refused = await ask(over);
    expect(
      refused.body?.error?.data?.cause?.code ?? refused.body?.error?.data?.intafacedCode,
      JSON.stringify(refused.body).slice(0, 300),
    ).toBe(code);
  }
  expect(await myFollows(me), 'no follow was started by a refused request').toEqual([]);
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

  // The reserve is a limit, not a hold: the ledger balance is what it was, and svc-trade holds 200 USDT of it for this
  // follow.
  expect((await (await api(follower)).balances()).USDT).toEqual(before);
  const [spot] = await myFollows(me);
  expect(spot.reserve).toEqual({ asset: 'USDT', amount: '200', released: false });
  // Held from the free balance: a total that fits the free balance but not what is left beside the 200 is refused.
  const futuresLeaderRef = await futuresRef(me);
  const tooMuch = await me.post('/api/trade/trpc/copy.follow', {
    leaderRef: futuresLeaderRef,
    region: 'DE',
    permittedMarkets: ['BTC/USDT'],
    maxNotionalPerOrder: '50',
    maxAggregateExposure: fromUnits(toUnits(before.free) - toUnits('200') + toUnits('1')),
    fixedOrderSize: '10',
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    clientRequestId: `journey-too-much:${state('tag')}`,
  });
  expect(
    tooMuch.body?.error?.data?.cause?.code ?? tooMuch.body?.error?.data?.intafacedCode,
    JSON.stringify(tooMuch.body).slice(0, 300),
  ).toBe('trade.copy_reserve_exceeds_balance');
  expect((await myFollows(me)).map((f) => f.followId)).toEqual([spot.followId]);

  // The same request sent twice is one follow (here to the futures leader, by the API the screen uses).
  const request = {
    leaderRef: futuresLeaderRef,
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

/** The follower's follows as svc-trade reads them back to their owner. */
async function myFollows(me) {
  const res = await me.get(`/api/trade/trpc/copy.listMyFollows?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

// svc-trade's mirror client id `copy-mirror:<follow>:<fill>`, hashed to 64 hex characters only when longer than 64; a
// fill id shaped as a UUID is lower-cased first.
const capped = (id) => (id.length <= 64 ? id : createHash('sha256').update(id).digest('hex').slice(0, 64));
const canonicalFill = (id) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim()) ? id.trim().toLowerCase() : id.trim();

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
  const leadBuy = await takeBest(state('leader'), 'buy', '0.001', `${J}-8-buy-${state('tag')}`);
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
  // As the follower, at the fixed amount: the copy is an order in the follower's own book (read with their own session),
  // under svc-trade's mirror client id for exactly one of the lead's fills, and its quantity is exactly the fixed 20 USDT
  // at that fill's price, stepped down to the market's lot.
  const me = await api(follower);
  const spot = (await myFollows(me)).find((f) => f.leaderRef === state('spotRef'));
  expect(spot, 'the spot follow from #7').toBeTruthy();
  const leader = await api(state('leader'));
  const fills = await leader.get(`/api/v1/account/trades?symbol=BTC/USDT&limit=100`);
  expect(fills.status, JSON.stringify(fills.body).slice(0, 300)).toBe(200);
  const leadFills = fills.body.filter((f) => f.order === leadBuy.id);
  expect(leadFills.length, `the lead's buy ${leadBuy.id} has no fills listed`).toBeGreaterThan(0);
  const markets = await me.get('/api/v1/markets?limit=500');
  const lot = toUnits(markets.body.find((m) => m.symbol === 'BTC/USDT').precision.amount);
  const mirrored = [];
  for (const f of leadFills) {
    const res = await me.get(
      `/api/v1/orders/by-client-id/${encodeURIComponent(capped(`copy-mirror:${spot.followId}:${canonicalFill(f.id)}`))}?symbol=BTC/USDT`,
    );
    expect([200, 404], JSON.stringify(res.body).slice(0, 300)).toContain(res.status);
    if (res.status === 200) mirrored.push({ fill: f, order: res.body });
  }
  expect(mirrored, 'exactly one copied order, for one of the lead fills').toHaveLength(1);
  const [{ fill, order }] = mirrored;
  expect(order.side).toBe('buy');
  const scaled = (toUnits(fill.amount) * toUnits('20')) / toUnits(fill.cost);
  expect(toUnits(order.amount), `20 USDT at ${fill.price}, stepped to the lot ${fromUnits(lot)}`).toBe(scaled - (scaled % lot));

  // A second sweep places nothing more: still one copied order a few seconds later.
  await page.waitForTimeout(5_000);
  await page.reload();
  await row.first().getByRole('button', { name: 'Manage' }).click();
  await expect(copied).toHaveCount(1);
});
