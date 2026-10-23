import path from 'node:path';
import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, ROOT, fund, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-bank-03, in the running app (docs/roadmap/journeys.json): I turn my balance into money in my bank account. One test
// per step, titled "J-bank-03 #<n>", run in order on one TEST account funded with TEST 50 USDT, with an authenticator app
// and one linked TEST bank account. The stack connects no banking partner, so no linked account can be verified and
// nothing can be paid out: this run proves the journey's honest ending. The quote names what stands in the way with no
// fee invented, the ask needs a fresh confirmation, and it is kept refused with nothing taken from the balance. Balances
// are read through the person's own bank API. Not here: #4 and #5 (they follow a payout, which needs a partner), and the
// cooling-off of a verified account (only a partner verifies one; svc-bank's own tests cover it).
const J = 'J-bank-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
// TEST: the standard example IBAN, not a customer's account.
const IBAN = 'GB82 WEST 1234 5698 7654 32';

test.describe.configure({ mode: 'default' });

function state() {
  const now = run.read();
  if (!now.who || !now.secret) throw new Error(`${J} #1 set up no account, so this step has no one to act as`);
  return now;
}

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** The next authenticator code, keeping its step so no code is used twice. */
async function code() {
  const now = state();
  const { totp } = await totpLib();
  const next = await nextCode(totp, now.secret, now.step);
  run.reset({ ...now, step: next.step });
  return next.code;
}

async function signInWithCode(page) {
  const { who } = state();
  const totpCode = await code();
  await page.goto('/login');
  await page.fill('input[name=totp]', totpCode);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function confirmItsMe(page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Authenticator code or recovery code').fill(await code());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  return dialog;
}

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank() {
  const { who } = state();
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: who.email, password: who.password, totpCode: await code() }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const answer = async (res) => {
    const body = await res.json();
    if (!res.ok) return { ok: false, status: res.status, code: body?.error?.data?.intafacedCode ?? body?.error?.data?.code, body };
    return { ok: true, data: body.result.data };
  };
  return {
    query: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, {
        headers,
      }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
  };
}

async function usdt(api) {
  const res = await api.query('spaces.list', { limit: 50 });
  if (!res.ok) throw new Error(`spaces.list refused: ${res.status}`);
  return res.data.find((s) => s.kind === 'primary' && s.assetId === 'USDT')?.balance;
}

/** Open Cash out from the Ramps room and ask what TEST `amount` USDT to the linked account would give. */
async function see(page, amount) {
  await page.getByLabel('Currency to cash out').selectOption('USDT');
  await page.getByLabel('Amount').fill(amount);
  await page.getByLabel('Bank account to pay into').selectOption({ label: 'TEST salary account (GB82 •••• 5432)' });
  await page.getByRole('button', { name: 'See what you get' }).click();
}

async function openCashOut(page) {
  await page.goto('/bank/ramps');
  await page.getByRole('link', { name: 'Cash out to a bank account' }).click();
  await expect(page).toHaveURL(/\/bank\/ramps\/cash-out$/);
  await expect(page.getByRole('heading', { name: 'Cash out to your bank', level: 1 })).toBeVisible();
}

test(`${J} #1 enters an amount and picks a linked account: the available balance, no fee invented, and what stands in the way`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'jb3');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '50').tx).toBeTruthy();
  await signIn(page, who);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ who, secret, step });

  // With no linked account, the room says so and points to where one is linked.
  await openCashOut(page);
  await expect(page.getByText('You have no linked bank account to cash out to.')).toBeVisible();
  await page.getByRole('link', { name: 'Link a bank account' }).click();
  await expect(page).toHaveURL(/\/bank\/ramps\/accounts$/);
  const form = page.getByRole('form', { name: 'Link a bank account' });
  await form.getByLabel('Name for this account').fill('TEST salary account');
  await form.getByLabel('Account holder').fill('TEST Holder');
  await form.getByLabel('IBAN', { exact: true }).fill(IBAN);
  await form.getByRole('button', { name: 'Link account' }).click();
  await confirmItsMe(page);
  await expect(form).toContainText('Linked TEST salary account. It is unverified.');

  await openCashOut(page);
  // More than the balance is refused before anything else, in the person's words.
  await see(page, '60');
  await expect(page.getByRole('alert')).toContainText('That is more than your available balance.');
  await expect(page.getByRole('alert')).toContainText('bank.cash_out_over_available');

  await see(page, '20');
  const quote = page.getByTestId('cash-out-quote');
  await expect(quote).toBeVisible();
  await expect(quote).toContainText('Available now');
  await expect(quote).toContainText('50 USDT');
  await expect(quote).toContainText('20 USDT');
  await expect(quote).toContainText('TEST salary account (GB82 •••• 5432)');
  // No partner prices a cash-out: the fee and what arrives are blank, never a made-up zero.
  await expect(quote.getByText('not set')).toHaveCount(2);
  await expect(page.getByTestId('cash-out-blocker')).toContainText('bank.linked_account_unverified');
  await expect(page.getByTestId('cash-out')).not.toContainText('WEST1234');
});

test(`${J} #2 the account must be verified and past its cooling-off: an unverified one is refused with rail.bank`, async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  await openCashOut(page);
  await see(page, '20');
  await expect(page.getByTestId('cash-out-blocker')).toContainText(
    'This account is unverified. Only a banking partner can verify it, and rail.bank is switched off in this build.',
  );

  // The bank says the same: the account is not usable, and the quote ends on it with no fee or arrival.
  const api = await bank();
  const listed = await api.query('linkedAccounts.list', undefined);
  expect(listed.ok).toBe(true);
  const [account] = listed.data.accounts;
  expect(account).toMatchObject({ state: 'unverified', usable: false, verificationRail: 'rail.bank' });
  const quoted = await api.query('cashOut.quote', { assetId: 'USDT', amount: '20', linkedAccountId: account.accountId });
  expect(quoted).toMatchObject({
    ok: true,
    data: { available: '50', fee: null, receiveAmount: null, rail: 'rail.bank', blocker: 'bank.linked_account_unverified' },
  });
  // Someone else's id, or one that does not exist, is not found.
  const stranger = await api.query('cashOut.quote', {
    assetId: 'USDT',
    amount: '20',
    linkedAccountId: '00000000-0000-4000-8000-000000000000',
  });
  expect(stranger).toMatchObject({ ok: false, status: 404 });
});

test(`${J} #3 confirms with a fresh check: the ask is kept refused with its reason, and nothing leaves the balance`, async ({ page }) => {
  test.setTimeout(240_000);
  await signInWithCode(page);
  await openCashOut(page);
  await expect(page.getByTestId('cash-out-requests')).toContainText('You have not asked to cash out.');
  await see(page, '20');
  await page.getByRole('button', { name: 'Cash out', exact: true }).click();
  const dialog = await confirmItsMe(page);
  await expect(dialog).toHaveCount(0);
  const kept = page.getByTestId('cash-out-kept');
  await expect(kept).toContainText('This cash-out was not sent');
  await expect(kept).toContainText('Nothing left your balance.');
  await expect(kept).toContainText('bank.linked_account_unverified');
  const rows = page.getByTestId('cash-out-request');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Not sent');
  await expect(rows.first()).toContainText('20 USDT');
  await expect(rows.first()).toContainText('rail.bank · Reference: bank.linked_account_unverified');

  // Through the person's own API: kept refused, a session without the fresh check is refused 403 and keeps nothing,
  // and the balance is still 50.
  const api = await bank();
  const requests = await api.query('cashOut.requests', { limit: 10 });
  expect(requests.ok && requests.data).toEqual([
    expect.objectContaining({ amount: '20', assetId: 'USDT', status: 'refused', refusalCode: 'bank.linked_account_unverified' }),
  ]);
  const plain = await api.mutate('cashOut.start', {
    requestId: crypto.randomUUID(),
    assetId: 'USDT',
    amount: '5',
    linkedAccountId: requests.data[0].linkedAccountId,
  });
  expect(plain).toMatchObject({ ok: false, status: 403 });
  expect((await api.query('cashOut.requests', { limit: 10 })).data).toHaveLength(1);
  expect(await usdt(api)).toBe('50');
});
