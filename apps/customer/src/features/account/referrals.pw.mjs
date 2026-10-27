import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Examples remain in isolated network tests against the real App and native login.
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const parent = '33333333-3333-4333-8333-333333333333';
const at = '2026-10-09T01:20:00Z';
const row = (extra = {}) => ({
  feeEventId: 'fee.example.original/001',
  beneficiaryId: owner,
  payerId: other,
  hop: 0,
  rate: '0.0007',
  feeAmount: '0.00000000000001',
  commissionAmount: '0.000000000000000007',
  asset: 'BTC',
  accruedAt: at,
  sourceModule: 'pay',
  ...extra,
});
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
const refuse = (route) =>
  route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Referral source unavailable', data: { code: 'referral.unavailable' } } }),
  });
async function network(page, handlers = {}, identity = () => owner) {
  const reads = [],
    writes = [],
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      procedure = url.pathname.split('/').at(-1);
    const input =
      route.request().method() === 'POST' ? route.request().postDataJSON() : JSON.parse(url.searchParams.get('input') ?? 'null');
    (route.request().method() === 'POST' ? writes : reads).push({ procedure, input });
    if (handlers[procedure]) return handlers[procedure](route, input);
    if (procedure === 'auth.login')
      return reply(route, {
        userId: identity(),
        accessToken: 'referral-isolated-token-' + identity(),
        refreshToken: 'referral-isolated-refresh-' + identity(),
        expiresAt: '2027-10-09T01:20:00Z',
      });
    if (procedure === 'auth.logout') return reply(route, { ok: true });
    if (procedure === 'affiliates.myReferrer') return reply(route, { userId: identity(), referrerId: parent, attributedAt: at });
    if (procedure === 'affiliates.myAncestors') return reply(route, [parent, other]);
    if (procedure === 'affiliates.myAccruals')
      return reply(route, {
        rows: [
          row({ beneficiaryId: identity() }),
          row({
            beneficiaryId: identity(),
            feeEventId: 'fee.example.002',
            commissionAmount: '12.34567890123456789',
            feeAmount: '123.4567890123456789',
            asset: 'USDC',
            rate: '0.1',
            hop: 1,
            sourceModule: 'trade',
          }),
        ],
      });
    return reply(route, []);
  });
  return { reads, writes, errors };
}
async function signIn(page) {
  await page.goto('/login?redirect=%2Fuc%2Fpromotion');
  await page.getByLabel('Email or handle', { exact: true }).fill('referral-review');
  await page.getByLabel('Password', { exact: true }).fill('isolated-review-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/uc\/promotion$/);
  await expect(page.getByRole('heading', { name: 'Promotions and invitations', exact: true })).toBeVisible();
}
const accruals = (page) => page.getByRole('region', { name: 'Commission accrual records', exact: true });
const selected = (page) => page.getByRole('region', { name: 'Selected accrual', exact: true });
const details = (page) => page.getByRole('region', { name: 'Accrual details', exact: true });

test('native App reads owned links, ordered ancestors and exact native-asset accrual details without financial writes', async ({
  page,
}) => {
  const calls = await network(page);
  await signIn(page);
  await expect(page.getByRole('region', { name: 'Your recorded referrer' })).toContainText(parent);
  await page.getByRole('button', { name: 'Show referral chain · 2 records' }).click();
  await expect(page.getByTestId('referral-chain').locator('li')).toHaveText([parent, other]);
  await expect(accruals(page)).toContainText('0.000000000000000007 BTC');
  await expect(accruals(page)).toContainText('12.34567890123456789 USDC');
  await accruals(page).getByRole('button', { name: 'Inspect accrual' }).first().click();
  await expect(selected(page)).toContainText('fee.example.original/001');
  await expect(details(page)).toContainText('0.00000000000001 BTC');
  await expect(details(page)).toContainText('0.07%');
  await expect(details(page)).toContainText(owner);
  await expect(details(page)).toContainText(other);
  await expect(accruals(page)).toContainText('do not confirm a balance or payout');
  // Development StrictMode may repeat an aborted initial read.
  expect([
    ...new Map(
      calls.reads
        .filter((r) => r.procedure.startsWith('affiliates.'))
        .map((r) => [JSON.stringify([r.procedure, r.input]), [r.procedure, r.input]]),
    ).values(),
  ]).toEqual([
    ['affiliates.myReferrer', null],
    ['affiliates.myAncestors', null],
    ['affiliates.myAccruals', { limit: 50 }],
  ]);
  expect(calls.writes.filter((r) => r.procedure !== 'auth.login')).toEqual([]);
  expect(calls.errors).toEqual([]);
});

test('bounded newest reads expand only through500 and retain selected original after its window disappears', async ({ page }) => {
  const calls = await network(page, {
    'affiliates.myAccruals': (route, input) =>
      reply(route, {
        rows: Array.from({ length: input.limit }, (_, index) => row({ feeEventId: 'fee.window.' + input.limit + '.' + index })),
      }),
  });
  await signIn(page);
  await accruals(page).getByRole('button', { name: 'Inspect accrual' }).first().click();
  for (const limit of [100, 200, 400, 500]) {
    await page.getByRole('button', { name: 'Read newest ' + limit, exact: true }).click();
    await expect(page.getByRole('article')).toHaveCount(limit);
    await expect(selected(page)).toContainText('fee.window.50.0');
    await expect(details(page)).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: /^Read newest / })).toHaveCount(0);
  await expect(accruals(page)).toContainText('500 shown · latest 500');
  await page.getByRole('button', { name: 'Return to newest 50' }).click();
  await expect(details(page)).toContainText('0.07%');
  expect(
    calls.reads
      .filter((r) => r.procedure === 'affiliates.myAccruals')
      .map((r) => r.input.limit)
      .filter((value, index, all) => index === 0 || value !== all[index - 1]),
  ).toEqual([50, 100, 200, 400, 500, 50]);
});

test('selected event survives loading, failed, empty and restored reads while stale quantities disappear', async ({ page }) => {
  let state = 'ready',
    release;
  await network(page, {
    'affiliates.myAccruals': (route) =>
      state === 'loading'
        ? new Promise((resolve) => {
            release = () => reply(route, { rows: [row()] }).then(resolve);
          })
        : state === 'failed'
          ? refuse(route)
          : reply(route, { rows: state === 'empty' ? [] : [row()] }),
  });
  await signIn(page);
  await page.getByRole('button', { name: 'Inspect accrual' }).click();
  await expect(details(page)).toContainText('0.07%');
  state = 'loading';
  await page.getByRole('button', { name: 'Refresh records' }).click();
  await expect(selected(page)).toContainText('fee.example.original/001');
  await expect(details(page)).toHaveCount(0);
  await expect(page.getByText('0.000000000000000007 BTC', { exact: true })).toHaveCount(0);
  await expect.poll(() => Boolean(release)).toBe(true);
  await release();
  await expect(details(page)).toContainText('0.07%');
  for (state of ['failed', 'empty']) {
    await page.getByRole('button', { name: 'Refresh records' }).click();
    await expect(accruals(page)).toContainText(state === 'failed' ? 'Referral source unavailable' : 'No commission records yet');
    await expect(selected(page)).toContainText('fee.example.original/001');
    await expect(details(page)).toHaveCount(0);
  }
  state = 'ready';
  await page.getByRole('button', { name: 'Refresh records' }).click();
  await expect(details(page)).toContainText('0.07%');
});

test('foreign ownership, malformed decimals, duplicates and oversized windows refuse before disclosure', async ({ page }) => {
  let bad = { rows: [row({ beneficiaryId: other })] };
  const calls = await network(page, {
    'affiliates.myReferrer': (route) => reply(route, { userId: other, referrerId: parent, attributedAt: at }),
    'affiliates.myAncestors': (route) => reply(route, [parent, parent]),
    'affiliates.myAccruals': (route) => reply(route, bad),
  });
  await signIn(page);
  await expect(page.getByRole('region', { name: 'Your recorded referrer' })).toContainText('could not be verified');
  await expect(page.getByRole('region', { name: 'Referral chain', exact: true })).toContainText('could not be verified');
  const variants = [
    { rows: [row({ commissionAmount: 0.25 })] },
    { rows: [row({ feeAmount: '-1' })] },
    { rows: [row({ rate: '1.01' })] },
    { rows: [row({ commissionAmount: '0.0000000000000000001' })] },
    { rows: [row(), row()] },
    { rows: Array.from({ length: 51 }, (_, i) => row({ feeEventId: String(i) })) },
    { rows: [row({ asset: ' ' })] },
    { rows: [row({ accruedAt: 'today' })] },
  ];
  await expect(accruals(page)).toContainText('could not be verified');
  for (bad of variants) {
    await accruals(page).getByRole('button', { name: 'Try again' }).click();
    await expect(accruals(page)).toContainText('could not be verified');
    await expect(page.getByRole('article')).toHaveCount(0);
  }
  expect(calls.writes.filter((r) => r.procedure.startsWith('affiliates.'))).toEqual([]);
});

test('empty projections and independent failure recovery never imply a complete tree or payout', async ({ page }) => {
  let failed = true;
  await network(page, {
    'affiliates.myReferrer': (route) => reply(route, null),
    'affiliates.myAncestors': (route) => reply(route, []),
    'affiliates.myAccruals': (route) => (failed ? refuse(route) : reply(route, { rows: [] })),
  });
  await signIn(page);
  await expect(page.getByText('No referrer on record', { exact: true })).toBeVisible();
  await expect(page.getByText('No one above your referrer', { exact: true })).toBeVisible();
  await expect(accruals(page)).toContainText('Referral source unavailable');
  failed = false;
  await accruals(page).getByRole('button', { name: 'Try again' }).click();
  await expect(accruals(page)).toContainText('No commission records yet');
  await expect(accruals(page)).toContainText('does not establish a complete history');
  await expect(page.getByRole('button', { name: /^Read newest / })).toHaveCount(0);
});

test('native device preference hides both fee and commission quantities while preserving native asset and rate', async ({ page }) => {
  const calls = await network(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Open person menu' }).click();
  await page.getByRole('dialog', { name: 'Your account' }).getByRole('link', { name: 'View and language', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Hide balance values', exact: true }).check();
  await page.getByRole('button', { name: 'Open person menu' }).click();
  await page.getByRole('dialog', { name: 'Your account' }).getByRole('link', { name: 'Promotions', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect accrual' }).first().click();
  await expect(accruals(page)).not.toContainText('0.000000000000000007');
  await expect(accruals(page)).not.toContainText('12.34567890123456789');
  await expect(details(page)).not.toContainText('0.00000000000001');
  await expect(details(page)).toContainText('•••• BTC');
  await expect(details(page)).toContainText('0.07%');
  await expect(details(page)).toContainText('Amounts hidden by your device view preference');
  expect(calls.writes.filter((r) => r.procedure.startsWith('affiliates.'))).toEqual([]);
});

test('native sign-out and different actor suppress a pending previous owner read and reset inspection', async ({ page }) => {
  let actor = owner,
    delayed = false,
    release;
  const calls = await network(
    page,
    {
      'affiliates.myAccruals': (route) =>
        delayed && actor === owner
          ? new Promise((resolve) => {
              release = () => reply(route, { rows: [row({ feeEventId: 'old-private-only' })] }).then(resolve);
            })
          : reply(route, { rows: [row({ beneficiaryId: actor, feeEventId: actor === owner ? 'first-owner-event' : 'new-owner-event' })] }),
    },
    () => actor,
  );
  await signIn(page);
  await page.getByRole('button', { name: 'Inspect accrual' }).click();
  delayed = true;
  await page.getByRole('button', { name: 'Refresh records' }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole('button', { name: 'Open person menu' }).click();
  await page.getByRole('dialog', { name: 'Your account' }).getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Referral records', exact: true })).toHaveCount(0);
  actor = other;
  await expect(page.getByRole('dialog', { name: 'Your account' })).toHaveCount(0);
  await page.locator('#main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email or handle', { exact: true }).fill('second-owner');
  await page.getByLabel('Password', { exact: true }).fill('isolated-review-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('article', { name: 'new-owner-event · 0' })).toBeVisible();
  await release();
  await expect(page.getByRole('article', { name: 'old-private-only · 0' })).toHaveCount(0);
  await expect(selected(page)).toHaveCount(0);
  expect(calls.errors).toEqual([]);
});

test('invitation uncertain-write guard remains intact alongside read-only referral records', async ({ page }) => {
  const calls = await network(page, { 'affiliates.createShare': (route) => refuse(route) });
  await signIn(page);
  await page.getByRole('button', { name: 'Create invitation link', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create invitation link', exact: true })).toBeDisabled();
  await expect(accruals(page)).toContainText('0.000000000000000007 BTC');
  await page.getByRole('button', { name: 'Refresh records' }).click();
  await expect(page.getByRole('button', { name: 'Create invitation link', exact: true })).toBeDisabled();
  expect(calls.writes.filter((r) => r.procedure.startsWith('affiliates.'))).toEqual([{ procedure: 'affiliates.createShare', input: {} }]);
});

test('actual App covers five widths, focus,44px targets and accessibility', async ({ page }) => {
  const calls = await network(page);
  await signIn(page);
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(accruals(page)).toContainText('12.34567890123456789 USDC');
    const button = page.getByRole('button', { name: 'Refresh records', exact: true });
    await button.focus();
    await expect(button).toBeFocused();
    expect(await button.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.REFERRALS_ARTIFACT)
      await page.screenshot({ path: process.env.REFERRALS_ARTIFACT + '/app-referrals-' + width + '.png', fullPage: true });
  }
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);
  expect(calls.errors).toEqual([]);
});

test('ordinary signed-out App preserves private boundary without intercepted data or live writes', async ({ page }) => {
  const requests = [],
    errors = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) requests.push({ method: request.method(), url: request.url() });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/uc/promotion');
  await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Referral records', exact: true })).toHaveCount(0);
  expect(requests.filter((r) => r.method !== 'GET' || r.url.includes('/affiliates.'))).toEqual([]);
  expect(errors).toEqual([]);
  if (process.env.REFERRALS_ARTIFACT)
    await page.screenshot({ path: process.env.REFERRALS_ARTIFACT + '/app-referrals-ordinary-signed-out.png', fullPage: true });
});
