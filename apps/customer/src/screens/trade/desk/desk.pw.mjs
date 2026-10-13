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
      body: request.method() === 'GET' ? undefined : request.postDataJSON(),
    });
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
  await page.locator('.dk-ticker .dk-pair').waitFor();
  await page.locator('.dk-bk-row[data-side="bid"]').first().waitFor();
};
const shot = async (page, name, { full = false } = {}) => {
  await page.waitForTimeout(350); // let dialogs and fades finish
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: full });
};
const buyForm = (page) => page.locator('form.dk-form[data-side="buy"]');
const sellForm = (page) => page.locator('form.dk-form[data-side="sell"]');
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

test('ready state at 1440x900: the three columns, ticker, chart, book, form, strip and the words', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page.locator('.pc-host a[href*="tradingview"]')).toHaveCount(1); // attribution kept
  await page.waitForTimeout(800);

  // Columns: 280 | centre | 280, panels separated by 3 px gutters
  const box = async (selector) => await page.locator(selector).first().boundingBox();
  expect(Math.abs((await box('.dk-left')).width - 280)).toBeLessThanOrEqual(2);
  expect(Math.abs((await box('.dk-book')).width - 280)).toBeLessThanOrEqual(2);
  const centre = await box('.dk-centre');
  expect(Math.abs(centre.width - (1440 - 280 - 280 - 6))).toBeLessThanOrEqual(2);
  expect((await box('.dk-ticker')).height).toBe(48);
  const gutter = await page
    .locator('.if-desk')
    .evaluate((node) => getComputedStyle(node).rowGap + ' ' + getComputedStyle(node).backgroundColor);
  expect(gutter).toContain('3px');

  // Ticker strip: every figure from /ticker, "$" on dollar prices
  await expect(page.locator('.dk-pair')).toHaveText('BTC/USDT');
  await expect(page.locator('.dk-last')).toHaveText('$65,000.00');
  await expect(page.locator('.dk-stats')).toContainText('24h low');
  await expect(page.locator('.dk-stats')).toContainText('$64,100.00');
  await expect(page.locator('.dk-stats')).toContainText('$65,400.00');
  await expect(page.locator('.dk-stats')).toContainText('24h volume (BTC)');
  await expect(page.locator('.dk-stats')).toContainText('1.8894');
  await expect(page.locator('.dk-stats')).toContainText('24h turnover (USDT)');

  // Order book: 22 px rows, asks highest first, best ask next to the mid price, depth bars
  const row = page.locator('.dk-bk-row').first();
  expect((await row.boundingBox()).height).toBe(22);
  expect(await row.evaluate((node) => getComputedStyle(node).fontSize)).toBe('12px');
  const askPrices = await page.locator('.dk-bk-row[data-side="ask"] .dk-bk-price').allTextContents();
  const bidPrices = await page.locator('.dk-bk-row[data-side="bid"] .dk-bk-price').allTextContents();
  expect(askPrices.length).toBeGreaterThan(5);
  expect(askPrices.at(-1)).toBe('65,000.10');
  expect(bidPrices[0]).toBe('64,999.90');
  const asc = [...askPrices].map((p) => Number(p.replace(/,/g, '')));
  expect(asc).toEqual([...asc].sort((a, b) => b - a));
  expect(
    await page
      .locator('.dk-bk-row[data-side="bid"]')
      .first()
      .locator('.dk-bk-bar')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(7, 33, 16)');
  expect(
    await page
      .locator('.dk-bk-row[data-side="ask"]')
      .first()
      .locator('.dk-bk-bar')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe('rgb(40, 13, 20)');
  await expect(page.locator('.dk-bk-ratio')).toContainText('B ');
  await expect(page.locator('.dk-bk-mid')).toContainText('$65,000.00');

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
  await expect(buyForm(page)).toContainText('Fees: 0.10% maker, 0.20% taker');

  // Bottom strip and the market list
  await expect(page.getByRole('tab', { name: 'Open orders' })).toBeVisible();
  await expect(page.getByText('No open orders.')).toBeVisible();
  await expect(page.locator('.dk-mk-row')).toHaveCount(4);
  await expect(page.locator('.dk-mk-row[data-selected] .dk-mk-pair')).toHaveText('BTC/USDT');

  // Words
  expect(await page.locator('main').innerText()).not.toMatch(forbidden);
  expect(m.errors).toEqual([]);
  await shot(page, 'desk-loaded-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  await shot(page, 'desk-loaded-1280');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
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
  await expect(page.locator('.pc-legend')).toBeVisible();
  await page.getByRole('tab', { name: 'Info' }).click();
  await expect(page.locator('.dk-info')).toContainText('Price step');
  await expect(page.locator('.dk-info')).toContainText('0.01 USDT');
  await expect(page.locator('.dk-info')).toContainText('0.00001 BTC');
  await expect(page.locator('.dk-info')).toContainText('Taker fee');
  await shot(page, 'desk-chart-info-1440');
  await page.getByRole('tab', { name: 'Chart' }).click();

  // Grouping: x10 merges 0.10 steps into whole-dollar buckets
  await page.getByRole('combobox', { name: 'Group prices by' }).click();
  await page.getByRole('option', { name: '1', exact: true }).click();
  const bids = await page.locator('.dk-bk-row[data-side="bid"] .dk-bk-price').allTextContents();
  expect(bids[0]).toBe('64,999');
  // Last trades
  await page.getByRole('tab', { name: 'Last trades' }).click();
  await expect(page.locator('.dk-bk-row--tape').first()).toBeVisible();
  await expect.poll(() => m.exchange.requests.some((r) => r.path.startsWith('trades/'))).toBe(true);
  await shot(page, 'desk-trades-1440');
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
  await expect(dialog).toContainText(`${expected.estimatedFee} USDT (0.10% maker)`);
  await shot(page, 'desk-review-limit-1440');
  expect(m.requests('POST', 'orders')).toHaveLength(0); // nothing sent until the click

  await dialog.getByRole('button', { name: 'Confirm buy' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(buyForm(page)).toContainText('Your buy order is in');
  await expect(page.getByText('We haven’t found it yet.')).toHaveCount(0); // no lookup ran for an order still in flight
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
  // The marker that guards against a lost answer is gone once the outcome is known.
  expect(await page.evaluate(() => localStorage.getItem('trade-pending:00000000-0000-4000-8000-000000000001'))).toBeNull();

  const table = page.locator('.dk-bottom-body table');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.locator('tbody tr').first()).toContainText('BTC/USDT');
  await expect(table.locator('tbody tr').first()).toContainText('63,999.90');
  await expect(table.locator('tbody tr').first()).toContainText('Limit');
  await shot(page, 'desk-open-order-1440', { full: true });

  await table.getByRole('button', { name: /Cancel buy order/ }).click();
  await expect(table.locator('tbody tr')).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByText('No open orders.')).toBeVisible();
  expect(m.requests('DELETE', 'orders/order-1')).toHaveLength(1);
  await shot(page, 'desk-cancelled-1440', { full: true });
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
  await expect(dialog).toContainText('(0.20% taker)');
  await shot(page, 'desk-review-market-1440');
  await dialog.getByRole('button', { name: 'Confirm buy' }).click();
  await expect(buyForm(page)).toContainText('Your buy order filled: 0.0001 BTC');
  const sent = m.requests('POST', 'orders')[0].body;
  expect(sent.type).toBe('market');
  expect('price' in sent).toBe(false);
  await page.getByRole('tab', { name: 'Trade history' }).click();
  const row = page.locator('.dk-bottom-body table tbody tr').first();
  await expect(row).toContainText('BTC/USDT');
  await expect(row).toContainText('65,000.10');
  await expect(row).toContainText('0.0001');
  await shot(page, 'desk-trade-history-1440', { full: true });
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
  await shot(page, 'desk-client-refusal-1440', { full: true });
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

test('refused: an account that is not verified gets words and the Verify path, never a raw code', async ({ page }) => {
  const exchange = new Exchange();
  exchange.opts.refusal = { code: 'tier.insufficient', message: 'raw words from the service' };
  const m = await mount(page, exchange);
  await ready(page);
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  const note = buyForm(page).locator('.dk-note--bad');
  await expect(note).toContainText('Verify your identity first');
  await expect(note).toContainText('You need a verified account to do this.');
  await expect(note.getByRole('link', { name: 'Verify now' })).toHaveAttribute('href', '/verification');
  await expect(buyForm(page)).not.toContainText('tier.insufficient');
  await expect(buyForm(page)).not.toContainText('raw words from the service');
  await expect(buyButton(page)).toBeDisabled();
  expect(m.requests('POST', 'orders')).toHaveLength(0);
  await shot(page, 'desk-refused-1440', { full: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'desk-refused-1280', { full: true });
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
  const notice = page.locator('.dk-note--warn');
  await expect(notice).toContainText('Checking your order…');
  await expect(notice).toContainText('You can’t place another order until this is settled');
  const key = 'trade-pending:00000000-0000-4000-8000-000000000001';
  expect(JSON.parse(await page.evaluate((k) => localStorage.getItem(k), key))).toMatchObject({ kind: 'place', symbol: 'BTC/USDT' });
  await expect(buyButton(page)).toBeDisabled();
  await shot(page, 'desk-checking-1440', { full: true });
  await page.waitForTimeout(1500);
  expect(m.requests('POST', 'orders')).toHaveLength(1); // never retried
  // The service shows the order; the check finds it and the desk is free again.
  exchange.opts.hideOrders = false;
  await notice.getByRole('button', { name: 'Check now' }).click();
  await expect(page.locator('.dk-note--warn')).toHaveCount(0);
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
  // The fee changes after the review opened: the service's fresh preview differs from the reviewed one.
  exchange.opts.markets = exchange.opts.markets.map((market) => (market.symbol === 'BTC/USDT' ? { ...market, maker: '0.002' } : market));
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm buy' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('changed');
  await expect(page.getByRole('alertdialog')).toContainText('(0.20% maker)');
  expect(m.requests('POST', 'orders')).toHaveLength(0); // nothing was sent
  await shot(page, 'desk-review-changed-1440', { full: true });
});

test('states: loading, no book, market closed, errors, signed out', async ({ page, browser }) => {
  // Loading
  let m = await mount(page, new Exchange(), { hold: ['markets'] });
  await page.locator('.if-desk[aria-busy="true"]').waitFor();
  await shot(page, 'desk-loading-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'desk-loading-1280');
  await m.release();
  await ready(page);

  // Book panel loading, with the book held back
  const heldBook = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  m = await mount(heldBook, new Exchange(), { hold: ['orderbook', 'ohlcv'] });
  await heldBook.locator('.dk-ticker .dk-pair').waitFor();
  await heldBook.locator('.dk-bk-skeleton').waitFor();
  await expect(heldBook.locator('.dk-chart-skeleton')).toBeVisible();
  await shot(heldBook, 'desk-panels-loading-1440');
  await heldBook.close();

  // No book
  const empty = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const exchange = new Exchange();
  exchange.opts.book = book({ empty: true });
  m = await mount(empty, exchange);
  await empty.locator('.dk-bk-note').waitFor();
  await expect(empty.locator('.dk-bk-note')).toHaveText('No orders yet in this market.');
  await expect(empty.locator('.dk-bk-mid')).toContainText('—');
  await shot(empty, 'desk-no-book-1440');
  await empty.setViewportSize({ width: 1280, height: 800 });
  await shot(empty, 'desk-no-book-1280');
  await empty.close();

  // Market closed
  const closed = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const shut = new Exchange();
  shut.opts.markets = markets({ btcOpen: false });
  m = await mount(closed, shut);
  await closed.locator('.dk-order [data-slot="state-block"]').waitFor();
  await expect(closed.locator('.dk-order')).toContainText('This market isn’t open');
  await expect(closed.locator('.dk-order')).toContainText('You can’t trade it right now');
  await shot(closed, 'desk-market-closed-1440');
  await closed.close();

  // Errors inside the failing panels only
  const broken = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const down = new Exchange();
  down.opts.fail = { orderbook: 500, ohlcv: 500, orders: 500 };
  m = await mount(broken, down);
  await broken.locator('.dk-bk [data-kind="error"]').waitFor({ timeout: 40000 });
  await expect(broken.locator('.dk-bk')).toContainText('Couldn’t load the order book.');
  await expect(broken.locator('.dk-chart')).toContainText('Couldn’t load the chart.');
  await expect(broken.locator('.dk-ticker .dk-pair')).toHaveText('BTC/USDT'); // the rest of the desk stays
  await shot(broken, 'desk-errors-1440');
  await broken.close();

  // Signed out
  const out = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  m = await mount(out, new Exchange(), { url: `${PAIR}?signedout=1` });
  await out.locator('.dk-ticker .dk-pair').waitFor();
  const login = out.locator('form.dk-form[data-side="buy"]').getByRole('link', { name: 'Log in to trade' });
  await expect(login).toBeVisible();
  expect(await login.getAttribute('href')).toMatch(/^\/login\?redirect=%2Ftrade%2Fspot%2FBTC-USDT/);
  await expect(out.getByText('Log in to see your orders.')).toBeVisible();
  await expect(out.locator('form.dk-form[data-side="buy"] .dk-avail')).toContainText('—');
  expect(
    m.exchange.requests.filter((r) => r.path.startsWith('orders/') || r.path === 'account/balance' || r.path === 'account/trades'),
  ).toHaveLength(0);
  await shot(out, 'desk-signed-out-1440', { full: true });
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
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="alertdialog"]')))).toBe(true);
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
  await page.locator('.dk-bk-row[data-side="ask"]').last().click();
  await expect(price).toHaveValue('65000.10');
  await expect(sellForm(page).getByRole('textbox', { name: 'Price' })).toHaveValue('65000.10');
  await buyForm(page).getByRole('button', { name: '50% of max' }).click();
  // 4,100 USDT / (65,000.10 x 1.002) = 0.06294... BTC; half of it, down to the lot
  const amount = buyForm(page).getByRole('textbox', { name: 'Amount' });
  await expect(amount).toHaveValue('0.03147');
  await sellForm(page).getByRole('button', { name: '100% of max' }).click();
  await expect(sellForm(page).getByRole('textbox', { name: 'Amount' })).toHaveValue('0.25');
  await buyForm(page).getByRole('button', { name: 'BBO' }).click();
  await expect(price).toHaveValue('64999.90');
  await sellForm(page).getByRole('button', { name: 'BBO' }).click();
  await expect(sellForm(page).getByRole('textbox', { name: 'Price' })).toHaveValue('65000.10');
});

test('another pair from the list: the URL changes and the form resets', async ({ page }) => {
  await mount(page);
  await ready(page);
  await fillBuy(page, { price: '63999.9', amount: '0.0001' });
  await page.locator('.dk-mk-row', { hasText: 'ETH/USDT' }).getByRole('link').click();
  await expect(page).toHaveURL(/\/trade\/spot\/ETH-USDT$/);
  await expect(page.locator('.dk-pair')).toHaveText('ETH/USDT');
  await expect(buyForm(page).getByRole('textbox', { name: 'Amount' })).toHaveValue('');
  await expect(page.locator('.dk-mk-row[data-selected] .dk-mk-pair')).toHaveText('ETH/USDT');
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

test('request budget: an idle desk stays under 120 requests a minute', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  await page.waitForTimeout(3000);
  const before = m.exchange.requests.length;
  await page.waitForTimeout(15000);
  const during = m.exchange.requests.length - before;
  // 15 s of idle polling, scaled to a minute
  expect(during * 4).toBeLessThanOrEqual(120);
});
