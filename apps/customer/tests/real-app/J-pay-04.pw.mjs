import { test, expect } from '@playwright/test';
import { journeyState, mailedConfirmLinks, signUpInBrowser, toUnits, tool } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member, usdt } from './pay.mjs';

// J-pay-04, in the running app (docs/roadmap/journeys.json): pay someone who is not a member yet, and let them claim it
// or take it back. One test per step, titled "J-pay-04 #<n>", run in order on a verified TEST sender with TEST 40 USDT.
// The claim message goes through the stack's TEST mailbox; the claim window is the stack's TEST pay terms and lapses by
// the stack's TEST clock (`local-test-world.mjs pay-claim-expire`). Balances are read through each person's own API.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1 to #5: Send looks up handles only; it has no email or phone recipient, no "Not a member" invite, no unclaimed
//   send, and the claim room (/pay/claim/<token>) says "not connected".
const J = 'J-pay-04';
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

const stranger = (tag) => `jp4${tag}${Date.now().toString(36)}@local-test.invalid`;

/** Sends `amount` to an email that is not a member, and returns the send's reference. */
async function sendToEmail(page, email, amount) {
  await page.goto('/pay');
  await page.getByRole('tab', { name: 'Email or phone' }).click(UNBUILT);
  await page.getByLabel('Email or phone').fill(email);
  await page.getByLabel('Amount to send').fill(amount);
  await page.getByTestId('pay-review').click();
  await page.getByTestId('pay-send').click();
  return (await page.getByTestId('pay-receipt-reference').innerText()).trim();
}

test(`${J} #1 searches an email that is not a member: "Not a member" with an offer to invite`, async ({ page }) => {
  test.setTimeout(240_000);
  const sender = await member(page, 'jp4s', '40');
  run.reset({ sender, email: stranger('a') });
  await signIn(page, sender);
  await page.goto('/pay');
  await page.getByRole('tab', { name: 'Email or phone' }).click(UNBUILT);
  await page.getByLabel('Email or phone').fill(run.read().email);
  await page.getByLabel('Email or phone').press('Tab');
  await expect(page.getByText('Not a member')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite them' })).toBeVisible();
});

test(`${J} #2 sends TEST 15 USDT to that contact: the amount set aside and the send reads Unclaimed`, async ({ page }) => {
  const sender = state('sender');
  await signIn(page, sender);
  const before = await usdt(sender);
  run.write({ reference: await sendToEmail(page, state('email'), '15') });
  expect(toUnits(before) - toUnits(await usdt(sender))).toBe(toUnits('15'));
  await expect(page.getByText('Unclaimed')).toBeVisible();
});

test(`${J} #3 the recipient opens the claim link and signs up: the claim page, then Completed for both; one claim post`, async ({
  page,
  browser,
}) => {
  // #2's send to the contact comes first: without it there is no claim to mail.
  state('reference');
  const link = mailedConfirmLinks(state('email')).find((l) => l.includes('/pay/claim/'));
  expect(link, 'the claim message reached the TEST mailbox').toBeTruthy();
  const claimer = await (await browser.newContext()).newPage();
  const who = { handle: state('email').split('@')[0], email: state('email'), password: `TEST-${Date.now().toString(36)}-9a` };
  await signUpInBrowser(claimer, who);
  await claimer.goto(link);
  await claimer.getByRole('button', { name: 'Claim this payment' }).click();
  await expect(claimer.getByText('Completed')).toBeVisible();
  expect(await usdt(who)).toBe('15');
  await claimer.context().close();
  await signIn(page, state('sender'));
  await page.goto('/pay');
  await expect(page.getByText('Completed').first()).toBeVisible();
});

test(`${J} #4 the sender cancels before the claim: Cancelled and one return post; Cancel is offered first`, async ({ page }) => {
  const sender = state('sender');
  await signIn(page, sender);
  const before = await usdt(sender);
  await sendToEmail(page, stranger('b'), '5');
  await page.getByRole('button', { name: 'Cancel this payment' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel payment' }).click();
  await expect(page.getByText('Cancelled')).toBeVisible();
  expect(await usdt(sender)).toBe(before);
});

test(`${J} #5 nobody claims inside the window: the amount returns once and the sender sees why`, async ({ page }) => {
  const sender = state('sender');
  await signIn(page, sender);
  const before = await usdt(sender);
  const reference = await sendToEmail(page, stranger('c'), '5');
  tool('local-test-world.mjs', 'pay-claim-expire', reference);
  tool('local-test-world.mjs', 'pay-claim-expire', reference);
  expect(await usdt(sender)).toBe(before);
  await page.goto('/pay');
  await expect(page.getByText(/Returned: not claimed in time/)).toBeVisible();
});
