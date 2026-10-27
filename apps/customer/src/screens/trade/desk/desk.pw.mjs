import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Exchange, book, markets } from './desk.fixtures.mjs';

const shots = process.env.DESK_SHOTS ?? join(tmpdir(), 'intafaced-desk-shots');
mkdirSync(shots, { recursive: true });

const forbidden = /unavailable|not connected|restricted|fixture|lifecycle/i;
const PAIR = '/trade/spot/BTC-USDT';

/** Answer the exchange REST calls the desk makes. A held name waits until `release()`. */
async function mount(page, exchange = new Exchange(), { hold = [], url = PAIR } = {}) {
  const held = new Set(hold);
  const waiting = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on(
    'console',
    (message) => message.type() === 'error' && !/Failed to load resource/.test(message.text()) && errors.push(message.text()),
  );
  const answer = async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    const path = target.pathname.replace(/^\/api\/v1\//, '');
    const result = exchange.handle({
      method: request.method(),
      path,
      query: Object.fromEntries(target.searchParams),
      body: request.method() === 'GET' ? undefined : request.postData() === null ? null : request.postDataJSON(),
      headers: request.headers(),
    });
    if (exchange.opts.delayPlace && request.method() === 'POST' && path === 'orders')
      await new Promise((done) => setTimeout(done, exchange.opts.delayPlace));
    if (result === 'abort') return route.abort('connectionreset');
    return route.fulfill(result);
  };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/v1\//, '');
    if (held.has(path.split('/')[0])) return void waiting.push(route);
    return answer(route);
  });
  await page.goto(url);
  return {
    exchange,
    errors,
    release: async () => {
      held.clear();
      for (const route of waiting.splice(0)) await answer(route);
    },
    requests: (method, path) => exchange.requests.filter((r) => r.method === method && r.path === path),
  };
}

const ready = async (page) => {
  await page.getByTestId('dk-ticker').getByTestId('dk-pair').waitFor();
  await page.locator('[data-testid="dk-bk-row"][data-side="bid"]').first().waitFor();
};
const shot = async (page, name, { full = false } = {}) => {
  await page.waitForTimeout(350); // let dialogs and fades finish
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: full });
};
/** Every size the desk is checked at: 1440x900, 1280x800 and the narrow phone width 390x844. */
const shotBoth = async (page, name, options) => {
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await shot(page, `${name}-${width}`, options);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
};
const buyForm = (page) => page.locator('form[data-testid="dk-form"][data-side="buy"]');
const sellForm = (page) => page.locator('form[data-testid="dk-form"][data-side="sell"]');
async function fillBuy(page, { price, amount }) {
  const form = buyForm(page);
  if (price !== undefined) await form.getByRole('textbox', { name: 'Price' }).fill(price);
  await form.getByRole('textbox', { name: 'Amount' }).fill(amount);
}
const buyButton = (page) => buyForm(page).getByRole('button', { name: 'Buy BTC' });
const openReview = async (page) => {
  await expect(buyButton(page)).toBeEnabled();
  await buyButton(page).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
};

test('classic desktop keeps the complete ticket and monitoring tabs in view at three widths', async ({ page }) => {
  const mounted = await mount(page);
  await ready(page);
  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(page.getByTestId('dk-left')).toBeVisible();
    for (const selector of [
      '[data-testid="dk-form"][data-side="buy"] button[type="submit"]',
      '[data-testid="dk-form"][data-side="sell"] button[type="submit"]',
      '[data-testid="dk-bottom-head"]',
    ]) {
      const rectangle = await page.locator(selector).boundingBox();
      expect(rectangle, selector).not.toBeNull();
      expect(rectangle.y + rectangle.height, `${selector} at ${width}`).toBeLessThanOrEqual(height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await shot(page, `classic-compact-${width}x${height}`);
  }
  expect(mounted.errors).toEqual([]);
});

test('ready state at 1440x900: the three columns, ticker, chart, book, form, strip and the words', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page.getByTestId('pc-host').locator('a[href*="tradingview"]')).toHaveCount(1); // attribution kept
  await page.waitForTimeout(800);

  // Classic compact: watchlist | chart and dual ticket | book, with 1 px dividers.
  const box = async (selector) => await page.locator(selector).first().boundingBox();
  expect(Math.abs((await box('[data-testid="dk-left"]')).width - 216)).toBeLessThanOrEqual(2);
  expect(Math.abs((await box('[data-testid="dk-book"]')).width - 264)).toBeLessThanOrEqual(2);
  const centre = await box('[data-testid="dk-centre"]');
  expect(Math.abs(centre.width - (1440 - 216 - 264 - 2))).toBeLessThanOrEqual(2);
  expect((await box('[data-testid="dk-ticker"]')).height).toBe(48);
  const gutter = await page
    .getByTestId('if-desk')
    .evaluate((node) => getComputedStyle(node).rowGap + ' ' + getComputedStyle(node).backgroundColor);
  expect(gutter).toContain('1px');

  // Ticker strip: every figure from /ticker; plain quote prices, no "$" (critic L8)
  await expect(page.getByTestId('dk-pair')).toHaveText('BTC/USDT');
  await expect(page.getByTestId('dk-last')).toHaveText('65,000.00');
  await expect(page.getByTestId('dk-stats')).toContainText('24h low');
  await expect(page.getByTestId('dk-stats')).toContainText('64,100.00');
  await expect(page.getByTestId('dk-stats')).toContainText('65,400.00');
  await expect(page.getByTestId('dk-stats')).toContainText('24h volume (BTC)');
  await expect(page.getByTestId('dk-stats')).toContainText('1.8894');
  await expect(page.getByTestId('dk-stats')).toContainText('24h turnover (USDT)');
  // The trading mode is the listing's lifecycle state, not the ticker's
  await expect(page.getByTestId('dk-stats')).toContainText('Trading mode');
  await expect(page.getByTestId('dk-stats')).toContainText('Cash spot · Open');

  // Order book: 22 px rows, asks highest first, best ask next to the mid price, depth bars
  const row = page.locator(':is([data-testid="dk-bk-row"], [data-testid="dk-bk-row--tape"])').first();
  expect((await row.boundingBox()).height).toBe(22);
  expect(await row.evaluate((node) => getComputedStyle(node).fontSize)).toBe('12px');
  const askPrices = await page.locator('[data-testid="dk-bk-row"][data-side="ask"] [data-testid="dk-bk-price"]').allTextContents();
  const bidPrices = await page.locator('[data-testid="dk-bk-row"][data-side="bid"] [data-testid="dk-bk-price"]').allTextContents();
  expect(askPrices.length).toBeGreaterThan(5);
  expect(askPrices.at(-1)).toBe('65,000.10');
  expect(bidPrices[0]).toBe('64,999.90');
  const asc = [...askPrices].map((p) => Number(p.replace(/,/g, '')));
  expect(asc).toEqual([...asc].sort((a, b) => b - a));
  expect(
    await page
      .locator('[data-testid="dk-bk-row"][data-side="bid"]')
      .first()
      .getByTestId('dk-bk-bar')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(7, 33, 16)');
  expect(
    await page
      .locator('[data-testid="dk-bk-row"][data-side="ask"]')
      .first()
      .getByTestId('dk-bk-bar')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(40, 13, 20)');
  await expect(page.getByTestId('dk-bk-ratio')).toContainText('B ');
  await expect(page.getByTestId('dk-bk-mid')).toContainText('65,000.00');

  // Forms side by side with the up and down colours and near-black text on green
  await expect(buyButton(page)).toBeDisabled();
  expect(await buyButton(page).evaluate((node) => getComputedStyle(node).color)).toBe('rgb(11, 11, 11)');
  expect(
    await sellForm(page)
      .getByRole('button', { name: 'Sell BTC' })
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(202, 63, 100)');
  await expect(buyForm(page)).toContainText('Available');
  await expect(buyForm(page)).toContainText('4,100 USDT');
  await expect(buyForm(page)).toContainText('Fee —');

  // Bottom strip and the market list
  await expect(page.getByRole('tab', { name: 'Open orders' })).toBeVisible();
  await expect(page.getByText('No open orders.')).toBeVisible();
  await page.getByRole('tab', { name: 'Positions' }).click();
  await expect(page.getByText('Not applicable: cash spot holds balances, not positions')).toBeVisible();
  await page.getByRole('tab', { name: 'Open orders' }).click();
  await expect(page.getByTestId('dk-mk-row')).toHaveCount(4);
  await expect(page.locator('[data-testid="dk-mk-row"][data-selected] [data-testid="dk-mk-pair"]')).toHaveText('BTC/USDT');

  // Words
  expect(await page.locator('main').innerText()).not.toMatch(forbidden);
  expect(m.errors).toEqual([]);
  await shotBoth(page, 'desk-loaded');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('market list: a young market’s "since" mark stays inside its own row (Phantom 24 Oct)', async ({ page }) => {
  const exchange = new Exchange();
  exchange.opts.windowStart = Date.now() - 4 * 60 * 60 * 1000;
  await mount(page, exchange);
  await ready(page);
  const rows = page.getByTestId('dk-mk-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText('since');
  const overflow = await rows.evaluateAll((items) =>
    items.flatMap((row) => {
      const box = row.getBoundingClientRect();
      return [
        ...row.querySelectorAll(
          '[data-testid="dk-mk-pair"], [data-testid="dk-mk-price"], [data-testid="dk-mk-sub"], [data-testid="dk-mk-change"]',
        ),
      ]
        .filter((node) => {
          const r = node.getBoundingClientRect();
          return r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5;
        })
        .map((node) => `${row.querySelector('.dk-mk-pair')?.textContent} ${node.className} ${node.getBoundingClientRect().height}px`);
    }),
  );
  expect(overflow).toEqual([]);
  // Side by side, the name and the figures do not run into each other either.
  const clash = await rows.evaluateAll(
    (items) =>
      items.filter((row) => {
        const name = row.querySelector('[data-testid="dk-mk-name"]');
        if (name.scrollWidth > name.clientWidth) return true; // its text runs past its own box
        const right = name.getBoundingClientRect().right;
        return [...row.querySelectorAll('[data-testid="dk-mk-figures"] > *')].some((node) => node.getBoundingClientRect().left < right);
      }).length,
  );
  expect(clash).toBe(0);
  await page.getByTestId('dk-mk-list').screenshot({ path: join(shots, 'desk-markets-young.png') });
});

test('chart: intervals, candles and line, market rules; the book tabs and grouping', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await expect(page.getByRole('button', { name: '15m' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '1h' }).click();
  await expect(page.getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => m.exchange.requests.filter((r) => r.path.startsWith('ohlcv/')).length).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: '30m' }).click();
  await expect(page.getByRole('button', { name: /^30m/ })).toBeVisible();
  await page.getByRole('button', { name: 'Line' }).click();
  await expect(page.getByRole('button', { name: 'Line' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pc-legend')).toBeVisible();
  await page.getByRole('tab', { name: 'Info' }).click();
  await expect(page.getByTestId('dk-info')).toContainText('Price step');
  await expect(page.getByTestId('dk-info')).toContainText('0.01 USDT');
  await expect(page.getByTestId('dk-info')).toContainText('0.00001 BTC');
  await expect(page.getByTestId('dk-info')).toContainText('The fee for an order is shown with the order check');
  await shotBoth(page, 'desk-chart-info');
  await page.getByRole('tab', { name: 'Chart' }).click();

  // Grouping: x10 merges 0.10 steps into whole-dollar buckets
  await page.getByRole('combobox', { name: 'Group prices by' }).click();
  await page.getByRole('option', { name: '1', exact: true }).click();
  const bids = await page.locator('[data-testid="dk-bk-row"][data-side="bid"] [data-testid="dk-bk-price"]').allTextContents();
  expect(bids[0]).toBe('64,999');
  // Last trades
  await page.getByRole('tab', { name: 'Last trades' }).click();
  await expect(page.getByTestId('dk-bk-row--tape').first()).toBeVisible();
  await expect.poll(() => m.exchange.requests.some((r) => r.path.startsWith('trades/'))).toBe(true);
  await shotBoth(page, 'desk-trades');
  expect(m.errors).toEqual([]);
});

test('limit buy: preview, review, placed, in Open orders, cancelled; one request each, ids from the app', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  await expect(buyForm(page).getByRole('textbox', { name: 'Total' })).toHaveValue('6.39999'); // the exact product
  await openReview(page);
  const dialog = page.getByRole('alertdialog');
  // The numbers in the review are the server's preview strings.
  const expected = m.exchange.preview({
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'limit',
    amount: '0.0001',
    price: '63999.9',
    timeInForce: 'GTC',
    postOnly: false,
  });
  await expect(dialog).toContainText('Review your buy');
  await expect(dialog).toContainText('63,999.90 USDT');
  await expect(dialog).toContainText(`${expected.holdAmount} USDT`);
  await expect(dialog).toContainText(`${expected.estimatedFee} BTC (up to 0.10%)`);
  // The order's fee role, and the client id a retry sends again (J-cex-spot-01 step 6).
  // A resting GTC limit is only a taker if it fills at once: the server's taker rate is the worst case.
  await expect(dialog).toContainText('Taker if it fills at once; any part that rests on the book pays the maker rate');
  await expect(dialog).toContainText('A retry sends this same ID, so it can’t become a second order.');
  const shownId = await dialog.getByText('Client order ID').locator('..').getByTestId('client-order-id').innerText();
  await shotBoth(page, 'desk-review-limit');
  expect(m.requests('POST', 'orders')).toHaveLength(0); // nothing sent until the click

  m.exchange.opts.delayPlace = 900;
  await dialog.getByRole('button', { name: 'Confirm buy' }).click();
  // While the order is on its way the desk says nothing about "checking": that is only for a lost answer.
  await page.waitForTimeout(400);
  await expect(page.getByTestId('dk-note--warn')).toHaveCount(0);
  await expect(buyButton(page)).toBeDisabled();
  await expect(dialog).toHaveCount(0);
  await expect(buyForm(page)).toContainText('Your buy order is in');
  await expect(page.getByText('We haven’t found it. It may still arrive: check again in a moment.')).toHaveCount(0); // no lookup ran for an order still in flight
  expect(m.requests('POST', 'orders')).toHaveLength(1);
  const sent = m.requests('POST', 'orders')[0].body;
  expect(sent).toMatchObject({
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'limit',
    amount: '0.0001',
    price: '63999.9',
    timeInForce: 'GTC',
    postOnly: false,
  });
  expect(sent.clientOrderId).toMatch(/^desk:/);
  expect(sent.clientOrderId.endsWith(`:${shownId}`)).toBe(true); // the reference the review showed is the order sent
  // The marker that guards against a lost answer is gone once the outcome is known.
  expect(await page.evaluate(() => localStorage.getItem('trade-pending:00000000-0000-4000-8000-000000000001'))).toBeNull();

  const table = page.getByTestId('dk-bottom-body').locator('table');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.locator('tbody tr').first()).toContainText('BTC/USDT');
  await expect(table.locator('tbody tr').first()).toContainText('63,999.90');
  await expect(table.locator('tbody tr').first()).toContainText('Limit');
  // What the order holds, from the service's wire (J-cex-spot-05 step 1).
  await expect(table.locator('thead')).toContainText('Held');
  await expect(table.locator('tbody tr').first()).toContainText('6.399990 USDT');
  await shotBoth(page, 'desk-open-order', { full: true });

  await table.getByRole('button', { name: /Cancel buy order/ }).click();
  await expect(table.locator('tbody tr')).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByText('No open orders.')).toBeVisible();
  expect(m.requests('DELETE', 'orders/order-1')).toHaveLength(1);
  await shotBoth(page, 'desk-cancelled', { full: true });
  expect(m.errors).toEqual([]);
});

test('market buy: the preview shows the fee and the price protection before confirming; the fill lands in Trade history', async ({
  page,
}) => {
  const m = await mount(page);
  await ready(page);
  await page.getByRole('tab', { name: 'Market' }).click();
  await expect(buyForm(page).getByRole('textbox', { name: 'Price' })).toBeDisabled();
  await buyForm(page).getByRole('textbox', { name: 'Amount' }).fill('0.0001');
  await openReview(page);
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Market price');
  await expect(dialog).toContainText('Price protection');
  await expect(dialog).toContainText('You won’t pay more than 65,650.10 USDT per BTC');
  await expect(dialog).toContainText('up to 0.10%');
  await shotBoth(page, 'desk-review-market');
  await dialog.getByRole('button', { name: 'Confirm buy' }).click();
  await expect(buyForm(page)).toContainText('Your buy order filled: 0.0001 BTC');
  const sent = m.requests('POST', 'orders')[0].body;
  expect(sent.type).toBe('market');
  expect('price' in sent).toBe(false);
  await page.getByRole('tab', { name: 'Trade history' }).click();
  const row = page.getByTestId('dk-bottom-body').locator('table tbody tr').first();
  await expect(row).toContainText('BTC/USDT');
  await expect(row).toContainText('65,000.10');
  await expect(row).toContainText('0.0001');
  // The fill says which side of the book it was on and the rate its fee was charged at (the service's own words).
  await expect(row).toContainText('Taker');
  await expect(row).toContainText('0.20%');
  await shotBoth(page, 'desk-trade-history', { full: true });
  expect(m.errors).toEqual([]);
});

test('client refusals: below the smallest order; finer than the lot or tick cannot be typed; nothing is previewed or sent', async ({
  page,
}) => {
  const m = await mount(page);
  await ready(page);
  await fillBuy(page, { price: '40000', amount: '0.0001' });
  await expect(buyForm(page)).toContainText('The smallest order is 5 USDT');
  await expect(buyButton(page)).toBeDisabled();
  await page.waitForTimeout(1200);
  expect(m.requests('POST', 'orders/preview')).toHaveLength(0);
  expect(m.requests('POST', 'orders')).toHaveLength(0);
  await shotBoth(page, 'desk-client-refusal', { full: true });
  // A price finer than the tick, or an amount finer than the lot, cannot even be typed.
  const price = buyForm(page).getByRole('textbox', { name: 'Price' });
  await price.fill('');
  await price.pressSequentially('64000.005');
  await expect(price).toHaveValue('64000.00');
  const amount = buyForm(page).getByRole('textbox', { name: 'Amount' });
  await amount.fill('');
  await amount.pressSequentially('0.000015');
  await expect(amount).toHaveValue('0.00001');
  expect(m.requests('POST', 'orders')).toHaveLength(0);
});

test("the pair's rules are on the ticket: steps, smallest order, price band and open-order cap as published", async ({ page }) => {
  await mount(page);
  await ready(page);
  const rules = page.locator('details[data-testid="dk-rules"]');
  await expect(rules.locator('summary')).toHaveText('BTC/USDT rules');
  await rules.locator('summary').click();
  await expect(rules).toContainText('Price step');
  await expect(rules).toContainText('0.01 USDT');
  await expect(rules).toContainText('Within 10% of the middle price');
  await expect(rules).toContainText('Up to 20 on this market');
  await shotBoth(page, 'desk-ticket-rules', { full: true });
});

test('a pair with no band or cap published reads "Not published", never a default', async ({ page }) => {
  const exchange = new Exchange();
  for (const market of exchange.opts.markets) {
    market.pairRules = {
      ...market.pairRules,
      protection: { ...market.pairRules.protection, collar: 'not set', openOrdersPerMarket: 'not set' },
    };
  }
  await mount(page, exchange);
  await ready(page);
  const rules = page.locator('details[data-testid="dk-rules"]');
  await rules.locator('summary').click();
  const row = (name) => rules.locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${name}$`) }) });
  await expect(row('Price band').locator('dd')).toHaveText('Not published');
  await expect(row('Open orders').locator('dd')).toHaveText('Not published');
});

test('refused: a price outside the band names the edges; too many open orders names the cap and the count', async ({ page }) => {
  const exchange = new Exchange();
  exchange.opts.refusal = { code: 'trade.price_band', message: 'raw words', data: { low: '58500', high: '71500', collar: '0.1' } };
  const m = await mount(page, exchange);
  await ready(page);
  await fillBuy(page, { price: '80000', amount: '0.0001' });
  const note = buyForm(page).getByTestId('dk-note--bad');
  await expect(note).toContainText('Price is outside the allowed range');
  await expect(note).toContainText('buy prices up to 71,500.00 and sell prices down to 58,500.00');
  await expect(buyForm(page)).not.toContainText('trade.price_band');
  await expect(buyButton(page)).toBeDisabled();
  exchange.opts.refusal = { code: 'trade.operator_throttle', message: 'raw words', data: { cap: '20', open: '20' } };
  await fillBuy(page, { price: '63999.9', amount: '0.0002' });
  await expect(note).toContainText('Too many open orders');
  await expect(note).toContainText('You have 20 open orders here and this market allows 20.');
  await expect(buyButton(page)).toBeDisabled();
  expect(m.requests('POST', 'orders')).toHaveLength(0);
});

test('refused: an account that is not verified gets words and the Verify path, never a raw code', async ({ page }) => {
  const exchange = new Exchange();
  exchange.opts.refusal = { code: 'tier.insufficient', message: 'raw words from the service' };
  const m = await mount(page, exchange);
  await ready(page);
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  const note = buyForm(page).getByTestId('dk-note--bad');
  await expect(note).toContainText('Verify your identity first');
  await expect(note).toContainText('You need a verified account to do this.');
  await expect(note.getByRole('link', { name: 'Verify now' })).toHaveAttribute('href', '/verification');
  await expect(buyForm(page)).not.toContainText('tier.insufficient');
  await expect(buyForm(page)).not.toContainText('raw words from the service');
  await expect(buyButton(page)).toBeDisabled();
  expect(m.requests('POST', 'orders')).toHaveLength(0);
  await shotBoth(page, 'desk-refused', { full: true });
});

test('a lost answer: the order is looked up, never sent again, and new orders wait until it is found', async ({ page }) => {
  const exchange = new Exchange();
  exchange.opts.placeMode = 'abort';
  exchange.opts.hideOrders = true;
  const m = await mount(page, exchange);
  await ready(page);
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  await openReview(page);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  const notice = page.getByTestId('dk-note--warn');
  await expect(notice).toContainText('Checking your order…');
  await expect(notice).toContainText('You can’t place another order until this is settled');
  const key = 'trade-pending:00000000-0000-4000-8000-000000000001';
  expect(JSON.parse(await page.evaluate((k) => localStorage.getItem(k), key))).toMatchObject({ kind: 'place', symbol: 'BTC/USDT' });
  await expect(buyButton(page)).toBeDisabled();
  await shotBoth(page, 'desk-checking', { full: true });
  await page.waitForTimeout(1500);
  expect(m.requests('POST', 'orders')).toHaveLength(1); // never retried
  // The service still hides the order: the check says it was not found, and that it may still arrive.
  await notice.getByRole('button', { name: 'Check order' }).click();
  await expect(page.getByTestId('dk-note--warn')).toContainText('It may still arrive');
  expect(m.requests('POST', 'orders')).toHaveLength(1);
  await shotBoth(page, 'desk-checking-not-found', { full: true });
  // The service shows the order; the check finds it and the desk is free again.
  exchange.opts.hideOrders = false;
  // The desk's own timed check may find it first: the note then goes away under the click (#5951). Either way the
  // outcome below is the same, and it is what this step proves.
  await notice
    .getByRole('button', { name: 'Check order' })
    .click({ timeout: 5_000 })
    .catch(() => undefined);
  await expect(page.getByTestId('dk-note--warn')).toHaveCount(0);
  await expect(page.getByText(/Checked: your order is/)).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBeNull();
  expect(m.requests('POST', 'orders')).toHaveLength(1);
});

test('the preview changing at confirm shows the new numbers and asks again', async ({ page }) => {
  const exchange = new Exchange();
  const m = await mount(page, exchange);
  await ready(page);
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  await openReview(page);
  // The fee rate changes after the review opened: the service's fresh preview differs from the reviewed one.
  exchange.opts.markets = exchange.opts.markets.map((market) => (market.symbol === 'BTC/USDT' ? { ...market, maker: '0.002' } : market));
  exchange.opts.feeBps = 20n;
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('changed');
  await expect(page.getByRole('alertdialog')).toContainText('(up to 0.20%)');
  expect(m.requests('POST', 'orders')).toHaveLength(0); // nothing was sent
  await shotBoth(page, 'desk-review-changed', { full: true });
});

test('states: loading, no book, market closed, errors, signed out', async ({ page, browser }) => {
  // Loading
  let m = await mount(page, new Exchange(), { hold: ['markets'] });
  await page.locator('[data-testid="if-desk"][aria-busy="true"]').waitFor();
  await shotBoth(page, 'desk-loading');
  await m.release();
  await ready(page);

  // Book panel loading, with the book held back
  const heldBook = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  m = await mount(heldBook, new Exchange(), { hold: ['orderbook', 'ohlcv'] });
  await heldBook.getByTestId('dk-ticker').getByTestId('dk-pair').waitFor();
  await heldBook.getByTestId('dk-bk-skeleton').waitFor();
  await expect(heldBook.getByTestId('dk-chart-skeleton')).toBeVisible();
  await shotBoth(heldBook, 'desk-panels-loading');
  await heldBook.close();

  // No book
  const empty = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const exchange = new Exchange();
  exchange.opts.book = book({ empty: true });
  m = await mount(empty, exchange);
  await empty.getByTestId('dk-bk-note').waitFor();
  await expect(empty.getByTestId('dk-bk-note')).toHaveText('No orders in this market.');
  await expect(empty.getByTestId('dk-bk-mid')).toContainText('—');
  await shotBoth(empty, 'desk-no-book');
  await empty.close();

  // Market closed
  const closed = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const shut = new Exchange();
  shut.opts.markets = markets({ btcOpen: false });
  m = await mount(closed, shut);
  await closed.getByTestId('dk-order').locator('[data-slot="state-block"]').waitFor();
  await expect(closed.getByTestId('dk-order')).toContainText('This market isn’t open');
  await expect(closed.getByTestId('dk-order')).toContainText('You can’t trade it right now');
  await expect(closed.getByTestId('dk-stats')).toContainText('Cash spot · Not open for new orders');
  await shotBoth(closed, 'desk-market-closed');
  await closed.close();

  // Errors inside the failing panels only
  const broken = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const down = new Exchange();
  down.opts.fail = { orderbook: 500, ohlcv: 500, orders: 500 };
  m = await mount(broken, down);
  await broken.getByTestId('dk-bk').locator('[data-kind="error"]').waitFor({ timeout: 40000 });
  await expect(broken.getByTestId('dk-bk')).toContainText('Couldn’t load the order book.');
  await expect(broken.getByTestId('dk-chart')).toContainText('Couldn’t load the chart.');
  await expect(broken.getByTestId('dk-ticker').getByTestId('dk-pair')).toHaveText('BTC/USDT'); // the rest of the desk stays
  await shotBoth(broken, 'desk-errors');
  await broken.close();

  // Signed out
  const out = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  m = await mount(out, new Exchange(), { url: `${PAIR}?signedout=1` });
  await out.getByTestId('dk-ticker').getByTestId('dk-pair').waitFor();
  const login = out.locator('form[data-testid="dk-form"][data-side="buy"]').getByRole('link', { name: 'Log in to trade' });
  await expect(login).toBeVisible();
  expect(await login.getAttribute('href')).toMatch(/^\/login\?redirect=%2Ftrade%2Fspot%2FBTC-USDT/);
  await expect(out.getByText('Log in to see your orders.')).toBeVisible();
  await expect(out.locator('form[data-testid="dk-form"][data-side="buy"] [data-testid="dk-avail"]')).toContainText('—');
  expect(
    m.exchange.requests.filter((r) => r.path.startsWith('orders/') || r.path === 'account/balance' || r.path === 'account/trades'),
  ).toHaveLength(0);
  await shotBoth(out, 'desk-signed-out', { full: true });
  await out.close();
});

test('keyboard path: amount, then ⌘/Ctrl+Enter opens the review with focus inside it; Escape sends nothing', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  await expect(buyButton(page)).toBeEnabled();
  await buyForm(page).getByRole('textbox', { name: 'Amount' }).focus();
  await page.keyboard.press('ControlOrMeta+Enter');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="alertdialog"]')))).toBe(true);
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('Tab');
    // Focus guards hand focus back to the dialog a moment after a Tab; it never settles outside.
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="alertdialog"]')))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(m.requests('POST', 'orders')).toHaveLength(0);
});

test('book and trade clicks fill the price; percent chips and Max round down to the lot; BBO stays on the book', async ({ page }) => {
  await mount(page);
  await ready(page);
  const price = buyForm(page).getByRole('textbox', { name: 'Price' });
  await page.locator('[data-testid="dk-bk-row"][data-side="ask"]').last().click();
  await expect(price).toHaveValue('65000.10');
  await expect(sellForm(page).getByRole('textbox', { name: 'Price' })).toHaveValue('65000.10');
  await buyForm(page).getByRole('button', { name: '50% of max' }).click();
  // 4,100 USDT / 65,000.10 = 0.06307... BTC (a buy's fee is taken from what it receives); half of it, down to the lot
  const amount = buyForm(page).getByRole('textbox', { name: 'Amount' });
  await expect(amount).toHaveValue('0.03153');
  await sellForm(page).getByRole('button', { name: '100% of max' }).click();
  await expect(sellForm(page).getByRole('textbox', { name: 'Amount' })).toHaveValue('0.25');
  await buyForm(page).getByRole('button', { name: 'BBO' }).click();
  await expect(price).toHaveValue('64999.90');
  await sellForm(page).getByRole('button', { name: 'BBO' }).click();
  await expect(sellForm(page).getByRole('textbox', { name: 'Price' })).toHaveValue('65000.10');
});

test('a lost order that never arrived: the person sends the SAME order again, once, and it is placed once', async ({ page }) => {
  const exchange = new Exchange();
  exchange.opts.placeMode = 'lose';
  const m = await mount(page, exchange);
  await ready(page);
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  await openReview(page);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  const notice = page.getByTestId('dk-note--warn');
  await expect(notice).toContainText('Checking your order…');
  await expect(notice.getByRole('button', { name: 'Send the same order again' })).toBeVisible();
  const key = 'trade-pending:00000000-0000-4000-8000-000000000001';
  const marker = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), key));
  expect(marker.draft).toMatchObject({ symbol: 'BTC/USDT', side: 'buy', type: 'limit', amount: '0.0001', price: '63999.9' });
  await page.waitForTimeout(1500);
  expect(m.requests('POST', 'orders')).toHaveLength(1); // nothing is ever sent by itself
  exchange.opts.placeMode = 'ok';
  await notice.getByRole('button', { name: 'Send the same order again' }).click();
  await expect(page.getByTestId('dk-note--warn')).toHaveCount(0);
  await expect(page.getByText(/Done: your order is/)).toBeVisible();
  const sent = m.requests('POST', 'orders');
  expect(sent).toHaveLength(2);
  expect(sent[1].body).toEqual(sent[0].body); // the very same order and clientOrderId
  expect(exchange.open).toHaveLength(1);
  expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBeNull();
});

test('market sell: the review shows the floor and the fee; it sends no price and fills', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await page.getByRole('tab', { name: 'Market' }).click();
  await expect(sellForm(page).getByRole('textbox', { name: 'Price' })).toBeDisabled();
  await sellForm(page).getByRole('textbox', { name: 'Amount' }).fill('0.0001');
  const sell = sellForm(page).getByRole('button', { name: 'Sell BTC' });
  await expect(sell).toBeEnabled();
  await expect(sellForm(page)).toContainText('Fee 0.10% · taker');
  await expect(page.locator('body')).not.toContainText('This can’t be done right now');
  await sell.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Price protection');
  await expect(dialog).toContainText(/You won’t sell for less than [\d,.]+ USDT per BTC/);
  await expect(dialog).toContainText('Fee');
  await shotBoth(page, 'desk-review-market-sell');
  await dialog.getByRole('button', { name: 'Confirm sell' }).click();
  await expect(sellForm(page)).toContainText('Your sell order filled: 0.0001 BTC');
  const sent = m.requests('POST', 'orders')[0].body;
  expect(sent).toMatchObject({ side: 'sell', type: 'market' });
  expect('price' in sent).toBe(false);
  expect(m.errors).toEqual([]);
});

test('flatten: one control in Assets reviews a market sell of every free lot; the same review number on every retry', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await page.getByRole('tab', { name: 'Assets' }).click();
  const flatten = page.getByRole('button', { name: /^Flatten BTC: sell all 0.25 BTC/ });
  await flatten.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Review your sell');
  await expect(dialog).toContainText('Price protection');
  expect(m.requests('POST', 'orders')).toHaveLength(0); // nothing is sent before Confirm
  const reference = await dialog.getByText('Client order ID').locator('..').getByTestId('client-order-id').innerText();
  // Leave and press Flatten again for the same coin: the same order, under the same number.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await flatten.click();
  await expect(dialog).toContainText('Review your sell');
  expect(await dialog.getByText('Client order ID').locator('..').getByTestId('client-order-id').innerText()).toBe(reference);
  await shot(page, 'desk-flatten-review');
  await dialog.getByRole('button', { name: 'Confirm sell' }).click();
  await expect(sellForm(page)).toContainText('Your sell order filled: 0.25 BTC');
  const sent = m.requests('POST', 'orders');
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toMatchObject({ side: 'sell', type: 'market', amount: '0.25' });
  expect(sent[0].body.clientOrderId.endsWith(`:${reference}`)).toBe(true);
  expect(m.errors).toEqual([]);
});

test('a market sell the service refuses (no protection published) says so in words, and nothing is sent', async ({ page }) => {
  const exchange = new Exchange();
  exchange.opts.refusal = { code: 'trade.protection_unset', message: 'raw words from the service' };
  const m = await mount(page, exchange);
  await ready(page);
  await page.getByRole('tab', { name: 'Market' }).click();
  await sellForm(page).getByRole('textbox', { name: 'Amount' }).fill('0.0001');
  await expect(sellForm(page).getByTestId('dk-note--bad')).toContainText('Price protection isn’t set');
  await expect(sellForm(page).getByRole('button', { name: 'Sell BTC' })).toBeDisabled();
  await expect(sellForm(page)).not.toContainText('trade.protection_unset');
  await expect(sellForm(page)).not.toContainText('raw words from the service');
  expect(m.requests('POST', 'orders')).toHaveLength(0);
});

test('an order bigger than the balance is refused in words before Confirm, from the exact hold', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await fillBuy(page, { price: '63999.9', amount: '0.07' }); // holds about 4,480 USDT; 4,100 are free
  await expect(buyForm(page)).toContainText('Not enough USDT');
  await expect(buyButton(page)).toBeDisabled();
  expect(m.requests('POST', 'orders')).toHaveLength(0);
});

test('market buy Max is sized from the price protection, so the hold never passes the balance', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await page.getByRole('tab', { name: 'Market' }).click();
  const amount = buyForm(page).getByRole('textbox', { name: 'Amount' });
  await buyForm(page).getByRole('button', { name: '100% of max' }).click();
  await expect(amount).not.toHaveValue('');
  const sized = await amount.inputValue();
  const check = m.exchange.preview({ symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: sized, timeInForce: 'GTC', postOnly: false });
  expect(Number(check.holdAmount)).toBeLessThanOrEqual(4100);
  await openReview(page);
  await expect(page.getByRole('alertdialog')).toBeVisible();
});

test('market buy by spend: typing a spend sizes the amount so the hold stays within it', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await page.getByRole('tab', { name: 'Market' }).click();
  const spend = buyForm(page).getByRole('textbox', { name: 'Spend' });
  await expect(spend).toBeEditable();
  await spend.fill('1000');
  const amount = buyForm(page).getByRole('textbox', { name: 'Amount' });
  await expect(amount).not.toHaveValue('');
  const sized = await amount.inputValue();
  const check = m.exchange.preview({ symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: sized, timeInForce: 'GTC', postOnly: false });
  expect(Number(check.holdAmount)).toBeLessThanOrEqual(1000);
  expect(Number(check.holdAmount)).toBeGreaterThan(0);
  await expect(spend).toHaveValue('1000');
  expect(m.requests('POST', 'orders')).toHaveLength(0);
});

test('a typed spend is dropped when the buy stops being a market order', async ({ page }) => {
  await mount(page);
  await ready(page);
  await page.getByRole('tab', { name: 'Market' }).click();
  const spend = buyForm(page).getByRole('textbox', { name: 'Spend' });
  await expect(spend).toBeEditable();
  await spend.fill('1000');
  await page.getByRole('tab', { name: 'Limit', exact: true }).click();
  await expect(buyForm(page).getByRole('textbox', { name: 'Total' })).not.toHaveValue('1000');
});

test('market sell has no spend field: its total stays an estimate', async ({ page }) => {
  await mount(page);
  await ready(page);
  await page.getByRole('tab', { name: 'Market' }).click();
  await expect(sellForm(page).getByRole('textbox', { name: 'Spend' })).toHaveCount(0);
  await expect(sellForm(page).getByRole('textbox', { name: 'Total' })).toHaveAttribute('readonly', '');
});

test('fee line comes from the preview, not the market list', async ({ page }) => {
  await mount(page);
  await ready(page);
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  await expect(buyForm(page)).toContainText('Fee up to 0.10%');
  await expect(page.locator('body')).not.toContainText('0.20%');
});

test('another pair from the list: the URL changes and the form resets', async ({ page }) => {
  await mount(page);
  await ready(page);
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  await page.getByTestId('dk-mk-row').filter({ hasText: 'ETH/USDT' }).getByRole('link').click();
  await expect(page).toHaveURL(/\/trade\/spot\/ETH-USDT$/);
  await expect(page.getByTestId('dk-pair')).toHaveText('ETH/USDT');
  await expect(buyForm(page).getByRole('textbox', { name: 'Amount' })).toHaveValue('');
  await expect(page.locator('[data-testid="dk-mk-row"][data-selected] [data-testid="dk-mk-pair"]')).toHaveText('ETH/USDT');
});

test('layout holds at 1180, 1100, 800 and 390: no horizontal page scroll, the market picker appears', async ({ page }) => {
  await mount(page);
  await ready(page);
  for (const width of [1180, 1100, 800, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    if (width <= 1179) await expect(page.getByRole('button', { name: 'Choose a market' })).toBeVisible();
    await shot(page, `desk-width-${width}`);
  }
});

test('request budget: the desk stays at or under 95 requests a minute (UI-SPEC 4.2), also with the busiest tabs open', async ({ page }) => {
  test.setTimeout(120_000);
  const m = await mount(page);
  await ready(page);
  const perMinute = async (seconds) => {
    const before = m.exchange.requests.length;
    await page.waitForTimeout(seconds * 1000);
    return Math.round(((m.exchange.requests.length - before) * 60) / seconds);
  };
  await page.waitForTimeout(3000);
  const normal = await perMinute(30); // Book tab, Open orders tab
  await page.getByRole('tab', { name: 'Trade history' }).click();
  await page.getByRole('tab', { name: 'Last trades' }).click();
  const busiest = await perMinute(30); // Trades beside the book, Trade history below
  console.log(`REQUESTS_PER_MINUTE default=${normal} busiest=${busiest}`);
  expect(normal).toBeLessThanOrEqual(95);
  expect(busiest).toBeLessThanOrEqual(95);
});

test('commit cost while the desk refreshes: the React Profiler numbers for an idle desk', async ({ page }) => {
  await mount(page);
  await ready(page);
  await page.waitForTimeout(3000);
  await page.evaluate(() => (window.__commits = []));
  await page.waitForTimeout(12000);
  const commits = await page.evaluate(() => window.__commits);
  const times = commits.map((c) => c.ms).sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
  const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
  console.log(
    `profiler: ${times.length} commits in 12 s, mean ${mean.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${(times.at(-1) ?? 0).toFixed(2)} ms (dev build, StrictMode doubles renders)`,
  );
  // Development build with StrictMode is far slower than production; this guards against a runaway, not the 4 ms budget.
  expect(p95).toBeLessThan(25);
});

// ── The finished ticket: time in force, order kinds the market does not take, changing orders, cancel all, data status ──

const pickTif = async (page, label) => {
  await page.getByRole('combobox', { name: 'Time in force' }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
};
const openTable = (page) => page.getByTestId('dk-bottom-body').locator('table');

test('time in force: post only, IOC and FOK are what the order sends; a market order offers only standard or fill or kill', async ({
  page,
}) => {
  const m = await mount(page);
  await ready(page);
  await expect(page.getByRole('combobox', { name: 'Time in force' })).toContainText('Good till cancelled');
  await page.getByRole('combobox', { name: 'Time in force' }).click();
  await expect(page.getByRole('option')).toHaveText([
    'Good till cancelled',
    'Good till date',
    'Post only',
    'Immediate or cancel',
    'Fill or kill',
  ]);
  await page.keyboard.press('Escape');

  await pickTif(page, 'Post only');
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  // A post-only order always rests as a maker, so the fee line says maker.
  await expect(buyForm(page)).toContainText('Fee 0.10% · maker');
  await openReview(page);
  await expect(page.getByRole('alertdialog')).toContainText('Time in force');
  await expect(page.getByRole('alertdialog')).toContainText('Post only');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  await expect(buyForm(page)).toContainText('Your buy order is in');
  expect(m.requests('POST', 'orders')).toHaveLength(1);
  expect(m.requests('POST', 'orders')[0].body).toMatchObject({ type: 'limit', timeInForce: 'PO', postOnly: true });
  await expect(openTable(page).locator('tbody tr').first()).toContainText('Post only');

  // Market: standard or fill or kill. A limit-only pick falls back to standard and comes back with Limit.
  await page.getByRole('tab', { name: 'Market' }).click();
  await expect(page.getByRole('combobox', { name: 'Time in force' })).toContainText('Standard');
  await page.getByRole('combobox', { name: 'Time in force' }).click();
  await expect(page.getByRole('option')).toHaveText(['Standard', 'Fill or kill']);
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Limit', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Time in force' })).toContainText('Post only');
  expect(m.errors).toEqual([]);
  await shotBoth(page, 'desk-tif-post-only', { full: true });
});

test('self-trade: the one mode the engine has is picked and sent; the others are listed, disabled, with why', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  const stp = page.getByRole('combobox', { name: 'If it meets my own order' });
  await expect(stp).toContainText('Cancel my resting order');
  await stp.click();
  await expect(page.getByRole('option', { name: 'Cancel this order' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('option', { name: 'Cancel both orders' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText('the matching engine only cancels the resting order')).toBeVisible();
  await shotBoth(page, 'desk-self-trade');
  await page.keyboard.press('Escape');
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  await openReview(page);
  await expect(page.getByRole('alertdialog')).toContainText('If it meets your own order');
  await expect(page.getByRole('alertdialog')).toContainText('Cancel my resting order');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  await expect(buyForm(page)).toContainText('Your buy order is in');
  expect(m.requests('POST', 'orders')[0].body).toMatchObject({ stpMode: 'cancel_maker' });
  expect(m.errors).toEqual([]);
});

test('a tag: typed once, shown in the review, sent with the order and shown on it; blank sends none', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  const tag = page.getByRole('textbox', { name: 'Tag' });
  await expect(tag).toHaveAttribute('maxlength', '16');
  await tag.fill('  grid-1  ');
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  await openReview(page);
  await expect(page.getByRole('alertdialog')).toContainText('grid-1');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  await expect(buyForm(page)).toContainText('Your buy order is in');
  expect(m.requests('POST', 'orders')[0].body).toMatchObject({ tag: 'grid-1' });
  await expect(openTable(page).locator('tbody tr').first()).toContainText('grid-1');

  await tag.fill('');
  await fillBuy(page, { price: '63999.8', amount: '0.0001' });
  await openReview(page);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  await expect(buyForm(page)).toContainText('Your buy order is in');
  expect('tag' in m.requests('POST', 'orders')[1].body).toBe(false);
  expect(m.errors).toEqual([]);
});

test('good till date: pick an expiry, the review shows it, the order sends it; a past time sends nothing', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await pickTif(page, 'Good till date');
  const expires = page.getByLabel('Expires');
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  // No expiry yet: nothing can be reviewed.
  await expect(buyButton(page)).toBeDisabled();
  await expires.fill('2020-01-01T00:00');
  await expect(page.getByText('Pick a time in the future.')).toBeVisible();
  await expect(buyButton(page)).toBeDisabled();
  expect(m.requests('POST', 'orders/preview').filter((r) => r.body.timeInForce === 'GTD')).toHaveLength(0);
  const future = new Date(Date.now() + 36 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
  await expires.fill(local);
  await expect(page.getByText('Pick a time in the future.')).toHaveCount(0);
  await openReview(page);
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Good till date');
  await expect(dialog).toContainText('Expires');
  await dialog.getByRole('button', { name: 'Confirm buy' }).click();
  await expect(buyForm(page)).toContainText('Your buy order is in');
  const sent = m.requests('POST', 'orders');
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toMatchObject({ type: 'limit', timeInForce: 'GTD', postOnly: false, expireAt: new Date(local).toISOString() });
  expect(m.errors).toEqual([]);
});

test('a post-only order that would match right away is refused in words, never called done, and nothing rests', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await pickTif(page, 'Post only');
  await fillBuy(page, { price: '65001', amount: '0.0001' }); // above the best ask: it would take
  await openReview(page);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  await expect(buyForm(page)).toContainText('Post-only order not placed');
  await expect(buyForm(page)).toContainText('Nothing was traded');
  await expect(buyForm(page)).not.toContainText('is done');
  await expect(buyForm(page).getByRole('textbox', { name: 'Amount' })).toHaveValue('0.0001'); // kept so the price can be fixed
  await expect(page.getByText('No open orders.')).toBeVisible();
  expect(m.requests('POST', 'orders')).toHaveLength(1);
  expect(m.requests('POST', 'orders')[0].body).toMatchObject({ timeInForce: 'PO', postOnly: true });
  await shotBoth(page, 'desk-post-only-refused');
});

test('fill or kill that the book cannot fill, and immediate or cancel with no match, both say nothing traded', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await pickTif(page, 'Fill or kill');
  await fillBuy(page, { price: '65001', amount: '0.06' }); // more than the 0.04 on offer, within the balance
  await openReview(page);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  await expect(buyForm(page)).toContainText('Fill-or-kill order not placed');
  await expect(buyForm(page)).toContainText('nothing was traded');
  expect(m.requests('POST', 'orders')[0].body).toMatchObject({ timeInForce: 'FOK', postOnly: false });

  await pickTif(page, 'Immediate or cancel');
  await fillBuy(page, { price: '60000', amount: '0.0001' }); // below the ask: nothing to match
  await openReview(page);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  await expect(buyForm(page)).toContainText('Nothing filled');
  expect(m.requests('POST', 'orders')[1].body).toMatchObject({ timeInForce: 'IOC', postOnly: false });
  await expect(page.getByText('No open orders.')).toBeVisible();
});

test('trailing stop is listed, disabled, with one reason; nothing is sent', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await page.getByRole('button', { name: 'Other order types (not available)' }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toContainText('The service does not take this order type.');
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveText(['Trailing stop']);
  for (const item of await items.all()) await expect(item).toHaveAttribute('aria-disabled', 'true');
  await shotBoth(page, 'desk-order-kinds-disabled');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tab', { name: 'Limit', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(m.requests('POST', 'orders')).toHaveLength(0);
});

test('open orders: a smaller amount uses native amend and keeps the place in the queue; a new price replaces the order after a review', async ({
  page,
}) => {
  const m = await mount(page);
  await ready(page);
  await fillBuy(page, { price: '63999.9', amount: '0.0002' });
  await openReview(page);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  await expect(openTable(page).locator('tbody tr')).toHaveCount(1);

  await openTable(page)
    .getByRole('button', { name: /Edit buy order/ })
    .click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Edit order');
  await dialog.getByRole('textbox', { name: 'Amount left' }).fill('0.0001');
  await expect(dialog).toContainText('Lowering the amount keeps your place in the queue.');
  await dialog.getByRole('button', { name: 'Change amount' }).click();
  await expect(dialog).toContainText('Your place in the queue was kept');
  expect(m.requests('PATCH', 'orders/order-1')).toHaveLength(1);
  expect(m.requests('PATCH', 'orders/order-1')[0].body).toEqual({ qty: '0.0001' });
  expect(m.requests('POST', 'orders/order-1/replace')).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(openTable(page).locator('tbody tr').first()).toContainText('0.0001');

  await openTable(page)
    .getByRole('button', { name: /Edit buy order/ })
    .click();
  await dialog.getByRole('textbox', { name: 'Price' }).fill('63990');
  await expect(dialog).toContainText('the old one is cancelled first');
  await dialog.getByRole('button', { name: 'Review replacement' }).click();
  await expect(dialog).toContainText('63,999.90 → 63,990.00');
  expect(m.requests('POST', 'orders/order-1/replace')).toHaveLength(0); // nothing sent until the second click
  await shotBoth(page, 'desk-edit-replace-review');
  await dialog.getByRole('button', { name: 'Replace order' }).click();
  await expect(dialog).toContainText('Replaced. Your new order is 0.0001 BTC at 63,990.00 USDT.');
  expect(m.requests('POST', 'orders/order-1/replace')).toHaveLength(1);
  expect(m.requests('POST', 'orders/order-1/replace')[0].body).toMatchObject({
    price: '63990',
    amount: '0.0001',
    timeInForce: 'GTC',
    postOnly: false,
  });
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(openTable(page).locator('tbody tr')).toHaveCount(1);
  await expect(openTable(page).locator('tbody tr').first()).toContainText('63,990.00');
  expect(m.errors).toEqual([]);
});

test('cancel all: asks first, cancels only the orders of the market on screen, one request', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  for (const price of ['63999.9', '63998.9']) {
    await fillBuy(page, { price, amount: '0.0001' });
    await openReview(page);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  }
  await expect(openTable(page).locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Cancel all (2)' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Cancel all BTC/USDT orders?');
  expect(m.requests('DELETE', 'orders')).toHaveLength(0);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel all orders' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Cancelled 2 orders.');
  expect(m.requests('DELETE', 'orders')).toHaveLength(1);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('No open orders.')).toBeVisible();
});

test('cancel orders: ticked orders go in one batch, each id answered; an order already gone is named; spot only is one request', async ({
  page,
}) => {
  const m = await mount(page);
  await ready(page);
  for (const price of ['63999.9', '63998.9', '63997.9']) {
    await fillBuy(page, { price, amount: '0.0001' });
    await openReview(page);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  }
  await expect(openTable(page).locator('tbody tr')).toHaveCount(3);
  const tick = (price) => openTable(page).locator('tbody tr').filter({ hasText: price }).getByRole('checkbox');
  await tick('63,999.90').check();
  await tick('63,998.90').check();
  // One of the two finishes elsewhere before the batch is sent: the service answers that id on its own line.
  const goneId = m.exchange.open.find((order) => order.price === '63998.9').id;
  await page.getByRole('button', { name: 'Cancel orders…' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('radio', { name: 'The 2 selected' })).toBeChecked();
  expect(m.requests('POST', 'orders/batch-cancel')).toHaveLength(0);
  m.exchange.open = m.exchange.open.filter((order) => order.id !== goneId);
  await dialog.getByRole('button', { name: 'Cancel orders' }).click();
  await expect(dialog).toContainText('1 of 2 cancelled.');
  await expect(dialog).toContainText('Order to buy 0.0001 BTC at 63,999.9 on BTC/USDT: Cancelled');
  await expect(dialog).toContainText('Order to buy 0.0001 BTC at 63,998.9 on BTC/USDT: Not cancelled: That order has already finished');
  expect(m.requests('POST', 'orders/batch-cancel')).toHaveLength(1);
  expect(m.requests('POST', 'orders/batch-cancel')[0].body.ids).toHaveLength(2);
  await shot(page, 'desk-cancel-batch');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(openTable(page).locator('tbody tr')).toHaveCount(1);

  // Spot only: one DELETE with kind=spot, after the person confirms.
  await page.getByRole('button', { name: 'Cancel orders…' }).click();
  await expect(dialog.getByRole('radio', { name: /The selected orders/ })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: /Every spot order/ })).toBeChecked();
  await expect(dialog).toContainText('Futures and options orders stay open.');
  const before = m.requests('DELETE', 'orders').length;
  await dialog.getByRole('button', { name: 'Cancel orders' }).click();
  await expect(dialog).toContainText('Cancelled 1 orders.');
  expect(m.requests('DELETE', 'orders')).toHaveLength(before + 1);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('No open orders.')).toBeVisible();
  expect(m.errors).toEqual([]);
});

test('data status: one chip, each feed on its own line; one failed feed makes it a problem', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  const chip = page.getByRole('button', { name: /Data status/ });
  await expect(chip).toContainText('Data OK');
  await chip.click();
  const pop = page.getByTestId('dk-feed-pop');
  for (const line of ['Sign-in', 'Order book', 'Prices', 'Your orders', 'Your balances']) await expect(pop).toContainText(line);
  await expect(pop).toContainText('Signed in');
  await expect(pop).toContainText('not a live stream');
  await shot(page, 'desk-data-status-ok');
  await page.keyboard.press('Escape');
  m.exchange.opts.fail.orders = 500;
  await expect(chip).toContainText('Data problem', { timeout: 50000 });
  await chip.click();
  await expect(pop).toContainText('Couldn’t load');
  await shot(page, 'desk-data-status-problem');
});

test('fee line: this order’s rate and role from the check, and the listed pair beside it', async ({ page }) => {
  await mount(page);
  await ready(page);
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  await expect(buyForm(page)).toContainText('Fee up to 0.10%'); // a resting limit may fill as a maker, so "up to"
  await expect(buyForm(page)).toContainText('Your rates: maker 0.08% · taker 0.12%');
});

test('a frozen ledger: the service refuses the order with a generic error; the desk says orders are paused, nothing rests, Buy works again', async ({
  page,
}) => {
  const m = await mount(page);
  await ready(page);
  m.exchange.opts.placeMode = { status: 400, json: { code: 'ExchangeError', message: 'ledger.frozen', intafacedCode: 'LedgerError' } };
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  await openReview(page);
  const headBefore = (await page.getByTestId('dk-bottom-head').boundingBox()).y;
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  await expect(buyForm(page)).toContainText('Orders are paused right now');
  // The refusal floats: the order monitor stays exactly where it was.
  expect((await page.getByTestId('dk-bottom-head').boundingBox()).y).toBe(headBefore);
  await expect(buyForm(page)).toContainText("this one wasn't placed");
  await expect(buyForm(page)).not.toContainText("can't be done right now");
  // The desk does not look ready to trade: the status chip says orders are paused, and the layout did not move.
  await expect(page.getByRole('button', { name: /Data status/ })).toContainText('Orders paused');
  await expect(page.getByText('No open orders.')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('trade-pending:00000000-0000-4000-8000-000000000001'))).toBeNull();
  await expect(buyButton(page)).toBeEnabled();
  expect(m.requests('POST', 'orders')).toHaveLength(1);
  await shotBoth(page, 'desk-orders-paused');
});

test('edit: a higher amount is refused here; a refused or failed replacement never claims the old order is safe', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await pickTif(page, 'Post only');
  await fillBuy(page, { price: '63999.9', amount: '0.0002' });
  await openReview(page);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  await expect(openTable(page).locator('tbody tr')).toHaveCount(1);

  // More than is left: not sent from here.
  await openTable(page)
    .getByRole('button', { name: /Edit buy order/ })
    .click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('textbox', { name: 'Amount left' }).fill('0.0005');
  await expect(dialog).toContainText('You can only lower the amount here');
  await expect(dialog.getByRole('button', { name: 'Change amount' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Keep order' })).toBeVisible(); // not "Cancel": the order stays live
  expect(m.requests('PATCH', 'orders/order-1')).toHaveLength(0);

  // Post-only moved to a price that would match: the old order is cancelled and the new one is REFUSED. Not "Replaced".
  await dialog.getByRole('textbox', { name: 'Amount left' }).fill('0.0002');
  await dialog.getByRole('textbox', { name: 'Price' }).fill('65001');
  await dialog.getByRole('button', { name: 'Review replacement' }).click();
  await dialog.getByRole('button', { name: 'Replace order' }).click();
  await expect(dialog).toContainText('the new order was refused');
  await expect(dialog).not.toContainText('Replaced.');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('No open orders.')).toBeVisible(); // the dialog's answer stayed on screen until closed

  // The service fails AFTER cancelling the original: the dialog says it cannot tell, and stops.
  await pickTif(page, 'Good till cancelled');
  await fillBuy(page, { price: '63999.9', amount: '0.0002' });
  await openReview(page);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  await expect(openTable(page).locator('tbody tr')).toHaveCount(1);
  m.exchange.opts.replaceError = true;
  await openTable(page)
    .getByRole('button', { name: /Edit buy order/ })
    .click();
  await dialog.getByRole('textbox', { name: 'Price' }).fill('63990');
  await dialog.getByRole('button', { name: 'Review replacement' }).click();
  await dialog.getByRole('button', { name: 'Replace order' }).click();
  await expect(dialog).toContainText('Your old order may already be cancelled');
  await expect(dialog.getByRole('button', { name: 'Replace order' })).toHaveCount(0);
  await expect(dialog).not.toContainText('Orders are paused');
  expect(m.errors).toEqual([]);
});
