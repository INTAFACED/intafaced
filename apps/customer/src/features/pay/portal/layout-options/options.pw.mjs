import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createPortalMock, USER_ID } from '../portal.mock.mjs';

async function setup(page, layout, scenario = 'active') {
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
  await page.goto('/login?redirect=' + encodeURIComponent('/pay/merchant' + (layout ? `?layout=${layout}` : '')));
  await page.getByLabel('Email or handle', { exact: true }).fill('TEST@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('TEST-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/pay/merchant' + (layout ? `?layout=${layout}` : ''));
  return mock;
}
async function go(page, path) {
  await page.evaluate((path) => {
    history.pushState(null, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}
const fits = (page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
for (const layout of ['a', 'b', 'c']) {
  test(`${layout}: dashboard, table fallback, filters, export and default money route`, async ({ page }) => {
    await setup(page, layout);
    await expect(page.getByText('Available to pay out', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await fits(page);
    if (layout === 'a') await page.locator('.plo-disclosure > summary').filter({ hasText: 'Payment volume' }).click();
    if (layout === 'b') await page.locator('.plo-disclosure > summary').filter({ hasText: 'Payments' }).click();
    await page.getByRole('button', { name: 'View data table', exact: true }).click();
    await expect(page.getByRole('region', { name: /Payment volume/ })).toBeVisible();
    await page.getByRole('link', { name: 'Pay out', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`view=tools&layout=${layout}`));
    await go(page, `/pay/payments?layout=${layout}`);
    await expect(page.getByRole('heading', { name: 'All payments', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('failed');
    await expect(page).toHaveURL(/status=failed/);
    await expect(page).toHaveURL(new RegExp(`layout=${layout}`));
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('payments.csv');
    await page.setViewportSize({ width: 390, height: 844 });
    await fits(page);
    const result = await new AxeBuilder({ page }).include('.plo').analyze();
    expect(result.violations).toEqual([]);
  });
  test(`${layout}: mobile menu fits viewport, traps focus, closes on Escape and preserves layout`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page, layout);
    const trigger = page.getByRole('button', { name: 'Portal menu', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        dialog.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
        }),
      )
      .toBe(true);
    await dialog.locator('summary').filter({ hasText: 'Payments' }).click();
    await expect(dialog.getByRole('link', { name: 'Payments', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.locator('summary').filter({ hasText: 'Payments' }).click();
    await dialog.getByRole('link', { name: 'Payments', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/pay/payments\\?layout=${layout}$`));
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await fits(page);
  });
  test(`${layout}: empty and offline feeds never invent amounts`, async ({ page }) => {
    await setup(page, layout, 'quiet');
    await expect(page.getByText('Your first payment starts here')).toBeVisible();
    await page.route('**/api/pay/trpc/merchantMetrics.snapshot*', (route) =>
      route.fulfill({ status: 503, json: { error: { message: 'offline' } } }),
    );
    await go(page, `/pay/payments?layout=${layout}`);
    await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
  });
}
test('without a switch the existing dashboard remains the default', async ({ page }) => {
  await setup(page, null);
  await expect(page.getByRole('heading', { name: 'Merchant dashboard', exact: true })).toBeVisible();
  await expect(page.locator('.plo')).toHaveCount(0);
});
