import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
const dir = process.env.EARN_EVIDENCE || '/tmp/intafaced-earn-browser';
mkdirSync(dir, { recursive: true });
const userId = '11111111-1111-4111-8111-111111111111',
  poolId = '22222222-2222-4222-8222-222222222222',
  positionId = '33333333-3333-4333-8333-333333333333';
const session = { userId, accessToken: 'isolated-identity-test', refreshToken: 'isolated-refresh-test', expiresAt: '2027-10-09T00:00:00Z' };
const pool = {
  id: poolId,
  assetId: 'USDC',
  kind: 'flexible',
  name: 'USDC flexible',
  aprBps: 350,
  termDays: null,
  minDeposit: '10',
  payoutEvery: 'day',
  compounding: 'simple',
  rewardAssetId: 'USDC',
  yieldSource: 'pool_reserve',
  rateBands: null,
  commissionBps: null,
  capacity: null,
  unbondingDays: null,
};
const position = {
  id: positionId,
  poolId,
  assetId: 'USDC',
  principal: '0.000000000000000001',
  openedAt: '2026-01-01T09:00:00Z',
  maturesAt: null,
  rateAtOpenBps: 350,
  accruesFrom: '2026-01-02T00:00:00.000Z',
  accrual: 'accruing',
  autoRenew: false,
  renewals: 0,
  nextPayoutOn: '2026-01-03',
  unbondsAt: null,
  unbondingDays: null,
};
const reply = (r, data) => r.fulfill({ json: { result: { data } } }),
  failed = (r) => r.fulfill({ status: 503, json: { error: 'Unavailable', message: 'Current read failed.' } });
async function setup(page, options = {}) {
  const state = {
    pools: [pool],
    positions: [
      { ...position, id: '44444444-4444-4444-8444-444444444444', principal: '350', maturesAt: '2030-01-16T09:00:00Z' },
      position,
      { ...position, id: '55555555-5555-4555-8555-555555555555', maturesAt: '1' },
    ],
    writes: [],
    positionFail: false,
    poolFail: false,
    policyEnabled: true,
    uncertain: false,
    withdrawResponse: null,
    positionGate: null,
    positionReads: 0,
    poolUnauthorized: false,
  };
  await page.route('**/api/**', failed);
  await page.route('**/api/identity/trpc/auth.login', (r) => reply(r, session));
  await page.route('**/api/identity/trpc/webauthn.list?*', (r) => reply(r, []));
  await page.route('**/api/v1/markets*', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/bank/trpc/earn.pools?*', async (r) => {
    if (options.poolGate) await options.poolGate;
    if (state.poolUnauthorized) return r.fulfill({ status: 401, json: { error: 'unauthorized' } });
    return state.poolFail ? failed(r) : reply(r, state.pools);
  });
  await page.route('**/api/bank/trpc/earn.positions?*', async (r) => {
    state.positionReads++;
    if (state.positionGate) await state.positionGate;
    return state.positionFail ? failed(r) : reply(r, state.positions);
  });
  await page.route('**/api/bank/trpc/autoInvest.list?*', (r) => reply(r, []));
  await page.route('**/api/bank/trpc/autoInvest.policy', (r) =>
    reply(r, { enabled: state.policyEnabled, convertWired: false, dcaRequiresConvert: true, inventsRates: false }),
  );
  await page.route('**/api/bank/trpc/*', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const body = r.request().postDataJSON(),
      proc = new URL(r.request().url()).pathname.split('/').pop();
    state.writes.push({ proc, body });
    if (state.uncertain) return r.fulfill({ status: 503, json: { error: 'Unavailable', message: 'Original outcome unavailable.' } });
    if (proc === 'earn.withdraw')
      return reply(
        r,
        state.withdrawResponse || { positionId: body.positionId, principal: position.principal, status: 'closed', unbondsAt: null },
      );
    if (proc === 'earn.deposit') return reply(r, { positionId: body.positionId, maturesAt: null });
    return reply(r, {
      id: positionId,
      kind: 'threshold_sweep',
      assetId: 'USDC',
      threshold: body.threshold,
      targetPoolId: poolId,
      buyAssetId: null,
      amount: null,
      cadence: null,
      nextRunAt: null,
      status: 'active',
      createdAt: '2026-10-09T00:00:00Z',
    });
  });
  await page.goto('/login?redirect=%2Fbank%2Fearn');
  await page.getByLabel('Email or handle', { exact: true }).fill('integration@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/bank\/earn$/);
  return state;
}
async function journal(page) {
  return JSON.parse((await page.evaluate((id) => localStorage.getItem('intafaced.customer.bank-unconfirmed.v1:' + id), userId)) || '[]');
}
for (const mismatch of ['position', 'principal'])
  test('withdrawal ' + mismatch + ' mismatch preserves the original unknown journal', async ({ page }) => {
    const state = await setup(page);
    state.withdrawResponse = {
      positionId: mismatch === 'position' ? poolId : positionId,
      principal: mismatch === 'principal' ? '999' : position.principal,
      status: 'closed',
      unbondsAt: null,
    };
    await page.getByRole('button', { name: 'Review withdrawal', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('This request may have completed');
    await expect(page.getByRole('dialog')).not.toContainText('Confirmed by the service');
    const pending = await journal(page);
    expect(pending).toHaveLength(1);
    expect(pending[0].recordRefs.positionId).toBe(positionId);
    expect(state.writes).toHaveLength(1);
  });
test('session loss during delayed withdrawal preflight creates no old-owner journal or POST', async ({ page }) => {
  let releasePool, releasePosition;
  const poolGate = new Promise((resolve) => {
    releasePool = resolve;
  });
  const positionGate = new Promise((resolve) => {
    releasePosition = resolve;
  });
  const state = await setup(page, { poolGate });
  await page.getByRole('button', { name: 'Review withdrawal', exact: true }).click();
  state.positionGate = positionGate;
  const before = state.positionReads;
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => state.positionReads).toBeGreaterThan(before);
  state.poolUnauthorized = true;
  releasePool();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  releasePosition();
  await expect.poll(async () => (await journal(page)).length).toBe(0);
  expect(state.writes).toEqual([]);
});
test('Earn puts owned principal first and suppresses known locked or unknown maturity withdrawals at four widths', async ({ page }) => {
  const state = await setup(page),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const sections = page.locator('.money-earn-lanes > section'),
    rows = sections.first().locator('.money-record');
  await expect(sections.locator('h2')).toHaveText(['Your positions', 'Available pools']);
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('cannot be withdrawn before maturity');
  await expect(rows.first().getByRole('button')).toHaveCount(0);
  await expect(rows.last()).toContainText('Maturity is unavailable');
  await expect(rows.last().getByRole('button')).toHaveCount(0);
  const review = page.getByRole('button', { name: 'Review withdrawal', exact: true });
  await expect(review).toHaveCount(1);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await sections.first().getByRole('button', { name: 'Refresh', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(review).toBeFocused();
    const r = await review.evaluate((el) => {
      const box = el.getBoundingClientRect(),
        nav = document.querySelector('.mobile-doors')?.getBoundingClientRect();
      return {
        hit: el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
        bottom: box.bottom,
        navTop: nav?.top,
      };
    });
    expect(r.hit).toBe(true);
    if (width <= 1000) expect(r.bottom).toBeLessThanOrEqual(r.navTop);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const a = await new AxeBuilder({ page }).include('.money-earn-lanes').analyze();
    expect(a.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);
    await page.evaluate(() => {
      document.activeElement?.blur();
      scrollTo(0, 0);
    });
    await page.screenshot({ path: dir + '/earn-' + width + '.png', fullPage: true });
  }
  await review.click();
  await expect(page.getByRole('dialog')).toContainText(positionId);
  await expect(page.getByRole('dialog')).toContainText('0.000000000000000001 USDC');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  expect(state.writes).toEqual([{ proc: 'earn.withdraw', body: { positionId } }]);
  expect(await journal(page)).toEqual([]);
  expect(errors).toEqual([]);
});
for (const mode of ['failed', 'removed', 'new lock']) {
  test('fresh owned position ' + mode + ' refuses before withdrawal dispatch', async ({ page }) => {
    const state = await setup(page);
    await page.getByRole('button', { name: 'Review withdrawal', exact: true }).click();
    if (mode === 'failed') state.positionFail = true;
    if (mode === 'removed') state.positions = [];
    if (mode === 'new lock')
      state.positions = state.positions.map((r) => (r.id === positionId ? { ...r, maturesAt: '2030-01-16T09:00:00Z' } : r));
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('No request was sent.');
    expect(state.writes).toEqual([]);
    expect(await journal(page)).toEqual([]);
  });
}
test('threshold setup refuses zero before review and sends only exact positive native-unit instruction', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Threshold sweep', exact: true }).click();
  const field = page.getByLabel('Keep available (USDC)', { exact: true });
  await field.fill('0');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(state.writes).toEqual([]);
  expect(await journal(page)).toEqual([]);
  await field.fill('0.000000000000000001');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Keep available (USDC)');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmed by the service');
  expect(state.writes).toEqual([
    { proc: 'autoInvest.createThresholdSweep', body: { assetId: 'USDC', targetPoolId: poolId, threshold: '0.000000000000000001' } },
  ]);
});
test('changed pool terms and disabled automation refuse current review without sending', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Deposit', exact: true }).click();
  await page.getByLabel('Amount (USDC)', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  state.pools = [{ ...pool, aprBps: 400 }];
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('No request was sent.');
  expect(state.writes).toEqual([]);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.money-earn-lanes > section').last().getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Threshold sweep', exact: true }).click();
  await page.getByLabel('Keep available (USDC)', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  state.policyEnabled = false;
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('No request was sent.');
  expect(state.writes).toEqual([]);
  expect(await journal(page)).toEqual([]);
});
test('unknown withdrawal is not resolved or replayed by empty active position read', async ({ page }) => {
  const state = await setup(page);
  state.uncertain = true;
  await page.getByRole('button', { name: 'Review withdrawal', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('This request may have completed');
  const pending = await journal(page);
  expect(pending).toHaveLength(1);
  expect(pending[0].recordRefs.positionId).toBe(positionId);
  state.positions = [];
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.money-earn-lanes > section').first().getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('No active earn positions returned', { exact: true })).toBeVisible();
  await expect(page.locator('#bank-unconfirmed')).toContainText(pending[0].reference);
  expect(await journal(page)).toEqual(pending);
  expect(state.writes).toHaveLength(1);
});
