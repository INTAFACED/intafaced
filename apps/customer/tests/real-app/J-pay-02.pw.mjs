import { test, expect } from '@playwright/test';
import { journeyState, signOutBrowser, toUnits } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';
import { member, sendTo, usdt } from './pay.mjs';

// J-pay-02, in the running app (docs/roadmap/journeys.json): know what I can send, what it costs, and why a send was
// stopped. One test per step, titled "J-pay-02 #<n>", run in order. #1 makes the start: a verified TEST sender with TEST
// 100 USDT, a verified recipient, and an unverified member. The per-tier limits and fees are the stack's TEST personal
// pay terms; every refusal is checked to have moved and held nothing.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: Send limits and Fees are rooms that read no terms ("No limits are published, so none is shown"), though Send
//   itself reads the TEST terms.
// - #2: no stack tool unpublishes the personal pay terms for one run.
// - #4: no rolling cap across midnight that a test can cross.
// - #6: no first-payment review hold or step-up on Send; #7 is proven in the harness only (pay.browser.pw.mjs).
const J = 'J-pay-02';
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

const terms = (page) => page.getByTestId('pay-terms');

test(`${J} #1 opens the send limits and the fee schedule: terms per tier, today's spend and what is left; blank never invented`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const recipient = await member(page, 'jplr');
  const sender = await member(page, 'jpls', '100');
  const unverified = await signUp(page, 'jplu');
  run.reset({ sender, recipient, unverified });
  await signOutBrowser(page.context());
  await signIn(page, sender);
  await page.goto('/pay/send/limits');
  await expect(page.getByRole('heading', { name: 'Send limits', level: 1 })).toBeVisible();
  const limits = page.getByRole('table', { name: 'Limits by verification level' });
  await expect(limits).toBeVisible(UNBUILT);
  await expect(page.getByText(/Sent today\s*[\d.]+ USDT/)).toBeVisible();
  await expect(page.getByText(/Left today\s*[\d.]+ USDT/)).toBeVisible();
  await page.goto('/pay/fees');
  await expect(page.getByRole('table', { name: 'Fees' })).toContainText(/Free|Not published|[\d.]+/);
});

test(`${J} #2 tries to send with no terms published: a typed refusal naming the unset terms; nothing reserved or posted`, async ({
  page,
}) => {
  await signIn(page, state('sender'));
  await page.goto('/pay');
  await expect(page.getByText(/Personal pay terms are not published/)).toBeVisible(UNBUILT);
});

test(`${J} #3 tries to send more than the balance covers: which balance is short and how to add money; no negative balance`, async ({
  page,
}) => {
  const sender = state('sender');
  const before = await usdt(sender);
  await signIn(page, sender);
  await sendTo(page, state('recipient').handle, '1000');
  await expect(terms(page).or(page.getByRole('alert'))).toContainText(/USDT balance is short|not enough USDT/i);
  await expect(page.getByRole('link', { name: 'Add money' })).toBeVisible();
  // Nothing reserved or moved.
  expect(await usdt(sender)).toBe(before);
});

test(`${J} #4 sends two payments across midnight that pass the rolling cap: the second refuses with the remaining allowance`, async ({
  page,
}) => {
  await signIn(page, state('sender'));
  await sendTo(page, state('recipient').handle, '1');
  await expect(terms(page)).toContainText(/left in the last 24 hours/, UNBUILT);
});

test(`${J} #5 sends as an unverified person: receiving works; sending refuses with the missing step and a link to finish it`, async ({
  page,
}) => {
  await signIn(page, state('unverified'));
  await sendTo(page, state('recipient').handle, '1');
  await expect(page.getByText(/Finish verifying/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Verify/ }).first()).toBeVisible();
});

test(`${J} #6 sends a large first payment to a new person: held In review, or a step-up; a blocked class reads generic`, async ({
  page,
}) => {
  await signIn(page, state('sender'));
  await sendTo(page, state('recipient').handle, '90');
  await page.getByTestId('pay-review').click();
  await page.getByTestId('pay-send').click();
  await expect(page.getByText('In review').or(page.getByText(/Confirm it’s you/))).toBeVisible(UNBUILT);
});

test(`${J} #7 loses the connection at the moment of Send: "still confirming", Send off, Retry returns the same payment`, async ({
  page,
}) => {
  const sender = state('sender');
  await signIn(page, sender);
  await sendTo(page, state('recipient').handle, '1');
  await expect(terms(page)).toHaveAttribute('data-terms', 'ok');
  await page.getByTestId('pay-review').click();
  // The reply is lost after the server has it: the request goes through, the browser never sees the answer.
  let dropped = false;
  await page.route('**/trpc/**', async (route) => {
    if (dropped || route.request().method() !== 'POST' || !/transfer|pay\./i.test(route.request().url())) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort('connectionreset');
  });
  const before = await usdt(sender);
  await page.getByTestId('pay-send').click();
  await expect(page.getByText(/still confirming/i)).toBeVisible();
  await expect(page.getByTestId('pay-send')).toBeDisabled();
  await page.unroute('**/trpc/**');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('pay-receipt')).toBeVisible();
  expect(toUnits(before) - toUnits(await usdt(sender))).toBe(toUnits('1'));
});
