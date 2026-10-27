import { test, expect } from '@playwright/test';
import { journeyState, toUnits, tool } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member, usdt } from './pay.mjs';

// J-pay-11, in the running app (docs/roadmap/journeys.json): track, add and pay a bill or an invoice. One test per step,
// titled "J-pay-11 #<n>", run in order on one verified TEST member with TEST 100 USDT. The biller network is a bank and
// card rail; on the stack its port is unset, so a biller search refuses with the rail notice. Invoices and biller
// returns come from the stack's TEST bill world (`local-test-world.mjs pay-invoice|bill-return`).
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #2: the Bills form is switched off as a whole ("Bill pay isn’t connected"), so there is no biller search to refuse.
// - #3 to #6: no invoice sent to a member, no bill to pay, no return, no hide and restore; the stack has no bill world.
const J = 'J-pay-11';
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

const bills = (page) => page.getByTestId('bills-card');

test(`${J} #1 opens Bills from navigation: the Bills room with its own layout and an honest empty list`, async ({ page }) => {
  test.setTimeout(240_000);
  const payer = await member(page, 'jpb', '100');
  run.reset({ payer });
  await signIn(page, payer);
  await page.goto('/pay');
  await page.getByRole('link', { name: 'Bill pay' }).first().click();
  await expect(page).toHaveURL(/\/pay\/bills$/);
  await expect(bills(page)).toBeVisible();
  await expect(bills(page).getByLabel('Biller')).toBeVisible();
  await expect(bills(page).getByText('No bills paid yet.')).toBeVisible();
});

test(`${J} #2 searches for a biller and adds a bill: with the biller port unset, the rail notice and nothing written`, async ({ page }) => {
  await signIn(page, state('payer'));
  await page.goto('/pay/bills');
  const biller = bills(page).getByLabel('Biller');
  await expect(biller).toBeEnabled(UNBUILT);
  await biller.fill('TEST Electric');
  await expect(bills(page).getByText(/biller network isn’t connected/)).toBeVisible();
});

test(`${J} #3 opens an invoice sent to them: lines and total; paying from balance posts once`, async ({ page }) => {
  const payer = state('payer');
  const invoice = JSON.parse(tool('local-test-world.mjs', 'pay-invoice', payer.email, '--total', '20'));
  run.write({ invoiceId: invoice.id });
  await signIn(page, payer);
  await page.goto(`/pay/bills/invoices/${encodeURIComponent(invoice.id)}`);
  await expect(page.getByRole('table', { name: 'Invoice lines' })).toBeVisible(UNBUILT);
  const before = await usdt(payer);
  await page.getByRole('button', { name: 'Pay from balance' }).dblclick();
  await expect(page.getByText('Paid')).toBeVisible();
  expect(toUnits(before) - toUnits(await usdt(payer))).toBe(toUnits('20'));
});

test(`${J} #4 pays a bill: submitted, then paid with the provider reference; an unaffordable bill refused before the rail`, async ({
  page,
}) => {
  await signIn(page, state('payer'));
  await page.goto('/pay/bills');
  await expect(page.getByTestId('bills-review')).toBeEnabled(UNBUILT);
});

test(`${J} #5 the biller returns the payment: returned and one reversal; a second delivery posts nothing`, async () => {
  const payer = state('payer');
  const before = await usdt(payer);
  tool('local-test-world.mjs', 'bill-return', state('invoiceId'));
  tool('local-test-world.mjs', 'bill-return', state('invoiceId'));
  expect(toUnits(await usdt(payer)) - toUnits(before)).toBe(toUnits('20'));
});

test(`${J} #6 hides a bill, then restores it: it leaves the list and comes back`, async ({ page }) => {
  await signIn(page, state('payer'));
  await page.goto('/pay/bills');
  const row = bills(page).getByRole('row', { name: new RegExp(state('invoiceId')) });
  await row.getByRole('button', { name: 'Hide' }).click(UNBUILT);
  await expect(row).toHaveCount(0);
  await bills(page).getByRole('button', { name: 'Show hidden' }).click();
  await bills(page)
    .getByRole('row', { name: new RegExp(state('invoiceId')) })
    .getByRole('button', { name: 'Restore' })
    .click();
  await expect(bills(page).getByRole('row', { name: new RegExp(state('invoiceId')) })).toBeVisible();
});
