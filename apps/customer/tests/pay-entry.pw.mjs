import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const baseURL = process.env.PAY_ENTRY_BASE_URL;
const evidence = process.env.PAY_ENTRY_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Use the explicit verified Pay-entry candidate/evidence environment.');
mkdirSync(evidence, { recursive: true });
const fixed = '66ff0bf2f65b95fe406937106b4c75e74a58ce1c';
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '44444444-4444-4444-8444-444444444444';
const primaryId = '22222222-2222-4222-8222-222222222222';
const namedId = '33333333-3333-4333-8333-333333333333';
const hrefs = ['/pay/send', '/pay/receive', '/p2p', '/pay/request', '/pay/bills', '/pay/global'];
const main = (page) => page.locator('#main');
const task = (page, href) => main(page).locator(`a[href="${href}"]`);
const currentURL = (page) => page.evaluate(() => location.pathname + location.search + location.hash);
function space(owner, kind = 'primary', name = 'Current primary USDT', assetId = 'USDT', balance = '7500') {
  const id = kind === 'primary' ? primaryId : namedId;
  return {
    id,
    assetId,
    kind,
    name,
    goalTarget: null,
    lockedUntil: null,
    balance,
    ledgerAccount: {
      ownerType: kind === 'primary' ? 'user' : 'subaccount',
      ownerId: kind === 'primary' ? owner : id,
      assetId,
      kind: 'available',
    },
  };
}
async function fixtures(context) {
  const state = {
    owner: ownerA,
    logins: [],
    reads: [],
    unexpectedWrites: [],
    errors: [],
    documents: [],
    observations: [],
    cancelled: [],
    pending: [],
  };
  state.answer = async () => ({ status: 200, data: [space(state.owner), space(state.owner, 'named', 'Named reserve — not a primary')] });
  state.offerAnswer = async () => ({ status: 200, data: [publishedOffer()] });
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
      const token = `isolated-pay-entry-token-${state.logins.length + 1}`;
      state.logins.push({ owner: state.owner, token, input: request.postDataJSON() });
      return rpc({
        userId: state.owner,
        accessToken: token,
        refreshToken: 'isolated-pay-entry-refresh',
        expiresAt: '2027-10-10T08:00:00Z',
      });
    }
    if (procedure === 'auth.logout') return rpc({ ok: true });
    if (request.method() !== 'GET') {
      state.unexpectedWrites.push({ path: url.pathname, method: request.method(), body: request.postData() });
      return route.fulfill({
        status: 503,
        json: {
          error: {
            message: 'No financial dispatch is authorized in this isolated Receive acceptance',
            data: { intafacedCode: 'fixture.write_refused' },
          },
        },
      });
    }
    let input;
    try {
      input = JSON.parse(url.searchParams.get('input') || '{}');
    } catch {
      input = url.searchParams.get('input');
    }
    state.reads.push({
      path: url.pathname,
      input,
      inputAbsent: !url.searchParams.has('input'),
      authorization: request.headers().authorization ?? null,
    });
    let answer =
      procedure === 'spaces.list' && url.pathname.startsWith('/api/bank/')
        ? await state.answer()
        : procedure === 'offers.list' && url.pathname.startsWith('/api/p2p/')
          ? await state.offerAnswer()
          : procedure === 'fiat.list' && url.pathname.startsWith('/api/p2p/')
            ? { status: 200, data: [{ code: 'USD', name: 'US Dollar', symbol: '$', minorUnits: 2 }] }
            : { status: 503 };
    try {
      await route.fulfill({
        status: answer.status,
        json:
          answer.status === 200
            ? { result: { data: answer.data } }
            : {
                error: {
                  message: 'Isolated current source unavailable',
                  data: { intafacedCode: answer.code ?? 'fixture.read_unavailable' },
                },
              },
      });
    } catch (error) {
      state.cancelled.push(error.message);
    }
  });
  return state;
}
async function scenario(browser, name, run, width = 1440, height = 1000) {
  const context = await browser.newContext({ baseURL, viewport: { width, height }, timezoneId: 'UTC' });
  const state = await fixtures(context),
    page = await context.newPage();
  try {
    await run({ page, context, state });
    expect(state.unexpectedWrites).toEqual([]);
    expect(state.errors).toEqual([]);
    const reads = state.reads.filter((read) => read.path === '/api/bank/trpc/spaces.list');
    for (const read of reads) {
      expect(read.input).toEqual({ limit: 200 });
      expect(read.authorization).toMatch(/^Bearer isolated-pay-entry-token-/);
    }
  } finally {
    state.pending.forEach((held) => held.release());
    if (!page.isClosed()) {
      state.observations.push(
        await page
          .evaluate(() => ({
            href: location.pathname + location.search + location.hash,
            text: document.querySelector('#main')?.textContent,
            active: document.activeElement?.outerHTML,
            scrollWidth: document.documentElement.scrollWidth,
            width: innerWidth,
          }))
          .catch(() => ({ pageClosed: true })),
      );
      await page.screenshot({ path: `${evidence}/${name}-final.png`, fullPage: true }).catch(() => {});
    }
    writeFileSync(
      `${evidence}/${name}.json`,
      JSON.stringify(
        {
          fixedFixtureSource: fixed,
          qualification:
            'Ordinary compiled App/Login/current owner chrome; isolated mounted-shaped reads. No live JWT/SQL/Edge, financial dispatch or producer authority proof.',
          ...state,
        },
        (key, value) => (typeof value === 'function' || key === 'pending' ? undefined : value),
        2,
      ),
    );
    await context.close();
  }
}
async function login(page, destination = '/pay') {
  await page.goto(`/login?redirect=${encodeURIComponent(destination)}`);
  await page.locator('input[autocomplete="username"]').fill('pay-entry-owner@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form button[type="submit"]').click();
  await expect.poll(() => currentURL(page)).toBe(destination);
  await expect(page.locator('#main').getByRole('heading', { level: 1 })).toBeVisible();
}
async function ownerProof(page, owner = ownerA) {
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(owner, { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
}
async function box(locator) {
  return locator.evaluate((node) => {
    const r = node.getBoundingClientRect(),
      nav = document.querySelector('.mobile-doors'),
      n = nav?.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      width: r.width,
      height: r.height,
      edge: nav && getComputedStyle(nav).display !== 'none' && n.height > 0 ? n.top : innerHeight,
      viewport: innerWidth,
    };
  });
}

async function entrySnapshot(page, state, name) {
  await page.evaluate(() => document.fonts.ready);
  const observed = await page.evaluate(
    (targets) => ({
      href: location.pathname + location.search + location.hash,
      timeOrigin: performance.timeOrigin,
      width: innerWidth,
      height: innerHeight,
      heading: document.querySelector('#main h1')?.textContent,
      mainText: document.querySelector('#main')?.textContent,
      mainVisibleText: document.querySelector('#main')?.innerText,
      targets: targets.map((href) => ({
        href,
        matches: Array.from(document.querySelectorAll('#main a'))
          .filter((a) => a.getAttribute('href') === href)
          .map((a) => {
            const r = a.getBoundingClientRect();
            return {
              text: a.textContent,
              box: { top: r.top, bottom: r.bottom, width: r.width, height: r.height },
              details: Array.from(a.querySelectorAll('small,p')).map((d) => ({
                text: d.textContent,
                display: getComputedStyle(d).display,
                visible: d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().height > 0,
              })),
            };
          }),
      })),
    }),
    hrefs,
  );
  state.observations.push(observed);
  await page.screenshot({ path: `${evidence}/${name}-viewport.png` });
  await page.screenshot({ path: `${evidence}/${name}-whole.png`, fullPage: true });
  return observed;
}

async function installClipboard(page, mode = 'success') {
  await page.evaluate((initial) => {
    window.__receiveClipboard = { mode: initial, calls: [], held: [] };
    const provider = {
      writeText(value) {
        const port = window.__receiveClipboard;
        port.calls.push(value);
        if (port.mode === 'sync') throw new DOMException('Isolated synchronous clipboard refusal', 'NotAllowedError');
        if (port.mode === 'denied') return Promise.reject(new DOMException('Isolated denied clipboard', 'NotAllowedError'));
        if (port.mode === 'held') return new Promise((resolve, reject) => port.held.push({ resolve, reject }));
        return Promise.resolve();
      },
    };
    window.__receiveClipboardProvider = provider;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: initial === 'undefined' ? undefined : provider });
  }, mode);
}
const clipboardCalls = (page) => page.evaluate(() => window.__receiveClipboard.calls);
async function storage(page) {
  return page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
    history: history.state,
  }));
}
async function viewLocale(page, locale) {
  await page.locator('.person-trigger').click();
  await page.getByRole('dialog').locator('a[href="/view"]').click();
  const language = page.locator('select').filter({ has: page.locator('option[value="ar"]') });
  await language.selectOption(locale);
  await expect(language).toHaveValue(locale);
  await page.locator('a[href="/pay"]:visible').first().click();
  await expect.poll(() => currentURL(page)).toBe('/pay');
  await expect(page.locator('html')).toHaveAttribute('lang', locale === 'ar' ? 'en' : locale);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
}
async function visibleAboveFooter(locator, minimum = 0) {
  await expect(locator).toBeVisible();
  await expect
    .poll(async () => {
      const geometry = await box(locator);
      return {
        left: geometry.left >= -0.5,
        right: geometry.right <= geometry.viewport + 0.5,
        top: geometry.top >= 0,
        bottom: geometry.bottom <= geometry.edge + 0.5,
        height: geometry.height >= minimum,
      };
    })
    .toEqual({ left: true, right: true, top: true, bottom: true, height: true });
  const geometry = await box(locator);
  expect(geometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 0.5);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.edge + 0.5);
  expect(geometry.height).toBeGreaterThanOrEqual(minimum);
}

const paused = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const offerId = '55555555-5555-4555-8555-555555555555';
function publishedOffer() {
  return {
    id: offerId,
    makerId: ownerB,
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'USD',
    priceType: 'fixed',
    price: '1.25',
    minAmount: '10',
    maxAmount: '2500',
    remainingAmount: '1250.5',
    methods: ['bank-transfer'],
    terms: 'Original published fixture terms — no financial action is authorized by entry.',
    status: 'active',
    createdAt: '2026-10-10T12:00:00.000Z',
  };
}
async function returnPay(page) {
  await page.locator('a[href="/pay"]:visible').first().click();
  await expect.poll(() => currentURL(page)).toBe('/pay');
  await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible();
}
async function followTask(page, href) {
  await task(page, href).click();
  await expect.poll(() => currentURL(page)).toBe(href);
}
async function submitCurrentLogin(page, destination) {
  await page.locator('input[autocomplete="username"]').fill('current-pay-entry-owner@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form button[type="submit"]').click();
  await expect.poll(() => currentURL(page)).toBe(destination);
}
const landingText = {
  en: {
    unavailable: 'Unavailable',
    request: 'Payment requests aren’t connected. You can share your account ID from Receive.',
    bills: 'Billers and payment rails aren’t connected.',
    global: 'International corridors and exchange quotes aren’t connected.',
  },
  es: {
    unavailable: /No disponible/,
    request: /solicitud|solicitudes/i,
    bills: /factur|canal/i,
    global: /corredor|internacional|cotizaci/i,
  },
  fr: { unavailable: /Indisponible/, request: /demande/i, bills: /factur|canal/i, global: /corridor|international|devis/i },
};
// The unavailable article’s direct body paragraph is its reason; its header paragraph is availability.
const taskContext = (page, href) => task(page, href).locator('xpath=ancestor-or-self::*[self::article][1]');
const taskDescription = (page, href) => {
  const link = task(page, href);
  if (href === '/p2p') return link.locator('xpath=ancestor::section[1]').locator('p').first();
  return ['/pay/request', '/pay/bills', '/pay/global'].includes(href)
    ? taskContext(page, href).locator(':scope > p')
    : link.locator('p,small').first();
};

test('Pay landing keeps six tasks readable before entry across four widths, locales, natural keyboard and guest', async ({ browser }) => {
  for (const [width, requested] of [
    [320, 'en'],
    [390, 'fr'],
    [768, 'es'],
    [1440, 'ar'],
  ])
    await scenario(
      browser,
      `landing-${width}-${requested}`,
      async ({ page, state }) => {
        await login(page);
        await ownerProof(page);
        if (requested !== 'en') await viewLocale(page, requested);
        const locale = requested === 'ar' ? 'en' : requested,
          before = await storage(page);
        await entrySnapshot(page, state, `landing-${width}-${requested}-arrival`);
        for (const href of hrefs) {
          await expect(task(page, href)).toHaveCount(1);
          await expect(taskDescription(page, href)).toBeVisible();
          expect((await taskDescription(page, href).innerText()).trim().length).toBeGreaterThan(15);
        }
        for (const [href, reason] of [
          ['/pay/request', 'request'],
          ['/pay/bills', 'bills'],
          ['/pay/global', 'global'],
        ]) {
          await expect(taskContext(page, href)).toContainText(landingText[locale].unavailable);
          await expect(taskDescription(page, href)).toContainText(landingText[locale][reason]);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await visibleAboveFooter(task(page, '/pay/send'), 44);
        await visibleAboveFooter(task(page, '/pay/receive'), 44);
        const keyboardHrefs = [...hrefs, '/uc/order'];
        await expect(task(page, '/uc/order')).toHaveCount(1);
        const seen = new Set();
        await main(page).focus();
        for (let turn = 0; turn < 24 && seen.size < keyboardHrefs.length; turn++) {
          await page.keyboard.press('Tab');
          const href = await page.evaluate(() => document.activeElement?.getAttribute('href'));
          if (keyboardHrefs.includes(href)) {
            seen.add(href);
            await visibleAboveFooter(task(page, href), 44);
            if (hrefs.includes(href)) await expect(taskDescription(page, href)).toBeVisible();
          }
        }
        expect([...seen].sort()).toEqual([...keyboardHrefs].sort());
        expect(await storage(page)).toEqual(before);
        expect(state.documents).toHaveLength(1);
        for (const href of ['/pay/request', '/pay/bills', '/pay/global']) {
          await followTask(page, href);
          await expect(main(page).locator('.pay-notice')).toBeVisible();
          await expect(main(page).locator('form')).toHaveCount(0);
          await returnPay(page);
        }
        state.observations.push({ requested, rendered: locale, seen: [...seen] });
      },
      width,
      width <= 390 ? 844 : 1000,
    );
  await scenario(
    browser,
    'guest-pay-entry',
    async ({ page, state }) => {
      await page.goto('/pay');
      await expect(main(page).getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
      for (const href of hrefs) await expect(task(page, href)).toHaveCount(0);
      await expect(main(page).getByText(ownerA, { exact: true })).toHaveCount(0);
      expect(state.reads).toEqual([]);
      await page.screenshot({ path: `${evidence}/guest-pay-before-login-viewport.png` });
      const signIn = main(page).getByRole('link', { name: 'Sign in', exact: true });
      await expect(signIn).toHaveAttribute('href', '/login?redirect=%2Fpay');
      const origin = await page.evaluate(() => performance.timeOrigin);
      await signIn.click();
      await submitCurrentLogin(page, '/pay');
      await ownerProof(page);
      await expect(task(page, '/pay/send')).toHaveCount(1);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
      expect(state.documents).toHaveLength(1);
    },
    320,
    844,
  );
});

test('ordinary Pay Send and Receive entry preserves exact review, current copy and unknown original without dispatch', async ({
  browser,
}) => {
  await scenario(
    browser,
    'supported-entry-and-original',
    async ({ page, state }) => {
      await login(page);
      await ownerProof(page);
      const origin = await page.evaluate(() => performance.timeOrigin),
        before = await storage(page);
      await followTask(page, '/pay/send');
      await expect(page.getByLabel('Source account', { exact: true })).toBeVisible();
      await page.getByLabel('Source account', { exact: true }).selectOption(primaryId);
      await page.getByLabel('Recipient account ID', { exact: true }).fill(ownerB);
      await page.getByLabel('Amount · USDT', { exact: true }).fill('1.234567890123456789');
      await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
      const review = page.getByRole('dialog', { name: 'Review transfer', exact: true });
      await expect(review).toContainText(ownerB);
      await expect(review).toContainText('Current primary USDT');
      await expect(review).toContainText('1.234567890123456789');
      await expect(review.getByRole('button', { name: 'Confirm transfer', exact: true })).toBeEnabled();
      expect(state.unexpectedWrites).toEqual([]);
      await review.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await returnPay(page);
      expect(await storage(page)).toEqual(before);
      await followTask(page, '/pay/receive');
      await expect(page.locator('.pay-account-id')).toHaveText(ownerA);
      await installClipboard(page);
      const copyButton = page.getByRole('button', { name: 'Copy account ID', exact: true });
      await copyButton.click();
      await expect(page.locator('.pay-receive-copy-status')).toHaveText('Account ID copied');
      expect(await clipboardCalls(page)).toEqual([ownerA]);
      await returnPay(page);
      await expect(page.locator('.pay-account-id')).toHaveCount(0);
      await followTask(page, '/pay/receive');
      await expect(page.locator('.pay-account-id')).toHaveText(ownerA);
      await expect(page.locator('.pay-receive-copy-status')).toHaveCount(0);
      await copyButton.click();
      await expect(page.locator('.pay-receive-copy-status')).toHaveText('Account ID copied');
      expect(await clipboardCalls(page)).toEqual([ownerA, ownerA]);
      await expect(main(page)).toContainText('Only primary spaces returned in this response are shown. Up to 200 spaces per response.');
      await returnPay(page);
      const key = `pay.unresolved:${ownerA}:send`,
        original = '  {"status":"uncertain","reference":"pay-entry-original-send-0001"}  ';
      await page.evaluate(({ key, original }) => localStorage.setItem(key, original), { key, original });
      await followTask(page, '/pay/send');
      await expect(page.getByRole('heading', { name: 'Original transfer is unresolved', exact: true })).toBeVisible();
      await expect(page.getByText('pay-entry-original-send-0001', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Review transfer', exact: true })).toBeDisabled();
      expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original);
      await returnPay(page);
      await followTask(page, '/pay/receive');
      await expect(page.locator('.pay-account-id')).toHaveText(ownerA);
      expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
      expect(state.documents).toHaveLength(1);
    },
    320,
    844,
  );
  for (const [query, target, valid] of [
    ['asset=USDT', '/pay/send?asset=USDT', true],
    ['asset=USDT&asset=BTC', '/pay/send?asset=USDT&asset=BTC', false],
    ['asset=ASSET123456789012', '/pay/send?asset=ASSET123456789012', false],
    ['asset=USDT?ignored=1&asset=BTC', '/pay/send?asset=USDT%3Fignored%3D1&asset=BTC', false],
  ])
    await scenario(
      browser,
      `send-query-${valid ? 'valid' : query.includes('?') ? 'nested-duplicate' : query.includes('&') ? 'duplicate' : 'oversized'}`,
      async ({ page, state }) => {
        state.answer = async () => ({ status: 200, data: [space(ownerA)] });
        await login(page, `/pay?${query}`);
        await ownerProof(page);
        const origin = await page.evaluate(() => performance.timeOrigin);
        const nested = query.includes('?');
        const queryOriginalKey = `pay.unresolved:${ownerA}:send`;
        const queryOriginal = '  {"status":"uncertain","reference":"pay-entry-nested-query-original-0001"}  ';
        if (nested) {
          await page.evaluate(({ key, original }) => localStorage.setItem(key, original), {
            key: queryOriginalKey,
            original: queryOriginal,
          });
          const actualSend = main(page)
            .locator('a')
            .filter({ has: page.getByRole('heading', { level: 2, name: 'Send money', exact: true }) });
          await expect(actualSend).toHaveCount(1);
          const observedHome = await page.evaluate(() => ({
            href: location.href,
            assets: new URL(location.href).searchParams.getAll('asset'),
            text: document.querySelector('#main')?.innerText,
          }));
          const actualHref = await actualSend.getAttribute('href');
          state.observations.push({ phase: 'nested-query-home-before-assertion', expected: target, actualHref, ...observedHome });
          await page.screenshot({ path: `${evidence}/nested-query-home-before-assertion-viewport.png` });
          await page.screenshot({ path: `${evidence}/nested-query-home-before-assertion-whole.png`, fullPage: true });
          await actualSend.click();
          await expect.poll(() => currentURL(page)).toBe(actualHref);
          const observedSend = await page.evaluate(
            (key) => ({ href: location.href, text: document.querySelector('#main')?.innerText, original: localStorage.getItem(key) }),
            queryOriginalKey,
          );
          state.observations.push({ phase: 'nested-query-send-before-assertion', expected: target, actualHref, ...observedSend });
          await page.screenshot({ path: `${evidence}/nested-query-send-before-assertion-viewport.png` });
          await page.screenshot({ path: `${evidence}/nested-query-send-before-assertion-whole.png`, fullPage: true });
          expect(state.unexpectedWrites).toEqual([]);
          expect(state.errors).toEqual([]);
          expect(observedHome.assets).toEqual(['USDT?ignored=1', 'BTC']);
          expect(observedSend.original).toBe(queryOriginal);
          expect(actualHref).toBe(target);
        } else {
          await expect(task(page, target)).toHaveCount(1);
          await task(page, target).click();
        }
        await expect.poll(() => currentURL(page)).toBe(target);
        if (valid) {
          await expect(page.getByLabel('Source account', { exact: true })).toHaveValue(primaryId);
          await expect(page.getByLabel('Amount · USDT', { exact: true })).toBeVisible();
          await expect(page.getByLabel('Recipient account ID', { exact: true })).toHaveValue('');
          await expect(page.getByLabel('Amount · USDT', { exact: true })).toHaveValue('');
          await expect(main(page).getByRole('dialog')).toHaveCount(0);
        } else {
          await expect(
            main(page).getByRole('heading', {
              name: 'The holding asset could not be identified. Choose it again from Money.',
              exact: true,
            }),
          ).toBeVisible();
          await expect(page.getByLabel('Source account', { exact: true })).toHaveCount(0);
          await expect(page.getByRole('button', { name: 'Review transfer', exact: true })).toHaveCount(0);
          await expect(main(page).getByRole('link', { name: 'Return to holdings', exact: true })).toHaveAttribute('href', '/portfolio');
        }
        if (nested) {
          await expect(page.getByText('pay-entry-nested-query-original-0001', { exact: true })).toBeVisible();
          expect(await page.evaluate((key) => localStorage.getItem(key), queryOriginalKey)).toBe(queryOriginal);
        }
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
        expect(state.documents).toHaveLength(1);
      },
      390,
      844,
    );
});

test('Personal P2P entry reads actual offer shape with loading, empty, scoped failure, current retry and 401 Login return', async ({
  browser,
}) => {
  for (const kind of ['published', 'empty', 'forbidden', 'unreachable', 'unauthorized'])
    await scenario(browser, `p2p-${kind}`, async ({ page, state }) => {
      const held = kind === 'published' ? paused() : null;
      if (held) state.pending.push(held);
      state.offerAnswer = async () => {
        if (held) await held.promise;
        return kind === 'empty'
          ? { status: 200, data: [] }
          : kind === 'forbidden'
            ? { status: 403, code: 'scope.denied' }
            : kind === 'unreachable'
              ? { status: 503 }
              : kind === 'unauthorized'
                ? { status: 401, code: 'auth.required' }
                : { status: 200, data: [publishedOffer()] };
      };
      await login(page);
      await ownerProof(page);
      const origin = await page.evaluate(() => performance.timeOrigin);
      await followTask(page, '/p2p');
      if (kind === 'unauthorized') {
        await expect(main(page).getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
        await expect(main(page).getByRole('region', { name: 'P2P offers', exact: true })).toHaveCount(0);
        const signIn = main(page).getByRole('link', { name: 'Sign in', exact: true });
        await expect(signIn).toHaveAttribute('href', '/login?redirect=%2Fp2p');
        await page.screenshot({ path: `${evidence}/p2p-unauthorized-before-login.png` });
        state.offerAnswer = async () => ({ status: 200, data: [publishedOffer()] });
        await signIn.click();
        await submitCurrentLogin(page, '/p2p');
        await ownerProof(page);
      } else if (kind === 'published') {
        await expect(main(page).getByRole('heading', { level: 2, name: 'Offer board', exact: true })).toBeVisible();
        await expect(main(page).locator('.loading')).toBeVisible();
        await page.screenshot({ path: `${evidence}/p2p-loading.png` });
        held.release();
      } else if (kind === 'empty') {
        await expect(main(page).getByRole('heading', { name: 'No offers returned for these filters', exact: true })).toBeVisible();
        await expect(main(page).getByRole('region', { name: 'P2P offers', exact: true })).toHaveCount(0);
      } else {
        await expect(main(page).locator('.failure')).toBeVisible();
        await expect(main(page).getByRole('region', { name: 'P2P offers', exact: true })).toHaveCount(0);
        await page.screenshot({ path: `${evidence}/p2p-${kind}-before-retry.png` });
        state.offerAnswer = async () => ({ status: 200, data: [publishedOffer()] });
        await main(page).getByRole('button', { name: 'Try again', exact: true }).click();
      }
      await expect(page.getByRole('button', { name: 'Select account', exact: true })).toContainText('Personal');
      if (kind !== 'empty') {
        const offers = main(page).getByRole('region', { name: 'P2P offers', exact: true });
        await expect(offers).toBeVisible();
        await expect(offers.getByText(ownerB, { exact: true })).toBeVisible();
        await expect(offers).toContainText('1.25 USD');
        await expect(offers).toContainText('USDT');
        await expect(offers).toContainText('1,250.5');
        await expect(main(page)).toContainText('1 records returned · window of 50');
      }
      await expect(main(page).locator('a[href="/uc/order"]')).toBeVisible();
      const reads = state.reads.filter((read) => read.path === '/api/p2p/trpc/offers.list');
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) {
        expect(read.input).toEqual({ limit: 50 });
        expect(read.authorization).toMatch(/^Bearer isolated-pay-entry-token-/);
      }
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
      expect(state.documents).toHaveLength(1);
    });
});
