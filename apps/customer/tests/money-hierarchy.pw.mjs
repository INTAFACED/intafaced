import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const evidence = process.env.MONEY_HIERARCHY_EVIDENCE || '/tmp/intafaced-money-hierarchy';
mkdirSync(evidence, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const reference = '77777777-7777-4777-8777-777777777777';
const bankKey = 'intafaced.customer.bank-unconfirmed.v1:' + owner;
const original = ` [ ${JSON.stringify({ reference, title: 'Original transfer', procedure: 'transfers.create', recordRefs: { transferId: reference, fromSpaceId: sourceId } })} ] `;
const preferencesKey = 'intafaced.customer.view.v1';
const balances = {
  timestamp: 1791621900000,
  datetime: '2026-10-10T08:45:00.000Z',
  balances: {
    USDT: { total: '8000', free: '7500', used: '500' },
    BTC: { total: '0.05', free: '0.05', used: '0' },
    ETH: { total: '2', free: '2', used: '0' },
  },
};
const row = (page, asset) => page.locator(`a.money-holding[href="/portfolio/${asset}"]`);
const home = (page) => page.locator('.money-home');
const pause = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
async function network(context) {
  const state = {
    reads: [],
    writes: [],
    errors: [],
    cancelled: [],
    balanceStatus: 200,
    data: structuredClone(balances),
    bankAvailable: true,
    held: null,
    sendStatus: 200,
  };
  const observe = (page) => page.on('pageerror', (error) => state.errors.push(error.message));
  context.pages().forEach(observe);
  context.on('page', observe);
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const reply = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (procedure === 'auth.login')
      return reply({
        userId: owner,
        accessToken: 'isolated-money-owner',
        refreshToken: 'isolated-money-refresh',
        expiresAt: '2027-10-10T00:00:00Z',
      });
    if (procedure === 'auth.logout') return reply({ ok: true });
    if (request.method() !== 'GET') {
      state.writes.push({ procedure, body: request.postDataJSON() });
      if (procedure === 'transfers.toUser' && state.sendStatus === 200)
        return reply({ ledgerTxId: 'isolated-money-transfer', amount: state.writes.at(-1).body.amount });
      return route.fulfill({
        status: state.sendStatus === 200 ? 503 : state.sendStatus,
        json: { message: 'Isolated write outcome unavailable' },
      });
    }
    state.reads.push({ path: url.pathname, input: JSON.parse(url.searchParams.get('input') || 'null') });
    if (url.pathname.endsWith('/account/balance')) {
      const status = state.balanceStatus,
        data = structuredClone(state.data),
        held = state.held;
      if (held) await held.promise;
      try {
        return route.fulfill({ status, json: status === 200 ? data : { message: 'Isolated balance read failed' } });
      } catch (error) {
        state.cancelled.push(error.message);
        return;
      }
    }
    if (procedure === 'spaces.list' && state.bankAvailable)
      return reply([
        {
          id: sourceId,
          assetId: 'USDT',
          kind: 'primary',
          name: 'Main',
          goalTarget: null,
          lockedUntil: null,
          balance: '7500',
          ledgerAccount: { ownerType: 'user', ownerId: owner, assetId: 'USDT', kind: 'available' },
        },
      ]);
    if (procedure === 'spaces.unnamed' && state.bankAvailable) return reply([{ assetId: 'USDT', balance: '7500' }]);
    return route.fulfill({
      status: 503,
      json: { message: url.pathname.endsWith('/markets') ? 'Published markets are unavailable.' : 'Isolated unrelated source unavailable' },
    });
  });
  return state;
}
async function login(page, destination = '/portfolio') {
  await page.goto('/login?redirect=' + encodeURIComponent(destination));
  await page.locator('input[autocomplete="username"]').fill('money@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form button[type="submit"]').click();
  await expect.poll(() => page.evaluate(() => location.pathname + location.search + location.hash)).toBe(destination);
  await expect(page.getByRole('heading', { name: 'Money', exact: true })).toBeVisible();
}
async function fit(page, name, state) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.errors).toEqual([]);
  const observe = () =>
    page.evaluate(() => {
      const rect = (element) =>
        element
          ? Object.fromEntries(['x', 'y', 'width', 'height', 'top', 'bottom'].map((key) => [key, element.getBoundingClientRect()[key]]))
          : null;
      const focused = document.activeElement;
      const skip = document.querySelector('a[href="#main"]');
      const quantity = document.querySelector('.money-holding-values strong');
      return {
        viewport: { width: innerWidth, height: innerHeight, scrollY, documentWidth: document.documentElement.scrollWidth },
        focused: {
          tag: focused?.tagName,
          id: focused?.id,
          href: focused?.getAttribute('href'),
          focusVisible: focused?.matches(':focus-visible'),
          rect: rect(focused),
        },
        skip: skip
          ? {
              rect: rect(skip),
              focused: skip === focused,
              transform: getComputedStyle(skip).transform,
              position: getComputedStyle(skip).position,
            }
          : null,
        assets: rect(document.querySelector('.money-overview-lane')),
        primaryActions: rect(document.querySelector('.money-primary-actions')),
        quantityFont: quantity ? { family: getComputedStyle(quantity).fontFamily, size: getComputedStyle(quantity).fontSize } : null,
        fontsStatus: document.fonts.status,
      };
    });
  const beforeWhole = await observe();
  await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
  const afterWhole = await observe();
  if (await home(page).locator('.money-overview-lane').count())
    await home(page)
      .locator('.money-overview-lane')
      .screenshot({ path: `${evidence}/${name}-assets.png` });
  writeFileSync(`${evidence}/${name}-geometry.json`, JSON.stringify({ beforeWhole, afterWhole, afterAssets: await observe() }, null, 2));
  writeFileSync(
    `${evidence}/${name}.json`,
    JSON.stringify(state, (key, value) => (key === 'held' ? undefined : value), 2),
  );
}

test('quantity hierarchy retains held values and primary actions before holdings at all four widths', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await fit(page, `populated-${width}`, state);
    const hierarchy = await page.evaluate(() => {
      const quantity = document.querySelector('.money-holding-values strong');
      const missing = document.querySelector('.money-total');
      const send = document.querySelector('a[href="/pay/send"]');
      const holding = document.querySelector('.money-holding');
      return {
        quantityFont: parseFloat(getComputedStyle(quantity).fontSize),
        missingFont: parseFloat(getComputedStyle(missing).fontSize),
        actionsFirst: Boolean(send.compareDocumentPosition(holding) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    expect(hierarchy.quantityFont).toBeGreaterThan(hierarchy.missingFont);
    await expect(row(page, 'USDT').locator('dd').last()).toHaveText('500 USDT');
    expect(hierarchy.actionsFirst).toBe(true);
    await expect(home(page).locator('a[href="/bank"]')).toHaveCount(1);
  }
  expect(state.writes).toEqual([]);
});

test('privacy masks quantity available and held including zero without changing routes or currency truth', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await page.setViewportSize({ width: 390, height: 1000 });
  await home(page).getByRole('button', { name: 'Hide amounts', exact: true }).click();
  for (const asset of ['USDT', 'BTC', 'ETH']) {
    await expect(row(page, asset).locator('.money-quantity-value')).toHaveText('••••');
    await expect(row(page, asset).locator('dd')).toHaveText(['••••', '••••']);
  }
  await home(page).getByRole('combobox', { name: 'Display currency', exact: true }).selectOption('BTC');
  await expect(home(page).getByText('Combined value unavailable', { exact: true })).toBeVisible();
  await fit(page, 'hidden-390', state);
  await home(page).getByRole('button', { name: 'Show amounts', exact: true }).click();
  await expect(row(page, 'BTC')).toContainText('0 BTC');
  expect(state.writes).toEqual([]);
});

test('returned zero differs from empty loading and failed reads; current refresh recovers without a fabricated timestamp', async ({
  page,
  context,
}) => {
  const state = await network(context);
  state.data.balances = { USDT: { free: '0', used: '0', total: '0' } };
  await login(page);
  await expect(row(page, 'USDT').locator('.money-quantity-value')).toHaveText('0');
  await page.setViewportSize({ width: 390, height: 1000 });
  await fit(page, 'zero-390', state);
  state.data.balances = {};
  await home(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(home(page).getByText('No account balances returned', { exact: true })).toBeVisible();
  await expect(home(page).locator('.money-holding')).toHaveCount(0);
  await fit(page, 'empty-390', state);
  state.balanceStatus = 503;
  state.bankAvailable = false;
  await home(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(home(page).getByText('Holdings could not be loaded.', { exact: true })).toBeVisible();
  await expect(home(page).locator('time')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 1000 });
  await fit(page, 'failure-320', state);
  state.balanceStatus = 200;
  state.data = structuredClone(balances);
  state.held = pause();
  await home(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(home(page).locator('.money-holding')).toHaveCount(0);
  await expect(home(page).locator('a[href="/pay/send"]')).toBeVisible();
  await fit(page, 'loading-320', state);
  state.held.release();
  state.held = null;
  await expect(row(page, 'USDT')).toContainText('8,000');
  expect(state.writes).toEqual([]);
});

test('failed balance fallback exposes available only and keeps original raw recovery through refresh and reload', async ({
  page,
  context,
}) => {
  const state = await network(context);
  state.balanceStatus = 503;
  await page.goto('/login');
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: bankKey, raw: original });
  await login(page);
  await page.setViewportSize({ width: 320, height: 1000 });
  await expect(row(page, 'USDT')).toContainText('7,500');
  await expect(row(page, 'USDT')).toContainText('Available projection only');
  await expect(row(page, 'USDT').locator('dd').last()).toHaveText('Unavailable');
  await expect(home(page).locator('time')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        document.querySelector('#bank-unconfirmed').compareDocumentPosition(document.querySelector('.money-home')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBeTruthy();
  await home(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(row(page, 'USDT')).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), bankKey)).toBe(original);
  await page.reload();
  await expect(page.locator('a.button[href^="/login?redirect="]')).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), bankKey)).toBe(original);
  await page.locator('a.button[href^="/login?redirect="]').click();
  await page.locator('input[autocomplete="username"]').fill('money@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form button[type="submit"]').click();
  await expect(row(page, 'USDT')).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), bankKey)).toBe(original);
  await fit(page, 'original-fallback-320', state);
  await page.locator('#bank-unconfirmed a[href="/support"]').click();
  await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/support');
  expect(await page.evaluate((key) => localStorage.getItem(key), bankKey)).toBe(original);
  expect(state.writes).toEqual([]);
});

test('all nine Bank and funding destinations stay reachable from Money with no financial write', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await page.setViewportSize({ width: 390, height: 1000 });
  for (const href of [
    '/bank',
    '/bank/spaces',
    '/bank/transfers',
    '/bank/earn',
    '/bank/loans',
    '/bank/analytics',
    '/bank/cards',
    '/bank/ramps',
    '/bank/business',
    '/uc/recharge',
    '/uc/withdraw',
    '/uc/withdraw/address',
    '/uc/record',
  ]) {
    const link = home(page).locator(`a[href="${href}"]`).first();
    await link.scrollIntoViewIfNeeded();
    await link.click();
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe(href);
    await page.goBack();
    await expect(row(page, 'USDT')).toBeVisible();
  }
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('holding context reaches real Trade failure and Send exact reviewed outcome; Receive stays internal', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await row(page, 'USDT').click();
  await expect(page.getByRole('heading', { name: 'USDT', exact: true })).toBeVisible();
  await page.locator('a[href="/exchange?asset=USDT&side=buy"]').click();
  await expect.poll(() => page.evaluate(() => location.search)).toBe('?asset=USDT&side=buy');
  await expect(page.getByText('Published markets are unavailable.', { exact: true }).first()).toBeVisible();
  await page.goBack();
  await page.locator('a[href="/pay/send?asset=USDT"]').click();
  await page.locator('input[name="recipient"]').fill('33333333-3333-4333-8333-333333333333');
  await page.locator('input[name="send-amount"]').fill('0.000000000000000001');
  await page.locator('form.pay-form button[type="submit"]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(state.writes).toEqual([]);
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect(page.getByRole('heading', { name: 'Transfer confirmed', exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body).toMatchObject({ fromSpaceId: sourceId, amount: '0.000000000000000001' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Personal Pay', exact: true }).locator('a[href="/pay/receive"]').click();
  await expect(page.locator('.pay-account-id')).toHaveText(owner);
  expect(state.writes).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test('unknown Send original survives returning to Money and refreshing quantities without replay', async ({ page, context }) => {
  const state = await network(context);
  state.sendStatus = 503;
  await login(page);
  await row(page, 'USDT').click();
  await page.locator('a[href="/pay/send?asset=USDT"]').click();
  await page.locator('input[name="recipient"]').fill('33333333-3333-4333-8333-333333333333');
  await page.locator('input[name="send-amount"]').fill('0.000000000000000001');
  await page.locator('form.pay-form button[type="submit"]').click();
  await page.locator('.pay-transfer-actions button:last-child').click();
  await expect.poll(() => state.writes.length).toBe(1);
  const key = `pay.unresolved:${owner}:send`;
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), key)).toBeTruthy();
  const raw = await page.evaluate((key) => localStorage.getItem(key), key);
  expect(raw).not.toContain('0.000000000000000001');
  await page.goBack();
  await page.locator('a[href="/portfolio"]').click();
  await expect(row(page, 'USDT')).toBeVisible();
  state.data.balances.USDT = { total: '7000', free: '6500', used: '500' };
  await home(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(row(page, 'USDT').locator('.money-quantity-value')).toHaveText('7,000');
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
  await home(page).locator('a[href="/pay/send"]').click();
  await expect(page.locator('form.pay-form button[type="submit"]')).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test('localized response clock and exact long quantities fit phones with neutral unknown identity', async ({ page, context }) => {
  const state = await network(context);
  const long = '9999999999999999999.000000000000000001';
  const asset = 'UNFAMILIAR-LONG-ASSET';
  state.data.balances[asset] = { total: long, free: long, used: '0' };
  for (const [language, width, timeZone] of [
    ['es', 390, 'UTC+8'],
    ['fr', 320, 'UTC'],
    ['cy', 320, 'device'],
  ]) {
    await page.addInitScript(({ key, language, timeZone }) => localStorage.setItem(key, JSON.stringify({ language, timeZone })), {
      key: preferencesKey,
      language,
      timeZone,
    });
    await page.goto('/login?redirect=%2Fportfolio');
    if (await page.locator('input[autocomplete="username"]').count()) {
      await page.locator('input[autocomplete="username"]').fill('money@example.invalid');
      await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
      await page.locator('form button[type="submit"]').click();
    }
    await expect(row(page, asset)).toBeVisible();
    await page.setViewportSize({ width, height: 1000 });
    await expect(row(page, asset).locator('.money-quantity-value')).toHaveText('9,999,999,999,999,999,999.000000000000000001');
    await expect(row(page, asset).locator('svg')).toHaveCount(1);
    const expected = await page.evaluate(
      ({ language, timeZone }) =>
        new Intl.DateTimeFormat(language === 'cy' ? 'en' : language, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short',
          ...(timeZone === 'device' ? {} : { timeZone: timeZone === 'UTC+8' ? 'Etc/GMT-8' : 'UTC' }),
        }).format(new Date('2026-10-10T08:45:00.000Z')),
      { language, timeZone },
    );
    await expect(home(page).locator('time')).toContainText(expected);
    await expect(home(page).locator('time')).toHaveAttribute('lang', language === 'cy' ? 'en' : language);
    await fit(page, `${language}-long-${width}`, state);
  }
  expect(state.writes).toEqual([]);
});

test('keyboard primary action remains above fixed navigation and sends no value by navigation alone', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await page.setViewportSize({ width: 320, height: 1000 });
  const link = home(page).locator('a[href="/pay/send"]');
  await link.focus();
  await expect(link).toBeFocused();
  const rect = await link.boundingBox();
  expect(rect.y + rect.height).toBeLessThan(916);
  const focusedDestinations = [];
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element.closest('.money-home') || element.tagName !== 'A') return null;
      const rect = element.getBoundingClientRect();
      return { href: element.getAttribute('href'), top: rect.top, bottom: rect.bottom };
    });
    if (!focused) continue;
    expect(focused.top).toBeGreaterThanOrEqual(0);
    expect(focused.bottom).toBeLessThanOrEqual(932);
    focusedDestinations.push(focused.href);
    if (focused.href === '/uc/withdraw/address') break;
  }
  expect(focusedDestinations).toContain('/portfolio/USDT');
  expect(focusedDestinations).toContain('/bank/business');
  expect(focusedDestinations.at(-1)).toBe('/uc/withdraw/address');
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('input[name="recipient"]')).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('guest and consequential401 retain complete Money auth destination without private quantities', async ({ page, context }) => {
  const state = await network(context),
    destination = '/portfolio?view=assets#original';
  await page.goto(destination);
  await expect(page.locator('.money-holding')).toHaveCount(0);
  await page.locator('a.button[href^="/login?redirect="]').click();
  await page.locator('form a[href^="/register?redirect="]').click();
  await page.locator('form a[href^="/login?redirect="]').click();
  await page.locator('input[autocomplete="username"]').fill('money@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form button[type="submit"]').click();
  await expect.poll(() => page.evaluate(() => location.pathname + location.search + location.hash)).toBe(destination);
  await expect(row(page, 'USDT')).toBeVisible();
  state.balanceStatus = 401;
  await home(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.money-holding')).toHaveCount(0);
  await expect(page.locator('a.button[href^="/login?redirect="]')).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});
