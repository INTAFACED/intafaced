import { test, expect } from '@playwright/test';
import { api, fund, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-04, in the running app (docs/roadmap/journeys.json): I send money to a person from the bank's Transfers room.
// One test per step, titled "J-bank-04 #<n>", run in order on two TEST accounts: A sends, B receives. The stack's gates
// publish TEST send terms for USDT and USDC with a zero fee (`local-test-gates.mjs apply`) and none for BTC; every number
// here is a TEST number on the local stack, and balances are read through each person's own API.
// Not here yet: #1, #2 and #4 to #7 (each lands with its own slice).
const J = 'J-bank-04';
const AMOUNT = '40';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

/** The two people, made on first use: B is verified, A is verified and holds TEST 100 USDT. */
async function people(page) {
  const now = run.read();
  if (now.sender && now.recipient) return now;
  const recipient = await signUp(page, 'jb4r');
  await verify(page, recipient);
  const sender = await signUp(page, 'jb4s');
  await verify(page, sender);
  expect(fund(sender.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ sender, recipient });
  // Sign-up leaves this browser signed in, and /login resets its form once the session refresh answers, which can wipe
  // the typed email. Start the sign-in signed out, on a page with no app loaded.
  await page.goto('about:blank');
  await page.context().clearCookies();
  return run.read();
}

const usdt = async (who) => (await (await api(who)).balances()).USDT?.free ?? '0';

/** A in the Transfers room with "Another person" chosen, B found by handle, and the amount typed, at the review. */
async function reviewSend(page, { asset = 'USDT', value = AMOUNT, signedIn = false } = {}) {
  const { sender, recipient } = await people(page);
  // Signing in on a page that is already signed in can wipe the typed email, so a second review only navigates.
  if (!signedIn) await signIn(page, sender);
  await page.goto('/bank/transfers');
  const source = page.getByLabel('From your space');
  await expect(source.locator('option', { hasText: asset })).not.toHaveCount(0);
  await source.selectOption({ label: (await source.locator('option', { hasText: asset }).first().innerText()).trim() });
  await page.getByLabel('Destination').selectOption({ label: 'Another person' });
  await page.getByPlaceholder('@handle').fill(recipient.handle);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText(`Paying @${recipient.handle}`)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(new RegExp(`Amount \\(${asset}\\)`)).fill(value);
  await dialog.getByRole('button', { name: 'Review' }).click();
  return dialog;
}

test(`${J} #3 reviews the transfer: fee lines that add up, and Confirm off with the missing fee named`, async ({ page }) => {
  test.setTimeout(180_000);
  const dialog = await reviewSend(page);
  const { recipient, sender } = run.read();
  await expect(dialog).toContainText(`@${recipient.handle}`);
  const rows = dialog.getByTestId('review-terms-row');
  await expect(rows).toHaveCount(4);
  // The service's published TEST fee is zero: one fee line, a total equal to it, and the amount is all that leaves.
  await expect(rows.nth(0)).toContainText('Transfer fee');
  await expect(rows.nth(0)).toContainText('0 USDT');
  await expect(rows.nth(1)).toContainText('Fees in total');
  await expect(rows.nth(1)).toContainText('0 USDT');
  await expect(rows.nth(2)).toContainText('Taken from your account');
  await expect(rows.nth(2)).toContainText(`${AMOUNT} USDT`);
  await expect(rows.nth(3)).toContainText('Left to send today after this');
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  await expect(dialog.getByTestId('review-terms-blocked')).toHaveCount(0);
  // Reviewing moves nothing.
  expect(await usdt(sender)).toBe('100');

  // BTC has no published fee or limits on this stack: the review names what is missing and Confirm stays off.
  const added = await (await api(sender)).post('/api/bank/trpc/currencies.add', { assetId: 'BTC' });
  expect(added.status, `add BTC to the account: ${JSON.stringify(added.body).slice(0, 300)}`).toBe(200);
  expect(fund(sender.email, 'BTC', '0.01').tx).toBeTruthy();
  const btc = await reviewSend(page, { asset: 'BTC', value: '0.001', signedIn: true });
  const blocked = btc.getByTestId('review-terms-blocked');
  await expect(blocked).toContainText('No fee or sending limit is published for BTC');
  await expect(blocked).toContainText('bank.personal_transfer_terms_unset');
  await expect(btc.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await expect(btc.getByTestId('review-terms-row')).toHaveCount(0);
});
