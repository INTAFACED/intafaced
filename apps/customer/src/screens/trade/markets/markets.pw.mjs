import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manyMarkets, markets, tickers } from './markets.fixtures.mjs';

const shots = process.env.MARKETS_SHOTS ?? join(tmpdir(), 'intafaced-markets-shots');
mkdirSync(shots, { recursive: true });
const reference = process.env.MARKETS_REFERENCE; // optional absolute path to the OKX markets capture (never committed)

const forbidden = /unavailable|not connected|restricted|fixture|lifecycle|simulated/i;
const moneyShape = /^[−+]?[$]?[\d,]+(\.\d+)?[%A-Z ]*$|^—$|^••••$/;
const FAVORITES_KEY = 'trade-favorites:00000000-0000-4000-8000-000000000001';

/**
 * Answer the exchange REST calls the data layer makes (/api/v1/markets, /tickers, /ohlcv/<symbol>).
 * An override is a wire JSON body or a function returning one, `null` to hold the request until `release()`,
 * 'error' for a 500, or { status, json } for any other answer. No service is contacted.
 */
const defaults = { markets: () => markets, tickers: () => tickers(), ohlcv: () => [] };
async function mock(page, overrides = {}) {
  const served = { ...defaults, ...overrides };
  const held = [];
  const seen = [];
  const answer = (route, value) => {
    if (value === 'error') return route.fulfill({ status: 500, body: 'no' });
    if (value && typeof value === 'object' && 'status' in value && 'json' in value)
      return route.fulfill({ status: value.status, json: value.json });
    return route.fulfill({ status: 200, json: typeof value === 'function' ? value() : value });
  };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/v1\//, '');
    const name = path.startsWith('ohlcv/') ? 'ohlcv' : path;
    seen.push(path);
    if (!(name in served)) return route.fulfill({ status: 404, json: { error: { message: 'not mocked' } } });
    if (served[name] === null) return void held.push({ route, name });
    return answer(route, served[name]);
  });
  return {
    seen,
    release: async () => {
      for (const name of Object.keys(served)) if (served[name] === null) served[name] = defaults[name];
      for (const { route, name } of held.splice(0)) await answer(route, defaults[name]);
    },
  };
}
const open = async (page, query = '') => {
  await page.goto(`/${query}`);
  await page.getByTestId('if-markets').waitFor();
};
const pro = (page) => page.addInitScript(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ layoutMode: 'pro' })));
const texts = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
const rowSymbols = (page) => page.locator('[role="row"][data-symbol]').evaluateAll((nodes) => nodes.map((node) => node.dataset.symbol));
const ready = (page) => expect(page.locator('[role="row"][data-symbol]').first()).toBeVisible();
const box = async (page, selector) => await page.locator(selector).first().boundingBox();

// Volume order of the fixtures: BTC, ETH, SOL, XRP, DOGE, IFC (USDT), then the two USDC markets.
const DEFAULT_ORDER = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT', 'IFC/USDT', 'BTC/USDC', 'ETH/USDC'];

test('ready state at 1440x900: layout, words, numbers, keyboard path', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await mock(page);
  await open(page);
  await ready(page);
  const root = page.getByTestId('if-markets');

  // Only open, real, orderable markets: the simulated, halted and locked ones are not listed.
  expect(await rowSymbols(page)).toEqual(DEFAULT_ORDER);
  expect(await root.innerText()).not.toMatch(forbidden);

  // Order on the page: cards -> tabs -> chips -> table.
  const ys = await page.evaluate(() =>
    ['[data-testid="mkt-cards"]', '[data-testid="mkt-tabs"]', '[data-testid="mkt-chips"]', '[data-testid="mkt-header"]'].map(
      (selector) => document.querySelector(selector).getBoundingClientRect().top,
    ),
  );
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);

  // Cards: Popular, New listings, Top gainers; one row per coin; 224 high; three across.
  expect(await texts(page.getByTestId('mkt-card__head').locator('h2'))).toEqual(['Popular', 'New listings', 'Top gainers']);
  expect(await texts(page.locator('[data-card="popular"] [data-testid="mkt-card__name"]'))).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
  expect(await texts(page.locator('[data-card="new"] [data-testid="mkt-card__name"]'))).toEqual(['IFC/USDT', 'SOL/USDT']);
  expect(await texts(page.locator('[data-card="gainers"] [data-testid="mkt-card__name"]'))).toEqual(['BTC/USDT', 'XRP/USDT', 'SOL/USDT']);
  expect(await texts(page.locator('[data-card="gainers"] [data-slot="pct"]'))).toEqual(['+2.75%', '+2.15%', '+1.75%']);
  const card = await box(page, '[data-testid="mkt-card"]');
  expect(Math.round(card.height)).toBe(224);
  expect(Math.round((await box(page, '[data-testid="if-markets"]')).width)).toBe(1392);
  expect(Math.round(card.width)).toBe(Math.round((1392 - 48) / 3));
  expect(Math.round((await box(page, '[data-testid="mkt-card__row"]')).height)).toBe(52);

  // Tabs and chips.
  expect(await texts(page.locator('[data-slot="tabs-tab"]'))).toEqual(['Favorites', 'Spot']);
  await expect(page.locator('[data-slot="tabs-tab"][data-active]')).toHaveText('Spot');
  expect(await texts(page.getByTestId('mkt-chips').locator('[data-slot="toggle-group-item"]'))).toEqual([
    'All',
    'Gainers',
    'Losers',
    'New',
    'USDT',
    'USDC',
  ]);

  // Header: 40 px, names in the OKX order (minus market cap); rows are 60 px.
  expect(await texts(page.getByTestId('mkt-header').locator('[role="columnheader"]'))).toEqual([
    'Name',
    'Price',
    '24h change',
    'Last 24h',
    '24h range',
    '24h volume',
    'Action',
  ]);
  expect(Math.round((await box(page, '[data-testid="mkt-header"]')).height)).toBe(40);
  const row = await box(page, '[role="row"][data-symbol]');
  expect(Math.round(row.height)).toBe(60);
  expect(Math.round(row.width)).toBe(1392);

  // First row figures, from the wire numbers (no floats): open 66000.00, last 67812.40.
  const btc = page.locator('[data-symbol="BTC/USDT"]');
  await expect(btc.getByTestId('mkt-name__ticker')).toHaveText('BTC/USDT');
  await expect(btc.getByTestId('mkt-name__full')).toHaveText('Bitcoin');
  await expect(btc.locator('[data-slot="price"]')).toHaveText('$67,812.40');
  await expect(btc.locator('[data-slot="pct"]')).toHaveText('▲+2.75%'); // the arrow is a second cue beside the sign
  await expect(page.locator('[data-symbol="IFC/USDT"] [data-slot="pct"]')).toHaveText('▼−2.14%');
  await expect(page.locator('[data-symbol="IFC/USDT"] [data-slot="price"]')).toHaveText('$0.4120');
  await expect(btc.locator('[data-slot="volume"]')).toHaveText('$91.2M');
  await expect(btc.getByTestId('mkt-range__ends')).toHaveText('$65,800.00$68,200.00');
  await expect(btc.getByTestId('mkt-range__marker')).toHaveAttribute('style', /left: 8\d\.\d+%/);
  expect(await page.getByTestId('mkt-row').locator('[data-slot="sparkline"] polyline').count()).toBe(8);

  // Simple mode (default), signed in: the row and the Buy button open the coin page (it needs a session).
  await expect(btc.locator('[data-row-link]')).toHaveAttribute('href', '/coin/BTC');
  await expect(btc.locator('[data-col="action"] a')).toHaveCount(2);
  await expect(btc.locator('[data-col="action"] a').nth(0)).toHaveText('Buy');
  await expect(btc.locator('[data-col="action"] a').nth(0)).toHaveAttribute('href', '/coin/BTC');
  await expect(btc.locator('[data-col="action"] a').nth(1)).toHaveText('Details');
  // Critic H1/H2: the Buy label is readable and kit sizes are true px.
  expect(Math.round((await box(page, '[data-symbol="BTC/USDT"] [data-col="action"] a'))?.height)).toBe(32);

  // Plain words, money shapes.
  for (const value of await texts(page.locator('[data-slot="price"], [data-money], [data-slot="volume"]')))
    expect(value, `money shape: ${value}`).toMatch(moneyShape);

  // Numbers are right-aligned in the header and the cells.
  const align = await page.evaluate(() => [
    getComputedStyle(document.querySelector('[data-testid="mkt-head--num"]')).textAlign,
    getComputedStyle(document.querySelector('[data-testid="mkt-cell--num"]')).justifyContent,
  ]);
  expect(align).toEqual(['right', 'flex-end']);

  // Keyboard: Tab reaches the tabs, search, chips, sort buttons, then the first row (link, star, Buy).
  await page.getByTestId('harness-bar').locator('a').last().focus();
  const path = [];
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(180); // the kit's controls fade their outline colour in (120 ms)
    const stop = await page.evaluate(() => {
      const node = document.activeElement;
      const style = getComputedStyle(node);
      return {
        name: node.getAttribute('aria-label') ?? node.textContent.trim().replace(/\s+/g, ' ').slice(0, 30),
        href: node.getAttribute('href'),
        outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
        after: getComputedStyle(node, '::after').outlineStyle,
        inside: Boolean(node.closest('[data-testid="if-markets"]')),
      };
    });
    if (!stop.inside) break;
    path.push(stop);
    if (stop.name === 'Buy BTC') break;
  }
  const names = path.map((stop) => stop.name);
  expect(names[0]).toBe('See all Popular'); // then the three rows of that card
  expect(names).toEqual(expect.arrayContaining(['See all New listings', 'See all Top gainers']));
  expect(names).toContain('Search markets');
  expect(names).toContain('Sort by Name');
  const rowStops = path.slice(path.findIndex((stop) => stop.href === '/coin/BTC' && stop.name.startsWith('BTC')));
  expect(rowStops.map((stop) => stop.name)).toEqual(expect.arrayContaining(['Add BTC to favorites', 'Buy BTC']));
  // Focus ring: 2 px lime on controls; the stretched row link draws it on its ::after.
  for (const stop of path.filter((s) => !(s.href?.startsWith('/trade/') || s.href?.startsWith('/coin/')) || s.name.startsWith('Buy'))) {
    expect(stop.outline, `focus ring on ${stop.name}`).toBe('solid 2px rgb(200, 246, 74)');
  }

  // Arrow keys move between rows; Enter on the focused row link opens its action.
  await page.locator('[data-symbol="BTC/USDT"] [data-row-link]').focus();
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => document.activeElement.closest('[role="row"]').dataset.symbol)).toBe('ETH/USDT');
  await page.keyboard.press('ArrowUp');
  expect(await page.evaluate(() => document.activeElement.closest('[role="row"]').dataset.symbol)).toBe('BTC/USDT');
  await page.keyboard.press('End');
  expect(await page.evaluate(() => document.activeElement.closest('[role="row"]').dataset.symbol)).toBe('ETH/USDC');

  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  await page.locator('[data-symbol="ETH/USDT"]').hover();
  await page.screenshot({ path: join(shots, 'markets-1440x900.png') });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(shots, 'markets-1440-full.png'), fullPage: true });
  expect(errors).toEqual([]);

  if (reference) {
    const ours = readFileSync(join(shots, 'markets-1440x900.png')).toString('base64');
    const theirs = readFileSync(reference).toString('base64');
    const compare = await page.context().newPage();
    await compare.setViewportSize({ width: 2900, height: 940 });
    await compare.setContent(`<body style="margin:0;background:rgb(0 0 0);color:rgb(144 144 144);font:12px sans-serif;display:flex;gap:16px;padding:16px">
      <figure style="margin:0"><img src="data:image/png;base64,${ours}" style="width:1440px;display:block;border:1px solid rgb(46 46 46)"><figcaption style="padding-top:6px">INTAFACED (mocked data)</figcaption></figure>
      <figure style="margin:0"><img src="data:image/png;base64,${theirs}" style="width:1440px;display:block;border:1px solid rgb(46 46 46)"><figcaption style="padding-top:6px">Reference: OKX markets page</figcaption></figure></body>`);
    await compare.screenshot({ path: join(shots, 'side-by-side-markets.png') });
    await compare.close();
  }
});

test('Pro mode: the action is Trade and every link goes to the desk', async ({ page }) => {
  await pro(page);
  await mock(page);
  await open(page);
  await ready(page);
  const btc = page.locator('[data-symbol="BTC/USDT"]');
  await expect(btc.locator('[data-col="action"] a').nth(0)).toHaveText('Trade');
  await expect(btc.locator('[data-col="action"] a').nth(0)).toHaveAttribute('href', '/trade/spot/BTC-USDT');
  await expect(btc.locator('[data-row-link]')).toHaveAttribute('href', '/trade/spot/BTC-USDT');
  await expect(page.locator('[data-symbol="BTC/USDC"] [data-row-link]')).toHaveAttribute('href', '/trade/spot/BTC-USDC');
  await expect(page.locator('[data-card="popular"] a').first()).toHaveAttribute('href', '/trade/spot/BTC-USDT');
  await page.screenshot({ path: join(shots, 'markets-state-pro.png') });
});

test('clicking a header sorts: high to low, low to high, then the default order', async ({ page }) => {
  await mock(page);
  await open(page);
  await ready(page);
  const change = page.getByRole('button', { name: 'Sort by 24h change' });
  await change.click();
  expect(await rowSymbols(page)).toEqual(['BTC/USDT', 'BTC/USDC', 'XRP/USDT', 'SOL/USDT', 'ETH/USDT', 'ETH/USDC', 'IFC/USDT', 'DOGE/USDT']);
  await expect(page.locator('[role="columnheader"]', { hasText: '24h change' })).toHaveAttribute('aria-sort', 'descending');
  await change.click();
  expect((await rowSymbols(page))[0]).toBe('DOGE/USDT');
  await expect(page.locator('[role="columnheader"]', { hasText: '24h change' })).toHaveAttribute('aria-sort', 'ascending');
  await change.click();
  expect(await rowSymbols(page)).toEqual(DEFAULT_ORDER);
  await expect(page.locator('[role="columnheader"]', { hasText: '24h change' })).toHaveAttribute('aria-sort', 'none');

  await page.getByRole('button', { name: 'Sort by Price' }).click();
  expect((await rowSymbols(page)).slice(0, 2)).toEqual(['BTC/USDT', 'BTC/USDC']);
  await page.getByRole('button', { name: 'Sort by Name' }).click();
  expect((await rowSymbols(page)).slice(0, 3)).toEqual(['BTC/USDC', 'BTC/USDT', 'DOGE/USDT']);
  await page.getByRole('button', { name: 'Sort by 24h volume' }).click();
  expect((await rowSymbols(page))[0]).toBe('BTC/USDT');
});

test('chips filter by change, newness and currency; pressing the chosen currency again clears it', async ({ page }) => {
  await mock(page);
  await open(page);
  await ready(page);
  const chip = (name) => page.getByTestId('mkt-chips').locator('[data-slot="toggle-group-item"]', { hasText: new RegExp(`^${name}$`) });
  await chip('Gainers').click();
  expect(await rowSymbols(page)).toEqual(['BTC/USDT', 'BTC/USDC', 'XRP/USDT', 'SOL/USDT', 'ETH/USDT', 'ETH/USDC']);
  await chip('Losers').click();
  expect(await rowSymbols(page)).toEqual(['DOGE/USDT', 'IFC/USDT']);
  await chip('New').click();
  expect(await rowSymbols(page)).toEqual(['IFC/USDT', 'SOL/USDT']); // newest first
  await chip('All').click();
  await chip('USDC').click();
  expect(await rowSymbols(page)).toEqual(['BTC/USDC', 'ETH/USDC']);
  await expect(chip('USDC')).toHaveAttribute('aria-pressed', 'true');
  await chip('USDC').click();
  expect(await rowSymbols(page)).toEqual(DEFAULT_ORDER);
  await chip('USDT').click();
  await chip('Gainers').click();
  expect(await rowSymbols(page)).toEqual(['BTC/USDT', 'XRP/USDT', 'SOL/USDT', 'ETH/USDT']);
  await page.screenshot({ path: join(shots, 'markets-state-filtered.png') });
});

test('search opens inline, matches names and pairs, says so when nothing matches, and Escape closes it', async ({ page }) => {
  await mock(page);
  await open(page);
  await ready(page);
  await page.getByRole('button', { name: 'Search markets' }).click();
  const input = page.getByRole('textbox', { name: 'Search markets' });
  await expect(input).toBeFocused();
  expect(Math.round((await box(page, '.mkt-search__field')).width)).toBe(240);
  await input.fill('doge');
  expect(await rowSymbols(page)).toEqual(['DOGE/USDT']);
  await input.fill('bitcoin');
  expect(await rowSymbols(page)).toEqual(['BTC/USDT', 'BTC/USDC']);
  await input.fill('eth/usdc');
  expect(await rowSymbols(page)).toEqual(['ETH/USDC']);
  await input.fill('zzz');
  await expect(page.getByTestId('mkt-empty')).toContainText('No markets match “zzz”.');
  await page.screenshot({ path: join(shots, 'markets-state-no-match.png') });
  await page.getByRole('button', { name: 'Clear search' }).click();
  expect(await rowSymbols(page)).toEqual(DEFAULT_ORDER);
  await expect(input).toHaveCount(0);
  await page.getByRole('button', { name: 'Search markets' }).click();
  await page.getByRole('textbox', { name: 'Search markets' }).fill('sol');
  await page.keyboard.press('Escape');
  expect(await rowSymbols(page)).toEqual(DEFAULT_ORDER);
});

test('favourites: an empty tab shows a way forward; a star saves to the device store and fills the tab', async ({ page }) => {
  await mock(page);
  await open(page);
  await ready(page);
  await page.getByRole('tab', { name: 'Favorites' }).click();
  await expect(page.getByTestId('mkt-empty')).toContainText('Star a market to keep it here.');
  await page.waitForTimeout(300); // the tab underline slides for 150 ms
  await page.screenshot({ path: join(shots, 'markets-state-favorites-empty.png') });
  await page.getByRole('button', { name: 'Browse markets' }).click();
  await expect(page.locator('[data-slot="tabs-tab"][data-active]')).toHaveText('Spot');
  await ready(page);

  await page.getByRole('button', { name: 'Add ETH to favorites' }).first().click();
  await page.getByRole('button', { name: 'Add BTC to favorites' }).first().click();
  await expect(page.getByRole('button', { name: 'Remove BTC from favorites' }).first()).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate((key) => localStorage.getItem(key), FAVORITES_KEY)).toBe('["ETH/USDT","BTC/USDT"]');
  await page.getByRole('tab', { name: 'Favorites' }).click();
  expect(await rowSymbols(page)).toEqual(['ETH/USDT', 'BTC/USDT']); // the order they were starred in
  await page.getByRole('button', { name: 'Remove ETH from favorites' }).click();
  expect(await rowSymbols(page)).toEqual(['BTC/USDT']);
});

test('favourites saved by the old screen show up, and the tab can be opened from the address', async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify(['SOL/USDT', 'NOPE/USDT'])), FAVORITES_KEY);
  await mock(page);
  await open(page, '?tab=favorites');
  await ready(page);
  await expect(page.locator('[data-slot="tabs-tab"][data-active]')).toHaveText('Favorites');
  expect(await rowSymbols(page)).toEqual(['SOL/USDT']);
});

test('signed out: the star leads to sign-in and comes back; Favorites says to log in', async ({ page }) => {
  await mock(page);
  await open(page, '?signedout=1');
  await ready(page);
  const star = page.getByRole('link', { name: 'Log in to star BTC' }).first();
  await expect(star).toHaveAttribute('href', '/login?redirect=%2Ftrade%3Fsignedout%3D1');
  // The coin page needs a session, so a signed-out visitor's rows open the public Buy card instead of a sign-in wall.
  await expect(page.locator('[data-symbol="BTC/USDT"] [data-row-link]')).toHaveAttribute('href', '/trade/buy?asset=BTC');
  expect(await page.getByTestId('if-markets').locator('a[href^="/coin/"]').count()).toBe(0);
  await page.getByRole('tab', { name: 'Favorites' }).click();
  await expect(page.getByTestId('mkt-empty')).toContainText('Log in to keep your favorites here.');
  await expect(page.getByTestId('mkt-empty').locator('a')).toHaveText('Log in');
});

test('loading shows final-size skeleton rows and cards, and nothing moves when data arrives', async ({ page }) => {
  const api = await mock(page, { markets: null, tickers: null });
  await open(page);
  await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
  expect(await page.getByTestId('mkt-row').locator('[data-slot="skeleton"]').count()).toBeGreaterThan(0);
  expect(await page.getByTestId('mkt-row').count()).toBe(8);
  expect(Math.round((await box(page, '[data-testid="mkt-row"]')).height)).toBe(60);
  expect(await page.getByTestId('mkt-card').locator('[data-slot="skeleton"]').count()).toBeGreaterThan(0);
  expect(await page.getByTestId('mkt-card').count()).toBe(3);
  // Skeletons inside a card are the field colour; the kit's own is the panel colour and would vanish there (critic M4).
  expect(
    await page
      .getByTestId('mkt-card')
      .locator('[data-slot="skeleton"]')
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(33, 33, 33)');
  await expect(page.locator('[role="table"]')).toHaveAttribute('aria-busy', 'true');
  const layout = () =>
    page.evaluate(() =>
      [
        '[data-testid="mkt-cards"]',
        '[data-testid="mkt-tabs"]',
        '[data-testid="mkt-chips"]',
        '[data-testid="mkt-header"]',
        '[data-testid="mkt-row"]',
      ].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().top)),
    );
  const before = await layout();
  await page.screenshot({ path: join(shots, 'markets-state-loading.png') });
  await api.release();
  await ready(page);
  expect(await layout()).toEqual(before);
  expect(await page.locator('[data-slot="skeleton"]').count()).toBe(0);
});

test('no open markets: one plain line, no table', async ({ page }) => {
  await mock(page, { markets: [] });
  await open(page);
  await expect(page.locator('[data-slot="state-block"]')).toContainText('No markets are open right now.');
  await expect(page.locator('[role="table"]')).toHaveCount(0);
  await page.screenshot({ path: join(shots, 'markets-state-empty.png') });
});

test('only simulated or halted markets: the same plain line', async ({ page }) => {
  await mock(page, { markets: () => markets.filter((m) => ['SIM/USDT', 'HALT/USDT', 'LOCK/USDT'].includes(m.symbol)) });
  await open(page);
  await expect(page.locator('[data-slot="state-block"]')).toContainText('No markets are open right now.');
});

test('a failed markets call offers "Try again", which works', async ({ page }) => {
  await mock(page, { markets: 'error' });
  await open(page);
  await expect(page.locator('[data-slot="state-block"]')).toContainText('Couldn’t load markets.');
  await page.screenshot({ path: join(shots, 'markets-state-error.png') });
  await page.unrouteAll();
  await mock(page);
  await page.getByRole('button', { name: 'Try again' }).click();
  await ready(page);
  expect(await rowSymbols(page)).toEqual(DEFAULT_ORDER);
});

test('a refused markets call shows plain words and a short reference, never the raw code', async ({ page }) => {
  await mock(page, {
    markets: { status: 403, json: { error: { message: 'denied', data: { intafacedCode: 'denied.screening_fixture' } } } },
  });
  await open(page);
  const block = page.locator('[data-slot="state-block"]');
  await expect(block).toContainText('Paused for account checks');
  await expect(block).toContainText('Ref SCR-1');
  await expect(block).not.toContainText('denied.screening_fixture');
  await page.screenshot({ path: join(shots, 'markets-state-refused.png') });
});

test('failed prices: the list stays, prices show a dash, and a notice offers "Try again"', async ({ page }) => {
  await mock(page, { tickers: 'error' });
  await open(page);
  await ready(page);
  await expect(page.getByTestId('mkt-notice')).toContainText('Couldn’t load prices.');
  await expect(page.getByTestId('mkt-cards')).toHaveCount(0); // cards are only prices, so they wait for them
  await expect(page.locator('[data-symbol="BTC/USDT"] [data-slot="price"]')).toHaveText('—');
  await expect(page.locator('[data-symbol="BTC/USDT"] [data-slot="pct"]')).toHaveText('—');
  await page.screenshot({ path: join(shots, 'markets-state-prices-failed.png') });
  await page.unrouteAll();
  await mock(page);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('[data-symbol="BTC/USDT"] [data-slot="price"]')).toHaveText('$67,812.40');
});

test('quiet filters: Gainers with nothing up says so in one line', async ({ page }) => {
  const down = Object.fromEntries(
    Object.entries(tickers()).map(([symbol, row]) => [symbol, { ...row, open: String(Number(row.last) * 2) }]),
  );
  await mock(page, { tickers: () => down });
  await open(page, '?filter=gainers');
  await expect(page.getByTestId('mkt-empty')).toContainText('Nothing is gaining right now.');
});

test('past 50 rows only the visible rows are drawn, and scrolling reaches the last one', async ({ page }) => {
  const many = manyMarkets(80);
  const api = await mock(page, { markets: () => many.markets, tickers: () => many.tickers });
  await open(page);
  await ready(page);
  const drawn = await page.locator('[role="row"][data-symbol]').count();
  expect(drawn).toBeGreaterThan(8);
  expect(drawn).toBeLessThan(40);
  await expect(page.locator('[role="table"]')).toHaveAttribute('aria-rowcount', '89');
  // Rows keep their 60 px pitch.
  const rows = await page
    .locator('[role="row"][data-symbol]')
    .evaluateAll((nodes) => nodes.slice(0, 3).map((n) => n.getBoundingClientRect().top));
  expect(Math.round(rows[1] - rows[0])).toBe(60);
  await page.screenshot({ path: join(shots, 'markets-state-many.png') });
  await page.keyboard.press('End');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator('[role="row"][data-symbol]').last()).toBeVisible();
  const last = await page.locator('[role="row"][data-symbol]').evaluateAll((nodes) => nodes.at(-1).dataset.symbol);
  expect(await rowSymbols(page)).toContain(last);
  // Keyboard: End on a focused link reaches the true last row even though it is not drawn.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('[role="row"][data-symbol] [data-row-link]').first().focus();
  await page.keyboard.press('End');
  await expect.poll(() => page.evaluate(() => document.activeElement.closest('[role="row"]')?.getAttribute('aria-rowindex'))).toBe('89');
  expect(api.seen.length).toBeLessThan(40);
});

test('responsive: no horizontal page scroll at 1280x800 and below', async ({ page }) => {
  await mock(page);
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1180, height: 800 },
    { width: 768, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await open(page);
    await ready(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="if-markets"] *')]
        .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 4)
        .map((node) => node.className || node.tagName),
    );
    expect(overflow, `${size.width}px, too wide: ${wide.join(' | ')}`).toBeLessThanOrEqual(0);
    if (size.width === 390) {
      // Phone is not designed; it must not break: name, price and change stay, and the row is still a link.
      await expect(page.locator('[data-symbol="BTC/USDT"] [data-row-link]')).toBeVisible();
      await expect(page.locator('[data-symbol="BTC/USDT"] [data-slot="pct"]')).toBeVisible();
    }
    await page.screenshot({ path: join(shots, `markets-${size.width}x${size.height}.png`), fullPage: size.width < 800 });
  }
});

test('a market younger than a day: its own row says "since HH:MM"; the headers stay "24h" for every other market (review M2)', async ({
  page,
}) => {
  const started = Date.now() - 3 * 3_600_000;
  await mock(page, {
    tickers: () => ({ ...tickers(), 'BTC/USDT': { ...tickers()['BTC/USDT'], windowStart: started } }),
  });
  await open(page);
  await ready(page);
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(started);
  const heads = await texts(page.getByTestId('mkt-header').locator('[role="columnheader"]'));
  expect(heads.join(' | ')).toContain('24h change');
  expect(heads.join(' | ')).not.toContain('since');
  await expect(page.locator('[data-symbol="BTC/USDT"] [data-testid="mkt-since"]').first()).toHaveText(`since ${clock}`);
  await expect(page.locator('[data-symbol="ETH/USDT"] [data-testid="mkt-since"]')).toHaveCount(0);
});

test('with two top cards, the two share the row (no empty third) (critic M8)', async ({ page }) => {
  await mock(page);
  await open(page);
  await ready(page);
  const cards = page.getByTestId('mkt-card');
  const count = await cards.count();
  const widths = await cards.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
  const row = await page.getByTestId('mkt-cards').evaluate((node) => Math.round(node.getBoundingClientRect().width));
  // However many cards are drawn (one to three), together with their gaps they fill the row.
  expect(widths.reduce((a, b) => a + b, 0) + (count - 1) * 24).toBeGreaterThanOrEqual(row - 2);
});

for (const mode of ['simple', 'pro']) {
  test(`phase2 ${mode}: phone quote identifiers remain fully visible`, async ({ page }) => {
    if (mode === 'pro') await pro(page);
    await mock(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await ready(page);
    for (const symbol of ['BTC/USDT', 'BTC/USDC']) {
      const row = page.locator(`[role="row"][data-symbol="${symbol}"]`);
      const identity = await row.getByTestId('mkt-name__ticker').evaluate((node) => {
        const quote = node.querySelector('[data-testid="mkt-name__quote"]');
        const rect = node.getBoundingClientRect();
        const ink = document.createRange();
        ink.selectNodeContents(quote);
        const value = ink.getBoundingClientRect();
        return {
          text: node.textContent,
          right: rect.right,
          inkRight: value.right,
          top: rect.top,
          inkTop: value.top,
          bottom: rect.bottom,
          inkBottom: value.bottom,
        };
      });
      expect(identity.text.replace(/\s/g, '')).toBe(symbol);
      expect(identity.inkRight).toBeLessThanOrEqual(identity.right + 1);
      expect(identity.inkTop).toBeGreaterThanOrEqual(identity.top - 1);
      expect(identity.inkBottom).toBeLessThanOrEqual(identity.bottom + 1);
      expect((await row.boundingBox()).height).toBeGreaterThanOrEqual(60);
    }
    await page.screenshot({ path: join(shots, `phase2-phone-${mode}.png`), fullPage: true });
  });
}
