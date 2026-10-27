import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const dir = process.env.KEYBOARD_FOCUS_EVIDENCE || '/tmp/intafaced-keyboard-focus';
mkdirSync(dir, { recursive: true });
// Native login and owned commerce responses use the existing Market purchase fixture.
const owner = '11111111-1111-4111-8111-111111111111',
  listing = '33333333-3333-4333-8333-333333333333',
  original = '44444444-4444-4444-8444-444444444444',
  ledger = '55555555-5555-4555-8555-555555555555',
  vendor = '66666666-6666-4666-8666-666666666666',
  seller = '77777777-7777-4777-8777-777777777777';
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
  ...extra,
});
const grant = (extra = {}) => ({ granted: true, listingId: listing, buyerId: owner, accessUntil: currentWindow, ...extra });
const reply = (route, data) => route.fulfill({ status: 200, json: { result: { data } } });
const failure = (route) =>
  route.fulfill({
    status: 503,
    json: { error: { message: 'Original English market read unavailable', data: { code: 'acceptance.unavailable' } } },
  });
const room = (page) => page.getByTestId('market-purchases');
const detail = (page) => room(page).getByRole('region', { name: 'Selected original purchase', exact: true });
const access = (page) => room(page).getByRole('region', { name: 'Current subscription access', exact: true });
async function network(page, handlers = {}, identity = () => owner) {
  const calls = { reads: [], writes: [], errors: [] };
  page.on('pageerror', (e) => calls.errors.push(e.message));
  page.context().on('page', (tab) => tab.on('pageerror', (e) => calls.errors.push(e.message)));
  await page.context().route('**/api/**', async (route) => {
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
async function frames(page) {
  await page.evaluate(async () => {
    for (let frame = 0; frame < 6; frame++) await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}
async function geometry(target) {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect(),
      nav = document.querySelector('[data-testid="mobile-doors"]')?.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      top: r.top,
      bottom: r.bottom,
      height: r.height,
      viewport: innerHeight,
      usableBottom: nav?.height ? nav.top : innerHeight,
      active: document.activeElement === el,
      focusVisible: el.matches(':focus-visible'),
      hit: el.contains(hit),
      hitText: hit?.textContent,
      scrollY,
    };
  });
}
for (const startingWidth of [320, 390, 1440])
  test('native access Tab remains visible when resizing from ' + startingWidth, async ({ page }) => {
    const calls = await network(page);
    await page.setViewportSize({ width: startingWidth, height: 1000 });
    await login(page);
    await inspect(page);
    const button = access(page).getByRole('button', { name: 'Check current access', exact: true });
    await detail(page).locator('summary').focus();
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    const originalButton = await button.elementHandle();
    await frames(page);
    const before = await geometry(button);
    expect(before.hit).toBe(true);
    await page.setViewportSize({ width: 320, height: 1000 });
    await frames(page);
    const after = await geometry(button);
    writeFileSync(dir + '/native-access-' + startingWidth + '.json', JSON.stringify({ before, after }, null, 2));
    await page.screenshot({ path: dir + '/native-access-' + startingWidth + '.png' });
    expect(after.active).toBe(true);
    expect(await originalButton.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(after.focusVisible).toBe(true);
    expect(after.hit).toBe(true);
    expect(after.top).toBeGreaterThanOrEqual(0);
    expect(after.bottom).toBeLessThanOrEqual(after.usableBottom);
    expect(after.height).toBeGreaterThanOrEqual(44);
    await expect(detail(page).getByTestId('market-purchases-reference')).toHaveText(original);
    expect(calls.reads.filter((x) => x.proc === 'subscriptionAccess')).toEqual([]);
    expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBeNull();
    await page.keyboard.press('Enter');
    await expect(access(page)).toContainText('Access granted by the service');
    expect(calls.reads.filter((x) => x.proc === 'subscriptionAccess')).toEqual([
      { proc: 'subscriptionAccess', input: { listingId: listing } },
    ]);
    await expect(detail(page).getByTestId('market-purchases-reference')).toHaveText(original);
    expect(marketWrites(calls)).toEqual([]);
    expect(calls.errors).toEqual([]);
  });

test('native exact price keeps its horizontal inspection and focus across resize', async ({ page }) => {
  const calls = await network(page, { myPurchases: (route) => reply(route, [row({ price: '99999999999999999999.999999999999999999' })]) });
  await page.setViewportSize({ width: 390, height: 1000 });
  await login(page);
  await inspect(page);
  const price = detail(page).getByRole('group', { name: 'Original purchase price', exact: true });
  await detail(page).locator('summary').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(price).toBeFocused();
  const originalPrice = await price.elementHandle();
  await price.press('ArrowRight');
  await expect.poll(() => price.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  // Native ArrowRight scrolling animates; compare the settled position.
  await price.evaluate(async (el) => {
    let last = el.scrollLeft,
      stable = 0;
    for (let frame = 0; frame < 30 && stable < 4; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      stable = el.scrollLeft === last ? stable + 1 : 0;
      last = el.scrollLeft;
    }
  });
  const left = await price.evaluate((el) => el.scrollLeft);
  await page.setViewportSize({ width: 320, height: 1000 });
  await frames(page);
  await expect(price).toBeFocused();
  expect(await originalPrice.evaluate((el) => el === document.activeElement)).toBe(true);
  expect(await price.evaluate((el) => el.scrollLeft)).toBe(left);
  await expect(price).toHaveText('99,999,999,999,999,999,999.999999999999999999');
  expect((await geometry(price)).hit).toBe(true);
  expect(calls.errors).toEqual([]);
  expect(marketWrites(calls)).toEqual([]);
});

test('pointer focus and mobile navigation keep native scroll and destinations', async ({ page }) => {
  const calls = await network(page);
  await page.setViewportSize({ width: 390, height: 1000 });
  await login(page);
  await inspect(page);
  const summary = detail(page).locator('summary');
  await summary.click();
  await expect(summary).toBeFocused();
  const before = await page.evaluate(() => scrollY);
  await page.setViewportSize({ width: 320, height: 1000 });
  await frames(page);
  expect(await page.evaluate(() => scrollY)).toBe(before);
  await expect(summary).toBeFocused();
  const doors = page.locator('[data-testid="mobile-doors"] a');
  const hrefs = await doors.evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(hrefs).toEqual(['/money', '/exchange', '/pay', '/more']);
  await doors.first().focus();
  await page.keyboard.press('Tab');
  await expect(doors.nth(1)).toBeFocused();
  const navScroll = await page.evaluate(() => scrollY);
  await page.setViewportSize({ width: 390, height: 1000 });
  await frames(page);
  expect(await page.evaluate(() => scrollY)).toBe(navScroll);
  await expect(doors.nth(1)).toBeFocused();
  expect(await doors.evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual(hrefs);
  expect(marketWrites(calls)).toEqual([]);
  expect(calls.errors).toEqual([]);
});

test('native search dialog retains focus and selection without shell scroll calls', async ({ page, context }) => {
  const calls = await network(page);
  await page.setViewportSize({ width: 390, height: 1000 });
  await login(page);
  await inspect(page);
  await detail(page).locator('summary').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog'),
    input = dialog.locator('input[name="global-search"]');
  await expect(input).toBeFocused();
  const originalInput = await input.elementHandle();
  await input.fill('bank');
  await input.press('ArrowLeft');
  await input.press('Shift+ArrowLeft');
  const before = await input.evaluate((el) => ({ start: el.selectionStart, end: el.selectionEnd }));
  expect(before.start).toBeLessThan(before.end);
  const backgroundBefore = await page.evaluate(() => {
    const native = HTMLElement.prototype.scrollIntoView;
    window.__focusScrollCalls = [];
    HTMLElement.prototype.scrollIntoView = function (...args) {
      window.__focusScrollCalls.push({ tag: this.tagName, className: this.className });
      return native.apply(this, args);
    };
    return scrollY;
  });
  await page.setViewportSize({ width: 320, height: 1000 });
  await frames(page);
  await expect(input).toBeFocused();
  expect(await originalInput.evaluate((el) => el === document.activeElement)).toBe(true);
  expect(await input.evaluate((el) => ({ start: el.selectionStart, end: el.selectionEnd }))).toEqual(before);
  expect(await page.evaluate(() => window.__focusScrollCalls)).toEqual([]);
  // Chromium may scroll its modal background on resize even without the hook.
  writeFileSync(
    dir + '/native-dialog-resize.json',
    JSON.stringify(
      {
        backgroundBefore,
        backgroundAfter: await page.evaluate(() => scrollY),
        selection: before,
        shellScrollCalls: [],
      },
      null,
      2,
    ),
  );
  await input.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(access(page).getByRole('button', { name: 'Check current access', exact: true })).toBeFocused();
  const tab = await context.newPage();
  await tab.goto('/market');
  await expect(tab.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
  await tab.close();
  expect(calls.errors).toEqual([]);
  expect(calls.reads.filter((x) => x.proc === 'subscriptionAccess')).toEqual([]);
  expect(marketWrites(calls)).toEqual([]);
});
