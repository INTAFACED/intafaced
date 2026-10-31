import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, fund, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-bank-03, in the running app (docs/roadmap/journeys.json): I turn my balance into money in my bank account. One test
// per step, titled "J-bank-03 #<n>", run in order on one TEST account funded with TEST 50 USDT, with an authenticator app
// and one linked TEST bank account. Steps 1 to 3 run before any banking partner has verified that account, so they prove
// the honest ending: the quote names what stands in the way with no fee invented, the ask needs a fresh confirmation,
// and it is kept refused with nothing taken from the balance. Steps 4 and 5 run against the stack's TEST payout stand-in
// (BANK_PAYOUT_PARTNER=payout-sim, which pays nobody): its signed calls verify the account and say paid, failed or came
// back, as a partner would, and the stack's TEST fixture moves the link past its 24-hour cooling-off (the journey starts
// from "a saved bank destination past its cooling-off"). Balances are read through the person's own bank API.
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
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, totpCode: await code() }),
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

let jobCtx;
/** One call of the TEST payout partner's signed job door, as the partner would make it. */
async function partner(what, body) {
  jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} }));
  const ctx = await jobCtx;
  const raw = JSON.stringify(body);
  const res = await fetch(`${ctx.url('bank')}/internal/jobs/payout-sim/${what}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const answer = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`payout-sim/${what} refused: ${res.status} ${JSON.stringify(answer).slice(0, 300)}`);
  return answer;
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

test(`${J} #4 watches the tracker: verified by the partner, the cash-out goes from processing to completed, and its receipt is signed with the ledger id`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { who } = state();
  const api = await bank();
  const [account] = (await api.query('linkedAccounts.list', undefined)).data.accounts;
  // The partner verifies the account, and the TEST fixture moves its link past the 24-hour cooling-off.
  expect(await partner('verify', { accountId: account.accountId })).toMatchObject({ state: 'verified', verificationRail: null });
  expect(tool('local-test-stack.mjs', 'age-linked-accounts', who.email, '25')).toContain('1 linked account(s)');

  await signInWithCode(page);
  await openCashOut(page);
  await see(page, '20');
  // Now the partner prices it: its TEST fee and what arrives, in euros, with the stand-in named and nothing in the way.
  const quote = page.getByTestId('cash-out-quote');
  await expect(quote).toContainText('1.5 EUR');
  await expect(quote).toContainText('16.5 EUR');
  await expect(quote.getByText('not set')).toHaveCount(0);
  await expect(page.getByTestId('cash-out-stand-in')).toContainText('TEST price from a stand-in');
  await expect(page.getByTestId('cash-out-blocker')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cash out', exact: true }).click();
  await confirmItsMe(page);
  await expect(page.getByTestId('cash-out-sent')).toContainText('Your cash-out is on its way');
  // Once it is on its way the quote cannot be confirmed again: another cash-out starts from a fresh quote.
  await expect(page.getByRole('button', { name: 'Cash out', exact: true })).toHaveCount(0);

  // The tracker: processing, step 1 of 2, no cancel and no receipt while the bank has it; 20 is held from the balance.
  const newest = page.getByTestId('cash-out-request').first();
  await expect(newest).toHaveAttribute('data-status', 'processing');
  await expect(newest.getByTestId('cash-out-steps')).toHaveAttribute('aria-label', 'Processing (1/2)');
  await expect(newest).toContainText('cannot be cancelled');
  await expect(newest).toContainText('The receipt is ready once the bank has paid it out.');
  await expect(newest.getByRole('button', { name: 'Download receipt' })).toHaveCount(0);
  const [taken] = (await api.query('cashOut.requests', { limit: 10 })).data;
  expect(taken).toMatchObject({ amount: '20', status: 'processing', payoutRef: `TEST-PAYOUT-${taken.requestId}` });
  expect(await usdt(api)).toBe('30');

  // The partner says it was paid: completed, once.
  const paid = await partner('paid', { cashOutId: taken.requestId });
  expect(paid).toMatchObject({ status: 'completed', ledgerTxId: expect.any(String) });
  expect(await partner('paid', { cashOutId: taken.requestId })).toEqual(paid);
  await page.reload();
  const done = page.locator(`[data-testid="cash-out-request"][data-status="completed"]`).first();
  await expect(done.getByTestId('cash-out-steps')).toHaveAttribute('aria-label', 'Completed (2/2)');
  await expect(done).toContainText('Bank reference: TEST-PAYOUT-');

  // The receipt: a file, signed, naming the ledger transaction; the hash on screen is the hash of the file.
  const receipt = done.getByTestId('cash-out-receipt');
  const [download] = await Promise.all([page.waitForEvent('download'), receipt.getByRole('button', { name: 'Download receipt' }).click()]);
  expect(download.suggestedFilename()).toBe(`receipt-${taken.requestId}.txt`);
  const file = readFileSync(await download.path(), 'utf8');
  expect(file).toContain(`Ledger transaction: ${paid.ledgerTxId}`);
  expect(file).toContain('Sent: 20 USDT');
  expect(file).toContain('Arrives: 16.5 EUR');
  expect(file).toContain('To: TEST Holder · GB82 •••• 5432');
  await expect(receipt.getByTestId('cash-out-receipt-ledger')).toHaveText(`Ledger record: ${paid.ledgerTxId}`);
  await expect(receipt.getByTestId('cash-out-receipt-hash')).toHaveText(`SHA-256: ${createHash('sha256').update(file).digest('hex')}`);
  await expect(receipt).toContainText(/Signed: [0-9a-f]{64}/);

  // The request step 3 kept refused has no receipt, and says why.
  const notSent = page.locator(`[data-testid="cash-out-request"][data-status="refused"]`).first();
  await expect(notSent.getByTestId('cash-out-no-receipt')).toHaveText('No receipt: this cash-out was not sent.');
  await expect(notSent.getByRole('button', { name: 'Download receipt' })).toHaveCount(0);
  expect(await usdt(api)).toBe('30');
});

test(`${J} #5 sees a failed and a returned payout: the reason in plain words, the money back once, and what stays paid out`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signInWithCode(page);
  await openCashOut(page);
  await see(page, '10');
  await page.getByRole('button', { name: 'Cash out', exact: true }).click();
  await confirmItsMe(page);
  await expect(page.getByTestId('cash-out-sent')).toBeVisible();
  const api = await bank();
  const requests = (await api.query('cashOut.requests', { limit: 10 })).data;
  const failing = requests.find((r) => r.amount === '10' && r.status === 'processing');
  const completed = requests.find((r) => r.status === 'completed');
  expect(failing && completed).toBeTruthy();
  expect(await usdt(api)).toBe('20');

  // The partner could not pay it: the account is closed. The 10 comes back once, however often it says so.
  expect(await partner('failed', { cashOutId: failing.requestId, reason: 'bank.payout_account_closed' })).toMatchObject({
    status: 'failed',
    failureCode: 'bank.payout_account_closed',
  });
  expect(await partner('failed', { cashOutId: failing.requestId, reason: 'bank.payout_account_closed' })).toMatchObject({
    status: 'failed',
  });
  expect(await usdt(api)).toBe('30');
  await page.reload();
  const failed = page.locator(`[data-testid="cash-out-request"][data-status="failed"]`).first();
  await expect(failed.getByTestId('cash-out-why')).toContainText('The receiving bank says this account is closed.');
  await expect(failed.getByTestId('cash-out-why')).toContainText('10 USDT is back in your available balance, once.');
  await expect(failed.getByTestId('cash-out-no-receipt')).toHaveText('No receipt: this cash-out was not paid out.');

  // The receiving bank sends part of the paid-out 20 back: 5 is credited once, and 15 stays paid out.
  expect(
    await partner('returned', { cashOutId: completed.requestId, amount: '5', assetId: 'USDT', reason: 'bank.payout_returned_by_bank' }),
  ).toMatchObject({
    status: 'returned',
    returnedAmount: '5',
    remainsPaidOut: '15',
  });
  expect(
    await partner('returned', { cashOutId: completed.requestId, amount: '5', assetId: 'USDT', reason: 'bank.payout_returned_by_bank' }),
  ).toMatchObject({
    status: 'returned',
    returnedAmount: '5',
  });
  expect(await usdt(api)).toBe('35');
  await page.reload();
  const back = page.locator(`[data-testid="cash-out-request"][data-status="returned"]`).first();
  await expect(back).toContainText('Came back');
  await expect(back.getByTestId('cash-out-why')).toContainText(
    'The receiving bank sent it back. 5 USDT of 20 USDT came back to your available balance, once. The other 15 USDT stays paid out.',
  );
  // It was paid out, so its receipt still stands.
  await expect(back.getByRole('button', { name: 'Download receipt' })).toBeVisible();
});
