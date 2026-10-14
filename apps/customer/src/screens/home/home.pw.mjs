import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activityPage,
  activityRow,
  alertList,
  balances,
  emptyBalances,
  establishedActivity,
  holdings,
  hourlyCandles,
  kycAnswer,
  kycPending,
  markets,
  passkeyList,
  tickers,
  trpc,
} from './home.fixtures.mjs';

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
// An established account by default: verified, a passkey, an alert, money in and a trade, so Get started is out of the way.
const defaults = {
  markets: () => markets,
  tickers: () => tickers(),
  balance: () => balances(),
  ohlcv: (symbol) => hourlyCandles(symbol),
  kyc: () => kycAnswer('basic'),
  passkeys: () => passkeyList(1),
  alerts: () => alertList(),
  activity: () => establishedActivity(),
};
// The service calls (/api/<module>/trpc/<procedure>) the checklist and the activity list make.
const procedures = { 'kyc.status': 'kyc', 'webauthn.list': 'passkeys', 'notify.alerts': 'alerts', 'activity.list': 'activity' };
/** A brand-new account: nothing done anywhere. */
const newAccount = {
  balance: emptyBalances,
  kyc: () => kycAnswer('none'),
  passkeys: () => passkeyList(0),
  alerts: () => alertList([]),
  activity: () => activityPage([]),
};
async function mock(page, overrides = {}) {
  const served = { ...defaults, ...overrides };
  const held = [];
  const seen = [];
  const answer = (route, value, arg, wrap = (data) => data) => {
    if (value === 'error') return route.fulfill({ status: 500, body: 'no' });
    if (value && typeof value === 'object' && 'status' in value && 'json' in value)
      return route.fulfill({ status: value.status, json: value.json });
    return route.fulfill({ status: 200, json: wrap(typeof value === 'function' ? value(arg) : value) });
  };
  await page.route('**/api/*/trpc/**', async (route) => {
    const procedure = decodeURIComponent(new URL(route.request().url()).pathname.split('/trpc/')[1]);
    const name = procedures[procedure];
    seen.push(procedure);
    if (!name || !(name in served)) return route.fulfill({ status: 404, json: { error: { message: 'not mocked' } } });
    if (served[name] === null) return void held.push({ route, name, wrap: trpc });
    return answer(route, served[name], undefined, trpc);
  });
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
    /** Answer every held request, and every later one, with `replacement[name]` or else the normal data. */
    release: async (replacement = {}) => {
      for (const name of Object.keys(served)) if (served[name] === null) served[name] = replacement[name] ?? defaults[name];
      for (const { route, name, arg, wrap } of held.splice(0)) await answer(route, served[name], arg, wrap);
    },
  };
}
const open = async (page) => {
  await page.goto('/');
  await page.locator('.if-home').waitFor();
};
/** "$12,481.29": NumberFlow draws digit strips in a shadow root, so read the figure's accessible name. */
const heroText = (page) =>
  page.locator('[data-slot="hero-number"]').evaluate((node) => {
    const figure = node.querySelector('[role="img"]')?.getAttribute('aria-label') ?? node.firstElementChild?.textContent ?? '';
    return figure.trim();
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
  await expectHero(page, expected);
  expect(expected).toBe('$12,481.29');
  await expect(page.locator('.home-change')).toContainText('+$206.29');
  await expect(page.locator('.home-change')).toContainText('+1.68%');
  await expect(page.locator('.home-change')).toContainText('Today, from price moves');

  // Actions: only live ones, Buy is the one primary.
  expect(await texts(page.locator('.home-actions > *'))).toEqual(['Buy', 'Sell', 'Convert', 'Send', 'Receive']);
  await expect(page.locator('.home-actions a.bg-lime')).toHaveText('Buy');
  expect(await page.locator('.home-actions a.bg-lime').count()).toBe(1);
  // Simple Buy and Sell open the Buy card (M2 critic H1); Pro Home goes to the desk.
  await expect(page.locator('.home-actions a').nth(0)).toHaveAttribute('href', '/trade/buy');
  await expect(page.locator('.home-actions a').nth(1)).toHaveAttribute('href', '/trade/buy?side=sell');
  // Critic H1: the Buy label is dark on lime (an unlayered rule once made it white, 1.25:1).
  const color = (selector) =>
    page
      .locator(selector)
      .first()
      .evaluate((node) => getComputedStyle(node).color);
  expect(await color('.home-actions [data-slot="button"]:first-child')).toBe('rgb(11, 11, 11)');
  // Critic H2: kit sizes are true px (the legacy 14 px root made every pill 35 tall).
  expect(Math.round((await page.locator('.home-actions a').first().boundingBox()).height)).toBe(40);

  // Cash / Crypto card
  await expect(page.locator('.home-holdings__row').nth(0)).toContainText('Cash');
  await expect(page.locator('.home-holdings__row').nth(0)).toContainText('$4,100.00');
  await expect(page.locator('.home-holdings__row').nth(1)).toContainText('$8,381.29');
  await expect(page.locator('.home-holdings__row').nth(1)).toHaveAttribute('href', '/money#crypto');

  // Markets: four cards, BTC/ETH/IFC first (no activity numbers), then the next listed asset.
  const cards = page.locator('.home-card');
  expect(await cards.count()).toBe(4);
  expect(await texts(page.locator('.home-card__ticker'))).toEqual(['BTC', 'ETH', 'IFC', 'SOL']);
  await expect(cards.first()).toContainText('$67,812.40'); // a dollar-quoted price carries the unit (critic M3)
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

  const box = async (selector) => await page.locator(selector).first().boundingBox();

  // Right column, T2-A: "Your crypto" (icon, amount, value, today's change) above Popular, from the portfolio's holdings.
  await expect(page.locator('.home-yours .home-watch__head h2')).toHaveText('Your crypto');
  expect(await texts(page.locator('.home-yours .home-watch__ticker'))).toEqual(['BTC · Bitcoin', 'ETH · Ethereum']);
  expect(await texts(page.locator('.home-yours [data-slot="amount"]'))).toEqual(['0.1 BTC', '0.5 ETH']);
  expect(await texts(page.locator('.home-yours [data-slot="money"]'))).toEqual(['$6,781.24', '$1,600.05']);
  expect(await texts(page.locator('.home-yours [data-slot="pct"]'))).toEqual(['+2.75%', '+1.59%']);
  await expect(page.locator('.home-yours .home-watch__row').first()).toHaveAttribute('href', '/coin/BTC');
  expect((await box('.home-yours')).y).toBeLessThan((await box('.home-watch:not(.home-yours)')).y);

  // Freshness line (missing-function #4): when the prices were last fetched.
  await expect(page.locator('.home-fresh')).toHaveText(/^Prices updated \d\d:\d\d$/);

  // Side card: no favourites -> "Popular", every orderable asset once, max 8.
  await expect(page.locator('.home-watch:not(.home-yours) .home-watch__head h2')).toHaveText('Popular');
  expect(await texts(page.locator('.home-watch:not(.home-yours) .home-watch__ticker'))).toEqual(['XRP', 'DOGE']); // the cards' coins are not repeated (critic N3)

  // Geometry: container 1224, main 792, side 408, card 186 x 176, hero text 48/58.
  expect(Math.round((await box('.if-home')).width)).toBe(1224);
  expect(Math.round((await box('.home-main')).width)).toBe(792);
  expect(Math.round((await box('.home-side')).width)).toBe(408);
  const card = await box('.home-card');
  expect([Math.round(card.width), Math.round(card.height)]).toEqual([186, 176]);
  expect((await box('.home-side')).y).toBeCloseTo((await box('.home-label')).y, 0);
  const heroStyle = await page
    .locator('[data-slot="hero-number"]')
    .evaluate((node) => getComputedStyle(node).fontSize + '/' + getComputedStyle(node).lineHeight);
  expect(heroStyle).toBe('48px/58px');
  // The Markets row is on the first screen (the real app adds a 28 px local-test banner above).
  expect((await box('.home-card')).y + card.height).toBeLessThanOrEqual(900 - 28);

  // Order on the page: value -> change -> actions -> Cash/Crypto -> Markets.
  const ys = await page.evaluate(() =>
    ['[data-slot="hero-number"]', '.home-change', '.home-actions', '.home-holdings', '.home-cards'].map(
      (selector) => document.querySelector(selector).getBoundingClientRect().top,
    ),
  );
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);

  // An established account (verified, passkey, alert, money in, a trade) has nothing left to get started on.
  await expect(page.locator('.home-started')).toHaveCount(0);
  // Recent activity shows the last movements in plain words; the Learn strip opens the Academy's Preview.
  expect(await texts(page.locator('.home-activity__kind'))).toEqual(['Trade', 'Trade', 'Deposit']);
  expect(await texts(page.locator('.home-activity__amount'))).toEqual(['+0.1 BTC', '−6,700 USDT', '+10,000 USDT']);
  await expect(page.locator('.home-activity__when').first()).toHaveText('13 Oct, 12:00');
  await expect(page.getByRole('heading', { name: /^Learn/ })).toContainText('Preview');
  expect(await page.locator('.home-learn__card').count()).toBe(3);

  // Plain words only.
  expect(await home.innerText()).not.toMatch(forbidden);
  for (const value of await texts(page.locator('[data-money], [data-slot="money"]')))
    expect(value, `money shape: ${value}`).toMatch(moneyShape);

  // Keyboard: Tab from the top bar reaches eye -> the two info tips -> actions -> Cash -> Crypto -> 4 cards (each
  // followed by its star) -> movers -> Your crypto -> the watchlist rows (each followed by its star).
  await page.locator('.harness-bar a').last().focus();
  const path = [];
  for (let step = 0; step < 70; step++) {
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
  expect(path.map((stop) => stop.name).slice(0, 8)).toEqual([
    'Hide balances',
    'How the total is worked out',
    'About this change',
    'Buy',
    'Sell',
    'Convert',
    'Send',
    'Receive',
  ]);
  expect(path.slice(8, 10).map((stop) => stop.href)).toEqual(['/money#cash', '/money#crypto']);
  const cardStops = path.slice(10, 18);
  expect(cardStops.filter((stop) => stop.href).map((stop) => stop.href)).toEqual(['/coin/BTC', '/coin/ETH', '/coin/IFC', '/coin/SOL']);
  expect(cardStops.filter((stop) => !stop.href).map((stop) => stop.name)).toEqual([
    'Add BTC to watchlist',
    'Add ETH to watchlist',
    'Add IFC to watchlist',
    'Add SOL to watchlist',
  ]);
  expect(path[18].name).toBe('About top movers');
  expect(path.slice(19, 25).map((stop) => stop.href)).toEqual([
    '/coin/DOGE',
    '/coin/BTC',
    '/coin/XRP',
    '/coin/IFC',
    '/coin/SOL',
    '/coin/ETH',
  ]);
  // Recent activity ("See all") and the Learn strip (the Academy's Preview, four links) follow the movers.
  expect(path.slice(25, 26).map((stop) => stop.href)).toEqual(['/money/activity']);
  expect(path.slice(26, 30).map((stop) => stop.href)).toEqual(Array(4).fill('/preview/academy'));
  expect(path.slice(30, 32).map((stop) => stop.href)).toEqual(['/coin/BTC', '/coin/ETH']); // Your crypto
  expect(
    path
      .slice(32)
      .filter((stop) => stop.href)
      .map((stop) => stop.href),
  ).toEqual(['/coin/XRP', '/coin/DOGE']);
  expect(path.slice(32).filter((stop) => !stop.href).length).toBe(2); // one star per row

  // The total-value rule is available in the page for assistive tech and as a tooltip that opens on hover AND
  // keyboard focus (critic M5), fully below the top bar (critic H7: it hid behind the banner when it opened upward).
  await expect(page.locator('.home-label')).toContainText('USDT and USDC count as 1 USD');
  await page.locator('.home-label .if-tip').hover();
  // The tip left open by the keyboard walk may still be fading out, so look at the open one only.
  const openTip = page.locator('[data-slot="tooltip-content"][data-open]');
  await expect(openTip).toBeVisible();
  expect((await openTip.boundingBox()).y).toBeGreaterThanOrEqual(56);
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  await page.locator('.home-label .if-tip').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
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
    { width: 1180, height: 800 },
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
  await expectHero(page, '$••••');
  expect(await texts(page.locator('.home-holdings__value'))).toEqual(['••••', '••••']);
  await expect(page.locator('.home-change [data-slot="change-text"]')).toContainText('••••'); // the whole change line is a portfolio figure
  await expect(page.locator('.home-change')).not.toContainText('206'); // and no digit of it leaks
  await expect(page.locator('.home-card__price').first()).toHaveText('$67,812.40'); // prices still show
  expect(await texts(page.locator('.home-yours [data-slot="money"], .home-yours [data-slot="amount"]'))).toEqual([
    '••••',
    '••••',
    '••••',
    '••••',
  ]);
  for (const value of await texts(page.locator('[data-money], [data-slot="money"]'))) expect(value).toMatch(moneyShape);
  await page.screenshot({ path: join(shots, 'home-state-hidden.png') });
  await page.reload();
  await expectHero(page, '$••••');
  await page.getByRole('button', { name: 'Show balances' }).click();
  await expectHero(page, '$12,481.29');
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
  // Critic M4: a skeleton inside a panel is the field colour, not the panel's own (it was invisible).
  expect(
    await page
      .locator('.home-watch [data-slot="skeleton"]')
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(33, 33, 33)');
  await page.screenshot({ path: join(shots, 'home-state-loading.png') });
  await api.release();
  await expectHero(page, '$12,481.29');
  await expect(page.locator('.home-card__price').first()).toBeVisible();
  expect(await layout()).toEqual(before);
  expect(await page.locator('[data-slot="skeleton"]').count()).toBe(0);
});

test('empty portfolio: zero is shown once, with one plain line and a way to start', async ({ page }) => {
  await mock(page, { balance: emptyBalances });
  await open(page);
  await expectHero(page, '$0.00');
  await expect(page.locator('.home-note')).toHaveText(
    'Your account is empty. Add money to get started, or receive coins from someone on INTAFACED.',
  );
  await expect(page.locator('.home-holdings')).toHaveCount(0);
  // The side card says so in one line instead of vanishing.
  await expect(page.locator('.home-yours')).toContainText('Coins you hold will show here.');
  // An empty account leads with Add money (a Preview until deposits are live), then Receive; nothing to sell, send or convert.
  expect(await texts(page.locator('.home-actions > *'))).toEqual(['Add moneyPreview', 'Receive', 'Buy']);
  await expect(page.locator('.home-actions a.bg-lime')).toContainText('Add money');
  await expect(page.locator('.home-actions a').first()).toHaveAttribute('href', '/preview/deposit');
  await expect(page.locator('.home-card').first()).toBeVisible();
  await page.screenshot({ path: join(shots, 'home-state-empty.png') });
});

test('a brand-new account: Get started, honest empty panels, a filled Simple Home', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mock(page, newAccount);
  await open(page);
  const started = page.locator('.home-started');
  await expect(started.getByRole('heading', { name: 'Get started' })).toBeVisible();
  await expect(started.locator('.home-started__count')).toHaveText('0 of 4 done');
  // Five steps; every one reads its real answer. The alert step has no live place to go yet.
  expect(await texts(started.locator('.home-started__title'))).toEqual([
    'Verify your identity',
    'Secure your account',
    'Add moneyPreview',
    'Make your first trade',
    'Set a price alert',
  ]);
  expect(await started.locator('a.home-started__row').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))).toEqual([
    '/verification',
    '/uc/safe',
    '/preview/deposit',
    '/trade/buy',
  ]);
  await expect(started.locator('[data-step="alert"]')).toContainText('Coming soon');
  await expect(started.locator('[data-step="alert"]')).not.toHaveAttribute('href', /.*/);
  await expect(started.locator('[data-status="done"]')).toHaveCount(0);
  // Honest empty states on a zero-balance account, none of them invented.
  await expectHero(page, '$0.00');
  await expect(page.locator('.home-activity, .home-main [data-slot="state-block"]')).toContainText('No activity yet');
  await expect(page.locator('.home-yours')).toContainText('Coins you hold will show here.');
  await expect(page.locator('.home-watch:not(.home-yours) .home-watch__head h2')).toHaveText('Popular');
  await expect(page.locator('.home-side__empty--hint')).toHaveText('Star a coin to build your own watchlist.');
  // The empty half is full: movers, a watchlist, and a Learn strip that opens the Academy's Preview.
  expect(await page.locator('.home-pill').count()).toBe(6);
  await expect(page.getByRole('heading', { name: /^Learn/ })).toContainText('Preview');
  await expect(page.getByRole('link', { name: 'Open Academy' })).toHaveAttribute('href', '/preview/academy');
  // The Preview chip is outlined grey, not lime.
  const chip = started.locator('[data-step="deposit"] .home-chip');
  await expect(chip).toHaveText('Preview');
  expect(await chip.evaluate((node) => getComputedStyle(node).color)).toBe('rgb(144, 144, 144)');
  expect(await page.locator('.if-home').innerText()).not.toMatch(forbidden);
  // The checklist sits at the top of the right column, level with the balance.
  const top = (selector) =>
    page
      .locator(selector)
      .first()
      .boundingBox()
      .then((box) => box.y);
  expect(Math.abs((await top('.home-started')) - (await top('.home-label')))).toBeLessThan(2);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(shots, 'home-new-account-1440x900.png') });
  await page.screenshot({ path: join(shots, 'home-new-account-full.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('Get started reads the real answers: done, in review, and "not done" until proven', async ({ page }) => {
  // Verification submitted and waiting, a passkey added, money received, no trade, no alert.
  await mock(page, {
    kyc: kycPending,
    passkeys: () => passkeyList(1),
    alerts: () => alertList([]),
    activity: () => activityPage([activityRow('deposit', 'in', '50')]),
  });
  await open(page);
  const started = page.locator('.home-started');
  const state = (step) => started.locator(`[data-step="${step}"]`).getAttribute('data-status');
  await expect.poll(() => state('verify')).toBe('review');
  expect(await state('secure')).toBe('done');
  expect(await state('deposit')).toBe('done');
  expect(await state('trade')).toBe('todo');
  await expect(started.locator('[data-step="verify"]')).toContainText('In review');
  await expect(started.locator('[data-step="secure"]')).toContainText('Done');
  await expect(started.locator('.home-started__count')).toHaveText('2 of 4 done');
  expect(await started.locator('.home-started__bar [data-on="true"]').count()).toBe(2);
  // A finished step does not carry the Preview chip.
  await expect(started.locator('[data-step="deposit"] .home-chip')).toHaveCount(0);
  await page.screenshot({ path: join(shots, 'home-started-partial.png') });
});

test('a step that cannot be read is never shown as done', async ({ page }) => {
  await mock(page, { ...newAccount, kyc: 'error', passkeys: 'error' });
  await open(page);
  const started = page.locator('.home-started');
  await expect(started.locator('[data-step="verify"]')).toHaveAttribute('data-status', 'unknown');
  await expect(started.locator('[data-step="verify"]')).toContainText('Couldn’t check');
  await expect(started.locator('[data-step="secure"]')).toContainText('Couldn’t check');
  await expect(started.locator('[data-status="done"]')).toHaveCount(0);
  await expect(started.locator('.home-started__count')).toHaveText('0 of 4 done');
});

test('Get started can be hidden, and stays hidden for this person', async ({ page }) => {
  await mock(page, newAccount);
  await open(page);
  await expect(page.locator('.home-started')).toBeVisible();
  await page.getByRole('button', { name: 'Hide Get started' }).click();
  await expect(page.locator('.home-started')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('intafaced.customer.home.started.v1:00000000-0000-4000-8000-000000000001'))).toBe(
    'dismissed',
  );
  await page.reload();
  await page.locator('.if-home').waitFor();
  await expectHero(page, '$0.00');
  await expect(page.locator('.home-started')).toHaveCount(0);
  // Hiding it did not move the rest of Home away: the watchlist is still there.
  await expect(page.locator('.home-watch').first()).toBeVisible();
});

test('finishing the last step shows "You’re all set", which can be hidden', async ({ page }) => {
  // Everything is done except adding money; the balance poll (every 30 s) then finds money, so the list finishes.
  let funded = false;
  await page.clock.install();
  await mock(page, {
    balance: () => (funded ? balances() : emptyBalances()),
    kyc: () => kycAnswer('basic'),
    passkeys: () => passkeyList(1),
    alerts: () => alertList([]),
    activity: () => activityPage([activityRow('trade', 'in', '1', 'BTC')]),
  });
  await open(page);
  await expect(page.locator('.home-started [data-step="deposit"]')).toHaveAttribute('data-status', 'todo');
  await expect(page.locator('.home-started__all')).toHaveCount(0);
  funded = true;
  await page.clock.runFor(31_000);
  await expect(page.locator('.home-started__all')).toContainText('You’re all set');
  await expect(page.locator('.home-started__count')).toHaveText('4 of 4 done');
  await page.screenshot({ path: join(shots, 'home-started-all-set.png') });
  await page.locator('.home-started__all').getByRole('button', { name: 'Hide' }).click();
  await expect(page.locator('.home-started')).toHaveCount(0);
});

test('Get started shows final-size placeholders while the answers are on their way', async ({ page }) => {
  const api = await mock(page, { ...newAccount, kyc: null, passkeys: null, alerts: null, activity: null, balance: null });
  await open(page);
  const started = page.locator('.home-started');
  await expect(started).toBeVisible();
  await expect(started.locator('[data-slot="skeleton"]').first()).toBeVisible();
  await expect(started.locator('[data-status="done"]')).toHaveCount(0); // waiting is never "done"
  await expect(page.locator('.home-activity')).toHaveAttribute('aria-hidden', 'true');
  const before = await started.boundingBox();
  await page.screenshot({ path: join(shots, 'home-new-account-loading.png') });
  await api.release(newAccount);
  await expect(started.locator('.home-started__count')).toHaveText('0 of 4 done');
  const after = await started.boundingBox();
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(2); // nothing jumps when the answers arrive
});

test('a failed activity list says so, with Try again, and does not touch the rest', async ({ page }) => {
  await mock(page, { ...newAccount, activity: 'error' });
  await open(page);
  await expect(page.locator('.home-main')).toContainText('Couldn’t load your activity.');
  await expect(page.locator('.home-started [data-step="trade"]')).toHaveAttribute('data-status', 'unknown');
  await expect(page.locator('.home-started [data-step="deposit"]')).toHaveAttribute('data-status', 'unknown');
  await expect(page.locator('.home-card').first()).toBeVisible();
  await page.screenshot({ path: join(shots, 'home-new-account-error.png') });
  await page.unrouteAll();
  await mock(page, newAccount);
  await page.locator('.home-main').getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.home-main')).toContainText('No activity yet');
});

test('unpriced assets are named, not counted, and never shown as zero', async ({ page }) => {
  await mock(page, { balance: () => balances({ XYZ: { free: '5', used: '0', total: '5' } }) });
  await open(page);
  await expect(page.locator('.home-note')).toContainText('Excludes 1 coin (no USD price)');
  await expect(page.locator('.home-note')).toContainText('Not counted: XYZ');
  await page.unrouteAll();
  await mock(page, { balance: () => balances({ XYZ: { free: '5', used: '0', total: '5' }, ABC: { free: '1', used: '0', total: '1' } }) });
  await page.reload();
  await expect(page.locator('.home-note')).toContainText('Excludes 2 coins (no USD price)');
});

test('a window shorter than a day says "since HH:mm"', async ({ page }) => {
  // Tickers without 24 h numbers: the data layer derives them from hourly candles that began 3 hours ago.
  const hour = 3_600_000;
  const start = Math.floor((Date.now() - 3 * hour) / hour) * hour;
  await mock(page, { tickers: () => tickers({ withOpen: false }), ohlcv: (symbol) => hourlyCandles(symbol, 3) });
  await open(page);
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(start);
  await expect(page.locator('.home-change')).toContainText(`since ${clock}`);
  await expect(page.locator('.home-change')).not.toContainText('Today');
});

test('the server windowStart decides the label: 4 hours is "since", never "Today" (critic H5)', async ({ page }) => {
  const start = Date.now() - 4 * 3_600_000;
  await mock(page, { tickers: () => tickers({ windowStart: start }) });
  await open(page);
  // The browser here runs in UTC and the person has not picked a zone, so the clock is the browser's, with no suffix.
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(start);
  await expect(page.locator('.home-change')).toContainText(`since ${clock}`);
  await expect(page.locator('.home-change')).not.toContainText('Today');
});

test('a zone the person picked is named, so "11:29" is never taken for local time (critic H6)', async ({ page }) => {
  const start = Date.now() - 4 * 3_600_000;
  await page.addInitScript(() =>
    localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ timeZone: 'UTC+8', timeZoneChosen: true })),
  );
  await mock(page, { tickers: () => tickers({ windowStart: start }) });
  await open(page);
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Etc/GMT-8' }).format(
    start,
  );
  await expect(page.locator('.home-change')).toContainText(`since ${clock} UTC+8`);
});

test('no orderable markets: Markets, Top movers and Watchlist are omitted', async ({ page }) => {
  // Without markets there are no prices, so only the stablecoin cash is counted and the coins are named as not counted.
  await mock(page, { markets: [] });
  await open(page);
  await expectHero(page, '$4,100.00');
  await expect(page.locator('.home-note')).toContainText('Excludes 2 coins (no USD price)');
  await expect(page.locator('.home-change')).toHaveCount(0); // unpriced coins alone do not switch the Today line on (critic S4)
  expect(await texts(page.locator('.home-actions > *'))).toEqual(['Send', 'Receive']); // nothing can be bought, sold or converted
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
  await expect(page.locator('[data-slot="state-block"]')).toContainText('Your account is paused while checks are set up.');
  await expect(page.locator('[data-slot="state-block"]')).toContainText('Ref SCR-1'); // a short support reference, small
  await expect(page.locator('[data-slot="state-block"]')).not.toContainText('denied.screening_fixture'); // never the raw code
  expect(await texts(page.locator('.home-actions > *'))).toEqual(['Receive']);
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
  await expectHero(page, '$12,481.29');
});

test('favourites from the existing device store become the Watchlist', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('trade-favorites:00000000-0000-4000-8000-000000000001', JSON.stringify(['ETH-USDT', 'SOL-USDT', 'NOPE-USDT'])),
  );
  await mock(page);
  await open(page);
  await expect(page.locator('.home-watch:not(.home-yours) .home-watch__head h2')).toHaveText('Watchlist');
  expect(await texts(page.locator('.home-watch:not(.home-yours) .home-watch__ticker'))).toEqual(['ETH', 'SOL']);
  // No Edit button: the stars edit the watchlist (critic N6).
  await expect(page.locator('.home-watch__head a, .home-watch__head button')).toHaveCount(0);
});

test('a star on a card or row adds the market to the watchlist and takes it off again', async ({ page }) => {
  await mock(page);
  await open(page);
  await expect(page.locator('.home-watch:not(.home-yours) .home-watch__head h2')).toHaveText('Popular');
  await page.getByRole('button', { name: 'Add ETH to watchlist' }).first().click();
  await expect(page.locator('.home-watch:not(.home-yours) .home-watch__head h2')).toHaveText('Watchlist');
  expect(await texts(page.locator('.home-watch:not(.home-yours) .home-watch__ticker'))).toEqual(['ETH']);
  await expect(page.getByRole('button', { name: 'Remove ETH from watchlist' }).first()).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('trade-favorites:00000000-0000-4000-8000-000000000001'))).toBe('["ETH-USDT"]');
  await page.getByRole('button', { name: 'Remove ETH from watchlist' }).first().click();
  await expect(page.locator('.home-watch:not(.home-yours) .home-watch__head h2')).toHaveText('Popular');
});

test('with four markets or fewer, Top movers is left out because it would repeat the cards (critic M1)', async ({ page }) => {
  await mock(page, { markets: () => markets.filter((market) => ['BTC-USDT', 'ETH-USDT', 'IFC-USDT'].includes(market.symbol)) });
  await open(page);
  await expect(page.locator('.home-card').first()).toBeVisible();
  expect(await page.locator('.home-card').count()).toBe(3);
  await expect(page.locator('.home-pills')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Top movers' })).toHaveCount(0);
});
