import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';

const evidence = process.env.LOAN_EVIDENCE || '/tmp/intafaced-loans-browser';
mkdirSync(evidence, { recursive: true });
const userId = '11111111-1111-4111-8111-111111111111';
const statuses = ['active', 'margin_call', 'pending', 'liquidating', 'repaid', 'liquidated', 'unrecognized'];
const ids = statuses.map((_, i) => `${i + 3}${'3'.repeat(7)}-3333-4333-8333-333333333333`);
const original = {
  id: ids[0],
  productId: '22222222-2222-4222-8222-222222222222',
  debtAssetId: 'USDC',
  collateralAssetId: 'BTC',
  principal: '5000',
  outstandingPrincipal: '5000',
  outstandingInterest: '12.5',
  collateral: '0.2',
  aprBps: 500,
  status: 'active',
  marginCalledAt: null,
};
const rows = statuses.map((status, i) => ({
  ...original,
  id: ids[i],
  status,
  outstandingPrincipal: ['repaid', 'liquidated', 'unrecognized'].includes(status) ? '0' : '5000',
  outstandingInterest: ['repaid', 'liquidated', 'pending', 'unrecognized'].includes(status) ? '0' : '12.5',
}));
const response = (route, data) => route.fulfill({ json: { result: { data } } });
const readFailed = (route) => route.fulfill({ status: 503, json: { error: 'Unavailable', message: 'Read unavailable.' } });
async function setup(page) {
  const state = {
    rows: structuredClone(rows),
    listFail: false,
    healthFail: false,
    uncertain: false,
    // How many repay replies to drop on the way back, after the service answered.
    dropReplies: 0,
    releasable: '0.15',
    writes: [],
    health: {
      debtValue: '10000',
      collateralValue: '20000',
      portfolioLtvBps: 5000,
      loans: [
        { loanId: ids[1], debtValue: '5012.5', collateralValue: '10000', ltvBps: 6013 },
        { loanId: ids[0], debtValue: '5012.5', collateralValue: '10000', ltvBps: 5013 },
        { loanId: ids[3], debtValue: '5012.5', collateralValue: '0', ltvBps: Number.MAX_SAFE_INTEGER },
      ],
    },
  };
  await page.route('**/api/**', readFailed);
  await page.route('**/api/identity/trpc/auth.login', (r) =>
    response(r, {
      userId,
      accessToken: 'isolated-identity-test',
      refreshToken: 'isolated-refresh-test',
      expiresAt: '2027-10-09T00:00:00Z',
    }),
  );
  await page.route('**/api/identity/trpc/webauthn.list?*', (r) => response(r, []));
  await page.route('**/api/v1/markets*', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/bank/trpc/loans.products?*', (r) => response(r, []));
  await page.route('**/api/bank/trpc/loans.list?*', (r) => (state.listFail ? readFailed(r) : response(r, state.rows)));
  await page.route('**/api/bank/trpc/loans.health', (r) => (state.healthFail ? readFailed(r) : response(r, state.health)));
  await page.route('**/api/bank/trpc/loans.releasable?*', (r) => {
    const loanId = JSON.parse(new URL(r.request().url()).searchParams.get('input')).loanId;
    if (state.releasable === null)
      return r.fulfill({
        status: 409,
        json: {
          error: {
            message: 'No usable mark',
            code: -32603,
            data: { code: 'CONFLICT', httpStatus: 409, cause: { code: 'bank.mark_missing' } },
          },
        },
      });
    return response(r, { loanId, held: '0.2', releasable: state.releasable, maxLtvBps: 5000, ltvBps: 5013 });
  });
  await page.route('**/api/bank/trpc/loans.*', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const procedure = new URL(r.request().url()).pathname.split('/').pop();
    const body = r.request().postDataJSON();
    state.writes.push({ procedure, body });
    if (state.uncertain) return r.fulfill({ status: 503, json: { error: 'Unavailable', message: 'Original outcome unavailable.' } });
    if (procedure === 'loans.repay' && state.dropReplies > 0) {
      state.dropReplies -= 1;
      return r.abort('connectionreset');
    }
    if (procedure === 'loans.repay')
      return response(r, {
        ledgerTxId: 'confirmed-repayment',
        interestPaid: body.amount,
        principalPaid: '0',
        remainingPrincipal: '5000',
        remainingInterest: '12.4',
        closed: false,
      });
    if (procedure === 'loans.close') return response(r, { released: '0.2', ledgerTxId: 'confirmed-release' });
    return response(r, { ledgerTxId: 'confirmed-collateral', sequence: 2 });
  });
  return state;
}
async function signIn(page) {
  await page.goto('/login?redirect=%2Fbank%2Floans');
  await page.getByLabel('Email or handle', { exact: true }).fill('integration@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/bank\/loans$/);
  await expect(page.getByTestId('money-loan-record')).toHaveCount(7);
}
const card = (page, i = 0) => page.locator(`[data-loan-id="${ids[i]}"]`);
const refresh = (page) => page.getByRole('button', { name: 'Refresh loans and health', exact: true });
async function review(page, action = 'Repay', index = 0, amount = '0.000000000000000001') {
  await card(page, index).getByRole('button', { name: action, exact: true }).click();
  if (action !== 'Close settled loan') {
    await page.getByLabel(action === 'Repay' ? 'Amount (USDC)' : 'Amount (BTC)', { exact: true }).fill(amount);
    await page.getByRole('button', { name: 'Review', exact: true }).click();
  }
}
async function journal(page) {
  return JSON.parse((await page.evaluate((id) => localStorage.getItem('intafaced.customer.bank-unconfirmed.v1:' + id), userId)) || '[]');
}

test('actual App uses each loan ratio and per-action status admission with native phone focus', async ({ page }) => {
  const state = await setup(page),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  await expect(card(page, 0).getByTestId('money-loan-risk')).toContainText('50.13%');
  await expect(card(page, 1).getByTestId('money-loan-risk')).toContainText('60.13%');
  await expect(card(page, 2).getByTestId('money-loan-risk')).toContainText('Loan risk unavailable');
  await expect(card(page, 2)).toContainText('Principal credit is unconfirmed');
  await expect(card(page, 2)).toContainText('Principal in pending record');
  await expect(card(page, 3)).toContainText('Unbounded or capped LTV');
  const admitted = [
    [true, true, true, false],
    [true, true, true, false],
    [false, true, false, false],
    [false, true, true, false],
    [false, false, false, true],
    [false, false, false, true],
    [false, false, false, false],
  ];
  const labels = ['Repay', 'Add collateral', 'Release excess', 'Close settled loan'];
  for (let i = 0; i < statuses.length; i++)
    for (let a = 0; a < labels.length; a++) {
      const button = card(page, i).getByRole('button', { name: labels[a], exact: true });
      if (admitted[i][a]) await expect(button).toBeEnabled();
      else await expect(button).toBeDisabled();
    }
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const first = card(page).getByRole('button', { name: 'Repay', exact: true });
    await first.focus();
    await page.keyboard.press('Tab');
    const next = card(page).getByRole('button', { name: 'Add collateral', exact: true });
    await expect(next).toBeFocused();
    const fit = await next.evaluate((el) => {
      const r = el.getBoundingClientRect(),
        bar = document.querySelector('[data-testid="mobile-doors"]')?.getBoundingClientRect();
      return { hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)), bottom: r.bottom, barTop: bar?.top };
    });
    expect(fit.hit).toBe(true);
    if (width <= 1000) expect(fit.bottom).toBeLessThanOrEqual(fit.barTop);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('[data-testid="money-loan-record"]').analyze();
    expect(audit.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);
    await page.screenshot({ path: evidence + `/loans-${width}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
  expect(state.writes).toEqual([]);
});

test('exact repayment review retains original identity, units and caller event', async ({ page }) => {
  const state = await setup(page);
  await signIn(page);
  await review(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(ids[0]);
  await expect(dialog).toContainText('USDC');
  await expect(dialog).toContainText('BTC');
  await expect(dialog).toContainText('active');
  await expect(dialog).toContainText('0.000000000000000001');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toContainText('Confirmed by the service');
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ procedure: 'loans.repay', body: { loanId: ids[0], amount: '0.000000000000000001' } });
  expect(state.writes[0].body.eventId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await journal(page)).toEqual([]);
});

for (const scenario of ['changed status', 'changed debt', 'omitted original', 'read failed']) {
  test('current loan review refuses without journal or write when ' + scenario, async ({ page }) => {
    const state = await setup(page);
    await signIn(page);
    await review(page);
    if (scenario === 'changed status') state.rows[0].status = 'liquidating';
    if (scenario === 'changed debt') state.rows[0].outstandingInterest = '13';
    if (scenario === 'omitted original') state.rows = state.rows.slice(1);
    if (scenario === 'read failed') state.listFail = true;
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('No request was sent.');
    await expect(page.getByRole('dialog')).toContainText(ids[0]);
    expect(state.writes).toEqual([]);
    expect(await journal(page)).toEqual([]);
  });
}

test('risk failed, omitted and restored reads never reuse a different loan ratio', async ({ page }) => {
  const state = await setup(page);
  await signIn(page);
  state.healthFail = true;
  await refresh(page).click();
  await expect(card(page).getByTestId('money-loan-risk')).toContainText('Loan risk unavailable');
  await expect(card(page).getByTestId('money-loan-risk')).toContainText('No usable individual ratio');
  await expect(card(page).getByTestId('money-loan-risk')).not.toContainText('50.13%');
  state.healthFail = false;
  state.health.loans = state.health.loans.filter((x) => x.loanId !== ids[0]);
  await card(page).getByRole('button', { name: 'Refresh loan risk', exact: true }).click();
  await expect(card(page).getByTestId('money-loan-risk')).toContainText('Loan risk unavailable');
  await expect(card(page).getByTestId('money-loan-risk')).not.toContainText('60.13%');
  state.health.loans.push({ loanId: ids[0], debtValue: '5000', collateralValue: '10000', ltvBps: 5000 });
  state.health.portfolioLtvBps = Number.MAX_SAFE_INTEGER;
  await refresh(page).click();
  await expect(card(page).getByTestId('money-loan-risk')).toContainText('50%');
  await expect(page.getByTestId('money-risk')).toContainText('Unbounded or capped LTV');
  await expect(page.getByTestId('money-risk')).not.toContainText('LTV LTV');
  expect(state.writes).toEqual([]);
});

for (const ratio of [-1, Number.MAX_SAFE_INTEGER + 1]) {
  test('malformed portfolio ratio ' + ratio + ' is refused instead of rendering a percentage', async ({ page }) => {
    const state = await setup(page);
    state.health.portfolioLtvBps = ratio;
    await signIn(page);
    await expect(page.getByTestId('money-risk')).toHaveCount(0);
    await expect(page.getByText('The service response could not be verified.', { exact: true }).first()).toBeVisible();
    expect(state.writes).toEqual([]);
  });
}

for (const index of [2, 3]) {
  test('mounted service still admits collateral top-up for ' + statuses[index], async ({ page }) => {
    const state = await setup(page);
    await signIn(page);
    await review(page, 'Add collateral', index);
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      procedure: 'loans.addCollateral',
      body: { loanId: ids[index], amount: '0.000000000000000001' },
    });
  });
}

test('excess release rejects known collateral overflow before review and accepts liquidating owner context', async ({ page }) => {
  const state = await setup(page);
  await signIn(page);
  await card(page, 3).getByRole('button', { name: 'Release excess', exact: true }).click();
  await page.getByLabel('Amount (BTC)', { exact: true }).fill('0.3');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('can’t be more than the collateral held for this loan');
  expect(state.writes).toEqual([]);
  expect(await journal(page)).toEqual([]);
  await page.getByLabel('Amount (BTC)', { exact: true }).fill('0.1');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  expect(state.writes).toEqual([
    { procedure: 'loans.releaseExcess', body: { loanId: ids[3], eventId: expect.stringMatching(/^[0-9a-f-]{36}$/), amount: '0.1' } },
  ]);
});

test('excess release review shows what the service would release now and holds Confirm above it', async ({ page }) => {
  const state = await setup(page);
  state.releasable = '0.05';
  await signIn(page);
  await review(page, 'Release excess', 0, '0.1');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('review-terms-row')).toContainText('Most you can release now0.05 BTC');
  await expect(dialog.getByTestId('review-terms-blocked')).toContainText('Release 0.05 BTC or less.');
  await expect(dialog.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  state.releasable = '0';
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Amount (BTC)', { exact: true }).fill('0.05');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(dialog.getByTestId('review-terms-blocked')).toContainText('would release no collateral');
  expect(state.writes).toEqual([]);
  expect(await journal(page)).toEqual([]);
});

test('a repayment whose reply was lost is sent again under the same reference, and the guard clears on its answer', async ({ page }) => {
  const state = await setup(page);
  state.dropReplies = 1;
  await signIn(page);
  await review(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toContainText('This request may have completed');
  expect(await journal(page)).toHaveLength(1);
  await expect(page.locator('#bank-unconfirmed')).toBeVisible();
  await dialog.getByRole('button', { name: 'Send the same request again', exact: true }).click();
  await expect(dialog).toContainText('Confirmed by the service');
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  expect(await journal(page)).toEqual([]);
  await expect(page.locator('#bank-unconfirmed')).toHaveCount(0);
});

test('a second send whose reply is lost again, or that the service refuses, leaves the original guarded and sendable', async ({ page }) => {
  const state = await setup(page);
  state.dropReplies = 2;
  await signIn(page);
  await review(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toContainText('This request may have completed');
  const again = dialog.getByRole('button', { name: 'Send the same request again', exact: true });
  await again.click();
  await expect(dialog).toContainText('This request may have completed');
  await expect(again).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(await journal(page)).toHaveLength(1);
  // A refusal on a second send cannot prove the first did nothing: still unknown, still journaled, still sendable.
  state.uncertain = true;
  await again.click();
  await expect(dialog).toContainText('This request may have completed');
  await expect(again).toBeVisible();
  expect(state.writes).toHaveLength(3);
  expect(new Set(state.writes.map((w) => JSON.stringify(w))).size).toBe(1);
  expect(await journal(page)).toHaveLength(1);
  await expect(page.locator('#bank-unconfirmed')).toBeVisible();
});

test('a second send while another tab holds the bank write lock sends nothing and stays unknown', async ({ page }) => {
  const state = await setup(page);
  state.dropReplies = 1;
  await signIn(page);
  await review(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toContainText('This request may have completed');
  await page.evaluate((id) => {
    void navigator.locks.request('bank-write:' + id, () => new Promise(() => {}));
  }, userId);
  await dialog.getByRole('button', { name: 'Send the same request again', exact: true }).click();
  await expect(dialog).toContainText('Another tab has a Bank request running');
  await expect(dialog).toContainText('This request may have completed');
  await expect(dialog.getByRole('button', { name: 'Send the same request again', exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(await journal(page)).toHaveLength(1);
});

test('the release review names the service refusal when it gives no figure', async ({ page }) => {
  const state = await setup(page);
  state.releasable = null;
  await signIn(page);
  await review(page, 'Release excess', 0, '0.1');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('review-terms-blocked')).toContainText('Reference: bank.mark_missing');
  await expect(dialog.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  expect(state.writes).toEqual([]);
});

test('an unknown release offers no second send: only a request the service answers by its reference may go again', async ({ page }) => {
  const state = await setup(page);
  state.uncertain = true;
  await signIn(page);
  await review(page, 'Release excess', 0, '0.1');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('This request may have completed');
  await expect(page.getByRole('button', { name: 'Send the same request again', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});

test('settled collateral close uses zero-debt admission and blocks changed current debt', async ({ page }) => {
  const state = await setup(page);
  await signIn(page);
  await review(page, 'Close settled loan', 4);
  state.rows[4].outstandingInterest = '0.01';
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('No request was sent.');
  expect(state.writes).toEqual([]);
  expect(await journal(page)).toEqual([]);
});

test('unknown collateral release preserves original loan guard through matching, empty and failed reads', async ({ page }) => {
  const state = await setup(page);
  state.uncertain = true;
  await signIn(page);
  await review(page, 'Release excess', 0, '0.1');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('This request may have completed');
  const pending = await journal(page);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ procedure: 'loans.releaseExcess', recordRefs: { loanId: ids[0] } });
  expect(pending[0]).not.toHaveProperty('amount');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await refresh(page).click();
  await expect(card(page)).toBeVisible();
  await card(page).getByRole('button', { name: 'Repay', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  state.rows = [];
  await refresh(page).click();
  await expect(page.getByTestId('money-loan-record')).toHaveCount(0);
  state.listFail = true;
  await refresh(page).click();
  await expect(page.locator('#bank-unconfirmed')).toContainText(ids[0]);
  expect(await journal(page)).toEqual(pending);
  expect(state.writes).toHaveLength(1);
  await page.screenshot({ path: evidence + '/loan-unknown-release.png', fullPage: true });
});
