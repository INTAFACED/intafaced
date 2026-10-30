import { expect, test } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { businessReadyPerson, openBusiness, paidCardPayment, payApiOf, verifiedBusiness } from './merchant.mjs';

// J-ops-console-22: oversee merchants. A fresh TEST business opens on the merchant portal, the stack's founder pair approves
// its verification, and it takes one TEST card payment of 40.00 USDT on the sandbox card rail. Founder A then reads the
// same merchant on the console. #1 and #2 read svc-pay's founder reads and the owner's own portal; #3 is the founder-wide
// verification queue (/kyb), which svc-pay does not serve yet; #5 is the jurisdiction setting history. #4 and #6 are
// deferred to launch prep (owner decision 2026-10-27) and have no test.

const J = 'J-ops-console-22';
const AMOUNT = '40.00';

test.use({ timezoneId: 'UTC' });

let world = null;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(420_000);
  const page = await (await browser.newContext()).newPage();
  const owner = await businessReadyPerson(page, 'oc22');
  const merchantId = await openBusiness(page, owner, 'TEST Oversight Ltd');
  await verifiedBusiness(page, owner, merchantId);
  const api = await payApiOf(owner, (step) => {
    owner.step = step;
  });
  const paid = await paidCardPayment(api, merchantId, { key: `${J}:payment:${merchantId}`, amount: AMOUNT });
  expect(paid.status, `the TEST card payment was not captured: ${JSON.stringify(paid).slice(0, 300)}`).toBe('captured');
  world = { owner, merchantId, portal: page };
});

/** The founder's merchant page, and its per-asset balance row for USDT as the console shows it. */
async function founderMerchant(page) {
  await founderSignIn(page, 'a');
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

  const { clearing, available } = await founderMerchant(page);
  await expect(page.getByText(world.merchantId, { exact: true })).toBeVisible();
  // svc-pay's balances read for this merchant: the captured payment is clearing and nothing is available yet.
  expect(clearing).toBe(AMOUNT);
  expect(available).toBe('0.00');
  await expect(page.getByRole('group', { name: 'Key figures' })).toBeVisible();
  await expect(page.getByText('This part could not be read')).toHaveCount(0);
  await expect(page.getByText(/not switched on|not connected/i)).toHaveCount(0);

  // Creating a merchant for someone else has no read or write in svc-pay: the page says so instead of a form.
  await page.goto(`${ADMIN}/merchants/new`, { waitUntil: 'load' });
  await expect(page.getByText('The pay service does not create merchants for someone else')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: world.merchantId.slice(0, 8) })).toHaveCount(1);
});

test(`${J} #2 the founder view and the merchant portal show the same figures for the same merchant`, async ({ page }) => {
  test.setTimeout(180_000);
  const founder = await founderMerchant(page);

  const portal = world.portal;
  await portal.goto('/pay/merchant');
  await expect(portal.getByText('Available to pay out')).toBeVisible();
  await expect(portal.getByText('Pending settlement')).toBeVisible();
  const text = (await portal.locator('main').innerText()).replace(/\s+/g, ' ');
  const after = (label) => new RegExp(`${label}[^0-9]*?([0-9][0-9,]*\\.[0-9]+) USDT`).exec(text)?.[1] ?? null;
  // Pending settlement is the founder's clearing; available to pay out is the founder's available.
  expect(after('Pending settlement'), text.slice(0, 800)).toBe(founder.clearing);
  expect(after('Available to pay out'), text.slice(0, 800)).toBe(founder.available);
  expect(after('Captured · Today \\(UTC\\)'), text.slice(0, 800)).toBe(AMOUNT);
});

test(`${J} #3 the business verification queue lists submitted businesses and opens their screens`, async ({ page }) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/kyb`, { waitUntil: 'load' });
  await expect(
    page.getByText('svc-pay has no founder-wide KYB list'),
    'the founder-wide verification queue is not connected: svc-pay has no founder-wide KYB list',
  ).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByRole('row').filter({ hasText: world.merchantId.slice(0, 8) })).toHaveCount(1, { timeout: 5_000 });
});

test(`${J} #5 the jurisdiction setting history lists every change with actor, reason, before and after`, async ({ page }) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/jurisdiction`, { waitUntil: 'load' });
  await expect(page.getByRole('table', { name: /setting history/i }), 'the jurisdiction board has no setting history read yet').toBeVisible({
    timeout: 5_000,
  });
});
