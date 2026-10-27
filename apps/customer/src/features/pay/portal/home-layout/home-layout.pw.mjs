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
  await expect(page.getByTestId('plo-balance-amount')).toHaveCount(1);
  await expect(page.getByTestId('plo-heading')).toHaveCount(0);
  await expect(page.locator('.pay-business-nav')).toHaveCount(0);
  const trigger = page.getByRole('button', { name: 'Payment volume', exact: true });
  // the daily chart is open when the page opens, so the wide screen has no empty area under the figures
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  // two assets are paid in, so the chart offers both; this check follows USDT
  await page.getByTestId('plo-volume').getByRole('group', { name: 'Asset' }).getByRole('button', { name: 'USDT', exact: true }).click();
  await page.getByRole('button', { name: 'View data table', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Payment volume USDT', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Pay out', exact: true }).click();
  await expect(page).toHaveURL(/\/pay\/payouts\?view=tools$/);
  await expect(page.getByTestId('plo-tabs').locator('a')).toHaveCount(5);
  await expect(page.locator('.pay-business-nav')).toHaveCount(0);
});

test('phone navigation keeps both menu rows reachable and retains URL filters', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.getByRole('button', { name: 'Open business menu', exact: true }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Notifications', exact: true }).click();
  await expect(page).toHaveURL(/\/pay\/settings\/notifications$/);
  const secondary = page.getByRole('navigation', { name: 'Settings', exact: true });
  const team = secondary.getByRole('link', { name: 'Team & roles', exact: true });
  await team.scrollIntoViewIfNeeded();
  await team.click();
  await expect(page).toHaveURL(/\/pay\/team$/);
  await go(page, '/pay/payments');
  await page.getByLabel('Status').selectOption({ label: 'Failed' });
  await expect(page).toHaveURL(/status=/);
  await fits(page);
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
    for (const path of ['/pay/merchant', '/pay/payments', '/pay/settings', '/pay/payouts', '/pay/money']) {
      await go(page, path);
      await expect(page.getByTestId('pp')).toBeVisible();
      if (width > 600)
        await expect(page.getByRole('navigation', { name: 'Business navigation', exact: true }).getByRole('link')).toHaveCount(5);
      else await expect(page.getByRole('button', { name: 'Open business menu', exact: true })).toBeVisible();
      await fits(page);
      const result = await new AxeBuilder({ page }).include('[data-testid="pp"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(result.violations.map((v) => ({ id: v.id, path, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
    }
  });

// The shared filter bar draws the search box and the status/date/asset selects at the same height, so they share a baseline.
test('payout filter controls share a baseline', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setup(page);
  await go(page, '/pay/payouts');
  const filters = page.getByRole('search').first();
  await expect(filters).toBeVisible();
  const controls = filters.locator('select, input');
  expect(await controls.count()).toBeGreaterThanOrEqual(3);
  const boxes = await controls.evaluateAll((els) =>
    els.map(
      (el) =>
        `${el.tagName}:${el.getAttribute('aria-label') ?? el.id}:${Math.round(el.getBoundingClientRect().top)}-${Math.round(el.getBoundingClientRect().bottom)}`,
    ),
  );
  const bottoms = await controls.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom));
  expect(Math.max(...bottoms) - Math.min(...bottoms), boxes.join(' | ')).toBeLessThanOrEqual(1);
  await fits(page);
});
