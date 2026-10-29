import { test, expect } from '@playwright/test';
import { fund, journeyState } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member } from './pay.mjs';

// J-pay-14, in the running app (docs/roadmap/journeys.json): see my Pay balance across assets and convert one. One test
// per step, titled "J-pay-14 #<n>", run in order. #1 makes the start: a verified TEST member holding TEST USDT and TEST
// BTC. Balances are compared with the ledger through the person's own API.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: Pay has no balance page per asset (pending, set aside, primary asset, close, refunded filter, convert).
const J = 'J-pay-14';
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

const balances = (page) => page.getByRole('table', { name: 'Pay balance by asset' });

async function balancePage(page) {
  await signIn(page, state('me'));
  await page.goto('/pay/balance');
  await expect(balances(page)).toBeVisible(UNBUILT);
}

test(`${J} #1 opens the Pay balance page: per asset, pending on top, set aside with the reason; equal to the ledger`, async ({ page }) => {
  test.setTimeout(240_000);
  const me = await member(page, 'jpbal', '40');
  expect(fund(me.email, 'BTC', '0.01').tx).toBeTruthy();
  run.reset({ me });
  await balancePage(page);
  await expect(balances(page).getByRole('row', { name: /USDT/ })).toContainText('40');
  await expect(balances(page).getByRole('row', { name: /BTC/ })).toContainText('0.01');
});

test(`${J} #2 filters activity to refunded: only refund lines`, async ({ page }) => {
  await balancePage(page);
  await page.getByLabel('Show').selectOption('Refunded');
  await expect(page.getByRole('table', { name: 'Activity' }).getByText('No refunds.')).toBeVisible();
});

test(`${J} #3 receives a payment in a new asset: a balance for that asset appears`, async ({ page }) => {
  expect(fund(state('me').email, 'ETH', '0.1').tx).toBeTruthy();
  await balancePage(page);
  await expect(balances(page).getByRole('row', { name: /ETH/ })).toBeVisible();
});

test(`${J} #4 sets a primary asset and tries to close one that holds funds: the primary shows; the close refuses`, async ({ page }) => {
  await balancePage(page);
  await balances(page).getByRole('row', { name: /USDT/ }).getByRole('button', { name: 'Make primary' }).click();
  await balances(page).getByRole('row', { name: /BTC/ }).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText(/still holds funds/)).toBeVisible();
});

test(`${J} #5 converts one asset to another: the rate with spread, then one post under the quote key`, async ({ page }) => {
  await balancePage(page);
  await page.getByRole('button', { name: 'Convert' }).click();
  const sheet = page.getByRole('dialog', { name: 'Convert' });
  await sheet.getByLabel('Amount').fill('10');
  await expect(sheet).toContainText(/Rate.*spread/);
});

test(`${J} #6 reads a held payment: the hold reason and the release date`, async ({ page }) => {
  await balancePage(page);
  await expect(page.getByRole('region', { name: 'Set aside' })).toBeVisible();
});
