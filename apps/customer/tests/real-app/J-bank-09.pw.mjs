import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { localStackState } from '../../../../tooling/scripts/local-test-state.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, api as account, fromUnits, fund, journeyState, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-09, in the running app (docs/roadmap/journeys.json): I borrow against my crypto. One TEST borrower holding
// TEST 0.1 BTC, on /bank/loans/apply. The stack's seeded TEST loan product (BTC collateral against USDT debt at a TEST
// 10% APR, its reserve funded by the seed) is the one the borrower applies for; its BTC mark comes from the TEST market
// maker. Step 1 (BK-loan-01, BK-loan-02): the application shows the product's limits and rate; the owner has published
// no rate tiers and no fixed terms, so both read "not set" and the one APR applies; with the lending policy off (svc-bank
// restarted with BANK_LOANS_ENABLED=false, in a try/finally) the page names it and the bank refuses bank.loans_disabled.
// Step 2: the calculator's TEST 1000 USDT is the bank's own quote (`loans.quote`), and a TEST product of the journey's
// own on an asset with no market shows the price as unavailable while open refuses bank.mark_missing. Step 3: each
// eligibility condition is read back from the bank once; the stack's TEST fee is zero, so the line reads no fee; with the
// fee left blank (restart, try/finally) the table reads not set and open refuses bank.loan_fee_unset; with a non-zero
// TEST fee published (restart, try/finally) the fee line shows and open refuses bank.loan_fee_unwired. Step 4 (LOAN-01): the
// borrower opens from the review with the quote's figures; the collateral is locked once and the payout is exactly the
// principal; the reply lost and the same request sent again adopts the same loan. A crash between lock and draw is
// played on a TEST product of the journey's own whose reserve is empty: the loan stays pending with its collateral
// locked, the reserve is funded with `local-test-seed.mjs fund-loan-reserve`, and the bank's resume job (signed as its
// scheduler) draws it under the same keys with no borrower action. Step 5 (BK-loan-02): the loan page shows the terms
// written on the loan at open; the product's rate raised through the treasury door (two TEST founders) leaves them as
// they were. Red by name: rate tiers priced from a TEST tier table (#1, BK-loan-02 tier pricing is not built) and a
// threshold edit that leaves an open loan's thresholds alone (#5, the risk engine reads the product's thresholds, LOAN-02).
const J = 'J-bank-09';
const RUN = process.env.JOURNEY_RUN_ID ?? `local-${Date.now()}`;
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

let staffDoor;
async function founders() {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { gates, ctx, sessions: await gates.approverSessions(ctx) };
  })();
  return staffDoor;
}
/** One treasury door of the bank, approved by the stack's two TEST founders and bound to `fields`, the door's canonical strings. */
async function treasury(actionType, procedure, input, fields) {
  const { gates, ctx, sessions } = await founders();
  const approval = await gates.twoPerson(ctx, sessions, {
    actionType,
    targetService: 'svc-bank',
    targetId: actionType,
    expectedVersion: '1',
    payloadHash: gates.bankPayloadHash(actionType, fields),
    policyVersion: gates.MARKERS.policyVersion,
  });
  return ctx.edge.mutate('bank', procedure, { ...input, ...approval }, await sessions.a.treasuryToken());
}
/** The seeded products' liquidation ladder (local-test-seed.mjs TEST_LOAN_POLICY). */
const POLICY = {
  marginCallLtvBps: 7500,
  liquidationLtvBps: 8500,
  insolvencyLtvBps: 9500,
  targetLtvBps: 6500,
  penaltyBps: 200,
  maxTrancheBps: 2500,
  graceSeconds: 3600,
};
/** A TEST loan product of the journey's own, opened through the treasury door. */
async function openProduct({ label, debtAssetId, collateralAssetId, quoteAssetId }) {
  const input = {
    productId: randomUUID(),
    name: `TEST ${J} ${label} ${RUN}`,
    debtAssetId,
    collateralAssetId,
    quoteAssetId,
    aprBps: 1000,
    maxLtvBps: 5000,
    minPrincipal: '0',
    ...POLICY,
  };
  const fields = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v)]));
  const res = await treasury('bank.ops.createLoanProduct', 'ops.createLoanProduct', input, fields);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return input;
}
/** svc-bank restarted with one stack switch set, then put back as it was, whatever happens in `body`. */
async function withBank(name, value, body) {
  const before = process.env[name];
  process.env[name] = value;
  try {
    tool('local-test-stack.mjs', 'restart', 'bank');
    return await body();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
    tool('local-test-stack.mjs', 'restart', 'bank');
  }
}

let jobCtx;
/** One signed call to a bank job door, as the stack's own tooling (or a scheduler) makes it. */
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
/** The empty reserve of `assetId` funded by the seed's own funding move; `ref` keys it, so a retry funds once. */
/** 1% above a quoted pledge, rounded up to 8 places: the quote is exact at the cap, and the TEST market keeps moving. */
function withMargin(quoted) {
  const step = 10n ** 10n;
  const units = (toUnits(quoted) * 101n + 99n) / 100n;
  return fromUnits(((units + step - 1n) / step) * step);
}

/** What the bank's loan reserve of `assetId` holds now, as treasury reads it (`ops.reconcileLoanReserve`), in units. */
async function reserveBalance(assetId) {
  const { ctx, sessions } = await founders();
  const res = await ctx.edge.query('bank', 'ops.reconcileLoanReserve', { debtAssetId: assetId }, await sessions.a.treasuryToken());
  expect(res.status, res.text?.slice(0, 300)).toBe(200);
  return toUnits(res.json.result.data.reserveBalance);
}

function fundReserve(assetId, amount, ref) {
  return execFileSync(
    process.execPath,
    [path.join(ROOT, 'tooling/scripts/local-test-seed.mjs'), 'fund-loan-reserve', assetId, amount, ref, '--state', localStackState()],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LOCAL_TEST: '1' }, timeout: 60_000 },
  );
}

/** The person's ledger balances, free and locked, in units. */
async function held(who) {
  const balances = await (await account(who)).balances();
  const of = (asset) => ({ free: toUnits(balances[asset]?.free ?? '0'), used: toUnits(balances[asset]?.used ?? '0') });
  return { BTC: of('BTC'), USDT: of('USDT'), USDC: of('USDC') };
}
async function loansOf(api) {
  const res = await api.query('loans.list', { limit: 200 });
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 300)).toBe(true);
  return res.data;
}
async function seededProduct(api) {
  const products = await api.query('loans.products', { limit: 200 });
  expect(products.ok).toBe(true);
  const product = products.data.find((p) => p.collateralAssetId === 'BTC' && p.debtAssetId === 'USDT' && p.name.startsWith('TEST · '));
  if (!product) throw new Error('the TEST content seed published no BTC-backed USDT loan product on this stack');
  return product;
}
function started() {
  const state = run.read();
  if (!state.who) throw new Error(`${J} #1 made no borrower, so this step has no one to act for`);
  return state;
}
const applyPage = (productId) => `/bank/loans/apply?product=${encodeURIComponent(productId)}`;
async function workOut(page, amount) {
  await page.getByLabel(/^Amount to borrow \(/).fill(amount);
  await page.getByRole('button', { name: 'Work it out', exact: true }).click();
}

test(`${J} #1 opens the application and picks the loan: its limits and rate, rate tiers and term "not set"; with the lending policy off the page names it and the bank refuses bank.loans_disabled`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = await signUp(page, 'jb09');
  await verify(page, who);
  expect(fund(who.email, 'BTC', '0.1').tx).toBeTruthy();
  const api = await bank(who);
  const product = await seededProduct(api);
  run.reset({ who, productId: product.id });

  await signIn(page, who);
  await page.goto('/bank/loans');
  await page.getByRole('link', { name: 'Apply for a loan' }).first().waitFor({ timeout: 30_000 });
  await page.goto('/bank/loans/apply');
  await page.getByLabel('Which loan').selectOption(product.id);
  const limits = page.getByTestId('loan-apply-limits');
  await expect(limits).toHaveAttribute('data-product-id', product.id);
  // The limits and rate are the bank's own: read again from loans.products and matched on the page.
  await expect(limits.locator('dd[data-value]').first()).toHaveAttribute('data-value', String(product.aprBps));
  await expect(limits.locator('dd[data-value]').nth(1)).toHaveAttribute('data-value', String(product.maxLtvBps));
  await expect(limits).toContainText(`${product.aprBps / 100}%`);
  await expect(limits).toContainText(`${product.marginCallLtvBps / 100}%`);
  await expect(limits).toContainText(`${product.liquidationLtvBps / 100}%`);
  await expect(page.getByTestId('loan-apply-tiers')).toHaveAttribute('data-state', 'not_set');
  await expect(page.getByTestId('loan-apply-tiers')).toContainText('every amount borrows at the one rate above');
  await expect(page.getByTestId('loan-apply-term')).toHaveAttribute('data-state', 'not_set');
  await expect(page.getByTestId('loan-apply-eligibility').locator('[data-key="lending_policy"]')).toHaveAttribute('data-state', 'met');

  // The lending policy off: the bank restarted with it switched off, and back on afterwards whatever happens.
  const before = await held(who);
  const loansBefore = await loansOf(api);
  await withBank('LOCAL_STACK_BANK_LOANS', 'off', async () => {
    const offApi = await bank(who);
    const eligibility = await offApi.query('loans.eligibility', { productId: product.id });
    expect(eligibility.ok).toBe(true);
    expect(eligibility.data.eligible).toBe(false);
    expect(eligibility.data.reasons.find((r) => r.key === 'lending_policy')).toEqual({
      key: 'lending_policy',
      state: 'unmet',
      code: 'bank.loans_disabled',
    });
    const quoted = await offApi.query('loans.quote', { productId: product.id, principal: '1000' });
    expect(quoted).toMatchObject({ ok: false, code: 'bank.loans_disabled' });
    const opened = await offApi.mutate('loans.open', {
      loanId: randomUUID(),
      productId: product.id,
      principal: '1000',
      collateralAmount: '0.05',
    });
    expect(opened).toMatchObject({ ok: false, code: 'bank.loans_disabled' });

    await page.goto(applyPage(product.id));
    const policy = page.getByTestId('loan-apply-eligibility').locator('[data-key="lending_policy"]');
    await expect(policy).toHaveAttribute('data-state', 'unmet', { timeout: 30_000 });
    await expect(policy).toContainText('Reference: bank.loans_disabled');
    await workOut(page, '1000');
    await expect(page.locator('[role="alert"][data-code="bank.loans_disabled"]')).toContainText('Lending is closed');
    await expect(page.getByRole('button', { name: 'Review and open', exact: true })).toBeDisabled();
    // Nothing opened and nothing moved.
    expect(await loansOf(offApi)).toEqual(loansBefore);
    expect(await held(who)).toEqual(before);
  });
  const after = await bank(who);
  expect((await after.query('loans.eligibility', { productId: product.id })).data.eligible).toBe(true);
});

test(`${J} #1 with a TEST tier table, the band's APR shows and the loan snapshots that rate`, async () => {
  throw new Error(
    'Red by name (BK-loan-02 tier pricing): the bank has no rate-tier table to read, so no band APR can be shown or snapshotted. The owner has published none; the page shows "not set" and the one APR (asserted in #1).',
  );
});

test(`${J} #2 works out TEST 1000 USDT in the calculator: the collateral, starting LTV and liquidation price are the bank's quote; an asset with no price shows "price unavailable" and open refuses bank.mark_missing`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { who, productId } = started();
  const api = await bank(who);
  await signIn(page, who);
  await page.goto(applyPage(productId));
  await workOut(page, '1000');
  const shown = page.getByTestId('loan-apply-quote');
  await expect(shown).toBeVisible({ timeout: 30_000 });
  await expect(shown).toHaveAttribute('data-principal', '1000');
  const quote = await api.query('loans.quote', { productId, principal: '1000' });
  expect(quote.ok, JSON.stringify(quote.body ?? {}).slice(0, 300)).toBe(true);
  // The page shows the bank's figures as decimal strings, never its own sums.
  const onPage = await shown.evaluate((el) => ({ ...el.dataset }));
  expect(onPage.collateral).toBe(quote.data.requiredCollateral);
  expect(onPage.ltvBps).toBe(String(quote.data.startingLtvBps));
  expect(onPage.liquidationPrice).toBe(quote.data.liquidationPrice);
  expect(quote.data).toMatchObject({ principal: '1000', debtAssetId: 'USDT', collateralAssetId: 'BTC', maxLtvBps: 5000 });
  expect(quote.data.startingLtvBps).toBeLessThanOrEqual(quote.data.maxLtvBps);
  // The pledge is the smallest the opening check accepts: at the quote's price, one unit less passes the cap.
  const ONE = toUnits('1');
  const value = (c) => (c * toUnits(quote.data.collateralPrice)) / ONE;
  const ltv = (c) => {
    const debt = (toUnits('1000') * toUnits(quote.data.debtPrice) + ONE - 1n) / ONE;
    return (debt * 10_000n + value(c) - 1n) / value(c);
  };
  expect(ltv(toUnits(quote.data.requiredCollateral))).toBeLessThanOrEqual(5000n);
  expect(ltv(toUnits(quote.data.requiredCollateral) - 1n)).toBeGreaterThan(5000n);
  run.write({ quote: quote.data });

  // An asset with no market on this stack: no figure, never zero, and open refuses before anything is locked.
  const unpriced = await openProduct({ label: 'unpriced', debtAssetId: 'USDT', collateralAssetId: 'XTEST', quoteAssetId: 'USDT' });
  await page.goto(applyPage(unpriced.productId));
  await workOut(page, '1000');
  await expect(page.locator('[role="alert"][data-code="bank.mark_missing"]')).toContainText(
    'A current price for one of these assets is missing',
    {
      timeout: 30_000,
    },
  );
  await expect(page.getByTestId('loan-apply-quote')).toHaveCount(0);
  expect(await api.query('loans.quote', { productId: unpriced.productId, principal: '1000' })).toMatchObject({
    ok: false,
    code: 'bank.mark_missing',
  });
  const before = await held(who);
  const loansBefore = await loansOf(api);
  const refused = await api.mutate('loans.open', {
    loanId: randomUUID(),
    productId: unpriced.productId,
    principal: '1000',
    collateralAmount: '0.05',
  });
  expect(refused).toMatchObject({ ok: false, code: 'bank.mark_missing' });
  expect(await loansOf(api)).toEqual(loansBefore);
  expect(await held(who)).toEqual(before);
});

test(`${J} #3 reads eligibility and fees: each condition the bank checks, the TEST zero fee line; a blank fee reads "not set" and open refuses bank.loan_fee_unset; a published TEST fee shows its line and open refuses bank.loan_fee_unwired`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { who, productId } = started();
  const api = await bank(who);
  await signIn(page, who);
  await page.goto(applyPage(productId));
  const list = page.getByTestId('loan-apply-eligibility');
  await expect(list).toHaveAttribute('data-eligible', 'true', { timeout: 30_000 });
  const eligibility = await api.query('loans.eligibility', { productId });
  expect(eligibility.ok).toBe(true);
  // Every condition the bank answers is on the page exactly once, with the bank's state and code.
  const keys = eligibility.data.reasons.map((r) => r.key);
  expect([...keys].sort()).toEqual(['assets_open', 'jurisdiction_rules', 'lending_policy', 'origination_fee', 'product_open']);
  await expect(list.locator('[data-key]')).toHaveCount(keys.length);
  for (const reason of eligibility.data.reasons) {
    const row = list.locator(`[data-key="${reason.key}"]`);
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-state', reason.state);
    await expect(row).toHaveAttribute('data-code', reason.code ?? '');
  }
  expect(eligibility.data.reasons.find((r) => r.key === 'jurisdiction_rules')).toEqual({
    key: 'jurisdiction_rules',
    state: 'not_set',
    code: null,
  });
  await expect(list).toContainText('The bank has published no rules for where you live');
  expect(eligibility.data.reasons.find((r) => r.key === 'origination_fee')).toEqual({ key: 'origination_fee', state: 'met', code: null });
  // The stack's TEST fee is zero: its line says no fee, and nothing stops the open.
  const fees = await api.query('loans.fees', { productId, principal: '1000' });
  expect(fees.data).toEqual({ productId, assetId: 'USDT', origination: { status: 'published', bps: 0, amount: '0', collectable: true } });
  await workOut(page, '1000');
  const fee = page.getByTestId('loan-apply-fee');
  await expect(fee).toHaveAttribute('data-state', 'published');
  await expect(fee).toHaveAttribute('data-bps', '0');
  await expect(fee).toContainText('No opening fee.');

  const before = await held(who);
  const loansBefore = await loansOf(api);
  // The fee left blank (restart, put back afterwards): the table reads not set, and open refuses before anything is locked.
  await withBank('LOCAL_STACK_BANK_LOAN_ORIGINATION_FEE', 'off', async () => {
    const blankApi = await bank(who);
    const blank = await blankApi.query('loans.fees', { productId, principal: '1000' });
    expect(blank.data).toEqual({ productId, assetId: 'USDT', origination: { status: 'not_set' } });
    const blankElig = await blankApi.query('loans.eligibility', { productId });
    expect(blankElig.data.eligible).toBe(false);
    expect(blankElig.data.reasons.find((r) => r.key === 'origination_fee')).toEqual({
      key: 'origination_fee',
      state: 'unmet',
      code: 'bank.loan_fee_unset',
    });
    await page.goto(applyPage(productId));
    await workOut(page, '1000');
    const line = page.getByTestId('loan-apply-fee');
    await expect(line).toHaveAttribute('data-state', 'not_set', { timeout: 30_000 });
    await expect(line).toContainText('has not published its fee for opening a loan, so new loans are refused');
    await expect(page.getByTestId('loan-apply-eligibility').locator('[data-key="origination_fee"]')).toHaveAttribute(
      'data-code',
      'bank.loan_fee_unset',
    );
    await expect(page.getByRole('button', { name: 'Review and open', exact: true })).toBeDisabled();
    const quote = await blankApi.query('loans.quote', { productId, principal: '1000' });
    const refused = await blankApi.mutate('loans.open', {
      loanId: randomUUID(),
      productId,
      principal: '1000',
      collateralAmount: quote.data.requiredCollateral,
    });
    expect(refused).toMatchObject({ ok: false, code: 'bank.loan_fee_unset' });
    expect(await loansOf(blankApi)).toEqual(loansBefore);
    expect(await held(who)).toEqual(before);
  });

  // A non-zero TEST fee published (restart, put back afterwards): its line shows, and open refuses before anything is locked.
  await withBank('LOCAL_STACK_BANK_LOAN_ORIGINATION_FEE', 'published', async () => {
    const feeApi = await bank(who);
    const published = await feeApi.query('loans.fees', { productId, principal: '1000' });
    expect(published.data).toEqual({
      productId,
      assetId: 'USDT',
      origination: { status: 'published', bps: 50, amount: '5', collectable: false },
    });
    await page.goto(applyPage(productId));
    await workOut(page, '1000');
    const line = page.getByTestId('loan-apply-fee');
    await expect(line).toHaveAttribute('data-state', 'published', { timeout: 30_000 });
    await expect(line).toHaveAttribute('data-bps', '50');
    await expect(line).toHaveAttribute('data-amount', '5');
    await expect(line).toContainText('new loans are refused');
    await expect(page.getByTestId('loan-apply-eligibility').locator('[data-key="origination_fee"]')).toHaveAttribute(
      'data-code',
      'bank.loan_fee_unwired',
    );
    await expect(page.getByRole('button', { name: 'Review and open', exact: true })).toBeDisabled();
    const quote = await feeApi.query('loans.quote', { productId, principal: '1000' });
    const refused = await feeApi.mutate('loans.open', {
      loanId: randomUUID(),
      productId,
      principal: '1000',
      collateralAmount: quote.data.requiredCollateral,
    });
    expect(refused).toMatchObject({ ok: false, code: 'bank.loan_fee_unwired' });
    expect(await loansOf(feeApi)).toEqual(loansBefore);
    expect(await held(who)).toEqual(before);
  });
});

test(`${J} #4 opens the loan from the review: the collateral locked once, the payout exactly the quote's principal, a lost reply adopts the same loan, and a crash between lock and draw is recovered by the same keys`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { who, productId } = started();
  const api = await bank(who);
  const before = await held(who);
  const loansBefore = await loansOf(api);
  await signIn(page, who);
  await page.goto(applyPage(productId));
  await workOut(page, '1000');
  const shown = page.getByTestId('loan-apply-quote');
  await expect(shown).toBeVisible({ timeout: 30_000 });
  const quoted = await shown.getAttribute('data-collateral');
  const pledged = withMargin(quoted);
  await page.getByRole('button', { name: 'Review and open', exact: true }).click();
  const dialog = page.getByRole('dialog');
  // The review carries the quote's figures as the request.
  await expect(dialog.getByLabel('Amount to borrow (USDT)')).toHaveValue('1000');
  await expect(dialog.getByLabel('Collateral to pledge (BTC)')).toHaveValue(quoted);
  // The quote is the smallest pledge at the cap on the prices it read; the TEST market keeps moving, so the borrower
  // pledges 1% more (rounded up to 8 places) and the open is not refused by a tick (the room says so when it is).
  await dialog.getByLabel('Collateral to pledge (BTC)').fill(pledged);
  await dialog.getByRole('button', { name: 'Review' }).click();
  await dialog.getByRole('button', { name: 'Open loan', exact: true }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  const fresh = (await loansOf(api)).filter((l) => !loansBefore.some((b) => b.id === l.id));
  expect(fresh).toHaveLength(1);
  const [loan] = fresh;
  expect(loan).toMatchObject({ productId, principal: '1000', collateral: pledged, status: 'active', outstandingPrincipal: '1000' });
  // What open recorded is what the quote said: the principal and the pledge, at the product's rate.
  const terms = await api.query('loans.terms', { loanId: loan.id });
  expect(terms.data).toMatchObject({ principal: '1000', openingCollateral: pledged, aprBps: 1000 });
  // The collateral moved once from free to locked; the payout is exactly the principal.
  const after = await held(who);
  expect(after.BTC.free).toBe(before.BTC.free - toUnits(pledged));
  expect(after.USDT.free).toBe(before.USDT.free + toUnits('1000'));
  // The bank's rows for the loan agree with the ledger's own transactions, leg by leg, and the pot holds the pledge.
  const check = await api.query('loans.ledgerCheck', { loanId: loan.id });
  expect(check.ok, JSON.stringify(check.body ?? {}).slice(0, 300)).toBe(true);
  expect(check.data).toMatchObject({ status: 'agrees', pending: 0, mismatches: [], collateralHeld: pledged });

  // The reply is lost and the same request goes again under the same loan id: the bank answers with the same loan.
  const replay = await api.mutate('loans.open', { loanId: loan.id, productId, principal: '1000', collateralAmount: pledged });
  expect(replay.ok, JSON.stringify(replay.body ?? {}).slice(0, 300)).toBe(true);
  expect(replay.data.loanId).toBe(loan.id);
  expect(await held(who)).toEqual(after);
  expect((await loansOf(api)).filter((l) => !loansBefore.some((b) => b.id === l.id))).toHaveLength(1);
  run.write({ loanId: loan.id });

  // A crash between lock and draw: a TEST product of the journey's own lends USDC for 100 more than the USDC reserve
  // holds (the reserve is the bank's per asset, so an earlier run or a retry may have left some in it), so the draw can't
  // be paid when the collateral is already locked.
  const dry = await openProduct({ label: 'empty reserve', debtAssetId: 'USDC', collateralAssetId: 'BTC', quoteAssetId: 'USDC' });
  const borrow = fromUnits((await reserveBalance('USDC')) + toUnits('100'));
  const quote = await api.query('loans.quote', { productId: dry.productId, principal: borrow });
  expect(quote.ok, JSON.stringify(quote.body ?? {}).slice(0, 300)).toBe(true);
  const stuckId = randomUUID();
  const request = {
    loanId: stuckId,
    productId: dry.productId,
    principal: borrow,
    collateralAmount: withMargin(quote.data.requiredCollateral),
  };
  const beforeStuck = await held(who);
  const stuck = await api.mutate('loans.open', request);
  expect(stuck).toMatchObject({ ok: false, code: 'bank.loan_reserve_underfunded' });
  const pending = (await loansOf(api)).find((l) => l.id === stuckId);
  expect(pending).toMatchObject({ status: 'pending', collateral: request.collateralAmount });
  const locked = await held(who);
  expect(locked.BTC.free).toBe(beforeStuck.BTC.free - toUnits(request.collateralAmount));
  expect(locked.USDC.free).toBe(beforeStuck.USDC.free);
  // The reserve funded by the seed, then the bank's own resume job draws it; the borrower does nothing.
  expect(fundReserve('USDC', '1000', `jb09-${RUN}`.slice(0, 64))).toContain('loan reserve USDC: funded 1000');
  const resumed = await job('resume-pending-loans', { limit: 1000 });
  expect(resumed.status, JSON.stringify(resumed.body).slice(0, 300)).toBe(200);
  const mine = resumed.body.filter((r) => r.loanId === stuckId);
  expect(mine).toEqual([{ loanId: stuckId, outcome: 'completed' }]);
  const recovered = await held(who);
  expect(recovered.BTC.free).toBe(locked.BTC.free);
  expect(recovered.USDC.free).toBe(locked.USDC.free + toUnits(borrow));
  expect((await loansOf(api)).find((l) => l.id === stuckId)).toMatchObject({ status: 'active', outstandingPrincipal: borrow });
  // The borrower's own retry after the crash adopts the loan the job drew; nothing locks or pays twice.
  const retried = await api.mutate('loans.open', request);
  expect(retried.ok, JSON.stringify(retried.body ?? {}).slice(0, 300)).toBe(true);
  expect(retried.data).toMatchObject({ loanId: stuckId, status: 'active' });
  expect(await held(who)).toEqual(recovered);
  const stuckCheck = await api.query('loans.ledgerCheck', { loanId: stuckId });
  expect(stuckCheck.data).toMatchObject({ status: 'agrees', pending: 0, mismatches: [], collateralHeld: request.collateralAmount });
  run.write({ dryProductId: dry.productId, recoveredLoanId: stuckId, recoveredPrincipal: borrow });
});

test(`${J} #5 reads the loan page: the terms written at open; the product's rate raised through the treasury door leaves them as they were`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { who, dryProductId, recoveredLoanId, recoveredPrincipal } = started();
  if (!recoveredLoanId) throw new Error(`${J} #4 opened no loan on the journey's own product, so this step has no loan to read`);
  const api = await bank(who);
  const opened = await api.query('loans.terms', { loanId: recoveredLoanId });
  expect(opened.data).toMatchObject({
    loanId: recoveredLoanId,
    productId: dryProductId,
    aprBps: 1000,
    marginCallLtvBps: POLICY.marginCallLtvBps,
    liquidationLtvBps: POLICY.liquidationLtvBps,
    principal: recoveredPrincipal,
  });

  await signIn(page, who);
  await page.goto(`/bank/loans/detail?loan=${recoveredLoanId}`);
  const panel = page.getByTestId('loan-terms');
  await expect(panel).toHaveAttribute('data-apr-bps', '1000', { timeout: 30_000 });
  await expect(panel).toHaveAttribute('data-margin-call-bps', String(POLICY.marginCallLtvBps));
  await expect(panel).toHaveAttribute('data-liquidation-bps', String(POLICY.liquidationLtvBps));

  // The owner's change of rate on the product, approved by two TEST founders.
  const reason = `TEST ${J} rate change ${RUN}`;
  const res = await treasury(
    'bank.ops.setLoanProductRate',
    'ops.setLoanProductRate',
    { productId: dryProductId, fromAprBps: 1000, aprBps: 1200, reason },
    { productId: dryProductId, fromAprBps: '1000', aprBps: '1200', reason },
  );
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  expect(res.json.result.data).toMatchObject({ productId: dryProductId, aprBps: 1200, previousAprBps: 1000 });
  const products = await api.query('loans.products', { limit: 200 });
  expect(products.data.find((p) => p.id === dryProductId)?.aprBps).toBe(1200);
  // The loan keeps what was written on it: the terms read, the loan list and the page.
  expect((await api.query('loans.terms', { loanId: recoveredLoanId })).data).toEqual(opened.data);
  expect((await loansOf(api)).find((l) => l.id === recoveredLoanId)?.aprBps).toBe(1000);
  await page.reload();
  await expect(page.getByTestId('loan-terms')).toHaveAttribute('data-apr-bps', '1000', { timeout: 30_000 });
  await expect(page.getByTestId('loan-terms')).toContainText('10%');
});

test(`${J} #5 a threshold edit after a loan opened leaves the open loan's liquidation terms as they were`, async () => {
  throw new Error(
    "Red by name (LOAN-02): the bank's risk sweep reads the margin-call and liquidation thresholds from the product, not from the loan, so no door edits them for a product with open loans. The loan's own snapshot is shown (asserted in #5).",
  );
});
