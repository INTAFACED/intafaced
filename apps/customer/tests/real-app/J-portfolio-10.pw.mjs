import { test, expect } from './journey.mjs';
import { chosePro, confirm, fundedTrader, openDesk, previewed, reviewSheet, signIn } from './desk.mjs';
import { api, ORIGIN, toUnits } from './stack.mjs';

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
  await openCoin(page);
  await expect(page.getByTestId('coin-bar__ticker')).toHaveText('BTC');
  await expect(page.getByTestId('pair')).toHaveText('BTC/USDT');
  // The live price, as its picture names it (the digits roll, so the text holds every reel).
  await expect
    .poll(() => page.getByTestId('price').evaluate((node) => node.querySelector('[role="img"]')?.getAttribute('aria-label') ?? null))
    .toMatch(/^\$[\d,]+\.\d{2}$/);
  await expect(page.getByTestId('chart-area')).toBeVisible();
  await expect(page.getByTestId('coin-ranges').locator('button').first()).toBeVisible();
  await expect(page.getByTestId('coin-stats')).toBeVisible();
  // The holding is the ledger's: what svc-ledger holds for this person, free and in orders.
  const btc = (await (await api(who)).balances()).BTC;
  const yours = page.getByTestId('your-coin');
  await expect(yours.getByTestId('coin-h2')).toHaveText('Your BTC');
  await expect(yours).toContainText(`${Number(btc.free) + Number(btc.used)} BTC`);
  await expect(page.locator('#coin-about h2')).toHaveText('About Bitcoin');
  await expect(page.locator('#coin-recent-title')).toHaveText('Recent BTC activity');

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
  // Six months of daily candles: the chart asks for daily candles, 180 of them.
  const asked = page.waitForRequest(
    (req) => req.url().includes('/ohlcv/') && /timeframe=1d/.test(req.url()) && /limit=180\b/.test(req.url()),
  );
  await pills.filter({ hasText: /^6M$/ }).click();
  await asked;
  await expect(pills.filter({ hasText: /^6M$/ })).toHaveAttribute('aria-pressed', 'true');
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
  const cap = stats.getByTestId('stat-market-cap');
  await expect(cap).toBeVisible();
  await expect(cap).toContainText('Market cap');
  await expect(cap).toContainText('not published');
  // The networks are the platform's asset registry's, read back from svc-bank.
  const registry = (await (await api(who)).get('/api/bank/trpc/assets.list')).body.result.data.assets;
  const btc = registry.find((row) => row.assetId === 'BTC');
  const network = page.getByTestId('coin-network');
  await expect(network).toContainText('Networks');
  await expect(network.locator('.coin-stats__value')).toHaveText(
    btc && btc.networks.length > 0 ? btc.networks.map((row) => row.label).join(', ') : 'not listed',
  );
  // No contract address or link is invented: the registry holds none.
  await expect(page.getByTestId('coin-stats')).not.toContainText(/0x[0-9a-f]{6,}/i);
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
  await expect(position.locator('[data-figure="result"]')).toHaveText(/^[+−-]?\$[\d,]+\.\d{2}/);
});

test(`${J} #5 reads recent activity for the coin: this person's BTC fills, newest first, and View all`, async ({ page }) => {
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
});

test(`${J} #6 presses Buy (Simple) or Trade (Pro): the Buy card with the coin chosen, or the spot desk for the pair`, async ({
  browser,
}) => {
  // Simple: the Buy card on the page is locked to BTC and reaches its review.
  const simple = await browser.newContext({ baseURL: ORIGIN });
  try {
    const page = await simple.newPage();
    await signIn(page, who);
    await openCoin(page);
    const buy = page.getByTestId('buy-card');
    await expect(buy).toBeVisible();
    await expect(buy.locator('[aria-label="Change coin"]')).toHaveCount(0);
    await expect(buy).toContainText('BTC');
    await expect(page.getByTestId('trade-button')).toHaveCount(0);
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
  } finally {
    await pro.close();
  }
});
