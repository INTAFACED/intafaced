import { test, expect } from '@playwright/test';
import { api, fund } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

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

const HOME_TOTAL = '.hp-total__figure, .home-total';

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
  await expect(page.locator('.hp-markets [role=row]').nth(1)).toContainText(/\d/);
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
  await page.locator('.hp-label, .home-label').getByRole('link', { name: 'Assets', exact: true }).click();
  await expect(page).toHaveURL(/\/money(\?|#|$)/);
  // The same reading of the bank's valuation that Home showed, or a newer one if a price moved since.
  await expect
    .poll(async () => {
      const shown = await spokenTotal(page, '.money-total');
      return shown === onHome || shown === usd(await bankSummary()) ? 'same' : `assets ${shown}, home ${onHome}`;
    })
    .toBe('same');
  for (const asset of ['USDT', 'BTC', 'EUR']) await expect(page.locator('main').getByText(asset, { exact: true }).first()).toBeVisible();
});
