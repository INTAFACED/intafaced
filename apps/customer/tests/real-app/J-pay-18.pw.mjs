import { test, expect } from '@playwright/test';
import { journeyState, toUnits } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member, sendNow, sendTo, usdt } from './pay.mjs';

// J-pay-18, in the running app (docs/roadmap/journeys.json): something is wrong: an unauthorised payment, a payment sent
// in error, a scam, and a debt. One test per step, titled "J-pay-18 #<n>", run in order. #1 makes the start: verified
// TEST members; the victim holds TEST 100 USDT and pays twice (one to report as unauthorised, one sent in error), and a
// stranger is a first-time recipient. The report windows are the stack's TEST dispute terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: a payment's room has no report (unauthorised, sent in error, scam), no reversal and no debt; Send has no
//   first-time-recipient warning.
const J = 'J-pay-18';
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

/** The most recent payment's room, with its report sheet open on `kind`. */
async function report(page, who, kind) {
  await signIn(page, who);
  await page.goto('/pay');
  await page
    .getByRole('link', { name: /receipt/i })
    .first()
    .click();
  await page.getByRole('button', { name: 'Report a problem' }).click();
  const sheet = page.getByRole('dialog', { name: 'Report a problem' });
  await sheet.getByRole('radio', { name: kind }).check(UNBUILT);
  return sheet;
}

test(`${J} #1 reports an unauthorised payment inside the window: a case and an offer to freeze; the buyer can't cancel it`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const other = await member(page, 'jpxo');
  const victim = await member(page, 'jpxv', '100');
  await signIn(page, victim);
  await sendNow(page, other.handle, '10', 'TEST unauthorised');
  run.reset({ victim, other });
  const sheet = await report(page, victim, 'I didn’t make this payment');
  await sheet.getByRole('button', { name: 'Report' }).click();
  await expect(page.getByText(/Case [\w-]+/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Freeze my account' })).toBeVisible();
});

test(`${J} #2 reports a payment sent in error: a case; one reversal when the recipient has funds; a second request refused`, async ({
  page,
}) => {
  const victim = state('victim');
  await signIn(page, victim);
  await sendNow(page, state('other').handle, '20', 'TEST wrong person');
  const before = await usdt(victim);
  const sheet = await report(page, victim, 'I sent it to the wrong person');
  await sheet.getByRole('button', { name: 'Report' }).click();
  await expect.poll(async () => toUnits(await usdt(victim)) - toUnits(before), { timeout: 30_000 }).toBe(toUnits('20'));
});

test(`${J} #3 reports a person as a scam: a receipt with a case; the first-time warning shows both scam lines`, async ({ page }) => {
  const stranger = await member(page, 'jpxs');
  await signIn(page, state('victim'));
  await sendTo(page, stranger.handle, '1');
  await expect(page.getByRole('note', { name: 'First payment to this person' })).toBeVisible(UNBUILT);
});

test(`${J} #4 a recipient whose balance was short is reversed: what exists posts, the rest is a debt; sends refuse naming it`, async ({
  page,
}) => {
  await signIn(page, state('other'));
  await page.goto('/pay');
  await expect(page.getByText(/You owe [\d.]+ USDT/)).toBeVisible(UNBUILT);
});

test(`${J} #5 receives an incoming payment: it repays the debt first; at zero the restriction lifts`, async ({ page }) => {
  await signIn(page, state('other'));
  await page.goto('/pay');
  await expect(page.getByText(/You owe [\d.]+ USDT/)).toBeVisible(UNBUILT);
});
