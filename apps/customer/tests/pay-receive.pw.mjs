import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const baseURL = process.env.PAY_RECEIVE_BASE_URL;
const evidence = process.env.PAY_RECEIVE_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Use the explicit verified candidate/evidence environment from the Receive config.');
mkdirSync(evidence, { recursive: true });
const fixed = 'fb8d1b8eac0f0a9b3b8b5388e4203076d7d84aed';
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '44444444-4444-4444-8444-444444444444';
const primaryId = '22222222-2222-4222-8222-222222222222';
const namedId = '33333333-3333-4333-8333-333333333333';
const longAsset = 'ASSET12345678901';
const oversizedAsset = longAsset + '2';
const longName = 'Private receiving space / espace de réception / espacio receptor / 原始值 — ' + 'abcdefghij'.repeat(10);
const copy = {
  en: {
    title: 'Receive money',
    account: 'Your account ID',
    button: 'Copy account ID',
    assets: 'Receiving spaces',
    copied: 'Account ID copied',
    unavailable: 'Copy isn’t available here',
    keep: 'Keep in asset',
  },
  es: {
    title: 'Recibir dinero',
    account: 'Tu ID de cuenta',
    button: 'Copiar ID de cuenta',
    assets: 'Espacios para recibir',
    copied: 'ID de cuenta copiado',
    unavailable: 'La copia no está disponible aquí',
    keep: 'Conservar en el activo',
  },
  fr: {
    title: 'Recevoir de l’argent',
    account: 'Votre ID de compte',
    button: 'Copier l’ID du compte',
    assets: 'Espaces de réception',
    copied: 'ID du compte copié',
    unavailable: 'La copie est indisponible ici',
    keep: 'Conserver dans l’actif',
  },
};
const currentURL = (page) => page.evaluate(() => location.pathname + location.search + location.hash);
const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const account = (page) => page.locator('.pay-account-id');
const copyButton = (page, locale = 'en') => page.getByRole('button', { name: copy[locale].button, exact: true });
const accountSection = (page, locale = 'en') =>
  page.locator('.pay-section').filter({ has: page.getByRole('heading', { level: 2, name: copy[locale].account, exact: true }) });
const assetSection = (page, locale = 'en') =>
  page.locator('.pay-section').filter({ has: page.getByRole('heading', { level: 2, name: copy[locale].assets, exact: true }) });
const readRefresh = (page) => assetSection(page).getByRole('button', { name: 'Refresh receiving spaces', exact: true });
const paused = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
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
      const token = `isolated-receive-token-${state.logins.length + 1}`;
      state.logins.push({ owner: state.owner, token, input: request.postDataJSON() });
      return rpc({ userId: state.owner, accessToken: token, refreshToken: 'isolated-receive-refresh', expiresAt: '2027-10-10T08:00:00Z' });
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
    state.reads.push({ path: url.pathname, input, authorization: request.headers().authorization ?? null });
    let answer = procedure === 'spaces.list' && url.pathname.startsWith('/api/bank/') ? await state.answer() : { status: 503 };
    try {
      await route.fulfill({
        status: answer.status,
        json:
          answer.status === 200
            ? { result: { data: answer.data } }
            : {
                error: {
                  message: 'Isolated current receiving source unavailable',
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
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.input).toEqual({ limit: 200 });
      expect(read.authorization).toMatch(/^Bearer isolated-receive-token-/);
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
            'Ordinary compiled App/Login/current owner chrome; isolated mounted-shaped reads and browser-RAM clipboard ports. No live JWT/SQL/Edge, OS clipboard, financial dispatch or producer authority proof.',
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
  await page.locator('input[autocomplete="username"]').fill('receive-owner@example.invalid');
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
async function receive(page, locale = 'en') {
  const link = page.locator('#main a[href="/pay/receive"]');
  await expect(link).toHaveCount(1);
  await link.click();
  await expect.poll(() => currentURL(page)).toBe('/pay/receive');
  await expect(page.getByRole('heading', { level: 1, name: copy[locale].title, exact: true })).toBeVisible();
  await expect(account(page)).toHaveText(ownerA);
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
async function clipboardMode(page, mode) {
  await page.evaluate((next) => {
    window.__receiveClipboard.mode = next;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: next === 'undefined' ? undefined : window.__receiveClipboardProvider,
    });
  }, mode);
}
const clipboardCalls = (page) => page.evaluate(() => window.__receiveClipboard.calls);
async function releaseClipboard(page, outcome = 'resolve') {
  await page.evaluate((answer) => {
    const held = window.__receiveClipboard.held.splice(0);
    held.forEach((promise) =>
      answer === 'resolve' ? promise.resolve() : promise.reject(new DOMException('Isolated retired clipboard refusal', 'NotAllowedError')),
    );
  }, outcome);
  await frames(page);
}
async function retainedCopy(page) {
  await copyButton(page).evaluate((node) => {
    const props = Object.keys(node).find((key) => key.startsWith('__reactProps$'));
    const click = props && node[props].onClick;
    if (typeof click !== 'function') throw new Error('Actual current Copy callback unavailable');
    window.__retainedReceiveCopy = () => click({ target: node, currentTarget: node, preventDefault() {} });
  });
}
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
async function visibleAboveFooter(locator, minimum = 0) {
  await expect(locator).toBeVisible();
  const geometry = await box(locator);
  expect(geometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 0.5);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.edge + 0.5);
  expect(geometry.height).toBeGreaterThanOrEqual(minimum);
}

test('clipboard ports refuse unavailable, synchronous and denied writes; deliberate current retry copies exact ID once', async ({
  browser,
}) => {
  for (const mode of ['undefined', 'sync', 'denied', 'success'])
    await scenario(
      browser,
      `clipboard-${mode}`,
      async ({ page, state }) => {
        await login(page);
        await ownerProof(page);
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);
        await receive(page);
        await expect(assetSection(page).getByText('Current primary USDT', { exact: true })).toBeVisible();
        await installClipboard(page, mode);
        const before = await storage(page);
        await copyButton(page).click();
        if (mode !== 'success') {
          await expect(accountSection(page).getByRole('status')).toContainText(copy.en.unavailable);
          await expect(accountSection(page).getByRole('status')).toContainText(
            'Select the full ID above and copy it yourself. You can try Copy again.',
          );
          expect(state.errors).toEqual([]);
          expect(await clipboardCalls(page)).toEqual(mode === 'undefined' ? [] : [ownerA]);
          await page.evaluate(() => document.fonts.ready);
          state.observations.push({
            phase: 'copy-unavailable-before-retry',
            mode,
            account: await box(account(page)),
            action: await box(copyButton(page)),
            status: await box(accountSection(page).getByRole('status')),
            statusText: await accountSection(page).getByRole('status').textContent(),
          });
          await page.screenshot({ path: `${evidence}/clipboard-${mode}-unavailable-viewport.png` });
          if (mode === 'undefined') {
            await visibleAboveFooter(account(page));
            await visibleAboveFooter(copyButton(page), 44);
            await visibleAboveFooter(accountSection(page).getByRole('status'));
          }
          await page.screenshot({ path: `${evidence}/clipboard-${mode}-unavailable-whole.png`, fullPage: true });
          if (mode === 'undefined') {
            await copyButton(page).focus();
            await page.keyboard.press('Shift+Tab');
            await expect(account(page)).toBeFocused();
            await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(ownerA);
            const selected = await account(page).evaluate((node) => {
              const selection = window.getSelection();
              if (!selection || selection.rangeCount !== 1) return { exact: false, collapsed: true };
              const range = selection.getRangeAt(0);
              return { exact: node.contains(range.startContainer) && node.contains(range.endContainer), collapsed: range.collapsed };
            });
            expect(selected).toEqual({ exact: true, collapsed: false });
            expect(await clipboardCalls(page)).toEqual([]);
          }
          await clipboardMode(page, 'success');
          await copyButton(page).click();
        }
        await expect(accountSection(page).getByRole('status')).toHaveText(copy.en.copied);
        expect(await clipboardCalls(page)).toEqual(mode === 'success' || mode === 'undefined' ? [ownerA] : [ownerA, ownerA]);
        expect(await storage(page)).toEqual(before);
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
        expect(state.documents).toHaveLength(1);
      },
      mode === 'undefined' ? 320 : 1440,
      mode === 'undefined' ? 844 : 1000,
    );
});

test('primary states show named-only meaning, bounded returned assets, zero, empty and fail-closed current reads', async ({ browser }) => {
  expect(longAsset).toHaveLength(16);
  expect(oversizedAsset).toHaveLength(17);
  for (const kind of ['named', 'empty', 'zero', 'populated', 'failed', 'malformed', 'oversized', 'foreign', 'forbidden', 'unauthorized'])
    await scenario(browser, `spaces-${kind}`, async ({ page, state }) => {
      const named = space(ownerA, 'named', 'Only named reserve — never a receiving primary');
      const primary = space(ownerA, 'primary', longName, longAsset, kind === 'zero' ? '0' : '7500');
      state.answer = async () =>
        kind === 'failed'
          ? { status: 503 }
          : kind === 'forbidden'
            ? { status: 403, code: 'scope.denied' }
            : kind === 'unauthorized'
              ? { status: 401, code: 'auth.required' }
              : {
                  status: 200,
                  data:
                    kind === 'named'
                      ? [named]
                      : kind === 'empty'
                        ? []
                        : kind === 'malformed'
                          ? [{ ...primary, balance: 7500 }]
                          : kind === 'oversized'
                            ? [
                                {
                                  ...primary,
                                  assetId: oversizedAsset,
                                  ledgerAccount: { ...primary.ledgerAccount, assetId: oversizedAsset },
                                },
                              ]
                            : kind === 'foreign'
                              ? [{ ...primary, ledgerAccount: { ...primary.ledgerAccount, ownerId: ownerB } }]
                              : [primary, named],
                };
      const unauthorizedReply = kind === 'unauthorized' ? paused() : null;
      if (unauthorizedReply) {
        state.pending.push(unauthorizedReply);
        const answer = state.answer;
        state.answer = async () => {
          await unauthorizedReply.promise;
          return answer();
        };
      }
      await login(page);
      await receive(page);
      await installClipboard(page);
      if (kind === 'unauthorized') {
        await retainedCopy(page);
        unauthorizedReply.release();
        const guest = page.locator('#main');
        await expect(guest.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
        await expect(account(page)).toHaveCount(0);
        await expect(assetSection(page)).toHaveCount(0);
        await expect(guest.getByText(ownerA, { exact: true })).toHaveCount(0);
        await expect(guest.getByText(primary.name, { exact: true })).toHaveCount(0);
        await expect(copyButton(page)).toHaveCount(0);
        const readsBeforeRetired = state.reads.length;
        await page.evaluate(() => window.__retainedReceiveCopy());
        await frames(page);
        expect(await clipboardCalls(page)).toEqual([]);
        expect(state.reads).toHaveLength(readsBeforeRetired);
        expect(state.unexpectedWrites).toEqual([]);
        const signIn = guest.getByRole('link', { name: 'Sign in', exact: true });
        await expect(signIn).toHaveAttribute('href', '/login?redirect=%2Fpay%2Freceive');
        state.observations.push({
          phase: 'unauthorized-guest-before-sign-in',
          href: await currentURL(page),
          guest: await guest.innerText(),
          clipboardCalls: await clipboardCalls(page),
          reads: state.reads.length,
        });
        await page.screenshot({ path: `${evidence}/spaces-unauthorized-guest-viewport.png` });
        await page.screenshot({ path: `${evidence}/spaces-unauthorized-guest-whole.png`, fullPage: true });
        state.answer = async () => ({ status: 200, data: [primary] });
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);
        await signIn.click();
        await expect.poll(() => currentURL(page)).toBe('/login?redirect=%2Fpay%2Freceive');
        await page.locator('input[autocomplete="username"]').fill('current-receiving-owner@example.invalid');
        await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
        await page.locator('form button[type="submit"]').click();
        await expect.poll(() => currentURL(page)).toBe('/pay/receive');
        await expect(account(page)).toHaveText(ownerA);
        await expect(assetSection(page).getByText(primary.name, { exact: true })).toBeVisible();
        await ownerProof(page);
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
        expect(state.documents).toHaveLength(1);
      } else if (['named', 'empty'].includes(kind)) {
        await expect(assetSection(page).getByRole('heading', { level: 3 })).toContainText('No primary spaces in this response');
        await expect(assetSection(page)).toContainText(
          'Only primary spaces returned in this response are shown. Up to 200 spaces per response.',
        );
        await expect(assetSection(page).getByRole('link', { name: 'Inspect Bank spaces', exact: true })).toHaveAttribute('href', '/bank');
        const namedReason = 'Only named spaces were returned. They cannot receive transfers sent to this account ID.';
        if (kind === 'named') await expect(assetSection(page)).toContainText(namedReason);
        else await expect(assetSection(page).getByText(namedReason, { exact: true })).toHaveCount(0);
        await expect(assetSection(page).getByText(named.name, { exact: true })).toHaveCount(0);
        await expect(assetSection(page).getByText(copy.en.keep, { exact: true })).toHaveCount(0);
      } else if (['zero', 'populated'].includes(kind)) {
        await expect(assetSection(page).getByText(primary.name, { exact: true })).toBeVisible();
        await expect(assetSection(page)).toContainText(primary.assetId);
        await expect(assetSection(page)).toContainText(
          'Only primary spaces returned in this response are shown. Up to 200 spaces per response.',
        );
        await expect(assetSection(page).getByText(copy.en.keep, { exact: true })).toHaveCount(1);
        await expect(assetSection(page).getByText(named.name, { exact: true })).toHaveCount(0);
        await expect(
          assetSection(page).getByRole('heading', { level: 3, name: 'No primary spaces in this response', exact: true }),
        ).toHaveCount(0);
        if (kind === 'populated') {
          state.answer = async () => ({ status: 503 });
          await readRefresh(page).click();
          await expect(assetSection(page).locator('.failure')).toBeVisible();
          await expect(assetSection(page).getByText(primary.name, { exact: true })).toHaveCount(0);
          state.answer = async () => ({ status: 200, data: [primary] });
          await readRefresh(page).click();
          await expect(assetSection(page).getByText(primary.name, { exact: true })).toBeVisible();
        }
      } else {
        await expect(assetSection(page).locator('.failure')).toBeVisible();
        await expect(assetSection(page).getByText(primary.name, { exact: true })).toHaveCount(0);
        if (kind === 'failed') {
          state.observations.push({
            phase: 'service-failed-before-refresh',
            failure: await assetSection(page).locator('.failure').innerText(),
            account: await account(page).innerText(),
            action: await box(copyButton(page)),
          });
          await page.screenshot({ path: `${evidence}/spaces-failed-before-refresh-viewport.png` });
          await page.screenshot({ path: `${evidence}/spaces-failed-before-refresh-whole.png`, fullPage: true });
        }
        state.answer = async () => ({ status: 200, data: [primary] });
        await readRefresh(page).click();
        await expect(assetSection(page).getByText(primary.name, { exact: true })).toBeVisible();
      }
      await copyButton(page).click();
      await expect(accountSection(page).getByRole('status')).toHaveText(copy.en.copied);
      expect(await clipboardCalls(page)).toEqual([ownerA]);
    });
});

test('retired clipboard and held reads cannot replace the current room, URL epoch or signed-in owner', async ({ browser }) => {
  await scenario(browser, 'retired-copy-room-and-url', async ({ page, state }) => {
    await login(page);
    await receive(page);
    await installClipboard(page, 'held');
    await copyButton(page).click();
    await expect.poll(() => clipboardCalls(page)).toEqual([ownerA]);
    await page.locator('.pay-personal-nav a[href="/pay/send"]').click();
    await expect.poll(() => currentURL(page)).toBe('/pay/send');
    await receive(page);
    await clipboardMode(page, 'success');
    await copyButton(page).click();
    await expect(accountSection(page).getByRole('status')).toHaveText(copy.en.copied);
    await releaseClipboard(page, 'reject');
    await expect(accountSection(page).getByRole('status')).toHaveText(copy.en.copied);
    await retainedCopy(page);
    const calls = await clipboardCalls(page);
    await page.evaluate(() => {
      history.pushState(null, '', '/pay/receive?retired=1');
      dispatchEvent(new PopStateEvent('popstate'));
      history.pushState(null, '', '/pay/receive');
      dispatchEvent(new PopStateEvent('popstate'));
      location.hash = 'old-copy';
      location.hash = '';
    });
    await frames(page);
    await page.evaluate(() => window.__retainedReceiveCopy());
    await frames(page);
    expect(await clipboardCalls(page)).toEqual(calls);
    await copyButton(page).click();
    await expect.poll(() => clipboardCalls(page)).toEqual([...calls, ownerA]);
    await expect(accountSection(page).getByRole('status')).toHaveText(copy.en.copied);
    expect(state.documents).toHaveLength(1);
  });
  await scenario(browser, 'held-read-current-opposite', async ({ page, state }) => {
    const held = paused();
    state.pending.push(held);
    const oldName = 'Retired response must not appear';
    let calls = 0;
    state.answer = async () => {
      if (++calls === 1) {
        await held.promise;
        return { status: 200, data: [space(ownerA, 'primary', oldName)] };
      }
      return { status: 200, data: [space(ownerA, 'primary', 'Current opposite receiving asset')] };
    };
    await login(page);
    await receive(page);
    await expect.poll(() => calls).toBe(1);
    await page.locator('.pay-personal-nav a[href="/pay/send"]').click();
    await expect.poll(() => currentURL(page)).toBe('/pay/send');
    await receive(page);
    await expect(assetSection(page).getByText('Current opposite receiving asset', { exact: true })).toBeVisible();
    held.release();
    await frames(page);
    await expect(assetSection(page).getByText(oldName, { exact: true })).toHaveCount(0);
    expect(state.documents).toHaveLength(1);
  });
  await scenario(browser, 'held-copy-owner-change', async ({ page, state }) => {
    await login(page);
    await receive(page);
    await installClipboard(page, 'held');
    await copyButton(page).click();
    await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
    state.owner = ownerB;
    await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.locator('input[autocomplete="username"]').fill('next-owner@example.invalid');
    await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
    await page.locator('form button[type="submit"]').click();
    await expect.poll(() => currentURL(page)).toBe('/money');
    await page.locator('a[href="/pay"]:visible').first().click();
    const receiveLink = page.locator('#main a[href="/pay/receive"]');
    await expect(receiveLink).toHaveCount(1);
    await receiveLink.click();
    await expect(account(page)).toHaveText(ownerB);
    await ownerProof(page, ownerB);
    await clipboardMode(page, 'success');
    await copyButton(page).click();
    await expect(accountSection(page).getByRole('status')).toHaveText(copy.en.copied);
    await releaseClipboard(page, 'reject');
    await expect(accountSection(page).getByRole('status')).toHaveText(copy.en.copied);
    expect(await clipboardCalls(page)).toEqual([ownerA, ownerB]);
    expect(state.logins.map((row) => row.owner)).toEqual([ownerA, ownerB]);
    expect(state.documents).toHaveLength(1);
  });
});

test('four widths preserve full receiving context, natural keyboard copy, opaque values and authored fallback', async ({ browser }) => {
  expect(longAsset).toHaveLength(16);
  for (const [width, requested] of [
    [320, 'en'],
    [390, 'fr'],
    [768, 'es'],
    [1440, 'ar'],
  ])
    await scenario(
      browser,
      `fit-${width}-${requested}`,
      async ({ page, state }) => {
        state.answer = async () => ({
          status: 200,
          data: [space(ownerA, 'primary', longName, longAsset, '0'), space(ownerA, 'named', 'Unrelated named reserve')],
        });
        await login(page);
        await ownerProof(page);
        if (requested !== 'en') await viewLocale(page, requested);
        const locale = requested === 'ar' ? 'en' : requested;
        await receive(page, locale);
        await installClipboard(page);
        await expect(assetSection(page, locale).getByText(longName, { exact: true })).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(account(page)).toHaveAttribute('lang', 'zxx');
        await visibleAboveFooter(account(page));
        await visibleAboveFooter(copyButton(page, locale), 44);
        await page.locator('#main').focus();
        let reached = false;
        for (let turn = 0; turn < 10; turn++) {
          await page.keyboard.press('Tab');
          if (await copyButton(page, locale).evaluate((node) => node === document.activeElement)) {
            reached = true;
            break;
          }
        }
        expect(reached).toBe(true);
        await visibleAboveFooter(copyButton(page, locale), 44);
        await page.keyboard.press('Enter');
        await expect(accountSection(page, locale).getByRole('status')).toHaveText(copy[locale].copied);
        expect(await clipboardCalls(page)).toEqual([ownerA]);
        await expect(assetSection(page, locale).getByText(copy[locale].keep, { exact: true })).toHaveCount(1);
        await page.screenshot({ path: `${evidence}/fit-${width}-${requested}-arrival.png` });
        await assetSection(page, locale).getByText(longName, { exact: true }).scrollIntoViewIfNeeded();
        const name = assetSection(page, locale).getByText(longName, { exact: true });
        expect((await name.textContent()).trim()).toBe(longName);
        const geometry = await box(name);
        expect(geometry.left).toBeGreaterThanOrEqual(-0.5);
        expect(geometry.right).toBeLessThanOrEqual(width + 0.5);
        if (requested === 'ar')
          expect(
            await accountSection(page)
              .getByRole('heading', { level: 2 })
              .evaluate((node) => node.closest('[lang]')?.getAttribute('lang')),
          ).toBe('en');
        state.observations.push({ width, requestedLocale: requested, renderedLocale: locale, opaqueName: longName, asset: longAsset });
      },
      width,
      width <= 390 ? 844 : 1000,
    );
});

test('receiving reads and copy preserve an exact unknown Send original and keep Review blocked without dispatch', async ({ browser }) => {
  await scenario(
    browser,
    'unknown-send-preserved',
    async ({ page }) => {
      await login(page);
      const original = '  {"status":"uncertain","reference":"receive-smoke-original-001"}  ',
        key = `pay.unresolved:${ownerA}:send`;
      await page.evaluate(({ key, original }) => localStorage.setItem(key, original), { key, original });
      await receive(page);
      await installClipboard(page);
      await copyButton(page).click();
      await expect(accountSection(page).getByRole('status')).toHaveText(copy.en.copied);
      await page.locator('.pay-personal-nav a[href="/pay/send"]').click();
      await expect.poll(() => currentURL(page)).toBe('/pay/send');
      await expect(page.getByRole('heading', { name: 'Original transfer is unresolved', exact: true })).toBeVisible();
      await expect(page.getByText('receive-smoke-original-001', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Review transfer', exact: true })).toBeDisabled();
      expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original);
      await receive(page);
      await expect(assetSection(page).getByText('Current primary USDT', { exact: true })).toBeVisible();
      expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original);
      expect(await clipboardCalls(page)).toEqual([ownerA]);
    },
    320,
    844,
  );
});
