import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const owner = '11111111-1111-4111-8111-111111111111';
const key = `trade-pending:${owner}`;
const otherKey = 'trade-pending:99999999-9999-4999-8999-999999999999';
const baseURL = process.env.TRADE_MARKET_RECOVERY_BASE_URL;
const evidence = process.env.TRADE_MARKET_RECOVERY_EVIDENCE;
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
  state.openReply = async () => ({ json: state.order.status === 'open' ? [state.order] : [] });
  state.closedReply = async () => ({ json: [] });
  state.deleteReply = async () => ({
    status: 503,
    json: { code: 'trade.cancel_unavailable', message: 'Isolated cancellation outcome unknown' },
  });
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
        if (req.method() === 'DELETE' && path === '/api/v1/orders/order-1') return send(await state.deleteReply());
        if (req.method() === 'PATCH' && path === '/api/v1/orders/order-1') return send(await state.patchReply());
        throw Error(`Unexpected financial request ${req.method()} ${path}`);
      }
      state.reads.push({ path, principal, query: url.search });
      if (path === '/api/v1/orders/order-1') return send(await state.orderReply());
      let data = [];
      if (path === '/api/v1/markets') return send(await state.marketReply());
      else if (path === '/api/v1/orders/open') return send(await state.openReply());
      else if (path === '/api/v1/orders/closed') return send(await state.closedReply());
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
const originalRaw = (page) => page.evaluate((key) => (window.__tradeOriginalGet ?? Storage.prototype.getItem).call(localStorage, key), key);
const storage = (page) =>
  page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
    history: history.state,
  }));
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
            'Actual compiled App; isolated illustrative owner/API replies. Bounded unavailable-market owner inspection/recovery evidence, not market-quality/live authority/funding proof.',
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

async function login(page, destination = '/uc/entrust/current') {
  await page.goto(`/login?redirect=${encodeURIComponent(destination)}`);
  await page.locator('input[autocomplete="username"]').fill('isolated@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('[aria-label="Account order management"]')).toBeVisible();
}
const original = { kind: 'cancel', id: 'order-1', orderId: 'order-1', symbol: 'BTC/USDT', startedAt: 1791633000000 };
function seedOriginal(value = original) {
  return {
    script: ({ key, value }) => {
      if (location.origin !== 'null') localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    args: { key, value },
  };
}
const arrival = async (page, locator) =>
  locator.evaluate((n) => ({
    target: n.getBoundingClientRect().toJSON(),
    footerTop: document.querySelector('.mobile-doors')?.getClientRects().length
      ? document.querySelector('.mobile-doors').getBoundingClientRect().top
      : innerHeight,
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollY,
  }));
test('owner original recovery leads the unavailable-market frame without forced scrolling', async ({ browser }) => {
  for (const width of [320, 390, 768, 1440])
    await scenario(
      browser,
      'original-arrival-' + width,
      async ({ page, state }) => {
        state.marketReply = async () => ({
          status: 503,
          json: { code: 'trade.markets_unavailable', message: 'Isolated catalogue temporarily unavailable' },
        });
        await login(page);
        await expect(page.locator('#main .trade-uncertain')).toContainText('order-1');
        await expect
          .poll(() =>
            state.reads.some(
              (r) =>
                r.path === '/api/v1/orders/open' && r.principal === owner && r.query.includes('limit=100') && !r.query.includes('symbol='),
            ),
          )
          .toBe(true);
        const control = page.getByRole('button', { name: 'Check original request status', exact: true });
        const geometry = await arrival(page, control);
        state.observations.push({ arrival: geometry });
        await capture(page, state, 'original-arrival-' + width);
        expect(geometry.target.top).toBeGreaterThanOrEqual(0);
        expect(geometry.target.bottom).toBeLessThanOrEqual(geometry.footerTop);
        expect(geometry.scrollY).toBe(0);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(width);
        expect(JSON.parse(await originalRaw(page))).toEqual(original);
        expect(state.writes).toEqual([]);
      },
      width,
      seedOriginal(),
    );
});

test('working orders remain useful and unknown cancellation survives market recovery', async ({ browser }) => {
  for (const width of [320, 390, 768, 1440])
    await scenario(
      browser,
      'working-arrival-' + width,
      async ({ page, state }) => {
        state.marketReply = async () => ({
          status: 503,
          json: { code: 'trade.markets_unavailable', message: 'Isolated catalogue temporarily unavailable' },
        });
        await login(page);
        const panel = page.locator('[aria-label="Account order management"]');
        await expect(panel).toContainText('order-1');
        const box = await arrival(page, panel.locator('tbody tr').first());
        state.observations.push({ firstWorkingOrder: box });
        await capture(page, state, 'working-arrival-' + width);
        expect(box.target.bottom).toBeLessThanOrEqual(box.footerTop);
        expect(box.scrollY).toBe(0);
        expect(box.scrollWidth).toBeLessThanOrEqual(width);
        const details = page.locator('.trade-fallback-tools');
        expect(await details.getAttribute('open')).toBeNull();
        await details.locator('summary').focus();
        await page.keyboard.press('Enter');
        await expect(details.getByRole('button', { name: 'Review order', exact: true })).toBeDisabled();
        await expect(details.getByRole('link', { name: 'Manage in Money ↗', exact: true })).toHaveAttribute('href', '/money');
        await expect(panel.getByRole('button', { name: 'Reduce', exact: true })).toBeDisabled();
        expect(state.writes).toEqual([]);
      },
      width,
    );
  await scenario(
    browser,
    'cancel-unknown-recovery',
    async ({ page, state }) => {
      state.marketReply = async () => ({
        status: 503,
        json: { code: 'trade.markets_unavailable', message: 'Isolated catalogue temporarily unavailable' },
      });
      await login(page);
      await page.locator('[aria-label="Account order management"]').getByRole('button', { name: 'Cancel', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('order-1');
      await expect(dialog).toContainText('BTC/USDT');
      await dialog.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
      await expect(page.locator('#main .trade-uncertain')).toContainText('Outcome not confirmed');
      const saved = JSON.parse(await originalRaw(page));
      expect(Object.keys(saved).sort()).toEqual(['id', 'kind', 'orderId', 'startedAt', 'symbol']);
      expect(saved).toMatchObject({ kind: 'cancel', id: 'order-1', orderId: 'order-1', symbol: 'BTC/USDT' });
      expect(state.writes).toHaveLength(1);
      expect(state.writes[0]).toMatchObject({ method: 'DELETE', path: '/api/v1/orders/order-1', principal: owner });
      await capture(page, state, 'cancel-unknown-320');
      await page.reload();
      await login(page);
      expect(JSON.parse(await originalRaw(page))).toEqual(saved);
      state.marketReply = async () => ({ json: [market()] });
      await page.getByRole('button', { name: 'Retry published markets', exact: true }).click();
      await expect(page.locator('.trade-fallback')).toHaveCount(0);
      await expect(page.locator('#main .trade-uncertain')).toContainText('order-1');
      expect(JSON.parse(await originalRaw(page))).toEqual(saved);
      const control = page.getByRole('button', { name: 'Check original request status', exact: true });
      await control.click();
      await expect(control).toBeEnabled();
      expect(JSON.parse(await originalRaw(page))).toEqual(saved);
      state.order = order({ status: 'canceled' });
      await control.click();
      await expect.poll(() => originalRaw(page)).toBeNull();
      expect(state.writes).toHaveLength(1);
      await capture(page, state, 'recovered-published-market-320');
    },
    320,
  );
});
test('independent owner failure, history, loading and simulation preserve honest recovery', async ({ browser }) => {
  await scenario(
    browser,
    'owner-read-failure',
    async ({ page, state }) => {
      state.marketReply = async () => ({
        status: 503,
        json: { code: 'trade.markets_unavailable', message: 'Isolated catalogue temporarily unavailable' },
      });
      state.openReply = async () => ({
        status: 503,
        json: { code: 'trade.orders_unavailable', message: 'Isolated current order read unavailable' },
      });
      await login(page);
      const panel = page.locator('[aria-label="Account order management"]');
      await expect(panel).toContainText('Isolated current order read unavailable');
      await expect(panel.locator('tbody tr')).toHaveCount(0);
      await expect(panel).not.toContainText('No open orders');
      await capture(page, state, 'owner-read-failure-390');
      state.openReply = async () => ({ json: [state.order] });
      await panel.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(panel).toContainText('order-1');
      state.closedReply = async () => ({ json: [order({ id: 'history-1', status: 'closed', filled: '0.025', remaining: '0' })] });
      await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
      await panel.getByRole('button', { name: 'History', exact: true }).click();
      await expect(panel).toContainText('history-1');
      expect(
        state.reads
          .filter((r) => r.path === '/api/v1/orders/closed')
          .every((r) => r.query.includes('limit=100') && !r.query.includes('symbol=') && r.principal === owner),
      ).toBe(true);
      await panel.getByRole('button', { name: 'Fills', exact: true }).click();
      await expect(panel).toContainText('No fills in this page');
      expect(state.writes).toEqual([]);
    },
    390,
  );
  await scenario(
    browser,
    'loading-owner-recovery',
    async ({ page, state }) => {
      let finish;
      state.marketReply = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      await login(page);
      await expect(page.getByRole('button', { name: 'Check original request status', exact: true })).toBeVisible();
      const box = await arrival(page, page.getByRole('button', { name: 'Check original request status', exact: true }));
      expect(box.target.bottom).toBeLessThanOrEqual(box.footerTop);
      await capture(page, state, 'loading-owner-recovery-320');
      finish({ json: [] });
      await expect(page.getByRole('button', { name: 'Retry published markets', exact: true })).toBeVisible();
      expect(JSON.parse(await originalRaw(page))).toEqual(original);
      expect(state.writes).toEqual([]);
    },
    320,
    seedOriginal(),
  );
  await scenario(
    browser,
    'simulation-no-live-orders',
    async ({ page, state }) => {
      state.marketReply = async () => ({ json: [] });
      await login(page, '/exchange?simulated=true');
      const panel = page.locator('[aria-label="Account order management"]');
      await expect(panel).toContainText('simulation');
      await expect(panel.locator('tbody tr')).toHaveCount(0);
      expect(
        state.reads.filter((r) =>
          ['/api/v1/orders/open', '/api/v1/orders/closed', '/api/v1/account/trades', '/api/v1/account/balance'].includes(r.path),
        ),
      ).toEqual([]);
      expect(state.writes).toEqual([]);
      await capture(page, state, 'simulation-no-live-orders-320');
    },
    320,
  );
  await scenario(
    browser,
    'long-public-error',
    async ({ page, state }) => {
      state.marketReply = async () => ({
        status: 503,
        json: { code: 'trade.markets_unavailable', message: 'Isolated public market error. ' + 'Recorded service context. '.repeat(80) },
      });
      await login(page);
      const box = await arrival(page, page.getByRole('button', { name: 'Check original request status', exact: true }));
      expect(box.target.bottom).toBeLessThanOrEqual(box.footerTop);
      const details = page.locator('.trade-fallback-error');
      expect(await details.getAttribute('open')).toBeNull();
      await details.locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(details).toContainText('Recorded service context.');
      expect(JSON.parse(await originalRaw(page))).toEqual(original);
      expect(state.writes).toEqual([]);
      await capture(page, state, 'long-public-error-open-320');
    },
    320,
    seedOriginal(),
  );
});

test('legacy privacy warning and original recovery fit the unavailable-market phone frame', async ({ browser }) => {
  const seed = {
    script: ({ key, value }) => {
      if (location.origin === 'null') return;
      const set = Storage.prototype.setItem;
      set.call(localStorage, key, JSON.stringify(value));
      Storage.prototype.setItem = function (requested, value) {
        if (this === localStorage && requested === key) throw new DOMException('Isolated original storage refusal', 'QuotaExceededError');
        return set.call(this, requested, value);
      };
    },
    args: { key, value: legacy },
  };
  await scenario(
    browser,
    'legacy-fallback-private-warning',
    async ({ page, state }) => {
      state.marketReply = async () => ({
        status: 503,
        json: { code: 'trade.markets_unavailable', message: 'Isolated catalogue temporarily unavailable' },
      });
      await login(page);
      const panel = page.locator('[aria-label="Account order management"]');
      await expect(panel.locator('[data-trade-privacy-blocked]')).toBeVisible();
      const control = panel.getByRole('button', { name: 'Check original request status', exact: true });
      const box = await arrival(page, control);
      expect(box.target.bottom).toBeLessThanOrEqual(box.footerTop);
      expect(box.scrollY).toBe(0);
      expect(JSON.parse(await originalRaw(page))).toEqual(legacy);
      await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      expect(state.writes).toEqual([]);
      await capture(page, state, 'legacy-fallback-private-warning-320');
    },
    320,
    seed,
  );
});
