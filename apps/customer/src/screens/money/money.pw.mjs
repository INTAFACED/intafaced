import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activityPage1,
  activityPage2,
  balances,
  buyLines,
  cashOnlySummary,
  closedOrders,
  emptyBalances,
  emptySummary,
  fills,
  holdLines,
  olderServerLines,
  hourlyCandles,
  markets,
  openOrders,
  spaces,
  summary,
  tickers,
  trpc,
} from './money.fixtures.mjs';

const shots = process.env.MONEY_SHOTS ?? join(tmpdir(), 'intafaced-money-shots');
mkdirSync(shots, { recursive: true });
// Optional absolute paths to the OKX reference captures (never committed).
const referencePortfolio = process.env.MONEY_REFERENCE_PORTFOLIO;
const referenceActivity = process.env.MONEY_REFERENCE_ACTIVITY;

const forbidden = /unavailable|not connected|restricted|fixture|lifecycle|\broom\b|\bledger\b|\btier\b/i;
const moneyShape = /^[−+]?[$]?[\d,]+(\.\d+)?[%A-Z ]*$|^—$|^••••$/;

const missing = {
  status: 404,
  json: {
    error: { message: 'No "query"-procedure on path "portfolio.summary"', code: -32004, data: { code: 'NOT_FOUND', httpStatus: 404 } },
  },
};
const pricesDown = {
  status: 503,
  json: {
    error: {
      message: "Prices can't be loaded right now, so your total can't be shown. Try again in a minute. (bank.prices_unavailable)",
      code: -32603,
      data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503 },
    },
  },
};
const paused = {
  status: 403,
  json: {
    error: { message: 'paused', code: -32003, data: { code: 'FORBIDDEN', intafacedCode: 'denied.screening_fixture', httpStatus: 403 } },
  },
};

const exchange = {
  markets: () => markets,
  tickers: () => tickers(),
  balance: () => balances(),
  ohlcv: (symbol) => hourlyCandles(symbol),
  'account/trades': () => fills(),
  'orders/open': () => openOrders(),
  'orders/closed': () => closedOrders(),
};
const bankDefaults = {
  'portfolio.summary': () => summary(),
  // TEST: what the fixture person held a week ago and now (J-portfolio-06 #3).
  'portfolio.holdingsChange': (input) => ({
    from: input.from,
    to: '2026-10-20T12:00:00.000Z',
    rows: [
      {
        assetId: 'BTC',
        startAmount: '0.05',
        endAmount: '0.1',
        change: '0.05',
        startPriceUsd: '65000',
        endPriceUsd: '67812.4',
        startValueUsd: '3250',
        endValueUsd: '6781.24',
      },
    ],
  }),
  'spaces.list': () => spaces(),
  'activity.list': (input) => (input?.cursor ? activityPage2() : activityPage1()),
  // The session asks for the person's business accounts on every page (HM-navigation-01); this person has none.
  'business.list': () => [],
};

/**
 * Answer the bank (/api/bank/trpc/<procedure>) and exchange (/api/v1/...) calls the screen makes. An override is a
 * wire JSON body or a function of the request input, `null` to hold the request until `release()`, 'error' for a 500,
 * or { status, json } for any other answer. No service is contacted.
 */
async function mock(page, { bank = {}, rest = {} } = {}) {
  const servedBank = { ...bankDefaults, ...bank };
  const servedRest = { ...exchange, ...rest };
  const held = [];
  const seen = [];
  const answer = (route, value, arg) => {
    if (value === 'error') return route.fulfill({ status: 500, body: 'no' });
    if (value && typeof value === 'object' && 'status' in value && 'json' in value)
      return route.fulfill({ status: value.status, json: value.json });
    const body = typeof value === 'function' ? value(arg) : value;
    return route.fulfill({ status: 200, json: body });
  };
  await page.route('**/api/bank/trpc/**', async (route) => {
    const url = new URL(route.request().url());
    const procedure = decodeURIComponent(url.pathname.split('/trpc/')[1]);
    const posted = route.request().postData();
    const input = url.searchParams.get('input') ? JSON.parse(url.searchParams.get('input')) : posted ? JSON.parse(posted) : undefined;
    seen.push({ procedure, input });
    if (!(procedure in servedBank)) return route.fulfill({ status: 404, json: missing.json });
    const value = servedBank[procedure];
    if (value === null) return void held.push({ route, procedure, input });
    if (value && typeof value === 'object' && 'status' in value && 'json' in value) return answer(route, value);
    if (value === 'error') return answer(route, value);
    return route.fulfill({ status: 200, json: trpc(typeof value === 'function' ? value(input) : value) });
  });
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/v1\//, '');
    const name = path.startsWith('ohlcv/') ? 'ohlcv' : path === 'account/balance' ? 'balance' : path;
    const arg = name === 'ohlcv' ? decodeURIComponent(path.slice('ohlcv/'.length)) : undefined;
    seen.push({ procedure: `rest:${path}` });
    if (!(name in servedRest)) return route.fulfill({ status: 404, json: { error: { message: 'not mocked' } } });
    return answer(route, servedRest[name], arg);
  });
  return {
    seen,
    calls: (procedure) => seen.filter((call) => call.procedure === procedure),
    /** Answer every held bank request, and every later one, with the normal data. */
    release: async () => {
      for (const name of Object.keys(servedBank)) if (servedBank[name] === null) servedBank[name] = bankDefaults[name];
      for (const { route, procedure, input } of held.splice(0))
        await route.fulfill({ status: 200, json: trpc(bankDefaults[procedure](input)) });
    },
  };
}

const open = async (page, path = '/money') => {
  await page.goto(path);
  await page.getByTestId('if-money').waitFor();
};
// A first visit lands on Simple (shared/preferences.ts); a case about either mode says which it needs.
const PREFERENCES_KEY = 'intafaced.customer.view.v1';
const layout = (page, layoutMode, extra = {}) =>
  // Runs on every load, so it keeps what the page saved meanwhile (a case that reloads checks the saved choice).
  page.addInitScript(
    ([key, value]) => localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), ...value })),
    [PREFERENCES_KEY, { layoutMode, ...extra }],
  );
const pro = (page, extra = {}) => layout(page, 'pro', extra);
const simple = (page, extra = {}) => layout(page, 'simple', extra);

/** "$12,481.91": NumberFlow draws digit strips in a shadow root, so read the figure's accessible name. */
const heroText = (page) =>
  page.locator('[data-slot="hero-number"]').evaluate((node) => {
    const figure = node.querySelector('[role="img"]')?.getAttribute('aria-label') ?? node.firstElementChild?.textContent ?? '';
    return figure.trim();
  });
const expectHero = (page, text) => expect.poll(() => heroText(page).catch(() => null), { timeout: 7000 }).toBe(text);
const texts = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.textContent.trim().replace(/\s+/g, ' ')));
/** What a person reads: the phone-only Value line under Amount is display:none on desktop, which textContent would count. */
const seen = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.innerText.trim().replace(/\s+/g, ' ')));
const snap = async (page, name) => {
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(shots, `${name}.png`) });
};
/** Screenshots of one state at both desktop sizes. */
async function shootBoth(page, name, prepare) {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(size);
    if (prepare) await prepare();
    await snap(page, `${name}-${size.width}x${size.height}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

// ── portfolio ────────────────────────────────────────────────────────────────

test('portfolio from the bank at 1440x900: numbers, layout, words, keyboard path', async ({ page }) => {
  await simple(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  const api = await mock(page);
  await open(page);
  const root = page.getByTestId('if-money');
  await expect(page.getByTestId('money-label')).toContainText('Est. total value');
  await expectHero(page, '$12,481.91');
  await expect(root).toHaveAttribute('data-source', 'server');
  await expect(page.getByTestId('money-change')).toContainText('+$206.26');
  await expect(page.getByTestId('money-change')).toContainText('+1.68%');
  await expect(page.getByTestId('money-change')).toContainText('Today');
  await expect(page.getByTestId('money-change')).not.toContainText('from price moves'); // the bank's own figure, not a derivation

  // Unpriced coins: "Excludes 1 coin" with the list in a tooltip.
  await expect(page.getByTestId('money-head').locator(':is([data-testid="money-note"], [data-testid="derived-total-note"])')).toContainText(
    'Excludes 1 coin (no USD price)',
  );
  await expect(page.getByTestId('money-head').locator(':is([data-testid="money-note"], [data-testid="derived-total-note"])')).toContainText(
    'Not counted: ZED',
  );

  // Actions: only live ones, Buy is the one primary. Simple Buy and Sell open the Buy card (critic H1).
  expect(await texts(page.locator('[data-testid="money-actions"] > *'))).toEqual(['Buy', 'Sell', 'Convert', 'Send', 'Receive']);
  expect(await page.getByTestId('money-actions').locator('a[data-variant="primary"]').count()).toBe(1);
  await expect(page.getByTestId('money-actions').locator('a').nth(0)).toHaveAttribute('href', '/trade/buy?side=buy');
  await expect(page.getByTestId('money-actions').locator('a').nth(1)).toHaveAttribute('href', '/trade/buy?side=sell');
  expect(Math.round((await page.getByTestId('money-actions').locator('a').first().boundingBox()).height)).toBe(40);

  // Allocation bar and legend (percentages from the same decimal strings), plus the table for screen readers.
  expect(Math.round((await page.getByTestId('money-alloc__bar').boundingBox()).height)).toBe(8);
  expect(await texts(page.getByTestId('money-alloc__legend').locator('li'))).toEqual([
    'BTC54.33%',
    'USDT32.85%',
    'ETH12.82%',
    'DOGE<0.01%',
  ]);
  expect(await page.getByTestId('money-alloc__seg').count()).toBe(4);

  // Cash and Crypto cards.
  await expect(page.locator('#cash [data-testid="money-card__head"]')).toContainText('Cash');
  await expect(page.locator('#cash [data-testid="money-card__head"]')).toContainText('$4,100.00');
  await expect(page.locator('#crypto [data-testid="money-card__head"]')).toContainText('Crypto');
  await expect(page.locator('#crypto [data-testid="money-card__head"]')).toContainText('$8,381.91');
  expect(await texts(page.locator('#cash tbody tr [data-testid="money-coin__text"]'))).toEqual(['USDT· 32.8%Tether']);
  expect(await texts(page.locator('#crypto > [data-testid="money-table"] tbody tr [data-testid="money-coin__text"]'))).toEqual([
    'BTC· 54.3%Bitcoin',
    'ETH· 12.8%Ethereum',
    'ZED',
  ]);
  const btc = page.locator('#crypto tr[data-asset="BTC"]');
  expect(await seen(btc.locator('td').nth(1))).toEqual(['0.1 BTC']);
  // The price the bank valued it at, then the value it gives.
  expect(await texts(btc.locator('td').nth(2))).toEqual(['$67,812.40']);
  expect(await texts(btc.locator('td').nth(3))).toEqual(['$6,781.24']);
  expect(await texts(btc.locator('td').nth(4))).toEqual(['▲+$181.24 (+2.75%)']);
  // No link to the old coin page (critic H3): the row's own buttons are the way on.
  expect(await page.getByTestId('if-money').locator('a[href^="/coin/"]').count()).toBe(0);
  // Unpriced rows show a dash, never zero.
  const zed = page.locator('#crypto tr[data-asset="ZED"]');
  expect(await texts(zed.locator('td').nth(2))).toEqual(['—']);
  await expect(zed.locator('td').nth(2)).toHaveAttribute('title', 'No price published');
  expect(await texts(zed.locator('td').nth(3))).toEqual(['—']);
  // Row actions come from the registry and the markets: Buy/Sell/Send for a listed coin, Send only for the rest.
  expect(await texts(btc.locator('[data-testid="money-row__actions"] > *'))).toEqual(['Buy', 'Sell', 'Send']);
  await expect(btc.getByTestId('money-row__actions').locator('a').nth(0)).toHaveAttribute('href', '/trade/buy?asset=BTC&side=buy');
  await expect(btc.getByTestId('money-row__actions').locator('a').nth(1)).toHaveAttribute('href', '/trade/buy?asset=BTC&side=sell');
  await expect(btc.getByTestId('money-row__actions').locator('a').nth(2)).toHaveAttribute('href', '/pay/send?asset=BTC');
  expect(await texts(zed.locator('[data-testid="money-row__actions"] > *'))).toEqual(['Send']);
  // A cash row also converts in place, with that coin as the one to give (PF-overview-03).
  expect(await texts(page.locator('#cash tr[data-asset="USDT"] [data-testid="money-row__actions"] > *'))).toEqual(['Convert', 'Send']);
  await expect(page.locator('#cash tr[data-asset="USDT"] [data-testid="money-row__actions"] a').nth(0)).toHaveAttribute(
    'href',
    '/trade/convert?from=USDT',
  );
  // The amount opens the entries behind that balance (PF-balances-01), and the cell still reads as the figure alone.
  await expect(btc.locator('td').nth(1).locator('a')).toHaveAttribute('href', '/money/balance/BTC');
  await expect(btc.locator('td').nth(1).locator('a')).toHaveAttribute('title', 'See the entries behind BTC');
  await expect(btc.locator('td').nth(1).locator('a')).toHaveAttribute('aria-label', '0.1 BTC. See the entries behind BTC');
  // Rows are 64 px.
  expect(Math.round((await btc.boundingBox()).height)).toBe(64);

  // Small balances fold away under the Crypto card.
  await expect(page.getByTestId('money-small__trigger')).toContainText('Small balances');
  await expect(page.getByTestId('money-small__trigger')).toContainText('1 coin under $1');
  await expect(page.locator('tr[data-asset="DOGE"]')).toHaveCount(0);
  await page.getByTestId('money-small__trigger').click();
  await expect(page.locator('tr[data-asset="DOGE"]')).toBeVisible();
  expect(await texts(page.locator('tr[data-asset="DOGE"] td').nth(3))).toEqual(['$0.6173']);
  await page.getByTestId('money-small__trigger').click();

  // Named accounts, each with its balance (the main account is not one of them).
  await expect(page.locator('#accounts h2')).toHaveText('Your spaces');
  expect(await texts(page.getByTestId('money-accounts__row'))).toEqual(['Rent300 USDT', 'Long term0.04 BTC']);

  // Order on the page: value -> actions (right) -> allocation -> Cash -> Crypto -> accounts.
  const tops = await page.evaluate(() =>
    ['[data-slot="hero-number"]', '[data-testid="money-alloc"]', '#cash', '#crypto', '#accounts'].map(
      (selector) => document.querySelector(selector).getBoundingClientRect().top,
    ),
  );
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);
  // Geometry: container 1224, hero 48/58.
  expect(Math.round((await root.boundingBox()).width)).toBe(1224);
  expect(
    await page
      .locator('[data-slot="hero-number"]')
      .evaluate((node) => getComputedStyle(node).fontSize + '/' + getComputedStyle(node).lineHeight),
  ).toBe('48px/58px');

  // Plain words only, and every money figure has a money shape.
  expect(await root.innerText()).not.toMatch(forbidden);
  for (const value of await texts(page.locator('[data-slot="money"]'))) expect(value, `money shape: ${value}`).toMatch(moneyShape);

  // The total-value rule is available for assistive tech and as a tooltip below the number (not under the top bar).
  await expect(page.getByTestId('money-label')).toContainText('USDT and USDC count as 1 USD');
  await page.getByTestId('money-label').getByTestId('if-tip').hover();
  const openTip = page.locator('[data-slot="tooltip-content"][data-open]');
  await expect(openTip).toBeVisible();
  expect((await openTip.boundingBox()).y).toBeGreaterThanOrEqual(56);
  await page.mouse.move(0, 0);

  // Keyboard: eye -> the info tips -> pills -> row links (each followed by its actions).
  await page.getByTestId('harness-bar').locator('a').last().focus();
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
        inside: Boolean(node.closest('[data-testid="if-money"]')),
      };
    });
    if (!stop.inside) break;
    expect(stop.outline, `focus ring on ${stop.name}`).toBe('solid 2px rgb(200, 246, 74)');
    path.push(stop);
  }
  expect(path.slice(0, 3).map((stop) => stop.name)).toEqual(['Hide balances', 'How the total is worked out', 'About this change']);
  expect(
    path
      .filter((stop) => stop.href)
      .map((stop) => stop.href)
      .slice(0, 8),
  ).toEqual([
    '/trade/buy?side=buy',
    '/trade/buy?side=sell',
    '/trade/convert',
    '/pay/send',
    '/pay/receive',
    '/money/balance/USDT',
    '/trade/convert?from=USDT',
    '/pay/send?asset=USDT',
  ]);

  await snap(page, 'portfolio-loaded-1440x900');
  expect(errors).toEqual([]);
  expect(api.calls('portfolio.summary').length).toBeGreaterThan(0);
  expect(api.seen.filter((call) => call.procedure === 'rest:account/balance')).toHaveLength(0); // the bank answered, so the fallback never ran
});

test('portfolio screenshots: loaded, row actions shown, side by side with the OKX portfolio', async ({ page }) => {
  await mock(page);
  await open(page);
  await expectHero(page, '$12,481.91');
  await page.locator('#crypto tr[data-asset="BTC"]').hover();
  await shootBoth(page, 'portfolio-loaded');
  await page.locator('#crypto tr[data-asset="BTC"]').hover();
  await page.screenshot({ path: join(shots, 'portfolio-loaded-row-hover-1440x900.png') });
  await page.getByTestId('money-small__trigger').click();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(shots, 'portfolio-small-balances-open-1440x900.png'), fullPage: true });
  await page.getByTestId('money-small__trigger').click();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(shots, 'portfolio-loaded-full-1440.png'), fullPage: true });
  if (referencePortfolio && existsSync(referencePortfolio)) {
    const ours = readFileSync(join(shots, 'portfolio-loaded-1440x900.png')).toString('base64');
    const theirs = readFileSync(referencePortfolio).toString('base64');
    const compare = await page.context().newPage();
    await compare.setViewportSize({ width: 1440 + 1000, height: 940 });
    await compare.setContent(`<body style="margin:0;background:rgb(0 0 0);color:rgb(144 144 144);font:12px sans-serif;display:flex;gap:16px;padding:16px">
      <figure style="margin:0"><img src="data:image/png;base64,${ours}" style="width:1440px;display:block;border:1px solid rgb(46 46 46)"><figcaption style="padding-top:6px">INTAFACED /money (local test, mocked data)</figcaption></figure>
      <figure style="margin:0"><img src="data:image/png;base64,${theirs}" style="height:900px;display:block;border:1px solid rgb(46 46 46)"><figcaption style="padding-top:6px">Reference: OKX portfolio capture</figcaption></figure></body>`);
    await compare.screenshot({ path: join(shots, 'portfolio-side-by-side-okx.png') });
    await compare.close();
  }
});

test('an older bank without the summary: falls back to the data layer and shows the same kind of figures', async ({ page }) => {
  const api = await mock(page, { bank: { 'portfolio.summary': missing } });
  await open(page);
  // 4100 + 0.1 BTC + 0.5 ETH from the exchange balance and tickers: the same total the Home screen computes.
  await expectHero(page, '$12,481.29');
  await expect(page.getByTestId('if-money')).toHaveAttribute('data-source', 'derived');
  await expect(page.getByTestId('money-change')).toContainText('+$206.29');
  await expect(page.getByTestId('money-change')).toContainText('Today, from price moves');
  expect(await texts(page.locator('#crypto > [data-testid="money-table"] tbody tr [data-testid="money-coin__text"]'))).toEqual([
    'BTC· 54.3%Bitcoin',
    'ETH· 12.8%Ethereum',
  ]);
  expect(api.calls('rest:account/balance').length).toBeGreaterThan(0);
  await snap(page, 'portfolio-fallback-1440x900');
});

test('the portfolio links to the profit and loss room', async ({ page }) => {
  await mock(page, {});
  await open(page);
  const link = page.locator('a[data-testid="money-pnl-link"]');
  await expect(link).toContainText('Profit and loss');
  await expect(link).toHaveAttribute('href', '/money/pnl');
});

test('a dropped bank connection also falls back', async ({ page }) => {
  await mock(page, { bank: { 'portfolio.summary': 'error' } });
  await open(page);
  await expectHero(page, '$12,481.29');
  await expect(page.getByTestId('if-money')).toHaveAttribute('data-source', 'derived');
});

test('prices down: the bank refusal reads in plain words, with no fallback guess', async ({ page }) => {
  await simple(page);
  const api = await mock(page, { bank: { 'portfolio.summary': pricesDown } });
  await open(page);
  const block = page.locator('[data-slot="state-block"][data-kind="refused"]');
  await expect(block).toContainText("Prices can't be loaded");
  await expect(block).toContainText('Try again in a minute');
  await expect(block).toContainText('Ref PRC-1');
  const text = await page.getByTestId('if-money').innerText();
  expect(text).not.toMatch(forbidden);
  expect(text).not.toContain('bank.prices_unavailable');
  expect(await texts(page.locator('[data-testid="money-actions"] > *'))).toEqual(['Receive']);
  expect(api.calls('rest:account/balance')).toHaveLength(0);
  await shootBoth(page, 'portfolio-refused');
});

test('account paused: the refusal has words and a reference, never the raw code', async ({ page }) => {
  await mock(page, { bank: { 'portfolio.summary': paused } });
  await open(page);
  const block = page.locator('[data-slot="state-block"][data-kind="refused"]');
  await expect(block).toContainText('Paused for account checks');
  await expect(block).toContainText('Ref SCR-1');
  expect(await page.getByTestId('if-money').innerText()).not.toMatch(forbidden);
});

test('loading shows final-size skeletons and nothing moves when data arrives', async ({ page }) => {
  const api = await mock(page, { bank: { 'portfolio.summary': null, 'spaces.list': null } });
  await open(page);
  await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
  const hero = await page.getByTestId('money-total').locator('[data-slot="skeleton"]').boundingBox();
  expect([Math.round(hero.width), Math.round(hero.height)]).toEqual([240, 56]);
  const pills = await page
    .getByTestId('money-actions')
    .locator('[data-slot="skeleton"]')
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
  expect(pills).toEqual([40, 40, 40, 40, 40]);
  const before = await page.getByTestId('money-total').boundingBox();
  await shootBoth(page, 'portfolio-loading');
  await api.release();
  await expectHero(page, '$12,481.91');
  const after = await page.getByTestId('money-total').boundingBox();
  expect(Math.round(after.y)).toBe(Math.round(before.y));
  expect(Math.round(after.height)).toBe(Math.round(before.height));
});

test('an account with nothing in it: zero is right here, and there is a way forward', async ({ page }) => {
  await simple(page);
  await mock(page, { bank: { 'portfolio.summary': emptySummary, 'spaces.list': [] }, rest: { balance: emptyBalances } });
  await open(page);
  await expectHero(page, '$0.00');
  const block = page.locator('[data-slot="state-block"][data-kind="empty"]');
  await expect(block).toContainText('You don’t hold anything yet.');
  await expect(block.locator('a')).toHaveText('Buy crypto');
  await expect(block.locator('a')).toHaveAttribute('href', '/trade/buy?side=buy');
  expect(await texts(page.locator('[data-testid="money-actions"] > *'))).toEqual(['Receive']);
  await expect(page.locator('#cash')).toHaveCount(0); // a card with no rows is omitted
  await shootBoth(page, 'portfolio-empty');
});

test('nothing at all works: an error inside the page, with a way to try again', async ({ page }) => {
  await mock(page, { bank: { 'portfolio.summary': 'error' }, rest: { balance: 'error' } });
  await open(page);
  const block = page.locator('[data-slot="state-block"][data-kind="error"]');
  await expect(block).toContainText('Couldn’t load your balance.');
  await expect(block.getByRole('button', { name: 'Try again' })).toBeVisible();
  await shootBoth(page, 'portfolio-error');
});

test('cash only: no empty Crypto card and no meaningless "$0.00 today" line', async ({ page }) => {
  await mock(page, { bank: { 'portfolio.summary': cashOnlySummary, 'spaces.list': [] } });
  await open(page);
  await expectHero(page, '$250.00');
  await expect(page.locator('#crypto')).toHaveCount(0);
  await expect(page.getByTestId('money-change')).toHaveCount(0);
  await expect(page.locator('#accounts')).toHaveCount(0); // no named accounts, no section
  await shootBoth(page, 'portfolio-cash-only');
});

test('a young market says "since HH:MM" instead of Today', async ({ page }) => {
  const windowStart = Date.UTC(2026, 9, 14, 8, 30);
  await mock(page, { bank: { 'portfolio.summary': () => summary({ windowStart }) } });
  await open(page);
  await expect(page.getByTestId('money-change')).toContainText('since 08:30');
});

test('the bank cannot list accounts: the page carries on without that section', async ({ page }) => {
  await mock(page, { bank: { 'spaces.list': 'error' } });
  await open(page);
  await expectHero(page, '$12,481.91');
  await expect(page.locator('#accounts')).toHaveCount(0);
});

test('Your spaces lists a named account only while it holds something; the picker still offers every one', async ({ page }) => {
  const empty = { ...spaces()[0], kind: 'named', id: 'sp-empty-test', name: 'Empty TEST', balance: '0' };
  const unread = { ...spaces()[0], kind: 'named', id: 'sp-unread-test', name: 'Unread TEST', balance: 'not-a-number' };
  await mock(page, { bank: { 'spaces.list': () => [...spaces(), empty, unread] } });
  await open(page);
  // A known zero is left out; a balance that cannot be read stays listed, shown as unknown.
  const rows = await texts(page.getByTestId('money-accounts__row'));
  expect(rows.slice(0, 2)).toEqual(['Rent300 USDT', 'Long term0.04 BTC']);
  expect(rows).toHaveLength(3);
  expect(rows[2]).toContain('Unread TEST');
  await expect(page.getByTestId('money-accounts__row').filter({ hasText: 'Empty TEST' })).toHaveCount(0);
  await expect(page.getByLabel('Accounts shown').locator('option', { hasText: 'Empty TEST' })).toHaveCount(1);
});

test('hidden balances show bullets, prices and shares stay, and the choice is remembered', async ({ page }) => {
  await simple(page);
  await mock(page);
  await open(page);
  await page.getByRole('button', { name: 'Hide balances' }).click();
  await expect(page.getByRole('button', { name: 'Show balances' })).toBeVisible();
  await expectHero(page, '$••••');
  await expect(page.getByTestId('money-change').locator('[data-slot="change-text"]')).toContainText('••••');
  await expect(page.getByTestId('money-change')).not.toContainText('206');
  expect(await texts(page.locator('#cash [data-slot="money"], #cash [data-slot="amount"]'))).toEqual(['••••', '••••', '••••', '••••']);
  for (const value of await texts(page.locator('[data-slot="money"], [data-slot="amount"]'))) expect(value).toMatch(moneyShape);
  await expect(page.getByTestId('money-alloc__legend')).toContainText('54.33%');
  await snap(page, 'portfolio-hidden-1440x900');
  await page.reload();
  await expectHero(page, '$••••');
  await page.getByRole('button', { name: 'Show balances' }).click();
  await expectHero(page, '$12,481.91');
});

test('/money#crypto scrolls to the Crypto card', async ({ page }) => {
  await simple(page);
  await mock(page);
  await page.setViewportSize({ width: 1440, height: 500 });
  await open(page, '/money#crypto');
  await expectHero(page, '$12,481.91');
  await expect.poll(async () => Math.round((await page.locator('#crypto').boundingBox()).y)).toBeLessThan(140);
});

test('portfolio responsive: no horizontal page scroll at 1280, 1180, 768 and 390', async ({ page }) => {
  await mock(page);
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1180, height: 800 },
    { width: 768, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await open(page);
    await expectHero(page, '$12,481.91');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="if-money"] *')]
        .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 4)
        .map((node) => node.className || node.tagName),
    );
    expect(overflow, `${size.width}px, too wide: ${wide.join(' | ')}`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: join(shots, `portfolio-${size.width}x${size.height}.png`), fullPage: size.width < 800 });
  }
});

// ── pro ──────────────────────────────────────────────────────────────────────

test('Pro Money: stake and collateral are in Locked, not in In orders, when the bank splits the locks', async ({ page }) => {
  const api = await mock(page, {
    bank: {
      'spaces.list': () => spaces().map((space) => ({ ...space, balance: '0' })),
      // Illustrative test figures: 4,095 spendable, 3 in open orders, 2 staked; 4,100 in the main account.
      'portfolio.balanceBreakdown': () => ({
        assets: [
          {
            assetId: 'USDT',
            total: '4100',
            available: '4095',
            locked: [
              { kind: 'hold', amount: '3', claims: [{ purpose: 'order:o-1', amount: '3' }] },
              { kind: 'stake', amount: '2', claims: [{ purpose: 'token:stake:s-1', amount: '2' }] },
            ],
          },
        ],
      }),
    },
    rest: {
      balance: () => balances({ USDT: { free: '4095', used: '5', total: '4100.00' }, BTC: { free: '0.1', used: '0', total: '0.1' } }),
    },
  });
  await pro(page);
  await open(page);
  const usdt = page.locator('#cash tr[data-asset="USDT"]');
  expect(await texts(usdt.locator('td[data-col="available"]'))).toEqual(['4,095']);
  expect(await texts(usdt.locator('td[data-col="in-orders"]'))).toEqual(['3']);
  expect(await texts(usdt.locator('td[data-col="locked"]'))).toEqual(['2']);
  await expect(usdt.locator('td[data-col="locked"]')).toHaveAttribute('title', /Staked: 2/);
  const btc = page.locator('#crypto tr[data-asset="BTC"]');
  expect(await texts(btc.locator('td[data-col="locked"]'))).toEqual(['0']);
  expect(api.calls('portfolio.balanceBreakdown')[0].input).toEqual({ scope: 'main' });
});

test('Pro Money: Available and In orders columns, 40 px rows, hero 32/40, Buy and Sell go to the desk (critic H4)', async ({ page }) => {
  await mock(page, {
    bank: { 'spaces.list': () => spaces().map((space) => ({ ...space, balance: '0' })) },
    rest: {
      balance: () => balances({ USDT: { free: '4095', used: '5', total: '4100.00' }, BTC: { free: '0.1', used: '0', total: '0.1' } }),
    },
  });
  await pro(page);
  await open(page);
  await expectHero(page, '$12,481.91');
  await expect(page.getByTestId('if-money')).toHaveAttribute('data-density', 'pro');
  expect(
    await page
      .locator('[data-slot="hero-number"]')
      .evaluate((node) => getComputedStyle(node).fontSize + '/' + getComputedStyle(node).lineHeight),
  ).toBe('32px/40px');
  expect(await seen(page.locator('#crypto > [data-testid="money-table"] thead th'))).toEqual([
    'Coin',
    'Amount',
    'Price',
    'Value',
    'Today',
    'Available',
    'In orders',
    'Locked',
    'In spaces',
    'Actions',
  ]);
  const usdt = page.locator('#cash tr[data-asset="USDT"]');
  expect(await texts(usdt.locator('td[data-col="available"]'))).toEqual(['4,095']);
  expect(await texts(usdt.locator('td[data-col="in-orders"]'))).toEqual(['5']);
  expect(await texts(usdt.locator('td[data-col="in-spaces"]'))).toEqual(['0']);
  const btc = page.locator('#crypto tr[data-asset="BTC"]');
  expect(await texts(btc.locator('td[data-col="available"]'))).toEqual(['0.1']);
  expect(await texts(btc.locator('td[data-col="in-orders"]'))).toEqual(['0']);
  expect(await texts(btc.locator('td[data-col="in-spaces"]'))).toEqual(['0']);
  expect(Math.round((await btc.boundingBox()).height)).toBe(40);
  // Pro means the desk.
  await expect(page.getByTestId('money-actions').locator('a').nth(0)).toHaveAttribute('href', '/trade/spot/BTC-USDT');
  await expect(btc.getByTestId('money-row__actions').locator('a').nth(0)).toHaveAttribute('href', '/trade/spot/BTC-USDT');
  await expect(btc.getByTestId('money-row__actions').locator('a').nth(1)).toHaveAttribute('href', '/trade/spot/BTC-USDT?side=sell');
  await expect(btc.getByTestId('money-row__actions')).toHaveCSS('opacity', '1'); // always shown in Pro
  expect(await page.getByTestId('if-money').innerText()).not.toMatch(forbidden);
  // Every column has its own width: the row actions never sit over In spaces (Phantom 24 Oct). Below 1280 the
  // rows drop their buttons; the page's own stay.
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1100, height: 800 },
  ]) {
    await page.setViewportSize(size);
    for (const row of [usdt, btc]) {
      const spacesBox = await row.locator('td[data-col="in-spaces"]').boundingBox();
      expect(spacesBox, `${size.width}px`).not.toBeNull();
      const actions = row.getByTestId('money-row__actions').locator('a');
      if (size.width < 1280) {
        await expect(actions.first()).toBeHidden();
        continue;
      }
      const firstAction = await actions.first().boundingBox();
      expect(firstAction, `${size.width}px`).not.toBeNull();
      expect(firstAction.x, `${size.width}px`).toBeGreaterThanOrEqual(spacesBox.x + spacesBox.width - 0.5);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('money-actions').locator('a').first()).toBeVisible();
  // Profit and loss is its own panel, spaced below the last card, not glued to it.
  const lastCard = await page.getByTestId('money-card').last().boundingBox();
  const pnl = await page.getByTestId('money-pnl-link').boundingBox();
  expect(lastCard).not.toBeNull();
  expect(pnl).not.toBeNull();
  expect(pnl.y - (lastCard.y + lastCard.height)).toBeGreaterThanOrEqual(24);
  await snap(page, 'portfolio-pro-1440x900');
  // No sideways scroll at 1280 and 390.
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${size.width}px`).toBeLessThanOrEqual(0);
  }
});

test('Pro Money: Available + In orders + In spaces add up to Amount (USDT 3,795 + 5 + 300 = 4,100)', async ({ page }) => {
  await mock(page, {
    rest: {
      balance: () =>
        balances({
          USDT: { free: '3795', used: '5', total: '3800.00' },
          BTC: { free: '0.06', used: '0', total: '0.06' },
          ETH: { free: '0.5', used: '0', total: '0.5' },
          DOGE: { free: '5', used: '0', total: '5' },
          ZED: { free: '12', used: '0', total: '12' },
        }),
    },
  });
  await pro(page);
  await open(page);
  const usdt = page.locator('#cash tr[data-asset="USDT"]');
  expect(await texts(usdt.locator('td[data-col="available"]'))).toEqual(['3,795']);
  expect(await texts(usdt.locator('td[data-col="in-orders"]'))).toEqual(['5']);
  expect(await texts(usdt.locator('td[data-col="in-spaces"]'))).toEqual(['300']);
  const btc = page.locator('#crypto tr[data-asset="BTC"]');
  expect(await texts(btc.locator('td[data-col="in-spaces"]'))).toEqual(['0.04']);
  await expect(page.getByTestId('held-note')).toHaveCount(0);
});

test('Pro Money with the bank summary missing: In spaces is a dash, never 0, and the note points to Your spaces', async ({ page }) => {
  await mock(page, {
    bank: { 'portfolio.summary': missing },
    rest: {
      balance: () => balances({ USDT: { free: '4095', used: '5', total: '4100.00' }, BTC: { free: '0.1', used: '0', total: '0.1' } }),
    },
  });
  await pro(page);
  await open(page);
  await expect(page.getByTestId('if-money')).toHaveAttribute('data-source', 'derived');
  const usdt = page.locator('#cash tr[data-asset="USDT"]');
  expect(await texts(usdt.locator('td[data-col="in-spaces"]'))).toEqual(['—']);
  await expect(page.getByTestId('held-note')).toHaveCount(1);
  await expect(page.getByTestId('held-note')).toContainText('It is listed under Your spaces below.');
});

test('Simple Money has no Available and In orders columns', async ({ page }) => {
  await simple(page);
  await mock(page);
  await open(page);
  expect(await seen(page.locator('#crypto > [data-testid="money-table"] thead th'))).toEqual([
    'Coin',
    'Amount',
    'Price',
    'Value',
    'Today',
    'Actions',
  ]);
});

test('Money lists the named accounts only when one of them holds something (critic M9)', async ({ page }) => {
  await mock(page, { bank: { 'spaces.list': () => spaces().map((space) => ({ ...space, balance: '0' })) } });
  await open(page);
  await expectHero(page, '$12,481.91');
  await expect(page.locator('#accounts')).toHaveCount(0);
});

// ── activity ─────────────────────────────────────────────────────────────────

const ALL = '/money/activity?tab=all';

test('activity opens on All, with Trades one tab along', async ({ page }) => {
  await mock(page);
  await open(page, '/money/activity');
  await expect(page.locator('h1')).toHaveText('Activity');
  expect(await texts(page.locator('[data-slot="tabs-tab"]'))).toEqual([
    'All',
    'Trades',
    'Orders',
    'Deposits',
    'Transfers',
    'Fees',
    'Entries',
  ]);
  await expect(page.locator('[data-slot="tabs-tab"][data-active]')).toHaveText('All');
  await open(page, '/money/activity?tab=nonsense');
  await expect(page.locator('[data-slot="tabs-tab"][data-active]')).toHaveText('All');
});

test('activity Trades tab is built from fills: one row per trade with price, total and fee (critic H2)', async ({ page }) => {
  await simple(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  const api = await mock(page);
  await open(page, '/money/activity?tab=trades');
  await expect(page.locator('h1')).toHaveText('Activity');
  await expect(page.locator('[data-slot="tabs-tab"][data-active]')).toHaveText('Trades');
  expect(await texts(page.getByTestId('money-trade-tab').locator('thead th'))).toEqual(['Time', 'Trade', 'Price', 'Total', 'Fee']);
  const rows = page.getByTestId('money-trade-tab').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  expect(await texts(rows.nth(0).locator('td'))).toEqual([
    '14 Oct, 08:02',
    'Bought 0.00015 BTCBTC/USDT',
    '65,083.66',
    '9.762549 USDT',
    '0.00000015 BTC',
  ]);
  expect(await texts(rows.nth(1).locator('td'))).toEqual([
    '13 Oct, 10:30',
    'Sold 0.002 BTCBTC/USDT',
    '64,000.00',
    '128.000000 USDT',
    '0.128 USDT',
  ]);
  expect(Math.round((await rows.first().boundingBox()).height)).toBe(48);
  expect(await page.getByTestId('if-money').innerText()).not.toMatch(forbidden);
  // The ledger is not read for this tab, and the same request the desk makes feeds it.
  expect(api.calls('activity.list')).toHaveLength(0);
  expect(api.seen.filter((call) => call.procedure === 'rest:account/trades').length).toBeGreaterThan(0);
  await snap(page, 'activity-trades-1440x900');
  expect(errors).toEqual([]);
});

test('activity ?asset= narrows Trades and All to one coin, shows a removable chip, and unknown coins read as empty', async ({ page }) => {
  await simple(page);
  await mock(page);
  const chip = (name) => page.getByRole('button', { name: `Remove ${name} filter` });
  // Trades: fills whose base or quote is the coin.
  await open(page, '/money/activity?tab=trades&asset=BTC');
  await expect(page.getByTestId('money-trade-tab').locator('tbody tr')).toHaveCount(2);
  await expect(chip('BTC')).toHaveText('BTC');
  await open(page, '/money/activity?tab=trades&asset=USDT');
  await expect(page.getByTestId('money-trade-tab').locator('tbody tr')).toHaveCount(2);
  await open(page, '/money/activity?tab=trades&asset=ETH');
  await expect(chip('ETH')).toBeVisible();
  await expect(page.getByTestId('money-trade-tab').locator('tbody tr')).toHaveCount(0);
  await expect(page.getByTestId('money-state')).toContainText('No ETH trades yet');
  // Unknown coin: a filter-aware empty state (every fill was seen), and the chip still removes the filter.
  await open(page, '/money/activity?tab=trades&asset=ZZZ');
  await expect(page.getByTestId('money-state')).toContainText('No ZZZ trades yet');
  await chip('ZZZ').click();
  await expect(page).toHaveURL(/\/money\/activity\?tab=trades$/);
  await expect(chip('ZZZ')).toHaveCount(0);
  await expect(page.getByTestId('money-trade-tab').locator('tbody tr')).toHaveCount(2);
  // All: a whole order stays together when any of its lines is in the coin (the BTC buy keeps its USDT lines).
  await open(page, '/money/activity?tab=all&asset=BTC');
  await expect(page.getByTestId('money-act')).toHaveCount(1);
  expect(await texts(page.getByTestId('money-act__title'))).toEqual(['Trade']);
  expect(await texts(page.getByTestId('money-act__sub'))).toEqual(['Paid 678.124000 USDT · Fee 0.678100 USDT']);
  // ...and it looks back through older pages on its own (ETH is on both pages).
  await open(page, '/money/activity?tab=all&asset=ETH');
  await expect(page.getByTestId('money-act')).toHaveCount(2);
  await open(page, '/money/activity?tab=all&asset=ZZZ');
  await expect(page.getByTestId('money-act')).toHaveCount(0);
  await expect(page.getByTestId('money-state')).toContainText('No ZZZ activity');
  await expect(page.getByTestId('money-state')).not.toContainText('No activity yet');
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  // Switching tab keeps the coin; removing the chip clears only the coin.
  await open(page, '/money/activity?tab=all&asset=BTC');
  await page.locator('[data-slot="tabs-tab"]', { hasText: 'Deposits' }).click();
  await expect(page).toHaveURL(/tab=deposits&asset=BTC$/);
  await snap(page, 'activity-asset-chip-1440x900');
  await chip('BTC').click();
  await expect(page).toHaveURL(/\/money\/activity\?tab=deposits$/);
});

test('activity Orders tab shows open orders with Cancel and the order history (critic H2)', async ({ page }) => {
  await mock(page);
  await open(page, '/money/activity?tab=orders');
  await expect(page.locator('[data-slot="tabs-tab"][data-active]')).toHaveText('Orders');
  expect(await texts(page.getByTestId('money-trade-tab__head'))).toEqual(['Open orders', 'Order history']);
  const tables = page.getByTestId('money-trade-tab').locator('table');
  await expect(tables).toHaveCount(2);
  const open_ = tables.nth(0).locator('tbody tr');
  await expect(open_).toHaveCount(1);
  await expect(open_.getByRole('button', { name: /Cancel buy order for 0.00008 BTC/ })).toBeVisible();
  const history = tables.nth(1).locator('tbody tr');
  await expect(history).toHaveCount(2);
  expect(await texts(history.locator('td:last-child'))).toEqual(['Filled', 'Cancelled']);
  await snap(page, 'activity-orders-1440x900');
});

test('every link that means "my orders" lands on the Orders tab', async ({ page }) => {
  await simple(page);
  await mock(page);
  await open(page, '/money/activity?tab=orders');
  await expect(page.locator('[data-slot="tabs-tab"][data-active]')).toHaveText('Orders');
  await open(page, '/money/activity?tab=nonsense');
  await expect(page.locator('[data-slot="tabs-tab"][data-active]')).toHaveText('All');
});

test('All: the lines of one order share an orderId and are one row; a cancelled order is one row (critic H2, N2)', async ({ page }) => {
  await mock(page, {
    bank: { 'activity.list': () => ({ items: [...holdLines(), ...buyLines()], nextCursor: null }) },
  });
  await open(page, ALL);
  await expect(page.getByTestId('money-act')).toHaveCount(2);
  expect(await texts(page.getByTestId('money-act__title'))).toEqual(['Trade', 'Order cancelled · nothing spent']);
  expect(await texts(page.getByTestId('money-act').locator('[data-slot="amount"]'))).toEqual(['+0.0000999 BTC', '5 USDT']);
  // No Paid: a hold minus a release is never turned into a price. The set-aside and returned money is shown as it is.
  expect(await texts(page.getByTestId('money-act__sub'))).toEqual(['Set aside 6.540908 USDT · Returned 0.032542 USDT']);
  await expect(page.getByTestId('money-act-note')).toHaveCount(0);
  expect(await page.getByTestId('if-money').innerText()).not.toContain('not listed');
  await snap(page, 'activity-all-trade-1440x900');
});

test('All: an older server with no orderId shows every line as its own row, with its real amount', async ({ page }) => {
  await mock(page, { bank: { 'activity.list': () => ({ items: olderServerLines(), nextCursor: null }) } });
  await open(page, ALL);
  await expect(page.getByTestId('money-act')).toHaveCount(5);
  expect(await texts(page.getByTestId('money-act__title'))).toEqual([
    'Other activity',
    'Trade',
    'Other activity',
    'Other activity',
    'Other activity',
  ]);
  expect(await texts(page.getByTestId('money-act').locator('[data-slot="amount"]'))).toEqual([
    '+0.032542 USDT',
    '+0.0000999 BTC',
    '−6.540908 USDT',
    '+5 USDT',
    '−5 USDT',
  ]);
  await expect(page.getByTestId('money-act__sub')).toHaveCount(0);
});

test('All shows a resting order as one "Set aside" row, never as completed money gone', async ({ page }) => {
  await mock(page, {
    bank: { 'activity.list': () => ({ items: [holdLines()[1]], nextCursor: null }) },
  });
  await open(page, ALL);
  expect(await texts(page.getByTestId('money-act__title'))).toEqual(['Set aside for an order']);
  expect(await texts(page.getByTestId('money-act__hold'))).toEqual(['Set aside']);
  await expect(page.getByTestId('money-act__done')).toHaveCount(0);
});

test('Pro Activity rows are 40 px', async ({ page }) => {
  await mock(page);
  await pro(page);
  await open(page, ALL);
  await expect(page.getByTestId('money-act')).toHaveCount(10);
  expect(Math.round((await page.getByTestId('money-act').first().boundingBox()).height)).toBe(40);
});

test('activity: rows in plain words, signed amounts, local time, completed', async ({ page }) => {
  await simple(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  const api = await mock(page);
  await open(page, ALL);
  await expect(page.locator('[data-slot="tabs-tab"][data-active]')).toHaveText('All');
  const rows = page.getByTestId('money-act');
  // 12 ledger lines on page one are 10 rows: the fill's three lines are one Trade; the loose "other" line is listed.
  await expect(rows).toHaveCount(10);
  expect(await texts(page.getByTestId('money-act__title'))).toEqual([
    'Received from @maya',
    'Trade',
    'Sent to @ola',
    'Received',
    'Moved between your accounts',
    'Deposit',
    'Welcome test funds',
    'Payment sent',
    'Withdrawal',
    'Other activity',
  ]);
  expect(await texts(page.getByTestId('money-act__sub'))).toEqual(['Paid 678.124000 USDT · Fee 0.678100 USDT', 'Account: Rent']);
  // Amounts carry their sign in text and their direction in colour.
  expect(await texts(page.getByTestId('money-act').locator('[data-slot="amount"]'))).toEqual([
    '+50 USDT',
    '+0.01 BTC',
    '−20 USDT',
    '+15 USDT',
    '−300 USDT',
    '+1,000 USDT',
    '+4,000 USDT',
    '−12.5 USDT',
    '−100 USDT',
    '+0.2 ETH',
  ]);
  const colour = (selector) =>
    page
      .locator(selector)
      .first()
      .evaluate((node) => getComputedStyle(node).color);
  expect(await colour('[data-testid="money-act"][data-kind="transfer_in"] [data-slot="amount"]')).toBe('rgb(37, 167, 80)');
  expect(await colour('[data-testid="money-act"][data-kind="transfer_out"] [data-slot="amount"]')).toBe('rgb(224, 86, 122)');
  // Time in the viewer's zone (the test browser runs in UTC), same year without the year.
  expect(await texts(page.getByTestId('money-act__time'))).toEqual([
    '14 Oct, 09:15',
    '14 Oct, 08:02',
    '13 Oct, 17:40',
    '13 Oct, 12:00',
    '12 Oct, 20:30',
    '12 Oct, 10:00',
    '10 Oct, 06:00',
    '9 Oct, 15:00',
    '8 Oct, 11:11',
    '7 Oct, 09:00',
  ]);
  expect(new Set(await texts(page.getByTestId('money-act__done')))).toEqual(new Set(['Completed']));
  expect(Math.round((await rows.first().boundingBox()).height)).toBe(48);
  expect(await page.getByTestId('if-money').innerText()).not.toMatch(forbidden);

  // Paging: "Load more" asks for the next page with the cursor and appends it.
  await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();
  await snap(page, 'activity-loaded-1440x900');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(rows).toHaveCount(13);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  expect((await texts(page.getByTestId('money-act__time'))).at(-1)).toBe('30 Dec 2025, 10:00'); // another year shows the year
  // (React's dev double-mount may ask for page one twice; the second page is asked for once, with the cursor.)
  const asked = api.calls('activity.list').map((call) => call.input);
  expect(asked.filter((input) => input.cursor)).toEqual([{ limit: 50, cursor: 'cursor-2' }]);
  expect(asked.filter((input) => !input.cursor).every((input) => input.limit === 50)).toBe(true);
  expect(errors).toEqual([]);
});

test('activity screenshots at both sizes, and side by side with the OKX order centre', async ({ page }) => {
  await mock(page);
  await open(page, ALL);
  await expect(page.getByTestId('money-act')).toHaveCount(10);
  await shootBoth(page, 'activity-loaded');
  await page.screenshot({ path: join(shots, 'activity-loaded-full-1440.png'), fullPage: true });
  if (referenceActivity && existsSync(referenceActivity)) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: join(shots, 'activity-loaded-1440x900.png') });
    const ours = readFileSync(join(shots, 'activity-loaded-1440x900.png')).toString('base64');
    const theirs = readFileSync(referenceActivity).toString('base64');
    const compare = await page.context().newPage();
    await compare.setViewportSize({ width: 1440 + 1000, height: 940 });
    await compare.setContent(`<body style="margin:0;background:rgb(0 0 0);color:rgb(144 144 144);font:12px sans-serif;display:flex;gap:16px;padding:16px">
      <figure style="margin:0"><img src="data:image/png;base64,${ours}" style="width:1440px;display:block;border:1px solid rgb(46 46 46)"><figcaption style="padding-top:6px">INTAFACED /money/activity (local test, mocked data)</figcaption></figure>
      <figure style="margin:0"><img src="data:image/png;base64,${theirs}" style="height:900px;display:block;border:1px solid rgb(46 46 46)"><figcaption style="padding-top:6px">Reference: OKX order centre capture</figcaption></figure></body>`);
    await compare.screenshot({ path: join(shots, 'activity-side-by-side-okx.png') });
    await compare.close();
  }
});

test('activity tabs filter the rows, keep the address in step, and look further back when a tab is thin', async ({ page }) => {
  await simple(page);
  const api = await mock(page);
  await open(page, ALL);
  await expect(page.getByTestId('money-act')).toHaveCount(10);

  await page.getByRole('tab', { name: 'Deposits' }).click();
  await expect(page).toHaveURL(/\/money\/activity\?tab=deposits$/);
  // Page one has two deposit-like rows; the tab asks for the next page on its own to find more.
  await expect(page.getByTestId('money-act')).toHaveCount(3);
  expect(await texts(page.getByTestId('money-act__title'))).toEqual(['Deposit', 'Welcome test funds', 'Deposit']);
  expect(api.calls('activity.list').filter((call) => call.input?.cursor)).toHaveLength(1);

  await page.getByRole('tab', { name: 'Transfers' }).click();
  await expect(page).toHaveURL(/tab=transfers$/);
  expect(await texts(page.getByTestId('money-act__title'))).toEqual([
    'Received from @maya',
    'Sent to @ola',
    'Received',
    'Moved between your accounts',
    'Received from @sam',
  ]);
  await page.getByRole('tab', { name: 'Trades' }).click();
  await expect(page).toHaveURL(/\/money\/activity\?tab=trades$/);
  await expect(page.getByTestId('money-trade-tab').locator('tbody tr')).toHaveCount(2);

  // Back and forward follow the tabs.
  await page.goBack();
  await expect(page.locator('[data-slot="tabs-tab"][data-active]')).toHaveText('Transfers');
});

test('a coin filter with no match in the pages read keeps Load more and does not claim there is none', async ({ page }) => {
  // Six pages of USDT lines; the only BTC line is on the last one. The screen reads the first five (itself, four times back), then stops and asks.
  const line = (id, minutes, asset) => ({
    id,
    kind: 'transfer_in',
    direction: 'in',
    asset,
    amount: '5',
    postedAt: new Date(Date.UTC(2026, 9, 14, 12) - minutes * 60_000).toISOString(),
    txId: `tx-${id}`,
    counterparty: null,
    spaceName: null,
  });
  const pageOf = (n) => ({
    items: Array.from({ length: 5 }, (_, index) => line(`p${n}-${index}`, n * 10 + index, n === 6 && index === 4 ? 'BTC' : 'USDT')),
    nextCursor: n === 6 ? null : `cursor-${n + 1}`,
  });
  const api = await mock(page, {
    bank: { 'activity.list': (input) => pageOf(input?.cursor ? Number(input.cursor.split('-')[1]) : 1) },
  });
  await open(page, '/money/activity?tab=all&asset=BTC');
  const block = page.locator('[data-slot="state-block"][data-kind="empty"]');
  await expect(block).toContainText('No BTC activity in the latest items');
  await expect(block).toContainText('Load more to look further back.');
  await expect(block).not.toContainText('No activity yet');
  await expect(block.locator('a')).toHaveCount(0);
  const more = page.getByRole('button', { name: 'Load more' });
  await expect(more).toBeVisible();
  expect(api.calls('activity.list').filter((call) => call.input?.cursor)).toHaveLength(4);
  // Pressing it reaches the older page, where the BTC line is.
  await more.click();
  await expect(page.getByTestId('money-act')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  await expect(block).toHaveCount(0);
  // The Deposits tab, with no coin, is the same: thin tabs keep asking instead of claiming "No deposits yet".
  await open(page, '/money/activity?tab=deposits');
  await expect(page.locator('[data-slot="state-block"][data-kind="empty"]')).toContainText('No deposits in the latest items');
  await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();
});

test('Trades with a coin filter and a full page of other fills says "latest 100", keeps the note, and does not say none', async ({
  page,
}) => {
  const fill = (index) => ({
    id: `x${index}`,
    order: `order-x${index}`,
    timestamp: Date.UTC(2026, 9, 14, 8) - index * 60_000,
    datetime: new Date(Date.UTC(2026, 9, 14, 8) - index * 60_000).toISOString(),
    symbol: 'ETH/USDT',
    type: 'market',
    side: 'buy',
    takerOrMaker: 'taker',
    price: '2600.00',
    amount: '0.5',
    cost: '1300.000000',
    fee: { cost: '0.00050000', currency: 'ETH', rate: '0.001' },
  });
  await mock(page, { rest: { 'account/trades': () => Array.from({ length: 100 }, (_, index) => fill(index + 1)) } });
  await open(page, '/money/activity?tab=trades&asset=BTC');
  const block = page.locator('[data-slot="state-block"][data-kind="empty"]');
  await expect(block).toContainText('No BTC trades in your latest 100');
  await expect(block).not.toContainText('No trades yet');
  await expect(page.getByTestId('money-act-note')).toHaveText('Showing your latest 100 trades.');
});

test('activity empty: a way forward', async ({ page }) => {
  await mock(page, { bank: { 'activity.list': () => ({ items: [], nextCursor: null }) } });
  await open(page, ALL);
  const block = page.locator('[data-slot="state-block"][data-kind="empty"]');
  await expect(block).toContainText('No activity yet');
  await expect(block).toContainText('When you receive, send or trade, it shows up here.');
  await expect(block.locator('a')).toHaveText('Buy crypto');
  await shootBoth(page, 'activity-empty');
});

test('Trades with no trades says so, and Orders with no orders says so', async ({ page }) => {
  await simple(page);
  await mock(page, { rest: { 'account/trades': () => [], 'orders/open': () => [], 'orders/closed': () => [] } });
  await open(page, '/money/activity?tab=trades');
  await expect(page.locator('[data-slot="state-block"][data-kind="empty"]')).toContainText('No trades yet');
  await open(page, '/money/activity?tab=orders');
  const blocks = page.locator('[data-slot="state-block"][data-kind="empty"]');
  await expect(blocks).toHaveCount(2);
  expect(await texts(blocks)).toEqual(['No open orders.', 'No past orders.']);
});

test('a tab with nothing of its kind says so without a button', async ({ page }) => {
  await mock(page, {
    bank: { 'activity.list': () => ({ items: activityPage1().items.filter((item) => item.kind === 'deposit'), nextCursor: null }) },
  });
  await open(page, '/money/activity?tab=transfers');
  const block = page.locator('[data-slot="state-block"][data-kind="empty"]');
  await expect(block).toContainText('No transfers yet');
  await expect(block.locator('a')).toHaveCount(0);
});

test('activity error: inside the page with Try again; refusal in plain words', async ({ page }) => {
  let fail = true;
  await mock(page, { bank: { 'activity.list': () => (fail ? { status: 500, json: { error: 'x' } } : activityPage1()) } });
  await open(page, ALL);
  const block = page.locator('[data-slot="state-block"][data-kind="error"]');
  await expect(block).toContainText('Couldn’t load your activity.');
  await shootBoth(page, 'activity-error');
  fail = false;
  await block.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('money-act')).toHaveCount(10);
});

test('activity refused: words and a reference, never the raw code', async ({ page }) => {
  await mock(page, { bank: { 'activity.list': paused } });
  await open(page, ALL);
  const block = page.locator('[data-slot="state-block"][data-kind="refused"]');
  await expect(block).toContainText('Paused for account checks');
  await expect(block).toContainText('Ref SCR-1');
  expect(await page.getByTestId('if-money').innerText()).not.toMatch(forbidden);
  await shootBoth(page, 'activity-refused');
});

test('activity loading shows 8 final-size skeleton rows; a failed "load more" keeps the rows', async ({ page }) => {
  const api = await mock(page, { bank: { 'activity.list': null } });
  await open(page, ALL);
  expect(await page.getByTestId('money-act-skeleton__row').count()).toBe(8);
  expect(Math.round((await page.getByTestId('money-act-skeleton__row').first().boundingBox()).height)).toBe(56);
  await shootBoth(page, 'activity-loading');
  await api.release();
  await expect(page.getByTestId('money-act')).toHaveCount(10);
});

test('a failed "load more" keeps what is on screen and offers to try again', async ({ page }) => {
  let second = 'fail';
  await mock(page, {
    bank: {
      'activity.list': (input) =>
        input?.cursor ? (second === 'fail' ? { status: 500, json: { error: 'x' } } : activityPage2()) : activityPage1(),
    },
  });
  await open(page, ALL);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByTestId('money-more__note')).toHaveText('Couldn’t load more.');
  await expect(page.getByTestId('money-act')).toHaveCount(10);
  second = 'ok';
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('money-act')).toHaveCount(13);
});

test('activity detail: a private note is saved once and shows as saved', async ({ page }) => {
  let attempts = 0;
  const api = await mock(page, {
    bank: {
      'activity.note.set': (input) => {
        attempts += 1;
        return { activityId: input.id, text: input.text, updatedAt: '2026-10-20T02:00:00.000Z' };
      },
    },
  });
  await open(page, '/money/activity/a6');
  const field = page.getByLabel('Your note');
  const save = page.getByRole('button', { name: 'Add a note' });
  await expect(save).toBeDisabled();
  await field.fill('Rent top-up');
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Note saved' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save note' })).toBeDisabled();
  const sent = api.calls('activity.note.set');
  expect(sent).toHaveLength(1);
  expect(sent[0].input).toMatchObject({ id: 'a6', text: 'Rent top-up' });
  expect(sent[0].input.commandId).toMatch(/^note-/);
  expect(attempts).toBe(1);
});

test('activity detail: a note with only spaces cannot be sent', async ({ page }) => {
  const api = await mock(page, {});
  await open(page, '/money/activity/a6');
  await page.getByLabel('Your note').fill('   ');
  await expect(page.getByRole('button', { name: 'Add a note' })).toBeDisabled();
  expect(api.calls('activity.note.set')).toHaveLength(0);
});

test('activity: a signed statement for a finished month downloads and shows its fingerprint', async ({ page }) => {
  const api = await mock(page, {
    bank: {
      'statements.export': (input) => ({
        format: input.format,
        filename: `intafaced-statement-${input.from.slice(0, 7)}.pdf`,
        contentType: 'application/pdf',
        bodyBase64: Buffer.from('%PDF-test').toString('base64'),
        sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        signature: 'sig',
        rowCount: 3,
        generatedAt: '2026-10-20T02:00:00.000Z',
        proof: {},
      }),
    },
  });
  await open(page, '/money/activity');
  const panel = page.getByRole('form', { name: 'Statement' });
  await expect(panel).toBeVisible();
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download statement' }).click();
  expect((await download).suggestedFilename()).toMatch(/^intafaced-statement-\d{4}-\d{2}\.pdf$/);
  await expect(panel.getByRole('status')).toContainText('3 lines');
  await expect(panel.getByRole('status')).toContainText('abcd ef01 2345');
  const sent = api.calls('statements.export');
  expect(sent).toHaveLength(1);
  expect(sent[0].input.from).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  expect(sent[0].input.to).toMatch(/T23:59:59\.999Z$/);
  expect(sent[0].input.format).toBe('pdf');
});

test('activity: this month is not offered as a statement', async ({ page }) => {
  await mock(page, {});
  await open(page, '/money/activity');
  const panel = page.getByRole('form', { name: 'Statement' });
  const now = new Date();
  await panel.getByLabel('Month').fill(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`);
  await expect(panel.getByRole('button', { name: 'Download statement' })).toBeDisabled();
  await expect(panel.getByRole('status')).toContainText('over');
});

test('activity: hide balances masks the amounts; no horizontal scroll at narrow widths', async ({ page }) => {
  await mock(page);
  await open(page, ALL);
  await expect(page.getByTestId('money-act')).toHaveCount(10);
  await page.evaluate(() => localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ hideBalances: true })));
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1024, height: 800 },
    { width: 768, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await open(page, ALL);
    await expect(page.getByTestId('money-act')).toHaveCount(10);
    expect([...new Set(await texts(page.getByTestId('money-act').locator('[data-slot="amount"]')))]).toEqual(['••••']);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="if-money"] *')]
        .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 4)
        .map((node) => node.className || node.tagName),
    );
    expect(overflow, `${size.width}px, too wide: ${wide.join(' | ')}`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: join(shots, `activity-${size.width}x${size.height}.png`) });
  }
  // At 390 px the tab row scrolls on its own, and a link to the last tab opens with that tab in view.
  await open(page, '/money/activity?tab=ledger');
  const active = page.locator('[data-slot="tabs-tab"][data-active]');
  await expect(active).toHaveText('Entries');
  const [tabBox, rowBox] = [await active.boundingBox(), await page.getByTestId('money-tabs').boundingBox()];
  // Within a pixel: the row scrolls by whole pixels and the tab edge can sit a fraction past it.
  expect(tabBox.x).toBeGreaterThanOrEqual(rowBox.x - 1);
  expect(tabBox.x + tabBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  // The Trades and Orders tabs do not scroll sideways either.
  for (const tab of ['/money/activity?tab=trades', '/money/activity?tab=orders']) {
    await open(page, tab);
    await expect(page.getByTestId('money-trade-tab').locator('table').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, tab).toBeLessThanOrEqual(0);
  }
});
