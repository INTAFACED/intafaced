import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const evidence = process.env.PREDICTION_CATALOGUE_EVIDENCE;
const baseURL = process.env.PREDICTION_CATALOGUE_BASE_URL;
const owner = '11111111-1111-4111-8111-111111111111';
const originalKey = 'intafaced:more:pending:' + owner + ':quant-backtest';
const original = JSON.stringify({ id: '33333333-3333-4333-8333-333333333333', title: 'Original historical attempt' });
const room = (page) => page.getByTestId('prediction-room');
const listing = (overrides = {}) => ({
  id: 'illustrative-event',
  kind: 'outcome',
  question: 'Is the illustrative published condition met?',
  closeAt: '2027-10-15T18:00:00Z',
  settlementAssetId: 'ILLUSTRATIVE-USD',
  settlementSource: 'illustrative.approved_source',
  collateralization: 'full',
  instruments: [
    { outcome: 'yes', symbol: 'illustrative-event:YES' },
    { outcome: 'no', symbol: 'illustrative-event:NO' },
  ],
  ...overrides,
});
const observations = [];
async function scenario(browser, name, width, fn) {
  const out = join(evidence, name);
  await mkdir(out, { recursive: true });
  const context = await browser.newContext({ baseURL, viewport: { width, height: 844 } });
  const state = { reads: [], writes: [], errors: [], fixtureErrors: [], catalogueReads: 0, holds: [], plan: [] };
  context.on('page', (p) => p.on('pageerror', (e) => state.errors.push(e.message)));
  await context.route('**/api/**', async (route) => {
    try {
      const r = route.request(),
        u = new URL(r.url()),
        procedure = decodeURIComponent(u.pathname.split('/').at(-1));
      if (procedure === 'auth.login')
        return route.fulfill({
          json: {
            result: {
              data: {
                userId: owner,
                accessToken: 'isolated-prediction-owner',
                refreshToken: 'isolated-refresh',
                expiresAt: '2027-10-11T00:00:00Z',
              },
            },
          },
        });
      state[r.method() === 'GET' ? 'reads' : 'writes'].push({
        method: r.method(),
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        headers: r.headers(),
      });
      if (u.pathname === '/api/v1/outcomes/markets') {
        state.catalogueReads++;
        const step = state.plan.shift() ?? { json: [] };
        if (step.hold) {
          state.holds.push(route);
          return;
        }
        if (step.abort) return route.abort('failed');
        return route.fulfill(step);
      }
      if (u.pathname.startsWith('/api/v1/orderbook/')) {
        const symbol = decodeURIComponent(u.pathname.slice('/api/v1/orderbook/'.length));
        const now = Date.now();
        return route.fulfill({ json: { symbol, bids: [], asks: [], timestamp: now, datetime: new Date(now).toISOString(), nonce: 1 } });
      }
      if (u.pathname.startsWith('/api/v1/trades/') || u.pathname === '/api/v1/account/trades') return route.fulfill({ json: [] });
      return route.fulfill({
        status: 503,
        json: {
          error: {
            message: 'Isolated current service unavailable',
            data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503, cause: { code: 'isolated.prediction_dependency' } },
          },
        },
      });
    } catch (e) {
      state.fixtureErrors.push(e.message);
      await route.abort('failed');
    }
  });
  const page = await context.newPage();
  let passed = false;
  try {
    await fn({ page, context, state, out });
    expect(state.writes).toEqual([]);
    expect(state.errors).toEqual([]);
    expect(state.fixtureErrors).toEqual([]);
    expect(state.reads.every((r) => !Object.keys(r.headers).some((k) => /x-service|hmac|internal-secret/i.test(k)))).toBe(true);
    passed = true;
  } finally {
    const observation = {
      name,
      width,
      passed,
      reads: state.reads,
      writes: state.writes,
      errors: state.errors,
      fixtureErrors: state.fixtureErrors,
      catalogueReads: state.catalogueReads,
      qualification:
        'Actual compiled ordinaryApp/nativeLogin; isolatedAuth and realrawcatalogue/book/tape/accountfill schema shapes, failure/malformed replies. Actual producer boot[] andno outcomeadmission/placement/settlement remain REQUIRED. Prospective event and exactplanning samples onlyisolated native, never productmode/liveauthority. Original minimalreference preserved.',
    };
    await writeFile(join(out, 'OBSERVATION.json'), JSON.stringify(observation, null, 2) + '\n');
    observations.push({ name, width, passed, writes: state.writes.length, errors: state.errors });
    await context.close();
  }
}
async function login(page, path = '/predict') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('prediction@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(path + '$'));
}
async function fit(page, locator, width) {
  await locator.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(locator).toBeFocused();
  const rect = await locator.evaluate((n) => {
    const r = n.getBoundingClientRect();
    return { height: r.height, hit: n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
  });
  expect(rect.height).toBeGreaterThanOrEqual(44);
  expect(rect.hit).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}
async function openStatus(page, width) {
  const summary = room(page).locator('.prediction-room-details summary');
  await fit(page, summary, width);
  await page.keyboard.press('Enter');
  await expect(room(page).locator('.prediction-room-details')).toHaveAttribute('open', '');
}

test('verified empty catalogue can be checked again through the actual read and supported destinations while existing unknown references survive', async ({
  browser,
}) => {
  for (const width of [320, 390, 768, 1440])
    await scenario(browser, 'journey-' + width, width, async ({ page, context, state, out }) => {
      await login(page);
      await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: originalKey, raw: original });
      await expect(room(page).getByRole('heading', { name: 'No questions are listed', exact: true })).toBeVisible();
      const refresh = room(page).getByRole('button', { name: 'Refresh questions', exact: true });
      await fit(page, refresh, width);
      await refresh.click();
      await expect.poll(() => state.catalogueReads).toBe(2);
      await expect(refresh).toBeEnabled();
      await expect(room(page).getByRole('heading', { name: 'Order review unavailable', exact: true })).toBeVisible();
      await expect(room(page).getByRole('form')).toHaveCount(0);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(out, 'overview.png'), fullPage: true });
      await openStatus(page, width);
      const rows = room(page).locator('.prediction-room-requirements>div');
      await expect(rows).toHaveCount(3);
      for (const label of ['Outcome admission', 'Fees and precision', 'Order placement'])
        await expect(rows.filter({ has: page.getByText(label, { exact: true }) }).getByText('Unavailable', { exact: true })).toBeVisible();
      await page.screenshot({ path: join(out, 'requirements.png'), fullPage: true });
      const axe = await new AxeBuilder({ page }).include('[data-testid="prediction-room"]').analyze();
      expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);
      const support = room(page).getByRole('link', { name: 'Contact Support →', exact: true });
      await fit(page, support, width);
      await support.click();
      await expect(page).toHaveURL(/\/support$/);
      expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(original);
      await page.goBack();
      await expect(page).toHaveURL(/\/predict$/);
      const more = room(page).getByRole('link', { name: 'Explore More →', exact: true });
      await fit(page, more, width);
      await more.click();
      await expect(page).toHaveURL(/\/more$/);
      const peer = await context.newPage();
      await login(peer);
      expect(await peer.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(original);
      expect(state.reads.filter((r) => /orderbook|\/trades/.test(r.path))).toHaveLength(0);
    });
});
test('current loading and failed reads retire old listings, malformed or ambiguous replies refuse and Retry obtains a fresh empty catalogue', async ({
  browser,
}) => {
  await scenario(browser, 'read-recovery', 320, async ({ page, state, out }) => {
    state.plan.push({ json: [listing()] });
    await login(page);
    await expect(page.locator('[data-testid="prediction-catalogue"] h3')).toContainText('illustrative published condition');
    state.plan.push({ hold: true });
    await room(page).getByRole('button', { name: 'Refresh questions', exact: true }).click();
    await expect(page.locator('[data-testid="prediction-catalogue"] [data-testid="loading"]')).toBeVisible();
    await expect(page.getByTestId('prediction-catalogue-records')).toHaveCount(0);
    await expect.poll(() => state.holds.length).toBe(1);
    await state.holds
      .shift()
      .fulfill({ status: 503, json: { error: 'isolated.catalogue_unavailable', message: 'Isolated catalogue unavailable' } });
    await expect(page.locator('[data-testid="prediction-catalogue"] [data-testid="failure"]')).toContainText(
      'Isolated catalogue unavailable',
    );
    await expect(page.getByTestId('prediction-catalogue')).toContainText('does not establish');
    await expect(room(page).getByRole('heading', { name: 'No questions are listed', exact: true })).toHaveCount(0);
    await page.screenshot({ path: join(out, 'failed.png'), fullPage: true });
    const bad = [
      { ...listing(), closeAt: 'not-a-time' },
      {
        ...listing(),
        instruments: [
          { outcome: 'yes', symbol: 'same' },
          { outcome: 'no', symbol: 'same' },
        ],
      },
      {
        ...listing(),
        instruments: [
          { outcome: 'yes', symbol: 'a' },
          { outcome: 'yes', symbol: 'b' },
        ],
      },
    ];
    const arrays = bad.map((row) => [row]);
    arrays.push([listing(), listing()], [listing(), listing({ id: 'another-event' })]);
    for (const rows of arrays) {
      state.plan.push({ json: rows });
      await page.locator('[data-testid="prediction-catalogue"] [data-testid="failure"] button').click();
      await expect(page.locator('[data-testid="prediction-catalogue"] [data-testid="failure"]')).toContainText('verified');
      await expect(page.getByTestId('prediction-catalogue-records')).toHaveCount(0);
    }
    state.plan.push({ abort: true });
    await page.locator('[data-testid="prediction-catalogue"] [data-testid="failure"] button').click();
    await expect(page.locator('[data-testid="prediction-catalogue"] [data-testid="failure"]')).toContainText('reach');
    state.plan.push({ json: [] });
    await page.locator('[data-testid="prediction-catalogue"] [data-testid="failure"] button').click();
    await expect(room(page).getByRole('heading', { name: 'No questions are listed', exact: true })).toBeVisible();
    await page.screenshot({ path: join(out, 'recovered.png'), fullPage: true });
    expect(state.catalogueReads).toBe(9);
  });
});
test('prospective published metadata keeps outcome reads and exact collateral planning, and changed terms retire the original draft', async ({
  browser,
}) => {
  await scenario(browser, 'ILLUSTRATIVE-inspection', 390, async ({ page, state, out }) => {
    state.plan.push({ json: [listing()] });
    await login(page);
    await page.getByRole('button', { name: 'Open event: Is the illustrative published condition met?', exact: true }).click();
    await expect(room(page).getByRole('heading', { name: 'Recent outcome trades', exact: true })).toBeVisible();
    await expect(room(page).getByRole('heading', { name: 'Your outcome fills', exact: true })).toBeVisible();
    await expect.poll(() => state.reads.filter((r) => r.path === '/api/v1/account/trades').length).toBe(1);
    expect(state.reads.find((r) => r.path === '/api/v1/account/trades').query).toEqual({ symbol: 'illustrative-event:YES', limit: '100' });
    const planning = room(page).locator('.prediction-room-planning summary');
    await fit(page, planning, 390);
    await planning.click();
    const qty = page.getByLabel('Outcome contract quantity', { exact: true });
    await qty.fill('1.000000000000000001');
    await expect(room(page)).toContainText('1.000000000000000001 ILLUSTRATIVE-USD');
    await page.screenshot({ path: join(out, 'exact-rule-only.png'), fullPage: true });
    await qty.fill('0');
    await expect(qty).toHaveAttribute('aria-invalid', 'true');
    await expect(room(page).getByText('Enter a positive exact decimal quantity.', { exact: true })).toBeVisible();
    await expect(room(page).getByText('Full collateral by published rule', { exact: true })).toHaveCount(0);
    await qty.fill('2.000000000000000001');
    await room(page).getByRole('button', { name: 'No', exact: true }).click();
    await expect(qty).toHaveValue('');
    await expect
      .poll(() => state.reads.filter((r) => r.path === '/api/v1/account/trades' && r.query.symbol === 'illustrative-event:NO').length)
      .toBe(1);
    await qty.fill('3.000000000000000001');
    state.plan.push({
      json: [
        listing({
          question: 'Updated illustrative condition',
          settlementAssetId: 'ILLUSTRATIVE-EUR',
          settlementSource: 'illustrative.new_source',
        }),
      ],
    });
    await room(page).getByRole('button', { name: 'Refresh questions', exact: true }).click();
    await expect(page.locator('[data-testid="prediction-catalogue"] h3')).toHaveText('Updated illustrative condition');
    await page.locator('.prediction-room-planning summary').click();
    await expect(qty).toHaveValue('');
    await expect(room(page)).not.toContainText('3.000000000000000001 ILLUSTRATIVE-EUR');
    await expect(room(page).getByRole('heading', { name: 'Order review unavailable', exact: true })).toBeVisible();
    await expect(room(page).getByRole('button', { name: /send|confirm|buy|sell|settle/i })).toHaveCount(0);
  });
});
test('departing during a catalogue read retires its late result and saved old refresh handler', async ({ browser }) => {
  await scenario(browser, 'departure-late', 390, async ({ page, state, out }) => {
    await login(page);
    await expect(room(page).getByRole('button', { name: 'Refresh questions', exact: true })).toBeEnabled();
    await page.evaluate(() => {
      window.oldPredictionRefresh = document.querySelector('[data-testid="prediction-catalogue-refresh"]');
    });
    state.plan.push({ hold: true });
    await room(page).getByRole('button', { name: 'Refresh questions', exact: true }).click();
    await expect.poll(() => state.holds.length).toBe(1);
    await room(page).getByRole('link', { name: 'Explore More →', exact: true }).click();
    await expect(page).toHaveURL(/\/more$/);
    state.plan.push({ json: [] });
    await page.goBack();
    await expect(page).toHaveURL(/\/predict$/);
    await expect(room(page).getByRole('heading', { name: 'No questions are listed', exact: true })).toBeVisible();
    await state.holds.shift().fulfill({ json: [listing()] });
    await page.evaluate(() => window.oldPredictionRefresh.click());
    await expect(page.getByTestId('prediction-catalogue-records')).toHaveCount(0);
    expect(state.catalogueReads).toBe(3);
    await page.screenshot({ path: join(out, 'current-only.png'), fullPage: true });
  });
});
test('passive locale changes preserve native requirement focus and open state with marked fallback', async ({ browser }) => {
  await scenario(browser, 'locale-focus', 320, async ({ page, context, out }) => {
    await login(page);
    await openStatus(page, 320);
    await page.evaluate(() => {
      window.predictionFocus = document.activeElement;
    });
    const peer = await context.newPage();
    await peer.goto('/help');
    for (const [language, title, lang] of [
      ['es', 'Preguntas publicadas', 'es'],
      ['fr', 'Questions publiées', 'fr'],
      ['ar', 'Listed questions', 'en'],
    ]) {
      await peer.evaluate((language) => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language })), language);
      await expect(page.getByTestId('prediction-catalogue').getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(page.getByTestId('prediction-catalogue')).toHaveAttribute('lang', lang);
      expect(await page.evaluate(() => document.activeElement === window.predictionFocus)).toBe(true);
      await expect(room(page).locator('.prediction-room-details')).toHaveAttribute('open', '');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await page.screenshot({ path: join(out, language + '.png'), fullPage: true });
    }
    await page.keyboard.press('Enter');
    await expect(room(page).locator('.prediction-room-details')).not.toHaveAttribute('open', '');
  });
});
test('guest preserves the complete destination and unreadable original storage still allows supported read-only inspection', async ({
  browser,
}) => {
  await scenario(browser, 'guest-return', 390, async ({ page }) => {
    await page.goto('/predict?public=reference#record');
    await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
    await expect(room(page)).toHaveCount(0);
    const a = page.locator('#main').getByRole('link', { name: 'Sign in', exact: true });
    expect(new URL(await a.getAttribute('href'), baseURL).searchParams.get('redirect')).toBe('/predict?public=reference#record');
    await a.click();
    await expect(page.locator('input[name="identifier"]')).toBeVisible();
  });
  await scenario(browser, 'unreadable-original', 320, async ({ page, state }) => {
    await page.addInitScript(() => {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (key.startsWith('intafaced:more:pending:')) throw Error('Original storage unreadable');
        return get.call(this, key);
      };
    });
    await login(page);
    await expect(room(page).getByRole('heading', { name: 'No questions are listed', exact: true })).toBeVisible();
    await room(page).getByRole('button', { name: 'Refresh questions', exact: true }).click();
    await expect.poll(() => state.catalogueReads).toBe(2);
    await expect(room(page).getByRole('form')).toHaveCount(0);
  });
});
test.afterAll(async () => {
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'SCENARIOS.json'), JSON.stringify(observations, null, 2) + '\n');
});
