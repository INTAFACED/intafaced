import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member, sendNow, sendTo } from './pay.mjs';

// J-pay-06, in the running app (docs/roadmap/journeys.json): keep my contacts tidy, block a person, and recover from a
// wrong recipient. One test per step, titled "J-pay-06 #<n>", run in order. #1 makes the start: verified TEST members;
// the person holds TEST 50 USDT and pays a friend once on Send.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: Contacts lists the people this device has paid, but keeps no saved contacts ("Saved contacts, groups and pools
//   are not stored by any service").
// - #2: no phone contacts matching; #3, #4: no block or unblock.
// - #5: a payment's room offers no Cancel, Ask for a refund or Open a dispute ("Reporting a payment and getting it back
//   are not connected").
const J = 'J-pay-06';
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

test(`${J} #1 opens Contacts and recents: saved people and recent recipients; one tap opens Send prefilled`, async ({ page }) => {
  test.setTimeout(240_000);
  const friend = await member(page, 'jpcf');
  const me = await member(page, 'jpcm', '50');
  await signIn(page, me);
  await sendNow(page, friend.handle, '1', 'TEST hello');
  run.reset({ me, friend });
  await page.goto('/pay/contacts');
  const recent = page.getByRole('listitem').filter({ hasText: friend.handle });
  await expect(recent).toBeVisible();
  await recent.getByRole('link', { name: 'Send' }).click();
  await expect(page.getByLabel('Handle')).toHaveValue(new RegExp(friend.handle));
  await page.goto('/pay/contacts');
  await page.getByRole('button', { name: 'Add a contact' }).click(UNBUILT);
  await page.getByRole('dialog').getByLabel('Handle').fill(friend.handle);
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('region', { name: 'Saved contacts' })).toContainText(friend.handle);
});

test(`${J} #2 allows phone contacts matching: matches among members; with permission denied it says so and manual search works`, async ({
  page,
}) => {
  await signIn(page, state('me'));
  await page.goto('/pay/contacts');
  await page.getByRole('button', { name: 'Find people from my phone contacts' }).click(UNBUILT);
  await expect(page.getByText(/permission/i)).toBeVisible();
});

test(`${J} #3 blocks a person: they get the generic refusal for an unreachable user; recents drop them`, async ({ page, browser }) => {
  await signIn(page, state('me'));
  await page.goto('/pay/contacts');
  await page
    .getByRole('listitem')
    .filter({ hasText: state('friend').handle })
    .getByRole('button', { name: 'Block' })
    .click(UNBUILT);
  await expect(page.getByRole('listitem').filter({ hasText: state('friend').handle })).toHaveCount(0);
  const other = await (await browser.newContext()).newPage();
  await signIn(other, state('friend'));
  await sendTo(other, state('me').handle, '1');
  await expect(other.getByText(/can’t be paid/)).toBeVisible();
  await other.context().close();
});

test(`${J} #4 unblocks them: payments work again and no notice is sent`, async ({ page }) => {
  await signIn(page, state('me'));
  await page.goto('/pay/contacts?view=blocked');
  await page
    .getByRole('listitem')
    .filter({ hasText: state('friend').handle })
    .getByRole('button', { name: 'Unblock' })
    .click(UNBUILT);
  await expect(page.getByText(/No one is blocked/)).toBeVisible();
});

test(`${J} #5 opens a payment sent to the wrong person: Ask for a refund and Open a dispute are offered, Cancel is not`, async ({
  page,
}) => {
  await signIn(page, state('me'));
  await page.goto('/pay');
  await page
    .getByRole('link', { name: /receipt/i })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Ask for a refund' })).toBeVisible(UNBUILT);
  await expect(page.getByRole('button', { name: 'Open a dispute' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Cancel/ })).toHaveCount(0);
});
