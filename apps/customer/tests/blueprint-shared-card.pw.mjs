import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const evidence = process.env.BLUEPRINT_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111',
  first = '22222222-2222-4222-8222-222222222222',
  second = '33333333-3333-4333-8333-333333333333';
const samples = Object.fromEntries(
  ['portrait', 'landscape'].map((size) => [size, readFileSync(process.env.BLUEPRINT_SAMPLE_DIR + '/sample-' + size + '.svg', 'utf8')]),
);
const card = (size = 'portrait', extra = {}) => ({
  size,
  width: size === 'portrait' ? 1080 : 1200,
  height: size === 'portrait' ? 1350 : 630,
  svg: samples[size],
  shareMode: 'svg',
  raster: { status: 'unavailable', code: 'blueprint.card_renderer_unconfigured', reason: 'Qualified isolated renderer unavailable' },
  ...extra,
});
const reply = (route, data) => route.fulfill({ status: 200, json: { result: { data } } });
const fail = (route, status, code) =>
  route.fulfill({ status, json: { error: { message: 'Qualified isolated refusal', data: { cause: { code } } } } });
const errors = new WeakMap(),
  summary = [];
test.beforeEach(async ({ context }) => {
  const list = [];
  errors.set(context, list);
  const watch = (page) => page.on('pageerror', (e) => list.push(e.message));
  context.pages().forEach(watch);
  context.on('page', watch);
  await context.addInitScript(() => {
    window.__artifactUrls = { made: [], revoked: [] };
    window.__sharedDispatches = [];
    const originalFetch = window.fetch;
    window.fetch = function (input, ...options) {
      const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : input.href, location.href);
      if (url.pathname.endsWith('/cardOf'))
        window.__sharedDispatches.push({
          href: location.pathname + location.search + location.hash,
          input: JSON.parse(url.searchParams.get('input')),
        });
      return originalFetch.call(this, input, ...options);
    };
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      window.__artifactUrls.made.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.__artifactUrls.revoked.push(url);
      revoke(url);
    };
  });
});
test.afterEach(async ({ context }, info) => {
  expect(errors.get(context)).toEqual([]);
  summary.push({ name: info.title, status: info.status, pageErrors: errors.get(context) });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summary, null, 2)));
async function network(context, options = {}) {
  const state = { owner, reads: [], writes: [], external: [], ...options };
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      proc = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : request.postDataJSON();
    if (proc === 'auth.login' || proc === 'auth.register')
      return reply(route, {
        userId: state.owner,
        accessToken: 'blueprint-token-' + state.owner,
        refreshToken: 'blueprint-refresh-' + state.owner,
        expiresAt: '2027-10-10T12:00:00Z',
      });
    if (proc === 'auth.logout') return reply(route, { ok: true });
    (request.method() === 'GET' ? state.reads : state.writes).push({ proc, input });
    if (state[proc]) return state[proc](route, input);
    if (proc === 'me') return reply(route, null);
    if (proc === 'mentors') return reply(route, [{ studentId: state.owner, mentorId: first, fitScore: 9500, status: 'shortlisted' }]);
    if (proc === 'card') return reply(route, card(input.size));
    if (proc === 'cardOf') return reply(route, card(input.size));
    return fail(route, 503, 'QUALIFIED_UNCONNECTED_ROUTE');
  });
  context.on('request', (request) => {
    if (new URL(request.url()).hostname === 'external-fixture.invalid') state.external.push(request.url());
  });
  return state;
}
async function login(page, path = '/blueprint', signed = true) {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('qualified-blueprint-owner');
  await page.locator('input[autocomplete="current-password"]').fill('qualified-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp('/blueprint'));
  if (signed) await expect(page.locator('.blueprint-shared')).toBeVisible();
  else await expect(page.getByText('Sign in to continue', { exact: true })).toBeVisible();
}
const viewer = (page) => page.locator('.blueprint-shared');
async function open(page, subject = first, size = 'portrait') {
  await viewer(page).getByRole('textbox').fill(subject);
  await viewer(page).locator('select').selectOption(size);
  await viewer(page).locator('form button[type="submit"]').click();
}
const image = (page) => viewer(page).locator('.blueprint-shared-image');
const reads = (state) => state.reads.filter((read) => read.proc === 'cardOf');
async function urls(page) {
  return page.evaluate(() => window.__artifactUrls);
}
async function retain(page, selector, prop = 'onClick', key = 'old') {
  await page.evaluate(
    ({ selector, prop, key }) => {
      const node = document.querySelector(selector);
      window[key] = node?.[Object.keys(node).find((key) => key.startsWith('__reactProps$'))]?.[prop];
    },
    { selector, prop, key },
  );
}
async function invoke(page, key = 'old', value) {
  await page.evaluate(({ key, value }) => window[key]?.({ preventDefault() {}, target: { value } }), { key, value });
}
async function heldRead(context) {
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve)),
    dispatched = new Promise((resolve) => (entered = resolve));
  let used = false;
  const state = await network(context, {
    cardOf: async (route, input) => {
      if (!used) {
        used = true;
        entered();
        await gate;
      }
      try {
        await reply(route, card(input.size));
      } catch {}
    },
  });
  return { state, release, dispatched };
}
for (const [locale, width] of [
  ['en', 1440],
  ['es', 390],
  ['fr', 320],
])
  test(`actual compiled App/Login shared SVG keyboard and layout ${locale} ${width}`, async ({ page, context }) => {
    await context.addInitScript((language) => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language })), locale);
    const state = await network(context);
    await page.setViewportSize({ width, height: 1100 });
    await login(page);
    await viewer(page).getByRole('textbox').focus();
    await page.keyboard.type(first);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(image(page)).toBeVisible();
    await expect(viewer(page).locator('.blueprint-shared-context')).toContainText(first);
    expect(reads(state).at(-1).input).toEqual({ userId: first, size: 'portrait' });
    expect(
      await image(page).evaluate((el) => Math.abs(el.getBoundingClientRect().width / el.getBoundingClientRect().height - 0.8) < 0.01),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const src = await image(page).getAttribute('src');
    expect(await page.evaluate((src) => fetch(src).then((r) => r.text()), src)).toBe(samples.portrait);
    await viewer(page).locator('.blueprint-shared-actions button').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const downloadEvent = page.waitForEvent('download');
    await viewer(page).locator('.blueprint-shared-actions button').nth(1).click();
    const download = await downloadEvent;
    const path = await download.path();
    expect(readFileSync(path, 'utf8')).toBe(samples.portrait);
    await open(page, second, 'landscape');
    await expect(image(page)).toHaveAttribute('width', '1200');
    expect(
      await image(page).evaluate(
        (el) => Math.abs(el.getBoundingClientRect().width / el.getBoundingClientRect().height - 1200 / 630) < 0.01,
      ),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: evidence + `/native-${locale}-${width}.png`, fullPage: true });
    expect(state.writes).toEqual([]);
  });
test('signed room return preserves deliberate UUID/size and mentor action uses only returned shortlist', async ({ page, context }) => {
  const state = await network(context);
  const path = `/blueprint?subject=${second}&size=landscape`;
  await page.goto(path);
  await expect(page.getByText('Sign in to continue', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.locator('input[name="identifier"]').fill('qualified-owner');
  await page.locator('input[autocomplete="current-password"]').fill('qualified-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`subject=${second}&size=landscape`));
  await expect(image(page)).toBeVisible();
  expect(reads(state)[0].input).toEqual({ userId: second, size: 'landscape' });
  await page.getByRole('button', { name: 'View card', exact: true }).click();
  await expect(image(page)).toHaveAttribute('width', '1080');
  expect(reads(state).at(-1).input).toEqual({ userId: first, size: 'portrait' });
  expect(state.writes).toEqual([]);
});
for (const [status, code, title] of [
  [404, 'blueprint.not_found', 'Card unavailable'],
  [404, 'ROUTE_ABSENT', 'The card service is unavailable'],
  [403, 'denied.region_unknown', 'This card request is not allowed'],
  [500, 'DEPENDENCY_FAILED', 'The card could not be loaded'],
])
  test(`refusal ${status} ${code} hides old SVG and retries frozen selection`, async ({ page, context }) => {
    let failure = false;
    const state = await network(context, {
      cardOf: (route, input) => (failure ? fail(route, status, code) : reply(route, card(input.size))),
    });
    await login(page);
    await open(page);
    await expect(image(page)).toBeVisible();
    failure = true;
    await open(page, second, 'landscape');
    await expect(viewer(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(image(page)).toHaveCount(0);
    await expect(viewer(page).locator('.blueprint-shared-context')).toContainText(second);
    failure = false;
    await viewer(page).getByRole('button', { name: 'Retry this card', exact: true }).click();
    await expect(image(page)).toBeVisible();
    expect(reads(state).at(-1).input).toEqual({ userId: second, size: 'landscape' });
  });
for (const [name, extra] of [
  ['wrong size', { size: 'landscape' }],
  ['wrong geometry', { height: 630 }],
  ['unsafe SVG', { svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }],
  ['external SVG', { svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://external-fixture.invalid/a)"/></svg>' }],
  ['unknown raster', { raster: { status: 'unavailable', code: 'invented', reason: 'x' } }],
])
  test(`${name} refuses artifact and remains a failed read`, async ({ page, context }) => {
    const state = await network(context, { cardOf: (route, input) => reply(route, card(input.size, extra)) });
    await login(page);
    await open(page);
    await expect(viewer(page).getByRole('heading', { name: 'The service returned an unusable card', exact: true })).toBeVisible();
    await expect(image(page)).toHaveCount(0);
    expect((await urls(page)).made).toHaveLength(0);
    expect(state.external).toEqual([]);
  });
test('malformed successful envelope and timeout preserve legitimate retry and original selection', async ({ page, context }) => {
  let mode = 'malformed';
  const state = await network(context, {
    cardOf: (route, input) =>
      mode === 'malformed'
        ? route.fulfill({ status: 200, body: '<html>upstream</html>', contentType: 'text/html' })
        : mode === 'timeout'
          ? route.abort('timedout')
          : reply(route, card(input.size)),
  });
  await login(page);
  await open(page, second, 'landscape');
  await expect(viewer(page).getByRole('heading', { name: 'The service returned an unusable card', exact: true })).toBeVisible();
  mode = 'timeout';
  await viewer(page).getByRole('button', { name: 'Retry this card', exact: true }).click();
  await expect(viewer(page).getByRole('heading', { name: 'The card could not be loaded', exact: true })).toBeVisible();
  mode = 'success';
  await viewer(page).getByRole('button', { name: 'Retry this card', exact: true }).click();
  await expect(image(page)).toBeVisible();
  expect(reads(state).every((read) => read.input.userId === second && read.input.size === 'landscape')).toBe(true);
});
test('401 clears actual session and re-login returns to intentional shared reference', async ({ page, context }) => {
  let expired = true;
  const state = await network(context, {
    cardOf: (route, input) => (expired ? fail(route, 401, 'UNAUTHORIZED') : reply(route, card(input.size))),
  });
  await login(page, `/blueprint?subject=${first}&size=portrait`, false);
  await expect(page.getByText('Sign in to continue', { exact: true })).toBeVisible();
  await expect(image(page)).toHaveCount(0);
  expired = false;
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.locator('input[name="identifier"]').fill('qualified-owner');
  await page.locator('input[autocomplete="current-password"]').fill('qualified-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(image(page)).toBeVisible();
  expect(reads(state).at(-1).input).toEqual({ userId: first, size: 'portrait' });
});
for (const [entry, destination] of [
  ['manual', 'login'],
  ['manual', 'register'],
  ['deep', 'login'],
])
  test(`${entry} landscape 401 preserves validated original request through actual ${destination}`, async ({ page, context }) => {
    let expired = true;
    const state = await network(context, {
      cardOf: (route, input) => (expired ? fail(route, 401, 'UNAUTHORIZED') : reply(route, card(input.size))),
    });
    const path = `/blueprint?subject=${second}&size=landscape`;
    await login(page, entry === 'deep' ? path : '/blueprint', entry !== 'deep');
    if (entry === 'manual') await open(page, second, 'landscape');
    await expect(page.getByText('Sign in to continue', { exact: true })).toBeVisible();
    expect(reads(state).map((read) => read.input)).toEqual([{ userId: second, size: 'landscape' }]);
    expect(await page.evaluate(() => window.__sharedDispatches)).toEqual([{ href: path, input: { userId: second, size: 'landscape' } }]);
    const signIn = page.getByRole('link', { name: 'Sign in', exact: true });
    await expect(signIn).toHaveAttribute('href', '/login?redirect=' + encodeURIComponent(path));
    expired = false;
    await signIn.click();
    if (destination === 'register') {
      await page.getByRole('link', { name: 'Create account', exact: true }).first().click();
      await expect(page).toHaveURL(new RegExp('/register\\?redirect='));
      expect(new URL(page.url()).searchParams.get('redirect')).toBe(path);
      await page.locator('input[name="identifier"]').fill('qualified_owner');
      await page.locator('input[autocomplete="email"]').fill('qualified-owner@example.invalid');
      await page.locator('input[autocomplete="new-password"]').fill('qualified-password');
    } else {
      await page.locator('input[name="identifier"]').fill('qualified-owner');
      await page.locator('input[autocomplete="current-password"]').fill('qualified-password');
    }
    await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
    await expect(page).toHaveURL(new URL(path, page.url()).href);
    await expect(viewer(page).getByRole('textbox')).toHaveValue(second);
    await expect(viewer(page).locator('select')).toHaveValue('landscape');
    await expect(image(page)).toHaveAttribute('width', '1200');
    expect(reads(state).map((read) => read.input)).toEqual([
      { userId: second, size: 'landscape' },
      { userId: second, size: 'landscape' },
    ]);
    expect(state.writes).toEqual([]);
  });
test('canonical manual departure dispatches once, refuses retained handlers and keeps current draft and reload usable', async ({
  page,
  context,
}) => {
  const held = await heldRead(context);
  await login(page, '/blueprint?discard=unused#discard');
  await viewer(page).getByRole('textbox').fill(first);
  await viewer(page).locator('select').selectOption('landscape');
  await retain(page, '.blueprint-shared input', 'onChange', 'preDepartureEdit');
  await retain(page, '.blueprint-shared form', 'onSubmit', 'preDepartureSubmit');
  await page.evaluate(() => {
    window.preDepartureSubmit?.({ preventDefault() {} });
    window.preDepartureSubmit?.({ preventDefault() {} });
    window.preDepartureEdit?.({ target: { value: '33333333-3333-4333-8333-333333333333' } });
  });
  await held.dispatched;
  const firstPath = `/blueprint?subject=${first}&size=landscape`;
  await expect(page).toHaveURL(new URL(firstPath, page.url()).href);
  expect(reads(held.state).map((read) => read.input)).toEqual([{ userId: first, size: 'landscape' }]);
  expect(await page.evaluate(() => window.__sharedDispatches)).toEqual([{ href: firstPath, input: { userId: first, size: 'landscape' } }]);
  await viewer(page).getByRole('textbox').fill(second);
  await viewer(page).locator('select').selectOption('portrait');
  await invoke(page, 'preDepartureEdit', first);
  await invoke(page, 'preDepartureSubmit');
  await expect(viewer(page).getByRole('textbox')).toHaveValue(second);
  await expect(viewer(page).locator('select')).toHaveValue('portrait');
  expect(reads(held.state)).toHaveLength(1);
  await viewer(page).locator('form button[type="submit"]').click();
  await expect(image(page)).toHaveAttribute('width', '1080');
  held.release();
  await expect(viewer(page).locator('.blueprint-shared-context')).toContainText(second);
  await expect(viewer(page).getByRole('textbox')).toHaveValue(second);
  await expect(viewer(page).locator('select')).toHaveValue('portrait');
  expect(reads(held.state).map((read) => read.input)).toEqual([
    { userId: first, size: 'landscape' },
    { userId: second, size: 'portrait' },
  ]);
  await viewer(page).locator('form button[type="submit"]').click();
  await expect(image(page)).toBeVisible();
  expect(reads(held.state)).toHaveLength(3);
  expect(reads(held.state).at(-1).input).toEqual({ userId: second, size: 'portrait' });
  expect(held.state.writes).toEqual([]);
});
test('held late read cannot publish over opposing current subject and size', async ({ page, context }) => {
  const held = await heldRead(context);
  await login(page);
  await open(page);
  await held.dispatched;
  await open(page, second, 'landscape');
  await expect(image(page)).toHaveAttribute('width', '1200');
  held.release();
  await expect(viewer(page).locator('.blueprint-shared-context')).toContainText(second);
  await expect(image(page)).toHaveAttribute('width', '1200');
});
for (const kind of ['query', 'hash', 'subject', 'size'])
  test(`same-turn URL ${kind} ABA refuses retained submit/download and revokes SVG`, async ({ page, context }) => {
    const state = await network(context);
    await login(page);
    await open(page);
    await expect(image(page)).toBeVisible();
    await retain(page, '.blueprint-shared form', 'onSubmit', 'submitOld');
    await retain(page, '.blueprint-shared-actions button:nth-child(2)', 'onClick', 'downloadOld');
    const before = reads(state).length;
    await page.evaluate((kind) => {
      const original = location.href,
        next = new URL(original);
      if (kind === 'hash') next.hash = 'departure';
      else
        next.searchParams.set(
          kind,
          kind === 'subject' ? '33333333-3333-4333-8333-333333333333' : kind === 'size' ? 'landscape' : 'changed',
        );
      history.replaceState(null, '', next.href);
      history.replaceState(null, '', original);
      window.submitOld?.({ preventDefault() {} });
      window.downloadOld?.();
    }, kind);
    await expect(image(page)).toHaveCount(0);
    expect(reads(state)).toHaveLength(before);
    const u = await urls(page);
    expect(u.revoked).toContain(u.made[0]);
  });
test('same-turn draft subject and size ABA refuses retained edits, submit and artifact callbacks', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await open(page);
  await expect(image(page)).toBeVisible();
  await retain(page, '.blueprint-shared input', 'onChange', 'editOld');
  await retain(page, '.blueprint-shared form', 'onSubmit', 'submitOld');
  await retain(page, '.blueprint-shared-actions button:first-child', 'onClick', 'fullOld');
  await invoke(page, 'editOld', second);
  await viewer(page).getByRole('textbox').fill(first);
  await viewer(page).locator('select').selectOption('landscape');
  await viewer(page).locator('select').selectOption('portrait');
  const before = reads(state).length;
  await invoke(page, 'editOld', second);
  await invoke(page, 'submitOld');
  await invoke(page, 'fullOld');
  await expect(viewer(page).getByRole('textbox')).toHaveValue(first);
  await expect(image(page)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(reads(state)).toHaveLength(before);
  await viewer(page).locator('form button[type="submit"]').click();
  await expect(image(page)).toBeVisible();
});
test('captured retry and image failure cannot clobber a fresh same-context intent', async ({ page, context }) => {
  let broken = true;
  const state = await network(context, {
    cardOf: (route, input) => (broken ? fail(route, 500, 'FAILED') : reply(route, card(input.size))),
  });
  await login(page);
  await open(page);
  await expect(viewer(page).getByRole('button', { name: 'Retry this card', exact: true })).toBeVisible();
  await retain(page, '.blueprint-shared-failure button', 'onClick', 'retryOld');
  broken = false;
  await viewer(page).getByRole('button', { name: 'Retry this card', exact: true }).click();
  await expect(image(page)).toBeVisible();
  await retain(page, '.blueprint-shared-image', 'onError', 'errorOld');
  await open(page, second, 'landscape');
  await expect(image(page)).toHaveAttribute('width', '1200');
  const before = reads(state).length;
  await invoke(page, 'retryOld');
  await invoke(page, 'errorOld');
  await expect(image(page)).toHaveAttribute('width', '1200');
  expect(reads(state)).toHaveLength(before);
});
test('captured Close cannot close a freshly opened full-size artifact', async ({ page, context }) => {
  await network(context);
  await login(page);
  await open(page);
  await expect(image(page)).toBeVisible();
  await viewer(page).getByRole('button', { name: 'Open full size', exact: true }).click();
  await retain(page, 'dialog header button', 'onClick', 'closeOld');
  await page.keyboard.press('Escape');
  await viewer(page).getByRole('button', { name: 'Open full size', exact: true }).click();
  await invoke(page, 'closeOld');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
});
test('actual same-turn Sign out refuses retained lookup before React finishes session cleanup', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await open(page);
  await expect(image(page)).toBeVisible();
  await retain(page, '.blueprint-shared form', 'onSubmit', 'submitOld');
  const before = reads(state).length;
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Sign out');
    const props = button?.[Object.keys(button).find((key) => key.startsWith('__reactProps$'))];
    props?.onClick?.();
    window.submitOld?.({ preventDefault() {} });
  });
  await expect(page.getByText('Sign in to continue', { exact: true })).toBeVisible();
  expect(reads(state)).toHaveLength(before);
  await expect(image(page)).toHaveCount(0);
  const u = await urls(page);
  expect(u.made.every((url) => u.revoked.includes(url))).toBe(true);
});
test('renderer codes remain data; no external raster autoload or private durable artifact', async ({ page, context }) => {
  let code = 'blueprint.card_renderer_unreachable';
  const state = await network(context, {
    cardOf: (route, input) =>
      reply(
        route,
        card(input.size, {
          raster:
            code === 'rendered'
              ? { status: 'rendered', url: 'https://external-fixture.invalid/card.png', contentType: 'image/png', bytes: 10 }
              : { status: 'unavailable', code, reason: 'Original opaque provider reason' },
        }),
      ),
  });
  await login(page);
  await open(page);
  await expect(image(page)).toBeVisible();
  await expect(viewer(page)).toContainText('The PNG renderer could not be reached.');
  code = 'blueprint.card_renderer_protocol';
  await open(page);
  await expect(viewer(page)).toContainText('The PNG renderer returned an unusable result.');
  code = 'rendered';
  await open(page);
  await expect(viewer(page)).toContainText('The service also returned a PNG.');
  expect(state.external).toEqual([]);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain('<svg');
  expect(storage).not.toContain('external-fixture');
  expect(storage).not.toContain('blob:');
});
test('existing unknown owner journal remains unchanged by shared card, export failure and a new login', async ({ page, context }) => {
  const key = `intafaced:more:pending:${owner}:blueprint`,
    original = JSON.stringify({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Original unresolved owner operation' });
  await context.addInitScript(({ key, original }) => localStorage.setItem(key, original), { key, original });
  await network(context);
  await login(page);
  await open(page);
  await expect(image(page)).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original);
  await page.getByRole('button', { name: 'Export Blueprint JSON', exact: true }).click();
  await expect(page.getByText('Qualified isolated refusal', { exact: true })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original);
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page);
  await open(page);
  await expect(image(page)).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original);
});

test('owner onboard still stages keyed answers, clears birth inputs and retains unknown independently of card reads', async ({
  page,
  context,
}) => {
  const state = await network(context, { onboard: (route) => route.abort('failed') });
  await login(page);
  await page.getByRole('textbox', { name: 'Answer key', exact: true }).fill('decision');
  await page.getByRole('textbox', { name: 'Your answer', exact: true }).fill('Qualified sampled response');
  await page.getByLabel('Birth date (optional)', { exact: true }).fill('2000-01-01');
  await page.getByRole('button', { name: 'Review Blueprint session', exact: true }).click();
  expect(state.writes).toHaveLength(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Run Blueprint session', exact: true }).click();
  await expect(page.getByLabel('Birth date (optional)', { exact: true })).toHaveValue('');
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toEqual({
    proc: 'onboard',
    input: {
      locale: 'en',
      responses: [{ key: 'decision', value: 'Qualified sampled response' }],
      visibility: 'private',
      mentorAvailable: false,
      birthData: { date: '2000-01-01' },
    },
  });
  const key = `intafaced:more:pending:${owner}:blueprint`;
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), key)).not.toBe(null);
  const original = await page.evaluate((key) => localStorage.getItem(key), key);
  expect(original).not.toContain('2000-01-01');
  expect(original).not.toContain('Qualified sampled response');
  await open(page);
  await expect(image(page)).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original);
  expect(state.writes).toHaveLength(1);
});
test('rendered actor/API/token changes reject an old retained viewer handler after login returns to the original actor', async ({
  page,
  context,
}) => {
  const state = await network(context);
  await login(page);
  await open(page);
  await expect(image(page)).toBeVisible();
  await retain(page, '.blueprint-shared form', 'onSubmit', 'originalActorSubmit');
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  state.owner = second;
  await login(page);
  await open(page, second);
  await expect(image(page)).toBeVisible();
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  state.owner = owner;
  await login(page);
  const before = reads(state).length;
  await invoke(page, 'originalActorSubmit');
  expect(reads(state)).toHaveLength(before);
  await open(page);
  await expect(image(page)).toBeVisible();
});

test('actual cross-tab language and theme preferences preserve opaque artifact, selected request and original bytes', async ({
  page,
  context,
}) => {
  const state = await network(context);
  await login(page);
  await open(page, first, 'landscape');
  await expect(image(page)).toBeVisible();
  const before = reads(state).length,
    source = await image(page).getAttribute('src');
  const sibling = await context.newPage();
  await sibling.goto('/');
  await sibling.evaluate(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language: 'es', theme: 'light' })));
  await expect(viewer(page).getByRole('heading', { name: 'Ver una tarjeta compartida', exact: true })).toBeVisible();
  await expect(image(page)).toHaveAttribute('src', source);
  expect(reads(state)).toHaveLength(before);
  await sibling.evaluate(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language: 'fr', theme: 'dark' })));
  await expect(viewer(page).getByRole('heading', { name: 'Voir une carte partagée', exact: true })).toBeVisible();
  await expect(image(page)).toHaveAttribute('src', source);
  expect(reads(state)).toHaveLength(before);
  expect(await page.evaluate((src) => fetch(src).then((r) => r.text()), source)).toBe(samples.landscape);
  await sibling.close();
});

test('coalesced native hash assignments reject the old lookup before queued hashchange events', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await open(page);
  await expect(image(page)).toBeVisible();
  await page.evaluate(() => history.replaceState(null, '', location.pathname + location.search + '#native-original'));
  await expect(image(page)).toBeVisible();
  await retain(page, '.blueprint-shared form', 'onSubmit', 'oldNativeHashSubmit');
  const before = reads(state).length;
  await page.evaluate(() => {
    const original = location.href;
    location.hash = 'native-departure';
    location.hash = 'native-original';
    if (location.href !== original) throw Error('Native ABA did not restore URL');
    window.oldNativeHashSubmit?.({ preventDefault() {} });
  });
  await expect(image(page)).toHaveCount(0);
  expect(reads(state)).toHaveLength(before);
  const u = await urls(page);
  expect(u.revoked).toContain(u.made[0]);
  await open(page);
  await expect(image(page)).toBeVisible();
});
