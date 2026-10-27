import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const output = process.env.QUANT_EVIDENCE || '/tmp/intafaced-quant-review';
mkdirSync(output, { recursive: true });
const catalogs = JSON.parse(readFileSync(process.env.QUANT_CATALOGS, 'utf8'));
const text = (locale, key) => catalogs[locale]['quant.' + key];
const owner = '11111111-1111-4111-8111-111111111111';
const originalSource = '// Original user source <owner> 0.000000000000000001';
const provider = 'Original provider prose <owner> 0.000000000000000001; retain this message. '.repeat(4).trim();
const stamp = (environment = 'paper') => ({
  environment,
  kind: environment === 'paper' ? 'paper' : 'simulated',
  claimLabel: environment === 'backtest' ? 'Historical simulation — not a forecast' : 'Paper — not live performance',
  live: false,
  simulated: true,
});
const strategy = {
  ...stamp(),
  id: 'original-strategy-id',
  name: 'Original user name <owner>',
  language: 'javascript',
  source: originalSource,
  cash: '0.000001',
  blocks: [{ side: 'buy', symbol: 'BTC/USDT', qty: '0.000000000000000001' }],
  risk: { maxDrawdown: '1', maxNotional: '2', kill: '3' },
};
const routes = { sandbox: '/quant/sandbox', studio: '/quant/studio', backtest: '/quant/backtest' };
const reviewKeys = { sandbox: 'review.simulated.run', studio: 'review.strategy', backtest: 'review.historical.simulation' };
const stageKeys = { sandbox: 'review.simulation', studio: 'review.strategy', backtest: 'review.backtest' };
const confirmKeys = { sandbox: 'run.simulation', studio: 'save.strategy', backtest: 'run.backtest' };
const successKeys = {
  sandbox: 'simulation.received',
  studio: 'strategy.saved.in.the.deployment.catalogue',
  backtest: 'historical.simulation.received',
};
const procedures = { sandbox: 'sandbox.run', studio: 'studio.save', backtest: 'backtest.run' };
const markerKey = (mode) => 'intafaced:more:pending:' + owner + ':quant-' + mode;
const summary = [];
async function network(context, mode, outcome, wired = true) {
  const calls = { reads: [], writes: [], errors: [] };
  context.on('page', (page) => page.on('pageerror', (error) => calls.errors.push(error.message)));
  await context.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = req.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : req.postDataJSON();
    const reply = (data) => route.fulfill({ json: { result: { data } } });
    if (procedure === 'auth.login')
      return reply({
        userId: owner,
        accessToken: 'isolated-quant-token',
        refreshToken: 'isolated-quant-refresh',
        expiresAt: '2027-10-09T00:00:00Z',
      });
    if (procedure === 'auth.logout') return reply({ ok: true });
    if (req.method() === 'GET') {
      calls.reads.push({ procedure, input });
      if (procedure === 'sandbox.capabilities')
        return reply({
          isolate: wired ? 'wired' : 'unwired',
          languages: ['javascript', 'typescript', 'python'],
          venueVault: 'unset',
          refuse: wired ? null : 'quant.sandbox_unwired',
        });
      if (procedure === 'studio.list') return reply({ strategies: [strategy] });
      if (procedure === 'webauthn.list') return reply([]);
      return route.fulfill({ status: 503, json: { message: 'Isolated read unavailable' } });
    }
    calls.writes.push({ procedure, input });
    expect(procedure).toBe(procedures[mode]);
    if (outcome === 'unknown') return route.abort('failed');
    if (outcome === 'refused')
      return route.fulfill({
        status: 412,
        json: { error: { message: provider, data: { code: 'PRECONDITION_FAILED', cause: { code: 'quant.fixture_refusal' } } } },
      });
    if (mode === 'sandbox')
      return reply({
        ...stamp(),
        ok: true,
        language: outcome === 'mismatch-language' ? 'python' : input.language,
        logs: [provider],
        cash: '0.000002',
        pnl: '0.000000000000000001',
        fills: [{ side: 'buy', symbol: 'BTC/USDT', qty: '0.000000000000000001', price: '80000', venue: 'internal' }],
        positions: [{ symbol: 'BTC/USDT', qty: '0.000000000000000001' }],
        venue: 'internal',
        venueVault: 'unset',
        ...(outcome === 'mismatch-environment'
          ? { environment: 'shadow', kind: 'simulated', claimLabel: 'Shadow — not live performance' }
          : {}),
      });
    if (mode === 'studio')
      return reply({
        ...strategy,
        ...input,
        id: 'returned-original-strategy',
        ...(outcome === 'mismatch-name' ? { name: 'Another strategy name' } : {}),
        ...(outcome === 'mismatch-block' ? { blocks: [{ ...input.blocks[0], symbol: 'ANOTHER/MARKET' }] } : {}),
      });
    return reply({
      ...stamp('backtest'),
      ok: true,
      runId: 'original-run-id',
      strategyId: outcome === 'mismatch-strategy' ? 'another-strategy' : input.strategyId,
      walkForward: { ...input.walkForward, ...(outcome === 'mismatch-window' ? { outOfSampleTo: '2026-10-05T00:00:00.000Z' } : {}) },
      inSample: { fillCount: 1, notional: '0.000001' },
      outOfSample: { fillCount: 1, notional: '0.000000000000000001' },
      outOfSampleLabel: provider,
    });
  });
  return calls;
}
async function login(page, path) {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('isolated-quant');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(path + '$'));
}
async function fill(page, mode) {
  if (mode === 'sandbox') {
    await page.getByLabel('Simulated starting cash', { exact: true }).fill('0.000001');
    await page.getByLabel('Strategy source', { exact: true }).fill(originalSource);
  } else if (mode === 'studio') {
    await page.getByLabel('Strategy name', { exact: true }).fill(strategy.name);
    await page.getByLabel('Simulated starting cash', { exact: true }).fill('0.000001');
    await page.getByLabel('Block 1 symbol', { exact: true }).fill('BTC/USDT');
    await page.getByLabel('Block 1 quantity', { exact: true }).fill('0.000000000000000001');
    await page.getByLabel('Max drawdown (service unit unspecified)', { exact: true }).fill('1');
    await page.getByLabel('Max notional (service unit unspecified)', { exact: true }).fill('2');
    await page.getByLabel('Kill threshold (service unit unspecified)', { exact: true }).fill('3');
  } else {
    await page.getByLabel('Strategy ID', { exact: true }).fill(strategy.id);
    await page.getByLabel('Historical symbol', { exact: true }).fill('BTC/USDT');
    for (const [label, value] of [
      ['In-sample start', '2026-10-01T00:00'],
      ['In-sample end', '2026-10-02T00:00'],
      ['Out-of-sample start', '2026-10-03T00:00'],
      ['Out-of-sample end', '2026-10-04T00:00'],
    ])
      await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByLabel('Number of strategy variants tested', { exact: true }).fill('1');
    for (const key of ['fees', 'slippage', 'latency'])
      await page.getByLabel(key + ' evidence source', { exact: true }).fill('Original ' + key + ' evidence');
  }
}
function expectedInput(mode) {
  if (mode === 'sandbox')
    return { language: 'javascript', source: originalSource, cash: '0.000001', environment: 'paper', presentedAs: 'paper' };
  if (mode === 'studio')
    return {
      name: strategy.name,
      blocks: strategy.blocks,
      risk: strategy.risk,
      cash: '0.000001',
      environment: 'paper',
      presentedAs: 'paper',
    };
  return {
    strategyId: strategy.id,
    symbol: 'BTC/USDT',
    walkForward: {
      inSampleFrom: '2026-10-01T00:00:00.000Z',
      inSampleTo: '2026-10-02T00:00:00.000Z',
      outOfSampleFrom: '2026-10-03T00:00:00.000Z',
      outOfSampleTo: '2026-10-04T00:00:00.000Z',
    },
    outOfSampleStatus: 'inconclusive',
    costModel: {
      fees: { kind: 'venue-schedule', source: 'Original fees evidence' },
      slippage: { kind: 'order-book-replay', source: 'Original slippage evidence' },
      latency: { kind: 'measured-distribution', source: 'Original latency evidence' },
    },
    strategyVariantCount: 1,
    environment: 'backtest',
    presentedAs: 'simulated',
  };
}
async function language(view, page, locale) {
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption(locale);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}
for (const mode of ['sandbox', 'studio', 'backtest'])
  for (const outcome of ['success', 'refused', 'unknown'])
    test(
      'native ' + mode + ' original review and ' + outcome + ' follow two-tab View without changing intent',
      async ({ page, context }) => {
        const calls = await network(context, mode, outcome);
        await login(page, routes[mode]);
        await fill(page, mode);
        const view = await context.newPage();
        await login(view, '/view');
        const origin = await page.evaluate(() => performance.timeOrigin);
        const input = page.locator('input').first();
        const originalInput = await input.elementHandle();
        const allOriginalInputs = await page.locator('input,textarea,select').elementHandles();
        const beforeInputs = await page
          .locator('input,textarea,select')
          .evaluateAll((xs) => xs.map((x) => ({ value: x.value, type: x.type })));
        await page.getByRole('button', { name: text('en', stageKeys[mode]), exact: true }).click();
        const dialog = page.getByRole('dialog');
        const originalDialog = await dialog.elementHandle();
        for (const locale of ['en', 'es', 'fr']) {
          if (locale !== 'en') await language(view, page, locale);
          await expect(dialog).toHaveAccessibleName(text(locale, reviewKeys[mode]));
          await expect(dialog.getByRole('button', { name: text(locale, confirmKeys[mode]), exact: true })).toBeVisible();
          await expect(dialog).toContainText(mode === 'backtest' ? strategy.id : '0.000001');
          expect(
            await page.locator('input,textarea,select').evaluateAll((xs) => xs.map((x) => ({ value: x.value, type: x.type }))),
          ).toEqual(beforeInputs);
          expect(await originalInput.evaluate((x) => x.isConnected)).toBe(true);
          for (const node of allOriginalInputs) expect(await node.evaluate((x) => x.isConnected)).toBe(true);
          expect(await originalDialog.evaluate((x) => x.isConnected && x.open)).toBe(true);
          expect(calls.writes).toEqual([]);
          expect(await page.evaluate((key) => localStorage.getItem(key), markerKey(mode))).toBeNull();
          if (outcome === 'success') await page.screenshot({ path: output + '/' + mode + '-review-' + locale + '.png', fullPage: true });
        }
        await dialog.getByRole('button', { name: text('fr', confirmKeys[mode]), exact: true }).click();
        await expect.poll(() => calls.writes.length).toBe(1);
        expect(calls.writes).toEqual([{ procedure: procedures[mode], input: expectedInput(mode) }]);
        if (outcome === 'success') {
          await expect(page.getByText(text('fr', successKeys[mode]), { exact: true })).toBeVisible();
          await language(view, page, 'es');
          await expect(page.getByText(text('es', successKeys[mode]), { exact: true })).toBeVisible();
          if (mode === 'sandbox' || mode === 'backtest')
            await expect(page.getByText(provider, { exact: true })).toHaveAttribute('lang', 'und');
          expect(await page.evaluate((key) => localStorage.getItem(key), markerKey(mode))).toBeNull();
        } else if (outcome === 'refused') {
          await expect(page.getByText(provider, { exact: true })).toBeVisible();
          expect(await page.getByText(provider, { exact: true }).evaluate((x) => x.closest('[lang]')?.lang)).toBe('und');
          await language(view, page, 'es');
          await expect(page.getByText(provider, { exact: true })).toHaveText(provider);
          expect(await page.evaluate((key) => localStorage.getItem(key), markerKey(mode))).toBeNull();
        } else {
          await expect(page.getByText(catalogs.fr['common.outcome.not.confirmed'], { exact: true })).toBeVisible();
          const raw = await page.evaluate((key) => localStorage.getItem(key), markerKey(mode));
          const marker = JSON.parse(raw);
          expect(marker.title).toBe(text('en', reviewKeys[mode]));
          expect(typeof marker.id).toBe('string');
          expect(Object.keys(marker).sort()).toEqual(['id', 'title']);
          await expect(page.getByText(marker.title, { exact: true })).toHaveAttribute('lang', 'und');
          await language(view, page, 'es');
          expect(await page.evaluate((key) => localStorage.getItem(key), markerKey(mode))).toBe(raw);
          await expect(page.getByRole('button', { name: text('es', stageKeys[mode]), exact: true })).toBeDisabled();
          await page.reload();
          await login(page, routes[mode]);
          expect(await page.evaluate((key) => localStorage.getItem(key), markerKey(mode))).toBe(raw);
          await expect(page.getByRole('button', { name: text('es', stageKeys[mode]), exact: true })).toBeDisabled();
        }
        expect((await page.evaluate(() => performance.timeOrigin)) === origin || outcome === 'unknown').toBe(true);
        expect(calls.writes).toHaveLength(1);
        expect(calls.errors).toEqual([]);
        await page.screenshot({ path: output + '/' + mode + '-' + outcome + '.png', fullPage: true });
        summary.push({ mode, outcome, exactInput: calls.writes[0].input, noReplay: calls.writes.length === 1, pageErrors: calls.errors });
      },
    );
test('unwired capability refuses simulation review without a write', async ({ page, context }) => {
  const calls = await network(context, 'sandbox', 'success', false);
  await login(page, '/quant/sandbox');
  await fill(page, 'sandbox');
  await expect(page.getByRole('button', { name: text('en', 'review.simulation'), exact: true })).toBeDisabled();
  await expect(page.getByText('quant.sandbox_unwired', { exact: false })).toHaveAttribute('lang', 'zxx');
  expect(calls.writes).toEqual([]);
});
test('legacy original marker remains a primitive original title with no new request', async ({ page, context }) => {
  const calls = await network(context, 'sandbox', 'success');
  const raw = JSON.stringify({
    id: 'legacy-original-id',
    title: 'Original legacy user/provider title <owner>',
    reference: 'original-reference',
  });
  await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), { key: markerKey('sandbox'), raw });
  await login(page, '/quant/sandbox');
  await expect(page.getByText('Original legacy user/provider title <owner>', { exact: true })).toHaveAttribute('lang', 'und');
  await expect(page.getByText('original-reference', { exact: true })).toHaveAttribute('lang', 'zxx');
  await expect(page.getByRole('button', { name: text('en', 'review.simulation'), exact: true })).toBeDisabled();
  expect(await page.evaluate((key) => localStorage.getItem(key), markerKey('sandbox'))).toBe(raw);
  expect(calls.writes).toEqual([]);
});
test('scoped storage failure and missing Web Locks refuse before dispatch and their authored error follows View', async ({
  page,
  context,
}) => {
  const calls = await network(context, 'sandbox', 'success');
  await login(page, '/quant/sandbox');
  await fill(page, 'sandbox');
  const view = await context.newPage();
  await login(view, '/view');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('intafaced:more:pending:')) throw Error('Isolated pending storage failure');
      return original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: text('en', 'review.simulation'), exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('en', 'run.simulation'), exact: true })
    .click();
  await language(view, page, 'fr');
  await expect(page.getByText(catalogs.fr['common.recovery.storage.is.unavailable.no.action.was'], { exact: true })).toBeVisible();
  expect(calls.writes).toEqual([]);
  await page.evaluate(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }));
  await page.getByRole('button', { name: text('fr', 'review.simulation'), exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('fr', 'run.simulation'), exact: true })
    .click();
  await language(view, page, 'es');
  await expect(page.getByText(catalogs.es['common.this.browser.has.no.cross.tab.mutation'], { exact: true })).toBeVisible();
  expect(calls.writes).toEqual([]);
});
test('actual French phone review and long opaque refusal retain native focus targets without overflow', async ({ page, context }) => {
  const calls = await network(context, 'sandbox', 'refused');
  await login(page, '/quant/sandbox');
  await fill(page, 'sandbox');
  const view = await context.newPage();
  await login(view, '/view');
  await language(view, page, 'fr');
  await page.getByRole('button', { name: text('fr', 'review.simulation'), exact: true }).click();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    const confirm = page.getByRole('dialog').getByRole('button', { name: text('fr', 'run.simulation'), exact: true });
    await confirm.focus();
    const fit = await confirm.evaluate((x) => {
      const r = x.getBoundingClientRect();
      return { height: r.height, hit: x.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
    });
    expect(fit.height).toBeGreaterThanOrEqual(44);
    expect(fit.hit).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const axe = await new AxeBuilder({ page }).include('[data-testid="dialog"]').analyze();
    expect(axe.violations.filter((x) => ['serious', 'critical'].includes(x.impact))).toEqual([]);
    await page.screenshot({ path: output + '/review-fr-' + width + '.png', fullPage: true });
  }
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('fr', 'run.simulation'), exact: true })
    .click();
  await expect(page.getByText(provider, { exact: true })).toBeVisible();
  expect(calls.writes).toHaveLength(1);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.getByText(provider, { exact: true }).evaluate((x) => x.closest('[lang]')?.lang)).toBe('und');
    await page.screenshot({ path: output + '/long-refusal-fr-' + width + '.png', fullPage: true });
  }
});
test('native second-tab lock and pending event keep a new simulation from dispatching', async ({ page, context }) => {
  const calls = await network(context, 'sandbox', 'success');
  await login(page, '/quant/sandbox');
  await fill(page, 'sandbox');
  const view = await context.newPage();
  await login(view, '/view');
  const key = markerKey('sandbox');
  await view.evaluate((key) => {
    globalThis.quantLockReady = false;
    void navigator.locks.request('more-action:' + key, async () => {
      globalThis.quantLockReady = true;
      await new Promise((resolve) => {
        globalThis.releaseQuantLock = resolve;
      });
    });
  }, key);
  await expect.poll(() => view.evaluate(() => globalThis.quantLockReady)).toBe(true);
  await page.getByRole('button', { name: text('en', 'review.simulation'), exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: text('en', 'run.simulation'), exact: true })
    .click();
  await expect(page.getByText(catalogs.en['common.this.account.has.an.action.running.in'], { exact: true })).toBeVisible();
  expect(calls.writes).toEqual([]);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
  await view.evaluate(() => globalThis.releaseQuantLock());
  await page.getByRole('button', { name: text('en', 'review.simulation'), exact: true }).click();
  const marker = { id: 'original-peer-request', title: 'Original peer simulation title' };
  await view.evaluate(({ key, marker }) => localStorage.setItem(key, JSON.stringify(marker)), { key, marker });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: text('en', 'review.simulation'), exact: true })).toBeDisabled();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key)).toEqual(marker);
  expect(calls.writes).toEqual([]);
  expect(calls.errors).toEqual([]);
});
for (const [mode, outcome] of [
  ['sandbox', 'mismatch-language'],
  ['sandbox', 'mismatch-environment'],
  ['studio', 'mismatch-name'],
  ['studio', 'mismatch-block'],
  ['backtest', 'mismatch-strategy'],
  ['backtest', 'mismatch-window'],
])
  test('native ' + mode + ' ' + outcome + ' stays unconfirmed under the original reviewed context', async ({ page, context }) => {
    const calls = await network(context, mode, outcome);
    await login(page, routes[mode]);
    await fill(page, mode);
    await page.getByRole('button', { name: text('en', stageKeys[mode]), exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: text('en', confirmKeys[mode]), exact: true })
      .click();
    await expect(page.getByText(catalogs.en['common.outcome.not.confirmed'], { exact: true })).toBeVisible();
    await expect(page.getByTestId('more-success')).toHaveCount(0);
    await expect(page.getByRole('button', { name: text('en', stageKeys[mode]), exact: true })).toBeDisabled();
    const originalMarker = await page.evaluate((key) => localStorage.getItem(key), markerKey(mode));
    expect(JSON.parse(originalMarker).title).toBe(text('en', reviewKeys[mode]));
    expect(calls.writes).toEqual([{ procedure: procedures[mode], input: expectedInput(mode) }]);
    const view = await context.newPage();
    await login(view, '/view');
    await language(view, page, 'fr');
    expect(await page.evaluate((key) => localStorage.getItem(key), markerKey(mode))).toBe(originalMarker);
    expect(calls.writes).toHaveLength(1);
    expect(calls.errors).toEqual([]);
    await page.screenshot({ path: output + '/' + outcome + '.png', fullPage: true });
  });
test.afterAll(() =>
  writeFileSync(
    output + '/native-contract-observations.json',
    JSON.stringify(
      {
        actualApp: true,
        nativeLogin: true,
        preferenceSwitch: 'native second View tab',
        isolatedContracts: true,
        noRealValue: true,
        summary,
      },
      null,
      2,
    ),
  ),
);
