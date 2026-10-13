import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { balances, emptyBalances, holdings, hourlyCandles, markets, tickers } from './home.fixtures.mjs';

const shots = process.env.HOME_SHOTS ?? join(tmpdir(), 'intafaced-home-shots');
mkdirSync(shots, { recursive: true });
const reference = process.env.HOME_REFERENCE; // optional absolute path to the OKX poster (never committed)

const forbidden = /unavailable|not connected|restricted|fixture|lifecycle/i;
const moneyShape = /^[−+]?[$]?[\d,]+(\.\d+)?[%A-Z ]*$|^—$|^••••$/;

/**
 * Answer the exchange REST calls the data layer makes (/api/v1/markets, /tickers, /account/balance, /ohlcv/<symbol>).
 * An override is a wire JSON body or a function returning one, `null` to hold the request until `release()`,
 * 'error' for a 500, or { status, json } for any other answer. No service is contacted.
 */
const defaults = {
  markets: () => markets,
  tickers: () => tickers(),
  balance: () => balances(),
  ohlcv: (symbol) => hourlyCandles(symbol),
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
const open = async (page) => {
  await page.goto('/');
  await page.locator('.if-home').waitFor();
};
/** "$12,481.29 USD": NumberFlow draws digit strips in a shadow root, so read the figure's accessible name plus the unit. */
const heroText = (page) =>
  page.locator('[data-slot="hero-number"]').evaluate((node) => {
    const figure = node.querySelector('[role="img"]')?.getAttribute('aria-label') ?? node.firstElementChild?.textContent ?? '';
    return `${figure} ${node.lastElementChild?.textContent ?? ''}`.trim();
  });
const expectHero = (page, text) => expect.poll(() => heroText(page).catch(() => null), { timeout: 7000 }).toBe(text);
const texts = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));

test('ready state at 1440x900: layout, words, keyboard path, numbers', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await mock(page);
  await open(page);
  const home = page.locator('.if-home');
  await expect(page.locator('.home-label')).toContainText('Est. total value');

  // Hero equals the sum of the holdings' USD values, computed in cents (no floats).
  const cents = (value) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(2, '0'));
  };
  const sum = holdings.reduce((total, row) => total + cents(row.usdValue), 0n);
  const expected = `$${(sum / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(sum % 100n).toString().padStart(2, '0')}`;
  await expectHero(page, `${expected} USD`);
  expect(expected).toBe('$12,481.29');
  await expect(page.locator('.home-change')).toContainText('+$206.29');
  await expect(page.locator('.home-change')).toContainText('+1.68%');
  await expect(page.locator('.home-change')).toContainText('Today, from price moves');

  // Actions: only live ones, Buy is the one primary.
  expect(await texts(page.locator('.home-actions > *'))).toEqual(['Buy', 'Sell', 'Convert', 'Send', 'Receive']);
  await expect(page.locator('.home-actions a.bg-lime')).toHaveText('Buy');
  expect(await page.locator('.home-actions a.bg-lime').count()).toBe(1);

  // Cash / Crypto card
  await expect(page.locator('.home-holdings__row').nth(0)).toContainText('Cash');
  await expect(page.locator('.home-holdings__row').nth(0)).toContainText('$4,100.00');
  await expect(page.locator('.home-holdings__row').nth(1)).toContainText('$8,381.29');
  await expect(page.locator('.home-holdings__row').nth(1)).toHaveAttribute('href', '/money#crypto');

  // Markets: four cards, BTC/ETH/IFC first (no activity numbers), then the next listed asset.
  const cards = page.locator('.home-card');
  expect(await cards.count()).toBe(4);
  expect(await texts(page.locator('.home-card__ticker'))).toEqual(['BTC', 'ETH', 'IFC', 'SOL']);
  await expect(cards.first()).toContainText('67,812.40'); // a price, not a USD amount: no currency sign (UI-SPEC 2.6 fmtPrice)
  await expect(cards.first()).toContainText('+2.75%');
  await expect(cards.nth(2)).toContainText('−2.14%');
  await expect(cards.first()).toHaveAttribute('href', '/coin/BTC');
  expect(await page.locator('.home-card [data-slot="sparkline"] polyline').count()).toBe(4);

  // Top movers: up to 6, biggest move first, one per asset.
  expect(await texts(page.locator('.home-pill'))).toEqual([
    'DOGE▼−4.94%',
    'BTC▲+2.75%',
    'XRP▲+2.15%',
    'IFC▼−2.14%',
    'SOL▲+1.75%',
    'ETH▲+1.59%',
  ]);

  // Side card: no favourites -> "Popular", every orderable asset once, max 8.
  await expect(page.locator('.home-watch__head h2')).toHaveText('Popular');
  expect(await texts(page.locator('.home-watch__ticker'))).toEqual(['BTC', 'ETH', 'IFC', 'SOL', 'XRP', 'DOGE']);

  // Geometry: container 1224, main 792, side 408, card 186 x 176, hero text 48/56.
  const box = async (selector) => await page.locator(selector).first().boundingBox();
  expect(Math.round((await box('.if-home')).width)).toBe(1224);
  expect(Math.round((await box('.home-main')).width)).toBe(792);
  expect(Math.round((await box('.home-side')).width)).toBe(408);
  const card = await box('.home-card');
  expect([Math.round(card.width), Math.round(card.height)]).toEqual([186, 176]);
  expect((await box('.home-side')).y).toBeCloseTo((await box('.home-label')).y, 0);
  const heroStyle = await page
    .locator('[data-slot="hero-number"]')
    .evaluate((node) => getComputedStyle(node).fontSize + '/' + getComputedStyle(node).lineHeight);
  expect(heroStyle).toBe('48px/56px');
  // The Markets row is on the first screen (the real app adds a 28 px local-test banner above).
  expect((await box('.home-card')).y + card.height).toBeLessThanOrEqual(900 - 28);

  // Order on the page: value -> change -> actions -> Cash/Crypto -> Markets.
  const ys = await page.evaluate(() =>
    ['[data-slot="hero-number"]', '.home-change', '.home-actions', '.home-holdings', '.home-cards'].map(
      (selector) => document.querySelector(selector).getBoundingClientRect().top,
    ),
  );
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);

  // Plain words only.
  expect(await home.innerText()).not.toMatch(forbidden);
  for (const value of await texts(page.locator('[data-money], [data-slot="money"]')))
    expect(value, `money shape: ${value}`).toMatch(moneyShape);

  // Keyboard: Tab from the top bar reaches eye -> actions -> Cash -> Crypto -> 4 cards -> movers -> watchlist.
  await page.locator('.harness-bar a').last().focus();
  const path = [];
  for (let step = 0; step < 30; step++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const node = document.activeElement;
      const style = getComputedStyle(node);
      return {
        name: node.getAttribute('aria-label') ?? node.textContent.trim().replace(/\s+/g, ' ').slice(0, 24),
        href: node.getAttribute('href'),
        outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
        inside: Boolean(node.closest('.if-home')),
      };
    });
    if (!stop.inside) break;
    expect(stop.outline, `focus ring on ${stop.name}`).toBe('solid 2px rgb(200, 246, 74)');
    path.push(stop);
  }
  expect(path.map((stop) => stop.name).slice(0, 6)).toEqual(['Hide balances', 'Buy', 'Sell', 'Convert', 'Send', 'Receive']);
  expect(path.slice(6, 8).map((stop) => stop.href)).toEqual(['/money#cash', '/money#crypto']);
  expect(path.slice(8, 12).map((stop) => stop.href)).toEqual(['/coin/BTC', '/coin/ETH', '/coin/IFC', '/coin/SOL']);
  expect(path.slice(12, 18).map((stop) => stop.href)).toEqual([
    '/coin/DOGE',
    '/coin/BTC',
    '/coin/XRP',
    '/coin/IFC',
    '/coin/SOL',
    '/coin/ETH',
  ]);
  expect(path[18].name).toBe('Edit your watchlist');
  expect(path.slice(19).map((stop) => stop.href)).toEqual(['/coin/BTC', '/coin/ETH', '/coin/IFC', '/coin/SOL', '/coin/XRP', '/coin/DOGE']);

  // The total-value rule is available in the page for assistive tech and as a hover tooltip.
  await expect(page.locator('.home-label .if-tip')).toContainText('USDT and USDC count as 1 USD');
  await page.locator('.home-label .if-tip').hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toBeVisible();

  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(shots, 'home-1440x900.png') });
  await page.screenshot({ path: join(shots, 'home-1440-full.png'), fullPage: true });
  expect(errors).toEqual([]);

  // Side-by-side with the OKX poster, composed outside the repo (the poster is never copied into it).
  if (reference) {
    const ours = readFileSync(join(shots, 'home-1440x900.png')).toString('base64');
    const theirs = readFileSync(reference).toString('base64');
    const compare = await page.context().newPage();
    await compare.setViewportSize({ width: 1440 + 460, height: 940 });
    await compare.setContent(`<body style="margin:0;background:rgb(0 0 0);color:rgb(144 144 144);font:12px sans-serif;display:flex;gap:16px;padding:16px">
      <figure style="margin:0"><img src="data:image/png;base64,${ours}" style="width:1440px;display:block;border:1px solid rgb(46 46 46)"><figcaption style="padding-top:6px">INTAFACED (local test, mocked data)</figcaption></figure>
      <figure style="margin:0"><img src="data:image/jpeg;base64,${theirs}" style="height:900px;display:block;border:1px solid rgb(46 46 46)"><figcaption style="padding-top:6px">Reference: OKX App Store poster, home-3.jpeg</figcaption></figure></body>`);
    await compare.screenshot({ path: join(shots, 'side-by-side-home-3.png') });
    await compare.close();
  }
});

test('responsive: no horizontal page scroll at 1280x800 and 390x844', async ({ page }) => {
  await mock(page);
  for (const size of [
    { width: 1280, height: 800 },
    { width: 768, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await open(page);
    await expect(page.locator('.home-card').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll('.if-home *')]
        .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 4)
        .map((node) => node.className || node.tagName),
    );
    expect(overflow, `${size.width}px, too wide: ${wide.join(' | ')}`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: join(shots, `home-${size.width}x${size.height}.png`), fullPage: size.width < 800 });
  }
});

test('hidden balances show bullets, prices stay, and the choice is remembered', async ({ page }) => {
  await mock(page);
  await open(page);
  await page.getByRole('button', { name: 'Hide balances' }).click();
  await expect(page.getByRole('button', { name: 'Show balances' })).toBeVisible();
  await expectHero(page, '$•••• USD');
  expect(await texts(page.locator('.home-holdings__value'))).toEqual(['••••', '••••']);
  await expect(page.locator('.home-change [data-slot="change-text"]')).toContainText('••••'); // the whole change line is a portfolio figure
  await expect(page.locator('.home-change')).not.toContainText('206'); // and no digit of it leaks
  await expect(page.locator('.home-card__price').first()).toHaveText('67,812.40'); // prices still show
  for (const value of await texts(page.locator('[data-money], [data-slot="money"]'))) expect(value).toMatch(moneyShape);
  await page.screenshot({ path: join(shots, 'home-state-hidden.png') });
  await page.reload();
  await expectHero(page, '$•••• USD');
  await page.getByRole('button', { name: 'Show balances' }).click();
  await expectHero(page, '$12,481.29 USD');
});

test('loading shows final-size skeletons and nothing moves when data arrives', async ({ page }) => {
  const api = await mock(page, { balance: null, markets: null, tickers: null, ohlcv: null });
  await open(page);
  await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
  expect(await page.locator('.home-cards [data-slot="skeleton"]').count()).toBe(4);
  const hero = await page.locator('.home-total [data-slot="skeleton"]').boundingBox();
  expect([Math.round(hero.width), Math.round(hero.height)]).toEqual([240, 56]);
  const layout = () =>
    page.evaluate(() =>
      ['.home-actions', '.home-holdings', '.home-cards', '.home-pills', '.home-watch'].map((selector) =>
        Math.round(document.querySelector(selector).getBoundingClientRect().top),
      ),
    );
  const before = await layout();
  await page.screenshot({ path: join(shots, 'home-state-loading.png') });
  await api.release();
  await expectHero(page, '$12,481.29 USD');
  await expect(page.locator('.home-card__price').first()).toBeVisible();
  expect(await layout()).toEqual(before);
  expect(await page.locator('[data-slot="skeleton"]').count()).toBe(0);
});

test('empty portfolio: zero is shown once, with one plain line', async ({ page }) => {
  await mock(page, { balance: emptyBalances });
  await open(page);
  await expectHero(page, '$0.00 USD');
  await expect(page.locator('.home-note')).toHaveText('You don’t own any crypto yet.');
  await expect(page.locator('.home-holdings')).toHaveCount(0);
  await expect(page.locator('.home-actions a.bg-lime')).toHaveText('Buy');
  await expect(page.locator('.home-card').first()).toBeVisible();
  await page.screenshot({ path: join(shots, 'home-state-empty.png') });
});

test('unpriced assets are named, not counted, and never shown as zero', async ({ page }) => {
  await mock(page, { balance: () => balances({ XYZ: { free: '5', used: '0', total: '5' } }) });
  await open(page);
  await expect(page.locator('.home-note')).toContainText('+ 1 asset not counted (no USD price)');
  await expect(page.locator('.home-note .if-tip')).toContainText('Not counted: XYZ');
  await page.unrouteAll();
  await mock(page, { balance: () => balances({ XYZ: { free: '5', used: '0', total: '5' }, ABC: { free: '1', used: '0', total: '1' } }) });
  await page.reload();
  await expect(page.locator('.home-note')).toContainText('+ 2 assets not counted (no USD price)');
});

test('a window shorter than a day says "since HH:mm"', async ({ page }) => {
  // Tickers without 24 h numbers: the data layer derives them from hourly candles that began 3 hours ago.
  const hour = 3_600_000;
  const start = Math.floor((Date.now() - 3 * hour) / hour) * hour;
  await mock(page, { tickers: () => tickers({ withOpen: false }), ohlcv: (symbol) => hourlyCandles(symbol, 3) });
  await open(page);
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(start);
  await expect(page.locator('.home-change')).toContainText(`since ${clock}`);
});

test('no orderable markets: Markets, Top movers and Watchlist are omitted', async ({ page }) => {
  // Without markets there are no prices, so only the stablecoin cash is counted and the coins are named as not counted.
  await mock(page, { markets: [] });
  await open(page);
  await expectHero(page, '$4,100.00 USD');
  await expect(page.locator('.home-note')).toContainText('+ 2 assets not counted (no USD price)');
  for (const selector of ['.home-cards', '.home-pills', '.home-watch', '.home-side']) await expect(page.locator(selector)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Markets|Top movers|Popular|Watchlist/ })).toHaveCount(0);
  await page.screenshot({ path: join(shots, 'home-state-no-markets.png') });
});

test('refused balance: plain panel in place of the hero, markets still render', async ({ page }) => {
  await mock(page, {
    balance: { status: 403, json: { error: { message: 'denied', data: { intafacedCode: 'denied.screening_fixture' } } } },
  });
  await open(page);
  await expect(page.locator('[data-slot="state-block"]')).toContainText('Paused for account checks');
  await expect(page.locator('[data-slot="state-block"]')).toContainText('denied.screening_fixture'); // support code, small
  await expect(page.locator('[data-slot="hero-number"]')).toHaveCount(0);
  await expect(page.locator('.home-card').first()).toBeVisible();
  await page.screenshot({ path: join(shots, 'home-state-refused.png') });
});

test('failed balance call offers "Try again", which works', async ({ page }) => {
  await mock(page, { balance: 'error' });
  await open(page);
  await expect(page.locator('[data-slot="state-block"]')).toContainText('Couldn’t load your balance.');
  await expect(page.locator('.home-card').first()).toBeVisible();
  await page.unrouteAll();
  await mock(page);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expectHero(page, '$12,481.29 USD');
});

test('favourites from the existing device store become the Watchlist', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('trade-favorites:00000000-0000-4000-8000-000000000001', JSON.stringify(['ETH-USDT', 'SOL-USDT', 'NOPE-USDT'])),
  );
  await mock(page);
  await open(page);
  await expect(page.locator('.home-watch__head h2')).toHaveText('Watchlist');
  expect(await texts(page.locator('.home-watch__ticker'))).toEqual(['ETH', 'SOL']);
  await expect(page.locator('.home-watch__head a')).toHaveAttribute('href', '/trade?tab=favorites');
});
