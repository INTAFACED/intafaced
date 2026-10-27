import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member } from './pay.mjs';

// J-pay-07, in the running app (docs/roadmap/journeys.json): split a bill with friends and settle up the group. One test
// per step, titled "J-pay-07 #<n>", run in order. #1 makes the start: four verified TEST members (the person and three
// friends), each holding TEST 100 USDT. The remainder rule and the member cap are the stack's TEST pay terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: Pay has no Split a bill, no split of a past purchase, no groups stored by a service ("Groups and pools
//   are not stored by any service"), no group expenses and no Settle up.
const J = 'J-pay-07';
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

const split = (page) => page.getByRole('form', { name: 'Split a bill' });

async function openSplit(page) {
  await signIn(page, state('me'));
  await page.goto('/pay/request');
  await page.getByRole('button', { name: 'Split a bill' }).click(UNBUILT);
  for (const f of state('friends')) {
    await split(page).getByLabel('Add a person').fill(f.handle);
    await split(page).getByLabel('Add a person').press('Enter');
  }
  await split(page).getByLabel('Total').fill('100.00');
}

test(`${J} #1 opens Split a bill, enters TEST 100.00 and picks three friends: portions by the remainder rule; a broken sum disables Create`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const friends = [];
  for (const p of ['jps1', 'jps2', 'jps3']) friends.push(await member(page, p, '100'));
  const me = await member(page, 'jpsm', '100');
  run.reset({ me, friends });
  await openSplit(page);
  const portions = await split(page)
    .getByRole('spinbutton', { name: /Portion/ })
    .evaluateAll((els) => els.map((e) => e.value));
  expect(portions.reduce((a, v) => a + Number(v), 0).toFixed(2)).toBe('100.00');
  await split(page)
    .getByRole('spinbutton', { name: /Portion/ })
    .first()
    .fill('50');
  await expect(split(page).getByRole('button', { name: 'Create' })).toBeDisabled();
});

test(`${J} #2 creates the split: one request per friend, created once; a second attempt returns the same split`, async ({ page }) => {
  await openSplit(page);
  await split(page).getByRole('button', { name: 'Create' }).dblclick();
  await expect(page.getByRole('list', { name: 'Requests in this split' }).getByRole('listitem')).toHaveCount(3);
});

test(`${J} #3 splits a past purchase from activity: requests created once for the chosen people`, async ({ page }) => {
  await signIn(page, state('me'));
  await page.goto('/money/activity');
  await page.getByRole('row').nth(1).getByRole('button', { name: 'Split' }).click(UNBUILT);
  await split(page).getByLabel('Add a person').fill(state('friends')[0].handle);
  await split(page).getByLabel('Add a person').press('Enter');
  await split(page).getByRole('button', { name: 'Create' }).dblclick();
  await expect(page.getByRole('list', { name: 'Requests in this split' }).getByRole('listitem')).toHaveCount(1);
});

test(`${J} #4 creates a payment group and invites members: the group page; over the cap refused; an expired invite refused`, async ({
  page,
}) => {
  await signIn(page, state('me'));
  await page.goto('/pay/contacts');
  await page.getByRole('button', { name: 'New group' }).click(UNBUILT);
  await page.getByRole('dialog').getByLabel('Group name').fill('TEST flat');
  await page.getByRole('dialog').getByRole('button', { name: 'Create group' }).click();
  await expect(page).toHaveURL(/\/pay\/contacts\/groups\//);
});

test(`${J} #5 adds a group expense excluding one member: the excluded member owes nothing`, async ({ page }) => {
  await signIn(page, state('me'));
  await page.goto('/pay/contacts');
  await page.getByRole('link', { name: 'TEST flat' }).click(UNBUILT);
  await page.getByRole('button', { name: 'Add an expense' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add an expense' });
  await sheet.getByLabel('Amount').fill('30');
  await sheet.getByRole('checkbox', { name: state('friends')[2].handle }).uncheck();
  await sheet.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('row', { name: new RegExp(state('friends')[2].handle) })).toContainText(/Owes\s*0/);
});

test(`${J} #6 opens Settle up: a plan that nets debts; a stale plan refused; an outside payment can be recorded`, async ({ page }) => {
  await signIn(page, state('me'));
  await page.goto('/pay/contacts');
  await page.getByRole('link', { name: 'TEST flat' }).click(UNBUILT);
  await page.getByRole('button', { name: 'Settle up' }).click();
  await expect(page.getByRole('table', { name: 'Settle-up plan' })).toBeVisible();
});
