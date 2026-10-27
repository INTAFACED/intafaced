import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const owner = '11111111-1111-4111-8111-111111111111',
  other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const a = '22222222-2222-4222-8222-222222222222',
  b = '33333333-3333-4333-8333-333333333333',
  generated = '44444444-4444-4444-8444-444444444444';
const stamp = '2026-10-10T09:41:00.000Z',
  key = 'intafaced.customer.subaccounts.v1:' + owner;
const evidence = process.env.SUBACCOUNT_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const contracts = JSON.parse(readFileSync(process.env.SUBACCOUNT_CONTRACT_FIXTURE));
const errors = new WeakMap(),
  summary = [];
test.beforeEach(async ({ context }) => {
  const list = [];
  errors.set(context, list);
  const watch = (page) => page.on('pageerror', (e) => list.push(e.message));
  context.pages().forEach(watch);
  context.on('page', watch);
});
test.afterEach(async ({ context }, info) => {
  expect(errors.get(context)).toEqual([]);
  summary.push({ name: info.title, status: info.status, pageErrors: errors.get(context) });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summary, null, 2)));
const row = (id = a, label = 'Original strategy', extra = {}) => ({
  id,
  label,
  purpose: 'Original purpose',
  revoked: false,
  frozen: false,
  kind: 'standard',
  nickname: null,
  createdAt: stamp,
  ...extra,
});
const reply = (route, data) => route.fulfill({ status: 200, json: { result: { data } } });
const fail = (route, status = 503, message = 'Isolated response lost', code = 'ISOLATED_REFUSAL') =>
  route.fulfill({ status, json: { error: { message, data: { cause: { code } } } } });
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
  const state = { owner, rows: [row(), row(b, 'Second strategy')], reads: [], writes: [], privateWrites: [], sequence: 0, ...options };
  const tokens = new Map();
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : request.postDataJSON();
    if (procedure === 'auth.login' || procedure === 'auth.refresh') {
      const token = 'isolated-subaccount-session-' + ++state.sequence;
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
    if (request.method() === 'GET')
      state.reads.push({ procedure, actor, ...(procedure === 'subAccounts.list' ? { limit: input.limit } : {}) });
    else {
      state.writes.push({ procedure, actor, ...(procedure === 'subAccounts.revoke' ? { target: input.subAccountId } : {}) });
      state.privateWrites.push({ procedure, input });
    }
    if (state[procedure]) return state[procedure](route, input, actor);
    if (procedure === 'subAccounts.list') return reply(route, state.rows.slice(0, input.limit));
    if (procedure === 'subAccounts.create') return reply(route, { id: generated });
    if (procedure === 'subAccounts.revoke') return reply(route, { revoked: true });
    return fail(route);
  });
  return state;
}
async function login(page, path = '/uc/account') {
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
async function nativeReturn(page) {
  await page.getByRole('link', { name: 'More', exact: true }).filter({ visible: true }).click();
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('navigation', { name: 'Person settings', exact: true }).getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
}
const list = (page) => page.getByRole('region', { name: 'Strategy subaccounts', exact: true });
const requests = (page) => page.getByRole('region', { name: 'Original subaccount requests', exact: true });
const createCount = (state) => state.writes.filter((r) => r.procedure === 'subAccounts.create').length;
const revokeCount = (state) => state.writes.filter((r) => r.procedure === 'subAccounts.revoke').length;
async function reviewCreate(page, label = '  Original new strategy  ', purpose = '  Private purpose  ') {
  await page.getByRole('textbox', { name: 'Label', exact: true }).fill(label);
  await page.getByRole('textbox', { name: 'Purpose (optional)', exact: true }).fill(purpose);
  await page.getByRole('button', { name: 'Review subaccount', exact: true }).click();
}
async function create(page, label, purpose) {
  await reviewCreate(page, label, purpose);
  await page.getByRole('dialog').getByRole('button', { name: 'Create subaccount', exact: true }).click();
}
async function reviewRevoke(page, id = a) {
  await page.getByRole('button', { name: 'Review revoke of subaccount ' + id, exact: true }).click();
}
async function revoke(page, id = a) {
  await reviewRevoke(page, id);
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke subaccount', exact: true }).click();
}
async function journal(page, storageKey = key) {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), storageKey);
}
async function shot(page, name) {
  await page.screenshot({
    path: evidence + '/' + name + '.png',
    fullPage: true,
    mask: [page.locator('input[autocomplete="username"],input[autocomplete="current-password"]')],
  });
}
async function locale(context, language) {
  const view = await context.newPage();
  await login(view, '/view');
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption(language);
  return view;
}

test('guest Account has useful native sign-in without private reads', async ({ context, page }) => {
  const s = await network(context);
  await page.goto('/uc/account');
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(s.reads).toEqual([]);
  expect(s.writes).toEqual([]);
});
test('native own bounded list includes revoked rows, exact IDs and actual timestamps', async ({ context, page }) => {
  const s = await network(context, { rows: [row(), row(b, 'Retired strategy', { revoked: true })] });
  await login(page);
  await expect(list(page)).toContainText(a);
  await expect(list(page)).toContainText(b);
  await expect(list(page)).toContainText('Revoked');
  expect(s.reads.filter((r) => r.procedure === 'subAccounts.list')).toEqual([{ procedure: 'subAccounts.list', actor: owner, limit: 50 }]);
  expect(s.writes).toEqual([]);
  await shot(page, 'desktop');
});
test('empty and failed read distinguish absence and conceal old private rows during retry', async ({ context, page }) => {
  const hold = held();
  let reads = 0;
  const s = await network(context, {
    'subAccounts.list': async (r) => {
      reads++;
      if (reads === 2) {
        await hold.promise;
        return fail(r);
      }
      return reply(r, reads > 2 ? [] : [row()]);
    },
  });
  await login(page);
  await expect(list(page)).toContainText(a);
  await page.getByRole('button', { name: 'Refresh subaccounts' }).click();
  await expect(page.getByText(a, { exact: true })).toHaveCount(0);
  hold.release();
  await expect(list(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByText(a, { exact: true })).toHaveCount(0);
  await list(page).getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('No strategy subaccounts returned')).toBeVisible();
  expect(s.writes).toEqual([]);
});
for (const [name, rows] of [
  ['duplicate UUID', [row(), row()]],
  ['impossible calendar', [row(a, 'Bad', { createdAt: '2026-02-30T00:00:00Z' })]],
  ['oldest first', [row(a, 'Old', { createdAt: '2026-10-09T00:00:00Z' }), row(b)]],
  ['invalid UUID', [row('invalid')]],
  ['missing revoked', [{ id: a, label: 'Bad', purpose: null, createdAt: stamp }]],
  ['oversized window', Array.from({ length: 51 }, (_, i) => row(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`))],
])
  test('malformed list refuses ' + name, async ({ context, page }) => {
    const s = await network(context, { rows, 'subAccounts.list': (r) => reply(r, rows) });
    await login(page);
    await expect(list(page).getByRole('heading', { name: 'Information could not be verified' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review revoke of subaccount ' + a })).toHaveCount(0);
    expect(s.writes).toEqual([]);
  });
test('equal timestamp rows are valid and a short window has no expansion', async ({ context, page }) => {
  await network(context);
  await login(page);
  await expect(list(page).locator('li')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Load up to 200' })).toHaveCount(0);
});
for (const width of [320, 390, 768, 1440])
  test('native full 50→200 window and reachable single creation form at ' + width, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 900 });
    const rows = Array.from({ length: 200 }, (_, i) =>
      row(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 'Ω'.repeat(64), { purpose: '長'.repeat(200), revoked: i % 2 === 0 }),
    );
    const s = await network(context, { rows });
    await login(page);
    await expect(list(page).locator('li')).toHaveCount(50);
    await page.getByRole('button', { name: 'Load up to 200' }).click();
    await expect(list(page).locator('li')).toHaveCount(200);
    await expect(page.getByText('This window ends at 200 subaccounts. It is not your complete history.')).toBeVisible();
    if (width < 900) {
      await page.evaluate(() => scrollTo(0, 0));
      const jump = page.getByRole('button', { name: 'New subaccount', exact: true });
      await expect(jump).toBeVisible();
      await jump.click();
      const field = page.getByRole('textbox', { name: 'Label', exact: true });
      await expect(field).toBeFocused();
      const rect = await field.boundingBox(),
        nav = await page.getByTestId('mobile-doors').boundingBox();
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.height).toBeLessThan(nav ? nav.y : 900);
    } else {
      await expect(page.getByRole('button', { name: 'New subaccount', exact: true })).toBeHidden();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('input[name="subaccount-label"]').count()).toBe(1);
    expect(s.writes).toEqual([]);
    await shot(page, 'long-' + width);
  });
test('native review has keyboard focus, Escape restoration and zero dispatch', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  await reviewCreate(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Original new strategy');
  await expect(dialog).toContainText(owner);
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review subaccount', exact: true })).toBeFocused();
  expect(s.writes).toEqual([]);
});
test('frozen normalized original is sent once and UUID-only create becomes known', async ({ context, page }) => {
  const s = await network(context);
  await login(page);
  await create(page);
  await expect(requests(page)).toContainText('The service created the original strategy subaccount.');
  await expect(requests(page)).toContainText(generated);
  expect(s.privateWrites).toEqual([
    { procedure: 'subAccounts.create', input: { label: 'Original new strategy', purpose: 'Private purpose' } },
  ]);
  expect(await journal(page)).toBeNull();
  expect(createCount(s)).toBe(1);
});
for (const [name, answer] of [
  ['changed', true],
  ['no change', false],
])
  test('revoke original distinguishes ' + name, async ({ context, page }) => {
    const s = await network(context, { 'subAccounts.revoke': (r) => reply(r, { revoked: answer }) });
    await login(page);
    await revoke(page);
    await expect(requests(page)).toContainText(
      answer ? 'The service revoked the original strategy subaccount.' : 'Revoke response · no change',
    );
    if (!answer) await expect(requests(page)).not.toContainText('The service revoked the original strategy subaccount.');
    expect(s.privateWrites).toEqual([{ procedure: 'subAccounts.revoke', input: { subAccountId: a } }]);
    expect(await journal(page)).toBeNull();
  });
for (const kind of ['create', 'revoke'])
  for (const malformed of ['missing', 'wrong type', 'invalid id'])
    test(kind + ' malformed dispatch ' + malformed + ' remains unknown', async ({ context, page }) => {
      const data =
        malformed === 'missing'
          ? {}
          : kind === 'create'
            ? { id: malformed === 'wrong type' ? 42 : 'bad' }
            : { revoked: malformed === 'wrong type' ? 'false' : null };
      const s = await network(context, { ['subAccounts.' + kind]: (r) => reply(r, data) });
      await login(page);
      await (kind === 'create' ? create(page) : revoke(page));
      await expect(requests(page)).toContainText(kind === 'create' ? 'Creation is not confirmed' : 'Revocation is not confirmed');
      expect((await journal(page)).length).toBe(1);
      expect(kind === 'create' ? createCount(s) : revokeCount(s)).toBe(1);
    });
test('unknown create survives native More, Support, remount and a closed tab without replay or private persistence', async ({
  context,
  page,
}) => {
  const s = await network(context, { 'subAccounts.create': (r) => fail(r) });
  await login(page);
  await create(page);
  await expect(requests(page)).toContainText('Creation is not confirmed');
  const first = await journal(page);
  expect(Object.keys(first[0]).sort()).toEqual(['createdAt', 'kind', 'owner', 'requestId']);
  expect(JSON.stringify(first)).not.toContain('Private purpose');
  await nativeReturn(page);
  await expect(requests(page)).toContainText(first[0].requestId);
  await expect(requests(page)).toContainText('The private label and purpose were not saved.');
  await expect(page.getByRole('button', { name: 'Review subaccount', exact: true })).toBeDisabled();
  await requests(page).getByRole('link', { name: 'Open Support' }).click();
  await expect(page).toHaveURL(/\/support$/);
  await nativeReturn(page);
  await expect(requests(page)).toContainText(first[0].requestId);
  const second = await context.newPage();
  await login(second);
  await page.close();
  await expect(requests(second)).toContainText(first[0].requestId);
  await expect(second.getByRole('button', { name: 'Review subaccount', exact: true })).toBeDisabled();
  expect(createCount(s)).toBe(1);
});
test('unknown revoke A and B retain independent originals while reads and creation remain useful', async ({ context, page }) => {
  const s = await network(context, { 'subAccounts.revoke': (r) => fail(r) });
  await login(page);
  await revoke(page, a);
  await expect(requests(page)).toContainText('Revocation is not confirmed');
  const one = await journal(page);
  await expect(page.getByRole('button', { name: 'Review revoke of subaccount ' + a })).toBeDisabled();
  await revoke(page, b);
  await expect(requests(page).locator('article')).toHaveCount(2);
  const two = await journal(page);
  expect(two[0]).toEqual(one[0]);
  expect(two.map((r) => r.target)).toEqual([a, b]);
  await page.getByRole('button', { name: 'Refresh subaccounts' }).click();
  await expect(list(page)).toContainText(a);
  await expect(page.getByRole('button', { name: 'Review subaccount', exact: true })).toBeEnabled();
  await nativeReturn(page);
  await expect(requests(page).locator('article')).toHaveCount(2);
  expect(revokeCount(s)).toBe(2);
});
test('unknown create leaves unrelated revoke available; known false cannot settle it', async ({ context, page }) => {
  const s = await network(context, { 'subAccounts.create': (r) => fail(r), 'subAccounts.revoke': (r) => reply(r, { revoked: false }) });
  await login(page);
  await create(page);
  await expect(requests(page)).toContainText('Creation is not confirmed');
  const first = await journal(page);
  await revoke(page);
  await expect(requests(page)).toContainText('Revoke response · no change');
  expect(await journal(page)).toEqual(first);
  expect(createCount(s)).toBe(1);
  expect(revokeCount(s)).toBe(1);
});
for (const scenario of ['list match', 'row absence', 'new login'])
  test('later ' + scenario + ' cannot recover an unknown original', async ({ context, page }) => {
    const s = await network(context, { 'subAccounts.revoke': (r) => fail(r) });
    await login(page);
    await revoke(page);
    await expect(requests(page)).toContainText('Revocation is not confirmed');
    const original = await journal(page);
    s.rows = scenario === 'row absence' ? [] : [row(a, 'Original strategy', { revoked: true })];
    if (scenario === 'new login') {
      await signOut(page);
      await login(page);
    } else await page.getByRole('button', { name: 'Refresh subaccounts' }).click();
    await expect(requests(page)).toContainText(original[0].requestId);
    expect(await journal(page)).toEqual(original);
    expect(revokeCount(s)).toBe(1);
  });
for (const cause of ['create unpublished cap', 'create frozen owner', 'create missing owner', 'create live partition cap reached'])
  test('exact source-qualified ' + cause + ' releases only its original create guard', async ({ context, page }) => {
    const c = contracts.cases.find((x) => x.name === cause);
    expect(c.status).toBe(500);
    const s = await network(context, { 'subAccounts.create': (r) => fail(r, c.status, c.apiResult.message, c.causeCode) });
    await login(page);
    await create(page);
    await expect(requests(page)).toContainText('Creation was refused before insertion');
    await expect(requests(page)).toContainText(c.causeCode);
    await expect(page.getByRole('button', { name: 'Review subaccount', exact: true })).toBeEnabled();
    expect(await journal(page)).toBeNull();
    expect(createCount(s)).toBe(1);
  });
for (const [name, status, message, code, kind] of [
  ['generic 400', 400, 'Invalid request', 'BAD_REQUEST', 'create'],
  ['generic 500', 500, 'Failure', 'INTERNAL_SERVER_ERROR', 'create'],
  ['same code wrong explanation', 500, 'Failure after insert', 'auth.not_found', 'create'],
  ['same code wrong status', 400, 'User not found', 'auth.not_found', 'create'],
  ['same code revoke', 500, 'User not found', 'auth.not_found', 'revoke'],
])
  test(name + ' retains unknown safeguards', async ({ context, page }) => {
    const s = await network(context, { ['subAccounts.' + kind]: (r) => fail(r, status, message, code) });
    await login(page);
    await (kind === 'create' ? create(page) : revoke(page));
    await expect(requests(page)).toContainText(kind === 'create' ? 'Creation is not confirmed' : 'Revocation is not confirmed');
    expect((await journal(page)).length).toBe(1);
    expect(kind === 'create' ? createCount(s) : revokeCount(s)).toBe(1);
  });
for (const denial of ['write denial', 'read denial', 'malformed journal', 'locks unavailable', 'held owner lock'])
  test(denial + ' prevents dispatch while reads remain useful', async ({ context, page }) => {
    const s = await network(context);
    await login(page);
    let hold;
    if (denial === 'malformed journal')
      await page.evaluate((k) => {
        localStorage.setItem(k, '{bad');
        dispatchEvent(new StorageEvent('storage', { key: k }));
      }, key);
    else if (denial === 'read denial')
      await page.evaluate(() => {
        Storage.prototype.getItem = function () {
          throw Error('isolated denied');
        };
      });
    else if (denial === 'write denial')
      await page.evaluate(() => {
        Storage.prototype.setItem = function () {
          throw Error('isolated denied');
        };
      });
    else if (denial === 'locks unavailable')
      await page.evaluate(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }));
    else {
      hold = await context.newPage();
      await hold.goto('/');
      await hold.evaluate((o) => {
        window.releaseLock = null;
        navigator.locks.request(
          'customer-subaccounts:' + o,
          () =>
            new Promise((r) => {
              window.releaseLock = r;
            }),
        );
      }, owner);
      await expect.poll(() => hold.evaluate(() => Boolean(window.releaseLock))).toBe(true);
    }
    if (denial === 'read denial') {
      await reviewCreate(page);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } else if (denial !== 'malformed journal') await create(page);
    else await expect(page.getByRole('button', { name: 'Review subaccount', exact: true })).toBeDisabled();
    await expect(page.getByTestId('notice')).toBeVisible();
    expect(createCount(s)).toBe(0);
    await page.getByRole('button', { name: 'Refresh subaccounts' }).click();
    await expect(list(page)).toContainText(a);
    if (hold) await hold.close();
  });
for (const result of ['create', 'true', 'false', 'refusal'])
  test('known ' + result + ' stays known after local cleanup failure and can finalize without replay', async ({ context, page }) => {
    const s = await network(context, {
      'subAccounts.create': async (r) => {
        await page.evaluate(() => {
          Storage.prototype.removeItem = function () {
            throw Error('isolated denied');
          };
        });
        return result === 'refusal' ? fail(r, 500, 'User not found', 'auth.not_found') : reply(r, { id: generated });
      },
      'subAccounts.revoke': async (r) => {
        await page.evaluate(() => {
          Storage.prototype.removeItem = function () {
            throw Error('isolated denied');
          };
        });
        return reply(r, { revoked: result === 'true' });
      },
    });
    await login(page);
    await page.evaluate(() => {
      window.originalRemove = Storage.prototype.removeItem;
    });
    await (result === 'create' || result === 'refusal' ? create(page) : revoke(page));
    await expect(requests(page)).toContainText('Known response received · local safeguard retained');
    await expect(requests(page)).not.toContainText('Creation is not confirmed');
    await expect(requests(page)).not.toContainText('Revocation is not confirmed');
    expect((await journal(page)).length).toBe(1);
    await page.evaluate(() => {
      Storage.prototype.removeItem = window.originalRemove;
    });
    await requests(page).getByRole('button', { name: 'Finalize known local safeguard' }).click();
    await expect(requests(page)).toContainText('The matching local safeguard was removed.');
    expect(await journal(page)).toBeNull();
    expect(createCount(s) + revokeCount(s)).toBe(1);
  });
test('known cleanup failure remount knows only saved unresolved references', async ({ context, page }) => {
  const s = await network(context, {
    'subAccounts.create': async (r) => {
      await page.evaluate(() => {
        Storage.prototype.removeItem = function () {
          throw Error('isolated denied');
        };
      });
      return reply(r, { id: generated });
    },
  });
  await login(page);
  await create(page);
  await expect(requests(page)).toContainText('Known response received · local safeguard retained');
  await nativeReturn(page);
  await expect(requests(page)).toContainText('Creation is not confirmed');
  await expect(requests(page)).not.toContainText('The service created the original strategy subaccount.');
  expect(createCount(s)).toBe(1);
});
for (const change of ['label', 'purpose', 'revoked', 'absent'])
  test('fresh revoke preflight rejects original row ' + change + ' without POST', async ({ context, page }) => {
    const s = await network(context);
    await login(page);
    await reviewRevoke(page);
    s.rows =
      change === 'absent'
        ? []
        : [
            row(a, change === 'label' ? 'Changed' : 'Original strategy', {
              ...(change === 'purpose' ? { purpose: 'Changed' } : {}),
              ...(change === 'revoked' ? { revoked: true } : {}),
            }),
          ];
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke subaccount' }).click();
    await expect(page.getByText('The original subaccount changed or is outside the current window.', { exact: false })).toBeVisible();
    expect(revokeCount(s)).toBe(0);
    expect(await journal(page)).toBeNull();
  });
test('failed preflight never saves or sends an original command', async ({ context, page }) => {
  let reads = 0;
  const s = await network(context, { 'subAccounts.list': (r) => (++reads === 1 ? reply(r, [row()]) : fail(r)) });
  await login(page);
  await create(page);
  await expect(page.getByText('Current records could not be verified.', { exact: false })).toBeVisible();
  expect(s.writes).toEqual([]);
  expect(await journal(page)).toBeNull();
});
for (const kind of ['create', 'revoke'])
  test('held ' + kind + ' preflight survives owner departure with zero POST', async ({ context, page }) => {
    const hold = held();
    let reads = 0;
    const s = await network(context, {
      'subAccounts.list': async (r) => {
        if (++reads === 2) await hold.promise;
        return reply(r, [row()]);
      },
    });
    await login(page);
    await (kind === 'create' ? create(page) : revoke(page));
    await expect.poll(() => reads).toBe(2);
    await signOut(page);
    s.owner = other;
    await login(page);
    hold.release();
    await expect(page.getByRole('region', { name: 'Account ID' })).toContainText(other);
    await expect(list(page)).toContainText(a);
    expect(s.writes).toEqual([]);
    expect(await journal(page)).toBeNull();
  });
test('held create preflight token refresh cancels original despite same owner', async ({ context, page }) => {
  const hold = held();
  let reads = 0;
  const s = await network(context, {
    expiresAt: new Date(Date.now() + 32000).toISOString(),
    'subAccounts.list': async (r) => {
      if (++reads === 2) await hold.promise;
      return reply(r, [row()]);
    },
  });
  await login(page);
  await create(page);
  await expect.poll(() => reads).toBe(2);
  await expect.poll(() => s.sequence).toBe(2);
  hold.release();
  await expect(page.getByRole('region', { name: 'Account ID' })).toContainText(owner);
  expect(createCount(s)).toBe(0);
  expect(await journal(page)).toBeNull();
});
for (const kind of ['create', 'revoke'])
  test('late dispatched ' + kind + ' cannot contaminate a new owner', async ({ context, page }) => {
    const hold = held();
    const s = await network(context, {
      ['subAccounts.' + kind]: async (r) => {
        await hold.promise;
        return reply(r, kind === 'create' ? { id: generated } : { revoked: true });
      },
    });
    await login(page);
    await (kind === 'create' ? create(page) : revoke(page));
    await expect.poll(() => s.writes.length).toBe(1);
    const original = await journal(page);
    await signOut(page);
    s.owner = other;
    await login(page);
    hold.release();
    await expect(page.getByRole('region', { name: 'Account ID' })).toContainText(other);
    await expect(requests(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review subaccount', exact: true })).toBeEnabled();
    expect(await journal(page)).toEqual(original);
    expect(s.writes[0].actor).toBe(owner);
  });
test('review and unknown survive authored locale changes with opaque originals intact', async ({ context, page }) => {
  const s = await network(context, { 'subAccounts.create': (r) => fail(r) });
  await login(page);
  await reviewCreate(page, '  Ωpaque original  ', '  Untranslated purpose  ');
  await locale(context, 'fr');
  await expect(page.getByRole('dialog')).toContainText('Ωpaque original');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Créer le sous-compte' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Créer le sous-compte' }).click();
  await expect(page.getByRole('heading', { name: 'Création non confirmée', exact: true })).toBeVisible();
  await locale(context, 'es');
  await expect(page.getByRole('heading', { name: 'Creación sin confirmar', exact: true })).toBeVisible();
  expect(s.privateWrites).toEqual([
    { procedure: 'subAccounts.create', input: { label: 'Ωpaque original', purpose: 'Untranslated purpose' } },
  ]);
  expect(JSON.stringify(await journal(page))).not.toContain('Ωpaque');
});
test('two real tabs cannot dispatch one owner create concurrently', async ({ context, page }) => {
  const hold = held();
  const s = await network(context, {
    'subAccounts.create': async (r) => {
      await hold.promise;
      return fail(r);
    },
  });
  await login(page);
  const second = await context.newPage();
  await login(second);
  await reviewCreate(second);
  await create(page);
  await expect.poll(() => createCount(s)).toBe(1);
  await second.getByRole('dialog').getByRole('button', { name: 'Create subaccount' }).click();
  await expect(second.getByTestId('notice')).toContainText('Another tab');
  hold.release();
  await expect(requests(page)).toContainText('Creation is not confirmed');
  expect(createCount(s)).toBe(1);
  await expect(second.getByRole('button', { name: 'Review subaccount', exact: true })).toBeDisabled();
});
test('native visible screen passes serious and critical accessibility checks', async ({ context, page }) => {
  await network(context);
  await login(page);
  const scan = await new AxeBuilder({ page }).include('#main').analyze();
  expect(scan.violations.filter((v) => ['critical', 'serious'].includes(v.impact))).toEqual([]);
  await reviewCreate(page);
  const dialog = await new AxeBuilder({ page }).include('dialog').analyze();
  expect(dialog.violations.filter((v) => ['critical', 'serious'].includes(v.impact))).toEqual([]);
});
test('known outcome updates an already mounted nonsecret polite status', async ({ context, page }) => {
  await network(context);
  await login(page);
  await expect(page.getByTestId('subaccounts__announcement')).toHaveText('');
  await page.evaluate(() => {
    window.statusUpdates = [];
    const region = document.querySelector('[data-testid="subaccounts__announcement"]');
    new MutationObserver(() => window.statusUpdates.push(region.textContent)).observe(region, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await create(page);
  await expect(page.getByTestId('subaccounts__announcement')).toHaveText('The service created the original strategy subaccount.');
  await expect(page.getByTestId('subaccounts__announcement')).toHaveAttribute('aria-live', 'polite');
  const messages = await page.evaluate(() => window.statusUpdates);
  expect(messages).toContain('The service created the original strategy subaccount.');
  expect(messages.join(' ')).not.toContain('Private purpose');
});
test('known B cleanup failure and local finalization preserve earlier unknown A exactly', async ({ context, page }) => {
  const s = await network(context, {
    'subAccounts.revoke': async (r, input) => {
      if (input.subAccountId === a) return fail(r);
      await page.evaluate(() => {
        window.realSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function () {
          throw Error('isolated cleanup denied');
        };
      });
      return reply(r, { revoked: false });
    },
  });
  await login(page);
  await revoke(page, a);
  await expect(requests(page)).toContainText('Revocation is not confirmed');
  const first = await journal(page);
  await revoke(page, b);
  await expect(requests(page)).toContainText('Known response received · local safeguard retained');
  const two = await journal(page);
  expect(two).toHaveLength(2);
  expect(two[0]).toEqual(first[0]);
  await page.evaluate(() => {
    Storage.prototype.setItem = window.realSet;
  });
  await requests(page).getByRole('button', { name: 'Finalize known local safeguard' }).click();
  await expect(requests(page)).toContainText('The matching local safeguard was removed.');
  expect(await journal(page)).toEqual(first);
  expect(revokeCount(s)).toBe(2);
});
test('reviewed private draft disappears immediately during account token refresh', async ({ context, page }) => {
  const s = await network(context, { expiresAt: new Date(Date.now() + 32000).toISOString() });
  await login(page);
  await reviewCreate(page, 'Opaque private draft', 'Opaque private purpose');
  await expect.poll(() => s.sequence).toBe(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Label', exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Purpose (optional)', exact: true })).toHaveValue('');
  expect(s.writes).toEqual([]);
});
test('held preflight route departure does not dispatch after native Account return', async ({ context, page }) => {
  const hold = held();
  let reads = 0;
  const s = await network(context, {
    'subAccounts.list': async (r) => {
      if (++reads === 2) await hold.promise;
      return reply(r, [row()]);
    },
  });
  await login(page);
  await create(page);
  await expect.poll(() => reads).toBe(2);
  await nativeReturn(page);
  hold.release();
  await expect(list(page)).toContainText(a);
  expect(createCount(s)).toBe(0);
  expect(await journal(page)).toBeNull();
});
