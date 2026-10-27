import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createPortalMock, USER_ID } from '../portal.mock.mjs';
import { installSettingsBMock } from './b-mock-install.mjs';

// The real App and sign-in form, the shared pay stand-in, and the developers / reports / analytics stand-in on top.
// Every key, address, secret and figure is TEST data. PORTAL_SHOTS_DIR writes a screenshot of each page.
const shots = process.env.PORTAL_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });

async function setup(page, { scenario = 'active', role = 'owner' } = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.route('**/api/identity/trpc/auth.login', (route) =>
    reply(route, { userId: USER_ID, accessToken: 'TEST-only', refreshToken: 'TEST-only', expiresAt: '2027-10-08T00:00:00Z' }),
  );
  await page.route('**/api/identity/trpc/webauthn.list?*', (route) => reply(route, []));
  const portal = createPortalMock(scenario, { role, myAccess: role === 'owner' ? 'off' : role });
  await portal.install(page);
  const b = await installSettingsBMock(page, { scenario, role });
  return { portal, b, errors };
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
async function look(page, name, { phone = false } = {}) {
  await expect(page.locator('.pp .pp-skeleton')).toHaveCount(0);
  const audit = await new AxeBuilder({ page }).include('[data-testid="pp"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(audit.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  if (shots) {
    await page.evaluate(() => {
      document.getElementById('fixture-label')?.remove();
      const badge = document.createElement('p');
      badge.id = 'fixture-label';
      badge.textContent = 'TEST DATA · local screenshot fixture';
      badge.style.cssText = 'margin:0;background:#2a2a2a;color:#eee;padding:6px 24px;font:12px system-ui';
      document.body.prepend(badge);
    });
    await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
  }
  if (phone) {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    if (shots) await page.screenshot({ path: `${shots}/${name}-phone.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}
const oneLime = (page) => expect.poll(() => page.getByTestId('pp').locator('[data-slot="button"].bg-lime').count()).toBeLessThanOrEqual(1);

test('developer pages: each shows real TEST data, fits a phone and has at most one lime button', async ({ page }) => {
  const { errors } = await setup(page);
  await signIn(page, '/pay/developer/keys');
  for (const [path, name, title, text] of [
    ['/pay/developer/keys', 'P43-api-keys', 'API keys', 'TEST Checkout system'],
    ['/pay/developer/signing', 'P44-signing', 'Signing and allowed addresses', 'How to sign a request'],
    ['/pay/developer/webhooks', 'P45-webhooks', 'Webhook endpoints', 'https://receiver.example/events'],
    ['/pay/developer/webhooks/TEST-endpoint-1', 'P46-endpoint', 'Webhook endpoint', 'Change this endpoint'],
    ['/pay/developer/deliveries', 'P47-deliveries', 'Webhook deliveries', 'payment.captured'],
    ['/pay/developer/sandbox', 'P48-sandbox', 'Test mode', 'Getting started'],
    ['/pay/developer/docs', 'P49-docs', 'Developer guide', 'Checking the events we send'],
  ]) {
    await go(page, path);
    await expect(page.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible();
    await expect(page.getByTestId('pp').getByText(text).first()).toBeVisible();
    await oneLime(page);
    await look(page, name, { phone: true });
  }
  expect(errors).toEqual([]);
});

test('keys: a new key is shown once, then hidden; revoking asks first', async ({ page }) => {
  const { b } = await setup(page);
  await signIn(page, '/pay/developer/keys');
  await page.getByLabel('Key name').fill('TEST new key');
  await page.getByRole('button', { name: 'Create test key', exact: true }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText(/test_TEST-NOT-A-REAL-KEY/)).toBeVisible();
  await expect(page.getByText(/shown only once/)).toBeVisible();
  await page.getByRole('button', { name: 'Hide it', exact: true }).click();
  await expect(page.getByText(/test_TEST-NOT-A-REAL-KEY/)).toHaveCount(0);
  // A reload drops the in-memory sign-in, so leave the page and come back inside the app.
  await go(page, '/pay/developer/signing');
  await go(page, '/pay/developer/keys');
  await expect(page.getByText(/test_TEST-NOT-A-REAL-KEY/)).toHaveCount(0);
  const revoke = page.getByRole('button', { name: 'Revoke key', exact: true }).first();
  await revoke.click();
  expect(b.calls.filter((c) => c.procedure === 'apiKeys.revoke')).toHaveLength(0);
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().dblclick();
  await expect.poll(() => b.calls.filter((c) => c.procedure === 'apiKeys.revoke').length).toBe(1);
});

test('signing: the saved state is shown and preselected; a first turn-on shows the secret once', async ({ page }) => {
  const { b } = await setup(page);
  await signIn(page, '/pay/developer/signing?key=TEST-key-2');
  // TEST-key-2 has neither setting on: the form starts from that, not from "not chosen".
  await expect(page.getByText('Signed requests required: no. Allowed address required: no.')).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Require signed requests' }).getByLabel('Off')).toBeChecked();
  await expect(page.getByRole('radiogroup', { name: /allowed IP address/ }).getByLabel('Off')).toBeChecked();
  await expect(page.getByText('No addresses are saved. The key works from any address.')).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Require signed requests' }).getByLabel('On').check();
  await expect(page.getByText('Requests with this key need a valid signature, or they are refused.').first()).toBeVisible();
  await page.getByRole('button', { name: 'Save signing settings' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText('ifs_TEST-signing-secret')).toBeVisible();
  await page.getByRole('button', { name: 'Hide it', exact: true }).click();
  await expect(page.getByText('ifs_TEST-signing-secret')).toHaveCount(0);
  expect(b.calls.filter((c) => c.procedure === 'setApiKeyRequestSigning')).toHaveLength(1);
});

test('signing state: the key list and the signing page show what is saved for each key, never a secret', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/developer/keys');
  const row = (name) => page.locator('[data-testid="pe-table"] tbody tr', { hasText: name });
  await expect(row('TEST Checkout system').getByText('Signed requests')).toBeVisible();
  await expect(row('TEST Checkout system').getByText('1 allowed address · address required')).toBeVisible();
  await expect(row('TEST Reporting').getByText('Signing off')).toBeVisible();
  await expect(row('TEST Reporting').getByText('Any address')).toBeVisible();
  await expect(page.getByTestId('pp')).not.toContainText('ifs_');
  await look(page, 'P43b-api-keys-protection', { phone: true });
  await go(page, '/pay/developer/signing?key=TEST-key-1');
  await expect(page.getByText('Signed requests required: yes. Allowed address required: yes.')).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Require signed requests' }).getByLabel('On')).toBeChecked();
  await expect(page.getByLabel('Addresses')).toHaveValue('203.0.113.10');
  await expect(page.getByTestId('pp')).not.toContainText('ifs_');
});

test('signing off says it deletes the secret; an empty list is its own "Remove all addresses" choice', async ({ page }) => {
  const { b } = await setup(page);
  await signIn(page, '/pay/developer/signing?key=TEST-key-1');
  await page.getByRole('radiogroup', { name: 'Require signed requests' }).getByLabel('Off').check();
  await page
    .getByRole('radiogroup', { name: /allowed IP address/ })
    .getByLabel('Off')
    .check();
  await page.getByRole('button', { name: 'Save signing settings' }).click();
  await expect(
    page.getByRole('dialog').getByText('This deletes the current signing secret; turning it on later issues a new one.'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  // The box starts from the saved list; emptied, plain Save closes and "Remove all addresses" is the way.
  await expect(page.getByLabel('Addresses')).toHaveValue('203.0.113.10');
  await page.getByLabel('Addresses').fill('');
  await expect(page.getByRole('button', { name: 'Replace allowed addresses' })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove all addresses' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect.poll(() => b.calls.filter((c) => c.procedure === 'bindApiKeyIpAllowlist').length).toBe(1);
});

test('allowed addresses: the page says saving them leaves the signing setting alone', async ({ page }) => {
  const { b } = await setup(page);
  await signIn(page, '/pay/developer/signing?key=TEST-key-1');
  await expect(page.getByText('Saving addresses does not change whether this key requires signed requests.')).toBeVisible();
  await page.getByLabel('Addresses').fill('203.0.113.10\n203.0.113.11');
  await page.getByRole('button', { name: 'Replace allowed addresses' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-testid="form-stack"] > button').last().click();
  await expect.poll(() => b.calls.filter((c) => c.procedure === 'bindApiKeyIpAllowlist').length).toBe(1);
});

test('webhooks: a private address is refused before sending; a good one shows its secret once', async ({ page }) => {
  const { b } = await setup(page);
  await signIn(page, '/pay/developer/webhooks');
  await expect(page.getByTestId('pp')).not.toContainText('TEST-secret-in-URL');
  await page.getByLabel('Endpoint address').fill('https://10.0.0.5/hook');
  await expect(page.getByText(/This address is private or internal/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add endpoint', exact: true }).last()).toBeDisabled();
  await page.getByLabel('Endpoint address').fill('https://receiver.example/new');
  await page.getByRole('button', { name: 'Add endpoint', exact: true }).last().click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText(/TEST-secret-TEST-endpoint-4/)).toBeVisible();
  await page.getByRole('button', { name: 'Hide it', exact: true }).click();
  await expect(page.getByText(/TEST-secret-TEST-endpoint-4/)).toHaveCount(0);
  expect(b.calls.filter((c) => c.procedure === 'merchantOps.webhooks.create')).toHaveLength(1);
});

test('endpoint: disabling asks first and the page then offers no way back on', async ({ page }) => {
  const { b } = await setup(page);
  await signIn(page, '/pay/developer/webhooks/TEST-endpoint-1');
  await page.getByRole('button', { name: 'Turn off endpoint', exact: true }).click();
  expect(b.calls.filter((c) => c.procedure === 'merchantOps.webhooks.disable')).toHaveLength(0);
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect.poll(() => b.calls.filter((c) => c.procedure === 'merchantOps.webhooks.disable').length).toBe(1);
  await expect(page.getByText(/add it as a new endpoint/).first()).toBeVisible();
});

test('deliveries: filter to failed and send one again after a review', async ({ page }) => {
  const { b } = await setup(page);
  await signIn(page, '/pay/developer/deliveries');
  await page.getByLabel('Status').selectOption('failed');
  await expect(page).toHaveURL(/status=failed/);
  await expect
    .poll(() => b.calls.some((c) => c.procedure === 'merchantOps.webhooks.deliveries.list' && c.input.status === 'failed'))
    .toBe(true);
  await page.getByRole('button', { name: 'Send again', exact: true }).first().click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect
    .poll(() => b.calls.find((c) => c.procedure === 'merchantOps.webhooks.deliveries.retry')?.input.requestId)
    .toMatch(/^[0-9a-f-]{36}$/);
});

test('a role that may only read sees webhooks but cannot change them', async ({ page }) => {
  await setup(page, { role: 'viewer' });
  await signIn(page, '/pay/developer/webhooks');
  await expect(page.getByText(/can look at webhooks but not change them/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add endpoint', exact: true }).last()).toBeDisabled();
});

test('reports: the catalog opens the request form on the chosen kind; request, build, download, delete', async ({ page }) => {
  const { b } = await setup(page);
  await signIn(page, '/pay/reports');
  await expect(page.getByRole('heading', { name: 'Reports', level: 1, exact: true })).toBeVisible();
  await look(page, 'P52-reports', { phone: true });
  await page.getByRole('row', { name: /Fees/ }).getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Report files', level: 1, exact: true })).toBeVisible();
  await expect(page.locator('#request select').first()).toHaveValue('fees');
  await page.getByRole('button', { name: 'Request a report', exact: true }).last().click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect.poll(() => b.calls.some((c) => c.procedure === 'merchantOps.exports.create')).toBe(true);
  const create = b.calls.find((c) => c.procedure === 'merchantOps.exports.create');
  expect(create.input.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(create.input)).not.toMatch(/merchantId/i);
  await expect(page.getByRole('row', { name: /Fees.*Ready/ }).first()).toBeVisible({ timeout: 15_000 });
  await look(page, 'P53-report-files', { phone: true });
  const download = page.waitForEvent('download');
  await page
    .getByRole('row', { name: /Fees.*Ready/ })
    .first()
    .getByRole('button', { name: /Download/ })
    .click();
  expect((await download).suggestedFilename()).toBe('fees.csv');
  await page
    .getByRole('row', { name: /Fees.*Ready/ })
    .first()
    .getByRole('button', { name: 'Delete file', exact: true })
    .click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect.poll(() => b.calls.filter((c) => c.procedure === 'merchantOps.exports.expire').length).toBe(1);
});

test('analytics: volume and fees read the period, bucket and asset the person chose', async ({ page }) => {
  const { b } = await setup(page);
  await signIn(page, '/pay/analytics');
  await expect(page.getByRole('heading', { name: 'Volume', level: 1, exact: true })).toBeVisible();
  await expect(page.getByText('Captured volume').first()).toBeVisible();
  await look(page, 'P50-analytics', { phone: true });
  await page.getByLabel('Group by').selectOption('week');
  await expect.poll(() => b.calls.some((c) => c.procedure === 'merchantAnalytics.volume' && c.input.bucket === 'week')).toBe(true);
  await page.getByLabel('Asset').selectOption('USD');
  await expect.poll(() => b.calls.some((c) => c.procedure === 'merchantAnalytics.volume' && c.input.assetId === 'USD')).toBe(true);
  await go(page, '/pay/analytics/fees');
  await expect(page.getByRole('heading', { name: 'Fees', level: 1, exact: true })).toBeVisible();
  // The rate is worked out per asset from the fees and gross on the page (fees ÷ gross), so a complete period shows it.
  await expect(page.getByRole('list', { name: 'Effective fee rate by asset' })).toBeVisible();
  await look(page, 'P51-fees', { phone: true });
});

test('an account with no activity gets plain empty states, not zeros', async ({ page }) => {
  await setup(page, { scenario: 'quiet' });
  await signIn(page, '/pay/developer/webhooks');
  await expect(page.getByText('No webhook endpoints yet')).toBeVisible();
  await go(page, '/pay/developer/keys');
  await expect(page.getByText('No API keys yet')).toBeVisible();
  await go(page, '/pay/analytics');
  await expect(page.getByText('No captured payments in this period')).toBeVisible();
  await go(page, '/pay/reports/exports');
  await expect(page.getByText('No report files yet')).toBeVisible();
});
