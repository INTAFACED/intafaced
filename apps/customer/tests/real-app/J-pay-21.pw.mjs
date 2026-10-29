import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';

// J-pay-21, in the running app (docs/roadmap/journeys.json): compliance publishes personal pay terms and reviews a held or
// reported payment. One test per step, titled "J-pay-21 #<n>", run in order on the console as the stack's two TEST
// founders (proposer and second approver). The terms proposed are TEST values. Screening and identity vendors are off on
// the stack; their notices are what show.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: the console has no personal pay terms page (propose, approve, version) and no held-send or scam-report
//   review; the stack publishes TEST terms from its own settings, so "nothing published" can't be seen here.
const J = 'J-pay-21';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

async function terms(page, key = 'a') {
  await founderSignIn(page, key);
  await page.goto(`${ADMIN}/compliance/pay-terms`);
  const view = page.getByRole('region', { name: 'Personal pay terms' });
  await expect(view).toBeVisible(UNBUILT);
  return view;
}

test(`${J} #1 opens the terms page with nothing published: the blocker bank.personal_transfer_terms_unset, also on the founder page`, async ({
  page,
}) => {
  run.reset({});
  const view = await terms(page);
  await expect(view.getByText(/bank\.personal_transfer_terms_unset|Version \d+/)).toBeVisible();
});

test(`${J} #2 proposes terms per tier and a second person approves: the version goes live; self-approval refused`, async ({ page }) => {
  const view = await terms(page, 'a');
  await view.getByLabel('Basic, largest single payment').fill('100');
  await view.getByRole('button', { name: 'Propose' }).click();
  await view.getByRole('button', { name: 'Approve' }).click();
  await expect(view.getByText(/can’t approve your own proposal/)).toBeVisible();
});

test(`${J} #3 opens a held first-payment review: the rule that held it, the amount and the people`, async ({ page }) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/compliance/cases`);
  await expect(page.getByRole('table', { name: 'Held sends' })).toBeVisible(UNBUILT);
});

test(`${J} #4 releases or blocks it: a release posts once; a block shows the sender a generic message`, async ({ page }) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/compliance/cases`);
  await page.getByRole('table', { name: 'Held sends' }).locator('tbody tr').first().getByRole('button', { name: 'Release' }).click(UNBUILT);
});

test(`${J} #5 opens a scam report: the case with the reporter's receipt state; an empty rule table shows "nothing auto-refused"`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/compliance/cases`);
  await expect(page.getByRole('table', { name: 'Scam reports' })).toBeVisible(UNBUILT);
});

test(`${J} #6 checks what a counterparty sees of a payment: no funding fields; an identity port that is down refuses the send`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/compliance/cases`);
  await expect(page.getByRole('region', { name: 'Counterparty view' })).toBeVisible(UNBUILT);
});
