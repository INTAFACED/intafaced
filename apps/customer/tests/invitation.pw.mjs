import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const owner = '11111111-1111-4111-8111-111111111111',
  other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const link = '22222222-2222-4222-8222-222222222222',
  replacement = '33333333-3333-4333-8333-333333333333';
const referrer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const originalRef = '44444444-4444-4444-8444-444444444444';
const secondRef = '55555555-5555-4555-8555-555555555555';
const stamp = '2026-10-09T22:41:00.000Z',
  key = 'intafaced.customer.invitation.v1:' + owner;
const invitation = '/invite?token=' + link;
const evidence = process.env.INVITATION_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const errors = new WeakMap(),
  summaries = [];
test.beforeEach(async ({ context }) => {
  const list = [];
  errors.set(context, list);
  const watch = (page) => page.on('pageerror', () => list.push('pageerror'));
  context.pages().forEach(watch);
  context.on('page', watch);
});
test.afterEach(async ({ context }, info) => {
  expect(errors.get(context)).toEqual([]);
  summaries.push({ name: info.title, status: info.status, pageErrorCount: errors.get(context).length });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summaries, null, 2)));
const reply = (route, data) => route.fulfill({ status: 200, json: { result: { data } } });
const fail = (route, status = 503, message = 'Isolated response lost', code = 'ISOLATED_LOST') =>
  route.fulfill({ status, json: { error: { message, data: { cause: { code } } } } });
async function replyAfterDeparture(route, data) {
  try {
    await reply(route, data);
  } catch (error) {
    const failure = route.request().failure()?.errorText;
    if (route.request().frame().page().isClosed() || failure === 'net::ERR_ABORTED' || failure === 'net::ERR_FAILED') return;
    throw error;
  }
}
function held() {
  let release;
  return {
    promise: new Promise((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
const record = (localRef = originalRef, extra = {}) => ({ owner, kind: 'invitation-accept', localRef, createdAt: stamp, ...extra });
const edge = (userId = owner, extra = {}) => ({ userId, referrerId: referrer, attributedAt: stamp, ...extra });
async function network(context, options = {}) {
  const state = { owner, posts: [], reads: [], sequence: 0, current: null, ...options },
    sessions = new Map();
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'POST' ? request.postDataJSON() : JSON.parse(url.searchParams.get('input') || 'null');
    // Models the HttpOnly `ifc_rt` cookie: sign-in sets it, logout clears it, and a bare refresh without it is session_invalid.
    if (procedure === 'auth.refresh' && !state.cookie)
      return route.fulfill({
        status: 401,
        json: { error: { message: 'Session not found', data: { intafacedCode: 'auth.session_invalid' } } },
      });
    if (procedure === 'auth.login') state.cookie = true;
    if (procedure === 'auth.logout') state.cookie = false;
    if (procedure === 'auth.login' || procedure === 'auth.refresh') {
      const accessToken = 'isolated-invitation-session-' + ++state.sequence;
      sessions.set(accessToken, state.owner);
      return reply(route, {
        userId: state.owner,
        accessToken,
        refreshToken: 'isolated-invitation-refresh-' + state.sequence,
        expiresAt:
          procedure === 'auth.login'
            ? state.refreshAfterMs
              ? new Date(Date.now() + 30000 + state.refreshAfterMs).toISOString()
              : '2027-10-10T09:41:00.000Z'
            : '2027-10-10T09:41:00.000Z',
      });
    }
    if (procedure === 'auth.logout') return reply(route, { ok: true });
    const actor = sessions.get(request.headers().authorization?.replace('Bearer ', ''));
    const entry = { procedure, actor: actor === owner ? 'a' : actor === other ? 'b' : 'none', sequence: state.sequence };
    if (request.method() === 'POST') state.posts.push({ ...entry, input, idempotencyHeaderAbsent: !request.headers()['idempotency-key'] });
    else state.reads.push(entry);
    if (state[procedure]) return state[procedure](route, input, actor);
    if (procedure === 'affiliates.myReferrer') return reply(route, state.current);
    if (procedure === 'affiliates.shareHits') return reply(route, { hits: 8, attributed: true });
    if (procedure === 'searchKb') return reply(route, []);
    return fail(route);
  });
  return state;
}
async function password(page) {
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page.locator('.invitation')).toBeVisible();
}
async function login(page, capability = link) {
  await page.goto('/login?invite=' + capability);
  await password(page);
}
const review = (page) => page.getByRole('button', { name: 'Review invitation', exact: true });
const accept = (page) => page.getByRole('button', { name: 'Accept this invitation', exact: true });
const original = (page) => page.getByRole('region', { name: 'Original result unknown', exact: true });
const read = (page) => page.getByRole('button', { name: 'Read current status', exact: true });
async function send(page) {
  await review(page).click();
  await accept(page).click();
}
async function journal(page, storageKey = key) {
  return page.evaluate((value) => localStorage.getItem(value), storageKey);
}
async function seed(context, records) {
  await context.addInitScript(({ key, records }) => localStorage.setItem(key, JSON.stringify(records)), { key, records });
}
async function helpBack(page) {
  await page.getByRole('navigation', { name: 'Public navigation', exact: true }).getByRole('link', { name: 'Help', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'How can we help?', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.locator('.invitation')).toBeVisible();
}
async function shot(page, name) {
  await page.screenshot({
    path: evidence + '/' + name + '.png',
    fullPage: true,
    mask: [page.locator('.invitation__private,input[autocomplete="username"],input[autocomplete="current-password"]')],
  });
}
async function setLocale(context, language) {
  const view = await context.newPage();
  await view.goto('/login?redirect=%2Fview');
  await view.locator('input[name="identifier"]').fill('isolated-owner');
  await view.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await view.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption(language);
  return view;
}

test('guest invitation offers native sign-in return without private reads or acceptance', async ({ context, page }) => {
  const s = await network(context);
  await page.goto(invitation);
  await expect(page.getByRole('heading', { name: 'Your account comes first.', exact: true })).toBeVisible();
  expect(s.posts).toEqual([]);
  expect(s.reads).toEqual([]);
  expect(await page.locator('.invitation').textContent()).not.toContain(link);
  await page.locator('.invitation').getByRole('link', { name: 'Sign in', exact: true }).click();
  await password(page);
  expect(await page.evaluate((expected) => new URL(location.href).searchParams.get('token') === expected, link)).toBe(true);
  await expect(review(page)).toBeEnabled();
  expect(s.posts).toEqual([]);
  await review(page).click();
  await expect(accept(page)).toBeVisible();
  expect(s.posts).toEqual([]);
  await accept(page).click();
  await expect(page.getByRole('heading', { name: 'Referral status recorded.', exact: true }).last()).toBeVisible();
  expect(s.posts.length).toBe(1);
  expect(s.posts[0].input.token === link).toBe(true);
});
test('header sign-in preserves the original invitation and never automatically accepts', async ({ context, page }) => {
  const s = await network(context);
  await page.goto(invitation);
  await page.locator('.public-signin').click();
  await password(page);
  expect(await page.evaluate((expected) => new URL(location.href).searchParams.get('token') === expected, link)).toBe(true);
  await expect(review(page)).toBeVisible();
  expect(s.posts).toEqual([]);
  await review(page).click();
  expect(s.posts).toEqual([]);
});
test('auth alternate header and form links retain the original invitation', async ({ context, page }) => {
  await network(context);
  await page.goto(invitation);
  await page.locator('.invitation').getByRole('link', { name: 'Create account', exact: true }).click();
  expect(await page.evaluate((expected) => new URL(location.href).searchParams.get('invite') === expected, link)).toBe(true);
  await page.locator('.public-signin').click();
  expect(await page.evaluate((expected) => new URL(location.href).searchParams.get('invite') === expected, link)).toBe(true);
  await password(page);
  await expect(review(page)).toBeVisible();
});
for (const [name, destination] of [
  ['Security', '/uc/safe'],
  ['full Money query', '/money?asset=USDC&view=available&origin=isolated-return'],
  ['full Send query', '/pay/send?asset=USDC&amount=12.3400&recipient=isolated-return'],
])
  test('header auth alternation preserves the original accepted return: ' + name, async ({ context, page }) => {
    const s = await network(context);
    await page.goto('/login?redirect=' + encodeURIComponent(destination));
    await page.locator('.public-signin').click();
    expect(
      await page.evaluate(
        (expected) => location.pathname === '/register' && new URL(location.href).searchParams.get('redirect') === expected,
        destination,
      ),
    ).toBe(true);
    await page.locator('.public-signin').click();
    expect(
      await page.evaluate(
        (expected) => location.pathname === '/login' && new URL(location.href).searchParams.get('redirect') === expected,
        destination,
      ),
    ).toBe(true);
    await page.locator('input[name="identifier"]').fill('isolated-owner');
    await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
    await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
    await expect.poll(() => page.evaluate((expected) => location.pathname + location.search === expected, destination)).toBe(true);
    expect(s.posts).toEqual([]);
  });
for (const [name, destination] of [
  ['external', 'https://isolated.invalid/uc/safe'],
  ['parked', '/chain'],
  ['team', '/ops'],
  ['unrecognized', '/unrecognized-return'],
])
  test('header auth alternation safely returns an unavailable original room to Money: ' + name, async ({ context, page }) => {
    const s = await network(context);
    await page.goto('/login?redirect=' + encodeURIComponent(destination));
    await page.locator('.public-signin').click();
    expect(
      await page.evaluate(() => location.pathname === '/register' && new URL(location.href).searchParams.get('redirect') === '/money'),
    ).toBe(true);
    await page.locator('.public-signin').click();
    await page.locator('input[name="identifier"]').fill('isolated-owner');
    await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
    await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
    await expect.poll(() => page.evaluate(() => location.pathname === '/money' && location.search === '')).toBe(true);
    expect(s.posts).toEqual([]);
  });
test('header auth alternation preserves a validated invitation alongside its original return', async ({ context, page }) => {
  const s = await network(context);
  await page.goto('/login?redirect=%2Fuc%2Fsafe&invite=' + link);
  await page.locator('.public-signin').click();
  expect(
    await page.evaluate(
      (expected) =>
        new URL(location.href).searchParams.get('invite') === expected &&
        new URL(location.href).searchParams.get('redirect') === '/uc/safe',
      link,
    ),
  ).toBe(true);
  await page.locator('.public-signin').click();
  await password(page);
  expect(
    await page.evaluate(
      (expected) => location.pathname === '/invite' && new URL(location.href).searchParams.get('token') === expected,
      link,
    ),
  ).toBe(true);
  await expect(review(page)).toBeEnabled();
  expect(s.posts).toEqual([]);
});
test('header auth alternation drops malformed invitation while preserving its safe return', async ({ context, page }) => {
  const s = await network(context);
  await page.goto('/login?redirect=%2Fuc%2Fsafe&invite=invalid');
  await page.locator('.public-signin').click();
  expect(
    await page.evaluate(
      () => !new URL(location.href).searchParams.has('invite') && new URL(location.href).searchParams.get('redirect') === '/uc/safe',
    ),
  ).toBe(true);
  await page.locator('.public-signin').click();
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect.poll(() => page.evaluate(() => location.pathname === '/uc/safe' && location.search === '')).toBe(true);
  expect(s.posts).toEqual([]);
});
test('header auth alternation preserves the accepted legacy return path', async ({ context, page }) => {
  await network(context);
  await page.goto('/login/returnUrl/' + encodeURIComponent('/uc/safe'));
  await page.locator('.public-signin').click();
  expect(
    await page.evaluate(() => location.pathname === '/register' && new URL(location.href).searchParams.get('redirect') === '/uc/safe'),
  ).toBe(true);
});
for (const address of ['/invite', '/invite?token=invalid'])
  test('missing or invalid invitation never propagates capability: ' + address, async ({ context, page }) => {
    const s = await network(context);
    await page.goto(address);
    await expect(page.locator('.invitation__card').getByRole('heading')).toBeVisible();
    await expect(page.locator('.public-signin')).toHaveAttribute('href', '/login');
    expect(s.posts).toEqual([]);
    expect(s.reads).toEqual([]);
    await expect(review(page)).toHaveCount(0);
  });
test('native review has exact owner, held capability, consequences, focus and Cancel without POST', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  await review(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#invitation-review-title')).toBeFocused();
  expect(await page.locator('.invitation__owner').textContent()).toContain(owner);
  expect(await page.locator('.invitation').textContent()).not.toContain(link);
  await expect(page.locator('.invitation__card')).toContainText('Repeating acceptance can record another visit.');
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click();
  await expect(review(page)).toBeFocused();
  expect(s.posts).toEqual([]);
  expect(s.reads).toEqual([]);
});
test('original reply true records status without inventing a new link referrer', async ({ context, page }) => {
  const s = await network(context, { current: edge() });
  await login(page);
  await send(page);
  await expect(page.locator('.invitation')).toContainText('This reply can include an existing relationship.');
  expect(s.posts.length).toBe(1);
  expect(Object.keys(s.posts[0].input)).toEqual(['token']);
  expect(s.posts[0].idempotencyHeaderAbsent).toBe(true);
  expect(await journal(page)).toBe(null);
  await read(page).click();
  await expect(page.locator('.invitation__current')).toContainText('A referral is recorded now');
  expect(await page.locator('.invitation__current').textContent()).toContain(referrer);
  await expect(page.locator('.invitation__current')).toContainText('This read does not confirm the original attempt.');
  expect(s.posts.length).toBe(1);
  await shot(page, 'known-current-desktop');
});
test('known false is no attribution reported, with owned nullable current read', async ({ context, page }) => {
  const s = await network(context, { 'affiliates.shareHits': (route) => reply(route, { hits: 9, attributed: false }) });
  await login(page);
  await send(page);
  await expect(page.locator('.invitation')).toContainText('No attribution reported.');
  expect(await journal(page)).toBe(null);
  await read(page).click();
  await expect(page.locator('.invitation__current')).toContainText('No referral is recorded now');
  expect(s.posts.length).toBe(1);
});
test('post-hit referral409 stays unknown and cannot be repeated through Help and Back', async ({ context, page }) => {
  let hits = 0;
  const s = await network(context, {
    'affiliates.shareHits': (route) => {
      hits++;
      return fail(route, 409, 'Referral would create a cycle [referral.cycle]', 'referral.cycle');
    },
  });
  await login(page);
  await send(page);
  await expect(original(page)).toBeVisible();
  const bytes = await journal(page);
  await helpBack(page);
  await expect(original(page)).toBeVisible();
  await expect(review(page)).toHaveCount(0);
  expect(await journal(page)).toBe(bytes);
  expect(s.posts.length).toBe(1);
  expect(hits).toBe(1);
  await read(page).click();
  await expect(page.locator('.invitation__current')).toContainText('No referral is recorded now');
  expect(await journal(page)).toBe(bytes);
});
test('unknown survives reload and fresh native sign-in without replay or inferred resolution', async ({ context, page }) => {
  const s = await network(context, { 'affiliates.shareHits': (route) => fail(route) });
  await login(page);
  await send(page);
  await expect(original(page)).toBeVisible();
  const bytes = await journal(page);
  await page.reload();
  await page.locator('.invitation').getByRole('link', { name: 'Sign in', exact: true }).click();
  await password(page);
  await expect(original(page)).toBeVisible();
  expect(await journal(page)).toBe(bytes);
  expect(s.posts.length).toBe(1);
  await expect(review(page)).toHaveCount(0);
});
test('unknown blocks a different capability for this owner while current read remains useful', async ({ context, page }) => {
  const s = await network(context, { 'affiliates.shareHits': (route) => fail(route), current: edge() });
  await login(page);
  await send(page);
  await expect(original(page)).toBeVisible();
  const bytes = await journal(page);
  await login(page, replacement);
  await expect(original(page)).toBeVisible();
  await read(page).click();
  await expect(page.locator('.invitation__current')).toContainText('A referral is recorded now');
  expect(await journal(page)).toBe(bytes);
  expect(s.posts.length).toBe(1);
  await expect(review(page)).toHaveCount(0);
});
for (const attributed of [true, false])
  test(
    'unknown owner A permits one deliberate owner B acceptance, then A bytes remain blocked: ' + attributed,
    async ({ context, page }) => {
      const s = await network(context, {
        'affiliates.shareHits': (route, input, actor) => (actor === owner ? fail(route) : reply(route, { hits: 10, attributed })),
      });
      await login(page);
      await send(page);
      await expect(original(page)).toBeVisible();
      const bytes = await journal(page);
      s.owner = other;
      await login(page, replacement);
      await expect(review(page)).toBeEnabled();
      await review(page).click();
      expect(s.posts.length).toBe(1);
      await accept(page).click();
      await expect(page.locator('.invitation')).toContainText(
        attributed ? 'This reply can include an existing relationship.' : 'The service reported no attribution from this check.',
      );
      expect(s.posts.filter((row) => row.actor === 'b').length).toBe(1);
      expect(s.posts[1].input.token === replacement).toBe(true);
      expect(await journal(page)).toBe(bytes);
      s.owner = owner;
      await login(page);
      await expect(original(page)).toBeVisible();
      expect(await journal(page)).toBe(bytes);
      await expect(review(page)).toHaveCount(0);
      expect(s.posts.length).toBe(2);
    },
  );
test('unknown keeps canonical Support and Account invitations useful without acceptance replay', async ({ context, page }) => {
  const s = await network(context, { 'affiliates.shareHits': (route) => fail(route) });
  await login(page);
  await send(page);
  await expect(original(page)).toBeVisible();
  const bytes = await journal(page);
  await original(page).getByRole('link', { name: 'Get support ↗', exact: true }).click();
  expect(new URL(page.url()).pathname).toBe('/support');
  await page.goBack();
  await expect(original(page)).toBeVisible();
  await page.getByRole('link', { name: 'Open account invitations ↗', exact: true }).click();
  expect(new URL(page.url()).pathname).toBe('/uc/promotion');
  await page.goBack();
  await expect(original(page)).toBeVisible();
  expect(await journal(page)).toBe(bytes);
  expect(s.posts.filter((row) => row.procedure === 'affiliates.shareHits').length).toBe(1);
});
test('unknown durable record is minimal and contains no capability, URL or authentication material', async ({ context, page }) => {
  await network(context, { 'affiliates.shareHits': (route) => fail(route) });
  await login(page);
  await send(page);
  await expect(original(page)).toBeVisible();
  const raw = await journal(page),
    saved = JSON.parse(raw)[0];
  expect(Object.keys(saved).sort()).toEqual(['createdAt', 'kind', 'localRef', 'owner']);
  expect(saved.owner === owner).toBe(true);
  expect(saved.kind).toBe('invitation-accept');
  expect(saved.localRef).toMatch(/^[0-9a-f-]{36}$/);
  expect(
    [link, replacement, 'isolated-password', 'isolated-invitation-session', '/invite?', 'isolated-owner'].some((value) =>
      raw.includes(value),
    ),
  ).toBe(false);
});
test('pending original becomes durable unknown through native Help and Back, late reply discarded', async ({ context, page }) => {
  const gate = held();
  const s = await network(context, {
    'affiliates.shareHits': async (route) => {
      await gate.promise;
      await replyAfterDeparture(route, { hits: 11, attributed: true });
    },
  });
  await login(page);
  await send(page);
  await expect.poll(() => s.posts.length).toBe(1);
  await expect(page.getByRole('region', { name: 'Checking this invitation…', exact: true })).toBeVisible();
  const bytes = await journal(page);
  await helpBack(page);
  await expect(original(page)).toBeVisible();
  gate.release();
  await expect(page.locator('.invitation')).not.toContainText('This reply can include an existing relationship.');
  expect(await journal(page)).toBe(bytes);
  expect(s.posts.length).toBe(1);
});
test('held preflight actual SessionProvider token refresh refuses stale POST before durable save', async ({ context, page }) => {
  const gate = held();
  const s = await network(context, {
    refreshAfterMs: 2000,
    'affiliates.myReferrer': async (route) => {
      await gate.promise;
      await replyAfterDeparture(route, null);
    },
  });
  await login(page);
  await send(page);
  await expect.poll(() => s.reads.length).toBe(1);
  await expect.poll(() => s.sequence).toBe(2);
  gate.release();
  await expect(review(page)).toBeEnabled();
  expect(s.posts).toEqual([]);
  expect(await journal(page)).toBe(null);
});
test('held original reply after actual token refresh cannot contaminate fresh context or settle original', async ({ context, page }) => {
  const gate = held();
  const s = await network(context, {
    refreshAfterMs: 2000,
    'affiliates.shareHits': async (route) => {
      await gate.promise;
      await replyAfterDeparture(route, { hits: 12, attributed: true });
    },
  });
  await login(page);
  await send(page);
  await expect.poll(() => s.posts.length).toBe(1);
  const bytes = await journal(page);
  await expect.poll(() => s.sequence).toBe(2);
  gate.release();
  await expect(original(page)).toBeVisible();
  await expect(page.locator('.invitation')).not.toContainText('This reply can include an existing relationship.');
  expect(await journal(page)).toBe(bytes);
  expect(s.posts.length).toBe(1);
});
test('held old owner reply cannot contaminate owner B acceptance or erase owner A guard', async ({ context, page }) => {
  const gate = held();
  const s = await network(context, {
    'affiliates.shareHits': async (route, input, actor) => {
      if (actor === owner) {
        await gate.promise;
        return replyAfterDeparture(route, { hits: 13, attributed: true });
      }
      return reply(route, { hits: 14, attributed: false });
    },
  });
  await login(page);
  await send(page);
  await expect.poll(() => s.posts.length).toBe(1);
  const bytes = await journal(page);
  s.owner = other;
  await login(page, replacement);
  await send(page);
  await expect(page.locator('.invitation')).toContainText('No attribution reported.');
  gate.release();
  await expect(page.locator('.invitation')).not.toContainText('This reply can include an existing relationship.');
  expect(await journal(page)).toBe(bytes);
  s.owner = owner;
  await login(page);
  await expect(original(page)).toBeVisible();
  expect(await journal(page)).toBe(bytes);
  expect(s.posts.length).toBe(2);
});
test('native same-mounted query change discards frozen review and requires a new deliberate review', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  await review(page).click();
  await page.evaluate((next) => {
    history.pushState(null, '', '/invite?token=' + next);
    dispatchEvent(new PopStateEvent('popstate'));
  }, replacement);
  await expect(accept(page)).toHaveCount(0);
  await expect(review(page)).toBeEnabled();
  expect(s.posts).toEqual([]);
  await send(page);
  await expect(page.locator('.invitation')).toContainText('This reply can include an existing relationship.');
  expect(s.posts[0].input.token === replacement).toBe(true);
});
test('held preflight same-mounted URL departure cannot dispatch the old capability', async ({ context, page }) => {
  const gate = held();
  const s = await network(context, {
    'affiliates.myReferrer': async (route) => {
      await gate.promise;
      await replyAfterDeparture(route, null);
    },
  });
  await login(page);
  await send(page);
  await expect.poll(() => s.reads.length).toBe(1);
  await page.evaluate((next) => {
    history.pushState(null, '', '/invite?token=' + next);
    dispatchEvent(new PopStateEvent('popstate'));
  }, replacement);
  gate.release();
  await expect(review(page)).toBeEnabled();
  expect(s.posts).toEqual([]);
  expect(await journal(page)).toBe(null);
});
test('new tab retains an earlier owner unknown and performs only useful owned GET', async ({ context, page }) => {
  const s = await network(context, { 'affiliates.shareHits': (route) => fail(route) });
  await login(page);
  await send(page);
  await expect(original(page)).toBeVisible();
  const bytes = await journal(page);
  const next = await context.newPage();
  await login(next, replacement);
  await expect(original(next)).toBeVisible();
  await read(next).click();
  await expect(next.locator('.invitation__current')).toContainText('No referral is recorded now');
  expect(await journal(next)).toBe(bytes);
  expect(s.posts.length).toBe(1);
});
test('closed sending tab preserves original unknown in a new native signed-in tab', async ({ context, page }) => {
  const gate = held();
  const s = await network(context, {
    'affiliates.shareHits': async (route) => {
      await gate.promise;
      await replyAfterDeparture(route, { hits: 15, attributed: true });
    },
  });
  await login(page);
  await send(page);
  await expect.poll(() => s.posts.length).toBe(1);
  const bytes = await journal(page);
  await page.close();
  gate.release();
  const next = await context.newPage();
  await login(next);
  await expect(original(next)).toBeVisible();
  expect(await journal(next)).toBe(bytes);
  expect(s.posts.length).toBe(1);
});
test('actual owner WebLock excludes a second tab while preflight is held', async ({ context, page }) => {
  const gate = held();
  let first = true;
  const s = await network(context, {
    'affiliates.myReferrer': async (route) => {
      if (first) {
        first = false;
        await gate.promise;
      }
      return reply(route, null);
    },
  });
  await login(page);
  await send(page);
  await expect.poll(() => s.reads.length).toBe(1);
  const next = await context.newPage();
  await login(next, replacement);
  await send(next);
  await expect(next.locator('.invitation')).toContainText('Another tab is checking an invitation for this account.');
  expect(s.posts).toEqual([]);
  gate.release();
  await expect(page.locator('.invitation')).toContainText('This reply can include an existing relationship.');
  await review(next).click();
  await accept(next).click();
  await expect(next.locator('.invitation')).toContainText('This reply can include an existing relationship.');
  expect(s.posts.length).toBe(2);
});
for (const mode of ['read-denied', 'write-denied', 'locks-unavailable'])
  test('typed browser refusal before acceptance remains useful: ' + mode, async ({ context, page }) => {
    await context.addInitScript((mode) => {
      if (mode !== 'locks-unavailable') {
        const method = mode === 'read-denied' ? 'getItem' : 'setItem',
          previous = Storage.prototype[method];
        Storage.prototype[method] = function (key, ...args) {
          if (key.startsWith('intafaced.customer.invitation.')) throw new Error('Isolated storage denial');
          return previous.call(this, key, ...args);
        };
      }
    }, mode);
    const s = await network(context);
    await login(page);
    if (mode === 'locks-unavailable') await page.evaluate(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
    if (mode !== 'read-denied') await send(page);
    await expect(page.locator('.invitation')).toContainText(
      mode === 'locks-unavailable'
        ? 'Safe coordination between tabs is unavailable.'
        : 'This browser cannot safely save or read the original reference.',
    );
    expect(s.posts).toEqual([]);
    await read(page).click();
    await expect(page.locator('.invitation__current')).toContainText('No referral is recorded now');
  });
for (const records of [
  [record(originalRef, { owner: other })],
  [record(), record()],
  [record(originalRef, { createdAt: '2026-02-30T22:41:00.000Z' })],
  [record(originalRef, { capability: link })],
])
  test(
    'malformed durable originals refuse closed: ' +
      (records.length > 1
        ? 'duplicate'
        : records[0].capability
          ? 'extra field'
          : records[0].owner === other
            ? 'foreign owner'
            : 'calendar'),
    async ({ context, page }) => {
      await seed(context, records);
      const s = await network(context);
      await login(page);
      await expect(review(page)).toBeDisabled();
      await expect(page.locator('.invitation')).toContainText('This browser cannot safely save or read the original reference.');
      expect(s.posts).toEqual([]);
      await read(page).click();
      await expect(page.locator('.invitation__current')).toContainText('No referral is recorded now');
    },
  );
test('multiple independent unknown originals keep all exact references and bytes without a invented cap', async ({ context, page }) => {
  const records = Array.from({ length: 205 }, (_, index) => record('44444444-4444-4444-8444-' + index.toString(16).padStart(12, '0')));
  await seed(context, records);
  const s = await network(context);
  await login(page);
  await expect(original(page)).toHaveCount(205);
  const bytes = await journal(page);
  await read(page).click();
  await expect(page.locator('.invitation__current')).toContainText('No referral is recorded now');
  expect(await journal(page)).toBe(bytes);
  expect(s.posts).toEqual([]);
  await expect(review(page)).toHaveCount(0);
});
const refusals = [
  [404, 'Share token is unknown [share.unknown]', 'share.unknown'],
  [403, 'Share token is revoked [share.revoked]', 'share.revoked'],
  [404, 'Referrer profile is gone [share.profile_gone]', 'share.profile_gone'],
];
for (const [status, message, code] of refusals)
  test('exact source-proven pre-counter refusal is known: ' + code, async ({ context, page }) => {
    const s = await network(context, { 'affiliates.shareHits': (route) => fail(route, status, message, code) });
    await login(page);
    await send(page);
    await expect(page.locator('.invitation')).toContainText('The service refused this original attempt before recording a visit.');
    expect(await journal(page)).toBe(null);
    expect(s.posts.length).toBe(1);
    await expect(original(page)).toHaveCount(0);
    await expect(page.locator('.invitation')).toContainText('HTTP ' + status + ' · ' + code);
  });
for (const [status, message, code] of [
  [404, 'Different service message', 'share.unknown'],
  [500, refusals[0][1], 'share.unknown'],
  [404, 'Referrer is unknown [referral.unknown_referrer]', 'referral.unknown_referrer'],
  [409, 'Depth exceeded [referral.depth_exceeded]', 'referral.depth_exceeded'],
  [403, 'Generic forbidden', 'FORBIDDEN'],
  [500, 'Referral service is unavailable', 'INTERNAL_SERVER_ERROR'],
])
  test('opposing post-hit or unqualified refusal stays unknown: ' + status + '/' + code, async ({ context, page }) => {
    const s = await network(context, { 'affiliates.shareHits': (route) => fail(route, status, message, code) });
    await login(page);
    await send(page);
    await expect(original(page)).toBeVisible();
    expect(JSON.parse(await journal(page)).length).toBe(1);
    expect(s.posts.length).toBe(1);
    await expect(review(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  });
for (const data of [{ hits: 1.5, attributed: true }, { hits: -1, attributed: true }, { hits: 8, attributed: 'true' }, { attributed: true }])
  test(
    'malformed successful reply never erases original: ' + Object.keys(data).join('/') + '/' + String(data.hits),
    async ({ context, page }) => {
      const s = await network(context, { 'affiliates.shareHits': (route) => reply(route, data) });
      await login(page);
      await send(page);
      await expect(original(page)).toBeVisible();
      expect(JSON.parse(await journal(page)).length).toBe(1);
      expect(s.posts.length).toBe(1);
    },
  );
test('unreadable HTTP200 write reply retains original unknown', async ({ context, page }) => {
  const s = await network(context, {
    'affiliates.shareHits': (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'Unreadable isolated reply' }),
  });
  await login(page);
  await send(page);
  await expect(original(page)).toBeVisible();
  expect(JSON.parse(await journal(page)).length).toBe(1);
  expect(s.posts.length).toBe(1);
});
test('known reply and local cleanup failure remain known and only local finish removes original', async ({ context, page }) => {
  await context.addInitScript(() => {
    window.invitationCleanupDenied = true;
    const previous = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith('intafaced.customer.invitation.') && window.invitationCleanupDenied) throw new Error('Isolated cleanup denial');
      return previous.call(this, key);
    };
  });
  const s = await network(context);
  await login(page);
  await send(page);
  await expect(page.locator('.invitation')).toContainText('Local record still saved');
  await expect(original(page)).toHaveCount(0);
  const bytes = await journal(page);
  expect(JSON.parse(bytes).length).toBe(1);
  await read(page).click();
  expect(await journal(page)).toBe(bytes);
  await expect(page.locator('.invitation')).toContainText('The service reply is known.');
  await page.evaluate(() => {
    window.invitationCleanupDenied = false;
  });
  await page.getByRole('button', { name: 'Finish local record', exact: true }).click();
  await expect(page.locator('.invitation')).toContainText('This known local record is finished.');
  expect(await journal(page)).toBe(null);
  expect(s.posts.length).toBe(1);
  await shot(page, 'known-local-finalized');
});
test('known local finish cannot overwrite an independent original added during dispatch', async ({ context, page }) => {
  const gate = held();
  await context.addInitScript(() => {
    window.invitationCleanupDenied = true;
    const previous = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key.startsWith('intafaced.customer.invitation.') &&
        window.invitationCleanupDenied &&
        JSON.parse(value).length === 1 &&
        JSON.parse(value)[0].localRef === '55555555-5555-4555-8555-555555555555'
      )
        throw new Error('Isolated cleanup denial');
      return previous.call(this, key, value);
    };
  });
  const s = await network(context, {
    'affiliates.shareHits': async (route) => {
      await gate.promise;
      return reply(route, { hits: 16, attributed: true });
    },
  });
  await login(page);
  await send(page);
  await expect.poll(() => s.posts.length).toBe(1);
  await page.evaluate(
    ({ key, extra }) => {
      const records = JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify([...records, extra]));
    },
    { key, extra: record(secondRef) },
  );
  gate.release();
  await expect(page.locator('.invitation')).toContainText('Local record still saved');
  const before = JSON.parse(await journal(page));
  expect(before.length).toBe(2);
  const extraBytes = JSON.stringify(before.find((row) => row.localRef === secondRef));
  await page.evaluate(() => {
    window.invitationCleanupDenied = false;
  });
  await page.getByRole('button', { name: 'Finish local record', exact: true }).click();
  await expect(page.locator('.invitation')).toContainText('This known local record is finished.');
  await expect(original(page)).toHaveCount(1);
  const after = JSON.parse(await journal(page));
  expect(after.length).toBe(1);
  expect(JSON.stringify(after[0])).toBe(extraBytes);
  expect(s.posts.length).toBe(1);
});
test('remount only knows durable retained state, never reconstructs known reply from current edge', async ({ context, page }) => {
  await context.addInitScript(() => {
    const previous = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith('intafaced.customer.invitation.')) throw new Error('Isolated cleanup denial');
      return previous.call(this, key);
    };
  });
  const s = await network(context, { current: edge() });
  await login(page);
  await send(page);
  await expect(page.locator('.invitation')).toContainText('Local record still saved');
  const bytes = await journal(page);
  await helpBack(page);
  await expect(original(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finish local record', exact: true })).toHaveCount(0);
  await read(page).click();
  await expect(page.locator('.invitation__current')).toContainText('A referral is recorded now');
  expect(await journal(page)).toBe(bytes);
  expect(s.posts.length).toBe(1);
});
test('owned current read hides old private row through loading and error, then GET retry recovers', async ({ context, page }) => {
  const gate = held();
  let phase = 0;
  const s = await network(context, {
    'affiliates.myReferrer': async (route) => {
      if (phase === 0) return reply(route, edge());
      if (phase === 1) {
        await gate.promise;
        return fail(route, 503, 'Original English read failure', 'ISOLATED_READ');
      }
      return reply(route, null);
    },
  });
  await login(page);
  await read(page).click();
  await expect(page.locator('.invitation__current')).toContainText(referrer);
  phase = 1;
  await read(page).click();
  await expect(page.locator('.invitation__current')).not.toContainText(referrer);
  gate.release();
  await expect(page.locator('.invitation__current .failure')).toContainText('Original English read failure');
  await expect(page.locator('.invitation__current')).not.toContainText(referrer);
  phase = 2;
  await page.locator('.invitation__current .failure').getByRole('button').click();
  await expect(page.locator('.invitation__current')).toContainText('No referral is recorded now');
  expect(s.posts).toEqual([]);
});
for (const data of [
  edge(other),
  edge(owner, { referrerId: owner }),
  edge(owner, { attributedAt: '2026-02-30T22:41:00.000Z' }),
  edge(owner, { referrerId: 'invalid' }),
])
  test(
    'malformed or foreign current read refuses without exposing stale private row: ' +
      (data.userId === other ? 'owner' : data.referrerId === owner ? 'self' : data.referrerId === 'invalid' ? 'uuid' : 'calendar'),
    async ({ context, page }) => {
      const s = await network(context, { current: data });
      await login(page);
      await read(page).click();
      await expect(page.locator('.invitation__current .failure')).toBeVisible();
      expect(await page.locator('.invitation__current').textContent()).not.toContain(referrer);
      await send(page);
      await expect(page.locator('.invitation')).toContainText('The current account could not be checked before acceptance.');
      expect(s.posts).toEqual([]);
      expect(await journal(page)).toBe(null);
    },
  );
for (const width of [320, 390, 768, 1440])
  test('actual compiled review and unknown recovery fit native viewport ' + width, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 900 });
    const s = await network(context, { 'affiliates.shareHits': (route) => fail(route) });
    await login(page);
    await review(page).click();
    await expect(page.locator('#invitation-review-title')).toBeFocused();
    await expect(page.locator('.invitation__current')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await accept(page).evaluate((button) => button.getBoundingClientRect().height >= 44)).toBe(true);
    await shot(page, 'review-' + width);
    await page.getByRole('button', { name: 'Cancel review', exact: true }).click();
    await expect(review(page)).toBeFocused();
    await send(page);
    await expect(original(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await read(page).click();
    await expect(page.locator('.invitation__current')).toContainText('No referral is recorded now');
    expect(s.posts.length).toBe(1);
    await shot(page, 'unknown-' + width);
  });
for (const [language, translatedRead] of [
  ['en', 'Read current status'],
  ['es', 'Leer estado actual'],
  ['fr', 'Lire l’état actuel'],
])
  test(
    'authored locale changes presentation while frozen original and opaque English failures remain unchanged: ' + language,
    async ({ context, page }) => {
      let failRead = false;
      const s = await network(context, {
        'affiliates.myReferrer': (route) =>
          failRead ? fail(route, 503, 'Original English read failure', 'ISOLATED_READ') : reply(route, null),
        'affiliates.shareHits': (route) => fail(route, 500, 'Original English acceptance failure', 'ISOLATED_ACCEPT'),
      });
      await login(page);
      await review(page).click();
      const view = await setLocale(context, language);
      await expect(page.locator('.invitation')).toHaveAttribute('lang', language);
      await page.locator('.invitation__card .button--primary').click();
      await expect(page.locator('.invitation .failure')).toContainText('Original English acceptance failure');
      expect(s.posts[0].input.token === link).toBe(true);
      expect(s.posts[0].actor).toBe('a');
      failRead = true;
      await page.getByRole('button', { name: translatedRead, exact: true }).click();
      await expect(page.locator('.invitation__current .failure')).toContainText('Original English read failure');
      const languages = await page.locator('.invitation .failure p').evaluateAll((nodes) =>
        nodes.map((node) => {
          for (let parent = node; parent; parent = parent.parentElement)
            if (parent.hasAttribute('lang')) return parent.getAttribute('lang');
          return '';
        }),
      );
      expect(languages).toEqual(['und', 'und']);
      const bytes = await journal(page);
      await view.close();
      expect(await journal(page)).toBe(bytes);
      await shot(page, 'opaque-' + language);
    },
  );
test('long opaque provider explanation wraps and stays und with native actionable current read', async ({ context, page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const s = await network(context, { 'affiliates.shareHits': (route) => fail(route, 500, 'Opaque'.repeat(250), 'LONG_OPAQUE') });
  await login(page);
  await send(page);
  await expect(original(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await read(page).click();
  await expect(page.locator('.invitation__current')).toContainText('No referral is recorded now');
  expect(s.posts.length).toBe(1);
  await shot(page, 'long-opaque-320');
});
test('native review and unknown recovery have no critical or serious accessibility violations', async ({ context, page }) => {
  await network(context, { 'affiliates.shareHits': (route) => fail(route) });
  await login(page);
  await review(page).click();
  const reviewed = await new AxeBuilder({ page }).analyze();
  expect(reviewed.violations.filter((row) => ['critical', 'serious'].includes(row.impact)).map((row) => row.id)).toEqual([]);
  await accept(page).click();
  await expect(original(page)).toBeVisible();
  const unknown = await new AxeBuilder({ page }).analyze();
  expect(unknown.violations.filter((row) => ['critical', 'serious'].includes(row.impact)).map((row) => row.id)).toEqual([]);
});

test('frozen native review expires on actual token refresh and requires a new review', async ({ context, page }) => {
  const s = await network(context, { refreshAfterMs: 2000 });
  await login(page);
  await review(page).click();
  await expect.poll(() => s.sequence).toBe(2);
  await expect(accept(page)).toHaveCount(0);
  await expect(review(page)).toBeEnabled();
  expect(s.posts).toEqual([]);
  expect(await journal(page)).toBe(null);
});
test('held current GET under token refresh hides the old private reply and retries in fresh context', async ({ context, page }) => {
  const gate = held();
  let first = true;
  const s = await network(context, {
    refreshAfterMs: 2000,
    'affiliates.myReferrer': async (route) => {
      if (first) {
        first = false;
        await gate.promise;
        return replyAfterDeparture(route, edge());
      }
      return reply(route, null);
    },
  });
  await login(page);
  await read(page).click();
  await expect.poll(() => s.reads.length).toBe(1);
  await expect.poll(() => s.sequence).toBe(2);
  gate.release();
  await expect(page.locator('.invitation__current')).not.toContainText(referrer);
  await expect(read(page)).toBeEnabled();
  await read(page).click();
  await expect(page.locator('.invitation__current')).toContainText('No referral is recorded now');
  expect(s.posts).toEqual([]);
});
test('HTTP401 after dispatch retains the original despite native session clearing and fresh login', async ({ context, page }) => {
  const s = await network(context, { 'affiliates.shareHits': (route) => fail(route, 401, 'Isolated principal expired', 'UNAUTHORIZED') });
  await login(page);
  await send(page);
  await expect(page.locator('.invitation').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  const bytes = await journal(page);
  expect(JSON.parse(bytes).length).toBe(1);
  await page.locator('.invitation').getByRole('link', { name: 'Sign in', exact: true }).click();
  await password(page);
  await expect(original(page)).toBeVisible();
  expect(await journal(page)).toBe(bytes);
  expect(s.posts.length).toBe(1);
});
test('silent browser save failure is verified before POST and refuses closed', async ({ context, page }) => {
  await context.addInitScript(() => {
    const previous = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('intafaced.customer.invitation.')) return;
      return previous.call(this, key, value);
    };
  });
  const s = await network(context);
  await login(page);
  await send(page);
  await expect(page.locator('.invitation')).toContainText('This browser cannot safely save or read the original reference.');
  expect(s.posts).toEqual([]);
  expect(await journal(page)).toBe(null);
});
test('corrupt JSON journal refuses before POST with useful current read', async ({ context, page }) => {
  await context.addInitScript((key) => localStorage.setItem(key, '{'), key);
  const s = await network(context);
  await login(page);
  await expect(review(page)).toBeDisabled();
  await read(page).click();
  await expect(page.locator('.invitation__current')).toContainText('No referral is recorded now');
  expect(s.posts).toEqual([]);
});
for (const outcome of ['false', 'refused'])
  test('known ' + outcome + ' reply stays known when local cleanup fails', async ({ context, page }) => {
    await context.addInitScript(() => {
      window.invitationCleanupDenied = true;
      const previous = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key) {
        if (key.startsWith('intafaced.customer.invitation.') && window.invitationCleanupDenied) throw new Error('Isolated cleanup denial');
        return previous.call(this, key);
      };
    });
    const s = await network(context, {
      'affiliates.shareHits': (route) =>
        outcome === 'false' ? reply(route, { hits: 17, attributed: false }) : fail(route, ...refusals[0]),
    });
    await login(page);
    await send(page);
    await expect(page.locator('.invitation')).toContainText('Local record still saved');
    await expect(original(page)).toHaveCount(0);
    await expect(page.locator('.invitation')).toContainText(
      outcome === 'false' ? 'The service reported no attribution' : 'before recording a visit',
    );
    await page.evaluate(() => {
      window.invitationCleanupDenied = false;
    });
    await page.getByRole('button', { name: 'Finish local record', exact: true }).click();
    await expect(page.locator('.invitation')).toContainText('This known local record is finished.');
    expect(await journal(page)).toBe(null);
    expect(s.posts.length).toBe(1);
  });
test('known local finish requires exact original fields and preserves a changed matching-reference record', async ({ context, page }) => {
  await context.addInitScript(() => {
    window.invitationCleanupDenied = true;
    const previous = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith('intafaced.customer.invitation.') && window.invitationCleanupDenied) throw new Error('Isolated cleanup denial');
      return previous.call(this, key);
    };
  });
  const s = await network(context);
  await login(page);
  await send(page);
  await expect(page.locator('.invitation')).toContainText('Local record still saved');
  await page.evaluate((key) => {
    const records = JSON.parse(localStorage.getItem(key));
    records[0].createdAt = '2026-10-08T22:41:00.000Z';
    localStorage.setItem(key, JSON.stringify(records));
    window.invitationCleanupDenied = false;
  }, key);
  const bytes = await journal(page);
  await page.getByRole('button', { name: 'Finish local record', exact: true }).click();
  await expect(page.locator('.invitation')).toContainText('This browser cannot safely save or read the original reference.');
  expect(await journal(page)).toBe(bytes);
  expect(s.posts.length).toBe(1);
});
for (const language of ['en', 'es', 'fr'])
  test('actual source-read preflight preserves opaque English language boundary: ' + language, async ({ context, page }) => {
    const s = await network(context, {
      'affiliates.myReferrer': (route) => fail(route, 500, 'Original English preflight failure', 'ISOLATED_PREFLIGHT'),
    });
    await login(page);
    const view = await setLocale(context, language);
    await page.locator('.invitation__card .button--primary').click();
    await page.locator('.invitation__card .button--primary').click();
    await expect(page.locator('.invitation .failure')).toContainText('Original English preflight failure');
    const inherited = await page.locator('.invitation .failure p').evaluate((node) => {
      for (let parent = node; parent; parent = parent.parentElement) if (parent.hasAttribute('lang')) return parent.getAttribute('lang');
      return '';
    });
    expect(inherited).toBe('und');
    expect(s.posts).toEqual([]);
    expect(await journal(page)).toBe(null);
    await view.close();
  });

test('audit invitation same-task query departure and return cannot revive an old review', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  await review(page).click();
  await page.evaluate((next) => {
    const before = location.href;
    history.pushState(null, '', '/invite?token=' + next);
    dispatchEvent(new PopStateEvent('popstate'));
    history.pushState(null, '', before);
    dispatchEvent(new PopStateEvent('popstate'));
  }, replacement);
  await page.waitForTimeout(150);
  const revived = await accept(page).count();
  if (revived) await accept(page).click();
  await page.waitForTimeout(150);
  writeFileSync(
    evidence + '/departure-review-observation.json',
    JSON.stringify({ revived, posts: s.posts.length, pageErrors: errors.get(context).length }),
  );
  expect(s.posts.length, 'departure invalidates old deliberate acceptance').toBe(0);
  expect(revived).toBe(0);
});
test('audit invitation held preflight same-task query departure and return cannot POST', async ({ context, page }) => {
  const gate = held();
  const s = await network(context, {
    'affiliates.myReferrer': async (route) => {
      await gate.promise;
      await replyAfterDeparture(route, null);
    },
  });
  await login(page);
  await send(page);
  await expect.poll(() => s.reads.length).toBe(1);
  await page.evaluate((next) => {
    const before = location.href;
    history.pushState(null, '', '/invite?token=' + next);
    dispatchEvent(new PopStateEvent('popstate'));
    history.pushState(null, '', before);
    dispatchEvent(new PopStateEvent('popstate'));
  }, replacement);
  gate.release();
  await page.waitForTimeout(200);
  writeFileSync(
    evidence + '/departure-preflight-observation.json',
    JSON.stringify({ posts: s.posts.length, pageErrors: errors.get(context).length }),
  );
  expect(s.posts.length, 'departed original preflight cannot dispatch').toBe(0);
});

async function batchedDeparture(page, buttonText, kind = 'query') {
  return page.evaluate(
    ({ buttonText, kind, replacement }) => {
      const before = location.href;
      const stale = [...document.querySelectorAll('.invitation button')].find((button) => button.textContent === buttonText);
      const next = kind === 'hash' ? before + '#departed' : '/invite?token=' + replacement;
      history.pushState(null, '', next);
      dispatchEvent(kind === 'hash' ? new HashChangeEvent('hashchange') : new PopStateEvent('popstate'));
      history.pushState(null, '', before);
      dispatchEvent(kind === 'hash' ? new HashChangeEvent('hashchange') : new PopStateEvent('popstate'));
      stale?.click();
      return Boolean(stale);
    },
    { buttonText, kind, replacement },
  );
}
for (const kind of ['query', 'hash'])
  test('synchronous departure rejects the stale native Accept handler before React repaint: ' + kind, async ({ context, page }) => {
    const s = await network(context);
    await login(page);
    await review(page).click();
    expect(await batchedDeparture(page, 'Accept this invitation', kind)).toBe(true);
    await expect(accept(page)).toHaveCount(0);
    expect(s.posts).toEqual([]);
    expect(s.reads).toEqual([]);
    expect(await journal(page)).toBe(null);
    await review(page).click();
    await accept(page).click();
    await expect(page.getByRole('heading', { name: 'Referral status recorded.', exact: true }).last()).toBeVisible();
    expect(s.posts.length).toBe(1);
    expect(s.posts[0].input.token === link).toBe(true);
  });
test('synchronous departure rejects a stale Review callback rather than creating a new private intent', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  expect(await batchedDeparture(page, 'Review invitation')).toBe(true);
  await expect(accept(page)).toHaveCount(0);
  expect(s.reads).toEqual([]);
  expect(s.posts).toEqual([]);
  await review(page).click();
  await expect(accept(page)).toBeVisible();
});
test('synchronous departure rejects the stale current-read callback even when the URL returns', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  expect(await batchedDeparture(page, 'Read current status')).toBe(true);
  await expect(read(page)).toBeEnabled();
  expect(s.reads).toEqual([]);
  expect(s.posts).toEqual([]);
  await read(page).click();
  await expect(page.locator('.invitation__current')).toContainText('No referral is recorded now');
  expect(s.reads.length).toBe(1);
});
test('same-URL popstate is not a departure and preserves the deliberate original review', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  await review(page).click();
  await page.evaluate(() => {
    history.replaceState(null, '', location.href);
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(accept(page)).toBeVisible();
  await accept(page).click();
  await expect(page.getByRole('heading', { name: 'Referral status recorded.', exact: true }).last()).toBeVisible();
  expect(s.posts.length).toBe(1);
});
test('held private current read is discarded across batched departure and a useful fresh read remains separate', async ({
  context,
  page,
}) => {
  const gate = held();
  let first = true;
  const s = await network(context, {
    'affiliates.myReferrer': async (route) => {
      if (first) {
        first = false;
        await gate.promise;
        return replyAfterDeparture(route, edge());
      }
      return reply(route, null);
    },
  });
  await login(page);
  await read(page).click();
  await expect.poll(() => s.reads.length).toBe(1);
  await batchedDeparture(page, 'Read current status');
  gate.release();
  await expect(page.locator('.invitation__current')).not.toContainText(referrer);
  await read(page).click();
  await expect(page.locator('.invitation__current')).toContainText('No referral is recorded now');
  expect(s.reads.length).toBe(2);
  expect(s.posts).toEqual([]);
  expect(await journal(page)).toBe(null);
});
test('dispatched original remains byte-identical unknown after ABA late known reply current read and new login', async ({
  context,
  page,
}) => {
  const gate = held();
  const s = await network(context, {
    'affiliates.shareHits': async (route) => {
      await gate.promise;
      return replyAfterDeparture(route, { hits: 8, attributed: true });
    },
  });
  await login(page);
  await send(page);
  await expect.poll(() => s.posts.length).toBe(1);
  const bytes = await journal(page);
  expect(Boolean(bytes)).toBe(true);
  await batchedDeparture(page, 'Read current status');
  gate.release();
  await expect(original(page)).toBeVisible();
  expect(await journal(page)).toBe(bytes);
  await expect(page.getByRole('heading', { name: 'Referral status recorded.', exact: true })).toHaveCount(0);
  s.current = edge();
  await read(page).click();
  await expect(page.locator('.invitation__current')).toContainText('A referral is recorded now');
  await expect(original(page)).toBeVisible();
  expect(await journal(page)).toBe(bytes);
  await login(page);
  await expect(original(page)).toBeVisible();
  expect(await journal(page)).toBe(bytes);
  expect(s.posts.length).toBe(1);
  await expect(review(page)).toHaveCount(0);
});
test('stale local-only Finish cannot erase a known cleanup-failed original after batched departure', async ({ context, page }) => {
  await context.addInitScript(() => {
    globalThis.invitationCleanupDenied = true;
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith('intafaced.customer.invitation.') && globalThis.invitationCleanupDenied) throw Error('Isolated cleanup denial');
      return remove.call(this, key);
    };
  });
  const s = await network(context);
  await login(page);
  await send(page);
  await expect(page.getByRole('button', { name: 'Finish local record', exact: true })).toBeVisible();
  const bytes = await journal(page);
  await page.evaluate(() => (globalThis.invitationCleanupDenied = false));
  expect(await batchedDeparture(page, 'Finish local record')).toBe(true);
  await expect(original(page)).toBeVisible();
  expect(await journal(page)).toBe(bytes);
  expect(s.posts.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Finish local record', exact: true })).toHaveCount(0);
});
