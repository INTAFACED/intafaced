import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createPortalMock, USER_ID } from '../portal.mock.mjs';

// The real App, the real sign-in form, and the mocked pay service (portal.mock.mjs). Every figure and name is TEST data.
const shots = process.env.PORTAL_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const session = {
  userId: USER_ID,
  accessToken: 'portal-test-only',
  refreshToken: 'portal-test-refresh',
  expiresAt: '2027-10-08T00:00:00Z',
};
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });

async function setup(page, scenario = 'active', options = {}) {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable', message: 'The service is offline.' }),
    }),
  );
  await page.route('**/api/identity/trpc/auth.login', (route) => reply(route, session));
  await page.route('**/api/identity/trpc/webauthn.list?*', (route) => reply(route, []));
  const mock = createPortalMock(scenario, options);
  await mock.install(page);
  return { mock };
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
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
}
const confirm = (page, title) =>
  page
    .getByRole('dialog', { name: `Review: ${title}` })
    .locator('.form-stack > button')
    .last()
    .click();

const STL_READY = 'bb000006-0000-4000-8000-000000000006';
const STL_WAITING = 'bb000003-0000-4000-8000-000000000003';
const STL_FAILED = 'bb000005-0000-4000-8000-000000000005';

test('destinations: choose the default, see a refusal in plain words, remove one that is free', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, '/pay/payouts/destinations');
  const tiles = page.getByRole('group', { name: 'Destinations at a glance' });
  await expect(tiles).toContainText('None chosen');
  const manage = page.getByRole('list', { name: 'Manage saved destinations' });
  const bank = manage.getByRole('listitem').filter({ hasText: '••••8821' });
  const wallet = manage.getByRole('listitem').filter({ hasText: '0x7a3f…4421' });
  await bank.getByRole('button', { name: 'Make default' }).click();
  await expect(page.getByRole('dialog')).toContainText('••••8821');
  await confirm(page, 'Make default');
  await expect(page.getByText('Default destination changed.')).toBeVisible();
  await expect(tiles).toContainText('••••8821');
  await expect(page.getByRole('region', { name: 'Saved destinations' }).getByRole('row').filter({ hasText: '••••8821' })).toContainText(
    'Default',
  );
  await snap(page, 'm1-destinations-default');
  // two payouts are waiting on the wallet: it cannot be removed yet, and the words say why
  await wallet.getByRole('button', { name: 'Remove' }).click();
  await confirm(page, 'Remove');
  await expect(page.getByRole('dialog')).toContainText('waiting for approval or still on its way');
  await expect(page.locator('body')).not.toContainText(/pay\.[a-z_]+/);
  await page.keyboard.press('Escape');
  // the bank account is free: removing the default leaves no default and does not promote the wallet
  await bank.getByRole('button', { name: 'Remove' }).click();
  await confirm(page, 'Remove');
  await expect(page.getByText('Destination removed.')).toBeVisible();
  await expect(tiles).toContainText('None chosen');
  await expect(manage.getByRole('listitem')).toHaveCount(1);
  expect(mock.calls.filter((c) => c.procedure === 'merchant.payoutDestinations.remove')).toHaveLength(2);
  await snap(page, 'm2-destinations-removed');
});

test('an approved payout can be sent: the page says so, the form is filled in, and sending uses the approval', async ({ page }) => {
  const { mock } = await setup(page);
  // The stand-in's waiting payout is bigger than today's payout limit on purpose; this test is about sending one that fits.
  const waiting = mock.world.settlementById(STL_WAITING);
  Object.assign(waiting, { gross: '1120.00', fees: '20.00', net: '1100.00' });
  mock.state.approvals.find((a) => a.settlementId === STL_WAITING).amount = '1100.00';
  await signIn(page, `/pay/payouts/${STL_WAITING}`);
  await page.getByLabel('Your reason *').fill('Checked the destination');
  await page.getByRole('button', { name: 'Approve payout' }).click();
  await confirm(page, 'Approve payout');
  await expect(page.getByText('The money has not been sent yet.')).toBeVisible();
  await expect(page.getByText('Approved, not sent yet').first().or(page.getByText('Approved').first())).toBeVisible();
  await snap(page, 'm3-payout-approved');
  await page.getByRole('link', { name: 'Send this payout' }).click();
  await expect(page).toHaveURL(/payouts\/new\?settlement=bb000003/);
  // the destination it was approved for is already chosen
  await expect(page.getByLabel('Destination')).toHaveValue(/.+/);
  await expect(page.getByText('Already approved to go to this destination.').first()).toBeVisible();
  await snap(page, 'm4-send-approved');
  await page.getByRole('button', { name: 'Send this payout' }).click();
  await confirm(page, 'Send this payout');
  await expect(page.getByText('The payout has been sent.')).toBeVisible();
  // it was sent on the approval, not asked for a second time
  expect(mock.calls.filter((c) => c.procedure === 'merchantControl.approvals.request')).toHaveLength(0);
  expect(mock.calls.filter((c) => c.procedure === 'settlement.payout')).toHaveLength(1);
  await go(page, `/pay/payouts/${STL_WAITING}`);
  await expect(page.getByText('Paid out').first()).toBeVisible();
});

test('the owner’s default destination is already chosen on the pay out form', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/payouts/destinations');
  const manage = page.getByRole('list', { name: 'Manage saved destinations' });
  await manage.getByRole('listitem').filter({ hasText: '••••8821' }).getByRole('button', { name: 'Make default' }).click();
  await confirm(page, 'Make default');
  await expect(page.getByText('Default destination changed.')).toBeVisible();
  await go(page, `/pay/payouts/new?settlement=${STL_READY}`);
  await expect(page.getByLabel('Destination')).toContainText('Default');
  await expect(page.getByLabel('Destination').locator('option:checked')).toContainText('••••8821');
});

test('Settlements, Payouts and Balances count the same: one ready, two waiting', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/settlements');
  await expect(page.getByRole('group', { name: 'Settlements at a glance' })).toContainText(/Ready to pay out\s*Now\s*1(?!\d)/);
  const rows = page.getByRole('region', { name: 'Settlements', exact: true }).getByRole('row');
  await expect(rows.filter({ hasText: 'Waiting for approval' })).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Ready to pay out' })).toHaveCount(1);
  await snap(page, 'm5-settlements');
  await go(page, '/pay/payouts');
  const payouts = page.getByRole('group', { name: 'Payouts at a glance' });
  await expect(payouts).toContainText(/Ready to pay out\s*Now\s*1(?!\d)/);
  await expect(payouts).toContainText(/Waiting for approval\s*Now\s*2(?!\d)/);
  await go(page, '/pay/money');
  const balances = page.getByRole('group', { name: /Balances at a glance/ });
  await expect(balances).toContainText(/Ready to pay out\s*Now\s*1(?!\d)/);
  await expect(balances).toContainText(/Waiting for approval\s*Now\s*2(?!\d)/);
  await snap(page, 'm6-balances');
  // paying the ready one out leaves nothing ready and still two waiting: nothing is counted twice
  await go(page, `/pay/payouts/new?settlement=${STL_READY}`);
  await page.getByLabel('Destination').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Pay out' }).click();
  await confirm(page, 'Pay out');
  await expect(page.getByText('The payout has been sent.')).toBeVisible();
  await go(page, '/pay/payouts');
  await expect(page.getByRole('group', { name: 'Payouts at a glance' })).toContainText(/Ready to pay out\s*Now\s*0(?!\d)/);
  await expect(page.getByRole('group', { name: 'Payouts at a glance' })).toContainText(/Waiting for approval\s*Now\s*2(?!\d)/);
});

test('limits show the tier ladder, with the merchant’s own tier marked', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/limits');
  await expect(page.getByRole('heading', { name: 'What unlocks next' })).toBeVisible();
  await expect(page.getByText('Growth (test)')).toBeVisible();
  await expect(page.getByText('Your tier', { exact: true })).toBeVisible();
  await expect(page.getByText('Limits not set yet')).toHaveCount(0);
  await snap(page, 'm7-limits-ladder');
});

test('the fee rate is the service’s own figure on Pricing and Fees', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/pricing');
  const actual = page
    .getByRole('region', { name: 'What you actually paid' })
    .or(page.locator('section', { hasText: 'What you actually paid' }));
  await expect(actual.first()).toContainText(/\d+\.\d\d+%/);
  await expect(actual.first()).toContainText('USDT');
  await snap(page, 'm8-pricing-rate');
  await go(page, '/pay/analytics/fees');
  await expect(page.getByText('worked out by INTAFACED from fees taken divided by what customers paid in.').first()).toBeVisible();
  await snap(page, 'm9-fees-rate');
});

test('a failed payout says what is known about the money and ends its history on the refusal', async ({ page }) => {
  await setup(page);
  await signIn(page, `/pay/payouts/${STL_FAILED}`);
  await expect(page.getByText('We can’t tell from this page whether the money is back in your USD balance.')).toBeVisible();
  const trail = page.getByRole('list', { name: 'Payout history' }).getByRole('listitem');
  await expect(trail.last()).toContainText('The payment network refused it');
  await expect(trail.nth(-2)).toContainText('Sent to the payment network');
  await expect(trail.last()).not.toContainText('Time not recorded');
  await expect(page.getByText('Bank account ••••8821').first()).toBeVisible();
  await snap(page, 'm10-payout-failed');
});

test('someone who did not ask for a payout is not offered to take the request back', async ({ page }) => {
  await setup(page);
  await signIn(page, `/pay/payouts/${STL_WAITING}`);
  await expect(page.getByRole('button', { name: 'Approve payout' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel my request' })).toHaveCount(0);
});

test('approvals and payouts name the same payout the same way', async ({ page }) => {
  await setup(page);
  const names = () =>
    page.locator('.pe-table tbody tr td:first-child').evaluateAll((cells) => cells.map((c) => c.innerText.split('\n')[0].trim()));
  await signIn(page, '/pay/payouts');
  await expect.poll(async () => (await names()).filter((n) => / · [A-Z][a-z]{2} \d/.test(n)).length).toBeGreaterThan(3);
  const payoutNames = await names();
  await go(page, '/pay/approvals');
  // the names settle once each payout's day is known
  await expect.poll(async () => (await names()).length).toBeGreaterThan(0);
  await expect.poll(async () => (await names()).every((n) => payoutNames.includes(n))).toBe(true);
});
