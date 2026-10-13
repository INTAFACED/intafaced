import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const baseURL = process.env.TRADE_REPRESENTATIVE_BASE_URL;
const evidence = process.env.TRADE_REPRESENTATIVE_EVIDENCE;
if (!baseURL || !evidence) throw new Error('Use the explicit verified-candidate environment from the Trade config.');
mkdirSync(evidence, { recursive: true });
const owner = '11111111-1111-4111-8111-111111111111';
const contractPin = '26863e271c325bc02c6ef9e3697aa74dc44cf37e';
const pendingKey = `trade-pending:${owner}`;
const chart = (page, symbol = 'BTC/USDT') => page.getByRole('group', { name: `Actual ${symbol} historical prices`, exact: true });
const ticket = (page) => page.getByRole('region', { name: 'Spot order ticket', exact: true });
const cents = (value) => `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
const priceInput = (page, base = 'BTC') => page.getByLabel(`Price (USDT per ${base})`, { exact: true });
const body = (route) => route.request().postDataJSON();
const displayedPrices = { '79993.50': '79,993.50', 80002.25: '80,002.25', 80015.75: '80,015.75', '80008.50': '80,008.50' };

// Isolated representative data, never a production sample mode or venue quote.
// Amounts/prices remain decimal strings; only bucket indices/timestamps are numbers.
function listing(base) {
  return {
    id: `market-${base}`,
    symbol: `${base}/USDT`,
    base,
    quote: 'USDT',
    settle: null,
    baseId: base,
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
function candles(base, timeframe = '1h', at = Date.now()) {
  const step = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 }[timeframe];
  if (!step) throw new Error(`Unsupported isolated fixture timeframe: ${timeframe}`);
  const bucket = Math.floor(at / step) * step;
  return Array.from({ length: 120 }, (_, index) => {
    const centre = (base === 'BTC' ? 8000000n : 200000n) + BigInt((index % 24) * 170 - 1700 + (index >= 60 ? 1200 : 0));
    // Four internal missing buckets remain absent: no invented flat fill candles.
    const slot = index + Math.floor(index / 25);
    return [
      bucket - (126 - slot) * step,
      cents(centre + BigInt(index % 2 ? 75 : -90)),
      cents(centre + 260n),
      cents(centre - 250n),
      cents(centre + BigInt(index % 3 ? 140 : -130)),
      `0.${(10000 + (index % 17) * 903).toString().padStart(5, '0')}`,
    ];
  });
}
function levels(base, side) {
  return Array.from({ length: 24 }, (_, index) => [
    cents((base === 'BTC' ? 8000000n : 200000n) + BigInt((side === 'bids' ? -1 : 1) * (index + 1) * 3)),
    `0.${(210 + (index % 7) * 91).toString().padStart(5, '0')}`,
  ]);
}
function ownedOrders(at) {
  return ['79993.50', '80002.25', '80015.75', '80008.50'].map((price, index) => ({
    id: `representative-order-${index}`,
    clientOrderId: `representative-client-${index}`,
    timestamp: at - index * 60000,
    datetime: new Date(at - index * 60000).toISOString(),
    lastTradeTimestamp: index === 3 ? at - 1000 : null,
    symbol: 'BTC/USDT',
    type: 'limit',
    side: index % 2 ? 'sell' : 'buy',
    timeInForce: 'GTC',
    postOnly: false,
    reduceOnly: false,
    price,
    stopPrice: null,
    average: index === 3 ? price : null,
    amount: '0.0025',
    filled: index === 3 ? '0.001' : '0',
    remaining: index === 3 ? '0.0015' : '0.0025',
    cost: index === 3 ? '80.0085' : '0',
    status: 'open',
    recoveryRequired: false,
    recoveryReason: null,
    reconciliationKey: null,
    fee: null,
    trades: [],
  }));
}
function preview(draft) {
  // Literal worked example: 80000 USDT/BTC * .0025 BTC = 200 USDT reserved;
  // owner-schedule10bps buy fee = .0000025 BTC. These are isolated service replies.
  return {
    symbol: draft.symbol,
    side: draft.side,
    type: draft.type,
    amount: draft.amount,
    price: draft.price ?? null,
    timeInForce: draft.postOnly ? 'PO' : draft.timeInForce,
    holdAsset: 'USDT',
    holdAmount: '200',
    protectionPrice: null,
    estimatedFee: '0.0000025',
    feeAsset: 'BTC',
    feeBps: 10,
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
    sockets: [],
    orders: ownedOrders(at),
    sequence: 12,
    stream: true,
    representative: { hourlyCandles: candles('BTC', '1h', at), depth: { bids: levels('BTC', 'bids'), asks: levels('BTC', 'asks') } },
  };
  state.history = async (base, timeframe) => ({ status: 200, data: candles(base, timeframe, at) });
  state.book = async (base) => ({
    status: 200,
    data: {
      symbol: `${base}/USDT`,
      bids: levels(base, 'bids'),
      asks: levels(base, 'asks'),
      timestamp: Date.now(),
      datetime: new Date().toISOString(),
      nonce: state.sequence,
    },
  });
  state.order = async (id) => ({ status: 200, data: state.orders.find((row) => row.id === id) });
  state.preview = async (draft) => ({ status: 200, data: preview(draft) });
  context.on('page', (page) => page.on('pageerror', (error) => state.errors.push(error.message)));
  await context.routeWebSocket('**/ws/**', (socket) => {
    const marketId = new URL(socket.url()).searchParams.get('market');
    state.sockets.push({ socket, marketId });
    if (state.stream)
      socket.send(
        JSON.stringify({
          type: 'snapshot',
          marketId,
          sequence: state.sequence,
          bids: levels(marketId === 'market-ETH' ? 'ETH' : 'BTC', 'bids'),
          asks: levels(marketId === 'market-ETH' ? 'ETH' : 'BTC', 'asks'),
        }),
      );
  });
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const procedure = decodeURIComponent(path.split('/').at(-1));
    if (procedure === 'auth.login')
      return route.fulfill({
        json: {
          result: {
            data: {
              userId: owner,
              accessToken: 'isolated-representative-trade-token',
              refreshToken: 'isolated-representative-trade-refresh',
              expiresAt: '2027-10-10T08:00:00Z',
            },
          },
        },
      });
    if (request.method() !== 'GET') {
      if (path === '/api/v1/orders/preview' && request.method() === 'POST') {
        const draft = body(route);
        state.previews.push(draft);
        const answer = await state.preview(draft);
        return route.fulfill({
          status: answer.status,
          json: answer.status === 200 ? answer.data : { error: 'trade.preview_unavailable', message: 'Isolated preview unavailable' },
        });
      }
      state.forbiddenWrites.push({ path, method: request.method(), body: request.postData() });
      return route.fulfill({
        status: 503,
        json: { error: 'fixture.financial_dispatch_forbidden', message: 'No financial dispatch is authorized by this native fixture' },
      });
    }
    state.reads.push({ path, query: Object.fromEntries(url.searchParams) });
    let answer;
    const symbol = decodeURIComponent(path.split('/').at(-1)),
      base = symbol.split('/')[0];
    if (path === '/api/v1/markets') answer = { status: 200, data: [listing('BTC'), listing('ETH')] };
    else if (path.startsWith('/api/v1/ohlcv/')) answer = await state.history(base, url.searchParams.get('timeframe'));
    else if (path.startsWith('/api/v1/orderbook/')) answer = await state.book(base);
    else if (path.startsWith('/api/v1/ticker/'))
      answer = {
        status: 200,
        data: {
          symbol,
          timestamp: at,
          datetime: new Date(at).toISOString(),
          high: null,
          low: null,
          bid: base === 'BTC' ? '79999.97' : '1999.97',
          bidVolume: '0.00210',
          ask: base === 'BTC' ? '80000.03' : '2000.03',
          askVolume: '0.00210',
          vwap: null,
          open: null,
          close: base === 'BTC' ? '80035.50' : '2035.50',
          last: base === 'BTC' ? '80035.50' : '2035.50',
          previousClose: null,
          change: null,
          percentage: null,
          average: null,
          baseVolume: null,
          quoteVolume: null,
        },
      };
    else if (path.startsWith('/api/v1/trades/')) answer = { status: 200, data: [] };
    else if (path === '/api/v1/account/balance')
      answer = {
        status: 200,
        data: {
          timestamp: at,
          datetime: new Date(at).toISOString(),
          balances: {
            USDT: { free: '7500', used: '800.8', total: '8300.8' },
            BTC: { free: '0.05', used: '0.005', total: '0.055' },
            ETH: { free: '2', used: '0', total: '2' },
          },
        },
      };
    else if (path === '/api/v1/orders/open')
      answer = {
        status: 200,
        data: state.orders.filter(
          (row) => row.status === 'open' && (!url.searchParams.get('symbol') || row.symbol === url.searchParams.get('symbol')),
        ),
      };
    else if (['/api/v1/orders/closed', '/api/v1/account/trades', '/api/v1/positions'].includes(path)) answer = { status: 200, data: [] };
    else if (path.startsWith('/api/v1/orders/')) answer = await state.order(procedure);
    else answer = { status: 503 };
    try {
      await route.fulfill({
        status: answer.status,
        json: answer.status === 200 ? answer.data : { error: 'fixture.read_unavailable', message: 'Isolated current read unavailable' },
      });
    } catch (error) {
      state.cancelled.push(error.message);
    }
  });
  return state;
}
async function scenario(browser, name, run, width = 1440) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 1000 }, timezoneId: 'UTC' });
  const state = await fixtures(context),
    page = await context.newPage();
  try {
    await run({ context, page, state });
    expect(state.forbiddenWrites).toEqual([]);
    expect(state.errors).toEqual([]);
  } finally {
    writeFileSync(
      `${evidence}/${name}.json`,
      JSON.stringify(
        {
          fixtureContractPin: contractPin,
          qualification: 'Isolated mounted-shaped replies in ordinary compiled App; no live authority/value or production sample mode.',
          ...state,
        },
        (key, value) => (typeof value === 'function' || key === 'sockets' ? undefined : value),
        2,
      ),
    );
    await context.close();
  }
}
async function login(page) {
  await page.goto('/login?redirect=%2Fexchange');
  await page.locator('input[autocomplete="username"]').fill('isolated-representative-trade-owner');
  await page.locator('input[autocomplete="current-password"]').fill('isolated-representative-password');
  await page.locator('form button[type="submit"]').click();
  await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/exchange');
  await expect(chart(page).locator('canvas').first()).toBeVisible();
  await expect(page.locator('.trade-book-row.positive')).toHaveCount(12);
}
async function studies(page) {
  await page.getByLabel('Chart interval', { exact: true }).selectOption('1h');
  const toolbar = page.locator('.trade-chart-toolbar').first();
  await toolbar.locator('summary').filter({ hasText: 'Indicators' }).click();
  for (const label of ['MA', 'Volume', 'RSI']) await toolbar.getByLabel(label, { exact: true }).check();
  await toolbar.locator('summary').filter({ hasText: 'Indicators' }).click();
  await expect
    .poll(() =>
      chart(page).evaluate(
        (element) =>
          new Set(
            [...element.querySelectorAll('canvas')]
              .filter((canvas) => {
                const box = canvas.getBoundingClientRect();
                return box.width > 150 && box.height > 28;
              })
              .map((canvas) => canvas.getBoundingClientRect().top),
          ).size,
      ),
    )
    .toBe(3);
  await page.evaluate(() => document.fonts.ready);
}
async function plotBounds(page) {
  return chart(page).evaluate((node) => {
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width, height: box.height, bottom: box.bottom };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      engine: rect(node.querySelector('.trade-engine')),
      canvases: [...node.querySelectorAll('canvas')].map(rect),
      panes: [
        ...new Map(
          [...node.querySelectorAll('canvas')]
            .map(rect)
            .filter((box) => box.width > 150 && box.height > 28)
            .map((box) => [box.top, box]),
        ).values(),
      ],
      handles: [...node.querySelectorAll('button[aria-label^="Change price for order "]')].map((element) => ({
        label: element.getAttribute('aria-label'),
        text: element.textContent,
        ...rect(element),
      })),
      inspectionMarkers: [...node.querySelectorAll('.trade-chart-canvas .trade-order-handle[aria-label^="Open orders"]')].map(
        (element) => ({
          label: element.getAttribute('aria-label'),
          text: element.textContent,
          ...rect(element),
        }),
      ),
      pageWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
}

test('representative phone analysis keeps readable price and study space with working-order controls', async ({ browser }) => {
  for (const width of [320, 390, 768, 1440])
    await scenario(
      browser,
      `readable-analysis-${width}`,
      async ({ page, state }) => {
        await login(page);
        await studies(page);
        await expect(page.locator('.trade-blotter table tbody tr')).toHaveCount(4);
        // Partial fills keep their annotation/management, but cannot gain a price-change handle.
        await expect(page.getByRole('button', { name: 'Change price for order representative-order-3', exact: true })).toHaveCount(0);
        for (const id of [0, 1, 2])
          await expect(page.getByRole('button', { name: `Change price for order representative-order-${id}`, exact: true })).toBeVisible();
        await chart(page).focus();
        await chart(page).press('ArrowLeft');
        await expect(page.locator('.trade-candle-inspection')).toContainText('80035.50');
        await chart(page).press('Enter');
        await expect(priceInput(page)).toHaveValue('80035.50');
        await page.locator('.trade-chart').first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${evidence}/analysis-${width}-viewport.png` });
        await page.screenshot({ path: `${evidence}/analysis-${width}-whole.png`, fullPage: true });
        await page
          .locator('.trade-chart')
          .first()
          .screenshot({ path: `${evidence}/analysis-${width}-section.png` });
        const bounds = await plotBounds(page);
        state.bounds = bounds;
        expect(bounds.pageWidth).toBeLessThanOrEqual(bounds.clientWidth);
        if (width <= 768) {
          // Provisional Paper dimensions; root approves the final readability criterion before green credit.
          expect(bounds.engine.height, 'Price/studies need useful phone analysis space, not a190px stacked engine').toBeGreaterThanOrEqual(
            420,
          );
          expect(
            bounds.canvases[0].height,
            'Price pane must remain readable with120 candles, three studies and four order annotations',
          ).toBeGreaterThanOrEqual(260);
          expect(bounds.panes).toHaveLength(3);
          for (const pane of bounds.panes.slice(1)) expect(pane.height).toBeGreaterThanOrEqual(64);
        } else {
          expect(bounds.engine.height).toBeGreaterThanOrEqual(360);
          expect(bounds.engine.width).toBeGreaterThan(400);
        }
        if (width === 320) {
          const toolbar = page.locator('.trade-chart-toolbar').first();
          await toolbar.locator('summary').filter({ hasText: 'Indicators' }).click();
          await toolbar.getByLabel('MACD', { exact: true }).check();
          await expect.poll(async () => (await plotBounds(page)).panes.length).toBe(4);
          const expanded = await plotBounds(page);
          expect(expanded.panes[0].height).toBeGreaterThanOrEqual(260);
          for (const pane of expanded.panes.slice(1)) expect(pane.height).toBeGreaterThanOrEqual(64);
          for (const label of ['MA', 'Volume', 'RSI']) await toolbar.getByLabel(label, { exact: true }).uncheck();
          await expect.poll(async () => (await plotBounds(page)).panes.length).toBe(2);
          const onlyMacd = await plotBounds(page);
          expect(onlyMacd.panes[0].height).toBeGreaterThanOrEqual(260);
          expect(onlyMacd.panes[1].height).toBeGreaterThanOrEqual(64);
          state.studyBounds = { expanded, onlyMacd };
          await toolbar.locator('summary').filter({ hasText: 'Indicators' }).click();
        }
        expect(state.previews).toEqual([]);
      },
      width,
    );
  for (const width of [320, 390])
    await scenario(
      browser,
      `clustered-analysis-${width}`,
      async ({ page, state }) => {
        // Five eligible originals exceed the320px plot's four direct slots.
        // The sixth exact-price original is partial; near and off-scale orders
        // remain individually available without shifting their true price Y.
        const prices = ['80002.25', '80002.25', '80002.25', '80002.25', '80002.25', '80002.26', '79900', '80002.25'];
        const template = state.orders[0];
        state.orders = prices.map((price, index) => ({
          ...template,
          id: `owner-specific-order-${index}-opaque-reference-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789`,
          clientOrderId: `representative-cluster-client-${index}`,
          price,
          filled: index === 7 ? '0.001' : '0',
          remaining: index === 7 ? '0.0015' : '0.0025',
          cost: index === 7 ? '80.00225' : '0',
          average: index === 7 ? price : null,
        }));
        await login(page);
        await studies(page);
        const rows = page.locator('.trade-blotter table tbody tr');
        await expect(rows).toHaveCount(8);
        const groupMarker = page.getByRole('button', { name: 'Open orders · 6 · 80002.25 USDT', exact: true });
        if (width === 320) await expect(groupMarker).toBeVisible();
        await expect(page.getByRole('button', { name: `Change price for order ${state.orders[6].id}`, exact: true })).toHaveCount(0);
        const bounds = await plotBounds(page),
          plot = bounds.canvases[0];
        const plotTargets = [...bounds.handles, ...bounds.inspectionMarkers];
        if (width === 320) expect(bounds.inspectionMarkers).toHaveLength(1);
        expect(bounds.pageWidth).toBeLessThanOrEqual(bounds.clientWidth);
        // Overflow may use bounded inspection markers plus individual management;
        // seven44px chart targets are not forced into a248px plot.
        for (const handle of plotTargets) {
          expect(handle.width).toBeGreaterThanOrEqual(44);
          expect(handle.height).toBeGreaterThanOrEqual(44);
          expect(handle.left).toBeGreaterThanOrEqual(plot.left);
          expect(handle.left + handle.width).toBeLessThanOrEqual(plot.left + plot.width);
          expect(handle.top).toBeGreaterThanOrEqual(plot.top);
          expect(handle.bottom).toBeLessThanOrEqual(plot.bottom);
        }
        for (let a = 0; a < plotTargets.length; a++)
          for (let b = a + 1; b < plotTargets.length; b++) {
            const first = plotTargets[a],
              second = plotTargets[b];
            const overlap =
              first.left < second.left + second.width &&
              second.left < first.left + first.width &&
              first.top < second.bottom &&
              second.top < first.bottom;
            expect(overlap, 'Distinct current order actions must not cover one another').toBe(false);
          }
        state.clusterBounds = bounds;
        await page
          .locator('.trade-chart')
          .first()
          .screenshot({ path: `${evidence}/cluster-${width}-section.png` });
        const management = page.getByRole('region', { name: 'Order management', exact: true });
        if (width === 320) {
          await groupMarker.click();
          await expect(management).toBeFocused();
          await expect(rows).toHaveCount(8);
          await expect(page.getByRole('dialog')).toHaveCount(0);
        }
        await page.locator('.trade-order-inspection').getByRole('button', { name: 'Open orders · 8 ↘', exact: true }).click();
        await expect(management).toBeFocused();
        await expect(rows).toHaveCount(8);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        state.clusterPolicy = {
          samePrice: '80002.25',
          eligibleSamePrice: 5,
          partialSamePrice: 1,
          nearPrice: '80002.26',
          offScalePrice: '79900',
        };
        for (const order of state.orders.slice(0, 7)) {
          const row = rows.filter({ hasText: order.id });
          const action = row.getByRole('button', { name: 'Change price', exact: true });
          await expect(action).toBeEnabled();
          if (order.id === state.orders[6].id) {
            await action.focus();
            await page.keyboard.press('Enter');
          } else await action.click();
          const review = page.getByRole('dialog', { name: 'Change price with cancel/replace', exact: true });
          await expect(review).toContainText(order.id);
          await expect(review.getByLabel('Replacement limit price (USDT per BTC)', { exact: true })).toHaveValue(order.price);
          await review.getByRole('button', { name: 'Keep order', exact: true }).click();
          await expect(review).toHaveCount(0);
          await expect(action).toBeFocused();
        }
        await expect(
          rows.filter({ hasText: state.orders[7].id }).getByRole('button', { name: 'Change price', exact: true }),
        ).toBeDisabled();
        expect(state.previews).toEqual([]);
        expect(await page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBeNull();
      },
      width,
    );
  await scenario(
    browser,
    'retained-chart-observed-route-lifetime',
    async ({ page, state }) => {
      await login(page);
      await studies(page);
      const action = page.getByRole('button', { name: 'Change price for order representative-order-0', exact: true });
      const review = page.getByRole('dialog', { name: 'Change price with cancel/replace', exact: true });
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      const openCurrent = async () => {
        await expect(action).toBeVisible();
        await action.focus();
        await page.keyboard.press('Enter');
        await expect(review).toContainText('representative-order-0');
        await expect(review.getByLabel('Replacement limit price (USDT per BTC)', { exact: true })).toHaveValue('79993.50');
        await review.getByRole('button', { name: 'Keep order', exact: true }).click();
        await expect(review).toHaveCount(0);
      };
      await openCurrent();
      state.retainedRouteCases = [];
      for (const kind of ['query', 'hash']) {
        // Qualified internal callback evidence from the independently confirmed
        // peer counterexample. Positive controls use actual keyboard dispatch.
        await action.evaluate((element) => {
          const key = Object.keys(element).find((candidate) => candidate.startsWith('__reactProps$'));
          const handler = key && element[key].onClick;
          if (typeof handler !== 'function') throw new Error('Actual current chart click callback unavailable');
          window.__nativeTradeRetainedClick = handler;
        });
        if (kind === 'query') {
          await page.evaluate(() => {
            history.pushState(null, '', '/exchange?native-observed-departure=1');
            window.dispatchEvent(new PopStateEvent('popstate'));
          });
          await expect.poll(() => page.evaluate(() => location.search)).toBe('?native-observed-departure=1');
          await page.evaluate(() => {
            history.pushState(null, '', '/exchange');
            window.dispatchEvent(new PopStateEvent('popstate'));
            window.__nativeTradeRetainedClick({ detail: 0 });
          });
        } else {
          await page.evaluate(() => {
            history.pushState(null, '', '/exchange#native-observed-departure');
            window.dispatchEvent(new HashChangeEvent('hashchange'));
            history.pushState(null, '', '/exchange');
            window.dispatchEvent(new HashChangeEvent('hashchange'));
            window.__nativeTradeRetainedClick({ detail: 0 });
          });
        }
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(review).toHaveCount(0);
        expect(await page.evaluate(() => location.pathname + location.search + location.hash)).toBe('/exchange');
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
        await openCurrent();
        state.retainedRouteCases.push({ kind, staleReviewRefusedAfterCommittedFrames: true, currentKeyboardReviewExact: true });
      }
      expect(state.previews).toEqual([]);
      expect(await page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBeNull();
    },
    320,
  );
});

function held() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function chooseMarket(page, base) {
  await page.getByRole('button', { name: 'Choose trading market', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose market', exact: true });
  await picker.getByLabel('Search markets', { exact: true }).fill(base);
  await picker
    .getByRole('button')
    .filter({ has: page.getByText(`${base}/USDT`, { exact: true }) })
    .click();
  await expect(chart(page, `${base}/USDT`).locator('canvas').first()).toBeVisible();
  await expect(priceInput(page, base)).toBeVisible();
}
function stream(state, marketId, message) {
  const sockets = state.sockets.filter((entry) => entry.marketId === marketId);
  expect(sockets.length).toBeGreaterThan(0);
  sockets.at(-1).socket.send(JSON.stringify({ marketId, ...message }));
}
async function draft(page) {
  await priceInput(page).fill('80000');
  await page.getByLabel('Amount (BTC)', { exact: true }).fill('0.0025');
  await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeEnabled();
}
async function reservationRows(page, fee) {
  const panel = ticket(page);
  await expect(
    panel
      .locator('dl > div')
      .filter({ has: page.getByText('Estimated fee', { exact: true }) })
      .locator('dd'),
  ).toHaveText(`${fee} BTC`);
  await expect(
    panel
      .locator('dl > div')
      .filter({ has: page.getByText('Expected reservation', { exact: true }) })
      .locator('dd'),
  ).toHaveText('200 USDT');
}

test('market selection retires delayed history and native depth gaps or stale snapshots refuse new review', async ({ browser }) => {
  await scenario(browser, 'market-and-depth-lifetime', async ({ page, state }) => {
    await login(page);
    await page.getByLabel('Chart interval', { exact: true }).selectOption('1h');
    await chart(page).focus();
    await chart(page).press('ArrowLeft');
    await expect(page.locator('.trade-candle-inspection')).toContainText('80035.50');
    const history = held(),
      originalHistory = state.history;
    state.history = async (base, timeframe) => {
      if (base === 'BTC') await history.promise;
      return originalHistory(base, timeframe);
    };
    const before = state.reads.filter(({ path }) => path.includes('/ohlcv/')).length;
    await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
    await expect.poll(() => state.reads.filter(({ path }) => path.includes('/ohlcv/')).length).toBe(before + 1);
    await chooseMarket(page, 'ETH');
    const current = chart(page, 'ETH/USDT');
    await current.focus();
    await current.press('ArrowLeft');
    await expect(page.locator('.trade-candle-inspection')).toContainText('2035.50');
    await current.press('Enter');
    await expect(priceInput(page, 'ETH')).toHaveValue('2035.50');
    history.release();
    await expect(chart(page)).toHaveCount(0);
    await expect(priceInput(page, 'ETH')).toHaveValue('2035.50');
    await page.getByRole('button', { name: 'Depth', exact: true }).click();
    await expect(page.getByRole('img', { name: 'Actual cumulative ETH/USDT depth', exact: true })).toBeVisible();
    await page.locator('.trade-depth-ladder button').first().click();
    await expect(priceInput(page, 'ETH')).toHaveValue('1999.97');
    const book = held(),
      originalBook = state.book;
    state.sequence = 13;
    state.book = async (base) => {
      await book.promise;
      return originalBook(base);
    };
    const beforeBook = state.reads.filter(({ path }) => path.includes('/orderbook/')).length;
    stream(state, 'market-ETH', { type: 'delta', fromSequence: 999, sequence: 1000, bids: [], asks: [] });
    await expect.poll(() => state.reads.filter(({ path }) => path.includes('/orderbook/')).length).toBe(beforeBook + 1);
    await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeDisabled();
    book.release();
    await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeEnabled();
    state.book = async (base) => {
      const result = await originalBook(base);
      return { ...result, data: { ...result.data, timestamp: Date.now() - 20000 } };
    };
    stream(state, 'market-ETH', { type: 'delta', fromSequence: 999, sequence: 1001, bids: [], asks: [] });
    await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeDisabled();
    await expect(page.locator('.trade-book')).toContainText('too old to authorize a new order');
    state.book = originalBook;
    state.sequence = 14;
    stream(state, 'market-ETH', { type: 'snapshot', sequence: 14, bids: levels('ETH', 'bids'), asks: levels('ETH', 'asks') });
    await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeEnabled();
    expect(state.previews).toEqual([]);
  });
});

test('review uses authoritative exact fee and reservation and changed values refuse placement without replay', async ({ browser }) => {
  await scenario(browser, 'authoritative-review', async ({ page, state }) => {
    await login(page);
    await draft(page);
    state.preview = async (input) => ({
      status: 200,
      data: state.previews.length === 1 ? preview(input) : { ...preview(input), estimatedFee: '0.00000375', feeBps: 15 },
    });
    await page.getByRole('button', { name: 'Review buy', exact: true }).click();
    await reservationRows(page, '0.0000025');
    expect(state.previews).toHaveLength(1);
    expect(state.previews[0]).toMatchObject({
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '0.0025',
      price: '80000',
      timeInForce: 'GTC',
    });
    await page.getByRole('button', { name: 'Place buy', exact: true }).click();
    await reservationRows(page, '0.00000375');
    await expect(ticket(page)).toContainText('Fee, price protection, or reservation changed. Review the refreshed values.');
    expect(state.previews).toHaveLength(2);
    expect(state.forbiddenWrites).toEqual([]);
    expect(await page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBeNull();
    await page.getByRole('button', { name: 'Back to edit', exact: true }).click();
    await expect(priceInput(page)).toHaveValue('80000');
    await page.getByRole('button', { name: 'Review buy', exact: true }).click();
    await reservationRows(page, '0.00000375');
    await expect(page.getByRole('button', { name: 'Place buy', exact: true })).toBeEnabled();
    expect(state.previews).toHaveLength(3);
    expect(
      await page.evaluate(() => Object.values(localStorage).some((raw) => raw.includes('estimatedFee') || raw.includes('holdAmount'))),
    ).toBe(false);
  });
});

test('four working orders retain exact partial-fill review and native Keep preserves current analysis', async ({ browser }) => {
  for (const width of [320, 1440])
    await scenario(
      browser,
      `working-management-${width}`,
      async ({ page, state }) => {
        await login(page);
        await studies(page);
        const rows = page.locator('.trade-blotter table tbody tr');
        await expect(rows).toHaveCount(4);
        for (const order of state.orders) {
          const row = rows.filter({ hasText: order.id });
          await expect(row).toHaveCount(1);
          await expect(row).toContainText(displayedPrices[order.price]);
          await row.getByRole('button', { name: 'Cancel', exact: true }).click();
          const review = page.getByRole('dialog', { name: 'Cancel working order', exact: true });
          await expect(review).toContainText(order.id);
          await expect(
            review
              .locator('dl > div')
              .filter({ has: page.getByText('Filled', { exact: true }) })
              .locator('dd'),
          ).toHaveText(`${order.filled} BTC`);
          await expect(
            review
              .locator('dl > div')
              .filter({ has: page.getByText('Remaining', { exact: true }) })
              .locator('dd'),
          ).toHaveText(`${order.remaining} BTC`);
          await expect(
            review
              .locator('dl > div')
              .filter({ has: page.getByText('Limit price', { exact: true }) })
              .locator('dd'),
          ).toHaveText(`${displayedPrices[order.price]} USDT`);
          await page.screenshot({ path: `${evidence}/working-${width}-${order.id}.png` });
          if (width === 1440 && order.id === 'representative-order-3') await page.keyboard.press('Escape');
          else await review.getByRole('button', { name: 'Keep order', exact: true }).click();
          await expect(review).toHaveCount(0);
          await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        }
        await chart(page).focus();
        await chart(page).press('ArrowLeft');
        await chart(page).press('Enter');
        await expect(priceInput(page)).toHaveValue('80035.50');
        expect(state.previews).toEqual([]);
        expect(await page.evaluate((key) => localStorage.getItem(key), pendingKey)).toBeNull();
      },
      width,
    );
});

test('unknown original has a reachable exact read through failures and closure while nonterminal replies cannot unlock entry', async ({
  browser,
}) => {
  await scenario(
    browser,
    'original-read-recovery',
    async ({ context, page, state }) => {
      const original = JSON.stringify({
        kind: 'cancel',
        symbol: 'BTC/USDT',
        id: state.orders[0].id,
        orderId: state.orders[0].id,
        startedAt: Date.now() - 60000,
      });
      // Seed once; new documents/tabs must restore actual surviving browser bytes, never a reseeding script.
      await page.goto('/login?redirect=%2Fexchange');
      await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: pendingKey, raw: original });
      await login(page);
      const check = (current) => current.getByRole('button', { name: 'Check original request status', exact: true });
      const retained = async (current) => {
        expect(await current.evaluate((key) => localStorage.getItem(key), pendingKey)).toBe(original);
        await expect(current.getByRole('button', { name: 'Review buy', exact: true })).toBeDisabled();
        await expect(check(current)).toBeEnabled();
      };
      await retained(page);
      for (const outcome of ['failed', 'wrong-id', 'wrong-market', 'still-open']) {
        state.order = async () =>
          outcome === 'failed'
            ? { status: 503 }
            : {
                status: 200,
                data: {
                  ...state.orders[0],
                  ...(outcome === 'wrong-id' ? { id: 'other-original-order' } : outcome === 'wrong-market' ? { symbol: 'ETH/USDT' } : {}),
                },
              };
        const before = state.reads.filter(({ path }) => path === '/api/v1/orders/representative-order-0').length;
        await check(page).click();
        await expect.poll(() => state.reads.filter(({ path }) => path === '/api/v1/orders/representative-order-0').length).toBe(before + 1);
        await retained(page);
        await expect(page.locator('.trade-status')).toBeVisible();
        if (outcome === 'still-open') await expect(page.locator('.trade-status')).toContainText('outcome is unresolved');
      }
      await page.screenshot({ path: `${evidence}/original-320-viewport.png` });
      await page.locator('.trade-uncertain').screenshot({ path: `${evidence}/original-320-section.png` });
      state.originalArrival = await check(page).evaluate((element) => {
        const bounds = element.getBoundingClientRect(),
          nav = document.querySelector('.mobile-doors').getBoundingClientRect();
        return {
          focused: document.activeElement === element,
          activeText: document.activeElement?.textContent,
          top: bounds.top,
          bottom: bounds.bottom,
          height: bounds.height,
          navTop: nav.top,
        };
      });
      await page.close();
      const current = await context.newPage();
      await login(current);
      await retained(current);
      state.orders[0] = { ...state.orders[0], status: 'canceled' };
      state.order = async (id) => ({ status: 200, data: state.orders.find((order) => order.id === id) });
      await check(current).click();
      await expect.poll(() => current.evaluate((key) => localStorage.getItem(key), pendingKey)).toBeNull();
      await expect(current.locator('.trade-status')).toContainText('canceled');
      await expect(current.getByRole('button', { name: 'Review buy', exact: true })).toBeEnabled();
      expect(state.previews).toEqual([]);
      expect(state.forbiddenWrites).toEqual([]);
    },
    320,
  );
});
