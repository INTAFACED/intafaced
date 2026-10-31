import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './journey.mjs';
import { localStackState } from '../../../../tooling/scripts/local-test-state.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api as account, fromUnits, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-11, in the running app (docs/roadmap/journeys.json): I repay and close my loan. Step 1 (BK-loan-06): the loan's
// payoff quote and a 30-day projection, on the loan's details page. The stack's TEST loan products come from the TEST
// content seed (BTC collateral against USDT debt at a TEST 10% APR), its BTC mark from the TEST market maker, and the
// payoff fee (TEST 0) and quote window (TEST 15 minutes) from the bank profile. One TEST account pledges TEST BTC and
// borrows TEST 100 USDT through the bank's own API as the starting state; the page is then read as the person sees it.
// Steps 2, 3, 5 and 6 (BK-loan-05, BK-loan-06, LOAN-01/07) carry on with that loan; step 4 (LOAN-05) opens one of its own. It starts owing interest: a stack has
// no past, so `local-test-seed.mjs age-loan` moves the TEST loan's start back 15 days, and the bank's own accrual job,
// called through its signed job door as a scheduler would, charges those days. Every repayment, release and statement
// after that is the person's own, on /bank/loans and the loan's details page.
const J = 'J-bank-11';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who) {
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
/** Moves this TEST loan's start back `days` days on the stack (dates only: nothing is posted and no interest is written). */
function age(loanId, days) {
  return execFileSync(
    process.execPath,
    [path.join(ROOT, 'tooling/scripts/local-test-seed.mjs'), 'age-loan', loanId, String(days), '--state', localStackState()],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LOCAL_TEST: '1' }, timeout: 60_000 },
  );
}

let jobCtx;
/** One signed call to a bank job door, as the stack's own tooling (or a scheduler) makes it. Refusals come back as data. */
async function job(name, body = {}) {
  jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} }));
  const ctx = await jobCtx;
  const raw = JSON.stringify(body);
  const res = await fetch(`${ctx.url('bank')}/internal/jobs/${name}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function started() {
  const { who, loanId } = run.read();
  if (!who || !loanId) throw new Error(`${J} #1 opened no loan, so this step has no loan to act on`);
  return { who, loanId };
}
/** This loan as the bank lists it now. */
async function loanNow(api, loanId) {
  const res = await api.query('loans.list', { limit: 50 });
  if (!res.ok) throw new Error(`loans.list refused: ${res.status} ${res.code}`);
  const loan = res.data.find((l) => l.id === loanId);
  if (!loan) throw new Error(`loan ${loanId} is not in the person's list`);
  return loan;
}
async function ltvNow(api, loanId) {
  const res = await api.query('loans.health');
  if (!res.ok) throw new Error(`loans.health refused: ${res.status} ${res.code}`);
  return res.data.loans.find((l) => l.loanId === loanId)?.ltvBps;
}
const free = async (who, asset) => toUnits((await (await account(who)).balances())[asset]?.free ?? '0');
/** The value a confirmed outcome shows next to its label. */
const shown = (dialog, label) =>
  dialog
    .locator('dl > div')
    .filter({ has: dialog.page().getByText(label, { exact: true }) })
    .locator('dd');

/** The bank's daily rule (svc-bank `dailyLoanInterest`), worked again here: the APR in bps of the debt, then a 365th, each rounded down. */
const dailyInterest = (basisUnits, aprBps) => (basisUnits * BigInt(aprBps)) / 10_000n / 365n;

test(`${J} #1 opens the payoff quote and a 30-day projection: each row's interest is the bank's daily rule, and the table is labelled a projection`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await signUp(page, 'jb11');
  await verify(page, who);
  expect(fund(who.email, 'BTC', '0.01').tx).toBeTruthy();
  const api = await bank(who);
  const products = await api.query('loans.products', { limit: 50 });
  expect(products.ok).toBe(true);
  const product = products.data.find((p) => p.collateralAssetId === 'BTC' && p.debtAssetId === 'USDT');
  if (!product) throw new Error('the TEST content seed published no BTC-backed USDT loan product on this stack');
  const opened = await api.mutate('loans.open', {
    loanId: randomUUID(),
    productId: product.id,
    collateralAmount: '0.01',
    principal: '100',
  });
  if (!opened.ok) throw new Error(`loans.open refused: ${opened.status} ${opened.code}`);
  expect(opened.data.status).toBe('active');
  const loanId = opened.data.loanId;
  run.reset({ who, loanId });

  await signIn(page, who);
  await page.goto('/bank/loans');
  const record = page.locator(`article[data-loan-id="${loanId}"]`);
  await record.getByRole('link', { name: 'Payoff quote, projection and statement' }).click();
  await expect(page).toHaveURL(new RegExp(`/bank/loans/detail\\?loan=${loanId}`));

  // The quote is the bank's: interest through today, then principal, plus the TEST fee of 0, with the time it holds.
  const quote = page.getByTestId('loan-quote');
  await expect(quote).toBeVisible({ timeout: 30_000 });
  const served = await api.query('loans.payoffQuote', { loanId });
  expect(served.ok).toBe(true);
  expect(served.data).toMatchObject({ principal: '100', fee: '0', assetId: 'USDT' });
  expect(toUnits(served.data.total)).toBe(toUnits(served.data.principal) + toUnits(served.data.interest));
  await expect(quote).toHaveAttribute('data-total', served.data.total);
  await expect(quote).toContainText('To clear the loan now');
  await expect(quote).toContainText('Valid until');
  await expect(quote).toHaveAttribute('data-expired', 'false');
  expect(Date.parse(served.data.validUntil)).toBeGreaterThan(Date.now());

  // Thirty days ahead, labelled a projection and never an obligation; each row is the bank's own figure.
  await expect(page.getByTestId('loan-projection-label')).toHaveText('Projection, not a schedule');
  const table = page.getByTestId('loan-projection');
  await expect(table).toHaveAttribute('data-days', '30');
  await expect(table).toHaveAttribute('data-kind', 'projection');
  await expect(table).toHaveAttribute('data-obligation', 'false');
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(30);
  const projection = await api.query('loans.projection', { loanId, days: 30 });
  expect(projection.ok).toBe(true);
  expect(projection.data).toMatchObject({ kind: 'projection', obligation: false, aprBps: product.aprBps, days: 30 });
  const shown = await rows.evaluateAll((trs) =>
    trs.map((tr) => ({ date: tr.dataset.date, basis: tr.dataset.basis, interest: tr.dataset.interest })),
  );
  expect(shown).toEqual(projection.data.rows.map((r) => ({ date: r.date, basis: r.basis, interest: r.interest })));
  let basis = toUnits(projection.data.openingPrincipal) + toUnits(projection.data.openingInterest);
  for (const row of projection.data.rows) {
    expect(toUnits(row.basis)).toBe(basis);
    expect(toUnits(row.interest)).toBe(dailyInterest(basis, product.aprBps));
    basis += toUnits(row.interest);
    expect(toUnits(row.debt)).toBe(basis);
  }
  // The rows run day by day from tomorrow (UTC), the first day the bank's accrual has not charged.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  expect(projection.data.rows[0].date <= tomorrow).toBe(true);

  // A what-if repayment is taken off interest first, then principal, and nothing is repaid.
  await page.getByLabel('If I repay now (optional)').fill('50');
  await page.getByRole('button', { name: 'Show projection' }).click();
  await expect(page.getByText('With 50 USDT repaid first.')).toBeVisible({ timeout: 30_000 });
  await expect(rows.first()).toHaveAttribute('data-basis', '50');
  const after = await api.query('loans.list', { limit: 50 });
  expect(after.data.find((l) => l.id === loanId)).toMatchObject({ outstandingPrincipal: '100', status: 'active' });
});

test(`${J} #2 repays TEST 50: the interest owed first, then principal; the loan and its LTV read again; the collateral stays locked`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { who, loanId } = started();
  const api = await bank(who);

  // The starting state: a loan that owes interest. Fifteen past days, each charged once by the bank's own job.
  expect(age(loanId, 15)).toContain('moved back 15 days');
  const accrued = await job('accrue-loan-interest', { limit: 1000 });
  expect(accrued.status, JSON.stringify(accrued.body).slice(0, 300)).toBe(200);
  expect(accrued.body.results.find((r) => r.loanId === loanId)?.days).toBe(15);
  const before = await loanNow(api, loanId);
  expect(before).toMatchObject({ outstandingPrincipal: '100', status: 'active', collateral: '0.01' });
  const owed = toUnits(before.outstandingInterest);
  expect(owed).toBeGreaterThan(0n);
  const ltvBefore = await ltvNow(api, loanId);

  await signIn(page, who);
  await page.goto('/bank/loans');
  const record = page.locator(`article[data-loan-id="${loanId}"]`);
  await expect(record).toContainText(`${before.outstandingInterest} USDT`, { timeout: 30_000 });
  await record.getByRole('button', { name: 'Repay', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Amount/).fill('50');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });

  // Interest first, all of it, and the rest of the 50 off the principal.
  const principalPaid = fromUnits(toUnits('50') - owed);
  await expect(shown(dialog, 'Interest paid')).toHaveText(`${before.outstandingInterest} USDT`);
  await expect(shown(dialog, 'Principal paid')).toHaveText(`${principalPaid} USDT`);
  const remaining = fromUnits(toUnits('100') - toUnits(principalPaid));
  await expect(shown(dialog, 'Remaining principal')).toHaveText(`${remaining} USDT`);
  await expect(shown(dialog, 'Remaining interest')).toHaveText('0 USDT');
  const after = await loanNow(api, loanId);
  expect(after).toMatchObject({ outstandingPrincipal: remaining, outstandingInterest: '0', collateral: '0.01', status: 'active' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  // The loan reads again without a refresh: the new principal, and a lower LTV on the same collateral.
  await expect(record).toContainText(`${remaining} USDT`, { timeout: 30_000 });
  const ltvAfter = await ltvNow(api, loanId);
  expect(ltvAfter).toBeLessThan(ltvBefore);
  await expect(record.getByRole('region', { name: `Risk for loan ${loanId}` })).toContainText(`${ltvAfter / 100}%`, { timeout: 30_000 });
});

test(`${J} #3 loses the reply and sends the same repayment again: the bank collects it once and answers with the first result`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { who, loanId } = started();
  const api = await bank(who);
  const before = await loanNow(api, loanId);
  const usdtBefore = await free(who, 'USDT');

  await signIn(page, who);
  await page.goto('/bank/loans');
  const record = page.locator(`article[data-loan-id="${loanId}"]`);
  await expect(record).toContainText(`${before.outstandingPrincipal} USDT`, { timeout: 30_000 });

  // The bank answers the first send, and the answer never reaches the page: the connection drops on the way back.
  let lost = null;
  await page.route(
    '**/api/bank/trpc/loans.repay*',
    async (route) => {
      const res = await route.fetch();
      lost = { status: res.status(), body: await res.json() };
      await route.abort('connectionreset');
    },
    { times: 1 },
  );
  await record.getByRole('button', { name: 'Repay', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Amount/).fill('10');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toContainText('This request may have completed', { timeout: 30_000 });
  expect(lost?.status).toBe(200);
  const first = lost.body.result.data;
  expect(first.closed).toBe(false);
  expect(toUnits(first.interestPaid) + toUnits(first.principalPaid)).toBe(toUnits('10'));
  // Every bank write pauses on this one, by its reference.
  const reference = (await dialog.getByTestId('money-reference').first().textContent()).replace('Request reference: ', '').trim();
  await expect(page.locator('#bank-unconfirmed')).toContainText(reference);
  const debt = (loan) => toUnits(loan.outstandingPrincipal) + toUnits(loan.outstandingInterest);
  expect(debt(await loanNow(api, loanId))).toBe(debt(before) - toUnits('10'));

  // The same request again, under the same reference: the bank answers with the first repayment and takes nothing more.
  await expect(dialog.getByText('The bank answers this reference with its first result')).toBeVisible();
  await dialog.getByRole('button', { name: 'Send the same request again' }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });
  await expect(shown(dialog, 'Ledger transaction')).toHaveText(first.ledgerTxId);
  await expect(shown(dialog, 'Principal paid')).toHaveText(`${first.principalPaid} USDT`);
  await expect(page.locator('#bank-unconfirmed')).toHaveCount(0);
  const after = await loanNow(api, loanId);
  expect(debt(after)).toBe(debt(before) - toUnits('10'));
  expect(await free(who, 'USDT')).toBe(usdtBefore - toUnits('10'));

  // The bank's recovery job finds nothing of this loan's left to settle, and changes nothing.
  const recovered = await job('recover-loan-repayments', { limit: 50 });
  expect(recovered.status, JSON.stringify(recovered.body).slice(0, 300)).toBe(200);
  expect(recovered.body.filter((r) => r.loanId === loanId && r.outcome !== 'completed')).toEqual([]);
  expect(await loanNow(api, loanId)).toEqual(after);
  expect(await free(who, 'USDT')).toBe(usdtBefore - toUnits('10'));
  run.write({ resent: first.ledgerTxId });
});

/** Founder A proposes `bank.adjust_loan_interest` over exactly these fields at identity, founder B approves it. */
let staffDoor;
async function founders() {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { gates, ctx, sessions: await gates.approverSessions(ctx) };
  })();
  return staffDoor;
}
async function correctInterest(terms) {
  const { gates, ctx, sessions } = await founders();
  const approval = await gates.twoPerson(ctx, sessions, {
    actionType: 'bank.adjust_loan_interest',
    targetService: 'svc-bank',
    targetId: 'bank.adjust_loan_interest',
    expectedVersion: '1',
    payloadHash: gates.bankPayloadHash('bank.adjust_loan_interest', terms),
    policyVersion: gates.MARKERS.policyVersion,
  });
  const call = async () => ctx.edge.mutate('bank', 'ops.adjustLoanInterest', { ...terms, ...approval }, await sessions.a.treasuryToken());
  return { call, approval };
}

test(`${J} #4 sees an interest correction: the interest rows are append-only, and the loan agrees with the ledger`, async ({ page }) => {
  test.setTimeout(240_000);
  // A loan of its own that has owed interest for ten days (step 2's loan has paid its interest off): opened through the
  // bank's API, moved back ten days, and charged by the bank's own accrual job.
  const who = await signUp(page, 'jb11c');
  await verify(page, who);
  expect(fund(who.email, 'BTC', '0.01').tx).toBeTruthy();
  const api = await bank(who);
  const products = await api.query('loans.products', { limit: 50 });
  const product = products.data.find((p) => p.collateralAssetId === 'BTC' && p.debtAssetId === 'USDT');
  const opened = await api.mutate('loans.open', {
    loanId: randomUUID(),
    productId: product.id,
    collateralAmount: '0.01',
    principal: '100',
  });
  if (!opened.ok) throw new Error(`loans.open refused: ${opened.status} ${opened.code}`);
  const loanId = opened.data.loanId;
  age(loanId, 10);
  const accrued = await job('accrue-loan-interest', { limit: 1000 });
  expect(accrued.status, JSON.stringify(accrued.body).slice(0, 300)).toBe(200);
  expect(accrued.body.results.find((r) => r.loanId === loanId)?.days).toBe(10);
  const before = await api.query('loans.interestRows', { loanId });
  expect(before.ok).toBe(true);
  expect(before.data.days).toHaveLength(10);
  expect(toUnits(before.data.accrued)).toBeGreaterThan(toUnits('0.1'));

  // The founders correct it: one proposes taking TEST 0.1 off with a reason, the other approves, and the bank writes it
  // as a new row. Sent twice, it is written once.
  const terms = { loanId, adjustmentId: randomUUID(), amount: '-0.1', reason: `TEST ${J}: one day was charged on the wrong basis` };
  const { call } = await correctInterest(terms);
  const written = await call();
  expect(written.status, written.text.slice(0, 300)).toBe(200);
  const row = written.json.result.data;
  expect(row).toMatchObject({ adjustmentId: terms.adjustmentId, amount: '-0.1', reason: terms.reason, replay: false });
  expect(row.proposedBy).not.toBe(row.approvedBy);
  expect(row.interestOwed).toBe(fromUnits(toUnits(before.data.accrued) - toUnits('0.1')));
  const again = await call();
  expect(again.json?.result?.data).toMatchObject({ adjustmentId: terms.adjustmentId, replay: true });

  // The person sees it on the loan's page: every day still as charged, the correction with its reason, and what is owed.
  await signIn(page, who);
  await page.goto(`/bank/loans/detail?loan=${loanId}`);
  const interest = page.getByTestId('loan-interest');
  await expect(interest).toBeVisible({ timeout: 30_000 });
  await expect(interest).toHaveAttribute('data-accrued', before.data.accrued);
  await expect(interest).toHaveAttribute('data-corrected', '-0.1');
  await expect(interest).toHaveAttribute('data-owed', row.interestOwed);
  const days = page.getByTestId('loan-interest-days').locator('tbody tr');
  await expect(days).toHaveCount(10);
  const shownDays = await days.evaluateAll((trs) => trs.map((tr) => ({ date: tr.dataset.date, interest: tr.dataset.interest })));
  expect(shownDays).toEqual(before.data.days.map((d) => ({ date: d.date, interest: d.interest })));
  const corrections = page.getByTestId('loan-corrections').locator('tbody tr');
  await expect(corrections).toHaveCount(1);
  await expect(corrections.first()).toHaveAttribute('data-amount', '-0.1');
  await expect(corrections.first()).toContainText('−0.1 USDT');
  await expect(corrections.first()).toContainText(terms.reason);
  await expect(interest).toContainText('Interest owed now');

  // The bank checks this loan against the ledger: the payout and the pledge match their transactions leg by leg, and the
  // collateral held is what was pledged. A correction moves no money, so it adds no transaction to check.
  const check = page.getByTestId('loan-ledger-check');
  await expect(check).toHaveAttribute('data-status', 'agrees', { timeout: 30_000 });
  await expect(check).toHaveAttribute('data-checked', '2');
  await expect(check).toContainText('Agrees: 2 transactions match, and the collateral held is 0.01 BTC.');
  const after = await api.query('loans.interestRows', { loanId });
  expect(after.data.days).toEqual(before.data.days);
  expect(after.data.corrections).toEqual([expect.objectContaining({ id: terms.adjustmentId, amount: '-0.1', reason: terms.reason })]);
});

test(`${J} #5 redeems excess collateral, then repays in full: the loan closes and the rest of the collateral comes back once`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { who, loanId } = started();
  const api = await bank(who);
  const before = await loanNow(api, loanId);
  const btcBefore = await free(who, 'BTC');
  const releasable = await api.query('loans.releasable', { loanId });
  expect(releasable.ok).toBe(true);
  expect(toUnits(releasable.data.releasable)).toBeGreaterThan(toUnits('0.001'));

  await signIn(page, who);
  await page.goto('/bank/loans');
  const record = page.locator(`article[data-loan-id="${loanId}"]`);
  await expect(record).toContainText(`${before.outstandingPrincipal} USDT`, { timeout: 30_000 });

  // Asking for more than the bank would release holds Confirm, with the bank's own figure.
  await record.getByRole('button', { name: 'Release excess', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Amount/).fill('0.01');
  await dialog.getByRole('button', { name: 'Review' }).click();
  const most = dialog.getByTestId('review-terms-row').filter({ hasText: 'Most you can release now' });
  await expect(most).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId('review-terms-blocked')).toContainText('That is more than the bank would release now');
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Edit' }).click();
  await dialog.getByLabel(/Amount/).fill('0.001');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await expect(dialog.getByTestId('review-terms-blocked')).toHaveCount(0, { timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await loanNow(api, loanId)).toMatchObject({ collateral: '0.009', status: 'active' });
  expect(await free(who, 'BTC')).toBe(btcBefore + toUnits('0.001'));

  // Repaying everything owed: the debt clears, the loan closes and the rest of the collateral comes back in the same answer.
  const owed = fromUnits(toUnits(before.outstandingPrincipal) + toUnits(before.outstandingInterest));
  if ((await free(who, 'USDT')) < toUnits(owed)) fund(who.email, 'USDT', '10');
  await expect(record).toContainText('0.009 BTC', { timeout: 30_000 });
  await record.getByRole('button', { name: 'Repay', exact: true }).click();
  await dialog.getByLabel(/Amount/).fill(owed);
  await dialog.getByRole('button', { name: 'Review' }).click();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });
  await expect(shown(dialog, 'Principal paid')).toHaveText(`${before.outstandingPrincipal} USDT`);
  await expect(shown(dialog, 'Remaining principal')).toHaveText('0 USDT');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const closed = await loanNow(api, loanId);
  expect(closed).toMatchObject({ status: 'repaid', outstandingPrincipal: '0', outstandingInterest: '0', collateral: '0' });
  expect(await free(who, 'BTC')).toBe(btcBefore + toUnits('0.01'));
  await expect(record).toContainText('Repaid', { timeout: 30_000 });

  // Closing it again releases nothing more: the collateral came back once.
  const again = await api.mutate('loans.close', { loanId });
  expect(again).toMatchObject({ ok: true, data: { released: '0', ledgerTxId: null } });
  expect(await free(who, 'BTC')).toBe(btcBefore + toUnits('0.01'));
});

test(`${J} #6 downloads the loan statement: its lines add up to the same totals the bank holds`, async ({ page }) => {
  test.setTimeout(180_000);
  const { who, loanId } = started();
  const { resent } = run.read();
  const api = await bank(who);
  expect(await loanNow(api, loanId)).toMatchObject({ status: 'repaid', outstandingPrincipal: '0', outstandingInterest: '0' });

  await signIn(page, who);
  await page.goto(`/bank/loans/detail?loan=${loanId}`);
  const panel = page.getByTestId('loan-statement');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    panel.getByRole('button', { name: 'Download statement' }).click(),
  ]);
  const text = readFileSync(await download.path(), 'utf8').replace(/^\uFEFF/, '');
  const [header, ...lines] = text.trim().split('\r\n');
  expect(header).toBe('kind,at,amount,interest,principal,asset,ledgerTxId');
  const rows = lines.map((line) => {
    const [kind, at, amount, interest, principal, asset, ledgerTxId] = line.split(',');
    return { kind, at, amount, interest, principal, asset, ledgerTxId };
  });
  const opening = rows[0];
  const closing = rows.at(-1);
  expect(opening.kind).toBe('opening');
  expect(closing.kind).toMatch(/^closing/);

  // Three repayments, each once: 50, the 10 sent twice, and the rest. The resent one carries the first send's transaction.
  const repayments = rows.filter((r) => r.kind === 'repayment');
  expect(repayments).toHaveLength(3);
  expect(repayments.filter((r) => r.ledgerTxId === resent)).toHaveLength(1);
  const sum = (kind, field) => rows.filter((r) => r.kind === kind).reduce((total, r) => total + toUnits(r[field]), 0n);
  // The file's own arithmetic: opening, plus what was drawn and charged, less what was repaid, is the closing debt: none.
  expect(toUnits(opening.principal) + sum('draw', 'principal') - sum('repayment', 'principal')).toBe(toUnits(closing.principal));
  expect(toUnits(opening.interest) + sum('interest', 'interest') - sum('repayment', 'interest')).toBe(toUnits(closing.interest));
  expect(closing).toMatchObject({ principal: '0', interest: '0' });
  // The collateral leaves the loan the same day: the release of 0.001, then the rest when the debt cleared.
  expect(rows.filter((r) => r.kind === 'collateral_release').map((r) => r.amount)).toEqual(['0.001', '0.009']);

  // The page says the same totals the file carries.
  await expect(panel.getByRole('status')).toContainText(
    `Opening debt ${opening.principal} USDT principal and ${opening.interest} USDT interest; closing 0 USDT and 0 USDT.`,
  );
});
