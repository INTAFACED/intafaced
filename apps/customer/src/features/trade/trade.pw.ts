import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('an unavailable catalog retains the four Desk work areas and retries without inventing market data', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/v1/markets') reads++;
    await route.fulfill({ status: 503, json: { code: 'trade.catalog_unavailable', message: 'Published markets are unavailable.' } });
  });
  await page.goto('/exchange');
  await expect(page.getByRole('region', { name: 'Market chart unavailable' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Order book unavailable' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Order ticket unavailable' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Account order management' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeDisabled();
  await expect(page.locator('.trade-workspace canvas')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry published markets', exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  const proof = '/Users/Nitro/Desktop/intafaced-interface-overview/named-look/build/desk-completion-proof';
  await mkdir(proof, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `${proof}/catalog-unavailable-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'All markets', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Published markets are unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('No matching published markets in this mode.', { exact: true })).toHaveCount(0);
});

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
async function mount(
  page: Page,
  options: {
    working?: boolean;
    uncertain?: boolean;
    race?: boolean;
    unknownAmend?: boolean;
    staleBook?: boolean;
    futures?: boolean;
    delayedPreview?: boolean;
    replacementNoSubmit?: boolean;
    delayedPlacement?: boolean;
    uncertainCancel?: boolean;
    contractMultiplier?: string;
    paper?: boolean;
  } = {},
) {
  let previews = 0,
    deletes = 0,
    amended = false,
    cancelled = false;
  let balanceReads = 0;
  let placedClientId = '',
    placements = 0,
    releasePlacement = () => {};
  const placementGate = new Promise<void>((resolve) => {
    releasePlacement = resolve;
  });
  let releasePreview = () => {};
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    let response: unknown = [];
    if (path === '/api/v1/markets')
      response = options.futures
        ? [
            {
              ...market('BTC'),
              id: 'futures-market',
              symbol: 'BTC/USDT:PERP',
              spot: false,
              swap: true,
              contract: true,
              type: 'swap',
              linear: true,
              inverse: false,
              contractSize: options.contractMultiplier ?? null,
            },
          ]
        : options.paper
          ? [{ ...market('BTC'), paper: true }]
          : [market('BTC'), market('ETH')];
    else if (path.startsWith('/api/v1/orderbook/')) {
      const symbol = decodeURIComponent(path.split('/').at(-1) ?? '');
      response = {
        symbol,
        bids: [['80000', '1']],
        asks: [['80001', '1']],
        timestamp: options.staleBook ? Date.now() - 60000 : Date.now(),
        datetime,
        nonce: 1,
      };
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
    else if (path === '/api/v1/account/balance') {
      balanceReads++;
      response = {
        timestamp: time,
        datetime,
        balances: options.paper
          ? {}
          : {
              USDT: { free: '7500', used: '500', total: '8000' },
              BTC: { free: '0.05', used: '0', total: '0.05' },
              ETH: { free: '2', used: '0', total: '2' },
            },
      };
    } else if (path === '/api/v1/orders/open')
      response =
        (options.working || placedClientId) && !cancelled
          ? [amended ? { ...order(), amount: '0.010', remaining: '0.010' } : { ...order(), clientOrderId: placedClientId || 'original-1' }]
          : [];
    else if (path === '/api/v1/futures/adl-disclosure')
      response = { version: 'test-adl', copy: 'Test ADL disclosure from service.', acknowledged: true };
    else if (path === '/api/v1/positions/preview') {
      const draft = route.request().postDataJSON();
      response = {
        ...draft,
        markPrice: '100',
        markSource: 'depth',
        leverageCap: '10',
        orderValue: '100',
        initialMargin: '50',
        estimatedFee: '0.1',
        liquidationPrice: '70',
        orderable: true,
        refusals: [],
      };
    } else if (path === '/api/v1/orders/preview') {
      previews++;
      const draft = route.request().postDataJSON();
      if (options.delayedPreview && previews > 1) await previewGate;
      response = {
        ...draft,
        price: draft.price ?? null,
        holdAsset: 'USDT',
        holdAmount: options.paper
          ? '0'
          : previews > 1 && !options.uncertain && !options.delayedPreview && !options.replacementNoSubmit
            ? '2001'
            : '2000',
        protectionPrice: null,
        estimatedFee: '0.000025',
        feeAsset: 'BTC',
        feeBps: 10,
        feeRole: 'taker',
        orderable: true,
        refusals: [],
      };
    } else if (path === '/api/v1/orders/order-1/replace' && options.replacementNoSubmit) {
      cancelled = true;
      response = {
        accepted: false,
        idempotent: false,
        code: 'REPLACEMENT_NOT_SUBMITTED',
        reasonCode: 'trade.insufficient_balance',
        reconciliationRequired: false,
        path: 'CANCEL_REPLACE',
        originalOrderId: 'order-1',
        originalState: 'cancelled',
        replacementOrderId: null,
        replacementState: null,
        original: order('0', 'canceled'),
        replacement: null,
      };
    } else if (path === '/api/v1/orders' && route.request().method() === 'POST') {
      if (options.delayedPlacement) {
        placements++;
        placedClientId = route.request().postDataJSON().clientOrderId;
        await placementGate;
      } else if (options.uncertain) {
        await route.fulfill({ status: 503, json: { message: 'Matching outcome unknown', code: 'trade.engine_unreachable' } });
        return;
      }
      response = { ...order(), clientOrderId: route.request().postDataJSON().clientOrderId };
    } else if (path === '/api/v1/orders/order-1') {
      if (route.request().method() === 'PATCH' && options.unknownAmend) {
        amended = true;
        await route.fulfill({ status: 503, json: { message: 'Amend response unknown' } });
        return;
      }
      if (route.request().method() === 'DELETE') {
        deletes++;
        if (options.uncertainCancel) {
          await route.fulfill({ status: 503, json: { message: 'Cancellation outcome unknown' } });
          return;
        }
        cancelled = true;
      }
      response = amended
        ? { ...order(), amount: '0.010', remaining: '0.010' }
        : options.race
          ? order('0.005')
          : order('0', cancelled ? 'canceled' : 'open');
    }
    await route.fulfill({ json: response });
  });
  await page.routeWebSocket('**/ws/**', (socket) => {
    if (options.staleBook) return;
    const id = new URL(socket.url()).searchParams.get('market');
    socket.send(JSON.stringify({ type: 'snapshot', marketId: id, sequence: 1, bids: [['80000', '1']], asks: [['80001', '1']] }));
  });
  return {
    deletes: () => deletes,
    previews: () => previews,
    releasePreview,
    placements: () => placements,
    releasePlacement,
    balanceReads: () => balanceReads,
  };
}

test('account orders and verified-ID cancellation remain accessible when no market catalog is published', async ({ page }) => {
  const server = await mount(page, { working: true });
  await page.route('**/api/v1/markets*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/orders/closed*', (route) => route.fulfill({ json: [{ ...order('0.025', 'closed'), remaining: '0' }] }));
  await page.goto('/uc/entrust/current');
  await expect(page.getByRole('region', { name: 'Open orders', exact: true }).getByRole('table')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reduce', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Change price', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('region', { name: 'History', exact: true }).getByRole('table')).toContainText('closed');
  await page.getByRole('button', { name: 'Open orders', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  await expect.poll(() => server.deletes()).toBe(1);
  await expect(page.getByText(/Order order-1: canceled/)).toBeVisible();
  await page.goto('/uc/entrust/history');
  await expect(page.getByRole('region', { name: 'History', exact: true }).getByRole('table')).toContainText('closed');
  await page.getByRole('button', { name: 'Fills', exact: true }).click();
  await expect(page.getByText('No fills in this page', { exact: true })).toBeVisible();
  expect(server.balanceReads()).toBe(0);
});

test('missing-catalog recovery checks only the saved request and retains an absent original as unknown', async ({ page }) => {
  const server = await mount(page);
  await page.route('**/api/v1/markets*', (route) => route.fulfill({ status: 503, json: { message: 'Published markets unavailable' } }));
  await page.addInitScript(() =>
    localStorage.setItem(
      'trade-pending:00000000-0000-4000-8000-000000000001',
      JSON.stringify({
        kind: 'place',
        symbol: 'BTC/USDT',
        id: 'earlier-unknown',
        startedAt: Date.now(),
      }),
    ),
  );
  const lookups: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/orders/open' || url.pathname === '/api/v1/orders/closed') lookups.push(url);
  });
  await page.goto('/uc/entrust/current');
  await expect(page.getByRole('button', { name: 'Check original request status', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check original request status', exact: true }).click();
  await expect(page.getByText('The request was not found in the returned order pages.', { exact: false })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('earlier-unknown');
  expect(await page.evaluate(() => localStorage.getItem('trade-pending:00000000-0000-4000-8000-000000000001'))).toContain(
    'earlier-unknown',
  );
  expect(lookups.filter((url) => url.searchParams.get('limit') === '500')).toHaveLength(2);
  expect(lookups.every((url) => !url.searchParams.has('symbol'))).toBe(true);
  await page.route('**/api/v1/orders/open*', (route) => route.fulfill({ json: [{ ...order(), clientOrderId: 'earlier-unknown' }] }));
  await page.getByRole('button', { name: 'Check original request status', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('trade-pending:00000000-0000-4000-8000-000000000001'))).toBeNull();
  expect(server.placements()).toBe(0);
  expect(server.deletes()).toBe(0);
});

test('the actual App Trade door follows a checkbox switch into paper mode on desktop and phone', async ({ page }) => {
  const server = await mount(page, { paper: true });
  await page.goto('/exchange?fullApp=1');
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const simulation = page.getByRole('checkbox', { name: 'Simulated', exact: true });
    await simulation.uncheck();
    await simulation.check();
    const door = page.locator(width > 800 ? '.trade-top-nav' : '.mobile-doors').getByRole('link', { name: 'Trade', exact: true });
    await expect(door).toHaveAttribute('href', '/exchange?simulated=true');
    await door.click();
    await expect(page).toHaveURL(/\/exchange\?simulated=true$/);
    await expect(simulation).toBeChecked();
    await expect(page.getByText('Simulation · no live funds', { exact: true })).toBeVisible();
  }
  expect(server.balanceReads()).toBe(0);
});

test('simulated tool return and Margin links preserve paper intent after room navigation', async ({ page }) => {
  await mount(page, { paper: true });
  await page.goto('/exchange/BTC%2FUSDT?simulated=true');
  await page.getByRole('link', { name: 'Futures', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Simulated', exact: true })).toBeChecked();
  await page.getByRole('link', { name: 'Back to spot desk ↗', exact: true }).click();
  await expect(page).toHaveURL(/\/exchange\?simulated=true$/);
  await expect(page.getByRole('checkbox', { name: 'Simulated', exact: true })).toBeChecked();
  await page.goto('/trade/margin?simulated=true');
  const links = page.locator('.trade-tools a');
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', /[?&]simulated=true$/);
});

test('an unrelated valid order response cannot resolve the saved original cancellation', async ({ page }) => {
  await mount(page);
  await page.route('**/api/v1/markets*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/orders/order-1', (route) => route.fulfill({ json: { ...order('0', 'canceled'), id: 'different-order' } }));
  await page.addInitScript(() =>
    localStorage.setItem(
      'trade-pending:00000000-0000-4000-8000-000000000001',
      JSON.stringify({
        kind: 'cancel',
        symbol: 'BTC/USDT',
        id: 'order-1',
        orderId: 'order-1',
        startedAt: Date.now(),
      }),
    ),
  );
  await page.goto('/uc/entrust/current');
  await page.getByRole('button', { name: 'Check original request status', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('order-1');
  expect(await page.evaluate(() => localStorage.getItem('trade-pending:00000000-0000-4000-8000-000000000001'))).toContain('order-1');
  await expect(page.getByText(/Order different-order:/)).toHaveCount(0);
  await page.evaluate(() => {
    history.pushState(null, '', '/uc/entrust/current?simulated=true');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('checkbox', { name: 'Simulated', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Check original request status', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('order-1');
});

for (const responseKind of ['wrong ID', 'open', 'malformed'] as const)
  test(`an unverified cancellation ${responseKind} response retains the original durable request`, async ({ page }) => {
    const server = await mount(page, { working: true });
    await page.route('**/api/v1/markets*', (route) => route.fulfill({ json: [] }));
    let writes = 0;
    await page.route('**/api/v1/orders/order-1', async (route) => {
      if (route.request().method() === 'DELETE') {
        writes++;
        await route.fulfill({
          json:
            responseKind === 'malformed'
              ? {}
              : {
                  ...order('0', responseKind === 'open' ? 'open' : 'canceled'),
                  id: responseKind === 'wrong ID' ? 'different-order' : 'order-1',
                },
        });
      } else await route.fulfill({ json: order() });
    });
    await page.goto('/uc/entrust/current');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('order-1');
    expect(writes).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('trade-pending:00000000-0000-4000-8000-000000000001'))).toContain('order-1');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Check original request status', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    expect(writes).toBe(1);
    expect(server.balanceReads()).toBe(0);
  });

for (const delayedPreflight of [false, true])
  test(`a catalog-free live cancellation is fenced after Back enters paper mode${delayedPreflight ? ' during preflight' : ''}`, async ({
    page,
  }) => {
    const server = await mount(page, { working: true });
    await page.route('**/api/v1/markets*', (route) => route.fulfill({ json: [] }));
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let preflight = false;
    let cancellations = 0;
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/v1/orders/order-1') cancellations++;
    });
    if (delayedPreflight)
      await page.route('**/api/v1/orders/order-1', async (route) => {
        if (route.request().method() === 'GET') {
          preflight = true;
          await gate;
        }
        await route.fulfill({ json: order() });
      });
    await page.goto('/exchange?simulated=true');
    await page.evaluate(() => {
      history.pushState(null, '', '/exchange');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    if (delayedPreflight) {
      await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
      await expect.poll(() => preflight).toBe(true);
    }
    await page.goBack();
    await expect(page.getByRole('checkbox', { name: 'Simulated', exact: true })).toBeChecked();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    release();
    await page.waitForLoadState('networkidle');
    expect(cancellations).toBe(0);
    await expect.poll(() => server.deletes()).toBe(0);
  });

test('the actual View red-up preference colors market data without recoloring cancellation danger', async ({ page }) => {
  const server = await mount(page, { working: true });
  await page.goto('/account/view');
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('dark');
  await page.getByRole('combobox', { name: 'Up and down colors', exact: true }).selectOption('red');
  await expect(page.getByText('Preferences saved on this device.', { exact: true })).toBeVisible();
  await page.goto('/exchange/BTC%2FUSDT');
  await expect(page.locator('.trade-book-row.positive').first()).toHaveCSS('color', 'rgb(240, 90, 104)');
  await expect(page.locator('.trade-book-row.negative').first()).toHaveCSS('color', 'rgb(200, 246, 74)');
  await expect
    .poll(async () =>
      page.locator('.trade-chart-canvas canvas').evaluateAll((canvases) => {
        let pixels = 0;
        for (const canvas of canvases as HTMLCanvasElement[]) {
          const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
          if (data)
            for (let index = 0; index < data.length; index += 4)
              if (data[index] === 240 && data[index + 1] === 90 && data[index + 2] === 104 && (data[index + 3] ?? 0) > 0) pixels++;
        }
        return pixels;
      }),
    )
    .toBeGreaterThan(20);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Confirm cancellation', exact: true })).toHaveCSS(
    'background-color',
    'rgb(240, 90, 104)',
  );
  await page.getByRole('button', { name: 'Keep order', exact: true }).click();
  await page.goto('/account/view');
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('light');
  await page.goto('/exchange/BTC%2FUSDT');
  await expect(page.locator('.trade-book-row.positive').first()).toHaveCSS('color', 'rgb(186, 36, 59)');
  await expect(page.locator('.trade-book-row.negative').first()).toHaveCSS('color', 'rgb(60, 101, 0)');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Confirm cancellation', exact: true })).toHaveCSS(
    'background-color',
    'rgb(186, 36, 59)',
  );
  expect(server.deletes()).toBe(0);
});

test('the full sell deep link resolves only its requested published market, keeping query outside the pair', async ({ page }) => {
  await mount(page);
  await page.goto('/exchange/BTC_USDT?side=sell');
  await expect(page.getByRole('img', { name: 'Actual BTC/USDT historical prices', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review sell', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Choose trading market', exact: true })).toContainText('BTC/USDT');
  await page.getByLabel('Amount (BTC)', { exact: true }).fill('0.003');
  await page.evaluate(() => {
    history.pushState(null, '', '/exchange/BTC_USDT?side=buy');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Amount (BTC)', { exact: true })).toHaveValue('');
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Review sell', exact: true })).toBeEnabled();
  await page.goto('/exchange/UNPUBLISHED_USDT?side=sell');
  await expect(page.getByText('This market is not available in this mode', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeDisabled();
  await expect(page.locator('.trade-workspace canvas')).toHaveCount(0);
});

test('an explicit Academy simulation link opens only a published paper row and preserves its navigation mode', async ({ page }) => {
  const server = await mount(page, { paper: true });
  await page.goto('/exchange/BTC%2FUSDT?simulated=true');
  await expect(page.getByRole('checkbox', { name: 'Simulated', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeEnabled();
  await expect(page.getByText('Simulation · no live funds', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Spot', exact: true })).toHaveAttribute('href', '/exchange?simulated=true');
  await page.evaluate(() => {
    history.pushState(null, '', '/exchange/BTC%2FUSDT');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('checkbox', { name: 'Simulated', exact: true })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeDisabled();
  await page.goBack();
  await expect(page.getByRole('checkbox', { name: 'Simulated', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeEnabled();
  expect(server.balanceReads()).toBe(0);
});

test('a requested paper market cannot fall back to the identically named live catalog row', async ({ page }) => {
  const server = await mount(page);
  await page.goto('/exchange/BTC%2FUSDT?simulated=true');
  await expect(page.getByRole('checkbox', { name: 'Simulated', exact: true })).toBeChecked();
  await expect(page.getByText('No simulated spot market is published', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review order', exact: true })).toBeDisabled();
  expect(server.balanceReads()).toBe(0);
});

test('Desk panels resize by keyboard and pointer, keep bounds, persist geometry and restore R5 defaults', async ({ page }) => {
  await mount(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/exchange');
  const ticket = page.getByRole('separator', { name: 'Resize order ticket' });
  await ticket.focus();
  await ticket.press('ArrowLeft');
  await expect(ticket).toHaveAttribute('aria-valuenow', '340');
  const book = page.getByRole('separator', { name: 'Resize order book' });
  const box = (await book.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + 20);
  await page.mouse.up();
  await expect(book).toHaveAttribute('aria-valuenow', '348');
  const chart = page.getByRole('separator', { name: 'Resize chart height' });
  await chart.press('Home');
  await expect(chart).toHaveAttribute('aria-valuenow', '380');
  await chart.press('End');
  await expect(chart).toHaveAttribute('aria-valuenow', '900');
  await page.reload();
  await expect(ticket).toHaveAttribute('aria-valuenow', '340');
  await expect(chart).toHaveAttribute('aria-valuenow', '900');
  await page.getByText('Workspace', { exact: true }).click();
  await page.getByRole('button', { name: 'Restore default workspace' }).click();
  await expect(ticket).toHaveAttribute('aria-valuenow', '320');
  await expect(chart).toHaveAttribute('aria-valuenow', '548');
});

test('a named multi-chart workspace restores its market views and panel sizes without carrying order amounts', async ({ page }) => {
  await mount(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/exchange');
  await page.getByText('Workspace', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Two timeframes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Two timeframes', exact: true }).click();
  await page.getByLabel('Linked chart 1 market').selectOption('ETH/USDT');
  await page.getByLabel('Linked chart 1 interval').selectOption('4h');
  await page.getByLabel('Linked chart 1 type').selectOption('Candles');
  await expect(page.getByRole('region', { name: 'Linked chart 1 · ETH/USDT' }).locator('canvas').first()).toBeVisible();
  await page.getByRole('separator', { name: 'Resize order ticket' }).press('ArrowLeft');
  await page.getByLabel('Workspace name').fill('Research views');
  await page.getByRole('button', { name: 'Save workspace on device', exact: true }).click();
  await page.getByRole('button', { name: 'Focused chart', exact: true }).click();
  await page.reload();
  await page.getByText('Workspace', { exact: true }).click();
  await page.getByRole('button', { name: 'Restore workspace Research views' }).click();
  await expect(page.getByLabel('Linked chart 1 market')).toHaveValue('ETH/USDT');
  await expect(page.getByLabel('Linked chart 1 interval')).toHaveValue('4h');
  await expect(page.getByRole('separator', { name: 'Resize order ticket' })).toHaveAttribute('aria-valuenow', '340');
  const saved = await page.evaluate(() => localStorage.getItem('trade-desk-workspaces:v1'));
  expect(saved).not.toMatch(/balance|amount|price|credential|token|accessToken/i);
});

test('four actual history views fit between desktop and phone widths and retain their controls', async ({ page }) => {
  await mount(page);
  const proof = '/Users/Nitro/Desktop/intafaced-interface-overview/named-look/build/desk-completion-proof';
  await mkdir(proof, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/exchange');
  await page.getByText('Workspace', { exact: true }).click();
  await page.getByRole('button', { name: 'Four timeframes', exact: true }).click();
  await page.getByText('Workspace', { exact: true }).click();
  for (const width of [1440, 1010, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByLabel('Linked chart 3 interval')).toHaveValue('1d');
    await expect(page.getByRole('region', { name: 'Linked chart 3 · BTC/USDT' }).locator('canvas').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width}px document`).toBeLessThanOrEqual(width);
    const primary = page.getByRole('img', { name: 'Actual BTC/USDT historical prices', exact: true });
    const parent = page.locator('.trade-chart-grid > .trade-chart');
    const chartBox = (await primary.boundingBox())!,
      panelBox = (await parent.boundingBox())!;
    expect(chartBox.y + chartBox.height, `${width}px primary chart bounds`).toBeLessThanOrEqual(panelBox.y + panelBox.height);
    await page.screenshot({ path: `${proof}/four-views-${width}.png` });
  }
});

test('an empty history draws no synthetic price axes on either workspace chart', async ({ page }) => {
  await mount(page);
  await page.route('**/api/v1/ohlcv/**', (route) => route.fulfill({ json: [] }));
  await page.goto('/exchange');
  await expect(page.getByText('No price history', { exact: true })).toBeVisible();
  await page.getByText('Workspace', { exact: true }).click();
  await page.getByRole('button', { name: 'Two timeframes', exact: true }).click();
  await expect(page.getByText('No history for the second chart', { exact: true })).toBeVisible();
  await expect(page.locator('.trade-chart-grid canvas')).toHaveCount(0);
});

test('switching to simulation while the final spot preview is pending prevents live dispatch', async ({ page }) => {
  const server = await mount(page, { delayedPreview: true });
  let placements = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/orders' && request.method() === 'POST') placements++;
  });
  await page.goto('/exchange');
  await page.getByLabel('Price (USDT per BTC)', { exact: true }).fill('80000');
  await page.getByRole('textbox', { name: /^Amount \(BTC\)/ }).fill('0.025');
  await page.getByRole('button', { name: 'Review buy', exact: true }).click();
  await page.getByRole('button', { name: 'Place buy', exact: true }).click();
  await expect.poll(server.previews).toBe(2);
  await page.getByRole('checkbox', { name: 'Simulated', exact: true }).check();
  await expect(page.getByRole('textbox', { name: /^Amount \(BTC\)/ })).toHaveCount(0);
  server.releasePreview();
  await expect.poll(() => placements).toBe(0);
  await page.getByRole('checkbox', { name: 'Simulated', exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeEnabled();
  expect(placements).toBe(0);
});
test('published paper markets place simulated orders without reading or requiring live ledger funds', async ({ page }) => {
  const server = await mount(page, { paper: true });
  await page.goto('/exchange');
  await page.getByRole('checkbox', { name: 'Simulated', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeEnabled();
  await page.getByLabel('Price (USDT per BTC)', { exact: true }).fill('80000');
  await page.getByRole('textbox', { name: /^Amount \(BTC\)/ }).fill('0.025');
  await page.getByRole('button', { name: 'Review buy', exact: true }).click();
  await page.getByRole('button', { name: 'Place simulated buy', exact: true }).click();
  await expect(page.getByText(/^Simulated order order-1 is open;/)).toBeVisible();
  expect(server.balanceReads()).toBe(0);
});
test('price change reviews cancel/replace and reports a cancelled original with no replacement honestly', async ({ page }) => {
  await mount(page, { working: true, replacementNoSubmit: true });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);
  });
  await page.goto('/exchange');
  await page.getByRole('button', { name: 'Change price', exact: true }).click();
  await page.getByLabel('Replacement limit price (USDT per BTC)', { exact: true }).fill('81000');
  await page.getByRole('button', { name: 'Review replacement', exact: true }).click();
  await expect(page.getByText('Replacement order value', { exact: true })).toBeVisible();
  await expect(page.getByText('2,025 USDT', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm cancel/replace', exact: true }).click();
  await expect(page.getByText(/^Cancel\/replace: REPLACEMENT_NOT_SUBMITTED/)).toContainText(
    'Original order-1: canceled. No replacement was submitted.',
  );
  expect(writes).toEqual(['/api/v1/orders/preview', '/api/v1/orders/preview', '/api/v1/orders/order-1/replace']);
});

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
test('quote-value limit entry sends only an exact lot-aligned base quantity for review', async ({ page }) => {
  await mount(page);
  let requested: { amount?: string; price?: string } = {};
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/orders/preview') requested = request.postDataJSON();
  });
  await page.goto('/exchange');
  await expect(page.getByLabel('Size units', { exact: true })).toBeVisible();
  await page.getByLabel('Price (USDT per BTC)', { exact: true }).fill('80000');
  await page.getByLabel('Size units', { exact: true }).selectOption('quote');
  await page.getByRole('textbox', { name: /^Order value \(USDT\)/ }).fill('2000.39');
  await page.getByRole('button', { name: 'Review buy', exact: true }).click();
  await expect(page.getByText('0.025 BTC', { exact: true })).toBeVisible();
  expect(requested).toMatchObject({ amount: '0.025', price: '80000' });
  await page.getByRole('button', { name: 'Back to edit', exact: true }).click();
  await page.getByRole('group', { name: 'Order type', exact: true }).getByRole('button', { name: 'Market', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Amount \(BTC\)/ })).toHaveValue('');
  await expect(page.getByLabel('Size units', { exact: true })).toHaveValue('base');
  await page.getByRole('group', { name: 'Order side', exact: true }).getByRole('button', { name: 'Sell', exact: true }).click();
  await page.getByRole('group', { name: 'Order type', exact: true }).getByRole('button', { name: 'Limit', exact: true }).click();
  await page.getByLabel('Price (USDT per BTC)', { exact: true }).fill('');
  await page.getByLabel('Size units', { exact: true }).selectOption('quote');
  await expect(page.getByRole('button', { name: '25%', exact: true })).toBeDisabled();
  await page.getByLabel('Price (USDT per BTC)', { exact: true }).fill('80000');
  await page.getByRole('button', { name: '25%', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Order value \(USDT\)/ })).toHaveValue('1000');
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
  await page.addInitScript(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ confirmSend: false })));
  await mount(page, { uncertain: true });
  await page.goto('/exchange');
  await page.getByLabel('Price (USDT per BTC)', { exact: true }).fill('80000');
  await page.getByRole('textbox', { name: /^Amount \(BTC\)/ }).fill('0.025');
  await page.getByRole('button', { name: 'Review buy', exact: true }).click();
  await expect(page.getByText('Base quantity', { exact: true })).toBeVisible();
  await expect(page.getByText('Orders can fill before you can cancel.', { exact: false })).toHaveCount(0);
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
test('disabling the cancel warning still checks the authoritative order and sends one cancellation', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ confirmCancel: false })));
  const server = await mount(page, { working: true });
  await page.goto('/exchange');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText(/^Order order-1: canceled\. Filled/)).toBeVisible();
  expect(server.deletes()).toBe(1);
});
test('an old mutation response cannot clear the recovery marker for a later cancellation', async ({ page }) => {
  const server = await mount(page, { delayedPlacement: true, uncertain: true, uncertainCancel: true });
  await page.goto('/exchange');
  await page.getByLabel('Price (USDT per BTC)', { exact: true }).fill('80000');
  await page.getByRole('textbox', { name: /^Amount \(BTC\)/ }).fill('0.025');
  await page.getByRole('button', { name: 'Review buy', exact: true }).click();
  await page.getByRole('button', { name: 'Place buy', exact: true }).click();
  await expect.poll(server.placements).toBe(1);
  await page.getByRole('button', { name: 'Check original request status', exact: true }).click();
  await expect(page.getByText(/^Order order-1: open\. Filled/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  await expect(page.getByText('Outcome not confirmed · cancel', { exact: true })).toBeVisible();
  server.releasePlacement();
  await expect(page.getByText(/^Order order-1 is open;/)).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((key) => key.startsWith('trade-pending:'))!)!).kind,
    ),
  ).toBe('cancel');
  await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeDisabled();
});
test('contract quantity uses only the published multiplier for authoritative futures risk review', async ({ page }) => {
  await mount(page, { futures: true, contractMultiplier: '0.001' });
  let reviewedSize = '';
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/positions/preview') reviewedSize = request.postDataJSON().size;
  });
  await page.goto('/trade/futures');
  await page.getByRole('combobox').first().selectOption('BTC/USDT:PERP');
  await page.getByLabel('Position size units', { exact: true }).selectOption('contracts');
  await page.getByRole('textbox', { name: /^Position size \(contracts\)/ }).fill('10');
  await page.getByLabel('Leverage (exact decimal)', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Review position risk', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm position', exact: true })).toBeEnabled();
  expect(reviewedSize).toBe('0.01');
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

test('an uncertain native amendment reconciles while its reduced order is still open', async ({ page }) => {
  await mount(page, { working: true, unknownAmend: true });
  await page.goto('/exchange');
  await page.getByRole('button', { name: 'Reduce', exact: true }).click();
  await page.getByLabel('New remaining quantity (BTC)', { exact: true }).fill('0.010');
  await page.getByRole('button', { name: 'Confirm reduction' }).click();
  await expect(page.getByText('Outcome not confirmed · amend')).toBeVisible();
  await page.getByRole('button', { name: 'Check original request status' }).click();
  await expect(page.getByText('Outcome not confirmed · amend')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeEnabled();
});
test('simulated toggle clears a live futures review and cannot submit its position', async ({ page }) => {
  await mount(page, { futures: true });
  let writes = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/positions' && request.method() === 'POST') writes++;
  });
  await page.goto('/trade/futures');
  await page.getByRole('combobox').first().selectOption('BTC/USDT:PERP');
  await page.getByRole('textbox', { name: /^Position size \(base quantity/ }).fill('1');
  await page.getByLabel('Leverage (exact decimal)', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Review position risk' }).click();
  await expect(page.getByRole('button', { name: 'Confirm position' })).toBeEnabled();
  await page.getByRole('checkbox', { name: 'Simulated', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Confirm position' })).toHaveCount(0);
  expect(writes).toBe(0);
});
test('old source depth cannot authorize a new order merely because it was just received', async ({ page }) => {
  await mount(page, { staleBook: true });
  await page.goto('/exchange');
  await expect(page.getByText('Snapshot is stale', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeDisabled();
  await expect(page.getByText('This depth snapshot is too old to authorize a new order.')).toBeVisible();
});
test('candle inspection and depth staging retain the actual source prices', async ({ page }) => {
  await mount(page);
  await page.goto('/exchange');
  const chart = page.getByRole('img', { name: 'Actual BTC/USDT historical prices', exact: true });
  await expect(chart.locator('canvas').first()).toBeVisible();
  await chart.focus();
  await chart.press('ArrowLeft');
  await expect(page.getByText('O 80000 · H 80020 · L 79990 · C 80001 USDT · V 1 BTC', { exact: true })).toBeVisible();
  await chart.press('Enter');
  await expect(page.getByLabel('Price (USDT per BTC)', { exact: true })).toHaveValue('80001');
  await page.getByRole('button', { name: 'Depth', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Actual cumulative BTC/USDT depth', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '80,000 USDT', exact: true }).click();
  await expect(page.getByLabel('Price (USDT per BTC)', { exact: true })).toHaveValue('80000');
});
test('a saved chart layout restores its type, interval, and indicator set', async ({ page }) => {
  await mount(page);
  await page.goto('/exchange');
  await page.getByLabel('Chart type', { exact: true }).selectOption('Line');
  await page.getByLabel('Chart interval', { exact: true }).selectOption('1m');
  await page
    .locator('summary')
    .filter({ hasText: /^Indicators$/ })
    .click();
  await page.getByRole('checkbox', { name: 'RSI', exact: true }).check();
  await page
    .locator('summary')
    .filter({ hasText: /^Indicators$/ })
    .click();
  await page
    .locator('summary')
    .filter({ hasText: /^Layouts$/ })
    .click();
  page.once('dialog', (dialog) => void dialog.accept('Momentum'));
  await page.getByRole('button', { name: 'Save layout on device', exact: true }).click();
  await page.reload();
  await page
    .locator('summary')
    .filter({ hasText: /^Layouts$/ })
    .click();
  await page.getByRole('button', { name: 'Momentum', exact: true }).click();
  await expect(page.getByLabel('Chart type', { exact: true })).toHaveValue('Line');
  await expect(page.getByLabel('Chart interval', { exact: true })).toHaveValue('1m');
  await page
    .locator('summary')
    .filter({ hasText: /^Indicators$/ })
    .click();
  await expect(page.getByRole('checkbox', { name: 'RSI', exact: true })).toBeChecked();
});
test('a keyboard level drawing persists and restores its exact source price', async ({ page }) => {
  await mount(page);
  await page.goto('/exchange');
  const chart = page.getByRole('img', { name: 'Actual BTC/USDT historical prices', exact: true });
  await expect(chart.locator('canvas').first()).toBeVisible();
  await page
    .locator('summary')
    .filter({ hasText: /^Draw$/ })
    .click();
  await page.getByRole('button', { name: 'level', exact: true }).click();
  await chart.focus();
  await chart.press('ArrowLeft');
  await chart.press('Enter');
  await expect(chart.locator('svg line')).toHaveCount(1);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem(Object.keys(localStorage).find((key) => key.startsWith('trade-drawings:'))!)!),
  );
  expect(saved[0].points[0][1]).toBe('80001');
  await page.reload();
  await expect(page.getByRole('img', { name: 'Actual BTC/USDT historical prices', exact: true }).locator('svg line')).toHaveCount(1);
});
test('a delayed reconciliation cannot remove a newer request recovery marker', async ({ page }) => {
  await mount(page, { uncertain: true });
  await page.goto('/exchange');
  await page.getByLabel('Price (USDT per BTC)', { exact: true }).fill('80000');
  await page.getByRole('textbox', { name: /^Amount \(BTC\)/ }).fill('0.025');
  await page.getByRole('button', { name: 'Review buy', exact: true }).click();
  await page.getByRole('button', { name: 'Place buy', exact: true }).click();
  await expect(page.getByText('Matching outcome unknown', { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.startsWith('trade-pending:'))!;
    return { key, request: JSON.parse(localStorage.getItem(key)!) };
  });
  let entered = false,
    release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/orders/open?**', async (route) => {
    entered = true;
    await gate;
    await route.fulfill({ json: [{ ...order(), clientOrderId: saved.request.id }] });
  });
  await page.getByRole('button', { name: 'Check original request status', exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  await page.evaluate(({ key, request }) => {
    localStorage.setItem(key, JSON.stringify({ ...request, id: 'newer-request-b', startedAt: request.startedAt + 1 }));
    window.dispatchEvent(new Event('trade-pending-change'));
  }, saved);
  release();
  await expect(page.getByText(/^Order order-1: open\. Filled/)).toBeVisible();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).id, saved.key)).toBe('newer-request-b');
  await expect(page.getByRole('button', { name: 'Place buy', exact: true })).toBeDisabled();
});
test('dragging an open order stages an exact replacement price without submitting it', async ({ page }) => {
  await mount(page, { working: true });
  let replacements = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/replace')) replacements++;
  });
  await page.goto('/exchange');
  const handle = page.getByRole('button', { name: 'Change price for order order-1', exact: true });
  await expect(handle).toBeVisible();
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error('Order handle is unavailable');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  const price = page.getByLabel('Replacement limit price (USDT per BTC)', { exact: true });
  await expect(price).toBeVisible();
  expect(await price.inputValue()).not.toBe('80000');
  expect(await price.inputValue()).toMatch(/^\d+(?:\.\d{1,2})?$/);
  expect(replacements).toBe(0);
});
for (const width of [1440, 768, 320])
  test(`trade remains usable at ${width}px including its chart menu`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page);
    await page.goto('/exchange');
    await expect(page.getByRole('img', { name: 'Actual BTC/USDT historical prices', exact: true }).locator('canvas').first()).toBeVisible();
    await page
      .locator('summary')
      .filter({ hasText: /^View$/ })
      .click();
    await expect(
      page.getByText('No customer alert creation, delivery, or alert history service is mounted.', { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/intafaced-trade-${width}.png`, fullPage: true });
  });
