import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const evidence = process.env.MARKET_PRECISION_EVIDENCE || '/tmp/intafaced-market-responsive-precision';
const catalogs = JSON.parse(readFileSync(process.env.MARKET_PRECISION_CATALOGS, 'utf8'));
mkdirSync(evidence, { recursive: true });
const copy = (locale, key) => catalogs[locale][key];
const owner = '11111111-1111-4111-8111-111111111111';
const listingId = '33333333-3333-4333-8333-333333333333';
const originalId = '44444444-4444-4444-8444-444444444444';
const vendorId = '66666666-6666-4666-8666-666666666666';
const title = 'Original title <owner> / no translation';
const description = 'Original user description <owner> / no translation';
const asset = 'LONG_NATIVE_ASSET_IDENTIFIER_123';
const tiny = '0.000000000000000001';
const markerKey = `intafaced:more:pending:${owner}:market`;
const at = '2026-10-09T10:00:00.000Z';

// Existing Market fixture inputs: ordinary App/Login/View, isolated typed reads only.
async function network(context, price = tiny) {
  const calls = { reads: [], writes: [], errors: [] };
  const observe = (page) => page.on('pageerror', (error) => calls.errors.push(error.message));
  context.pages().forEach(observe);
  context.on('page', observe);
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : request.postDataJSON();
    const reply = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (procedure === 'auth.login')
      return reply({
        userId: owner,
        accessToken: 'isolated-market-token',
        refreshToken: 'isolated-market-refresh',
        expiresAt: '2027-10-09T10:00:00Z',
      });
    if (procedure === 'auth.logout') return reply({ ok: true });
    (request.method() === 'GET' ? calls.reads : calls.writes).push({ procedure, input });
    if (request.method() !== 'GET')
      return route.fulfill({ status: 503, json: { message: 'This visual fixture admits no feature writes' } });
    if (procedure === 'listings')
      return reply([
        {
          id: listingId,
          vendorId,
          title,
          description,
          offerType: 'subscription',
          assetId: asset,
          price,
          periodSeconds: 3600,
          status: 'active',
          createdAt: at,
          updatedAt: at,
        },
      ]);
    if (procedure === 'commerceProgramme') return reply({ commissionBps: 500, commissionConfigured: true });
    if (procedure === 'myPurchases' || procedure === 'webauthn.list') return reply([]);
    return route.fulfill({ status: 503, json: { message: 'Isolated read unavailable' } });
  });
  return calls;
}

async function login(page, path) {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('isolated-market');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(path + '$'));
}

async function language(view, page, locale) {
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption(locale);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

const rowFor = (page) => page.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const priceFor = (row, locale = 'en') => row.getByRole('group', { name: copy(locale, 'market.price'), exact: true });

async function geometry(row) {
  return row.evaluate((element) => {
    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return { x: value.x, y: value.y, left: value.left, right: value.right, width: value.width, height: value.height };
    };
    const price = element.querySelector('[data-testid="market-purchases-exact-price"]');
    const amount = price.querySelector('strong');
    const range = document.createRange();
    range.selectNodeContents(amount);
    const last = document.createRange();
    const text = amount.firstChild;
    last.setStart(text, text.textContent.length - 1);
    last.setEnd(text, text.textContent.length);
    const button = element.querySelector('[data-testid="market-catalogue-decision"] > .button');
    const vendor = element.querySelector('[data-testid="market-catalogue-facts"] code');
    const offer = element.querySelector('[data-testid="market-catalogue-facts"] > div:nth-child(2) dd');
    const vendorRange = document.createRange();
    vendorRange.selectNodeContents(vendor);
    const offerRange = document.createRange();
    offerRange.selectNodeContents(offer);
    const metadata = [...element.querySelectorAll('[data-testid="market-catalogue-facts"] > div')].map((node) => {
      const label = node.querySelector('dt');
      const value = node.querySelector('dd');
      const labelInk = document.createRange();
      labelInk.selectNodeContents(label);
      return {
        labelText: label.textContent,
        valueText: value.textContent,
        label: rect(label),
        labelInk: rect(labelInk),
        value: rect(value),
      };
    });
    return {
      viewport: innerWidth,
      hovered: element.matches(':hover'),
      columns: getComputedStyle(element).gridTemplateColumns,
      row: rect(element),
      main: rect(element.querySelector('[data-testid="market-catalogue-main"]')),
      title: rect(element.querySelector('h3')),
      description: rect(element.querySelector('[data-testid="market-catalogue-description"]')),
      vendorText: vendor.textContent,
      vendorLineFragments: vendorRange.getClientRects().length,
      offerText: offer.textContent,
      offerLineFragments: offerRange.getClientRects().length,
      metadata,
      price: rect(price),
      amount: rect(range),
      finalGlyph: rect(last),
      text: amount.textContent,
      clientWidth: price.clientWidth,
      scrollWidth: price.scrollWidth,
      scrollLeft: price.scrollLeft,
      font: {
        family: getComputedStyle(amount).fontFamily,
        size: getComputedStyle(amount).fontSize,
        weight: getComputedStyle(amount).fontWeight,
      },
      interLoaded: document.fonts.check('500 24px Inter'),
      button: rect(button),
      pageClientWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
    };
  });
}

function expectMetadataGap(value) {
  for (const fact of value.metadata) {
    expect(fact.labelInk.right).toBeLessThanOrEqual(fact.label.right + 0.5);
    expect(fact.value.left - fact.labelInk.right).toBeGreaterThanOrEqual(12 - 0.5);
  }
}

test('native full tiny price and readable listing remain stable across hover and responsive boundaries', async ({ page, context }) => {
  const calls = await network(context);
  await login(page, '/market');
  await page.evaluate(() => document.fonts.ready);
  const row = rowFor(page);
  await expect(row).toBeVisible();
  const measurements = [];
  for (const width of [320, 390, 560, 561, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(50);
    const before = await geometry(row);
    await row.hover();
    const after = await geometry(row);
    measurements.push({ width, before, after });
    await row.screenshot({ path: `${evidence}/row-${width}-hover.png` });
  }
  writeFileSync(`${evidence}/geometry.json`, JSON.stringify({ measurements, calls }, null, 2));
  for (const { width, before, after } of measurements) {
    expect(before.hovered).toBe(false);
    expect(after.hovered).toBe(true);
    for (const value of [before, after]) {
      expect(value.text).toBe(tiny);
      expect(value.scrollLeft).toBe(0);
      expect(value.amount.left).toBeGreaterThanOrEqual(value.price.left - 1);
      expect(value.amount.right).toBeLessThanOrEqual(value.price.right + 1);
      expect(value.finalGlyph.right).toBeLessThanOrEqual(value.price.right + 1);
      expect(value.interLoaded).toBe(true);
      expect(value.vendorText).toBe(vendorId);
      expect(value.offerText).toBe('subscription');
      expectMetadataGap(value);
      expect(value.offerLineFragments).toBe(1);
      if (width === 561) expect(value.vendorLineFragments).toBe(1);
      expect(value.font.family).toContain('Inter');
      expect(value.button.height).toBeGreaterThanOrEqual(44);
      expect(value.button.left).toBe(value.price.left);
      if (width > 560) expect(value.button.width).toBeLessThan(value.price.width);
      expect(value.pageScrollWidth).toBeLessThanOrEqual(value.pageClientWidth);
      if (width <= 767) {
        expect(value.main.width).toBeGreaterThanOrEqual(value.row.width - 1);
        expect(value.title.height).toBeLessThanOrEqual(56);
        expect(value.description.height).toBeLessThanOrEqual(44);
      }
    }
    expect(after.columns).toBe(before.columns);
    expect(after.main.width).toBe(before.main.width);
    expect(after.row.height).toBe(before.row.height);
    expect(before.font.size).toBe(width <= 360 ? '18px' : width <= 560 ? '20px' : '24px');
  }
  expect(calls.writes).toEqual([]);
  expect(calls.errors).toEqual([]);
});

test('native View locales keep opaque listing values and current pointer and keyboard reviews usable', async ({ page, context }) => {
  const calls = await network(context);
  await login(page, '/market');
  const view = await context.newPage();
  await login(view, '/view');
  const origin = await page.evaluate(() => performance.timeOrigin);
  const row = rowFor(page);
  await page.evaluate(() => document.fonts.ready);
  const measurements = [];
  for (const locale of ['en', 'es', 'fr']) {
    await language(view, page, locale);
    for (const width of [320, 390, 561]) {
      await page.setViewportSize({ width, height: 1000 });
      await row.hover();
      await expect(row.getByRole('heading', { name: title, exact: true })).toHaveAttribute('lang', 'und');
      await expect(row.getByText(description, { exact: true })).toHaveAttribute('lang', 'und');
      await expect(row.getByText(vendorId, { exact: true })).toHaveAttribute('lang', 'zxx');
      await expect(row.getByText(asset, { exact: true })).toBeVisible();
      await expect(row.getByText('subscription', { exact: true })).toBeVisible();
      await expect(priceFor(row, locale).locator('strong')).toHaveText(tiny);
      const current = await geometry(row);
      measurements.push({ locale, width, current });
      expectMetadataGap(current);
      expect(current.amount.right).toBeLessThanOrEqual(current.price.right + 1);
      expect(current.main.width).toBe(current.row.width);
      await row.screenshot({ path: `${evidence}/current-${locale}-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 390, height: 1000 });
  const buy = row.getByRole('button', { name: copy('fr', 'market.buy.2').replace('{value1}', title), exact: true });
  await buy.click();
  const dialog = page.getByRole('dialog', { name: copy('fr', 'market.review.purchase'), exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(tiny, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: copy('fr', 'common.back'), exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 1000 });
  await priceFor(row, 'fr').focus();
  await page.keyboard.press('Tab');
  await expect(buy).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: copy('fr', 'common.back'), exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await buy.scrollIntoViewIfNeeded();
  const clearance = await buy.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const fixed = [...document.querySelectorAll('nav')]
      .filter((node) => getComputedStyle(node).position === 'fixed' && node.getBoundingClientRect().bottom >= innerHeight - 1)
      .map((node) => node.getBoundingClientRect().top);
    return {
      viewport: innerWidth,
      buttonTop: bounds.top,
      buttonBottom: bounds.bottom,
      buttonHeight: bounds.height,
      navTop: Math.min(...fixed),
    };
  });
  expect(clearance.viewport).toBe(320);
  expect(clearance.buttonHeight).toBeGreaterThanOrEqual(44);
  expect(Number.isFinite(clearance.navTop)).toBe(true);
  expect(clearance.buttonBottom).toBeLessThan(clearance.navTop);
  await page.screenshot({ path: `${evidence}/pointer-ready-320.png` });
  await buy.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: copy('fr', 'common.back'), exact: true }).click();
  await expect(dialog).toHaveCount(0);
  writeFileSync(`${evidence}/pointer-clearance.json`, JSON.stringify(clearance, null, 2));
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
  expect(calls.writes).toEqual([]);
  expect(calls.errors).toEqual([]);
  writeFileSync(`${evidence}/current-controls.json`, JSON.stringify({ origin, measurements, calls }, null, 2));
});

test('native verylong exact price keeps deliberate local keyboard scroll at readable type', async ({ page, context }) => {
  const calls = await network(context, '99999999999999999999.999999999999999999');
  const exact = '99,999,999,999,999,999,999.999999999999999999';
  await page.setViewportSize({ width: 320, height: 1000 });
  await login(page, '/market');
  await page.evaluate(() => document.fonts.ready);
  const row = rowFor(page);
  const price = priceFor(row);
  await expect(price.locator('strong')).toHaveText(exact);
  const before = await geometry(row);
  expect(before.font.size).toBe('18px');
  expect(before.scrollWidth).toBeGreaterThan(before.clientWidth);
  expect(before.scrollLeft).toBe(0);
  await price.focus();
  for (let index = 0; index < 35; index++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  const after = await geometry(row);
  expect(after.scrollLeft).toBeGreaterThan(0);
  expect(after.finalGlyph.right).toBeLessThanOrEqual(after.price.right + 1);
  expect(after.text).toBe(exact);
  for (let index = 0; index < 35; index++) await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  const restored = await geometry(row);
  expect(restored.scrollLeft).toBe(0);
  expect(restored.amount.left).toBeGreaterThanOrEqual(restored.price.left - 1);
  expect(restored.text).toBe(exact);
  expect(restored.pageScrollWidth).toBeLessThanOrEqual(restored.pageClientWidth);
  await row.screenshot({ path: `${evidence}/verylong-price-320.png` });
  expect(calls.writes).toEqual([]);
  expect(calls.errors).toEqual([]);
  writeFileSync(`${evidence}/long-price.json`, JSON.stringify({ before, after, restored, calls }, null, 2));
});

test('native original marker remains exact with disabled Buy and reachable read recovery through responsive locales', async ({
  page,
  context,
}) => {
  const raw = JSON.stringify({ id: originalId, title: 'Original purchase', reference: originalId });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: markerKey, value: raw });
  const calls = await network(context);
  await login(page, '/market');
  const view = await context.newPage();
  await login(view, '/view');
  const row = rowFor(page);
  for (const locale of ['en', 'es', 'fr']) {
    await language(view, page, locale);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await row.hover();
      await expect(row.getByRole('button', { name: copy(locale, 'market.buy.2').replace('{value1}', title), exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: copy(locale, 'common.check.original.outcome'), exact: true })).toBeEnabled();
      expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBe(raw);
    }
  }
  const reads = calls.reads.filter((call) => call.procedure === 'myPurchases').length;
  const check = page.getByRole('button', { name: copy('fr', 'common.check.original.outcome'), exact: true });
  await check.click();
  await expect.poll(() => calls.reads.filter((call) => call.procedure === 'myPurchases').length).toBe(reads + 1);
  await expect(check).toBeEnabled();
  expect(await page.evaluate((key) => localStorage.getItem(key), markerKey)).toBe(raw);
  await page.screenshot({ path: `${evidence}/original-fr-390.png`, fullPage: true });
  expect(calls.writes).toEqual([]);
  expect(calls.errors).toEqual([]);
  writeFileSync(`${evidence}/original-marker.json`, JSON.stringify({ raw, calls }, null, 2));
});
