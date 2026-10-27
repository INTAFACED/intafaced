import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { OWNER_SCOPES, accessTokenFor, createPortalMock, TEST_TOTP_CODE, USER_ID } from '../portal.mock.mjs';

// The real App, the real sign-in form, and the mocked pay service (portal.mock.mjs). Every figure and name is TEST data.
const shots = process.env.PORTAL_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
// The owner session is the one identity mints: it never carries refund or payout. Those come from "Confirm it's you".
const sessionFor = (scopes = OWNER_SCOPES) => ({
  userId: USER_ID,
  accessToken: accessTokenFor(scopes),
  refreshToken: 'portal-test-refresh',
  expiresAt: '2027-10-08T00:00:00Z',
});
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });

async function setup(page, scenario = 'active', options = {}) {
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
    .locator('[data-testid="form-stack"] > button')
    .last()
    .click();

/** The "Confirm it's you" question: the TEST authenticator code, then Confirm. */
async function confirmItsYou(page, code = TEST_TOTP_CODE) {
  const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('6-digit code from your authenticator app').fill(code);
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
}
const askedDialog = (page) => page.getByRole('dialog', { name: "Confirm it's you" });
const STEP_UP_TOKEN = /^TEST-stepup\./;

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
  await confirmItsYou(page);
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
  await confirmItsYou(page);
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
    page
      .getByTestId('pe-table')
      .locator('tbody tr td:first-child')
      .evaluateAll((cells) => cells.map((c) => c.innerText.split('\n')[0].trim()));
  await signIn(page, '/pay/payouts');
  await expect.poll(async () => (await names()).filter((n) => / · [A-Z][a-z]{2} \d/.test(n)).length).toBeGreaterThan(3);
  const payoutNames = await names();
  await go(page, '/pay/approvals');
  // the names settle once each payout's day is known
  await expect.poll(async () => (await names()).length).toBeGreaterThan(0);
  await expect.poll(async () => (await names()).every((n) => payoutNames.includes(n))).toBe(true);
});

// ---- refunds and payouts: "Confirm it's you" -------------------------------------------------------------------------------

const REFUND_OWNER_ONLY = 'Only the account owner can refund payments.';
const PAYOUT_OWNER_ONLY = 'Only the account owner can send payouts.';
const PAYMENT = 'aa000001-0000-4000-8000-000000000001';

test('an owner whose session carries no refund or payout scope sees every money-out control on', async ({ page }) => {
  // Identity grants an owner pay:read, pay:write and pay:onboard only. Refund and payout come from confirming it's them.
  const { mock } = await setup(page);
  await signIn(page, '/pay/merchant');
  const overview = page.getByTestId('plo-actions');
  await expect(overview.getByRole('link', { name: 'Pay out' })).toBeVisible();
  await expect(overview.getByRole('link', { name: 'Refund' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/confirmed sign-in step|does not offer/);
  await snap(page, 'su1-overview-money-on');
  for (const [path, name] of [
    ['/pay/refunds', 'Issue a refund'],
    ['/pay/payouts', 'Pay out'],
    ['/pay/settlements', 'Pay out'],
  ]) {
    await go(page, path);
    await expect(page.getByRole('link', { name }).first(), path).toBeVisible();
  }
  // Nothing is asked until an action that moves money is opened.
  await expect(askedDialog(page)).toHaveCount(0);
  expect(mock.calls.filter((c) => c.procedure === 'auth.stepUpPay')).toHaveLength(0);
});

test('a finance teammate sees refunds off with who can, and the payout request on', async ({ page }) => {
  await setup(page, 'active', { role: 'finance', myAccess: 'finance' });
  await signIn(page, '/pay/refunds');
  await expect(page.getByRole('button', { name: 'Issue a refund' }).first()).toBeDisabled();
  await expect(page.getByText(REFUND_OWNER_ONLY).first()).toBeVisible();
  await snap(page, 'su2-refunds-owner-only');
  await go(page, '/pay/payouts');
  // asking for a payout follows the role's permission, which finance holds; sending one stays the owner's
  await expect(page.getByRole('link', { name: 'Pay out' }).first()).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/confirmed sign-in step|does not offer/);
});

test('a finance teammate asks for a payout approval after confirming it’s them, and still cannot send or refund', async ({ page }) => {
  const { mock } = await setup(page, 'active', { role: 'finance', myAccess: 'finance' });
  // A payout over the approval limit that fits today's payout limit, so asking for approval is the path.
  const ready = mock.world.settlementById(STL_READY);
  Object.assign(ready, { gross: '1120.00', fees: '20.00', net: '1100.00' });
  await signIn(page, `/pay/payouts/new?settlement=${STL_READY}`);
  await page.getByLabel('Destination').selectOption({ index: 1 });
  // asking is theirs to do: the control is on, and it asks to confirm it's them first
  await expect(page.getByText(PAYOUT_OWNER_ONLY)).toHaveCount(0);
  await page.getByRole('button', { name: 'Pay out' }).click();
  await confirmItsYou(page);
  await confirm(page, 'Pay out');
  await expect(page.getByText('Your request is with your team for approval.').first()).toBeVisible();
  const asked = mock.calls.filter((c) => c.procedure === 'merchantControl.approvals.request');
  expect(asked).toHaveLength(1);
  expect(asked[0].bearer).toMatch(STEP_UP_TOKEN);
  expect(mock.calls.filter((c) => c.procedure === 'settlement.payout')).toHaveLength(0);
  expect(mock.calls.find((c) => c.procedure === 'auth.stepUpPay').input.scopes).toEqual(['pay:payout']);
  // refunds stay the owner's
  await go(page, '/pay/refunds');
  await expect(page.getByRole('button', { name: 'Issue a refund' }).first()).toBeDisabled();
  await expect(page.getByText(REFUND_OWNER_ONLY).first()).toBeVisible();
});

test('a refund asks to confirm it’s you before the review, then sends with the confirmation token and nothing else does', async ({
  page,
}) => {
  const { mock } = await setup(page);
  await signIn(page, `/pay/refunds/new?payment=${PAYMENT}`);
  await page.getByLabel(/Refund amount/).fill('5');
  await page.getByRole('button', { name: 'Review refund' }).click();
  // asked first: no review yet, and nothing sent
  await expect(askedDialog(page)).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Review refund' })).toHaveCount(0);
  await expect(askedDialog(page)).toContainText("so we check it's you first");
  await snap(page, 'su3-confirm-its-you');
  await confirmItsYou(page);
  await expect(askedDialog(page)).toHaveCount(0);
  const review = page.getByRole('dialog', { name: 'Review refund' });
  await expect(review).toBeVisible();
  await snap(page, 'su4-refund-review');
  await review.getByRole('button', { name: 'Confirm refund' }).click();
  await expect(page.getByText('Refund recorded').first()).toBeVisible();
  const sent = mock.calls.filter((c) => c.procedure === 'payment.refund');
  expect(sent).toHaveLength(1);
  expect(sent[0].bearer).toMatch(STEP_UP_TOKEN);
  // the confirmation went to identity under the ordinary session, naming the business and one scope
  const minted = mock.calls.filter((c) => c.procedure === 'auth.stepUpPay');
  expect(minted).toHaveLength(1);
  expect(minted[0].bearer).not.toMatch(STEP_UP_TOKEN);
  expect(minted[0].input).toMatchObject({ scopes: ['pay:refund'], factorProof: { totpCode: TEST_TOTP_CODE } });
  expect(minted[0].input.merchantId).toMatch(/^[0-9a-f-]{36}$/);
  // no other call carried the token
  expect(mock.calls.filter((c) => c.procedure !== 'payment.refund' && STEP_UP_TOKEN.test(c.bearer ?? '')).map((c) => c.procedure)).toEqual(
    [],
  );
  // held in memory only, and never on the page
  const kept = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
  expect(kept).not.toContain('TEST-stepup');
  await expect(page.locator('body')).not.toContainText('TEST-stepup');
});

test('a payout sends after the confirmation, and a second payout action does not ask again within the confirmation’s life', async ({
  page,
}) => {
  const { mock } = await setup(page);
  await signIn(page, `/pay/payouts/new?settlement=${STL_READY}`);
  await page.getByLabel('Destination').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Pay out' }).click();
  await confirmItsYou(page);
  const review = page.getByRole('dialog', { name: 'Review: Pay out' });
  await expect(review).toBeVisible();
  // it says how long the confirmation lasts, in minutes, and nothing technical
  await expect(review).toContainText(/Confirmed for the next \d+ minutes?\./);
  await expect(review).not.toContainText(/TEST-stepup|expires|T\d\d:\d\d/);
  // close the review and open it again: the confirmation still holds, so it is not asked a second time
  await page.keyboard.press('Escape');
  await expect(review).toHaveCount(0);
  await page.getByRole('button', { name: 'Pay out' }).click();
  await expect(askedDialog(page)).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Review: Pay out' })).toBeVisible();
  await confirm(page, 'Pay out');
  await expect(page.getByText('The payout has been sent.')).toBeVisible();
  expect(mock.calls.filter((c) => c.procedure === 'auth.stepUpPay')).toHaveLength(1);
  const moneyCalls = mock.calls.filter((c) => /^(settlement\.payout|merchantControl\.approvals\.request)$/.test(c.procedure));
  expect(moneyCalls.length).toBeGreaterThan(0);
  for (const c of moneyCalls) expect(c.bearer, c.procedure).toMatch(STEP_UP_TOKEN);
  expect(
    mock.calls.filter(
      (c) => /^(settlement\.get|settlement\.list|merchantControl\.usage)$/.test(c.procedure) && STEP_UP_TOKEN.test(c.bearer ?? ''),
    ),
  ).toHaveLength(0);
  await snap(page, 'su5-payout-sent');
});

test('a confirmation that runs out between the review and the send is asked for again, and the same payout goes out', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, `/pay/payouts/new?settlement=${STL_READY}`);
  await page.getByLabel('Destination').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Pay out' }).click();
  await confirmItsYou(page);
  await expect(page.getByRole('dialog', { name: 'Review: Pay out' })).toBeVisible();
  // ten minutes pass while the review is open
  mock.stepUp.expireAll();
  await page.getByRole('dialog', { name: 'Review: Pay out' }).locator('[data-testid="form-stack"] > button').last().click();
  await expect(askedDialog(page)).toBeVisible();
  await expect(askedDialog(page)).toContainText('That confirmation expired. Confirm again.');
  await snap(page, 'su6-confirm-expired');
  await confirmItsYou(page);
  await expect(page.getByText('The payout has been sent.')).toBeVisible();
  const asks = mock.calls.filter((c) => c.procedure === 'merchantControl.approvals.request');
  expect(asks).toHaveLength(2);
  // the very same request, under a new confirmation
  expect(asks[1].input).toEqual(asks[0].input);
  expect(asks[0].bearer).not.toBe(asks[1].bearer);
  expect(mock.calls.filter((c) => c.procedure === 'auth.stepUpPay')).toHaveLength(2);
  expect(mock.calls.filter((c) => c.procedure === 'settlement.payout')).toHaveLength(1);
});

test('a refund whose confirmation ran out is confirmed again and sent again with the same refund reference', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, `/pay/refunds/new?payment=${PAYMENT}`);
  await page.getByLabel(/Refund amount/).fill('5');
  await page.getByRole('button', { name: 'Review refund' }).click();
  await confirmItsYou(page);
  const review = page.getByRole('dialog', { name: 'Review refund' });
  await expect(review).toBeVisible();
  mock.stepUp.expireAll();
  await review.getByRole('button', { name: 'Confirm refund' }).click();
  await expect(askedDialog(page)).toBeVisible();
  await expect(askedDialog(page)).toContainText('That confirmation expired. Confirm again.');
  await confirmItsYou(page);
  await expect(page.getByText('Refund recorded').first()).toBeVisible();
  const sent = mock.calls.filter((c) => c.procedure === 'payment.refund');
  expect(sent).toHaveLength(2);
  expect(sent[1].input).toEqual(sent[0].input);
  expect(sent[1].input.refundId).toMatch(/^refund:/);
  expect(sent[0].bearer).not.toBe(sent[1].bearer);
});

test('a wrong code is a plain retry message and keeps the person signed in', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, `/pay/payouts/new?settlement=${STL_READY}`);
  await page.getByLabel('Destination').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Pay out' }).click();
  await confirmItsYou(page, '123456');
  await expect(askedDialog(page)).toContainText("That code didn't match. Check your authenticator app and try again.");
  await expect(askedDialog(page)).not.toContainText(/auth\.|mfa_invalid/);
  await expect(page).not.toHaveURL(/login/);
  expect(mock.calls.filter((c) => /^(settlement\.payout|merchantControl\.approvals\.request)$/.test(c.procedure))).toHaveLength(0);
  // the right code then works, in the same question
  await askedDialog(page).getByLabel('6-digit code from your authenticator app').fill(TEST_TOTP_CODE);
  await askedDialog(page).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Review: Pay out' })).toBeVisible();
});

test('declining the question sends nothing and opens no review', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, `/pay/payouts/new?settlement=${STL_READY}`);
  await page.getByLabel('Destination').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Pay out' }).click();
  await askedDialog(page).getByRole('button', { name: 'Not now' }).click();
  await expect(askedDialog(page)).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Review: Pay out' })).toHaveCount(0);
  expect(
    mock.calls.filter(
      (c) => c.method !== 'GET' && /^(settlement\.payout|merchantControl\.approvals\.request|payment\.refund)$/.test(c.procedure),
    ),
  ).toHaveLength(0);
});

test('a role the service does not allow to refund is told so in plain words, and nothing is minted or sent', async ({ page }) => {
  const { mock } = await setup(page, 'active', { stepUp: 'role' });
  await signIn(page, `/pay/refunds/new?payment=${PAYMENT}`);
  await page.getByLabel(/Refund amount/).fill('5');
  await page.getByRole('button', { name: 'Review refund' }).click();
  await confirmItsYou(page);
  await expect(askedDialog(page)).toContainText('Your role on this business does not allow refunds. Ask the account owner.');
  await expect(askedDialog(page)).not.toContainText(/refunds\.create|pay\.role_not_allowed/);
  await snap(page, 'su7-role-not-allowed');
  expect(mock.stepUp.minted).toHaveLength(0);
  expect(mock.calls.filter((c) => c.procedure === 'payment.refund')).toHaveLength(0);
});

test('an API key or sub-account cannot confirm a payment, and the words say so', async ({ page }) => {
  await setup(page, 'active', { stepUp: 'keys' });
  await signIn(page, `/pay/payouts/new?settlement=${STL_READY}`);
  await page.getByLabel('Destination').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Pay out' }).click();
  await confirmItsYou(page);
  await expect(askedDialog(page)).toContainText('API keys and sub-accounts cannot confirm a payment.');
});

test('a passkey confirms it too, signing the challenge the service issued', async ({ page }) => {
  // A stand-in for the browser's passkey prompt: it answers with an assertion over the challenge it is given.
  await page.addInitScript(() => {
    const toBase64Url = (buffer) =>
      btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    const bytes = (text) => new TextEncoder().encode(text).buffer;
    navigator.credentials.get = async ({ publicKey }) => {
      const response = Object.create(AuthenticatorAssertionResponse.prototype);
      Object.defineProperties(response, {
        clientDataJSON: { value: bytes(JSON.stringify({ type: 'webauthn.get', challenge: toBase64Url(publicKey.challenge) })) },
        authenticatorData: { value: bytes('TEST-authenticator-data') },
        signature: { value: bytes('TEST-signature') },
        userHandle: { value: null },
      });
      const credential = Object.create(PublicKeyCredential.prototype);
      Object.defineProperties(credential, {
        id: { value: toBase64Url(bytes('TEST-credential')) },
        rawId: { value: bytes('TEST-credential') },
        response: { value: response },
        getClientExtensionResults: { value: () => ({}) },
      });
      return credential;
    };
  });
  const { mock } = await setup(page);
  await signIn(page, `/pay/payouts/new?settlement=${STL_READY}`);
  await page.getByLabel('Destination').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Pay out' }).click();
  await askedDialog(page).getByRole('button', { name: 'Use a passkey' }).click();
  await expect(page.getByRole('dialog', { name: 'Review: Pay out' })).toBeVisible();
  const minted = mock.calls.filter((c) => c.procedure === 'auth.stepUpPay');
  expect(minted).toHaveLength(1);
  expect(minted[0].input.factorProof).toHaveProperty('webauthn');
  expect(mock.calls.filter((c) => c.procedure === 'auth.stepUpOptions')).toHaveLength(1);
  await confirm(page, 'Pay out');
  await expect(page.getByText('The payout has been sent.')).toBeVisible();
});

test('the confirmation survives moving about inside the portal and is forgotten once the portal is left', async ({ page }) => {
  const { mock } = await setup(page);
  await signIn(page, `/pay/payouts/new?settlement=${STL_READY}`);
  await page.getByLabel('Destination').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Pay out' }).click();
  await confirmItsYou(page);
  await page.keyboard.press('Escape');
  // moving about inside the portal keeps it...
  await go(page, `/pay/payouts/new?settlement=${STL_READY}`);
  await page.getByLabel('Destination').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Pay out' }).click();
  await expect(askedDialog(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  // ...leaving it for good does not
  await go(page, '/pay/not-a-page');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await go(page, `/pay/payouts/new?settlement=${STL_READY}`);
  await expect(page.getByLabel('Destination')).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Destination').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Pay out' }).click();
  await expect(askedDialog(page)).toBeVisible();
  expect(mock.calls.filter((c) => c.procedure === 'auth.stepUpPay')).toHaveLength(1);
});

test('Pricing shows the account’s rate or says there is none, and a failed read can be tried again', async ({ page }) => {
  await setup(page);
  // the account read fails at first
  let fail = true;
  await page.route('**/api/pay/trpc/merchant.me**', (route) =>
    fail
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'down' } }) })
      : route.fallback(),
  );
  await signIn(page, '/pay/pricing');
  await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
  await expect(page.getByText('Can’t be shown right now').first()).toBeVisible();
  await snap(page, 'su8-pricing-failed');
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).first().click();
  await expect(page.getByText('Starter fee 1.50% (TEST value) — taken when a payment settles').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('one fee story, and the Today tiles name their UTC day', async ({ page }) => {
  await setup(page);
  await signIn(page, '/pay/merchant');
  await expect(page.getByText('Starter fee 1.50% (TEST value) — taken when a payment settles')).toBeVisible();
  const day = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  await expect(page.getByText(`Today (UTC): ${day}`).first()).toBeVisible();
  await go(page, '/pay/pricing');
  await expect(page.getByText('Starter fee 1.50% (TEST value) — taken when a payment settles')).toBeVisible();
  await expect(page.getByText('INTAFACED has not published pricing')).toHaveCount(0);
  await go(page, '/pay/money');
  await expect(page.getByText(`Today (UTC): ${day}`).first()).toBeVisible();
  for (const path of ['/pay/merchant', '/pay/pricing', `/pay/payments/${PAYMENT}`, '/pay/limits']) {
    await go(page, path);
    await expect(page.locator('main')).not.toContainText(/\bbps\b|basis points|\byet\b.*(not set|no tier)/i);
  }
});
