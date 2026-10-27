import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const evidence = process.env.HELP_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111',
  other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const title = 'Sign-in and account access',
  body = 'Support never asks for your password or recovery codes in chat.';
const row = (id = 'kb-account-access', version = 1, extra = {}) => ({
  id,
  titleKey: 'support.kb.account_access.title',
  bodyKey: 'support.kb.account_access.body',
  version,
  revision: version,
  published: true,
  ...extra,
});
const reply = (route, data) => route.fulfill({ status: 200, json: { result: { data } } });
const refusal = (route, status = 503, message = 'Isolated public read unavailable', code = 'SERVICE_UNAVAILABLE') =>
  route.fulfill({ status, json: { error: { message, data: { code } } } });
function held() {
  let release;
  return {
    promise: new Promise((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
async function departedReply(route, data) {
  try {
    await reply(route, data);
  } catch (error) {
    const failure = route.request().failure()?.errorText;
    if (route.request().frame().page().isClosed() || ['net::ERR_ABORTED', 'net::ERR_FAILED'].includes(failure)) return;
    throw error;
  }
}
const errors = new WeakMap(),
  summaries = [];
test.beforeEach(({ context }) => {
  const list = [];
  errors.set(context, list);
  const watch = (page) => page.on('pageerror', () => list.push('pageerror'));
  context.pages().forEach(watch);
  context.on('page', watch);
});
test.afterEach(({ context }, info) => {
  expect(errors.get(context)).toEqual([]);
  summaries.push({ name: info.title, status: info.status, pageErrors: errors.get(context).length });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summaries, null, 2)));
async function network(context, options = {}) {
  const state = { gets: [], posts: [], allPosts: [], lists: [row()], sequence: 0, owner, ...options };
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'POST' ? request.postDataJSON() : JSON.parse(url.searchParams.get('input') || 'null');
    if (request.method() === 'POST') {
      state.allPosts.push(procedure);
      if (procedure !== 'auth.login' && procedure !== 'auth.refresh' && procedure !== 'auth.logout') state.posts.push(procedure);
    }
    // Models the HttpOnly `ifc_rt` cookie: sign-in sets it, logout clears it, and a bare refresh without it is session_invalid.
    if (procedure === 'auth.refresh' && !state.cookie)
      return route.fulfill({
        status: 401,
        json: { error: { message: 'Session not found', data: { intafacedCode: 'auth.session_invalid' } } },
      });
    if (procedure === 'auth.login') state.cookie = true;
    if (procedure === 'auth.logout') state.cookie = false;
    if (procedure === 'auth.login' || procedure === 'auth.refresh')
      return reply(route, {
        userId: state.owner,
        accessToken: 'isolated-help-session-' + ++state.sequence,
        refreshToken: 'isolated-help-refresh-' + state.sequence,
        expiresAt:
          procedure === 'auth.login' && state.refreshAfterMs
            ? new Date(Date.now() + 30000 + state.refreshAfterMs).toISOString()
            : '2027-10-10T00:00:00.000Z',
      });
    if (procedure === 'auth.logout') return reply(route, { ok: true });
    if (procedure === 'searchKb' || procedure === 'getKb') {
      state.gets.push({ procedure, input, sequence: state.sequence });
      if (state[procedure]) return state[procedure](route, input);
      return reply(route, procedure === 'searchKb' ? state.lists.slice(0, input.limit) : row(input.id, input.version ?? 2));
    }
    return refusal(route);
  });
  return state;
}
const address = (id, version) => '/helpdetail?id=' + encodeURIComponent(id) + (version === undefined ? '' : '&version=' + version);
const ready = (page) => page.getByTestId('help__body');
async function login(page, destination = '/help') {
  await page.goto('/login?redirect=' + encodeURIComponent(destination));
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  // Public rooms cannot be private safeReturnTo targets; enter Help after native authentication.
  await expect.poll(() => page.evaluate(() => location.pathname === '/money')).toBe(true);
  await page.evaluate((destination) => {
    history.pushState(null, '', destination);
    dispatchEvent(new PopStateEvent('popstate'));
  }, destination);
  await expect(page.getByTestId('help')).toBeVisible();
}
async function changeURL(page, destination) {
  await page.evaluate((destination) => {
    history.pushState(null, '', destination);
    dispatchEvent(new PopStateEvent('popstate'));
  }, destination);
}
async function locale(context, language) {
  const page = await context.newPage();
  await page.goto('/login?redirect=%2Fview');
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await page
    .locator('select')
    .filter({ has: page.locator('option[value="es"]') })
    .selectOption(language);
  return page;
}
async function shot(page, name) {
  await page.screenshot({
    path: evidence + '/' + name + '.png',
    fullPage: true,
    mask: [
      page.locator(
        '[data-testid="help__private"],input[name="help-search"],input[autocomplete="username"],input[autocomplete="current-password"]',
      ),
    ],
  });
}

test('direct exact article outside the loaded catalogue uses only its original getKb', async ({ context, page }) => {
  const s = await network(context);
  const id = 'isolated-help-private-outside-window';
  await page.goto(address(id, 7));
  await expect(ready(page)).toContainText(body);
  expect(s.gets.length).toBe(1);
  expect(s.gets[0].procedure).toBe('getKb');
  expect(s.gets[0].input.id === id && s.gets[0].input.version === 7).toBe(true);
  await expect(page.getByTestId('help__heading')).toContainText('Published version 7');
  expect(s.posts).toEqual([]);
  expect(s.allPosts).toEqual([]);
});
test('native catalogue article link preserves exact ID and returned version without a list preflight', async ({ context, page }) => {
  const id = 'isolated-help-private /?#+漢字&=',
    s = await network(context, { lists: [row(id, 4)] });
  await page.goto('/help');
  await page.getByRole('link', { name: 'Read answer: ' + title, exact: true }).click();
  await expect(ready(page)).toContainText(body);
  expect(
    await page.evaluate(
      ({ id }) => new URL(location.href).searchParams.get('id') === id && new URL(location.href).searchParams.get('version') === '4',
      { id },
    ),
  ).toBe(true);
  expect(s.gets.map((item) => item.procedure)).toEqual(['searchKb', 'getKb']);
  expect(s.gets[1].input.id === id).toBe(true);
  expect(s.posts).toEqual([]);
});
for (const [name, query] of [
  ['no ID', 'version=1'],
  ['empty ID', 'id='],
  ['blank ID', 'id=%20'],
  ['duplicate ID', 'id=a&id=b'],
  ['decoded duplicate ID', 'id=a&%69d=b'],
  ['duplicate version', 'id=a&version=1&version=2'],
  ['zero version', 'id=a&version=0'],
  ['fractional version', 'id=a&version=1.5'],
  ['exponential version', 'id=a&version=1e2'],
  ['unsafe integer', 'id=a&version=9007199254740992'],
  ['empty version', 'id=a&version='],
  ['malformed escape', 'id=%ZZ'],
  ['invalid UTF8', 'id=%C0%AF'],
  ['unknown field', 'id=a&q=hidden'],
  ['overlong ID', 'id=' + 'a'.repeat(201)],
])
  test('malformed or ambiguous exact Help address refuses before any GET: ' + name, async ({ context, page }) => {
    const s = await network(context);
    await page.goto('/helpdetail?' + query);
    await expect(page.getByRole('heading', { name: 'This Help address is invalid', exact: true })).toBeVisible();
    expect(s.gets).toEqual([]);
    expect(s.posts).toEqual([]);
    await expect(page.getByRole('link', { name: 'Browse published answers', exact: true })).toBeVisible();
  });
for (const [name, data] of [
  ['wrong ID', row('wrong', 1)],
  ['wrong version', row('kb-account-access', 2)],
  ['unpublished', row('kb-account-access', 1, { published: false })],
  [
    'missing explicit generation',
    { id: 'kb-account-access', titleKey: 'support.kb.account_access.title', bodyKey: 'support.kb.account_access.body' },
  ],
  ['invalid generation', row('kb-account-access', 0)],
  ['unsafe generation', row('kb-account-access', 9007199254740992)],
])
  test('unverifiable exact response cannot render another article or version: ' + name, async ({ context, page }) => {
    const s = await network(context, { getKb: (route) => reply(route, data) });
    await page.goto(address('kb-account-access', 1));
    await expect(page.getByRole('heading', { name: 'Answer unavailable', exact: true })).toBeVisible();
    await expect(ready(page)).toHaveCount(0);
    expect(s.gets.length).toBe(1);
    expect(s.posts).toEqual([]);
  });
test('omitted published and generation remain readable legacy latest without invented version one', async ({ context, page }) => {
  const legacy = { id: 'legacy', titleKey: 'support.kb.account_access.title', bodyKey: 'support.kb.account_access.body' },
    s = await network(context, { lists: [legacy], getKb: (route) => reply(route, legacy) });
  await page.goto('/help');
  await expect(page.getByTestId('help__list')).toContainText('Published answer');
  await expect(page.getByTestId('help__list')).not.toContainText('version 1');
  await page.getByRole('link', { name: 'Read answer: ' + title, exact: true }).click();
  await expect(ready(page)).toContainText(body);
  expect(Object.keys(s.gets.at(-1).input)).toEqual(['id']);
  await expect(page.getByTestId('help__heading')).toContainText('Published answer');
});
test('null latest is an explicit empty read without a silent catalogue fallback', async ({ context, page }) => {
  const s = await network(context, { getKb: (route) => reply(route, null) });
  await page.goto(address('missing'));
  await expect(page.getByRole('heading', { name: 'No published answer returned', exact: true })).toBeVisible();
  expect(s.gets.map((item) => item.procedure)).toEqual(['getKb']);
  expect(s.posts).toEqual([]);
});
test('actual named 412 without cause identifies missing requested version and latest is a separate native read', async ({
  context,
  page,
}) => {
  const s = await network(context, {
    getKb: (route, input) =>
      input.version === 3 ? refusal(route, 412, 'support.kb_version_unknown', 'PRECONDITION_FAILED') : reply(route, row(input.id, 2)),
  });
  await page.goto(address('kb-account-access', 3));
  await expect(page.getByRole('heading', { name: 'This version is unavailable', exact: true })).toBeVisible();
  await expect(page.getByTestId('help__original')).toContainText('Requested version 3');
  expect(s.gets.length).toBe(1);
  await page.getByRole('link', { name: 'Read latest version', exact: true }).click();
  await expect(ready(page)).toContainText(body);
  expect(s.gets.length).toBe(2);
  expect(Object.keys(s.gets[1].input)).toEqual(['id']);
  await expect(page.getByTestId('help__heading')).toContainText('Published version 2');
  expect(s.posts).toEqual([]);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'This version is unavailable', exact: true })).toBeVisible();
  expect(s.gets.at(-1).input.version).toBe(3);
  await shot(page, 'missing-version');
});
for (const [name, status, message, code] of [
  ['generic 412', 412, 'Different precondition', 'PRECONDITION_FAILED'],
  ['named wrong status', 500, 'support.kb_version_unknown', 'PRECONDITION_FAILED'],
  ['contradictory cause-style code', 412, 'support.kb_version_unknown', 'support.kb_version_unknown'],
])
  test('generic or contradictory failure cannot become a named missing version: ' + name, async ({ context, page }) => {
    await network(context, { getKb: (route) => refusal(route, status, message, code) });
    await page.goto(address('kb-account-access', 3));
    await expect(page.getByRole('heading', { name: 'Answer unavailable', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'This version is unavailable', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  });
test('failed exact read retry preserves original ID version and never claims publication before reply', async ({ context, page }) => {
  let failed = true;
  const s = await network(context, { getKb: (route, input) => (failed ? refusal(route) : reply(route, row(input.id, input.version))) });
  await page.goto(address('kb-account-access', 4));
  await expect(page.getByRole('heading', { name: 'Answer unavailable', exact: true })).toBeVisible();
  await expect(page.getByTestId('help__original')).toContainText('Requested version 4');
  await expect(page.getByTestId('help')).not.toContainText('Published version 4');
  await shot(page, 'failed-exact');
  failed = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(ready(page)).toContainText(body);
  expect(s.gets.length).toBe(2);
  expect(JSON.stringify(s.gets[0].input) === JSON.stringify(s.gets[1].input)).toBe(true);
  expect(s.posts).toEqual([]);
});
test('readable published content remains separate from unknown or interpolated catalogue keys', async ({ context, page }) => {
  const s = await network(context, {
    getKb: (route) => reply(route, row('kb-account-access', 1, { titleKey: 'opaque.unknown.title', bodyKey: 'ui.list.items' })),
  });
  await page.goto(address('kb-account-access', 1));
  await expect(page.getByRole('heading', { name: 'Article text unavailable', exact: true })).toBeVisible();
  await expect(ready(page)).toContainText('no readable text');
  await expect(page.getByTestId('help')).not.toContainText('opaque.unknown.title');
  await expect(page.getByTestId('help')).not.toContainText('ui.list.items');
  expect(s.posts).toEqual([]);
});
for (const [name, bodyKey] of [
  ['known interpolation', 'auth.twofa.prompt'],
  ['known plural', 'common.results'],
])
  test('published references without parameters do not invent article prose: ' + name, async ({ context, page }) => {
    const s = await network(context, { getKb: (route) => reply(route, row('kb-account-access', 1, { bodyKey })) });
    await page.goto(address('kb-account-access', 1));
    await expect(ready(page)).toContainText('no readable text');
    await expect(ready(page)).not.toContainText(bodyKey);
    await expect(ready(page)).not.toContainText('{');
    expect(s.posts).toEqual([]);
  });
test('historical published article remains an exact read when a separate latest read returns null', async ({ context, page }) => {
  const s = await network(context, {
    getKb: (route, input) => reply(route, input.version === 1 ? row(input.id, 1) : null),
  });
  await page.goto(address('kb-account-access', 1));
  await expect(ready(page)).toContainText(body);
  await page.getByRole('link', { name: 'Read latest published version →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No published answer returned', exact: true })).toBeVisible();
  expect(s.gets.length).toBe(2);
  expect(s.gets[0].input.version).toBe(1);
  expect(Object.keys(s.gets[1].input)).toEqual(['id']);
  await page.goBack();
  await expect(ready(page)).toContainText(body);
  expect(s.gets.at(-1).input.version).toBe(1);
  expect(s.posts).toEqual([]);
});
test('maximum opaque decoded ID remains exact and fits at 320 without storage or publication claims on failure', async ({
  context,
  page,
}) => {
  const id = 'isolated-help-private-' + '漢'.repeat(177) + '/';
  expect(id.length).toBe(200);
  const s = await network(context, { getKb: (route) => refusal(route, 500, 'Isolated English read failure', 'INTERNAL_SERVER_ERROR') });
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.goto(address(id, 9));
  await expect(page.getByRole('heading', { name: 'Answer unavailable', exact: true })).toBeVisible();
  expect(s.gets.length === 1 && s.gets[0].input.id === id && s.gets[0].input.version === 9).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate((id) => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(id), id)).toBe(true);
  await expect(page.getByTestId('help')).not.toContainText('Published version 9');
  await shot(page, 'long-exact-failure-320');
  expect(s.posts).toEqual([]);
});
test('natural search filters actual loaded prose locally and private query never leaves RAM', async ({ context, page }) => {
  const s = await network(context, {
    lists: [row(), row('security', 1, { titleKey: 'support.kb.security_basics.title', bodyKey: 'support.kb.security_basics.body' })],
  });
  await page.goto('/help');
  await expect(page.getByTestId('help__row')).toHaveCount(2);
  await page.getByLabel('Search loaded answers', { exact: true }).fill('password');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByTestId('help__row')).toHaveCount(1);
  await expect(page.getByTestId('help__row')).toContainText(title);
  const privateQuery = 'isolated-help-private-search-value';
  await page.getByLabel('Search loaded answers', { exact: true }).fill(privateQuery);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('help__empty')).toContainText('No matches in loaded answers');
  expect(s.gets.length).toBe(1);
  expect(s.gets[0].input.q).toBe('');
  expect(
    await page.evaluate(
      (value) => !location.href.includes(value) && !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(value),
      privateQuery,
    ),
  ).toBe(true);
  expect(s.posts).toEqual([]);
});
test('full bounded catalogue expands only 100 through 500 with no cursor total or whole catalogue claim', async ({ context, page }) => {
  const rows = Array.from({ length: 600 }, (_, i) => row('public-' + i));
  const s = await network(context, { lists: rows });
  await page.goto('/help');
  for (const limit of [100, 200, 300, 400, 500]) {
    await expect(page.getByTestId('help__row')).toHaveCount(limit);
    expect(s.gets.at(-1).input).toEqual({ q: '', limit });
    if (limit < 500) await page.getByRole('button', { name: 'Load more published answers', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Load more published answers', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('help')).toContainText('may not include the complete catalogue');
  expect(s.gets.map((x) => x.input.limit)).toEqual([100, 200, 300, 400, 500]);
  expect(s.posts).toEqual([]);
});
for (const [name, rows] of [
  ['empty', []],
  ['partial', [row()]],
])
  test('partial public window never invents a continuation: ' + name, async ({ context, page }) => {
    await network(context, { lists: rows });
    await page.goto('/help');
    await expect(page.getByRole('button', { name: 'Load more published answers', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('help')).toContainText(name === 'empty' ? 'No published answers returned' : title);
  });
for (const [name, rows] of [
  ['duplicates', [row(), row()]],
  ['unpublished', [row('draft', 1, { published: false })]],
  ['invalid version', [row('bad', 0)]],
  ['overwindow', Array.from({ length: 101 }, (_, i) => row('over-' + i))],
])
  test('invalid public catalogue hides unverifiable rows: ' + name, async ({ context, page }) => {
    await network(context, { searchKb: (route) => reply(route, rows) });
    await page.goto('/help');
    await expect(page.locator('[data-testid="help"] [data-testid="failure"]')).toBeVisible();
    await expect(page.getByTestId('help__row')).toHaveCount(0);
  });
test('loading and failed window expansion conceal all former public rows and retry same window', async ({ context, page }) => {
  const gate = held();
  let failed = true;
  const s = await network(context, {
    searchKb: async (route, input) => {
      if (input.limit === 100)
        return reply(
          route,
          Array.from({ length: 100 }, (_, i) => row('loaded-' + i)),
        );
      await gate.promise;
      return failed ? refusal(route) : reply(route, [row()]);
    },
  });
  await page.goto('/help');
  await expect(page.getByTestId('help__row')).toHaveCount(100);
  await page.getByRole('button', { name: 'Load more published answers', exact: true }).click();
  await expect(page.getByTestId('help__row')).toHaveCount(0);
  gate.release();
  await expect(page.locator('[data-testid="help"] [data-testid="failure"]')).toBeVisible();
  await expect(page.getByTestId('help__row')).toHaveCount(0);
  failed = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByTestId('help__row')).toHaveCount(1);
  expect(s.gets.map((x) => x.input.limit)).toEqual([100, 200, 200]);
  expect(s.posts).toEqual([]);
});
test('held original exact response cannot replace query-only newer article or revive it after Back', async ({ context, page }) => {
  const gate = held(),
    id = 'isolated-help-private-original';
  const s = await network(context, {
    getKb: async (route, input) => {
      if (input.id === id && s.gets.filter((x) => x.input.id === id).length === 1) {
        await gate.promise;
        return departedReply(route, row(id, 1));
      }
      return reply(
        route,
        row(input.id, input.version, { titleKey: 'support.kb.security_basics.title', bodyKey: 'support.kb.security_basics.body' }),
      );
    },
  });
  await page.goto(address(id, 1));
  await expect.poll(() => s.gets.length).toBe(1);
  await changeURL(page, address('newer', 2));
  await expect(page.getByRole('heading', { name: 'Security basics', exact: true })).toBeVisible();
  gate.release();
  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(ready(page)).toBeVisible();
  expect(s.gets.at(-1).input.id === id && s.gets.at(-1).input.version === 1).toBe(true);
  expect(s.posts).toEqual([]);
});
test('actual token refresh during held exact read discards old context and reads the same target freshly', async ({ context, page }) => {
  const gate = held();
  const s = await network(context, {
    refreshAfterMs: 2000,
    getKb: async (route, input) => {
      if (s.sequence === 1) {
        await gate.promise;
        return departedReply(route, row(input.id, input.version, { titleKey: 'support.kb.orders_status.title' }));
      }
      return reply(route, row(input.id, input.version));
    },
  });
  await login(page, address('kb-account-access', 1));
  await expect.poll(() => s.gets.filter((x) => x.procedure === 'getKb').length).toBe(1);
  await expect.poll(() => s.sequence).toBe(2);
  await expect(ready(page)).toContainText(body);
  gate.release();
  await expect(page.getByRole('heading', { name: 'Order status', exact: true })).toHaveCount(0);
  expect(s.gets.filter((x) => x.procedure === 'getKb').every((x) => x.input.id === 'kb-account-access' && x.input.version === 1)).toBe(
    true,
  );
  expect(s.posts).toEqual([]);
});
test('native refresh changes owner discards held old public context and clears private local search', async ({ context, page }) => {
  const gate = held();
  const s = await network(context, {
    refreshAfterMs: 2000,
    getKb: async (route, input) => {
      const originalOwner = s.owner;
      if (originalOwner === owner) {
        await gate.promise;
        return departedReply(route, row(input.id, input.version, { titleKey: 'support.kb.orders_status.title' }));
      }
      return reply(route, row(input.id, input.version));
    },
  });
  await login(page);
  await expect(page.getByTestId('help__row')).toHaveCount(1);
  await page.getByLabel('Search loaded answers', { exact: true }).fill('isolated-help-private-owner-search');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('help__empty')).toBeVisible();
  await changeURL(page, address('kb-account-access', 1));
  await expect.poll(() => s.gets.filter((x) => x.procedure === 'getKb').length).toBe(1);
  s.owner = other;
  await expect.poll(() => s.sequence).toBe(2);
  await expect(ready(page)).toContainText(body);
  gate.release();
  await expect(page.getByRole('heading', { name: 'Order status', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '← Published answers', exact: true }).click();
  await expect(page.getByLabel('Search loaded answers', { exact: true })).toHaveValue('');
  await expect(page.getByTestId('help__row')).toHaveCount(1);
  expect(s.posts).toEqual([]);
});
test('held read from a closed native tab cannot contaminate a fresh tab or create durable private state', async ({ context, page }) => {
  const gate = held();
  const s = await network(context, {
    getKb: async (route, input) => {
      if (input.id === 'isolated-help-private-closed') {
        await gate.promise;
        return departedReply(route, row(input.id, 1, { titleKey: 'support.kb.orders_status.title' }));
      }
      return reply(route, row(input.id, input.version));
    },
  });
  await page.goto(address('isolated-help-private-closed', 1));
  await expect.poll(() => s.gets.length).toBe(1);
  await page.close();
  const fresh = await context.newPage();
  await fresh.goto(address('kb-account-access', 2));
  await expect(ready(fresh)).toContainText(body);
  gate.release();
  await expect(fresh.getByRole('heading', { name: 'Order status', exact: true })).toHaveCount(0);
  expect(await fresh.evaluate(() => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes('isolated-help-private-closed'))).toBe(
    true,
  );
  expect(s.posts).toEqual([]);
});
test('public support and recovery links reach actual auth return without any Help mutation', async ({ context, page }) => {
  const s = await network(context);
  await page.goto(address('kb-account-access', 1));
  await expect(ready(page)).toBeVisible();
  await page.getByRole('link', { name: 'Account recovery →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Get back into your account', exact: true })).toBeVisible();
  await page.goBack();
  await page.getByRole('link', { name: 'View your support tickets →', exact: true }).click();
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your account', exact: true })).toBeVisible();
  expect(await page.evaluate(() => new URL(location.href).searchParams.get('redirect') === '/support')).toBe(true);
  expect(s.posts).toEqual([]);
  expect(s.allPosts).toEqual([]);
});
test('native support sign-in preserves its complete safe return URL and actually reaches owned support', async ({ context, page }) => {
  const s = await network(context);
  await page.goto(address('kb-account-access', 1));
  await expect(ready(page)).toBeVisible();
  await page.getByRole('link', { name: 'View your support tickets →', exact: true }).click();
  const destination = '/support?ticket=isolated-help-private-support-return&view=open';
  await changeURL(page, destination);
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  expect(await page.evaluate((destination) => new URL(location.href).searchParams.get('redirect') === destination, destination)).toBe(true);
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect.poll(() => page.evaluate((destination) => location.pathname + location.search === destination, destination)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Support', exact: true })).toBeVisible();
  expect(s.posts).toEqual([]);
  expect(s.allPosts).toEqual(['auth.login']);
});
for (const [language, headingText, retryText] of [
  ['en', 'Answer unavailable', 'Try again'],
  ['es', 'Respuesta no disponible', 'Intentar de nuevo'],
  ['fr', 'Réponse indisponible', 'Réessayer'],
])
  for (const room of ['article', 'catalogue'])
    test(
      'raw English failure stays undetermined while authored recovery keeps its actual locale: ' + language + ' ' + room,
      async ({ context, page }) => {
        const s = await network(context, { getKb: (route) => refusal(route), searchKb: (route) => refusal(route) });
        const view = await locale(context, language);
        await page.goto(room === 'article' ? address('kb-account-access', 1) : '/help');
        const raw = page.locator('[data-testid="help"] [data-testid="failure"] p').filter({ hasText: 'Isolated public read unavailable' });
        await expect(raw).toBeVisible();
        expect(await raw.evaluate((element) => element.closest('[lang]').getAttribute('lang'))).toBe('und');
        const retryButton = page.getByRole('button', { name: retryText, exact: true });
        await expect(retryButton).toBeVisible();
        expect(await retryButton.evaluate((element) => element.closest('[lang]').getAttribute('lang'))).toBe(language);
        if (room === 'article') await expect(page.getByRole('heading', { name: headingText, exact: true })).toBeFocused();
        expect(s.posts).toEqual([]);
        await view.close();
      },
    );
for (const [language, headingText, label] of [
  ['en', 'How can we help?', 'Search loaded answers'],
  ['es', '¿Cómo podemos ayudarte?', 'Buscar en las respuestas cargadas'],
  ['fr', 'Comment pouvons-nous vous aider ?', 'Rechercher dans les réponses chargées'],
])
  for (const width of [320, 390, 768, 1440])
    test('actual Help browse article keyboard and published language fallback fit ' + language + ' ' + width, async ({ context, page }) => {
      const s = await network(context);
      const view = await locale(context, language);
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/help');
      await expect(page.getByRole('heading', { name: headingText, exact: true })).toBeVisible();
      await shot(page, 'browse-' + language + '-' + width);
      await page.getByLabel(label, { exact: true }).fill('password');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('help__row')).toHaveCount(1);
      const answer = page.locator('[data-testid="help__row-heading"] a');
      await answer.focus();
      await page.keyboard.press('Enter');
      await expect(ready(page)).toContainText(body);
      await expect(page.locator('[data-testid="help"] h1')).toBeFocused();
      await expect(page.locator('[data-testid="help"] h1')).toHaveAttribute('lang', 'en');
      await expect(ready(page)).toHaveAttribute('lang', 'en');
      if (language !== 'en')
        await expect(page.getByTestId('help__heading')).toContainText(language === 'es' ? 'se muestra en inglés' : 'affichée en anglais');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(
        await page.getByTestId('help__link').evaluateAll((links) => links.every((link) => link.getBoundingClientRect().height >= 44)),
      ).toBe(true);
      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations.filter((x) => ['critical', 'serious'].includes(x.impact)).map((x) => x.id)).toEqual([]);
      await shot(page, 'article-' + language + '-' + width);
      expect(s.posts).toEqual([]);
      await view.close();
    });
