import { createHash } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ORIGIN, api, bestPrices, fund, toUnits } from './stack.mjs';
import { fundedTrader, openOrders, signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';

// J-home-ia-01, in the running app (docs/roadmap/journeys.json): I open the app and see where I stand. Tests titled
// "J-home-ia-01 #<n>" prove a whole step. One TEST person walks the steps in order: TEST USDT and BTC through the real
// ledger, plus a fiat code no market prices, so the total has something it must name and leave out.
const J = 'J-home-ia-01';

test.describe.configure({ mode: 'serial' });

let who;

/** "1234567.891" -> "1,234,567.891": the grouping the hero number speaks. */
function grouped(decimal) {
  const [whole, frac] = decimal.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac === undefined ? '' : `.${frac}`}`;
}

/** A decimal string rounded half up to `places`, without a float. */
function roundTo(decimal, places) {
  const [whole, frac = ''] = decimal.split('.');
  const padded = `${frac}${'0'.repeat(places + 1)}`;
  let units = BigInt(`${whole}${padded.slice(0, places)}`);
  if (Number(padded[places]) >= 5) units += 1n;
  const text = units.toString().padStart(places + 1, '0');
  return `${text.slice(0, -places)}.${text.slice(-places)}`;
}

/** The bank's own valuation for this person, as Home and Assets must show it. */
async function bankSummary(input) {
  const client = await api(who);
  const query = input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : '';
  const { status, body } = await client.get(`/api/bank/trpc/portfolio.summary${query}`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

/** What the total on the page says it is (the hero number's spoken label). */
const totalOn = (page, scopes) =>
  page
    .locator(
      scopes
        .split(',')
        .map((scope) => `${scope.trim()} [data-slot="hero-number"]`)
        .join(', '),
    )
    .first();
async function spokenTotal(page, scope) {
  return totalOn(page, scope).locator('[role=img]').first().getAttribute('aria-label');
}

/** A UUID (version 4 layout) derived from a business key, for APIs that take a UUID id. */
function businessUuid(key) {
  const hex = createHash('sha256').update(key).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const HOME_TOTAL = '[data-testid="hp-total__figure"], [data-testid="home-total"]';

/** Do `act`, then wait until the change is written to the account's view record (the app waits half a second, then writes). */
async function savedToAccount(page, act) {
  const written = page.waitForResponse((res) => res.url().includes('preferences.set') && res.request().method() === 'POST');
  await act();
  expect((await written).status()).toBe(200);
}
const usd = (summary) => (summary.totalUsd === null ? null : `$${grouped(summary.totalUsd)}`);

/**
 * The TEST market maker keeps moving BTC's price, so the page is compared with the bank's reads just before and just after
 * it loads: the page must show one of those two valuations exactly.
 */
async function showsBankTotal(page, path, scope, expected, input) {
  await expect
    .poll(
      async () => {
        const before = expected(await bankSummary(input));
        await page.goto(path);
        await totalOn(page, scope).locator('[role=img]').first().waitFor();
        const shown = await spokenTotal(page, scope);
        const after = expected(await bankSummary(input));
        return shown === before || shown === after ? 'same' : `page ${shown}, bank ${before} then ${after}`;
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBe('same');
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await browser.newPage();
  who = await fundedTrader(page, 'hm', '1000');
  expect(fund(who.email, 'BTC', '0.01').tx).toBeTruthy();
  expect(fund(who.email, 'EUR', '25').tx).toBeTruthy();
  // The newest movement, with all 18 decimals, so the list must show it to the last digit.
  expect(fund(who.email, 'USDT', '0.123456789012345678').tx).toBeTruthy();
  await page.close();
});

test(`${J} #1 Home shows the bank's total to the cent, names what it leaves out, and follows the unit chosen (BTC, or dollars with a note)`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, who);
  await showsBankTotal(page, '/', HOME_TOTAL, usd);
  const summary = await bankSummary();

  // EUR has no USD market: it is named as left out, never counted as zero.
  expect(summary.unpriced.map((row) => row.asset)).toContain('EUR');
  await expect(page.getByText(/Excludes \d+ coins? \(no USD price\)/)).toBeVisible();

  // The person picks BTC in View; Home then shows the bank's BTC total, or keeps dollars and says why.
  await page.goto('/view');
  await savedToAccount(page, () => page.getByLabel('Display currency').selectOption('BTC'));
  try {
    const inBtc = await bankSummary({ displayCurrency: 'BTC' });
    if (inBtc.btc?.total) {
      await showsBankTotal(page, '/', HOME_TOTAL, (row) => (row.btc?.total ? `₿${grouped(roundTo(row.btc.total, 8))}` : null), {
        displayCurrency: 'BTC',
      });
      await expect(page.getByText(/^Shown in BTC at the current BTC price\. In dollars: \$[\d,.]+$/)).toBeVisible();
    } else {
      await showsBankTotal(page, '/', HOME_TOTAL, usd, { displayCurrency: 'BTC' });
      await expect(page.getByText('There is no BTC price right now, so the total is shown in dollars.')).toBeVisible();
    }
    await expect(page.locator('[data-slot="state-block"][data-kind="error"]')).toHaveCount(0);
  } finally {
    // Back to dollars for the steps that follow, even when this one fails.
    await page.goto('/view');
    await savedToAccount(page, () => page.getByLabel('Display currency').selectOption('USD'));
  }
});

test(`${J} #2 the eye hides amounts and keeps prices, and the choice follows the person to another device`, async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signIn(page, who);
  await page.goto('/');
  await expect(totalOn(page, HOME_TOTAL).locator('[role=img]')).toBeVisible();
  await savedToAccount(page, () => page.getByRole('button', { name: 'Hide balances' }).first().click());
  await expect(totalOn(page, HOME_TOTAL)).toHaveAttribute('data-hidden', 'true');
  await expect(totalOn(page, HOME_TOTAL).getByLabel('Hidden')).toBeVisible();
  // Prices are not balances: the markets on Home still show theirs.
  await expect(page.locator('[data-testid="hp-markets"] [role=row], [data-testid="home-cards"] > *').nth(1)).toContainText(/\d/);
  await expect(page.getByRole('button', { name: 'Show balances' }).first()).toBeVisible();

  // A second device: a fresh browser with nothing stored, signed in as the same person.
  const other = await browser.newContext({ baseURL: 'http://127.0.0.1:3210', viewport: { width: 1440, height: 900 } });
  const second = await other.newPage();
  await signIn(second, who);
  await second.goto('/');
  await expect(totalOn(second, HOME_TOTAL)).toHaveAttribute('data-hidden', 'true');
  await expect(second.getByRole('button', { name: 'Show balances' }).first()).toBeVisible();
  await savedToAccount(second, () => second.getByRole('button', { name: 'Show balances' }).first().click());
  await expect(totalOn(second, HOME_TOTAL).locator('[role=img]')).toBeVisible();
  await other.close();
});

test(`${J} #3 the total's Assets link opens the Assets room with the same total and the same holdings`, async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, who);
  await showsBankTotal(page, '/', HOME_TOTAL, usd);
  const onHome = await spokenTotal(page, HOME_TOTAL);
  // The total's own link, not the Assets door in the top bar.
  await page.locator('[data-testid="hp-label"], [data-testid="home-label"]').getByRole('link', { name: 'Assets', exact: true }).click();
  await expect(page).toHaveURL(/\/money(\?|#|$)/);
  // The same reading of the bank's valuation that Home showed, or a newer one if a price moved since.
  await expect
    .poll(async () => {
      const shown = await spokenTotal(page, '[data-testid="money-total"]');
      return shown === onHome || shown === usd(await bankSummary()) ? 'same' : `assets ${shown}, home ${onHome}`;
    })
    .toBe('same');
  for (const asset of ['USDT', 'BTC', 'EUR']) await expect(page.locator('main').getByText(asset, { exact: true }).first()).toBeVisible();
});

test(`${J} #5 Recent activity lists the three newest movements to the last digit, each opening its record; an empty account says so`, async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page, who);
  await page.goto('/');
  const list = page.locator('section[aria-labelledby="home-activity-title"]');
  await expect(list.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
  const rows = list.getByTestId('home-activity__row');
  await expect(rows).toHaveCount(3);
  // Newest first: the four TEST deposits went in as USDT 1000, BTC 0.01, EUR 25, then USDT 0.123456789012345678.
  await expect(rows.nth(0)).toContainText('+0.123456789012345678 USDT');
  await expect(rows.nth(1)).toContainText('+25 EUR');
  await expect(rows.nth(2)).toContainText('+0.01 BTC');
  // The stack's TEST funding posts on its own rail, which the list names as welcome funds.
  for (let i = 0; i < 3; i++) await expect(rows.nth(i).getByTestId('home-activity__kind')).toHaveText(/^(Deposit|Welcome funds)$/);
  await expect(list.getByRole('link', { name: 'See all' })).toHaveAttribute('href', '/money/activity');

  // A row opens that movement's own record.
  const href = await rows.nth(0).getAttribute('href');
  expect(href).toMatch(/^\/money\/activity\/.+/);
  await rows.nth(0).click();
  await expect(page).toHaveURL(href);
  // The record it opens is that movement's own (its record number is the row's id).
  await expect(page.locator('main')).toContainText(decodeURIComponent(href.slice('/money/activity/'.length)));
  await expect(page.locator('main')).toContainText('USDT');

  // A new, verified account with nothing in it has nothing to list, and says so instead of showing sample rows.
  const fresh = await browser.newContext({ baseURL: 'http://127.0.0.1:3210', viewport: { width: 1440, height: 900 } });
  const empty = await fresh.newPage();
  const nobody = await signUp(empty, 'hme');
  // Before verification the bank refuses the read: Home says what the card will hold once verified, not a bare
  // "couldn't load", and does not repeat the summary's own "Verify your identity first" (one ask per page).
  await empty.goto('/');
  const refused = empty.locator('section[aria-labelledby="home-activity-title"]');
  await expect(refused.locator('[data-slot="state-block"]')).toContainText('Your activity shows here once you’re verified');
  await expect(refused).not.toContainText('Couldn’t load your activity');
  await expect(refused).not.toContainText('Verify your identity first');
  await expect(empty.getByText('Verify your identity first')).toHaveCount(1);
  await verify(empty, nobody);
  await signIn(empty, nobody);
  await empty.goto('/');
  const none = empty.locator('section[aria-labelledby="home-activity-title"]');
  await expect(none).toContainText('No activity');
  await expect(none).toContainText('Deposits, trades and transfers show here.');
  await expect(none.getByTestId('home-activity__row')).toHaveCount(0);
  await fresh.close();
});

test(`${J}, part of #5: a failed activity read says so with Try again, and the rest of Home is unaffected`, async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, who);
  // The one outside thing in this run: the browser cannot reach the activity read (the service itself is untouched).
  let fail = true;
  await page.route('**/activity.list**', (route) => (fail ? route.abort('connectionrefused') : route.continue()));
  await page.goto('/');
  const list = page.locator('section[aria-labelledby="home-activity-title"]');
  await expect(list).toContainText('Couldn’t load your activity.');
  await expect.poll(() => spokenTotal(page, HOME_TOTAL)).toMatch(/^\$[\d,]+\.\d{2}$/);
  fail = false;
  await list.getByRole('button', { name: 'Try again' }).click();
  await expect(list.getByTestId('home-activity__row')).toHaveCount(3);
});

test(`${J} #4 Needs you: an unverified person gets one item to Verification that is gone after approval; with the margin warning level blank an open loan adds no item; with nothing to do it says nothing needs you`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const fresh = await signUp(page, 'hmw');
  const work = page.locator('section[aria-labelledby="home-work-title"]');
  const rows = work.getByTestId('home-work__row');
  // Every owner answered, so the list is the whole answer (not "nothing so far from the services that answered").
  const settled = async () => {
    await expect(work.locator('[data-slot="state-block"]')).toHaveCount(0);
    await expect(work.locator('[data-missing]')).toHaveCount(0);
  };

  // Unverified: identity's one item, linking to Verification, and nothing else.
  await page.goto('/');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-kind', 'verification');
  await expect(rows.first()).toHaveAttribute('href', '/verification');
  await expect(rows.first()).toContainText('Verify your identity');
  await settled();
  await expect(work).not.toContainText('Nothing needs you');
  // The row opens the Verification room.
  await rows.first().click();
  await expect(page).toHaveURL(/\/verification$/);

  // Approved by the stack's TEST operators: on the next load the item is gone, read from identity's record.
  await verify(page, fresh);
  await signIn(page, fresh);
  await page.goto('/');
  await expect(work.getByText('Nothing needs you right now.')).toBeVisible();
  await expect(rows).toHaveCount(0);
  await settled();

  // An open loan while the owner's margin warning level is blank: no margin item and no error, only loans in a call would
  // be listed (none is). The loan is the bank's TEST product from the stack's content seed.
  expect(fund(fresh.email, 'BTC', '0.01').tx).toBeTruthy();
  const client = await api(fresh);
  const products = await client.get(`/api/bank/trpc/loans.products?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(products.status, JSON.stringify(products.body).slice(0, 300)).toBe(200);
  const product = products.body.result.data.find((row) => row.collateralAssetId === 'BTC' && row.debtAssetId === 'USDT');
  expect(product, 'the TEST content seed publishes a BTC-backed USDT loan product').toBeTruthy();
  const opened = await client.post('/api/bank/trpc/loans.open', {
    // The loan's id is its business key, named by this step and person, so a retried step meets the same loan.
    loanId: businessUuid(`${J}-4-loan:${fresh.handle}`),
    productId: product.id,
    collateralAmount: '0.01',
    principal: '100',
  });
  expect(opened.status, JSON.stringify(opened.body).slice(0, 300)).toBe(200);
  expect(opened.body.result.data.status).toBe('active');
  await page.goto('/');
  await expect(work.getByText('Nothing needs you right now.')).toBeVisible();
  await expect(work.locator('[data-kind="margin_health"]')).toHaveCount(0);
  await settled();
  await context.close();
});

test(`${J}, part of #4: while Home's owner values cannot be read, Needs you says so with Try again, never "nothing needs you"`, async ({
  page,
}) => {
  await signIn(page, who);
  // The one outside thing in this run: the browser cannot reach svc-ops' home.config (the service itself is untouched).
  let fail = true;
  await page.route('**/home.config**', (route) => (fail ? route.abort('connectionrefused') : route.continue()));
  await page.goto('/');
  const work = page.locator('section[aria-labelledby="home-work-title"]');
  await expect(work.locator('[data-slot="state-block"]')).toBeVisible();
  await expect(work).not.toContainText('Nothing needs you');
  fail = false;
  await work.getByRole('button', { name: 'Try again' }).click();
  await expect(work.getByText('Nothing needs you right now.')).toBeVisible();
});

/** Each Get started step as the tile shows it: { step: status }, plus where each open step leads. */
async function startedSteps(page) {
  const rows = page.locator('section[aria-labelledby="home-started-title"] [data-step]');
  await expect(rows).toHaveCount(6);
  // A step still being read never counts: wait until every one has its answer.
  await expect(rows.and(page.locator('[data-status="checking"]'))).toHaveCount(0, { timeout: 20_000 });
  const steps = {};
  for (const row of await rows.all()) {
    steps[await row.getAttribute('data-step')] = { status: await row.getAttribute('data-status'), href: await row.getAttribute('href') };
  }
  return steps;
}
const statuses = (steps) => Object.fromEntries(Object.entries(steps).map(([id, step]) => [id, step.status]));

test(`${J} #6 Get started reads each step from the account's records, survives a cleared browser, and leaves when all six are done`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  // Passkeys belong to the stack's relying party, localhost, so this person uses the app there.
  const context = await browser.newContext({ baseURL: PASSKEY_ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const fresh = await signUp(page, 'hmg');
  await page.goto('/');
  const open = await startedSteps(page);
  expect(statuses(open)).toEqual({ register: 'done', verify: 'todo', secure: 'todo', deposit: 'todo', trade: 'todo', alert: 'todo' });
  expect(open.verify.href).toBe('/verification');
  expect(open.secure.href).toBe('/uc/safe');
  expect(open.deposit.href).toBe('/uc/recharge');
  expect(open.trade.href).toBe('/trade/buy');
  expect(open.alert.href).toBe('/notifications?view=alerts');
  await expect(page.getByTestId('home-started__count')).toHaveText('1 of 6 done');

  // Nothing is kept in the browser: with its storage cleared, the same steps come back from the account.
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  expect(statuses(await startedSteps(page))).toEqual(statuses(open));

  // Verified, then money in through the real ledger: both steps are done on the next load.
  await verify(page, fresh);
  await signIn(page, fresh);
  expect(fund(fresh.email, 'USDT', '100').tx).toBeTruthy();
  await page.goto('/');
  expect(statuses(await startedSteps(page))).toEqual({
    register: 'done',
    verify: 'done',
    secure: 'todo',
    deposit: 'done',
    trade: 'todo',
    alert: 'todo',
  });

  // A passkey from Security, a price alert, and a first trade on the real book.
  await virtualAuthenticator(page);
  await addPasskey(page);
  const client = await api(fresh);
  const alert = await client.post('/api/notify/trpc/notify.createAlert', {
    marketId: 'BTC-USDT',
    direction: 'above',
    targetPrice: '10000000',
  });
  expect(alert.status, JSON.stringify(alert.body).slice(0, 300)).toBe(200);
  const { ask } = await bestPrices();
  const buy = await client.post('/api/v1/orders', {
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    amount: '0.0001',
    price: ask,
    timeInForce: 'IOC',
    clientOrderId: `${J}-6-${fresh.handle}`,
  });
  expect(buy.status, JSON.stringify(buy.body).slice(0, 300)).toBeLessThan(300);
  await expect.poll(async () => (await openOrders(fresh)).length, { timeout: 20_000 }).toBe(0);
  await expect.poll(async () => toUnits((await client.balances()).BTC?.total ?? '0') > 0n, { timeout: 20_000 }).toBe(true);

  // Every step done: the tile has nothing left to say and is gone; the rest of Home is unchanged.
  await page.goto('/');
  await expect(totalOn(page, HOME_TOTAL).locator('[role=img]')).toBeVisible();
  await expect(page.locator('section[aria-labelledby="home-started-title"]')).toHaveCount(0);
  await context.close();
});
