import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const evidence = process.env.QUANT_CONTEXT_EVIDENCE;
const baseURL = process.env.QUANT_CONTEXT_BASE_URL;
const owner = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
const A = 'studio_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  B = 'studio_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const key = 'intafaced:more:pending:' + owner + ':quant-backtest';
const times = ['2026-09-01T00:00:00.000Z', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z', '2026-09-15T00:00:00.000Z'];
const labels = ['In-sample start', 'In-sample end', 'Out-of-sample start', 'Out-of-sample end'];
const stamp = {
  environment: 'backtest',
  kind: 'simulated',
  claimLabel: 'Historical simulation — not a forecast',
  live: false,
  simulated: true,
};
const firstNotional = '12345.678901234567890123',
  secondNotional = '4567.890123456789012345';
const firstEvidence = {
  fees: 'isolated-native-fees-evidence',
  slippage: 'isolated-native-slippage-evidence',
  latency: 'isolated-native-latency-evidence',
};
const record = (page) => page.locator('.quant-history');
const review = (page) => page.getByRole('button', { name: 'Review historical analysis', exact: true });
const stable = (page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
const scenarios = [];
async function scenario(browser, name, width, fn, timezoneId = 'UTC') {
  const out = join(evidence, name);
  await mkdir(out, { recursive: true });
  const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, timezoneId });
  const state = {
    owner,
    outcome: 'ok',
    writes: [],
    reads: [],
    pageErrors: [],
    fixtureErrors: [],
    pending: null,
    extra: {},
    strategies: [],
    catalogueFailure: false,
  };
  context.on('page', (page) => page.on('pageerror', (e) => state.pageErrors.push(e.message)));
  await context.route('**/api/**', async (route) => {
    try {
      const req = route.request(),
        url = new URL(req.url()),
        procedure = decodeURIComponent(url.pathname.split('/').at(-1));
      const input = req.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : req.postDataJSON();
      const rpc = (data) => route.fulfill({ status: 200, json: { result: { data } } });
      const refusal = (status = 503, message = 'Isolated unavailable', code = 'quant.isolated_unavailable') =>
        route.fulfill({
          status,
          json: {
            error: {
              message,
              data: { code: status === 412 ? 'PRECONDITION_FAILED' : 'SERVICE_UNAVAILABLE', httpStatus: status, cause: { code } },
            },
          },
        });
      if (procedure === 'auth.login')
        return rpc({
          userId: state.owner,
          accessToken: 'isolated-' + state.owner,
          refreshToken: 'isolated-refresh',
          expiresAt: '2027-10-11T00:00:00Z',
        });
      if (procedure === 'auth.logout') return rpc({ ok: true });
      if (req.method() === 'GET') {
        state.reads.push({ procedure, input });
        if (procedure === 'studio.list') {
          expect(input).toEqual({ limit: 50 });
          if (state.catalogueFailure) return refusal(503, 'Isolated catalogue unavailable', 'quant.catalogue_unavailable');
          return rpc({ strategies: state.strategies });
        }
        if (procedure === 'sandbox.capabilities')
          return rpc({ isolate: 'unwired', languages: ['javascript'], venueVault: 'unset', refuse: 'quant.sandbox_unwired' });
        return refusal();
      }
      state.writes.push({ procedure, input });
      expect(procedure).toBe('backtest.run');
      if (state.outcome === 'unknown') return route.abort('failed');
      if (state.outcome === 'refused')
        return refusal(412, 'connect data lake is not wired — fills are absent, candles are not invented', 'quant.backtest_lake_missing');
      const data = {
        ok: true,
        ...stamp,
        runId: 'bt_' + input.strategyId,
        strategyId: input.strategyId,
        walkForward: input.walkForward,
        inSample: { fillCount: 12, notional: firstNotional },
        outOfSample: { fillCount: 3, notional: secondNotional },
        outOfSampleLabel: 'Out-of-sample: ' + input.outOfSampleStatus,
        ...state.extra,
      };
      if (state.outcome === 'late')
        await new Promise((resolve) => {
          state.pending = resolve;
        });
      return rpc(data);
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
    passed = true;
  } finally {
    const result = {
      name,
      width,
      timezoneId,
      passed,
      ...state,
      pending: !!state.pending,
      qualification:
        'Actual compiled ordinary Customer App, native Login and isolated contract-shaped historical fixtures. No live lake, saved-code execution, cost-adjusted performance or provider authority.',
    };
    await writeFile(join(out, 'OBSERVATION.json'), JSON.stringify(result, null, 2) + '\n');
    scenarios.push({ name, passed, width, timezoneId, writes: state.writes.length, pageErrors: state.pageErrors });
    await context.close();
  }
}
async function login(page, path = '/quant/backtest') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('quant@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
}
async function fill(page, id = A, symbol = 'BTC/USD', window = times, evidence = firstEvidence) {
  await page.getByLabel('Strategy ID', { exact: true }).fill(id);
  await page.getByLabel('Historical symbol', { exact: true }).fill(symbol);
  for (let i = 0; i < labels.length; i++) await page.getByLabel(labels[i], { exact: true }).fill(window[i].slice(0, 16));
  await page.getByLabel('Number of strategy variants tested', { exact: true }).fill('2');
  for (const [kind, source] of Object.entries(evidence)) await page.getByLabel(kind + ' evidence source', { exact: true }).fill(source);
}
async function run(page) {
  await review(page).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Run backtest', exact: true }).click();
}
async function original(page) {
  await expect(record(page).getByText(A, { exact: true })).toBeVisible();
  await expect(record(page).getByText('BTC/USD', { exact: true })).toBeVisible();
  expect(
    await record(page)
      .locator('time')
      .evaluateAll((ns) => ns.map((n) => n.getAttribute('datetime'))),
  ).toEqual(times);
  await expect(record(page).locator('[data-exact-amount]').first()).toHaveAttribute('data-exact-amount', firstNotional);
  await expect(record(page).locator('[data-exact-amount]').last()).toHaveAttribute('data-exact-amount', secondNotional);
  await expect(record(page)).toContainText('Variants declared: 2');
  await expect(record(page).getByText('Declared verdict', { exact: true })).toBeVisible();
}
test('original result remains identifiable after edited draft and a definitive failed new analysis', async ({ browser }) => {
  for (const width of [320, 390, 768, 1440])
    await scenario(browser, 'immutable-' + width, width, async ({ page, state, out }) => {
      await login(page);
      await fill(page);
      await run(page);
      await original(page);
      await expect(record(page)).toContainText('Saved strategy code is not executed');
      await expect(record(page)).toContainText('not profit');
      await stable(page);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(out, 'completed.png'), fullPage: true });
      const href = page.url();
      await page.getByRole('button', { name: 'Configure a new analysis', exact: true }).click();
      await expect(page.getByLabel('Strategy ID', { exact: true })).toBeFocused();
      expect(page.url()).toBe(href);
      await fill(
        page,
        B,
        'ETH/EUR',
        ['2026-09-16T00:00:00.000Z', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z', '2026-09-20T00:00:00.000Z'],
        { fees: 'second-fees', slippage: 'second-slip', latency: 'second-latency' },
      );
      await original(page);
      state.outcome = 'refused';
      await run(page);
      await expect(
        page.getByText('connect data lake is not wired — fills are absent, candles are not invented', { exact: true }),
      ).toBeVisible();
      await expect(page.locator('.quant-latest-failure')).toContainText(B);
      await expect(page.locator('.quant-latest-failure')).toContainText('ETH/EUR');
      await original(page);
      await record(page).locator('summary').click();
      for (const source of Object.values(firstEvidence)) await expect(record(page).getByText(source, { exact: true })).toBeVisible();
      await expect(record(page).getByText('bt_' + A, { exact: true })).toBeVisible();
      await expect(record(page)).toContainText('cannot recover an unknown request');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const configure = page.getByRole('button', { name: 'Configure a new analysis', exact: true });
      await configure.focus();
      await stable(page);
      const fit = await configure.evaluate((n) => {
        const r = n.getBoundingClientRect();
        return { height: r.height, hit: n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
      });
      expect(fit.height).toBeGreaterThanOrEqual(44);
      expect(fit.hit).toBe(true);
      expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
      expect(state.writes).toHaveLength(2);
      expect(state.writes[0].input.walkForward).toEqual({
        inSampleFrom: times[0],
        inSampleTo: times[1],
        outOfSampleFrom: times[2],
        outOfSampleTo: times[3],
      });
      expect(state.writes[0].input).toMatchObject({ idempotencyKey: expect.any(String) });
      expect(String(state.writes[0].input.idempotencyKey).trim()).not.toBe('');
      expect(state.writes[1].input.strategyId).toBe(B);
      expect(state.writes[1].input).toMatchObject({ idempotencyKey: expect.any(String) });
      expect(String(state.writes[1].input.idempotencyKey).trim()).not.toBe('');
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(out, 'failed-new.png'), fullPage: true });
      await record(page).locator('summary').focus();
      const axe = await new AxeBuilder({ page }).include('.quant-workbench').analyze();
      expect(axe.violations.filter((v) => ['critical', 'serious'].includes(v.impact))).toEqual([]);
    });
});
test('unknown original remains accessible through closure and an independent same-owner tab without private terms or replay', async ({
  browser,
}) => {
  await scenario(browser, 'unknown-closure', 320, async ({ page, context, state, out }) => {
    await login(page);
    await fill(page);
    state.outcome = 'unknown';
    await run(page);
    await expect.poll(() => state.writes.length).toBe(1);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), key)).not.toBeNull();
    await expect(page.locator('.failure').filter({ hasText: 'outcome' }).first()).toBeVisible();
    await expect(review(page)).toBeDisabled();
    const raw = await page.evaluate((key) => localStorage.getItem(key), key),
      marker = JSON.parse(raw);
    expect(Object.keys(marker).sort()).toEqual(['id', 'title']);
    expect(marker.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(raw).not.toContain(A);
    expect(raw).not.toContain('BTC/USD');
    for (const source of Object.values(firstEvidence)) expect(raw).not.toContain(source);
    await expect(page.getByText(marker.id, { exact: true })).toBeVisible();
    await page.screenshot({ path: join(out, 'unknown.png'), fullPage: true });
    await page.close();
    const independent = await context.newPage();
    await login(independent);
    await fill(independent);
    await expect(review(independent)).toBeDisabled();
    expect(await independent.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
    await expect(independent.getByText(marker.id, { exact: true })).toBeVisible();
    await expect(record(independent)).toContainText('No completed analysis in this view');
    await expect(independent.getByRole('link', { name: 'Contact Support', exact: true })).toBeVisible();
    expect(state.writes).toHaveLength(1);
    await independent.locator('.quant-original-context').getByRole('link', { name: 'Studio', exact: true }).click();
    await expect(independent).toHaveURL(/\/quant\/studio$/);
    expect(await independent.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
  });
});
test('explicit UTC intervals are identical across device zones including a local DST gap; invalid drafts cannot dispatch', async ({
  browser,
}) => {
  const boundaries = ['2026-03-07T02:00:00.000Z', '2026-03-08T02:30:00.000Z', '2026-03-08T02:30:00.000Z', '2026-03-09T02:45:00.000Z'];
  for (const zone of ['UTC', 'Asia/Makassar', 'America/New_York'])
    await scenario(
      browser,
      'utc-' + zone.replaceAll('/', '-'),
      390,
      async ({ page, state }) => {
        await login(page);
        await fill(page, A, 'BTC/USD', boundaries);
        await page.getByLabel('Number of strategy variants tested', { exact: true }).fill('1.5');
        await expect(review(page)).toBeDisabled();
        await page.getByLabel('Number of strategy variants tested', { exact: true }).fill('9007199254740992');
        await expect(review(page)).toBeDisabled();
        await page.getByLabel('Number of strategy variants tested', { exact: true }).fill('2');
        await page.getByLabel('In-sample end', { exact: true }).fill('2026-03-07T01:00');
        await expect(review(page)).toBeDisabled();
        await page
          .locator('.quant-analysis-draft form')
          .evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(state.writes).toHaveLength(0);
        await page.getByLabel('In-sample end', { exact: true }).fill('2026-03-08T02:30');
        await review(page).click();
        await expect(page.getByRole('dialog')).toContainText('Input timezone · UTC');
        await expect(page.getByRole('dialog')).toContainText('2026-03-08T02:30:00.000Z');
        await page.getByRole('dialog').getByRole('button', { name: 'Run backtest', exact: true }).click();
        await expect(record(page).getByText(A, { exact: true })).toBeVisible();
        expect(state.writes[0].input.walkForward).toEqual({
          inSampleFrom: boundaries[0],
          inSampleTo: boundaries[1],
          outOfSampleFrom: boundaries[2],
          outOfSampleTo: boundaries[3],
        });
        expect(state.writes[0].input).toMatchObject({ idempotencyKey: expect.any(String) });
        expect(String(state.writes[0].input.idempotencyKey).trim()).not.toBe('');
        expect(
          await record(page)
            .locator('time')
            .evaluateAll((ns) => ns.map((n) => n.getAttribute('datetime'))),
        ).toEqual(boundaries);
        await expect(record(page).locator('time').first()).toContainText('02:00 UTC');
        expect(state.writes).toHaveLength(1);
      },
      zone,
    );
});
test('batched native departures retire completed records and old handlers; late replies preserve the unknown original', async ({
  browser,
}) => {
  await scenario(browser, 'departures-late', 320, async ({ page, state, out }) => {
    await login(page);
    await fill(page);
    await run(page);
    await original(page);
    await review(page).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Run backtest', exact: true })
      .evaluate((node) => {
        const props = Object.keys(node).find((k) => k.startsWith('__reactProps$'));
        window.savedQuantConfirm = node[props].onClick;
      });
    await page.evaluate(() => {
      window.quantHashEvents = [];
      window.addEventListener('hashchange', (e) =>
        window.quantHashEvents.push({ oldURL: e.oldURL, newURL: e.newURL, actual: location.href }),
      );
      const old = location.href;
      location.hash = 'departed-review';
      history.replaceState(null, '', old);
    });
    await page.waitForFunction(() => window.quantHashEvents.length > 0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(record(page).getByText(A, { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.savedQuantConfirm());
    await stable(page);
    expect(state.writes).toHaveLength(1);
    state.outcome = 'late';
    await run(page);
    await expect.poll(() => !!state.pending).toBe(true);
    const raw = await page.evaluate((key) => localStorage.getItem(key), key);
    expect(raw).toBeTruthy();
    await page.evaluate(() => {
      const old = location.href;
      history.pushState({}, '', '/quant/backtest?observed=departure');
      window.dispatchEvent(new PopStateEvent('popstate'));
      history.pushState({}, '', old);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    const response = page.waitForResponse((r) => r.url().endsWith('/backtest.run') && r.request().method() === 'POST');
    state.pending();
    await (await response).finished();
    await stable(page);
    await expect(page.locator('.loading')).toHaveCount(0);
    await expect(record(page).getByText(A, { exact: true })).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
    await expect(review(page)).toBeDisabled();
    expect(state.writes).toHaveLength(2);
    await page.screenshot({ path: join(out, 'returned-unknown.png'), fullPage: true });
  });
});
test('late prior-owner response never appears for a new owner and leaves the original owner request intact', async ({ browser }) => {
  await scenario(browser, 'owner-late', 390, async ({ page, state }) => {
    await login(page);
    await fill(page);
    state.outcome = 'late';
    await run(page);
    await expect.poll(() => !!state.pending).toBe(true);
    const raw = await page.evaluate((key) => localStorage.getItem(key), key);
    await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
    state.owner = other;
    state.outcome = 'ok';
    await page.locator('#main').getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.locator('input[name="identifier"]').fill('other@example.invalid');
    await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
    await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
    await expect(record(page)).toContainText('No completed analysis in this view');
    const response = page.waitForResponse((r) => r.url().endsWith('/backtest.run') && r.request().method() === 'POST');
    state.pending();
    await (await response).finished();
    await stable(page);
    await expect(record(page).getByText(A, { exact: true })).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
    expect(state.writes).toHaveLength(1);
    await fill(page, B, 'ETH/EUR');
    await run(page);
    await expect(record(page).getByText(B, { exact: true })).toBeVisible();
    await expect(record(page).getByText(A, { exact: true })).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
    expect(state.writes).toHaveLength(2);
  });
});
test('unreadable and opaque original storage prevents both reviewed and saved-handler submission', async ({ browser }) => {
  await scenario(browser, 'unreadable-original', 390, async ({ page, context, state }) => {
    await login(page);
    await fill(page);
    await review(page).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Run backtest', exact: true })
      .evaluate((node) => {
        const props = Object.keys(node).find((k) => k.startsWith('__reactProps$'));
        window.savedQuantConfirm = node[props].onClick;
      });
    const peer = await context.newPage();
    await peer.goto('/help');
    const raw = 'opaque-original-never-delete';
    await peer.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key, raw });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(review(page)).toBeDisabled();
    await page.evaluate(() => window.savedQuantConfirm());
    await stable(page);
    expect(state.writes).toHaveLength(0);
    expect(await peer.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
    await page.evaluate((key) => {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k) {
        if (k === key) throw Error('isolated original storage unreadable');
        return get.call(this, k);
      };
    }, key);
    await page.getByLabel('Strategy ID', { exact: true }).fill(B);
    await expect(review(page)).toBeDisabled();
    await page
      .locator('.quant-analysis-draft form')
      .evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(state.writes).toHaveLength(0);
    expect(await peer.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
  });
});
test('mismatched or malformed service results stay unknown under their original request', async ({ browser }) => {
  const cases = [
    ['strategy', { strategyId: B }],
    ['run-label', { runId: 'bt_unrelated' }],
    [
      'window',
      {
        walkForward: { inSampleFrom: times[0], inSampleTo: times[1], outOfSampleFrom: times[2], outOfSampleTo: '2026-09-16T00:00:00.000Z' },
      },
    ],
    ['verdict', { outOfSampleLabel: 'Out-of-sample: passed' }],
    ['stamp', { environment: 'shadow' }],
    ['activity', { inSample: { fillCount: -1, notional: firstNotional } }],
    ['decimal', { outOfSample: { fillCount: 3, notional: 4567.89 } }],
  ];
  for (const [name, extra] of cases)
    await scenario(browser, 'malformed-' + name, 390, async ({ page, state }) => {
      state.extra = extra;
      await login(page);
      await fill(page);
      await run(page);
      await expect.poll(() => state.writes.length).toBe(1);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible();
      await expect(review(page)).toBeDisabled();
      await expect(record(page).getByText(A, { exact: true })).toHaveCount(0);
      await expect(page.locator('.more-success')).toHaveCount(0);
      const raw = await page.evaluate((key) => localStorage.getItem(key), key);
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['id', 'title']);
      await expect(page.getByText(JSON.parse(raw).id, { exact: true })).toBeVisible();
      expect(state.writes).toHaveLength(1);
    });
});
test('same service run label across different windows is a new immutable record, never original recovery proof', async ({ browser }) => {
  await scenario(browser, 'repeating-label', 390, async ({ page, state }) => {
    await login(page);
    await fill(page);
    await run(page);
    await original(page);
    await record(page).locator('summary').click();
    await expect(record(page).getByText('bt_' + A, { exact: true })).toBeVisible();
    const next = ['2026-09-16T00:00:00.000Z', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z', '2026-09-20T00:00:00.000Z'];
    await fill(page, A, 'ETH/EUR', next, { fees: 'later-fees', slippage: 'later-slip', latency: 'later-latency' });
    await original(page);
    await run(page);
    await expect(record(page).getByText('ETH/EUR', { exact: true })).toBeVisible();
    await expect(record(page).getByText('BTC/USD', { exact: true })).toHaveCount(0);
    expect(
      await record(page)
        .locator('time')
        .evaluateAll((ns) => ns.map((n) => n.getAttribute('datetime'))),
    ).toEqual(next);
    await expect(record(page).getByText('bt_' + A, { exact: true })).toBeVisible();
    await expect(record(page).getByText('later-fees', { exact: true })).toBeVisible();
    expect(state.writes).toHaveLength(2);
    state.outcome = 'unknown';
    await run(page);
    await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible();
    const raw = await page.evaluate((key) => localStorage.getItem(key), key);
    expect(raw).not.toContain('bt_');
    await expect(review(page)).toBeDisabled();
    await expect(record(page).getByText('bt_' + A, { exact: true })).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
    expect(state.writes).toHaveLength(3);
  });
});
test('exact long reported values, passive locales and keyboard disclosure fit without changing the record or focus', async ({
  browser,
}) => {
  await scenario(browser, 'locale-long', 320, async ({ page, context, state, out }) => {
    const long = '-99999999999999999999.999999999999999999';
    state.extra = { inSample: { fillCount: 2147483647, notional: long }, outOfSample: { fillCount: 0, notional: '0' } };
    await login(page);
    await fill(page);
    await run(page);
    await expect(record(page).getByText(A, { exact: true })).toBeVisible();
    await expect(record(page).locator('[data-exact-amount]').first()).toHaveAttribute('data-exact-amount', long);
    await expect(record(page).locator('[data-exact-amount]').last()).toHaveAttribute('data-exact-amount', '0');
    const summary = record(page).locator('summary');
    await summary.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(summary).toBeFocused();
    const focus = await summary.evaluate((n) => ({
      visible: n.matches(':focus-visible'),
      width: parseFloat(getComputedStyle(n).outlineWidth),
      style: getComputedStyle(n).outlineStyle,
    }));
    expect(focus.visible).toBe(true);
    expect(focus.width).toBeGreaterThanOrEqual(2);
    expect(focus.style).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(record(page).getByText(firstEvidence.fees, { exact: true })).toBeVisible();
    await page.evaluate(() => (window.originalQuantFocus = document.activeElement));
    const peer = await context.newPage();
    await peer.goto('/help');
    for (const [language, title, lang] of [
      ['es', 'Último análisis completado', 'es'],
      ['fr', 'Dernière analyse terminée', 'fr'],
      ['ar', 'Last completed analysis', 'en'],
    ]) {
      await peer.evaluate((language) => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language })), language);
      await expect(record(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(page.locator('.quant-history-body')).toHaveAttribute('lang', lang);
      expect(await page.evaluate(() => document.activeElement === window.originalQuantFocus)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await expect(record(page).locator('[data-exact-amount]').first()).toHaveAttribute('data-exact-amount', long);
      await expect(record(page).getByText(firstEvidence.fees, { exact: true })).toBeVisible();
      await expect(record(page).getByText('Out-of-sample: inconclusive', { exact: true })).toHaveAttribute('lang', 'en');
      await page.screenshot({ path: join(out, language + '.png'), fullPage: true });
    }
    await page.keyboard.press('Enter');
    await expect(record(page).getByText(firstEvidence.fees, { exact: true })).not.toBeVisible();
    const amounts = record(page).locator('.quant-history-amount');
    await amounts.first().focus();
    await page.keyboard.press('End');
    expect(await amounts.first().evaluate((n) => n.scrollWidth > n.clientWidth)).toBe(true);
    expect(state.writes).toHaveLength(1);
  });
});
test('deployment catalogue failure recovers through its actual bounded read and choosing a reference does not execute it', async ({
  browser,
}) => {
  await scenario(browser, 'catalogue-recovery', 390, async ({ page, state, out }) => {
    state.catalogueFailure = true;
    state.strategies = [
      {
        environment: 'paper',
        kind: 'paper',
        claimLabel: 'Paper — not live performance',
        live: false,
        simulated: true,
        id: B,
        name: 'Declared catalogue strategy',
        language: 'javascript',
        source: '// saved source is not backtest execution',
        cash: '1',
        blocks: [{ side: 'buy', symbol: 'ETH/EUR', qty: '0.000000000000000001' }],
        risk: { maxDrawdown: '1', maxNotional: '2', kill: '3' },
      },
    ];
    await login(page);
    await page.locator('.quant-catalogue summary').click();
    await expect(page.getByText('Isolated catalogue unavailable', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use Declared catalogue strategy', exact: true })).toHaveCount(0);
    state.catalogueFailure = false;
    await page.locator('.quant-catalogue').getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('button', { name: 'Use Declared catalogue strategy', exact: true }).click();
    await expect(page.getByLabel('Strategy ID', { exact: true })).toHaveValue(B);
    await expect(page.getByLabel('Historical symbol', { exact: true })).toHaveValue('');
    await expect(review(page)).toBeDisabled();
    expect(state.writes).toHaveLength(0);
    expect(state.reads.filter((r) => r.procedure === 'studio.list')).toHaveLength(2);
    await expect(page.locator('.quant-catalogue')).toContainText('shared in-process');
    await expect(page.locator('.quant-analysis-draft')).toContainText('execution and performance producer');
    await page.screenshot({ path: join(out, 'catalogue.png'), fullPage: true });
  });
});
test.afterAll(async () => {
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'SCENARIOS.json'), JSON.stringify(scenarios, null, 2) + '\n');
});
