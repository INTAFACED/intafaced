import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const evidence = process.env.MINING_AVAILABILITY_EVIDENCE;
const baseURL = process.env.MINING_AVAILABILITY_BASE_URL;
const owner = '11111111-1111-4111-8111-111111111111';
const originalKey = 'intafaced:more:pending:' + owner + ':quant-backtest';
const original = JSON.stringify({ id: '33333333-3333-4333-8333-333333333333', title: 'Original historical attempt' });
const room = (page) => page.getByTestId('mining-room');
const health = (configured = true, jobs = configured ? ['mining.epoch_payout'] : []) => ({
  ok: true,
  service: 'svc-mining-pool',
  ledger: { status: configured ? 'configured' : 'absent', code: configured ? 'mining.ledger_unprobed' : 'mining.ledger_unavailable' },
  pg: { status: configured ? 'configured' : 'absent', code: configured ? 'mining.pg_unprobed' : 'mining.pg_unavailable' },
  jobs,
});
const observations = [];
async function scenario(browser, name, width, fn) {
  const out = join(evidence, name);
  await mkdir(out, { recursive: true });
  const context = await browser.newContext({ baseURL, viewport: { width, height: 844 } });
  const state = { reads: [], writes: [], errors: [], fixtureErrors: [], healthReads: 0, holds: [], plan: [] };
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
                accessToken: 'isolated-mining-owner',
                refreshToken: 'isolated-refresh',
                expiresAt: '2027-10-11T00:00:00Z',
              },
            },
          },
        });
      state[r.method() === 'GET' ? 'reads' : 'writes'].push({ method: r.method(), path: u.pathname, headers: r.headers() });
      if (u.pathname === '/api/mining/health') {
        state.healthReads++;
        const step = state.plan.shift() ?? { json: health() };
        if (step.hold) {
          state.holds.push(route);
          return;
        }
        if (step.abort) return route.abort('failed');
        return route.fulfill(step);
      }
      return route.fulfill({
        status: 503,
        json: {
          error: {
            message: 'Isolated current service unavailable',
            data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503, cause: { code: 'isolated.mining_dependency' } },
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
      healthReads: state.healthReads,
      qualification:
        'Actual compiled ordinaryApp/nativeLogin; isolatedAuth, realplainhealth status/code/job shape and transport/refusal/malformed replies. No money/worker/credits/payout/customerHMAC authority supplied. Other-feature original is minimal illustrative reference; product must preserve it.',
    };
    await writeFile(join(out, 'OBSERVATION.json'), JSON.stringify(observation, null, 2) + '\n');
    observations.push({ name, width, passed, writes: state.writes.length, errors: state.errors });
    await context.close();
  }
}
async function login(page, path = '/mining') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('mining@example.invalid');
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
  const summary = room(page).locator('summary');
  await fit(page, summary, width);
  await page.keyboard.press('Enter');
  await expect(room(page).locator('details')).toHaveAttribute('open', '');
}
test('customer tasks lead optional public status and actual Support and More destinations while unknown originals remain intact', async ({
  browser,
}) => {
  for (const width of [320, 390, 768, 1440])
    await scenario(browser, 'journey-' + width, width, async ({ page, context, state, out }) => {
      await login(page);
      await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: originalKey, raw: original });
      await expect(room(page).getByRole('heading', { name: 'Mining activity unavailable', exact: true })).toBeVisible();
      await expect(room(page).locator('details')).not.toHaveAttribute('open', '');
      await expect(room(page).getByText('Responding', { exact: true })).not.toBeVisible();
      const rows = room(page).locator('[data-testid="mining-room-requirements"] > div');
      await expect(rows).toHaveCount(3);
      for (const label of ['Workers', 'Accepted shares', 'Credits and payouts'])
        await expect(rows.filter({ has: page.getByText(label, { exact: true }) }).getByText('Unavailable', { exact: true })).toBeVisible();
      await expect(room(page)).toContainText('do not mean zero activity');
      await expect(room(page).getByRole('table')).toHaveCount(0);
      await expect(room(page).getByRole('form')).toHaveCount(0);
      const support = room(page).getByRole('link', { name: 'Ask about mining access', exact: true });
      await fit(page, support, width);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(out, 'overview.png'), fullPage: true });
      await openStatus(page, width);
      await expect(room(page).getByText('Responding', { exact: true })).toBeVisible();
      await expect(room(page).getByText('Set up · not tested', { exact: true })).toHaveCount(2);
      await expect(room(page)).toContainText('do not establish a successful run or payment');
      await fit(page, room(page).getByRole('button', { name: 'Refresh service status', exact: true }), width);
      await page.screenshot({ path: join(out, 'expanded.png'), fullPage: true });
      const axe = await new AxeBuilder({ page }).include('[data-testid="mining-room"]').analyze();
      expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact))).toEqual([]);
      await support.click();
      await expect(page).toHaveURL(/\/support$/);
      expect(await page.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(original);
      await page.goBack();
      await expect(page).toHaveURL(/\/mining$/);
      await fit(page, room(page).getByRole('link', { name: 'Explore More →', exact: true }), width);
      await room(page).getByRole('link', { name: 'Explore More →', exact: true }).click();
      await expect(page).toHaveURL(/\/more$/);
      const peer = await context.newPage();
      await login(peer);
      expect(await peer.evaluate((key) => localStorage.getItem(key), originalKey)).toBe(original);
      await expect(room(peer).getByRole('heading', { name: 'Mining activity unavailable', exact: true })).toBeVisible();
      expect(state.reads.filter((r) => r.path.includes('/mining/')).every((r) => r.path === '/api/mining/health')).toBe(true);
    });
});
test('refresh discards previous facts during loading, current refusal and malformed replies and Retry reads fresh absent configuration', async ({
  browser,
}) => {
  await scenario(browser, 'read-recovery', 320, async ({ page, state, out }) => {
    state.plan.push({ hold: true });
    await login(page);
    await openStatus(page, 320);
    await expect(room(page).getByTestId('loading')).toBeVisible();
    await expect(room(page).getByTestId('mining-room-health-record')).toHaveCount(0);
    await expect.poll(() => state.holds.length).toBe(1);
    await state.holds.shift().fulfill({ json: health() });
    await expect(room(page).getByText('mining.epoch_payout', { exact: true })).toBeVisible();
    state.plan.push({ hold: true });
    await room(page).getByRole('button', { name: 'Refresh service status', exact: true }).click();
    await expect(room(page).getByTestId('loading')).toBeVisible();
    await expect(room(page).getByTestId('mining-room-health-record')).toHaveCount(0);
    await expect.poll(() => state.holds.length).toBe(1);
    await state.holds.shift().fulfill({ status: 404, json: { error: 'mining.route_unavailable' } });
    await expect(room(page).getByTestId('failure')).toBeVisible();
    await expect(room(page).getByTestId('mining-room-health-record')).toHaveCount(0);
    await page.screenshot({ path: join(out, 'failed.png'), fullPage: true });
    state.plan.push({ json: { ...health(), service: 'wrong-service' } });
    await room(page).locator('[data-testid="failure"] button').click();
    await expect(room(page).getByTestId('failure')).toContainText('verified');
    await expect(room(page).getByTestId('mining-room-health-record')).toHaveCount(0);
    state.plan.push({ abort: true });
    await room(page).locator('[data-testid="failure"] button').click();
    await expect(room(page).getByTestId('failure')).toContainText('reach');
    state.plan.push({ json: health(false) });
    await room(page).locator('[data-testid="failure"] button').click();
    await expect(room(page).getByText('Not set up', { exact: true })).toHaveCount(2);
    await expect(room(page).getByText('No jobs registered', { exact: true })).toBeVisible();
    await expect(room(page).getByText('mining.ledger_unavailable', { exact: true })).toHaveCount(0);
    await expect(room(page).getByText('mining.epoch_payout', { exact: true })).toHaveCount(0);
    await fit(page, room(page).getByRole('button', { name: 'Refresh service status', exact: true }), 320);
    await page.screenshot({ path: join(out, 'recovered.png'), fullPage: true });
    expect(state.healthReads).toBe(5);
  });
});
test('departure retires a late read and a saved old refresh handler without restoring old process facts', async ({ browser }) => {
  await scenario(browser, 'depart-late', 390, async ({ page, state, out }) => {
    await login(page);
    await openStatus(page, 390);
    await expect(room(page).getByText('mining.epoch_payout', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.oldMiningRefresh = document.querySelector('[data-testid="mining-room-refresh"]');
    });
    state.plan.push({ hold: true });
    await room(page).getByRole('button', { name: 'Refresh service status', exact: true }).click();
    await expect.poll(() => state.holds.length).toBe(1);
    await room(page).getByRole('link', { name: 'Explore More →', exact: true }).click();
    await expect(page).toHaveURL(/\/more$/);
    state.plan.push({ json: health(false) });
    await page.goBack();
    await expect(page).toHaveURL(/\/mining$/);
    await openStatus(page, 390);
    await expect(room(page).getByText('No jobs registered', { exact: true })).toBeVisible();
    await state.holds.shift().fulfill({ json: health() });
    await page.evaluate(() => window.oldMiningRefresh.click());
    await expect(room(page).getByText('No jobs registered', { exact: true })).toBeVisible();
    await expect(room(page).getByText('mining.epoch_payout', { exact: true })).toHaveCount(0);
    expect(state.healthReads).toBe(3);
    await page.screenshot({ path: join(out, 'current-only.png'), fullPage: true });
  });
});
test('passive locale changes preserve disclosure focus and long raw metadata stays readable with marked fallback', async ({ browser }) => {
  await scenario(browser, 'locale-focus', 320, async ({ page, context, state, out }) => {
    state.plan.push({ json: health(true, ['mining.epoch_payout', 'job_' + 'x'.repeat(220)]) });
    await login(page);
    await openStatus(page, 320);
    await page.evaluate(() => {
      window.miningFocus = document.activeElement;
    });
    const peer = await context.newPage();
    await peer.goto('/help');
    for (const [language, title, lang] of [
      ['es', 'La actividad de minería no está disponible', 'es'],
      ['fr', 'L’activité de minage est indisponible', 'fr'],
      ['ar', 'Mining activity unavailable', 'en'],
    ]) {
      await peer.evaluate((language) => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language })), language);
      await expect(room(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(room(page)).toHaveAttribute('lang', lang);
      expect(await page.evaluate(() => document.activeElement === window.miningFocus)).toBe(true);
      await expect(room(page).locator('details')).toHaveAttribute('open', '');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await page.screenshot({ path: join(out, language + '.png'), fullPage: true });
    }
    await page.keyboard.press('Enter');
    await expect(room(page).locator('details')).not.toHaveAttribute('open', '');
  });
});
test('guest return and unreadable original storage do not confer customer submission authority or hide supported public reads', async ({
  browser,
}) => {
  await scenario(browser, 'guest-return', 390, async ({ page }) => {
    await page.goto('/mining?public=reference#record');
    await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
    await expect(room(page)).toHaveCount(0);
    const signIn = page.locator('#main').getByRole('link', { name: 'Sign in', exact: true });
    expect(new URL(await signIn.getAttribute('href'), baseURL).searchParams.get('redirect')).toBe('/mining?public=reference#record');
    await signIn.click();
    await expect(page.locator('input[name="identifier"]')).toBeVisible();
  });
  await scenario(browser, 'unreadable-original', 320, async ({ page, state }) => {
    await page.addInitScript(() => {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (key.startsWith('intafaced:more:pending:')) throw Error('Original journal unreadable');
        return get.call(this, key);
      };
    });
    await login(page);
    await openStatus(page, 320);
    await expect(room(page).getByText('Responding', { exact: true })).toBeVisible();
    await expect(room(page).getByRole('form')).toHaveCount(0);
    await expect(room(page)).toContainText('The pool offers no customer access, so nothing can be submitted here');
    expect(state.healthReads).toBe(1);
  });
});

// Hold the actual queued arrival callback to exercise the brief interval
// between focusing the final control and traversing into browser chrome.
test('a queued room arrival respects observed control focus and still focuses main when no control was focused', async ({ browser }) => {
  for (const focused of [true, false])
    await scenario(browser, focused ? 'queued-control-focus' : 'queued-default-focus', 1440, async ({ page, out }) => {
      await login(page);
      await room(page).getByRole('link', { name: 'Ask about mining access', exact: true }).click();
      await expect(page).toHaveURL(/\/support$/);
      await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        document.activeElement?.blur();
        const raf = window.requestAnimationFrame.bind(window),
          cancel = window.cancelAnimationFrame.bind(window);
        window.heldMiningArrival = new Map();
        window.pauseMiningArrival = true;
        window.requestAnimationFrame = (callback) => {
          let id;
          id = raf((at) => {
            if (window.pauseMiningArrival) window.heldMiningArrival.set(id, () => callback(at));
            else callback(at);
          });
          return id;
        };
        window.cancelAnimationFrame = (id) => {
          window.heldMiningArrival.delete(id);
          cancel(id);
        };
      });
      await page.goBack();
      await expect(page).toHaveURL(/\/mining$/);
      const more = room(page).getByRole('link', { name: 'Explore More →', exact: true });
      await expect(more).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.heldMiningArrival.size)).toBeGreaterThan(0);
      if (focused) {
        await more.focus();
        await expect(more).toBeFocused();
        await page.keyboard.press('Tab');
      }
      const before = await page.evaluate(() => ({
        active: document.activeElement.id || document.activeElement.className,
        held: window.heldMiningArrival.size,
      }));
      await page.evaluate(() => {
        window.pauseMiningArrival = false;
        for (const fn of window.heldMiningArrival.values()) fn();
        window.heldMiningArrival.clear();
      });
      const after = await page.evaluate(() => ({ active: document.activeElement.id || document.activeElement.className }));
      await writeFile(join(out, 'FOCUS-PROBE.json'), JSON.stringify({ focused, before, after }, null, 2) + '\n');
      if (focused) {
        expect(after.active).not.toBe('main');
        await page.keyboard.press('Shift+Tab');
        await expect(more).toBeFocused();
      } else expect(after.active).toBe('main');
    });
});
test.afterAll(async () => {
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'SCENARIOS.json'), JSON.stringify(observations, null, 2) + '\n');
});
