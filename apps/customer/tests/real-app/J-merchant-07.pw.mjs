import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, journeyState, tool } from './stack.mjs';
import { forgetSession, nextCode } from './identity-factors.mjs';
import {
  businessReadyPerson,
  openBusiness,
  paidCardPayment,
  payApiOf,
  refusedPayCalls,
  signInWithCode,
  verifiedBusiness,
} from './merchant.mjs';
import { tableIn } from './tables.mjs';

// J-merchant-07, in the running app (docs/roadmap/journeys.json): see the business's money and ask for a payout. One test
// per step, titled "J-merchant-07 #<n>", run in order on one verified TEST business. #1 makes the owner and the business
// and reads Money while it has none. The later steps need TEST settlements posted to it, a verified default destination
// and a finance teammate who can request but not send.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - The stack cannot post a TEST settlement to a business (`local-test-world.mjs merchant-settlement <merchantId>`,
//   proposed), so #2 and #6 to #8 have no settlement to pay out (M-money-out-05).
// - #3: the stack publishes no pricing schedule for a TEST business, so Pricing shows no fee table and the calculator
//   is off (`local-test-world.mjs merchant-pricing`, proposed).
// - #2: no clearing-to-available view (RC-merchant-10); #4: no payout schedule or rules (M-money-out-03,
//   M-adv-money-out-01); #5: no top-up (M-money-out-02).
const J = 'J-merchant-07';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

const saved = (who) => ({ handle: who.handle, email: who.email, password: who.password, secret: who.secret, step: who.step });

function journey() {
  const state = run.read();
  if (!state.owner?.secret) throw new Error(`${J} #1 made no business, so this step has no owner to act as`);
  return state;
}

async function signInOwner(page, destination) {
  const state = journey();
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = { ...state.owner, totp };
  await signInWithCode(page, who, destination);
  run.write({ owner: saved(who) });
  return { ...who, totp };
}

/** The owner's own pay API through Edge; the code's time step is kept for the next sign-in. */
async function ownerApi() {
  const state = journey();
  return payApiOf(state.owner, (step) => run.write({ owner: { ...state.owner, step } }));
}

/** The TEST settlement the stack posts to the business, read back as its row on Settlements. */
function postedSettlement() {
  const { merchantId } = journey();
  const out = tool('local-test-world.mjs', 'merchant-settlement', merchantId, '--net', '100', '--asset', 'USDT');
  return /settlement\s+([0-9a-f-]{36})/.exec(out)?.[1];
}

test(`${J} #1 opens Money: zero per asset with "No money yet" for a new business; with balances, clearing and available and a reserve card "recorded, not withheld"`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const owner = await businessReadyPerson(page, 'mm');
  const merchantId = await openBusiness(page, owner);
  await verifiedBusiness(page, owner, merchantId);
  run.reset({ owner: saved(owner), merchantId });
  await signInOwner(page, '/pay/money');
  const refused = refusedPayCalls(page);
  await expect(page.getByRole('heading', { name: 'Balances', level: 1 })).toBeVisible();
  await expect(page.getByText('No money yet')).toBeVisible();
  await expect(page.getByRole('group', { name: /Balances at a glance/ })).toHaveCount(0);

  // A TEST card payment, paid: it is captured, so it waits in clearing until a settlement makes it available.
  const api = await ownerApi();
  const paid = await paidCardPayment(api, merchantId, { key: `${J}:payment:clearing:${merchantId}`, amount: '40.00' });
  expect(paid.status).toBe('captured');
  // The balances follow the payment's events, so the page is read again until the payment shows.
  const balances = page.getByRole('group', { name: /Balances at a glance/ });
  await expect(async () => {
    await page.reload();
    await expect(balances).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await expect(balances.getByRole('link', { name: /^Clearing/ })).toContainText(/40(\.0+)?\s*USDT/);
  await expect(balances.getByRole('link', { name: /^Available to pay out/ })).toContainText(/Now\s*0(\.0+)?\s*USDT/);
  const all = page.getByRole('table', { name: 'All balances' });
  await expect(all.getByRole('row', { name: /USDT/ })).toContainText(/0(\.0+)?\s*USDT/);
  const reserve = page.getByRole('region', { name: 'Reserve' });
  await expect(reserve).toContainText('recorded, not withheld');
  await expect(reserve).toContainText('No reserve rule is set for your account.');
  expect(refused).toEqual([]);

  // A balance the page cannot read says so, and never reads as zero.
  await page.route('**/api/pay/trpc/merchantMetrics.snapshot**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { message: 'pay.metrics_balance_unavailable', code: -32603, data: { code: 'INTERNAL_SERVER_ERROR' } },
      }),
    }),
  );
  await page.reload();
  await expect(page.getByTestId('failure').first()).toBeVisible();
  await expect(page.getByRole('group', { name: /Balances at a glance/ })).toHaveCount(0);
  await expect(page.getByText('Available to pay out')).toHaveCount(0);
  await expect(page.getByText('No money yet')).toHaveCount(0);
  await page.unroute('**/api/pay/trpc/merchantMetrics.snapshot**');
});

test(`${J} #2 reads funds moving from clearing to available: funds wait until available, and a payout of clearing money is refused without moving it`, async ({
  page,
}) => {
  const settlement = postedSettlement();
  expect(settlement).toBeTruthy();
  run.write({ settlement });
  await signInOwner(page, '/pay/money');
  await expect(page.getByRole('group', { name: /Balances at a glance/ })).toContainText(/Clearing\s*100(\.0+)? USDT/);
});

test(`${J} #3 reads Pricing and Fees: the tier fee table, a calculator on the live engine; a blank tier fee reads "Not set" and refuses a total; payout "not charged" when so published`, async ({
  page,
}) => {
  await signInOwner(page, '/pay/pricing');
  await expect(page.getByRole('heading', { name: /Pricing/, level: 1 })).toBeVisible();
  const table = tableIn(page, /Fees/).first();
  await expect(table).toBeVisible(UNBUILT);
  for (const cell of await table.getByRole('cell').allInnerTexts()) expect(cell.trim()).not.toBe('');
  await page.getByRole('textbox', { name: /Payment amount/ }).fill('100');
  await page.getByRole('button', { name: 'Work out the fee' }).click();
  await expect(page.getByRole('main')).toContainText(/You receive|Not set/);
});

test(`${J} #4 opens the payout schedule and rules: manual by default or the next date after cut-off; changes with who and when; minimums disable the control with the reason`, async ({
  page,
}) => {
  await signInOwner(page, '/pay/payouts');
  const schedule = page.getByRole('region', { name: 'Payout schedule' });
  await expect(schedule).toContainText(/Manual|Next payout/, UNBUILT);
  await expect(tableIn(page, 'Schedule changes')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Payout rules' })).toContainText(/Minimum amount/);
});

test(`${J} #5 requests a top-up: with no rail "Top up is not set up for your account" and Request off; the balance is unchanged`, async ({
  page,
}) => {
  await signInOwner(page, '/pay/money');
  await page.getByRole('link', { name: 'Top up' }).click(UNBUILT);
  await expect(page.getByText('Top up is not set up for your account')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request' })).toBeDisabled();
});

test(`${J} #6 presses Pay out on a posted settlement: the whole net with no amount box, the destination and the approval rule`, async ({
  page,
}) => {
  const { settlement } = journey();
  expect(settlement, 'a TEST settlement from #2').toBeTruthy();
  await signInOwner(page, '/pay/settlements');
  const row = page
    .getByRole('region', { name: 'Settlements', exact: true })
    .getByRole('row')
    .filter({ hasText: settlement.slice(0, 8) });
  await row.getByRole('link', { name: 'Pay out' }).click();
  await expect(page.getByRole('textbox', { name: /Amount/ })).toHaveCount(0);
  await expect(page.getByLabel('Destination')).toHaveValue(/.+/);
  await expect(page.getByRole('main')).toContainText(/approval/i);
});

test(`${J} #7 confirms with a fresh step-up and sends: one payout with a receipt; a second inside the confirmation life does not ask again`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { settlement } = journey();
  expect(settlement, 'a TEST settlement from #2').toBeTruthy();
  const owner = await signInOwner(page, '/pay/payouts/new');
  await page.getByRole('button', { name: 'Pay out' }).click();
  const confirm = page.getByRole('dialog', { name: "Confirm it's you" });
  const { code, step } = await nextCode(owner.totp, owner.secret, owner.step);
  run.write({ owner: saved({ ...owner, step }) });
  await confirm.getByLabel('6-digit code from your authenticator app').fill(code);
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('The payout has been sent.')).toBeVisible();
  await expect(page.getByRole('link', { name: /receipt/i }).first()).toBeVisible();
  // A second payout inside the confirmation's life goes without asking again.
  const second = postedSettlement();
  expect(second).toBeTruthy();
  await page.goto('/pay/payouts/new');
  await page.getByRole('button', { name: 'Pay out' }).click();
  await expect(page.getByText('The payout has been sent.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: "Confirm it's you" })).toHaveCount(0);
});

test(`${J} #8 a finance teammate asks for the same: they request an approval and cannot send or refund; the owner approves`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  expect(postedSettlement(), 'a TEST settlement for the teammate to ask about').toBeTruthy();
  const finance = await businessReadyPerson(page, 'mfn', '/pay/merchant');
  await forgetSession(page);
  await signInOwner(page, '/pay/team');
  await page.getByRole('button', { name: 'Invite by account ID instead' }).click();
  await page.getByLabel('Account ID *').fill(finance.userId);
  await page.getByRole('combobox', { name: /^Role \*/ }).selectOption({ label: 'Finance' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await forgetSession(page);

  await signInWithCode(page, finance, '/pay/team');
  const accept = page.locator('li').filter({ hasText: 'Finance' }).getByRole('button', { name: 'Accept' }).first();
  await expect(async () => {
    await page.reload();
    await expect(accept).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await accept.click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await page.goto('/pay/payouts/new');
  await page.getByLabel('Destination').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Pay out' }).click();
  await expect(page.getByText('Your request is with your team for approval.').first()).toBeVisible();
  await page.goto('/pay/refunds');
  await expect(page.getByText('Only the account owner can refund payments.').first()).toBeVisible();
  await forgetSession(page);

  await signInOwner(page, '/pay/approvals');
  await page.getByLabel('Your reason *').fill('TEST checked the destination');
  await page.getByRole('button', { name: 'Approve payout' }).click();
  await expect(page.getByText('Approved, not sent yet').first()).toBeVisible();
});
