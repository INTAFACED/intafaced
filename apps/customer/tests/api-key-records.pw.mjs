import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const evidence = process.env.API_KEY_RECORDS_EVIDENCE || '/tmp/intafaced-api-key-records';
mkdirSync(evidence, { recursive: true });
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '22222222-2222-4222-8222-222222222222';
const record = {
  id: 'owner-key/not-a-uuid/01',
  name: 'Notebook <reader>',
  prefix: 'if_live_f3a9',
  scopes: ['identity:read', 'trade:write'],
  lastUsedAt: '2026-10-10T08:00:00.000Z',
  revoked: false,
  mode: 'live',
  requireSignature: false,
  requireNonEmptyIpAllowlist: false,
  ipAllowlist: [],
};
const securityKey = `intafaced.customer.security.v1:${ownerA}`;
const original = ` [ ${JSON.stringify({ requestId: '33333333-3333-4333-8333-333333333333', owner: ownerA, kind: 'logout', state: 'sent', createdAt: '2026-10-10T08:00:00.000Z' })} ] `;
const section = (page) => page.locator('.api-key-records');
const readButton = (page) => section(page).locator('.api-key-records__controls').getByRole('button');
const rows = (page) => section(page).locator('.api-key-records__row');
const pause = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

async function network(context) {
  const state = {
    owner: ownerA,
    token: 1,
    reads: [],
    keyReads: [],
    featureWrites: [],
    errors: [],
    cancelled: [],
    respond: async () => ({ status: 200, data: [record] }),
  };
  const observe = (page) => page.on('pageerror', (error) => state.errors.push(error.message));
  context.pages().forEach(observe);
  context.on('page', observe);
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const input = request.method() === 'GET' ? JSON.parse(url.searchParams.get('input') || 'null') : null;
    const reply = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (procedure === 'auth.login')
      return reply({
        userId: state.owner,
        accessToken: `isolated-owner-key-token-${state.token}`,
        refreshToken: `isolated-owner-key-refresh-${state.token}`,
        expiresAt: '2027-10-10T08:00:00Z',
      });
    if (procedure === 'auth.logout') return reply({ ok: true });
    if (request.method() !== 'GET') {
      state.featureWrites.push(procedure);
      return route.fulfill({ status: 503, json: { message: 'This owner-read fixture admits no feature writes' } });
    }
    state.reads.push({ procedure, input });
    if (procedure === 'apiKeys.list') {
      state.keyReads.push({ input, path: url.pathname });
      const answer = await state.respond(input, state.keyReads.length);
      try {
        return await route.fulfill({
          status: answer.status,
          json: answer.status === 200 ? { result: { data: answer.data } } : { message: 'Isolated owner read refused' },
        });
      } catch (error) {
        state.cancelled.push(error.message);
        return;
      }
    }
    if (procedure === 'webauthn.list' || procedure === 'listSessions') return reply([]);
    return route.fulfill({ status: 503, json: { message: 'Isolated unrelated read unavailable' } });
  });
  return state;
}
async function login(page, destination = '/uc/safe', newDocument = true) {
  if (newDocument) await page.goto('/login?redirect=' + encodeURIComponent(destination));
  else await page.locator('a.button[href^="/login?redirect="]').click();
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect.poll(() => page.evaluate(() => location.pathname + location.search + location.hash)).toBe(destination);
  if (destination.startsWith('/uc/safe')) await expect(section(page)).toBeVisible();
}
async function clean(state, name) {
  expect(state.featureWrites).toEqual([]);
  expect(state.errors).toEqual([]);
  expect(state.reads.some(({ procedure }) => /merchant|provider|company|pay\./i.test(procedure))).toBe(false);
  writeFileSync(
    `${evidence}/${name}.json`,
    JSON.stringify(state, (key, value) => (typeof value === 'function' ? undefined : value), 2),
  );
}

test('deliberate owner GET windows and refresh preserve an unresolved Security original', async ({ page, context }) => {
  const state = await network(context);
  await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), { key: securityKey, raw: original });
  await login(page);
  expect(state.keyReads).toEqual([]);
  await expect(section(page)).toBeVisible();
  await expect(page.locator('.security__session-inspection')).toHaveAttribute('disabled', '');
  await expect(page.locator('.security__session-inspection').getByRole('button', { name: 'Refresh sessions', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sign out everywhere', exact: true })).toBeDisabled();
  for (const limit of [50, 100, 150, 200]) {
    if (limit !== 50) await section(page).getByRole('combobox').selectOption(String(limit));
    await expect(rows(page)).toHaveCount(0);
    await readButton(page).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(section(page).getByText(record.id, { exact: true })).toBeVisible();
    expect(state.keyReads.at(-1).input).toEqual({ limit });
  }
  state.respond = async () => ({ status: 200, data: [] });
  await readButton(page).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(section(page).getByText('No API keys yet.', { exact: true })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), securityKey)).toBe(original);
  await clean(state, 'windows-and-original');
});

test('failed and invalid whole reads hide prior metadata and current retry succeeds', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await readButton(page).click();
  await expect(rows(page)).toHaveCount(1);
  for (const failure of [
    { status: 403 },
    { status: 200, data: [record, { ...record, id: 'malformed', lastUsedAt: '2026-10-10T08:00:00+24:00' }] },
    { status: 503 },
  ]) {
    state.respond = async () => failure;
    await readButton(page).click();
    await expect(rows(page)).toHaveCount(0);
    await expect(section(page).locator('.api-key-records__failure')).toBeVisible();
    await expect(section(page).getByText(record.id, { exact: true })).toHaveCount(0);
    state.respond = async () => ({ status: 200, data: [record] });
    await readButton(page).click();
    await expect(rows(page)).toHaveCount(1);
  }
  await clean(state, 'failures-retry');
});

test('held refresh retires rows at admission before a failed reply and local read remains usable', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  await readButton(page).click();
  await expect(rows(page)).toHaveCount(1);
  const held = pause();
  state.respond = async () => {
    await held.promise;
    return { status: 503 };
  };
  await readButton(page).click();
  await expect.poll(() => state.keyReads.length).toBe(2);
  await expect(rows(page)).toHaveCount(0);
  await expect(readButton(page)).toBeDisabled();
  held.release();
  await expect(section(page).locator('.api-key-records__failure')).toBeVisible();
  state.respond = async () => ({ status: 200, data: [record] });
  await readButton(page).click();
  await expect(rows(page)).toHaveCount(1);
  await clean(state, 'held-refresh');
});

test('observed same-task full-URL departure retires held A and retained Read before current B succeeds', async ({ page, context }) => {
  const state = await network(context);
  await login(page, '/uc/safe?read=original#records');
  const held = pause();
  state.respond = async (_input, count) =>
    count === 1 ? (await held.promise, { status: 200, data: [record] }) : { status: 200, data: [{ ...record, id: 'current-B' }] };
  await readButton(page).evaluate((button) => {
    const key = Object.keys(button).find((name) => name.startsWith('__reactProps$'));
    window.retiredRead = button[key].onClick;
  });
  await readButton(page).click();
  await expect.poll(() => state.keyReads.length).toBe(1);
  await page.evaluate(() => {
    const original = location.pathname + location.search + location.hash;
    history.pushState(null, '', '/uc/safe?read=departed#other');
    history.replaceState(null, '', original);
    window.retiredRead();
  });
  await expect(readButton(page)).toBeEnabled();
  expect(state.keyReads).toHaveLength(1);
  await readButton(page).click();
  await expect(section(page).getByText('current-B', { exact: true })).toBeVisible();
  held.release();
  await expect(section(page).getByText(record.id, { exact: true })).toHaveCount(0);
  await clean(state, 'url-aba-retained-read');
});

test('held late parsing and retired window handler cannot publish A or clear current B', async ({ page, context }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    let first = true;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]).includes('/api/identity/trpc/apiKeys.list') && first) {
        first = false;
        const text = response.text.bind(response);
        response.text = async () => {
          const body = await text();
          window.keyParseHeld = true;
          await new Promise((resolve) => {
            window.releaseKeyParse = resolve;
          });
          return body;
        };
      }
      return response;
    };
  });
  const state = await network(context);
  state.respond = async (_input, count) => ({ status: 200, data: [{ ...record, id: count === 1 ? 'late-A' : 'current-B' }] });
  await login(page);
  await section(page)
    .getByRole('combobox')
    .evaluate((select) => {
      const key = Object.keys(select).find((name) => name.startsWith('__reactProps$'));
      window.retiredWindow = select[key].onChange;
    });
  await readButton(page).click();
  await expect.poll(() => page.evaluate(() => !!window.keyParseHeld)).toBe(true);
  await section(page).getByRole('combobox').selectOption('100');
  await readButton(page).click();
  await expect(section(page).getByText('current-B', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.retiredWindow({ target: { value: '150' } });
    window.releaseKeyParse();
  });
  await expect(section(page).getByRole('combobox')).toHaveValue('100');
  await expect(section(page).getByText('current-B', { exact: true })).toBeVisible();
  await expect(section(page).getByText('late-A', { exact: true })).toHaveCount(0);
  expect(state.keyReads.map(({ input }) => input.limit)).toEqual([50, 100]);
  await clean(state, 'late-parse-window');
});

test('actual same-task signout rejects retained private Read and new signed-in owner remains usable', async ({ page, context }) => {
  const state = await network(context);
  await login(page);
  const originalTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  await readButton(page).evaluate((button) => {
    const key = Object.keys(button).find((name) => name.startsWith('__reactProps$'));
    window.retiredRead = button[key].onClick;
  });
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).evaluate((button) => {
    const key = Object.keys(button).find((name) => name.startsWith('__reactProps$'));
    button[key].onClick();
    window.retiredRead();
  });
  await expect(section(page)).toHaveCount(0);
  expect(state.keyReads).toEqual([]);
  state.owner = ownerB;
  state.token = 2;
  state.respond = async () => ({ status: 200, data: [{ ...record, id: 'new-owner-B' }] });
  await login(page, '/uc/safe', false);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(originalTimeOrigin);
  await expect.poll(() => page.evaluate(() => typeof window.retiredRead)).toBe('function');
  await page.evaluate(() => window.retiredRead());
  expect(state.keyReads).toEqual([]);
  await readButton(page).click();
  await expect(section(page).getByText('new-owner-B', { exact: true })).toBeVisible();
  await clean(state, 'signout-new-owner');
});

test('401 retires private rows and actual Login/Register preserves complete query and hash return', async ({ page, context }) => {
  const state = await network(context);
  const destination = '/uc/safe?read=owner%2Bkey#record-details';
  await login(page, destination);
  state.respond = async () => ({ status: 401 });
  await readButton(page).click();
  await expect(section(page)).toHaveCount(0);
  const signIn = page.locator('a.button[href^="/login?redirect="]');
  await expect(signIn).toHaveAttribute('href', '/login?redirect=' + encodeURIComponent(destination));
  await signIn.click();
  const register = page.locator('a.text-link[href^="/register?redirect="]');
  await expect(register).toBeVisible();
  await register.click();
  expect(new URL(page.url()).searchParams.get('redirect')).toBe(destination);
  await page.locator('a.text-link[href^="/login?redirect="]').click();
  expect(new URL(page.url()).searchParams.get('redirect')).toBe(destination);
  await page.locator('input[name="identifier"]').fill('isolated-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect.poll(() => page.evaluate(() => location.pathname + location.search + location.hash)).toBe(destination);
  state.respond = async () => ({ status: 200, data: [record] });
  await readButton(page).click();
  await expect(rows(page)).toHaveCount(1);
  await clean(state, '401-return');
});

test('actual View EN/ES/FR and320/390 preserve opaque long values with native keyboard and pointer reads', async ({ page, context }) => {
  const state = await network(context);
  const long = {
    ...record,
    id: 'owner:key/' + 'long-reference-'.repeat(12),
    name: 'Original name <script> / propriétaire',
    prefix: 'if_live_' + 'abcdef'.repeat(16),
    scopes: ['identity:read', 'arbitrary:scope/' + 'x'.repeat(100)],
  };
  state.respond = async () => ({
    status: 200,
    data: [long, { ...record, id: 'revoked-sandbox', mode: 'sandbox', revoked: true, lastUsedAt: null }],
  });
  await login(page);
  const view = await context.newPage();
  await login(view, '/view');
  const states = [];
  for (const locale of ['en', 'es', 'fr']) {
    await view
      .locator('select')
      .filter({ has: view.locator('option[value="es"]') })
      .selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const select = section(page).getByRole('combobox');
      await select.selectOption(width === 320 ? '100' : '50');
      await expect(rows(page)).toHaveCount(0);
      const initial = await readButton(page).evaluate((button) => ({
        text: button.textContent,
        height: button.getBoundingClientRect().height,
        left: button.getBoundingClientRect().left,
        right: button.getBoundingClientRect().right,
        viewport: innerWidth,
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(initial.scroll).toBeLessThanOrEqual(initial.client);
      expect(initial.right).toBeLessThanOrEqual(initial.viewport);
      expect(initial.height).toBeGreaterThanOrEqual(44);
      if (locale === 'fr' && width === 320) await section(page).screenshot({ path: `${evidence}/initial-fr-320.png` });
      await select.click();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Tab');
      await expect(readButton(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(rows(page)).toHaveCount(2);
      await expect(section(page).getByText(long.id, { exact: true })).toBeVisible();
      await expect(section(page).getByText(long.name, { exact: true })).toBeVisible();
      await expect(section(page).getByText(long.prefix, { exact: true })).toBeVisible();
      const bounds = await section(page).evaluate((node) => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
        selectHeight: node.querySelector('select').getBoundingClientRect().height,
        buttonHeight: node.querySelector('button').getBoundingClientRect().height,
        font: getComputedStyle(node.querySelector('h2')).fontFamily,
        opaqueLang: [...node.querySelectorAll('bdi')].every((value) => value.lang === 'und'),
      }));
      states.push({ locale, width, initial, bounds });
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.client);
      expect(bounds.selectHeight).toBeGreaterThanOrEqual(44);
      expect(bounds.buttonHeight).toBeGreaterThanOrEqual(44);
      expect(bounds.font).toContain('Inter');
      expect(bounds.opaqueLang).toBe(true);
      await section(page).screenshot({ path: `${evidence}/records-${locale}-${width}.png` });
      if (width === 390) {
        await readButton(page).click();
        await expect(rows(page)).toHaveCount(2);
      }
    }
  }
  expect(await page.evaluate(() => Object.values(localStorage).some((value) => value.includes('Original name <script>')))).toBe(false);
  writeFileSync(`${evidence}/phone-locale-geometry.json`, JSON.stringify(states, null, 2));
  await clean(state, 'phone-locales');
});

test('actual Login and View use resolved timestamp language for unsupported Welsh and supported Arabic', async ({ page, context }) => {
  const state = await network(context);
  await login(page, '/view');
  const observations = [];
  for (const requested of ['cy', 'ar', 'en']) {
    if (requested !== 'cy') {
      await page.locator('.person-trigger').click();
      await page.getByRole('dialog').locator('a[href="/view"]').click();
    }
    await page
      .locator('select')
      .filter({ has: page.locator('option[value="cy"]') })
      .selectOption(requested);
    await page.locator('.person-trigger').click();
    await page.getByRole('dialog').locator('a[href="/uc/safe"]').click();
    await expect(section(page)).toBeVisible();
    await expect(readButton(page)).toHaveText('Read API-key records');
    await readButton(page).click();
    await expect(rows(page)).toHaveCount(1);
    const observed = await section(page).evaluate(
      (node, { requested, instant }) => {
        const formatter = new Intl.DateTimeFormat(requested, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
        const time = node.querySelector('time');
        return {
          requested,
          supported: Intl.DateTimeFormat.supportedLocalesOf([requested]),
          resolved: formatter.resolvedOptions().locale,
          expectedText: formatter.format(new Date(instant)) + ' UTC',
          text: time.textContent,
          dateTime: time.dateTime,
          lang: time.lang,
          dir: time.dir,
          computedDirection: getComputedStyle(time).direction,
          sectionLanguage: node.lang,
          opaqueLanguages: [...node.querySelectorAll('bdi')].map((value) => value.lang),
        };
      },
      { requested, instant: record.lastUsedAt },
    );
    observations.push(observed);
    expect(observed.dateTime).toBe(record.lastUsedAt);
    expect(observed.text).toBe(observed.expectedText);
    expect(observed.lang).toBe(observed.resolved);
    expect(observed.dir).toBe('auto');
    expect(observed.sectionLanguage).toBe('en');
    expect(observed.opaqueLanguages.every((language) => language === 'und')).toBe(true);
    if (requested === 'cy') {
      expect(observed.supported).toEqual([]);
      expect(observed.resolved).toMatch(/^en(?:-|$)/);
      expect(observed.computedDirection).toBe('ltr');
    } else if (requested === 'ar') {
      expect(observed.supported).toContain('ar');
      expect(observed.resolved).toMatch(/^ar(?:-|$)/);
      expect(observed.computedDirection).toBe('rtl');
    } else {
      expect(observed.computedDirection).toBe('ltr');
    }
    await section(page).screenshot({ path: `${evidence}/timestamp-${requested}.png` });
  }
  expect(state.keyReads.map(({ input }) => input)).toEqual([{ limit: 50 }, { limit: 50 }, { limit: 50 }]);
  writeFileSync(`${evidence}/timestamp-provenance.json`, JSON.stringify(observations, null, 2));
  await clean(state, 'timestamp-read');
});
