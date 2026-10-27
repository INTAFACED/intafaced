import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member, sendNow } from './pay.mjs';

// J-pay-17, in the running app (docs/roadmap/journeys.json): use protection: a temporary credit, a returned item, and a
// purchase claim. One test per step, titled "J-pay-17 #<n>", run in order. #1 makes the start: a verified TEST buyer with
// TEST 100 USDT pays a verified TEST seller for a purchase. The protection cap, waiting period and categories are the
// stack's TEST protection terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: Send has no purchase type or protection label; there are no claims, temporary credits or item returns.
const J = 'J-pay-17';
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

async function purchase(page) {
  await signIn(page, state('buyer'));
  await page.goto('/pay');
  await page
    .getByRole('link', { name: /receipt/i })
    .first()
    .click();
}

test(`${J} #1 opens a purchase payment: a protection label with a deadline; blank rules say protection is not published`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const seller = await member(page, 'jpts');
  const buyer = await member(page, 'jptb', '100');
  await signIn(page, buyer);
  await sendNow(page, seller.handle, '40', 'TEST purchase');
  run.reset({ buyer, seller });
  await purchase(page);
  await expect(page.getByText(/Protected until|Protection isn’t published/)).toBeVisible(UNBUILT);
});

test(`${J} #2 files a not-as-described claim: the case with the claim steps`, async ({ page }) => {
  await purchase(page);
  await page.getByRole('button', { name: 'Make a claim' }).click(UNBUILT);
  await page.getByRole('dialog').getByRole('radio', { name: 'Not as described' }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('list', { name: 'Claim steps' })).toBeVisible();
});

test(`${J} #3 waits past the waiting period: a labelled Temporary credit with its date and rule; an empty pot says so`, async ({
  page,
}) => {
  await purchase(page);
  await expect(page.getByText(/Temporary credit|protection pot is empty/)).toBeVisible(UNBUILT);
});

test(`${J} #4 is asked to return the item: deadlines; tracking goes to the agent`, async ({ page }) => {
  await purchase(page);
  await page.getByRole('button', { name: 'Return the item' }).click(UNBUILT);
  await page.getByRole('dialog').getByLabel('Tracking number').fill('TEST-TRACK-1');
  await page.getByRole('dialog').getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('TEST-TRACK-1')).toBeVisible();
});

test(`${J} #5 the claim is decided: one refund on a win; a no-error decision reverses the credit once after notice`, async ({ page }) => {
  await purchase(page);
  await expect(page.getByText(/Claim decided/)).toBeVisible(UNBUILT);
});
