import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createPortalMock, USER_ID } from './portal.mock.mjs';

// The real App, the real sign-in form, and a mocked pay service (portal.mock.mjs). Every figure and name is TEST data.
// With PORTAL_SHOTS_DIR set the run also writes a screenshot of each page, with a visible "mocked data" badge.
const shots = process.env.PORTAL_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const session = {
  userId: USER_ID,
  accessToken: 'portal-test-only',
  refreshToken: 'portal-test-refresh',
  expiresAt: '2027-10-08T00:00:00Z',
};
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });

async function setup(page, scenario = 'active') {
  const seen = [];
  page.on('request', (request) => request.url().includes('/api/') && seen.push(request.url()));
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable', message: 'The service is offline.' }),
    }),
  );
  await page.route('**/api/identity/trpc/auth.login', (route) => reply(route, session));
  await page.route('**/api/identity/trpc/webauthn.list?*', (route) => reply(route, []));
  const mock = createPortalMock(scenario);
  await mock.install(page);
  return { mock, seen };
}
async function signIn(page, destination) {
  await page.goto(`/login?redirect=${encodeURIComponent(destination)}`);
  await page.getByLabel('Email or handle', { exact: true }).fill('portal-test@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
}
/** In-app navigation keeps the in-memory sign-in; a reload would drop it. */
async function go(page, path) {
  await page.evaluate((path) => {
    history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}
async function snap(page, name) {
  if (!shots) return;
  await page.evaluate(() => {
    document.getElementById('mock-badge')?.remove();
    const badge = document.createElement('div');
    badge.id = 'mock-badge';
    badge.textContent = 'MOCKED DATA · screenshot fixture, not a real merchant';
    badge.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:99999;background:#c8f64a;color:#000;font:600 12px Inter,system-ui;padding:6px 10px;border-radius:6px;';
    document.body.append(badge);
  });
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
}
const noSideScroll = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
const axe = async (page) => {
  const audit = await new AxeBuilder({ page }).include('.pp').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(audit.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
};

test('dashboard: KPI tiles, daily chart, status mix, balances, as-of; phone width', async ({ page }) => {
  const { mock, seen } = await setup(page);
  await signIn(page, '/pay/merchant');
  await expect(page.getByRole('heading', { name: 'Merchant dashboard', level: 1 })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Totals for Today' })).toBeVisible();
  await expect(page.getByText('As of').first()).toBeVisible();
  await expect(page.getByText('4 s behind').first()).toBeVisible();
  await expect(page.getByRole('img', { name: /Bar chart of daily volume in USDT/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /8,123\.456789 USDT/ })).toBeVisible();
  await expect(page.getByText('Limits, approvals and operator pauses')).toBeVisible();
  await page.getByRole('button', { name: 'Last 30 days', exact: true }).first().click();
  await expect(page.getByRole('group', { name: 'Totals for Last 30 days' })).toBeVisible();
  await snap(page, '01-dashboard-desktop');
  await page.getByRole('button', { name: 'Show as a table' }).click();
  await expect(page.getByRole('region', { name: 'Daily volume in USDT' })).toBeVisible();
  await axe(page);
  expect(mock.calls.some((c) => c.procedure === 'merchantMetrics.snapshot' && c.input.window.preset === 'rolling_30d')).toBe(true);
  expect(seen.filter((u) => /founderAdmin/i.test(u))).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await snap(page, '02-dashboard-phone');
});

test('dashboard: a new merchant sees how the first payment appears, not a wall of zeros', async ({ page }) => {
  await setup(page, 'quiet');
  await signIn(page, '/pay/merchant');
  await expect(page.getByRole('heading', { name: 'No payments yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue setup' })).toHaveAttribute('href', '/pay/onboarding');
  await expect(page.getByText('Not published')).toBeVisible();
  await snap(page, '03-dashboard-empty');
});

test('dashboard: no merchant yet leads to setup; operations not switched on says "arrives soon"', async ({ page }) => {
  await setup(page, 'new');
  await signIn(page, '/pay/merchant');
  await expect(page.getByRole('heading', { name: 'Set up your merchant account' })).toBeVisible();
  await snap(page, '04-dashboard-no-merchant');
  const soon = await page.context().newPage();
  await setup(soon, 'soon');
  await signIn(soon, '/pay/merchant');
  await expect(soon.getByText('Arrives soon').first()).toBeVisible();
  await snap(soon, '05-dashboard-arrives-soon');
});

test('onboarding: verification then payout destination, ending in a live-in-sandbox summary', async ({ page }) => {
  const { mock } = await setup(page, 'quiet');
  await signIn(page, '/pay/onboarding');
  await expect(page.getByText('Step 2 of 3: Verification').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send for review' })).toBeDisabled();
  await page.getByLabel('Verification file reference *').fill('TEST-dossier-777');
  await snap(page, '06-onboarding-verification');
  await page.getByRole('button', { name: 'Send for review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review: Send for review' });
  await expect(dialog.getByText('TEST-dossier-777')).toBeVisible();
  await dialog.getByRole('button', { name: /^Confirm/ }).click();
  await expect(page.getByText('INTAFACED is reviewing it')).toBeVisible();
  expect(mock.calls.filter((c) => c.procedure === 'merchant.submitKyb')).toHaveLength(1);
  await page.getByRole('button', { name: /Step 3 of 3/ }).click();
  const address = page.getByLabel('Wallet address *');
  await address.fill('0x123');
  await expect(page.getByText('This is not a valid address')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save destination' })).toBeDisabled();
  await address.fill(`0x${'ab'.repeat(20)}`);
  await snap(page, '07-onboarding-payout');
  await page.getByRole('button', { name: 'Save destination' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Confirm/ })
    .click();
  await expect(page.getByRole('heading', { name: 'You are live in sandbox' })).toBeVisible();
  await expect(page.getByText('Waiting for verification to be approved')).toBeVisible();
  await snap(page, '08-onboarding-sandbox-summary');
});

test('onboarding: step 1 refuses to open an account while no starting fee is published', async ({ page }) => {
  await setup(page, 'new');
  await signIn(page, '/pay/onboarding');
  await expect(page.getByText('Step 1 of 3: Business details').first()).toBeVisible();
  await page.getByLabel('Legal business name *').fill('TEST Trading Ltd');
  await page.getByLabel('Country code *').fill('gb');
  await page.getByLabel('Type of business *').fill('Online shop');
  await page.getByLabel('Contact email *').fill('ops@test.invalid');
  await expect(page.getByText('Accounts cannot be opened yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create my account' })).toBeDisabled();
  await snap(page, '09-onboarding-business');
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
});

test('team: change a role, invite, and a refused change reads in plain words', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/team');
  await expect(page.getByText('verified with two-step sign-in (MFA)')).toBeVisible();
  const members = page.getByRole('region', { name: 'Members' });
  await expect(members.getByRole('row', { name: /TEST-user-finance/ })).toBeVisible();
  await snap(page, '10-team');
  const row = members.getByRole('row', { name: /TEST-user-dev/ });
  await row.getByLabel('New role').selectOption('viewer');
  await row.getByRole('button', { name: 'Change role', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review: Change role' });
  await expect(dialog.getByText(/TEST-user-dev changes from Developer to Viewer/)).toBeVisible();
  await dialog.getByRole('button', { name: /^Confirm/ }).click();
  await expect(page.getByText('TEST-user-dev changed from Developer to Viewer')).toBeVisible();
  expect(mock.calls.find((c) => c.procedure === 'merchantOps.team.changeRole').input).toMatchObject({ role: 'viewer' });
  // A refusal from the service: words, not a code.
  await page.route('**/api/pay/trpc/merchantOps.team.invite', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'pay.team_interactive_only', data: { cause: { code: 'pay.team_interactive_only' } } } }),
    }),
  );
  await page.getByLabel('Account ID *').fill('TEST-user-new');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Confirm/ })
    .click();
  await expect(page.getByText(/Team changes need a session verified with two-step sign-in/).first()).toBeVisible();
  await expect(page.getByText('pay.team_interactive_only')).toHaveCount(0);
  await axe(page);
});

test('team: pending invitations can be accepted or declined', async ({ page }) => {
  await setup(page, 'new');
  await signIn(page, '/pay/team');
  await expect(page.getByText('Invitation to join a team as Developer')).toBeVisible();
  await snap(page, '11-team-invitation');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Confirm/ })
    .click();
  await expect(page.getByText('Invitation to join a team as Developer')).toHaveCount(0);
});

test('disputes: filter in the URL, open one, add evidence metadata, then contest', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/disputes');
  await expect(page.getByRole('region', { name: 'All disputes' }).getByRole('row')).toHaveCount(4);
  await expect(page.getByText('No deadline has been published')).toBeVisible();
  await snap(page, '12-disputes');
  await page.getByLabel('Status').selectOption('won');
  await expect(page).toHaveURL(/status=won/);
  await expect(page.getByRole('region', { name: 'All disputes' }).getByRole('row')).toHaveCount(2);
  await page.getByLabel('Status').selectOption('');
  await page.getByRole('link', { name: /Open dispute d0000001/ }).click();
  await expect(page.getByRole('heading', { name: 'Dispute', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Contest the dispute' })).toBeDisabled();
  await expect(page.getByText('Add at least one piece of evidence to contest.')).toBeVisible();
  const content = Buffer.from('TEST receipt contents');
  await page.getByLabel('File *').setInputFiles({ name: 'TEST-receipt.txt', mimeType: 'text/plain', buffer: content });
  await expect(page.getByText(/TEST-receipt\.txt · 21 B · ready/)).toBeVisible();
  await page.getByRole('button', { name: 'Add evidence', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Confirm/ })
    .click();
  await expect(page.getByRole('cell', { name: /TEST-receipt\.txt/ })).toBeVisible();
  const sent = mock.calls.find((c) => c.procedure === 'merchantOps.disputes.addEvidence').input;
  expect(sent).toMatchObject({ fileName: 'TEST-receipt.txt', contentType: 'text/plain', sizeBytes: 21 });
  expect(sent.sha256).toBe(createHash('sha256').update(content).digest('hex'));
  await snap(page, '13-dispute-detail');
  await page.getByRole('button', { name: 'Contest the dispute' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Confirm/ })
    .click();
  await expect(page.getByText('You contested the dispute')).toBeVisible();
  const decision = mock.calls.find((c) => c.procedure === 'merchantOps.disputes.respond').input;
  expect(decision.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(decision.action).toBe('contest');
  await axe(page);
});

test('disputes: an unknown id reads as not found, never as a code', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/disputes/does-not-exist');
  await expect(page.getByText('We could not find that dispute.')).toBeVisible();
});

test('customers: search, cursor pagination, and a customer detail', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/customers');
  const table = page.getByRole('region', { name: 'Customer directory' });
  await expect(table.getByRole('row')).toHaveCount(26);
  await expect(page.getByText('25 shown so far. More are available.')).toBeVisible();
  await snap(page, '14-customers');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(table.getByRole('row')).toHaveCount(31);
  await expect(page.getByText('30 shown. That is everything.')).toBeVisible();
  const pages = mock.calls.filter((c) => c.procedure === 'merchantOps.customers.list');
  expect(pages[0].input.cursor).toBeUndefined();
  expect(pages.some((c) => typeof c.input.cursor === 'string' && c.input.cursor.length > 0)).toBe(true);
  await page.getByLabel('Reference starts with').fill('TEST-cust-00');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/q=TEST-cust-00/);
  await expect(table.getByRole('row')).toHaveCount(10);
  await page.getByLabel('Reference starts with').fill('nobody');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('No reference starts with “nobody”.')).toBeVisible();
  await go(page, '/pay/customers/TEST-cust-030');
  await expect(page.getByRole('heading', { name: 'Customer', level: 1 })).toBeVisible();
  await expect(page.getByText('Lifetime totals')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recent payments' })).toBeVisible();
  await snap(page, '15-customer-detail');
});

test('exports: request, watch it build, download it', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/exports');
  await snap(page, '16-exports');
  await page.getByLabel('Kind *').selectOption('settlements');
  await page.getByRole('button', { name: 'Request export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review: Request export' });
  await expect(dialog.getByText('Settlements')).toBeVisible();
  await dialog.getByRole('button', { name: /^Confirm/ }).click();
  const jobs = page.getByRole('region', { name: 'Your exports' });
  await expect(jobs.getByRole('row', { name: /Settlements.*(Waiting|Building)/ })).toBeVisible();
  const request = mock.calls.find((c) => c.procedure === 'merchantOps.exports.create').input;
  expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(request)).not.toMatch(/merchantId/i);
  await expect(jobs.getByRole('row', { name: /Settlements.*Ready/ })).toBeVisible({ timeout: 15_000 });
  const download = page.waitForEvent('download');
  await jobs
    .getByRole('row', { name: /Settlements.*Ready/ })
    .getByRole('button', { name: /Download/ })
    .click();
  expect((await download).suggestedFilename()).toBe('payments.csv');
  await snap(page, '17-exports-ready');
});

test('notifications: mark read, preferences with a threshold that has no default', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/notifications');
  await expect(page.getByText('A customer challenged a payment')).toBeVisible();
  await snap(page, '18-notifications');
  await page.getByRole('button', { name: 'Mark read' }).first().click();
  await expect.poll(() => mock.calls.filter((c) => c.procedure === 'merchantOps.notifications.markRead').length).toBe(1);
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByText('Nothing is sent by email or text')).toBeVisible();
  const threshold = page.getByLabel('Alert when a limit reaches');
  await expect(threshold).toHaveValue('');
  await threshold.fill('-5');
  await expect(page.getByText('Use digits only')).toBeVisible();
  await threshold.fill('250.5');
  await page.getByRole('listitem').filter({ hasText: 'Limit nearly reached' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  expect(mock.calls.find((c) => c.procedure === 'merchantOps.notifications.preferences.set').input).toMatchObject({
    kind: 'limit_threshold',
    threshold: '250.5',
  });
  await snap(page, '19-notification-preferences');
  await axe(page);
});

test('every portal page survives an unreachable service with a retry, and calls no operator procedure', async ({ page }) => {
  const { seen } = await setup(page, 'down');
  await signIn(page, '/pay/team');
  await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
  for (const path of ['/pay/disputes', '/pay/customers', '/pay/exports', '/pay/notifications', '/pay/merchant']) {
    await go(page, path);
    await expect(page.getByRole('main').or(page.locator('.page')).first()).toBeVisible();
    await expect(page.getByText(/pay\.[a-z_]+/)).toHaveCount(0);
  }
  expect(seen.filter((u) => /founderAdmin/i.test(u))).toEqual([]);
});
