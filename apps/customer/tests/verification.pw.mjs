import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const owner = '11111111-1111-4111-8111-111111111111',
  other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const a = '22222222-2222-4222-8222-222222222222',
  b = '33333333-3333-4333-8333-333333333333';
const stamp = '2026-10-09T12:00:00.000Z',
  key = 'intafaced.customer.verification.v1:' + owner;
const evidence = process.env.VERIFICATION_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const errors = new WeakMap(),
  summary = [];
test.beforeEach(async ({ context }) => {
  const list = [];
  errors.set(context, list);
  const watch = (p) => p.on('pageerror', (e) => list.push(e.message));
  context.pages().forEach(watch);
  context.on('page', watch);
});
test.afterEach(async ({ context }, info) => {
  expect(errors.get(context)).toEqual([]);
  summary.push({ name: info.title, status: info.status, pageErrors: errors.get(context) });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summary, null, 2)));
const row = (extra = {}) => ({
  id: a,
  userId: owner,
  tier: 'full',
  jurisdiction: 'US',
  status: 'pending',
  reviewedAt: null,
  expiresAt: null,
  createdAt: stamp,
  ...extra,
});
const reply = (r, data) => r.fulfill({ status: 200, json: { result: { data } } });
// The ladder below the records (I-kyc-compliance-04/05): nothing published, every feature open from basic.
const LEVELS = ['none', 'basic', 'full', 'institutional'];
const ladder = (held) => ({
  held,
  region: 'DE',
  regionResolved: true,
  levels: LEVELS.map((level) => ({
    level,
    current: level === held,
    features: ['deposit', 'withdraw', 'trade', 'card', 'earn', 'rewards'].map((feature) =>
      level === 'none'
        ? { feature, state: 'needs_level', level: 'basic', perOffer: false }
        : { feature, state: 'allowed', perOffer: false },
    ),
    requirements: { published: false },
    reviewHours: null,
  })),
});
const fail = (r, status = 503, code = 'ISOLATED_REFUSAL') =>
  r.fulfill({ status, json: { error: { message: 'Isolated response lost', data: { cause: { code } } } } });
function held() {
  let release;
  return {
    promise: new Promise((r) => {
      release = r;
    }),
    release: () => release(),
  };
}
async function network(context, options = {}) {
  const state = {
    owner,
    rows: [row(), row({ id: b, tier: 'basic', status: 'approved', reviewedAt: stamp, createdAt: '2026-10-08T12:00:00.000Z' })],
    tier: 'basic',
    reads: [],
    writes: [],
    privateWrites: [],
    sequence: 0,
    refreshes: 0,
    ...options,
  };
  const tokens = new Map();
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : request.postDataJSON();
    if (procedure === 'auth.login' || procedure === 'auth.refresh') {
      if (procedure === 'auth.refresh') state.refreshes++;
      const token = 'isolated-verification-' + ++state.sequence;
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
    if (request.method() === 'GET') state.reads.push({ procedure, actor, ...(procedure === 'kyc.status' ? { limit: input.limit } : {}) });
    else {
      state.writes.push({ procedure, actor });
      state.privateWrites.push({ procedure, input });
    }
    if (state[procedure]) return state[procedure](route, input, actor);
    if (procedure === 'kyc.status')
      return reply(route, { tier: state.tier, records: state.rows.filter((r) => r.userId === actor).slice(0, input.limit) });
    if (procedure === 'kyc.submit') return reply(route, row({ userId: actor, tier: input.tier, jurisdiction: input.jurisdiction }));
    if (procedure === 'kyc.levels.describe') return reply(route, ladder(state.tier));
    if (procedure === 'help.list' || procedure === 'notices.list') return reply(route, []);
    return fail(route);
  });
  return state;
}
async function login(page, path = '/verification') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(new URL(path, test.info().project.use.baseURL).href);
}
async function signOut(page) {
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
}
async function nativeReturn(page) {
  await page.goBack();
  await expect(page).toHaveURL(/\/verification$/);
}
const records = (page) => page.getByRole('region', { name: 'Your requests', exact: true });
const originals = (page) => page.getByRole('region', { name: 'Original verification requests', exact: true });
const count = (s) => s.writes.filter((w) => w.procedure === 'kyc.submit').length;
async function review(page, tier = 'full', country = 'de') {
  await page.getByRole('combobox', { name: 'Level to request', exact: true }).selectOption(tier);
  await page.getByRole('textbox', { name: 'Country code', exact: true }).fill(country);
  await page.locator('form').getByRole('button', { name: 'Review request', exact: true }).click();
}
async function submit(page, tier, country) {
  await review(page, tier, country);
  await page.getByRole('dialog').getByRole('button', { name: 'Submit this request', exact: true }).click();
}
async function journal(page, storageKey = key) {
  return page.evaluate((k) => localStorage.getItem(k), storageKey);
}
async function shot(page, name) {
  await page.screenshot({
    path: evidence + '/' + name + '.png',
    fullPage: true,
    mask: [page.locator('input[autocomplete="username"],input[autocomplete="current-password"]')],
  });
}
async function changeLocale(context, language) {
  const view = await context.newPage();
  await login(view, '/view');
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption(language);
  return view;
}

test('guest has useful sign-in without private reads', async ({ context, page }) => {
  const s = await network(context);
  await page.goto('/verification');
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(s.reads).toEqual([]);
  expect(count(s)).toBe(0);
});
test('exact source-qualified missing-owner404 is known before insertion; localized message is not raw-service matched', async ({
  context,
  page,
}) => {
  const s = await network(context, {
    'kyc.submit': (r) => r.fulfill({ status: 404, json: { error: { message: 'Not found', data: { cause: { code: 'auth.not_found' } } } } }),
  });
  await login(page);
  await submit(page);
  await expect(originals(page)).toContainText('Submission refused before insertion');
  expect(await journal(page)).toBeNull();
  expect(count(s)).toBe(1);
});
for (const status of [400, 403, 404, 500])
  test(`unqualified ${status} retains original unknown`, async ({ context, page }) => {
    const s = await network(context, { 'kyc.submit': (r) => fail(r, status) });
    await login(page);
    await submit(page);
    await expect(originals(page)).toContainText('Original result unknown');
    expect(JSON.parse(await journal(page))).toHaveLength(1);
    expect(count(s)).toBe(1);
  });
test('owned bounded current records and exact selected dates, no full history claim', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  await expect(records(page)).toContainText(a);
  await expect(records(page)).toContainText(b);
  await page.getByRole('button', { name: 'Inspect record ' + a, exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected record', exact: true })).toContainText(a);
  await expect(page.getByRole('region', { name: 'Selected record', exact: true })).toContainText('None recorded');
  expect(s.reads.filter((r) => r.procedure === 'kyc.status')).toEqual([{ procedure: 'kyc.status', actor: owner, limit: 50 }]);
  await expect(page.getByRole('button', { name: 'Load up to 100 records', exact: true })).toHaveCount(0);
  await shot(page, 'desktop-current-records');
});
test('50 full rows increment 100/150/200 and narrow form/selected record remain reachable', async ({ context, page }) => {
  const rows = Array.from({ length: 200 }, (_, i) =>
    row({
      id: `${String(i + 10000000).padStart(8, '0')}-2222-4222-8222-222222222222`,
      createdAt: new Date(Date.parse(stamp) - i * 1000).toISOString(),
    }),
  );
  const s = await network(context, { rows });
  await page.setViewportSize({ width: 320, height: 760 });
  await login(page);
  // The request form sits directly under the level, so there is no jump button; it is reachable as it is.
  await expect(page.getByRole('textbox', { name: 'Country code', exact: true })).toBeVisible();
  for (const limit of [100, 150, 200]) {
    await page.getByRole('button', { name: `Load up to ${limit} records`, exact: true }).click();
    await expect(records(page).locator('li')).toHaveCount(limit);
  }
  await expect(records(page)).toContainText('not your complete history');
  await page.getByRole('button', { name: 'Inspect record ' + rows[199].id, exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected record', exact: true })).toContainText(rows[199].id);
  expect(s.reads.filter((r) => r.procedure === 'kyc.status').map((r) => r.limit)).toEqual([50, 100, 150, 200]);
  expect(count(s)).toBe(0);
});
for (const [name, corrupt] of [
  ['wrong owner', (rows) => [row({ userId: other })]],
  ['duplicate IDs', (rows) => [row(), row()]],
  ['invalid calendar', (rows) => [row({ createdAt: '2026-02-30T12:00:00.000Z' })]],
  ['not newest first', (rows) => rows.toReversed()],
  ['invalid review date', (rows) => [row({ reviewedAt: '2026-02-30T12:00:00.000Z' })]],
  ['invalid expiry', (rows) => [row({ expiresAt: 'bad' })]],
])
  test('read refuses ' + name + ' and hides private rows', async ({ context, page }) => {
    const s = await network(context);
    s['kyc.status'] = (r) => reply(r, { tier: 'basic', records: corrupt(s.rows) });
    await login(page);
    await expect(page.getByTestId('failure')).toBeVisible();
    await expect(records(page)).not.toContainText(a);
    expect(count(s)).toBe(0);
  });
test('failed GET hides selection, retry is read only, and independent request remains useful', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  await page.getByRole('button', { name: 'Inspect record ' + a, exact: true }).click();
  s['kyc.status'] = (r) => fail(r);
  await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
  await expect(page.getByTestId('failure')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected record', exact: true })).toHaveCount(0);
  await review(page);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click();
  delete s['kyc.status'];
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(records(page)).toContainText(a);
  await expect(page.getByRole('region', { name: 'Selected record', exact: true })).toContainText(a);
  expect(count(s)).toBe(0);
});
for (const status of ['approved', 'pending'])
  test('legitimate existing ' + status + ' different-country reply is known with actual record', async ({ context, page }) => {
    const s = await network(context, {
      'kyc.submit': (r) =>
        reply(
          r,
          row({
            id: b,
            status,
            tier: 'full',
            jurisdiction: 'US',
            reviewedAt: status === 'approved' ? stamp : null,
            createdAt: '2026-10-08T12:00:00.000Z',
          }),
        ),
    });
    await login(page);
    await submit(page, status === 'approved' ? 'basic' : 'full', 'DE');
    await expect(originals(page)).toContainText('A record was returned.');
    await expect(originals(page)).toContainText(b);
    await expect(originals(page)).toContainText('US');
    await expect(originals(page)).toContainText('DE');
    await expect(originals(page)).toContainText('does not say a new record was created');
    expect(count(s)).toBe(1);
    expect(await journal(page)).toBeNull();
    await shot(page, 'known-existing-' + status);
  });
for (const [name, extra] of [
  ['wrong owner', { userId: other }],
  ['pending wrong tier', { tier: 'basic' }],
  ['rejected', { status: 'rejected' }],
  ['expired', { status: 'expired' }],
  ['approved below requested', { tier: 'basic', status: 'approved' }],
  ['lapsed approval', { status: 'approved', expiresAt: '2020-01-01T00:00:00.000Z' }],
  ['malformed date', { createdAt: '2026-02-30T12:00:00.000Z' }],
])
  test('submit ' + name + ' reply stays original unknown', async ({ context, page }) => {
    const s = await network(context, { 'kyc.submit': (r) => reply(r, row(extra)) });
    await login(page);
    await submit(page);
    await expect(originals(page)).toContainText('Original result unknown');
    await expect(originals(page)).not.toContainText('A record was returned.');
    expect(JSON.parse(await journal(page))).toHaveLength(1);
    expect(count(s)).toBe(1);
  });
test('unknown A → native Help/return → B exactly one reviewed POST → A original bytes unchanged', async ({ context, page }) => {
  const s = await network(context, {
    'kyc.submit': (r, input, actor) =>
      actor === owner ? fail(r) : reply(r, row({ userId: actor, tier: input.tier, jurisdiction: input.jurisdiction })),
  });
  await login(page);
  await submit(page);
  await expect(originals(page)).toContainText('Original result unknown');
  const original = await journal(page);
  const saved = JSON.parse(original);
  expect(Object.keys(saved[0]).sort()).toEqual(['createdAt', 'kind', 'owner', 'requestId']);
  await page.getByRole('link', { name: 'Verification help →', exact: true }).click();
  await nativeReturn(page);
  await expect(originals(page)).toContainText(saved[0].requestId);
  await expect(page.locator('form button[type="submit"]')).toBeDisabled();
  await page.getByRole('link', { name: 'Get support →', exact: true }).click();
  await nativeReturn(page);
  expect(await journal(page)).toBe(original);
  await signOut(page);
  s.owner = other;
  await login(page);
  await submit(page, 'basic', 'FR');
  await expect(originals(page)).toContainText('A record was returned.');
  expect(s.writes.filter((w) => w.procedure === 'kyc.submit' && w.actor === other)).toHaveLength(1);
  await signOut(page);
  s.owner = owner;
  await login(page);
  expect(await journal(page)).toBe(original);
  await expect(page.locator('form button[type="submit"]')).toBeDisabled();
  expect(count(s)).toBe(2);
  await shot(page, 'unknown-original-returned');
});
test('new and closed tabs retain unknown owner guard; useful reads never release it', async ({ context, page }) => {
  const s = await network(context, { 'kyc.submit': (r) => fail(r) });
  await login(page);
  await submit(page);
  await expect(originals(page)).toContainText('Original result unknown');
  const before = await journal(page);
  const next = await context.newPage();
  await login(next);
  await expect(next.locator('form button[type="submit"]')).toBeDisabled();
  await page.close();
  await next.getByRole('button', { name: 'Read current records', exact: true }).click();
  expect(await journal(next)).toBe(before);
  expect(count(s)).toBe(1);
});
test('known cleanup failure stays known; exact local finalization sends no POST', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  await page.evaluate((k) => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key === k) throw new DOMException('Isolated quota', 'QuotaExceededError');
      return remove.call(this, key);
    };
    window.restoreVerificationStorage = () => {
      Storage.prototype.removeItem = remove;
    };
  }, key);
  await submit(page);
  await expect(originals(page)).toContainText('Local record still saved');
  await expect(originals(page)).toContainText('A record was returned.');
  await expect(originals(page)).not.toContainText('Original result unknown');
  const original = await journal(page);
  await page.evaluate(() => window.restoreVerificationStorage());
  await page.getByRole('button', { name: 'Finish local record', exact: true }).click();
  await expect(originals(page)).toContainText('service was not called again');
  expect(await journal(page)).toBeNull();
  expect(count(s)).toBe(1);
  expect(JSON.parse(original)).toHaveLength(1);
});
test('remount after known cleanup failure knows only durable unknown; cannot finalize', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  await page.evaluate((k) => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key === k) throw Error('Isolated denied');
      return remove.call(this, key);
    };
  }, key);
  await submit(page);
  await expect(originals(page)).toContainText('Local record still saved');
  await page.getByRole('link', { name: 'Verification help →', exact: true }).click();
  await nativeReturn(page);
  await expect(originals(page)).toContainText('Original result unknown');
  await expect(page.getByRole('button', { name: 'Finish local record', exact: true })).toHaveCount(0);
  expect(count(s)).toBe(1);
});
for (const mode of ['quota', 'denied', 'corrupt', 'no locks', 'lock busy'])
  test('predispatch ' + mode + ' refuses without memory-only persistence', async ({ context, page }) => {
    const s = await network(context);
    await login(page);
    if (mode === 'corrupt') await page.evaluate((k) => localStorage.setItem(k, '{bad'), key);
    if (mode === 'quota' || mode === 'denied')
      await page.evaluate(
        ({ k, mode }) => {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (key === k) throw new DOMException('Isolated refusal', mode === 'quota' ? 'QuotaExceededError' : 'SecurityError');
            return original.call(this, key, value);
          };
        },
        { k: key, mode },
      );
    if (mode === 'no locks') await page.evaluate(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }));
    if (mode === 'lock busy')
      await page.evaluate(() => {
        window.verificationLockStarted = false;
        navigator.locks.request(
          'customer-verification:11111111-1111-4111-8111-111111111111',
          () =>
            new Promise((r) => {
              window.verificationLockStarted = true;
              window.releaseVerificationLock = r;
            }),
        );
      });
    await review(page);
    if (mode !== 'corrupt') await page.getByRole('dialog').getByRole('button', { name: 'Submit this request', exact: true }).click();
    await expect(page.getByTestId('notice')).toBeVisible();
    expect(count(s)).toBe(0);
    if (mode === 'lock busy') await page.evaluate(() => window.releaseVerificationLock());
  });
test('real SessionProvider token refresh cancels original review and cannot dispatch', async ({ context, page }) => {
  const s = await network(context, { expiresAt: new Date(Date.now() + 33000).toISOString() });
  await login(page);
  await review(page);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(() => s.refreshes).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(count(s)).toBe(0);
  expect(await journal(page)).toBeNull();
});
test('late reply after native route departure keeps durable original and cannot claim known', async ({ context, page }) => {
  const hold = held();
  const s = await network(context, {
    'kyc.submit': async (r) => {
      await hold.promise;
      return reply(r, row());
    },
  });
  await login(page);
  await submit(page);
  await expect.poll(() => count(s)).toBe(1);
  const before = await journal(page);
  await page.getByRole('link', { name: 'Verification help →', exact: true }).click();
  hold.release();
  await nativeReturn(page);
  await expect(originals(page)).toContainText('Original result unknown');
  expect(await journal(page)).toBe(before);
  await expect(originals(page)).not.toContainText('A record was returned.');
});
test('independent saved originals are retained and never replaced by list/null/new login', async ({ context, page }) => {
  const s = await network(context, { rows: [], tier: 'none' });
  await login(page);
  const stored = [a, b].map((requestId) => ({ owner, kind: 'submit', requestId, createdAt: stamp }));
  await page.evaluate(
    ({ k, stored }) => {
      localStorage.setItem(k, JSON.stringify(stored));
      window.dispatchEvent(new StorageEvent('storage', { key: k }));
    },
    { k: key, stored },
  );
  await expect(originals(page)).toContainText(a);
  await expect(originals(page)).toContainText(b);
  const before = await journal(page);
  await page.getByRole('button', { name: 'Read current records', exact: true }).click();
  await signOut(page);
  await login(page);
  expect(await journal(page)).toBe(before);
  await expect(page.locator('form button[type="submit"]')).toBeDisabled();
  expect(count(s)).toBe(0);
});
test('two actual same-owner tabs review independently but unknown first blocks the second POST', async ({ context, page }) => {
  const s = await network(context, { 'kyc.submit': (r) => fail(r) });
  const next = await context.newPage();
  await login(page);
  await login(next);
  await review(page);
  await review(next);
  await page.getByRole('dialog').getByRole('button', { name: 'Submit this request', exact: true }).click();
  await expect(originals(page)).toContainText('Original result unknown');
  const before = await journal(page);
  await next.getByRole('dialog').getByRole('button', { name: 'Submit this request', exact: true }).click();
  await expect(originals(next)).toContainText('Original result unknown');
  expect(count(s)).toBe(1);
  expect(await journal(next)).toBe(before);
});
test('real SessionProvider refresh during held POST leaves original durable unknown and hides late known reply', async ({
  context,
  page,
}) => {
  const hold = held();
  const s = await network(context, {
    expiresAt: new Date(Date.now() + 33000).toISOString(),
    'kyc.submit': async (r) => {
      await hold.promise;
      return reply(r, row());
    },
  });
  await login(page);
  await submit(page);
  await expect.poll(() => count(s)).toBe(1);
  const before = await journal(page);
  await expect.poll(() => s.refreshes).toBe(1);
  hold.release();
  await expect(originals(page)).toContainText('Original result unknown');
  await expect(originals(page)).not.toContainText('A record was returned.');
  expect(await journal(page)).toBe(before);
  expect(count(s)).toBe(1);
});
test('late owned GET cannot contaminate a new owner', async ({ context, page }) => {
  const hold = held();
  const s = await network(context, {
    'kyc.status': async (r, input, actor) => {
      if (actor === owner) {
        await hold.promise;
        return reply(r, { tier: 'full', records: [row()] });
      }
      return reply(r, { tier: 'none', records: [] });
    },
  });
  await login(page);
  await signOut(page);
  s.owner = other;
  await login(page);
  hold.release();
  await expect(records(page)).toContainText('No requests yet');
  await expect(page.locator('#main')).not.toContainText(a);
  expect(count(s)).toBe(0);
});
test('native locale change preserves frozen review terms and only exact two-field uppercase POST', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  await review(page, 'institutional', 'fr');
  await changeLocale(context, 'fr');
  await expect(page.getByRole('dialog')).toContainText('Institutionnel');
  await page.getByRole('dialog').locator('.button--primary').click();
  await expect(page.getByTestId('verification__original')).toContainText('Un dossier a été renvoyé.');
  expect(s.privateWrites.filter((r) => r.procedure === 'kyc.submit').map((r) => r.input)).toEqual([
    { tier: 'institutional', jurisdiction: 'FR' },
  ]);
  expect(count(s)).toBe(1);
});
test('exact known local cleanup retains an independent original unchanged', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  await page.evaluate((k) => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key === k) throw Error('Isolated cleanup refusal');
      return original.call(this, key);
    };
    window.restoreVerificationStorage = () => {
      Storage.prototype.removeItem = original;
    };
  }, key);
  await submit(page);
  await expect(originals(page)).toContainText('Local record still saved');
  const independent = { owner, kind: 'submit', requestId: b, createdAt: stamp };
  await page.evaluate(
    ({ k, independent }) => {
      const records = JSON.parse(localStorage.getItem(k));
      localStorage.setItem(k, JSON.stringify([...records, independent]));
      window.dispatchEvent(new StorageEvent('storage', { key: k }));
      window.restoreVerificationStorage();
    },
    { k: key, independent },
  );
  await page.getByRole('button', { name: 'Finish local record', exact: true }).click();
  await expect(originals(page)).toContainText('The matching local record was removed. The service was not called again.');
  expect(JSON.parse(await journal(page))).toEqual([independent]);
  await expect(originals(page)).toContainText('Original result unknown');
  await expect(page.locator('form button[type="submit"]')).toBeDisabled();
  expect(count(s)).toBe(1);
});
test('unknown320 plus failed current GET retains original; retry only reads', async ({ context, page }) => {
  const s = await network(context, { 'kyc.submit': (r) => fail(r) });
  await page.setViewportSize({ width: 320, height: 900 });
  await login(page);
  await submit(page);
  await expect(originals(page)).toContainText('Original result unknown');
  const before = await journal(page);
  s['kyc.status'] = (r) => fail(r);
  await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
  await expect(page.getByTestId('failure')).toBeVisible();
  await expect(records(page)).not.toContainText(a);
  await shot(page, 'unknown320-failed-current-read');
  delete s['kyc.status'];
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(records(page)).toContainText(a);
  expect(await journal(page)).toBe(before);
  expect(count(s)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
for (const language of ['en', 'es', 'fr'])
  for (const width of [320, 390, 768, 1440])
    test(`native ${language} ${width} hierarchy/focus/overflow/accessibility`, async ({ context, page }) => {
      const s = await network(context);
      if (language !== 'en') await changeLocale(context, language);
      await page.setViewportSize({ width, height: 900 });
      await login(page);
      await expect(page.locator('[data-testid="verification__rows"] li')).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const result = await new AxeBuilder({ page })
        .include('[data-testid="verification"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(result.violations).toEqual([]);
      await page.locator('[data-testid="verification__request"] select').selectOption('institutional');
      await page.locator('input[name="kyc-country"]').fill('fr');
      await page.locator('form button[type="submit"]').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      if (width === 390) await shot(page, `review-${language}-390`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('form button[type="submit"]')).toBeFocused();
      expect(count(s)).toBe(0);
      await shot(page, `native-${language}-${width}`);
    });
