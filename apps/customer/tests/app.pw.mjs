import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Isolated identity/network examples exercise the real App and sign-in form.
// No production sample mode, financial browser dataset, or fixture screenshots.
const userId = '11111111-1111-4111-8111-111111111111';
const foreignId = '22222222-2222-4222-8222-222222222222';
const invitationId = '33333333-3333-4333-8333-333333333333';
const session = { userId, accessToken: 'isolated-identity-test', refreshToken: 'isolated-refresh-test', expiresAt: '2027-10-08T00:00:00Z' };
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
async function setup(page) {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable', message: 'The service is offline.' }),
    }),
  );
  await page.route('**/api/identity/trpc/auth.login', (route) => reply(route, session));
  await page.route('**/api/identity/trpc/webauthn.list?*', (route) => reply(route, []));
  await page.route('**/api/v1/markets*', (route) => {
    if (new URL(route.request().url()).searchParams.get('limit') !== '500')
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'trade.markets_limit_unset' }) });
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });
}
async function signIn(page, destination) {
  await page.goto(`/login?redirect=${encodeURIComponent(destination)}`);
  await page.getByLabel('Email or handle', { exact: true }).fill('integration@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
}

test('safe sign-in return opens the actual Bank room without persisting credentials', async ({ page }) => {
  await setup(page);
  await signIn(page, '/bank/spaces');
  await expect(page.getByRole('heading', { name: 'Spaces', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('Journey implementation in progress')).toHaveCount(0);
  const storage = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }));
  expect(JSON.stringify(storage)).not.toContain(session.accessToken);
  expect(JSON.stringify(storage)).not.toContain(session.refreshToken);
});

test('search is keyboard reachable and excludes Business, Team and parked chain rooms', async ({ page }) => {
  await setup(page);
  await signIn(page, '/uc/safe');
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Search Intafaced' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('No published markets match this search.')).toBeVisible();
  await dialog.getByLabel('Find a room or action').fill('ledger');
  await expect(dialog.getByRole('link', { name: /Operator|Ledger ops|Business bank|Merchant/ })).toHaveCount(0);
  await dialog.getByLabel('Find a room or action').fill('chain');
  await expect(dialog.getByRole('link')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('sign out everywhere requires review and clears the account after the service confirms', async ({ page }) => {
  await setup(page);
  let revocations = 0;
  await page.route('**/api/identity/trpc/auth.logoutAll', (route) => {
    revocations++;
    return reply(route, { revoked: 1 });
  });
  await signIn(page, '/uc/safe');
  await page.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
  expect(revocations).toBe(0);
  await page.getByRole('dialog', { name: 'Sign out everywhere' }).getByRole('button', { name: 'Revoke all sessions' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  expect(revocations).toBe(1);
});

test('Inbox keeps a legitimate Money link and refuses another account’s notification', async ({ page }) => {
  await setup(page);
  const item = {
    id: invitationId,
    userId,
    titleKey: 'test.notification',
    bodyKey: 'test.body',
    title: 'Review account settings',
    body: 'Review the current settings for your account.',
    href: '/money',
    severity: 'info',
    readAt: null,
    createdAt: '2026-10-08T00:00:00Z',
  };
  await page.route('**/api/notify/trpc/notify.list?*', (route) => reply(route, { items: [item], nextCursor: null }));
  await signIn(page, '/notifications');
  await expect(page.getByRole('link', { name: 'Open related room' })).toHaveAttribute('href', '/money');
  item.userId = foreignId;
  await page.getByRole('button', { name: 'Unread only' }).click();
  await expect(page.getByRole('heading', { name: 'Information could not be verified' })).toBeVisible();
  await expect(page.getByText('Review account settings')).toHaveCount(0);
});

test('invitation survives sign-in and requires an explicit acceptance', async ({ page }) => {
  await setup(page);
  let accepted = 0;
  await page.route('**/api/identity/trpc/affiliates.shareHits', (route) => {
    expect(route.request().postDataJSON()).toEqual({ token: invitationId });
    accepted++;
    return reply(route, { hits: 1, attributed: true });
  });
  await page.goto(`/invite?token=${invitationId}`);
  await page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email or handle', { exact: true }).fill('integration@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/invite\\?token=${invitationId}$`));
  expect(accepted).toBe(0);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByText('Your referral status is recorded by the service.')).toBeVisible();
  expect(accepted).toBe(1);
});

test('View uses the selected document language at 320px and has no serious accessibility defects', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await signIn(page, '/view');
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await page.getByLabel('Language', { exact: true }).selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(audit.violations.filter((item) => ['serious', 'critical'].includes(item.impact))).toEqual([]);
});

test('authenticator confirmation submits the real contract without reloading or persisting setup secrets', async ({ page }) => {
  await setup(page);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const secret = Array.from(randomBytes(32), (byte) => alphabet[byte % 32]).join('');
  await page.route('**/api/identity/trpc/totp.enrol', (route) =>
    reply(route, { secret, uri: `otpauth://totp/Test?secret=${secret}`, recoveryCodes: ['isolated-recovery'] }),
  );
  await page.route('**/api/identity/trpc/totp.confirm', (route) => {
    expect(route.request().postDataJSON()).toEqual({ secret, code: '123456' });
    return reply(route, { ok: true });
  });
  await signIn(page, '/uc/safe');
  await page.getByRole('button', { name: 'Start authenticator setup' }).click();
  await page.getByLabel('Six-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Confirm authenticator' }).click();
  await expect(page.getByText('Authenticator enrollment confirmed.')).toBeVisible();
  await expect(page).toHaveURL(/\/uc\/safe$/);
  expect(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))).not.toContain(secret);
});

test('assembled customer rooms remain usable at desktop and 320px when services are unavailable', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  await signIn(page, '/money');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const paths = await page.evaluate(async () => {
    const { rooms } = await import('/src/app/navigation.ts');
    return rooms
      .filter(
        (room) =>
          !room.alias &&
          !room.path.includes(':') &&
          !room.path.includes('*') &&
          ['money', 'trade', 'pay', 'more', 'person'].includes(room.area),
      )
      .map((room) => room.path);
  });
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of paths) {
      await page.evaluate(async (destination) => {
        const { navigate } = await import('/src/app/location.ts');
        navigate(destination);
      }, path);
      await expect(page.getByText('Opening room', { exact: false })).toHaveCount(0);
      await expect(page.getByText('The interface encountered an error', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Journey implementation in progress', { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path} at ${width}px`).toBe(true);
    }
  }
  expect(errors).toEqual([]);
});
