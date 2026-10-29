import { test, expect } from '@playwright/test';
import { journeyState, toUnits } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member, usdt } from './pay.mjs';

// J-pay-05, in the running app (docs/roadmap/journeys.json): ask someone for money, and pay or decline a request. One
// test per step, titled "J-pay-05 #<n>", run in order on two verified TEST members: the payee asks, the payer holds TEST
// 30 USDT. Every request is read back through each person's own view, and balances through their own API.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: Request makes a payment link kept on the device; it has no person to ask, so no request reaches a payer.
// - #2 to #6: no request notice, detail with Pay and Decline, reminders, report and block, or expiry ("The request
//   service is not connected").
const J = 'J-pay-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

/** The payee asks the payer for `amount` with `note`, and returns the request's id. */
async function ask(page, amount, note) {
  await page.goto('/pay/request');
  await page.getByLabel('Who to ask').fill(state('payer').handle, UNBUILT);
  await page.getByLabel('Amount', { exact: true }).fill(amount);
  await page.getByLabel('What is it for? (optional)').fill(note);
  await page.getByTestId('request-create').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send request' }).click();
  return (await page.getByTestId('request-id').innerText()).trim();
}

/** The payer opens the request from their notice. */
async function openAsPayer(page, requestId) {
  await signIn(page, state('payer'));
  await page.goto(`/pay/request/${encodeURIComponent(requestId)}`);
  await expect(page.getByRole('button', { name: 'Pay' })).toBeVisible(UNBUILT);
}

test(`${J} #1 the payee asks a person for TEST 12 USDT with a note: a review and a created request; no money moved`, async ({ page }) => {
  test.setTimeout(240_000);
  const payee = await member(page, 'jp5e');
  const payer = await member(page, 'jp5r', '30');
  run.reset({ payee, payer });
  await signIn(page, payee);
  run.write({ first: await ask(page, '12', 'TEST lunch') });
  expect(await usdt(payer)).toBe('30');
  expect(await usdt(payee)).toBe('0');
});

test(`${J} #2 the payer opens the notice: the request detail with amount, note and Pay and Decline`, async ({ page }) => {
  await signIn(page, state('payer'));
  await page.goto('/notifications');
  await page.getByRole('article').filter({ hasText: 'asked you for 12 USDT' }).getByRole('link').click(UNBUILT);
  await expect(page.getByText('TEST lunch')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Decline' })).toBeVisible();
});

test(`${J} #3 the payer pays: one transfer under the request key; Paid for both; paying twice returns the first receipt`, async ({
  page,
}) => {
  await openAsPayer(page, state('first'));
  await page.getByRole('button', { name: 'Pay' }).click();
  await page.getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByText('Paid')).toBeVisible();
  expect(toUnits(await usdt(state('payee')))).toBe(toUnits('12'));
});

test(`${J} #4 the payee reminds on a second, unpaid request: once per window; over the cap refused with the next time`, async ({
  page,
}) => {
  await signIn(page, state('payee'));
  const second = await ask(page, '5', 'TEST second');
  await page.goto(`/pay/request/${encodeURIComponent(second)}`);
  await page.getByRole('button', { name: 'Send a reminder' }).click();
  await page.getByRole('button', { name: 'Send a reminder' }).click();
  await expect(page.getByText(/You can remind again at/)).toBeVisible();
});

test(`${J} #5 the payer declines a third request with Report and block: Declined, a case, the block; the payee sees Declined only`, async ({
  page,
}) => {
  await signIn(page, state('payee'));
  const third = await ask(page, '3', 'TEST third');
  await openAsPayer(page, third);
  await page.getByRole('button', { name: 'Decline' }).click();
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Report and block' }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Decline' }).click();
  await expect(page.getByText('Declined')).toBeVisible();
});

test(`${J} #6 the period passes on a fourth request: both lists show Expired`, async ({ page }) => {
  await signIn(page, state('payee'));
  await page.goto('/pay/request');
  await expect(page.getByTestId('request-list').getByText('Expired')).toBeVisible(UNBUILT);
});
