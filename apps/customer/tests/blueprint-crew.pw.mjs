import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const evidence = process.env.CREW_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111',
  peer = '22222222-2222-4222-8222-222222222222',
  crewId = '33333333-3333-4333-8333-333333333333';
const time = '2026-10-10T12:00:00Z';
const svg = readFileSync(process.env.CREW_SAMPLE_DIR + '/sample-portrait.svg', 'utf8');
const profile = {
  id: crewId,
  userId: owner,
  engineVersion: 'qualified-fixture',
  visibility: 'private',
  cardAssetUrl: null,
  createdAt: time,
  profile: {
    decisionStyle: 'analytical',
    riskTemperament: 'measured',
    energyRhythm: 'steady',
    learningMode: 'visual',
    crewRole: 'anchor',
    curriculumPath: 'foundations',
    toneRegister: 'warm',
    guardrails: { maxLeverage: 1, dailyLossPromptPct: 5, confirmBeforeMarketOrder: true, copyTradingVisible: false },
  },
};
const card = {
  size: 'portrait',
  width: 1080,
  height: 1350,
  svg,
  shareMode: 'png',
  raster: { status: 'rendered', url: 'https://crew-fixture.invalid/private.png', contentType: 'image/png', bytes: 1 },
};
const record = (extra = {}) => ({
  schemaVersion: 2,
  exportedAt: time,
  blueprint: profile,
  card,
  crew: { id: crewId, name: 'Northline', formedAt: time, season: 4, xp: '-9007199254740993', lobbyId: null, capacity: 6 },
  membership: { userId: owner, crewId, role: 'builder', joinedAt: time },
  crewmates: [{ userId: peer, role: 'scout', joinedAt: time }],
  matchRuns: [{ id: crewId, candidates: [], scores: [], placedCrewId: peer, ts: time }],
  mentorMatches: [],
  mentoringOthers: [],
  shares: [],
  cardsOpened: [],
  ...extra,
});
const reply = (route, data) => route.fulfill({ status: 200, json: { result: { data } } });
const fail = (route, status) =>
  route.fulfill({ status, json: { error: { message: 'Qualified isolated refusal', data: { code: 'QUALIFIED_FIXTURE' } } } });
const errors = new WeakMap(),
  summary = [];
test.beforeEach(async ({ context }) => {
  const list = [];
  errors.set(context, list);
  context.on('page', (page) => page.on('pageerror', (error) => list.push(error.message)));
  context.pages().forEach((page) => page.on('pageerror', (error) => list.push(error.message)));
  await context.addInitScript(() => {
    window.__crewObjects = 0;
    window.__crewReleases = [];
    const originalObject = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (...args) => {
      window.__crewObjects++;
      return originalObject(...args);
    };
    const originalFetch = window.fetch;
    window.fetch = async function (input, options) {
      const url = typeof input === 'string' ? input : input.url;
      const isCrew = new URL(url, location.href).pathname.endsWith('/export');
      const response = await originalFetch.call(
        this,
        input,
        isCrew && window.__ignoreCrewAbort ? { ...options, signal: undefined } : options,
      );
      if (isCrew && window.__holdCrewParser) {
        const parse = response.text.bind(response);
        response.text = async () => {
          const body = await parse();
          await new Promise((resolve) => window.__crewReleases.push(resolve));
          return body;
        };
      }
      return response;
    };
  });
});
test.afterEach(async ({ context }, info) => {
  expect(errors.get(context)).toEqual([]);
  summary.push({ name: info.title, status: info.status, pageErrors: errors.get(context) });
});
test.afterAll(() => writeFileSync(evidence + '/native-summary.json', JSON.stringify(summary, null, 2)));
async function network(context, options = {}) {
  const state = { owner, reads: [], writes: [], external: 0, downloads: 0, exportReply: record(), ...options };
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== new URL(process.env.CREW_BASE_URL).origin) {
      state.external++;
      return route.fulfill({ status: 503, body: '' });
    }
    return route.fallback();
  });
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      proc = decodeURIComponent(url.pathname.split('/').at(-1));
    if (proc === 'auth.login' || proc === 'auth.register')
      return reply(route, {
        userId: state.owner,
        accessToken: 'crew-fixture-' + state.owner,
        refreshToken: 'crew-refresh-fixture-' + state.owner,
        expiresAt: '2027-10-10T12:00:00Z',
      });
    if (proc === 'auth.logout') return reply(route, { ok: true });
    (request.method() === 'GET' ? state.reads : state.writes).push(proc);
    if (state[proc]) return state[proc](route);
    if (proc === 'export') return reply(route, state.exportReply);
    if (proc === 'me') return reply(route, null);
    if (proc === 'mentors') return reply(route, []);
    if (proc === 'card')
      return reply(route, {
        ...card,
        shareMode: 'svg',
        raster: { status: 'unavailable', code: 'blueprint.card_renderer_unconfigured', reason: 'Qualified fixture' },
      });
    return fail(route, 503);
  });
  context.on('page', (page) => page.on('download', () => state.downloads++));
  context.pages().forEach((page) => page.on('download', () => state.downloads++));
  return state;
}
const panel = (page) => page.getByTestId('blueprint-crew');
const exportCount = (state) => state.reads.filter((proc) => proc === 'export').length;
async function signIn(page, destination = '/blueprint?crew=own') {
  await page.goto('/login?redirect=' + encodeURIComponent(destination));
  await page.locator('input[name="identifier"]').fill('qualified-fixture-owner');
  await page.locator('input[name="password"]').fill('QualifiedFixtureOnly1!');
  await page.locator('button[type="submit"]').click();
  await expect(panel(page)).toBeVisible();
}
async function currentRead(page) {
  await panel(page).getByRole('button', { name: 'View own crew', exact: true }).click();
}
async function retain(page, name = 'View own crew') {
  await panel(page)
    .getByRole('button', { name, exact: true })
    .evaluate((button) => {
      window.__retainedCrewRead = button[Object.keys(button).find((key) => key.startsWith('__reactProps$'))].onClick;
    });
}
async function safeReadEffects(page, state) {
  expect(state.writes).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.downloads).toBe(0);
  expect(await page.evaluate(() => window.__crewObjects)).toBe(0);
}

test('deliberate initial read exposes actual membership/roster/exact XP with no download or peer request', async ({ page, context }) => {
  const state = await network(context);
  await signIn(page);
  expect(exportCount(state)).toBe(0);
  await retain(page);
  await currentRead(page);
  await expect(panel(page).getByText('Northline', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('-9007199254740993', { exact: true })).toBeVisible();
  await expect(panel(page).getByTestId('blueprint-crew-roster')).toContainText(peer);
  await expect(panel(page).getByTestId('blueprint-crew-identity')).toContainText('Builder');
  await expect(panel(page)).toContainText('2 of 6');
  await expect(panel(page)).toContainText('not a live update time');
  await expect(panel(page).locator('[lang="und"]')).toHaveText('Northline');
  expect(exportCount(state)).toBe(1);
  await page.evaluate(() => window.__retainedCrewRead());
  expect(exportCount(state)).toBe(1);
  expect(state.reads).not.toContain('cardOf');
  await safeReadEffects(page, state);
});

for (const [width, language, title, button, role] of [
  [390, 'es', 'Tu equipo', 'Ver mi equipo', 'Constructor'],
  [320, 'fr', 'Votre équipe', 'Voir mon équipe', 'Constructeur'],
]) {
  test(`native keyboard/current read at${width} with authored${language} and coherent missing profile`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 844 });
    await context.addInitScript((language) => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language })), language);
    const state = await network(context, { exportReply: record({ blueprint: null, card: null, crew: { ...record().crew, name: '' } }) });
    await signIn(page);
    // Locale setup is verified by its actual rendered authored wrapper, never a raw-key assertion.
    const action = panel(page).getByRole('button', { name: button, exact: true });
    await expect(panel(page)).toContainText(title);
    await action.focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toContainText(role);
    await expect(panel(page).getByTestId('blueprint-crew-note')).toBeVisible();
    await panel(page).getByRole('button').scrollIntoViewIfNeeded();
    const box = await panel(page).getByRole('button').boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel(page).getByRole('button').click();
    await expect.poll(() => exportCount(state)).toBe(2);
    await safeReadEffects(page, state);
  });
}

test('unplaced ignores persona/history; current retry remains usable after read failures hide old data', async ({ page, context }) => {
  const state = await network(context);
  await signIn(page);
  await currentRead(page);
  await expect(panel(page)).toContainText('Northline');
  state.export = (route) => fail(route, 503);
  await panel(page).getByRole('button', { name: 'Read again' }).click();
  await expect(panel(page)).toContainText('Crew read unavailable');
  await expect(panel(page)).not.toContainText('Northline');
  state.export = (route) => reply(route, record({ crew: null, membership: null, crewmates: [] }));
  await panel(page).getByRole('button', { name: 'Retry crew read' }).click();
  await expect(panel(page)).toContainText('No recorded crew placement');
  await expect(panel(page)).not.toContainText(crewId);
  await safeReadEffects(page, state);
});
test('malformed displayed timestamps refuse the old snapshot and keep current retry usable', async ({ page, context }) => {
  const state = await network(context);
  await signIn(page);
  await currentRead(page);
  await expect(panel(page)).toContainText('Northline');
  const changes = [
    (value) => record({ crewmates: [{ ...record().crewmates[0], joinedAt: value }] }),
    (value) => record({ exportedAt: value }),
    (value) => record({ membership: { ...record().membership, joinedAt: value } }),
  ];
  for (const change of changes) {
    state.exportReply = change('2026-10-10T12:00:00+24:00');
    await panel(page).getByRole('button', { name: 'Read again', exact: true }).click();
    await expect(panel(page)).toContainText('Crew information can’t be verified');
    await expect(panel(page)).not.toContainText('Northline');
    await expect(panel(page).getByTestId('blueprint-crew-roster')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reload the app', exact: true })).toHaveCount(0);
    state.exportReply = change('2026-10-10T12:00:00+05:30');
    await panel(page).getByRole('button', { name: 'Retry crew read', exact: true }).click();
    await expect(panel(page)).toContainText('Northline');
    await expect(panel(page).getByTestId('blueprint-crew-roster')).toContainText(peer);
    await expect(panel(page)).toContainText('UTC');
  }
  expect(exportCount(state)).toBe(7);
  await safeReadEffects(page, state);
});
for (const [name, response] of [
  ['wrong owner', () => record({ membership: { ...record().membership, userId: peer } })],
  ['partial placement', () => record({ crew: null })],
  ['invalid full envelope', () => ({ ...record(), mentoringOthers: undefined })],
]) {
  test(`refuses${name}; hides previous snapshot and current valid retry works`, async ({ page, context }) => {
    const state = await network(context);
    await signIn(page);
    await currentRead(page);
    await expect(panel(page)).toContainText('Northline');
    state.exportReply = response();
    await panel(page).getByRole('button', { name: 'Read again' }).click();
    await expect(panel(page)).toContainText('Crew information can’t be verified');
    await expect(panel(page)).not.toContainText(crewId);
    state.exportReply = record();
    await panel(page).getByRole('button', { name: 'Retry crew read' }).click();
    await expect(panel(page)).toContainText('Northline');
    await safeReadEffects(page, state);
  });
}
test('403 is a scoped read refusal; typed renderer-unavailable reply remains valid on retry', async ({ page, context }) => {
  const state = await network(context, { export: (route) => fail(route, 403) });
  await signIn(page);
  await currentRead(page);
  await expect(panel(page)).toContainText('Crew read not permitted');
  await expect(panel(page).getByRole('link', { name: 'Sign in' })).toHaveCount(0);
  state.export = (route) =>
    reply(
      route,
      record({
        card: { ...card, raster: { status: 'unavailable', code: 'blueprint.card_renderer_protocol', reason: 'Qualified fixture' } },
      }),
    );
  await panel(page).getByRole('button', { name: 'Retry crew read' }).click();
  await expect(panel(page)).toContainText('Northline');
  await safeReadEffects(page, state);
});

for (const mode of ['query', 'hash', 'mixed']) {
  test(`observed${mode} ABA synchronously hides private DOM and blocks retained read; fresh current read works`, async ({
    page,
    context,
  }) => {
    const state = await network(context);
    await signIn(page);
    await currentRead(page);
    await expect(panel(page)).toContainText('Northline');
    await retain(page, 'Read again');
    const visible = await page.evaluate((mode) => {
      const original = location.href,
        changed = new URL(original);
      if (mode !== 'hash') changed.searchParams.set('crew', 'other');
      if (mode !== 'query') changed.hash = 'other';
      history.replaceState(null, '', changed);
      history.replaceState(null, '', original);
      window.__retainedCrewRead();
      return document.querySelector('[data-testid="blueprint-crew"]').textContent.includes('Northline');
    }, mode);
    expect(visible).toBe(false);
    expect(exportCount(state)).toBe(1);
    await currentRead(page);
    await expect(panel(page)).toContainText('Northline');
    expect(exportCount(state)).toBe(2);
    await safeReadEffects(page, state);
  });
}
test('same full URL replacement preserves current read and permits an intentional reread', async ({ page, context }) => {
  const state = await network(context);
  await signIn(page);
  await currentRead(page);
  await expect(panel(page)).toContainText('Northline');
  await page.evaluate(() => history.replaceState(null, '', location.href));
  await expect(panel(page)).toContainText('Northline');
  await panel(page).getByRole('button', { name: 'Read again' }).click();
  await expect.poll(() => exportCount(state)).toBe(2);
  await safeReadEffects(page, state);
});

for (const phase of ['fetch', 'parser']) {
  test(`late${phase} ignoring abort cannot replace current B after departure`, async ({ page, context }) => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const state = await network(context);
    let calls = 0;
    state.export = async (route) => {
      const sequence = ++calls;
      if (sequence === 1 && phase === 'fetch') await held;
      return reply(
        route,
        sequence === 1
          ? record({ crew: { ...record().crew, name: 'Retired A' } })
          : record({ crew: { ...record().crew, name: 'Current B' } }),
      );
    };
    await signIn(page);
    await page.evaluate((phase) => {
      window.__ignoreCrewAbort = true;
      window.__holdCrewParser = phase === 'parser';
    }, phase);
    await retain(page);
    await currentRead(page);
    await expect.poll(() => exportCount(state)).toBe(1);
    if (phase === 'parser') await expect.poll(() => page.evaluate(() => window.__crewReleases.length)).toBe(1);
    await page.evaluate(() => {
      history.replaceState(null, '', '/blueprint?crew=B');
      window.__holdCrewParser = false;
      window.__retainedCrewRead();
    });
    await currentRead(page);
    await expect(panel(page)).toContainText('Current B');
    if (phase === 'fetch') release();
    else await page.evaluate(() => window.__crewReleases.splice(0).forEach((release) => release()));
    await page.waitForTimeout(100);
    await expect(panel(page)).toContainText('Current B');
    await expect(panel(page)).not.toContainText('Retired A');
    expect(exportCount(state)).toBe(2);
    await safeReadEffects(page, state);
  });
}
test('real unmount/new-owner Login retires held read even when abort is ignored', async ({ page, context }) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const state = await network(context, {
    export: async (route) => {
      await held;
      return reply(route, record());
    },
  });
  await signIn(page);
  await page.evaluate(() => (window.__ignoreCrewAbort = true));
  await currentRead(page);
  await expect.poll(() => exportCount(state)).toBe(1);
  state.owner = peer;
  delete state.export;
  await signIn(page);
  release();
  await page.waitForTimeout(100);
  await expect(panel(page).getByRole('button', { name: 'View own crew' })).toBeVisible();
  await expect(panel(page)).not.toContainText('Northline');
  state.exportReply = record({ blueprint: null, card: null, membership: { ...record().membership, userId: peer }, crewmates: [] });
  await currentRead(page);
  await expect(panel(page)).toContainText('Northline');
  await safeReadEffects(page, state);
});

for (const operation of ['onboard', 'erase']) {
  test(`crew placed/unplaced reads preserve actual unresolved${operation} request without replay`, async ({ page, context }) => {
    const state = await network(context, { [operation]: (route) => route.abort() });
    await signIn(page);
    if (operation === 'onboard') {
      await page.getByLabel('Answer key', { exact: true }).fill('qualified-key');
      await page.getByLabel('Your answer', { exact: true }).fill('RAM-only qualified answer');
      await page.getByLabel('Birth date (optional)', { exact: true }).fill('1990-01-01');
      await page.getByRole('button', { name: 'Review Blueprint session', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Run Blueprint session', exact: true }).click();
    } else {
      await page.getByLabel('Type ERASE BLUEPRINT', { exact: true }).fill('ERASE BLUEPRINT');
      await page.getByRole('button', { name: 'Review permanent erasure', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Erase Blueprint permanently', exact: true }).click();
    }
    await expect.poll(() => state.writes.filter((proc) => proc === operation).length).toBe(1);
    const marker = await page.evaluate((owner) => localStorage.getItem('intafaced:more:pending:' + owner + ':blueprint'), owner);
    expect(marker).toBeTruthy();
    await currentRead(page);
    await expect(panel(page)).toContainText('Northline');
    state.exportReply = record({ crew: null, membership: null, crewmates: [] });
    await panel(page).getByRole('button', { name: 'Read again' }).click();
    await expect(panel(page)).toContainText('No recorded crew placement');
    expect(await page.evaluate((owner) => localStorage.getItem('intafaced:more:pending:' + owner + ':blueprint'), owner)).toBe(marker);
    await expect(page.getByTestId('failure').filter({ hasText: 'Earlier request:' })).toBeVisible();
    expect(state.writes.filter((proc) => proc === operation).length).toBe(1);
    expect(state.external).toBe(0);
    expect(state.downloads).toBe(0);
  });
}
test('current owner401 replaces private Blueprint with existing generic room gate', async ({ page, context }) => {
  const state = await network(context);
  await signIn(page);
  await currentRead(page);
  await expect(panel(page)).toContainText('Northline');
  state.export = (route) => fail(route, 401);
  await panel(page).getByRole('button', { name: 'Read again' }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await expect(
    page.getByText('Your account context is needed before this room can show private information.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Register', exact: true })).toHaveCount(0);
});
