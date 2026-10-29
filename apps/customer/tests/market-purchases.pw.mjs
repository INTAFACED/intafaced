import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, readFileSync } from 'node:fs';
const dir = process.env.MARKET_PURCHASES_EVIDENCE || '/tmp/intafaced-market-purchases';
mkdirSync(dir, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222',
  listing = '33333333-3333-4333-8333-333333333333',
  original = '44444444-4444-4444-8444-444444444444',
  ledger = '55555555-5555-4555-8555-555555555555',
  vendor = '66666666-6666-4666-8666-666666666666',
  seller = '77777777-7777-4777-8777-777777777777',
  second = '88888888-8888-4888-8888-888888888888';
const at = '2026-10-09T10:00:00.000Z',
  originalWindow = '2026-10-10T10:00:00.000Z',
  currentWindow = '2026-10-10T14:00:00.000Z';
const row = (extra = {}) => ({
  id: original,
  listingId: listing,
  buyerId: owner,
  vendorId: vendor,
  vendorUserId: seller,
  assetId: 'USDT',
  price: '0.000000000000000001',
  commissionBps: 500,
  status: 'settled',
  ledgerTxId: ledger,
  rejectionCode: null,
  createdAt: at,
  settledAt: at,
  accessUntil: originalWindow,
  refundWindowSeconds: null,
  hold: null,
  ...extra,
});
const grant = (extra = {}) => ({ granted: true, listingId: listing, buyerId: owner, accessUntil: currentWindow, ...extra });
const reply = (route, data) => route.fulfill({ status: 200, json: { result: { data } } });
const failure = (route) =>
  route.fulfill({
    status: 503,
    json: { error: { message: 'Original English market read unavailable', data: { code: 'acceptance.unavailable' } } },
  });
const room = (page) => page.locator('.market-purchases');
const detail = (page) => room(page).getByRole('region', { name: 'Selected original purchase', exact: true });
const access = (page) => room(page).getByRole('region', { name: 'Current subscription access', exact: true });
async function network(page, handlers = {}, identity = () => owner) {
  const calls = { reads: [], writes: [], errors: [] };
  page.on('pageerror', (e) => calls.errors.push(e.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      proc = url.pathname.split('/').at(-1),
      input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') ?? 'null') : request.postDataJSON();
    (request.method() === 'GET' ? calls.reads : calls.writes).push({ proc, input });
    if (handlers[proc]) return handlers[proc](route, input);
    if (proc === 'auth.login')
      return reply(route, {
        userId: identity(),
        accessToken: 'isolated-market-owner-' + identity(),
        refreshToken: 'isolated-market-refresh-' + identity(),
        expiresAt: '2027-10-09T10:00:00Z',
      });
    if (proc === 'auth.logout') return reply(route, { ok: true });
    if (proc === 'myPurchases') return reply(route, [row({ buyerId: identity() })]);
    if (proc === 'subscriptionAccess') return reply(route, grant({ buyerId: identity(), listingId: input.listingId }));
    if (proc === 'commerceProgramme') return reply(route, { commissionBps: 500, commissionConfigured: true });
    if (['listings', 'mine', 'myListings', 'webauthn.list'].includes(proc)) return reply(route, proc === 'mine' ? null : []);
    return failure(route);
  });
  return calls;
}
async function login(page, path = '/market') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.getByLabel('Email or handle', { exact: true }).fill('market-owner');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(path + '$'));
  await expect(room(page)).toBeVisible();
}
async function inspect(page, index = 0) {
  await room(page).getByRole('button', { name: 'Inspect purchase', exact: true }).nth(index).click();
  await expect(detail(page)).toBeVisible();
}
const marketWrites = (c) => c.writes.filter((x) => !x.proc.startsWith('auth.'));
const markerKey = 'intafaced:more:pending:' + owner + ':market';
test('native owned receipt keeps exact native price and original window separate from manual current listing grant', async ({ page }) => {
  const calls = await network(page);
  await login(page);
  expect(calls.reads.filter((x) => x.proc === 'subscriptionAccess')).toHaveLength(0);
  await inspect(page);
  await expect(detail(page)).toContainText('Settlement recorded');
  await expect(detail(page)).toContainText('0.000000000000000001');
  await expect(detail(page)).toContainText('USDT');
  await expect(detail(page).locator('time[datetime="' + originalWindow + '"]')).toBeVisible();
  await expect(access(page)).toContainText('Current access has not been checked.');
  await access(page).getByRole('button', { name: 'Check current access', exact: true }).click();
  await expect(access(page)).toContainText('Access granted by the service');
  await expect(access(page).locator('time[datetime="' + currentWindow + '"]')).toBeVisible();
  await expect(detail(page).locator('time[datetime="' + originalWindow + '"]')).toBeVisible();
  await expect(access(page)).toContainText('It can include other purchases.');
  await expect(access(page)).toContainText('A grant does not reveal renewal or cancellation status.');
  expect(calls.reads.filter((x) => x.proc === 'subscriptionAccess')).toEqual([
    { proc: 'subscriptionAccess', input: { listingId: listing } },
  ]);
  expect(calls.reads.filter((x) => x.proc === 'myPurchases').every((x) => x.input.limit === 50)).toBe(true);
  expect(marketWrites(calls)).toEqual([]);
  expect(calls.errors).toEqual([]);
  await page.screenshot({ path: dir + '/native-original-and-current.png', fullPage: true });
});
test('pending or incomplete settlement and null window do not become a receipt or unlimited access', async ({ page }) => {
  let mode = 0;
  const calls = await network(page, {
    myPurchases: (route) =>
      reply(route, [
        row(
          mode === 0
            ? { status: 'pending', ledgerTxId: null, settledAt: null, accessUntil: null }
            : { ledgerTxId: null, settledAt: null, accessUntil: null },
        ),
      ]),
  });
  await login(page);
  await inspect(page);
  await expect(detail(page)).toContainText('Settlement not confirmed');
  await expect(detail(page)).toContainText('It does not establish unlimited access.');
  await expect(detail(page)).not.toContainText('Settlement recorded');
  await access(page).getByRole('button', { name: 'Check current access', exact: true }).click();
  await expect(access(page)).toContainText('Access granted by the service');
  await expect(detail(page)).toContainText('Settlement not confirmed');
  mode = 1;
  await room(page).getByRole('button', { name: 'Refresh purchases', exact: true }).click();
  await expect(detail(page)).toContainText('Settlement not confirmed');
  expect(calls.reads.filter((x) => x.proc === 'subscriptionAccess')).toHaveLength(1);
  expect(marketWrites(calls)).toEqual([]);
});
test('selected original survives loading failed empty and restored owner reads without stale amounts or grant', async ({ page }) => {
  let mode = 'ready',
    release;
  const calls = await network(page, {
    myPurchases: async (route) => {
      if (mode === 'loading') await new Promise((r) => (release = r));
      return mode === 'failed' ? failure(route) : reply(route, mode === 'empty' ? [] : [row()]);
    },
  });
  await login(page);
  await inspect(page);
  await access(page).getByRole('button', { name: 'Check current access', exact: true }).click();
  await expect(access(page)).toContainText('Access granted by the service');
  mode = 'loading';
  await room(page).getByRole('button', { name: 'Refresh purchases', exact: true }).click();
  await expect(detail(page).getByText(original, { exact: true })).toBeVisible();
  await expect(detail(page)).not.toContainText('0.000000000000000001');
  await expect(access(page)).toHaveCount(0);
  await expect.poll(() => Boolean(release)).toBe(true);
  mode = 'failed';
  release();
  await expect(room(page)).toContainText('Original English market read unavailable');
  await expect(detail(page).getByText(original, { exact: true })).toBeVisible();
  mode = 'empty';
  await room(page).getByRole('button', { name: 'Refresh purchases', exact: true }).click();
  await expect(room(page)).toContainText('No purchases returned');
  await expect(detail(page)).not.toContainText('Settlement recorded');
  mode = 'ready';
  await room(page).getByRole('button', { name: 'Refresh purchases', exact: true }).click();
  await expect(detail(page)).toContainText('Settlement recorded');
  await expect(access(page)).toContainText('Current access has not been checked.');
  expect(calls.reads.filter((x) => x.proc === 'subscriptionAccess')).toHaveLength(1);
  expect(marketWrites(calls)).toEqual([]);
  expect(calls.errors).toEqual([]);
});
for (const mode of ['foreign', 'numeric', 'duplicate', 'oversized'])
  test('native purchase window ' + mode + ' refuses before owned details or writes', async ({ page }) => {
    const rows =
      mode === 'foreign'
        ? [row({ buyerId: other })]
        : mode === 'numeric'
          ? [row({ price: 0.1 })]
          : mode === 'duplicate'
            ? [row(), row()]
            : Array.from({ length: 51 }, (_, i) => row({ id: String(i + 1).padStart(8, '0') + '-0000-4000-8000-000000000000' }));
    const calls = await network(page, { myPurchases: (route) => reply(route, rows) });
    await login(page);
    await expect(room(page).locator('.loading')).toHaveCount(0);
    await expect(room(page).getByRole('button', { name: 'Inspect purchase', exact: true })).toHaveCount(0);
    await expect(room(page)).not.toContainText('0.000000000000000001');
    expect(calls.reads.filter((x) => x.proc === 'subscriptionAccess')).toHaveLength(0);
    expect(marketWrites(calls)).toEqual([]);
  });
for (const mode of ['foreign buyer', 'wrong listing', 'malformed grant'])
  test('current access ' + mode + ' never renders a grant or clears an original purchase marker', async ({ page }) => {
    const marker = { id: second, title: 'Original purchase', reference: original };
    await page.addInitScript(({ markerKey, marker }) => localStorage.setItem(markerKey, JSON.stringify(marker)), { markerKey, marker });
    const calls = await network(page, {
      subscriptionAccess: (route) =>
        reply(
          route,
          mode === 'foreign buyer'
            ? grant({ buyerId: other })
            : mode === 'wrong listing'
              ? grant({ listingId: second })
              : grant({ granted: false }),
        ),
    });
    await login(page);
    await inspect(page);
    await access(page).getByRole('button', { name: 'Check current access', exact: true }).click();
    await expect(access(page)).toContainText('Current access unavailable');
    await expect(access(page)).not.toContainText('Access granted by the service');
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), markerKey)).toEqual(marker);
    expect(marketWrites(calls)).toEqual([]);
  });
test('a granted current listing window cannot resolve an original uncertain purchase journal', async ({ page }) => {
  const marker = { id: second, title: 'Original purchase', reference: original };
  await page.addInitScript(({ markerKey, marker }) => localStorage.setItem(markerKey, JSON.stringify(marker)), { markerKey, marker });
  const calls = await network(page);
  await login(page);
  await inspect(page);
  await access(page).getByRole('button', { name: 'Check current access', exact: true }).click();
  await expect(access(page)).toContainText('Access granted by the service');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), markerKey)).toEqual(marker);
  await expect(page.getByText('Original outcome verified', { exact: true })).toHaveCount(0);
  expect(marketWrites(calls)).toEqual([]);
});
test('different selections discard a previous access reply and preserve only the new original listing', async ({ page }) => {
  let release;
  const calls = await network(page, {
    myPurchases: (route) => reply(route, [row(), row({ id: second, listingId: second, price: '2' })]),
    subscriptionAccess: async (route, input) => {
      if (input.listingId === listing) await new Promise((r) => (release = r));
      return reply(
        route,
        grant({ listingId: input.listingId, accessUntil: input.listingId === listing ? currentWindow : '2026-10-11T14:00:00.000Z' }),
      );
    },
  });
  await login(page);
  await inspect(page);
  await access(page).getByRole('button', { name: 'Check current access', exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await inspect(page, 1);
  await access(page).getByRole('button', { name: 'Check current access', exact: true }).click();
  await expect(access(page).locator('time[datetime="2026-10-11T14:00:00.000Z"]')).toBeVisible();
  release();
  await expect(access(page).locator('time[datetime="' + currentWindow + '"]')).toHaveCount(0);
  await expect(detail(page)).not.toContainText('0.000000000000000001');
  expect(marketWrites(calls)).toEqual([]);
  expect(calls.errors).toEqual([]);
});
test('native account change discards old selected receipt and late current access', async ({ page }) => {
  let actor = owner,
    release;
  const calls = await network(
    page,
    {
      subscriptionAccess: async (route) => {
        await new Promise((r) => (release = r));
        return reply(route, grant());
      },
    },
    () => actor,
  );
  await login(page);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  await inspect(page);
  await access(page).getByRole('button', { name: 'Check current access', exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.locator('.person-trigger').click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  actor = other;
  await page.evaluate(() => {
    history.pushState(null, '', '/login?redirect=%2Fmarket');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.getByLabel('Email or handle', { exact: true }).fill('next-market-owner');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/market$/);
  release();
  await expect(detail(page)).toHaveCount(0);
  await expect(room(page)).not.toContainText('Access granted by the service');
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  expect(calls.errors).toEqual([]);
});
test('native view preference hides prices while retaining asset and original references', async ({ page }) => {
  const calls = await network(page);
  await login(page);
  await inspect(page);
  await page.locator('.person-trigger').click();
  await page.getByRole('dialog').locator('a[href="/view"]').click();
  await page.getByRole('checkbox', { name: 'Hide balance values', exact: true }).check();
  await page.evaluate(() => {
    history.pushState(null, '', '/market');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await inspect(page);
  await expect(room(page)).not.toContainText('0.000000000000000001');
  await expect(detail(page)).toContainText('USDT');
  await expect(detail(page).getByText(original, { exact: true }).first()).toBeVisible();
  await expect(detail(page)).toContainText('Amounts hidden by your device view preference.');
  expect(marketWrites(calls)).toEqual([]);
});
test('native long exact price remains complete and keyboard inspectable at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  const calls = await network(page, {
    myPurchases: (route) => reply(route, [row({ price: '99999999999999999999.999999999999999999' })]),
  });
  await login(page);
  await inspect(page);
  const price = detail(page).getByRole('group', { name: 'Original purchase price', exact: true });
  const exact = '99,999,999,999,999,999,999.999999999999999999';
  await expect(price).toHaveText(exact);
  await price.scrollIntoViewIfNeeded();
  await price.focus();
  await expect(price).toBeFocused();
  const size = await price.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }));
  expect(size.height).toBeGreaterThanOrEqual(44);
  expect(size.scroll).toBeGreaterThan(size.client);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => price.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await expect(price).toHaveText(exact);
  await expect(detail(page)).toContainText('USDT');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(marketWrites(calls)).toEqual([]);
  expect(calls.errors).toEqual([]);
  await page.screenshot({ path: dir + '/long-exact-price-keyboard-320.png', fullPage: true });
});
test('actual App five widths native focus44px and accessibility fit the purchase section', async ({ page }) => {
  const calls = await network(page);
  await login(page);
  await inspect(page);
  for (const width of [1440, 1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const button = access(page).getByRole('button', { name: 'Check current access', exact: true });
    await button.scrollIntoViewIfNeeded();
    await button.focus();
    const fit = await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { height: r.height, hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)), bottom: r.bottom };
    });
    expect(fit.height).toBeGreaterThanOrEqual(44);
    expect(fit.hit).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: dir + '/app-purchases-' + width + '.png', fullPage: true });
  }
  const axe = await new AxeBuilder({ page }).include('#main').analyze();
  expect(axe.violations.filter((x) => ['serious', 'critical'].includes(x.impact))).toEqual([]);
  expect(calls.errors).toEqual([]);
  expect(marketWrites(calls)).toEqual([]);
});
test('ordinary compiled App keeps Market private without installed example identity or write', async ({ page }) => {
  const writes = [],
    errors = [];
  page.on('request', (r) => {
    if (r.method() === 'POST') writes.push(r.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/market');
  await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
  await expect(room(page)).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: dir + '/ordinary-private.png', fullPage: true });
});

// These captures come from the actual mounted router/CommerceService/shared
// formatter using a strict isolated SELECT-only adapter, never a live database.
for (const [name, expected, granted] of [
  ['grantedAcrossPurchases', 'Access granted by the service', true],
  ['cancelledRemainingPaid', 'Access granted by the service', true],
  ['pastDueAtExactBoundary', 'The service reports that the paid access window has ended.', false],
  ['cancelledEnded', 'The service reports that this subscription was cancelled and its paid window has ended.', false],
  ['noPaidAccess', 'The service returned no paid subscription access for this listing.', false],
  ['notSubscription', 'The service did not find a subscription listing with this identifier.', false],
])
  test('actual service formatter current access ' + name + ' remains distinct from original receipt', async ({ page }) => {
    if (!process.env.MARKET_SERVICE_PROBE)
      throw Error('MARKET_SERVICE_PROBE must name a generated actual Market read/formatter proof; no fabricated fallback.');
    const capture = JSON.parse(readFileSync(process.env.MARKET_SERVICE_PROBE, 'utf8')).cases[name];
    const calls = await network(page, {
      subscriptionAccess: (route) => route.fulfill({ status: capture.status, json: capture.body }),
      myPurchases: (route) => reply(route, [row(name === 'notSubscription' ? { accessUntil: null } : {})]),
    });
    await login(page);
    await inspect(page);
    await access(page).getByRole('button', { name: 'Check current access', exact: true }).click();
    await expect(access(page)).toContainText(expected);
    await expect(detail(page)).toContainText('Settlement recorded');
    if (granted) {
      await expect(access(page).locator('time[datetime="' + currentWindow + '"]')).toBeVisible();
      await expect(detail(page).locator('time[datetime="' + originalWindow + '"]')).toBeVisible();
      await expect(access(page)).toContainText('A grant does not reveal renewal or cancellation status.');
    } else {
      expect(capture.body.error.data.cause.code).toMatch(/^market\./);
      expect(capture.body.error.data).not.toHaveProperty('intafacedCode');
      await expect(access(page)).toContainText(capture.body.error.data.cause.code);
      await expect(access(page)).not.toContainText('This service is not connected');
      await expect(access(page)).not.toContainText('Access granted by the service');
    }
    expect(marketWrites(calls)).toEqual([]);
    expect(calls.errors).toEqual([]);
  });
for (const locale of ['es', 'fr'])
  test('native ' + locale + ' copy and original values remain correctly scoped without reload', async ({ page }) => {
    const calls = await network(page);
    await login(page);
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await page.locator('.person-trigger').click();
    await page.getByRole('dialog').locator('a[href="/view"]').click();
    await page
      .locator('select')
      .filter({ has: page.locator('option[value="es"]') })
      .selectOption(locale);
    await page.evaluate(() => {
      history.pushState(null, '', '/market');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(room(page)).toHaveAttribute('lang', locale);
    await room(page).locator('button[aria-pressed]').first().click();
    await room(page).locator('.market-purchases-access > button').click();
    await expect(room(page).locator('.market-purchases-access-outcome')).toBeVisible();
    for (const el of await room(page).locator('[data-i18n^="more.market-purchases."]').all())
      await expect(el).toHaveAttribute('lang', locale);
    await expect(room(page).getByText(listing, { exact: true })).toHaveAttribute('lang', 'zxx');
    await expect(room(page)).toContainText('0.000000000000000001');
    await expect(room(page)).toContainText('USDT');
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    expect(marketWrites(calls)).toEqual([]);
    expect(calls.errors).toEqual([]);
  });
test('existing cancellation review preserves listing payload and remaining paid current window without refund', async ({ page }) => {
  const proof = JSON.parse(readFileSync(process.env.MARKET_SERVICE_PROBE, 'utf8')),
    remaining = proof.cases.cancelledRemainingPaid;
  const calls = await network(page, {
    subscriptionAccess: (route) => route.fulfill({ status: remaining.status, json: remaining.body }),
    cancelSubscription: (route, input) =>
      reply(route, { listingId: input.listingId, buyerId: owner, cancelledAt: '2026-10-09T11:00:00.000Z' }),
  });
  await login(page);
  await room(page).getByRole('button', { name: 'Cancel access', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Cancel subscription access', exact: true });
  await expect(modal).toContainText(listing);
  await expect(modal).toContainText('does not issue a refund');
  await modal.getByRole('button', { name: 'Cancel access', exact: true }).click();
  await expect(page.getByText('Access cancellation recorded', { exact: true })).toBeVisible();
  await inspect(page);
  await access(page).getByRole('button', { name: 'Check current access', exact: true }).click();
  await expect(access(page)).toContainText('Access granted by the service');
  expect(marketWrites(calls)).toEqual([{ proc: 'cancelSubscription', input: { listingId: listing } }]);
  expect(calls.errors).toEqual([]);
});
test('existing native purchase confirmation and exact original recovery behavior remain available', async ({ page }) => {
  let bought = null;
  const offer = {
    id: listing,
    vendorId: vendor,
    title: 'Original seller listing',
    description: 'Original seller description',
    offerType: 'one_time',
    assetId: 'USDT',
    price: '1',
    periodSeconds: null,
    status: 'active',
    createdAt: at,
    updatedAt: at,
  };
  const calls = await network(page, {
    listings: (route) => reply(route, [offer]),
    myPurchases: (route) => reply(route, bought ? [bought] : []),
    purchase: (route, input) => {
      bought = row({ id: input.purchaseId, price: '1', accessUntil: null });
      return reply(route, bought);
    },
  });
  await login(page);
  await page.getByRole('button', { name: 'Buy Original seller listing', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Review purchase', exact: true });
  await expect(modal).toContainText('1 USDT');
  await modal.getByRole('button', { name: 'Confirm purchase', exact: true }).click();
  await expect(page.getByText('Purchase outcome received. Read its settlement status below.', { exact: true })).toBeVisible();
  await inspect(page);
  await expect(detail(page)).toContainText('Settlement recorded');
  await expect(detail(page)).toContainText(bought.id);
  expect(marketWrites(calls)).toHaveLength(1);
  expect(marketWrites(calls)[0].input).toEqual({ listingId: listing, purchaseId: bought.id });
  expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBeNull();
  expect(calls.errors).toEqual([]);
});
