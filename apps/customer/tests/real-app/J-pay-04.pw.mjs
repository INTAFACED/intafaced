// World: restart, stack
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { actedAs, api, fund, journeyState, mailedCodes, mailedLines, nextMailedCode, restartWith, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-pay-04, in the running app (docs/roadmap/journeys.json): pay someone who is not a member yet, and let them claim it
// or take it back. One test per step, titled "J-pay-04 #<n>", run in order on TEST accounts: A sends, funded with TEST
// 40 USDT; each "contact" is an email address no member has, on the stack's LOCAL-TEST mail outbox, read like an inbox.
// Money (the journey's row): a send sets TEST 15 USDT aside (A's available minus 15); a claim posts once to the
// recipient; a cancel or an expiry posts one return to A. Every figure is TEST money on the local stack, and each one on
// screen is checked against what the person's own API answers.
//
// Written from the step's words by a test-writer, ahead of the feature (OWNER 212). What the stack needs from the
// feature, named here so the builder wires exactly it:
//   - the claim message goes to the contact through the stack's mail outbox, purpose `pay-claim`, with `link=<app path>`;
//   - `LOCAL_STACK_BANK_CLAIM_MAIL=off` restarts svc-bank with the claim mail unwired (vendor.email off), as
//     `LOCAL_STACK_SUPPORT_GUEST_MAIL` does for support;
//   - `node tooling/scripts/local-test-stack.mjs expire-unclaimed-sends <email>`: the TEST person's unclaimed sends reach
//     the end of their claim window now, as the stack's other `expire-*` fixtures do, so step 5 need not wait it out.
const J = 'J-pay-04';
const AMOUNT = '15';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function sender() {
  const { sender: a } = run.read();
  if (!a) throw new Error(`${J} #1 made no sender, so this step has no one to act as`);
  return a;
}

/** An email address no member has: a contact who is not a member yet. */
const contact = (label) => `${label}-${Date.now().toString(36)}${randomBytes(2).toString('hex')}@local-test.invalid`;

/** A's USDT on the ledger, through A's own API: { free, used, total } as decimal strings. */
const usdt = async (who) => (await (await api(who)).balances()).USDT ?? { free: '0', used: '0', total: '0' };

/** Types an email or phone in To and leaves the field, which is when Send looks it up. */
async function lookUp(page, value) {
  const to = page.getByRole('textbox', { name: 'Handle', exact: true });
  await to.fill(value);
  await to.press('Tab');
}

/** A on /pay sends TEST 15 USDT to `to` (not a member) through Review and Send. Leaves the page on the answer. */
async function sendTo(page, to) {
  await signIn(page, sender());
  await page.goto('/pay');
  await lookUp(page, to);
  await expect(page.getByText(/not a member/i).first()).toBeVisible();
  await page.getByLabel('Amount to send').fill(AMOUNT);
  await page.getByTestId('pay-review').click();
  await expect(page.getByTestId('pay-review-to')).toContainText(to);
  await expect(page.getByTestId('pay-review-amount')).toContainText(AMOUNT);
  await page.getByTestId('pay-send').click();
}

/** A's row for the unclaimed send to `to` on Pay's recent payments. */
async function sentRow(page, to) {
  await page.goto('/pay');
  const row = page.getByTestId('recent-payment').filter({ hasText: to });
  await expect(row).toHaveCount(1);
  return row;
}

/** The claim links the stack's mail outbox holds for `to`, oldest first (an app path each). */
const claimLinks = (to) =>
  mailedLines(to, 'pay-claim')
    .map((line) => /\blink=(\S+)/.exec(line)?.[1])
    .filter(Boolean)
    .map((link) => (link.startsWith('/') ? link : `/${link}`));

async function claimLink(to, waitMs = 20_000) {
  const until = Date.now() + waitMs;
  for (;;) {
    const links = claimLinks(to);
    if (links.length) return links;
    if (Date.now() >= until) throw new Error(`no claim message (outbox purpose pay-claim) reached ${to} within ${waitMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test(`${J} #1 searches an email or phone that is not a member: "Not a member" with an offer to invite`, async ({ page }) => {
  test.setTimeout(180_000);
  // The start: A signed up, verified and funded with TEST 40 USDT.
  const a = await signUp(page, 'jp4a');
  await verify(page, a);
  expect(fund(a.email, 'USDT', '40').tx).toBeTruthy();
  a.userId = (await api(a)).userId;
  run.reset({ sender: a });
  expect((await usdt(a)).free).toBe('40');

  const stranger = contact('jp4-none');
  await signIn(page, a);
  await page.goto('/pay');
  await lookUp(page, stranger);
  // Not a member, said in those words, and an offer to invite them: never "not found" as though the send were a dead end.
  await expect(page.getByText(/not a member/i).first()).toBeVisible();
  await expect(page.getByText('No one can be paid at that email or phone. Check it, or ask for their handle.')).toHaveCount(0);
  const invite = page.getByRole('button', { name: /invite/i }).or(page.getByRole('link', { name: /invite/i }));
  await expect(invite.first()).toBeVisible();
  // Searching moves nothing.
  expect((await usdt(a)).free).toBe('40');
});

test(`${J} #2 sends TEST 15 USDT to that contact: the balance shows the amount set aside and the send reads Unclaimed; with the email vendor off the send refuses with the notice and holds nothing`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const a = sender();
  const to = contact('jp4-claim');
  await sendTo(page, to);
  await expect(page.getByTestId('pay-receipt')).toBeVisible();
  await expect(page.getByTestId('pay-receipt')).toContainText('Unclaimed');

  // The money: TEST 15 USDT has left A's available balance and is set aside, not gone.
  const after = await usdt(a);
  expect(after.free).toBe('25');
  // The send reads Unclaimed on A's recent payments, and the balance page shows the 15 set aside.
  const row = await sentRow(page, to);
  await expect(row).toContainText('Unclaimed');
  await expect(row).toContainText(`${AMOUNT} USDT`);
  await page.goto('/money/balance/USDT');
  await expect(
    page.getByText(new RegExp(`set aside[^\\n]*${AMOUNT}(\\.0+)? USDT|${AMOUNT}(\\.0+)? USDT[^\\n]*set aside`, 'i')).first(),
  ).toBeVisible();
  run.write({ claimed: to });

  // With the email vendor off: the send refuses, says why, and holds nothing.
  const off = contact('jp4-off');
  restartWith('bank', 'LOCAL_STACK_BANK_CLAIM_MAIL', false);
  try {
    await sendTo(page, off);
    await expect(page.getByRole('alert').filter({ hasText: /email/i })).toBeVisible();
    await expect(page.getByTestId('pay-receipt')).toHaveCount(0);
    const held = await usdt(a);
    expect(held.free).toBe('25');
    expect(held.total).toBe(after.total);
    await page.goto('/pay');
    await expect(page.getByTestId('recent-payment').filter({ hasText: off })).toHaveCount(0);
    expect(claimLinks(off)).toEqual([]);
  } finally {
    restartWith('bank', 'LOCAL_STACK_BANK_CLAIM_MAIL', true);
  }
});

test(`${J} #3 the recipient opens the claim link and signs up: the claim page, then Completed for both, and one claim post`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const a = sender();
  const { claimed: to } = run.read();
  if (!to) throw new Error(`${J} #2 sent nothing, so there is nothing to claim`);
  const [link] = await claimLink(to);

  // The claim page, signed out: who sent it and how much, and the way to sign up to claim it.
  await page.context().clearCookies();
  await page.goto(link);
  await expect(page.getByRole('heading', { name: /claim/i }).first()).toBeVisible();
  await expect(page.getByText(`@${a.handle}`).first()).toBeVisible();
  await expect(page.getByText(new RegExp(`${AMOUNT}(\\.0+)? USDT`)).first()).toBeVisible();

  // Signs up from the claim page, with the address the money was sent to.
  const handle = `jp4b${Date.now().toString(36)}`;
  const b = { handle, email: to, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  actedAs(b);
  const seen = mailedCodes(b.email).length;
  await page
    .getByRole('link', { name: /sign up|create.*account/i })
    .or(page.getByRole('button', { name: /sign up|create.*account/i }))
    .first()
    .click();
  await page.getByLabel('Email address').fill(b.email);
  await page.getByLabel('Handle').fill(b.handle);
  await page.getByLabel('Password').fill(b.password);
  await page.getByLabel('Country you live in').selectOption('DE');
  await page.getByLabel('Date of birth').fill('1990-05-01');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  await page.getByLabel('Code from the email').fill(await nextMailedCode(b.email, seen));
  await page.getByRole('button', { name: 'Confirm and open my account' }).click();
  await page.waitForURL((url) => url.pathname !== '/register');

  // Completed for the recipient, with exactly TEST 15 USDT in their balance.
  await expect(page.getByText('Completed').first()).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await usdt(b)).free, { timeout: 20_000 }).toBe(AMOUNT);

  // Completed for A, whose balance holds nothing aside any more: 25 left of 40.
  await signIn(page, a);
  const row = await sentRow(page, to);
  await expect(row).toContainText('Completed');
  await expect(row).not.toContainText('Unclaimed');
  const mine = await usdt(a);
  expect(mine.free).toBe('25');
  expect(mine.total).toBe('25');

  // One claim post: opening the link again claims nothing more, and neither balance moves.
  await signIn(page, b);
  await page.goto(link);
  await expect(page.getByText(/already claimed|completed/i).first()).toBeVisible();
  await page.waitForTimeout(3_000);
  expect((await usdt(b)).free).toBe(AMOUNT);
  expect((await usdt(a)).free).toBe('25');
});

test(`${J} #4 in another case the sender cancels before the claim: Cancel is offered first on an unclaimed send, the status reads Cancelled, and one return post`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const a = sender();
  const to = contact('jp4-cancel');
  const before = await usdt(a);
  await sendTo(page, to);
  await expect(page.getByTestId('pay-receipt')).toContainText('Unclaimed');
  expect(toUnits((await usdt(a)).free)).toBe(toUnits(before.free) - toUnits(AMOUNT));

  // On the unclaimed send's status page, Cancel is the first thing offered.
  const row = await sentRow(page, to);
  await row
    .getByRole('link', { name: /receipt|details|status/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/money\/activity\/[^/?]+/);
  await expect(page.getByText('Unclaimed').first()).toBeVisible();
  const first = page.getByRole('main').getByRole('button').first();
  await expect(first).toHaveAccessibleName(/cancel/i);
  await first.click();
  // A confirmation, if the page asks for one, is answered the same way.
  const confirm = page.getByRole('dialog').getByRole('button', { name: /cancel/i });
  if (await confirm.count()) await confirm.first().click();

  await expect(page.getByText('Cancelled').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /^cancel/i })).toHaveCount(0);
  // One return post: the 15 is back, once, and stays that way.
  await expect.poll(async () => (await usdt(a)).free, { timeout: 20_000 }).toBe(before.free);
  await page.waitForTimeout(3_000);
  const after = await usdt(a);
  expect(after.free).toBe(before.free);
  expect(after.total).toBe(before.total);
  await expect(await sentRow(page, to)).toContainText('Cancelled');

  // The contact's link no longer claims anything.
  const [link] = await claimLink(to);
  await page.context().clearCookies();
  await page.goto(link);
  await expect(page.getByText(/cancelled/i).first()).toBeVisible();
  expect((await usdt(a)).free).toBe(before.free);
});

test(`${J} #5 in another case nobody claims inside the window: the amount returns once and the sender sees why`, async ({ page }) => {
  test.setTimeout(240_000);
  const a = sender();
  const to = contact('jp4-expire');
  const before = await usdt(a);
  await sendTo(page, to);
  await expect(page.getByTestId('pay-receipt')).toContainText('Unclaimed');
  expect(toUnits((await usdt(a)).free)).toBe(toUnits(before.free) - toUnits(AMOUNT));

  // The claim window ends with no claim.
  tool('local-test-stack.mjs', 'expire-unclaimed-sends', a.email);
  await expect.poll(async () => (await usdt(a)).free, { timeout: 60_000 }).toBe(before.free);
  // Once: a second pass of the window's end returns nothing more.
  tool('local-test-stack.mjs', 'expire-unclaimed-sends', a.email);
  await page.waitForTimeout(5_000);
  const after = await usdt(a);
  expect(after.free).toBe(before.free);
  expect(after.total).toBe(before.total);

  // A sees why: the send reads as returned because nobody claimed it in time.
  await signIn(page, a);
  const row = await sentRow(page, to);
  await expect(row).not.toContainText('Unclaimed');
  await row
    .getByRole('link', { name: /receipt|details|status/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/money\/activity\/[^/?]+/);
  await expect(page.getByText(/returned/i).first()).toBeVisible();
  await expect(page.getByText(/not claimed|nobody claimed|wasn.t claimed|expired/i).first()).toBeVisible();
});
