import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
const evidence = process.env.M3_EVIDENCE || '/tmp/intafaced-repeat-buy-browser';
mkdirSync(evidence, { recursive: true });
const userId = '11111111-1111-4111-8111-111111111111',
  ruleId = '33333333-3333-4333-8333-333333333333';
const session = { userId, accessToken: 'isolated-identity-test', refreshToken: 'isolated-refresh-test', expiresAt: '2027-10-09T00:00:00Z' };
const rule = {
  id: ruleId,
  kind: 'dca',
  assetId: 'USDC',
  buyAssetId: 'BTC',
  amount: '25',
  threshold: null,
  targetPoolId: null,
  cadence: 'weekly',
  nextRunAt: '2026-10-16T09:00:00Z',
  status: 'active',
  createdAt: '2026-10-09T00:00:00Z',
};
const paused = {
  ...rule,
  id: '44444444-4444-4444-8444-444444444444',
  amount: '10',
  cadence: 'monthly',
  status: 'paused',
  nextRunAt: '2026-10-05T09:00:00Z',
};
const baseBalances = {
  BTC: { free: '0.2', used: '0', total: '0.2' },
  USDC: { free: '0', used: '0', total: '0' },
  USDT: { free: '100', used: '0', total: '100' },
};
const response = (route, data) => route.fulfill({ json: { result: { data } } });
const readFailed = (route) => route.fulfill({ status: 503, json: { error: 'Unavailable', message: 'Read unavailable.' } });
async function setup(page) {
  const state = {
    policy: { enabled: true, convertWired: true, dcaRequiresConvert: true, inventsRates: false },
    balances: baseBalances,
    rows: [
      rule,
      paused,
      { ...rule, id: '55555555-5555-4555-8555-555555555555', assetId: 'BTC', buyAssetId: 'ETH' },
      {
        ...rule,
        id: '66666666-6666-4666-8666-666666666666',
        kind: 'threshold_sweep',
        assetId: 'BTC',
        buyAssetId: null,
        threshold: '0.1',
        amount: null,
        cadence: null,
      },
    ],
    writes: [],
    privateReads: [],
    policyFail: false,
    balanceFail: false,
    listFail: false,
    uncertain: false,
  };
  await page.route('**/api/**', readFailed);
  await page.route('**/api/identity/trpc/auth.login', (r) => response(r, session));
  await page.route('**/api/identity/trpc/webauthn.list?*', (r) => response(r, []));
  await page.route('**/api/v1/markets*', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/v1/account/balance*', (r) => {
    state.privateReads.push('balances');
    return state.balanceFail
      ? readFailed(r)
      : r.fulfill({ json: { timestamp: 1791504000000, datetime: '2026-10-09T00:00:00Z', balances: state.balances } });
  });
  await page.route('**/api/bank/trpc/autoInvest.policy', (r) => {
    state.privateReads.push('policy');
    return state.policyFail ? readFailed(r) : response(r, state.policy);
  });
  await page.route('**/api/bank/trpc/autoInvest.list?*', (r) => {
    state.privateReads.push('list');
    return state.listFail
      ? readFailed(r)
      : response(r, state.rows.slice(0, JSON.parse(new URL(r.request().url()).searchParams.get('input')).limit));
  });
  await page.route('**/api/bank/trpc/autoInvest.*', async (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const body = r.request().postDataJSON(),
      procedure = new URL(r.request().url()).pathname.split('/').pop();
    state.writes.push({ procedure, body });
    if (state.uncertain) return r.fulfill({ status: 503, json: { error: 'Unavailable', message: 'Original outcome unavailable.' } });
    if (procedure === 'autoInvest.createDca')
      return response(r, {
        ...rule,
        assetId: body.spendAssetId,
        buyAssetId: body.buyAssetId,
        amount: body.amount,
        cadence: body.cadence,
        id: ruleId,
        nextRunAt: body.startsAt,
      });
    const found = state.rows.find((x) => x.id === body.ruleId);
    return response(
      r,
      procedure === 'autoInvest.cancel' ? { ok: true } : { ...found, status: procedure === 'autoInvest.pause' ? 'paused' : 'active' },
    );
  });
  return state;
}
async function signIn(page, path = '/portfolio/BTC/repeat-buy') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.getByLabel('Email or handle', { exact: true }).fill('integration@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
}
async function review(page, amount = '0.000000000000000001') {
  await page.getByLabel('Spend from main account', { exact: true }).selectOption('USDC');
  await page.getByRole('button', { name: 'Set up repeat buy', exact: true }).click();
  await page.getByLabel('Spending budget (USDC)', { exact: true }).fill(amount);
  await page.getByLabel('Cadence', { exact: true }).selectOption('weekly');
  await page.getByLabel('First run', { exact: true }).fill('2027-01-16T09:00');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
}
async function journal(page) {
  return JSON.parse((await page.evaluate((id) => localStorage.getItem('intafaced.customer.bank-unconfirmed.v1:' + id), userId)) || '[]');
}
test('actual App offers verified main assets and buy-only rules with phone focus and exact review/dispatch', async ({ page }) => {
  const state = await setup(page),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  const select = page.getByLabel('Spend from main account', { exact: true });
  await expect(select.locator('option')).toHaveText(['Choose a spending asset', 'USDC', 'USDT']);
  await expect(page.getByTestId('money-repeat-rule')).toHaveCount(2);
  await expect(page.getByText('2 matching instructions in 4 returned Bank automation records.')).toBeVisible();
  await expect(page.getByTestId('money-repeat-lanes')).not.toContainText('ETH');
  await select.selectOption('USDC');
  await expect(page.getByText('0 USDC available now', { exact: true })).toBeVisible();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await select.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Set up repeat buy', exact: true })).toBeFocused();
    const fit = await page.getByRole('button', { name: 'Set up repeat buy', exact: true }).evaluate((el) => {
      const r = el.getBoundingClientRect(),
        bar = document.querySelector('[data-testid="mobile-doors"]')?.getBoundingClientRect();
      return { hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)), bottom: r.bottom, barTop: bar?.top };
    });
    expect(fit.hit).toBe(true);
    if (width <= 1000) expect(fit.bottom).toBeLessThanOrEqual(fit.barTop);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const a = await new AxeBuilder({ page }).include('[data-testid="money-repeat-lanes"]').analyze();
    expect(a.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);
    await page.evaluate(() => {
      document.activeElement?.blur();
      scrollTo(0, 0);
    });
    await page.screenshot({ path: evidence + '/repeat-' + width + '.png', fullPage: true });
  }
  await review(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('0.000000000000000001');
  await expect(dialog).toContainText('Main account · USDC');
  await expect(dialog).toContainText('Spending budget (USDC)');
  await page.screenshot({ path: evidence + '/review-phone.png' });
  await page.getByRole('button', { name: 'Create instruction', exact: true }).click();
  await expect(dialog).toContainText('Confirmed by the service');
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toEqual({
    procedure: 'autoInvest.createDca',
    body: {
      spendAssetId: 'USDC',
      buyAssetId: 'BTC',
      amount: '0.000000000000000001',
      cadence: 'weekly',
      startsAt: '2027-01-16T09:00:00.000Z',
    },
  });
  expect(await journal(page)).toEqual([]);
  expect(errors).toEqual([]);
});
for (const scenario of ['policy changed', 'source removed', 'source read failed', 'policy read failed']) {
  test('current review prevents dispatch and journaling when ' + scenario, async ({ page }) => {
    const state = await setup(page);
    await signIn(page);
    await review(page);
    if (scenario === 'policy changed') state.policy.enabled = false;
    if (scenario === 'source removed') state.balances = { BTC: baseBalances.BTC };
    if (scenario === 'source read failed') state.balanceFail = true;
    if (scenario === 'policy read failed') state.policyFail = true;
    await page.getByRole('button', { name: 'Create instruction', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('No request was sent.');
    expect(state.writes).toEqual([]);
    expect(await journal(page)).toEqual([]);
  });
}
test('lifecycle review includes exact original rule context and rejects changed owner read', async ({ page }) => {
  const state = await setup(page);
  await signIn(page);
  await page.getByTestId('money-repeat-rule').first().getByRole('button', { name: 'Pause', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(ruleId);
  await expect(dialog).toContainText('25 USDC');
  await expect(dialog).toContainText('Cadence');
  await expect(dialog).toContainText('weekly');
  await expect(dialog).toContainText('Main account · USDC');
  state.rows = state.rows.map((x) => (x.id === ruleId ? { ...x, status: 'paused' } : x));
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toContainText('No request was sent.');
  expect(state.writes).toEqual([]);
  expect(await journal(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const rules = page.locator('[data-testid="money-repeat-lanes"] > section').last();
  await rules.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByTestId('money-repeat-rule').last().getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('eligible on a later runner check');
  state.policy.convertWired = false;
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('No request was sent.');
  expect(state.writes).toEqual([]);
});
test('unknown create survives failed and matching rule reads without another write', async ({ page }) => {
  const state = await setup(page);
  state.uncertain = true;
  await signIn(page);
  await review(page, '25');
  await page.getByRole('button', { name: 'Create instruction', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('This request may have completed');
  const pending = await journal(page);
  expect(pending).toHaveLength(1);
  expect(pending[0].procedure).toBe('autoInvest.createDca');
  expect(pending[0]).not.toHaveProperty('amount');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  state.listFail = true;
  await page.locator('[data-testid="money-repeat-lanes"] > section').last().getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#bank-unconfirmed')).toContainText(pending[0].reference);
  state.listFail = false;
  state.rows = [rule];
  await page.locator('[data-testid="money-repeat-lanes"] > section').last().getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByTestId('money-repeat-rule')).toHaveCount(1);
  await page.getByLabel('Spend from main account', { exact: true }).selectOption('USDC');
  await page.getByRole('button', { name: 'Set up repeat buy', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await journal(page)).toEqual(pending);
  expect(state.writes).toHaveLength(1);
  await page.screenshot({ path: evidence + '/unknown-create.png', fullPage: true });
});
test('failed setup source still permits stopping a returned owned instruction', async ({ page }) => {
  const state = await setup(page);
  state.balanceFail = true;
  await signIn(page);
  await expect(page.locator('[data-testid="money-repeat-lanes"] > section').first().getByTestId('failure')).toBeVisible();
  await page.getByTestId('money-repeat-rule').first().getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  expect(state.writes).toEqual([{ procedure: 'autoInvest.pause', body: { ruleId } }]);
});
test('invalid asset refuses before private Repeat buy reads', async ({ page }) => {
  const state = await setup(page);
  await signIn(page, '/portfolio/INVALIDASSETCODE17/repeat-buy');
  await expect(page.getByRole('heading', { name: 'Repeat buy context unavailable', exact: true }).first()).toBeVisible();
  expect(state.privateReads).toEqual([]);
  expect(state.writes).toEqual([]);
});

test('first run expiring during successful current reads refuses before dispatch', async ({ page }) => {
  const state = await setup(page);
  await signIn(page);
  await review(page);
  let held;
  await page.route('**/api/v1/account/balance*', (route) => {
    held = route;
  });
  await page.getByRole('button', { name: 'Create instruction', exact: true }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.clock.setFixedTime(new Date('2027-01-16T09:00:01Z'));
  await held.fulfill({ json: { timestamp: 1791504000000, datetime: '2026-10-09T00:00:00Z', balances: baseBalances } });
  await expect(page.getByRole('dialog')).toContainText('first run must still be in the future');
  expect(state.writes).toEqual([]);
  expect(await journal(page)).toEqual([]);
});
