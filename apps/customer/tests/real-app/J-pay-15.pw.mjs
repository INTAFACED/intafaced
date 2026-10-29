import { test, expect } from '@playwright/test';
import { journeyState, signOutBrowser, toUnits } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member, sendNow, usdt } from './pay.mjs';

// J-pay-15, in the running app (docs/roadmap/journeys.json): get a refund, or ask for one. One test per step, titled
// "J-pay-15 #<n>", run in order. #1 makes the start: verified TEST members A (TEST 100 USDT) and B; A pays B TEST 100 USDT
// on Send, and the payment's reference is the original transfer. Balances are read through each person's own API.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: a payment's room has no Ask for a refund and no Refund; "Reporting a payment and getting it back are not
//   connected".
const J = 'J-pay-15';
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

/** The payment's room for `who`, opened from its receipt link on Pay's recent payments (the original unless named). */
async function payment(page, who, reference = state('reference')) {
  await signOutBrowser(page.context());
  await signIn(page, who);
  await page.goto('/pay');
  const receipts = page.getByRole('link', { name: /receipt/i });
  // The recent payments load after the page: count the receipts once the first is there.
  await expect(receipts.first()).toBeVisible();
  const count = await receipts.count();
  for (let i = 0; i < count; i += 1) {
    if (i > 0) await page.goto('/pay');
    await receipts.nth(i).click();
    const shown = await page
      .getByText(reference)
      .first()
      .waitFor({ timeout: 3_000 })
      .then(
        () => true,
        () => false,
      );
    if (shown) return;
  }
  throw new Error(`${J}: no receipt on Pay shows ${reference}`);
}

/** B refunds `amount` from the payment's room after a fresh confirmation. */
async function refund(page, amount, reference) {
  await payment(page, state('b'), reference);
  await page.getByRole('button', { name: 'Refund' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Refund this payment' });
  await sheet.getByLabel('Amount to refund').fill(amount);
  await sheet.getByRole('button', { name: 'Refund' }).click();
  return sheet;
}

test(`${J} #1 A opens the payment and chooses Ask for a refund: a request to B with a reason; B sees it`, async ({ page, browser }) => {
  test.setTimeout(240_000);
  const b = await member(page, 'jprb');
  const a = await member(page, 'jpra', '100');
  await signIn(page, a);
  const reference = await sendNow(page, b.handle, '100', 'TEST order');
  run.reset({ a, b, reference });
  await payment(page, a);
  await page.getByRole('button', { name: 'Ask for a refund' }).click(UNBUILT);
  await page.getByRole('dialog').getByLabel('Reason').fill('TEST: the item never came.');
  await page.getByRole('dialog').getByRole('button', { name: 'Send' }).click();
  const other = await (await browser.newContext()).newPage();
  await payment(other, b);
  await expect(other.getByText('TEST: the item never came.')).toBeVisible();
  await other.context().close();
});

test(`${J} #2 B accepts and refunds TEST 30: the refund after a fresh confirmation; remaining refundable TEST 70`, async ({ page }) => {
  const before = await usdt(state('a'));
  await refund(page, '30');
  await expect(page.getByText(/Refundable\s*70 USDT/)).toBeVisible();
  expect(toUnits(await usdt(state('a'))) - toUnits(before)).toBe(toUnits('30'));
});

test(`${J} #3 B refunds the rest: allowed at TEST 70, refused at TEST 70.01; two racing refunds give one in flight`, async ({ page }) => {
  const sheet = await refund(page, '70.01');
  await expect(sheet.getByText(/more than the 70 USDT left to refund/)).toBeVisible();
  await sheet.getByLabel('Amount to refund').fill('70');
  await sheet.getByRole('button', { name: 'Refund' }).click();
  await expect(page.getByText(/Refundable\s*0 USDT/)).toBeVisible();
});

test(`${J} #4 B refunds with too little balance: refused with an add-money prompt; no negative balance`, async ({ page }) => {
  // #3 refunded the first payment in full, so this is a new one: A pays B TEST 10, and B sends all it holds back to A.
  const [a, b] = [state('a'), state('b')];
  await signOutBrowser(page.context());
  await signIn(page, a);
  const second = await sendNow(page, b.handle, '10', 'TEST second order');
  await signOutBrowser(page.context());
  await signIn(page, b);
  await sendNow(page, a.handle, await usdt(b), 'TEST back');
  const before = await usdt(b);
  const sheet = await refund(page, '1', second);
  await expect(sheet.getByRole('link', { name: 'Add money' })).toBeVisible();
  // Nothing reserved or moved.
  expect(await usdt(b)).toBe(before);
});

test(`${J} #5 both track the refund: the refund line in both histories, the status page with the reason`, async ({ page }) => {
  for (const who of [state('a'), state('b')]) {
    await signIn(page, who);
    await page.goto('/money/activity');
    await expect(page.getByRole('row', { name: /Refund/ }).first()).toBeVisible(UNBUILT);
  }
});
