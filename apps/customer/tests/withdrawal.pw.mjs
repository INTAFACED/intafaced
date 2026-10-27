import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const evidence = process.env.WITHDRAWAL_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const prefsKey = 'intafaced.customer.view.v1';
const journalKey = 'intafaced.customer.bank-unconfirmed.v1:' + owner;
const original = {
  id,
  userId: owner,
  assetId: 'USDT',
  amount: '2.500000000000000001',
  rail: 'bank-wire',
  destination: { kind: 'bank', ref: '<opaque-original-destination>' + 'x'.repeat(170) },
  clientRef: '<opaque-client-reference>' + 'y'.repeat(120),
  railRef: 'opaque-rail-' + 'z'.repeat(180),
  attempts: 1,
  failureCode: null,
  status: 'held',
  createdAt: '2026-10-10T09:20:00Z',
};
const states = new WeakMap(),
  errors = new WeakMap(),
  summaries = [];
const reply = (route, data) => route.fulfill({ json: { result: { data } } });
const refusal = (route, status, code) =>
  route.fulfill({ status, json: { error: { message: 'Isolated service refusal', data: { intafacedCode: code } } } });
const routeInput = (route) => JSON.parse(new URL(route.request().url()).searchParams.get('input') || '{}');
test.beforeEach(({ page }) => {
  const list = [];
  errors.set(page, list);
  page.on('pageerror', () => list.push(true));
});
test.afterEach(({ page }, info) => {
  expect(errors.get(page).length).toBe(0);
  expect(states.get(page)?.unexpectedWrites || 0).toBe(0);
  summaries.push({
    name: info.title,
    status: info.status,
    pageErrors: errors.get(page).length,
    unexpectedWrites: states.get(page)?.unexpectedWrites || 0,
    reads: states.get(page)?.reads.length || 0,
  });
});
test.afterAll(() =>
  writeFileSync(
    evidence + '/native-summary.json',
    JSON.stringify({ summaries, privateDiagnostics: false, fixtures: 'isolated in RAM; no live/provider/ledger writes' }, null, 2),
  ),
);
async function setup(page, options = {}) {
  const state = {
    reads: [],
    unexpectedWrites: 0,
    actor: owner,
    token: 0,
    records: [structuredClone(original), { ...original, id: otherId, amount: '0.000000000000000001', status: 'sent' }],
    detail: structuredClone(original),
  };
  states.set(page, state);
  await page.route('**/api/**', async (route) => {
    const procedure = new URL(route.request().url()).pathname.split('/').at(-1);
    if (procedure === 'auth.login')
      return reply(route, {
        userId: state.actor,
        accessToken: 'isolated-withdrawal-' + ++state.token,
        refreshToken: 'isolated-refresh',
        expiresAt: '2027-10-10T00:00:00Z',
      });
    if (procedure === 'auth.logout') return reply(route, { ok: true });
    if (procedure === 'withdrawal.mine' || procedure === 'withdrawal.get') {
      expect(route.request().method()).toBe('GET');
      state.reads.push({ procedure, input: routeInput(route) });
      if (options.read) return options.read(route, state, procedure);
      return reply(route, procedure === 'withdrawal.mine' ? state.records : state.detail);
    }
    if (route.request().method() !== 'GET') state.unexpectedWrites++;
    return refusal(route, 503, 'isolated.unavailable');
  });
  await page.goto('/login?redirect=' + encodeURIComponent(options.path || '/uc/withdraw'));
  await page.getByLabel('Email or handle', { exact: true }).fill('withdrawal@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (options.signedOut) await expect(page.locator('main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  else await expect(page.locator('main :is([data-testid="withdrawal-page"], [data-testid="approve-address"])')).toBeVisible();
  return state;
}
const privateVisible = (page, value) => page.locator('main').evaluate((node, text) => node.textContent.includes(text), value);
async function fit(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const sizes = await page
    .locator(
      'main :is([data-testid="withdrawal-page"], [data-testid="approve-address"]) button, main :is([data-testid="withdrawal-page"], [data-testid="approve-address"]) a.button, main :is([data-testid="withdrawal-page"], [data-testid="approve-address"]) input',
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return r.height >= 44 && r.width >= 44;
      }),
    );
  expect(sizes.every(Boolean)).toBe(true);
}
async function capture(page, name) {
  await page.screenshot({
    path: evidence + '/' + name + '.png',
    fullPage: true,
    mask: [page.locator('[data-withdrawal-private], [data-withdrawal-amount], [data-testid="money-reference"], input')],
    maskColor: '#171717',
  });
}
async function move(page, path) {
  await page.evaluate((next) => {
    history.pushState(null, '', next);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test('same-turn sign out invalidates retained original lookup while the current owner lookup works', async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByTestId('withdrawal-row')).toHaveCount(2);
  await page.getByLabel('Withdrawal ID', { exact: true }).fill(id);
  await page.evaluate(() => {
    const form = document.querySelector('[data-testid="withdrawal-lookup"]');
    const props = form[Object.keys(form).find((key) => key.startsWith('__reactProps$'))];
    props.onSubmit({ preventDefault() {} });
  });
  await expect(page.getByTestId('withdrawal-facts')).toBeVisible();
  await page.getByRole('link', { name: 'View your withdrawals', exact: true }).click();
  await expect(page.getByTestId('withdrawal-row')).toHaveCount(2);
  await page.getByLabel('Withdrawal ID', { exact: true }).fill(id);
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  const reads = state.reads.length;
  const observed = await page.evaluate(() => {
    const form = document.querySelector('[data-testid="withdrawal-lookup"]');
    const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
    const retained = props(form).onSubmit;
    let fiber = form[Object.keys(form).find((key) => key.startsWith('__reactFiber$'))];
    let session;
    while (fiber) {
      const value = fiber.memoizedProps?.value;
      if (value?.api && typeof value.clear === 'function') {
        session = value;
        break;
      }
      fiber = fiber.return;
    }
    if (!session) throw new Error('Actual SessionProvider not found');
    const before = location.pathname + location.search;
    const oldApi = session.api;
    const currentBefore = oldApi.canWrite();
    const signout = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Sign out');
    props(signout).onClick();
    const currentAfter = oldApi.canWrite();
    retained({ preventDefault() {} });
    return { before, after: location.pathname + location.search, currentBefore, currentAfter };
  });
  expect(observed).toEqual({ before: '/uc/withdraw', after: '/uc/withdraw', currentBefore: true, currentAfter: false });
  await expect(page.locator('main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(state.reads.length).toBe(reads);
});
for (const locale of ['en', 'es', 'fr'])
  for (const width of [1440, 768, 390, 320]) {
    test(`owned list and detail fit ${locale} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      const state = await setup(page);
      await expect(page.getByTestId('withdrawal-row')).toHaveCount(2);
      await page.evaluate(
        ({ prefsKey, locale }) => {
          localStorage.setItem(prefsKey, JSON.stringify({ language: locale }));
          dispatchEvent(new StorageEvent('storage', { key: prefsKey, storageArea: localStorage }));
        },
        { prefsKey, locale },
      );
      await expect
        .poll(() =>
          page
            .locator(':is([data-testid="withdrawal-page"], [data-testid="approve-address"])')
            .evaluate((node, language) => node.closest('[lang]')?.lang === language, locale),
        )
        .toBe(true);
      expect(
        await page
          .locator('[data-withdrawal-amount]')
          .first()
          .evaluate((node) => node.textContent === '2.500000000000000001 USDT'),
      ).toBe(true);
      expect(
        await page
          .locator('[data-withdrawal-amount]')
          .nth(1)
          .evaluate((node) => node.textContent === '0.000000000000000001 USDT'),
      ).toBe(true);
      expect(await page.locator('main').evaluate((node) => !node.textContent.includes('Design sample'))).toBe(true);
      await fit(page);
      await capture(page, `isolated-list-${locale}-${width}`);
      await page.getByTestId('withdrawal-open').first().focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('withdrawal-facts')).toBeVisible();
      expect(await privateVisible(page, original.clientRef)).toBe(true);
      expect(await privateVisible(page, original.destination.ref)).toBe(true);
      expect(await page.locator('[data-withdrawal-private]').evaluateAll((nodes) => nodes.every((node) => node.lang === 'und'))).toBe(true);
      expect(await page.locator('[data-testid="withdrawal-facts"] img, [data-testid="withdrawal-facts"] script').count()).toBe(0);
      await fit(page);
      await capture(page, `isolated-detail-${locale}-${width}`);
      await page.evaluate(
        ({ prefsKey, locale }) => {
          localStorage.setItem(prefsKey, JSON.stringify({ language: locale, hideBalances: true }));
          dispatchEvent(new StorageEvent('storage', { key: prefsKey, storageArea: localStorage }));
        },
        { prefsKey, locale },
      );
      await expect.poll(() => page.locator('[data-withdrawal-amount]').evaluate((node) => node.textContent === '•••• USDT')).toBe(true);
      const before = state.reads.length;
      await page.locator('[data-testid="withdrawal-detail"] button').click();
      await expect.poll(() => state.reads.length > before).toBe(true);
      await expect(page.getByTestId('withdrawal-facts')).toBeVisible();
      expect(state.reads.filter((read) => read.procedure === 'withdrawal.get').every((read) => read.input.withdrawalId === id)).toBe(true);
    });
  }
test('explicit window expands only on a full response and stops at 200', async ({ page }) => {
  const state = await setup(page, {
    read: (route, state, procedure) =>
      reply(
        route,
        procedure === 'withdrawal.mine'
          ? Array.from({ length: routeInput(route).limit }, (_, index) => ({
              ...original,
              id: `${(index + 1).toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
            }))
          : state.detail,
      ),
  });
  await expect(page.getByTestId('withdrawal-row')).toHaveCount(50);
  for (const limit of [100, 150, 200]) {
    await page.getByRole('button', { name: 'Load up to ' + limit, exact: true }).click();
    await expect(page.getByTestId('withdrawal-row')).toHaveCount(limit);
  }
  await expect(page.getByRole('button', { name: /Load up to/ })).toHaveCount(0);
  expect([...new Set(state.reads.map((read) => read.input.limit))]).toEqual([50, 100, 150, 200]);
  await expect(page.getByText('More records may exist.', { exact: false })).toBeVisible();
});
test('empty bounded read, loading, failure and refresh preserve honest states', async ({ page }) => {
  let held,
    mode = 'held';
  const state = await setup(page, {
    read: (route) => {
      if (mode === 'held') {
        held = route;
        return new Promise(() => {});
      }
      if (mode === 'failure') return refusal(route, 503, 'isolated.unavailable');
      return reply(route, []);
    },
  });
  await expect(page.locator('main [data-testid="loading"]')).toBeVisible();
  await expect(page.getByTestId('withdrawal-row')).toHaveCount(0);
  mode = 'empty';
  await reply(held, []);
  await expect(page.getByRole('heading', { name: 'No withdrawal records returned', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Load up to/ })).toHaveCount(0);
  mode = 'failure';
  await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
  await expect(page.locator('main [data-testid="failure"]')).toBeVisible();
  mode = 'empty';
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No withdrawal records returned', exact: true })).toBeVisible();
  expect(state.reads.every((read) => read.input.limit === 50)).toBe(true);
});
for (const kind of ['numeric', 'owner', 'original', 'status'])
  test(`detail refuses ${kind} response and refreshes the same original`, async ({ page }) => {
    const change =
      kind === 'numeric'
        ? { amount: 1 }
        : kind === 'owner'
          ? { userId: other }
          : kind === 'original'
            ? { id: otherId }
            : { status: 'delivered' };
    let bad = true;
    const state = await setup(page, {
      path: '/uc/withdraw?withdrawalId=' + id,
      read: (route) => reply(route, { ...original, ...(bad ? change : {}) }),
    });
    await expect(page.locator('main [data-testid="failure"]')).toBeVisible();
    expect(await privateVisible(page, original.destination.ref)).toBe(false);
    bad = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByTestId('withdrawal-facts')).toBeVisible();
    expect(state.reads.every((read) => read.input.withdrawalId === id)).toBe(true);
  });
for (const kind of ['malformed', 'duplicate'])
  test(`invalid ${kind} query refuses all withdrawal GETs`, async ({ page }) => {
    const state = await setup(page, {
      path: '/uc/withdraw?withdrawalId=' + (kind === 'malformed' ? 'bad' : id + '&withdrawalId=' + otherId),
    });
    await expect(page.getByText('Enter one valid original withdrawal ID.', { exact: true })).toBeVisible();
    expect(state.reads.length).toBe(0);
    await page.getByLabel('Withdrawal ID', { exact: true }).fill(id);
    await page.getByRole('button', { name: 'Open record', exact: true }).click();
    await expect(page.getByTestId('withdrawal-facts')).toBeVisible();
    expect(state.reads.every((read) => read.procedure === 'withdrawal.get' && read.input.withdrawalId === id)).toBe(true);
  });
for (const kind of ['named404', 'unmounted404', 'forbidden403'])
  test(`${kind} recovery preserves the original and clears private response`, async ({ page }) => {
    let denied = true;
    const state = await setup(page, {
      path: '/uc/withdraw?withdrawalId=' + id,
      read: (route) =>
        denied
          ? refusal(
              route,
              kind === 'forbidden403' ? 403 : 404,
              kind === 'named404' ? 'pay.withdrawal_not_found' : kind === 'unmounted404' ? 'NOT_FOUND' : 'FORBIDDEN',
            )
          : reply(route, original),
    });
    await expect(page.locator('main [data-testid="failure"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Withdrawal not found', exact: true })).toHaveCount(kind === 'named404' ? 1 : 0);
    expect(await privateVisible(page, original.destination.ref)).toBe(false);
    denied = false;
    await page.getByRole('button', { name: kind === 'named404' ? 'Refresh this record' : 'Try again', exact: true }).click();
    await expect(page.getByTestId('withdrawal-facts')).toBeVisible();
    expect(state.reads.every((read) => read.input.withdrawalId === id)).toBe(true);
  });
test('401 returns through real Login to the same original under a new API session', async ({ page }) => {
  let denied = true;
  const state = await setup(page, {
    signedOut: true,
    path: '/uc/withdraw?withdrawalId=' + id,
    read: (route) => (denied ? refusal(route, 401, 'UNAUTHORIZED') : reply(route, original)),
  });
  await expect(page.locator('main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  denied = false;
  await page.locator('main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email or handle', { exact: true }).fill('same-owner@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByTestId('withdrawal-facts')).toBeVisible();
  expect(state.token).toBe(2);
  expect(state.reads.every((read) => read.input.withdrawalId === id)).toBe(true);
});
for (const departure of ['query', 'hash'])
  test(`observed ${departure} ABA retires handlers and private fields synchronously`, async ({ page }) => {
    const state = await setup(page);
    await expect(page.getByTestId('withdrawal-row')).toHaveCount(2);
    await page.getByLabel('Withdrawal ID', { exact: true }).fill(id);
    const departed = await page.evaluate((kind) => {
      const button = document.querySelector(':is([data-testid="withdrawal-page"], [data-testid="approve-address"]) button');
      const form = document.querySelector('[data-testid="withdrawal-lookup"]');
      const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps'))];
      window.retired = { refresh: props(button).onClick, submit: props(form).onSubmit };
      const original = location.href;
      history.pushState(null, '', original + (kind === 'query' ? '?departed=1' : '#departed'));
      dispatchEvent(kind === 'query' ? new PopStateEvent('popstate') : new HashChangeEvent('hashchange'));
      const cleared = !document.querySelector('[data-testid="withdrawal-lookup"] input')?.value;
      history.pushState(null, '', original);
      dispatchEvent(kind === 'query' ? new PopStateEvent('popstate') : new HashChangeEvent('hashchange'));
      return cleared;
    }, departure);
    expect(departed).toBe(true);
    await expect(page.getByTestId('withdrawal-row')).toHaveCount(2);
    const before = state.reads.length;
    await page.evaluate(() => {
      window.retired.refresh();
      window.retired.submit({ preventDefault() {} });
    });
    expect(state.reads.length).toBe(before);
    expect(await page.getByLabel('Withdrawal ID', { exact: true }).inputValue()).toBe('');
    expect(await page.evaluate(() => !location.search)).toBe(true);
  });
test('same URL event remains valid and retained detail handlers retire on unmount', async ({ page }) => {
  const state = await setup(page, { path: '/uc/withdraw?withdrawalId=' + id });
  await expect(page.getByTestId('withdrawal-facts')).toBeVisible();
  await page.evaluate(() => {
    const node = document.querySelector('[data-testid="withdrawal-detail"] button');
    window.retiredRefresh = node[Object.keys(node).find((key) => key.startsWith('__reactProps'))].onClick;
    dispatchEvent(new PopStateEvent('popstate'));
  });
  const before = state.reads.length;
  await page.evaluate(() => window.retiredRefresh());
  await expect.poll(() => state.reads.length > before).toBe(true);
  await expect(page.getByTestId('withdrawal-facts')).toBeVisible();
  await move(page, '/support');
  const after = state.reads.length;
  await page.evaluate(() => window.retiredRefresh());
  expect(state.reads.length).toBe(after);
  expect(await privateVisible(page, original.destination.ref)).toBe(false);
});
test('late detail cannot contaminate another original after full URL departure', async ({ page }) => {
  let held;
  const state = await setup(page, {
    path: '/uc/withdraw?withdrawalId=' + id,
    read: (route) => {
      if (routeInput(route).withdrawalId === id) {
        held = route;
        return new Promise(() => {});
      }
      return reply(route, { ...original, id: otherId, clientRef: 'other-original-only-in-memory' });
    },
  });
  await expect(page.locator('main [data-testid="loading"]')).toBeVisible();
  await move(page, '/uc/withdraw?withdrawalId=' + otherId);
  await expect(page.getByTestId('withdrawal-facts')).toBeVisible();
  await reply(held, original).catch(() => {});
  expect(await privateVisible(page, original.clientRef)).toBe(false);
  expect(await privateVisible(page, 'other-original-only-in-memory')).toBe(true);
  expect(state.reads.some((read) => read.input.withdrawalId === otherId)).toBe(true);
});
test('owner and API replacement retire private reads and retained refresh through actual Login', async ({ page }) => {
  let held,
    hold = false;
  const state = await setup(page, {
    path: '/uc/withdraw?withdrawalId=' + id,
    read: (route, state) => {
      if (hold && state.actor === owner) {
        held = route;
        return new Promise(() => {});
      }
      if (state.actor === other && routeInput(route).withdrawalId === id) return refusal(route, 403, 'FORBIDDEN');
      return reply(route, { ...original, id: state.actor === other ? otherId : id, userId: state.actor });
    },
  });
  await expect(page.getByTestId('withdrawal-facts')).toBeVisible();
  await page.evaluate(() => {
    const node = document.querySelector('[data-testid="withdrawal-detail"] button');
    window.retiredOwnerRefresh = node[Object.keys(node).find((key) => key.startsWith('__reactProps'))].onClick;
  });
  hold = true;
  await page.locator('[data-testid="withdrawal-detail"] button').click();
  await expect(page.locator('main [data-testid="loading"]')).toBeVisible();
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('main').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(await privateVisible(page, original.destination.ref)).toBe(false);
  state.actor = other;
  await page.locator('main').getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email or handle', { exact: true }).fill('other-owner@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('main [data-testid="failure"]')).toBeVisible();
  const before = state.reads.length;
  await page.evaluate(() => window.retiredOwnerRefresh());
  expect(state.reads.length).toBe(before);
  await reply(held, original).catch(() => {});
  expect(await privateVisible(page, original.destination.ref)).toBe(false);
  await move(page, '/uc/withdraw?withdrawalId=' + otherId);
  await expect(page.getByTestId('withdrawal-facts')).toBeVisible();
  expect(state.token).toBe(2);
});
test('existing unknown journal bytes survive list/detail reads and huge exact amount remains readable', async ({ page }) => {
  await page.addInitScript(
    ({ journalKey }) => {
      localStorage.setItem(journalKey, '{unreadable-original');
    },
    { journalKey },
  );
  const state = await setup(page);
  await expect(page.getByTestId('withdrawal-row')).toHaveCount(2);
  const before = await page.evaluate((key) => localStorage.getItem(key), journalKey);
  state.detail.amount = '99999999999999999999.000000000000000001';
  await page.getByTestId('withdrawal-open').first().click();
  await expect(page.getByTestId('withdrawal-facts')).toBeVisible();
  expect(
    await page
      .locator('[data-withdrawal-amount]')
      .evaluate((node) => node.textContent === '99,999,999,999,999,999,999.000000000000000001 USDT'),
  ).toBe(true);
  await fit(page);
  expect(await page.evaluate((key) => localStorage.getItem(key), journalKey)).toBe(before);
  expect(await page.evaluate(() => Object.keys(localStorage).every((key) => !key.includes('withdrawal')))).toBe(true);
});
