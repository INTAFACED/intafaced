// World: book
import { test, expect } from './journey.mjs';
import { chosePro, confirm, fundedTrader, openDesk, previewed, reviewSheet, signIn } from './desk.mjs';
import { api, EDGE, ORIGIN, toUnits } from './stack.mjs';

// J-portfolio-10, in the running app (docs/roadmap/journeys.json): I open a coin and see my own position in it. One test
// per step, titled "J-portfolio-10 #<n>". One TEST trader, verified and funded with TEST USDT through the real ledger,
// buys BTC twice at market on the desk, so the coin page has a holding, a lot book and fills of its own to show.
// #3 shows the asset registry's networks (svc-bank `assets.list`); the registry holds no contract or links yet, and no
// circulating supply is published, so market cap reads "not published".
const J = 'J-portfolio-10';

test.describe.configure({ mode: 'serial' });

let who;

/** The coin page for BTC, after its price card and holding have drawn. */
async function openCoin(page) {
  await page.goto('/coin/BTC');
  await expect(page.getByTestId('coin-name')).toHaveText('Bitcoin');
  await expect(page.getByTestId('coin-price-card')).toBeVisible();
}

const units = (value) => toUnits(String(value).replace(/[^0-9.]/g, ''));
/** One whole unit in toUnits' scale, and a scaled value rounded half up to the cent. */
const ONE = toUnits('1');
const CENT = toUnits('0.01');
const cents = (scaled) => ((scaled + CENT / 2n) / CENT) * CENT;
/** A signed dollar figure as the page writes it ("+$1.23", "−$0.40", "$0.00"), scaled; the minus may be U+2212. */
const signedUnits = (text) => (/^\s*[−-]/.test(text) ? -1n : 1n) * units(text);
const RANGES = ['1D', '1W', '1M', '6M', '1Y', 'All'];
const DAY_MS = 86_400_000;
/** The candles a range's request brought back, as the page read them: [time ms, open, high, low, close, volume]. */
const candlesOf = async (response) => {
  expect(response.status(), response.url()).toBe(200);
  return response.json();
};
/** BTC/USDT's 24h ticker as the stack publishes it. */
const tickerNow = async () => {
  const res = await fetch(`${EDGE}/api/v1/ticker/${encodeURIComponent('BTC/USDT')}`, { headers: { origin: ORIGIN } });
  expect(res.status).toBe(200);
  return res.json();
};
const dollars = (text) => Number(String(text).replace(/[^0-9.]/g, ''));

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await browser.newPage({ baseURL: ORIGIN });
  who = await fundedTrader(page, 'pf10', '1000');
  await openDesk(page, who);
  for (const amount of ['0.001', '0.002']) {
    await page.locator('[role=tab]', { hasText: /^Market$/ }).click();
    await previewed(page, () => page.getByRole('textbox', { name: 'Amount' }).first().fill(amount));
    await page.getByRole('button', { name: 'Buy BTC' }).click();
    await expect(reviewSheet(page)).toBeVisible();
    await confirm(page, 'buy');
  }
  // Two BTC fills, each net of its trading fee in BTC.
  await expect
    .poll(
      async () => (await (await api(who)).get('/api/v1/account/trades?limit=100')).body.filter((fill) => fill.symbol === 'BTC/USDT').length,
      {
        timeout: 20_000,
      },
    )
    .toBe(2);
  await page.close();
});

test(`${J} #1 opens /coin/BTC: price chart, range pills, stats, holding, about and activity, with the coin bar staying under the top bar`, async ({
  page,
}) => {
  await signIn(page, who);
  // The price chart draws the default range's candles (1D: 5-minute candles), as the page asked the stack for them.
  const firstCandles = page.waitForResponse((res) => res.url().includes('/ohlcv/') && /timeframe=5m/.test(res.url()));
  await openCoin(page);
  const drawn = await candlesOf(await firstCandles);
  expect(drawn.length, 'the stack has 5-minute BTC candles to draw').toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('coin-chart')).toBeVisible();
  await expect(page.getByTestId('chart-empty')).toHaveCount(0);
  await expect(page.getByTestId('coin-bar__ticker')).toHaveText('BTC');
  await expect(page.getByTestId('pair')).toHaveText('BTC/USDT');
  // The live price, as its picture names it (the digits roll, so the text holds every reel).
  await expect
    .poll(() => page.getByTestId('price').evaluate((node) => node.querySelector('[role="img"]')?.getAttribute('aria-label') ?? null))
    .toMatch(/^\$[\d,]+\.\d{2}$/);
  await expect(page.getByTestId('chart-area').getByTestId('coin-chart')).toBeVisible();
  // The range pills: all six, in order, the default 1D the one pressed.
  const pills = page.getByTestId('coin-ranges').locator('button');
  await expect(pills).toHaveText(RANGES);
  await expect(pills.filter({ hasText: /^1D$/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('coin-ranges').locator('button[aria-pressed="true"]')).toHaveCount(1);
  // The stats: 24h high and low are the stack's own 24h ticker (read again until both sides agree, as the price moves),
  // the high not under the low, and market cap and networks rows named.
  const stats = page.getByTestId('coin-stats');
  await expect
    .poll(async () => {
      const t = await tickerNow();
      const high = dollars(await stats.getByTestId('stat-high').locator('.coin-stats__value').innerText());
      const low = dollars(await stats.getByTestId('stat-low').locator('.coin-stats__value').innerText());
      return Math.abs(high - Number(t.high)) <= 0.005 && Math.abs(low - Number(t.low)) <= 0.005 && high >= low;
    })
    .toBe(true);
  await expect(stats.getByTestId('stat-market-cap')).toContainText('Market cap');
  await expect(stats.getByTestId('coin-network')).toContainText('Networks');
  // The holding is the ledger's: what svc-ledger holds for this person, free and in orders.
  const btc = (await (await api(who)).balances()).BTC;
  const yours = page.getByTestId('your-coin');
  await expect(yours.getByTestId('coin-h2')).toHaveText('Your BTC');
  await expect(yours).toContainText(`${Number(btc.free) + Number(btc.used)} BTC`);
  await expect(page.locator('#coin-about h2')).toHaveText('About Bitcoin');
  await expect(page.locator('#coin-recent-title')).toHaveText('Recent BTC activity');
  // The activity is this person's own: the two BTC buys from the start.
  await expect(page.getByTestId('recent').locator('tbody tr[data-fill]')).toHaveCount(2);

  // The coin bar sits right under the top bar while the page scrolls.
  const topBar = await page.locator('header').first().boundingBox();
  await page.mouse.wheel(0, 900);
  await expect
    .poll(async () => Math.round((await page.getByTestId('coin-bar').boundingBox()).y))
    .toBe(Math.round(topBar.y + topBar.height));
  await expect(page.getByTestId('coin-bar')).toBeInViewport();
});

test(`${J} #2 picks the 6M range: about six months of daily candles, the pills keep their order and arrow keys move between them`, async ({
  page,
}) => {
  await signIn(page, who);
  await openCoin(page);
  const pills = page.getByTestId('coin-ranges').locator('button');
  await expect(pills.filter({ hasText: /^6M$/ })).toBeVisible();
  expect(await pills.allInnerTexts()).toEqual(['1D', '1W', '1M', '6M', '1Y', 'All']);
  // Six months of daily candles: the chart asks for daily candles, 180 of them, and draws what came back.
  const asked = page.waitForResponse(
    (res) => res.url().includes('/ohlcv/') && /timeframe=1d/.test(res.url()) && /limit=180\b/.test(res.url()),
  );
  await pills.filter({ hasText: /^6M$/ }).click();
  const daily = await candlesOf(await asked);
  await expect(pills.filter({ hasText: /^6M$/ })).toHaveAttribute('aria-pressed', 'true');
  // Daily candles, oldest first, each a whole day after the one before, at most 180 of them, and none older than six
  // months of days.
  expect(daily.length, 'BTC has daily candles').toBeGreaterThanOrEqual(1);
  expect(daily.length).toBeLessThanOrEqual(180);
  for (const [i, candle] of daily.entries()) {
    expect(candle[0] % DAY_MS, `candle ${i} opens at a day's start`).toBe(0);
    if (i > 0) expect(candle[0] - daily[i - 1][0], `candle ${i} is a day after ${i - 1}`).toBeGreaterThanOrEqual(DAY_MS);
  }
  expect(Date.now() - daily[0][0]).toBeLessThanOrEqual(181 * DAY_MS);
  // The change line names the range: "Past six months", or, when the market is younger than that, the time it starts.
  const change = page.getByTestId('change');
  if (daily.length >= 180) await expect(change).toContainText('Past six months');
  else await expect(change).toContainText(/Since /);
  // Drawn: two or more candles draw the chart (fewer fall back to finer candles, which the page then draws).
  await expect(page.getByTestId('coin-chart')).toBeVisible();
  await expect(page.getByTestId('chart-empty')).toHaveCount(0);
  expect(await pills.allInnerTexts()).toEqual(['1D', '1W', '1M', '6M', '1Y', 'All']);
  // Arrow keys move between the pills.
  await pills.filter({ hasText: /^6M$/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(pills.filter({ hasText: /^1Y$/ })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(pills.filter({ hasText: /^6M$/ })).toBeFocused();
});

test(`${J} #3 reads stats and network details: market cap reads "not published" with no supply figure; network, contract and links where known`, async ({
  page,
}) => {
  await signIn(page, who);
  await openCoin(page);
  const stats = page.getByTestId('coin-stats');
  // No supply figure: neither the stack's BTC/USDT market nor its 24h ticker publishes a supply or market cap, so the
  // market cap row's value is exactly "not published", never a figure.
  const markets = await (await fetch(`${EDGE}/api/v1/markets?limit=500`, { headers: { origin: ORIGIN } })).json();
  const market = markets.find((row) => row.symbol === 'BTC/USDT');
  expect(market, 'BTC/USDT is a market on the stack').toBeDefined();
  const SUPPLY = /supply|market.?cap|circulating/i;
  expect(
    Object.keys(market).filter((key) => SUPPLY.test(key)),
    'the market publishes no supply figure',
  ).toEqual([]);
  expect(
    Object.keys(await tickerNow()).filter((key) => SUPPLY.test(key)),
    'the ticker publishes no supply figure',
  ).toEqual([]);
  const cap = stats.getByTestId('stat-market-cap');
  await expect(cap).toBeVisible();
  await expect(cap).toContainText('Market cap');
  await expect(cap.locator('.coin-stats__value')).toHaveText('not published');
  // The networks are the platform's asset registry's, read back from svc-bank: the networks of BTC's row when it is
  // active and a customer may deposit or withdraw it, joined in the registry's order; a coin with none says "not listed".
  const registry = (await (await api(who)).get('/api/bank/trpc/assets.list')).body.result.data.assets;
  const btc = registry.find(
    (row) =>
      row.assetId === 'BTC' &&
      row.state === 'active' &&
      (row.allowedActions.includes('deposit') || row.allowedActions.includes('withdraw')),
  );
  const network = page.getByTestId('coin-network');
  await expect(network).toContainText('Networks');
  await expect(network.locator('.coin-stats__value')).toHaveText(
    btc && btc.networks.length > 0 ? btc.networks.map((row) => row.label).join(', ') : 'not listed',
  );
  // Contract and links "where known": the registry is where the page would know them, and BTC's row (and each of its
  // networks) holds no contract address and no link, so none is known and the stats show none: no contract row, no
  // address, and no link at all.
  const CONTRACT = /contract|address|link|url|explorer|website|homepage/i;
  for (const row of registry.filter((entry) => entry.assetId === 'BTC')) {
    expect(
      Object.keys(row).filter((key) => CONTRACT.test(key)),
      'the registry row holds no contract or link',
    ).toEqual([]);
    for (const net of row.networks)
      expect(
        Object.keys(net).filter((key) => CONTRACT.test(key)),
        `network ${net.label}`,
      ).toEqual([]);
  }
  await expect(stats.locator('a')).toHaveCount(0);
  await expect(stats).not.toContainText(/contract|explorer|website/i);
  await expect(stats).not.toContainText(/0x[0-9a-f]{6,}/i);
});

test(`${J} #4 reads "Your position": quantity, average price, cost basis and result from the lot book`, async ({ page }) => {
  await signIn(page, who);
  await openCoin(page);
  const position = page.getByTestId('coin-position');
  await expect(position).toBeVisible();
  // The lot book as svc-tax works it out for this person (the same book Profit and loss reads).
  const book = (await (await api(who)).get('/api/tax/trpc/lotBook')).body.result.data;
  const asset = book.assets.find((row) => row.assetId === 'BTC');
  expect(asset, 'BTC in the lot book').toBeDefined();
  // Every BTC this person holds came from those two buys, so the open lots count exactly the ledger's holding.
  const btc = (await (await api(who)).balances()).BTC;
  expect(toUnits(asset.openQty)).toBe(toUnits(btc.free) + toUnits(btc.used));
  expect(asset.openCostUsd).not.toBeNull();
  await expect(position.locator('[data-figure="quantity"]')).toContainText(`${Number(asset.openQty)} BTC`);
  // To the cent, half up, from the book's exact figures.
  expect(units(await position.locator('[data-figure="cost-basis"]').innerText())).toBe(cents(toUnits(asset.openCostUsd)));
  // Divided as the app divides: half up at the 18th place, then to the cent.
  const average = (2n * toUnits(asset.openCostUsd) * ONE + toUnits(asset.openQty)) / (2n * toUnits(asset.openQty));
  expect(units(await position.locator('[data-figure="average-price"]').innerText())).toBe(cents(average));
  // The result is those open lots at the live price less their cost: the same price values the holding shown above it
  // (every BTC held is in those lots), so the result is that value less the cost basis, to the cent (each side is
  // rounded to the cent on the page, so they may differ by one cent).
  await expect(position.locator('[data-figure="result"]')).toHaveText(/^[+−-]?\$[\d,]+\.\d{2}$/);
  await expect
    .poll(async () => {
      const [value, result] = await Promise.all([
        page.getByTestId('your-coin').locator('.coin-yours__value').first().innerText(),
        position.locator('[data-figure="result"]').innerText(),
      ]);
      const expected = units(value) - cents(toUnits(asset.openCostUsd));
      const diff = signedUnits(result) - expected;
      return diff >= -CENT && diff <= CENT;
    })
    .toBe(true);
});

test(`${J} #5 reads recent activity for the coin: this person's BTC fills, newest first, or View all when a full page holds other coins`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  await signIn(page, who);
  await openCoin(page);
  const fills = (await (await api(who)).get('/api/v1/account/trades?limit=100')).body.filter((fill) => fill.symbol.startsWith('BTC/'));
  expect(fills).toHaveLength(2);
  const newestFirst = [...fills].sort((a, b) => b.timestamp - a.timestamp);
  const rows = page.getByTestId('recent').locator('tbody tr[data-fill]');
  await expect(rows).toHaveCount(2);
  expect(await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-fill')))).toEqual(newestFirst.map((fill) => fill.id));
  await expect(page.getByTestId('recent').getByTestId('dk-trade-what').first()).toHaveText(`Bought ${Number(newestFirst[0].amount)} BTC`);
  await expect(page.getByTestId('coin-recent__all')).toHaveAttribute('href', '/money/activity?tab=trades&asset=BTC');
  // Every row is this coin's.
  for (const what of await page.getByTestId('recent').getByTestId('dk-trade-what').allInnerTexts()) expect(what).toMatch(/\bBTC\b/);

  // A full page holding other coins: a second TEST trader whose latest page of fills (the 100 the page reads) holds only ETH fills, no BTC.
  const setup = await browser.newPage({ baseURL: ORIGIN });
  const other = await fundedTrader(setup, 'pf10b', '2000');
  await setup.close();
  const a = await api(other);
  for (let i = 0; i < 100; i++) {
    const res = await a.post('/api/v1/orders', {
      symbol: 'ETH/USDT',
      type: 'market',
      side: 'buy',
      amount: '0.002',
      clientOrderId: `${J}-full-page-${other.email}-${i}`,
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
  }
  await expect.poll(async () => (await a.get('/api/v1/account/trades?limit=100')).body.length, { timeout: 60_000 }).toBe(100);
  const latest = (await a.get('/api/v1/account/trades?limit=100')).body;
  expect(latest.filter((fill) => fill.symbol.startsWith('BTC/'))).toEqual([]);

  const context = await browser.newContext({ baseURL: ORIGIN });
  try {
    const page = await context.newPage();
    await signIn(page, other);
    await page.goto('/coin/BTC');
    await expect(page.getByTestId('coin-name')).toHaveText('Bitcoin');
    const recent = page.getByTestId('recent');
    await expect(recent.locator('tbody tr[data-fill]')).toHaveCount(0);
    const empty = recent.getByTestId('coin-recent__empty');
    await expect(empty).toContainText('No BTC trades in your latest 100');
    await expect(empty).toContainText('Older BTC activity may be under View all.');
    await expect(empty.getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/money/activity?tab=all&asset=BTC');
  } finally {
    await context.close();
  }
});

test(`${J} #6 presses Buy (Simple) or Trade (Pro): the Buy card with the coin chosen, or the spot desk for the pair`, async ({
  browser,
}) => {
  // Simple: the Buy card on the page has BTC chosen and locked; pressing its Buy reaches the review of a BTC buy.
  const simple = await browser.newContext({ baseURL: ORIGIN });
  try {
    const page = await simple.newPage();
    await signIn(page, who);
    await openCoin(page);
    await expect(page.getByTestId('trade-button')).toHaveCount(0);
    const buy = page.getByTestId('buy-card');
    await expect(buy).toBeVisible();
    // The coin is chosen: the coin row reads Buy BTC and offers no other coin.
    await expect(buy.locator('[aria-label="Change coin"]')).toHaveCount(0);
    await expect(buy.getByTestId('buy-row').first().getByTestId('buy-row__text')).toHaveText(/^\s*Buy\s*BTC\s*$/);
    const fillsBefore = (await (await api(who)).get('/api/v1/account/trades?limit=100')).body.length;
    await buy.getByLabel('Amount in USD').fill('10');
    await buy.getByRole('button', { name: 'Review buy' }).click();
    const review = page.getByRole('alertdialog');
    await expect(review).toContainText('Review your buy');
    await expect(review.getByTestId('review-get')).toContainText(/BTC/);
    await expect(review).toContainText(/per BTC/);
    // Leaving the review places nothing.
    await review.getByRole('button', { name: 'Cancel' }).click();
    await expect(review).toHaveCount(0);
    expect((await (await api(who)).get('/api/v1/account/trades?limit=100')).body.length).toBe(fillsBefore);
  } finally {
    await simple.close();
  }
  // Pro: a Trade button replaces the Buy card and opens the spot desk for BTC/USDT.
  const pro = await browser.newContext({ baseURL: ORIGIN });
  try {
    const page = await pro.newPage();
    await chosePro(page);
    await signIn(page, who);
    await openCoin(page);
    await expect(page.getByTestId('buy-card')).toHaveCount(0);
    const trade = page.getByTestId('trade-button');
    await expect(trade).toHaveText('Trade BTC/USDT');
    await trade.click();
    await expect(page).toHaveURL((url) => url.pathname === '/trade/spot/BTC-USDT');
    // The spot desk drew for that pair: its pair reads BTC/USDT and its ticket buys BTC.
    await expect(page.getByTestId('dk-pair')).toHaveText('BTC/USDT');
    await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
  } finally {
    await pro.close();
  }
});
