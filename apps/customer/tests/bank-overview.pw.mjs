import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const baseURL = process.env.BANK_OVERVIEW_BASE_URL;
const evidence = process.env.BANK_OVERVIEW_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Use the explicit verified-candidate environment from the Bank config.');
mkdirSync(evidence, { recursive: true });
const contractPin = '26863e271c325bc02c6ef9e3697aa74dc44cf37e';
const owner = '11111111-1111-4111-8111-111111111111';
const primaryId = '22222222-2222-4222-8222-222222222222';
const namedId = '33333333-3333-4333-8333-333333333333';
const reference = '77777777-7777-4777-8777-777777777777';
const bankKey = `intafaced.customer.bank-unconfirmed.v1:${owner}`;
const preferencesKey = 'intafaced.customer.view.v1';
const original = ` [ ${JSON.stringify({ reference, title: 'Original transfer', procedure: 'transfers.create', recordRefs: { transferId: reference, fromSpaceId: primaryId } })} ] `;
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
const balances = {
  timestamp: 1791621900000,
  datetime: '2026-10-10T08:45:00.000Z',
  balances: {
    USDT: { total: '8000', free: '7500', used: '500' },
    BTC: { total: '0.05', free: '0.05', used: '0' },
    ETH: { total: '2', free: '2', used: '0' },
  },
};
const space = (id, kind, name, balance) => ({
  id,
  assetId: 'USDT',
  kind,
  name,
  balance,
  goalTarget: null,
  lockedUntil: null,
  ledgerAccount: { ownerType: 'user', ownerId: owner, assetId: 'USDT', kind: 'available' },
});
const row = (page, asset) => page.locator(`main a[data-testid="money-holding"][href="/portfolio/${encodeURIComponent(asset)}"]`);
const quantity = (page, asset) =>
  row(page, asset)
    .locator(
      '[data-testid="money-quantity-value"], [data-testid="money-holding-values"] > strong:not(:has([data-testid="money-quantity-value"]))',
    )
    .first();
const bankNav = (page) => page.locator('main [data-testid="money-bank-nav"]');
const main = (page) => page.locator('main');
const currentURL = (page) => page.evaluate(() => location.pathname + location.search + location.hash);
const pause = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

// Existing mounted Money/Bank schemas, isolated HTTP replies in the ordinary App.
// This suite authorizes no financial method and supplies no production sample mode.
async function network(context) {
  const state = {
    reads: [],
    writes: [],
    logins: [],
    documents: [],
    errors: [],
    cancelled: [],
    observations: [],
    balanceStatus: 200,
    spacesStatus: 200,
    unnamedStatus: 200,
    held: null,
    data: structuredClone(balances),
    spaces: [space(primaryId, 'primary', 'Main', '7500'), space(namedId, 'named', 'Trip · exact owned space', '1250')],
    unnamed: [{ assetId: 'USDT', balance: '7500' }],
  };
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
      url = new URL(request.url());
    const procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const reply = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (procedure === 'auth.login') {
      state.logins.push(request.postDataJSON());
      return reply({
        userId: owner,
        accessToken: 'isolated-bank-overview-owner',
        refreshToken: 'isolated-bank-overview-refresh',
        expiresAt: '2027-10-10T00:00:00Z',
      });
    }
    if (procedure === 'auth.logout') return reply({ ok: true });
    if (request.method() !== 'GET') {
      state.writes.push({ path: url.pathname, method: request.method(), body: request.postData() });
      return route.fulfill({ status: 503, json: { message: 'Bank native fixture refuses financial dispatch' } });
    }
    state.reads.push({ path: url.pathname, input: JSON.parse(url.searchParams.get('input') || 'null') });
    const failure = () => route.fulfill({ status: 503, json: { message: 'Isolated account source unavailable' } });
    if (url.pathname.endsWith('/account/balance')) {
      const data = structuredClone(state.data),
        status = state.balanceStatus,
        held = state.held;
      if (held) await held.promise;
      try {
        return status === 200 ? route.fulfill({ status, json: data }) : failure();
      } catch (error) {
        state.cancelled.push(error.message);
        return;
      }
    }
    if (procedure === 'spaces.list') return state.spacesStatus === 200 ? reply(structuredClone(state.spaces)) : failure();
    if (procedure === 'spaces.unnamed') return state.unnamedStatus === 200 ? reply(structuredClone(state.unnamed)) : failure();
    return failure();
  });
  return state;
}
async function scenario(browser, name, run, width = 1440) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 976 }, timezoneId: 'UTC' });
  const state = await network(context),
    page = await context.newPage();
  try {
    await run({ context, page, state });
    expect(state.writes).toEqual([]);
    expect(state.errors).toEqual([]);
  } finally {
    state.held?.release();
    writeFileSync(
      `${evidence}/${name}.json`,
      JSON.stringify(
        {
          contractPin,
          qualification:
            'Ordinary compiled App with actual Login and isolated mounted-shaped HTTP; no live financial/service/SQL/owner-authority proof.',
          ...state,
        },
        (key, value) => (key === 'held' ? undefined : value),
        2,
      ),
    );
    await context.close();
  }
}
async function submitLogin(page, destination) {
  await page.locator('input[name="identifier"]').fill('bank@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect.poll(() => currentURL(page)).toBe(destination);
  await expect(bankNav(page)).toBeVisible();
}
async function login(page, destination = '/bank') {
  await page.goto(`/login?redirect=${encodeURIComponent(destination)}`);
  await submitLogin(page, destination);
}
async function refresh(page) {
  await main(page).getByRole('button', { name: 'Refresh', exact: true }).first().click();
}
async function capture(page, name, state) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  state.observations.push(
    await page.evaluate(() => ({
      href: location.pathname + location.search + location.hash,
      viewport: { width: innerWidth, height: innerHeight, scrollY },
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      active: { tag: document.activeElement?.tagName, text: document.activeElement?.textContent },
    })),
  );
  await page.screenshot({ path: `${evidence}/${name}-viewport.png` });
  await page.screenshot({ path: `${evidence}/${name}-whole.png`, fullPage: true });
  await page.locator('main [data-testid="money-overview-lane"]').screenshot({ path: `${evidence}/${name}-holdings.png` });
}
async function exactAmounts(page) {
  await expect(quantity(page, 'USDT')).toHaveText(/^8,000\s*(?:USDT)?$/);
  await expect(row(page, 'USDT').locator('dd')).toHaveText(['7,500 USDT', '500 USDT']);
  await expect(row(page, 'BTC').locator('dd')).toHaveText(['0.05 BTC', '0 BTC']);
}

test('four widths promote supported quantities and useful tasks while keeping all nine Bank destinations and separate spaces', async ({
  browser,
}) => {
  await scenario(browser, 'hierarchy-navigation', async ({ page, state }) => {
    await login(page);
    await exactAmounts(page);
    await expect(bankNav(page).locator('a')).toHaveCount(9);
    expect(
      await bankNav(page)
        .locator('a')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))),
    ).toEqual(paths);
    const primary = main(page).locator(`a[data-testid="money-space-row"][href="/bank/spaces?space=${primaryId}"]`);
    const named = main(page).locator(`a[data-testid="money-space-row"][href="/bank/spaces?space=${namedId}"]`);
    await expect(primary).toContainText('Primary · included in your account balances');
    await expect(named).toContainText('Named space · balance shown separately');
    await expect(named).toContainText('1,250 USDT');
    // Named1250 and primary7500 must not be added again to the actual total8000.
    await expect(quantity(page, 'USDT')).toHaveText(/^8,000(?: USDT)?$/);
    for (const [width, height] of [
      [1440, 976],
      [768, 976],
      [390, 976],
      [320, 976],
      [390, 844],
      [320, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.evaluate(() => document.fonts.ready);
      const geometry = await row(page, 'USDT').evaluate((element) => {
        const q = element.querySelector('[data-testid="money-holding-values"] > strong');
        const missing = document.querySelector('main [data-testid="money-total"]');
        const tasks = [...document.querySelectorAll('main a.button')].filter((node) =>
          ['/bank/spaces', '/bank/transfers', '/uc/withdraw'].includes(node.getAttribute('href')),
        );
        const nav = document.querySelector('[data-testid="mobile-doors"]');
        const navTop = nav?.getClientRects().length ? nav.getBoundingClientRect().top : innerHeight;
        return {
          width: innerWidth,
          height: innerHeight,
          quantityFont: parseFloat(getComputedStyle(q).fontSize),
          missingFont: parseFloat(getComputedStyle(missing).fontSize),
          quantity: { top: q.getBoundingClientRect().top, bottom: q.getBoundingClientRect().bottom },
          restrictions: [...element.querySelectorAll('dd')].map((node) => ({
            text: node.textContent,
            top: node.getBoundingClientRect().top,
            bottom: node.getBoundingClientRect().bottom,
          })),
          navTop,
          tasks: tasks.map((node) => ({
            href: node.getAttribute('href'),
            top: node.getBoundingClientRect().top,
            bottom: node.getBoundingClientRect().bottom,
            before: Boolean(node.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
          })),
        };
      });
      state.observations.push(geometry);
      expect(geometry.quantityFont).toBeGreaterThan(geometry.missingFont);
      expect(geometry.quantity.top).toBeGreaterThanOrEqual(0);
      expect(geometry.quantity.bottom, 'A supported account quantity should be inspectable in the first phone view').toBeLessThanOrEqual(
        geometry.navTop,
      );
      if (height === 844) {
        expect(geometry.restrictions.map((entry) => entry.text)).toEqual(['7,500 USDT', '500 USDT']);
        for (const restriction of geometry.restrictions) {
          expect(restriction.top).toBeGreaterThanOrEqual(0);
          expect(restriction.bottom, `Returned ${restriction.text} amount must be readable above fixed navigation`).toBeLessThanOrEqual(
            geometry.navTop,
          );
        }
      }
      for (const href of ['/bank/spaces', '/bank/transfers', '/uc/withdraw']) {
        const task = geometry.tasks.find((entry) => entry.href === href);
        expect(task, `Existing ${href} task must be present`).toBeTruthy();
        expect(task.before, 'Useful tasks precede the holdings list').toBe(true);
        expect(task.top).toBeGreaterThanOrEqual(0);
        expect(task.bottom).toBeLessThanOrEqual(geometry.navTop);
      }
      await capture(page, `populated-${width}${height === 976 ? '' : `-${height}`}`, state);
      if (width === 320 || width === 390) {
        await main(page).focus();
        const reached = [];
        for (let step = 0; step < 32; step++) {
          await page.keyboard.press('Tab');
          const focused = await page.evaluate(() => {
            const node = document.activeElement;
            if (!node?.matches('main a.button') || !['/bank/spaces', '/bank/transfers', '/uc/withdraw'].includes(node.getAttribute('href')))
              return null;
            const box = node.getBoundingClientRect(),
              nav = document.querySelector('[data-testid="mobile-doors"]');
            return {
              href: node.getAttribute('href'),
              top: box.top,
              bottom: box.bottom,
              navTop: nav?.getClientRects().length ? nav.getBoundingClientRect().top : innerHeight,
            };
          });
          if (!focused) continue;
          expect(focused.top).toBeGreaterThanOrEqual(0);
          expect(focused.bottom).toBeLessThanOrEqual(focused.navTop);
          reached.push(focused);
          if (new Set(reached.map((entry) => entry.href)).size === 3) break;
        }
        expect(new Set(reached.map((entry) => entry.href)).size).toBe(3);
        state.observations.push({ nativeTabPrimaryTasks: reached });
      }
    }
    for (const href of paths.slice(1)) {
      const link = bankNav(page).locator(`a[href="${href}"]`);
      await link.click();
      await expect.poll(() => currentURL(page)).toBe(href);
      await expect(bankNav(page)).toBeVisible();
      await page.goBack();
      await exactAmounts(page);
    }
  });
});

test('Money to Bank to Spaces Create uses the same document and preserves actual RAM login before guarded form review', async ({
  browser,
}) => {
  await scenario(
    browser,
    'money-bank-create',
    async ({ page, state }) => {
      await page.goto('/login?redirect=%2Fmoney');
      await page.locator('input[name="identifier"]').fill('bank@example.invalid');
      await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
      await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
      await expect.poll(() => currentURL(page)).toBe('/money');
      const bank = page.locator('.money-home a[href="/bank"]');
      await expect(bank).toBeVisible();
      const beforeDocuments = state.documents.length;
      const sentinel = await page.evaluate(() => (window.__bankDocumentCanary = crypto.randomUUID()));
      await bank.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => currentURL(page)).toBe('/bank');
      await exactAmounts(page);
      const create = main(page).locator('a.button[href="/bank/spaces"]').first();
      await expect(create).toBeVisible();
      await create.click();
      await expect.poll(() => currentURL(page)).toBe('/bank/spaces');
      await expect(main(page).getByRole('button', { name: 'Create space', exact: true })).toBeEnabled();
      expect(await page.evaluate(() => window.__bankDocumentCanary)).toBe(sentinel);
      expect(state.documents).toHaveLength(beforeDocuments);
      expect(state.logins).toHaveLength(1);
      await main(page).getByRole('button', { name: 'Create space', exact: true }).click();
      const form = page.getByRole('dialog', { name: 'Create space', exact: true });
      await expect(form).toBeVisible();
      await form.locator('input[name="assetId"]').fill('USDT');
      await form.locator('input[name="name"]').fill('Exact native review');
      await form.getByRole('button', { name: 'Review', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Review create space', exact: true })).toContainText('Exact native review');
      expect(state.writes).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await page.evaluate(() => window.__bankDocumentCanary)).toBe(sentinel);
      await page.goBack();
      await exactAmounts(page);
      const transfers = main(page).locator('a.button[href="/bank/transfers"]').first();
      await transfers.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => currentURL(page)).toBe('/bank/transfers');
      expect(state.logins).toHaveLength(1);
      expect(state.documents).toHaveLength(beforeDocuments);
    },
    320,
  );
});

test('privacy masks all amounts including zero; long exact units fit English Spanish French and honest empty-dictionary fallback', async ({
  browser,
}) => {
  for (const language of ['en', 'es', 'fr', 'ar'])
    await scenario(
      browser,
      `privacy-${language}`,
      async ({ context, page, state }) => {
        const asset = 'UNFAMILIAR-LONG-ASSET';
        const long = '9999999999999999999.000000000000000001';
        state.data.balances[asset] = { total: long, free: long, used: '0' };
        state.spaces[1].name = 'Exact owned label · ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 · not translated';
        await context.addInitScript(
          ({ origin, key, language }) => {
            if (location.origin !== origin) return;
            localStorage.setItem(key, JSON.stringify({ language, timeZone: 'UTC' }));
          },
          { origin: new URL(baseURL).origin, key: preferencesKey, language },
        );
        await login(page);
        await expect(quantity(page, asset)).toHaveText(/^9,999,999,999,999,999,999\.000000000000000001(?: UNFAMILIAR-LONG-ASSET)?$/);
        await expect(row(page, asset).locator('dd')).toHaveText([`9,999,999,999,999,999,999.000000000000000001 ${asset}`, `0 ${asset}`]);
        await expect(main(page).getByTestId('money-space-row').last()).toContainText(state.spaces[1].name);
        const hide = { en: 'Hide amounts', es: 'Ocultar importes', fr: 'Masquer les montants', ar: 'Hide amounts' }[language];
        const show = { en: 'Show amounts', es: 'Mostrar importes', fr: 'Afficher les montants', ar: 'Show amounts' }[language];
        await main(page).getByRole('button', { name: hide, exact: true }).click();
        for (const current of ['USDT', 'BTC', 'ETH', asset]) {
          await expect(quantity(page, current)).toHaveText('••••');
          await expect(row(page, current).locator('dd')).toHaveText(['••••', '••••']);
        }
        for (const saved of await main(page).locator('[data-testid="money-space-row"] [data-testid="numeric"]').all())
          await expect(saved).toHaveText('••••');
        await capture(page, `${language}-hidden`, state);
        await main(page).getByRole('button', { name: show, exact: true }).click();
        await expect(row(page, 'BTC').locator('dd').last()).toHaveText('0 BTC');
        const requested = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).language, preferencesKey);
        expect(requested).toBe(language);
        await expect(page.locator('html')).toHaveAttribute('lang', language === 'ar' ? 'en' : language);
        await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
        if (language === 'ar') {
          await expect(main(page).getByRole('heading', { name: 'Bank', level: 1, exact: true })).toBeVisible();
        }
        await capture(page, `${language}-long`, state);
      },
      language === 'fr' || language === 'ar' ? 320 : 390,
    );
});

test('returned zero empty loading available-only fallback and unavailable sources remain distinct without invented held values or clocks', async ({
  browser,
}) => {
  await scenario(
    browser,
    'source-truth',
    async ({ page, state }) => {
      state.data.balances = { USDT: { total: '0', free: '0', used: '0' } };
      state.spaces = [];
      state.unnamed = [];
      await login(page);
      await expect(quantity(page, 'USDT')).toHaveText(/^0(?: USDT)?$/);
      await expect(row(page, 'USDT').locator('dd')).toHaveText(['0 USDT', '0 USDT']);
      state.data.balances = {};
      await refresh(page);
      await expect(main(page).getByText('No account balances returned', { exact: true })).toBeVisible();
      await expect(main(page).getByTestId('money-holding')).toHaveCount(0);
      state.balanceStatus = 503;
      state.spaces = [space(primaryId, 'primary', 'Main', '7500')];
      state.unnamed = [{ assetId: 'USDT', balance: '7500' }];
      await refresh(page);
      await expect(row(page, 'USDT')).toContainText('Available projection only');
      await expect(quantity(page, 'USDT')).toHaveText(/^7,500(?: USDT)?$/);
      await expect(row(page, 'USDT').locator('dd')).toHaveText(['7,500 USDT', 'Unavailable']);
      await expect(main(page).locator('time')).toHaveCount(0);
      await capture(page, 'available-only-320', state);
      state.spacesStatus = state.unnamedStatus = 503;
      await refresh(page);
      await expect(main(page).getByTestId('money-holding')).toHaveCount(0);
      await expect(main(page).getByText('Holdings could not be loaded.', { exact: true })).toBeVisible();
      await expect(main(page).locator('time')).toHaveCount(0);
      state.balanceStatus = state.spacesStatus = state.unnamedStatus = 200;
      state.data = structuredClone(balances);
      state.held = pause();
      await refresh(page);
      await expect(main(page).getByTestId('money-holding')).toHaveCount(0);
      await expect(bankNav(page).locator('a[href="/bank/spaces"]')).toBeVisible();
      await capture(page, 'loading-320', state);
      state.held.release();
      state.held = null;
      await exactAmounts(page);
      const sourceClock = await page.evaluate(
        (stamp) => [
          new Date(stamp).toLocaleString('en', { timeZone: 'UTC' }),
          new Intl.DateTimeFormat('en', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short',
            timeZone: 'UTC',
          }).format(new Date(stamp)),
        ],
        balances.datetime,
      );
      const sourceText = await main(page).innerText();
      expect(sourceClock.some((clock) => sourceText.includes(clock))).toBe(true);
      await capture(page, 'recovered-320', state);
    },
    320,
  );
});

test('unknown and unreadable originals stay before content byte-exact through refresh navigation and reload with no replay', async ({
  browser,
}) => {
  for (const mode of ['unknown', 'corrupt', 'unreadable'])
    await scenario(
      browser,
      `original-${mode}`,
      async ({ page, state }) => {
        const raw = mode === 'corrupt' ? ' original unreadable bytes { ' : original;
        await page.goto('/login?redirect=%2Fbank');
        await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: bankKey, raw });
        await submitLogin(page, '/bank');
        if (mode === 'unreadable') {
          await page.evaluate((key) => {
            const originalGet = Storage.prototype.getItem;
            window.__bankUnfaultGet = () => (Storage.prototype.getItem = originalGet);
            Storage.prototype.getItem = function (current) {
              if (current === key) throw new Error('Isolated original read unavailable');
              return originalGet.call(this, current);
            };
            dispatchEvent(new StorageEvent('storage', { key }));
          }, bankKey);
        }
        const banner = page.locator('#bank-unconfirmed');
        await expect(banner).toBeVisible();
        if (mode === 'unknown') await expect(banner).toContainText(reference);
        else await expect(banner).toContainText('Recovery required');
        expect(
          await page.evaluate(() =>
            Boolean(
              document.querySelector('#bank-unconfirmed').compareDocumentPosition(document.querySelector('.money-layout')) &
              Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          ),
        ).toBe(true);
        state.data.balances.USDT = { total: '7000', free: '6500', used: '500' };
        await refresh(page);
        await expect(quantity(page, 'USDT')).toHaveText(/^7,000(?: USDT)?$/);
        await expect(banner).toBeVisible();
        await bankNav(page).locator('a[href="/bank/spaces"]').click();
        await expect.poll(() => currentURL(page)).toBe('/bank/spaces');
        await main(page).getByRole('button', { name: 'Create space', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(banner).toBeVisible();
        const geometry = await banner.evaluate((element) => {
          const b = element.getBoundingClientRect(),
            nav = document.querySelector('[data-testid="mobile-doors"]');
          return { top: b.top, bottom: b.bottom, navTop: nav?.getClientRects().length ? nav.getBoundingClientRect().top : innerHeight };
        });
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.top).toBeLessThan(geometry.navTop);
        state.observations.push({ mode, blockedCurrentCreate: true, recovery: geometry });
        if (mode === 'unreadable') await page.evaluate(() => window.__bankUnfaultGet());
        expect(await page.evaluate((key) => localStorage.getItem(key), bankKey)).toBe(raw);
        await page.goBack();
        await expect(banner).toBeVisible();
        await banner.locator('a[href="/support"]').click();
        await expect.poll(() => currentURL(page)).toBe('/support');
        expect(await page.evaluate((key) => localStorage.getItem(key), bankKey)).toBe(raw);
        await page.goBack();
        await page.reload();
        const signIn = main(page).locator('a.button[href="/login?redirect=%2Fbank"]');
        await expect(signIn).toBeVisible();
        expect(await page.evaluate((key) => localStorage.getItem(key), bankKey)).toBe(raw);
        await signIn.click();
        await submitLogin(page, '/bank');
        await expect(banner).toBeVisible();
        expect(await page.evaluate((key) => localStorage.getItem(key), bankKey)).toBe(raw);
        expect(state.writes).toEqual([]);
        await capture(page, `${mode}-reloaded-320`, state);
      },
      320,
    );
});
