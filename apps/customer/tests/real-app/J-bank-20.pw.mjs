// World: stack
import { randomBytes, randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api as ledgerApi, journeyState, json, signOutBrowser, signUpInBrowser } from './stack.mjs';
import { signIn, verify } from './desk.mjs';

// J-bank-20, in the running app (docs/roadmap/journeys.json): I pay my suppliers' bills. Tests titled "J-bank-20 #<n>"
// prove a step.
//
// Starts: a business admin (the business's owner), signed up as a business and verified, in Business mode on a business
// bank account whose money is the TEST partner bank's: the owner's bank money is held there (`custody: 'off'`) and TEST
// 1000 USDT is paid into the business's own partner account (`testPartner.fundBusiness`), the partner's figure and no
// ledger post. An approver (the built-in checker role) is on the team. The bill inbox is upload only: email forwarding
// needs email delivery, not connected in this build. The bill reader is the stack's TEST reader (BANK_BILL_READER=
// test-lines), which reads a TEST bill's labelled lines and is shown as "Preview · sample data".
//
// Each step opens a business of its own, so a step never leans on another's bills or limits. Paying a bill is one
// instruction to the partner under `bank.business.bill-pay:<bill id>:<attempt>`; the ledger posts nothing, which every
// step checks on the owner's ledger figures.
const J = 'J-bank-20';
const RUN = Date.now().toString(36);
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const PARTNER_BANK = 'TEST partner bank';
const FUNDED = '1000';
const VENDOR = 'TEST Paper Co';
/** The step's TEST Bill Pay limits, when a step does not set them itself (step 2 sets these in the app). */
const LIMITS = { perPayment: '5000', daily: '8000', monthly: '9000' };

test.describe.configure({ mode: 'default' });

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who) {
  const { status, body: login } = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then(json);
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${status} ${JSON.stringify(login).slice(0, 300)}`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const answer = async (res) => {
    const body = await res.json();
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        code: body?.error?.data?.intafacedCode ?? body?.error?.data?.cause?.code ?? body?.error?.data?.code,
        body,
      };
    return { ok: true, data: body.result.data };
  };
  return {
    userId: login.result.data.userId,
    query: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
  };
}

function ok(res) {
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 400)).toBe(true);
  return res.data;
}

let jobCtx;
/** One call of svc-bank's signed bill-pay job door, as the partner's report (or the scheduler) would make it. */
async function job(what, body) {
  jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} }));
  const ctx = await jobCtx;
  const raw = JSON.stringify(body);
  const res = await fetch(`${ctx.url('bank')}/internal/jobs/bill-pay/${what}`, {
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
  if (res.status !== 200) throw new Error(`bill-pay/${what} refused: ${res.status} ${JSON.stringify(answer).slice(0, 300)}`);
  return answer;
}

async function person(page, prefix, options = {}) {
  const handle = `${prefix}${RUN}${randomBytes(2).toString('hex')}`;
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  await signUpInBrowser(page, who, options);
  await verify(page, who);
  return who;
}

/** The owner and the approver, made once a run and kept in its run file. */
async function world(page) {
  const kept = run.read();
  if (kept.owner) return kept;
  const owner = await person(page, 'jb20o', { accountType: 'business' });
  const approver = await person(page, 'jb20a');
  ok(await (await bank(owner)).mutate('testPartner.set', { custody: 'off' }));
  const ownerLedger = await (await ledgerApi(owner)).balances();
  return run.reset({ owner, approver, ownerLedger });
}

/** A business of the step's own: TEST 1000 USDT at the TEST partner, the approver on its team as a checker. */
async function business(w, tag) {
  const own = await bank(w.owner);
  const accountId = randomUUID();
  const name = `TEST Bills ${tag} ${RUN}`;
  ok(await own.mutate('business.create', { accountId, name, assetId: 'USDT', spendThreshold: '1' }));
  const funded = ok(await own.mutate('testPartner.fundBusiness', { accountId, fundId: `jb20-${accountId}`.slice(0, 64), amount: FUNDED }));
  expect(funded).toMatchObject({ label: PARTNER_BANK, assetId: 'USDT', balance: FUNDED });
  const invite = ok(
    await own.mutate('businessTeam.invite', { accountId, inviteId: randomUUID(), email: null, role: 'checker', roleId: null }),
  );
  ok(await (await bank(w.approver)).mutate('businessTeam.acceptInvite', { token: invite.token }));
  return { own, accountId, name };
}

/** The pre-approved vendor and the TEST limits, by API: a step's setup, never a step's proof. */
async function policy(own, accountId) {
  ok(await own.mutate('businessBills.setVendor', { accountId, name: VENDOR, cap: '200' }));
  ok(await own.mutate('businessBills.setLimits', { accountId, ...LIMITS }));
}

/** A TEST bill: plain text with the labelled lines the TEST reader reads. */
function billFile(reference, amount, due, note = '') {
  return Buffer.from(`TEST BILL\nVendor: ${VENDOR}\nReference: ${reference}\nAmount: ${amount}\nDue: ${due}\n${note}`);
}

async function uploadByApi(own, accountId, reference, amount, due) {
  return ok(
    await own.mutate('businessBills.upload', {
      accountId,
      billId: randomUUID(),
      fileName: `${reference}.txt`,
      contentType: 'text/plain',
      contentBase64: billFile(reference, amount, due).toString('base64'),
    }),
  );
}

/** The business's account at the partner, as the partner reports it. */
async function held(own, accountId) {
  return ok(await own.query('businessTeam.overview', { accountId })).partner.amount;
}

/**
 * `who` signed in, in Business mode on `name`, at `path`. The pick is saved on the account's view record a moment later
 * (shared/view-sync.ts), and that record wins on the next load; so the bills room is read until it names the business
 * just picked, picking again if a load beat the save.
 */
async function inBusiness(page, who, name, path = '/bank/business/bills') {
  await signOutBrowser(page.context());
  await signIn(page, who);
  await page.goto('/home');
  for (let attempt = 1; ; attempt++) {
    // The account's write of the pick, when it goes out; a pick it already holds writes nothing, so this waits a bounded time.
    const saved = page
      .waitForResponse((r) => r.url().includes('/preferences.set') && r.request().method() === 'POST', { timeout: 5_000 })
      .catch(() => null);
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByTestId('profile-business').filter({ hasText: name }).click();
    await page.waitForURL('**/pay/merchant');
    await saved;
    await page.goto('/bank/business/bills');
    const shown = page.getByTestId('bills-business');
    await expect(shown).toBeVisible();
    if ((await shown.textContent()) === name || attempt === 3) break;
  }
  await expect(page.getByTestId('bills-business')).toHaveText(name);
  if (path !== '/bank/business/bills') await page.goto(path);
}

async function ledgerUnchanged(w) {
  expect(await (await ledgerApi(w.owner)).balances()).toEqual(w.ownerLedger);
}

const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test(`${J} #1 opens the bill inbox and uploads a bill twice: extracted data to review; the second is flagged "may be a duplicate of" with a link and cannot be paid until cleared`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const { own, accountId, name } = await business(w, 'inbox');
  const reference = `INV-${RUN}-1`;
  const file = { name: 'supplier-bill.txt', mimeType: 'text/plain', buffer: billFile(reference, '150.00', day(30)) };

  await inBusiness(page, w.owner, name);
  await expect(page.getByTestId('bills-inbox')).toContainText('No bills yet.');
  const upload = page.getByRole('form', { name: 'Upload bill' });
  await upload.getByLabel('Bill file').setInputFiles(file);
  await upload.getByRole('button', { name: 'Upload bill' }).click();
  await expect(page.getByTestId('bill-row')).toHaveCount(1);
  const first = ok(await own.query('businessBills.list', { accountId }))[0];
  expect(first).toMatchObject({ status: 'inbox', vendor: VENDOR, reference, amount: '150', duplicateOf: null });

  // The first bill's page: what the reader read, labelled, and the fields to review before it goes anywhere.
  await page.getByTestId('bill-row').getByRole('link', { name: VENDOR }).click();
  await expect(page.getByTestId('bill-detail')).toHaveAttribute('data-status', 'inbox');
  const read = page.getByTestId('bill-extracted');
  await expect(read).toHaveAttribute('data-label', 'Preview · sample data');
  await expect(read).toContainText(`Reference: ${reference}`);
  await expect(read).toContainText('Amount: 150');
  const review = page.getByRole('form', { name: 'Save review' });
  await expect(review.getByLabel('Vendor')).toHaveValue(VENDOR);
  await expect(review.getByLabel('Amount')).toHaveValue('150');
  await expect(review.getByLabel('Due date')).toHaveValue(day(30));

  // The same bill uploaded again: flagged, with a link to the first.
  await page.goto('/bank/business/bills');
  await upload.getByLabel('Bill file').setInputFiles(file);
  await upload.getByRole('button', { name: 'Upload bill' }).click();
  await expect(page.getByTestId('bill-row')).toHaveCount(2);
  const second = ok(await own.query('businessBills.list', { accountId })).find((b) => b.id !== first.id);
  expect(second.duplicateOf).toMatchObject({ id: first.id, reference });
  const flagged = page.locator(`[data-testid="bill-row"][data-id="${second.id}"]`);
  await expect(flagged).toHaveAttribute('data-duplicate-of', first.id);
  await expect(flagged.getByTestId('bill-duplicate')).toContainText('May be a duplicate of');
  await expect(flagged.getByTestId('bill-duplicate').getByRole('link')).toHaveAttribute('href', `/bank/business/bill?id=${first.id}`);

  // It cannot go to payment until cleared.
  await page.goto(`/bank/business/bill?id=${second.id}`);
  await expect(page.getByTestId('bill-duplicate-of')).toHaveAttribute('data-cleared', 'false');
  await page.getByRole('button', { name: 'Send on for payment' }).click();
  await expect(page.getByTestId('bills-refusal')).toHaveAttribute('data-code', 'bank.bill_duplicate_uncleared');
  expect(ok(await own.query('businessBills.get', { billId: second.id })).status).toBe('inbox');
  expect(
    await own.mutate('businessBills.pay', { billId: second.id, paymentId: randomUUID(), scheduledFor: null, splits: [] }),
  ).toMatchObject({ ok: false, code: 'bank.bill_duplicate_uncleared' });

  // Cleared by the admin, it goes on.
  await page.getByRole('button', { name: 'Not a duplicate' }).click();
  await expect(page.getByTestId('bill-duplicate-of')).toHaveAttribute('data-cleared', 'true');
  await page.getByRole('button', { name: 'Send on for payment' }).click();
  await expect(page.getByTestId('bill-detail')).toHaveAttribute('data-status', 'awaiting_approval');
  expect(await held(own, accountId)).toBe(FUNDED);
  await ledgerUnchanged(w);
});

test(`${J} #2 sets a pre-approved vendor with a cap and Bill Pay limits: a bill under the cap goes straight to payment; over it goes to approvers`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const { own, accountId, name } = await business(w, 'vendor');
  await inBusiness(page, w.owner, name);

  // The vendor and its TEST cap of 200.00.
  const vendor = page.getByRole('form', { name: 'Save vendor' });
  await vendor.getByLabel('Vendor name').fill(VENDOR);
  await vendor.getByLabel('Cap').fill('200');
  await vendor.getByRole('button', { name: 'Save vendor' }).click();
  await expect(page.getByTestId('bill-vendor').filter({ hasText: VENDOR })).toHaveAttribute('data-cap', '200');

  // Limits blank: shown as not set, and a payment refuses.
  for (const k of ['perPayment', 'daily', 'monthly']) await expect(page.getByTestId(`bill-limit-${k}`)).toContainText('not set');
  const small = await uploadByApi(own, accountId, `INV-${RUN}-2a`, '150.00', day(31));
  await page.goto(`/bank/business/bill?id=${small.id}`);
  await page.getByRole('button', { name: 'Send on for payment' }).click();
  await expect(page.getByTestId('bill-detail')).toHaveAttribute('data-status', 'approved');
  await expect(page.getByTestId('bill-approval')).toHaveAttribute('data-preapproved', 'true');
  await page.getByRole('form', { name: 'Pay this bill' }).getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByTestId('bills-refusal')).toHaveAttribute('data-code', 'bank.bill_limit_unset');
  expect(await held(own, accountId)).toBe(FUNDED);

  // The limits set in the app.
  await page.goto('/bank/business/bills');
  const limits = page.getByRole('form', { name: 'Save limits' });
  await limits.getByLabel('Per payment').fill(LIMITS.perPayment);
  await limits.getByLabel('Per day').fill(LIMITS.daily);
  await limits.getByLabel('Per month').fill(LIMITS.monthly);
  await limits.getByRole('button', { name: 'Save limits' }).click();
  await expect(page.getByTestId('bill-limit-perPayment')).toHaveAttribute('data-value', LIMITS.perPayment);
  await expect(page.getByTestId('bill-limit-monthly')).toHaveAttribute('data-value', LIMITS.monthly);

  // The bill under the cap goes straight to payment: no approver, paid once at the partner.
  await page.goto(`/bank/business/bill?id=${small.id}`);
  await page.getByRole('form', { name: 'Pay this bill' }).getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByTestId('bill-detail')).toHaveAttribute('data-status', 'paid');
  const paid = ok(await own.query('businessBills.get', { billId: small.id }));
  expect(paid).toMatchObject({ preapproved: true, approvalsNeeded: 0, approvals: [] });
  expect(paid.payments).toHaveLength(1);
  expect(paid.payments[0]).toMatchObject({ status: 'sent', amount: '150', partnerKey: `bank.business.bill-pay:${small.id}:1` });
  expect(paid.payments[0].partnerMoveId).toBeTruthy();
  expect(await held(own, accountId)).toBe('850');

  // The bill over the cap goes to approvers, and cannot be paid before them.
  const big = await uploadByApi(own, accountId, `INV-${RUN}-2b`, '250.00', day(32));
  await page.goto(`/bank/business/bill?id=${big.id}`);
  await page.getByRole('button', { name: 'Send on for payment' }).click();
  await expect(page.getByTestId('bill-detail')).toHaveAttribute('data-status', 'awaiting_approval');
  await expect(page.getByTestId('bill-approval')).toHaveAttribute('data-preapproved', 'false');
  await expect(page.getByTestId('bill-approval')).toHaveAttribute('data-needed', '1');
  await expect(page.getByRole('form', { name: 'Pay this bill' })).toHaveCount(0);
  expect(await own.mutate('businessBills.pay', { billId: big.id, paymentId: randomUUID(), scheduledFor: null, splits: [] })).toMatchObject({
    ok: false,
    code: 'bank.bill_not_approved',
  });
  // The person who sent it on cannot approve it; the approver does.
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByTestId('bills-refusal')).toHaveAttribute('data-code', 'bank.business_self_approve');
  await inBusiness(page, w.approver, name, `/bank/business/bill?id=${big.id}`);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByTestId('bill-detail')).toHaveAttribute('data-status', 'approved');
  await expect(page.getByTestId('bill-approved-by')).toContainText(w.approver.handle);
  expect(await held(own, accountId)).toBe('850');
  await ledgerUnchanged(w);
});

test(`${J} #3 categorises or splits a bill at payment: the split is our record beside the partner's one payment`, async ({ page }) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const { own, accountId, name } = await business(w, 'split');
  await policy(own, accountId);
  const bill = await uploadByApi(own, accountId, `INV-${RUN}-3`, '250.00', day(33));
  expect(ok(await own.mutate('businessBills.submit', { billId: bill.id })).status).toBe('awaiting_approval');
  expect(ok(await (await bank(w.approver)).mutate('businessBills.approve', { billId: bill.id })).status).toBe('approved');

  await inBusiness(page, w.owner, name, `/bank/business/bill?id=${bill.id}`);
  const pay = page.getByRole('form', { name: 'Pay this bill' });
  await pay.getByRole('button', { name: 'Add a line' }).click();
  await pay.getByRole('button', { name: 'Add a line' }).click();
  await pay.getByLabel('Category').nth(0).fill('Office supplies');
  await pay.getByLabel('Line amount').nth(0).fill('150.00');
  await pay.getByLabel('Category').nth(1).fill('Printing');
  await pay.getByLabel('Line amount').nth(1).fill('99.99');
  await pay.getByRole('button', { name: 'Pay now' }).click();
  // Lines that do not add up are refused, and nothing reaches the partner.
  await expect(page.getByTestId('bills-refusal')).toHaveAttribute('data-code', 'bank.split_total_mismatch');
  expect(ok(await own.query('businessBills.get', { billId: bill.id })).payments).toEqual([]);
  expect(await held(own, accountId)).toBe(FUNDED);

  await pay.getByLabel('Line amount').nth(1).fill('100.00');
  await pay.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByTestId('bill-detail')).toHaveAttribute('data-status', 'paid');
  const lines = page.getByTestId('bill-payment-split');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toHaveAttribute('data-category', 'Office supplies');
  await expect(lines.nth(1)).toHaveAttribute('data-amount', '100');

  // One payment at the partner for the whole bill; the split is ours beside it.
  const paid = ok(await own.query('businessBills.get', { billId: bill.id }));
  expect(paid.payments).toHaveLength(1);
  expect(paid.payments[0]).toMatchObject({
    status: 'sent',
    amount: '250',
    partnerKey: `bank.business.bill-pay:${bill.id}:1`,
    splits: [
      { category: 'Office supplies', amount: '150' },
      { category: 'Printing', amount: '100' },
    ],
  });
  expect(paid.payments[0].partnerMoveId).toBeTruthy();
  expect(await held(own, accountId)).toBe('750');
  await ledgerUnchanged(w);
});

test(`${J} #4 schedules a payment and cancels before send: the instruction never reaches the partner and the bill is back to approved`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const { own, accountId, name } = await business(w, 'schedule');
  await policy(own, accountId);
  const bill = await uploadByApi(own, accountId, `INV-${RUN}-4`, '120.00', day(34));
  expect(ok(await own.mutate('businessBills.submit', { billId: bill.id })).status).toBe('approved');

  await inBusiness(page, w.owner, name, `/bank/business/bill?id=${bill.id}`);
  const pay = page.getByRole('form', { name: 'Pay this bill' });
  await pay.getByLabel('Pay on (leave blank to pay now)').fill(day(3));
  await pay.getByRole('button', { name: 'Schedule payment' }).click();
  await expect(page.getByTestId('bill-detail')).toHaveAttribute('data-status', 'scheduled');
  const payment = page.getByTestId('bill-payment');
  await expect(payment).toHaveAttribute('data-status', 'scheduled');
  await expect(payment).toContainText(`Scheduled for ${day(3)}`);

  await payment.getByRole('button', { name: 'Cancel payment' }).click();
  await expect(page.getByTestId('bill-detail')).toHaveAttribute('data-status', 'approved');
  await expect(payment).toHaveAttribute('data-status', 'cancelled');
  await expect(payment).toContainText('it never reached the partner bank');

  // Never at the partner: no move under its key, the partner's figure unchanged; the due run sends nothing for it.
  const after = ok(await own.query('businessBills.get', { billId: bill.id }));
  expect(after).toMatchObject({ status: 'approved', payments: [{ status: 'cancelled', partnerMoveId: null, sentAt: null }] });
  await job('run-due', { limit: 50 });
  expect(ok(await own.query('businessBills.get', { billId: bill.id })).payments[0]).toMatchObject({
    status: 'cancelled',
    partnerMoveId: null,
  });
  // A second cancel changes nothing.
  expect(ok(await own.mutate('businessBills.cancel', { paymentId: after.payments[0].id })).payments).toHaveLength(1);
  expect(await held(own, accountId)).toBe(FUNDED);
  await ledgerUnchanged(w);
});

test(`${J} #5 sees a declined or returned bill payment: the partner's reason and the bill back in the inbox; the amount credited once as the partner reports`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const { own, accountId, name } = await business(w, 'returns');
  await policy(own, accountId);

  // Declined: more than the partner holds for the business. Nothing moves.
  const big = await uploadByApi(own, accountId, `INV-${RUN}-5a`, '1001.00', day(35));
  ok(await own.mutate('businessBills.submit', { billId: big.id }));
  expect(ok(await (await bank(w.approver)).mutate('businessBills.approve', { billId: big.id })).status).toBe('approved');
  await inBusiness(page, w.owner, name, `/bank/business/bill?id=${big.id}`);
  await page.getByRole('form', { name: 'Pay this bill' }).getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByTestId('bill-detail')).toHaveAttribute('data-status', 'inbox');
  await expect(page.getByTestId('bill-back')).toHaveAttribute('data-reason', 'bank.partner_insufficient_funds');
  await expect(page.getByTestId('bill-back')).toContainText('The partner reports');
  await expect(page.getByTestId('bill-payment')).toHaveAttribute('data-status', 'declined');
  const declined = ok(await own.query('businessBills.get', { billId: big.id }));
  expect(declined).toMatchObject({ status: 'inbox', round: 2, approvals: [], payments: [{ status: 'declined', partnerMoveId: null }] });
  expect(await held(own, accountId)).toBe(FUNDED);
  await page.goto('/bank/business/bills');
  await expect(page.locator(`[data-testid="bill-row"][data-id="${big.id}"]`)).toHaveAttribute('data-status', 'inbox');

  // Returned: paid once, then the partner reports the payee's bank sent it back.
  const bill = await uploadByApi(own, accountId, `INV-${RUN}-5b`, '120.00', day(36));
  ok(await own.mutate('businessBills.submit', { billId: bill.id }));
  const paid = ok(await own.mutate('businessBills.pay', { billId: bill.id, paymentId: randomUUID(), scheduledFor: null, splits: [] }));
  expect(paid.status).toBe('paid');
  expect(await held(own, accountId)).toBe('880');
  const paymentId = paid.payments[0].id;
  const back = await job('returned', { paymentId, reason: 'account_closed' });
  expect(back).toMatchObject({ status: 'inbox', payments: [{ status: 'returned', partnerReason: 'account_closed' }] });
  expect(await held(own, accountId)).toBe(FUNDED);
  // The same report again credits nothing more.
  await job('returned', { paymentId, reason: 'account_closed' });
  expect(await held(own, accountId)).toBe(FUNDED);

  await page.goto(`/bank/business/bill?id=${bill.id}`);
  await expect(page.getByTestId('bill-detail')).toHaveAttribute('data-status', 'inbox');
  await expect(page.getByTestId('bill-back')).toContainText('The payee’s bank account is closed.');
  const returned = page.getByTestId('bill-payment');
  await expect(returned).toHaveAttribute('data-status', 'returned');
  await expect(returned).toContainText('the amount came back to the business’s account once');
  await expect(returned.getByTestId('bill-payment-reason')).toHaveAttribute('data-reason', 'account_closed');
  await page.goto('/bank/business/bills');
  await expect(page.locator(`[data-testid="bill-row"][data-id="${bill.id}"]`)).toHaveAttribute('data-status', 'inbox');
  await ledgerUnchanged(w);
});
