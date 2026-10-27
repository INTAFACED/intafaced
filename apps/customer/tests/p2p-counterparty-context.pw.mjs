import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const evidence = process.env.P2P_COUNTERPARTY_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111',
  subject = '22222222-2222-4222-8222-222222222222',
  other = '33333333-3333-4333-8333-333333333333';
const offerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  orderId = '77777777-7777-4777-8777-777777777777';
const originalKey = `pay.unresolved:${owner}:offer:${offerId}`;
const offer = {
  id: offerId,
  makerId: subject,
  side: 'sell',
  asset: 'USDT',
  fiatCurrency: 'USD',
  priceType: 'fixed',
  price: '1.1',
  minAmount: '1',
  maxAmount: '50',
  remainingAmount: '12.345678901234567801',
  methods: ['bank-transfer'],
  terms: 'Current private offer terms',
  status: 'active',
  createdAt: '2026-10-10T12:00:00Z',
};
const order = {
  id: orderId,
  offerId,
  sellerId: owner,
  buyerId: subject,
  asset: 'USDT',
  amount: '12.345678901234567801',
  fiatCurrency: 'USD',
  fiatAmount: '13.580246791358024581',
  price: '1.1',
  method: 'bank-transfer',
  status: 'fiat_sent',
  resolution: null,
  deadlineAt: '2026-10-11T06:00:00Z',
  createdAt: '2026-10-10T12:00:00Z',
  escrowedAt: '2026-10-10T12:00:05Z',
  resolvedAt: null,
  settledAt: null,
};
const established = {
  tradesTotal: 100,
  completed: 98,
  cancelled: 1,
  disputed: 1,
  disputesLost: 1,
  completionRate: 0.98,
  avgReleaseSecs: 245,
  badges: ['first-trade', 'reliable'],
  merchant: true,
};
const empty = {
  tradesTotal: 0,
  completed: 0,
  cancelled: 0,
  disputed: 0,
  disputesLost: 0,
  completionRate: 0,
  avgReleaseSecs: 0,
  badges: [],
  merchant: null,
};
const profile = (id = subject, returnTo = '/p2p') => '/checkuser?userId=' + id + '&returnTo=' + encodeURIComponent(returnTo);
async function fixture(context) {
  const state = {
    owner,
    offer: { ...offer },
    order: { ...order },
    record: { ...established },
    reads: [],
    writes: [],
    errors: [],
    fixtureErrors: [],
    pending: null,
    failed: false,
    delay: false,
  };
  context.on('page', (page) => page.on('pageerror', (e) => state.errors.push(e.message)));
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      procedure = decodeURIComponent(url.pathname.split('/').at(-1));
    const rpc = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    const fail = () =>
      route.fulfill({
        status: 503,
        json: {
          error: {
            message: 'Isolated counterparty service unavailable',
            data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503, cause: { code: 'p2p.isolated_unavailable' } },
          },
        },
      });
    if (procedure === 'auth.login')
      return rpc({
        userId: state.owner,
        accessToken: 'isolated-counterparty-' + state.owner,
        refreshToken: 'isolated-refresh',
        expiresAt: '2027-10-10T00:00:00Z',
      });
    if (procedure === 'auth.logout') return rpc({ ok: true });
    if (request.method() !== 'GET') {
      state.writes.push({ procedure, input: request.postData() });
      return fail();
    }
    const input = JSON.parse(url.searchParams.get('input') || 'null');
    state.reads.push({ procedure, input });
    if (procedure === 'offers.list') return rpc([state.offer]);
    if (procedure === 'offers.get') {
      if (input.offerId !== offerId) state.fixtureErrors.push({ procedure, input });
      return rpc(state.offer);
    }
    if (procedure === 'trades.get') {
      if (input.tradeId !== orderId) state.fixtureErrors.push({ procedure, input });
      return rpc(state.order);
    }
    if (procedure === 'fiat.list') return rpc([{ code: 'USD', name: 'US Dollar', symbol: '$', minorUnits: 2 }]);
    if (procedure === 'reputation.get') {
      if (![subject, other].includes(input.userId) || Object.keys(input).length !== 1) state.fixtureErrors.push({ procedure, input });
      const reply = { ...state.record };
      if (state.delay) {
        state.delay = false;
        await new Promise((resolve) => (state.pending = resolve));
      }
      return state.failed ? fail() : rpc(reply);
    }
    return fail();
  });
  return state;
}
async function login(page, path = '/p2p') {
  await page.goto('/login?redirect=' + encodeURIComponent(path));
  await page.locator('input[name="identifier"]').fill('counterparty@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
  await expect(page.getByTestId('pay-room-tabs')).toBeVisible();
}
const record = (page) => page.getByTestId('p2p-counterparty');
const metric = (page, key) => record(page).locator(`[data-counterparty-metric="${key}"]`);
const stable = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function scenario(browser, name, width, run) {
  const out = join(evidence, name);
  mkdirSync(out, { recursive: true });
  const context = await browser.newContext({
    baseURL: process.env.P2P_COUNTERPARTY_BASE_URL,
    viewport: { width, height: 844 },
    timezoneId: 'UTC',
  });
  const state = await fixture(context),
    page = await context.newPage();
  try {
    await run({ context, state, page, out });
    expect(state.writes).toEqual([]);
    expect(state.errors).toEqual([]);
    expect(state.fixtureErrors).toEqual([]);
  } finally {
    writeFileSync(
      join(out, 'OBSERVATION.json'),
      JSON.stringify(
        {
          ...state,
          pending: !!state.pending,
          qualification:
            'Actual compiled App/ordinary Login; isolated real-contract GETs. Reported history is not identity, Business, escrow, external-payment or live-authority proof.',
        },
        null,
        2,
      ) + '\n',
    );
    await context.close();
  }
}
async function save(page, locator, key) {
  await locator.evaluate((node, key) => {
    const props = Object.keys(node).find((k) => k.startsWith('__reactProps$'));
    if (!props || typeof node[props].onClick !== 'function') throw Error('Actual handler missing');
    window[key] = node[props].onClick;
  }, key);
}
test('offer inspection shows reported decision metrics and restores fresh selected context at four widths', async ({ browser }) => {
  for (const width of [320, 390, 768, 1440])
    await scenario(browser, 'offer-' + width, width, async ({ page, state, out }) => {
      const origin = '/p2p?asset=USDT&fiatCurrency=USD&side=sell&limit=200#selected-offer';
      await login(page, origin);
      await page.locator('[data-testid="p2p-offer-row"] button').first().click();
      await save(page, page.getByRole('link', { name: 'Review counterparty →', exact: true }), '__oldProfile');
      await page.getByRole('link', { name: 'Review counterparty →', exact: true }).click();
      await expect(metric(page, 'completion')).toHaveText('98%');
      await expect(metric(page, 'average')).toHaveText('245s');
      await expect(metric(page, 'lost')).toHaveText('1');
      await expect(record(page)).toContainText('98 of 100 escrowed trades completed');
      await expect(record(page)).toContainText('sample count is not returned');
      await expect(record(page)).toContainText('do not verify identity');
      await expect(record(page)).toContainText(subject);
      expect(state.reads.filter((r) => r.procedure === 'reputation.get').map((r) => r.input)).toEqual([{ userId: subject }]);
      const back = record(page).getByRole('link', { name: 'Back to this offer', exact: true }),
        href = await back.getAttribute('href');
      expect(href).toContain('offerId=' + offerId);
      expect(href).toContain('#selected-offer');
      expect(href).not.toContain(state.offer.terms);
      expect(href).not.toContain(state.offer.remainingAmount);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: join(out, 'counterparty.png') });
      const currentURL = page.url();
      await page.evaluate(() => window.__oldProfile({ button: 0, defaultPrevented: false, preventDefault() {} }));
      expect(page.url()).toBe(currentURL);
      await page.screenshot({ path: join(out, 'counterparty-full.png'), fullPage: true });
      const refresh = record(page).getByRole('button', { name: 'Refresh record', exact: true });
      await refresh.scrollIntoViewIfNeeded();
      const fits = await refresh.evaluate((node) => {
        const r = node.getBoundingClientRect(),
          footer = document.querySelector('[data-testid="mobile-doors"]');
        const bottom = footer?.getClientRects().length ? footer.getBoundingClientRect().top : innerHeight;
        return r.height >= 44 && r.top >= 0 && r.bottom <= bottom + 1;
      });
      expect(fits).toBe(true);
      await page.screenshot({ path: join(out, 'counterparty-actions.png') });
      state.offer.terms = 'Fresh terms after inspection';
      await page.goBack();
      await expect(page.getByTestId('p2p-offer-inspector')).toContainText('Fresh terms after inspection');
      expect(state.reads.filter((r) => r.procedure === 'offers.get').length).toBe(2);
      expect(new URL(page.url()).hash).toBe('#selected-offer');
      await page.getByTestId('p2p-offer-inspector').getByRole('button', { name: 'Back to offers', exact: true }).click();
      expect(new URL(page.url()).searchParams.has('offerId')).toBe(false);
      await expect(page.getByTestId('p2p-offer-market')).toBeFocused();
      await page.locator('[data-testid="p2p-offer-row"] button').first().click();
      await page.getByRole('link', { name: 'Review counterparty →', exact: true }).click();
      await record(page).getByRole('link', { name: 'Back to this offer', exact: true }).click();
      await expect(page.getByTestId('p2p-offer-inspector')).toContainText('Fresh terms after inspection');
      expect(new URL(page.url()).hash).toBe('#selected-offer');
    });
});
test('current order context returns with a fresh owner read and no revived private review', async ({ browser }) => {
  await scenario(browser, 'order-return', 390, async ({ page, state, out }) => {
    const origin = '/chat?tradeId=' + orderId + '#order-details';
    await login(page, origin);
    await expect(page.getByTestId('p2p-order')).toContainText(orderId);
    await page.locator('[data-testid="p2p-order-facts"] > summary').click();
    await page.locator('[data-testid="p2p-order-facts"] a').click();
    await expect(metric(page, 'completion')).toHaveText('98%');
    await expect(page.locator('[data-testid="pay-room-tabs"] a[aria-current="page"]')).toHaveText('Your orders');
    await expect(record(page).getByRole('link', { name: 'Back to this order', exact: true })).toHaveAttribute('href', origin);
    await page.screenshot({ path: join(out, 'counterparty.png') });
    state.order = { ...state.order, status: 'disputed' };
    await record(page).getByRole('link', { name: 'Back to this order', exact: true }).click();
    await expect(page.getByTestId('p2p-order')).toContainText('disputed');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(state.reads.filter((r) => r.procedure === 'trades.get').length).toBe(2);
    expect(page.url()).toContain('#order-details');
  });
});
test('empty history, zero timing and each programme state remain distinct', async ({ browser }) => {
  for (const [name, value, width, text] of [
    ['empty', empty, 1440, 'Programme unavailable'],
    ['zero', { ...established, avgReleaseSecs: 0, merchant: false }, 390, 'Not approved'],
    ['approved', established, 320, 'Approved'],
  ])
    await scenario(browser, name, width, async ({ page, state, out }) => {
      state.record = { ...value };
      await login(page, profile());
      await expect(metric(page, 'completion')).toBeVisible();
      await expect(record(page).getByText(text, { exact: true })).toBeVisible();
      if (!value.tradesTotal) {
        await expect(record(page)).toContainText('No escrowed trade history to assess');
        await expect(record(page)).toContainText('No badges returned');
      }
      if (!value.avgReleaseSecs) {
        await expect(metric(page, 'average')).toHaveText('0s');
        await expect(record(page)).toContainText('no release samples or a rounded zero');
      }
      await page.screenshot({ path: join(out, 'counterparty.png') });
    });
});
test('refresh failures and invalid contract counters remove old facts and recover through the current read', async ({ browser }) => {
  await scenario(browser, 'failure-recovery', 320, async ({ page, state, out }) => {
    await login(page, profile(subject, '/chat?tradeId=' + orderId));
    await expect(metric(page, 'completion')).toHaveText('98%');
    state.failed = true;
    await record(page).getByRole('button', { name: 'Refresh record', exact: true }).click();
    await expect(record(page).getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect(metric(page, 'completion')).toHaveCount(0);
    await expect(record(page)).not.toContainText('Approved');
    await expect(record(page).getByRole('link', { name: 'Back to this order', exact: true })).toBeVisible();
    await page.screenshot({ path: join(out, 'failed.png') });
    state.failed = false;
    for (const invalid of [
      { completionRate: 1.1 },
      { completed: -1 },
      { completed: 100, cancelled: 1 },
      { disputesLost: 2 },
      { avgReleaseSecs: '245' },
    ]) {
      state.record = { ...established, ...invalid };
      await record(page).getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(record(page).getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
      await expect(metric(page, 'average')).toHaveCount(0);
    }
    state.record = { ...established };
    await record(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(metric(page, 'completion')).toHaveText('98%');
  });
});
test('late responses and saved navigation handlers retire on batched subject departure and return', async ({ browser }) => {
  await scenario(browser, 'late-batched', 390, async ({ page, state }) => {
    await login(page, profile());
    await expect(metric(page, 'completion')).toHaveText('98%');
    await save(page, record(page).getByRole('link', { name: 'Back to offers', exact: true }), '__oldReturn');
    state.record = { ...established, avgReleaseSecs: 444 };
    state.delay = true;
    await record(page).getByRole('button', { name: 'Refresh record', exact: true }).click();
    await expect.poll(() => !!state.pending).toBe(true);
    state.record = { ...established, avgReleaseSecs: 777 };
    await page.evaluate(
      ({ subject, other }) => {
        const href = location.pathname + location.search;
        history.pushState(null, '', href.replace(subject, other));
        window.dispatchEvent(new PopStateEvent('popstate'));
        history.pushState(null, '', href);
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
      { subject, other },
    );
    await expect(metric(page, 'average')).toHaveText('777s');
    const current = page.url();
    await page.evaluate(() => window.__oldReturn({ button: 0, defaultPrevented: false, preventDefault() {} }));
    expect(page.url()).toBe(current);
    state.pending();
    await stable(page);
    await expect(metric(page, 'average')).toHaveText('777s');
    expect(state.reads.filter((r) => r.procedure === 'reputation.get').every((r) => [subject, other].includes(r.input.userId))).toBe(true);
  });
});
test('late prior-owner response remains retired after actual sign-out and another owner signs in', async ({ browser }) => {
  await scenario(browser, 'late-owner', 390, async ({ page, state }) => {
    await login(page, profile());
    await expect(metric(page, 'average')).toHaveText('245s');
    state.delay = true;
    state.record = { ...established, avgReleaseSecs: 444 };
    await record(page).getByRole('button', { name: 'Refresh record', exact: true }).click();
    await expect.poll(() => !!state.pending).toBe(true);
    await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(record(page)).toHaveCount(0);
    state.owner = other;
    state.record = { ...established, avgReleaseSecs: 777 };
    await page.locator('#main').getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.locator('input[name="identifier"]').fill('other-owner@example.invalid');
    await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
    await page.locator('form:has(input[name="identifier"]) button[type="submit"]').click();
    await expect(metric(page, 'average')).toHaveText('777s');
    state.pending();
    await stable(page);
    await expect(metric(page, 'average')).toHaveText('777s');
  });
});
test('original references survive counterparty navigation, tab closure and independent same-owner reads', async ({ browser }) => {
  await scenario(browser, 'original-preservation', 390, async ({ page, context, state }) => {
    await login(page);
    await page.evaluate(({ key }) => localStorage.setItem(key, 'opaque-original-must-survive'), { key: originalKey });
    await page.locator('[data-testid="p2p-offer-row"] button').first().click();
    await page.getByRole('link', { name: 'Review counterparty →', exact: true }).click();
    await expect(metric(page, 'completion')).toHaveText('98%');
    const selected = await record(page).getByRole('link', { name: 'Back to this offer', exact: true }).getAttribute('href');
    await page.close();
    const next = await context.newPage();
    await login(next, selected);
    await expect(next.getByTestId('p2p-offer-inspector')).toContainText(offerId);
    expect(await next.evaluate((key) => localStorage.getItem(key), originalKey)).toBe('opaque-original-must-survive');
    state.failed = true;
    await next.getByRole('link', { name: 'Review counterparty →', exact: true }).click();
    await expect(record(next).getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    expect(await next.evaluate((key) => localStorage.getItem(key), originalKey)).toBe('opaque-original-must-survive');
  });
});
test('long reported counts and badges fit; passive ES FR and fallback language keep focus and all five rooms reachable', async ({
  browser,
}) => {
  await scenario(browser, 'locale-long', 320, async ({ page, context, state, out }) => {
    state.record = {
      ...established,
      tradesTotal: 2147483647,
      completionRate: 0.9965,
      completed: 2140000000,
      cancelled: 0,
      disputed: 100,
      avgReleaseSecs: 2147483647,
      badges: ['first-trade', 'unrecognized-returned-badge-' + 'a'.repeat(120)],
    };
    await login(page, profile());
    await expect(metric(page, 'completion')).toBeVisible();
    const button = record(page).getByRole('button', { name: 'Refresh record', exact: true });
    await button.focus();
    await page.evaluate(() => (window.__focusBefore = document.activeElement));
    const peer = await context.newPage();
    await peer.goto('/help');
    for (const [language, title, lang] of [
      ['es', 'Historial P2P informado', 'es'],
      ['fr', 'Historique P2P déclaré', 'fr'],
      ['ar', 'Reported P2P record', 'en'],
    ]) {
      await peer.evaluate((language) => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ language })), language);
      await expect(record(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(record(page)).toHaveAttribute('lang', lang);
      expect(await page.evaluate(() => document.activeElement === window.__focusBefore)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await page.screenshot({ path: join(out, language + '.png') });
    }
    const links = page.locator('[data-testid="pay-room-tabs"] a');
    await expect(links).toHaveCount(5);
    await links.first().focus();
    for (let i = 0; i < 5; i++) {
      if (i) await page.keyboard.press('Tab');
      await expect(links.nth(i)).toBeFocused();
      await stable(page);
      const fits = await links.nth(i).evaluate((n) => {
        const a = n.getBoundingClientRect(),
          b = n.parentElement.getBoundingClientRect();
        return a.left >= b.left - 1 && a.right <= b.right + 1;
      });
      expect(fits).toBe(true);
    }
  });
});
test('unsafe or private return parameters are removed; login/register preserve complete validated nested destination', async ({
  browser,
}) => {
  await scenario(browser, 'validated-return', 390, async ({ page, state }) => {
    const good = '/p2p?asset=USDT&fiatCurrency=USD&side=sell&limit=200&offerId=' + offerId + '#offer-details';
    const target = profile(subject, good);
    await page.goto('/login?redirect=' + encodeURIComponent(target));
    const register = page.locator('[data-testid="public-auth-form-links"] a');
    expect(new URL(await register.getAttribute('href'), page.url()).searchParams.get('redirect')).toBe(target);
    await register.click();
    expect(
      new URL(await page.locator('[data-testid="public-auth-form-links"] a').getAttribute('href'), page.url()).searchParams.get('redirect'),
    ).toBe(target);
    await page.locator('[data-testid="public-auth-form-links"] a').click();
    await login(page, target);
    await expect(record(page).getByRole('link', { name: 'Back to this offer', exact: true })).toHaveAttribute('href', good);
    for (const [candidate, expected] of [
      ['https://evil.invalid/chat?tradeId=' + orderId, '/p2p'],
      ['/ops', '/p2p'],
      ['/pay/payments', '/p2p'],
      ['/p2p?amount=900&terms=private&offerId=' + offerId + '#safe', '/p2p?offerId=' + offerId + '#safe'],
      ['/p2p?offerId=' + offerId + '&offerId=' + offerId, '/p2p'],
    ]) {
      await page.evaluate(
        (href) => {
          history.pushState(null, '', href);
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
        profile(subject, candidate),
      );
      await expect(record(page).getByTestId('p2p-counterparty-return')).toHaveAttribute('href', expected);
    }
    const count = state.reads.filter((r) => r.procedure === 'reputation.get').length;
    await page.evaluate((href) => {
      history.pushState(null, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, profile('invalid'));
    await expect(record(page)).toHaveCount(0);
    await stable(page);
    expect(state.reads.filter((r) => r.procedure === 'reputation.get').length).toBe(count);
  });
});
