import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const baseURL = process.env.HOLDING_CHART_HANDOFF_BASE_URL;
const evidence = process.env.HOLDING_CHART_HANDOFF_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Use the explicit verified-candidate environment from the holding-handoff config.');
mkdirSync(evidence, { recursive: true });
const contractPin = 'e8befe08487e8f4303784328dac64f63ccc7686b';
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '44444444-4444-4444-8444-444444444444';
const primaryId = '22222222-2222-4222-8222-222222222222';
const exactPrice = '80035.50';
const destination = (symbol) => `/exchange/${encodeURIComponent(symbol)}`;
const holdingPath = (asset) => `/portfolio/${encodeURIComponent(asset)}`;
const chart = (page, symbol = 'BTC/USDT') => page.getByRole('group', { name: `Actual ${symbol} historical prices`, exact: true });
const priceInput = (page, symbol = 'BTC/USDT') => {
  const [base, quote] = symbol.split('/');
  return page.getByLabel(`Price (${quote} per ${base})`, { exact: true });
};
const ticket = (page) => page.getByRole('region', { name: 'Spot order ticket', exact: true });
const reviewFact = (page, label) =>
  ticket(page)
    .locator('dl > div')
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator('dd');
const currentURL = (page) => page.evaluate(() => location.pathname + location.search + location.hash);
const cents = (value) => `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
const pause = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const committedFrames = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

// Reuses the committed Trade listing/rule and120-bar/depth schemas. Fixture
// financial values remain exact strings; only visual indices/times are numbers.
function listing(base, quote = 'USDT') {
  return {
    id: `market-${base}-${quote}`,
    symbol: `${base}/${quote}`,
    base,
    quote,
    settle: null,
    baseId: base,
    quoteId: quote,
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
function candles(base, timeframe, at) {
  const step = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 }[timeframe];
  if (!step) throw new Error(`Unsupported isolated fixture timeframe: ${timeframe}`);
  const bucket = Math.floor(at / step) * step;
  return Array.from({ length: 120 }, (_, index) => {
    const centre = (base === 'ETH' ? 200000n : 8000000n) + BigInt((index % 24) * 170 - 1700 + (index >= 60 ? 1200 : 0));
    const close = index >= 112 ? (base === 'ETH' ? 203550n : 8003550n) : centre + BigInt(index % 3 ? 140 : -130);
    // Last8 real fixture buckets form an exact close plateau; open/wicks/volume
    // still vary. This makes ordinary last-candle pointer selection deterministic
    // at narrow widths without a fake chart handler or production sample mode.
    const high = centre + 260n > close ? centre + 260n : close + 260n;
    const slot = index + Math.floor(index / 25);
    return [
      bucket - (126 - slot) * step,
      cents(centre + BigInt(index % 2 ? 75 : -90)),
      cents(high),
      cents(centre - 250n),
      cents(close),
      `0.${(10000 + (index % 17) * 903).toString().padStart(5, '0')}`,
    ];
  });
}
function levels(base, side) {
  return Array.from({ length: 24 }, (_, index) => [
    cents((base === 'ETH' ? 200000n : 8000000n) + BigInt((side === 'bids' ? -1 : 1) * (index + 1) * 3)),
    `0.${(210 + (index % 7) * 91).toString().padStart(5, '0')}`,
  ]);
}
function order(at) {
  return {
    id: 'handoff-original-order',
    clientOrderId: 'handoff-original-client',
    timestamp: at,
    datetime: new Date(at).toISOString(),
    lastTradeTimestamp: null,
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    timeInForce: 'GTC',
    postOnly: false,
    reduceOnly: false,
    price: '79993.50',
    stopPrice: null,
    average: null,
    amount: '0.0025',
    filled: '0',
    remaining: '0.0025',
    cost: '0',
    status: 'open',
    recoveryRequired: false,
    recoveryReason: null,
    reconciliationKey: null,
    fee: null,
    trades: [],
  };
}
function preview(input, changed = false) {
  const [base, quote] = input.symbol.split('/');
  // Worked exact example80035.50*.0025=200.08875; buy fee10bps=.0000025BTC.
  return {
    symbol: input.symbol,
    side: input.side,
    type: input.type,
    amount: input.amount,
    price: input.price ?? null,
    timeInForce: input.postOnly ? 'PO' : input.timeInForce,
    holdAsset: quote,
    holdAmount: '200.08875',
    protectionPrice: null,
    estimatedFee: changed ? '0.00000375' : '0.0000025',
    feeAsset: base,
    feeBps: changed ? 15 : 10,
    feeRole: 'taker',
    orderable: true,
    refusals: [],
  };
}
async function fixtures(context) {
  const at = Date.now();
  const state = {
    reads: [],
    previews: [],
    forbiddenWrites: [],
    errors: [],
    cancelled: [],
    logins: [],
    documents: [],
    observations: [],
    sockets: [],
    owner: ownerA,
    markets: [listing('BTC'), listing('ETH')],
    catalogueStatus: 200,
    historyStatus: 200,
    currentOrder: order(at),
    pending: [],
  };
  state.catalogue = async () => ({ status: state.catalogueStatus, data: structuredClone(state.markets) });
  state.history = async (symbol, timeframe) => ({ status: state.historyStatus, data: candles(symbol.split('/')[0], timeframe, at) });
  state.readOrder = async () => ({ status: 200, data: structuredClone(state.currentOrder) });
  state.preview = async (input) => ({ status: 200, data: preview(input) });
  const observe = (page) => {
    page.on('pageerror', (error) => state.errors.push(error.message));
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) state.documents.push(request.url());
    });
  };
  context.pages().forEach(observe);
  context.on('page', observe);
  await context.routeWebSocket('**/ws/**', (socket) => {
    const marketId = new URL(socket.url()).searchParams.get('market');
    const market = state.markets.find((row) => row.id === marketId);
    state.sockets.push({ socket, marketId });
    if (market)
      socket.send(
        JSON.stringify({ type: 'snapshot', marketId, sequence: 12, bids: levels(market.base, 'bids'), asks: levels(market.base, 'asks') }),
      );
  });
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const procedure = decodeURIComponent(path.split('/').at(-1));
    const rpc = (data) => route.fulfill({ status: 200, json: { result: { data } } });
    if (procedure === 'auth.login') {
      const token = `isolated-handoff-token-${state.logins.length + 1}`;
      state.logins.push({ owner: state.owner, token });
      return rpc({ userId: state.owner, accessToken: token, refreshToken: 'isolated-handoff-refresh', expiresAt: '2027-10-10T08:00:00Z' });
    }
    if (procedure === 'auth.logout') return rpc({ ok: true });
    if (request.method() !== 'GET') {
      if (path === '/api/v1/orders/preview' && request.method() === 'POST') {
        const input = request.postDataJSON();
        state.previews.push(input);
        const answer = await state.preview(input);
        return route.fulfill({
          status: answer.status,
          json:
            answer.status === 200
              ? answer.data
              : { error: 'trade.preview_unavailable', message: 'Isolated authoritative preview unavailable' },
        });
      }
      state.forbiddenWrites.push({ path, method: request.method(), body: request.postData() });
      return route.fulfill({
        status: 503,
        json: { error: 'fixture.financial_dispatch_forbidden', message: 'No financial dispatch is authorized by this native fixture' },
      });
    }
    state.reads.push({
      path,
      query: Object.fromEntries(url.searchParams),
      input: JSON.parse(url.searchParams.get('input') || 'null'),
      authorization: request.headers().authorization ?? null,
    });
    const symbol = decodeURIComponent(path.split('/').at(-1)),
      base = symbol.split('/')[0];
    let answer;
    if (path === '/api/v1/markets') answer = await state.catalogue();
    else if (path.startsWith('/api/v1/ohlcv/')) answer = await state.history(symbol, url.searchParams.get('timeframe'));
    else if (path.startsWith('/api/v1/orderbook/'))
      answer = {
        status: 200,
        data: {
          symbol,
          bids: levels(base, 'bids'),
          asks: levels(base, 'asks'),
          timestamp: Date.now(),
          datetime: new Date().toISOString(),
          nonce: 12,
        },
      };
    else if (path.startsWith('/api/v1/ticker/'))
      answer = {
        status: 200,
        data: {
          symbol,
          timestamp: at,
          datetime: new Date(at).toISOString(),
          high: null,
          low: null,
          bid: base === 'ETH' ? '1999.97' : '79999.97',
          bidVolume: '0.00210',
          ask: base === 'ETH' ? '2000.03' : '80000.03',
          askVolume: '0.00210',
          vwap: null,
          open: null,
          close: base === 'ETH' ? '2035.50' : exactPrice,
          last: base === 'ETH' ? '2035.50' : exactPrice,
          previousClose: null,
          change: null,
          percentage: null,
          average: null,
          baseVolume: null,
          quoteVolume: null,
        },
      };
    else if (path === '/api/v1/account/balance')
      answer = {
        status: 200,
        data: {
          timestamp: at,
          datetime: new Date(at).toISOString(),
          balances: {
            USDT: { free: '7500', used: '800.8', total: '8300.8' },
            USDC: { free: '9000', used: '0', total: '9000' },
            BTC: { free: '0.05', used: '0.005', total: '0.055' },
            ETH: { free: '2', used: '0', total: '2' },
            ...Object.fromEntries(
              state.markets
                .filter((row) => !['BTC', 'ETH'].includes(row.base))
                .map((row) => [row.base, { free: '1', used: '0', total: '1' }]),
            ),
          },
        },
      };
    else if (procedure === 'spaces.list')
      return rpc([
        {
          id: primaryId,
          assetId: 'USDT',
          kind: 'primary',
          name: 'Main',
          goalTarget: null,
          lockedUntil: null,
          balance: '7500',
          ledgerAccount: { ownerType: 'user', ownerId: state.owner, assetId: 'USDT', kind: 'available' },
        },
      ]);
    else if (procedure === 'spaces.unnamed') return rpc([{ assetId: 'USDT', balance: '7500' }]);
    else if (path === '/api/v1/orders/open')
      answer = { status: 200, data: state.currentOrder.status === 'open' ? [state.currentOrder] : [] };
    else if (['/api/v1/orders/closed', '/api/v1/account/trades', '/api/v1/positions'].includes(path) || path.startsWith('/api/v1/trades/'))
      answer = { status: 200, data: [] };
    else if (path.startsWith('/api/v1/orders/')) answer = await state.readOrder();
    else answer = { status: 503 };
    try {
      await route.fulfill({
        status: answer.status,
        json: answer.status === 200 ? answer.data : { error: 'fixture.read_unavailable', message: 'Isolated current source unavailable' },
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
    await run({ context, page, state });
    expect(state.forbiddenWrites).toEqual([]);
    expect(state.errors).toEqual([]);
  } finally {
    state.pending.forEach((held) => held.release());
    writeFileSync(
      `${evidence}/${name}.json`,
      JSON.stringify(
        {
          contractPin,
          qualification:
            'Actual ordinary App/Login/Person menu with isolated mounted-shaped HTTP. No real JWT/SQL/owner authority, financial dispatch, producer or production sample-mode proof.',
          ...state,
        },
        (key, value) => (typeof value === 'function' || ['sockets', 'pending'].includes(key) ? undefined : value),
        2,
      ),
    );
    await context.close();
  }
}
async function submitLogin(page, route) {
  await page.locator('input[autocomplete="username"]').fill('handoff@example.invalid');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-password');
  await page.locator('form button[type="submit"]').click();
  await expect.poll(() => currentURL(page)).toBe(route);
}
async function login(page, route = '/money') {
  await page.goto(`/login?redirect=${encodeURIComponent(route)}`);
  await submitLogin(page, route);
}
async function ownerProof(page, owner = ownerA) {
  await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
  const menu = page.getByRole('dialog');
  await expect(menu.getByText(owner, { exact: true })).toBeVisible();
  await menu.getByRole('button', { name: 'Close dialog', exact: true }).click();
}
async function holding(page, asset = 'BTC') {
  await page.locator(`.money-home a.money-holding[href="${holdingPath(asset)}"]`).click();
  await expect.poll(() => currentURL(page)).toBe(holdingPath(asset));
}
async function inspect(page, symbol = 'BTC/USDT') {
  const view = chart(page, symbol);
  await expect(view.locator('canvas').first()).toBeVisible();
  await view.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.trade-candle-inspection')).toContainText(exactPrice);
}
async function activate(page, symbol = 'BTC/USDT', kind = 'keyboard') {
  const view = chart(page, symbol);
  if (kind === 'keyboard') {
    await inspect(page, symbol);
    await view.press('Enter');
  } else {
    await expect(view.locator('canvas').first()).toBeVisible();
    await page.locator('.trade-chart-context').getByRole('button', { name: 'Fit', exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    const plot = await view.locator('canvas').first().boundingBox();
    expect(plot.width).toBeGreaterThan(100);
    await page.mouse.click(plot.x + plot.width - 8, plot.y + plot.height / 2);
    await expect(page.locator('.trade-candle-inspection')).toContainText(exactPrice);
    expect(await currentURL(page)).toBe(holdingPath(symbol.split('/')[0]));
    const useClose = page.getByRole('button', { name: 'Use close in Trade', exact: true });
    await expect(useClose).toBeVisible();
    await expect(useClose).toBeEnabled();
    await useClose.click();
  }
}
async function arrived(page, symbol = 'BTC/USDT') {
  await expect.poll(() => currentURL(page)).toBe(destination(symbol));
  await expect(priceInput(page, symbol)).toHaveValue(exactPrice);
  await expect(chart(page, symbol).locator('canvas').first()).toBeVisible();
}
async function retain(page, symbol = 'BTC/USDT') {
  await inspect(page, symbol);
  await chart(page, symbol).evaluate((node) => {
    const key = Object.keys(node).find((value) => value.startsWith('__reactProps$'));
    const callback = key && node[key].onKeyDown;
    if (typeof callback !== 'function') throw new Error('Actual inspected chart callback unavailable');
    window.__retainedHoldingChart = () => callback({ key: 'Enter', target: node, currentTarget: node, preventDefault() {} });
  });
  await page.getByRole('button', { name: 'Use close in Trade', exact: true }).evaluate((node) => {
    const key = Object.keys(node).find((value) => value.startsWith('__reactProps$'));
    const callback = key && node[key].onClick;
    if (typeof callback !== 'function') throw new Error('Actual selected-close button callback unavailable');
    const keyboard = window.__retainedHoldingChart;
    window.__retainedHoldingChart = () => {
      keyboard();
      callback({ target: node, currentTarget: node, preventDefault() {} });
    };
  });
}
async function snapshot(page, name, state) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  state.observations.push(
    await page.evaluate(() => ({
      href: location.pathname + location.search + location.hash,
      timeOrigin: performance.timeOrigin,
      width: innerWidth,
      height: innerHeight,
      active: { tag: document.activeElement?.tagName, text: document.activeElement?.textContent },
    })),
  );
  await page.screenshot({ path: `${evidence}/${name}-viewport.png` });
  await page.screenshot({ path: `${evidence}/${name}-whole.png`, fullPage: true });
  await page
    .locator('.trade-chart')
    .first()
    .screenshot({ path: `${evidence}/${name}-chart.png` });
}
async function noTerms(page) {
  const stores = await page.evaluate(() => ({
    href: location.href,
    state: JSON.stringify(history.state),
    local: Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])),
    session: Object.fromEntries(Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)])),
  }));
  expect(JSON.stringify(stores)).not.toContain(exactPrice);
  expect(JSON.stringify(stores)).not.toContain('isolated-handoff-token');
  return stores;
}

test('current holding pointer and keyboard candles reach exact Trade draft at four widths without losing document or owner', async ({
  browser,
}) => {
  for (const width of [1440, 768, 390, 320])
    for (const kind of ['keyboard', 'pointer'])
      await scenario(
        browser,
        `handoff-${kind}-${width}`,
        async ({ page, state }) => {
          await login(page);
          await holding(page);
          await ownerProof(page);
          const timeOrigin = await page.evaluate(() => performance.timeOrigin),
            docs = state.documents.length;
          await snapshot(page, `holding-${kind}-${width}`, state);
          await activate(page, 'BTC/USDT', kind);
          await arrived(page);
          const origin = ticket(page).locator('.trade-holding-origin');
          await expect(origin).toHaveAttribute('role', 'status');
          await expect(origin).toBeVisible();
          await expect(origin).toBeFocused();
          await expect(origin).toContainText('BTC/USDT');
          await expect(origin).toContainText(exactPrice);
          await page.evaluate(() => document.fonts.ready);
          const arrival = await origin.evaluate((node) => {
            const rect = node.getBoundingClientRect(),
              nav = document.querySelector('.mobile-doors'),
              navRect = nav?.getBoundingClientRect(),
              visibleNav = nav && nav.getClientRects().length > 0 && getComputedStyle(nav).visibility !== 'hidden' && navRect.height > 0;
            return {
              top: rect.top,
              bottom: rect.bottom,
              viewportHeight: innerHeight,
              visibleBottom: visibleNav ? Math.min(innerHeight, navRect.top) : innerHeight,
              focused: document.activeElement === node,
              inputFocused: document.activeElement instanceof HTMLInputElement,
            };
          });
          expect(arrival.top).toBeGreaterThanOrEqual(0);
          expect(arrival.bottom).toBeLessThanOrEqual(arrival.visibleBottom);
          expect(arrival.focused).toBe(true);
          expect(arrival.inputFocused).toBe(false);
          state.observations.push({ currentDraftArrival: arrival });
          await page.screenshot({ path: `${evidence}/trade-arrival-${kind}-${width}-context.png` });
          await ownerProof(page);
          expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
          expect(state.documents).toHaveLength(docs);
          expect(state.logins).toHaveLength(1);
          expect(state.previews).toEqual([]);
          await noTerms(page);
          await snapshot(page, `trade-${kind}-${width}`, state);
        },
        width,
        width <= 390 ? 844 : 1000,
      );
});

test('exact same-base quote and long symbols cannot retarget; unavailable catalogue or delayed history refuses stale selection and current Retry works', async ({
  browser,
}) => {
  await scenario(
    browser,
    'market-identity',
    async ({ page, state }) => {
      state.markets = [listing('BTC'), listing('BTC', 'USDC'), listing('ETH')];
      await login(page);
      await holding(page);
      await inspect(page);
      state.markets = [listing('BTC', 'USDC'), listing('BTC'), listing('ETH')];
      await chart(page).press('Enter');
      await arrived(page, 'BTC/USDT');
      await ownerProof(page);
      await expect(priceInput(page, 'BTC/USDC')).toHaveCount(0);
      expect(state.previews).toEqual([]);
    },
    390,
  );
  await scenario(
    browser,
    'long-symbol',
    async ({ page, state }) => {
      const base = 'LONG-ASSET-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        quote = 'LONG-QUOTE-0123456789',
        symbol = `${base}/${quote}`;
      state.markets = [listing(base, quote), listing('BTC')];
      await login(page);
      await holding(page, base);
      await activate(page, symbol);
      await arrived(page, symbol);
      await ownerProof(page);
      await noTerms(page);
      await snapshot(page, 'long-symbol-320', state);
    },
    320,
  );
  await scenario(browser, 'catalogue-failure', async ({ page, state }) => {
    await login(page);
    await holding(page);
    await inspect(page);
    state.catalogueStatus = 503;
    await chart(page).press('Enter');
    await expect.poll(() => currentURL(page)).toBe(destination('BTC/USDT'));
    await expect(page.getByText('Isolated current source unavailable', { exact: true }).first()).toBeVisible();
    expect(state.previews).toEqual([]);
    state.catalogueStatus = 200;
    await page.getByRole('button', { name: 'Retry published markets', exact: true }).click();
    await arrived(page);
    expect(state.previews).toEqual([]);
    await page.goBack();
    await activate(page);
    await arrived(page);
  });
  await scenario(browser, 'successful-missing-market', async ({ page, state }) => {
    state.markets = [listing('BTC'), listing('BTC', 'USDC'), listing('ETH')];
    await login(page);
    await holding(page);
    await inspect(page);
    state.markets = [listing('BTC', 'USDC'), listing('ETH')];
    await chart(page).press('Enter');
    await expect.poll(() => currentURL(page)).toBe(destination('BTC/USDT'));
    await expect(page.getByText('This market is not available in this mode', { exact: true })).toBeVisible();
    await expect(priceInput(page, 'BTC/USDC')).toHaveCount(0);
    state.markets = [listing('BTC'), listing('BTC', 'USDC'), listing('ETH')];
    await page.getByRole('button', { name: 'Retry published markets', exact: true }).click();
    await expect(priceInput(page)).toHaveValue('');
    await page.goBack();
    await activate(page);
    await arrived(page);
    expect(state.previews).toEqual([]);
  });
  for (const changed of ['id', 'price-rule', 'inactive'])
    await scenario(browser, `successful-changed-${changed}`, async ({ page, state }) => {
      await login(page);
      await holding(page);
      await inspect(page);
      const changedMarket = listing('BTC');
      if (changed === 'id') changedMarket.id = 'different-published-BTC-USDT-id';
      else if (changed === 'price-rule') changedMarket.precision.price = '0.07';
      else changedMarket.active = false;
      state.markets = [changedMarket, listing('ETH')];
      await chart(page).press('Enter');
      await expect.poll(() => currentURL(page)).toBe(destination('BTC/USDT'));
      await expect(priceInput(page)).toHaveValue('');
      expect(state.previews).toEqual([]);
      state.markets = [listing('BTC'), listing('ETH')];
      await page.goBack();
      await activate(page);
      await arrived(page);
      expect(state.previews).toEqual([]);
    });
  await scenario(browser, 'history-failure-current-retry', async ({ page, state }) => {
    await login(page);
    await holding(page);
    await retain(page);
    state.historyStatus = 503;
    await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
    await expect(chart(page).getByText('Isolated current source unavailable', { exact: true })).toBeVisible();
    await page.evaluate(() => window.__retainedHoldingChart());
    await committedFrames(page);
    expect(await currentURL(page)).toBe(holdingPath('BTC'));
    state.historyStatus = 200;
    await chart(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await activate(page);
    await arrived(page);
    expect(state.previews).toEqual([]);
  });
  await scenario(browser, 'late-history', async ({ page, state }) => {
    await login(page);
    await holding(page);
    await retain(page);
    const delayed = pause(),
      read = state.history;
    state.pending.push(delayed);
    state.history = async (symbol, interval) => {
      if (symbol === 'BTC/USDT') await delayed.promise;
      return read(symbol, interval);
    };
    await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
    await page.evaluate(() => window.__retainedHoldingChart());
    await committedFrames(page);
    expect(await currentURL(page)).toBe(holdingPath('BTC'));
    await page.goBack();
    await holding(page, 'ETH');
    await expect(chart(page, 'ETH/USDT').locator('canvas').first()).toBeVisible();
    delayed.release();
    await committedFrames(page);
    await expect(chart(page)).toHaveCount(0);
    expect(await currentURL(page)).toBe(holdingPath('ETH'));
    state.history = read;
    await page.goBack();
    await holding(page);
    await activate(page);
    await arrived(page);
    expect(state.previews).toEqual([]);
  });
});

test('changed inspected candle or tool and observed path query hash ABA or owner token changes retire real captured controls while current controls remain useful', async ({
  browser,
}) => {
  await scenario(browser, 'same-selection-current-controls', async ({ page, state }) => {
    await login(page);
    await holding(page);
    await inspect(page);
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await chart(page).press('Escape');
    await chart(page).press('Enter');
    await arrived(page);
    await ownerProof(page);
    expect(state.previews).toEqual([]);
    await page.goBack();
    const view = chart(page);
    await expect(view.locator('canvas').first()).toBeVisible();
    await page.locator('.trade-chart-context').getByRole('button', { name: 'Fit', exact: true }).click();
    const plot = await view.locator('canvas').first().boundingBox();
    expect(plot.width).toBeGreaterThan(100);
    await page.mouse.click(plot.x + plot.width - 8, plot.y + plot.height / 2);
    await expect(page.locator('.trade-candle-inspection')).toContainText(exactPrice);
    const firstInspection = await page.locator('.trade-candle-inspection').textContent();
    expect(await currentURL(page)).toBe(holdingPath('BTC'));
    await page.mouse.click(plot.x + plot.width - 8, plot.y + plot.height / 2);
    await expect(page.locator('.trade-candle-inspection')).toHaveText(firstInspection);
    expect(await currentURL(page)).toBe(holdingPath('BTC'));
    await page.getByRole('button', { name: 'Use close in Trade', exact: true }).click();
    await arrived(page);
    await ownerProof(page);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    expect(state.previews).toEqual([]);
    state.observations.push({ sameValueEscapeCurrentEnter: true, sameCandlePointerTwiceCurrentCTA: true, selectedClose: exactPrice });
  });
  await scenario(browser, 'retained-selection-A-B', async ({ page, state }) => {
    await login(page);
    await holding(page);
    await retain(page);
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    for (let index = 0; index < 9; index++) await chart(page).press('ArrowLeft');
    const inspection = await page.locator('.trade-candle-inspection').textContent(),
      selectedClose = inspection.match(/\bC\s+([0-9]+(?:\.[0-9]+)?)/)?.[1];
    expect(selectedClose).toMatch(/^[0-9]+\.[0-9]+$/);
    expect(selectedClose).not.toBe(exactPrice);
    await page.evaluate(() => window.__retainedHoldingChart());
    await committedFrames(page);
    expect(await currentURL(page)).toBe(holdingPath('BTC'));
    await expect(page.locator('.trade-candle-inspection')).toContainText(selectedClose);
    expect(state.previews).toEqual([]);
    await chart(page).press('Enter');
    await expect.poll(() => currentURL(page)).toBe(destination('BTC/USDT'));
    await expect(priceInput(page)).toHaveValue(selectedClose);
    await ownerProof(page);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    expect(state.previews).toEqual([]);
    state.observations.push({ selectionA: exactPrice, selectionB: selectedClose, retainedARefused: true, currentNativeB: true });
  });
  await scenario(browser, 'retained-selection-tool', async ({ page, state }) => {
    await login(page);
    await holding(page);
    await retain(page);
    await page
      .locator('.trade-chart summary')
      .filter({ hasText: /^Draw$/ })
      .click();
    await page.locator('.trade-chart').getByRole('button', { name: 'level', exact: true }).click();
    await page.evaluate(() => window.__retainedHoldingChart());
    await committedFrames(page);
    expect(await currentURL(page)).toBe(holdingPath('BTC'));
    expect(state.previews).toEqual([]);
    await chart(page).press('Escape');
    await activate(page);
    await arrived(page);
    await ownerProof(page);
    expect(state.previews).toEqual([]);
  });
  await scenario(
    browser,
    'retained-lifetimes',
    async ({ page, state }) => {
      await login(page);
      await holding(page);
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      for (const kind of ['query', 'hash', 'batched-ABA', 'path']) {
        await retain(page);
        if (kind === 'path') {
          await page.locator('main a[href="/portfolio"]').click();
          await expect.poll(() => currentURL(page)).toBe('/portfolio');
          await holding(page, 'ETH');
          await expect(chart(page, 'ETH/USDT').locator('canvas').first()).toBeVisible();
          await page.goBack();
          await holding(page);
        } else if (kind === 'query' || kind === 'hash') {
          const away = `${holdingPath('BTC')}${kind === 'query' ? '?observed-departure=1' : '#observed-departure'}`;
          await page.evaluate(
            ({ away, kind }) => {
              if (kind === 'hash') location.hash = 'observed-departure';
              else {
                history.pushState(null, '', away);
                dispatchEvent(new PopStateEvent('popstate'));
              }
            },
            { away, kind },
          );
          await expect.poll(() => currentURL(page)).toBe(away);
          await page.evaluate(() => window.__retainedHoldingChart());
          await committedFrames(page);
          expect(await currentURL(page)).toBe(away);
          await page.goBack();
          await expect.poll(() => currentURL(page)).toBe(holdingPath('BTC'));
        } else
          await page.evaluate(
            ({ path, kind }) => {
              const leave = kind === 'query' ? `${path}?observed-departure=1` : `${path}#observed-departure`;
              history.pushState(null, '', leave);
              dispatchEvent(new PopStateEvent('popstate'));
              history.pushState(null, '', path);
              dispatchEvent(new PopStateEvent('popstate'));
              if (kind !== 'query')
                dispatchEvent(new HashChangeEvent('hashchange', { oldURL: location.origin + leave, newURL: location.origin + path }));
            },
            { path: holdingPath('BTC'), kind },
          );
        await page.evaluate(() => window.__retainedHoldingChart());
        await committedFrames(page);
        expect(await currentURL(page)).toBe(holdingPath('BTC'));
        await activate(page);
        await arrived(page);
        await ownerProof(page);
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
        await page.goBack();
        await expect(chart(page).locator('canvas').first()).toBeVisible();
        state.observations.push({ lifetime: kind, oldRefused: true, currentNativeHandoff: true });
      }
      for (const owner of [ownerB, ownerB]) {
        await retain(page);
        const before = state.logins.length;
        await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
        state.owner = owner;
        await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
        const guest = page.getByRole('dialog'),
          roomSignIn = page.locator(`main a[href="/login?redirect=${encodeURIComponent(holdingPath('BTC'))}"]`);
        await expect(guest).toContainText('Sign in to access account, security and verification.');
        if ((await roomSignIn.count()) === 1) {
          await guest.getByRole('button', { name: 'Close dialog', exact: true }).click();
          await roomSignIn.click();
          await submitLogin(page, holdingPath('BTC'));
        } else {
          await guest.getByRole('link', { name: 'Sign in', exact: true }).click();
          await expect.poll(() => currentURL(page)).toBe('/login');
          await submitLogin(page, '/money');
          await holding(page);
        }
        await ownerProof(page, owner);
        await page.evaluate(() => window.__retainedHoldingChart());
        await committedFrames(page);
        expect(await currentURL(page)).toBe(holdingPath('BTC'));
        await activate(page);
        await arrived(page);
        await ownerProof(page, owner);
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
        expect(state.logins).toHaveLength(before + 1);
        expect(state.logins.at(-1).token).not.toBe(state.logins.at(-2).token);
        expect(
          state.reads.some(
            (read) => read.path === '/api/v1/account/balance' && read.authorization === `Bearer ${state.logins.at(-1).token}`,
          ),
        ).toBe(true);
        await page.goBack();
      }
      expect(state.previews).toEqual([]);
    },
    390,
  );
});

test('handoff terms stay one-use private RAM; Back Forward reload other entry and held-destination departures lose intent without clearing original refs', async ({
  browser,
}) => {
  await scenario(browser, 'one-use-privacy', async ({ page, state }) => {
    const key = `trade-pending:${ownerA}`,
      raw = ` ${JSON.stringify({ kind: 'cancel', symbol: 'BTC/USDT', id: state.currentOrder.id, orderId: state.currentOrder.id, startedAt: Date.now() - 60000 })} `;
    await page.goto('/login?redirect=%2Fmoney');
    await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key, raw });
    await submitLogin(page, '/money');
    await holding(page);
    await activate(page);
    await arrived(page);
    state.observations.push({ privateStores: await noTerms(page) });
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
    await page.goBack();
    await expect(chart(page).locator('canvas').first()).toBeVisible();
    await page.goForward();
    await expect(priceInput(page)).toHaveValue('');
    await noTerms(page);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
    await page.reload();
    await expect(priceInput(page)).toHaveValue('');
    await page.getByRole('button', { name: 'Open person menu', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Sign in to access account, security and verification.');
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
    await login(page, holdingPath('BTC'));
    await expect(chart(page).locator('canvas').first()).toBeVisible();
    await page.locator('a[href="/exchange?asset=BTC&side=buy"]').click();
    await expect(priceInput(page)).toHaveValue('');
    await ownerProof(page);
    await noTerms(page);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
    expect(state.previews).toEqual([]);
  });
  await scenario(browser, 'pending-destination-lease', async ({ page, state }) => {
    await login(page);
    await holding(page);
    await inspect(page);
    const held = pause(),
      catalogue = state.catalogue;
    state.pending.push(held);
    state.catalogue = async () => {
      await held.promise;
      return catalogue();
    };
    await chart(page).press('Enter');
    await expect.poll(() => currentURL(page)).toBe(destination('BTC/USDT'));
    await page.evaluate((path) => {
      history.replaceState(null, '', `${path}?departed=1`);
      dispatchEvent(new PopStateEvent('popstate'));
      history.replaceState(null, '', path);
      dispatchEvent(new PopStateEvent('popstate'));
    }, destination('BTC/USDT'));
    held.release();
    await expect(priceInput(page)).toHaveValue('');
    state.catalogue = catalogue;
    await page.goBack();
    await activate(page);
    await arrived(page);
    expect(state.previews).toEqual([]);
  });
});

test('explicit current review keeps authoritative fee and reservation refusal; exact original recovery never turns unrelated state into settlement', async ({
  browser,
}) => {
  await scenario(browser, 'busy-preview-fresh-same-price', async ({ page, state }) => {
    await login(page, destination('BTC/USDT'));
    await ownerProof(page);
    await expect(chart(page).locator('canvas').first()).toBeVisible();
    const manualPrice = '79993.50',
      held = pause();
    state.pending.push(held);
    state.preview = async (input) => {
      await held.promise;
      return { status: 200, data: { ...preview(input), holdAmount: '199.98375' } };
    };
    await priceInput(page).fill(manualPrice);
    await page.getByLabel('Amount (BTC)', { exact: true }).fill('0.0025');
    await page.getByRole('button', { name: 'Review buy', exact: true }).click();
    await expect.poll(() => state.previews.length).toBe(1);
    expect(state.previews[0]).toMatchObject({ symbol: 'BTC/USDT', price: manualPrice, amount: '0.0025' });
    await inspect(page);
    await chart(page).press('Enter');
    await committedFrames(page);
    await expect(priceInput(page)).toHaveValue(manualPrice);
    expect(state.previews).toHaveLength(1);
    expect(state.forbiddenWrites).toEqual([]);
    held.release();
    await page.getByRole('button', { name: 'Back to edit', exact: true }).click();
    await expect(priceInput(page)).toHaveValue(manualPrice);
    await chart(page).press('Enter');
    await expect(priceInput(page)).toHaveValue(exactPrice);
    expect(state.previews).toHaveLength(1);
    expect(state.forbiddenWrites).toEqual([]);
    state.observations.push({ busyManualPrice: manualPrice, selectedClose: exactPrice, busyPreservedP: true, freshSameCloseApplied: true });
  });
  await scenario(browser, 'review-preflight', async ({ page, state }) => {
    await login(page);
    await holding(page);
    await activate(page);
    await arrived(page);
    expect(state.previews).toEqual([]);
    await page.getByLabel('Amount (BTC)', { exact: true }).fill('0.0025');
    state.preview = async (input) => ({ status: 200, data: preview(input, state.previews.length > 1) });
    await page.getByRole('button', { name: 'Review buy', exact: true }).click();
    await expect(reviewFact(page, 'Expected reservation')).toHaveText('200.08875 USDT');
    await expect(reviewFact(page, 'Estimated fee')).toHaveText('0.0000025 BTC');
    expect(state.previews).toHaveLength(1);
    expect(state.previews[0]).toMatchObject({ symbol: 'BTC/USDT', price: exactPrice, amount: '0.0025' });
    await page.getByRole('button', { name: 'Place buy', exact: true }).click();
    await expect(ticket(page)).toContainText('Fee, price protection, or reservation changed. Review the refreshed values.');
    await expect(reviewFact(page, 'Estimated fee')).toHaveText('0.00000375 BTC');
    expect(state.previews).toHaveLength(2);
    expect(state.forbiddenWrites).toEqual([]);
    expect(await page.evaluate((key) => localStorage.getItem(key), `trade-pending:${ownerA}`)).toBeNull();
  });
  await scenario(
    browser,
    'original-recovery',
    async ({ page, state }) => {
      const key = `trade-pending:${ownerA}`,
        raw = ` ${JSON.stringify({ kind: 'cancel', symbol: 'BTC/USDT', id: state.currentOrder.id, orderId: state.currentOrder.id, startedAt: Date.now() - 60000 })} `;
      await page.goto('/login?redirect=%2Fmoney');
      await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key, raw });
      await submitLogin(page, '/money');
      await holding(page);
      await activate(page);
      await arrived(page);
      const recovery = page.locator('.trade-uncertain[role="alert"]');
      await expect(recovery).toBeVisible();
      await expect(recovery).toContainText('BTC/USDT');
      await expect(recovery).toContainText(state.currentOrder.id);
      await committedFrames(page);
      await expect(ticket(page).locator('.trade-holding-origin')).not.toBeFocused();
      const recoveryArrival = await recovery.evaluate((node) => {
        const rect = node.getBoundingClientRect(),
          nav = document.querySelector('.mobile-doors').getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, navTop: nav.top, viewportHeight: innerHeight };
      });
      expect(recoveryArrival.top).toBeGreaterThanOrEqual(0);
      expect(recoveryArrival.bottom).toBeLessThanOrEqual(Math.min(recoveryArrival.viewportHeight, recoveryArrival.navTop));
      expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
      expect(state.previews).toEqual([]);
      expect(state.forbiddenWrites).toEqual([]);
      state.observations.push({ currentOriginalArrival: recoveryArrival, priceOriginFocused: false });
      await page.screenshot({ path: `${evidence}/original-recovery-arrival-320.png` });
      await page.getByLabel('Amount (BTC)', { exact: true }).fill('0.0025');
      const check = page.getByRole('button', { name: 'Check original request status', exact: true });
      for (const result of ['failed', 'wrong-id', 'wrong-market', 'still-open']) {
        state.readOrder = async () =>
          result === 'failed'
            ? { status: 503 }
            : {
                status: 200,
                data: {
                  ...state.currentOrder,
                  ...(result === 'wrong-id' ? { id: 'another-original' } : result === 'wrong-market' ? { symbol: 'ETH/USDT' } : {}),
                },
              };
        await expect(check).toBeEnabled();
        const before = state.reads.filter((read) => read.path === '/api/v1/orders/handoff-original-order').length;
        await check.click();
        await expect
          .poll(() => state.reads.filter((read) => read.path === '/api/v1/orders/handoff-original-order').length)
          .toBe(before + 1);
        await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeDisabled();
        await expect(check).toBeEnabled();
        expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
      }
      state.currentOrder = { ...state.currentOrder, status: 'canceled' };
      state.readOrder = async () => ({ status: 200, data: state.currentOrder });
      await check.click();
      await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
      await expect(page.locator('.trade-status')).toContainText('canceled');
      await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeEnabled();
      expect(state.previews).toEqual([]);
      expect(state.forbiddenWrites).toEqual([]);
    },
    320,
    844,
  );
});
