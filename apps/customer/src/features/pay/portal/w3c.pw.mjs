import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createPortalMock, USER_ID } from './portal.mock.mjs';
const shots = process.env.PORTAL_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
async function setup(page, scenario = 'active') {
  page.on('pageerror', (error) => console.error('BROWSER ERROR', error.message));
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/identity/trpc/auth.login', (route) =>
    reply(route, { userId: USER_ID, accessToken: 'TEST-only', refreshToken: 'TEST-only', expiresAt: '2027-10-08T00:00:00Z' }),
  );
  await page.route('**/api/identity/trpc/webauthn.list?*', (route) => reply(route, []));
  const mock = createPortalMock(scenario);
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
    badge.style.cssText = 'position:fixed;bottom:0;right:0;z-index:9999;background:#c8f64a;color:#111;padding:6px;font:12px system-ui';
    document.body.append(badge);
  });
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
}
async function phone(page, name) {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await snap(page, `${name}-phone`);
}
async function axe(page) {
  expect((await new AxeBuilder({ page }).include('.pp').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
}

test('onboarding: direct step routes, unpublished pricing, and unsaved draft protection', async ({ page }) => {
  await setup(page, 'new');
  await signIn(page, '/pay/onboarding/business');
  await expect(page.getByLabel('Legal business name *')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create my account' })).toBeDisabled();
  await page.getByLabel('Legal business name *').fill('TEST Workshop');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('link', { name: /Step 2 of 3/ }).click();
  await expect(page).toHaveURL(/onboarding\/business$/);
  await snap(page, 'P02-business');
  await axe(page);
  await phone(page, 'P02-business');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('link', { name: /Step 2 of 3/ }).click();
  await expect(page.getByText('Do step 1 first')).toBeVisible();
});

test('onboarding: verification history and activation gaps have no fabricated clearance', async ({ page }) => {
  await setup(page, 'quiet');
  await signIn(page, '/pay/onboarding/verification');
  await expect(page.getByLabel('Verification file reference *')).toBeVisible();
  await expect(page.getByText(/it is not a screening clearance/)).toBeVisible();
  await snap(page, 'P03-verification');
  await axe(page);
  await phone(page, 'P03-verification');
  await go(page, '/pay/onboarding/go-live');
  await expect(page.getByText(/Saving a destination below does not complete go-live/)).toBeVisible();
  await snap(page, 'P04-go-live-phone');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await snap(page, 'P04-go-live');
  await axe(page);
});
