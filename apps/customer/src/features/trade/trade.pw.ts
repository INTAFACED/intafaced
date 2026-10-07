import { test, expect, type Page } from '@playwright/test';

// Financial examples are test-only network responses, never application fallback data.
const time = Date.now(),
  datetime = new Date(time).toISOString();
function market(base: string) {
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
function order(filled = '0', status = 'open') {
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
    filled,
    remaining: filled === '0' ? '0.025' : '0.020',
    cost: '0',
    status,
    recoveryRequired: false,
    recoveryReason: null,
    reconciliationKey: null,
    fee: null,
    trades: [],
  };
}
async function mount(page: Page, options: { working?: boolean; uncertain?: boolean; race?: boolean } = {}) {
  let previews = 0,
    deletes = 0;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    let response: unknown = [];
    if (path === '/api/v1/markets') response = [market('BTC'), market('ETH')];
    else if (path.startsWith('/api/v1/orderbook/')) {
      const symbol = decodeURIComponent(path.split('/').at(-1) ?? '');
      response = { symbol, bids: [['80000', '1']], asks: [['80001', '1']], timestamp: time, datetime, nonce: 1 };
    } else if (path.startsWith('/api/v1/ticker/')) {
      const symbol = decodeURIComponent(path.split('/').at(-1) ?? '');
      response = {
        symbol,
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
    } else if (path.startsWith('/api/v1/ohlcv/')) response = [[time - 60000, '80000', '80020', '79990', '80001', '1']];
    else if (path === '/api/v1/account/balance')
      response = {
        timestamp: time,
        datetime,
        balances: {
          USDT: { free: '7500', used: '500', total: '8000' },
          BTC: { free: '0.05', used: '0', total: '0.05' },
          ETH: { free: '2', used: '0', total: '2' },
        },
      };
    else if (path === '/api/v1/orders/open') response = options.working ? [order()] : [];
    else if (path === '/api/v1/orders/preview') {
      previews++;
      const draft = route.request().postDataJSON();
      response = {
        ...draft,
        price: draft.price ?? null,
        holdAsset: 'USDT',
        holdAmount: previews > 1 && !options.uncertain ? '2001' : '2000',
        protectionPrice: null,
        estimatedFee: '0.000025',
        feeAsset: 'BTC',
        feeBps: 10,
        feeRole: 'taker',
        orderable: true,
        refusals: [],
      };
    } else if (path === '/api/v1/orders' && route.request().method() === 'POST') {
      if (options.uncertain) {
        await route.fulfill({ status: 503, json: { message: 'Matching outcome unknown', code: 'trade.engine_unreachable' } });
        return;
      }
      response = { ...order(), clientOrderId: route.request().postDataJSON().clientOrderId };
    } else if (path === '/api/v1/orders/order-1') {
      if (route.request().method() === 'DELETE') deletes++;
      response = options.race ? order('0.005') : order();
    }
    await route.fulfill({ json: response });
  });
  await page.routeWebSocket('**/ws/**', (socket) => {
    const id = new URL(socket.url()).searchParams.get('market');
    socket.send(JSON.stringify({ type: 'snapshot', marketId: id, sequence: 1, bids: [['80000', '1']], asks: [['80001', '1']] }));
  });
  return { deletes: () => deletes };
}

test('market context resets the ticket and retains explicit base units', async ({ page }) => {
  await mount(page);
  await page.goto('/exchange?asset=BTC&side=sell');
  await expect(page.getByRole('button', { name: 'Review sell', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: /^Amount \(BTC\)/ }).fill('0.025');
  await page.getByRole('button', { name: 'All markets', exact: true }).click();
  await page.getByRole('button', { name: 'ETH/USDT Published for trading', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Amount \(ETH\)/ })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: /^Amount \(BTC\)/ })).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Actual ETH/USDT historical prices' })).toBeVisible();
});
test('changed reservation requires a second review and creates no order', async ({ page }) => {
  await mount(page);
  let placements = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/orders' && request.method() === 'POST') placements++;
  });
  await page.goto('/exchange');
  await page.getByLabel('Price (USDT per BTC)', { exact: true }).fill('80000');
  await page.getByRole('textbox', { name: /^Amount \(BTC\)/ }).fill('0.025');
  await page.getByRole('button', { name: 'Review buy', exact: true }).click();
  await page.getByRole('button', { name: 'Place buy', exact: true }).click();
  await expect(page.getByText('Fee, price protection, or reservation changed. Review the refreshed values.')).toBeVisible();
  expect(placements).toBe(0);
});
test('uncertain placement remains locked across reload and cannot duplicate a request', async ({ page }) => {
  await mount(page, { uncertain: true });
  await page.goto('/exchange');
  await page.getByLabel('Price (USDT per BTC)', { exact: true }).fill('80000');
  await page.getByRole('textbox', { name: /^Amount \(BTC\)/ }).fill('0.025');
  await page.getByRole('button', { name: 'Review buy', exact: true }).click();
  await page.getByRole('button', { name: 'Place buy', exact: true }).click();
  await expect(page.getByText('Outcome not confirmed · place')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Check original request status' }).click();
  await expect(page.getByText('The request was not found in the returned order pages.', { exact: false })).toBeVisible();
});
test('a fill during cancellation refreshes the remainder before any cancel is sent', async ({ page }) => {
  const transport = await mount(page, { working: true, race: true });
  await page.goto('/exchange');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(
    page.getByText('This order filled while you were reviewing. Review its refreshed remainder before continuing.'),
  ).toBeVisible();
  expect(transport.deletes()).toBe(0);
});
test('phone retains chart, ticket, and book without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  await page.goto('/exchange');
  await expect(page.getByRole('img', { name: 'Actual BTC/USDT historical prices' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Actual BTC/USDT historical prices' }).locator('canvas').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/intafaced-trade-phone.png', fullPage: true });
});
