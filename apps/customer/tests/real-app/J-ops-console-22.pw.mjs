import { expect, test } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { forgetSession } from './identity-factors.mjs';
import { businessReadyPerson, openBusiness, paidCardPayment, payApiOf, signInWithCode, verifiedBusiness } from './merchant.mjs';

// J-ops-console-22: oversee merchants. A fresh TEST business opens on the merchant portal, the stack's founder pair approves
// its verification, and it takes one TEST card payment of 40.00 USDT on the sandbox card rail. Founder A then reads the
// same merchant on the console. #1 and #2 read svc-pay's founder reads and the owner's own portal; #3 is the founder-wide
// verification queue (/kyb), which svc-pay does not serve yet; #5 is the jurisdiction setting history. #4 and #6 are
// deferred to launch prep (owner decision 2026-10-27) and have no test.

const J = 'J-ops-console-22';
const AMOUNT = '40.00';

test.use({ timezoneId: 'UTC' });

/** A merchant room part that failed or is not connected (the console's StateBlock kinds other than empty and loading). */
const failedPart = (page) => page.locator('[data-kind="error"], [data-kind="forbidden"], [data-kind="not_built"]');

/** The figure in a money element's text, without its unit. */
const figure = (text) => /([0-9][0-9,]*\.[0-9]+)/.exec(text)?.[1] ?? null;

test.describe('one TEST merchant', () => {
  let world = null;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(420_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    const owner = await businessReadyPerson(page, 'oc22');
    const merchantId = await openBusiness(page, owner, 'TEST Oversight Ltd');
    await verifiedBusiness(page, owner, merchantId);
    // The owner signs in again after the approval, for the new grant, as every merchant journey does.
    await forgetSession(page);
    await signInWithCode(page, owner, '/pay/merchant');
    const api = await payApiOf(owner, (step) => {
      owner.step = step;
    });
    const paid = await paidCardPayment(api, merchantId, { key: `${J}:payment:${merchantId}`, amount: AMOUNT });
    expect(paid.status, `the TEST card payment was not captured: ${JSON.stringify(paid).slice(0, 300)}`).toBe('captured');
    world = { owner, merchantId, portal: page, context };
  });

  test.afterAll(async () => {
    await world?.context.close();
  });

  /** On a page founder A is signed in on: the merchant page and its USDT balance row as the console shows it. */
  async function founderMerchant(page) {
    await page.goto(`${ADMIN}/merchants/${world.merchantId}`, { waitUntil: 'load' });
    await expect(page.getByRole('heading', { name: 'TEST Oversight Ltd' })).toBeVisible();
    const balances = page.getByRole('table', { name: 'Merchant balances per asset' });
    const usdt = balances.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'USDT', exact: true }) });
    await expect(usdt).toHaveCount(1);
    const [clearing, available] = await usdt.getByRole('cell').allInnerTexts();
    return { clearing: clearing.trim(), available: available.trim() };
  }

  test(`${J} #1 a merchant page whose read exists shows the read and no gap notice; a page without one keeps its honest notice`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await founderSignIn(page, 'a');
    await page.goto(`${ADMIN}/merchants`, { waitUntil: 'load' });
    await expect(page.getByRole('heading', { name: 'Merchants dashboard' })).toBeVisible();
    await expect(page.getByText(/Numbers on this page as of /)).toBeVisible();
    await expect(failedPart(page)).toHaveCount(0);

    const { clearing, available } = await founderMerchant(page);
    await expect(page.getByText(world.merchantId, { exact: true })).toBeVisible();
    // svc-pay's reads for this merchant: the captured payment is clearing and nothing is available yet, and no part of the
    // page failed or says it is not connected.
    expect(clearing).toBe(AMOUNT);
    expect(available).toBe('0.00');
    await expect(page.getByRole('group', { name: 'Key figures' })).toBeVisible();
    await expect(failedPart(page)).toHaveCount(0);

    // Creating a merchant for someone else has no read or write in svc-pay: the page says so instead of a form.
    await page.goto(`${ADMIN}/merchants/new`, { waitUntil: 'load' });
    await expect(page.getByText('The pay service does not create merchants for someone else')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: world.merchantId.slice(0, 8) })).toHaveCount(1);
  });

  test(`${J} #2 the founder view and the merchant portal show the same figures for the same merchant`, async ({ page }) => {
    test.setTimeout(180_000);
    await founderSignIn(page, 'a');
    const founder = await founderMerchant(page);

    const portal = world.portal;
    await portal.goto('/pay/merchant');
    // Available to pay out is the founder's available; pending settlement is the founder's clearing.
    const available = portal.getByRole('region', { name: 'Available to pay out' }).getByTestId('plo-balance-amount');
    await expect(available).toBeVisible();
    expect(figure(await available.innerText())).toBe(founder.available);
    const pending = portal.locator('section').filter({ has: portal.getByRole('heading', { name: 'Pending settlement', level: 2 }) });
    await expect(pending).toContainText('USDT');
    expect(figure(await pending.innerText())).toBe(founder.clearing);
  });

  test(`${J} #3 the business verification queue lists submitted businesses and opens their screens`, async ({ page }) => {
    await founderSignIn(page, 'a');
    await page.goto(`${ADMIN}/kyb`, { waitUntil: 'load' });
    await expect(
      page.getByText('svc-pay has no founder-wide KYB list'),
      'the founder-wide verification queue is not connected: svc-pay has no founder-wide KYB list',
    ).toHaveCount(0, { timeout: 5_000 });
    // This business sent its verification and was decided: the queue lists it, and its row opens its verification screen.
    const row = page.getByRole('row').filter({ hasText: world.merchantId.slice(0, 8) });
    await expect(row).toHaveCount(1, { timeout: 5_000 });
    await row.getByRole('link').first().click();
    await expect(page).toHaveURL(new RegExp(world.merchantId));
    await expect(failedPart(page)).toHaveCount(0);
  });
});

test(`${J} #5 the jurisdiction setting history lists every change with actor, reason, before and after`, async ({ page }) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/jurisdiction`, { waitUntil: 'load' });
  const history = page.getByRole('table', { name: /setting history/i });
  await expect(history, 'the jurisdiction board has no setting history read yet').toBeVisible({ timeout: 5_000 });
  for (const column of ['Actor', 'Reason', 'Before', 'After'])
    await expect(history.getByRole('columnheader', { name: column })).toBeVisible();
  await expect(history.getByRole('row')).not.toHaveCount(1);
});
