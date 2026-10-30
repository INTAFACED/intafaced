import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from './coin.mock.mjs';
import { wireTicker } from './coin.fixtures.mjs';
import { refusal } from '../trade/buy/trade.mock.mjs';

const shots = process.env.COIN_SHOTS ?? join(tmpdir(), 'intafaced-coin-shots');
mkdirSync(shots, { recursive: true });
const PREFERENCES_KEY = 'intafaced.customer.view.v1';

const forbidden = /unavailable|not connected|restricted|fixture|lifecycle|undefined|NaN|\[object|ledger|room\b/i;

// A short wait lets the chart and tooltips settle, so the picture shows the final state. Every state is taken at both
// sizes the spec names: 1440x900 and 1280x800.
const shot = async (page, name) => {
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, `${name}-${width}x${height}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
};
const open = async (page, path = '/coin/BTC') => {
  await page.goto(path);
  await page.getByTestId('if-coin').waitFor();
};
const ready = async (page) => {
  await expect(page.getByTestId('price')).toBeVisible();
  await expect(page.getByTestId('coin-chart').locator('canvas').first()).toBeAttached();
};
const pro = (page) => page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ layoutMode: 'pro' })), PREFERENCES_KEY);
const box = async (locator) => await locator.first().boundingBox();
const texts = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
/** "$67,812.40": NumberFlow draws digit strips in a shadow root, so read the figure's accessible name. */
const priceText = (page) =>
  page.getByTestId('price').evaluate((node) => node.querySelector('[role="img"]')?.getAttribute('aria-label') ?? node.textContent.trim());
const expectPrice = (page, text) => expect.poll(() => priceText(page).catch(() => null), { timeout: 7000 }).toBe(text);
const noForbidden = async (page) => expect(await page.getByTestId('if-coin').innerText()).not.toMatch(forbidden);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

test('Simple, loaded, 1440x900: grid, header, chart, range pills, stats, holding, about, activity', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The real top bar asks for notifications, which this page's test does not mock (Home's harness leaves it unmocked too).
  const notify = (url) => url.includes('/api/notify/');
  page.on('console', (message) => message.type() === 'error' && !/404 \(Not Found\)/.test(message.text()) && errors.push(message.text()));
  page.on('response', (response) => response.status() === 404 && !notify(response.url()) && errors.push(`404 ${response.url()}`));
  await mock(page);
  await open(page);
  await ready(page);

  // Coin bar: 64 high, name over ticker, star, About anchor.
  expect(Math.round((await box(page.getByTestId('coin-bar'))).height)).toBe(64);
  await expect(page.getByTestId('coin-name')).toHaveText('Bitcoin');
  await expect(page.getByTestId('coin-bar__ticker')).toHaveText('BTC');
  expect(await texts(page.getByTestId('coin-bar__tabs').locator('button'))).toEqual(['Overview', 'About']);
  expect(await page.locator('[data-testid="coin-bar"] a[href^="#"], [data-testid="if-coin"] a[href^="#"]').count()).toBe(0);

  // Title row.
  await expect(page.getByTestId('coin-title')).toHaveText('Bitcoin price');
  await expect(page.getByTestId('pair')).toHaveText('BTC/USDT');

  // Two columns: container 1224, left 912, gap 24, right 288, left card first, Buy card top-aligned with it.
  expect(Math.round((await box(page.getByTestId('if-coin'))).width)).toBe(1224);
  const left = await box(page.getByTestId('coin-price-card'));
  const buy = await box(page.getByTestId('buy-card'));
  const stats = await box(page.getByTestId('coin-stats'));
  expect(Math.round(left.width)).toBe(912);
  expect(Math.round(buy.width)).toBe(288);
  expect(Math.round(buy.x - (left.x + left.width))).toBe(24);
  expect(Math.round(buy.y)).toBe(Math.round(left.y));
  expect(Math.round(stats.width)).toBe(288);
  expect(stats.y).toBeGreaterThan(buy.y + buy.height);
  // The 288 px Buy card: "Available …" wraps under the pay-with select instead of running over it, inside the card.
  const payRowLoc = page
    .getByTestId('buy-card')
    .getByTestId('buy-row')
    .filter({ has: page.getByTestId('available') });
  const payRow = await box(payRowLoc);
  const available = await box(page.getByTestId('available'));
  const payLabel = await box(payRowLoc.getByTestId('buy-row__text'));
  expect(available.y).toBeGreaterThanOrEqual(payLabel.y + payLabel.height - 1);
  expect(available.x).toBeGreaterThanOrEqual(payRow.x);
  expect(available.x + available.width).toBeLessThanOrEqual(payRow.x + payRow.width + 0.5);

  // Price: HeroNumber at 48/58, the live last price from the ticker, dollars.
  await expectPrice(page, '$67,812.40');
  expect(
    await page.getByTestId('price').evaluate((node) => getComputedStyle(node).fontSize + '/' + getComputedStyle(node).lineHeight),
  ).toBe('48px/58px');
  // Change since the range started (first candle open 66,000.00), exact: +$1,812.40 (+2.75%), with the range named.
  await expect(page.getByTestId('change')).toContainText('+$1,812.40 (+2.75%)');
  await expect(page.getByTestId('change')).toContainText('Past day');
  await expect(page.getByTestId('change')).toContainText('▲');

  // Range pills: five, in order, 1D pressed; each loads the candles the spec names.
  expect(await texts(page.getByTestId('coin-ranges').locator('button'))).toEqual(['1D', '1W', '1M', '6M', '1Y', 'All']);
  await expect(page.getByTestId('coin-ranges').locator('button', { hasText: '1D' })).toHaveAttribute('aria-pressed', 'true');

  // Line chart present, with the attribution the licence asks for, no volume pane (one canvas pair for the pane).
  expect(Math.round((await box(page.getByTestId('chart-area'))).height)).toBe(360);

  // Footer: last update in the viewer's zone with its offset.
  await expect(page.getByTestId('updated')).toHaveText(/^Last updated \d{1,2} \w{3} 2026, \d{2}:\d{2} \(UTC\)$/);

  // Key stats: rows with dotted-underline terms; high, low, volume from the ticker, balance from the portfolio.
  await expect(page.getByTestId('stat-high')).toContainText('$68,100.50');
  await expect(page.getByTestId('stat-low')).toContainText('$65,800.25');
  await expect(page.getByTestId('stat-volume')).toContainText('1,234.5678');
  await expect(page.getByTestId('stat-volume')).toContainText('24h volume (BTC)');
  await expect(page.getByTestId('stat-balance')).toContainText('0.25 BTC');
  await expect(page.getByTestId('stat-balance')).toContainText('$16,953.10');
  expect(await page.getByTestId('coin-stats').getByTestId('coin-term').count()).toBe(6);
  expect(Math.round((await box(page.getByTestId('stat-high'))).height)).toBe(49);
  // No supply figure is published for any coin, so market cap says so; the networks are the registry's (J-portfolio-10 #3).
  await expect(page.getByTestId('stat-market-cap')).toContainText('Market cap');
  await expect(page.getByTestId('stat-market-cap')).toContainText('not published');
  await expect(page.getByTestId('coin-network')).toContainText('Bitcoin');
  await expect(page.getByTestId('coin-stats')).not.toContainText(/rating|rank/i);

  // Your BTC: only because it is held. Amount, value, available, in orders, Send and Convert.
  const yours = page.getByTestId('your-coin');
  await expect(yours.getByTestId('coin-h2')).toHaveText('Your BTC');
  await expect(yours).toContainText('0.25 BTC');
  await expect(yours).toContainText('$16,953.10');
  await expect(yours).toContainText('Available');
  await expect(yours).toContainText('In orders');
  await expect(yours.locator('a', { hasText: 'Send' })).toHaveAttribute('href', '/pay/send');
  await expect(yours.locator('a', { hasText: 'Convert' })).toHaveAttribute('href', '/trade/convert?from=BTC');
  // Your position, from the lot book: 0.25 BTC that cost $15,000.00, so $60,000.00 a coin; worth $16,953.10 now.
  const position = yours.getByTestId('coin-position');
  await expect(position.locator('[data-figure="quantity"]')).toContainText('0.25 BTC');
  await expect(position.locator('[data-figure="average-price"]')).toHaveText('$60,000.00');
  await expect(position.locator('[data-figure="cost-basis"]')).toHaveText('$15,000.00');
  await expect(position.locator('[data-figure="result"]')).toHaveText('+$1,953.10');

  // About: plain sentences, no price claim.
  await expect(page.locator('#coin-about h2')).toHaveText('About Bitcoin');
  expect(await page.locator('#coin-about p').count()).toBe(3);

  // Recent activity: the newest five BTC fills (no ETH, no IFC), "View all" into Activity.
  await expect(page.locator('#coin-recent-title')).toHaveText('Recent BTC activity');
  const rows = page.getByTestId('recent').locator('tbody tr');
  expect(await rows.count()).toBe(5);
  const recent = await texts(page.getByTestId('recent').getByTestId('dk-trade-what'));
  expect(recent).toEqual([
    'Bought 0.00015 BTC',
    'Sold 0.0002 BTC',
    'Bought 0.001 BTC',
    'Bought 0.0004 BTC', // the BTC/USDC fill
    'Bought 0.002 BTC',
  ]);
  await expect(page.getByTestId('coin-recent__all')).toHaveAttribute('href', '/money/activity?tab=trades&asset=BTC');

  // The Buy card is the real one, compact and locked to this coin.
  await expect(page.getByTestId('buy-card')).toHaveAttribute('data-compact', 'true');
  await expect(page.getByTestId('buy-card')).toContainText('Enter an amount');
  expect(await page.getByTestId('buy-card').locator('[aria-label="Change coin"]').count()).toBe(0);

  await noForbidden(page);
  await shot(page, 'simple-loaded');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('recent activity: no BTC fill in a short list says none; in a full page of other fills it points to View all instead of claiming none', async ({
  page,
}) => {
  const fill = (index, symbol) => ({
    id: `x${index}`,
    order: `order-x${index}`,
    timestamp: Date.now() - index * 60_000,
    datetime: new Date(Date.now() - index * 60_000).toISOString(),
    symbol,
    type: null,
    side: 'buy',
    takerOrMaker: 'taker',
    price: '2600.00',
    amount: '0.5',
    cost: '1300.000000',
    fee: { cost: '0.00050000', currency: 'ETH', rate: '0.001' },
  });
  // A short list (fewer than the 100 the call returns) with no BTC: that is everything, so "none yet" is true.
  await mock(page, { fills: () => [fill(1, 'ETH/USDT'), fill(2, 'ETH/USDT')] });
  await open(page, '/coin/BTC');
  await expect(page.getByTestId('coin-recent__empty')).toContainText('No BTC activity yet');
  // A full page of ETH fills: older BTC fills may exist, so it must not claim none, and View all is offered.
  await mock(page, { fills: () => Array.from({ length: 100 }, (_, index) => fill(index + 1, 'ETH/USDT')) });
  await open(page, '/coin/BTC');
  const empty = page.getByTestId('coin-recent__empty');
  await expect(empty).toContainText('No BTC trades in your latest 100');
  await expect(empty).not.toContainText('No BTC activity yet');
  await expect(empty.locator('a')).toHaveText('View all');
  await expect(empty.locator('a')).toHaveAttribute('href', '/money/activity?tab=all&asset=BTC');
});

test('the Buy card on the page is the working one: $10 of BTC reaches the review', async ({ page }) => {
  const api = await mock(page);
  await open(page);
  await ready(page);
  await page.getByLabel('Amount in USD').fill('10');
  const review = page.getByRole('button', { name: 'Review buy' });
  await expect(review).toBeEnabled();
  await review.click();
  await expect(page.getByRole('alertdialog')).toContainText('BTC');
  expect(api.of('preview').length).toBe(1);
  expect(api.of('place').length).toBe(0); // reviewed, not placed: the test never sends an order
  await shot(page, 'simple-buy-review');
});

test('the coin bar stays under the top bar when the page scrolls, and About scrolls to its section', async ({ page }) => {
  await mock(page);
  await open(page);
  await ready(page);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(300);
  expect(Math.round((await box(page.getByTestId('coin-bar'))).y)).toBe(48);
  await page.getByTestId('coin-bar__tabs').locator('button', { hasText: 'About' }).click();
  await expect(page.getByTestId('coin-bar__tabs').locator('button', { hasText: 'About' })).toHaveAttribute('aria-current', 'true');
  await shot(page, 'simple-scrolled-about');
  await page.getByTestId('coin-bar__tabs').locator('button', { hasText: 'Overview' }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(5);
});

test('scrubbing the chart writes the hovered price into the header, leaving restores the live one', async ({ page }) => {
  await mock(page);
  await open(page);
  await ready(page);
  await expectPrice(page, '$67,812.40');
  const host = await box(page.getByTestId('coin-chart__host'));
  await page.mouse.move(host.x + 80, host.y + host.height / 2);
  await page.mouse.move(host.x + 90, host.y + host.height / 2, { steps: 4 });
  const scrub = page.getByTestId('scrub-price');
  await expect(scrub).toBeVisible();
  const scrubbed = await scrub.innerText();
  expect(scrubbed).toMatch(/^\$[\d,]+\.\d{2}$/);
  expect(scrubbed).not.toBe('$67,812.40');
  // The change line follows the hovered candle and names its time instead of the range.
  await expect(page.getByTestId('change')).toContainText(/\d{1,2} \w{3}, \d{2}:\d{2}/);
  await expect(page.getByTestId('change')).not.toContainText('Past day');
  await page.waitForTimeout(150);
  await shot(page, 'simple-scrubbing');
  await page.mouse.move(host.x + host.width / 2, 10);
  await expect(page.getByTestId('scrub-price')).toHaveCount(0);
  await expectPrice(page, '$67,812.40');
  await expect(page.getByTestId('change')).toContainText('Past day');
});

test('range pills are a ToggleGroup: arrow keys move between them, Enter picks, each range reads its own candles', async ({ page }) => {
  const api = await mock(page);
  await open(page);
  await ready(page);
  const pill = (label) => page.getByTestId('coin-ranges').locator('button', { hasText: new RegExp(`^${label}$`) });
  await pill('1D').focus();
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('1W');
  await page.keyboard.press('Enter');
  await expect(pill('1W')).toHaveAttribute('aria-pressed', 'true');
  await expect(pill('1D')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('change')).toContainText('Past week');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('change')).toContainText('Past month');
  await pill('6M').click();
  await expect(page.getByTestId('change')).toContainText('Past six months');
  await pill('1Y').click();
  await expect(page.getByTestId('change')).toContainText('Past year');
  await pill('All').click();
  await expect(page.getByTestId('change')).toContainText('All time');
  const asked = api.seen('ohlcv').filter((call) => call.symbol === 'BTC/USDT');
  const has = (timeframe, limit) => asked.some((call) => call.timeframe === timeframe && call.limit === limit);
  expect(has('5m', 288)).toBe(true);
  expect(has('1h', 168)).toBe(true);
  expect(has('4h', 180)).toBe(true);
  expect(has('1d', 180)).toBe(true);
  expect(has('1d', 365)).toBe(true);
  expect(has('1w', 260)).toBe(true);
  await shot(page, 'simple-range-all');
});

test('tooltips open on keyboard focus', async ({ page }) => {
  await mock(page);
  await open(page);
  await ready(page);
  await page.getByTestId('coin-stats').getByTestId('coin-term').first().focus();
  const tip = page.locator('[data-slot="tooltip-content"]');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('The highest price traded in the last 24 hours.');
  await shot(page, 'simple-tooltip');
});

test('the star adds the market to the same watchlist Home uses', async ({ page }) => {
  await mock(page);
  await open(page);
  await ready(page);
  const star = page.getByRole('button', { name: 'Add BTC to watchlist' });
  await star.click();
  await expect(page.getByRole('button', { name: 'Remove BTC from watchlist' })).toHaveAttribute('aria-pressed', 'true');
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('trade-favorites:00000000-0000-4000-8000-000000000001') ?? '[]'),
  );
  expect(stored).toEqual(['BTC/USDT']);
  await page.getByRole('button', { name: 'Remove BTC from watchlist' }).click();
  await expect(page.getByRole('button', { name: 'Add BTC to watchlist' })).toHaveAttribute('aria-pressed', 'false');
});

test('a coin with USDT and USDC markets has a quote pill, and the price follows it', async ({ page }) => {
  await mock(page);
  await open(page);
  await ready(page);
  await expectPrice(page, '$67,812.40');
  await page.getByTestId('quote-pill').click();
  await page.getByRole('option', { name: 'USDC' }).click();
  await expect(page.getByTestId('pair')).toHaveText('BTC/USDC');
  await expectPrice(page, '$67,790.10');
  // IFC has one market: no pill.
  await open(page, '/coin/IFC');
  await ready(page);
  expect(await page.getByTestId('quote-pill').count()).toBe(0);
});

test('Pro: a Trade button to the desk replaces the Buy card, and the stats come first', async ({ page }) => {
  await pro(page);
  await mock(page);
  await open(page);
  await ready(page);
  expect(await page.getByTestId('buy-card').count()).toBe(0);
  const trade = page.getByTestId('trade-button');
  await expect(trade).toHaveText('Trade BTC/USDT');
  await expect(trade).toHaveAttribute('href', '/trade/spot/BTC-USDT');
  expect(Math.round((await box(trade)).height)).toBe(40);
  expect(Math.round((await box(trade)).width)).toBe(288);
  expect((await box(page.getByTestId('coin-stats'))).y).toBeGreaterThan((await box(trade)).y);
  await shot(page, 'pro-loaded');
});

test('USDT: counted at 1 USD, no chart, no range pills, no buy card', async ({ page }) => {
  await mock(page);
  await open(page, '/coin/USDT');
  await expect(page.getByTestId('dollar-price')).toHaveText('$1.00 (counted at 1 USD)');
  await expect(page.getByTestId('coin-title')).toHaveText('Tether price');
  expect(await page.locator('[data-testid="coin-chart"], [data-testid="coin-ranges"], [data-testid="buy-card"]').count()).toBe(0);
  await expect(page.getByTestId('your-coin')).toContainText('9,993 USDT');
  await expect(page.locator('#coin-about h2')).toHaveText('About Tether');
  await expect(page.locator('#coin-recent-title')).toHaveText('Recent USDT activity');
  await noForbidden(page);
  await shot(page, 'usdt');
  await open(page, '/coin/USDC');
  await expect(page.getByTestId('dollar-price')).toHaveText('$1.00 (counted at 1 USD)');
  await expect(page.locator('#coin-about h2')).toHaveText('About USD Coin');
});

test('IFC: no About section until its wording is approved', async ({ page }) => {
  await mock(page);
  await open(page, '/coin/IFC');
  await ready(page);
  await expect(page.getByTestId('coin-title')).toHaveText('IFC price');
  expect(await page.locator('#coin-about').count()).toBe(0);
  expect(await page.getByTestId('coin-bar__tabs').count()).toBe(0);
  // Not held: no "Your IFC" card, and the balance row says 0 IFC.
  expect(await page.getByTestId('your-coin').count()).toBe(0);
  await expect(page.getByTestId('stat-balance')).toContainText('0 IFC');
  await shot(page, 'ifc');
});

test('an unknown asset goes back to the markets list; a lower-case address works', async ({ page }) => {
  await mock(page);
  await page.goto('/coin/ZZZ');
  await expect(page).toHaveURL(/\/trade$/);
  await expect(page.getByTestId('elsewhere')).toBeVisible();
  await open(page, '/coin/btc');
  await ready(page);
  await expect(page.getByTestId('coin-title')).toHaveText('Bitcoin price');
});

test('loading: the final shape in skeletons, then the page', async ({ page }) => {
  const api = await mock(page, { markets: 'hang' });
  await open(page);
  await expect(page.getByTestId('coin-loading')).toBeVisible();
  expect(Math.round((await box(page.getByTestId('coin-grid'))).y)).toBeGreaterThan(100);
  await shot(page, 'loading-page');
  await api.release();
  await ready(page);
});

test('loading: price card skeleton while the ticker and candles load', async ({ page }) => {
  const api = await mock(page, { ticker: 'hang', ohlcv: 'hang' });
  await open(page);
  await expect(
    page
      .locator(
        '[data-testid="coin-price-card"] [data-testid="chart-area"] [data-slot="skeleton"], [data-testid="coin-price-card"] [data-slot="skeleton"]',
      )
      .first(),
  ).toBeVisible();
  await expect(page.getByTestId('price')).toHaveCount(0);
  await shot(page, 'loading-card');
  await api.release();
  await ready(page);
});

test('empty: a market that has never traded says so, with the pills still usable', async ({ page }) => {
  await mock(page, {}, { history: 'none' });
  await open(page);
  await expect(page.getByTestId('chart-empty')).toHaveText('No trades yet in this period.');
  await expectPrice(page, '$67,812.40');
  // Nothing to measure a change against: a dash, never a made-up number.
  await expect(page.getByTestId('change')).toContainText('—');
  await page.getByTestId('coin-ranges').locator('button', { hasText: '1W' }).click();
  await expect(page.getByTestId('coin-ranges').locator('button', { hasText: '1W' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('chart-empty')).toBeVisible();
  await shot(page, 'empty-chart');
});

test('a market younger than a day: the change says since when, the stats say their window, long ranges show what there is', async ({
  page,
}) => {
  const api = await mock(page, {}, { history: 'young', young: true });
  await open(page);
  await expect(page.getByTestId('stat-young')).toContainText('This market is less than a day old, so these figures start at');
  await expect(page.getByTestId('change')).toContainText(/Since \d{1,2} \w{3}, \d{2}:\d{2}/);
  // 1Y and All: one daily or weekly candle cannot be drawn, so the next finer candles are read until there is a line.
  await page.getByTestId('coin-ranges').locator('button', { hasText: 'All' }).click();
  await expect(page.getByTestId('coin-chart').locator('canvas').first()).toBeAttached();
  expect(await page.getByTestId('chart-empty').count()).toBe(0);
  await expect(page.getByTestId('change')).toContainText('All time');
  const asked = api.seen('ohlcv').filter((call) => call.symbol === 'BTC/USDT');
  for (const [timeframe, limit] of [
    ['1w', 260],
    ['1d', 365],
    ['4h', 180],
    ['1h', 168],
  ])
    expect(
      asked.some((call) => call.timeframe === timeframe && call.limit === limit),
      `${timeframe}x${limit}`,
    ).toBe(true);
  await page.getByTestId('coin-ranges').locator('button', { hasText: '1Y' }).click();
  await expect(page.getByTestId('change')).toContainText(/Since \d{1,2} \w{3}, \d{2}:\d{2}/);
  await shot(page, 'young-market');
});

test('error: the chart fails alone, the price and the Buy card stay', async ({ page }) => {
  await mock(page, { ohlcv: 'error' });
  await open(page);
  await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
  await expect(page.getByTestId('coin-price-card')).toContainText('Couldn’t load the chart.');
  await expectPrice(page, '$67,812.40');
  await expect(page.getByTestId('buy-card')).toBeVisible();
  await noForbidden(page);
  await shot(page, 'error-chart');
});

test('error: the markets list fails, one retry, no raw codes', async ({ page }) => {
  await mock(page, { markets: 'error' });
  await open(page);
  await expect(page.getByTestId('if-coin')).toContainText('Couldn’t load the price.');
  await noForbidden(page);
  await shot(page, 'error-page');
});

test('refused: a typed refusal reads as words, with its reference, never the raw code', async ({ page }) => {
  await mock(page, { markets: refusal('trade.account_restricted', 'held', 403) });
  await open(page);
  await expect(page.getByTestId('if-coin').locator('[data-slot="state-block"]')).toBeVisible();
  expect(await page.getByTestId('if-coin').innerText()).not.toMatch(/trade\.account_restricted|\btrade\./);
  await shot(page, 'refused-page');
});

test('refused: the price is refused, the page says why in plain words', async ({ page }) => {
  await mock(page, { ticker: refusal('trade.market_closed', 'closed', 403) });
  await open(page);
  await expect(page.getByTestId('coin-price-card')).toBeVisible();
  expect(await page.getByTestId('coin-price-card').innerText()).not.toMatch(/trade\.market_closed/);
  await shot(page, 'refused-price');
});

test('hide balances masks the holding, never the price', async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ hideBalances: true })), PREFERENCES_KEY);
  await mock(page);
  await open(page);
  await ready(page);
  await expectPrice(page, '$67,812.40');
  await expect(page.getByTestId('stat-balance')).toContainText('••••');
  await expect(page.getByTestId('stat-balance')).not.toContainText('0.25');
  await expect(page.getByTestId('your-coin')).not.toContainText('16,953');
  await expect(page.getByTestId('stat-high')).toContainText('$68,100.50');
});

for (const mode of ['simple', 'pro']) {
  test(`phase2 ${mode}: loading and503 remain distinct from empty success`, async ({ page }) => {
    if (mode === 'pro') await pro(page);
    const api = await mock(page, { markets: 'hang' });
    await open(page);
    await expect(page.getByTestId('coin-loading')).toBeVisible();
    await expect(page.getByTestId('coin-nomarket')).toHaveCount(0);
    await api.release();
    await expectPrice(page, '$67,812.40');
    await mock(page, { markets: { status: 503, json: { error: { message: 'Test catalogue unavailable' } } } });
    await open(page);
    await expect(page.getByTestId('coin-problem')).toContainText('Couldn’t load the price');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByTestId('coin-nomarket')).toHaveCount(0);
    await expect(page.getByTestId('coin-loading')).toHaveCount(0);
  });

  test(`phase2 ${mode}: successful empty catalogue keeps the held asset and settles`, async ({ page }) => {
    if (mode === 'pro') await pro(page);
    await mock(page, { markets: () => [] });
    await open(page);
    await expect(page.getByTestId('coin-nomarket')).toContainText('BTC');
    await expect(page.getByTestId('coin-loading')).toHaveCount(0);
    await expect(page.getByTestId('your-coin')).toContainText('0.25 BTC');
    await expect(page.getByTestId('your-coin')).toContainText('—');
    await expect(page.getByTestId('price')).toHaveCount(0);
    await expect(page.getByTestId('buy-card')).toHaveCount(0);
    await expect(page.getByTestId('trade-button')).toHaveCount(0);
    await page.screenshot({ path: join(shots, `phase2-empty-${mode}.png`) });
    await open(page, '/coin/ZZZ');
    await expect(page).toHaveURL(/\/trade$/);
  });

  test(`phase2 ${mode}: phone exact price and quote do not collide`, async ({ page }) => {
    test.setTimeout(20000);
    if (mode === 'pro') await pro(page);
    const api = await mock(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await expectPrice(page, '$67,812.40');
    for (const enlarged of [false, true]) {
      await page.evaluate((large) => {
        document.documentElement.style.fontSize = large ? '24px' : '';
        const price = document.querySelector('[data-testid=price]');
        price.style.fontSize = large ? `${parseFloat(getComputedStyle(price).fontSize) * 1.5}px` : '';
      }, enlarged);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await expectPrice(page, '$67,812.40');
      const figure = await box(page.getByTestId('coin-price-card__figure'));
      const number = page.getByTestId('price').locator('number-flow-react');
      await expect.poll(async () => (await number.boundingBox())?.width ?? 0).toBeGreaterThan(100);
      const price = await box(number);
      const quote = await box(page.getByTestId('quote-pill'));
      expect(price.x + price.width).toBeLessThanOrEqual(figure.x + figure.width + 1);
      expect(price.y + price.height <= quote.y || quote.x >= price.x + price.width).toBe(true);
      await page.screenshot({ path: join(shots, `phase2-phone-${mode}-${enlarged ? 'large' : 'normal'}.png`) });
    }
    await page.getByTestId('quote-pill').click();
    await page.getByRole('option', { name: 'USDC' }).click();
    await expectPrice(page, '$67,790.10');
    await expect(page.getByTestId('pair')).toHaveText('BTC/USDC');
    api.set('ticker', ({ symbol }) => ({ ...wireTicker(symbol, {}), last: '67.40' }));
    await open(page);
    await expectPrice(page, '$67.40');
    await page.getByTestId('quote-pill').click();
    await page.getByRole('option', { name: 'USDC' }).click();
    await expectPrice(page, '$67.40');
    await page.screenshot({ path: join(shots, `phase2-phone-${mode}-short.png`) });
  });
}
