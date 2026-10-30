import { test, expect } from '@playwright/test';
import { api, fund, journeyState, toUnits, signOutBrowser } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-pay-01, in the running app (docs/roadmap/journeys.json): send TEST money to a person by handle and see it complete.
// One test per step, titled "J-pay-01 #<n>", run in order on two TEST accounts: A sends, B receives. The stack's gates
// publish TEST send limits (`local-test-gates.mjs apply`); every number here is a TEST number on the local stack, and
// both balances are read through each person's own API after the move.
const J = 'J-pay-01';
const AMOUNT = '25';
const NOTE = 'Lunch, TEST';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function people() {
  const { sender, recipient } = run.read();
  if (!sender || !recipient) throw new Error(`${J} #1 made no accounts, so this step has no one to act as`);
  return { sender, recipient };
}

/** Types a handle in To and leaves the field, which is when Send looks it up. */
async function lookUp(page, handle) {
  const to = page.getByRole('textbox', { name: 'Handle', exact: true });
  await to.fill(handle);
  await to.press('Tab');
}

const usdt = async (who) => (await (await api(who)).balances()).USDT?.free ?? '0';

/** A on /pay with B's handle, the amount and the note typed in: where steps 2 to 5 start. */
async function sendForm(page) {
  const { sender, recipient } = people();
  await signIn(page, sender);
  await page.goto('/pay');
  await lookUp(page, recipient.handle);
  await expect(page.getByText(`@${recipient.handle}`).first()).toBeVisible();
  await page.getByLabel('Amount to send').fill(AMOUNT);
  await page.locator('#pay-note').fill(NOTE);
  await expect(page.getByTestId('pay-terms')).toHaveAttribute('data-terms', 'ok');
}

test(`${J} #1 opens Pay from the navigation and lands on Send`, async ({ page }) => {
  // The start: two verified members, and A holds TEST 100 USDT in the ledger.
  const recipient = await signUp(page, 'jpb');
  await verify(page, recipient);
  const sender = await signUp(page, 'jpa');
  await verify(page, sender);
  expect(fund(sender.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ sender, recipient, before: { sender: await usdt(sender), recipient: await usdt(recipient) } });
  expect(run.read().before).toEqual({ sender: '100', recipient: '0' });

  await signIn(page, sender);
  await page.goto('/');
  await page.getByRole('link', { name: 'Pay', exact: true }).first().click();
  await expect(page).toHaveURL(/\/pay(\/send)?(\?|$)/);
  await expect(page.getByRole('textbox', { name: 'Handle', exact: true })).toBeVisible();
  await expect(page.getByText(/not found/i)).toHaveCount(0);
  // The other personal rooms are listed beside Send.
  for (const room of ['Request', 'Receive']) await expect(page.getByRole('link', { name: room }).first()).toBeVisible();
});

test(`${J} #2 types a handle in To and sees who it is`, async ({ page }) => {
  const { sender, recipient } = people();
  await signIn(page, sender);
  await page.goto('/pay');
  await lookUp(page, recipient.handle);
  await expect(page.getByText(`@${recipient.handle}`).first()).toBeVisible();
  // An unknown handle and one's own handle each get a plain answer, not a raw code.
  const nobody = `nobody${Date.now().toString(36)}`;
  await lookUp(page, nobody);
  await expect(page.getByText(`We couldn’t find @${nobody}. Check the spelling.`)).toBeVisible();
  await lookUp(page, sender.handle);
  await expect(page.getByText('That’s you. Pick someone else.')).toBeVisible();
});

test(`${J} #3 enters TEST 25 USDT and a note, and sees the fee and today's allowance`, async ({ page }) => {
  await sendForm(page);
  const terms = page.getByTestId('pay-terms');
  await expect(terms).toContainText('No fee');
  await expect(terms).toContainText('USDT per payment');
  await expect(terms).toContainText('left today');
  await expect(page.getByTestId('pay-review')).toBeEnabled();
});

test(`${J} #4 presses Review and sees amount, recipient, source, note, fee and what is left today`, async ({ page }) => {
  await sendForm(page);
  await page.getByTestId('pay-review').click();
  const dialog = page.getByTestId('pay-dialog');
  await expect(dialog).toBeVisible();
  const { recipient } = people();
  await expect(dialog).toContainText(`@${recipient.handle}`);
  await expect(dialog).toContainText(`${AMOUNT} USDT`);
  await expect(dialog).toContainText(NOTE);
  await expect(dialog).toContainText('No fee');
  await expect(page.getByTestId('pay-review-left')).toBeVisible();
  // Nothing has moved yet.
  expect(await usdt(people().sender)).toBe(run.read().before.sender);
});

test(`${J} #5 confirms with a double click and the money moves once`, async ({ page }) => {
  await sendForm(page);
  await page.getByTestId('pay-review').click();
  await page.getByTestId('pay-send').dblclick();
  await expect(page.getByTestId('pay-receipt')).toBeVisible();
  await expect(page.getByTestId('pay-receipt-amount')).toContainText(AMOUNT);
  const reference = (await page.getByTestId('pay-receipt-reference').innerText()).trim();
  expect(reference).not.toBe('');
  run.write({ reference });
  // Exactly TEST 25 USDT left A and reached B: one post, not two.
  const { sender, recipient } = people();
  const { before } = run.read();
  expect(toUnits(before.sender) - toUnits(await usdt(sender))).toBe(toUnits(AMOUNT));
  expect(toUnits(await usdt(recipient)) - toUnits(before.recipient)).toBe(toUnits(AMOUNT));
});

/** The payment's status page, opened from the receipt link on Pay's recent payments. */
async function statusPage(page, who) {
  await signIn(page, who);
  await page.goto('/pay');
  await page
    .getByRole('link', { name: /receipt/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/money\/activity\/[^/?]+/);
  await expect(page.getByText('Completed').first()).toBeVisible();
}

test(`${J} #6 reads the payment status page: Completed for both, no Cancel, and a way to report a problem`, async ({ page }) => {
  const { sender, recipient } = people();
  for (const who of [sender, recipient]) {
    await statusPage(page, who);
    await expect(page.getByText(NOTE)).toBeVisible();
    await expect(page.getByText(run.read().reference).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /cancel/i })).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Report a problem' }).or(page.getByRole('button', { name: 'Report a problem' })),
    ).toBeVisible();
    await signOutBrowser(page.context());
  }
});

test(`${J} #7 the recipient opens Pay and sees the payment, the sender, the note and a notice`, async ({ page }) => {
  const { sender, recipient } = people();
  await signIn(page, recipient);
  await page.goto('/pay');
  await expect(page.getByText(`@${sender.handle}`).first()).toBeVisible();
  await expect(page.getByText(`+${AMOUNT} USDT`).first()).toBeVisible();
  await page.goto('/notifications');
  await expect(page.getByText('Money received').first()).toBeVisible();
  await expect(page.getByText(`You received ${AMOUNT} USDT.`)).toHaveCount(1);
});

test(`${J} #8 each person's balance on screen equals the ledger`, async ({ page }) => {
  const { sender, recipient } = people();
  for (const who of [sender, recipient]) {
    await signIn(page, who);
    await page.goto('/money');
    // The screen groups thousands; the ledger answers a plain decimal (75 and 25 here, so no grouping to undo).
    const ledger = await usdt(who);
    await expect(page.getByText(new RegExp(`(^|\\s)${ledger.replace('.', '\\.')}\\s*USDT`)).first()).toBeVisible();
    await signOutBrowser(page.context());
  }
});
