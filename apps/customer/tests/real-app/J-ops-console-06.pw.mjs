// World: stack
import { expect, test } from './journey.mjs';
import { randomBytes } from 'node:crypto';
import { ADMIN, founderCode, founderSignIn } from './admin.mjs';
import { forgetSession } from './identity-factors.mjs';
import { businessReadyPerson, openBusiness, paidCardPayment, payApiOf, signInWithCode, uuidOf, verifiedBusiness } from './merchant.mjs';
import { unconfirmedAccount } from './p2p.mjs';
import { fund, toUnits } from './stack.mjs';

// J-ops-console-06: watch payments and send a payout by operator instruction (OPS-payments-desk-01 to -04). Written from
// the journey row's words (project-state operation-zero/modules/ops-console/acceptance/journeys.md) before the feature,
// by someone other than its builder (OWNER 212). Each step is its own test and sets up what it reads, so each fails on
// its own first missing clause.
//
// The operator is finance staff: the stack's founder A, with founder B as the approver ("a different approver"). Every
// amount is TEST. The routes are the spec's: `/payments` and `/payments/:paymentId` (OPS-payments-desk-01), the tabs
// Providers, Pools and Rails on `/ledger/treasury` (-02), `/operator-payouts` and `/operator-payouts/:instructionNo`
// (-03), `/payments/statements` and `/payments/workflows` (-04). Money is read where the operator reads it: the ledger
// desk (`/ledger`), by business key and by account.
//
// The bank partner is outside (`rail.bank`), so the stack answers for it with a TEST stand-in (BUILDER.md: "a missing
// outside rail gets a TEST stand-in in the stack, never softer words"). The operator picks its answer by the TEST
// beneficiary they pay, as the sandbox card rail takes `tok_ok` or `tok_funds_held`:
//   "TEST bank: confirms"                 the partner confirms the payout
//   "TEST bank: fails"                    the partner answers a definite failure
//   "TEST bank: times out"                the partner never answers in time, on every call
//   "TEST bank: times out, then fails"    the first call times out; asked again under the same reference, the partner
//                                         proves that attempt failed; the next attempt (a new reference) is confirmed

const J = 'J-ops-console-06';
const ASSET = 'USDT';
const tag = randomBytes(3).toString('hex');

test.use({ timezoneId: 'UTC' });

/** A refusal on a console page carries its typed code in `data-code` (the module's refusal-copy rule). */
const refusal = (scope, code) => scope.locator(`[data-code="${code}"]`);

/** The business key the spec gives attempt `n` of operator payout instruction `no`. */
const payoutKey = (no, n) => `ops:payout:${no}:${n}`;

/** A fresh TEST customer funded through the real ledger with `amount` USDT: who pays out, and their user id. */
async function fundedCustomer(prefix, amount = '100') {
  const who = await unconfirmedAccount(prefix);
  const out = fund(who.email, ASSET, amount, `${prefix}-${tag}`);
  expect(out.tx, out.out).toBeTruthy();
  const userId = /\(([0-9a-f-]{36})\)/.exec(out.out)?.[1] ?? null;
  expect(userId, out.out).toBeTruthy();
  return { who, userId };
}

/** The available USDT balance of `userId` as the ledger desk shows it (a decimal string), found by account address. */
async function ledgerBalance(page, userId) {
  await page.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  const accounts = page.getByTestId('ledger-desk-accounts');
  await expect(accounts).toBeVisible({ timeout: 60_000 });
  await accounts.getByLabel('Address prefix').fill(`user:${userId}`);
  const answered = page.waitForResponse((res) => res.url().includes('/api/ledger-desk/accounts'));
  await accounts.getByRole('button', { name: 'Search accounts' }).click();
  const body = await (await answered).json();
  const mine = (body.page?.accounts ?? []).find((row) => row.ownerId === userId && row.assetId === ASSET);
  expect(mine, JSON.stringify(body).slice(0, 400)).toBeTruthy();
  await expect(accounts.locator(`tr[data-account="${mine.accountId}"]`)).toContainText(mine.balance);
  return mine.balance;
}

/** The ledger desk's trace of a business key: the transaction id it posted under, or null for an honest "no record". */
async function traceKey(page, key) {
  await page.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  const lookup = page.getByTestId('ledger-lookup');
  await expect(lookup).toBeVisible({ timeout: 60_000 });
  await lookup.getByLabel('Look up by').selectOption('businessKey');
  await lookup.getByLabel('Business key', { exact: true }).fill(key);
  await lookup.getByRole('button', { name: 'Look up' }).click();
  const found = lookup.getByTestId('ledger-lookup-tx-id');
  const none = lookup.getByTestId('ledger-lookup-not-found');
  await expect(found.or(none)).toBeVisible({ timeout: 30_000 });
  if (await none.count()) return null;
  await expect(lookup.getByTestId('ledger-lookup-business-key')).toHaveText(key);
  return (await found.innerText()).trim();
}

/** How much a balance went down from `start` to `now`, exactly, as scaled bigint units (every decimal place kept). */
const heldSince = (start, now) => toUnits(start) - toUnits(now);

/** Two founders, each signed in on their own browser context: A requests, B approves. Their handles come with them. */
async function founders(browser) {
  const a = await (await browser.newContext()).newPage();
  const aWho = await founderSignIn(a, 'a');
  const b = await (await browser.newContext()).newPage();
  const bWho = await founderSignIn(b, 'b');
  expect(aWho.handle, 'founder A has a handle in the stack vault').toBeTruthy();
  expect(bWho.handle, 'founder B has a handle in the stack vault').toBeTruthy();
  expect(bWho.handle).not.toBe(aWho.handle);
  return { a, b, aHandle: aWho.handle, bHandle: bWho.handle };
}

/**
 * Founder A initiates a TEST payout of `amount` USDT from `userId` to `beneficiary` on `/operator-payouts`, and lands on
 * the instruction. Returns its instruction number (from the database sequence the spec stores on the row).
 */
async function initiatePayout(page, userId, beneficiary, amount = '10') {
  await page.goto(`${ADMIN}/operator-payouts`, { waitUntil: 'load' });
  await expect(page.getByRole('heading', { name: 'Operator payouts' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('link', { name: 'New payout' }).click();
  const form = page.getByTestId('operator-payout-form');
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.getByLabel('Customer').fill(userId);
  await form.getByLabel('Asset').fill(ASSET);
  await form.getByLabel('Amount').fill(amount);
  await form.getByLabel('Beneficiary').selectOption({ label: beneficiary });
  await form.getByRole('button', { name: 'Send for approval' }).click();
  const no = page.getByTestId('operator-payout-instruction-no');
  await expect(no).toHaveText(/^\d+$/, { timeout: 30_000 });
  return (await no.innerText()).trim();
}

/** The instruction page of `no` on `page`. */
async function openInstruction(page, no) {
  await page.goto(`${ADMIN}/operator-payouts/${no}`, { waitUntil: 'load' });
  const detail = page.getByTestId('operator-payout');
  await expect(detail.getByTestId('operator-payout-instruction-no')).toHaveText(no, { timeout: 60_000 });
  return detail;
}

/** The partner calls the instruction page lists, oldest first: each call's business reference and its answer. */
async function partnerCalls(detail) {
  const rows = detail.getByTestId('operator-payout-partner-calls').locator('tbody tr');
  const out = [];
  for (const row of await rows.all())
    out.push({ reference: (await row.getAttribute('data-reference')) ?? '', answer: (await row.getAttribute('data-answer')) ?? '' });
  return out;
}

/** Founder B approves instruction `no` with their step-up code (a fresh authenticator code). */
async function approveAsB(page, no) {
  const detail = await openInstruction(page, no);
  await detail.getByRole('button', { name: 'Approve' }).click();
  await detail.getByLabel('Authenticator code').fill(await founderCode('b'));
  await detail.getByRole('button', { name: 'Confirm approval' }).click();
  return detail;
}

test.describe('the payments list and detail', () => {
  let world = null;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(480_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    const owner = await businessReadyPerson(page, 'oc06');
    const merchantId = await openBusiness(page, owner, 'TEST Payments Desk Ltd');
    await verifiedBusiness(page, owner, merchantId);
    await forgetSession(page);
    await signInWithCode(page, owner, '/pay/merchant');
    const kept = (step) => {
      owner.step = step;
    };
    const api = await payApiOf(owner, kept);
    // Two connectors: a paid card payment on the sandbox card rail, and a crypto payment on the crypto rail that waits
    // for its transfer (created, so a different status too).
    const card = await paidCardPayment(api, merchantId, { key: `${J}:card:${merchantId}`, amount: '12.00' });
    expect(card.status, JSON.stringify(card).slice(0, 300)).toBe('captured');
    const crypto = await api.mutate('payment.create', {
      requestId: uuidOf(`${J}:crypto:${merchantId}`),
      merchantId,
      amount: '7.00',
      assetId: ASSET,
      method: 'crypto',
      railAdapter: 'crypto-native',
      metadata: { reference: `TEST-${J}-crypto-${tag}` },
    });
    expect(crypto.status, JSON.stringify(crypto).slice(0, 300)).toBe('created');
    world = { owner, merchantId, api, card, crypto, context, kept };
  });

  test.afterAll(async () => {
    await world?.context.close();
  });

  test(`${J} #1 /payments filtered by connector and status shows only those rows, with a cursor`, async ({ page }) => {
    test.setTimeout(240_000);
    await founderSignIn(page, 'a');
    await page.goto(`${ADMIN}/payments`, { waitUntil: 'load' });
    const list = page.getByTestId('payments-list');
    await expect(list, 'the platform-wide payment list (svc-pay founder payment search)').toBeVisible({ timeout: 60_000 });
    await list.getByLabel('Connector').selectOption('card-sandbox');
    await list.getByLabel('Status').selectOption('captured');
    await list.getByRole('button', { name: 'Show payments' }).click();
    const rows = list.getByTestId('payments-table').locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    // Only those rows: every row is the card connector and captured; this test's card payment is listed, its crypto one is not.
    for (const row of await rows.all()) {
      await expect(row).toHaveAttribute('data-connector', 'card-sandbox');
      await expect(row).toHaveAttribute('data-status', 'captured');
    }
    await expect(list.locator(`tr[data-payment-id="${world.card.id}"]`)).toHaveCount(1);
    await expect(list.locator(`tr[data-payment-id="${world.crypto.id}"]`)).toHaveCount(0);
    // With a cursor: the page names where the next page starts (or that this is the last page), never a silent cut.
    const cursor = list.getByTestId('payments-cursor');
    await expect(cursor).toBeVisible();
    await expect(cursor).toHaveAttribute('data-next-cursor', /.*/);

    // The other connector and status: the crypto payment, and not the card one.
    await list.getByLabel('Connector').selectOption('crypto-native');
    await list.getByLabel('Status').selectOption('created');
    await list.getByRole('button', { name: 'Show payments' }).click();
    await expect(list.locator(`tr[data-payment-id="${world.crypto.id}"]`)).toHaveCount(1, { timeout: 30_000 });
    await expect(list.locator(`tr[data-payment-id="${world.card.id}"]`)).toHaveCount(0);
    for (const row of await rows.all()) {
      await expect(row).toHaveAttribute('data-connector', 'crypto-native');
      await expect(row).toHaveAttribute('data-status', 'created');
    }
  });

  test(`${J} #2 a payment shows its status history in order, the raw payload with secrets removed, and its linked refund`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    // A refund of part of the card payment, by its owner with "Confirm it's you" (the refund scope), under a business key.
    const { nextCode } = await import('./identity-factors.mjs');
    const totp = (await import('../../../../services/svc-identity/dist/auth/totp.js')).totp;
    const code = await nextCode(totp, world.owner.secret, world.owner.step);
    world.kept(code.step);
    const refunder = await world.api.steppedUp(world.merchantId, ['pay:refund'], code.code);
    const refunded = await refunder.mutate('payment.refund', {
      paymentId: world.card.id,
      amount: '2.00',
      refundId: `${J}:refund:${world.card.id}`,
    });
    expect(refunded.id, JSON.stringify(refunded).slice(0, 300)).toBe(world.card.id);

    await founderSignIn(page, 'a');
    await page.goto(`${ADMIN}/payments/${world.card.id}`, { waitUntil: 'load' });
    const detail = page.getByTestId('payment-detail');
    await expect(detail.getByTestId('payment-detail-id')).toHaveText(world.card.id, { timeout: 60_000 });

    // Status history in order: created, authorised, captured, then the refund, each with its time, oldest first.
    const history = detail.getByTestId('payment-status-history').locator('li');
    const statuses = await history.evaluateAll((items) => items.map((li) => li.dataset.status));
    expect(statuses.slice(0, 3)).toEqual(['created', 'authorized', 'captured']);
    expect(statuses).toContain('refunded');
    const times = await history.locator('time').evaluateAll((els) => els.map((t) => Date.parse(t.getAttribute('datetime'))));
    expect(times.length).toBe(statuses.length);
    expect([...times].sort((x, y) => x - y)).toEqual(times);

    // The raw payload the rail sent, with secrets removed: shown, and no card token, card number or credential in it.
    const raw = detail.getByTestId('payment-raw-payload');
    await expect(raw).toBeVisible();
    const text = await raw.innerText();
    expect(text.trim().length).toBeGreaterThan(2);
    expect(text).not.toContain('tok_ok');
    expect(text).not.toMatch(/\b\d{13,19}\b/);
    expect(text).not.toMatch(/"(?:secret|password|apiKey|api_key|authorization|token)"\s*:\s*"[^"[]/i);
    await expect(raw).toContainText('[removed]');

    // A link to the linked refund.
    const link = detail.getByTestId('payment-linked-refunds').getByRole('link');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', new RegExp(`${J}:refund:${world.card.id}`.replace(/[:]/g, '(:|%3A)')));
  });
});

test(`${J} #3 /ledger/treasury lists each provider account with its latest balance and as-of time; none shows unset; a live pull shows rail.bank`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/ledger/treasury`, { waitUntil: 'load' });
  await page.getByRole('tab', { name: 'Providers' }).click();
  const providers = page.getByTestId('treasury-providers');
  await expect(providers).toBeVisible({ timeout: 60_000 });
  const rows = providers.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) {
    const kind = await row.getAttribute('data-kind');
    expect(['internal', 'external']).toContain(kind);
    await expect(row).toContainText(kind === 'internal' ? 'Internal' : 'External');
    const balance = row.getByTestId('treasury-provider-balance');
    if ((await row.getAttribute('data-provider')) === 'unset') {
      // No provider: "unset" and no figure.
      await expect(balance).toHaveText('unset');
      expect(await row.getByTestId('treasury-provider-balance').innerText()).not.toMatch(/\d/);
      await expect(row.locator('time')).toHaveCount(0);
    } else {
      // Its latest balance as a decimal string, with the time it was read.
      await expect(balance).toHaveText(/^\d+(\.\d+)?$/);
      await expect(row.getByTestId('treasury-provider-as-of').locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
    }
  }
  // A live balance pull needs the bank partner, which is not connected in this build.
  await providers.getByRole('button', { name: 'Pull live balance' }).first().click();
  const notConnected = refusal(providers, 'rail.bank');
  await expect(notConnected).toBeVisible({ timeout: 30_000 });
  await expect(notConnected).toContainText('It is switched off in this build.');
});

test(`${J} #4 a dynamic cash pool takes in a new matching account on the next read, reads a past time from ledger history, and a list with a query is refused`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  // The pool matches every customer account in XPT, an asset this file funds on its own.
  const POOL_ASSET = 'XPT';
  const first = await unconfirmedAccount('jpool');
  expect(fund(first.email, POOL_ASSET, '3', `pool-a-${tag}`).tx).toBeTruthy();
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/ledger/treasury`, { waitUntil: 'load' });
  await page.getByRole('tab', { name: 'Pools' }).click();
  const pools = page.getByTestId('treasury-pools');
  await expect(pools).toBeVisible({ timeout: 60_000 });

  const name = `TEST pool ${tag}`;
  await pools.getByRole('button', { name: 'New pool' }).click();
  const form = pools.getByTestId('treasury-pool-form');
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Kind').selectOption('dynamic');
  await form.getByLabel('Query').fill(`address:user:* asset:${POOL_ASSET}`);
  await form.getByRole('button', { name: 'Save pool' }).click();
  const pool = pools.locator(`[data-pool-name="${name}"]`);
  await expect(pool).toBeVisible({ timeout: 30_000 });
  await pool.getByRole('button', { name: 'Read now' }).click();
  const sum = pool.getByTestId('treasury-pool-sum');
  await expect(sum).toHaveText(/^\d+(\.\d+)?$/, { timeout: 30_000 });
  const before = (await sum.innerText()).trim();
  const membersBefore = Number(await pool.getByTestId('treasury-pool-members').innerText());
  const pastTime = new Date(Date.now() - 1_000).toISOString();

  // A new matching account appears: the next read includes it.
  const second = await unconfirmedAccount('jpoolb');
  expect(fund(second.email, POOL_ASSET, '2', `pool-b-${tag}`).tx).toBeTruthy();
  await pool.getByRole('button', { name: 'Read now' }).click();
  await expect(sum).toHaveText(String(Number(before) + 2), { timeout: 30_000 });
  await expect(pool.getByTestId('treasury-pool-members')).toHaveText(String(membersBefore + 1));

  // At a past time, before that account was funded, the sum comes from ledger history.
  await pool.getByLabel('As of').fill(pastTime.slice(0, 19));
  await pool.getByRole('button', { name: 'Read at that time' }).click();
  await expect(sum).toHaveText(before, { timeout: 30_000 });
  await expect(pool.getByTestId('treasury-pool-source')).toContainText('ledger history');

  // A pool with both a list and a query is refused.
  await pools.getByRole('button', { name: 'New pool' }).click();
  await form.getByLabel('Name').fill(`TEST pool both ${tag}`);
  await form.getByLabel('Kind').selectOption('dynamic');
  await form.getByLabel('Query').fill(`asset:${POOL_ASSET}`);
  await form.getByLabel('Accounts').fill(`user:${first.handle}`);
  await form.getByRole('button', { name: 'Save pool' }).click();
  await expect(refusal(pools, 'ledger.pool_invalid')).toBeVisible({ timeout: 30_000 });
  await expect(pools.locator(`[data-pool-name="TEST pool both ${tag}"]`)).toHaveCount(0);
});

test(`${J} #5 rail connection health: a blank polling period is pay.rail_poll_period_unset, below the partner minimum is refused, unsupported actions say why`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/ledger/treasury`, { waitUntil: 'load' });
  await page.getByRole('tab', { name: 'Rails' }).click();
  const rails = page.getByTestId('treasury-rails');
  await expect(rails).toBeVisible({ timeout: 60_000 });
  const rail = rails.locator('[data-rail]').first();
  await expect(rail).toBeVisible();

  // A blank polling period: the typed code and "not set", never a default.
  const period = rail.getByTestId('rail-poll-period');
  await expect(period).toContainText('not set');
  await expect(refusal(rail, 'pay.rail_poll_period_unset')).toBeVisible();

  // A period below the partner's minimum is refused and nothing changes.
  await rail.getByRole('button', { name: 'Set polling period' }).click();
  await rail.getByLabel('Polling period (seconds)').fill('1');
  await rail.getByRole('button', { name: 'Save period' }).click();
  await expect(refusal(rail, 'pay.rail_period_below_minimum')).toBeVisible({ timeout: 30_000 });
  await page.reload({ waitUntil: 'load' });
  await page.getByRole('tab', { name: 'Rails' }).click();
  await expect(rails.locator('[data-rail]').first().getByTestId('rail-poll-period')).toContainText('not set', { timeout: 60_000 });

  // The capability matrix: fetch, balances, payments, transfer, payout and beneficiary; an unsupported one says so and why.
  const matrix = rails.locator('[data-rail]').first().getByTestId('rail-capabilities');
  for (const capability of ['fetch', 'balances', 'payments', 'transfer', 'payout', 'beneficiary'])
    await expect(matrix.locator(`[data-capability="${capability}"]`)).toHaveCount(1);
  const unsupported = matrix.locator('[data-supported="false"]');
  expect(await unsupported.count()).toBeGreaterThan(0);
  for (const cell of await unsupported.all()) {
    await expect(cell).toContainText('Unsupported');
    expect((await cell.getByTestId('rail-capability-reason').innerText()).trim().length).toBeGreaterThan(0);
  }
});

test(`${J} #6 a TEST payout exists first as waiting_for_validation, the hold posts once, and the partner is not called yet`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { userId } = await fundedCustomer('jpay6');
  await founderSignIn(page, 'a');
  const start = await ledgerBalance(page, userId);
  const no = await initiatePayout(page, userId, 'TEST bank: confirms', '10');
  const detail = await openInstruction(page, no);
  await expect(detail.getByTestId('operator-payout-status')).toHaveText('waiting_for_validation');
  // The partner is not called before approval.
  expect(await partnerCalls(detail)).toEqual([]);
  await expect(detail.getByTestId('operator-payout-partner-calls')).toContainText('No partner call yet');
  // The hold posted once, under the instruction's first business key: the customer's balance is down by exactly 10.
  expect(await traceKey(page, payoutKey(no, 1))).toBeTruthy();
  expect(heldSince(start, await ledgerBalance(page, userId))).toBe(toUnits('10'));
  // Opening and reloading the instruction posts nothing more.
  await openInstruction(page, no);
  await page.reload({ waitUntil: 'load' });
  expect(heldSince(start, await ledgerBalance(page, userId))).toBe(toUnits('10'));
});

test(`${J} #7 a different approver approves with a step-up token: the partner call carries the business reference, a confirmed answer settles, a definite failure reverses the hold`, async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const { a, b, aHandle, bHandle } = await founders(browser);

  // Confirmed: settled under the instruction's business reference.
  const ok = await fundedCustomer('jpay7a');
  const start = await ledgerBalance(a, ok.userId);
  const settledNo = await initiatePayout(a, ok.userId, 'TEST bank: confirms', '10');
  let detail = await approveAsB(b, settledNo);
  await expect(detail.getByTestId('operator-payout-status')).toHaveText('settled', { timeout: 60_000 });
  expect(await partnerCalls(detail)).toEqual([{ reference: payoutKey(settledNo, 1), answer: 'confirmed' }]);
  // Approved by founder B, the different approver, and not by the requester A.
  const approvedBy = detail.getByTestId('operator-payout-approved-by');
  await expect(approvedBy).toContainText(bHandle);
  await expect(approvedBy).not.toContainText(aHandle);
  expect(heldSince(start, await ledgerBalance(a, ok.userId))).toBe(toUnits('10'));

  // A definite failure: the hold is reversed and the customer has their money back.
  const bad = await fundedCustomer('jpay7b');
  const badStart = await ledgerBalance(a, bad.userId);
  const failedNo = await initiatePayout(a, bad.userId, 'TEST bank: fails', '10');
  detail = await approveAsB(b, failedNo);
  await expect(detail.getByTestId('operator-payout-status')).toHaveText('reversed', { timeout: 60_000 });
  expect(await partnerCalls(detail)).toEqual([{ reference: payoutKey(failedNo, 1), answer: 'failed' }]);
  expect(await ledgerBalance(a, bad.userId)).toBe(badStart);
});

test(`${J} #8 a partner timeout keeps the instruction processing with its hold and a retry reuses the reference; after a proven failure the next attempt is n+1 with a new reference`, async ({
  browser,
}) => {
  test.setTimeout(480_000);
  const { a, b } = await founders(browser);
  const { userId } = await fundedCustomer('jpay8');
  const start = await ledgerBalance(a, userId);
  const no = await initiatePayout(a, userId, 'TEST bank: times out, then fails', '10');
  let detail = await approveAsB(b, no);

  // The partner timed out: processing, the hold stays.
  await expect(detail.getByTestId('operator-payout-status')).toHaveText('processing', { timeout: 60_000 });
  expect(await partnerCalls(detail)).toEqual([{ reference: payoutKey(no, 1), answer: 'timeout' }]);
  expect(heldSince(start, await ledgerBalance(a, userId))).toBe(toUnits('10'));

  // A retry reuses the same reference; this time the partner proves the attempt failed.
  detail = await openInstruction(a, no);
  await detail.getByRole('button', { name: 'Retry' }).click();
  await expect(detail.getByTestId('operator-payout-attempt')).toHaveText('1', { timeout: 60_000 });
  await expect
    .poll(async () => (await partnerCalls(await openInstruction(a, no))).map((c) => c.reference), { timeout: 60_000 })
    .toEqual([payoutKey(no, 1), payoutKey(no, 1)]);
  detail = await openInstruction(a, no);
  await expect(detail.getByTestId('operator-payout-attempt-state')).toContainText('proven failed');

  // The next attempt takes n+1 (a fresh approval, the first one was used), and the partner sees a new reference.
  await detail.getByRole('button', { name: 'Retry' }).click();
  detail = await approveAsB(b, no);
  await expect(detail.getByTestId('operator-payout-attempt')).toHaveText('2', { timeout: 60_000 });
  await expect(detail.getByTestId('operator-payout-status')).toHaveText('settled', { timeout: 60_000 });
  const calls = await partnerCalls(detail);
  expect(calls.at(-1)).toEqual({ reference: payoutKey(no, 2), answer: 'confirmed' });
  expect(calls.filter((c) => c.reference === payoutKey(no, 2))).toHaveLength(1);
  // One payout of 10, however many attempts: the customer is down by exactly 10.
  expect(heldSince(start, await ledgerBalance(a, userId))).toBe(toUnits('10'));
});

test(`${J} #9 approving one’s own instruction is action_approval.same_person; a waiting one retires with audit and no money moves; a dispatched one is refused`, async ({
  browser,
}) => {
  test.setTimeout(480_000);
  const { a, b } = await founders(browser);
  const { userId } = await fundedCustomer('jpay9');

  // The requester approving their own instruction.
  const own = await initiatePayout(a, userId, 'TEST bank: confirms', '5');
  let detail = await openInstruction(a, own);
  await detail.getByRole('button', { name: 'Approve' }).click();
  await detail.getByLabel('Authenticator code').fill(await founderCode('a'));
  await detail.getByRole('button', { name: 'Confirm approval' }).click();
  await expect(refusal(detail, 'action_approval.same_person')).toBeVisible({ timeout: 30_000 });
  await expect(detail.getByTestId('operator-payout-status')).toHaveText('waiting_for_validation');

  // Retiring the waiting instruction: retired, an audit entry, and no money moves on the retire.
  const before = await ledgerBalance(a, userId);
  detail = await openInstruction(a, own);
  await detail.getByRole('button', { name: 'Retire' }).click();
  await detail.getByLabel('Reason').fill('TEST retire a waiting instruction');
  await detail.getByRole('button', { name: 'Confirm retire' }).click();
  await expect(detail.getByTestId('operator-payout-status')).toHaveText('retired', { timeout: 30_000 });
  await expect(detail.getByTestId('operator-payout-audit').locator('li').filter({ hasText: 'retired' })).toHaveCount(1);
  expect(await ledgerBalance(a, userId)).toBe(before);

  // A dispatched instruction (approved and sent to the partner) cannot be retired.
  const sent = await initiatePayout(a, userId, 'TEST bank: times out', '5');
  await approveAsB(b, sent);
  detail = await openInstruction(a, sent);
  await expect(detail.getByTestId('operator-payout-status')).toHaveText('processing', { timeout: 60_000 });
  await detail.getByRole('button', { name: 'Retire' }).click();
  await detail.getByLabel('Reason').fill('TEST retire a dispatched instruction');
  await detail.getByRole('button', { name: 'Confirm retire' }).click();
  await expect(refusal(detail, 'pay.instruction_state_illegal')).toBeVisible({ timeout: 30_000 });
  await expect(detail.getByTestId('operator-payout-status')).toHaveText('processing');
});

test(`${J} #10 a statement line ingested twice is stored once; a batch matched to a status report shows cleared and not cleared with each movement; an intraday entry is reversible`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/payments/statements`, { waitUntil: 'load' });
  const statements = page.getByTestId('payment-statements');
  await expect(statements).toBeVisible({ timeout: 60_000 });

  // The same TEST statement line, ingested twice: one stored line.
  const lineId = `TEST-STMT-${tag}`;
  const line = JSON.stringify({ id: lineId, kind: 'booked', amount: '25.00', asset: 'EUR', bookedAt: new Date().toISOString() });
  for (let i = 0; i < 2; i++) {
    await statements.getByLabel('TEST statement line').fill(line);
    await statements.getByRole('button', { name: 'Ingest line' }).click();
    await expect(statements.getByTestId('payment-statements-ingest-result')).toBeVisible({ timeout: 30_000 });
  }
  await expect(statements.locator(`tr[data-line-id="${lineId}"]`)).toHaveCount(1);

  // An intraday entry is labelled reversible.
  const intraday = `TEST-INTRADAY-${tag}`;
  await statements
    .getByLabel('TEST statement line')
    .fill(JSON.stringify({ id: intraday, kind: 'intraday', amount: '4.00', asset: 'EUR', bookedAt: new Date().toISOString() }));
  await statements.getByRole('button', { name: 'Ingest line' }).click();
  await expect(statements.locator(`tr[data-line-id="${intraday}"]`)).toContainText('Reversible', { timeout: 30_000 });

  // A batch matched to its status report: each payment cleared or not cleared, with the movement it matched.
  await statements.getByRole('tab', { name: 'Clearing' }).click();
  const clearing = statements.getByTestId('payment-clearing');
  await clearing
    .getByLabel('TEST status report')
    .fill(JSON.stringify({ batch: `TEST-BATCH-${tag}`, cleared: [lineId], notCleared: [intraday] }));
  await clearing.getByRole('button', { name: 'Match report' }).click();
  const cleared = clearing.locator('tr[data-cleared="true"]');
  const notCleared = clearing.locator('tr[data-cleared="false"]');
  await expect(cleared).toHaveCount(1, { timeout: 30_000 });
  await expect(notCleared).toHaveCount(1);
  await expect(cleared).toContainText('Cleared');
  await expect(cleared.getByTestId('payment-clearing-movement')).toContainText(lineId);
  await expect(notCleared).toContainText('Not cleared');
  await expect(notCleared.getByTestId('payment-clearing-movement')).toContainText(intraday);
});

test(`${J} #11 terminating a stuck money workflow with two founders stops the saga and keeps its intent row and holds, with a held-for-review note; one founder alone is refused`, async ({
  browser,
}) => {
  test.setTimeout(480_000);
  const { a, b } = await founders(browser);
  const { userId } = await fundedCustomer('jpay11');
  const start = await ledgerBalance(a, userId);
  // A payout whose partner never answers: its saga is stuck in processing with the hold on.
  const no = await initiatePayout(a, userId, 'TEST bank: times out', '10');
  await approveAsB(b, no);
  await expect((await openInstruction(a, no)).getByTestId('operator-payout-status')).toHaveText('processing', { timeout: 60_000 });

  await a.goto(`${ADMIN}/payments/workflows`, { waitUntil: 'load' });
  const workflows = a.getByTestId('payment-workflows');
  await expect(workflows).toBeVisible({ timeout: 60_000 });
  const row = workflows.locator(`tr[data-business-key="${payoutKey(no, 1)}"]`);
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toHaveAttribute('data-status', 'running');

  // One founder alone: asking to terminate only waits for a second founder; terminating alone is refused.
  await row.getByRole('button', { name: 'Terminate' }).click();
  await workflows.getByLabel('Reason').fill('TEST stuck payout saga');
  await workflows.getByRole('button', { name: 'Ask to terminate' }).click();
  await expect(row).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
  await expect(row.getByTestId('payment-workflow-pending-approval')).toBeVisible();
  await row.getByRole('button', { name: 'Approve terminate' }).click();
  await expect(refusal(workflows, 'action_approval.same_person')).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute('data-status', 'running');

  // The second founder approves: the saga stops, its intent row and holds remain, and a note says funds are held for review.
  await b.goto(`${ADMIN}/payments/workflows`, { waitUntil: 'load' });
  const theirs = b.getByTestId('payment-workflows').locator(`tr[data-business-key="${payoutKey(no, 1)}"]`);
  await theirs.getByRole('button', { name: 'Approve terminate' }).click();
  await expect(theirs).toHaveAttribute('data-status', 'terminated', { timeout: 30_000 });
  await expect(theirs).toContainText('held for review');
  await expect(theirs.getByTestId('payment-workflow-intent')).toContainText(payoutKey(no, 1));
  // Terminating posted nothing: the hold is still there and the customer is still down by exactly 10.
  expect(heldSince(start, await ledgerBalance(a, userId))).toBe(toUnits('10'));
  expect(await traceKey(a, `ops:payout-reverse:${no}:1`)).toBeNull();
});
