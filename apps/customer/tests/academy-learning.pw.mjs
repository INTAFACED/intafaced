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
const evidence = process.env.ACADEMY_EVIDENCE || '/tmp/academy-learning-proof';
mkdirSync(evidence, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
const certId = 'foundations-v1',
  slug = 'foundations-position-sizing',
  next = 'foundations-journal-discipline';
const at = '2026-10-10T09:41:00.000Z',
  markerKey = `intafaced:more:pending:${owner}:academy`;
const originalPath = `/academy/${slug}?cert=${certId}`;
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
  for (const required of listCertCatalog()[0].requiredItemSlugs.slice(0, 3))
    store.markComplete(owner, required, new Date('2026-10-09T08:00:00Z'));
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
  await expect(page).toHaveURL('http://127.0.0.1:3234' + path);
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

test('native published certificate to original required lesson to durable receipt and next lesson', async ({ page, context }) => {
  const state = await network(context);
  await login(page, '/academy?section=certificates');
  await page.getByRole('button', { name: /Open Foundations/ }).click();
  await page.getByRole('link', { name: 'Read next required lesson', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/academy/${slug}\\?cert=${certId}$`));
  await expect(pathPanel(page)).toContainText('3 of 7 required lessons recorded');
  await expect(pathPanel(page).locator('li[aria-current="step"]')).toContainText('Still required');
  await expect(page.locator('article.more-body')).toContainText('Size is the output, not an input');
  await expect(page.locator('article.more-body')).toHaveAttribute('lang', 'en');
  await review(page);
  expect(state.writes).toEqual([]);
  await expect(page.getByRole('dialog')).toContainText(slug);
  await send(page);
  await expect(receipt(page)).toContainText(at);
  await expect(receipt(page)).toContainText(owner);
  await expect(pathPanel(page)).toContainText('4 of 7 required lessons recorded');
  await expect(pathPanel(page).locator('li[aria-current="step"]')).toContainText('Recorded');
  expect(state.writes).toEqual([{ procedure: 'markCurriculumComplete', input: { itemSlug: slug } }]);
  expect(await marker(page)).toBeNull();
  await shot(page, 'completion-desktop');
  await pathPanel(page).getByRole('link', { name: 'Return to certificate', exact: true }).click();
  await expect(page.locator('.if-panel').filter({ has: page.getByRole('heading', { name: 'Your progress', exact: true }) })).toContainText(
    '4 of 7',
  );
  await page.getByRole('link', { name: 'Read next required lesson', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(next + '\\?cert=' + certId + '$'));
  await expect(pathPanel(page)).toContainText('4 of 7 required lessons recorded');
  await page.goBack();
  await expect(page.locator('.if-panel').filter({ has: page.getByRole('heading', { name: 'Your progress', exact: true }) })).toContainText(
    '4 of 7',
  );
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(next + '\\?cert=' + certId + '$'));
  expect(state.writes).toHaveLength(1);
});
test('native repeat confirmed canonical completion retains first timestamp without grade or XP', async ({ page, context }) => {
  const state = await network(context);
  state.store.markComplete(owner, slug, new Date('2026-10-08T11:12:13Z'));
  await login(page);
  await review(page);
  await send(page);
  await expect(receipt(page)).toContainText('2026-10-08T11:12:13.000Z');
  await expect(receipt(page)).toContainText('It does not confirm mastery, a certificate or XP');
  expect(state.writes.filter((r) => r.procedure === 'grantCert')).toEqual([]);
});
test('native standalone real lesson remains readable and completable without enrollment or invented certificate', async ({
  page,
  context,
}) => {
  const state = await network(context);
  await login(page, '/academy/markets-reading-the-book');
  await expect(page.locator('article.more-body')).toBeVisible();
  await review(page);
  await send(page);
  await expect(receipt(page)).toBeVisible();
  expect(state.writes.map((r) => r.procedure)).toEqual(['markCurriculumComplete']);
  expect(state.reads.filter((r) => r.procedure === 'certProgress')).toEqual([]);
  await page.getByRole('link', { name: 'Return to library', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:3234/academy?path=markets');
  await expect(page.getByRole('combobox', { name: 'Learning path', exact: true })).toHaveValue('markets');
});
test('native bounded filtered discovery keeps actual library and selected certificate separate', async ({ page, context }) => {
  const state = await network(context);
  await login(page, '/academy');
  await page.getByRole('combobox', { name: 'Published certificate', exact: true }).selectOption(certId);
  await page.getByRole('combobox', { name: 'Learning path', exact: true }).selectOption('markets');
  await expect(page.locator('.more-room-link').first()).toHaveAttribute('href', /path=markets/);
  await expect(pathPanel(page)).toContainText('Position sizing without invent');
  expect(state.reads.filter((r) => r.procedure === 'curriculum').every((r) => r.input.limit > 0 && r.input.limit <= 200)).toBe(true);
  expect(state.writes).toEqual([]);
  await shot(page, 'discovery-library');
});
for (const part of ['owner', 'certificate', 'count', 'missing', 'ratio', 'grantKey'])
  test('native malformed original progress ' + part + ' hides private counts and next lesson', async ({ page, context }) => {
    const state = await network(context);
    state.certProgress = (route, input, reply) => {
      const p = state.store.progressOf(owner, input.certId);
      return reply({
        ...p,
        ...(part === 'owner'
          ? { userId: other }
          : part === 'certificate'
            ? { certId: 'wrong-cert' }
            : part === 'count'
              ? { completedCount: 8 }
              : part === 'missing'
                ? { missingItemSlugs: [slug, slug] }
                : part === 'ratio'
                  ? { ratio: '0.9999' }
                  : { granted: true, grantIdempotencyKey: `cert:${other}:${certId}` }),
      });
    };
    await login(page);
    await expect(pathPanel(page).getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect(pathPanel(page)).not.toContainText('3 of 7');
    await expect(pathPanel(page).getByRole('link', { name: 'Read next required lesson', exact: true })).toHaveCount(0);
    expect(state.writes).toEqual([]);
  });
test('native progress failure hides old counts and read-only retry restores current same certificate', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await expect(pathPanel(page)).toContainText('3 of 7');
  state.certProgress = (route) =>
    route.fulfill({
      status: 503,
      json: { error: { message: 'Progress store unavailable', data: { cause: { code: 'PROGRESS_READ_UNAVAILABLE' } } } },
    });
  await pathPanel(page).getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(pathPanel(page)).toContainText('Progress store unavailable');
  await expect(pathPanel(page)).not.toContainText('3 of 7');
  delete state.certProgress;
  await pathPanel(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(pathPanel(page)).toContainText('3 of 7');
  expect(state.writes).toEqual([]);
  await shot(page, 'progress-retry');
});
test('native empty published definitions do not create a new certificate', async ({ page, context }) => {
  const state = await network(context, { definitions: [] });
  await login(page, '/academy');
  await expect(pathPanel(page)).toContainText('No certificate is published for this learning path');
  await expect(page.locator('.more-room-link').first()).toBeVisible();
  expect(state.writes).toEqual([]);
});
test('native wrong original lesson slug prevents reading or completion', async ({ page, context }) => {
  const state = await network(context, { curriculumItemLocalized: (route, input, reply) => reply(lesson({ ...input, slug: next })) });
  await login(page);
  await expect(page.locator('.academy-learning-reader')).toContainText('could not be verified');
  await expect(page.getByRole('button', { name: 'Review lesson completion', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
test('native fresh original lesson content change refuses completion before POST', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await review(page);
  state.curriculumItemLocalized = (route, input, reply) =>
    reply({ ...lesson(input), body: lesson(input).body + '\nChanged real-content revision' });
  await send(page);
  await expect(
    page.getByText('The original lesson could not be verified. No completion was sent. Refresh the lesson before reviewing again.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(await marker(page)).toBeNull();
});
for (const part of ['owner', 'slug', 'timestamp'])
  test('native impossible completion receipt ' + part + ' preserves original unknown request', async ({ page, context }) => {
    const state = await network(context, {
      markCurriculumComplete: (route, input, reply) =>
        reply({
          userId: part === 'owner' ? other : owner,
          itemSlug: part === 'slug' ? next : input.itemSlug,
          completedAt: part === 'timestamp' ? 'tomorrow' : at,
        }),
    });
    await login(page);
    await review(page);
    await send(page);
    await expect(page.getByRole('region', { name: 'Original completion is not confirmed', exact: true })).toBeVisible();
    const original = await marker(page);
    expect(original).not.toBeNull();
    await pathPanel(page).getByRole('button', { name: 'Refresh progress', exact: true }).click();
    await expect(pathPanel(page)).toContainText('3 of 7');
    expect(await marker(page)).toBe(original);
    await expect(receipt(page)).toHaveCount(0);
    expect(state.writes).toHaveLength(1);
  });
test('native uncertain completion survives canonical Support and original lesson return without replay', async ({ page, context }) => {
  const state = await network(context, {
    markCurriculumComplete: async (route, input) => {
      state.store.markComplete(owner, input.itemSlug, new Date(at));
      await route.abort('failed');
    },
  });
  await login(page);
  await review(page);
  await send(page);
  const recovery = page.getByRole('region', { name: 'Original completion is not confirmed', exact: true });
  await expect(recovery).toBeVisible();
  const original = await marker(page);
  await expect(recovery.getByRole('link', { name: 'Contact Support', exact: true })).toHaveAttribute('href', '/support');
  await recovery.getByRole('link', { name: 'Contact Support', exact: true }).click();
  await expect(page).toHaveURL(/\/support$/);
  expect(await marker(page)).toBe(original);
  await returnAcademy(page);
  await page.getByRole('link', { name: 'Return to original lesson', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/academy/${slug}\\?cert=${certId}$`));
  await expect(pathPanel(page)).toContainText('4 of 7');
  await expect(receipt(page)).toHaveCount(0);
  await pathPanel(page).getByRole('button', { name: 'Refresh progress', exact: true }).click();
  expect(await marker(page)).toBe(original);
  await expect(page.getByRole('button', { name: 'Review lesson completion', exact: true })).toBeDisabled();
  expect(state.writes).toEqual([{ procedure: 'markCurriculumComplete', input: { itemSlug: slug } }]);
  await shot(page, 'unknown-support-return');
});
test('native pre-existing different Academy unknown cannot be cleared or relabeled as completion', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  const original = JSON.stringify({ id: 'original-academy-enrollment', title: 'Original enrollment', reference: 'enrollment:foundations' });
  await page.evaluate(({ key, original }) => localStorage.setItem(key, original), { key: markerKey, original });
  await returnAcademy(page);
  await expect(page.getByRole('alert')).toContainText('Original enrollment');
  await expect(page.getByRole('region', { name: 'Original completion is not confirmed', exact: true })).toHaveCount(0);
  expect(await marker(page)).toBe(original);
  expect(state.writes).toEqual([]);
});
test('native typed completion refusal stays distinct from unknown and allows original review retry', async ({ page, context }) => {
  const state = await network(context, {
    markCurriculumComplete: (route) =>
      route.fulfill({
        status: 403,
        json: { error: { message: 'Academy write permission required', data: { cause: { code: 'FORBIDDEN' } } } },
      }),
  });
  await login(page);
  await review(page);
  await send(page);
  await expect(page.getByText('Academy write permission required', { exact: true })).toBeVisible();
  expect(await marker(page)).toBeNull();
  await expect(receipt(page)).toHaveCount(0);
  delete state.markCurriculumComplete;
  await review(page);
  await send(page);
  await expect(receipt(page)).toContainText(at);
  expect(state.writes).toHaveLength(2);
});
for (const locale of ['es', 'fr'])
  test(
    'native open completion review follows View ' + locale + ' while original lesson stays English and exact',
    async ({ page, context }) => {
      const state = await network(context);
      await login(page);
      await review(page);
      await viewLocale(context, locale);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toHaveAccessibleName(locale === 'es' ? 'Revisar finalización de la lección' : 'Examiner la fin de leçon');
      await expect(dialog.getByText(slug, { exact: true })).toHaveAttribute('lang', 'zxx');
      await expect(page.locator('article.more-body')).toHaveAttribute('lang', 'en');
      await expect(page.locator('article.more-body')).toContainText('Size is the output, not an input');
      await shot(page, 'review-' + locale);
      await dialog.locator('.actions button').last().click();
      await expect.poll(() => state.writes.length).toBe(1);
      expect(state.writes).toEqual([{ procedure: 'markCurriculumComplete', input: { itemSlug: slug } }]);
      await expect(
        page.getByRole('region', { name: locale === 'es' ? 'Recibo de finalización de la lección' : 'Reçu de fin de leçon', exact: true }),
      ).toContainText(at);
    },
  );
for (const width of [320, 390, 768])
  test('native phone readable lesson receipt targets and keyboard ' + width, async ({ page, context }) => {
    const state = await network(context);
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    const reviewButton = page.getByRole('button', { name: 'Review lesson completion', exact: true });
    for (let n = 0; n < 75 && !(await reviewButton.evaluate((el) => el === document.activeElement)); n++) await page.keyboard.press('Tab');
    await expect(reviewButton).toBeFocused();
    expect((await reviewButton.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await send(page);
    await expect(receipt(page)).toContainText(at);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const refresh = pathPanel(page).getByRole('button', { name: 'Refresh progress', exact: true });
    expect((await refresh.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await refresh.focus();
    await page.keyboard.press('Enter');
    await expect(pathPanel(page)).toContainText('4 of 7');
    await expect(pathPanel(page).getByRole('link', { name: 'Read next required lesson', exact: true })).toBeVisible();
    expect(await page.locator('article.more-body').evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');
    expect(await page.locator('article.more-body').evaluate((element) => getComputedStyle(element).lineHeight)).toBe('26px');
    await shot(page, 'completion-phone-' + width);
    expect(state.writes).toHaveLength(1);
  });
test('native private guest boundary performs no Academy reads or writes', async ({ page, context }) => {
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
test('native session loss mid successful fresh read sends no completion and hides private original context', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await review(page);
  let release;
  state.curriculumItemLocalized = async (route, input, reply) => {
    await new Promise((done) => (release = done));
    return reply(lesson(input));
  };
  await send(page);
  await expect.poll(() => typeof release).toBe('function');
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  release();
  await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  await expect(page.locator('article.more-body')).toHaveCount(0);
});
test('native owner switch cannot display prior account progress or receipt', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await review(page);
  await send(page);
  await expect(receipt(page)).toBeVisible();
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  state.owner = other;
  await login(page);
  await expect(pathPanel(page)).toContainText('0 of 7');
  await expect(receipt(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('native incomplete certificate remains manual and XP unavailable does not undo a durable grant', async ({ page, context }) => {
  const state = await network(context);
  await login(page, `/academy?cert=${certId}&section=certificates`);
  await expect(page.getByRole('button', { name: 'Request certification', exact: true })).toBeDisabled();
  expect(state.writes).toEqual([]);
  listCertCatalog()[0].requiredItemSlugs.forEach((s) => state.store.markComplete(owner, s, new Date(at)));
  await returnAcademy(page);
  await page.getByRole('button', { name: 'Certificates', exact: true }).click();
  await page.getByRole('button', { name: 'Request certification', exact: true }).click();
  expect(state.writes).toEqual([]);
  await page.getByRole('dialog').getByRole('button', { name: 'Request certification', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Certification receipt', exact: true })).toContainText('publisher_unavailable');
  expect(state.store.listCerts(owner)).toHaveLength(1);
  expect(state.writes.map((r) => r.procedure)).toEqual(['grantCert']);
  await shot(page, 'grant-xp-unavailable');
});
test('native original-bound grant receipt rejects wrong account without clearing its journal', async ({ page, context }) => {
  const state = await network(context);
  listCertCatalog()[0].requiredItemSlugs.forEach((s) => state.store.markComplete(owner, s));
  state.grantCert = (route, input, reply) =>
    reply({
      grant: { userId: other, certId: input.certId, grantedAt: at, idempotencyKey: `cert:${other}:${input.certId}` },
      alreadyGranted: false,
      xp: { emitted: false, reason: 'publisher_unavailable' },
      perks: { status: 'refuse', message: 'Unknown', code: 'CERT_PERK_REFUSE' },
    });
  await login(page, `/academy?cert=${certId}&section=certificates`);
  await page.getByRole('button', { name: 'Request certification', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Request certification', exact: true }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  expect(await marker(page)).not.toBeNull();
  await expect(page.getByRole('region', { name: 'Certification receipt', exact: true })).toHaveCount(0);
});
test('native serious accessibility checks cover actual lesson and path', async ({ page, context }) => {
  await network(context);
  await login(page);
  await expect(page.locator('article.more-body')).toBeVisible();
  const result = await new AxeBuilder({ page }).include('.academy-learning-layout').analyze();
  expect(result.violations.filter((v) => ['critical', 'serious'].includes(v.impact))).toEqual([]);
  writeFileSync(evidence + '/axe.json', JSON.stringify(result, null, 2));
});

test('native late progress cannot restore a certificate the owner deselected', async ({ page, context }) => {
  const state = await network(context),
    releases = [];
  state.certProgress = async (route, input, reply) => {
    await new Promise((done) => releases.push(done));
    return reply(state.store.progressOf(owner, input.certId));
  };
  await login(page);
  await expect.poll(() => releases.length).toBeGreaterThan(0);
  await page.getByRole('combobox', { name: 'Published certificate', exact: true }).selectOption('');
  releases.forEach((done) => done());
  await expect(pathPanel(page)).toContainText('Choose a published certificate');
  await expect(pathPanel(page)).not.toContainText('3 of 7');
  await expect(pathPanel(page).getByRole('link', { name: 'Read next required lesson', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
test('native certificate change mid fresh lesson check refuses original completion before POST', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await review(page);
  let release;
  state.curriculumItemLocalized = async (route, input, reply) => {
    await new Promise((done) => (release = done));
    return reply(lesson(input));
  };
  await send(page);
  await expect.poll(() => typeof release).toBe('function');
  await page.getByRole('combobox', { name: 'Published certificate', exact: true }).selectOption('');
  release();
  await expect(
    page.getByText('The account, lesson or certificate changed. No completion was sent. Return to the original lesson and review again.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(await marker(page)).toBeNull();
});
test('native failed fresh original lesson read sends no POST and allows explicit retry', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await review(page);
  state.curriculumItemLocalized = (route) =>
    route.fulfill({
      status: 503,
      json: { error: { message: 'Original lesson read unavailable', data: { cause: { code: 'CURRICULUM_READ_UNAVAILABLE' } } } },
    });
  await send(page);
  await expect(page.getByText('Original lesson read unavailable', { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(await marker(page)).toBeNull();
  delete state.curriculumItemLocalized;
  await review(page);
  await send(page);
  await expect(receipt(page)).toContainText(at);
  expect(state.writes).toHaveLength(1);
});
for (const locale of ['es', 'fr'])
  test('native original-context storage refusal remains localizable after failure ' + locale, async ({ page, context }) => {
    const state = await network(context);
    await login(page);
    await review(page);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('intafaced:academy:original-completion:')) throw new Error('Isolated context-storage failure');
        return original.call(this, key, value);
      };
    });
    await send(page);
    await expect(page.getByText('The original lesson context could not be saved. No completion was sent.', { exact: true })).toBeVisible();
    expect(state.writes).toEqual([]);
    expect(await marker(page)).toBeNull();
    await viewLocale(context, locale);
    const message =
      locale === 'es'
        ? 'No se pudo guardar el contexto de la lección original. No se envió ninguna finalización.'
        : locale === 'fr'
          ? 'Le contexte de la leçon d’origine n’a pas pu être enregistré. Aucune fin de leçon n’a été envoyée.'
          : 'The original lesson context could not be saved. No completion was sent.';
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    expect(await page.getByText(message, { exact: true }).evaluate((element) => element.closest('[lang]').lang)).toBe(locale);
    await expect(page.locator('article.more-body')).toHaveAttribute('lang', 'en');
    expect(state.writes).toEqual([]);
  });
for (const locale of ['es', 'fr'])
  test('native localized unknown Support action preserves exact original marker ' + locale, async ({ page, context }) => {
    const state = await network(context, { markCurriculumComplete: (route) => route.abort('failed') });
    await login(page);
    await review(page);
    await send(page);
    await expect(page.getByRole('region', { name: 'Original completion is not confirmed', exact: true })).toBeVisible();
    const original = await marker(page);
    await viewLocale(context, locale);
    const support = locale === 'es' ? 'Contactar con soporte' : 'Contacter l’assistance';
    await expect(page.getByRole('link', { name: support, exact: true })).toHaveAttribute('href', '/support');
    await expect(page.getByText(slug, { exact: true }).first()).toHaveAttribute('lang', 'zxx');
    await page.getByRole('link', { name: support, exact: true }).click();
    await expect(page).toHaveURL(/\/support$/);
    expect(await marker(page)).toBe(original);
    await returnAcademy(page);
    await page
      .getByRole('link', { name: locale === 'es' ? 'Volver a la lección original' : 'Revenir à la leçon d’origine', exact: true })
      .click();
    expect(await marker(page)).toBe(original);
    expect(state.writes).toHaveLength(1);
    await shot(page, 'unknown-' + locale);
  });
test('native fresh incomplete certificate blocks a previously eligible grant without POST', async ({ page, context }) => {
  const state = await network(context);
  listCertCatalog()[0].requiredItemSlugs.forEach((s) => state.store.markComplete(owner, s));
  await login(page, `/academy?cert=${certId}&section=certificates`);
  await page.getByRole('button', { name: 'Request certification', exact: true }).click();
  const incomplete = new MemoryCertStore();
  incomplete.registerCert(listCertCatalog()[0]);
  state.certProgress = (route, input, reply) => reply(incomplete.progressOf(owner, input.certId));
  await page.getByRole('dialog').getByRole('button', { name: 'Request certification', exact: true }).click();
  await expect(
    page.getByText('Certificate progress changed. No certification request was sent. Refresh this certificate and review again.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(await marker(page)).toBeNull();
});
for (const mode of ['published', 'failed', 'wrong-key'])
  test('native durable grant distinguishes XP publication ' + mode + ' from credit', async ({ page, context }) => {
    const state = await network(context),
      events = [];
    listCertCatalog()[0].requiredItemSlugs.forEach((s) => state.store.markComplete(owner, s));
    state.grantCert = async (route, input, reply) => {
      const grant = state.store.grant(owner, input.certId, new Date(at));
      const publisher = new BusCertXpPublisher({
        publish: async (event, payload, options) => {
          if (mode === 'failed') throw new Error('Isolated publisher failure');
          events.push({ event, payload, options });
        },
      });
      const xp = await publisher.publishCertXp(grant);
      return reply({
        grant,
        alreadyGranted: false,
        xp: mode === 'wrong-key' ? { ...xp, idempotencyKey: 'academy.cert:another-owner' } : xp,
        perks: { status: 'refuse', message: 'Identity rank unavailable', code: 'CERT_PERK_REFUSE' },
      });
    };
    await login(page, `/academy?cert=${certId}&section=certificates`);
    await page.getByRole('button', { name: 'Request certification', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Request certification', exact: true }).click();
    const result = page.getByRole('region', { name: 'Certification receipt', exact: true });
    if (mode === 'wrong-key') {
      await expect(page.getByRole('alert').first()).toBeVisible();
      expect(await marker(page)).not.toBeNull();
      await expect(result).toHaveCount(0);
    } else {
      await expect(result).toContainText(mode === 'failed' ? 'publish_failed' : '100 XP published');
      await expect(result).toContainText('XP publication does not confirm that Identity applied the award or changed your rank');
      expect(await marker(page)).toBeNull();
    }
    expect(state.store.listCerts(owner)).toHaveLength(1);
    expect(state.writes).toHaveLength(1);
    if (mode !== 'failed') expect(events[0].options.idempotencyKey).toBe(`academy.cert:cert:${owner}:${certId}`);
  });

test('native durable granted certificate can review same award while current lessons are incomplete', async ({ page, context }) => {
  const state = await network(context);
  const cert = listCertCatalog()[0];
  cert.requiredItemSlugs.forEach((s) => state.store.markComplete(owner, s));
  const grant = state.store.grant(owner, certId, new Date(at));
  state.certProgress = (route, input, reply) =>
    reply(progressReport({ userId: owner, cert, completedSlugs: new Set(), existingGrant: grant }));
  state.grantCert = async (route, input, reply) =>
    reply({
      ...decideGrant({ userId: owner, cert, completedSlugs: new Set(), existing: grant }),
      xp: await new NullCertXpPublisher().publishCertXp(grant),
      perks: { status: 'refuse', message: 'Identity rank unavailable', code: 'CERT_PERK_REFUSE' },
    });
  await login(page, `/academy?cert=${certId}&section=certificates`);
  const recovery = page.getByRole('button', { name: 'Recover certification award', exact: true });
  await expect(recovery).toBeEnabled();
  expect(state.writes).toEqual([]);
  await recovery.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Recover certification award', exact: true }).click();
  const result = page.getByRole('region', { name: 'Certification receipt', exact: true });
  await expect(result).toContainText(at);
  await expect(result).toContainText('publisher_unavailable');
  expect(state.writes).toEqual([{ procedure: 'grantCert', input: { certId } }]);
  expect(await marker(page)).toBeNull();
});

test('native closed tab during read preflight retains original owner lesson and certificate without POST', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await review(page);
  let release;
  state.curriculumItemLocalized = async (route, input, reply) => {
    await new Promise((done) => (release = done));
    if (!route.request().frame().page().isClosed()) return reply(lesson(input));
  };
  await send(page);
  await expect.poll(() => typeof release).toBe('function');
  const original = await marker(page);
  expect(original).not.toBeNull();
  await page.close();
  delete state.curriculumItemLocalized;
  const reopened = await context.newPage();
  await login(reopened, '/academy');
  release();
  const recovery = reopened.getByRole('region', { name: 'Original completion is not confirmed', exact: true });
  await expect(recovery).toContainText(slug);
  await expect(recovery).toContainText(certId);
  expect(await marker(reopened)).toBe(original);
  await recovery.getByRole('link', { name: 'Return to original lesson', exact: true }).click();
  await expect(reopened).toHaveURL(new RegExp('/academy/' + slug + '\\?cert=' + certId + '$'));
  await expect(pathPanel(reopened)).toContainText('3 of 7');
  await pathPanel(reopened).getByRole('button', { name: 'Refresh progress', exact: true }).click();
  await expect(pathPanel(reopened)).toContainText('3 of 7');
  expect(await marker(reopened)).toBe(original);
  expect(state.writes).toEqual([]);
});

test('native leaving Learning during successful fresh check sends no completion', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await review(page);
  let release,
    held = false;
  state.curriculumItemLocalized = async (route, input, reply) => {
    if (!held) {
      held = true;
      await new Promise((done) => (release = done));
    }
    return reply(lesson(input));
  };
  await send(page);
  await expect.poll(() => typeof release).toBe('function');
  await page.getByRole('button', { name: 'Certificates', exact: true }).click();
  await page.getByRole('button', { name: 'Learning', exact: true }).click();
  await page.getByRole('combobox', { name: 'Published certificate', exact: true }).selectOption('');
  release();
  await expect(
    page.getByText('The account, lesson or certificate changed. No completion was sent. Return to the original lesson and review again.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(await marker(page)).toBeNull();
});
test('native leaving Certificates during successful fresh progress sends no grant', async ({ page, context }) => {
  const state = await network(context);
  listCertCatalog()[0].requiredItemSlugs.forEach((s) => state.store.markComplete(owner, s));
  await login(page, `/academy?cert=${certId}&section=certificates`);
  await page.getByRole('button', { name: 'Request certification', exact: true }).click();
  let release,
    held = false;
  state.certProgress = async (route, input, reply) => {
    if (!held) {
      held = true;
      await new Promise((done) => (release = done));
    }
    return reply(state.store.progressOf(owner, input.certId));
  };
  await page.getByRole('dialog').getByRole('button', { name: 'Request certification', exact: true }).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.getByRole('button', { name: 'Learning', exact: true }).click();
  await page.getByRole('combobox', { name: 'Published certificate', exact: true }).selectOption('');
  release();
  await expect(page.getByRole('status').filter({ hasText: 'pending request changed' })).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(await marker(page)).toBeNull();
});

for (const section of ['Learning', 'Certificates'])
  for (const mode of ['held', 'failed', 'empty'])
    test(`native preselected ${section} waits for ${mode} definitions before interpreting contradictory progress`, async ({
      page,
      context,
    }) => {
      const state = await network(context);
      let release;
      state.certDefinitions = async (route, input, reply) => {
        if (mode === 'held') await new Promise((done) => (release = done));
        if (mode === 'failed')
          return route.fulfill({
            status: 503,
            json: { error: { message: 'Published definitions unavailable', data: { cause: { code: 'SERVICE_UNAVAILABLE' } } } },
          });
        return reply(mode === 'empty' ? [] : state.definitions);
      };
      state.certProgress = (route, input, reply) =>
        reply({
          ...state.store.progressOf(owner, input.certId),
          requiredCount: 2,
          completedCount: 1,
          ratio: '0.5000',
          missingItemSlugs: ['outside-published-definition'],
          complete: false,
        });
      await login(page, `/academy?cert=${certId}${section === 'Certificates' ? '&section=certificates' : ''}`);
      const panel =
        section === 'Learning'
          ? pathPanel(page)
          : page.locator('.if-panel').filter({ has: page.getByRole('heading', { name: 'Your progress', exact: true }) });
      const definitionsPanel =
        section === 'Learning'
          ? pathPanel(page)
          : page.locator('.if-panel').filter({ has: page.getByRole('heading', { name: 'Certificate paths', exact: true }) });
      if (mode === 'held') await expect.poll(() => typeof release).toBe('function');
      else if (mode === 'failed') await expect(definitionsPanel).toContainText('Published definitions unavailable');
      else
        await expect(definitionsPanel).toContainText(
          section === 'Learning' ? 'No certificate is published for this learning path' : 'No certificate paths are published',
        );
      expect(state.reads.filter((r) => r.procedure === 'certProgress')).toEqual([]);
      await expect(panel).not.toContainText('1 of 2');
      await expect(panel).not.toContainText('outside-published-definition');
      await expect(page.getByRole('link', { name: 'Read next required lesson', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Request certification', exact: true })).toHaveCount(0);
      expect(state.writes).toEqual([]);
      delete state.certDefinitions;
      if (mode === 'held') release();
      else if (mode === 'failed') await definitionsPanel.getByRole('button', { name: 'Try again', exact: true }).click();
      else {
        await page.getByRole('button', { name: section === 'Learning' ? 'Certificates' : 'Learning', exact: true }).click();
        await page.getByRole('button', { name: section, exact: true }).click();
      }
      await expect(panel.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
      await expect(panel).not.toContainText('1 of 2');
      await expect(panel).not.toContainText('outside-published-definition');
      await expect(page.getByRole('button', { name: 'Request certification', exact: true })).toHaveCount(0);
      delete state.certProgress;
      await panel.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(panel).toContainText('3 of 7');
      expect(state.writes).toEqual([]);
    });
test('native unpublished URL certificate cannot interpret complete progress or offer a grant', async ({ page, context }) => {
  const state = await network(context);
  state.certProgress = (route, input, reply) =>
    reply({
      ...state.store.progressOf(owner, certId),
      certId: input.certId,
      requiredCount: 2,
      completedCount: 2,
      ratio: '1.0000',
      missingItemSlugs: [],
      complete: true,
    });
  await login(page, '/academy?cert=unpublished&section=certificates');
  await expect(page.getByRole('button', { name: /Open Foundations/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request certification', exact: true })).toHaveCount(0);
  expect(state.reads.filter((r) => r.procedure === 'certProgress')).toEqual([]);
  await page.getByRole('button', { name: 'Learning', exact: true }).click();
  await expect(page.locator('.more-room-link').first()).toBeVisible();
  await expect(pathPanel(page)).not.toContainText('2 of 2');
  await expect(pathPanel(page).getByRole('link', { name: 'Read next required lesson', exact: true })).toHaveCount(0);
  expect(state.reads.filter((r) => r.procedure === 'certProgress')).toEqual([]);
  expect(state.writes).toEqual([]);
});
