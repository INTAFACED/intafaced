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
/** No sideways page scroll at the current width. Polls briefly because a resize reflows after the call returns, and names what overflows if it does not settle. */
const noSideScroll = async (page) =>
  expect
    .poll(() =>
      page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        if (document.documentElement.scrollWidth <= width) return 'fits';
        return [...document.querySelectorAll('body *')]
          .filter((el) => {
            if (el.getBoundingClientRect().right <= width + 1) return false;
            // anything inside its own horizontal scroller is not the page overflowing
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement)
              if (['auto', 'scroll', 'hidden'].includes(getComputedStyle(p).overflowX)) return false;
            return true;
          })
          .slice(0, 5)
          .map(
            (el) =>
              `${el.tagName}.${el.getAttribute('class') ?? ''} "${(el.textContent ?? '').slice(0, 20)}" right=${Math.round(el.getBoundingClientRect().right)} in ${el.parentElement?.className ?? ''}`,
          )
          .join(' | ');
      }),
    )
    .toBe('fits');
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

// ---- W3b: payments, settlements, payouts, approvals, pricing, limits -----------------------------------------------------------
const PAY_SETTLED = 'aa000001-0000-4000-8000-000000000001';
const PAY_REFUNDED = 'aa000003-0000-4000-8000-000000000003';
const PAY_DISPUTED = 'aa000008-0000-4000-8000-000000000008';
const STL_PAID = 'bb000002-0000-4000-8000-000000000002';
const STL_WAITING = 'bb000003-0000-4000-8000-000000000003';
const STL_OWN = 'bb000006-0000-4000-8000-000000000006';
const STL_FAILED = 'bb000005-0000-4000-8000-000000000005';

test('payments: KPI strip, filters in the URL, search, load more, CSV with its times, and a phone layout', async ({ page }) => {
  const { mock, seen } = await setup(page);
  await signIn(page, '/pay/payments');
  await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Totals for Last 30 days' })).toBeVisible();
  await expect(page.getByText('4 s behind').first()).toBeVisible();
  const table = page.getByRole('region', { name: 'All payments' });
  await expect(table.getByRole('row')).toHaveCount(26);
  await expect(page.getByText('25 shown so far. More are available.')).toBeVisible();
  await snap(page, '20-payments-desktop');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(table.getByRole('row')).toHaveCount(51);
  await expect(page).toHaveURL(/limit=50/);
  expect(mock.calls.filter((c) => c.procedure === 'payment.list').map((c) => c.input.limit)).toEqual(expect.arrayContaining([25, 50]));
  // status asks the service; the other filters narrow what is loaded
  await page.getByLabel('Status').selectOption('failed');
  await expect(page).toHaveURL(/status=failed/);
  await expect.poll(() => mock.calls.some((c) => c.procedure === 'payment.list' && c.input.status === 'failed')).toBe(true);
  await page.getByLabel('Status').selectOption('');
  await page.getByLabel('Search', { exact: true }).fill('TEST-rail-0010');
  await expect(page).toHaveURL(/q=TEST-rail-0010/);
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(page.getByText(/1 of the \d+ loaded payments match\./)).toBeVisible();
  await page.getByLabel('Search', { exact: true }).fill('no-such-thing');
  await expect(page.getByRole('heading', { name: 'No loaded payment matches' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(table.getByRole('row')).not.toHaveCount(2);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('payments.csv');
  const { readFile } = await import('node:fs/promises');
  const csv = await readFile(await file.path(), 'utf8');
  expect(csv.split('\r\n')[0]).toContain('"generated_at","as_of"');
  expect(csv).not.toMatch(/founder|operator/i);
  await axe(page);
  expect(seen.filter((u) => /founderAdmin/i.test(u))).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await snap(page, '21-payments-phone');
});

test('payments: an empty account explains how the first payment appears', async ({ page }) => {
  await setup(page, 'quiet');
  await signIn(page, '/pay/payments');
  await expect(page.getByRole('heading', { name: 'No payments yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create a payment link' }).last()).toHaveAttribute('href', '/pay/links');
  await snap(page, '22-payments-empty');
});

test('payment detail: facts, amounts, timeline, refunds, dispute card; never the payer instrument', async ({ page }) => {
  await setup(page);
  await signIn(page, `/pay/payments/${PAY_REFUNDED}`);
  await expect(page.getByRole('heading', { name: 'Payment', level: 1 })).toBeVisible();
  await expect(page.getByText('Still refundable')).toBeVisible();
  await expect(page.getByText('Fee, net and the price that applied')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Refunds' }).getByRole('row')).toHaveCount(2);
  await expect(page.getByText('Completed')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Refund or capture this payment' }).first()).toHaveAttribute(
    'href',
    new RegExp(`payment=${PAY_REFUNDED}`),
  );
  await expect(page.locator('body')).not.toContainText('tok_TEST_must_never_show');
  await expect(page.locator('body')).not.toContainText('rail internals');
  await snap(page, '23-payment-detail');
  await go(page, `/pay/payments/${PAY_DISPUTED}`);
  await expect(page.getByRole('heading', { name: 'Dispute', level: 2 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the dispute' })).toHaveAttribute(
    'href',
    '/pay/disputes/d0000001-0000-4000-8000-000000000001',
  );
  await snap(page, '24-payment-detail-disputed');
  await go(page, `/pay/payments/${PAY_SETTLED}`);
  await expect(page.getByRole('link', { name: 'The settlement this payment is in' })).toHaveAttribute(
    'href',
    '/pay/settlements/bb000002-0000-4000-8000-000000000002',
  );
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await snap(page, '25-payment-detail-phone');
});

test('payment detail: an unknown or foreign id reads as not found, never as a code', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/payments/not-an-id');
  await expect(page.getByText('We could not find that payment.').first()).toBeVisible();
  await go(page, '/pay/payments/aa999999-0000-4000-8000-000000000999');
  await expect(page.getByText('We could not find that payment.').first()).toBeVisible();
  await expect(page.getByText(/pay\.[a-z_]+/)).toHaveCount(0);
});

test('settlements: totals for the period, status words, and a statement that ties out', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/settlements');
  await expect(page.getByRole('heading', { name: 'Settlements', level: 1 })).toBeVisible();
  const table = page.getByRole('region', { name: 'All settlements' });
  await expect(table.getByRole('row')).toHaveCount(7);
  await expect(page.getByText('there is no date filter yet')).toBeVisible();
  await snap(page, '26-settlements');
  await page.getByLabel('Status').selectOption('failed');
  await expect(table.getByRole('row')).toHaveCount(2);
  await page.getByLabel('Status').selectOption('');
  await page.getByRole('link', { name: /Open the settlement for window TEST-2026-W40$/ }).click();
  await expect(page.getByRole('heading', { name: 'Settlement statement', level: 1 })).toBeVisible();
  await expect(page.getByText('Checked: gross minus fees equals net, to the last decimal.')).toBeVisible();
  await expect(page.getByText('Your account holds back a rolling reserve of 5.00%.')).toBeVisible();
  await expect(page.getByText('Fees by line and the price that applied')).toBeVisible();
  await expect(page.getByText('TEST-tx-0xabc123')).toBeVisible();
  await snap(page, '27-settlement-statement');
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await snap(page, '28-settlement-statement-phone');
});

test('payouts: approval state on every row, an approval trail, and a cap with its time', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/payouts');
  await expect(page.getByRole('heading', { name: 'Payouts', level: 1 })).toBeVisible();
  await expect(page.getByText('Waiting for approval from your owner, an admin or finance').first()).toBeVisible();
  await expect(page.getByText('Arrives with the payout confirmation read')).toBeVisible();
  await snap(page, '29-payouts');
  await page.getByLabel('State').selectOption('paid_out');
  await expect(page).toHaveURL(/state=paid_out/);
  await expect(page.getByRole('region', { name: 'All payouts' }).getByRole('row')).toHaveCount(3);
  await go(page, `/pay/payouts/${STL_PAID}`);
  await expect(page.getByRole('heading', { name: 'Payout', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Approval trail' })).toBeVisible();
  await expect(page.getByText('TEST-tx-0xabc123')).toBeVisible();
  await expect(page.getByText('Your daily payout limit')).toBeVisible();
  await snap(page, '30-payout-detail-paid');
  await go(page, `/pay/payouts/${STL_FAILED}`);
  await expect(page.getByText('This payout did not complete. The reason is not shown here yet.')).toBeVisible();
  await expect(page.getByText('The approval on this payout no longer counts')).toBeVisible();
  await snap(page, '31-payout-detail-failed-voided');
  await axe(page);
});

test('payout detail: the checker approves with a reason, the service gets the fingerprint they reviewed', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, `/pay/payouts/${STL_WAITING}`);
  await expect(page.getByText('Waiting for approval').first()).toBeVisible();
  const approve = page.getByRole('button', { name: 'Approve payout' });
  await expect(approve).toBeDisabled();
  await expect(page.getByText('Write a reason of at least 3 characters to enable the buttons.')).toBeVisible();
  await snap(page, '32-payout-detail-waiting');
  await page.getByLabel('Your reason *').fill('Checked the destination');
  await expect(approve).toBeEnabled();
  await approve.click();
  const dialog = page.getByRole('dialog', { name: 'Review: Approve payout' });
  // the page must not promise a destination it does not show
  await expect(
    dialog.getByText('The destination is not shown here yet. Confirm it with the person who asked before you approve.'),
  ).toBeVisible();
  await expect(dialog).not.toContainText(/this destination/i);
  await expect(dialog.getByText('Checked the destination')).toBeVisible();
  await dialog.getByRole('button', { name: /^Confirm/ }).click();
  await expect(page.getByText('Approved').first()).toBeVisible();
  const sent = mock.calls.find((c) => c.procedure === 'merchantControl.approvals.decide').input;
  expect(sent).toEqual({
    approvalId: 'cc000001-0000-4000-8000-000000000001',
    decision: 'approve',
    expectedPayloadHash: `sha256:${'a'.repeat(64)}`,
    reason: 'Checked the destination',
  });
});

test('payout detail: the person who asked cannot approve, and can take the request back', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, `/pay/payouts/${STL_OWN}`);
  await expect(page.getByRole('button', { name: 'Approve payout' })).toBeDisabled();
  await expect(page.getByText('You asked for this payout, so someone else on your team has to decide it.')).toBeVisible();
  await page.getByLabel('Reason for cancelling *').fill('Wrong amount');
  await page.getByRole('button', { name: 'Cancel my request' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Confirm/ })
    .click();
  await expect(page.getByText('The approval on this payout no longer counts')).toBeVisible();
  expect(mock.calls.find((c) => c.procedure === 'merchantControl.approvals.cancel').input).toMatchObject({ reason: 'Wrong amount' });
});

test('approvals: the queue with ages and expiry, approve, reject, and a refusal in plain words', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/approvals');
  await expect(page.getByRole('heading', { name: 'Payout approvals', level: 1 })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Waiting on your team' })).toBeVisible();
  const items = page.getByRole('list', { name: 'Payout requests' }).getByRole('listitem');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText('965.55');
  await expect(items.first()).toContainText('Expires in');
  await expect(items.nth(1)).toContainText('You asked for this payout');
  await expect(items.nth(1).getByRole('button', { name: 'Approve payout' })).toBeDisabled();
  await snap(page, '33-approvals');
  // the service refuses because the payout changed after it was opened: words, not a code
  await page.route('**/api/pay/trpc/merchantControl.approvals.decide', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { message: 'pay.approval_payload_mismatch', data: { cause: { code: 'pay.approval_payload_mismatch' } } },
      }),
    }),
  );
  await items.first().getByLabel('Your reason *').fill('Looks right');
  await items.first().getByRole('button', { name: 'Reject payout' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Confirm/ })
    .click();
  await expect(page.getByText(/The payout changed after you opened it, so your decision was not recorded/).first()).toBeVisible();
  await expect(page.getByText('pay.approval_payload_mismatch')).toHaveCount(0);
  await snap(page, '34-approvals-refused');
  await page.unroute('**/api/pay/trpc/merchantControl.approvals.decide');
  await page.keyboard.press('Escape');
  await items.first().getByRole('button', { name: 'Reject payout' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Confirm/ })
    .click();
  await expect(items).toHaveCount(1);
  expect(mock.calls.filter((c) => c.procedure === 'merchantControl.approvals.decide').at(-1).input).toMatchObject({ decision: 'reject' });
  await page.getByLabel('Status').selectOption('all');
  await expect(page).toHaveURL(/status=all/);
  await expect(page.getByRole('list', { name: 'Payout requests' }).getByRole('listitem')).toHaveCount(5);
  await snap(page, '35-approvals-all');
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await snap(page, '36-approvals-phone');
});

test('pricing: the fee table, the calculator uses the live engine, and an unconfigured account shows no fee at all', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/pricing');
  await expect(page.getByRole('heading', { name: 'Pricing and fees', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Prices for USDT' })).toBeVisible();
  await expect(page.getByText('1.50%').first()).toBeVisible();
  await expect(page.getByText('History of price changes')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Work out the fee' })).toBeDisabled();
  await page.getByLabel('Payment amount *').fill('-5');
  await expect(page.getByText('Enter an amount greater than zero').first()).toBeVisible();
  await page.getByLabel('Asset').selectOption('USDT');
  await page.getByLabel('Payment amount *').fill('100');
  await page.getByRole('button', { name: 'Work out the fee' }).click();
  await expect(page.getByRole('heading', { name: 'Result for 100 USDT' })).toBeVisible();
  // 1.20% of 100 plus a flat 0.25, in the band that starts at 10,000 (the mock's month so far is 12,500)
  await expect(page.getByText('1.45').first()).toBeVisible();
  expect(mock.calls.find((c) => c.procedure === 'merchantControl.pricing.preview').input).toEqual({
    merchantId: expect.any(String),
    assetCode: 'USDT',
    amount: '100',
  });
  await page.getByLabel('This is a USD to USDT conversion (adds the spread)').check();
  await page.getByRole('button', { name: 'Work out the fee' }).click();
  await expect(page.getByText('Conversion spread').last()).toBeVisible();
  await snap(page, '37-pricing');
  await axe(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download schedule (CSV)' }).click();
  expect((await download).suggestedFilename()).toBe('pricing-schedule.csv');
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await snap(page, '38-pricing-phone');
});

test('pricing: not configured shows the words "not configured" and not one placeholder fee', async ({ page }) => {
  await setup(page, 'quiet');
  await signIn(page, '/pay/pricing');
  await expect(page.getByText('INTAFACED has not published pricing for your account.')).toBeVisible();
  await expect(page.getByText('No tier assigned')).toBeVisible();
  await expect(page.getByText('The calculator needs published pricing')).toBeVisible();
  await expect(page.getByText(/\d\.\d\d%/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download schedule (CSV)' })).toHaveCount(0);
  await snap(page, '39-pricing-not-configured');
});

test('limits: usage bars with exact figures and reset times, and nothing invented for what is not set', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/limits');
  await expect(page.getByRole('heading', { name: 'Limits and tier', level: 1 })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(4);
  await expect(page.getByText('14,200.5').first()).toBeVisible();
  await expect(page.getByText('Tiers and what unlocks next')).toBeVisible();
  await expect(page.getByText('Ask for a higher limit')).toBeVisible();
  await expect(page.getByText('TEST VALUE')).toHaveCount(0);
  await snap(page, '40-limits');
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await snap(page, '41-limits-phone');
});

test('limits: an account with no limits set says "not configured" and labels itself as a test account', async ({ page }) => {
  await setup(page, 'quiet');
  await signIn(page, '/pay/limits');
  await expect(page.getByText('INTAFACED has not set limits for your account yet.')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByText('TEST VALUE').first()).toBeVisible();
  await expect(page.getByText('0 / 5')).toBeVisible();
  await snap(page, '42-limits-not-configured');
});

test('a payout pause is named on the payout pages', async ({ page }) => {
  await setup(page, 'halted');
  await signIn(page, '/pay/payouts');
  await expect(page.getByText('Payouts are paused.')).toBeVisible();
  await expect(page.getByText('INTAFACED has paused this on your account')).toBeVisible();
  await snap(page, '43-payouts-paused');
  await go(page, '/pay/approvals');
  await expect(page.getByText('Payouts are paused.')).toBeVisible();
});

test('a refusal on a W3b page is plain words with no code', async ({ page }) => {
  await setup(page);
  await page.route('**/api/pay/trpc/payment.list*', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'pay.merchant_forbidden', data: { cause: { code: 'pay.merchant_forbidden' } } } }),
    }),
  );
  await signIn(page, '/pay/payments');
  await expect(page.getByText('Your account does not have access to this.').first()).toBeVisible();
  await expect(page.getByText(/pay\.[a-z_]+/)).toHaveCount(0);
  await snap(page, '44-payments-forbidden');
});

test('every W3b page says "arrives soon" when the control room is not switched on, and survives an unreachable service', async ({
  page,
}) => {
  await setup(page, 'soon');
  await signIn(page, '/pay/pricing');
  await expect(page.getByText('Arrives soon').first()).toBeVisible();
  await go(page, '/pay/limits');
  await expect(page.getByText('Arrives soon').first()).toBeVisible();
  await go(page, '/pay/approvals');
  await expect(page.getByText('Arrives soon').first()).toBeVisible();
  await snap(page, '45-approvals-arrives-soon');
  const offline = await page.context().newPage();
  const { seen } = await setup(offline, 'down');
  await signIn(offline, '/pay/payments');
  await expect(offline.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
  for (const path of [
    '/pay/settlements',
    '/pay/payouts',
    '/pay/approvals',
    '/pay/pricing',
    '/pay/limits',
    `/pay/payments/${PAY_SETTLED}`,
    `/pay/settlements/${STL_PAID}`,
    `/pay/payouts/${STL_PAID}`,
  ]) {
    await go(offline, path);
    await expect(offline.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
    await expect(offline.getByText(/pay\.[a-z_]+/)).toHaveCount(0);
  }
  expect(seen.filter((u) => /founderAdmin/i.test(u))).toEqual([]);
});

// ---- W3b review fixes -----------------------------------------------------------------------------------------------------------

const json = (route, data, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { result: { data } } : { error: data }) });

test('approvals: names where the portal has them, short ids otherwise', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/approvals');
  const items = page.getByRole('list', { name: 'Payout requests' }).getByRole('listitem');
  await expect(items.first()).toContainText('TEST Accounts');
});

test('approvals: a decision that was voided meanwhile is shown as refused, never as success', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/approvals');
  const items = page.getByRole('list', { name: 'Payout requests' }).getByRole('listitem');
  await page.route('**/api/pay/trpc/merchantControl.approvals.decide', (route) =>
    json(
      route,
      { ...mock.state.approvalsForTest?.[0] } && {
        approvalId: 'cc000001-0000-4000-8000-000000000001',
        merchantId: '11111111-1111-4111-8111-111111111111',
        settlementId: 'bb000003-0000-4000-8000-000000000003',
        amount: '965.55',
        assetCode: 'USDT',
        payloadHash: `sha256:${'a'.repeat(64)}`,
        status: 'voided',
        makerUserId: 'TEST-user-finance',
        checkerUserId: null,
        createdAt: new Date().toISOString(),
        decidedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    ),
  );
  await items.first().getByLabel('Your reason *').fill('Looks right');
  await items.first().getByRole('button', { name: 'Approve payout' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review: Approve payout' });
  await dialog.getByRole('button', { name: /^Confirm/ }).click();
  await expect(dialog.getByText('The request was voided because the payout changed, so your decision did not count.')).toBeVisible();
  await expect(page.getByText('The service confirmed the action')).toHaveCount(0);
  await snap(page, '46-approvals-voided-result');
});

test('approvals: a request a teammate already approved waits on INTAFACED, and cannot be decided again', async ({ page }) => {
  await setup(page);
  const row = {
    approvalId: 'cc000009-0000-4000-8000-000000000009',
    merchantId: '11111111-1111-4111-8111-111111111111',
    settlementId: 'bb000003-0000-4000-8000-000000000003',
    amount: '965.55',
    assetCode: 'USDT',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    status: 'pending',
    makerUserId: 'TEST-user-dev',
    checkerUserId: 'TEST-user-finance',
    createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    decidedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 40 * 3600_000).toISOString(),
  };
  await page.route('**/api/pay/trpc/merchantControl.approvals.list*', (route) => json(route, [row]));
  await signIn(page, '/pay/approvals');
  await expect(page.getByText('Approved by TEST Accounts, waiting for INTAFACED’s sign-off.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve payout' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reject payout' })).toBeDisabled();
  await expect(page.getByText('A teammate has already approved this.')).toBeVisible();
  await snap(page, '47-approvals-waiting-on-intafaced');
});

test('approvals: the clock ticks, so a request that expires while the page is open stops being decidable', async ({ page }) => {
  // the fake clock must be in place before the page starts its own timer
  await page.clock.install({ time: Date.now() });
  await setup(page);
  await signIn(page, '/pay/approvals');
  const first = page.getByRole('list', { name: 'Payout requests' }).getByRole('listitem').first();
  await expect(first).toContainText('Expires in');
  await page.getByRole('list', { name: 'Payout requests' }).getByRole('listitem').first().getByLabel('Your reason *').fill('Looks right');
  await expect(first.getByRole('button', { name: 'Approve payout' })).toBeEnabled();
  await page.clock.fastForward('50:00:00');
  await expect(first).toContainText('Past its expiry');
  await expect(first.getByRole('button', { name: 'Approve payout' })).toBeDisabled();
  await expect(first.getByText('This request has expired. Ask for the payout again.')).toBeVisible();
});

test('a failed or refused pause read says it could not check, not "nothing is paused"', async ({ page }) => {
  await setup(page);
  await page.route('**/api/pay/trpc/payHalts.status*', (route) =>
    json(route, { message: 'pay.merchant_forbidden', data: { cause: { code: 'pay.merchant_forbidden' } } }, 403),
  );
  await signIn(page, '/pay/payouts');
  await expect(page.getByText('We could not check whether payouts are paused.')).toBeVisible();
  await go(page, '/pay/payments');
  await expect(page.getByText('We could not check whether new payments are paused.')).toBeVisible();
  await snap(page, '48-pause-check-failed');
});

test('payouts: when approvals cannot be read, a payout shows "Approval unknown", not "ready"', async ({ page }) => {
  await setup(page);
  await page.route('**/api/pay/trpc/merchantControl.approvals.list*', (route) => json(route, { message: 'x' }, 503));
  await signIn(page, '/pay/payouts');
  await expect(page.getByText('Approval states could not be read')).toBeVisible();
  await expect(page.locator('.pp-chip', { hasText: 'Approval unknown' }).first()).toBeVisible();
  await expect(page.locator('.pp-chip', { hasText: 'Ready to pay out' })).toHaveCount(0);
  await snap(page, '49-payouts-approval-unknown');
  await go(page, `/pay/payouts/${STL_WAITING}`);
  await expect(page.locator('.pp-chip', { hasText: 'Approval unknown' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve payout' })).toHaveCount(0);
});

test('team members who are not the owner are told payments and statements are owner-only, and get no payout links', async ({ page }) => {
  await setup(page);
  await page.route('**/api/pay/trpc/merchant.me*', (route) => json(route, null));
  await page.route('**/api/pay/trpc/merchantOps.team.me*', (route) =>
    json(route, { merchantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'finance' }),
  );
  await signIn(page, '/pay/payments');
  await expect(page.getByText('Only the account owner can open payments and statements for now.')).toBeVisible();
  await snap(page, '50-payments-owner-only');
  for (const path of [
    '/pay/settlements',
    '/pay/payouts',
    `/pay/payments/${PAY_SETTLED}`,
    `/pay/settlements/${STL_PAID}`,
    `/pay/payouts/${STL_PAID}`,
  ]) {
    await go(page, path);
    await expect(page.getByText('Only the account owner can open payments and statements for now.')).toBeVisible();
  }
  await go(page, '/pay/approvals');
  await expect(page.getByRole('list', { name: 'Payout requests' })).toBeVisible();
  await expect(page.locator('a[href^="/pay/payouts/"]')).toHaveCount(0);
});

test('settlement statement CSV carries the time the data was read, not the time of the download', async ({ page }) => {
  await setup(page);
  await signIn(page, `/pay/settlements/${STL_PAID}`);
  await expect(page.getByText('Checked: gross minus fees equals net')).toBeVisible();
  await page.waitForTimeout(1500);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download statement (CSV)' }).click();
  const { readFile } = await import('node:fs/promises');
  const csv = await readFile(await (await download).path(), 'utf8');
  const [, row] = csv.trim().split('\r\n');
  const cells = row.split('","').map((c) => c.replaceAll('"', ''));
  const [generatedAt, asOf] = cells.slice(-2);
  expect(Date.parse(asOf)).toBeGreaterThan(0);
  expect(Date.parse(generatedAt) - Date.parse(asOf)).toBeGreaterThanOrEqual(1000);
});
