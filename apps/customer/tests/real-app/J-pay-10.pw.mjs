import { test, expect } from '@playwright/test';
import { journeyState, tool } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member } from './pay.mjs';

// J-pay-10, in the running app (docs/roadmap/journeys.json): schedule a payment and manage automatic payments. One test
// per step, titled "J-pay-10 #<n>", run in order. #1 makes the start: verified TEST members, the person holding TEST 30
// USDT. Runs come from the stack's TEST schedule clock (`local-test-world.mjs pay-schedule-tick`); the cutoff and notice
// rules are the stack's TEST pay terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: no service stores a payment for a later date ("Send pays now"), no recurring request, no automatic
//   payments (mandates) list; the stack has no schedule clock.
const J = 'J-pay-10';
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

const upcoming = (page) => page.getByRole('table', { name: 'Upcoming' });

async function scheduled(page) {
  await signIn(page, state('me'));
  await page.goto('/pay/scheduled');
  await expect(page.getByRole('heading', { name: 'Scheduled payments', level: 1 })).toBeVisible();
}

test(`${J} #1 creates a weekly payment to a friend: the schedule with the next run`, async ({ page }) => {
  test.setTimeout(240_000);
  const friend = await member(page, 'jpwf');
  const me = await member(page, 'jpwm', '30');
  run.reset({ me, friend });
  await scheduled(page);
  await page.getByRole('button', { name: 'Schedule a payment' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Schedule a payment' });
  await sheet.getByLabel('Handle').fill(friend.handle);
  await sheet.getByLabel('Amount').fill('20');
  await sheet.getByLabel('How often').selectOption('Weekly');
  await sheet.getByRole('button', { name: 'Schedule' }).click();
  await expect(upcoming(page).getByRole('row', { name: new RegExp(friend.handle) })).toContainText(/Next run/);
});

test(`${J} #2 an occurrence runs with too little balance: the typed refusal recorded; the schedule continues by its policy`, async ({
  page,
}) => {
  tool('local-test-world.mjs', 'pay-schedule-tick', state('me').email);
  tool('local-test-world.mjs', 'pay-schedule-tick', state('me').email);
  await scheduled(page);
  await expect(upcoming(page).getByRole('row', { name: new RegExp(state('friend').handle) })).toContainText(/not enough USDT/, UNBUILT);
});

test(`${J} #3 edits it after the cutoff: refused`, async ({ page }) => {
  await scheduled(page);
  await upcoming(page)
    .getByRole('row', { name: new RegExp(state('friend').handle) })
    .getByRole('button', { name: 'Edit' })
    .click(UNBUILT);
  await expect(page.getByText(/past the cutoff/)).toBeVisible();
});

test(`${J} #4 schedules a recurring request: a request per run and no money moves`, async ({ page }) => {
  await scheduled(page);
  await page.getByRole('button', { name: 'Schedule a request' }).click(UNBUILT);
  await expect(page.getByRole('dialog', { name: 'Schedule a request' })).toBeVisible();
});

test(`${J} #5 opens Automatic payments: each mandate with terms and next run; Stop ends later runs`, async ({ page }) => {
  await signIn(page, state('me'));
  await page.goto('/pay/scheduled?view=automatic');
  await expect(page.getByRole('table', { name: 'Automatic payments' }).or(page.getByText('No automatic payments.'))).toBeVisible(UNBUILT);
});
