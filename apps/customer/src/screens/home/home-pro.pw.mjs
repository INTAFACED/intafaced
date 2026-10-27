import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { balances, emptyBalances, hourlyCandles, markets, tickers } from './home.fixtures.mjs';

const shots = process.env.HOME_PRO_SHOTS ?? join(tmpdir(), 'intafaced-home-pro-shots');
mkdirSync(shots, { recursive: true });
const reference = process.env.HOME_PRO_REFERENCE; // optional absolute path to the OKX markets capture (never committed)

const forbidden = /unavailable|not connected|restricted|fixture|lifecycle/i;
const moneyShape = /^[−+]?[$]?[\d,]+(\.\d+)?[%A-Z ]*$|^—$|^••••$/;
const PREFERENCES_KEY = 'intafaced.customer.view.v1';

/** An open order as the exchange sends it (only the count matters to Home Pro). */
const order = (id) => ({
  id,
  clientOrderId: null,
  timestamp: Date.now(),
  datetime: new Date().toISOString(),
  lastTradeTimestamp: null,
  symbol: 'BTC/USDT',
  type: 'limit',
  side: 'buy',
  timeInForce: 'GTC',
  postOnly: false,
  reduceOnly: false,
  price: '60000.00',
  stopPrice: null,
  average: null,
  amount: '0.01',
  filled: '0',
  remaining: '0.01',
  cost: '0',
  status: 'open',
  fee: null,
  trades: [],
  recoveryRequired: false,
  recoveryReason: null,
  reconciliationKey: null,
});

/**
 * Answer the exchange REST calls the data layer makes (/api/v1/markets, /tickers, /account/balance, /ohlcv/<symbol>,
 * /orders/open). An override is a wire JSON body or a function returning one, `null` to hold the request until
 * `release()`, 'error' for a 500, or { status, json } for any other answer. No service is contacted.
 */
const defaults = {
  markets: () => markets,
  tickers: () => tickers(),
  balance: () => balances(),
  ohlcv: (symbol) => hourlyCandles(symbol),
  'orders/open': () => [order('o1'), order('o2')],
};
async function mock(page, overrides = {}) {
  const served = { ...defaults, ...overrides };
  const held = [];
  const seen = [];
  const answer = (route, value, arg) => {
    if (value === 'error') return route.fulfill({ status: 500, body: 'no' });
    if (value && typeof value === 'object' && 'status' in value && 'json' in value)
      return route.fulfill({ status: value.status, json: value.json });
    return route.fulfill({ status: 200, json: typeof value === 'function' ? value(arg) : value });
  };
  // The services' own reads (tRPC) are not mocked here: they answer 404 as a missing build would, never the dev server's page.
  await page.route('**/api/*/trpc/**', (route) => route.fulfill({ status: 404, json: { error: { message: 'not mocked' } } }));
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/v1\//, '');
    const name = path.startsWith('ohlcv/') ? 'ohlcv' : path === 'account/balance' ? 'balance' : path;
    const arg = name === 'ohlcv' ? decodeURIComponent(path.slice('ohlcv/'.length)) : undefined;
    seen.push(path);
    if (!(name in served)) return route.fulfill({ status: 404, json: { error: { message: 'not mocked' } } });
    if (served[name] === null) return void held.push({ route, name, arg });
    return answer(route, served[name], arg);
  });
  return {
    seen,
    /** Answer every held request, and every later one, with the normal data. */
    release: async () => {
      for (const name of Object.keys(served)) if (served[name] === null) served[name] = defaults[name];
      for (const { route, name, arg } of held.splice(0)) await answer(route, defaults[name], arg);
    },
  };
}
const pro = (page) => page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ layoutMode: 'pro' })), PREFERENCES_KEY);
/** A device that chose Simple before (Simple is also the default, preferences.ts). Set once, so a reload keeps what the page stored. */
const simple = (page) =>
  page.addInitScript(
    (key) => localStorage.getItem(key) ?? localStorage.setItem(key, JSON.stringify({ layoutMode: 'simple' })),
    PREFERENCES_KEY,
  );
const open = async (page, query = '') => {
  await page.goto(`/pro.html${query}`);
  await page.getByTestId('tb').waitFor();
};
const openPro = async (page) => {
  await pro(page);
  await open(page);
  await page.getByTestId('if-home-pro').waitFor();
};
const texts = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
const box = async (page, selector) => await page.locator(selector).first().boundingBox();
const heroText = (page) =>
  page.locator('[data-slot="hero-number"]').evaluate((node) => {
    const figure = node.querySelector('[role="img"]')?.getAttribute('aria-label') ?? node.firstElementChild?.textContent ?? '';
    return figure.trim();
  });
const expectHero = (page, text) => expect.poll(() => heroText(page).catch(() => null), { timeout: 7000 }).toBe(text);
const ready = (page) => expect(page.getByTestId('hp-markets').locator('[role="row"][data-symbol]').first()).toBeVisible();
/** Nothing in Home Pro reaches past the window, and the page itself does not scroll sideways. */
const noOverflow = async (page, label) => {
  const wide = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="if-home-pro"], [data-testid="if-home-pro"] *')]
      .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 4)
      .map((node) => `${node.tagName}.${typeof node.className === 'string' ? node.className : ''}`),
  );
  expect(wide, `${label}, too wide`).toEqual([]);
};
const shotBoth = async (page, name) => {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(size);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(shots, `${name}-${size.width}x${size.height}.png`) });
  }
};

test('ready state at 1440x900: summary, assets, markets, words, numbers', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && !/404|not mocked/.test(message.text()) && errors.push(message.text()));
  await mock(page);
  await openPro(page);
  await ready(page);
  const home = page.getByTestId('if-home-pro');
  await expect(page.getByTestId('if-home')).toHaveCount(0); // Simple Home is not drawn in Pro mode

  // Summary strip: the total, today's change, Cash, Crypto, open orders, and the actions at the right end.
  await expectHero(page, '$12,481.29');
  const summary = page.getByTestId('hp-summary');
  await expect(summary).toContainText('Est. total value');
  await expect(summary.locator('[data-slot="change-text"]')).toContainText('+$206.29');
  await expect(summary.locator('[data-slot="change-text"]')).toContainText('+1.68%');
  await expect(summary).toContainText('Today, from price moves');
  expect(await texts(page.getByTestId('hp-stat__label'))).toEqual(['Cash', 'Crypto', 'Open orders']);
  expect(await texts(page.getByTestId('hp-stat__value'))).toEqual(['$4,100.00', '$8,381.29', '2']);
  await expect(page.getByTestId('hp-stat__link')).toHaveAttribute('href', '/money/activity?tab=orders');
  // Only live actions, Buy is the one primary.
  expect(await texts(page.locator('[data-testid="hp-actions"] > *'))).toEqual(['Buy', 'Sell', 'Convert', 'Send', 'Receive']);
  expect(await page.getByTestId('hp-actions').locator('a[data-variant="primary"]').count()).toBe(1);
  await expect(page.getByTestId('hp-actions').locator('a').nth(0)).toHaveAttribute('href', '/trade/spot/BTC-USDT');
  expect(
    await page
      .locator('[data-testid="hp-actions"] > *')
      .first()
      .evaluate((node) => getComputedStyle(node).color),
  ).toBe('rgb(11, 11, 11)');
  expect(Math.round((await box(page, '[data-testid="hp-actions"] a')).height)).toBe(32);
  expect(Math.round((await box(page, '[data-testid="hp-summary"]')).height)).toBeGreaterThanOrEqual(96);
  expect(Math.round((await box(page, '[data-testid="hp-summary"]')).height)).toBeLessThanOrEqual(112);
  // Actions sit at the right end of the strip.
  const strip = await box(page, '[data-testid="hp-summary"]');
  const actions = await box(page, '[data-testid="hp-actions"]');
  expect(Math.round(strip.x + strip.width - 24 - (actions.x + actions.width))).toBe(0);

  // Assets: asset, amount (rounded down), value, today's change, link to the desk.
  const assets = page.getByTestId('hp-assets');
  expect(await texts(assets.locator('[role="columnheader"]'))).toEqual(['Asset', 'Amount', 'Value', 'Today', 'Trade']);
  const rows = assets.locator('[role="row"][data-asset]');
  expect(await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.asset))).toEqual(['BTC', 'USDT', 'ETH']); // biggest value first;
  const cells = async (asset) => texts(assets.locator(`[data-asset="${asset}"] [role="cell"]`));
  expect(await cells('BTC')).toEqual(['BTCBitcoin', '0.1', '$6,781.24', '+2.75%', 'Trade']);
  expect(await cells('ETH')).toEqual(['ETHEthereum', '0.5', '$1,600.05', '+1.59%', 'Trade']);
  expect((await cells('USDT'))[0]).toBe('USDTTether');
  expect((await cells('USDT'))[4]).toBe(''); // cash has no market to open
  // The asset name opens the desk for its market (the coin page is M3; critic H3).
  await expect(assets.locator('[data-asset="BTC"] a').first()).toHaveAttribute('href', '/trade/spot/BTC-USDT');
  await expect(assets.locator('[data-asset="BTC"] [data-slot="button"]')).toHaveAttribute('href', '/trade/spot/BTC-USDT');
  await expect(assets.locator('[data-asset="ETH"] [data-slot="button"]')).toHaveAttribute('href', '/trade/spot/ETH-USDT');
  expect(Math.round((await box(page, '[data-testid="hp-assets__row"]')).height)).toBe(48);
  // Numbers line up on the right edge of their column.
  const rights = await assets
    .locator('[role="cell"]:nth-child(3)')
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().right)));
  expect(new Set(rights).size).toBe(1);

  // Markets: the shared table in Pro form, columns from the OKX markets list, the action says "Trade".
  const table = page.getByTestId('hp-markets').locator('[role="table"]');
  expect(await texts(table.locator('[role="columnheader"]'))).toEqual(['Name', 'Price', '24h change', 'Last 24h', '24h range', 'Action']);
  expect(await texts(page.getByTestId('hp-markets').locator('[role="tab"]'))).toEqual(['Favorites', 'All', 'Gainers', 'Losers']);
  await expect(page.getByTestId('hp-markets').locator('[role="tab"][aria-selected="true"]')).toHaveText('All');
  const symbols = await page
    .getByTestId('hp-markets')
    .locator('[role="row"][data-symbol]')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.symbol));
  expect(symbols.length).toBeGreaterThan(3);
  expect(symbols.length).toBeLessThanOrEqual(10);
  await expect(page.getByTestId('hp-markets').locator('[role="row"][data-symbol]').first()).toContainText('Trade');
  await expect(page.getByTestId('hp-markets').locator('[data-slot="sparkline"] polyline').first()).toBeVisible();
  await expect(page.getByTestId('hp-markets').getByTestId('hp-link')).toHaveAttribute('href', '/trade');
  // The 24h-change column is signed; a star is on every row.
  expect(await texts(page.getByTestId('hp-markets').locator('[data-slot="pct"]'))).toContain('▲+2.75%');

  // Order on the page: summary -> assets -> markets.
  const ys = await page.evaluate(() =>
    ['[data-testid="hp-summary"]', '[data-testid="hp-assets"]', '[data-testid="hp-markets"] [role="table"]'].map(
      (selector) => document.querySelector(selector).getBoundingClientRect().top,
    ),
  );
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  // 24 px gutters at 1440 (the page is full width up to 1600).
  const frame = await box(page, '[data-testid="if-home-pro"]');
  expect([Math.round(frame.x), Math.round(frame.width)]).toEqual([24, 1392]);

  // Plain words only, and every money figure has the money shape.
  expect(await home.innerText()).not.toMatch(forbidden);
  for (const value of await texts(
    page.locator('[data-testid="if-home-pro"] [data-slot="money"], [data-testid="if-home-pro"] [data-money]'),
  ))
    expect(value, `money shape: ${value}`).toMatch(moneyShape);

  // Keyboard: Tab from the top bar reaches eye -> info tips -> actions -> Open orders -> View all assets -> asset rows.
  await page.locator('[data-testid="tb-right"] button').last().focus();
  const path = [];
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const node = document.activeElement;
      const style = getComputedStyle(node);
      return {
        name: node.getAttribute('aria-label') ?? node.textContent.trim().replace(/\s+/g, ' ').slice(0, 24),
        href: node.getAttribute('href'),
        outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
        inside: Boolean(node.closest('[data-testid="if-home-pro"]')),
      };
    });
    if (!stop.inside) continue;
    expect(stop.outline, `focus ring on ${stop.name}`).toBe('solid 2px rgb(200, 246, 74)');
    path.push(stop);
    if (path.length >= 12) break;
  }
  expect(path.map((stop) => stop.name).slice(0, 9)).toEqual([
    'Customise Home',
    'Hide balances',
    'How the total is worked out',
    'Assets',
    'About this change',
    'Named spaces not included',
    '2 open orders',
    'Buy',
    'Sell',
  ]);

  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500); // the tip the keyboard walk opened fades out
  await page.screenshot({ path: join(shots, 'home-pro-1440x900.png') });
  await page.screenshot({ path: join(shots, 'home-pro-1440-full.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: join(shots, 'home-pro-1280x800.png') });
  await noOverflow(page, '1280');
  expect(errors).toEqual([]);

  if (reference) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: join(shots, 'home-pro-1440x900.png') });
    const ours = readFileSync(join(shots, 'home-pro-1440x900.png')).toString('base64');
    const theirs = readFileSync(reference).toString('base64');
    const compare = await page.context().newPage();
    await compare.setViewportSize({ width: 2900, height: 940 });
    await compare.setContent(`<body style="margin:0;background:rgb(0 0 0);color:rgb(144 144 144);font:12px sans-serif;display:flex;gap:16px;padding:16px">
      <figure style="margin:0"><img src="data:image/png;base64,${ours}" style="width:1440px;display:block;border:1px solid rgb(46 46 46)"><figcaption style="padding-top:6px">INTAFACED (local test, mocked data)</figcaption></figure>
      <figure style="margin:0"><img src="data:image/png;base64,${theirs}" style="width:1440px;display:block;border:1px solid rgb(46 46 46)"><figcaption style="padding-top:6px">Reference: OKX markets list, captured 2026-10-13</figcaption></figure></body>`);
    await compare.screenshot({ path: join(shots, 'side-by-side-okx-markets.png') });
    await compare.close();
  }
});

test('the Simple / Pro switch changes Home at once, is remembered, and says what changes', async ({ page }) => {
  await mock(page);
  await simple(page);
  await open(page);
  await expect(page.getByTestId('if-home')).toBeVisible();
  await expect(page.getByTestId('if-home-pro')).toHaveCount(0);

  const group = page.getByRole('group', { name: 'Simple or Pro layout' });
  await expect(group).toBeVisible();
  await expect(group).toContainText('Simple');
  await expect(group).toContainText('Pro');
  expect(Math.round((await group.boundingBox()).height)).toBe(28);
  await expect(group.getByRole('button', { name: 'Simple' })).toHaveAttribute('aria-pressed', 'true');

  // The tooltip says what changes (opens on hover, and on keyboard focus).
  await group.hover();
  const tip = page.locator('[data-slot="tooltip-content"][data-open]');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Simple keeps things calm');
  await expect(tip).toContainText('Pro is denser');
  expect((await tip.boundingBox()).y).toBeGreaterThanOrEqual(38); // below the switch, never over it
  await page.screenshot({ path: join(shots, 'switch-tooltip-1440x900.png'), clip: { x: 800, y: 0, width: 640, height: 200 } });

  // Pro: Home changes immediately, without a reload.
  await group.getByRole('button', { name: 'Pro' }).click();
  await expect(page.getByTestId('if-home-pro')).toBeVisible();
  await expect(page.getByTestId('if-home')).toHaveCount(0);
  await expect(group.getByRole('button', { name: 'Pro' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).layoutMode, PREFERENCES_KEY)).toBe('pro');

  // Remembered on the device.
  await page.reload();
  await page.getByTestId('if-home-pro').waitFor();
  await expect(page.getByRole('group', { name: 'Simple or Pro layout' }).getByRole('button', { name: 'Pro' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Back to Simple.
  await page.getByRole('group', { name: 'Simple or Pro layout' }).getByRole('button', { name: 'Simple' }).click();
  await expect(page.getByTestId('if-home')).toBeVisible();
  await expect(page.getByTestId('if-home-pro')).toHaveCount(0);

  // Keyboard: the switch is reachable with Tab and Enter flips it.
  await page.getByRole('group', { name: 'Simple or Pro layout' }).getByRole('button', { name: 'Simple' }).focus();
  await page.keyboard.press('ArrowRight'); // a keyboard move inside the group, so the focus ring shows
  const ring = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return { name: document.activeElement.textContent, ring: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}` };
  });
  await page.waitForTimeout(400); // the outline colour fades in
  const settled = await page.evaluate(() => getComputedStyle(document.activeElement).outlineColor);
  expect(ring.name).toBe('Pro');
  expect(settled).toBe('rgb(200, 246, 74)');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('if-home-pro')).toBeVisible();
});

test('the switch also changes the Trade list: Buy in Simple, Trade in Pro', async ({ page }) => {
  await mock(page);
  await simple(page);
  await open(page, '?screen=trade');
  // BTC's row in the full Markets table (the Popular and Top gainers cards above it carry no action).
  const row = page
    .getByRole('grid', { name: 'Markets' })
    .getByRole('row', { name: /BTC\/USDT/ })
    .first();
  await expect(row.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
  await page.getByRole('group', { name: 'Simple or Pro layout' }).getByRole('button', { name: 'Pro' }).click();
  await expect(row.getByRole('button', { name: 'Trade BTC/USDT' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Buy BTC' })).toHaveCount(0);
  await page.mouse.move(0, 300);
  await page.screenshot({ path: join(shots, 'trade-list-pro-1440x900.png') });
  await page.getByRole('group', { name: 'Simple or Pro layout' }).getByRole('button', { name: 'Simple' }).click();
  await expect(row.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
});

test('the switch is hidden below 1000px, where the top bar has no room for it', async ({ page }) => {
  await mock(page);
  for (const width of [390, 768, 999]) {
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    await expect(page.getByRole('group', { name: 'Simple or Pro layout' })).toBeHidden();
  }
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(page.getByRole('group', { name: 'Simple or Pro layout' })).toBeVisible();
});

test('below 1000px the same switch is in the account menu, so Pro can always be left (review M2)', async ({ page }) => {
  await mock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await pro(page); // a device that chose Pro: a new device opens in Simple
  await open(page);
  await expect(page.getByTestId('if-home-pro')).toBeVisible();
  await page.getByRole('button', { name: 'Account menu' }).click();
  const group = page.getByRole('group', { name: 'Simple or Pro layout' });
  await expect(group).toBeVisible();
  await expect(group.getByRole('button', { name: 'Pro' })).toHaveAttribute('aria-pressed', 'true');
  await group.getByRole('button', { name: 'Simple' }).click();
  await expect(page.getByTestId('if-home')).toBeVisible();
  await group.getByRole('button', { name: 'Pro' }).click();
  await expect(page.getByTestId('if-home-pro')).toBeVisible();
  // On a wide bar the menu does not repeat it: the bar's own switch is the only one.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('group', { name: 'Simple or Pro layout' })).toHaveCount(1);
});

test('hidden balances show bullets and prices stay', async ({ page }) => {
  await mock(page);
  await openPro(page);
  await ready(page);
  await page.getByRole('button', { name: 'Hide balances' }).click();
  await expectHero(page, '$••••');
  expect(await texts(page.getByTestId('hp-stat__value').locator('[data-slot="money"]'))).toEqual(['••••', '••••']);
  await expect(page.getByTestId('hp-assets')).not.toContainText('6,781');
  await expect(page.getByTestId('hp-assets')).not.toContainText('0.5');
  await expect(page.getByTestId('hp-summary').locator('[data-slot="change-text"]')).not.toContainText('206');
  await expect(page.getByTestId('hp-markets').locator('[role="row"][data-symbol]').first()).toContainText('$'); // prices still show
  for (const value of await texts(
    page.locator('[data-testid="if-home-pro"] [data-slot="money"], [data-testid="if-home-pro"] [data-slot="amount"]'),
  ))
    expect(value).toMatch(moneyShape);
  await page.getByRole('button', { name: 'Show balances' }).click();
  await expectHero(page, '$12,481.29');
});

test('loading shows final-size skeletons and nothing moves when data arrives', async ({ page }) => {
  const api = await mock(page, { balance: null, markets: null, tickers: null, ohlcv: null, 'orders/open': null });
  await openPro(page);
  await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
  const hero = await page.getByTestId('hp-total__figure').locator('[data-slot="skeleton"]').boundingBox();
  expect([Math.round(hero.width), Math.round(hero.height)]).toEqual([200, 40]);
  expect(await page.getByTestId('hp-assets').locator('[data-slot="skeleton"]').count()).toBeGreaterThan(5);
  expect(await page.getByTestId('hp-markets').locator('[role="table"] [data-slot="skeleton"]').count()).toBeGreaterThan(8);
  // A skeleton inside a panel is the field colour, not the panel's own (it would be invisible): summary, assets, markets.
  const panelColour = await page
    .locator(':is([data-testid="hp-assets-panel"], [data-testid="hp-markets"], [data-testid="hp-activity"], [data-testid="hp-work"])')
    .first()
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  for (const selector of ['[data-testid="hp-summary"]', '[data-testid="hp-assets"]', '[data-testid="hp-markets"] [role="table"]'])
    expect(
      await page
        .locator(`${selector} [data-slot="skeleton"]`)
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor),
      selector,
    ).not.toBe(panelColour);
  const layout = () =>
    page.evaluate(() =>
      [
        '[data-testid="hp-summary"]',
        '[data-testid="hp-assets"]',
        '[data-testid="hp-markets"]',
        '[data-testid="hp-markets"] [data-testid="mkt-header"]',
      ].map((selector) => Math.round(document.querySelector(selector).getBoundingClientRect().top)),
    );
  const before = await layout();
  const sizes = () =>
    page.evaluate(() =>
      ['[data-testid="hp-summary"]', '[data-testid="hp-assets__row"]'].map((s) =>
        Math.round(document.querySelector(s).getBoundingClientRect().height),
      ),
    );
  const beforeSizes = await sizes();
  await shotBoth(page, 'home-pro-loading');
  await page.setViewportSize({ width: 1440, height: 900 });
  await api.release();
  await ready(page);
  await expectHero(page, '$12,481.29');
  await expect(page.getByTestId('hp-stat__value').last()).toHaveText('2');
  // The summary, the assets and the markets header did not move when the data arrived (3 rows loaded as 3 rows).
  expect(await layout()).toEqual(before);
  expect(await sizes()).toEqual(beforeSizes);
});

test('empty account: zero is shown once, with one plain line and only Add money, Receive and Buy', async ({ page }) => {
  await mock(page, { balance: () => emptyBalances(), 'orders/open': () => [] });
  await openPro(page);
  await expectHero(page, '$0.00');
  await expect(page.getByTestId('hp-total__note')).toHaveText(/Your account is empty/);
  expect(await texts(page.locator('[data-testid="hp-actions"] > *'))).toEqual(['Add money', 'Receive', 'Buy']);
  await expect(page.getByTestId('hp-assets')).toHaveCount(0); // nothing to list
  await ready(page); // markets still render
  expect(await page.getByTestId('if-home-pro').innerText()).not.toMatch(forbidden);
  await shotBoth(page, 'home-pro-empty');
});

test('refused balance: plain panel with its words, no raw code, markets still render', async ({ page }) => {
  await mock(page, {
    balance: { status: 403, json: { error: { message: 'denied', data: { intafacedCode: 'denied.screening_fixture' } } } },
  });
  await openPro(page);
  const block = page.getByTestId('hp-summary').locator('[data-slot="state-block"]');
  await expect(block).toContainText('Paused for account checks');
  await expect(block).not.toContainText('denied.screening_fixture');
  await expect(block).not.toContainText(forbidden);
  expect(await texts(page.locator('[data-testid="hp-actions"] > *'))).toEqual(['Receive']);
  await expect(page.getByTestId('hp-assets')).toHaveCount(0);
  await ready(page);
  await shotBoth(page, 'home-pro-refused');
});

test('failed balance call offers "Try again", which works', async ({ page }) => {
  let fail = true;
  await mock(page, { balance: () => (fail ? { __fail: true } : balances()) });
  // A function answer cannot send a 500, so route the balance call by hand.
  await page.route('**/api/v1/account/balance', (route) =>
    fail ? route.fulfill({ status: 500, body: 'no' }) : route.fulfill({ status: 200, json: balances() }),
  );
  await openPro(page);
  const block = page.getByTestId('hp-summary').locator('[data-slot="state-block"]');
  await expect(block).toContainText('Couldn’t load your balance');
  await shotBoth(page, 'home-pro-error');
  fail = false;
  await block.getByRole('button', { name: 'Try again' }).click();
  await expectHero(page, '$12,481.29');
});

test('a failed orders call just leaves the open orders count out', async ({ page }) => {
  await mock(page, { 'orders/open': 'error' });
  await openPro(page);
  await expectHero(page, '$12,481.29');
  expect(await texts(page.getByTestId('hp-stat__label'))).toEqual(['Cash', 'Crypto']);
  await expect(page.getByTestId('hp-assets').locator('[role="row"][data-asset="BTC"]')).toBeVisible();
  await ready(page);
});

test('failed markets call: the markets panel says so with "Try again"; the page does not go blank', async ({ page }) => {
  await mock(page, { markets: 'error' });
  await openPro(page);
  await expect(page.getByTestId('hp-markets').locator('[data-slot="state-block"]')).toContainText('Couldn’t load markets');
  await expect(
    page.getByTestId('hp-markets').locator('[data-slot="state-block"]').getByRole('button', { name: 'Try again' }),
  ).toBeVisible();
  await expect(page.getByTestId('hp-summary')).toBeVisible();
  await shotBoth(page, 'home-pro-markets-error');
});

test('markets tabs filter the table; Favorites is empty until a star is added', async ({ page }) => {
  await mock(page);
  await openPro(page);
  await ready(page);
  const symbolsOf = () =>
    page
      .getByTestId('hp-markets')
      .locator('[role="row"][data-symbol]')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.symbol));
  const all = await symbolsOf();
  await page.getByRole('tab', { name: 'Favorites' }).click();
  await expect(page.getByTestId('hp-markets').locator('[data-slot="state-block"]')).toContainText('Star a market to keep it here.');
  await page.getByRole('tab', { name: 'Gainers' }).click();
  const gainers = await symbolsOf();
  expect(gainers.length).toBeGreaterThan(0);
  expect(gainers.length).toBeLessThan(all.length);
  expect(gainers[0]).toBe('BTC-USDT'); // biggest gain first
  await page.getByRole('tab', { name: 'Losers' }).click();
  expect(await symbolsOf()).toEqual(['DOGE-USDT', 'IFC-USDT']);
  await page.getByRole('tab', { name: 'All' }).click();
  // A star puts the market into Favorites.
  await page.getByTestId('hp-markets').locator('[role="row"][data-symbol="ETH-USDT"] [aria-label^="Add"]').click();
  await page.getByRole('tab', { name: 'Favorites' }).click();
  expect(await symbolsOf()).toEqual(['ETH-USDT']);
  await shotBoth(page, 'home-pro-favorites');
});

test('responsive: no horizontal page scroll from 1280 down to 390', async ({ page }) => {
  await mock(page);
  await pro(page);
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1180, height: 800 },
    { width: 1024, height: 800 },
    { width: 768, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await open(page);
    await ready(page);
    await noOverflow(page, `${size.width}px`);
    await page.screenshot({ path: join(shots, `home-pro-${size.width}x${size.height}.png`), fullPage: size.width < 800 });
  }
});
