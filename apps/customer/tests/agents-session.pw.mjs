import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const evidence = process.env.AGENTS_EVIDENCE || '/tmp/agents-session-proof';
mkdirSync(evidence, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
const first = '44444444-4444-4444-8444-444444444444',
  second = '55555555-5555-4555-8555-555555555555';
const at = '2026-10-09T10:00:00.000Z',
  markerKey = `intafaced:more:pending:${owner}:agents`;
const uuid = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const row = (extra = {}) => ({
  id: uuid(1),
  sessionId: first,
  agentId: 'navigator',
  sequence: 0,
  kind: 'session_open',
  status: 'executed',
  tool: null,
  task: null,
  model: null,
  inputTokens: '0',
  outputTokens: '0',
  cost: '0',
  refusalCode: null,
  messageKey: 'agents.session.opened',
  messageParams: { agent: 'navigator' },
  occurredAt: at,
  ...extra,
});
const complete = (extra = {}) =>
  row({
    id: uuid(2),
    sequence: 1,
    kind: 'completion',
    task: 'research-summary',
    inputTokens: '18',
    outputTokens: '7',
    cost: '0.015',
    ...extra,
  });
const session = (extra = {}) => ({
  id: first,
  agentId: 'navigator',
  guardrailVersion: 1,
  status: 'open',
  metered: true,
  openedAt: at,
  closedAt: null,
  ...extra,
});
const definition = {
  agentId: 'navigator',
  version: 1,
  enabled: true,
  tools: [{ name: 'trade.quote', module: 'trade', mode: 'read', requiresApproval: false, maxCallsPerSession: 5 }],
  limits: {
    maxActionsPerSession: 10,
    maxOutputTokensPerCall: 100,
    maxSpendPerSession: '1',
    allowedModules: ['trade'],
    allowedTasks: ['research-summary'],
  },
};
const prices = [
  {
    task: 'research-summary',
    maxOutputTokens: 100,
    capability: 'complete',
    inputPerMillion: '0.01',
    outputPerMillion: '0.02',
    assetId: 'USDT',
  },
];
const summaries = [],
  errors = new WeakMap();
test.beforeEach(async ({ context }) => {
  const list = [];
  errors.set(context, list);
  const observe = (page) => page.on('pageerror', (e) => list.push(e.message));
  context.pages().forEach(observe);
  context.on('page', observe);
});
test.afterEach(async ({ context }, info) => {
  expect(errors.get(context)).toEqual([]);
  summaries.push({ name: info.title, status: info.status, pageErrors: errors.get(context) });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summaries, null, 2)));
async function network(context, options = {}) {
  const state = {
    owner,
    log: [complete(), row()],
    history: [row(), complete()],
    usage: { windowId: '2026-10-09T10:00Z', pending: '0.000000000000000001', sessionTotal: '0.015', assetId: 'USDT' },
    reads: [],
    writes: [],
    ...options,
  };
  await context.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      proc = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = req.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : req.postDataJSON();
    const reply = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (proc === 'auth.login')
      return reply({
        userId: state.owner,
        accessToken: 'isolated-agent-' + state.owner,
        refreshToken: 'isolated-refresh-' + state.owner,
        expiresAt: '2027-10-09T10:00:00Z',
      });
    if (proc === 'auth.logout') return reply({ ok: true });
    (req.method() === 'GET' ? state.reads : state.writes).push({ proc, input });
    if (state[proc]) return state[proc](route, input, reply);
    if (proc === 'log.mine') return reply(state.log);
    if (proc === 'session.log') return reply(state.history);
    if (proc === 'usage.current') return reply(state.usage);
    if (proc === 'routes.list') return reply(prices);
    if (proc === 'agent.get') return reply({ ...definition, agentId: input.agentId });
    if (proc === 'coach.session')
      return reply({ status: 'refuse', reason: 'grounding_unavailable', isAdvice: false, positionsReferenced: false, citedCount: 0 });
    if (proc === 'session.open') return reply(session());
    if (proc === 'run.complete')
      return reply({
        text: 'Original English provider response <unchanged>',
        inputTokens: 18,
        outputTokens: 7,
        cost: '0.015',
        assetId: 'USDT',
        metered: true,
        action: complete(),
      });
    if (proc === 'session.close') return reply(session({ status: 'closed', closedAt: at }));
    return route.fulfill({ status: 503, json: { error: { message: 'Isolated unconnected read', data: { code: 'SERVICE_UNAVAILABLE' } } } });
  });
  return state;
}
async function login(page, path = '/agents') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(path + '$'));
}
const selected = (page) => page.getByRole('region', { name: 'Selected session', exact: true });
async function inspect(page, index = 0) {
  await page.getByRole('button', { name: 'Inspect session', exact: true }).nth(index).click();
  await expect(selected(page).getByText(first, { exact: true })).toBeVisible();
}
async function open(page) {
  await page.getByRole('button', { name: 'Review session', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Open agent session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review engine request', exact: true })).toBeVisible();
}
async function reviewRun(page) {
  await open(page);
  await page.getByLabel('Task request', { exact: true }).fill(' Original user request <unaltered> ');
  await page.getByRole('button', { name: 'Review engine request', exact: true }).click();
}
async function shot(page, name) {
  await page.screenshot({ path: evidence + '/' + name + '.png', fullPage: true });
}
async function returnToAgents(page) {
  await page.locator('a[href="/more"]').first().click();
  await page.locator('a[href="/agents"]').first().click();
}
async function marker(page) {
  return page.evaluate((key) => localStorage.getItem(key), markerKey);
}

test('native owner inspects recorded session with exact usage and no writes', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await inspect(page);
  await expect(selected(page)).toContainText('0.000000000000000001 USDT');
  await expect(selected(page)).toContainText('0.015 USDT');
  expect(state.reads.filter((r) => r.proc === 'session.log').every((r) => r.input.sessionId === first)).toBe(true);
  expect(state.writes).toEqual([]);
  await shot(page, 'owned-session-desktop');
});
test('native selected session survives route remount and missing activity window', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await inspect(page);
  state.log = [];
  await returnToAgents(page);
  await expect(selected(page).getByText(first, { exact: true })).toBeVisible();
  await expect(selected(page)).toContainText('0.015 USDT');
  expect(state.writes).toEqual([]);
  await shot(page, 'selected-window-empty');
});
for (const phase of ['loading', 'failed', 'empty'])
  test('native same-session ' + phase + ' recovery suppresses stale history', async ({ page, context }) => {
    const state = await network(context);
    await login(page);
    await inspect(page);
    let release;
    state['session.log'] = async (route, input, reply) => {
      if (phase === 'loading') {
        await new Promise((done) => (release = done));
        return reply(state.history);
      }
      if (phase === 'empty') return reply([]);
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Original English history failure', data: { code: 'SERVICE_UNAVAILABLE' } } },
      });
    };
    await selected(page).getByRole('button', { name: 'Refresh session', exact: true }).click();
    await expect(selected(page).getByText(first, { exact: true })).toBeVisible();
    await expect(selected(page).locator('.agent-session-history')).toHaveCount(0);
    await shot(page, 'history-' + phase);
    if (release) release();
    else delete state['session.log'];
    if (phase !== 'loading') await selected(page).getByRole('button', { name: 'Refresh session', exact: true }).click();
    await expect(selected(page).locator('.agent-session-history li')).toHaveCount(2);
    expect(state.writes).toEqual([]);
  });
for (const mismatch of ['foreign', 'duplicate', 'backwards', 'negative', 'amount'])
  test('native invalid session history ' + mismatch + ' refuses', async ({ page, context }) => {
    const invalid =
      mismatch === 'foreign'
        ? [row({ sessionId: second })]
        : mismatch === 'duplicate'
          ? [row(), row()]
          : mismatch === 'backwards'
            ? [complete(), row()]
            : mismatch === 'negative'
              ? [row({ sequence: -1 })]
              : [row({ cost: 'bad' })];
    const state = await network(context, { history: invalid });
    await login(page);
    await inspect(page);
    await expect(selected(page).locator('.agent-session-history')).toHaveCount(0);
    await expect(selected(page).locator('.failure')).toBeVisible();
    expect(state.writes).toEqual([]);
  });
test('native recorded-window filter and exact larger bound preserve original session', async ({ page, context }) => {
  const records = Array.from({ length: 50 }, (_, n) =>
    complete({ id: uuid(n + 100), sequence: n, sessionId: n === 0 ? second : first, agentId: n === 0 ? 'support' : 'navigator' }),
  );
  const state = await network(context, { log: records });
  await login(page);
  await page.getByLabel('Filter recorded sessions').selectOption('navigator');
  await inspect(page);
  await page.getByRole('button', { name: 'Load a larger window', exact: true }).click();
  await expect.poll(() => state.reads.filter((r) => r.proc === 'log.mine').at(-1).input.limit).toBe(100);
  await expect(selected(page).getByText(first, { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});
test('native owner change suppresses private selected context', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await inspect(page);
  await page.locator('a[href="/more"]').first().click();
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  state.owner = other;
  state.log = [];
  await login(page);
  await expect(selected(page).getByText(first, { exact: true })).toHaveCount(0);
  expect(state.reads.filter((r) => r.proc === 'session.log').length).toBe(1);
  expect(state.writes).toEqual([]);
});
for (const width of [320, 390, 768])
  test('native phone exact usage privacy and keyboard ' + width, async ({ page, context }) => {
    const state = await network(context);
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await inspect(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const refresh = selected(page).getByRole('button', { name: 'Refresh session', exact: true });
    await refresh.focus();
    await page.keyboard.press('Enter');
    expect((await refresh.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(selected(page)).toContainText('0.000000000000000001 USDT');
    await shot(page, 'phone-' + width);
    const view = await context.newPage();
    await login(view, '/view');
    await view.getByLabel('Hide balance values', { exact: true }).check();
    await expect(selected(page)).not.toContainText('0.000000000000000001');
    await expect(selected(page)).not.toContainText('0.015');
    await shot(page, 'hidden-' + width);
    expect(state.writes).toEqual([]);
  });
for (const locale of ['es', 'fr'])
  test('native open request review follows second-tab ' + locale + ' with original payload', async ({ page, context }) => {
    const state = await network(context);
    await login(page);
    await reviewRun(page);
    const view = await context.newPage();
    await login(view, '/view');
    await view
      .locator('select')
      .filter({ has: view.locator('option[value="es"]') })
      .selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    const dialog = page.getByRole('dialog');
    await expect(dialog).not.toHaveAccessibleName('Review metered engine request');
    await expect(dialog.getByText(' Original user request <unaltered> ', { exact: true })).toHaveAttribute('lang', 'und');
    await shot(page, 'review-' + locale);
    await dialog.locator('.actions button').last().click();
    await expect.poll(() => state.writes.filter((r) => r.proc === 'run.complete').length).toBe(1);
    const request = state.writes.find((r) => r.proc === 'run.complete').input;
    expect(request).toMatchObject({
      sessionId: first,
      task: 'research-summary',
      messages: [{ role: 'user', content: ' Original user request <unaltered> ' }],
      maxOutputTokens: 100,
    });
    expect(typeof request.requestId).toBe('string');
    await expect(page.getByText('Original English provider response <unchanged>', { exact: true })).toHaveAttribute('lang', 'und');
  });
for (const key of ['task', 'kind', 'status', 'cost', 'input', 'output', 'asset', 'unmetered'])
  test('native wrong completion echo ' + key + ' stays blocked', async ({ page, context }) => {
    const state = await network(context, {
      'run.complete': (route, input, reply) => {
        const action = complete(
          key === 'task'
            ? { task: 'another-task' }
            : key === 'kind'
              ? { kind: 'tool_call' }
              : key === 'status'
                ? { status: 'failed' }
                : key === 'cost'
                  ? { cost: '0.016' }
                  : {},
        );
        return reply({
          text: 'Invalid original result',
          inputTokens: key === 'input' ? 19 : 18,
          outputTokens: key === 'output' ? 8 : 7,
          cost: '0.015',
          assetId: key === 'asset' ? 'BTC' : 'USDT',
          metered: key !== 'unmetered',
          action,
        });
      },
    });
    await login(page);
    await reviewRun(page);
    await page.getByRole('dialog').getByRole('button', { name: 'Run engine request', exact: true }).click();
    await expect.poll(() => marker(page)).not.toBeNull();
    await expect(page.getByText('Invalid original result', { exact: true })).toHaveCount(0);
    const original = await marker(page);
    await returnToAgents(page);
    await expect.poll(() => marker(page)).toBe(original);
    await selected(page).getByRole('button', { name: 'Refresh session', exact: true }).click();
    await expect.poll(() => marker(page)).toBe(original);
    expect(state.writes.filter((r) => r.proc === 'run.complete')).toHaveLength(1);
  });
test('native denied metered-use permission refuses without session invention', async ({ page, context }) => {
  const state = await network(context, {
    'session.open': (route) =>
      route.fulfill({ status: 403, json: { error: { message: 'Metered-use permission not issued', data: { code: 'FORBIDDEN' } } } }),
  });
  await login(page);
  await page.getByRole('button', { name: 'Review session', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Open agent session', exact: true }).click();
  await expect(page.getByText('Metered-use permission not issued', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review engine request', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});
test('native valid original closure confirms matching terminal session', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await open(page);
  await page.getByRole('button', { name: 'Review session closure', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Settle and close session', exact: true }).click();
  await expect(page.getByText('Session closure received', { exact: true })).toBeVisible();
  expect(state.writes.find((r) => r.proc === 'session.close').input).toEqual({ sessionId: first });
});
test('native read-only journey has no serious accessibility defects', async ({ page, context }) => {
  await network(context);
  await login(page);
  await inspect(page);
  const result = await new AxeBuilder({ page }).include('.agent-session-journey').analyze();
  expect(result.violations.filter((v) => ['critical', 'serious'].includes(v.impact))).toEqual([]);
  writeFileSync(evidence + '/axe.json', JSON.stringify(result, null, 2));
});

test('native stale read cannot replace newly selected original session', async ({ page, context }) => {
  const state = await network(context, { log: [complete(), row({ id: uuid(20), sessionId: second, agentId: 'support' })] });
  let release;
  state['session.log'] = async (route, input, reply) => {
    if (input.sessionId === first) {
      await new Promise((done) => (release = done));
      return reply([row()]);
    }
    return reply([row({ id: uuid(20), sessionId: second, agentId: 'support' })]);
  };
  await login(page);
  await page.getByRole('button', { name: 'Inspect session', exact: true }).nth(0).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.getByRole('button', { name: 'Inspect session', exact: true }).nth(1).click();
  await expect(selected(page).getByText(second, { exact: true })).toBeVisible();
  release();
  await expect(selected(page).locator('.agent-session-history')).not.toContainText(first);
  expect(state.writes).toEqual([]);
});
test('native long exact amount and unit fit320 and ordinary private boundary', async ({ page, context }) => {
  const value = '99999999999999999999.999999999999999999';
  const state = await network(context, { usage: { windowId: 'original-window', pending: value, sessionTotal: value, assetId: 'USDT' } });
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/login?redirect=%2Fagents');
  expect(state.reads).toEqual([]);
  expect(state.writes).toEqual([]);
  await login(page);
  await inspect(page);
  await expect(selected(page)).toContainText('99,999,999,999,999,999,999.999999999999999999 USDT');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, 'long-exact320');
  expect(state.writes).toEqual([]);
});
test('native Tab reaches same-session refresh with visible touch target', async ({ page, context }) => {
  await network(context);
  await page.setViewportSize({ width: 320, height: 900 });
  await login(page);
  await inspect(page);
  const refresh = selected(page).getByRole('button', { name: 'Refresh session', exact: true });
  for (let step = 0; step < 60 && !(await refresh.evaluate((el) => el === document.activeElement)); step++)
    await page.keyboard.press('Tab');
  await expect(refresh).toBeFocused();
  expect((await refresh.boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect(
    await refresh.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
    }),
  ).toBe(true);
  await page.keyboard.press('Enter');
  await expect(selected(page).locator('.agent-session-history li')).toHaveCount(2);
  await shot(page, 'tab-refresh320');
});
test('native logout during successful fresh preflight sends no completion', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await reviewRun(page);
  let release;
  state['agent.get'] = async (route, input, reply) => {
    await new Promise((done) => (release = done));
    return reply(definition);
  };
  await page.getByRole('dialog').getByRole('button', { name: 'Run engine request', exact: true }).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  release();
  await expect.poll(() => state.writes.filter((r) => r.proc === 'run.complete').length).toBe(0);
  await expect.poll(() => marker(page)).toBeNull();
});

const preflightCases = [
  {
    branch: 'guard-version',
    operation: 'session.open',
    reason: 'error',
    en: 'The agent guardrails changed. Reload and review again.',
    es: 'Las restricciones del agente han cambiado. Vuelve a cargar y revisar.',
    fr: 'Les garde-fous de l’agent ont changé. Recharge et vérifie à nouveau.',
  },
  {
    branch: 'open-context',
    operation: 'session.open',
    reason: 'aborted',
    en: 'The account changed. Review this session again.',
    es: 'La cuenta ha cambiado. Revisa esta sesión de nuevo.',
    fr: 'Le compte a changé. Vérifie à nouveau cette session.',
  },
  {
    branch: 'route-price',
    operation: 'run.complete',
    reason: 'error',
    en: 'Agent permissions or routing prices changed. Reload and review this request again.',
    es: 'Los permisos del agente o los precios de enrutamiento han cambiado. Vuelve a cargar y revisar esta solicitud.',
    fr: 'Les autorisations de l’agent ou les tarifs de routage ont changé. Recharge et vérifie à nouveau cette demande.',
  },
  {
    branch: 'run-context',
    operation: 'run.complete',
    reason: 'aborted',
    en: 'The account or session changed. Review again.',
    es: 'La cuenta o la sesión han cambiado. Revisa de nuevo.',
    fr: 'Le compte ou la session a changé. Vérifie à nouveau.',
  },
];
for (const scenario of preflightCases)
  for (const locale of ['es', 'fr'])
    test('native original preflight ' + scenario.branch + ' failure follows later View ' + locale, async ({ page, context }) => {
      const state = await network(context);
      await login(page);
      if (scenario.operation === 'run.complete') {
        await reviewRun(page);
        await expect(page.getByRole('dialog').getByText(' Original user request <unaltered> ', { exact: true })).toHaveAttribute(
          'lang',
          'und',
        );
      } else await page.getByRole('button', { name: 'Review session', exact: true }).click();
      let release;
      state['agent.get'] = async (route, input, reply) => {
        if (input.agentId !== 'navigator') return reply({ ...definition, agentId: input.agentId });
        await new Promise((done) => (release = done));
        return reply(scenario.branch === 'guard-version' ? { ...definition, version: 2 } : definition);
      };
      if (scenario.branch === 'route-price')
        state['routes.list'] = (route, input, reply) => reply(prices.map((row) => ({ ...row, inputPerMillion: '0.03' })));
      await page
        .getByRole('dialog')
        .getByRole('button', {
          name: scenario.operation === 'run.complete' ? 'Run engine request' : 'Open agent session',
          exact: true,
        })
        .click();
      await expect.poll(() => typeof release).toBe('function');
      const originalMarker = JSON.parse(await marker(page));
      expect(originalMarker.reference).toMatch(scenario.operation === 'run.complete' ? /^[0-9a-f-]{36}$/ : /^navigator$/);
      expect(state.reads.filter((r) => r.proc === 'agent.get').at(-1).input).toEqual({ agentId: 'navigator' });
      if (scenario.branch === 'open-context')
        await page.getByRole('combobox', { name: 'Product agent', exact: true }).selectOption('support');
      if (scenario.branch === 'run-context')
        await page.getByRole('textbox', { name: 'Task request', exact: true }).fill('Changed after review');
      expect(JSON.parse(await marker(page))).toEqual(originalMarker);
      release();
      const failure = page.getByText(scenario.en, { exact: true });
      await expect(failure).toBeVisible();
      await expect(failure.locator('xpath=..').getByRole('heading')).toHaveText(
        scenario.reason === 'error' ? 'The request was refused' : 'Request stopped',
      );
      expect(await failure.evaluate((el) => el.closest('[lang]')?.getAttribute('lang'))).toBe('en');
      await expect.poll(() => marker(page)).toBeNull();
      expect(state.writes.filter((r) => r.proc === scenario.operation)).toHaveLength(0);
      const view = await context.newPage();
      await login(view, '/view');
      await view
        .locator('select')
        .filter({ has: view.locator('option[value="es"]') })
        .selectOption(locale);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const translated = page.getByText(scenario[locale], { exact: true });
      await expect(translated).toBeVisible();
      expect(await translated.evaluate((el) => el.closest('[lang]')?.getAttribute('lang'))).toBe(locale);
      await expect(page.getByText(scenario.en, { exact: true })).toHaveCount(0);
      expect(state.writes.filter((r) => r.proc === scenario.operation)).toHaveLength(0);
      await shot(page, 'preflight-' + scenario.branch + '-' + locale);
    });

for (const locale of ['en', 'es', 'fr'])
  test('native history heading follows ' + locale + ' while original nodes and private values stay bound', async ({ page, context }) => {
    const state = await network(context);
    await login(page);
    await inspect(page);
    const rows = page.locator('.agent-session-history > li');
    const originalOpen = await rows.first().elementHandle();
    const originalComplete = await rows.nth(1).elementHandle();
    const headings = {
      en: ['Session opened · Executed', 'Engine response · Executed'],
      es: ['Sesión iniciada · Ejecutado', 'Respuesta del motor · Ejecutado'],
      fr: ['Session ouverte · Exécuté', 'Réponse du moteur · Exécuté'],
    };
    await expect(rows.first().locator(':scope > strong')).toHaveText(headings.en[0]);
    await expect(rows.nth(1).locator(':scope > strong')).toHaveText(headings.en[1]);
    const view = await context.newPage();
    await login(view, '/view');
    await view.getByLabel('Hide balance values', { exact: true }).check();
    await view
      .locator('select')
      .filter({ has: view.locator('option[value="es"]') })
      .selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(rows.first().locator(':scope > strong')).toHaveText(headings[locale][0]);
    await expect(rows.nth(1).locator(':scope > strong')).toHaveText(headings[locale][1]);
    expect(await rows.first().evaluate((el, old) => el === old, originalOpen)).toBe(true);
    expect(await rows.nth(1).evaluate((el, old) => el === old, originalComplete)).toBe(true);
    for (const [index, action] of [row(), complete()].entries()) {
      await expect(rows.nth(index).locator(':scope > small').first()).toHaveText(action.sequence + ' · ' + action.id);
      await expect(rows.nth(index).locator(':scope > small').first()).toHaveAttribute('lang', 'zxx');
      await expect(rows.nth(index).locator(':scope > strong span').first()).toHaveAttribute('lang', locale);
    }
    await expect(page.locator('.agent-session-journey')).not.toContainText('0.000000000000000001');
    await expect(page.locator('.agent-session-history')).not.toContainText('0.015');
    expect(state.writes).toEqual([]);
    await shot(page, 'history-heading-' + locale);
  });
