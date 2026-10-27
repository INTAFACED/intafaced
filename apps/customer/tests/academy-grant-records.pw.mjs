import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Pure actual pinned curriculum / MemoryCertStore, supplied by the isolated proof runner.
// No invented lesson body, assessment engine, provider, bus or ledger is mounted.
const service = await import(pathToFileURL(process.env.ACADEMY_SERVICE_FIXTURE).href);
const {
  MemoryCertStore,
  progressReport,
  decideGrant,
  NullCertXpPublisher,
  BusCertXpPublisher,
  listCertCatalog,
  listCurriculum,
  getCurriculumItem,
  curriculumBodyForLocale,
  curriculumI18nStrategyLine,
} = service;
const evidence = process.env.ACADEMY_GRANT_EVIDENCE || '/tmp/academy-grant-proof';
const base = process.env.ACADEMY_GRANT_BASE_URL || 'http://127.0.0.1:3290';
mkdirSync(evidence, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
const certId = 'foundations-v1',
  slug = 'foundations-position-sizing',
  next = 'foundations-journal-discipline';
const at = '2026-10-10T09:41:00.000Z',
  markerKey = `intafaced:more:pending:${owner}:academy`;
const originalPath = `/academy?cert=${certId}&section=certificates`;
const summaries = [],
  errors = new WeakMap();
test.beforeEach(async ({ context }) => {
  const list = [];
  errors.set(context, list);
  const observe = (page) => page.on('pageerror', (error) => list.push(error.message));
  context.pages().forEach(observe);
  context.on('page', observe);
});
test.afterEach(async ({ context }, info) => {
  expect(errors.get(context)).toEqual([]);
  summaries.push({ name: info.title, status: info.status, pageErrors: errors.get(context) });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summaries, null, 2)));
function lesson(input) {
  const original = getCurriculumItem(input.slug);
  if (!original) throw new Error('Test requested no real curriculum item: ' + input.slug);
  const localized = curriculumBodyForLocale(original.body, input.locale);
  return {
    ...original,
    body: localized.body,
    locale: localized.resolution.locale,
    fellBack: localized.resolution.fellBack,
    i18nStrategy: curriculumI18nStrategyLine(),
  };
}
async function network(context, options = {}) {
  const store = new MemoryCertStore();
  listCertCatalog().forEach((definition) => store.registerCert(definition));
  for (const required of listCertCatalog()[0].requiredItemSlugs) store.markComplete(owner, required, new Date('2026-10-09T08:00:00Z'));
  const state = { owner, store, definitions: listCertCatalog(), reads: [], writes: [], ...options };
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : request.postDataJSON();
    const reply = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (procedure === 'auth.login')
      return reply({
        userId: state.owner,
        accessToken: 'isolated-academy-' + state.owner,
        refreshToken: 'isolated-academy-refresh-' + state.owner,
        expiresAt: '2027-10-10T09:41:00Z',
      });
    if (procedure === 'auth.logout') return reply({ ok: true });
    (request.method() === 'GET' ? state.reads : state.writes).push({ procedure, input });
    if (state[procedure]) return state[procedure](route, input, reply);
    if (procedure === 'myCerts') return reply(store.listCerts(state.owner).slice(0, input.limit));
    if (procedure === 'certDefinitions') return reply(state.definitions);
    if (procedure === 'curriculum') return reply(listCurriculum(input).slice(0, input.limit));
    if (procedure === 'curriculumItemLocalized') return reply(lesson(input));
    if (procedure === 'certProgress') return reply(store.progressOf(state.owner, input.certId));
    if (procedure === 'markCurriculumComplete') return reply(store.markComplete(state.owner, input.itemSlug, new Date(at)));
    if (procedure === 'enrollCertPath') return reply(store.enroll(state.owner, input.pathSlug, new Date(at)));
    if (procedure === 'grantCert') {
      const alreadyGranted = store.listCerts(state.owner).some((g) => g.certId === input.certId);
      const grant = store.grant(state.owner, input.certId, new Date(at));
      return reply({
        grant,
        alreadyGranted,
        xp: await new NullCertXpPublisher().publishCertXp(grant),
        perks: { status: 'refuse', message: 'Identity rank unavailable', code: 'CERT_PERK_REFUSE' },
      });
    }
    return route.fulfill({
      status: 503,
      json: { error: { message: 'Isolated unconnected read', data: { cause: { code: 'SERVICE_UNAVAILABLE' } } } },
    });
  });
  return state;
}
async function login(page, path = originalPath) {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(base + path);
}
const receipt = (page) => page.getByRole('region', { name: 'Lesson completion receipt', exact: true });
const pathPanel = (page) =>
  page.locator('.if-panel').filter({ has: page.getByRole('heading', { name: 'Your learning path', exact: true }) });
async function review(page) {
  await page.getByRole('button', { name: 'Review lesson completion', exact: true }).click();
}
async function send(page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Record completion', exact: true }).click();
}
async function marker(page) {
  return page.evaluate((key) => localStorage.getItem(key), markerKey);
}
async function shot(page, name) {
  await page.screenshot({ path: evidence + '/' + name + '.png', fullPage: true });
}
async function viewLocale(context, locale) {
  const view = await context.newPage();
  await login(view, '/view');
  await view
    .locator('select')
    .filter({ has: view.locator('option[value="es"]') })
    .selectOption(locale);
  return view;
}
async function returnAcademy(page) {
  await page.locator('a[href="/more"]:visible').first().click();
  await page.locator('a[href="/academy"]').first().click();
}

const pending = (id = 'original-a', selected = certId) => ({
  id,
  title: 'Review certification grant',
  reference: `cert:${owner}:${selected}`,
});
async function seed(page, value) {
  await page.addInitScript(({ markerKey, value }) => localStorage.setItem(markerKey, value), { markerKey, value });
}
const originalCheck = (page) => page.getByRole('button', { name: 'Check original grant', exact: true });
async function retain(page, name, selector) {
  await expect(page.locator(selector)).toBeVisible();
  await page.evaluate(
    ({ name, selector }) => {
      const node = document.querySelector(selector);
      if (!node) throw Error('Missing source-derived control');
      const key = Object.keys(node).find((key) => key.startsWith('__reactProps'));
      window[name] = node[key].onClick;
    },
    { name, selector },
  );
}
async function grantReview(page) {
  await page.getByRole('button', { name: /^(Request certification|Recover certification award)$/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
const grantConfirm = (page) =>
  page.getByRole('dialog').getByRole('button', { name: /^(Request certification|Recover certification award)$/ });
test('actual guest Academy boundary sends no Academy request', async ({ page, context }) => {
  const state = await network(context);
  await page.goto(originalPath);
  await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
  await expect(page.locator('#main').getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute(
    'href',
    '/login?redirect=' + encodeURIComponent(originalPath),
  );
  expect(state.reads).toEqual([]);
  expect(state.writes).toEqual([]);
});
test('canonical grant original check survives definition and progress failure without POST', async ({ page, context }) => {
  const state = await network(context),
    raw = JSON.stringify(pending());
  await seed(page, raw);
  state.store.grant(owner, certId, new Date(at));
  state.certDefinitions = (route) => route.fulfill({ status: 503, json: { error: { message: 'Definitions unavailable' } } });
  state.certProgress = (route) => route.fulfill({ status: 503, json: { error: { message: 'Progress unavailable' } } });
  await login(page);
  await expect(originalCheck(page)).toBeVisible();
  await expect(page.locator('.academy-grant-original')).toContainText(certId);
  await originalCheck(page).click();
  await expect(page.getByRole('region', { name: 'Grant recorded', exact: true })).toContainText(at);
  expect(await marker(page)).toBe(null);
  expect(state.writes).toEqual([]);
  expect(state.reads.filter((r) => r.procedure === 'myCerts').map((r) => r.input.limit)).toContain(200);
  await expect(page.getByText('Original XP delivery remains unconfirmed.', { exact: true })).toBeVisible();
});
test('empty grant lookup retains original; deliberate current reread can prove it', async ({ page, context }) => {
  const state = await network(context),
    raw = JSON.stringify(pending());
  await seed(page, raw);
  await login(page);
  await originalCheck(page).click();
  await expect(page.locator('.academy-grant-original')).toContainText('No matching grant returned');
  expect(await marker(page)).toBe(raw);
  expect(state.writes).toEqual([]);
  state.store.grant(owner, certId, new Date(at));
  await originalCheck(page).click();
  await expect(page.getByRole('region', { name: 'Grant recorded', exact: true })).toBeVisible();
  expect(await marker(page)).toBe(null);
});
test('malformed finite-date and duplicate record replies never clear original or crash room', async ({ page, context }) => {
  const state = await network(context),
    raw = JSON.stringify(pending());
  await seed(page, raw);
  state.store.grant(owner, certId, new Date(at));
  state.myCerts = (_route, _input, reply) => reply([{ ...state.store.listCerts(owner)[0], grantedAt: '2026-10-10T08:00:00+24:00' }]);
  await login(page);
  await originalCheck(page).click();
  await expect(page.locator('.academy-grant-original')).toContainText('Original grant is not confirmed');
  expect(await marker(page)).toBe(raw);
  state.myCerts = (_route, _input, reply) => reply([state.store.listCerts(owner)[0], state.store.listCerts(owner)[0]]);
  await originalCheck(page).click();
  expect(await marker(page)).toBe(raw);
  expect(state.writes).toEqual([]);
});
test('unknown non-grant Academy bytes cannot gain grant recovery or release admission', async ({ page, context }) => {
  const state = await network(context),
    raw = JSON.stringify({ id: 'old-room', title: 'Earlier room request', reference: 'room:original' });
  await seed(page, raw);
  state.store.grant(owner, certId, new Date(at));
  await login(page);
  await expect(originalCheck(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review enrolment', exact: true })).toBeDisabled();
  expect(await marker(page)).toBe(raw);
  expect(state.writes).toEqual([]);
});
for (const fault of ['getItem', 'setItem', 'silent-setItem'])
  test(`native ${fault} failure refuses grant submission`, async ({ page, context }) => {
    const state = await network(context);
    await page.addInitScript((fault) => {
      const original = Storage.prototype[fault === 'silent-setItem' ? 'setItem' : fault];
      Storage.prototype[fault === 'silent-setItem' ? 'setItem' : fault] = function (key, ...args) {
        if (key.startsWith('intafaced:more:pending:')) {
          if (fault === 'silent-setItem') return;
          throw Error('Isolated device refusal');
        }
        return original.call(this, key, ...args);
      };
    }, fault);
    await login(page);
    if (fault === 'getItem') await expect(page.getByRole('button', { name: 'Request certification', exact: true })).toBeDisabled();
    else {
      await grantReview(page);
      await grantConfirm(page).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    expect(state.writes).toEqual([]);
  });
test('grant known proof survives cleanup and independent list failure; local retry sends no API', async ({ page, context }) => {
  const state = await network(context),
    raw = JSON.stringify(pending());
  await seed(page, raw);
  state.store.grant(owner, certId, new Date(at));
  await login(page);
  await page.evaluate(() => {
    const old = Storage.prototype.removeItem;
    window.cleanBlocked = true;
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith('intafaced:more:pending:') && window.cleanBlocked) throw Error('Isolated remove refusal');
      return old.call(this, key);
    };
  });
  await originalCheck(page).click();
  await expect(page.getByRole('region', { name: 'Grant recorded', exact: true })).toContainText(at);
  state.myCerts = (route) => route.fulfill({ status: 503, json: { error: { message: 'Records temporarily unavailable' } } });
  await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Grant recorded', exact: true })).toContainText(at);
  await page.evaluate(() => (window.cleanBlocked = false));
  const reads = state.reads.length;
  await page.getByRole('button', { name: 'Retry device cleanup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry device cleanup', exact: true })).toHaveCount(0);
  expect(state.reads.length).toBe(reads);
  expect(await marker(page)).toBe(null);
  expect(state.writes).toEqual([]);
});
test('retained original A Check cannot read or clear later marker B with the same canonical reference', async ({ page, context }) => {
  const state = await network(context);
  await seed(page, JSON.stringify(pending()));
  state.store.grant(owner, certId, new Date(at));
  await login(page);
  await retain(page, 'oldCheck', '.academy-grant-original button');
  await originalCheck(page).click();
  await expect(page.getByRole('region', { name: 'Grant recorded', exact: true })).toBeVisible();
  state.grantCert = (route) => route.fulfill({ status: 503, json: { error: { message: 'Lost grant reply' } } });
  await grantReview(page);
  await grantConfirm(page).click();
  await expect(originalCheck(page)).toBeVisible();
  const rawB = await marker(page),
    reads = state.reads.length;
  expect(JSON.parse(rawB).reference).toBe(pending().reference);
  expect(JSON.parse(rawB).id).not.toBe('original-a');
  await page.evaluate(() => window.oldCheck());
  await page.waitForTimeout(100);
  expect(state.reads.length).toBe(reads);
  expect(await marker(page)).toBe(rawB);
  await originalCheck(page).click();
  await expect(page.getByRole('region', { name: 'Grant recorded', exact: true })).toBeVisible();
  expect(await marker(page)).toBe(null);
  expect(state.writes.filter((r) => r.procedure === 'grantCert')).toHaveLength(1);
});
test('retained review A Confirm and Close cannot dispatch or dismiss current B', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await grantReview(page);
  await retain(page, 'oldConfirm', 'dialog .actions button:last-child');
  await retain(page, 'oldClose', 'dialog > header button');
  await page.getByRole('dialog').getByRole('button', { name: 'Back', exact: true }).click();
  await grantReview(page);
  await page.evaluate(() => {
    window.oldConfirm();
    window.oldClose();
  });
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(state.writes).toEqual([]);
  await grantConfirm(page).click();
  await expect.poll(() => state.writes.filter((r) => r.procedure === 'grantCert').length).toBe(1);
});
test('observed full URL away-and-back retires retained grant Confirm in the same task', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await grantReview(page);
  await retain(page, 'oldConfirm', 'dialog .actions button:last-child');
  await page.evaluate(() => {
    const href = location.href;
    history.replaceState(null, '', href + '&departed=1#other');
    dispatchEvent(new PopStateEvent('popstate'));
    history.replaceState(null, '', href);
    dispatchEvent(new HashChangeEvent('hashchange'));
    window.oldConfirm();
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.writes).toEqual([]);
  await grantReview(page);
  await grantConfirm(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
});
test('same-task selected certificate ABA cannot revive retired A; current review remains usable', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await grantReview(page);
  await retain(page, 'oldConfirm', 'dialog .actions button:last-child');
  await page.getByRole('dialog').getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Learning', exact: true }).click();
  const selection = page.getByRole('combobox', { name: 'Published certificate', exact: true });
  await expect(selection).toBeVisible();
  await selection.evaluate((node, certId) => {
    const key = Object.keys(node).find((k) => k.startsWith('__reactProps'));
    const change = node[key].onChange;
    change({ target: { value: '' } });
    change({ target: { value: certId } });
    window.oldConfirm();
  }, certId);
  expect(state.writes).toEqual([]);
  await page.getByRole('button', { name: 'Certificates', exact: true }).click();
  await grantReview(page);
  await grantConfirm(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
});
test('qualified mounted parent selection callback ABA retires held grant; current published review works', async ({ page, context }) => {
  // Only one certificate is published. This probes the actual mounted parent
  // callback, not a second public option or an ordinary pointer selection flow.
  const state = await network(context);
  await login(page);
  await page
    .locator('.if-panel')
    .filter({ has: page.getByRole('heading', { name: 'Certificate paths', exact: true }) })
    .getByRole('button', { name: /^Open/ })
    .first()
    .evaluate((node, certId) => {
      const key = Object.keys(node).find((key) => key.startsWith('__reactFiber'));
      let fiber = node[key];
      while (fiber && !(typeof fiber.memoizedProps?.setSelected === 'function' && fiber.memoizedProps?.action?.grantApi))
        fiber = fiber.return;
      if (!fiber || fiber.memoizedProps.selected !== certId) throw Error('Missing actual Certificates parent callback');
      window.currentCertificateSelection = fiber.memoizedProps.setSelected;
    }, certId);
  await grantReview(page);
  await retain(page, 'oldConfirm', 'dialog .actions button:last-child');
  let release;
  state.certProgress = async (_route, input, reply) => {
    await new Promise((done) => (release = done));
    return reply(state.store.progressOf(owner, input.certId));
  };
  await grantConfirm(page).click();
  await expect.poll(() => typeof release).toBe('function');
  const beforeUrl = page.url();
  await page.evaluate((certId) => {
    window.currentCertificateSelection('');
    window.currentCertificateSelection(certId);
    window.oldConfirm();
  }, certId);
  delete state.certProgress;
  release();
  await expect(page.getByRole('button', { name: 'Request certification', exact: true })).toBeEnabled();
  expect(page.url()).toBe(beforeUrl);
  expect(state.writes).toEqual([]);
  expect(await marker(page)).toBe(null);
  await grantReview(page);
  await grantConfirm(page).click();
  await expect.poll(() => state.writes.filter((row) => row.procedure === 'grantCert').length).toBe(1);
});
test('native grant lease prevents retained enrolment Confirm in another same-owner tab', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  const other = await context.newPage();
  await login(other);
  await other.getByRole('button', { name: 'Review enrolment', exact: true }).click();
  await retain(other, 'enrolConfirm', 'dialog .actions button:last-child');
  await grantReview(page);
  let release;
  state.certProgress = async (_route, input, reply) => {
    await new Promise((done) => (release = done));
    return reply(state.store.progressOf(owner, input.certId));
  };
  await grantConfirm(page).click();
  await expect.poll(() => typeof release).toBe('function');
  expect(await page.evaluate(() => navigator.locks.query())).toMatchObject({ held: [{ name: `more-action:${markerKey}` }] });
  await other.evaluate(() => window.enrolConfirm());
  expect(state.writes).toEqual([]);
  delete state.certProgress;
  release();
  await expect.poll(() => state.writes.length).toBe(1);
  await other.getByRole('button', { name: 'Review enrolment', exact: true }).click();
  await other.getByRole('dialog').getByRole('button', { name: 'Enrol in path', exact: true }).click();
  await expect.poll(() => state.writes.some((r) => r.procedure === 'enrollCertPath')).toBe(true);
});
test('originating tab closes after dispatched grant; independent tab reads original business record without replay', async ({
  page,
  context,
}) => {
  const state = await network(context);
  await login(page);
  await grantReview(page);
  let received = false;
  state.grantCert = async (route, input, reply) => {
    state.store.grant(owner, input.certId, new Date(at));
    received = true;
    await new Promise((done) => setTimeout(done, 150));
    if (!route.request().frame().page().isClosed()) return reply({});
  };
  await grantConfirm(page).click();
  await expect.poll(() => received).toBe(true);
  const raw = await marker(page);
  await page.close();
  const other = await context.newPage();
  await login(other);
  expect(await marker(other)).toBe(raw);
  await originalCheck(other).click();
  await expect(other.getByRole('region', { name: 'Grant recorded', exact: true })).toContainText(at);
  expect(await marker(other)).toBe(null);
  expect(state.writes.filter((r) => r.procedure === 'grantCert')).toHaveLength(1);
});
test('held original history after navigation cannot clean or publish; current return Check succeeds', async ({ page, context }) => {
  const state = await network(context),
    raw = JSON.stringify(pending());
  await seed(page, raw);
  state.store.grant(owner, certId, new Date(at));
  await login(page);
  let release;
  state.myCerts = async (_route, input, reply) => {
    if (input.limit === 200) await new Promise((done) => (release = done));
    return reply(state.store.listCerts(owner));
  };
  await originalCheck(page).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.locator('.academy-grant-original a[href="/support"]').click();
  release();
  expect(await marker(page)).toBe(raw);
  delete state.myCerts;
  await returnAcademy(page);
  await page.getByRole('button', { name: 'Certificates', exact: true }).click();
  await originalCheck(page).click();
  await expect(page.getByRole('region', { name: 'Grant recorded', exact: true })).toBeVisible();
  expect(await marker(page)).toBe(null);
  expect(state.writes).toEqual([]);
});
test('records 401 returns through Login and Register with exact query and hash', async ({ page, context }) => {
  const state = await network(context),
    path = originalPath + '&window=50#record';
  state.myCerts = (route) => route.fulfill({ status: 401, json: { error: { message: 'Sign in again' } } });
  await login(page, path);
  await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
  await page.locator('#main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?/);
  expect(new URL(page.url()).searchParams.get('redirect')).toBe(path);
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  expect(new URL(page.url()).searchParams.get('redirect')).toBe(path);
  delete state.myCerts;
  await page.locator('a[href^="/login?redirect="]').first().click();
  expect(new URL(page.url()).searchParams.get('redirect')).toBe(path);
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page).toHaveURL(base + path);
  await expect(page.getByRole('region', { name: 'Grant records', exact: true })).toBeVisible();
});
for (const locale of ['en', 'es', 'fr'])
  for (const width of [320, 390])
    test(`${locale} ${width}px original references and records fit with keyboard read controls`, async ({ page, context }) => {
      const state = await network(context);
      await page.setViewportSize({ width, height: 950 });
      await page.addInitScript(
        (locale) => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language: locale })),
        locale,
      );
      await seed(page, JSON.stringify(pending('original-long', 'x'.repeat(64))));
      await login(page);
      const button = page.locator('.academy-grant-original button');
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.academy-grant-original')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(state.writes).toEqual([]);
      await shot(page, `original-${locale}-${width}`);
    });
