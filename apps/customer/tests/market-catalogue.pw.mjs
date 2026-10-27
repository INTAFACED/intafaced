import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const dir = process.env.MARKET_CATALOGUE_EVIDENCE || '/tmp/intafaced-market-catalogue';
mkdirSync(dir, { recursive: true });
const catalogs = JSON.parse(readFileSync(process.env.MARKET_CATALOGUE_CATALOGS, 'utf8'));
const t = (locale, key) => catalogs[locale]['market.' + key];
const owner = '11111111-1111-4111-8111-111111111111',
  vendorId = '66666666-6666-4666-8666-666666666666';
const at = '2026-10-09T10:00:00.000Z',
  provider = 'Original provider explanation: catalogue read refused.';
const nano = '0.000000000000000001',
  maximum = '99999999999999999999.999999999999999999';
const listing = (index, extra = {}) => ({
  id: String(index + 1).padStart(8, '0') + '-3333-4333-8333-333333333333',
  vendorId,
  title:
    index === 2
      ? 'Original longer listing title with its own source bytes and no invented performance claim'
      : 'Original listing ' + (index + 1),
  description: 'Original seller description ' + (index + 1) + ': inspect the paid listing terms before sending.',
  offerType: index % 2 ? 'subscription' : 'one_time',
  assetId: 'USDT',
  price: '12.5',
  periodSeconds: index % 2 ? 3600 : null,
  status: 'active',
  createdAt: at,
  updatedAt: at,
  ...extra,
});
async function network(context, rows, { mine = false, fail = false } = {}) {
  const calls = { reads: [], writes: [], errors: [] };
  let failed = fail;
  const observe = (page) => page.on('pageerror', (e) => calls.errors.push(e.message));
  for (const page of context.pages()) observe(page);
  context.on('page', observe);
  await context.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = req.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : req.postDataJSON();
    const reply = (data) => route.fulfill({ json: { result: { data } } });
    if (procedure === 'auth.login')
      return reply({
        userId: owner,
        accessToken: 'isolated-catalogue-access',
        refreshToken: 'isolated-catalogue-refresh',
        expiresAt: '2027-10-09T00:00:00Z',
      });
    if (procedure === 'auth.logout') return reply({ ok: true });
    if (req.method() === 'GET') {
      calls.reads.push({ procedure, input });
      if (procedure === 'listings' || procedure === 'myListings') {
        if (failed) {
          failed = false;
          return route.fulfill({ status: 412, json: { message: provider } });
        }
        return reply(rows);
      }
      if (procedure === 'myPurchases' || procedure === 'webauthn.list') return reply([]);
      if (procedure === 'mine')
        return reply(
          mine
            ? {
                id: vendorId,
                userId: owner,
                displayName: 'Original seller name',
                description: 'Original seller description',
                status: 'approved',
                createdAt: at,
                updatedAt: at,
              }
            : null,
        );
      if (procedure === 'slots')
        return reply({ vendorId, status: 'approved', tier: 'published-tier', capacity: 5, held: 1, usable: 4, slots: [] });
      if (procedure === 'commerceProgramme') return reply({ commissionBps: 500, commissionConfigured: true });
      return route.fulfill({ status: 503, json: { message: provider } });
    }
    calls.writes.push({ procedure, input });
    return route.fulfill({ status: 503, json: { message: 'Isolated catalogue proof refuses writes' } });
  });
  return calls;
}
async function login(page, path) {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.getByLabel('Email or handle', { exact: true }).fill('isolated-market-catalogue');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(path + '$'));
}
async function locale(view, page, language) {
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption(language);
  await expect(page.locator('html')).toHaveAttribute('lang', language);
}
async function capture(page, name) {
  await page.screenshot({ path: dir + '/' + name + '.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function focusHit(control) {
  await control.locator('..').locator('.market-purchases-exact-price').focus();
  await control.page().keyboard.press('Tab');
  await expect(control).toBeFocused();
  await expect
    .poll(() =>
      control.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }),
    )
    .toBe(true);
}
for (const count of [1, 3, 7])
  for (const width of [320, 390, 768, 1440]) {
    test('catalogue layout ' + count + ' listings at ' + width, async ({ page, context }) => {
      const rows = Array.from({ length: count }, (_, i) => listing(i)),
        calls = await network(context, rows);
      await page.setViewportSize({ width, height: 1000 });
      await login(page, '/market');
      const articles = page.locator('article.more-room-link');
      await expect(articles).toHaveCount(count);
      const before = await articles.first().evaluate((el) => {
        const parent = el.parentElement,
          r = el.getBoundingClientRect(),
          p = parent.getBoundingClientRect();
        return {
          row: { x: r.x, width: r.width },
          parent: { x: p.x, width: p.width },
          columns: getComputedStyle(parent).gridTemplateColumns,
          background: getComputedStyle(parent).backgroundColor,
          price: getComputedStyle(el.querySelector('.numeric')).fontSize,
        };
      });
      writeFileSync(dir + '/layout-' + count + '-' + width + '.json', JSON.stringify(before, null, 2));
      await capture(page, 'layout-' + count + '-' + width);
      expect(before.row.width).toBeCloseTo(before.parent.width, 0);
      for (let i = 0; i < count; i++) {
        const article = articles.nth(i);
        await expect(article.getByRole('heading', { name: rows[i].title, exact: true })).toHaveAttribute('lang', 'und');
        await expect(article.getByText(vendorId, { exact: true })).toHaveAttribute('lang', 'zxx');
        await expect(article.getByText(rows[i].offerType, { exact: true })).toHaveAttribute('lang', 'zxx');
        await expect(article).toContainText(
          rows[i].periodSeconds ? t('en', 'seconds.one.paid.period').replace('{seconds}', '3,600') : t('en', 'one.time.purchase'),
        );
        const price = article.getByRole('group', { name: t('en', 'price'), exact: true });
        await expect(price).toHaveText('12.5');
        expect(await price.locator('strong').evaluate((el) => getComputedStyle(el).marginBottom)).toBe('0px');
        const originalBackground = await article.evaluate((el) => getComputedStyle(el).backgroundColor);
        await article.hover();
        expect(await article.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(originalBackground);
      }
      await focusHit(articles.last().getByRole('button'));
      expect(calls.writes).toEqual([]);
      expect(calls.errors).toEqual([]);
      if (count === 3 && [320, 1440].includes(width)) {
        const axe = await new AxeBuilder({ page }).include('#main').analyze();
        writeFileSync(dir + '/axe-' + width + '.json', JSON.stringify(axe, null, 2));
        expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);
      }
    });
  }
for (const width of [320, 390, 768, 1440])
  test('own listings keep seller and archive context at ' + width, async ({ page, context }) => {
    const rows = [listing(0), listing(1, { status: 'archived' })],
      calls = await network(context, rows, { mine: true });
    await page.setViewportSize({ width, height: 1000 });
    await login(page, '/market/mine');
    const articles = page.locator('article.more-room-link');
    await expect(articles).toHaveCount(2);
    const first = articles.first(),
      second = articles.last();
    await expect(first).toContainText('active');
    await expect(second).toContainText('archived');
    await expect(second.getByRole('button', { name: t('en', 'archive'), exact: true })).toBeDisabled();
    await expect(page.getByText('Original seller name', { exact: true })).toBeVisible();
    expect(await first.evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(
      await page.getByRole('heading', { name: t('en', 'create.a.listing'), exact: true }).evaluate((el) => el.getBoundingClientRect().top),
    );
    const nav = page.getByRole('navigation', { name: t('en', 'catalogue'), exact: true });
    await expect(nav.getByRole('link', { name: t('en', 'my.listings'), exact: true })).toHaveAttribute('aria-current', 'page');
    await capture(page, 'mine-' + width);
    await focusHit(first.getByRole('button'));
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(rows[0].title);
    await expect(dialog.getByText(vendorId, { exact: true })).toHaveAttribute('lang', 'zxx');
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    expect(calls.writes).toEqual([]);
    expect(calls.errors).toEqual([]);
  });
for (const width of [320, 390])
  for (const amount of [nano, maximum])
    test('original catalogue price survives View at ' + width + ' ' + amount, async ({ page, context }) => {
      const displayed = amount === nano ? nano : '99,999,999,999,999,999,999.999999999999999999';
      const row = listing(1, { price: amount, assetId: 'LONG_NATIVE_ASSET_IDENTIFIER_123' }),
        calls = await network(context, [row]);
      await page.setViewportSize({ width, height: 1000 });
      await login(page, '/market');
      const view = await context.newPage();
      await login(view, '/view');
      const article = page.locator('article.more-room-link'),
        price = article.locator('.market-purchases-exact-price');
      await expect(price).toHaveAttribute('aria-label', t('en', 'price'));
      await expect(price).toHaveText(displayed);
      const original = await price.elementHandle();
      await price.focus();
      for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
      await expect.poll(() => price.evaluate((el) => el.scrollLeft)).toBe(await price.evaluate((el) => el.scrollWidth - el.clientWidth));
      const offset = await price.evaluate((el) => el.scrollLeft),
        origin = await page.evaluate(() => performance.timeOrigin);
      for (const language of ['es', 'fr']) {
        await locale(view, page, language);
        expect(await original.evaluate((el) => el.isConnected && el === document.activeElement)).toBe(true);
        expect(await original.evaluate((el) => el.scrollLeft)).toBe(offset);
        await expect(price).toHaveAttribute('aria-label', t(language, 'price'));
        await expect(price).toHaveText(displayed);
        await expect(article.getByText(row.assetId, { exact: true })).toHaveAttribute('lang', 'zxx');
      }
      await capture(page, 'price-' + width + '-' + (amount === nano ? 'nano' : 'max'));
      await focusHit(article.getByRole('button'));
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toHaveAccessibleName(t('fr', 'review.purchase'));
      await expect(dialog).toContainText(displayed);
      await expect(dialog.getByText(vendorId, { exact: true })).toHaveAttribute('lang', 'zxx');
      await capture(page, 'price-review-' + width + '-' + (amount === nano ? 'nano' : 'max'));
      expect(calls.writes).toEqual([]);
      expect(calls.errors).toEqual([]);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
    });
for (const path of ['/market', '/market/mine'])
  for (const failed of [false, true])
    test('honest bounded ' + path + ' ' + (failed ? 'failed reload' : 'empty'), async ({ page, context }) => {
      const calls = await network(context, failed ? [listing(0)] : [], { mine: path.endsWith('mine'), fail: failed });
      await login(page, path);
      if (failed) {
        await expect(page.getByText(provider, { exact: true })).toBeVisible();
        expect(await page.getByText(provider, { exact: true }).evaluate((el) => el.closest('[lang]').lang)).toBe('und');
        await page.getByRole('button', { name: 'Try again', exact: true }).click();
        await expect(page.locator('article.more-room-link')).toHaveCount(1);
      } else {
        await expect(
          page.getByText(t('en', path.endsWith('mine') ? 'you.have.no.listings' : 'no.listings.are.available'), { exact: true }),
        ).toBeVisible();
        await expect(page.locator('article.more-room-link')).toHaveCount(0);
      }
      expect(calls.writes).toEqual([]);
      expect(calls.errors).toEqual([]);
    });
