import path from 'node:path';
import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, ROOT, api, fund, journeyState, staffFreeze } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-bank-04, in the running app (docs/roadmap/journeys.json): I send money to a person from the bank's Transfers room.
// One test per step, titled "J-bank-04 #<n>", run in order on TEST accounts: A sends (with an authenticator app), B
// receives, and C is frozen by staff. The stack's gates publish TEST send terms for USDT and USDC with a zero fee
// (`local-test-gates.mjs apply`) and none for BTC; every number here is a TEST number on the local stack, and balances
// are read through each person's own API. Not here yet: #1, #2 and #5 to #7 (each lands with its own slice).
const J = 'J-bank-04';
const AMOUNT = '40';
const NOTE = 'Lunch, TEST';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** The next authenticator code for A, keeping its step so no code is used twice. */
async function code() {
  const now = run.read();
  const { totp } = await totpLib();
  const next = await nextCode(totp, now.secret, now.step);
  run.write({ step: next.step });
  return next.code;
}

/** A session token for A through identity's own sign-in, with a fresh code. */
async function senderToken() {
  const { sender } = run.read();
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: sender.email, password: sender.password, totpCode: await code() }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${sender.email} refused`);
  return token;
}

/** A's free USDT from the ledger, through A's own API. */
async function senderUsdt() {
  const res = await fetch(`${EDGE}/api/v1/account/balance`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${await senderToken()}` },
  });
  return (await res.json()).balances?.USDT?.free ?? '0';
}
const usdt = async (who) => (await (await api(who)).balances()).USDT?.free ?? '0';

/** A signs in with password and a fresh code. */
async function signInSender(page) {
  const { sender } = run.read();
  const totpCode = await code();
  await page.goto('/login');
  await page.fill('input[name=totp]', totpCode);
  await page.fill('input[name=identifier]', sender.email);
  await page.fill('input[name=password]', sender.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The people, made on first use: B is verified, A is verified, holds TEST 100 USDT and has an authenticator app. */
async function people(page) {
  const now = run.read();
  if (now.sender && now.recipient && now.secret) return now;
  const recipient = await signUp(page, 'jb4r');
  await verify(page, recipient);
  const sender = await signUp(page, 'jb4s');
  await verify(page, sender);
  expect(fund(sender.email, 'USDT', '100').tx).toBeTruthy();
  await page.goto('/login');
  await page.fill('input[name=identifier]', sender.email);
  await page.fill('input[name=password]', sender.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ sender, recipient, secret, step });
  // /login resets its form once a session refresh answers, which can wipe the typed email: start the next sign-in clean.
  await page.goto('about:blank');
  await page.context().clearCookies();
  return run.read();
}

/** A in the Transfers room: "Another person", the handle found, a note, and the amount typed, at the review. */
async function reviewSend(page, { to, asset = 'USDT', value = AMOUNT, note = '', signedIn = false } = {}) {
  const { recipient } = await people(page);
  // Signing in on a page that is already signed in can wipe the typed email, so a second review only navigates.
  if (!signedIn) await signInSender(page);
  await page.goto('/bank/transfers');
  const source = page.getByLabel('From your space');
  await expect(source.locator('option', { hasText: asset })).not.toHaveCount(0);
  await source.selectOption({ label: (await source.locator('option', { hasText: asset }).first().innerText()).trim() });
  await page.getByLabel('Destination').selectOption({ label: 'Another person' });
  const handle = (to ?? recipient).handle;
  await page.getByPlaceholder('@handle').fill(handle);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText(`Paying @${handle}`)).toBeVisible();
  if (note) await page.getByLabel('Note for the recipient').fill(note);
  await page.getByRole('button', { name: 'Continue' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(new RegExp(`Amount \\(${asset}\\)`)).fill(value);
  await dialog.getByRole('button', { name: 'Review' }).click();
  return dialog;
}

test(`${J} #3 reviews the transfer: fee lines that add up, and Confirm off with the missing fee named`, async ({ page }) => {
  test.setTimeout(240_000);
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
  // Nothing blocks it: the code field that confirms the send is open.
  await expect(dialog.getByTestId('step-up-confirm').getByLabel('Authenticator code')).toBeEnabled();
  await expect(dialog.getByTestId('review-terms-blocked')).toHaveCount(0);
  // Reviewing moves nothing.
  expect(await usdt(recipient)).toBe('0');

  // BTC has no published fee or limits on this stack: the review names what is missing and Confirm stays off.
  const added = await fetch(`${EDGE}/api/bank/trpc/currencies.add`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${await senderToken()}` },
    body: JSON.stringify({ assetId: 'BTC' }),
  });
  expect(added.status, 'add BTC to the account').toBe(200);
  expect(fund(sender.email, 'BTC', '0.01').tx).toBeTruthy();
  const btc = await reviewSend(page, { asset: 'BTC', value: '0.001', signedIn: true });
  const blocked = btc.getByTestId('review-terms-blocked');
  await expect(blocked).toContainText('No fee or sending limit is published for BTC');
  await expect(blocked).toContainText('bank.personal_transfer_terms_unset');
  await expect(btc.getByTestId('step-up-confirm').getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  await expect(btc.getByTestId('step-up-confirm').getByLabel('Authenticator code')).toBeDisabled();
  await expect(btc.getByTestId('review-terms-row')).toHaveCount(0);
});

test(`${J} #4 confirms with a fresh code: the money reaches the person once, and a frozen recipient is refused`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const dialog = await reviewSend(page, { note: NOTE });
  const { recipient } = run.read();
  const before = await usdt(recipient);
  const senderBefore = await senderUsdt();
  // A send to another person needs a fresh second factor for exactly this send, with its note.
  const stepUp = dialog.getByTestId('step-up-confirm');
  await expect(stepUp).toContainText('Confirm it’s you');
  await stepUp.getByLabel('Authenticator code').fill(await code());
  await stepUp.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog.getByTestId('step-up-confirm')).toHaveCount(0, { timeout: 30_000 });
  await expect(dialog).not.toContainText('Nothing was sent');
  await expect.poll(() => usdt(recipient), { timeout: 30_000 }).toBe(String(Number(before) + Number(AMOUNT)));
  expect(await senderUsdt()).toBe(String(Number(senderBefore) - Number(AMOUNT)));

  // C is frozen by staff after A picked them (a frozen account is not found by handle at all): the bank refuses the
  // send before any posting, and it is never shown as sent.
  const other = await (await browser.newContext()).newPage();
  const frozen = await signUp(other, 'jb4c');
  await verify(other, frozen);
  const refused = await reviewSend(page, { to: frozen, value: '1', signedIn: true });
  await staffFreeze(frozen);
  const confirm = refused.getByTestId('step-up-confirm');
  await confirm.getByLabel('Authenticator code').fill(await code());
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(refused).toContainText('That person cannot receive this right now. Nothing was sent.', { timeout: 30_000 });
  expect(await senderUsdt()).toBe(String(Number(senderBefore) - Number(AMOUNT)));
});
