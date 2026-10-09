import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Isolated identity/network examples exercise the real App and sign-in form.
// No production sample mode, financial browser dataset, or fixture screenshots.
const userId = '11111111-1111-4111-8111-111111111111';
const foreignId = '22222222-2222-4222-8222-222222222222';
const invitationId = '33333333-3333-4333-8333-333333333333';
const session = { userId, accessToken: 'isolated-identity-test', refreshToken: 'isolated-refresh-test', expiresAt: '2027-10-08T00:00:00Z' };
const reply = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
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

for (const publishedMarket of [false, true]) test(`working orders beyond the first 100 remain reachable ${publishedMarket ? 'in Spot' : 'account-wide'} without financial writes`, async ({ page }) => {
  await setup(page);
  if (publishedMarket) await page.route('**/api/v1/markets*', (route) => route.fulfill({ json: [{
    id: 'market-BTC', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', settle: null,
    baseId: 'BTC', quoteId: 'USDT', type: 'spot', spot: true, swap: false, future: false,
    option: false, contract: false, linear: null, inverse: null, active: true, orderable: true,
    paper: false, schedule: 'crypto-24x7', sessionOpen: true, nextSessionChange: null,
    hours: { kind: 'continuous' }, taker: '0.001', maker: '0.001', contractSize: null,
    expiry: null, expiryDatetime: null, strike: null, optionType: null, precisionMode: 'TICK_SIZE',
    precision: { amount: '0.00001', price: '0.01' }, limits: {
      amount: { min: '0.00001', max: null }, price: { min: null, max: null },
      cost: { min: '5', max: null }, leverage: { min: null, max: null },
    },
  }] }));
  const limits = [], writes = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/') && request.method() !== 'GET') writes.push(request.method());
  });
  const orders = Array.from({ length: 501 }, (_, index) => ({
      id: `working-order-${index + 1}`, clientOrderId: null,
      timestamp: 1791417600000, datetime: '2026-10-08T00:00:00.000Z', lastTradeTimestamp: null,
      symbol: 'BTC/USDT', type: 'limit', side: 'buy', timeInForce: 'GTC', postOnly: false,
      reduceOnly: false, price: '1', stopPrice: null, average: null, amount: '1', filled: '0',
      remaining: '1', cost: '0', status: 'open', fee: null, trades: [], recoveryRequired: false,
      recoveryReason: null, reconciliationKey: null,
  }));
  await page.route('**/api/v1/orders/working-order-*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(orders.find((order) => route.request().url().endsWith('/' + order.id))),
  }));
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
  await page.route('**/api/token/trpc/listStakes?*', (route) => reply(route, [{
    id: invitationId, userId, amount, tier: 'm3', startedAt: '2026-10-08T00:00:00Z',
    unlocksAt: '2027-01-08T00:00:00Z', status: 'active',
  }]));
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
  await expect(page.getByRole('link', { name: 'Open public campaigns', exact: true })).toHaveAttribute('href', '/lab');
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

test('search is keyboard reachable and excludes Business, Team and parked chain rooms', async ({ page }) => {
  await setup(page);
  await signIn(page, '/uc/safe');
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Search Intafaced' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('No published markets match this search.')).toBeVisible();
  await dialog.getByLabel('Find a room or action').fill('ledger');
  await expect(dialog.getByRole('link', { name: /Operator|Ledger ops|Business bank|Merchant/ })).toHaveCount(0);
  await dialog.getByLabel('Find a room or action').fill('chain');
  await expect(dialog.getByRole('link')).toHaveCount(0);
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
  await page.getByRole('dialog', { name: 'Sign out everywhere' }).getByRole('button', { name: 'Revoke all sessions' }).click();
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
  let accepted = 0;
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
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByText('Your referral status is recorded by the service.')).toBeVisible();
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
  await page.route('**/api/identity/trpc/totp.enrol', (route) =>
    reply(route, { secret, uri: `otpauth://totp/Test?secret=${secret}`, recoveryCodes: ['isolated-recovery'] }),
  );
  await page.route('**/api/identity/trpc/totp.confirm', (route) => {
    expect(route.request().postDataJSON()).toEqual({ secret, code: '123456' });
    return reply(route, { ok: true });
  });
  await signIn(page, '/uc/safe');
  await page.getByRole('button', { name: 'Start authenticator setup' }).click();
  await page.getByLabel('Six-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Confirm authenticator' }).click();
  await expect(page.getByText('Authenticator enrollment confirmed.')).toBeVisible();
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
  await page.locator('.money-holding').click();
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
