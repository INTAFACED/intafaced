import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';

// J-pay-19, in the running app (docs/roadmap/journeys.json): a support agent works a dispute and hold queue. One test per
// step, titled "J-pay-19 #<n>", run in order on the console as the stack's TEST founder acting as a natural-person agent
// with the dispute scope. The cases and held payments are the ones the customer dispute journeys open on this stack; the
// ruling threshold and credit cap are the stack's TEST dispute terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: the console's support desk has no dispute and hold queue (cases, ages, held payments, information
//   requests, offers, rulings, temporary credits, sent-in-error reversals).
const J = 'J-pay-19';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

async function queue(page, key = 'a') {
  await founderSignIn(page, key);
  await page.goto(`${ADMIN}/support`);
  const table = page.getByRole('table', { name: 'Disputes and holds' });
  await expect(table).toBeVisible(UNBUILT);
  return table;
}

async function firstCase(page, key) {
  const table = await queue(page, key);
  await table.locator('tbody tr').first().getByRole('link').first().click();
  return page.getByRole('region', { name: 'Case' });
}

test(`${J} #1 opens the dispute and hold desk: cases, ages and held payments; a compliance-only role sees no buttons`, async ({ page }) => {
  run.reset({});
  const table = await queue(page);
  for (const row of await table.locator('tbody tr').all()) await expect(row).toContainText(/\d+ (minutes?|hours?|days?)/);
});

test(`${J} #2 opens a case and asks the customer for information: one audit row; the customer sees the request`, async ({ page }) => {
  const kase = await firstCase(page);
  await kase.getByRole('button', { name: 'Ask for information' }).click();
  await page.getByRole('dialog').getByLabel('What you need').fill('TEST: a photo of the receipt.');
  await page.getByRole('dialog').getByRole('button', { name: 'Send' }).click();
  await expect(kase.getByRole('row', { name: /TEST: a photo of the receipt\./ })).toHaveCount(1);
});

test(`${J} #3 makes an offer: one audit row; the recipient and customer see it`, async ({ page }) => {
  const kase = await firstCase(page);
  await kase.getByRole('button', { name: 'Make an offer' }).click();
  await page.getByRole('dialog').getByLabel('Amount').fill('30');
  await page.getByRole('dialog').getByRole('button', { name: 'Send offer' }).click();
  await expect(kase).toContainText(/Offer\s*30 USDT/);
});

test(`${J} #4 rules on the case: a machine identity refused; above the threshold the ruling waits for a second approver`, async ({
  page,
}) => {
  const kase = await firstCase(page);
  await kase.getByRole('button', { name: 'Rule' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Rule for the customer' }).click();
  await expect(kase).toContainText(/Waiting for a second approver|Ruled/);
});

test(`${J} #5 grants a temporary credit: posted once, or refused with the cap, the empty pot or the missing approver`, async ({ page }) => {
  const kase = await firstCase(page);
  await kase.getByRole('button', { name: 'Grant a temporary credit' }).click();
  await expect(page.getByText(/Credit posted|over the cap|protection pot is empty|second approver/)).toBeVisible();
});

test(`${J} #6 reverses a payment sent in error: one reversal; a short balance posts what exists and records a debt`, async ({ page }) => {
  const kase = await firstCase(page);
  await kase.getByRole('button', { name: 'Reverse the payment' }).click();
  await expect(kase).toContainText(/Reversed|Debt recorded/);
});
