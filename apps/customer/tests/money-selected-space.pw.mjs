import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const baseURL = process.env.MONEY_SELECTED_SPACE_BASE_URL;
const evidence = process.env.MONEY_SELECTED_SPACE_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Use the explicit verified selected-space origin and evidence directory.');
mkdirSync(evidence, { recursive: true });
const fixed = '52612d4445fd456d4f13b1e7e7fe0fc224df0b12';
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '99999999-9999-4999-8999-999999999999';
const primaryId = '22222222-2222-4222-8222-222222222222';
const targetId = '33333333-3333-4333-8333-333333333333';
const targetName = 'Travel reserve — exact current owner, purpose and long name';
const targetBalance = '1250.000000000000000001';
const targetGoal = '2500.000000000000000001';
const targetLock = '2030-10-10T12:00:00.000Z';
const otherId = '44444444-4444-4444-8444-444444444444';
const longAsset = 'ASSET12345678901';
const bankKey = `intafaced.customer.bank-unconfirmed.v1:${ownerA}`;
const originalReference = '77777777-7777-4777-8777-777777777777';
const original = ` [ ${JSON.stringify({ reference: originalReference, title: 'Original transfer', procedure: 'transfers.create', recordRefs: { transferId: originalReference, fromSpaceId: primaryId } })} ] `;
const paths = [
  '/bank',
  '/bank/spaces',
  '/bank/transfers',
  '/bank/earn',
  '/bank/loans',
  '/bank/cards',
  '/bank/ramps',
  '/bank/analytics',
  '/bank/business',
];
const main = (page) => page.locator('#main');
const currentURL = (page) => page.evaluate(() => location.pathname + location.search + location.hash);
const selectedURL = (id = targetId) => `/bank/spaces?space=${encodeURIComponent(id)}`;
const makeSpace = (id, kind, name, balance = '0', owner = ownerA) => ({
  id,
  assetId: 'USDT',
  kind,
  name,
  balance,
  goalTarget: id === targetId ? targetGoal : null,
  lockedUntil: id === targetId ? targetLock : null,
  ledgerAccount: {
    ownerType: kind === 'primary' ? 'user' : 'subaccount',
    ownerId: kind === 'primary' ? owner : id,
    assetId: 'USDT',
    kind: 'available',
  },
});
const rows = (owner = ownerA) => [
  makeSpace(primaryId, 'primary', 'Main USDT', '7500', owner),
  ...Array.from({ length: 58 }, (_, index) =>
    makeSpace(
      `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      'named',
      `Reserve ${String(index + 1).padStart(2, '0')}`,
      '1',
      owner,
    ),
  ),
  makeSpace(targetId, 'named', targetName, targetBalance, owner),
];
const pause = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
async function network(context) {
  const state = { owner: ownerA, reads: [], writes: [], logins: [], documents: [], errors: [], cancelled: [], observations: [], held: [] };
  state.asset = 'USDT';
  state.unlocked = false;
  state.currentRows = (owner) =>
    rows(owner).map((row) => ({
      ...row,
      assetId: state.asset,
      ledgerAccount: { ...row.ledgerAccount, assetId: state.asset },
      ...(row.id === targetId && state.unlocked ? { lockedUntil: '2020-10-10T12:00:00.000Z' } : {}),
    }));
  state.answer = async ({ input, owner }) => ({ status: 200, data: state.currentRows(owner).slice(0, input.limit) });
  const observe = (page) => {
    page.on('pageerror', (error) => state.errors.push(error.message));
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) state.documents.push(request.url());
    });
  };
  context.pages().forEach(observe);
  context.on('page', observe);
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const rpc = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (procedure === 'auth.login') {
      const token = `isolated-selected-space-token-${state.logins.length + 1}`;
      state.logins.push({ owner: state.owner, token, input: request.postDataJSON() });
      return rpc({
        userId: state.owner,
        accessToken: token,
        refreshToken: 'isolated-selected-space-refresh',
        expiresAt: '2027-10-10T00:00:00Z',
      });
    }
    if (procedure === 'auth.logout') return rpc({ ok: true });
    if (request.method() !== 'GET') {
      state.writes.push({ path: url.pathname, method: request.method(), body: request.postData() });
      return route.fulfill({
        status: 503,
        json: {
          error: { message: 'Selected-space fixture authorizes no financial dispatch', data: { intafacedCode: 'fixture.write_refused' } },
        },
      });
    }
    const input = JSON.parse(url.searchParams.get('input') || 'null');
    const read = { path: url.pathname, input, authorization: request.headers().authorization ?? null };
    state.reads.push(read);
    try {
      if (url.pathname.endsWith('/account/balance'))
        return route.fulfill({
          status: 200,
          json: {
            timestamp: 1791621900000,
            datetime: '2026-10-10T08:45:00.000Z',
            balances: {
              [state.asset]: state.zeroPrimary ? { total: '0', free: '0', used: '0' } : { total: '8000', free: '7500', used: '500' },
            },
          },
        });
      if (procedure === 'spaces.unnamed') return rpc([]);
      if (procedure === 'transfers.listSchedules') return rpc([]);
      if (procedure === 'spaces.list') {
        const principal = state.logins.find((login) => `Bearer ${login.token}` === read.authorization)?.owner;
        if (!principal)
          return route.fulfill({
            status: 401,
            json: {
              error: { message: 'Fixture requires the current ordinary Login bearer', data: { intafacedCode: 'fixture.unauthenticated' } },
            },
          });
        const answer = await state.answer({ input, read, owner: principal });
        return answer.status === 200
          ? rpc(answer.data)
          : route.fulfill({
              status: answer.status,
              json: {
                error: {
                  message: answer.message ?? 'Isolated owner space read refused',
                  data: { intafacedCode: answer.code ?? 'fixture.space_read_refused' },
                },
              },
            });
      }
      return route.fulfill({
        status: 503,
        json: {
          error: {
            message: 'No other service read is supplied by this bounded fixture',
            data: { intafacedCode: 'fixture.read_unavailable' },
          },
        },
      });
    } catch (error) {
      state.cancelled.push(error.message);
    }
  });
  return state;
}
async function snapshot(page, state, name) {
  await page.evaluate(() => document.fonts.ready);
  const observed = await page.evaluate(
    ({ name, targetName, targetId }) => {
      const nav = document.querySelector('.mobile-doors'),
        n = nav?.getBoundingClientRect(),
        edge = nav && getComputedStyle(nav).display !== 'none' && n.height > 0 ? n.top : innerHeight;
      const heading = [...document.querySelectorAll('#main h1,#main h2,#main h3')].find((node) => node.textContent.trim() === targetName);
      const frame = heading?.getBoundingClientRect();
      return {
        name,
        href: location.pathname + location.search + location.hash,
        timeOrigin: performance.timeOrigin,
        width: innerWidth,
        height: innerHeight,
        edge,
        scrollWidth: document.documentElement.scrollWidth,
        active: document.activeElement?.outerHTML,
        targetId,
        targetHeading: heading?.outerHTML ?? null,
        targetBox: frame ? { top: frame.top, bottom: frame.bottom } : null,
        text: document.querySelector('#main')?.textContent,
      };
    },
    { name, targetName, targetId },
  );
  state.observations.push(observed);
  writeFileSync(`${evidence}/${name}.json`, JSON.stringify(observed, null, 2));
  await page.screenshot({ path: `${evidence}/${name}-viewport.png` });
  await page.screenshot({ path: `${evidence}/${name}-whole.png`, fullPage: true });
  return observed;
}
async function scenario(browser, name, run, width = 320, height = 844) {
  const context = await browser.newContext({ baseURL, viewport: { width, height }, timezoneId: 'UTC' });
  const state = await network(context),
    page = await context.newPage();
  try {
    await run({ page, context, state });
    expect(state.writes).toEqual([]);
    expect(state.errors).toEqual([]);
    for (const read of state.reads.filter((row) => row.path.endsWith('/spaces.list'))) {
      expect(read.input.limit).toBeGreaterThanOrEqual(1);
      expect(read.input.limit).toBeLessThanOrEqual(200);
      expect(read.authorization).toMatch(/^Bearer isolated-selected-space-token-/);
    }
  } finally {
    state.held.forEach((held) => held.release());
    writeFileSync(
      `${evidence}/${name}-raw.json`,
      JSON.stringify(
        {
          fixedFixtureSource: fixed,
          qualification:
            'Ordinary compiled App/Login with isolated mounted-shaped owner reads. No live JWT/SQL/Edge, financial dispatch, exact lookup or fixture authority claim.',
          ...state,
        },
        (key, value) => (typeof value === 'function' || key === 'held' ? undefined : value),
        2,
      ),
    );
    await context.close();
  }
}
async function submitLogin(page, destination) {
  await page.locator('input[name="identifier"]').fill('selected-space-owner@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect.poll(() => currentURL(page)).toBe(destination);
  await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible();
}
async function login(page, destination = '/bank') {
  await page.goto(`/login?redirect=${encodeURIComponent(destination)}`);
  await submitLogin(page, destination);
}
async function ownerProof(page, owner = ownerA) {
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(owner, { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
}

const ui = {
  en: {
    selected: 'Selected space',
    missing: 'Space not in this response',
    invalid: 'Space could not be identified',
    conflict: 'Space could not be verified',
    from: 'From your space',
    continue: 'Continue',
    hide: 'Hide amounts',
    show: 'Show amounts',
    create: 'Create space',
  },
  es: {
    selected: 'Espacio seleccionado',
    from: 'Desde tu espacio',
    continue: 'Continuar',
    hide: 'Ocultar importes',
    show: 'Mostrar importes',
    create: 'Crear espacio',
  },
  fr: {
    selected: 'Espace sélectionné',
    from: 'Depuis ton espace',
    continue: 'Continuer',
    hide: 'Masquer les montants',
    show: 'Afficher les montants',
    create: 'Créer un espace',
  },
};
const selection = (page, locale = 'en') => main(page).getByRole('region', { name: ui[locale].selected, exact: true });
const selectedTransfer = (page, id = targetId, locale = 'en') =>
  selection(page, locale).locator(`a[href="/bank/transfers?from=${encodeURIComponent(id)}"]`);
const listReads = (state) => state.reads.filter((row) => row.path.endsWith('/spaces.list'));
const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function aboveFooter(locator, minimum = 0) {
  await expect(locator).toBeVisible();
  await expect
    .poll(() =>
      locator.evaluate((node, minimum) => {
        const r = node.getBoundingClientRect(),
          nav = document.querySelector('.mobile-doors'),
          n = nav?.getBoundingClientRect();
        const edge = nav && getComputedStyle(nav).display !== 'none' && n.height > 0 ? n.top : innerHeight;
        return {
          left: r.left >= -0.5,
          right: r.right <= innerWidth + 0.5,
          top: r.top >= 0,
          bottom: r.bottom <= edge + 0.5,
          height: r.height >= minimum,
        };
      }, minimum),
    )
    .toEqual({ left: true, right: true, top: true, bottom: true, height: true });
}
async function viewLocale(page, requested) {
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('dialog').locator('a[href="/view"]').click();
  const language = page.locator('select').filter({ has: page.locator('option[value="ar"]') });
  await language.selectOption(requested);
  await expect(language).toHaveValue(requested);
  await page.locator('a[href="/money"]:visible').first().click();
  await expect.poll(() => currentURL(page)).toBe('/money');
  await main(page).locator('a[href="/bank"]').click();
  await expect.poll(() => currentURL(page)).toBe('/bank');
  await expect(page.locator('html')).toHaveAttribute('lang', requested === 'ar' ? 'en' : requested);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
}
async function ready(page, { id = targetId, name = targetName, asset = 'USDT', locale = 'en', balance = '1,250.000000000000000001' } = {}) {
  const panel = selection(page, locale);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(panel.getByText(id, { exact: true })).toBeVisible();
  await expect(panel).toContainText(asset);
  if (balance !== null) await expect(panel).toContainText(`${balance} ${asset}`);
  await expect(selectedTransfer(page, id, locale)).toHaveCount(1);
  return panel;
}
async function ordinarySelectedLink(page, id = targetId, keyboard = false) {
  const anchor = main(page).locator(`a.money-space-row[href="${selectedURL(id)}"]`);
  if ((await anchor.count()) === 0) {
    const more = main(page).locator('.money-continuation').getByRole('button');
    await expect(more).toHaveCount(1);
    await more.click();
  }
  await expect(anchor).toHaveCount(1);
  if (keyboard) {
    await anchor.focus();
    await page.keyboard.press('Enter');
  } else await anchor.click();
  await expect.poll(() => currentURL(page)).toBe(selectedURL(id));
}
async function transferReview(page, locale = 'en', id = targetId) {
  await selectedTransfer(page, id, locale).click();
  await expect.poll(() => currentURL(page)).toBe(`/bank/transfers?from=${id}`);
  await expect(main(page).getByLabel(ui[locale].from, { exact: true })).toHaveValue(id);
  await main(page).getByRole('button', { name: ui[locale].continue, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveCount(1);
  await dialog.locator('input[name="toSpaceId"]').fill(primaryId);
  await dialog.locator('input[name="amount"]').fill('0.000000000000000001');
  await dialog.locator('form button[type="submit"]').click();
  return dialog;
}
async function captureHandler(locator, key) {
  await locator.evaluate((node, key) => {
    const propsKey = Object.keys(node).find((key) => key.startsWith('__reactProps'));
    const handler = propsKey && node[propsKey]?.onClick;
    if (typeof handler !== 'function') throw new Error('Retained-control probe requires the actual rendered React click handler.');
    window[key] = handler;
  }, key);
}
async function inspectStorage(page) {
  return page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
    history: history.state,
  }));
}
async function refresh(page) {
  await main(page).getByRole('button', { name: 'Refresh', exact: true }).first().click();
}
async function retry(page) {
  await main(page).getByRole('button', { name: 'Try again', exact: true }).first().click();
}
async function bankNavigation(page) {
  expect(
    await main(page)
      .locator('.money-bank-nav a')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))),
  ).toEqual(paths);
}

test('four widths preserve chosen space facts, privacy, natural Transfer entry and all Bank destinations', async ({ browser }) => {
  expect(targetName.length).toBeLessThanOrEqual(64);
  expect(longAsset).toHaveLength(16);
  for (const [width, requested] of [
    [320, 'en'],
    [390, 'fr'],
    [768, 'es'],
    [1440, 'ar'],
  ]) {
    const locale = requested === 'ar' ? 'en' : requested;
    await scenario(
      browser,
      `selected-${width}-${requested}`,
      async ({ page, state }) => {
        state.unlocked = true;
        if (width === 390) state.asset = longAsset;
        await login(page, '/money');
        await ownerProof(page);
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);
        await main(page).locator('a[href="/bank"]').click();
        await expect.poll(() => currentURL(page)).toBe('/bank');
        if (requested !== 'en') await viewLocale(page, requested);
        await ordinarySelectedLink(page, targetId, width >= 768);
        const panel = await ready(page, { locale, asset: state.asset });
        if (locale === 'en') await expect(panel).toContainText('Named');
        await bankNavigation(page);
        expect(listReads(state).at(-1).input).toEqual({ limit: 200 });
        await expect(panel).toContainText('2,500.000000000000000001');
        await expect(panel).toContainText('2020');
        await aboveFooter(panel.getByRole('heading', { name: targetName, exact: true }));
        await aboveFooter(panel.getByText(targetId, { exact: true }));
        await aboveFooter(panel.getByText(`1,250.000000000000000001 ${state.asset}`, { exact: true }));
        await aboveFooter(selectedTransfer(page, targetId, locale), 44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(main(page)).toBeFocused();
        await snapshot(page, state, `selected-${width}-${requested}-current-before-actions`);
        // Natural Tab from the arrived main must reach the existing current Transfer anchor.
        let reached = false;
        for (let turn = 0; turn < 24; turn++) {
          await page.keyboard.press('Tab');
          if (await selectedTransfer(page, targetId, locale).evaluate((node) => node === document.activeElement)) {
            reached = true;
            break;
          }
        }
        expect(reached).toBe(true);
        await aboveFooter(selectedTransfer(page, targetId, locale), 44);
        const dialog = await transferReview(page, locale);
        expect(listReads(state).at(-1).input).toEqual({ limit: 200 });
        await expect(dialog.locator('form')).toHaveCount(0);
        await expect(dialog).toContainText(targetName);
        await expect(dialog).toContainText('0.000000000000000001');
        expect(state.writes).toEqual([]);
        expect(JSON.stringify(await inspectStorage(page))).not.toContain('0.000000000000000001');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await main(page).locator('.money-bank-nav a[href="/bank"]').click();
        await main(page).getByRole('button', { name: ui[locale].hide, exact: true }).click();
        await ordinarySelectedLink(page);
        const hidden = await ready(page, { locale, asset: state.asset, balance: null });
        await expect(hidden).toContainText('••••');
        await expect(hidden).not.toContainText('1,250.000000000000000001');
        await expect(hidden).not.toContainText('2,500.000000000000000001');
        await expect(hidden.getByText(targetId, { exact: true })).toBeVisible();
        await snapshot(page, state, `selected-${width}-${requested}-hidden`);
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
        expect(state.logins).toHaveLength(1);
        expect(state.documents).toHaveLength(1);
      },
      width,
      width <= 390 ? 844 : 1000,
    );
  }
  await scenario(browser, 'primary-zero-and-generic-create', async ({ page, state }) => {
    state.zeroPrimary = true;
    state.answer = async ({ input, owner }) => ({
      status: 200,
      data: [makeSpace(primaryId, 'primary', 'Zero current primary', '0', owner)].slice(0, input.limit),
    });
    await login(page);
    await ordinarySelectedLink(page, primaryId);
    const panel = await ready(page, { id: primaryId, name: 'Zero current primary', balance: '0' });
    await expect(panel).toContainText('Primary');
    await snapshot(page, state, 'primary-zero-before-generic');
    await main(page).locator('.money-bank-nav a[href="/bank/spaces"]').click();
    await expect(selection(page)).toHaveCount(0);
    await expect.poll(() => listReads(state).at(-1).input.limit).toBe(50);
    await bankNavigation(page);
    await main(page).getByRole('button', { name: 'Create space', exact: true }).click();
    const form = page.getByRole('dialog');
    await form.locator('input[name="assetId"]').fill('USDT');
    await form.locator('input[name="name"]').fill('Deliberate current named space');
    await form.locator('form button[type="submit"]').click();
    await expect(form.locator('form')).toHaveCount(0);
    await expect(form).toContainText('Deliberate current named space');
    expect(state.writes).toEqual([]);
    await page.keyboard.press('Escape');
  });
  await scenario(browser, 'future-lock-current-review-refusal', async ({ page, state }) => {
    await login(page);
    await ordinarySelectedLink(page);
    await ready(page);
    await expect(selection(page)).toContainText('2030');
    const dialog = await transferReview(page);
    await expect(dialog.locator('form')).toHaveCount(1);
    await expect(dialog.getByRole('alert')).toContainText('locked');
    expect(state.writes).toEqual([]);
    await snapshot(page, state, 'future-lock-local-refusal');
    await page.keyboard.press('Escape');
  });
});

test('complete selection query and bounded owner reads refuse invalid, ambiguous, missing and current service failures', async ({
  browser,
}) => {
  const valid = `/bank/spaces?ignored=1?inner=2&space=${targetId}`;
  for (const [name, url, expected] of [
    ['complete-valid-search', valid, 'ready'],
    ['duplicate-valid', `${selectedURL()}&space=${primaryId}`, 'invalid'],
    ['blank', '/bank/spaces?space=', 'invalid'],
    ['nested-duplicate', `/bank/spaces?space=${targetId}?ignored=1&space=${primaryId}`, 'invalid'],
    ['oversized', `/bank/spaces?space=${'a'.repeat(201)}`, 'invalid'],
  ])
    await scenario(browser, `query-${name}`, async ({ page, state }) => {
      await login(page, url);
      if (expected === 'ready') {
        await ready(page);
        expect(listReads(state).at(-1).input.limit).toBe(200);
      } else {
        await expect(selection(page).getByRole('heading', { name: ui.en.invalid, exact: true })).toBeVisible();
        await expect(selection(page).locator('a[href^="/bank/transfers"]')).toHaveCount(0);
      }
      await bankNavigation(page);
      await expect(main(page).getByRole('button', { name: 'Create space', exact: true })).toBeEnabled();
      await snapshot(page, state, `query-${name}-before-next-action`);
    });
  await scenario(browser, 'invalid-from-manual-current-recovery', async ({ page, state }) => {
    await login(page, `/bank/transfers?from=${targetId}?ignored=1&from=${primaryId}`);
    const source = main(page).getByLabel(ui.en.from, { exact: true });
    await expect(source).toHaveValue('');
    await expect(main(page).getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
    await snapshot(page, state, 'invalid-from-before-explicit-choice');
    await source.selectOption(primaryId);
    await main(page).getByRole('button', { name: 'Continue', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[name="toSpaceId"]').fill('50000000-0000-4000-8000-000000000001');
    await dialog.locator('input[name="amount"]').fill('0.000000000000000001');
    await dialog.locator('form button[type="submit"]').click();
    await expect(dialog.locator('form')).toHaveCount(0);
    await expect(dialog).toContainText('Main USDT');
    expect(state.writes).toEqual([]);
    await page.keyboard.press('Escape');
  });
  for (const kind of ['missing-200', 'conflicting-id', 'malformed', 'forbidden', 'unreachable', 'unauthorized'])
    await scenario(browser, `read-${kind}`, async ({ page, state }) => {
      state.answer = async ({ input, owner }) => {
        if (kind === 'missing-200')
          return {
            status: 200,
            data: Array.from({ length: 200 }, (_, index) =>
              makeSpace(
                `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                'named',
                `Bounded current reserve ${index + 1}`,
                '1',
                owner,
              ),
            ).slice(0, input.limit),
          };
        if (kind === 'conflicting-id')
          return {
            status: 200,
            data: [
              makeSpace(targetId, 'named', targetName, targetBalance, owner),
              makeSpace(targetId, 'named', 'Conflicting current name', '2', owner),
            ],
          };
        if (kind === 'malformed')
          return { status: 200, data: [{ ...makeSpace(targetId, 'named', targetName, targetBalance, owner), balance: 'NaN' }] };
        return {
          status: kind === 'forbidden' ? 403 : kind === 'unauthorized' ? 401 : 503,
          code: kind === 'forbidden' ? 'scope.denied' : kind === 'unauthorized' ? 'auth.unauthorized' : 'fixture.space_unreachable',
        };
      };
      await login(page, selectedURL());
      if (kind === 'unauthorized') {
        await expect(main(page).getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
        await expect(selection(page)).toHaveCount(0);
        await expect(main(page).getByText(targetName, { exact: true })).toHaveCount(0);
        const signIn = main(page).getByRole('link', { name: 'Sign in', exact: true });
        await expect(signIn).toHaveAttribute('href', `/login?redirect=${encodeURIComponent(selectedURL())}`);
        await snapshot(page, state, 'read-unauthorized-guest-before-login');
        state.answer = async ({ input, owner }) => ({ status: 200, data: rows(owner).slice(0, input.limit) });
        await signIn.click();
        await submitLogin(page, selectedURL());
        await ownerProof(page);
        await ready(page);
        expect(state.logins).toHaveLength(2);
      } else {
        const panel = selection(page);
        if (kind === 'missing-200') {
          await expect(panel.getByRole('heading', { name: ui.en.missing, exact: true })).toBeVisible();
          await expect(panel).toContainText(targetId);
          await expect(main(page)).toContainText('200');
        } else if (kind === 'conflicting-id') {
          await expect(panel.getByRole('heading', { name: ui.en.conflict, exact: true })).toBeVisible();
          await expect(main(page).locator(`a[href="/bank/transfers?from=${targetId}"]`)).toHaveCount(0);
          await expect(main(page).getByRole('button', { name: 'Archive label', exact: true })).toHaveCount(0);
        } else await expect(main(page).getByRole('button', { name: 'Try again', exact: true }).first()).toBeVisible();
        await expect(panel.locator('a[href^="/bank/transfers"]')).toHaveCount(0);
        await expect(panel).not.toContainText('1,250.000000000000000001 USDT');
        await snapshot(page, state, `read-${kind}-before-recovery`);
        state.answer = async ({ input, owner }) => ({ status: 200, data: rows(owner).slice(0, input.limit) });
        if (['missing-200', 'conflicting-id'].includes(kind)) await refresh(page);
        else await retry(page);
        await ready(page);
        expect(listReads(state).at(-1).input).toEqual({ limit: 200 });
      }
      expect(state.documents).toHaveLength(1);
      expect(state.writes).toEqual([]);
    });
});

test('current URL and owner leases refuse retired results while dialogs and original recovery keep their own context', async ({
  browser,
}) => {
  await scenario(browser, 'late-A-current-B-and-retired-refresh', async ({ page, state }) => {
    const held = pause();
    state.held.push(held);
    let old = true;
    const staleName = 'Retired A response must not become current';
    state.answer = async ({ input, owner }) => {
      const captured = rows(owner);
      if (input.limit === 200 && old) {
        old = false;
        await held.promise;
        return { status: 200, data: captured.map((row) => (row.id === targetId ? { ...row, name: staleName } : row)) };
      }
      return { status: 200, data: [...captured, makeSpace(otherId, 'named', 'Current B reserve', '2', owner)].slice(0, input.limit) };
    };
    await login(page, selectedURL());
    await expect.poll(() => listReads(state).length).toBeGreaterThan(0);
    await captureHandler(main(page).getByRole('button', { name: 'Refresh', exact: true }).first(), '__oldSelectedRefresh');
    await page.evaluate((url) => {
      history.pushState(null, '', url);
      dispatchEvent(new PopStateEvent('popstate'));
    }, selectedURL(otherId));
    await ready(page, { id: otherId, name: 'Current B reserve', balance: '2' });
    held.release();
    await frames(page);
    await expect(selection(page)).not.toContainText(staleName);
    const count = listReads(state).length;
    await page.evaluate(() => window.__oldSelectedRefresh());
    await frames(page);
    expect(listReads(state)).toHaveLength(count);
    await refresh(page);
    await expect.poll(() => listReads(state).length).toBeGreaterThan(count);
    await ready(page, { id: otherId, name: 'Current B reserve', balance: '2' });
    for (const mode of ['query', 'hash', 'batched']) {
      await captureHandler(main(page).getByRole('button', { name: 'Refresh', exact: true }).first(), '__retiredEpochRefresh');
      if (mode === 'query') {
        await page.evaluate((url) => {
          history.pushState(null, '', `${url}&departed=query`);
          dispatchEvent(new PopStateEvent('popstate'));
        }, selectedURL(otherId));
        await frames(page);
        await page.evaluate((url) => {
          history.pushState(null, '', url);
          dispatchEvent(new PopStateEvent('popstate'));
        }, selectedURL(otherId));
      } else
        await page.evaluate(
          ({ mode, url }) => {
            if (mode === 'hash') {
              history.pushState(null, '', `${url}#departed`);
              dispatchEvent(new HashChangeEvent('hashchange'));
              history.pushState(null, '', url);
              dispatchEvent(new HashChangeEvent('hashchange'));
            } else {
              history.pushState(null, '', `${url}&departed=${mode}`);
              dispatchEvent(new PopStateEvent('popstate'));
              history.pushState(null, '', url);
              dispatchEvent(new PopStateEvent('popstate'));
            }
          },
          { mode, url: selectedURL(otherId) },
        );
      await ready(page, { id: otherId, name: 'Current B reserve', balance: '2' });
      await frames(page);
      const before = listReads(state).length;
      await page.evaluate(() => window.__retiredEpochRefresh());
      await frames(page);
      expect(listReads(state)).toHaveLength(before);
      await refresh(page);
      await expect.poll(() => listReads(state).length).toBeGreaterThan(before);
      await ready(page, { id: otherId, name: 'Current B reserve', balance: '2' });
    }
    await snapshot(page, state, 'current-B-after-ABA-opposites');
    expect(state.documents).toHaveLength(1);
  });
  await scenario(browser, 'late-arrival-does-not-steal-create-fields', async ({ page, state }) => {
    const held = pause();
    state.held.push(held);
    let first = true;
    state.answer = async ({ input, owner }) => {
      const data = rows(owner).slice(0, input.limit);
      if (first) {
        first = false;
        await held.promise;
      }
      return { status: 200, data };
    };
    await login(page, selectedURL());
    await main(page).getByRole('button', { name: 'Create space', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[name="assetId"]').fill('USDT');
    const name = dialog.locator('input[name="name"]');
    await name.fill('Private current create fields');
    held.release();
    await expect(main(page)).toContainText(targetName);
    await frames(page);
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('Private current create fields');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await ready(page);
    expect(JSON.stringify(await inspectStorage(page))).not.toContain('Private current create fields');
  });
  for (const nextOwner of [ownerA, ownerB])
    await scenario(browser, `retired-owner-${nextOwner === ownerA ? 'same-new-token' : 'different'}`, async ({ page, state }) => {
      await login(page, selectedURL());
      await ready(page);
      await captureHandler(main(page).getByRole('button', { name: 'Refresh', exact: true }).first(), '__previousOwnerRefresh');
      const origin = await page.evaluate(() => performance.timeOrigin);
      await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(selection(page)).toHaveCount(0);
      state.owner = nextOwner;
      await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
      await page.getByRole('dialog').getByRole('link', { name: 'Sign in', exact: true }).click();
      await submitLogin(page, '/money');
      await ownerProof(page, nextOwner);
      const count = listReads(state).length;
      await page.evaluate(() => window.__previousOwnerRefresh());
      await frames(page);
      expect(listReads(state)).toHaveLength(count);
      await main(page).locator('a[href="/bank"]').click();
      await ordinarySelectedLink(page);
      await ready(page);
      await refresh(page);
      await ready(page);
      expect(state.logins.map((row) => row.owner)).toEqual([ownerA, nextOwner]);
      expect(state.logins[0].token).not.toBe(state.logins[1].token);
      expect(listReads(state).at(-1).authorization).toBe(`Bearer ${state.logins[1].token}`);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
      expect(state.documents).toHaveLength(1);
    });
  for (const unreadable of [false, true])
    await scenario(browser, `original-${unreadable ? 'unreadable' : 'unknown'}`, async ({ page, state }) => {
      state.unlocked = true;
      await login(page);
      await page.evaluate(
        ({ key, original, unreadable }) => {
          localStorage.setItem(key, original);
          window.__selectedOriginalGet = Storage.prototype.getItem;
          if (unreadable)
            Storage.prototype.getItem = function (candidate) {
              if (candidate === key) throw new DOMException('Isolated getItem-only refusal', 'SecurityError');
              return window.__selectedOriginalGet.call(this, candidate);
            };
        },
        { key: bankKey, original, unreadable },
      );
      await ordinarySelectedLink(page);
      const recovery = main(page).locator('#bank-unconfirmed');
      await expect(recovery).toHaveAttribute('role', 'alert');
      await expect(recovery).toContainText('Bank writes are paused');
      if (!unreadable) await expect(recovery).toContainText(originalReference);
      const raw = () =>
        page.evaluate((key) => (window.__selectedOriginalGet ?? Storage.prototype.getItem).call(localStorage, key), bankKey);
      expect(await raw()).toBe(original);
      await ready(page);
      await expect(main(page)).toBeFocused();
      await aboveFooter(recovery.getByRole('heading'));
      await snapshot(page, state, `original-${unreadable ? 'unreadable' : 'unknown'}-current-before-transfer`);
      await selectedTransfer(page).click();
      await expect(main(page).getByLabel(ui.en.from, { exact: true })).toHaveValue(targetId);
      await main(page).getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(recovery).toBeVisible();
      expect(await raw()).toBe(original);
      expect(state.writes).toEqual([]);
      await page.evaluate(() => {
        Storage.prototype.getItem = window.__selectedOriginalGet;
      });
      await main(page).locator('.money-bank-nav a[href="/bank"]').click();
      await ordinarySelectedLink(page);
      await ready(page);
      state.answer = async () => ({ status: 503, code: 'fixture.original_read_unreachable' });
      await refresh(page);
      await expect(main(page).getByRole('button', { name: 'Try again', exact: true }).first()).toBeVisible();
      expect(await raw()).toBe(original);
      await expect(recovery).toContainText(originalReference);
      state.answer = async ({ input, owner }) => ({ status: 200, data: state.currentRows(owner).slice(0, input.limit) });
      await retry(page);
      await ready(page);
      expect(await raw()).toBe(original);
      await expect(recovery).toContainText(originalReference);
      if (!unreadable) {
        await page.reload();
        await expect(main(page).getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
        expect(await raw()).toBe(original);
        await main(page).getByRole('link', { name: 'Sign in', exact: true }).click();
        await submitLogin(page, selectedURL());
        await ownerProof(page);
        await ready(page);
        expect(await raw()).toBe(original);
        await expect(recovery).toContainText(originalReference);
        expect(state.documents).toHaveLength(2);
      }
    });
});
