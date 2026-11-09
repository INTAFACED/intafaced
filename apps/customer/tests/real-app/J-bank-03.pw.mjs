// World: restart, stack
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, journeyState, restartWith, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-bank-03, in the running app (docs/roadmap/journeys.json): I turn my balance into money in my bank account, with the
// adapted words (OWNER 226, CUSTODY-DELTA): the partner bank holds the person's money and the ledger posts nothing. One test
// per step, titled "J-bank-03 #<n>", run in order on one TEST account. The person's bank money is at the stack's TEST
// partner bank (`testPartner.set({ custody: 'off' })`), funded there with TEST 50 USDT (`testPartner.fund`), with an
// authenticator app and a saved TEST bank destination that the TEST payout stand-in (BANK_PAYOUT_PARTNER=payout-sim, which
// pays nobody) verified and that the stack's TEST fixture moved past its 24-hour cooling-off, as the journey starts. The
// stand-in's signed calls say paid, failed, cancelled or came back, as a partner would. Balances are the partner's figures,
// read through the person's own bank API. #2 restarts svc-bank with the cooling-off blank, which empties the TEST partner's
// in-process book, so the person is put back at the partner with TEST 50 USDT after it.
const J = 'J-bank-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
// TEST: the standard example IBANs, not a customer's accounts.
const IBAN = 'GB82 WEST 1234 5698 7654 32';
const NEW_IBAN = 'DE89 3704 0044 0532 0130 00';
const SAVED = 'TEST salary account (GB82 •••• 5432)';
const NEW = 'TEST new account (DE89 •••• 3000)';
const PARTNER_BANK = 'TEST partner bank';

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

/** The person's USDT main balance as the partner bank reports it (the space says where it is held). */
async function usdt(api) {
  const res = await api.query('spaces.list', { limit: 50 });
  if (!res.ok) throw new Error(`spaces.list refused: ${res.status}`);
  const main = res.data.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
  expect(main?.heldAt?.label).toBe(PARTNER_BANK);
  return main.balance;
}

/** The person's money at the TEST partner bank, funded there once per `fundId` with TEST 50 USDT. */
async function atPartner(api, fundId) {
  const set = await api.mutate('testPartner.set', { custody: 'off' });
  if (!set.ok) throw new Error(`testPartner.set refused: ${set.status} ${JSON.stringify(set.body).slice(0, 300)}`);
  const funded = await api.mutate('testPartner.fund', { fundId, assetId: 'USDT', amount: '50' });
  if (!funded.ok) throw new Error(`testPartner.fund refused: ${funded.status} ${JSON.stringify(funded.body).slice(0, 300)}`);
  return funded.data;
}

/** The receipt's HMAC-SHA256 as svc-bank signs it: a key derived for cash-out receipts from the stack's service secret. */
async function expectedSignature(text) {
  jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} }));
  const ctx = await jobCtx;
  const key = Buffer.from(hkdfSync('sha256', ctx.secrets.internal, Buffer.alloc(0), 'bank.cash-out.receipt.v1', 32));
  return createHmac('sha256', key).update(Buffer.from(text, 'utf8')).digest('hex');
}

/** Link a TEST bank destination on /bank/ramps/accounts, behind the fresh check. */
async function link(page, name, iban) {
  await page.goto('/bank/ramps/accounts');
  const form = page.getByRole('form', { name: 'Link a bank account' });
  await form.getByLabel('Name for this account').fill(name);
  await form.getByLabel('Account holder').fill('TEST Holder');
  await form.getByLabel('IBAN', { exact: true }).fill(iban);
  await form.getByRole('button', { name: 'Link account' }).click();
  await confirmItsMe(page);
  await expect(form).toContainText(`Linked ${name}. It is unverified.`);
}

/** Ask what TEST `amount` USDT to a linked account would give. */
async function see(page, amount, account = SAVED) {
  await page.getByLabel('Currency to cash out').selectOption('USDT');
  await page.getByLabel('Amount').fill(amount);
  await page.getByLabel('Bank account to pay into').selectOption({ label: account });
  await page.getByRole('button', { name: 'See what you get' }).click();
}

async function openCashOut(page) {
  await page.goto('/bank/ramps');
  await page.getByRole('link', { name: 'Cash out to a bank account' }).click();
  await expect(page).toHaveURL(/\/bank\/ramps\/cash-out$/);
  await expect(page.getByRole('heading', { name: 'Cash out to your bank', level: 1 })).toBeVisible();
}

test(`${J} #1 opens cash out and enters the amount: the partner's quote with its fee and what arrives, and the entry checks in plain words`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await signUp(page, 'jb3');
  await verify(page, who);
  await signIn(page, who);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ who, secret, step });

  // The journey's start: the person's bank money at the partner bank, TEST 50 USDT there, and nothing on our ledger.
  const api = await bank();
  expect(await atPartner(api, `jb3-start-${who.email}`)).toMatchObject({ label: PARTNER_BANK, assetId: 'USDT', balance: '50' });
  // A saved destination: linked, verified by the partner, and past its cooling-off.
  await link(page, 'TEST salary account', IBAN);
  const [account] = (await api.query('linkedAccounts.list', undefined)).data.accounts;
  expect(await partner('verify', { accountId: account.accountId })).toMatchObject({ state: 'verified', verificationRail: null });
  expect(tool('local-test-stack.mjs', 'age-linked-accounts', who.email, '25')).toContain('1 linked account(s)');

  await openCashOut(page);
  // The entry checks, in the person's words: no amount, a zero, and more than the balance the partner holds.
  await page.getByLabel('Currency to cash out').selectOption('USDT');
  await page.getByLabel('Amount').fill('0');
  await page.getByRole('button', { name: 'See what you get' }).click();
  await expect(page.getByText('Enter an amount above zero, with up to 18 decimals.')).toBeVisible();
  await expect(page.getByTestId('cash-out-quote')).toHaveCount(0);
  await see(page, '60');
  await expect(page.getByRole('alert')).toContainText('That is more than your available balance.');
  await expect(page.getByRole('alert')).toContainText('bank.cash_out_over_available');

  // The quote: the partner's fee and what arrives, in euros, against the balance at the partner bank.
  await see(page, '20');
  const quote = page.getByTestId('cash-out-quote');
  await expect(quote).toContainText('Available now at TEST partner bank');
  await expect(quote).toContainText('50 USDT');
  await expect(quote).toContainText('20 USDT');
  await expect(quote).toContainText(SAVED);
  await expect(quote).toContainText('1.5 EUR');
  await expect(quote).toContainText('16.5 EUR');
  await expect(quote.getByText('not set')).toHaveCount(0);
  await expect(page.getByTestId('cash-out-stand-in')).toContainText('TEST price from a stand-in');
  await expect(page.getByTestId('cash-out-blocker')).toHaveCount(0);
  await expect(page.getByTestId('cash-out')).not.toContainText('WEST1234');
  // The bank says the same figures, and that the balance is the partner's.
  expect(await api.query('cashOut.quote', { assetId: 'USDT', amount: '20', linkedAccountId: account.accountId })).toMatchObject({
    ok: true,
    data: { available: '50', heldAt: PARTNER_BANK, fee: '1.5', receiveAmount: '16.5', receiveCurrency: 'EUR', blocker: null },
  });
  expect(await api.query('cashOut.quote', { assetId: 'USDT', amount: '60', linkedAccountId: account.accountId })).toMatchObject({
    ok: false,
    code: 'bank.cash_out_over_available',
  });
  expect(await usdt(api)).toBe('50');
});

test(`${J} #2 chooses a saved destination: one inside its cooling window is refused with the end time, a blank window refuses, and a new destination restarts the window`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const { who } = state();
  await signInWithCode(page);
  const api = await bank();

  // A new destination, verified by the partner: its own window starts now, while the saved one stays usable.
  await link(page, 'TEST new account', NEW_IBAN);
  const accounts = (await api.query('linkedAccounts.list', undefined)).data.accounts;
  const saved = accounts.find((a) => a.label === 'TEST salary account');
  const fresh = accounts.find((a) => a.label === 'TEST new account');
  await partner('verify', { accountId: fresh.accountId });
  const ends = Date.parse(fresh.coolingOffEndsAt);
  expect(ends - Date.parse(fresh.linkedAt)).toBe(24 * 3600_000);
  expect(ends).toBeGreaterThan(Date.now());
  expect(Date.parse(saved.coolingOffEndsAt)).toBeLessThan(Date.now());

  await openCashOut(page);
  await see(page, '20', NEW);
  const blocker = page.getByTestId('cash-out-blocker');
  await expect(blocker).toContainText('This account is new. Money can be sent to it from');
  await expect(blocker).toContainText('when its cooling-off ends.');
  await expect(blocker).toContainText('bank.offramp_cooling_active');
  await expect(page.getByTestId('cash-out-quote').getByText('not set')).toHaveCount(2);
  expect(await api.query('cashOut.quote', { assetId: 'USDT', amount: '20', linkedAccountId: fresh.accountId })).toMatchObject({
    ok: true,
    data: { blocker: 'bank.offramp_cooling_active', fee: null, account: { coolingOffEndsAt: fresh.coolingOffEndsAt } },
  });
  // Asked anyway, it is kept refused and nothing reaches the partner: no payout reference, the balance untouched.
  await page.getByRole('button', { name: 'Cash out', exact: true }).click();
  await confirmItsMe(page);
  await expect(page.getByTestId('cash-out-kept')).toContainText('bank.offramp_cooling_active');
  const [kept] = (await api.query('cashOut.requests', { limit: 10 })).data;
  expect(kept).toMatchObject({ status: 'refused', refusalCode: 'bank.offramp_cooling_active', payoutRef: null, partnerMoveId: null });
  expect(await usdt(api)).toBe('50');
  // The saved destination, past its window, is the one the quote goes ahead with.
  await see(page, '20', SAVED);
  await expect(page.getByTestId('cash-out-blocker')).toHaveCount(0);

  // With the owner's cooling-off blank, no destination can be paid: the saved one refuses too.
  restartWith('bank', 'LOCAL_STACK_BANK_OFFRAMP_COOLING', false);
  try {
    const blank = await bank();
    await atPartner(blank, `jb3-blank-${who.email}`);
    expect(await blank.query('cashOut.quote', { assetId: 'USDT', amount: '20', linkedAccountId: saved.accountId })).toMatchObject({
      ok: true,
      data: { blocker: 'bank.offramp_cooling_unset', fee: null, receiveAmount: null, account: { coolingOffEndsAt: null } },
    });
    await openCashOut(page);
    await see(page, '20', SAVED);
    await expect(page.getByTestId('cash-out-blocker')).toContainText(
      'The bank has published no cooling-off period for new accounts, so nothing can be sent to this one.',
    );
  } finally {
    restartWith('bank', 'LOCAL_STACK_BANK_OFFRAMP_COOLING', true);
  }
  // Back on the stack's TEST 24 hours; the restart emptied the TEST partner's book, so the person is put back there.
  const after = await bank();
  await atPartner(after, `jb3-after-${who.email}`);
  expect(await usdt(after)).toBe('50');
  expect((await after.query('cashOut.quote', { assetId: 'USDT', amount: '20', linkedAccountId: saved.accountId })).data.blocker).toBeNull();
});

test(`${J} #3 confirms with step-up: the cash-out needs a second-factor session, and a normal session is refused by its code`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInWithCode(page);
  const api = await bank();
  const before = (await api.query('cashOut.requests', { limit: 10 })).data;
  await openCashOut(page);
  await see(page, '20');
  // Confirming asks for the second factor first; stepping away from it sends nothing.
  await page.getByRole('button', { name: 'Cash out', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Cashing out sends money out of your account, so it needs a fresh confirmation.');
  await expect(dialog.getByLabel('Authenticator code or recovery code')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('cash-out-sent')).toHaveCount(0);

  // A normal session, without the fresh second factor, is refused by name and keeps nothing.
  const plain = await api.mutate('cashOut.start', {
    requestId: crypto.randomUUID(),
    assetId: 'USDT',
    amount: '5',
    linkedAccountId: before[0].linkedAccountId,
  });
  expect(plain).toMatchObject({ ok: false, status: 403, code: 'scope.denied' });
  expect(JSON.stringify(plain.body)).toContain('trade:withdraw');
  expect((await api.query('cashOut.requests', { limit: 10 })).data).toEqual(before);
  expect(await usdt(api)).toBe('50');
});

test(`${J} #4 watches the transfer tracker: processing to completed as the partner reports, a signed receipt with the partner's id, and a cancelled order with no button and its reason`, async ({
  page,
}) => {
  test.setTimeout(360_000);
  const api = await bank();
  await signInWithCode(page);
  await openCashOut(page);
  await see(page, '20');
  await page.getByRole('button', { name: 'Cash out', exact: true }).click();
  await confirmItsMe(page);
  await expect(page.getByTestId('cash-out-sent')).toContainText('Your cash-out is on its way');
  await expect(page.getByTestId('cash-out-sent')).toContainText('The amount left your balance at TEST partner bank, which pays it out.');
  await expect(page.getByRole('button', { name: 'Cash out', exact: true })).toHaveCount(0);

  // Processing, step 1 of 2: no cancel and no receipt while the bank has it; 20 left the partner balance once.
  const newest = page.getByTestId('cash-out-request').first();
  await expect(newest).toHaveAttribute('data-status', 'processing');
  await expect(newest.getByTestId('cash-out-steps')).toHaveAttribute('aria-label', 'Processing (1/2)');
  await expect(newest).toContainText('The bank already has it, so it cannot be cancelled.');
  await expect(newest.getByRole('button', { name: /cancel/i })).toHaveCount(0);
  await expect(newest).toContainText('The receipt is ready once the bank has paid it out.');
  await expect(newest.getByRole('button', { name: 'Download receipt' })).toHaveCount(0);
  const [taken] = (await api.query('cashOut.requests', { limit: 10 })).data;
  expect(taken).toMatchObject({
    amount: '20',
    status: 'processing',
    heldAt: PARTNER_BANK,
    ledgerTxId: null,
    payoutRef: `TEST-PAYOUT-${taken.requestId}`,
  });
  expect(taken.partnerMoveId).toMatch(/^test-partner-move-\d+$/);
  expect(await usdt(api)).toBe('30');

  // The partner says it was paid: completed, once, with nothing posted to the ledger.
  const paid = await partner('paid', { cashOutId: taken.requestId });
  expect(paid).toMatchObject({ status: 'completed', ledgerTxId: null, partnerMoveId: taken.partnerMoveId, remainsPaidOut: '20' });
  expect(await partner('paid', { cashOutId: taken.requestId })).toEqual(paid);
  expect(await usdt(api)).toBe('30');
  await page.reload();
  const done = page.locator(`[data-testid="cash-out-request"][data-status="completed"]`).first();
  await expect(done.getByTestId('cash-out-steps')).toHaveAttribute('aria-label', 'Completed (2/2)');
  await expect(done).toContainText(`Bank reference: TEST-PAYOUT-${taken.requestId}`);

  // The receipt: a file naming the partner's payout reference and move, signed by svc-bank, the signature checked here.
  const receipt = done.getByTestId('cash-out-receipt');
  const [download] = await Promise.all([page.waitForEvent('download'), receipt.getByRole('button', { name: 'Download receipt' }).click()]);
  expect(download.suggestedFilename()).toBe(`receipt-${taken.requestId}.txt`);
  const file = readFileSync(await download.path(), 'utf8');
  expect(file).toContain(`Payout reference: TEST-PAYOUT-${taken.requestId}`);
  expect(file).toContain(`Partner payout: ${taken.partnerMoveId}`);
  expect(file).toContain(`Held at: ${PARTNER_BANK}`);
  expect(file).not.toContain('Ledger transaction');
  expect(file).toContain('Status: completed');
  expect(file).toContain('Sent: 20 USDT');
  expect(file).toContain('Arrives: 16.5 EUR');
  expect(file).toContain('To: TEST Holder · GB82 •••• 5432');
  await expect(receipt.getByTestId('cash-out-receipt-partner')).toHaveText(`Partner record: ${taken.partnerMoveId}`);
  await expect(receipt.getByTestId('cash-out-receipt-hash')).toHaveText(`SHA-256: ${createHash('sha256').update(file).digest('hex')}`);
  await expect(receipt).toContainText(`Signed: ${await expectedSignature(file)}`);
  const signed = (await api.query('cashOut.receipt', { requestId: taken.requestId })).data;
  expect(signed).toMatchObject({ text: file, ledgerTxId: null, partnerMoveId: taken.partnerMoveId });
  expect(signed.signature).toBe(await expectedSignature(file));

  // A cancelled order: the partner cancels a 5 cash-out before paying it, the 5 comes back once, and the row offers no
  // button, neither a cancel nor a receipt, and says why.
  await openCashOut(page);
  await see(page, '5');
  await page.getByRole('button', { name: 'Cash out', exact: true }).click();
  await confirmItsMe(page);
  await expect(page.getByTestId('cash-out-sent')).toBeVisible();
  const cancelling = (await api.query('cashOut.requests', { limit: 10 })).data.find((r) => r.amount === '5' && r.status === 'processing');
  expect(await usdt(api)).toBe('25');
  const cancelled = await partner('cancelled', { cashOutId: cancelling.requestId, reason: 'bank.payout_cancelled_by_bank' });
  expect(cancelled).toMatchObject({ status: 'cancelled', failureCode: 'bank.payout_cancelled_by_bank', ledgerTxId: null });
  expect(await partner('cancelled', { cashOutId: cancelling.requestId, reason: 'bank.payout_cancelled_by_bank' })).toEqual(cancelled);
  expect(await usdt(api)).toBe('30');
  await page.reload();
  const off = page.locator(`[data-testid="cash-out-request"][data-status="cancelled"]`).first();
  await expect(off).toContainText('Cancelled');
  await expect(off.getByTestId('cash-out-why')).toContainText('The bank cancelled this cash-out before paying it out.');
  await expect(off.getByTestId('cash-out-why')).toContainText('5 USDT is back in your balance at TEST partner bank, once.');
  await expect(off.getByTestId('cash-out-no-receipt')).toHaveText(
    'No receipt and nothing to cancel: the bank cancelled this cash-out before paying it out.',
  );
  await expect(off.getByRole('button')).toHaveCount(0);
  expect((await api.query('cashOut.receipt', { requestId: cancelling.requestId })).code).toBe('bank.cash_out_receipt_not_ready');

  // The request #2 kept refused has no receipt either, and says why.
  const notSent = page.locator(`[data-testid="cash-out-request"][data-status="refused"]`).first();
  await expect(notSent.getByTestId('cash-out-no-receipt')).toHaveText('No receipt: this cash-out was not sent.');
  await expect(notSent.getByRole('button')).toHaveCount(0);
});

test(`${J} #5 sees a failed and a returned payout: the partner's reason in plain words, the money back in the partner balance once, and what stays paid out`, async ({
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

  // The partner could not pay it: the account is closed. The 10 comes back to the partner balance once, however often
  // it says so, and the ledger posts nothing.
  expect(await partner('failed', { cashOutId: failing.requestId, reason: 'bank.payout_account_closed' })).toMatchObject({
    status: 'failed',
    failureCode: 'bank.payout_account_closed',
    ledgerTxId: null,
  });
  expect(await partner('failed', { cashOutId: failing.requestId, reason: 'bank.payout_account_closed' })).toMatchObject({
    status: 'failed',
  });
  expect(await usdt(api)).toBe('30');
  await page.reload();
  const failed = page.locator(`[data-testid="cash-out-request"][data-status="failed"]`).first();
  await expect(failed.getByTestId('cash-out-why')).toContainText('The receiving bank says this account is closed.');
  await expect(failed.getByTestId('cash-out-why')).toContainText('10 USDT is back in your balance at TEST partner bank, once.');
  await expect(failed.getByTestId('cash-out-no-receipt')).toHaveText('No receipt: this cash-out was not paid out.');

  // The receiving bank sends part of the paid-out 20 back: 5 is credited to the partner balance once, 15 stays paid out.
  expect(
    await partner('returned', { cashOutId: completed.requestId, amount: '5', assetId: 'USDT', reason: 'bank.payout_returned_by_bank' }),
  ).toMatchObject({
    status: 'returned',
    returnedAmount: '5',
    remainsPaidOut: '15',
    ledgerTxId: null,
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
    'The receiving bank sent it back. 5 USDT of 20 USDT came back to your balance at TEST partner bank, once. The other 15 USDT stays paid out.',
  );
  // It was paid out, so its receipt still stands, now naming what came back and the partner's move for it.
  await expect(back.getByRole('button', { name: 'Download receipt' })).toBeVisible();
  const receipt = (await api.query('cashOut.receipt', { requestId: completed.requestId })).data;
  expect(receipt.text).toContain('Came back: 5 USDT (bank.payout_returned_by_bank)');
  expect(receipt.text).toContain('Stays paid out: 15 USDT');
  expect(receipt.text).toMatch(/Partner return: test-partner-move-\d+/);
  expect(receipt.signature).toBe(await expectedSignature(receipt.text));
});
