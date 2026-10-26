import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createPortalMock, USER_ID } from './portal.mock.mjs';
const shots = process.env.PORTAL_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
async function setup(page, scenario = 'active', options = {}) {
  page.on('pageerror', (error) => console.error('BROWSER ERROR', error.message));
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/identity/trpc/auth.login', (route) =>
    reply(route, { userId: USER_ID, accessToken: 'TEST-only', refreshToken: 'TEST-only', expiresAt: '2027-10-08T00:00:00Z' }),
  );
  await page.route('**/api/identity/trpc/webauthn.list?*', (route) => reply(route, []));
  const mock = createPortalMock(scenario, options);
  await mock.install(page);
  return mock;
}
async function signIn(page, path) {
  await page.goto(`/login?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel('Email or handle', { exact: true }).fill('TEST@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('TEST-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
}
async function go(page, path) {
  await page.evaluate((path) => {
    history.pushState(null, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}
async function snap(page, name) {
  if (!shots) return;
  await page.evaluate(() => {
    document.getElementById('fixture-label')?.remove();
    const badge = document.createElement('p');
    badge.id = 'fixture-label';
    badge.textContent = 'TEST DATA · local screenshot fixture';
    badge.style.cssText = 'margin:0;background:#c8f64a;color:#111;padding:6px 24px;font:12px system-ui';
    document.body.prepend(badge);
  });
  // Start at the top so sticky shell elements are not captured halfway down a long form.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: `${shots}/${name}-viewport.png`, fullPage: false });
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
}
async function phone(page, name) {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await snap(page, `${name}-phone`);
}
async function axe(page) {
  expect(
    (await new AxeBuilder({ page }).include('[data-testid="pp"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
  ).toEqual([]);
}

test('onboarding: direct step routes, unpublished pricing, and unsaved draft protection', async ({ page }) => {
  await setup(page, 'new');
  await signIn(page, '/pay/onboarding/business');
  await expect(page.getByLabel('Legal business name *')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create my account' })).toBeDisabled();
  await page.getByLabel('Legal business name *').fill('TEST Workshop');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('listitem').filter({ hasText: 'Step 2 of 3' }).getByRole('link').click();
  await expect(page).toHaveURL(/onboarding\/business$/);
  await snap(page, 'P02-business');
  await axe(page);
  await phone(page, 'P02-business');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('listitem').filter({ hasText: 'Step 2 of 3' }).getByRole('link').click();
  await expect(page.getByText('Do step 1 first')).toBeVisible();
});

test('onboarding: verification history and activation gaps have no fabricated clearance', async ({ page }) => {
  await setup(page, 'quiet');
  await signIn(page, '/pay/onboarding/verification');
  await expect(page.getByLabel('Verification file reference *')).toBeVisible();
  await expect(page.getByText(/a missing document never counts as passed/)).toBeVisible();
  await snap(page, 'P03-verification');
  await axe(page);
  await phone(page, 'P03-verification');
  await go(page, '/pay/onboarding/go-live');
  await expect(page.getByText(/Live payments open once your business is verified/)).toBeVisible();
  await snap(page, 'P04-go-live-phone');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await snap(page, 'P04-go-live');
  await axe(page);
});

const REFUNDED_PAYMENT = 'aa000003-0000-4000-8000-000000000003';
test('refunds: the account list, URL filters, CSV and detail timeline', async ({ page }) => {
  const mock = await setup(page);
  await signIn(page, '/pay/refunds');
  await expect(page.getByRole('heading', { name: 'Refunds', level: 1 })).toBeVisible();
  const list = page.getByRole('region', { name: 'Refunds', exact: true });
  await expect(list.getByRole('table')).toBeVisible();
  await snap(page, 'P08-refunds');
  await axe(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download this page' }).click();
  expect((await download).suggestedFilename()).toMatch(/refunds.*\.csv$/);
  await page.getByLabel('Status').selectOption({ label: 'Reversed' });
  await expect(page).toHaveURL(/status=/);
  await expect(list.getByRole('row')).toHaveCount(2);
  await page.getByLabel('Status').selectOption('');
  await phone(page, 'P08-refunds');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await list.getByRole('link', { name: 'Open' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Refund');
  await snap(page, 'P10-refund-detail-phone');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await snap(page, 'P10-refund-detail');
  await axe(page);
  expect(mock.calls.filter((call) => call.procedure === 'payment.refund')).toEqual([]);
});

test('refund creation: a payment with nothing left to refund refuses closed without a mutation', async ({ page }) => {
  const mock = await setup(page);
  await signIn(page, `/pay/refunds/new?payment=${REFUNDED_PAYMENT}`);
  await expect(page.getByText('No captured amount is available to refund.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Confirm/ })).toHaveCount(0);
  await snap(page, 'P09-new-refund');
  await axe(page);
  await phone(page, 'P09-new-refund');
  expect(mock.calls.filter((call) => call.procedure === 'payment.refund')).toEqual([]);
});

test('refunds: a payment id that is not found reveals nothing about whether it exists', async ({ page }) => {
  const mock = await setup(page);
  await page.route('**/api/pay/trpc/payment.get?*', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'pay.payment_not_found', data: { cause: { code: 'pay.payment_not_found' } } } }),
    }),
  );
  await signIn(page, `/pay/refunds/new?payment=${REFUNDED_PAYMENT}`);
  await expect(page.getByRole('heading', { name: 'Issue a refund', level: 1 })).toBeVisible();
  await expect(page.getByText('pay.payment_not_found')).toHaveCount(0);
  expect(mock.calls.filter((call) => call.procedure === 'payment.refund')).toEqual([]);
});

const LINK_ID = 'dd000001-0000-4000-8000-000000000001';
function testLinks() {
  const now = Date.now();
  return [
    {
      id: LINK_ID,
      prefix: 'TEST-ln-1',
      label: 'TEST workshop',
      amount: '123.000000000000000001',
      currency: 'USDT',
      active: true,
      expiresAt: new Date(now + 86400_000).toISOString(),
      maxUses: 10,
      uses: 2,
      createdAt: new Date(now - 86400_000).toISOString(),
    },
    {
      id: 'dd000002-0000-4000-8000-000000000002',
      prefix: 'TEST-ln-2',
      label: 'TEST expired',
      amount: null,
      currency: null,
      active: true,
      expiresAt: new Date(now - 86400_000).toISOString(),
      maxUses: null,
      uses: 0,
      createdAt: new Date(now - 2 * 86400_000).toISOString(),
    },
  ];
}
test('payment links: scoped records, URL search and availability, export and detail', async ({ page }) => {
  await setup(page);
  await page.route('**/api/pay/trpc/merchant.listLinks?*', (route) => reply(route, { items: testLinks(), nextCursor: null }));
  await signIn(page, '/pay/links');
  await expect(page.getByRole('link', { name: /TEST workshop/ })).toBeVisible();
  await expect(page.getByText('2 shown from 2 links.')).toBeVisible();
  await snap(page, 'P13-payment-links');
  await axe(page);
  await phone(page, 'P13-payment-links');
  await page.getByLabel('Search links').fill('workshop');
  await expect(page).toHaveURL(/q=workshop/);
  await expect(page.getByText('1 shown from 2 links.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Availability', exact: true }).selectOption('expired');
  await expect(page.getByText('No links match these filters', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Availability', exact: true }).selectOption('');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download shown links (CSV)' }).click();
  expect((await download).suggestedFilename()).toBe('payment-links.csv');
  await page.getByRole('link', { name: /TEST workshop/ }).click();
  await expect(page.getByRole('heading', { name: 'Payment link', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deactivate link' })).toBeEnabled();
  await snap(page, 'P15-link-detail-phone');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await snap(page, 'P15-link-detail');
  await axe(page);
});

test('payment-link creation: validates fields and asks for a review before anything is created', async ({ page }) => {
  const mock = await setup(page);
  await signIn(page, '/pay/links/new');
  await expect(page.getByLabel('Link label *')).toBeVisible();
  await page.getByLabel('Link label *').fill('TEST workshop');
  await page.getByLabel('Fixed amount', { exact: true }).fill('12.000000000000000001');
  await expect(page.getByText('Choose an asset when setting a fixed amount.')).toBeVisible();
  await page.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await page.getByLabel('Maximum completed payments', { exact: true }).fill('1.5');
  await expect(page.getByText('Check this field before reviewing the link.')).toBeVisible();
  await page.getByLabel('Maximum completed payments', { exact: true }).fill('10');
  await expect(page.getByRole('button', { name: 'Create link' })).toBeEnabled();
  await snap(page, 'P14-new-payment-link');
  await axe(page);
  await phone(page, 'P14-new-payment-link');
  expect(mock.calls.filter((call) => call.procedure === 'merchant.createLink')).toEqual([]);
});

test('merchant money: snapshot balances, separate assets and honest statement gap', async ({ page }) => {
  const mock = await setup(page);
  await signIn(page, '/pay/money');
  await expect(page.getByRole('heading', { name: 'Balances', level: 1 })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Balances at a glance' })).toBeVisible();
  await expect(page.getByText(/Reserve: 5\.00% held back/).first()).toBeVisible();
  await snap(page, 'P24-money');
  await axe(page);
  await phone(page, 'P24-money');
  await page.getByRole('link', { name: 'Open the statement', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await snap(page, 'P25-balance-activity-phone');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await snap(page, 'P25-balance-activity');
  await axe(page);
  expect(mock.calls.some((call) => call.procedure === 'merchantMetrics.snapshot')).toBe(true);
});

test('reports: the catalog opens the request form on the selected kind', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/reports');
  await expect(page.getByRole('heading', { name: 'Available reports' })).toBeVisible();
  await snap(page, 'P52-reports');
  await axe(page);
  await phone(page, 'P52-reports');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole('row', { name: /Settlements/ })
    .getByRole('link', { name: 'Open' })
    .click();
  await expect(page.getByRole('heading', { name: 'Report files', level: 1 })).toBeVisible();
  await expect(page.locator('#request select').first()).toHaveValue('settlements');
  await snap(page, 'P53-export-jobs-phone');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await snap(page, 'P53-export-jobs');
  await axe(page);
});

test('stored light preference: app policy stays dark, all W3c routes remain accessible, and the search keyboard shortcut works', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ theme: 'light' })));
  await setup(page);
  await page.route('**/api/pay/trpc/merchant.listLinks?*', (route) => reply(route, { items: testLinks(), nextCursor: null }));
  await signIn(page, '/pay/money');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  for (const [id, path, title] of [
    ['P02', '/pay/onboarding/business', 'Business details'],
    ['P03', '/pay/onboarding/verification', 'Verification'],
    ['P04', '/pay/onboarding/go-live', 'Payout destination'],
    ['P08', '/pay/refunds', 'Refunds'],
    ['P09', `/pay/refunds/new?payment=${REFUNDED_PAYMENT}`, 'Issue a refund'],
    ['P10', '/pay/refunds/cc100001-0000-4000-8000-000000000101', 'Refund'],
    ['P13', '/pay/links', 'Payment links'],
    ['P14', '/pay/links/new', 'Create a payment link'],
    ['P15', `/pay/links/${LINK_ID}`, 'Payment link'],
    ['P24', '/pay/money', 'Balances'],
    ['P25', '/pay/money/activity', 'Statement'],
    ['P52', '/pay/reports', 'Reports'],
    ['P53', '/pay/reports/exports', 'Report files'],
  ]) {
    await go(page, path);
    await expect(page.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible();
    await expect(page.locator('.pp .pp-skeleton')).toHaveCount(0);
    await axe(page);
    await snap(page, `${id}-stored-light-policy-dark`);
  }
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('searchbox', { name: 'Search the business pages' })).toBeFocused();
});

test('unsaved business details survive a cancelled browser Back traversal', async ({ page }) => {
  await setup(page, 'new');
  await signIn(page, '/pay/merchant');
  await go(page, '/pay/onboarding/business');
  await page.getByLabel('Legal business name *').fill('TEST retained draft');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/onboarding\/business$/);
  await expect(page.getByLabel('Legal business name *')).toHaveValue('TEST retained draft');
  page.once('dialog', (dialog) => dialog.accept());
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/pay\/merchant$/);
});
