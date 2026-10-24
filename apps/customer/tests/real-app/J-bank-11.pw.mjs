import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-11, in the running app (docs/roadmap/journeys.json): I repay and close my loan. Step 1 (BK-loan-06): the loan's
// payoff quote and a 30-day projection, on the loan's details page. The stack's TEST loan products come from the TEST
// content seed (BTC collateral against USDT debt at a TEST 10% APR), its BTC mark from the TEST market maker, and the
// payoff fee (TEST 0) and quote window (TEST 15 minutes) from the bank profile. One TEST account pledges TEST BTC and
// borrows TEST 100 USDT through the bank's own API as the starting state; the page is then read as the person sees it.
const J = 'J-bank-11';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who) {
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: who.email, password: who.password }),
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
