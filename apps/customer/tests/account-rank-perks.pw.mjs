import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const owner = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
const stamp = '2026-10-10T08:00:00.000Z',
  original = '/uc/account?read=rank#original';
const evidence = process.env.RANK_PERKS_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const summaries = [],
  errors = new WeakMap();
const rank = (userId = owner, extra = {}) => ({
  userId,
  rank: 2,
  xp: '2500',
  seasonXp: '400',
  nextRankAt: '1500',
  updatedAt: stamp,
  ...extra,
});
const perks = (extra = {}) => ({
  feeDiscountBps: 50,
  p2pLimitMultiplier: 1.5,
  copyFollowerCap: 10,
  lobbyHostRights: false,
  cardTier: 'none',
  otcAccess: false,
  launchpadTier: 0,
  ...extra,
});
const reply = (route, data) => route.fulfill({ status: 200, json: { result: { data } } });
const fail = (route, status = 503) => route.fulfill({ status, json: { error: { message: 'Isolated read unavailable' } } });
function held() {
  let release;
  return {
    promise: new Promise((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
test.beforeEach(async ({ context }) => {
  const list = [];
  errors.set(context, list);
  const watch = (page) => page.on('pageerror', (error) => list.push(error.message));
  context.pages().forEach(watch);
  context.on('page', watch);
});
test.afterEach(async ({ context }, info) => {
  expect(errors.get(context)).toEqual([]);
  summaries.push({ title: info.title, status: info.status, pageErrors: errors.get(context) });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summaries, null, 2)));
async function network(context, options = {}) {
  const state = { owner, reads: [], writes: [], sequence: 0, ...options },
    tokens = new Map();
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : request.postDataJSON();
    // Models the HttpOnly `ifc_rt` cookie: sign-in sets it, logout clears it, and a bare refresh without it is session_invalid.
    if (procedure === 'auth.refresh' && !state.cookie)
      return route.fulfill({
        status: 401,
        json: { error: { message: 'Session not found', data: { intafacedCode: 'auth.session_invalid' } } },
      });
    if (procedure === 'auth.login') state.cookie = true;
    if (procedure === 'auth.logout') state.cookie = false;
    if (procedure === 'auth.login' || procedure === 'auth.refresh') {
      const token = 'isolated-rank-session-' + ++state.sequence;
      tokens.set(token, state.owner);
      return reply(route, {
        userId: state.owner,
        accessToken: token,
        refreshToken: 'isolated-rank-refresh-' + state.sequence,
        expiresAt: procedure === 'auth.login' ? (state.expiresAt ?? '2027-10-10T08:00:00.000Z') : '2027-10-10T08:00:00.000Z',
      });
    }
    if (procedure === 'auth.logout') return reply(route, { ok: true });
    const token = request.headers().authorization?.replace('Bearer ', ''),
      actor = tokens.get(token);
    (request.method() === 'GET' ? state.reads : state.writes).push({ procedure, actor, token, input });
    if (state[procedure]) return state[procedure](route, actor, token, input);
    if (procedure === 'rank.get') return reply(route, rank(actor));
    if (procedure === 'rank.perks') return reply(route, perks());
    if (procedure === 'subAccounts.list') return reply(route, []);
    return fail(route);
  });
  return state;
}
async function login(page, path = original) {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new URL(path, test.info().project.use.baseURL).href);
}
const feature = (page) => page.getByTestId('rank-perks'),
  rankHalf = (page) => page.getByTestId('rank-perks__rank'),
  perksHalf = (page) => page.getByTestId('rank-perks__perks');
const count = (state, procedure) => state.reads.filter((row) => row.procedure === procedure).length;
async function shot(page, name) {
  await page.screenshot({ path: evidence + '/' + name + '.png', fullPage: true });
}
async function signOut(page) {
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
}
async function currentReturn(page) {
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('navigation', { name: 'Person settings', exact: true }).getByRole('link', { name: 'Account', exact: true }).click();
}

test('guest Account performs no private rank or perk reads', async ({ page, context }) => {
  const state = await network(context);
  await page.goto(original);
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(state.reads).toEqual([]);
  expect(state.writes).toEqual([]);
});
test('actual App login exposes only owned rank, exact remaining XP and all seven projections without writes or journal cleanup', async ({
  page,
  context,
}) => {
  const state = await network(context);
  await page.addInitScript(() => {
    localStorage.setItem('intafaced:more:pending:11111111-1111-4111-8111-111111111111:academy', 'original-academy-bytes');
    localStorage.setItem('intafaced.customer.subaccounts.v1:11111111-1111-4111-8111-111111111111', 'original-subaccount-bytes');
  });
  await login(page);
  await expect(rankHalf(page)).toContainText('Rank 2');
  await expect(perksHalf(page).locator('dl > div')).toHaveCount(7);
  await expect(perksHalf(page)).toContainText('50 bps');
  await expect(perksHalf(page)).toContainText('1.5×');
  await expect(rankHalf(page).locator('time')).toHaveAttribute('datetime', stamp);
  expect(await rankHalf(page).locator('dd').allTextContents()).toEqual(['2,500', '400', '1,500']);
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Verification', exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Strategy subaccounts', exact: true })).toBeVisible();
  const journals = await page.evaluate(() => [
    localStorage.getItem('intafaced:more:pending:11111111-1111-4111-8111-111111111111:academy'),
    localStorage.getItem('intafaced.customer.subaccounts.v1:11111111-1111-4111-8111-111111111111'),
  ]);
  expect(journals).toEqual(['original-academy-bytes', 'original-subaccount-bytes']);
  expect(state.reads.filter((row) => row.procedure.startsWith('rank.')).map((row) => [row.procedure, row.actor, row.input])).toEqual([
    ['rank.get', owner, null],
    ['rank.perks', owner, null],
  ]);
  expect(state.writes).toEqual([]);
  await shot(page, 'desktop');
});
test('configured zero and signed bigint maximum stay exact; null remaining never borrows a seeded next tier', async ({ page, context }) => {
  let reads = 0;
  const large = '9223372036854775807';
  const state = await network(context, {
    'rank.get': (route) =>
      reply(
        route,
        ++reads === 1
          ? rank(owner, { rank: 0, xp: '0', seasonXp: '0', nextRankAt: large })
          : rank(owner, { rank: 9, xp: large, seasonXp: large, nextRankAt: null }),
      ),
  });
  await login(page);
  await expect(rankHalf(page)).toContainText('Rank 0');
  expect((await rankHalf(page).locator('dd').allTextContents()).map((text) => text.replace(/\D/g, ''))).toEqual(['0', '0', large]);
  await page.getByRole('button', { name: 'Refresh rank', exact: true }).click();
  await expect(rankHalf(page)).toContainText('Rank 9');
  expect((await rankHalf(page).locator('dd').allTextContents()).slice(0, 2).map((text) => text.replace(/\D/g, ''))).toEqual([large, large]);
  await expect(rankHalf(page)).toContainText('No higher rank in the current ladder');
  expect(state.writes).toEqual([]);
});
test('rank failure and pointer retry preserve independently valid perks', async ({ page, context }) => {
  let reads = 0;
  const state = await network(context, { 'rank.get': (route) => (++reads === 1 ? fail(route) : reply(route, rank(owner, { rank: 4 }))) });
  await login(page);
  await expect(rankHalf(page)).toContainText('Couldn’t read your rank');
  await expect(perksHalf(page)).toContainText('50 bps');
  await page.getByRole('button', { name: 'Retry rank', exact: true }).click();
  await expect(rankHalf(page)).toContainText('Rank 4');
  expect(count(state, 'rank.get')).toBe(2);
  expect(count(state, 'rank.perks')).toBe(1);
  expect(state.writes).toEqual([]);
});
test('perks failure and keyboard retry preserve independently valid rank', async ({ page, context }) => {
  let reads = 0;
  const state = await network(context, {
    'rank.perks': (route) => (++reads === 1 ? fail(route) : reply(route, perks({ feeDiscountBps: 75 }))),
  });
  await login(page);
  await expect(rankHalf(page)).toContainText('Rank 2');
  await expect(perksHalf(page)).toContainText('Couldn’t read your perks');
  await page.getByRole('button', { name: 'Retry perks', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(perksHalf(page)).toContainText('75 bps');
  expect(count(state, 'rank.get')).toBe(1);
  expect(count(state, 'rank.perks')).toBe(2);
  expect(state.writes).toEqual([]);
});
for (const [name, procedure, value] of [
  ['other owner', 'rank.get', rank(other)],
  ['noncanonical XP', 'rank.get', rank(owner, { xp: '1e9' })],
  ['fabricated date', 'rank.get', rank(owner, { updatedAt: '2026-02-31T08:00:00.000Z' })],
  ['missing perk data', 'rank.perks', {}],
  ['unsafe perk count', 'rank.perks', perks({ copyFollowerCap: 9007199254740992 })],
])
  test(`malformed ${name} refuses only its own read half`, async ({ page, context }) => {
    const state = await network(context, { [procedure]: (route) => reply(route, value) });
    await login(page);
    const broken = procedure === 'rank.get' ? rankHalf(page) : perksHalf(page),
      good = procedure === 'rank.get' ? perksHalf(page) : rankHalf(page);
    await expect(broken.getByTestId('rank-perks__failure')).toBeVisible();
    await expect(good).toContainText(procedure === 'rank.get' ? '50 bps' : 'Rank 2');
    expect(state.writes).toEqual([]);
  });
test('held old-owner read cannot publish after real sign out and another owner login', async ({ page, context }) => {
  const hold = held();
  const state = await network(context, {
    'rank.get': async (route, actor) => {
      if (actor === owner) {
        await hold.promise;
        return reply(route, rank(owner));
      }
      return reply(route, rank(other, { rank: 4 }));
    },
  });
  await login(page);
  await expect(perksHalf(page)).toContainText('50 bps');
  await expect(rankHalf(page)).toContainText('Loading your rank');
  await signOut(page);
  state.owner = other;
  await login(page);
  await expect(rankHalf(page)).toContainText('Rank 4');
  hold.release();
  await page.waitForTimeout(100);
  await expect(rankHalf(page)).not.toContainText('Rank 2');
  expect(state.writes).toEqual([]);
});
test('same-owner session refresh replaces the API client and rejects its held predecessor', async ({ page, context }) => {
  const hold = held();
  const state = await network(context, {
    expiresAt: new Date(Date.now() + 31000).toISOString(),
    'rank.get': async (route, actor, token) => {
      if (token.endsWith('-1')) {
        await hold.promise;
        return reply(route, rank(actor));
      }
      return reply(route, rank(actor, { rank: 4 }));
    },
  });
  await login(page);
  await expect(rankHalf(page)).toContainText('Rank 4');
  hold.release();
  await page.waitForTimeout(100);
  await expect(rankHalf(page)).not.toContainText('Rank 2');
  expect(state.sequence).toBe(2);
  expect(state.writes).toEqual([]);
});
test('observed full-URL A→B→A departure cancels held old answer and current read succeeds', async ({ page, context }) => {
  const hold = held();
  let reads = 0;
  const state = await network(context, {
    'rank.get': async (route, actor) => {
      if (++reads === 1) {
        await hold.promise;
        return reply(route, rank(actor));
      }
      return reply(route, rank(actor, { rank: 4 }));
    },
  });
  await login(page);
  await expect(rankHalf(page)).toContainText('Loading your rank');
  await page.evaluate(() => {
    const original = location.href;
    history.replaceState(null, '', '/uc/account?read=other#departed');
    dispatchEvent(new PopStateEvent('popstate'));
    history.replaceState(null, '', original);
    dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await expect(rankHalf(page)).toContainText('Rank 4');
  hold.release();
  await page.waitForTimeout(100);
  await expect(rankHalf(page)).not.toContainText('Rank 2');
  expect(count(state, 'rank.get')).toBe(2);
  expect(state.writes).toEqual([]);
});
test('native room departure and current Account return cannot expose held unmounted read', async ({ page, context }) => {
  const hold = held();
  let reads = 0;
  const state = await network(context, {
    'rank.get': async (route, actor) => {
      if (++reads === 1) {
        await hold.promise;
        return reply(route, rank(actor));
      }
      return reply(route, rank(actor, { rank: 4 }));
    },
  });
  await login(page);
  await expect(rankHalf(page)).toContainText('Loading your rank');
  await page.getByRole('link', { name: 'More', exact: true }).filter({ visible: true }).click();
  await currentReturn(page);
  await expect(rankHalf(page)).toContainText('Rank 4');
  hold.release();
  await page.waitForTimeout(100);
  await expect(rankHalf(page)).not.toContainText('Rank 2');
  expect(state.writes).toEqual([]);
});
test('current retry followed by query/hash departure cannot publish its held answer', async ({ page, context }) => {
  const hold = held();
  let reads = 0;
  const state = await network(context, {
    'rank.get': async (route, actor) => {
      const index = ++reads;
      if (index === 1) return fail(route);
      if (index === 2) {
        await hold.promise;
        return reply(route, rank(actor));
      }
      return reply(route, rank(actor, { rank: 4 }));
    },
  });
  await login(page);
  await page.getByRole('button', { name: 'Retry rank', exact: true }).click();
  await expect(rankHalf(page)).toContainText('Loading your rank');
  await page.evaluate(() => {
    history.replaceState(null, '', '/uc/account?read=current#new');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(rankHalf(page)).toContainText('Rank 4');
  hold.release();
  await page.waitForTimeout(100);
  await expect(rankHalf(page)).not.toContainText('Rank 2');
  expect(state.writes).toEqual([]);
});
test('actual 401 sign-in and registration preserve full current query and hash', async ({ page, context }) => {
  const state = await network(context, { 'rank.get': (route) => fail(route, 401) });
  await login(page);
  const signIn = page.locator('#main').getByRole('link', { name: 'Sign in', exact: true });
  await expect(signIn).toHaveAttribute('href', '/login?redirect=' + encodeURIComponent(original));
  await signIn.click();
  await expect(page.getByRole('link', { name: 'Create account', exact: true })).toHaveAttribute(
    'href',
    '/register?redirect=' + encodeURIComponent(original),
  );
  expect(state.writes).toEqual([]);
});
for (const [locale, rankLabel, perkLabel, retryLabel, refreshLabel] of [
  ['en', 'Current rank', 'Current perks', 'Retry perks', 'Refresh rank'],
  ['es', 'Rango actual', 'Ventajas actuales', 'Reintentar ventajas', 'Actualizar rango'],
  ['fr', 'Rang actuel', 'Avantages actuels', 'Réessayer les avantages', 'Actualiser le rang'],
])
  for (const width of [320, 390])
    test(`${locale} ${width}px independently retries with pointer/keyboard, exact long XP and no horizontal overflow`, async ({
      page,
      context,
    }) => {
      let reads = 0;
      const large = '9223372036854775807';
      const state = await network(context, {
        'rank.get': (route) => reply(route, rank(owner, { xp: large, seasonXp: '0', nextRankAt: large })),
        'rank.perks': (route) => (++reads === 1 ? fail(route) : reply(route, perks())),
      });
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((language) => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language })), locale);
      await login(page);
      await expect(feature(page).getByRole('heading', { name: rankLabel, exact: true })).toBeVisible();
      await expect(feature(page).getByRole('heading', { name: perkLabel, exact: true })).toBeVisible();
      const retry = feature(page).getByRole('button', { name: retryLabel, exact: true });
      await retry.focus();
      await page.keyboard.press('Enter');
      await expect(perksHalf(page).locator('dl > div')).toHaveCount(7);
      const refresh = feature(page).getByRole('button', { name: refreshLabel, exact: true });
      await refresh.click();
      await expect(rankHalf(page).locator('dd').first()).not.toBeEmpty();
      expect((await rankHalf(page).locator('dd').first().textContent()).replace(/\D/g, '')).toBe(large);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await refresh.boundingBox()).height).toBeGreaterThanOrEqual(44);
      const axe = await new AxeBuilder({ page })
        .include('[data-testid="rank-perks"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(axe.violations).toEqual([]);
      expect(state.writes).toEqual([]);
      await shot(page, `rank-${locale}-${width}`);
    });
