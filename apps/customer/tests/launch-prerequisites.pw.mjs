import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const evidence = process.env.LAUNCH_PREREQUISITES_EVIDENCE,
  baseURL = process.env.LAUNCH_PREREQUISITES_BASE_URL;
const owner = '11111111-1111-4111-8111-111111111111',
  originalKey = 'intafaced:more:pending:' + owner + ':quant-backtest';
const original = JSON.stringify({ id: '33333333-3333-4333-8333-333333333333', title: 'Original historical attempt' });
const room = (page) => page.getByTestId('launch-room');
const scenarios = [];
async function scenario(browser, name, width, fn) {
  const out = join(evidence, name);
  await mkdir(out, { recursive: true });
  const context = await browser.newContext({ baseURL, viewport: { width, height: 844 } }),
    state = { reads: [], writes: [], pageErrors: [], fixtureErrors: [] };
  context.on('page', (page) => page.on('pageerror', (e) => state.pageErrors.push(e.message)));
  await context.route('**/api/**', async (route) => {
    try {
      const request = route.request(),
        url = new URL(request.url()),
        procedure = decodeURIComponent(url.pathname.split('/').at(-1));
      if (procedure === 'auth.login')
        return route.fulfill({
          json: {
            result: {
              data: {
                userId: owner,
                accessToken: 'isolated-launch-owner',
                refreshToken: 'isolated-refresh',
                expiresAt: '2027-10-11T00:00:00Z',
              },
            },
          },
        });
      const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : request.postDataJSON();
      state[request.method() === 'GET' ? 'reads' : 'writes'].push({ procedure, input });
      if (url.pathname.includes('/api/mining/') && procedure === 'health')
        return route.fulfill({
          json: {
            ok: true,
            service: 'svc-mining-pool',
            ledger: { status: 'absent', code: 'mining.ledger_unavailable' },
            pg: { status: 'absent', code: 'mining.pg_unavailable' },
            jobs: [],
          },
        });
      return route.fulfill({
        status: 503,
        json: {
          error: {
            message: 'Isolated current service unavailable',
            data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503, cause: { code: 'isolated.launch_dependency' } },
          },
        },
      });
    } catch (error) {
      state.fixtureErrors.push(error.message);
      await route.abort('failed');
    }
  });
  const page = await context.newPage();
  let passed = false;
  try {
    await fn({ page, context, state, out });
    expect(state.pageErrors).toEqual([]);
    expect(state.fixtureErrors).toEqual([]);
    expect(state.writes).toHaveLength(0);
    passed = true;
  } finally {
    await writeFile(
      join(out, 'OBSERVATION.json'),
      JSON.stringify(
        {
          name,
          width,
          passed,
          ...state,
          qualification:
            'Actual compiled ordinary App/nativeLogin; isolated Auth and typed service errors only. No launchproducer/assetlisting/round/history/funding/issuerauthority/GO invented. Mininghealth is a nonfinancial isolated liveness record.',
        },
        null,
        2,
      ) + '\n',
    );
    scenarios.push({ name, width, passed, writes: state.writes.length, pageErrors: state.pageErrors });
    await context.close();
  }
}
async function login(page, path = '/launch') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('launch@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(path + '$'));
}
async function stable(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}
async function fit(page, locator, width) {
  await locator.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(locator).toBeFocused();
  await stable(page);
  const info = await locator.evaluate((n) => {
    const r = n.getBoundingClientRect();
    return { height: r.height, hit: n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
  });
  expect(info.height).toBeGreaterThanOrEqual(44);
  expect(info.hit).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}
test('Launch and own participation distinguish required missing capabilities from the separate service catalogue through actual destinations', async ({
  browser,
}) => {
  for (const width of [320, 390, 768, 1440])
    await scenario(browser, 'journey-' + width, width, async ({ page, context, state, out }) => {
      await login(page);
      await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: originalKey, raw: original });
      await expect(room(page).getByRole('heading', { name: 'Asset launches are unavailable', exact: true })).toBeVisible();
      const rows = room(page).locator('dl > div');
      await expect(rows).toHaveCount(3);
      for (const label of ['Issuance', 'Trading-market listing', 'Sale participation']) {
        const row = rows.filter({ has: page.getByText(label, { exact: true }) });
        await expect(row.getByText('Unavailable', { exact: true })).toBeVisible();
        await expect(row.locator('dd')).toContainText('unavailable');
      }
      const listing = rows.filter({ has: page.getByText('Trading-market listing', { exact: true }) });
      await expect(listing.locator('dd')).toContainText('asset-listing request');
      await expect(listing.locator('dd')).not.toContainText('Market');
      await expect(page.getByTestId('launch-room-market')).toContainText('do not issue an asset');
      await expect(room(page).getByRole('table')).toHaveCount(0);
      await fit(page, room(page).getByRole('link', { name: 'Contact Support', exact: true }), width);
      const accessibility = await new AxeBuilder({ page }).include('[data-testid="launch-room"]').analyze();
      expect(accessibility.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(out, 'overview.png'), fullPage: true });
      await room(page).getByRole('link', { name: 'My participation', exact: true }).click();
      await expect(page).toHaveURL(/\/uc\/innovation\/myorders$/);
      await expect(room(page).getByRole('heading', { name: 'Your launch orders are unavailable', exact: true })).toBeVisible();
      await expect(room(page)).toContainText('do not mean you have no orders');
      await expect(room(page).getByRole('link', { name: 'My participation', exact: true })).toHaveAttribute('aria-current', 'page');
      await room(page).getByRole('link', { name: 'View required launch capabilities →', exact: true }).click();
      await expect(page).toHaveURL(/\/launch$/);
      expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(original);
      const summary = room(page).locator('summary');
      await fit(page, summary, width);
      await page.keyboard.press('Enter');
      await expect(room(page).getByText(/The existing issuance template is explicitly unaudited/)).toBeVisible();
      await page.screenshot({ path: join(out, 'expanded.png'), fullPage: true });
      await page.keyboard.press('Enter');
      await expect(room(page).getByText(/The existing issuance template is explicitly unaudited/)).not.toBeVisible();
      await room(page).getByRole('link', { name: 'Market service listings →', exact: true }).click();
      await expect(page).toHaveURL(/\/market\/mine$/);
      await expect(page.getByText('Isolated current service unavailable', { exact: true }).first()).toBeVisible();
      expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(original);
      await page.goBack();
      await expect(page).toHaveURL(/\/launch$/);
      await room(page).getByRole('link', { name: 'Contact Support', exact: true }).click();
      await expect(page).toHaveURL(/\/support$/);
      expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(original);
      const peer = await context.newPage();
      await login(peer, '/uc/innovation/myorders');
      expect(await peer.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(original);
      await expect(room(peer).getByRole('heading', { name: 'Your launch orders are unavailable', exact: true })).toBeVisible();
      expect(state.reads.some((r) => /launch|issuance|sale/i.test(r.procedure))).toBe(false);
    });
});
test('passive ES FR and fallback language keep keyboard focus and truthful launch status on a narrow phone', async ({ browser }) => {
  await scenario(browser, 'locale-focus', 320, async ({ page, context, out }) => {
    await login(page);
    const summary = room(page).locator('summary');
    await summary.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await page.evaluate(() => (window.launchFocus = document.activeElement));
    const peer = await context.newPage();
    await peer.goto('/help');
    for (const [language, title, lang] of [
      ['es', 'Los lanzamientos de activos no están disponibles', 'es'],
      ['fr', 'Les lancements d’actifs sont indisponibles', 'fr'],
      ['ar', 'Asset launches are unavailable', 'en'],
    ]) {
      await peer.evaluate((language) => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language })), language);
      await expect(room(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(room(page)).toHaveAttribute('lang', lang);
      expect(await page.evaluate(() => document.activeElement === window.launchFocus)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      expect(
        await room(page)
          .locator('details')
          .evaluate((n) => n.open),
      ).toBe(true);
      await page.screenshot({ path: join(out, language + '.png'), fullPage: true });
    }
  });
});
test('guest entry preserves its validated launch destination without showing issuer or owned-order authority', async ({ browser }) => {
  await scenario(browser, 'guest-return', 390, async ({ page }) => {
    await page.goto('/uc/innovation/myorders?public=reference#record');
    await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
    await expect(room(page)).toHaveCount(0);
    const signIn = page.locator('#main').getByRole('link', { name: 'Sign in', exact: true });
    const href = await signIn.getAttribute('href');
    expect(new URL(href, baseURL).searchParams.get('redirect')).toBe('/uc/innovation/myorders?public=reference#record');
    await signIn.click();
    await expect(page.locator('input[name="identifier"]')).toBeVisible();
  });
});
test('the Mining liveness read still distinguishes responding process from absent customer capabilities', async ({ browser }) => {
  await scenario(browser, 'mining-seam', 390, async ({ page, state }) => {
    await login(page, '/mining');
    await expect(page.getByRole('heading', { name: 'Mining activity unavailable', exact: true })).toBeVisible();
    await page.locator('[data-testid="mining-room"] summary').click();
    await expect(page.getByText('mining.ledger_unavailable', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('mining-room')).toContainText('have not been tested');
    await expect(page.getByTestId('mining-room')).toContainText('The pool offers no customer access, so nothing can be submitted here');
    expect(state.reads.filter((r) => r.procedure === 'health')).toHaveLength(1);
  });
});
test.afterAll(async () => {
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'SCENARIOS.json'), JSON.stringify(scenarios, null, 2) + '\n');
});
