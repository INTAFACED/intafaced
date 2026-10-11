import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const owner = '11111111-1111-4111-8111-111111111111';
const key = `trade-pending:${owner}`;
const otherKey = 'trade-pending:99999999-9999-4999-8999-999999999999';
const baseURL = process.env.TRADE_PRIVATE_ORIGINALS_BASE_URL;
const evidence = process.env.TRADE_PRIVATE_ORIGINALS_EVIDENCE;
mkdirSync(evidence, { recursive: true });
const time = Date.now(),
  datetime = new Date(time).toISOString();
function market() {
  return {
    id: 'market-BTC',
    symbol: 'BTC/USDT',
    base: 'BTC',
    quote: 'USDT',
    settle: null,
    baseId: 'BTC',
    quoteId: 'USDT',
    type: 'spot',
    spot: true,
    swap: false,
    future: false,
    option: false,
    contract: false,
    linear: null,
    inverse: null,
    active: true,
    orderable: true,
    paper: false,
    schedule: 'crypto-24x7',
    sessionOpen: true,
    nextSessionChange: null,
    hours: { kind: 'continuous' },
    taker: '0.001',
    maker: '0.001',
    contractSize: null,
    expiry: null,
    expiryDatetime: null,
    strike: null,
    optionType: null,
    precisionMode: 'TICK_SIZE',
    precision: { amount: '0.00001', price: '0.01' },
    limits: {
      amount: { min: '0.00001', max: null },
      price: { min: null, max: null },
      cost: { min: '5', max: null },
      leverage: { min: null, max: null },
    },
  };
}
function order(overrides = {}) {
  return {
    id: 'order-1',
    clientOrderId: 'original-1',
    timestamp: time,
    datetime,
    lastTradeTimestamp: null,
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    timeInForce: 'GTC',
    postOnly: false,
    reduceOnly: false,
    price: '80000',
    stopPrice: null,
    average: null,
    amount: '0.025',
    filled: '0',
    remaining: '0.025',
    cost: '0',
    status: 'open',
    recoveryRequired: false,
    recoveryReason: null,
    reconciliationKey: null,
    fee: null,
    trades: [],
    ...overrides,
  };
}
function canonicalAmend() {
  return {
    accepted: true,
    idempotent: false,
    code: 'AMENDED',
    reasonCode: null,
    reconciliationRequired: false,
    path: 'native',
    priority: 'retained',
    orderId: 'order-1',
    order: order({ amount: '0.010', remaining: '0.010' }),
  };
}
async function network(context) {
  const state = { reads: [], writes: [], errors: [], transportErrors: [], documents: [], logins: [], observations: [], order: order() };
  state.orderReply = async () => ({ status: 200, json: state.order });
  state.marketReply = async () => ({ json: [market()] });
  state.patchReply = async () => ({ status: 503, json: { message: 'Isolated amendment outcome unknown' } });
  const observe = (page) => {
    page.on('pageerror', (e) => state.errors.push(e.message));
    page.on('request', (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) state.documents.push(r.url());
    });
  };
  context.pages().forEach(observe);
  context.on('page', observe);
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    const send = (reply) => route.fulfill(reply);
    if (path.endsWith('/auth.login')) {
      const accessToken = `isolated-trade-owner-${state.logins.length + 1}`;
      state.logins.push({ accessToken, owner });
      return send({
        json: {
          result: {
            data: {
              userId: owner,
              accessToken,
              refreshToken: `isolated-trade-refresh-${state.logins.length}`,
              expiresAt: '2027-10-10T00:00:00Z',
            },
          },
        },
      });
    }
    const authorization = req.headers().authorization;
    const principal = state.logins.find((l) => `Bearer ${l.accessToken}` === authorization)?.owner;
    if (/\/orders|\/account\//.test(path) && !principal)
      return send({ status: 401, json: { message: 'Authentication required for this owner read' } });
    try {
      if (req.method() !== 'GET') {
        expect(principal).toBe(owner);
        state.writes.push({ method: req.method(), path, body: req.postDataJSON(), principal });
        if (req.method() === 'PATCH' && path === '/api/v1/orders/order-1') return send(await state.patchReply());
        throw Error(`Unexpected financial request ${req.method()} ${path}`);
      }
      state.reads.push({ path, principal });
      if (path === '/api/v1/orders/order-1') return send(await state.orderReply());
      let data = [];
      if (path === '/api/v1/markets') return send(await state.marketReply());
      else if (path === '/api/v1/orders/open') data = state.order.status === 'open' ? [state.order] : [];
      else if (path.startsWith('/api/v1/orderbook/'))
        data = { symbol: 'BTC/USDT', bids: [['80000', '1']], asks: [['80001', '1']], timestamp: time, datetime, nonce: 1 };
      else if (path.startsWith('/api/v1/ohlcv/')) data = [[time - 60000, '80000', '80020', '79990', '80001', '1']];
      else if (path === '/api/v1/account/balance')
        data = {
          timestamp: time,
          datetime,
          balances: { USDT: { free: '7500', used: '500', total: '8000' }, BTC: { free: '0.05', used: '0', total: '0.05' } },
        };
      else if (path.startsWith('/api/v1/ticker/'))
        data = {
          symbol: 'BTC/USDT',
          timestamp: time,
          datetime,
          high: null,
          low: null,
          bid: '80000',
          bidVolume: '1',
          ask: '80001',
          askVolume: '1',
          vwap: null,
          open: null,
          close: '80000',
          last: '80000',
          previousClose: null,
          change: null,
          percentage: null,
          average: null,
          baseVolume: null,
          quoteVolume: null,
        };
      else if (!['/api/v1/orders/closed', '/api/v1/account/trades', '/api/v1/positions', '/api/v1/trades/BTC%2FUSDT'].includes(path))
        return send({ status: 503, json: { message: 'Isolated unrelated read unavailable' } });
      return send({ json: data });
    } catch (e) {
      state.transportErrors.push({ path, message: e.message });
    }
  });
  return state;
}
async function login(page, destination = '/exchange') {
  await page.goto(`/login?redirect=${encodeURIComponent(destination)}`);
  await page.locator('input[autocomplete="username"]').fill('isolated@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form button[type="submit"]').click();
  await expect(
    page
      .locator('#main .trade-uncertain')
      .or(page.getByRole('button', { name: 'Reduce', exact: true }).first())
      .first(),
  ).toBeVisible();
}
const originalRaw = (page) => page.evaluate((key) => (window.__tradeOriginalGet ?? Storage.prototype.getItem).call(localStorage, key), key);
const storage = (page) =>
  page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
    history: history.state,
  }));
async function reduce(page) {
  await page.getByRole('button', { name: 'Reduce', exact: true }).first().click();
  await page.getByLabel('New remaining quantity (BTC)', { exact: true }).fill('0.010');
  await page.getByRole('button', { name: 'Confirm reduction', exact: true }).click();
}
async function unknown(page) {
  await expect(page.locator('#main .trade-uncertain')).toContainText('Outcome not confirmed · amend');
}
async function minimal(page) {
  const value = JSON.parse(await originalRaw(page));
  expect(Object.keys(value).sort()).toEqual(['id', 'kind', 'orderId', 'startedAt', 'symbol']);
  expect(value).toMatchObject({ id: 'order-1', kind: 'amend', orderId: 'order-1', symbol: 'BTC/USDT' });
  expect(JSON.stringify(await storage(page))).not.toContain('0.010');
  expect(JSON.stringify(await storage(page))).not.toContain('0.025');
  return value;
}
async function check(page) {
  const reply = page.waitForResponse((r) => r.url().endsWith('/api/v1/orders/order-1') && r.request().method() === 'GET');
  await page.getByRole('button', { name: 'Check original request status', exact: true }).click();
  await (await reply).finished();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(page.getByRole('button', { name: 'Checking status…', exact: true })).toHaveCount(0);
}

async function capture(page, state, name) {
  const observation = {
    name,
    storage: await storage(page),
    raw: await originalRaw(page),
    geometry: await page.locator('#main').evaluate((n) => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      alert: n.querySelector('.trade-uncertain')?.getBoundingClientRect().toJSON(),
      footerTop: document.querySelector('.mobile-doors')?.getBoundingClientRect().top,
      dom: n.outerHTML,
    })),
  };
  state.observations.push(observation);
  await page.screenshot({ path: join(evidence, name + '-viewport.png') });
  await page.screenshot({ path: join(evidence, name + '-whole.png'), fullPage: true });
}
async function scenario(browser, name, run, width = 1440, seed) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: width < 768 ? 844 : 1000 } }),
    state = await network(context);
  if (seed) await context.addInitScript(seed.script, seed.args);
  const page = await context.newPage();
  try {
    await run({ page, context, state });
    expect(state.errors).toEqual([]);
    expect(state.transportErrors).toEqual([]);
  } finally {
    writeFileSync(
      join(evidence, name + '-raw.json'),
      JSON.stringify(
        {
          ...state,
          qualification:
            'Actual compiled App; isolated illustrative owner/API replies. Bounded privacy/recovery evidence, not market-quality/live authority/funding proof.',
        },
        null,
        2,
      ),
    );
    await context.close();
  }
}
const seedLegacy = (raw, mode) => ({
  args: { key, raw, mode, origin: baseURL },
  script: ({ key, raw, mode, origin }) => {
    if (location.origin !== new URL(origin).origin) return;
    localStorage.setItem(key, raw);
    if (mode === 'write') {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === key) throw new DOMException('Isolated write refusal', 'SecurityError');
        return original.call(this, k, v);
      };
    }
    if (mode === 'read') {
      window.__tradeOriginalGet = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k) {
        if (k === key) throw new DOMException('Isolated read refusal', 'SecurityError');
        return window.__tradeOriginalGet.call(this, k);
      };
    }
  },
});
const legacy = {
  kind: 'amend',
  symbol: 'BTC/USDT',
  id: 'order-1',
  orderId: 'order-1',
  startedAt: 1730000000000,
  expectedAmount: '0.010',
  originalAmount: '0.025',
  opaqueOriginalReference: 'preserve-this-original',
};

test('uncertain reduction uses minimal storage and only sufficient original recovery', async ({ browser }) => {
  await scenario(browser, 'same-session', async ({ page, state }) => {
    await login(page);
    await reduce(page);
    await unknown(page);
    const before = await minimal(page);
    await capture(page, state, 'same-session-unknown');
    state.order = order({ amount: '0.010', remaining: '0.006', filled: '0.004' });
    await check(page);
    await expect(page.locator('.trade-status')).toContainText('outcome is unresolved');
    await unknown(page);
    expect(await minimal(page)).toEqual(before);
    for (const wrong of [{ id: 'wrong-original' }, { symbol: 'ETH/USDT' }, { recoveryRequired: true, recoveryReason: 'AMEND_UNKNOWN' }]) {
      state.order = order({ status: 'closed', remaining: '0', ...wrong });
      await check(page);
      await unknown(page);
      expect(await minimal(page)).toEqual(before);
    }
    state.order = order({ status: 'closed', amount: '0.010', remaining: '0', filled: '0.010' });
    await check(page);
    await expect.poll(() => originalRaw(page)).toBeNull();
    await expect(page.locator('#main .trade-uncertain')).toHaveCount(0);
    expect(state.writes.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'PATCH', path: '/api/v1/orders/order-1', body: { qty: '0.010' } },
    ]);
  });
  await scenario(browser, 'reload-and-tabs', async ({ page, context, state }) => {
    await login(page);
    await reduce(page);
    await unknown(page);
    const before = await minimal(page);
    await page.reload();
    expect(JSON.parse(await originalRaw(page))).toEqual(before);
    await login(page);
    await unknown(page);
    expect(await minimal(page)).toEqual(before);
    state.order = order({ amount: '0.010', remaining: '0.010' });
    await check(page);
    await unknown(page);
    expect(await minimal(page)).toEqual(before);
    await capture(page, state, 'reload-unknown');
    const peer = await context.newPage();
    await login(peer);
    await unknown(peer);
    expect(await minimal(peer)).toEqual(before);
    await expect(peer.getByRole('button', { name: 'Reduce', exact: true }).first()).toBeDisabled();
    await page.close();
    await unknown(peer);
    expect(await minimal(peer)).toEqual(before);
    state.order = order({ status: 'closed', amount: '0.010', filled: '0.010', remaining: '0' });
    await check(peer);
    await expect.poll(() => originalRaw(peer)).toBeNull();
    expect(state.writes).toHaveLength(1);
  });
  await scenario(browser, 'direct-ack', async ({ page, state }) => {
    state.patchReply = async () => ({ json: canonicalAmend() });
    await login(page);
    await reduce(page);
    await expect.poll(() => state.writes.length).toBe(1);
    await expect.poll(() => originalRaw(page)).toBeNull();
    await expect(page.locator('#main .trade-uncertain')).toHaveCount(0);
    await expect(page.locator('.trade-status')).toContainText('accepted');
  });
});

test('legacy private fields are removed without losing references or blockers', async ({ browser }) => {
  await scenario(
    browser,
    'legacy-reference',
    async ({ page, state }) => {
      await login(page);
      await unknown(page);
      const expected = { ...legacy };
      delete expected.expectedAmount;
      delete expected.originalAmount;
      await expect.poll(async () => JSON.parse(await originalRaw(page))).toEqual(expected);
      await check(page);
      await unknown(page);
      expect(JSON.parse(await originalRaw(page))).toEqual(expected);
      await capture(page, state, 'legacy-reference-390');
      expect(state.writes).toEqual([]);
    },
    390,
    seedLegacy(JSON.stringify(legacy)),
  );
  await scenario(
    browser,
    'legacy-malformed-metadata',
    async ({ page, state }) => {
      await login(page);
      await expect
        .poll(async () => JSON.parse(await originalRaw(page)))
        .toEqual({
          kind: 'amend',
          symbol: 'BTC/USDT',
          id: 'order-1',
          orderId: 'order-1',
          startedAt: 'unreadable-time',
          opaqueOriginalReference: 'preserve-this-original',
        });
      await reduce(page);
      await expect(page.locator('.trade-status')).toContainText('saved trading request cannot be read');
      expect(state.writes).toEqual([]);
    },
    1440,
    seedLegacy(JSON.stringify({ ...legacy, startedAt: 'unreadable-time' })),
  );
  for (const mode of ['write', 'read'])
    await scenario(
      browser,
      'legacy-storage-' + mode,
      async ({ page, state }) => {
        await login(page);
        if (mode === 'write') {
          await unknown(page);
          await expect(page.locator('[data-trade-privacy-blocked]')).toContainText('private fields could not be removed');
          await expect
            .poll(() =>
              page.locator('#main .trade-uncertain').evaluate((n) => {
                const r = n.getBoundingClientRect();
                return r.bottom <= document.querySelector('.mobile-doors').getBoundingClientRect().top;
              }),
            )
            .toBe(true);
          await capture(page, state, 'legacy-write-blocked-320');
        } else {
          await reduce(page);
          await expect(page.locator('.trade-status')).toContainText('storage is unavailable');
        }
        expect(await originalRaw(page)).toBe(JSON.stringify(legacy));
        expect(state.writes).toEqual([]);
      },
      mode === 'write' ? 320 : 390,
      seedLegacy(JSON.stringify(legacy), mode),
    );
  await scenario(
    browser,
    'legacy-owner-lock',
    async ({ page, context, state }) => {
      const holder = await context.newPage();
      await holder.goto('/login');
      await holder.evaluate((owner) => {
        window.__legacyLock = false;
        void navigator.locks.request(`trade-account:${owner}`, async () => {
          window.__legacyLock = true;
          await new Promise((resolve) => {
            window.__releaseLegacyLock = resolve;
          });
        });
      }, owner);
      await expect.poll(() => holder.evaluate(() => window.__legacyLock)).toBe(true);
      await login(page);
      await unknown(page);
      await expect(page.locator('[data-trade-privacy-blocked]')).toBeVisible();
      expect(await originalRaw(page)).toBe(JSON.stringify(legacy));
      await holder.evaluate(() => window.__releaseLegacyLock());
      await login(page);
      await unknown(page);
      const expected = { ...legacy };
      delete expected.expectedAmount;
      delete expected.originalAmount;
      await expect.poll(async () => JSON.parse(await originalRaw(page))).toEqual(expected);
      await expect(page.locator('[data-trade-privacy-blocked]')).toHaveCount(0);
      expect(state.writes).toEqual([]);
    },
    390,
    seedLegacy(JSON.stringify(legacy)),
  );
  await scenario(
    browser,
    'legacy-account-orders',
    async ({ page, state }) => {
      state.marketReply = async () => ({ status: 503, json: { message: 'Isolated published catalogue unavailable' } });
      await login(page, '/uc/entrust/current');
      await unknown(page);
      const panel = page.locator('[aria-label="Account order management"]');
      await expect(panel.locator('[data-trade-privacy-blocked]')).toBeVisible();
      await expect
        .poll(() =>
          panel.evaluate((n) => {
            const notice = n.querySelector('.trade-uncertain'),
              blotter = n.querySelector('.trade-blotter');
            return notice && (notice.compareDocumentPosition(blotter) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
          }),
        )
        .toBe(true);
      await capture(page, state, 'account-orders-privacy-390');
      expect(await originalRaw(page)).toBe(JSON.stringify(legacy));
      expect(state.writes).toEqual([]);
    },
    390,
    seedLegacy(JSON.stringify(legacy), 'write'),
  );
});

test('late recovery cannot clear a changed original or a different owner marker', async ({ browser }) => {
  await scenario(browser, 'late-changed-original', async ({ page, state }) => {
    await login(page);
    await reduce(page);
    await unknown(page);
    const before = await minimal(page),
      replacement = { ...before, symbol: 'ETH/USDT' };
    let release;
    const held = new Promise((r) => (release = r));
    state.orderReply = async () => {
      await held;
      return { json: order({ status: 'closed', remaining: '0' }) };
    };
    const calls = state.reads.filter((r) => r.path === '/api/v1/orders/order-1').length;
    await page.getByRole('button', { name: 'Check original request status', exact: true }).click();
    await expect.poll(() => state.reads.filter((r) => r.path === '/api/v1/orders/order-1').length).toBe(calls + 1);
    const foreign = 'opaque-other-owner-original';
    await page.evaluate(
      ({ key, otherKey, replacement, foreign }) => {
        localStorage.setItem(otherKey, foreign);
        localStorage.setItem(key, JSON.stringify(replacement));
        window.dispatchEvent(new Event('trade-pending-change'));
      },
      { key, otherKey, replacement, foreign },
    );
    release();
    await expect(page.locator('#main .trade-uncertain')).toContainText('ETH/USDT');
    await expect.poll(async () => JSON.parse(await originalRaw(page))).toEqual(replacement);
    expect(await page.evaluate((k) => localStorage.getItem(k), otherKey)).toBe(foreign);
    await capture(page, state, 'changed-original-preserved');
    expect(state.writes).toHaveLength(1);
  });
  const raw = ' [ { "opaqueOriginalReference": "preserve-unreadable-original" } ] ';
  await scenario(
    browser,
    'opaque-original',
    async ({ page, state }) => {
      await login(page);
      await reduce(page);
      await expect(page.locator('.trade-status')).toContainText('saved trading request cannot be read');
      expect(await originalRaw(page)).toBe(raw);
      expect(state.writes).toEqual([]);
    },
    1440,
    seedLegacy(raw),
  );
});
