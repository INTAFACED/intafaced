import { test, expect } from '@playwright/test';
import { journeyState, toUnits } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member, sendNow, sendTo, usdt } from './pay.mjs';

// J-pay-13, in the running app (docs/roadmap/journeys.json): pay from my bank or card, and send as a gift or as a
// purchase. One test per step, titled "J-pay-13 #<n>", run in order. #1 makes the start: verified TEST members, the
// person holding TEST 10 USDT. Bank and card sources are rails; on the stack they are unset, so a send that needs one
// shows the rail notice.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: Pay preferences are not stored by any service, so the funding sources list is off.
// - #3, #4: Send has no bank or card source, and the stack has no TEST bank rail.
// - #5: Send has no business or gift type.
const J = 'J-pay-13';
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

test(`${J} #1 opens funding source preferences: the ordered sources; with none, an honest empty state`, async ({ page }) => {
  test.setTimeout(240_000);
  const friend = await member(page, 'jpff');
  const me = await member(page, 'jpfm', '10');
  run.reset({ me, friend });
  await signIn(page, me);
  await page.goto('/pay/preferences');
  await expect(page.getByRole('heading', { name: 'Pay preferences', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Pay from')).toBeEnabled(UNBUILT);
});

test(`${J} #2 sends an amount the balance covers: the balance is used first`, async ({ page }) => {
  const me = state('me');
  const before = await usdt(me);
  await signIn(page, me);
  await sendNow(page, state('friend').handle, '2');
  expect(toUnits(before) - toUnits(await usdt(me))).toBe(toUnits('2'));
  await expect(page.getByTestId('pay-receipt')).toContainText(/From\s*(your )?balance/i, UNBUILT);
});

test(`${J} #3 sends an amount that needs the bank: with the rail unset, the rail notice and nothing written`, async ({ page }) => {
  await signIn(page, state('me'));
  await sendTo(page, state('friend').handle, '50');
  await expect(page.getByText(/bank isn’t connected/)).toBeVisible(UNBUILT);
});

test(`${J} #4 the rail returns the pull: returned and one reversal`, async ({ page }) => {
  await signIn(page, state('me'));
  await page.goto('/pay');
  await expect(page.getByText('Returned')).toBeVisible(UNBUILT);
});

test(`${J} #5 sends to a business, then to a friend with a gift toggle: purchase fixed; no purchase for a person; gifts not configured`, async ({
  page,
}) => {
  await signIn(page, state('me'));
  await sendTo(page, state('friend').handle, '1');
  await expect(page.getByRole('radiogroup', { name: 'Payment type' })).toBeVisible(UNBUILT);
  await expect(page.getByText('Gifts aren’t configured.')).toBeVisible();
});
