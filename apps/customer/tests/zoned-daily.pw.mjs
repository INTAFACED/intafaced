import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const evidence = process.env.ZONED_DAILY_EVIDENCE || '/tmp/intafaced-zoned-daily-native';
mkdirSync(evidence, { recursive: true });
const now = Date.parse('2026-10-10T12:00:00Z'),
  preferenceKey = 'intafaced.customer.view.v1';
const sample = (timestamp, close = '80001.000000000000000009') => [
  timestamp,
  '80000.000000000000000001',
  '80020',
  '79990',
  close,
  '0.000000000000000001',
];
function market(base) {
  return {
    id: 'market-' + base,
    symbol: base + '/USDT',
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
async function observedPreferences(page, patches) {
  await page.evaluate(
    ({ key, patches }) => {
      for (const patch of patches) {
        const oldValue = localStorage.getItem(key),
          next = { ...JSON.parse(oldValue || '{}'), ...patch };
        const newValue = JSON.stringify(next);
        localStorage.setItem(key, newValue);
        window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }));
      }
    },
    { key: preferenceKey, patches },
  );
}
async function mount(
  page,
  { zone = 'America/New_York', language = 'en', path = '/exchange', signedIn = false, engineHold = false, clock = now } = {},
) {
  const state = {
    reads: [],
    writes: [],
    held: [],
    hold: false,
    failure: false,
    invalid: false,
    offGrid: false,
    close: '80001.000000000000000009',
    engineRelease: null,
    engineHeld: false,
    pageErrors: [],
  };
  page.on('pageerror', () => state.pageErrors.push('browser exception'));
  await page.clock.setFixedTime(new Date(clock));
  await page.addInitScript(
    ({ key, zone, language }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ dailyStart: 'zoned', dailyZone: zone, language }));
      window.__chartProof = { clicks: [], created: 0, series: [] };
      let engine;
      Object.defineProperty(window, 'LightweightCharts', {
        configurable: true,
        get: () => engine,
        set: (value) => {
          engine = {
            ...value,
            createChart: (...args) => {
              window.__chartProof.created++;
              const chart = value.createChart(...args),
                click = chart.subscribeClick.bind(chart),
                add = chart.addSeries.bind(chart);
              chart.subscribeClick = (handler) => {
                window.__chartProof.clicks.push(handler);
                click(handler);
              };
              chart.addSeries = (...seriesArgs) => {
                const series = add(...seriesArgs),
                  set = series.setData.bind(series);
                series.setData = (rows) => {
                  window.__chartProof.series.push(rows.map((row) => row.time));
                  set(rows);
                };
                return series;
              };
              return chart;
            },
          };
        },
      });
    },
    { key: preferenceKey, zone, language: signedIn ? 'en' : language },
  );
  if (engineHold)
    await page.route('**/*lightweight-charts*.js', async (route) => {
      state.engineHeld = true;
      await new Promise((resolve) => {
        state.engineRelease = resolve;
      });
      await route.continue();
    });
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      pathname = url.pathname,
      method = request.method();
    if (method !== 'GET') state.writes.push({ pathname, body: request.postData() });
    if (pathname === '/api/identity/trpc/auth.login')
      return route.fulfill({
        json: {
          result: {
            data: {
              userId: '11111111-1111-4111-8111-111111111111',
              accessToken: 'isolated-zoned-session',
              refreshToken: 'isolated-zoned-refresh',
              expiresAt: '2027-10-10T00:00:00Z',
            },
          },
        },
      });
    if (pathname === '/api/v1/markets') return route.fulfill({ json: [market('BTC'), market('ETH')] });
    if (pathname.startsWith('/api/v1/ohlcv/')) {
      const timeframe = url.searchParams.get('timeframe'),
        span = timeframe === '1h' ? 3600000 : timeframe === '1d' ? 86400000 : 900000;
      const since = Number(url.searchParams.get('since') || Math.floor(clock / span) * span);
      const captured = {
        timeframe,
        since,
        limit: url.searchParams.get('limit'),
        symbol: decodeURIComponent(pathname.split('/').at(-1)),
        close: state.close,
        failure: state.failure,
        invalid: state.invalid,
        offGrid: state.offGrid,
      };
      state.reads.push(captured);
      if (state.hold) await new Promise((resolve) => state.held.push(resolve));
      if (captured.failure)
        return route.fulfill({ status: 503, json: { code: 'trade.original_read', message: 'Original selected read unavailable.' } });
      const rows = [sample(since, captured.close), sample(Math.floor(clock / span) * span, captured.close)];
      if (rows[0][0] === rows[1][0]) rows.shift();
      if (captured.invalid) rows.at(-1)[2] = '1';
      if (captured.offGrid) rows[0][0] += 1;
      return route.fulfill({ json: rows });
    }
    if (pathname.startsWith('/api/v1/orderbook/'))
      return route.fulfill({
        json: {
          symbol: decodeURIComponent(pathname.split('/').at(-1)),
          bids: [['80000', '1']],
          asks: [['80001', '1']],
          timestamp: now,
          datetime: new Date(now).toISOString(),
          nonce: 1,
        },
      });
    if (pathname === '/api/v1/account/balance')
      return route.fulfill({
        json: {
          timestamp: now,
          datetime: new Date(now).toISOString(),
          balances: { USDT: { free: '7500', used: '500', total: '8000' }, BTC: { free: '0.05', used: '0', total: '0.05' } },
        },
      });
    if (pathname === '/api/v1/orders/preview') {
      const draft = request.postDataJSON();
      return route.fulfill({
        json: {
          ...draft,
          price: draft.price ?? null,
          holdAsset: 'USDT',
          holdAmount: '2000',
          protectionPrice: null,
          estimatedFee: '0.000025',
          feeAsset: 'BTC',
          feeBps: 10,
          feeRole: 'taker',
          orderable: true,
          refusals: [],
        },
      });
    }
    if (pathname === '/api/v1/orders' && method === 'POST')
      return route.fulfill({ status: 503, json: { code: 'trade.original_unknown', message: 'Original outcome is unknown.' } });
    if (pathname.startsWith('/api/v1/')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 503, json: { error: 'Unavailable', message: 'Isolated read unavailable.' } });
  });
  if (signedIn) {
    await page.goto('/login?redirect=' + encodeURIComponent(path));
    await page.getByLabel('Email or handle', { exact: true }).fill('integration@example.invalid');
    await page.getByLabel('Password', { exact: true }).fill('isolated-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(path.replace(/[?]/g, '\\?')));
    state.writes = [];
    if (language !== 'en') await observedPreferences(page, [{ language }]);
  } else await page.goto(path);
  return state;
}
const primary = (page) => page.getByTestId('trade-chart').first();
async function daily(page) {
  await primary(page).getByLabel('Chart interval', { exact: true }).selectOption('1d');
}
async function ready(page, zone = 'America/New_York') {
  const canonical = await page.evaluate((zone) => new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone, zone);
  await expect(primary(page).locator('[data-zoned-source]').first()).toContainText(canonical);
  await expect(primary(page).locator('[data-testid="trade-engine"] canvas').first()).toBeVisible();
}
async function inspect(page) {
  const canvas = primary(page).getByTestId('trade-chart-canvas');
  await canvas.focus();
  await canvas.press('ArrowLeft');
  return primary(page).getByTestId('trade-candle-inspection');
}
test('View accepts browser-recognized named aliases containing digits', async ({ page }) => {
  const state = await mount(page, { path: '/view', signedIn: true });
  const zone = page.getByLabel('Daily chart time zone', { exact: true });
  const mappings = [];
  for (const [alias, target] of [
    ['EST5EDT', 'America/New_York'],
    ['CST6CDT', 'America/Chicago'],
    ['MST7MDT', 'America/Denver'],
    ['PST8PDT', 'America/Los_Angeles'],
  ]) {
    const canonical = await page.evaluate((value) => new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone, alias);
    expect(canonical).toBe(target);
    await zone.fill(alias);
    await zone.press('Enter');
    mappings.push({ alias, canonical, invalid: await zone.getAttribute('aria-invalid'), value: await zone.inputValue() });
    writeFileSync(`${evidence}/view-alias-mappings.json`, JSON.stringify(mappings, null, 2) + '\n');
    await expect(zone).toHaveValue(canonical);
    await expect(zone).toHaveAttribute('aria-invalid', 'false');
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).dailyZone, preferenceKey)).toBe(canonical);
  }
  expect(state.writes).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
for (const clock of [now, Date.parse('2026-03-08T12:00:00Z'), Date.parse('2026-11-01T12:00:00Z')])
  test(`Trade chooser applies a named alias and the canonical target uses the identical bounded GET at ${new Date(clock).toISOString()}`, async ({
    page,
  }) => {
    const state = await mount(page, { signedIn: true, clock });
    await daily(page);
    await ready(page);
    await primary(page).getByRole('link', { name: 'Choose time zone', exact: true }).click();
    await expect(page).toHaveURL(/\/view$/);
    const zone = page.getByLabel('Daily chart time zone', { exact: true });
    await zone.fill('CST6CDT');
    await page.getByRole('button', { name: 'Apply time zone', exact: true }).click();
    writeFileSync(
      `${evidence}/trade-alias-chooser.json`,
      JSON.stringify({ invalid: await zone.getAttribute('aria-invalid'), value: await zone.inputValue() }, null, 2) + '\n',
    );
    await expect(zone).toHaveValue('America/Chicago');
    await page.getByRole('link', { name: 'Trade', exact: true }).click();
    await daily(page);
    await ready(page, 'America/Chicago');
    const aliasRead = { ...state.reads.at(-1) };
    await expect(await inspect(page)).toContainText('80001.000000000000000009');
    await primary(page).getByRole('link', { name: 'Choose time zone', exact: true }).click();
    await zone.fill('America/Chicago');
    await zone.press('Enter');
    await page.getByRole('link', { name: 'Trade', exact: true }).click();
    await daily(page);
    await ready(page, 'America/Chicago');
    expect(state.reads.at(-1)).toEqual(aliasRead);
    expect(aliasRead).toMatchObject({ symbol: 'BTC/USDT', timeframe: '1h', limit: '500' });
    expect(state.writes).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
test('named UTC and fixed-offset Etc zones stay usable while numeric offsets and unknown drafts preserve the current choice', async ({
  page,
}) => {
  const state = await mount(page, { path: '/view', signedIn: true });
  const zone = page.getByLabel('Daily chart time zone', { exact: true });
  for (const named of ['UTC', 'Etc/GMT+8', 'US/Eastern']) {
    const canonical = await page.evaluate((value) => new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone, named);
    await zone.fill(named);
    await zone.press('Enter');
    await expect(zone).toHaveValue(canonical);
    await expect(zone).toHaveAttribute('aria-invalid', 'false');
  }
  for (const refused of ['1', '123', '+01', '-0100', '+01:00', 'Unknown/Unpublished_Zone']) {
    await zone.fill(refused);
    await zone.press('Enter');
    await expect(zone).toHaveValue(refused);
    await expect(zone).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert')).toContainText('current choice is kept');
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).dailyZone, preferenceKey)).toBe('America/New_York');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(zone).toHaveValue('America/New_York');
  }
  await zone.fill('PST8PDT');
  await zone.press('Enter');
  await expect(zone).toHaveValue('America/Los_Angeles');
  await page.goto('/exchange');
  await daily(page);
  await ready(page, 'America/Los_Angeles');
  expect(state.writes).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
test('View stages invalid zones, keeps the saved choice, and labels are independent', async ({ page }) => {
  const state = await mount(page, { path: '/view', signedIn: true });
  const zone = page.getByLabel('Daily chart time zone', { exact: true });
  await zone.fill('Invalid/Choice');
  await page.getByRole('button', { name: 'Apply time zone', exact: true }).click();
  await expect(zone).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert')).toContainText('current choice is kept');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).dailyZone, preferenceKey)).toBe('America/New_York');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(zone).toHaveValue('America/New_York');
  await zone.fill('Asia/Kathmandu');
  await zone.press('Enter');
  await expect(zone).toHaveValue(
    await page.evaluate(() => new Intl.DateTimeFormat('en', { timeZone: 'Asia/Kathmandu' }).resolvedOptions().timeZone),
  );
  await page.getByLabel('Chart time labels', { exact: true }).selectOption('UTC+8');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).dailyZone, preferenceKey)).toMatch(/Asia\/Kat[h]?mandu/);
  await observedPreferences(page, [{ dailyZone: 'America/Havana' }]);
  await expect(zone).toHaveValue('America/Havana');
  expect(state.writes).toEqual([]);
});
test('same-task cross-tab zone ABA discards held primary, comparison and linked snapshots', async ({ page }) => {
  const state = await mount(page);
  await daily(page);
  await ready(page);
  await primary(page).getByLabel('Compare market symbol').fill('ETH/USDT');
  await primary(page).getByText('Layouts', { exact: true }).click();
  await primary(page).getByLabel('Second linked chart', { exact: true }).check();
  await expect(page.locator('[data-zoned-source]')).toHaveCount(3);
  state.hold = true;
  state.close = '80003.000000000000000009';
  await primary(page).getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect.poll(() => state.held.length).toBe(3);
  await observedPreferences(page, [{ dailyZone: 'Asia/Kathmandu' }, { dailyZone: 'America/New_York' }]);
  await expect.poll(() => state.held.length).toBe(6);
  expect(await page.locator('[data-zoned-source]').count()).toBe(0);
  const old = state.held.splice(0, 3);
  for (const release of old) release();
  await page.waitForTimeout(100);
  expect(await page.locator('[data-zoned-source]').count()).toBe(0);
  state.hold = false;
  for (const release of state.held.splice(0)) release();
  await expect(page.locator('[data-zoned-source]')).toHaveCount(3);
  await ready(page);
  await expect(await inspect(page)).toContainText('80003.000000000000000009');
  expect(state.writes).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
test('interval and market departures reject late reads and fresh current control publishes', async ({ page }) => {
  const state = await mount(page);
  await daily(page);
  await ready(page);
  state.hold = true;
  state.close = '80007';
  await primary(page).getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect.poll(() => state.held.length).toBe(1);
  await primary(page).getByLabel('Chart interval', { exact: true }).selectOption('1h');
  await expect.poll(() => state.held.length).toBe(2);
  state.held.shift()();
  await page.waitForTimeout(100);
  expect(await page.locator('[data-zoned-source]').count()).toBe(0);
  state.hold = false;
  for (const release of state.held.splice(0)) release();
  await daily(page);
  await ready(page);
  await expect(await inspect(page)).toContainText('80007');
  await page.goto('/exchange?asset=ETH');
  await daily(page);
  await ready(page);
  expect(state.reads.at(-1).symbol).toBe('ETH/USDT');
  expect(state.pageErrors).toEqual([]);
});
test('queued cross-tab events observe a departed zone even when storage already returned to A', async ({ page }) => {
  const state = await mount(page);
  await daily(page);
  await ready(page);
  state.hold = true;
  state.close = '80004';
  await primary(page).getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect.poll(() => state.held.length).toBe(1);
  state.close = '80005';
  await page.evaluate((key) => {
    const original = localStorage.getItem(key),
      departed = JSON.stringify({ ...JSON.parse(original), dailyZone: 'Asia/Kathmandu' });
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue: original, newValue: departed, storageArea: localStorage }));
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue: departed, newValue: original, storageArea: localStorage }));
  }, preferenceKey);
  await expect.poll(() => state.held.length).toBe(2);
  state.held.shift()();
  await page.waitForTimeout(100);
  await expect(primary(page).locator('[data-zoned-source]')).toHaveCount(0);
  state.hold = false;
  state.held.shift()();
  await ready(page);
  await expect(await inspect(page)).toContainText('80005');
});
test('oldValue-only B to A departure rejects a retained daily chart handler and fresh control publishes', async ({ page }) => {
  const state = await mount(page);
  await daily(page);
  await ready(page);
  const price = page.getByRole('region', { name: 'Spot order ticket' }).getByLabel('Price (USDT per BTC)');
  await price.fill('79999');
  const reads = state.reads.length;
  await page.evaluate(() => {
    const key = 'intafaced.customer.view.v1',
      current = localStorage.getItem(key),
      a = JSON.parse(current),
      oldValue = JSON.stringify({ ...a, dailyZone: 'Asia/Kathmandu' });
    const handler = window.__chartProof.clicks.at(-1),
      time = window.__chartProof.series
        .filter((rows) => rows.length)
        .at(-1)
        ?.at(-1);
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue: current, storageArea: localStorage }));
    handler({ time });
  });
  await expect.poll(() => state.reads.length).toBe(reads + 1);
  await ready(page);
  await expect(price).toHaveValue('79999');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('intafaced.customer.view.v1')));
  expect(saved).toMatchObject({ dailyStart: 'zoned', dailyZone: 'America/New_York' });
  await page.evaluate(() => {
    const handler = window.__chartProof.clicks.at(-1),
      time = window.__chartProof.series
        .filter((rows) => rows.length)
        .at(-1)
        ?.at(-1);
    handler({ time });
  });
  await expect(price).toHaveValue('80001.000000000000000009');
  expect(state.writes).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
for (const kind of ['unchanged', 'malformed-json', 'malformed-zone', 'other-key', 'other-area'])
  test(`${kind} storage description keeps the current daily chart handler admitted`, async ({ page }) => {
    const state = await mount(page);
    await daily(page);
    await ready(page);
    const price = page.getByRole('region', { name: 'Spot order ticket' }).getByLabel('Price (USDT per BTC)');
    await price.fill('79999');
    const reads = state.reads.length;
    await page.evaluate((kind) => {
      const key = 'intafaced.customer.view.v1',
        current = localStorage.getItem(key),
        a = JSON.parse(current),
        b = JSON.stringify({ ...a, dailyZone: 'Asia/Kathmandu' });
      const oldValue =
        kind === 'unchanged'
          ? current
          : kind === 'malformed-json'
            ? '{'
            : kind === 'malformed-zone'
              ? JSON.stringify({ ...a, dailyZone: 'Invalid/Choice' })
              : b;
      const handler = window.__chartProof.clicks.at(-1),
        time = window.__chartProof.series
          .filter((rows) => rows.length)
          .at(-1)
          ?.at(-1);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: kind === 'other-key' ? 'unrelated.preference' : key,
          oldValue,
          newValue: current,
          storageArea: kind === 'other-area' ? sessionStorage : localStorage,
        }),
      );
      handler({ time });
    }, kind);
    await expect(price).toHaveValue('80001.000000000000000009');
    expect(state.reads).toHaveLength(reads);
    expect(state.writes).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
test('actor and API departure during a held guest read cannot publish into the signed-in chart', async ({ page }) => {
  const state = await mount(page);
  await daily(page);
  await ready(page);
  state.hold = true;
  state.close = '80004';
  await primary(page).getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect.poll(() => state.held.length).toBe(1);
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = '/login?redirect=%2Fexchange';
    document.querySelector('[data-testid="trade-chart"]').append(link);
    link.click();
  });
  await page.getByLabel('Email or handle', { exact: true }).fill('integration@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('isolated-password');
  state.hold = false;
  state.close = '80008';
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/exchange/);
  await daily(page);
  await ready(page);
  state.held.shift()();
  await page.waitForTimeout(100);
  await expect(await inspect(page)).toContainText('80008');
  expect(state.pageErrors).toEqual([]);
});
test('late chart imports and retained click handlers cannot stage old prices after zone ABA', async ({ page }) => {
  const state = await mount(page, { engineHold: true });
  await expect.poll(() => state.engineHeld).toBe(true);
  await daily(page);
  await observedPreferences(page, [{ dailyZone: 'Asia/Kathmandu' }, { dailyZone: 'America/New_York' }]);
  state.engineRelease();
  await ready(page);
  expect(await page.evaluate(() => window.__chartProof.created)).toBe(1);
  const price = page.getByRole('region', { name: 'Spot order ticket' }).getByLabel('Price (USDT per BTC)');
  await price.fill('79999');
  await page.evaluate(
    ({ key }) => {
      const handler = window.__chartProof.clicks.at(-1),
        time = window.__chartProof.series.find((rows) => rows.length)?.at(-1);
      const current = localStorage.getItem(key),
        original = JSON.parse(current);
      for (const zone of ['Asia/Kathmandu', 'America/New_York']) {
        const next = JSON.stringify({ ...original, dailyZone: zone });
        localStorage.setItem(key, next);
        window.dispatchEvent(new StorageEvent('storage', { key, oldValue: current, newValue: next, storageArea: localStorage }));
      }
      handler({ time });
    },
    { key: preferenceKey },
  );
  await expect(price).toHaveValue('79999');
  await ready(page);
  await primary(page).getByTestId('trade-chart-canvas').focus();
  await primary(page).getByTestId('trade-chart-canvas').press('ArrowLeft');
  await primary(page).getByTestId('trade-chart-canvas').press('Enter');
  await expect(price).toHaveValue('80001.000000000000000009');
  expect(state.writes).toEqual([]);
});
test('manual refresh rejects a held linked import in the same turn and fresh current control publishes', async ({ page }) => {
  await page.addInitScript(() => {
    window.__moduleProof = { hold: false, held: [], observed: 0 };
    const then = Promise.prototype.then;
    Promise.prototype.then = function (fulfilled, rejected) {
      if (typeof fulfilled !== 'function') return then.call(this, fulfilled, rejected);
      return then.call(
        this,
        (value) => {
          if (
            window.__moduleProof.hold &&
            value?.[Symbol.toStringTag] === 'Module' &&
            Object.keys(value).length === 0 &&
            window.LightweightCharts
          ) {
            window.__moduleProof.observed++;
            return new Promise((resolve, reject) => {
              window.__moduleProof.held.push(() =>
                queueMicrotask(() => {
                  try {
                    resolve(fulfilled(value));
                  } catch (error) {
                    reject(error);
                  }
                }),
              );
            });
          }
          return fulfilled(value);
        },
        rejected,
      );
    };
  });
  const state = await mount(page);
  await daily(page);
  await ready(page);
  await page.evaluate(() => {
    window.__moduleProof.hold = true;
  });
  await primary(page).getByText('Layouts', { exact: true }).click();
  await primary(page).getByLabel('Second linked chart', { exact: true }).check();
  await expect.poll(() => page.evaluate(() => window.__moduleProof.held.length)).toBe(1);
  await expect(primary(page).locator('[data-zoned-source]')).toHaveCount(2);
  state.hold = true;
  const proof = await page.evaluate(async () => {
    const chart = document.querySelector('[data-testid="trade-chart"]');
    const button = [...chart.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Refresh history');
    const propsKey = Object.keys(button).find((key) => key.startsWith('__reactProps$'));
    const retainedRefresh = button[propsKey].onClick;
    const before = window.__chartProof.created;
    retainedRefresh();
    window.__moduleProof.hold = false;
    window.__moduleProof.held.shift()();
    // Drain the actual Vite preload/module fulfillment chain within the same
    // event turn; React's scheduled render must still be pending below.
    for (let turn = 0; turn < 32; turn++) await Promise.resolve();
    return {
      createdInSameTurn: window.__chartProof.created - before,
      sourceStillRendered: chart.querySelectorAll('[data-zoned-source]').length,
      heldModuleFulfillments: window.__moduleProof.observed,
    };
  });
  writeFileSync(`${evidence}/refresh-import-same-turn.json`, JSON.stringify(proof, null, 2) + '\n');
  expect(proof.sourceStillRendered).toBe(2);
  expect(proof.heldModuleFulfillments).toBe(1);
  expect(proof.createdInSameTurn).toBe(0);
  await expect.poll(() => state.held.length).toBe(2);
  state.hold = false;
  for (const release of state.held.splice(0)) release();
  await ready(page);
  await expect(primary(page).locator('[data-zoned-source]')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Second linked BTC/USDT chart', exact: true }).locator('canvas').first()).toBeVisible();
  expect(state.pageErrors).toEqual([]);
  expect(state.writes).toEqual([]);
});
test('published-schema whole read failures retain no prefix, retry deliberately, and native UTC remains useful', async ({ page }) => {
  const state = await mount(page, { zone: 'Asia/Kathmandu' });
  await daily(page);
  await ready(page, 'Asia/Kathmandu');
  state.invalid = true;
  await primary(page).getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect(primary(page)).toContainText('The service response could not be verified.');
  await expect(primary(page).locator('[data-zoned-source]')).toHaveCount(0);
  await expect(primary(page).locator('[data-testid="trade-engine"] canvas')).toHaveCount(0);
  state.invalid = false;
  state.failure = true;
  await primary(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(primary(page)).toContainText('Original selected read unavailable.');
  state.failure = false;
  await primary(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await ready(page, 'Asia/Kathmandu');
  state.failure = true;
  await primary(page).getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect(primary(page)).toContainText('Original selected read unavailable.');
  state.failure = false;
  await primary(page).getByRole('button', { name: 'Use native UTC', exact: true }).click();
  await expect(primary(page).getByLabel('Daily chart starts at', { exact: true })).toHaveValue('nativeUTC');
  await expect(primary(page).locator('[data-testid="trade-engine"] canvas').first()).toBeVisible();
  expect(state.reads.at(-1).timeframe).toBe('1d');
  expect(state.writes).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});
test('shape-valid source outside its captured grid refuses the whole derived result', async ({ page }) => {
  const state = await mount(page, { zone: 'Asia/Kathmandu' });
  await daily(page);
  await ready(page, 'Asia/Kathmandu');
  state.offGrid = true;
  await primary(page).getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect(primary(page)).toContainText('The source history is invalid, outside the captured window, or reaches its cap.');
  await expect(primary(page)).toContainText('No derived daily candles are shown.');
  await expect(primary(page).locator('[data-zoned-source]')).toHaveCount(0);
  await expect(primary(page).locator('[data-testid="trade-engine"] canvas')).toHaveCount(0);
  state.offGrid = false;
  await primary(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await ready(page, 'Asia/Kathmandu');
  expect(state.pageErrors).toEqual([]);
  expect(state.writes).toEqual([]);
});
test('captured countdown requests refresh at the next local day without manufacturing a candle', async ({ page }) => {
  const state = await mount(page);
  await daily(page);
  await ready(page);
  const count = state.reads.length;
  await page.clock.setFixedTime(new Date('2026-10-11T04:00:01Z'));
  await expect(primary(page)).toContainText('The local day changed. Refresh daily history');
  expect(state.reads).toHaveLength(count);
  await expect(await inspect(page)).toContainText('80001.000000000000000009');
  expect(state.pageErrors).toEqual([]);
});
test('holding chart uses the same captured daily-zone reader', async ({ page }) => {
  const state = await mount(page, { signedIn: true, path: '/portfolio/BTC', zone: 'Asia/Kathmandu' });
  await daily(page);
  await ready(page, 'Asia/Kathmandu');
  expect(state.reads.at(-1).timeframe).toBe('15m');
  expect(state.reads.at(-1).limit).toBe('500');
  await observedPreferences(page, [{ dailyZone: 'America/New_York' }]);
  await ready(page);
  expect(state.reads.at(-1).timeframe).toBe('1h');
  expect(state.pageErrors).toEqual([]);
});
test('daily preferences preserve the original reviewed draft and client order identity', async ({ page }) => {
  const state = await mount(page, { signedIn: true });
  await daily(page);
  await ready(page);
  const ticket = page.getByRole('region', { name: 'Spot order ticket' });
  await ticket.getByLabel('Price (USDT per BTC)').fill('80000.00');
  await ticket.getByLabel('Amount (BTC)').fill('0.025000');
  await ticket.getByRole('button', { name: 'Review buy', exact: true }).click();
  await expect(ticket.getByRole('heading', { name: 'Review buy', exact: true })).toBeVisible();
  const dialog = ticket.locator('.trade-ticket-body'),
    before = await dialog.innerText(),
    reviewed = state.writes.at(-1).body;
  const journals = await page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => /intent|pending|journal/.test(key))
        .map((key) => [key, localStorage.getItem(key)]),
    ),
  );
  const aliasZone = await page.evaluate(() => new Intl.DateTimeFormat('en', { timeZone: 'CST6CDT' }).resolvedOptions().timeZone);
  await observedPreferences(page, [
    { dailyZone: aliasZone },
    { dailyZone: 'Asia/Kathmandu' },
    { dailyZone: 'America/New_York', timeZone: 'UTC+8' },
  ]);
  await expect(dialog).toBeVisible();
  expect(await dialog.innerText()).toBe(before);
  expect(state.writes.at(-1).body).toBe(reviewed);
  expect(JSON.parse(reviewed)).toMatchObject({
    symbol: 'BTC/USDT',
    price: '80000.00',
    amount: '0.025000',
    clientOrderId: expect.stringMatching(/^desk:/),
  });
  expect(
    await page.evaluate(() =>
      Object.fromEntries(
        Object.keys(localStorage)
          .filter((key) => /intent|pending|journal/.test(key))
          .map((key) => [key, localStorage.getItem(key)]),
      ),
    ),
  ).toEqual(journals);
  expect(state.writes.filter((entry) => entry.pathname === '/api/v1/orders')).toEqual([]);
  await dialog.getByRole('button', { name: 'Place buy', exact: true }).click();
  await expect(page.getByText('Original outcome is unknown.', { exact: true })).toBeVisible();
  const dispatched = state.writes.find((entry) => entry.pathname === '/api/v1/orders').body;
  expect(dispatched).toBe(reviewed);
  const pendingBefore = await page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key.startsWith('trade-pending:'))
        .map((key) => [key, localStorage.getItem(key)]),
    ),
  );
  expect(Object.keys(pendingBefore)).toHaveLength(1);
  await observedPreferences(page, [{ dailyZone: 'Asia/Kathmandu' }, { dailyStart: 'nativeUTC' }]);
  expect(
    await page.evaluate(() =>
      Object.fromEntries(
        Object.keys(localStorage)
          .filter((key) => key.startsWith('trade-pending:'))
          .map((key) => [key, localStorage.getItem(key)]),
      ),
    ),
  ).toEqual(pendingBefore);
  expect(state.writes.filter((entry) => entry.pathname === '/api/v1/orders')).toHaveLength(1);
});
for (const language of ['en', 'es', 'fr'])
  for (const width of [1440, 768, 390, 320]) {
    test(`View and daily chart fit ${width}px in ${language} with focused 44px controls`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const state = await mount(page, { path: '/view', language, signedIn: true });
      const field = page.locator('.daily-zone-form input'),
        apply = page.locator('.daily-zone-form button[type=submit]');
      await field.focus();
      await expect(field).toBeFocused();
      await field.press('Tab');
      await expect(apply).toBeFocused();
      for (const target of [field, apply, page.locator('.daily-zone-actions button').last()]) {
        const box = await target.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `${evidence}/view-${language}-${width}.png`,
        fullPage: true,
        mask: [page.locator('.daily-zone-form input')],
      });
      await page.goto('/exchange');
      await primary(page).locator('[data-testid="trade-chart-toolbar"] select').first().selectOption('1d');
      await expect(primary(page).locator('[data-zoned-source]')).toContainText('America/New_York');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const select = primary(page).locator('[data-testid="trade-chart-toolbar"] select').nth(2),
        bounds = await select.boundingBox();
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `${evidence}/chart-${language}-${width}.png`, fullPage: true, mask: [page.locator('input')] });
      expect(state.pageErrors).toEqual([]);
      expect(state.writes).toEqual([]);
    });
  }
