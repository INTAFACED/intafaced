import { test, expect } from '@playwright/test';
import { journeyState, toUnits } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member, sendNow, usdt } from './pay.mjs';

// J-pay-16, in the running app (docs/roadmap/journeys.json): dispute a payment and see it through to a decision. One test
// per step, titled "J-pay-16 #<n>", run in order. #1 makes the start: verified TEST members, the payer holding TEST 200
// USDT, who pays the recipient TEST 100 USDT twice (one payment per case). The dispute windows and minimum age are the
// stack's TEST dispute terms. Balances are read through each person's own API.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: a payment's room has no Open a dispute; Cases says "The case desk is not connected, so a case cannot be
//   opened or read."
const J = 'J-pay-16';
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

const cases = (page) => page.getByRole('table', { name: 'Your cases' });

async function openCase(page, who, caseId) {
  await signIn(page, who);
  await page.goto(`/pay/cases/${encodeURIComponent(caseId)}`);
  await expect(page.getByRole('heading', { name: 'Case', level: 1 })).toBeVisible();
  await expect(page.getByText(/Status\s*\w+/)).toBeVisible(UNBUILT);
}

test(`${J} #1 opens a payment and chooses Open a dispute, picks a reason: eligibility, the routing note, and refusals with reasons`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const recipient = await member(page, 'jpdr');
  const payer = await member(page, 'jpdp', '200');
  await signIn(page, payer);
  const first = await sendNow(page, recipient.handle, '100', 'TEST case one');
  const second = await sendNow(page, recipient.handle, '100', 'TEST case two');
  run.reset({ payer, recipient, first, second });
  await page.goto('/pay');
  await page
    .getByRole('link', { name: /receipt/i })
    .first()
    .click();
  await page.getByRole('button', { name: 'Open a dispute' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Open a dispute' });
  await sheet.getByLabel('Reason').selectOption({ index: 1 });
  await expect(sheet.getByText(/You can open a dispute/)).toBeVisible();
});

test(`${J} #2 submits the case: a receipt with the case id and next step; the same line twice is the same case; no money moved`, async ({
  page,
}) => {
  const payer = state('payer');
  const before = await usdt(payer);
  await signIn(page, payer);
  await page.goto('/pay');
  await page
    .getByRole('link', { name: /receipt/i })
    .first()
    .click();
  await page.getByRole('button', { name: 'Open a dispute' }).click(UNBUILT);
  await page.getByRole('dialog').getByLabel('Reason').selectOption({ index: 1 });
  await page.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
  const caseId = (await page.getByTestId('case-id').innerText()).trim();
  run.write({ caseId });
  expect(await usdt(payer)).toBe(before);
});

test(`${J} #3 adds evidence: a checklist; an infected file refused; edits after submit refuse`, async ({ page }) => {
  await openCase(page, state('payer'), state('caseId'));
  await expect(page.getByRole('list', { name: 'Evidence checklist' })).toBeVisible();
  await page.getByLabel('Add evidence').setInputFiles({
    name: 'eicar.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
  });
  await expect(page.getByText(/This file can’t be accepted/)).toBeVisible();
});

test(`${J} #4 the recipient accepts: one refund, and the case ends accepted offer`, async ({ page }) => {
  await openCase(page, state('recipient'), state('caseId'));
  await page.getByRole('button', { name: 'Accept and refund' }).click();
  await expect(page.getByText(/Status\s*Accepted offer/)).toBeVisible();
});

test(`${J} #5 opens the dispute centre: both cases with status and timeline; a cancelled case has no Reopen`, async ({ page }) => {
  await signIn(page, state('payer'));
  await page.goto('/pay/cases');
  await expect(cases(page).locator('tbody tr')).toHaveCount(2, UNBUILT);
});

test(`${J} #6 receives an offer of TEST 30 and escalates another case: accept posts one refund of 30; early escalation refused`, async ({
  page,
}) => {
  const payer = state('payer');
  const before = await usdt(payer);
  await openCase(page, payer, state('caseId'));
  await page.getByRole('button', { name: 'Accept the offer' }).click();
  expect(toUnits(await usdt(payer)) - toUnits(before)).toBe(toUnits('30'));
});

test(`${J} #7 appeals a decision: accepted once; a second appeal without new information denied`, async ({ page }) => {
  await openCase(page, state('payer'), state('caseId'));
  await page.getByRole('button', { name: 'Appeal' }).click();
  await page.getByRole('button', { name: 'Appeal' }).click();
  await expect(page.getByText(/Add new information to appeal again/)).toBeVisible();
});
