import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const evidence = process.env.ROOM_RETURN_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111',
  subject = '22222222-2222-4222-8222-222222222222';
const destination = `/blueprint?subject=${subject}&size=landscape#shared-details`;
const samples = Object.fromEntries(
  ['portrait', 'landscape'].map((size) => [size, readFileSync(process.env.ROOM_RETURN_SAMPLE_DIR + '/sample-' + size + '.svg', 'utf8')]),
);
const card = (size) => ({
  size,
  width: size === 'portrait' ? 1080 : 1200,
  height: size === 'portrait' ? 1350 : 630,
  svg: samples[size],
  shareMode: 'svg',
  raster: { status: 'unavailable', code: 'blueprint.card_renderer_unconfigured', reason: 'Qualified isolated renderer unavailable' },
});
const reply = (route, data) => route.fulfill({ status: 200, json: { result: { data } } });
const fail = (route, status, code) =>
  route.fulfill({ status, json: { error: { message: 'Qualified isolated refusal', data: { cause: { code } } } } });
const errors = new WeakMap();
test.beforeEach(async ({ context }) => {
  const list = [];
  errors.set(context, list);
  const watch = (page) => page.on('pageerror', (error) => list.push(error.message));
  context.pages().forEach(watch);
  context.on('page', watch);
  await context.addInitScript(() => {
    window.__hashChanges = 0;
    addEventListener('hashchange', () => window.__hashChanges++);
  });
});
test.afterEach(async ({ context }, info) => {
  writeFileSync(
    evidence + '/case-' + info.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json',
    JSON.stringify({ name: info.title, status: info.status, pageErrors: errors.get(context) }, null, 2),
  );
  expect(errors.get(context)).toEqual([]);
});
async function network(context) {
  const state = { expired: null, reads: [], auth: [], writes: [], external: [] };
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== new URL(process.env.ROOM_RETURN_BASE_URL).origin) {
      state.external.push(new URL(route.request().url()).origin);
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  });
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      service = url.pathname.split('/')[2],
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    if (service === 'identity' && ['auth.login', 'auth.register'].includes(procedure)) {
      state.auth.push(procedure);
      return reply(route, {
        userId: owner,
        accessToken: 'qualified-room-token',
        refreshToken: 'qualified-room-refresh',
        expiresAt: '2027-10-10T12:00:00Z',
      });
    }
    if (request.method() !== 'GET') {
      state.writes.push(procedure);
      return fail(route, 503, 'QUALIFIED_UNCONNECTED_WRITE');
    }
    const input = JSON.parse(url.searchParams.get('input') || 'null');
    state.reads.push({ service, procedure, input, unauthorized: service === 'blueprint' && state.expired === procedure });
    if (service === 'blueprint' && state.expired === procedure) return fail(route, 401, 'UNAUTHORIZED');
    if (service === 'blueprint' && procedure === 'me') return reply(route, null);
    if (service === 'blueprint' && procedure === 'mentors') return reply(route, []);
    if (service === 'blueprint' && ['card', 'cardOf'].includes(procedure)) return reply(route, card(input.size));
    return fail(route, 503, 'QUALIFIED_UNCONNECTED_READ');
  });
  return state;
}
const gate = (page) => page.getByRole('link', { name: 'Sign in', exact: true });
const formAlternate = (page) => page.locator('[data-testid="public-auth-form-links"] a');
async function returnContext(page, original) {
  expect(new URL(page.url()).searchParams.get('redirect')).toBe(original);
  expect(new URL(await formAlternate(page).getAttribute('href'), page.url()).searchParams.get('redirect')).toBe(original);
}
async function authenticate(page, target, original) {
  await returnContext(page, original);
  await formAlternate(page).click();
  await returnContext(page, original);
  await formAlternate(page).click();
  await returnContext(page, original);
  if (target === 'register' && new URL(page.url()).pathname !== '/register') {
    await formAlternate(page).click();
    await returnContext(page, original);
  }
  if (target === 'login' && new URL(page.url()).pathname !== '/login') {
    await formAlternate(page).click();
    await returnContext(page, original);
  }
  if (target === 'register') {
    await page.locator('input[name="identifier"]').fill('qualified_owner');
    await page.locator('input[autocomplete="email"]').fill('qualified-owner@example.invalid');
    await page.locator('input[autocomplete="new-password"]').fill('qualified-password');
  } else {
    await page.locator('input[name="identifier"]').fill('qualified-owner');
    await page.locator('input[autocomplete="current-password"]').fill('qualified-password');
  }
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new URL(original, page.url()).href);
  await expect(page.getByTestId('blueprint-shared')).toBeVisible();
}
async function firstLogin(page) {
  await page.goto('/login?redirect=%2Fblueprint');
  await page.locator('input[name="identifier"]').fill('qualified-owner');
  await page.locator('input[autocomplete="current-password"]').fill('qualified-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page.getByTestId('blueprint-shared')).toBeVisible();
}
async function navigateRoom(page, href) {
  await page.evaluate((href) => {
    history.pushState(null, '', href);
    dispatchEvent(new PopStateEvent('popstate'));
  }, href);
}
for (const target of ['login', 'register']) {
  test(`actual generic gate query and fragment survive form links and ${target} completion`, async ({ page, context }) => {
    const state = await network(context);
    await page.goto(destination);
    await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
    await expect(gate(page)).toHaveAttribute('href', '/login?redirect=' + encodeURIComponent(destination));
    await gate(page).click();
    await authenticate(page, target, destination);
    await expect(page.getByTestId('blueprint-shared-image')).toHaveAttribute('width', '1200');
    expect(state.auth).toEqual(['auth.' + target]);
    expect(state.reads.filter((read) => read.procedure === 'cardOf').map((read) => read.input)).toEqual([
      { userId: subject, size: 'landscape' },
    ]);
    expect(state.writes).toEqual([]);
    expect(state.external).toEqual([]);
  });
  test(`existing validated auth context retains direct query and fragment through ${target} form links and completion`, async ({
    page,
    context,
  }) => {
    const state = await network(context);
    await page.goto('/login?redirect=' + encodeURIComponent(destination));
    await authenticate(page, target, destination);
    expect(state.auth).toEqual(['auth.' + target]);
    expect(state.writes).toEqual([]);
  });
  for (const procedure of ['cardOf', 'me'])
    test(`consequential ${procedure} 401 uses real generic gate and complete ${target} return`, async ({ page, context }) => {
      const state = await network(context);
      await firstLogin(page);
      await navigateRoom(page, '/view');
      await expect(page.getByTestId('blueprint-shared')).toHaveCount(0);
      state.expired = procedure;
      const original = procedure === 'cardOf' ? destination : '/blueprint?section=owner#identity-profile';
      await navigateRoom(page, original);
      await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
      expect(state.reads.filter((read) => read.unauthorized).map((read) => read.procedure)).toEqual([procedure]);
      await expect(page.getByTestId('blueprint-shared')).toHaveCount(0);
      await expect(gate(page)).toHaveAttribute('href', '/login?redirect=' + encodeURIComponent(original));
      state.expired = null;
      await gate(page).click();
      await authenticate(page, target, original);
      expect(state.auth).toEqual(['auth.login', 'auth.' + target]);
      expect(state.writes).toEqual([]);
    });
}
test('native fragment change updates the open generic gate return link', async ({ page, context }) => {
  await network(context);
  await page.goto('/blueprint?section=current#original');
  await expect(gate(page)).toBeVisible();
  await page.evaluate(() => (location.hash = 'latest'));
  const current = '/blueprint?section=current#latest';
  await expect(gate(page)).toHaveAttribute('href', '/login?redirect=' + encodeURIComponent(current));
  await gate(page).click();
  await authenticate(page, 'login', current);
});
test('same-turn native fragment change and actual Sign in click capture the current destination before hashchange renders', async ({
  page,
  context,
}) => {
  await network(context);
  await page.goto('/blueprint?section=current#original');
  await expect(gate(page)).toBeVisible();
  const activation = await page.evaluate(() => {
    const anchor = [...document.querySelectorAll('a')].find((node) => node.textContent.trim() === 'Sign in');
    const renderedHref = anchor.getAttribute('href');
    location.hash = 'latest';
    const current = location.pathname + location.search + location.hash,
      hashChangesBeforeActivation = window.__hashChanges;
    anchor.click();
    return { renderedHref, current, hashChangesBeforeActivation };
  });
  expect(activation.hashChangesBeforeActivation).toBe(0);
  expect(activation.current).toBe('/blueprint?section=current#latest');
  await authenticate(page, 'login', activation.current);
});
test('fragment-only supported destination keeps its room label and exact authentication return', async ({ page, context }) => {
  await network(context);
  const original = '/blueprint#identity-profile';
  await page.goto('/login?redirect=' + encodeURIComponent(original));
  await expect(page.getByTestId('public-auth-context')).toContainText('Identity Blueprint');
  await authenticate(page, 'register', original);
});
