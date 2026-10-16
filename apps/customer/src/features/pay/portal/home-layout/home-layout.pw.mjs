import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createPortalMock, USER_ID } from '../portal.mock.mjs';

async function setup(page, scenario = 'active') {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await page.route('**/api/identity/trpc/auth.login', (route) =>
    route.fulfill({
      json: {
        result: { data: { userId: USER_ID, accessToken: 'TEST-only', refreshToken: 'TEST-only', expiresAt: '2027-10-08T00:00:00Z' } },
      },
    }),
  );
  const mock = createPortalMock(scenario);
  await mock.install(page);
  await page.goto('/login?redirect=%2Fpay%2Fmerchant');
  await page.getByLabel('Email or handle', { exact: true }).fill('TEST@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('TEST-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/pay/merchant');
  return mock;
}
async function go(page, path) {
  await page.evaluate((path) => {
    history.pushState(null, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}
const fits = (page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test('Home-style default, accordion keyboard control, chart table and reviewed payout route', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.plo-number')).toHaveCount(1);
  await expect(page.locator('.plo-heading')).toHaveCount(0);
  await expect(page.locator('.pay-business-nav')).toHaveCount(0);
  const trigger = page.getByRole('button', { name: 'Payment volume', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'View data table', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Payment volume USDT', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Pay out', exact: true }).click();
  await expect(page).toHaveURL(/\/pay\/payouts\?view=tools$/);
  await expect(page.locator('.plo-tabs a')).toHaveCount(5);
  await expect(page.locator('.pay-business-nav')).toHaveCount(0);
});

test('phone navigation scrolls both tab rows, opens nested pages and retains URL filters', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const tabs = page.getByRole('navigation', { name: 'Merchant portal', exact: true });
  const settings = tabs.getByRole('link', { name: 'Settings / Developers', exact: true });
  await settings.scrollIntoViewIfNeeded();
  await settings.click();
  await expect(page).toHaveURL(/\/pay\/settings$/);
  const secondary = page.locator('.plo-subtabs');
  const exports = secondary.getByRole('link', { name: 'Exports', exact: true });
  await exports.scrollIntoViewIfNeeded();
  await exports.click();
  await expect(page).toHaveURL(/\/pay\/exports$/);
  await go(page, '/pay/payments');
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('failed');
  await expect(page).toHaveURL(/status=failed/);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('payments.csv');
  await fits(page);
});

test('payment description/customer survives parsing; exact decimal requires an explicit detail action', async ({ page }) => {
  await setup(page);
  const paymentId = 'aa000001-0000-4000-8000-000000000001';
  const row = {
    id: paymentId,
    merchantId: '11111111-1111-4111-8111-111111111111',
    profileId: null,
    amount: '47.123456789123456789',
    assetId: 'USDT',
    method: 'TEST',
    railAdapter: 'TEST',
    railRef: null,
    status: 'settled',
    capturedAmount: '47.123456789123456789',
    refundedAmount: '0',
    createdAt: '2026-10-16T00:00:00Z',
    customerRef: 'TEST customer workshop',
    description: 'TEST order',
  };
  await page.route('**/api/pay/trpc/payment.list?*', (route) => route.fulfill({ json: { result: { data: [row] } } }));
  await page.route('**/api/pay/trpc/payment.get?*', (route) => route.fulfill({ json: { result: { data: row } } }));
  await go(page, '/pay/payments');
  await expect(page.getByRole('link', { name: `Open payment ${paymentId}`, exact: true })).toHaveText('TEST customer workshop');
  await page.getByRole('link', { name: `Open payment ${paymentId}`, exact: true }).click();
  const exact = page.getByRole('button', { name: 'Show exact', exact: true }).first();
  await expect(exact).toBeVisible();
  await expect(page.getByText('47.123456789123456789', { exact: true })).toHaveCount(0);
  await exact.click();
  await expect(page.getByText('47.123456789123456789', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide exact', exact: true }).click();
  await expect(page.getByText('47.123456789123456789', { exact: true })).toHaveCount(0);
});

test('quiet and offline dashboard states keep useful actions without invented balances', async ({ page }) => {
  await setup(page, 'quiet');
  await expect(page.getByText('Your first payment starts here')).toBeVisible();
  await expect(page.getByText('No balance to show yet')).toBeVisible();
  await page.route('**/api/pay/trpc/merchantMetrics.snapshot?*', (route) =>
    route.fulfill({ status: 503, json: { error: { message: 'offline' } } }),
  );
  await go(page, '/pay/payments');
  await expect(page.getByRole('button', { name: 'Try again', exact: true }).first()).toBeVisible();
});
for (const width of [1440, 390])
  test(`portal accessibility and page width at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    for (const path of ['/pay/merchant', '/pay/payments', '/pay/settings', '/pay/network', '/pay/permissions', '/pay/payouts?view=tools']) {
      await go(page, path);
      await expect(page.locator('.plo')).toBeVisible();
      await expect(page.locator('.plo-tabs a')).toHaveCount(5);
      await fits(page);
      const result = await new AxeBuilder({ page }).include('.plo').analyze();
      expect(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
    }
  });

test('payout controls share a baseline and the phone ribbon contains its text', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setup(page);
  await go(page, '/pay/payouts');
  const filters = page.locator('.pp-payout-filters');
  const controls = filters.locator('[data-slot="select-trigger"], input[type="search"], [data-slot="button"]');
  await expect(controls).toHaveCount(4);
  const bottoms = await controls.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom));
  expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(1);
  const search = filters.getByRole('searchbox');
  const hintId = await search.getAttribute('aria-describedby');
  await expect(page.locator(`[id="${hintId}"]`)).toBeVisible();
  await expect(filters.locator('small')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'State', exact: true }).click();
  await page.getByRole('option', { name: 'Paid out', exact: true }).click();
  await expect(page).toHaveURL(/state=paid_out/);
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, '/pay/merchant');
  const contained = await page.locator('.dev-ribbon').evaluate((el) => {
    const box = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const text = range.getBoundingClientRect();
    return text.left > box.left && text.right < box.right && text.top > box.top && text.bottom < box.bottom;
  });
  expect(contained).toBe(true);
  await fits(page);
});
