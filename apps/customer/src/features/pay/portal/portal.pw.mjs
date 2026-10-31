import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { OWNER_SCOPES, accessTokenFor, createPortalMock, TEST_TOTP_CODE, USER_ID } from './portal.mock.mjs';

// The real App, the real sign-in form, and a mocked pay service (portal.mock.mjs). Every figure and name is TEST data.
// With PORTAL_SHOTS_DIR set the run also writes a screenshot of each page, with a visible "mocked data" badge.
const shots = process.env.PORTAL_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
// The owner session is the one identity mints (no refund or payout scope); those come from "Confirm it's you".
const sessionFor = (scopes = OWNER_SCOPES) => ({
  userId: USER_ID,
  accessToken: accessTokenFor(scopes),
  refreshToken: 'portal-test-refresh',
  expiresAt: '2027-10-08T00:00:00Z',
});
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });

async function setup(page, scenario = 'active', options = {}) {
  const seen = [];
  page.on('request', (request) => request.url().includes('/api/') && seen.push(request.url()));
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable', message: 'The service is offline.' }),
    }),
  );
  await page.route('**/api/identity/trpc/auth.login', (route) => reply(route, sessionFor(options.scopes)));
  await page.route('**/api/identity/trpc/webauthn.list?*', (route) => reply(route, []));
  const mock = createPortalMock(scenario, options);
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
  const audit = await new AxeBuilder({ page }).include('[data-testid="pp"]').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(audit.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
};

test('dashboard: Home-style figures, daily chart, retained insights and phone width', async ({ page }) => {
  const { mock, seen } = await setup(page);
  await signIn(page, '/pay/merchant');
  await expect(page.getByRole('heading', { name: 'Business overview', level: 1 })).toHaveCount(1);
  await expect(page.getByTestId('plo-kpi-strip')).toBeVisible();
  await expect(page.getByText('4 s behind').first()).toBeVisible();
  // the big number is the USDT balance you can pay out, worked out from the settlements
  await expect(page.getByTestId('plo-balance-amount')).toHaveText(
    (Number(mock.world.balance('USDT').proceeds) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  );
  await page.getByRole('button', { name: '30 days', exact: true }).first().click();
  expect(mock.calls.some((c) => c.procedure === 'merchantMetrics.snapshot' && c.input.window.preset === 'rolling_30d')).toBe(true);
  // the daily chart is open when the page opens: no click needed
  await expect(page.getByTestId('plo-volume')).toBeVisible();
  // two assets are paid in, so the chart offers both; this check follows USDT
  await page.getByTestId('plo-volume').getByRole('group', { name: 'Asset' }).getByRole('button', { name: 'USDT', exact: true }).click();
  await expect(page.getByRole('img', { name: /Payment volume · USDT/ })).toBeVisible();
  await page.getByRole('button', { name: 'View data table', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Payment volume USDT', exact: true })).toBeVisible();
  await snap(page, '01-dashboard-desktop');
  await axe(page);
  expect(seen.filter((u) => /founderAdmin/i.test(u))).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await snap(page, '02-dashboard-phone');
});

test('dashboard: a new merchant sees how the first payment appears, not a wall of zeros', async ({ page }) => {
  await setup(page, 'quiet');
  await signIn(page, '/pay/merchant');
  await expect(page.getByRole('heading', { name: 'Your first payment starts here' })).toBeVisible();
  await expect(page.getByText('No balance to show yet')).toBeVisible();
  await expect(page.getByRole('link', { name: /Set up your account/ })).toHaveAttribute('href', '/pay/onboarding');
  await snap(page, '03-dashboard-empty');
});

test('dashboard: no merchant yet leads to setup; operations not switched on says "not connected yet"', async ({ page }) => {
  await setup(page, 'new');
  await signIn(page, '/pay/merchant');
  await expect(page.getByRole('heading', { name: 'No business account yet' })).toBeVisible();
  await snap(page, '04-dashboard-no-merchant');
  const soon = await page.context().newPage();
  await setup(soon, 'soon');
  await signIn(soon, '/pay/merchant');
  await expect(soon.getByText('Not connected here').first()).toBeVisible();
  await snap(soon, '05-dashboard-arrives-soon');
});

test('onboarding: verification then payout destination, with activation explicitly unconfirmed', async ({ page }) => {
  const { mock } = await setup(page, 'quiet');
  await signIn(page, '/pay/onboarding/verification');
  await expect(page.getByText('Step 2 of 3: Verification').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send for review' })).toBeDisabled();
  await page.getByLabel('Verification file reference *').fill('TEST-dossier-777');
  await snap(page, '06-onboarding-verification');
  await page.getByRole('button', { name: 'Send for review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review: Send for review' });
  await expect(dialog.getByText('TEST-dossier-777')).toBeVisible();
  await dialog.locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText('INTAFACED is reviewing it')).toBeVisible();
  expect(mock.calls.filter((c) => c.procedure === 'merchant.submitKyb')).toHaveLength(1);
  await page.getByRole('listitem').filter({ hasText: 'Step 3 of 3' }).getByRole('link', { name: 'Continue' }).click();
  const address = page.getByLabel('Wallet address *');
  await address.fill('0x123');
  await expect(page.getByText('This is not a valid address')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save destination' })).toBeDisabled();
  await address.fill(`0x${'ab'.repeat(20)}`);
  await snap(page, '07-onboarding-payout');
  await page.getByRole('button', { name: 'Save destination' }).click();
  await page.getByRole('dialog').getByLabel('6-digit code from your authenticator app *').fill(TEST_TOTP_CODE);
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText('Destination saved.', { exact: true })).toBeVisible();
  await expect(page.getByText('Waiting for your verification to be approved')).toBeVisible();
  await expect(page.getByText(/Saving a destination does not activate payments/).first()).toBeVisible();
  await snap(page, '08-onboarding-sandbox-summary');
});

test('onboarding: step 1 refuses to open an account while no starting fee is published', async ({ page }) => {
  await setup(page, 'new');
  await signIn(page, '/pay/onboarding/business');
  await expect(page.getByText('Step 1 of 3: Business details').first()).toBeVisible();
  await page.getByLabel('Legal business name *').fill('TEST Trading Ltd');
  await page.getByLabel('Country code *').fill('gb');
  await page.getByLabel('Type of business *').fill('Online shop');
  await page.getByLabel('Contact email *').fill('ops@test.invalid');
  await expect(page.getByText('Opening new accounts isn’t possible here')).toBeVisible();
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
  await expect(members.getByRole('row', { name: /TEST Accounts/ })).toBeVisible();
  await snap(page, '10-team');
  await members
    .getByRole('row', { name: /TEST Dev/ })
    .getByRole('link', { name: 'Open' })
    .click();
  await page.getByLabel('New role').selectOption('viewer');
  await page.getByRole('button', { name: 'Change role', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review: Change role' });
  await expect(dialog.getByText(/TEST Dev changes from Developer to Viewer/)).toBeVisible();
  await dialog.locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText('TEST Dev changed from Developer to Viewer')).toBeVisible();
  expect(mock.calls.find((c) => c.procedure === 'merchantOps.team.changeRole').input).toMatchObject({ role: 'viewer' });
  // A refusal from the service: words, not a code.
  await page.route('**/api/pay/trpc/merchantOps.team.invite', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'pay.team_interactive_only', data: { cause: { code: 'pay.team_interactive_only' } } } }),
    }),
  );
  await page.getByLabel('Email address *').fill('new.person@test.invalid');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText(/Team changes need a session verified with two-step sign-in/).first()).toBeVisible();
  await expect(page.getByText('pay.team_interactive_only')).toHaveCount(0);
  await axe(page);
});

test('team: invite by email shows the address as it will be sent, says they join after confirming, and lists it masked', async ({
  page,
}) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/team');
  const members = page.getByRole('region', { name: 'Members' });
  // An email invite already waiting is listed masked, never in full.
  await expect(members.getByText('Invited · p***@test.invalid')).toBeVisible();
  await expect(page.getByTestId('pp')).not.toContainText('pending.person@test.invalid');
  await page.getByLabel('Email address *').fill('  Priya.N@Test.INVALID ');
  await expect(page.getByText('The invitation goes to priya.n@test.invalid.')).toBeVisible();
  await page.getByLabel('Role *').selectOption('finance');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review: Send invitation' });
  await expect(
    dialog.getByText('Invite priya.n@test.invalid as Finance. They join after confirming that email and accepting.'),
  ).toBeVisible();
  await snap(page, '10b-team-invite-email-review');
  await dialog.locator('[data-testid="form-stack"] > button').last().click();
  await expect(
    page.getByText('Invitation sent to priya.n@test.invalid. They join after confirming that email and accepting.'),
  ).toBeVisible();
  const sent = mock.calls.find((c) => c.procedure === 'merchantOps.team.invite');
  expect(sent.input).toEqual({ email: 'priya.n@test.invalid', role: 'finance' });
  // The new invite joins the list masked, and the form is empty again.
  await expect(members.getByText('Invited · p***@test.invalid').first()).toBeVisible();
  await expect(page.getByLabel('Email address *')).toHaveValue('');
  await snap(page, '10c-team-invite-email-sent');
  await axe(page);
});

test('team: an invalid address is caught before sending; the account-id way stays available', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/team');
  await page.getByLabel('Email address *').fill('not an email');
  await expect(page.getByText('Enter one email address, with no spaces.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send invitation' })).toBeDisabled();
  await page.getByRole('button', { name: 'Invite by account ID instead' }).click();
  await page.getByLabel('Account ID *').fill('TEST-user-new');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect.poll(() => mock.calls.filter((c) => c.procedure === 'merchantOps.team.invite').length).toBe(1);
  expect(mock.calls.find((c) => c.procedure === 'merchantOps.team.invite').input).toEqual({ userId: 'TEST-user-new', role: 'viewer' });
});

test('team: when email invitations are switched off the refusal says so in plain words', async ({ page }) => {
  await setup(page, 'active', { emailInvites: 'off' });
  await signIn(page, '/pay/team');
  await page.getByLabel('Email address *').fill('priya.n@test.invalid');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText('Email invitations are switched off on this system.').first()).toBeVisible();
  await expect(page.getByText('pay.team_email_invite_unconfigured')).toHaveCount(0);
  await snap(page, '10d-team-invite-email-off');
});

test('team: pending invitations can be accepted or declined', async ({ page }) => {
  await setup(page, 'new');
  await signIn(page, '/pay/team');
  await expect(page.getByText('Invitation to join a team as Developer')).toBeVisible();
  await snap(page, '11-team-invitation');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText('Invitation to join a team as Developer')).toHaveCount(0);
});

test('disputes: filter in the URL, open one, upload evidence, then contest', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/disputes');
  await expect(page.getByTestId('pe-table').locator('tbody tr')).toHaveCount(3);
  await expect(page.getByText('No deadline').first()).toBeVisible();
  await snap(page, '12-disputes');
  await page.getByLabel('Status').selectOption('won');
  await expect(page).toHaveURL(/status=won/);
  await expect(page.getByTestId('pe-table').locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Status').selectOption('');
  await page.getByTestId('pe-table').getByRole('link', { name: 'Open', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Dispute', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Contest the dispute' })).toBeDisabled();
  await expect(page.getByText('Add at least one piece of evidence to contest.')).toBeVisible();
  const content = Buffer.from('TEST receipt contents');
  await page.getByLabel('File *').setInputFiles({ name: 'TEST-receipt.txt', mimeType: 'text/plain', buffer: content });
  await expect(page.getByText(/TEST-receipt\.txt · 21 B · ready/)).toBeVisible();
  await page.getByRole('button', { name: 'Add evidence', exact: true }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByRole('cell', { name: /TEST-receipt\.txt/ }).first()).toBeVisible();
  const sent = mock.calls.find((c) => c.procedure === 'merchantOps.disputes.uploadEvidence').input;
  expect(sent).toMatchObject({ fileName: 'TEST-receipt.txt', contentType: 'text/plain', contentBase64: content.toString('base64') });
  expect(sent.sha256).toBe(createHash('sha256').update(content).digest('hex'));
  await snap(page, '13-dispute-detail');
  await page.getByRole('button', { name: 'Contest the dispute' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
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
  await signIn(page, '/pay/reports/exports');
  await snap(page, '16-exports');
  await page.locator('#request select').first().selectOption('settlements');
  await page.getByRole('button', { name: 'Request a report', exact: true }).last().click();
  const dialog = page.getByRole('dialog', { name: 'Review: Request a report' });
  await expect(dialog.getByText('Settlements')).toBeVisible();
  await dialog.locator('[data-testid="form-stack"] > button').last().click();
  const jobs = page.getByRole('region', { name: 'Your report files' });
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
  expect((await download).suggestedFilename()).toBe('settlements.csv');
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
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
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
    await expect(page.getByRole('main').or(page.getByTestId('page')).first()).toBeVisible();
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
// the newest settlement (the one whose fee record is kept), and the one this person asked to pay out
const STL_NEWEST = 'bb000006-0000-4000-8000-000000000006';
const STL_OWN = 'bb000004-0000-4000-8000-000000000004';
const STL_FAILED = 'bb000005-0000-4000-8000-000000000005';

test('payments: totals with their period, filters the service applies, load more, export, and a phone layout', async ({ page }) => {
  const { mock, seen } = await setup(page);
  await signIn(page, '/pay/payments');
  await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
  const totals = page.getByRole('group', { name: 'Totals for Last 30 days' });
  await expect(totals).toBeVisible();
  await expect(totals.getByRole('link', { name: /Failed/ })).toHaveAttribute('href', /status=failed&date=30d/);
  await expect(page.getByText('Updated just now').first()).toBeVisible();
  const rows = page.getByTestId('pe-table').locator('tbody tr');
  await expect(rows).toHaveCount(25);
  await expect(page.getByText('25 shown · Load more')).toBeVisible();
  await snap(page, '20-payments-desktop');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(rows).toHaveCount(50);
  expect(mock.calls.filter((c) => c.procedure === 'payment.list').some((c) => c.input.cursor)).toBe(true);
  // every filter is asked of the service and lives in the address
  await page.getByLabel('Status').selectOption('failed');
  await expect(page).toHaveURL(/status=failed/);
  await expect.poll(() => mock.calls.some((c) => c.procedure === 'payment.list' && c.input.status === 'failed')).toBe(true);
  await page.getByLabel('Status').selectOption('');
  await page.getByLabel('Search', { exact: true }).fill('TEST-cust-001');
  await expect(page).toHaveURL(/q=TEST-cust-001/);
  await expect.poll(() => mock.calls.some((c) => c.procedure === 'payment.list' && c.input.search === 'TEST-cust-001')).toBe(true);
  await page.getByLabel('Search', { exact: true }).fill('no-such-thing');
  await expect(page.getByRole('heading', { name: 'No payments match these filters' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows.first()).toBeVisible();
  await page.getByLabel('Search', { exact: true }).fill('TEST-cust-001');
  await page.getByRole('button', { name: 'Export these results' }).click();
  await expect(page.getByRole('dialog')).toContainText('Search text isn’t part of an export');
  await page.keyboard.press('Escape');
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
  await expect(page.getByText('Your first payment starts here', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create payment link' }).last()).toHaveAttribute('href', '/pay/links/new');
  await snap(page, '22-payments-empty');
});

test('payment detail: facts, amounts, timeline, refunds, dispute card; never the payer instrument', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, `/pay/payments/${PAY_REFUNDED}`);
  await expect(page.getByRole('heading', { level: 2 }).first()).toContainText('Refunded');
  await expect(page.getByText('Still refundable')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Summary' })).toBeVisible();
  await expect(page.getByText('Fee rule')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Refunds' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('tok_TEST_must_never_show');
  await expect(page.locator('body')).not.toContainText('rail internals');
  await snap(page, '23-payment-detail');
  await go(page, `/pay/payments/${PAY_DISPUTED}`);
  await expect(page.getByRole('heading', { name: 'Dispute', level: 2 }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the dispute' })).toHaveAttribute(
    'href',
    '/pay/disputes/d0000001-0000-4000-8000-000000000001',
  );
  await snap(page, '24-payment-detail-disputed');
  await go(page, `/pay/payments/${PAY_SETTLED}`);
  await expect(page.getByRole('link', { name: 'The settlement this payment is in' })).toHaveAttribute(
    'href',
    `/pay/settlements/${mock.world.paymentById(PAY_SETTLED).settlementId}`,
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

test('settlements: a tile strip, server filters in the address, status words, and a statement that ties out', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/settlements');
  await expect(page.getByRole('heading', { name: 'Settlements', level: 1 })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Settlements at a glance' })).toBeVisible();
  const table = page.getByRole('region', { name: 'Settlements', exact: true });
  await expect(table.getByRole('row')).toHaveCount(7);
  await snap(page, '26-settlements');
  await page.getByLabel('Status').selectOption('failed');
  await expect(page).toHaveURL(/status=failed/);
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect
    .poll(() => mock.calls.some((c) => c.procedure === 'settlement.list' && c.input.status === 'failed' && c.input.limit === 25))
    .toBe(true);
  await page.getByLabel('Status').selectOption('');
  await go(page, `/pay/settlements/${STL_PAID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Settlement statement' })).toBeVisible();
  await expect(page.getByText('Checked: gross minus fees equals net, to the last decimal.')).toBeVisible();
  await expect(page.getByText(/No fee record is stored for this settlement/)).toBeVisible();
  await expect(page.getByText('TEST-tx-0xabc123')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Payments in this settlement' })).toBeVisible();
  await snap(page, '27-settlement-statement');
  await go(page, `/pay/settlements/${STL_NEWEST}`);
  await expect(page.getByText('How the fee was worked out')).toBeVisible();
  await expect(page.getByText('1.50%').first()).toBeVisible();
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await snap(page, '28-settlement-statement-phone');
});

test('payouts: named by destination and date, a status on every row, and a timeline that ends on the final state', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/payouts');
  await expect(page.getByRole('heading', { name: 'Payouts', level: 1 })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Payouts at a glance' })).toBeVisible();
  await expect(page.getByText(/Waiting for approval from your team/).first()).toBeVisible();
  await snap(page, '29-payouts');
  await page.getByLabel('Status').selectOption('paid_out');
  await expect(page).toHaveURL(/status=paid_out/);
  await expect(page.getByRole('region', { name: 'Payouts', exact: true }).getByRole('row')).toHaveCount(3);
  await go(page, `/pay/payouts/${STL_PAID}`);
  await expect(page.getByRole('heading', { name: /USDT/, level: 2 }).first()).toBeVisible();
  await expect(page.getByText('TEST-tx-0xabc123')).toBeVisible();
  await expect(page.getByText('Your daily payout limit')).toBeVisible();
  // rejected once, approved later, paid: every attempt in order and the final state last
  const trail = page.getByRole('list', { name: 'Payout history' }).getByRole('listitem');
  await expect(trail).toHaveCount(7);
  await expect(trail.nth(2)).toContainText('Rejected');
  await expect(trail.last()).toContainText('Paid out');
  await snap(page, '30-payout-detail-paid');
  await go(page, `/pay/payouts/${STL_FAILED}`);
  await expect(page.getByText('The payment network declined this payout.').first()).toBeVisible();
  // one banner, not two that disagree: the failure, with retry paused and a way to reach support
  await expect(page.getByText('The approval on this payout no longer counts')).toHaveCount(0);
  await expect(page.getByText('Retrying is paused while we fix a safety issue.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Contact support' })).toBeVisible();
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
  // the review names where the money goes, masked, and the exact amount
  await expect(dialog.getByText(/Wallet 0x7a3f…4421/)).toBeVisible();
  // the amount is the settlement's net, worked out from its payments
  await expect(
    dialog.getByText(
      new RegExp(
        mock.world
          .settlementById(STL_WAITING)
          .net.split('.')[0]
          .replace(/\B(?=(\d{3})+(?!\d))/g, ','),
      ),
    ),
  ).toBeVisible();
  await expect(dialog.getByText('Checked the destination')).toBeVisible();
  await dialog.locator('[data-testid="form-stack"] > button').last().click();
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
  // The seeded request on this payout was asked for by a teammate (so the owner can approve it); here it is the owner's own.
  mock.state.approvals.find((a) => a.settlementId === STL_OWN).makerUserId = USER_ID;
  await signIn(page, `/pay/payouts/${STL_OWN}`);
  await expect(page.getByRole('button', { name: 'Approve payout' })).toBeDisabled();
  await expect(page.getByText('You asked for this payout, so someone else on your team has to decide it.')).toBeVisible();
  await page.getByLabel('Reason for cancelling *').fill('Wrong amount');
  await page.getByRole('button', { name: 'Cancel my request' }).click();
  // taking a payout request back carries the payout scope, so it asks to confirm it's you first
  const asked = page.getByRole('dialog', { name: "Confirm it's you" });
  await asked.getByLabel('6-digit code from your authenticator app').fill(TEST_TOTP_CODE);
  await asked.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review: Cancel my request' }).locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText('The approval on this payout no longer counts')).toBeVisible();
  expect(mock.calls.find((c) => c.procedure === 'merchantControl.approvals.cancel').input).toMatchObject({ reason: 'Wrong amount' });
});

test('payout detail: an approved payout over what is left of today’s limit says so instead of offering to send it', async ({ page }) => {
  await setup(page);
  // Both seeded requests were asked for by a teammate, so the owner can approve them. This one is larger than what is left today.
  await signIn(page, `/pay/payouts/${STL_WAITING}`);
  await page.getByLabel('Your reason *').fill('Checked the destination');
  await page.getByRole('button', { name: 'Approve payout' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText('more than you have left of today’s payout limit, so it cannot be sent yet')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Send this payout' })).toHaveCount(0);
  // The other one fits under the limit, so the owner can approve it and go on to send it.
  await signIn(page, `/pay/payouts/${STL_OWN}`);
  await page.getByLabel('Your reason *').fill('Checked the destination');
  await page.getByRole('button', { name: 'Approve payout' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByRole('link', { name: 'Send this payout' }).first()).toBeVisible();
});

test('approvals: the queue with ages, where each payout goes, and a row that opens the request', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/approvals');
  await expect(page.getByRole('heading', { name: 'Payout approvals', level: 1 })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Approvals at a glance' })).toBeVisible();
  const table = page.getByRole('region', { name: 'Payout approvals', exact: true });
  await expect(table.getByRole('row')).toHaveCount(6);
  await expect(table.getByText(/Wallet 0x7a3f…4421 · Crypto network/).first()).toBeVisible();
  await expect(table.getByText(/Waiting/).first()).toBeVisible();
  await expect(table.getByText('You').first()).toBeVisible();
  await snap(page, '33-approvals');
  await page.getByLabel('Status').selectOption('pending');
  await expect(page).toHaveURL(/status=pending/);
  await expect(table.getByRole('row')).toHaveCount(3);
  await table.getByRole('link', { name: 'Open' }).first().click();
  await expect(page).toHaveURL(/\/pay\/payouts\/bb0000/);
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await snap(page, '36-approvals-phone');
});

test('payout detail: a refused decision is plain words, and a retry then goes through', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, `/pay/payouts/${STL_WAITING}`);
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
  await page.getByLabel('Your reason *').fill('Looks right');
  await page.getByRole('button', { name: 'Reject payout' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText(/The payout changed after you opened it, so your decision was not recorded/).first()).toBeVisible();
  await expect(page.getByText('pay.approval_payload_mismatch')).toHaveCount(0);
  await snap(page, '34-approvals-refused');
  await page.unroute('**/api/pay/trpc/merchantControl.approvals.decide');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Reject payout' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText('Rejected').first()).toBeVisible();
  expect(mock.calls.filter((c) => c.procedure === 'merchantControl.approvals.decide').at(-1).input).toMatchObject({ decision: 'reject' });
});

test('pricing: the fee table, the calculator uses the live engine, and an unconfigured account shows no fee at all', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/pricing');
  await expect(page.getByRole('heading', { name: 'Pricing and fees', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Prices for USDT' })).toBeVisible();
  await expect(page.getByText('1.50%').first()).toBeVisible();
  await expect(page.getByText('Pricing history').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Work out the fee' })).toBeDisabled();
  await page.getByLabel('Payment amount *').fill('-5');
  await expect(page.getByText('Enter an amount greater than zero').first()).toBeVisible();
  await page.getByLabel('Asset').selectOption('USDT');
  await page.getByLabel('Payment amount *').fill('100');
  await page.getByRole('button', { name: 'Work out the fee' }).click();
  await expect(page.getByRole('heading', { name: 'Result for 100.00 USDT' })).toBeVisible();
  // 1.50% of 100 plus a flat 0.30: the one fee rule every payment in the stand-in follows
  await expect(page.getByText('1.80').first()).toBeVisible();
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
  await expect(page.getByText('No pricing schedule is published for this account, so no price list is shown.')).toBeVisible();
  await expect(page.getByText('No tier assigned').first()).toBeVisible();
  await expect(page.getByText('The calculator works from a published pricing schedule')).toBeVisible();
  await expect(page.getByText(/\d\.\d\d%/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download schedule (CSV)' })).toHaveCount(0);
  await snap(page, '39-pricing-not-configured');
});

test('limits: usage bars with exact figures and reset times, and nothing invented for what is not set', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/limits');
  await expect(page.getByRole('heading', { name: 'Limits and tier', level: 1 })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(4);
  // today's intake is what the payments since midnight UTC add up to (the limit resets at midnight UTC)
  const usedToday =
    mock.world.figures(Math.floor(Date.now() / 86_400_000) * 86_400_000).captured.find((row) => row.assetCode === 'USDT')?.amount ?? '0';
  const [whole, fraction = ''] = usedToday.split('.');
  await expect(
    page
      .getByText(`${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction.replace(/0+$/, '') ? `.${fraction.replace(/0+$/, '')}` : ''}`)
      .first(),
  ).toBeVisible();
  await expect(page.getByText('What unlocks next')).toBeVisible();
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
  await expect(page.getByText('No limits are set for this account, so none are shown here.')).toBeVisible();
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

test('a page whose service is not switched on says what it is waiting for, and every money page survives an unreachable service', async ({
  page,
}) => {
  await setup(page, 'soon');
  await signIn(page, '/pay/pricing');
  await expect(page.getByTestId('pfo-soon').first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/coming soon|arrives soon/i);
  await go(page, '/pay/limits');
  await expect(page.getByTestId('pfo-soon').first()).toBeVisible();
  await go(page, '/pay/approvals');
  await expect(page.getByTestId('pfo-soon').first()).toBeVisible();
  await snap(page, '45-approvals-not-switched-on');
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
  await expect(page.getByRole('region', { name: 'Payout approvals', exact: true }).getByRole('row').nth(1)).toContainText('TEST Accounts');
});

test('payout detail: a decision that was voided meanwhile is shown as refused, never as success', async ({ page }) => {
  await setup(page);
  await signIn(page, `/pay/payouts/${STL_WAITING}`);
  await page.route('**/api/pay/trpc/merchantControl.approvals.decide', (route) =>
    json(route, {
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
    }),
  );
  await page.getByLabel('Your reason *').fill('Looks right');
  await page.getByRole('button', { name: 'Approve payout' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review: Approve payout' });
  await dialog.locator('[data-testid="form-stack"] > button').last().click();
  await expect(dialog.getByText('The request was voided because the payout changed, so your decision did not count.')).toBeVisible();
  await expect(page.getByText('The service confirmed the action')).toHaveCount(0);
  await snap(page, '46-approvals-voided-result');
});

test('payout detail: a request a teammate already approved waits on INTAFACED, and cannot be decided again', async ({ page }) => {
  await setup(page);
  const row = {
    approvalId: 'cc000009-0000-4000-8000-000000000009',
    merchantId: '11111111-1111-4111-8111-111111111111',
    settlementId: STL_WAITING,
    amount: '965.55',
    assetCode: 'USDT',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    status: 'pending',
    makerUserId: 'TEST-user-dev',
    checkerUserId: 'TEST-user-finance',
    createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    decidedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 40 * 3600_000).toISOString(),
    railId: 'crypto-native',
    destinationKind: 'crypto',
    destinationMasked: '0x7a3f…4421',
  };
  await page.route('**/api/pay/trpc/merchantControl.approvals.list*', (route) => json(route, { items: [row], nextCursor: null }));
  await signIn(page, `/pay/payouts/${STL_WAITING}`);
  await expect(page.getByText('Approved by TEST Accounts, waiting for INTAFACED’s sign-off.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve payout' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reject payout' })).toBeDisabled();
  await expect(page.getByText('A teammate has already approved this.')).toBeVisible();
  await snap(page, '47-approvals-waiting-on-intafaced');
});

test('payout detail: the clock ticks, so a request that expires while the page is open stops being decidable', async ({ page }) => {
  // the fake clock must be in place before the page starts its own timer
  await page.clock.install({ time: Date.now() });
  await setup(page);
  await signIn(page, `/pay/payouts/${STL_WAITING}`);
  await expect(page.getByText('Expires in').first()).toBeVisible();
  await page.getByLabel('Your reason *').fill('Looks right');
  await expect(page.getByRole('button', { name: 'Approve payout' })).toBeEnabled();
  await page.clock.fastForward('50:00:00');
  await expect(page.getByRole('button', { name: 'Approve payout' })).toBeDisabled();
  await expect(page.getByText('This request has expired. Ask for the payout again.').first()).toBeVisible();
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
  await expect(page.locator('[data-testid="pp-chip"]', { hasText: 'Approval unknown' }).first()).toBeVisible();
  await expect(page.locator('[data-testid="pp-chip"]', { hasText: 'Ready to pay out' })).toHaveCount(0);
  await snap(page, '49-payouts-approval-unknown');
  await go(page, `/pay/payouts/${STL_WAITING}`);
  await expect(page.locator('[data-testid="pp-chip"]', { hasText: 'Approval unknown' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve payout' })).toHaveCount(0);
});

test('finance can read payments, settlements and approvals, and is told links are owner-only', async ({ page }) => {
  // `myAccess: 'off'`: the service does not say what this member may do, so the portal works it out from the team read.
  await setup(page, 'active', { myAccess: 'off' });
  await page.route('**/api/pay/trpc/merchant.me*', (route) => json(route, null));
  await page.route('**/api/pay/trpc/merchantOps.team.me*', (route) =>
    json(route, { merchantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'finance' }),
  );
  await signIn(page, '/pay/payments');
  await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
  await expect(page.getByText('Only the account owner can open this page.')).toHaveCount(0);
  await snap(page, '50-payments-finance');
  for (const path of ['/pay/settlements', `/pay/payments/${PAY_SETTLED}`, `/pay/settlements/${STL_PAID}`]) {
    await go(page, path);
    await expect(page.getByText('Only the account owner can open this page.')).toHaveCount(0);
  }
  // Links are owner-only on the service, and the page says so up front.
  await go(page, '/pay/links');
  await expect(page.getByText('Only the account owner can open this page.')).toBeVisible();
  await go(page, '/pay/approvals');
  await expect(page.getByRole('region', { name: 'Payout approvals', exact: true })).toBeVisible();
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
