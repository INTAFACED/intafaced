import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('native View changes reach another open tab and malformed device settings preserve the last valid view', async ({ page, context }) => {
  const other = await context.newPage();
  await setup(page);
  await setup(other);
  await signIn(page, '/view');
  await signIn(other, '/view');
  const language = (p) => p.locator('select').filter({ has: p.locator('option[value="es"]') });
  const theme = (p) => p.locator('select').filter({ has: p.locator('option[value="light"]') });
  const origin = await page.evaluate(() => performance.timeOrigin);
  await theme(page).selectOption('light');
  await expect(page.getByText('Preferences saved on this device.', { exact: true })).toBeVisible();
  await language(other).selectOption('es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(language(page)).toHaveValue('es');
  await expect(theme(other)).toHaveValue('light');
  await expect(page.getByText('Preferencias guardadas en este dispositivo.', { exact: true })).toHaveCount(0);
  await other.getByRole('checkbox', { name: 'Ocultar los saldos', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Ocultar los saldos', exact: true })).toBeChecked();
  await language(other).selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(language(page)).toHaveValue('fr');
  await expect(page.getByText('Préférences enregistrées sur cet appareil.', { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    window.__viewRegressionEvents = 0;
    addEventListener('storage', (event) => {
      if (event.key === 'intafaced.customer.view.v1') window.__viewRegressionEvents++;
    });
  });
  for (const [index, value] of ['{broken', '{"language":"unsupported","hideBalances":false}'].entries()) {
    await other.evaluate((value) => localStorage.setItem('intafaced.customer.view.v1', value), value);
    await expect.poll(() => page.evaluate(() => window.__viewRegressionEvents)).toBe(index + 1);
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.getByRole('checkbox', { name: 'Masquer les soldes', exact: true })).toBeChecked();
  }
  await theme(other).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(language(page)).toHaveValue('fr');
  await other.evaluate(() => localStorage.removeItem('intafaced.customer.view.v1'));
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(language(page)).toHaveValue('en');
  await expect(page.getByRole('checkbox', { name: 'Hide balance values', exact: true })).not.toBeChecked();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
  await other.close();
});

// Isolated identity/network examples exercise the real App and sign-in form.
// No production sample mode, financial browser dataset, or fixture screenshots.
const userId = '11111111-1111-4111-8111-111111111111';
const foreignId = '22222222-2222-4222-8222-222222222222';
const invitationId = '33333333-3333-4333-8333-333333333333';
const session = { userId, accessToken: 'isolated-identity-test', refreshToken: 'isolated-refresh-test', expiresAt: '2027-10-08T00:00:00Z' };
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
const activityId = '44444444-4444-4444-8444-444444444444';
const activityRecord = {
  id: activityId,
  assetId: 'BTC',
  amount: '0.000000000000000001',
  kind: 'crypto',
  rail: 'isolated-rail',
  simulated: true,
  status: 'pending',
  createdAt: '2026-10-09T00:00:00Z',
  destinationRef: 'destination-' + 'a'.repeat(80),
  clientRef: 'original-client-reference',
  holdLedgerTxId: 'hold-original',
  settleLedgerTxId: null,
};
async function activityApi(page) {
  await setup(page);
  await page.route('**/api/bank/trpc/ramps.onramps?*', (route) =>
    reply(route, [
      { ...activityRecord, id: foreignId, assetId: 'USDT', amount: '9', railRef: 'other-asset', ledgerTxId: 'other-transaction' },
      { ...activityRecord, railRef: 'original-rail-reference', ledgerTxId: 'deposit-ledger-reference' },
    ]),
  );
  await page.route('**/api/bank/trpc/ramps.offramps?*', (route) => reply(route, [activityRecord]));
}
async function setup(page) {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unavailable', message: 'The service is offline.' }),
    }),
  );
  await page.route('**/api/identity/trpc/auth.login', (route) => reply(route, session));
  await page.route('**/api/identity/trpc/webauthn.list?*', (route) => reply(route, []));
  await page.route('**/api/v1/markets*', (route) => {
    if (new URL(route.request().url()).searchParams.get('limit') !== '500')
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'trade.markets_limit_unset' }) });
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });
}
async function signIn(page, destination) {
  await page.goto(`/login?redirect=${encodeURIComponent(destination)}`);
  await page.getByLabel('Email or handle', { exact: true }).fill('integration@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
}

test('Money holding opens filtered asset activity and inspects exact records at four widths in the real App', async ({ page }) => {
  await activityApi(page);
  const errors = [],
    writes = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (request) => {
    if (request.url().includes('/api/') && request.method() === 'POST' && !request.url().includes('auth.login')) writes.push(request.url());
  });
  await page.route('**/api/v1/account/balance*', (route) =>
    route.fulfill({
      json: {
        timestamp: 1791504000000,
        datetime: '2026-10-09T00:00:00Z',
        balances: { BTC: { free: '0.2', used: '0.1', total: '0.3' } },
      },
    }),
  );
  await signIn(page, '/portfolio/BTC');
  await page.getByRole('link', { name: /BTC activity/ }).click();
  await expect(page).toHaveURL(/\/uc\/record\?asset=BTC$/);
  await expect(page.getByRole('heading', { name: 'BTC activity', exact: true })).toBeVisible();
  await expect(page.getByTestId('money-activity-row')).toHaveCount(1);
  await expect(page.getByTestId('money-activity-list')).not.toContainText('USDT');
  await expect(page.getByText('1 matching BTC records in 2 returned.')).toBeVisible();
  await page.getByRole('button', { name: 'Outgoing', exact: true }).click();
  const details = page.locator('#money-record-details');
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: new RegExp('Inspect.*' + activityId) }).click();
    await expect(details).toContainText(activityId);
    await expect(details).toContainText('0.000000000000000001 BTC');
    await expect(details).toContainText('hold-original');
    await expect(details).toContainText('Not supplied');
    await expect(details).toContainText('does not confirm a live bank transfer or network broadcast');
    if (width === 1440) await expect(page.locator('#money-record-heading')).toBeFocused();
    await page.locator('#money-record-heading').focus();
    await page.keyboard.press('Tab');
    await expect(details.getByRole('link', { name: /Open Support/ })).toBeFocused();
    const reachable = await details.getByRole('link', { name: /Open Support/ }).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const bar = document.querySelector('[data-testid="mobile-doors"]')?.getBoundingClientRect();
      return { hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)), bottom: r.bottom, barTop: bar?.top };
    });
    expect(reachable.hit).toBe(true);
    if (width <= 1000) expect(reachable.bottom).toBeLessThanOrEqual(reachable.barTop);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const axe = await new AxeBuilder({ page }).include('[data-testid="money-activity"]').analyze();
    expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);
  }
  await page.getByRole('button', { name: 'Hide amounts', exact: true }).click();
  await expect(details).toContainText('•••• BTC');
  await expect(details).not.toContainText('0.000000000000000001');
  await page.getByRole('button', { name: 'Show amounts', exact: true }).click();
  await expect(details).toContainText('0.000000000000000001 BTC');
  await page.getByRole('link', { name: 'Back to BTC', exact: true }).click();
  await expect(page).toHaveURL(/\/portfolio\/BTC$/);
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});

test('Money activity retains selected original ID through loading failed empty and restored reads without clearing write recovery', async ({
  page,
}) => {
  await activityApi(page);
  let mode = 'ready',
    held;
  await page.route('**/api/bank/trpc/ramps.offramps?*', (route) => {
    if (mode === 'loading') {
      held = route;
      return;
    }
    return reply(route, mode === 'empty' ? [] : [activityRecord]);
  });
  await page.addInitScript(
    ({ userId, activityId }) =>
      localStorage.setItem(
        'intafaced.customer.bank-unconfirmed.v1:' + userId,
        JSON.stringify([
          { reference: activityId, title: 'Original transfer', procedure: 'transfers.toUser', recordRefs: { transferId: activityId } },
        ]),
      ),
    { userId, activityId },
  );
  await signIn(page, '/uc/record?asset=BTC');
  await page.getByRole('button', { name: 'Outgoing', exact: true }).click();
  await page.getByRole('button', { name: new RegExp('Inspect.*' + activityId) }).click();
  const details = page.locator('#money-record-details');
  mode = 'loading';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await expect(details).toContainText(activityId);
  await expect(details).not.toContainText('0.000000000000000001');
  await expect(details).toContainText('Current details are unavailable');
  await held.fulfill({ status: 503, json: { error: 'Unavailable', message: 'The service is offline.' } });
  await expect(page.locator('[data-testid="money-activity"] [data-testid="failure"]')).toBeVisible();
  await expect(details).toContainText(activityId);
  mode = 'empty';
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(details).toContainText('not present in the latest bounded read');
  await expect(details).toContainText(activityId);
  await expect(details).not.toContainText('0.000000000000000001');
  mode = 'ready';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(details).toContainText('0.000000000000000001 BTC');
  await expect(page.locator('#bank-unconfirmed')).toContainText(activityId);
  expect(
    JSON.parse(await page.evaluate((userId) => localStorage.getItem('intafaced.customer.bank-unconfirmed.v1:' + userId), userId)),
  ).toHaveLength(1);
});

test('Money activity continuation uses fetched count when no matching asset is on the first page', async ({ page }) => {
  await activityApi(page);
  const limits = [];
  const all = Array.from({ length: 51 }, (_, index) => ({
    ...activityRecord,
    id: `record-${index}`,
    assetId: index === 50 ? 'BTC' : 'USDT',
    railRef: `rail-${index}`,
    ledgerTxId: null,
  }));
  await page.route('**/api/bank/trpc/ramps.onramps?*', (route) => {
    const input = JSON.parse(new URL(route.request().url()).searchParams.get('input'));
    expect(Object.keys(input)).toEqual(['limit']);
    limits.push(input.limit);
    return reply(route, all.slice(0, input.limit));
  });
  await signIn(page, '/uc/record?asset=BTC');
  await expect(page.getByText('No matching records in this read', { exact: true })).toBeVisible();
  await expect(page.getByText('0 matching BTC records in 50 returned.')).toBeVisible();
  await page.getByRole('button', { name: 'Load up to 100', exact: true }).click();
  await expect(page.getByTestId('money-activity-row')).toHaveCount(1);
  await expect(page.getByText('1 matching BTC records in 51 returned.')).toBeVisible();
  expect(limits).toContain(50);
  expect(limits.at(-1)).toBe(100);
  expect(limits.every((limit) => limit === 50 || limit === 100)).toBe(true);
});

test('Money activity keeps standing instructions distinct and reads the selected owned schedule execution refusal', async ({ page }) => {
  await activityApi(page);
  await page.route('**/api/bank/trpc/transfers.listSchedules?*', (route) =>
    reply(route, [
      {
        id: invitationId,
        assetId: 'BTC',
        amount: '0.000000000000000001',
        cadence: 'weekly',
        startsAt: '2026-10-16T00:00:00Z',
        endsAt: null,
        nextRunAt: '2026-10-16T00:00:00Z',
        status: 'active',
        revision: 1,
      },
      {
        id: foreignId,
        assetId: 'USDT',
        amount: '4',
        cadence: 'daily',
        startsAt: '2026-10-10T00:00:00Z',
        endsAt: null,
        nextRunAt: '2026-10-10T00:00:00Z',
        status: 'active',
        revision: 1,
      },
    ]),
  );
  await page.route('**/api/bank/trpc/transfers.executions?*', (route) => {
    const input = JSON.parse(new URL(route.request().url()).searchParams.get('input'));
    expect(input).toEqual({ scheduleId: invitationId, limit: 50 });
    return reply(route, [
      { occurrence: 1, amount: '0.000000000000000001', status: 'rejected', ledgerTxId: null, rejectionCode: 'bank.insufficient_available' },
    ]);
  });
  await signIn(page, '/uc/record?asset=BTC');
  await page.getByRole('button', { name: 'Scheduled', exact: true }).click();
  await expect(page.getByText('These are scheduled instructions, not posted transfers.', { exact: false })).toBeVisible();
  await expect(page.getByTestId('money-activity-row')).toHaveCount(1);
  await page.getByRole('button', { name: new RegExp('Inspect.*' + invitationId) }).click();
  await expect(page.locator('#money-record-details')).toContainText('bank.insufficient_available');
  await expect(page.locator('#money-record-details')).toContainText('No ledger reference returned');
  await expect(page.locator('#money-record-details')).not.toContainText('No posted transaction');
  await expect(page.getByRole('link', { name: /Manage standing orders/ })).toHaveAttribute('href', '/bank/transfers');
  await page.getByRole('button', { name: 'Incoming', exact: true }).click();
  await expect(page.locator('#money-record-details')).not.toContainText(invitationId);
});

for (const query of ['asset=', 'asset=BTC&asset=USDT', 'asset=THIS-ASSET-CODE-IS-TOO-LONG'])
  test(`Money activity refuses invalid context ${query} before Bank reads`, async ({ page }) => {
    await activityApi(page);
    const reads = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/bank/')) reads.push(request.url());
    });
    await signIn(page, '/uc/record?' + query);
    await expect(page.getByRole('heading', { name: 'Asset context is invalid', exact: true })).toBeVisible();
    await expect(page.getByTestId('money-activity-row')).toHaveCount(0);
    expect(reads).toEqual([]);
  });

test('Money activity for all assets retains explicit units and rejects numeric monetary responses', async ({ page }) => {
  await activityApi(page);
  await signIn(page, '/uc/record');
  await expect(page.getByTestId('money-activity-row')).toHaveCount(2);
  await expect(page.getByTestId('money-activity-list')).toContainText('9 USDT');
  await page.route('**/api/bank/trpc/ramps.onramps?*', (route) =>
    reply(route, [{ ...activityRecord, amount: 0.1, railRef: 'invalid', ledgerTxId: null }]),
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('[data-testid="money-activity"] [data-testid="failure"]')).toBeVisible();
  await expect(page.getByTestId('money-activity-row')).toHaveCount(0);
});

for (const publishedMarket of [false, true])
  test(`working orders beyond the first 100 remain reachable ${publishedMarket ? 'in Spot' : 'account-wide'} without financial writes`, async ({
    page,
  }) => {
    await setup(page);
    if (publishedMarket)
      await page.route('**/api/v1/markets*', (route) =>
        route.fulfill({
          json: [
            {
              id: 'market-BTC',
              symbol: 'BTC/USDT',
              base: 'BTC',
              quote: 'USDT',
              settle: null,
              baseId: 'BTC',
              quoteId: 'USDT',
              type: 'spot',
              spot: true,
              swap: false,
              future: false,
              option: false,
              contract: false,
              linear: null,
              inverse: null,
              active: true,
              orderable: true,
              paper: false,
              schedule: 'crypto-24x7',
              sessionOpen: true,
              nextSessionChange: null,
              hours: { kind: 'continuous' },
              taker: '0.001',
              maker: '0.001',
              contractSize: null,
              expiry: null,
              expiryDatetime: null,
              strike: null,
              optionType: null,
              precisionMode: 'TICK_SIZE',
              precision: { amount: '0.00001', price: '0.01' },
              limits: {
                amount: { min: '0.00001', max: null },
                price: { min: null, max: null },
                cost: { min: '5', max: null },
                leverage: { min: null, max: null },
              },
            },
          ],
        }),
      );
    const limits = [],
      writes = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/') && request.method() !== 'GET') writes.push(request.method());
    });
    const orders = Array.from({ length: 501 }, (_, index) => ({
      id: `working-order-${index + 1}`,
      clientOrderId: null,
      timestamp: 1791417600000,
      datetime: '2026-10-08T00:00:00.000Z',
      lastTradeTimestamp: null,
      symbol: 'BTC/USDT',
      type: 'limit',
      side: 'buy',
      timeInForce: 'GTC',
      postOnly: false,
      reduceOnly: false,
      price: '1',
      stopPrice: null,
      average: null,
      amount: '1',
      filled: '0',
      remaining: '1',
      cost: '0',
      status: 'open',
      fee: null,
      trades: [],
      recoveryRequired: false,
      recoveryReason: null,
      reconciliationKey: null,
    }));
    await page.route('**/api/v1/orders/working-order-*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          orders.find((order) =>
            route
              .request()
              .url()
              .endsWith('/' + order.id),
          ),
        ),
      }),
    );
    await page.route('**/api/v1/orders/open?*', (route) => {
      const limit = Number(new URL(route.request().url()).searchParams.get('limit'));
      limits.push(limit);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(orders.slice(0, limit)) });
    });
    await signIn(page, '/exchange');
    const management = page.locator('.trade-blotter');
    await expect(management.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(100);
    await management.getByRole('button', { name: 'Load more records', exact: true }).click();
    await expect(management.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(200);
    await management.getByRole('button', { name: 'Cancel', exact: true }).nth(100).click();
    await expect(page.getByRole('dialog').getByText(/working-order-101$/)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
    for (let i = 0; i < 3; i++) await management.getByRole('button', { name: 'Load more records', exact: true }).click();
    await expect(management.getByRole('button', { name: /page limit reached/i })).toBeDisabled();
    await expect(management.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(500);
    expect(limits).toContain(200);
    expect(Math.max(...limits)).toBe(500);
    expect(writes).toEqual([]);
  });

test('Hide balances masks each owned stake on desktop and phone and can reveal it again', async ({ page }) => {
  await setup(page);
  const amount = '123.456789123456789123';
  await page.route('**/api/token/trpc/accessOf*', (route) => reply(route, { staked: amount, tier: 'm3', feeDiscountBps: 10 }));
  await page.route('**/api/token/trpc/listStakes?*', (route) =>
    reply(route, [
      {
        id: invitationId,
        userId,
        amount,
        tier: 'm3',
        startedAt: '2026-10-08T00:00:00Z',
        unlocksAt: '2027-01-08T00:00:00Z',
        status: 'active',
      },
    ]),
  );
  await signIn(page, '/view');
  await page.getByLabel('Hide balance values', { exact: true }).check();
  await signIn(page, '/token');
  const stakes = page.getByRole('region', { name: 'Your token stakes', exact: true }).getByRole('table');
  await expect(stakes.getByText('active', { exact: true })).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(stakes).not.toContainText(amount);
    await expect(stakes).toContainText('••••');
    await expect(page.getByRole('main')).not.toContainText(amount);
  }
  await signIn(page, '/view');
  await page.getByLabel('Hide balance values', { exact: true }).uncheck();
  await signIn(page, '/token');
  await expect(stakes).toContainText(amount);
});

test('customer campaigns represent participation and its unavailable service without growth authoring', async ({ page }) => {
  await setup(page);
  const proposals = [];
  page.on('request', (request) => {
    if (request.url().includes('growth.propose')) proposals.push(request.method());
  });
  await signIn(page, '/campaigns');
  await expect(page.getByRole('heading', { name: 'Your campaign activity', exact: true })).toBeVisible();
  await expect(page.getByText('Campaign activity unavailable', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Campaign headline', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Prepare a grounded proposal/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review campaign proposal', exact: true })).toHaveCount(0);
  // The public /lab page is the Lab (SP-pages-01), not a campaign list, so the room no longer points there.
  await expect(page.getByRole('link', { name: 'Open public campaigns', exact: true })).toHaveCount(0);
  expect(proposals).toEqual([]);
});

test('safe sign-in return opens the actual Bank room without persisting credentials', async ({ page }) => {
  await setup(page);
  await signIn(page, '/bank/spaces');
  await expect(page.getByRole('heading', { name: 'Spaces', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('Journey implementation in progress')).toHaveCount(0);
  const storage = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }));
  expect(JSON.stringify(storage)).not.toContain(session.accessToken);
  expect(JSON.stringify(storage)).not.toContain(session.refreshToken);
});

test('search is keyboard reachable, lists the parked Chain room, and excludes Business and Team rooms', async ({ page }) => {
  await setup(page);
  await signIn(page, '/uc/safe');
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Search Intafaced' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('No published markets match this search.')).toBeVisible();
  await dialog.getByLabel('Find a room or action').fill('ledger');
  await expect(dialog.getByRole('link', { name: /Operator|Ledger ops|Business bank|Merchant/ })).toHaveCount(0);
  await dialog.getByLabel('Find a room or action').fill('chain');
  // Parked rooms are searchable (founder order 2026-10-17); they still never become a sign-in return target.
  await expect(dialog.getByRole('link')).toHaveCount(1);
  await expect(dialog.getByRole('link').first()).toHaveAttribute('href', '/chain');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('sign out everywhere requires review and clears the account after the service confirms', async ({ page }) => {
  await setup(page);
  let revocations = 0;
  await page.route('**/api/identity/trpc/auth.logoutAll', (route) => {
    revocations++;
    return reply(route, { revoked: 1 });
  });
  await signIn(page, '/uc/safe');
  await page.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
  expect(revocations).toBe(0);
  await page
    .getByRole('dialog', { name: 'Sign out everywhere?', exact: true })
    .getByRole('button', { name: 'Sign out everywhere', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  expect(revocations).toBe(1);
});

test('Inbox keeps a legitimate Money link and refuses another account’s notification', async ({ page }) => {
  await setup(page);
  const item = {
    id: invitationId,
    userId,
    titleKey: 'test.notification',
    bodyKey: 'test.body',
    title: 'Review account settings',
    body: 'Review the current settings for your account.',
    href: '/money',
    severity: 'info',
    readAt: null,
    createdAt: '2026-10-08T00:00:00Z',
  };
  await page.route('**/api/notify/trpc/notify.list?*', (route) => reply(route, { items: [item], nextCursor: null }));
  await signIn(page, '/notifications');
  await expect(page.getByRole('link', { name: 'Open related room' })).toHaveAttribute('href', '/money');
  item.userId = foreignId;
  await page.getByRole('button', { name: 'Unread only' }).click();
  await expect(page.getByRole('heading', { name: 'Information could not be verified' })).toBeVisible();
  await expect(page.getByText('Review account settings')).toHaveCount(0);
});

test('invitation survives sign-in and requires an explicit acceptance', async ({ page }) => {
  await setup(page);
  let accepted = 0,
    checked = 0;
  await page.route('**/api/identity/trpc/affiliates.myReferrer', (route) => {
    checked++;
    return reply(route, null);
  });
  await page.route('**/api/identity/trpc/affiliates.shareHits', (route) => {
    expect(route.request().postDataJSON()).toEqual({ token: invitationId });
    accepted++;
    return reply(route, { hits: 1, attributed: true });
  });
  await page.goto(`/invite?token=${invitationId}`);
  await page.getByRole('main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email or handle', { exact: true }).fill('integration@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/invite\\?token=${invitationId}$`));
  expect(accepted).toBe(0);
  await page.getByRole('button', { name: 'Review invitation', exact: true }).click();
  expect(accepted).toBe(0);
  expect(checked).toBe(0);
  await page.getByRole('button', { name: 'Accept this invitation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Referral status recorded.', exact: true }).last()).toBeVisible();
  expect(checked).toBe(1);
  expect(accepted).toBe(1);
});

test('View uses the selected document language at 320px and has no serious accessibility defects', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await signIn(page, '/view');
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await page.getByLabel('Language', { exact: true }).selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(audit.violations.filter((item) => ['serious', 'critical'].includes(item.impact))).toEqual([]);
});

test('authenticator confirmation submits the real contract without reloading or persisting setup secrets', async ({ page }) => {
  await setup(page);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const secret = Array.from(randomBytes(32), (byte) => alphabet[byte % 32]).join('');
  const recoveryCodes = Array.from({ length: 10 }, () =>
    randomBytes(5)
      .toString('hex')
      .toUpperCase()
      .replace(/^(.{5})(.{5})$/, '$1-$2'),
  );
  expect(new Set(recoveryCodes).size).toBe(10);
  let preparations = 0;
  await page.route('**/api/identity/trpc/totp.enrol', (route) => {
    preparations++;
    return reply(route, {
      secret,
      uri: `otpauth://totp/INTAFACED:isolated?secret=${secret}&issuer=INTAFACED&algorithm=SHA1&digits=6&period=30`,
      recoveryCodes,
    });
  });
  await page.route('**/api/identity/trpc/totp.confirm', (route) => {
    expect(route.request().postDataJSON()).toEqual({ secret, code: '123456' });
    return reply(route, { ok: true });
  });
  await signIn(page, '/uc/safe');
  await page.getByRole('button', { name: 'Start authenticator setup', exact: true }).click();
  expect(preparations).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Start authenticator setup', exact: true }).click();
  await page.getByLabel('Six-digit authenticator code').fill('123456');
  expect(preparations).toBe(1);
  await page.getByRole('button', { name: 'Confirm authenticator' }).click();
  await expect(page.getByRole('region', { name: 'Authenticator app', exact: true })).toContainText(
    'The service accepted the original authenticator confirmation.',
  );
  await expect(page).toHaveURL(/\/uc\/safe$/);
  expect(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))).not.toContain(secret);
});

test('assembled customer rooms remain usable at desktop and 320px when services are unavailable', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  await signIn(page, '/money');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const paths = await page.evaluate(async () => {
    const { rooms } = await import('/src/app/navigation.ts');
    return rooms
      .filter(
        (room) =>
          !room.alias &&
          !room.path.includes(':') &&
          !room.path.includes('*') &&
          ['money', 'trade', 'pay', 'more', 'person'].includes(room.area),
      )
      .map((room) => room.path);
  });
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of paths) {
      await page.evaluate(async (destination) => {
        const { navigate } = await import('/src/app/location.ts');
        navigate(destination);
      }, path);
      await expect(page.getByText('Opening room', { exact: false })).toHaveCount(0);
      await expect(page.getByText('The interface encountered an error', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Journey implementation in progress', { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path} at ${width}px`).toBe(true);
    }
  }
  expect(errors).toEqual([]);
});

test('Money holding to Send preserves BTC through source selection and exact review in the real App', async ({ page }) => {
  await setup(page);
  const sourceId = '44444444-4444-4444-8444-444444444444';
  const btc = {
    id: sourceId,
    assetId: 'BTC',
    kind: 'primary',
    name: 'Main',
    goalTarget: null,
    lockedUntil: null,
    balance: '0.200000000000000001',
    ledgerAccount: { ownerType: 'user', ownerId: userId, assetId: 'BTC', kind: 'available' },
  };
  const usd = { ...btc, id: foreignId, assetId: 'USDT', balance: '4', ledgerAccount: { ...btc.ledgerAccount, assetId: 'USDT' } };
  const writes = [],
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/api/') && request.method() === 'POST' && !request.url().includes('auth.login')) writes.push(request.url());
  });
  await page.route('**/api/v1/account/balance*', (route) =>
    route.fulfill({
      json: {
        timestamp: 1791417600000,
        datetime: '2026-10-08T00:00:00.000Z',
        balances: { BTC: { free: '0.200000000000000001', used: '0.1', total: '0.300000000000000001' } },
      },
    }),
  );
  await page.route('**/api/bank/trpc/spaces.list?*', (route) => reply(route, [usd, btc]));
  await page.route('**/api/bank/trpc/spaces.unnamed?*', (route) => reply(route, []));
  await signIn(page, '/portfolio');
  await page.getByTestId('money-holding').click();
  await expect(page).toHaveURL(/\/portfolio\/BTC$/);
  await expect(page.locator('.money-holding-quantity')).toHaveText('0.300000000000000001 BTC');
  await expect(page.getByText('Total account value', { exact: true })).toHaveCount(0);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const send = page.getByRole('link', { name: /Send available BTC/ });
    await expect(page.locator('.money-holding-actions').getByRole('link', { name: /Send available BTC/ })).toBeVisible();
    expect((await send.boundingBox()).height).toBeGreaterThanOrEqual(44);
    if (width <= 768) {
      const analysis = page.getByRole('heading', { name: 'Price and simple analysis' });
      expect((await send.boundingBox()).y).toBeLessThan((await analysis.boundingBox()).y);
      await page.getByRole('button', { name: 'Hide amounts' }).focus();
      for (const name of ['Buy BTC', 'Sell BTC', /Send available BTC/]) {
        await page.keyboard.press('Tab');
        await expect(page.getByRole('link', { name })).toBeFocused();
      }
      expect(
        await send.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('a') === element;
        }),
      ).toBe(true);
    }
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(audit.violations.filter((item) => ['serious', 'critical'].includes(item.impact))).toEqual([]);
    if (process.env.MONEY_JOURNEY_SCREENSHOTS)
      await page.screenshot({ path: `${process.env.MONEY_JOURNEY_SCREENSHOTS}/M1-holding-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Hide amounts' }).click();
  await expect(page.locator('.money-holding-quantity')).toHaveText('••••');
  await expect(page.locator('.money-holding-restrictions')).not.toContainText('0.200000000000000001');
  await page.getByRole('button', { name: 'Show amounts' }).click();
  await page.getByRole('link', { name: /Send available BTC/ }).click();
  await expect(page).toHaveURL(/\/pay\/send\?asset=BTC$/);
  await expect(page.getByRole('heading', { name: 'Sending BTC', exact: true })).toBeVisible();
  await expect(page.getByLabel('Source account', { exact: true })).toHaveValue(sourceId);
  await expect(page.getByLabel('Source account', { exact: true }).locator('option')).not.toContainText(['Main · USDT']);
  await page.getByLabel('Recipient account ID').fill(invitationId);
  await page.getByLabel('Amount · BTC', { exact: true }).fill('0.000000000000000001');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  await expect(page.getByRole('dialog').getByText('0.000000000000000001 BTC', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Main · BTC', { exact: true })).toBeVisible();
  if (process.env.MONEY_JOURNEY_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.MONEY_JOURNEY_SCREENSHOTS}/M1-send-review-320.png` });
  await page.getByRole('button', { name: 'Edit transfer' }).click();
  await page.getByRole('link', { name: /Back to BTC holding/ }).click();
  await expect(page).toHaveURL(/\/portfolio\/BTC$/);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
