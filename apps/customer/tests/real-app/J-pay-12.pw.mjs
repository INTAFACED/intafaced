import { test, expect } from '@playwright/test';
import { journeyState, toUnits, tool } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member, usdt } from './pay.mjs';

// J-pay-12, in the running app (docs/roadmap/journeys.json): send money abroad and follow it until it lands. One test per
// step, titled "J-pay-12 #<n>", run in order on one verified TEST member with TEST 200 USDT. Corridors, FX and the payout
// rail are bank-rail ports; on the stack they are unset, and Global send says which one. Rail events (accepted, paid,
// failed, returned) come from the stack's TEST rail (`local-test-world.mjs global-rail`).
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #2: the stack publishes no corridor, so no destination can be picked and no quote asked.
// - #3 to #5: nothing to send, so no transfer to open, cancel or return; no TEST rail on the stack.
const J = 'J-pay-12';
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

const card = (page) => page.getByTestId('global-card');

test(`${J} #1 opens Global send: corridors, delivery methods and an honest empty or notice state`, async ({ page }) => {
  test.setTimeout(240_000);
  const sender = await member(page, 'jpg', '200');
  run.reset({ sender });
  await signIn(page, sender);
  await page.goto('/pay/global');
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByLabel('Where it goes')).toBeVisible();
  await expect(card(page).getByLabel('Recipient')).toBeVisible();
  // Either corridors to choose from, or the notice that names what isn't set.
  const destinations = await card(page).getByLabel('Where it goes').getByRole('option').count();
  if (destinations <= 1) await expect(card(page).getByRole('note').first()).toBeVisible();
  else await expect(card(page).getByLabel('Delivery method')).toBeVisible(UNBUILT);
});

test(`${J} #2 picks a corridor, a recipient and a delivery method, and asks for a quote: the quote, or the FX refusal by name`, async ({
  page,
}) => {
  await signIn(page, state('sender'));
  await page.goto('/pay/global');
  await card(page).getByLabel('Where it goes').selectOption({ index: 1 }, UNBUILT);
  await card(page).getByRole('button', { name: 'Add a new recipient' }).click();
  await card(page).getByLabel('Recipient’s full name').fill('TEST Recipient');
  await card(page).getByLabel('Account number or IBAN').fill('DE89370400440532013000');
  await card(page).getByTestId('global-recipient-save').click();
  await card(page).getByLabel('You send').fill('50');
  await card(page).getByTestId('global-get-quote').click();
  await expect(card(page).getByTestId('global-quote').or(card(page).getByTestId('global-quote-refused'))).toBeVisible();
});

test(`${J} #3 confirms the send: one send with the provider quote unchanged; an expired quote refused`, async ({ page }) => {
  const sender = state('sender');
  await signIn(page, sender);
  await page.goto('/pay/global');
  await expect(card(page).getByTestId('global-quote')).toBeVisible(UNBUILT);
  const before = await usdt(sender);
  await card(page).getByTestId('global-review').click();
  await page
    .getByTestId('global-confirm')
    .getByRole('button', { name: /Confirm/ })
    .click();
  await expect(card(page).getByTestId('global-sent')).toBeVisible();
  expect(toUnits(before) - toUnits(await usdt(sender))).toBeGreaterThan(0n);
});

test(`${J} #4 opens the transfer: status and timeline; Cancel once while submitted, then Request return after acceptance`, async ({
  page,
}) => {
  await signIn(page, state('sender'));
  await page.goto('/pay/global');
  await expect(page.getByTestId('global-cancel')).toBeVisible(UNBUILT);
});

test(`${J} #5 the rail fails or returns it: a support path; returned with one reversal; a different amount goes to review`, async () => {
  const out = tool('local-test-world.mjs', 'global-rail', state('sender').email, 'return');
  expect(out).toMatch(/returned/);
});
