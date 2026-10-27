import { test, expect } from '@playwright/test';
import { journeyState, toUnits } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member, usdt } from './pay.mjs';

// J-pay-08, in the running app (docs/roadmap/journeys.json): collect money from many people into a pool. One test per
// step, titled "J-pay-08 #<n>", run in order. #1 makes the start: a verified TEST organiser and two verified members
// holding TEST 20 USDT each. Balances are read through each person's own API.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: pools are not stored by any service, so there is no pool to create, share, contribute to, close or
//   withdraw from.
const J = 'J-pay-08';
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

const pool = (page) => page.getByRole('region', { name: 'Pool' });

async function contribute(page, who, amount) {
  await signIn(page, who);
  await page.goto(state('link'));
  await pool(page).getByLabel('Amount').fill(amount, UNBUILT);
  await pool(page).getByRole('button', { name: 'Contribute' }).click();
}

test(`${J} #1 creates a pool with a name, an end date and a goal: the pool page and a share link`, async ({ page }) => {
  test.setTimeout(300_000);
  const a = await member(page, 'jppa', '20');
  const b = await member(page, 'jppb', '20');
  const organiser = await member(page, 'jppo');
  run.reset({ organiser, a, b });
  await signIn(page, organiser);
  await page.goto('/pay/contacts');
  await page.getByRole('button', { name: 'New pool' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'New pool' });
  await sheet.getByLabel('Name').fill('TEST gift');
  await sheet.getByLabel('Goal (USDT)').fill('10');
  await sheet.getByLabel('Ends on').fill(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
  await sheet.getByRole('button', { name: 'Create pool' }).click();
  run.write({ link: (await pool(page).getByTestId('pool-link').innerText()).trim() });
});

test(`${J} #2 members contribute TEST 5 USDT each: the balance and contribution list match to the digit`, async ({ page }) => {
  await contribute(page, state('a'), '5');
  await contribute(page, state('b'), '5');
  await signIn(page, state('organiser'));
  await page.goto(state('link'));
  await expect(pool(page)).toContainText(/Collected\s*10 USDT/);
  await expect(pool(page).getByRole('table', { name: 'Contributions' }).locator('tbody tr')).toHaveCount(2);
});

test(`${J} #3 closes the pool early: new contributions refuse`, async ({ page, browser }) => {
  await signIn(page, state('organiser'));
  await page.goto(state('link'));
  await pool(page).getByRole('button', { name: 'Close pool' }).click(UNBUILT);
  const other = await (await browser.newContext()).newPage();
  await signIn(other, state('a'));
  await other.goto(state('link'));
  await expect(other.getByText('This pool is closed.')).toBeVisible();
  await other.context().close();
});

test(`${J} #4 withdraws: the balance moves to the organiser once`, async ({ page }) => {
  const organiser = state('organiser');
  const before = await usdt(organiser);
  await signIn(page, organiser);
  await page.goto(state('link'));
  await pool(page).getByRole('button', { name: 'Withdraw' }).dblclick(UNBUILT);
  expect(toUnits(await usdt(organiser)) - toUnits(before)).toBe(toUnits('10'));
});
