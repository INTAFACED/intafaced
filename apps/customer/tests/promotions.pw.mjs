import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const owner = '11111111-1111-4111-8111-111111111111',
  other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const a = '22222222-2222-4222-8222-222222222222',
  b = '33333333-3333-4333-8333-333333333333';
const stamp = '2026-10-09T12:00:00.000Z',
  key = 'intafaced.customer.promotions.v1:' + owner;
const evidence = process.env.PROMOTIONS_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const errors = new WeakMap(),
  summary = [];
test.beforeEach(async ({ context }) => {
  const list = [];
  errors.set(context, list);
  const watch = (page) => page.on('pageerror', (error) => list.push(error.name));
  context.pages().forEach(watch);
  context.on('page', watch);
});
test.afterEach(async ({ context }, info) => {
  expect(errors.get(context)).toEqual([]);
  summary.push({ name: info.title, status: info.status, pageErrors: errors.get(context) });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summary, null, 2)));
const link = (extra = {}) => ({ token: a, referrerId: owner, hits: 0, ...extra });
const reply = (route, data) => route.fulfill({ status: 200, json: { result: { data } } });
const fail = (route, status = 503, code = 'ISOLATED_UNCONFIRMED') =>
  route.fulfill({ status, json: { error: { message: 'Isolated response', data: { cause: { code } } } } });
function held() {
  let release;
  return {
    promise: new Promise((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
async function network(context, options = {}) {
  const state = { owner, sequence: 0, refreshes: 0, reads: [], writes: [], privateWrites: [], ...options },
    tokens = new Map();
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    if (procedure === 'auth.login' || procedure === 'auth.refresh') {
      if (procedure === 'auth.refresh') state.refreshes++;
      const token = 'isolated-promotions-' + ++state.sequence;
      tokens.set(token, state.owner);
      return reply(route, {
        userId: state.owner,
        accessToken: token,
        refreshToken: 'isolated-refresh-' + state.sequence,
        expiresAt: procedure === 'auth.login' ? (state.expiresAt ?? '2027-10-10T09:41:00.000Z') : '2027-10-10T09:41:00.000Z',
      });
    }
    if (procedure === 'auth.logout') return reply(route, { ok: true });
    const actor = tokens.get(request.headers().authorization?.replace('Bearer ', ''));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : request.postDataJSON();
    if (request.method() === 'GET') state.reads.push({ procedure, actor });
    else {
      state.writes.push({ procedure, actor });
      state.privateWrites.push({ procedure, input });
    }
    if (state[procedure]) return state[procedure](route, input, actor);
    if (procedure === 'affiliates.createShare') return reply(route, link({ referrerId: actor }));
    if (procedure === 'affiliates.revokeShare') return reply(route, { ...link({ referrerId: actor }), revokedAt: stamp });
    if (procedure === 'affiliates.myReferrer') return reply(route, null);
    if (procedure === 'affiliates.myAncestors') return reply(route, []);
    if (procedure === 'affiliates.myLapse')
      return reply(route, { state: 'none', periodSeconds: null, lastActivityAt: null, endsAt: null, ended: null });
    if (procedure === 'affiliates.myAccruals') return reply(route, { rows: [] });
    if (procedure === 'help.list' || procedure === 'notices.list') return reply(route, []);
    return fail(route);
  });
  return state;
}
async function login(page, path = '/uc/promotion') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new URL(path, test.info().project.use.baseURL).href);
}
async function signOut(page) {
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
}
const originals = (page) => page.getByRole('region', { name: 'Original link requests', exact: true });
const panel = (page) => page.getByRole('region', { name: 'Your invitation link', exact: true });
const count = (state, kind) => state.writes.filter((row) => row.procedure === 'affiliates.' + kind).length;
async function create(page) {
  await panel(page).getByRole('button', { name: 'Review link request', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Get or create link', exact: true }).click();
}
async function revoke(page) {
  await panel(page).getByRole('button', { name: 'Review revocation', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke current account link', exact: true }).click();
}
const journal = (page, k = key) => page.evaluate((name) => localStorage.getItem(name), k);
async function shot(page, name) {
  await page.screenshot({
    path: evidence + '/' + name + '.png',
    fullPage: true,
    mask: [page.locator('[data-private-capability],input[autocomplete="username"],input[autocomplete="current-password"]')],
  });
}
async function locale(context, value) {
  const view = await context.newPage();
  await login(view, '/view');
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption(value);
  return view;
}

test('ordinary guest has useful native sign in and no owner reads', async ({ context, page }) => {
  const state = await network(context);
  await page.goto('/uc/promotion');
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(state.reads).toEqual([]);
  expect(state.writes).toEqual([]);
});
test('review precedes current link mutation; exact wire and RAM-only private capability', async ({ context, page }) => {
  const state = await network(context);
  await login(page);
  await panel(page).getByRole('button', { name: 'Review link request', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('or creates one if none exists');
  await expect(page.getByRole('dialog')).toContainText('not a read-only refresh');
  expect(count(state, 'createShare')).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Get or create link', exact: true }).click();
  await expect(panel(page).getByRole('textbox')).toHaveValue(new URL('/invite?token=' + a, test.info().project.use.baseURL).href);
  expect(state.privateWrites.filter((row) => row.procedure === 'affiliates.createShare').map((row) => row.input)).toEqual([{}]);
  expect(await journal(page)).toBeNull();
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  expect(stored).not.toContain(a);
  expect(stored).not.toContain('isolated-promotions');
  await shot(page, 'current-link-desktop');
});
test('reviewed owner-current replacement is known; never certifies earlier snapshot or current-after status', async ({ context, page }) => {
  const state = await network(context, {
    'affiliates.revokeShare': (route) => reply(route, { ...link({ token: b, hits: 9 }), revokedAt: stamp }),
  });
  await login(page);
  await create(page);
  await panel(page).getByRole('button', { name: 'Review revocation', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('whichever link is current');
  await expect(page.getByRole('dialog')).toContainText('the replacement may be revoked');
  expect(count(state, 'revokeShare')).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke current account link', exact: true }).click();
  await expect(originals(page)).toContainText('A different link was returned');
  await expect(originals(page)).toContainText('does not confirm the earlier link');
  await expect(originals(page)).toContainText('does not establish which link is current now');
  expect(await journal(page)).toBeNull();
  expect(count(state, 'revokeShare')).toBe(1);
  expect(state.privateWrites.filter((row) => row.procedure === 'affiliates.revokeShare').map((row) => row.input)).toEqual([{}]);
  await expect(originals(page).getByRole('textbox', { name: 'Link shown in this tab', exact: true })).toHaveValue(
    new URL('/invite?token=' + a, test.info().project.use.baseURL).href,
  );
  await expect(originals(page).getByRole('textbox', { name: 'Link returned by the service', exact: true })).toHaveValue(
    new URL('/invite?token=' + b, test.info().project.use.baseURL).href,
  );
  await shot(page, 'known-replacement');
});
for (const [name, extra] of [
  ['wrong owner', { referrerId: other }],
  ['negative visits', { hits: -1 }],
  ['storage counter overflow', { hits: 2147483648 }],
  ['unsafe visits', { hits: Number.MAX_SAFE_INTEGER + 1 }],
  ['fractional visits', { hits: 0.5 }],
  ['malformed capability', { token: 'not-a-uuid' }],
])
  test('create ' + name + ' cannot become a usable link or clear original', async ({ context, page }) => {
    const state = await network(context, { 'affiliates.createShare': (route) => reply(route, link(extra)) });
    await login(page);
    await create(page);
    await expect(originals(page)).toContainText('Link request not confirmed');
    await expect(panel(page).getByRole('textbox')).toHaveCount(0);
    expect(JSON.parse(await journal(page))).toHaveLength(1);
    expect(count(state, 'createShare')).toBe(1);
  });
for (const [name, extra] of [
  ['wrong owner', { referrerId: other }],
  ['negative visits', { hits: -1 }],
  ['calendar rollover', { revokedAt: '2026-02-30T12:00:00Z' }],
  ['unreadable timestamp', { revokedAt: 'invalid' }],
])
  test('revoke ' + name + ' remains original unknown', async ({ context, page }) => {
    const state = await network(context, { 'affiliates.revokeShare': (route) => reply(route, { ...link(), revokedAt: stamp, ...extra }) });
    await login(page);
    await create(page);
    await revoke(page);
    await expect(originals(page)).toContainText('Link request not confirmed');
    expect(JSON.parse(await journal(page))[0].kind).toBe('revoke-current');
    expect(count(state, 'revokeShare')).toBe(1);
  });
for (const [kind, code, status] of [
  ['create', 'share.profile_gone', 404],
  ['create', 'share.invalid', 400],
  ['revoke', 'share.not_found', 404],
])
  test('original source-typed ' + code + ' is known pre-effect for its own kind', async ({ context, page }) => {
    const state = await network(context);
    await login(page);
    if (kind === 'revoke') await create(page);
    state['affiliates.' + (kind === 'create' ? 'createShare' : 'revokeShare')] = (route) => fail(route, status, code);
    await (kind === 'create' ? create(page) : revoke(page));
    await expect(originals(page)).toContainText('Request refused before effect');
    expect(await journal(page)).toBeNull();
  });
for (const [name, status, code] of [
  ['generic bad request', 400, 'BAD_REQUEST'],
  ['opaque permission refusal', 403, 'FORBIDDEN'],
  ['unclassified unauthorized', 401, 'UNAUTHORIZED'],
  ['wrong-kind profile code', 404, 'share.profile_gone'],
  ['post-effect server failure', 500, 'INTERNAL_SERVER_ERROR'],
])
  test('revoke ' + name + ' cannot certify original refusal', async ({ context, page }) => {
    const state = await network(context);
    await login(page);
    await create(page);
    state['affiliates.revokeShare'] = (route) => fail(route, status, code);
    await revoke(page);
    await expect.poll(() => journal(page)).not.toBeNull();
    if (status === 401) await login(page);
    await expect(originals(page)).toContainText('Link request not confirmed');
    expect(JSON.parse(await journal(page))).toHaveLength(1);
    expect(count(state, 'revokeShare')).toBe(1);
  });
test('lost create original survives Support/history and new/closed tab with only nonsecret fields', async ({ context, page }) => {
  const state = await network(context, { 'affiliates.createShare': (route) => fail(route) });
  await login(page);
  await create(page);
  await expect(originals(page)).toContainText('Link request not confirmed');
  const before = await journal(page),
    saved = JSON.parse(before)[0];
  expect(Object.keys(saved).sort()).toEqual(['createdAt', 'kind', 'owner', 'requestId']);
  await originals(page).getByRole('link', { name: 'Get account help →', exact: true }).click();
  await page.goBack();
  await expect(originals(page)).toContainText(saved.requestId);
  expect(await journal(page)).toBe(before);
  const next = await context.newPage();
  await login(next);
  await page.close();
  await expect(panel(next).getByRole('button', { name: 'Review link request', exact: true })).toBeDisabled();
  await next.locator('.referral-heading').getByRole('button').click();
  expect(await journal(next)).toBe(before);
  expect(count(state, 'createShare')).toBe(1);
  expect(count(state, 'shareHits')).toBe(0);
});
test('owner A unknown does not block B reviewed intent and cannot be released by new login', async ({ context, page }) => {
  const state = await network(context, {
    'affiliates.createShare': (route, input, actor) => (actor === owner ? fail(route) : reply(route, link({ referrerId: actor }))),
  });
  await login(page);
  await create(page);
  await expect(originals(page)).toContainText('Link request not confirmed');
  const before = await journal(page);
  await signOut(page);
  state.owner = other;
  await login(page);
  await create(page);
  await expect(panel(page).getByRole('textbox')).toBeVisible();
  expect(state.writes.filter((row) => row.procedure === 'affiliates.createShare' && row.actor === other)).toHaveLength(1);
  await signOut(page);
  state.owner = owner;
  await login(page);
  expect(await journal(page)).toBe(before);
  await expect(panel(page).getByRole('button', { name: 'Review link request', exact: true })).toBeDisabled();
  expect(count(state, 'createShare')).toBe(2);
});
for (const mode of ['denied', 'quota', 'corrupt', 'no-locks', 'held-lock'])
  test('predispatch ' + mode + ' refuses with zero mutation', async ({ context, page }) => {
    const state = await network(context);
    await login(page);
    if (mode === 'corrupt') {
      await page.evaluate((k) => localStorage.setItem(k, 'invalid'), key);
      await page.reload();
      await login(page);
    } else
      await page.evaluate(
        ({ k, mode }) => {
          if (mode === 'no-locks') Object.defineProperty(navigator, 'locks', { value: undefined });
          if (mode === 'held-lock') {
            let release;
            window.releasePromoLock = () => release();
            navigator.locks.request(
              'customer-promotions:' + k.split(':').at(-1),
              () =>
                new Promise((r) => {
                  release = r;
                }),
            );
          }
          if (mode === 'denied' || mode === 'quota') {
            const original = Storage.prototype[mode === 'denied' ? 'getItem' : 'setItem'];
            Storage.prototype[mode === 'denied' ? 'getItem' : 'setItem'] = function (name, ...args) {
              if (name === k) throw Error('Isolated storage refusal');
              return original.call(this, name, ...args);
            };
          }
        },
        { k: key, mode },
      );
    if (mode === 'corrupt') await expect(panel(page).getByRole('button')).toBeDisabled();
    else {
      await panel(page).getByRole('button', { name: 'Review link request', exact: true }).click();
      if (mode !== 'denied') await page.getByRole('dialog').getByRole('button', { name: 'Get or create link', exact: true }).click();
    }
    await expect(page.locator('.notice')).toBeVisible();
    expect(count(state, 'createShare')).toBe(0);
    expect(count(state, 'revokeShare')).toBe(0);
    if (mode === 'held-lock') await page.evaluate(() => window.releasePromoLock());
  });
test('known cleanup failure removes only exact matching local record without API replay', async ({ context, page }) => {
  const state = await network(context);
  await login(page);
  await page.evaluate((k) => {
    const fn = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name) {
      if (name === k) throw Error('Isolated cleanup refusal');
      return fn.call(this, name);
    };
    window.restorePromoStorage = () => {
      Storage.prototype.removeItem = fn;
    };
  }, key);
  await create(page);
  await expect(originals(page)).toContainText('Local record still saved');
  const independent = { owner, kind: 'revoke-current', requestId: b, createdAt: stamp };
  await page.evaluate(
    ({ k, independent }) => {
      const entries = JSON.parse(localStorage.getItem(k));
      localStorage.setItem(k, JSON.stringify([...entries, independent]));
      window.dispatchEvent(new StorageEvent('storage', { key: k }));
      window.restorePromoStorage();
    },
    { k: key, independent },
  );
  await originals(page).getByRole('button', { name: 'Finish matching local record', exact: true }).click();
  await expect(originals(page)).toContainText('without calling the service');
  expect(JSON.parse(await journal(page))).toEqual([independent]);
  expect(count(state, 'createShare')).toBe(1);
});
test('remounted known cleanup failure has only durable unknown and no finish/replay', async ({ context, page }) => {
  const state = await network(context);
  await login(page);
  await page.evaluate((k) => {
    const fn = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name) {
      if (name === k) throw Error('Isolated cleanup refusal');
      return fn.call(this, name);
    };
  }, key);
  await create(page);
  await expect(originals(page)).toContainText('Local record still saved');
  const before = await journal(page);
  await page.getByRole('link', { name: 'Open Account →', exact: true }).click();
  await expect(page).toHaveURL(new URL('/uc/account', test.info().project.use.baseURL).href);
  await page.goBack();
  await expect(originals(page)).toContainText('Link request not confirmed');
  await expect(originals(page).getByRole('button', { name: 'Finish matching local record', exact: true })).toHaveCount(0);
  expect(await journal(page)).toBe(before);
  expect(count(state, 'createShare')).toBe(1);
});
test('real SessionProvider refresh cancels original review before any POST', async ({ context, page }) => {
  const state = await network(context, { expiresAt: new Date(Date.now() + 33000).toISOString() });
  await login(page);
  await panel(page).getByRole('button', { name: 'Review link request', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(() => state.refreshes).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(count(state, 'createShare')).toBe(0);
  expect(await journal(page)).toBeNull();
});
test('refresh during held successful POST preserves original unknown and hides late capability', async ({ context, page }) => {
  const hold = held(),
    state = await network(context, {
      expiresAt: new Date(Date.now() + 33000).toISOString(),
      'affiliates.createShare': async (route) => {
        await hold.promise;
        return reply(route, link());
      },
    });
  await login(page);
  await create(page);
  await expect.poll(() => count(state, 'createShare')).toBe(1);
  const before = await journal(page);
  await expect.poll(() => state.refreshes).toBe(1);
  hold.release();
  await expect(originals(page)).toContainText('Link request not confirmed');
  await expect(panel(page).getByRole('textbox')).toHaveCount(0);
  expect(await journal(page)).toBe(before);
});
test('late response after Support departure and new actor cannot expose a capability', async ({ context, page }) => {
  const hold = held(),
    state = await network(context, {
      'affiliates.createShare': async (route, input, actor) => {
        await hold.promise;
        return reply(route, link({ referrerId: actor }));
      },
    });
  await login(page);
  await create(page);
  await expect.poll(() => count(state, 'createShare')).toBe(1);
  const before = await journal(page);
  await originals(page).getByRole('link', { name: 'Get account help →', exact: true }).click();
  await signOut(page);
  state.owner = other;
  await login(page);
  hold.release();
  await expect(panel(page).getByRole('textbox')).toHaveCount(0);
  expect(await journal(page)).toBe(before);
  expect(count(state, 'createShare')).toBe(1);
});
test('same-owner second tab cannot dispatch after first unknown', async ({ context, page }) => {
  const state = await network(context, { 'affiliates.createShare': (route) => fail(route) });
  await login(page);
  const next = await context.newPage();
  await login(next);
  await panel(next).getByRole('button', { name: 'Review link request', exact: true }).click();
  await create(page);
  await expect(originals(page)).toContainText('Link request not confirmed');
  await next.getByRole('dialog').getByRole('button', { name: 'Get or create link', exact: true }).click();
  expect(count(state, 'createShare')).toBe(1);
});
test('held clipboard completion after native owner change cannot show old success', async ({ context, page }) => {
  const state = await network(context);
  await login(page);
  await create(page);
  const clipboard = held();
  await context.exposeBinding('heldPromoClipboard', () => clipboard.promise);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => window.heldPromoClipboard() } });
  });
  await panel(page).getByRole('button', { name: 'Copy link', exact: true }).click();
  await signOut(page);
  state.owner = other;
  await login(page);
  clipboard.release();
  await expect(panel(page)).not.toContainText('Invitation link copied.');
  await expect(panel(page).getByRole('textbox')).toHaveCount(0);
});
async function departAndReturn(page, batched = false) {
  const original = await page.evaluate(() => location.pathname + location.search);
  await page.evaluate(
    ({ original, batched }) => {
      history.pushState(null, '', original + (original.includes('?') ? '&' : '?') + 'promo-context=departure');
      window.dispatchEvent(new PopStateEvent('popstate'));
      if (batched) {
        history.pushState(null, '', original);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    },
    { original, batched },
  );
  if (!batched) await page.goBack();
  await expect(page).toHaveURL(new URL(original, test.info().project.use.baseURL).href);
}
for (const batched of [false, true])
  test(
    'query departure and return ' +
      (batched ? 'in one browser task' : 'through native browserBack') +
      ' permanently cancels original review',
    async ({ context, page }) => {
      const state = await network(context);
      await login(page);
      await panel(page).getByRole('button', { name: 'Review link request', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await departAndReturn(page, batched);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(count(state, 'createShare')).toBe(0);
      expect(await journal(page)).toBeNull();
      await create(page);
      await expect(panel(page).getByRole('textbox')).toBeVisible();
      expect(count(state, 'createShare')).toBe(1);
    },
  );
for (const action of ['Review revocation', 'Copy link'])
  test('retained ' + action + ' DOM callback cannot recapture a departed private snapshot before redraw', async ({ context, page }) => {
    const state = await network(context);
    let copies = 0;
    await context.exposeBinding('countPromoRetainedCopy', () => {
      copies++;
    });
    await login(page);
    await create(page);
    await expect(panel(page).getByRole('textbox')).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => window.countPromoRetainedCopy() } });
    });
    await page.evaluate((action) => {
      const stale = [...document.querySelectorAll('.promotions__link button')].find((node) => node.textContent === action);
      const original = location.pathname + location.search;
      history.pushState(null, '', original + '?promo-context=departed');
      window.dispatchEvent(new PopStateEvent('popstate'));
      history.pushState(null, '', original);
      window.dispatchEvent(new PopStateEvent('popstate'));
      stale.click();
    }, action);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-private-capability]')).toHaveCount(0);
    await expect(panel(page)).not.toContainText('Invitation link copied.');
    expect(copies).toBe(0);
    expect(count(state, 'revokeShare')).toBe(0);
    expect(count(state, 'createShare')).toBe(1);
    expect(await journal(page)).toBeNull();
    await create(page);
    await expect(panel(page).getByRole('textbox')).toBeVisible();
    expect(count(state, 'createShare')).toBe(2);
    await panel(page).getByRole('button', { name: 'Review revocation', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('textbox')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('whichever link is current');
    expect(count(state, 'revokeShare')).toBe(0);
  });

test('known private capability is erased on query departure and never revives on return', async ({ context, page }) => {
  const state = await network(context);
  await login(page);
  await create(page);
  await expect(panel(page).getByRole('textbox')).toBeVisible();
  await departAndReturn(page);
  await expect(page.locator('[data-private-capability]')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Review link request', exact: true })).toBeEnabled();
  expect(await journal(page)).toBeNull();
  expect(count(state, 'createShare')).toBe(1);
});
for (const kind of ['createShare', 'revokeShare'])
  test('held ' + kind + ' reply cannot revive after query departure and return or clear its original', async ({ context, page }) => {
    const hold = held();
    const state = await network(context, {
      ['affiliates.' + kind]: async (route) => {
        await hold.promise;
        return reply(route, kind === 'createShare' ? link() : { ...link({ token: b }), revokedAt: stamp });
      },
    });
    await login(page);
    if (kind === 'revokeShare') {
      await create(page);
      await expect(panel(page).getByRole('textbox')).toBeVisible();
      await revoke(page);
    } else await create(page);
    await expect.poll(() => count(state, kind)).toBe(1);
    const before = await journal(page);
    await departAndReturn(page, true);
    hold.release();
    await expect(originals(page)).toContainText('Link request not confirmed');
    await expect(page.locator('[data-private-capability]')).toHaveCount(0);
    await expect(originals(page).getByRole('button', { name: 'Finish matching local record', exact: true })).toHaveCount(0);
    expect(await journal(page)).toBe(before);
    await expect(panel(page).getByRole('button', { name: 'Review link request', exact: true })).toBeDisabled();
    await page.locator('.referral-heading button').click();
    await expect(page.locator('#promotion-referrals')).toContainText('No referrer returned');
    await originals(page).getByRole('link', { name: 'Get account help →', exact: true }).click();
    await expect(page).toHaveURL(new URL('/support', test.info().project.use.baseURL).href);
    await page.goBack();
    await expect(originals(page)).toContainText('Link request not confirmed');
    expect(await journal(page)).toBe(before);
    expect(count(state, kind)).toBe(1);
  });
test('late clipboard completion is not revived by query departure and return', async ({ context, page }) => {
  const state = await network(context),
    clipboard = held();
  await context.exposeBinding('heldPromoRouteClipboard', () => clipboard.promise);
  await login(page);
  await create(page);
  await expect(panel(page).getByRole('textbox')).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => window.heldPromoRouteClipboard() } });
  });
  await panel(page).getByRole('button', { name: 'Copy link', exact: true }).click();
  await departAndReturn(page, true);
  clipboard.release();
  await expect(panel(page)).not.toContainText('Invitation link copied.');
  await expect(page.locator('[data-private-capability]')).toHaveCount(0);
  expect(await journal(page)).toBeNull();
  expect(count(state, 'createShare')).toBe(1);
});
test('query departure removes private known cleanup receipt and keeps original unknown across return', async ({ context, page }) => {
  const state = await network(context);
  await login(page);
  await page.evaluate((k) => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name) {
      if (name === k) throw Error('Isolated cleanup refusal');
      return original.call(this, name);
    };
  }, key);
  await create(page);
  await expect(originals(page)).toContainText('Local record still saved');
  const before = await journal(page);
  await departAndReturn(page, true);
  await expect(originals(page)).toContainText('Link request not confirmed');
  await expect(originals(page).getByRole('button', { name: 'Finish matching local record', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-private-capability]')).toHaveCount(0);
  expect(await journal(page)).toBe(before);
  expect(count(state, 'createShare')).toBe(1);
});
test('query round trip invalidates held lock admission before any original marker or POST', async ({ context, page }) => {
  const state = await network(context),
    admission = held();
  await context.exposeBinding('heldPromoRouteAdmission', () => admission.promise);
  await login(page);
  await page.evaluate(() => {
    const actual = navigator.locks.request.bind(navigator.locks);
    navigator.locks.request = async (...args) => {
      await window.heldPromoRouteAdmission();
      return actual(...args);
    };
  });
  await create(page);
  await departAndReturn(page, true);
  admission.release();
  await expect(panel(page).getByRole('button', { name: 'Review link request', exact: true })).toBeEnabled();
  expect(count(state, 'createShare')).toBe(0);
  expect(await journal(page)).toBeNull();
  await create(page);
  await expect(panel(page).getByRole('textbox')).toBeVisible();
  expect(count(state, 'createShare')).toBe(1);
});

test('known link readiness is announced without its capability and continues native keyboard focus', async ({ context, page }) => {
  await network(context);
  await login(page);
  const start = panel(page).getByRole('button', { name: 'Review link request', exact: true });
  await start.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: 'Get or create link', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('response snapshot');
  await expect(panel(page).getByRole('status')).not.toContainText(a);
  await expect(panel(page).getByRole('heading', { name: 'Your invitation link', exact: true })).toBeFocused();
});
test('held known link readiness does not steal focus from a deliberately moved control', async ({ context, page }) => {
  const hold = held();
  await network(context, {
    'affiliates.createShare': async (route) => {
      await hold.promise;
      return reply(route, link());
    },
  });
  await login(page);
  await create(page);
  const refresh = page.locator('.referral-heading button');
  await refresh.focus();
  hold.release();
  await expect(panel(page).getByRole('textbox')).toBeVisible();
  await expect(refresh).toBeFocused();
});
test('native View changes review language without changing original owner or empty request', async ({ context, page }) => {
  const state = await network(context);
  await login(page);
  await panel(page).getByRole('button', { name: 'Review link request', exact: true }).click();
  await locale(context, 'fr');
  await expect(page.getByRole('dialog')).toContainText('Compte personnel');
  await page.getByRole('dialog').getByRole('button', { name: 'Obtenir ou créer un lien', exact: true }).click();
  const region = page.getByRole('region', { name: 'Votre lien d’invitation', exact: true });
  await expect(region.getByRole('textbox')).toBeVisible();
  await expect(region.getByRole('status')).toContainText('instantané de la réponse');
  expect(state.privateWrites.filter((row) => row.procedure === 'affiliates.createShare').map((row) => row.input)).toEqual([{}]);
  expect(state.writes.filter((row) => row.procedure === 'affiliates.createShare').map((row) => row.actor)).toEqual([owner]);
  expect(await journal(page)).toBeNull();
});
for (const visits of [0, 2147483647])
  test('published integer visits ' + visits + ' remains an exact nonfinancial counter', async ({ context, page }) => {
    await network(context, { 'affiliates.createShare': (route) => reply(route, link({ hits: visits })) });
    await login(page);
    await create(page);
    await expect(panel(page).locator('.promotions__visits strong')).toHaveText(String(visits));
    await expect(page.locator('#main')).toContainText('not sign-ups');
    expect(await journal(page)).toBeNull();
  });
for (const copied of [true, false])
  test(
    'explicit clipboard ' + (copied ? 'completion' : 'refusal') + ' preserves original link and no extra mutation',
    async ({ context, page }) => {
      const state = await network(context);
      await login(page);
      await create(page);
      await page.evaluate((success) => {
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: () => (success ? Promise.resolve() : Promise.reject(Error('Isolated copy refusal'))) },
        });
      }, copied);
      await panel(page).getByRole('button', { name: 'Copy link', exact: true }).click();
      await expect(panel(page)).toContainText(copied ? 'Invitation link copied.' : 'Copy is unavailable. Select the link above.');
      await expect(panel(page).getByRole('textbox')).toBeVisible();
      expect(count(state, 'createShare')).toBe(1);
      expect(count(state, 'revokeShare')).toBe(0);
    },
  );

test('failed referral read remains independently retryable and never calls shareHits or releases unknown', async ({ context, page }) => {
  const state = await network(context, {
    'affiliates.createShare': (route) => fail(route),
    'affiliates.myReferrer': (route) => fail(route),
  });
  await login(page);
  await create(page);
  await expect(originals(page)).toContainText('Link request not confirmed');
  const before = await journal(page);
  delete state['affiliates.myReferrer'];
  await page.locator('#promotion-referrals').getByRole('button', { name: 'Try again', exact: true }).click();
  expect(await journal(page)).toBe(before);
  expect(count(state, 'createShare')).toBe(1);
  expect(count(state, 'shareHits')).toBe(0);
});
for (const language of ['en', 'es', 'fr'])
  for (const width of [320, 390, 768, 1440])
    test(`native ${language} ${width} review focus touch fit and locale context`, async ({ context, page }) => {
      const state = await network(context);
      if (language !== 'en') await locale(context, language);
      await page.setViewportSize({ width, height: 900 });
      await login(page);
      const button = page.locator('.promotions__link .button');
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(count(state, 'createShare')).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const result = await new AxeBuilder({ page }).include('.promotions').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(result.violations).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(button).toBeFocused();
      await shot(page, `native-${language}-${width}`);
      if (width === 390) {
        await button.click();
        await shot(page, `review-${language}-${width}`);
      }
    });
