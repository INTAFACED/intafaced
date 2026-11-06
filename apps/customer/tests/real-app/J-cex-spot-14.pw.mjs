import { test, expect } from './journey.mjs';
import { EDGE, api, bestPrices, fund, journeyState, toUnits } from './stack.mjs';
import { deskPath, fundedTrader, held, openDesk, openOrders, placements, signIn } from './desk.mjs';

// J-cex-spot-14, in the running app (docs/roadmap/journeys.json): a pro trader knows whether a market is open, limited,
// closing, new or risky before trading it, and never sends an order into a state that refuses it without being told
// why first. One test per step, titled "J-cex-spot-14 #<n>", run in order on one TEST account funded with TEST USDC
// through the real ledger. Operators set a market's trading mode through svc-trade's two-person door
// (`setMarketMode`, two TEST operators), as TEST changes on books only this file holds in a restricted mode, each put
// back to Open in the same step. Money: none moves; a refusal in any state leaves no hold, and cancels always work.
const J = 'J-cex-spot-14';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** #3 holds this book limit-only for the step, #4 holds it cancel-only. */
const LIMITED = 'BTC/USDC';
/** A room or label a step needs that is not built answers within this, so an unbuilt step fails fast. */
const UNBUILT_MS = 8_000;

test.describe.configure({ mode: 'default' });

let gates;
let operators;
/** The stack's two TEST operators, signed in once for the file. */
async function ops() {
  gates ??= await import('../../../../tooling/scripts/local-test-gates.mjs');
  if (!operators) {
    const ctx = await gates.makeContext({ log: () => undefined });
    operators = { ctx, sessions: await gates.approverSessions(ctx) };
  }
  return operators;
}

/** Hold `symbol` in `mode` (two TEST operators) while `body` runs, then always put it back to Open. */
async function inMode(symbol, mode, body) {
  const { ctx, sessions } = await ops();
  let changed = false;
  let failed = null;
  try {
    const set = await gates.setMarketMode(ctx, symbol, mode, { sessions, reason: `${J}: TEST ${mode} for one step` });
    changed = true;
    expect(set.mode).toBe(mode);
    await body();
  } catch (err) {
    failed = err;
  }
  // Always try to reopen: the change may have gone through even if the tool then failed. The step's own failure is
  // the one reported; a failed reopen is added to it, never put in its place.
  try {
    await gates.setMarketMode(ctx, symbol, 'OPEN', { sessions, reason: `${J}: TEST back to Open after the step` });
  } catch (err) {
    if (failed) throw new AggregateError([failed, err], `${J}: the step failed, and ${symbol} could not be put back to Open`);
    if (changed) throw err;
  }
  if (failed) throw failed;
}

/** The journey's account, made on first use: verified, funded with TEST 2000 USDC through the real ledger. */
async function account(page) {
  const known = run.read().account;
  if (known) return known;
  const who = await fundedTrader(page, 'j14', '10');
  expect(fund(who.email, 'USDC', '2000').tx).toBeTruthy();
  run.write({ account: who });
  return who;
}

/** The market's lifecycle state as the public read reports it. */
async function publicState(symbol) {
  const res = await fetch(`${EDGE}/api/v1/market-lifecycle/${encodeURIComponent(symbol)}`);
  const body = await res.json();
  return body?.state ?? body?.snapshot?.state ?? null;
}

/** A whole-unit USDC price `percent` of the best bid: inside the book's band, far enough under it to rest. */
async function restingBid(symbol, percent) {
  const { bid } = await bestPrices(symbol);
  const one = toUnits('1');
  const units = ((toUnits(bid) * BigInt(percent)) / 100n / one) * one;
  return (units / one).toString();
}

const orderSends = (sent) => sent.filter((body) => body?.symbol === LIMITED || body?.symbol === undefined);

test(`${J} #1 the markets list shows open, upcoming and delisting markets with listing status and dated delisting; only open real markets are tradeable`, async ({
  page,
}) => {
  await page.goto('/trade');
  const list = page.getByRole('table').first();
  await expect(list).toBeVisible();
  // Every row says its listing status in words.
  const rows = list.getByRole('row');
  await expect(rows.first()).toBeVisible();
  await expect(list.getByText(/^Upcoming$/).first()).toBeVisible({ timeout: UNBUILT_MS });
  const delisting = list.getByRole('row').filter({ hasText: /Delisting/ });
  await expect(delisting.first()).toBeVisible({ timeout: UNBUILT_MS });
  // The delisting is dated.
  await expect(delisting.first()).toContainText(/\d{1,2} [A-Z][a-z]{2}|[A-Z][a-z]{2} \d{1,2}/, { timeout: UNBUILT_MS });
});

test(`${J} #2 /status shows each market's trading mode and the platform status, with the time they are as of`, async ({ page }) => {
  await page.goto('/status');
  await expect(page.getByRole('heading', { name: 'Platform status' })).toBeVisible();
  // Platform status: the founders' components, or the honest line that none is published.
  await expect(page.getByTestId('status-components').first()).toBeVisible();
  // Trading modes per market, each with its effect, from the same lifecycle read the desk uses.
  await expect(page.getByRole('heading', { name: 'Trading modes' })).toBeVisible();
  const btc = page.getByTestId('status-mode-BTC/USDT');
  await expect(btc).toContainText('Open');
  await expect(btc).toContainText('Orders are accepted and can be cancelled.');
  expect(await publicState('BTC/USDT')).toBe('OPEN');
  // The as-of time is the service's own observation time, in UTC.
  await expect(page.getByTestId('status-modes-asof')).toHaveText(/^As of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
});

test(`${J} #3 a market order on a limit-only market is refused as limit-only, and a limit inside the band is accepted`, async ({
  page,
}) => {
  const who = await account(page);
  const client = await api(who);
  const price = await restingBid(LIMITED, 98);
  await inMode(LIMITED, 'LIMIT_ONLY', async () => {
    expect(await publicState(LIMITED)).toBe('LIMIT_ONLY');
    // /status names the mode and its effect.
    await page.goto('/status');
    const row = page.getByTestId(`status-mode-${LIMITED}`);
    await expect(row).toContainText('Limit-only');
    await expect(row).toContainText('Market orders are refused.');

    await openDesk(page, who, LIMITED);
    await expect(page.getByTestId('dk-ticker')).toContainText('Limit only');
    const before = held(await client.balances(), 'USDC');
    const sent = placements(page);
    // A market buy: the desk's own preview says why before Confirm, and nothing is sent or held.
    await page.locator('[role=tab]', { hasText: /^Market$/ }).click();
    await page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001');
    const form = page.locator('form[data-testid="dk-form"][data-side="buy"]');
    await expect(form).toContainText('Market orders are paused here');
    await expect(form).toContainText('Place a limit order instead');
    await expect(form).not.toContainText(/[a-z]+\.[a-z_]+_[a-z_]+/); // no raw code
    await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
    await page.waitForTimeout(1000);
    expect(orderSends(sent)).toHaveLength(0);
    // The door itself refuses the same order with the typed code, before any hold.
    const market = await client.post('/api/v1/orders', {
      symbol: LIMITED,
      side: 'buy',
      type: 'market',
      amount: '0.001',
      clientOrderId: `${J}-3m-${who.handle}`,
    });
    expect(market.status).toBe(400);
    expect(JSON.stringify(market.body)).toContain('trade.mode_limit_only');
    expect(held(await client.balances(), 'USDC')).toBe(before);

    // A limit buy inside the band is accepted and rests, holding exactly its price x amount.
    const limit = await client.post('/api/v1/orders', {
      symbol: LIMITED,
      side: 'buy',
      type: 'limit',
      amount: '0.001',
      price,
      clientOrderId: `${J}-3-${who.handle}`,
    });
    expect(limit.status, JSON.stringify(limit.body).slice(0, 300)).toBeLessThan(300);
    const resting = (await openOrders(who, LIMITED)).find((o) => o.id === limit.body.id);
    expect(resting).toBeTruthy();
    expect(held(await client.balances(), 'USDC') - before).toBe((toUnits(price) * toUnits('0.001')) / toUnits('1'));
    run.write({ ...run.read(), resting: limit.body.id, price });
  });
});

test(`${J} #4 a new order on a cancel-only market is refused, and cancel works`, async ({ page }) => {
  const who = await account(page);
  const client = await api(who);
  const restingId = run.read().resting;
  if (!restingId) throw new Error(`${J} #3 left no resting order, so this step has nothing to cancel`);
  const price = run.read().price;
  await inMode(LIMITED, 'CANCEL_ONLY', async () => {
    expect(await publicState(LIMITED)).toBe('CANCEL_ONLY');
    await page.goto('/status');
    await expect(page.getByTestId(`status-mode-${LIMITED}`)).toContainText('Cancel-only');

    await openDesk(page, who, LIMITED);
    await expect(page.getByTestId('dk-ticker')).toContainText('Cancel only, no new orders on this desk');
    const before = held(await client.balances(), 'USDC');
    const sent = placements(page);
    // A new limit buy: refused in words before Confirm; nothing is sent and nothing more is held.
    await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
    await page.getByRole('textbox', { name: 'Price' }).first().fill(price);
    await page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001');
    const form = page.locator('form[data-testid="dk-form"][data-side="buy"]');
    await expect(form).toContainText('This market is cancel-only');
    await expect(form).toContainText('you can still cancel them');
    await expect(form).not.toContainText(/[a-z]+\.[a-z_]+_[a-z_]+/);
    await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
    await page.waitForTimeout(1000);
    expect(orderSends(sent)).toHaveLength(0);
    const refused = await client.post('/api/v1/orders', {
      symbol: LIMITED,
      side: 'buy',
      type: 'limit',
      amount: '0.001',
      price,
      clientOrderId: `${J}-4-${who.handle}`,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain('trade.mode_cancel_only');
    expect(held(await client.balances(), 'USDC')).toBe(before);

    // Cancel works: the resting order from #3 comes off the book and its hold is released once.
    const cancel = await client.delete(`/api/v1/orders/${encodeURIComponent(restingId)}`);
    expect(cancel.status, JSON.stringify(cancel.body).slice(0, 300)).toBeLessThan(300);
    await expect.poll(async () => (await openOrders(who, LIMITED)).map((o) => o.id)).not.toContain(restingId);
    expect(held(await client.balances(), 'USDC')).toBe(0n);
  });
});

test(`${J} #5 a market with scheduled maintenance an hour away says "Maintenance in 1 hour" on the ticket and flags it on the list; no end time reads "End time not set"`, async ({
  page,
}) => {
  const who = await account(page);
  await openDesk(page, who, LIMITED);
  // The maintenance flag on the ticket comes from the lifecycle read's `upcomingMaintenance` (SP-developer-status-01).
  const res = await fetch(`${EDGE}/api/v1/market-lifecycle/${encodeURIComponent(LIMITED)}`);
  expect(Object.keys(await res.json())).toContain('upcomingMaintenance');
  await expect(page.getByTestId('dk-ticker')).toContainText('Maintenance in 1 hour', { timeout: UNBUILT_MS });
  await page.goto('/trade');
  await expect(
    page
      .getByRole('table')
      .first()
      .getByText(/Maintenance/)
      .first(),
  ).toBeVisible({ timeout: UNBUILT_MS });
  await page.goto('/status');
  await expect(page.getByText('End time not set').first()).toBeVisible({ timeout: UNBUILT_MS });
});

test(`${J} #6 an order while the market session is closed: the closed-market rule is applied and explained`, async ({ page }) => {
  const who = await account(page);
  const client = await api(who);
  // A session market (commodities keep exchange hours). When its session is shut the list reads "Closed, opens at" and an
  // order refuses `trade.market_closed`, with no order stored and nothing held.
  const markets = await (await fetch(`${EDGE}/api/v1/markets?limit=500`)).json();
  const shut = markets.find((m) => m.sessionOpen === false && m.lifecycle && m.lifecycle.state !== 'REFUSED');
  expect(shut, 'a session market with a published lifecycle whose session is shut now').toBeTruthy();
  await page.goto('/trade');
  await expect(page.getByRole('table').first().getByRole('row').filter({ hasText: shut.base })).toContainText(/Closed.*Opens/, {
    timeout: UNBUILT_MS,
  });
  const before = await client.balances();
  const res = await client.post('/api/v1/orders', { symbol: shut.symbol, side: 'buy', type: 'limit', amount: '1', price: '1' });
  expect(JSON.stringify(res.body)).toContain('trade.market_closed');
  expect(await client.balances()).toEqual(before);
  await signIn(page, who);
  await page.goto(deskPath(shut.symbol));
  await expect(page.getByText(/Orders are not queued while it is closed/)).toBeVisible({ timeout: UNBUILT_MS });
});

test(`${J} #7 a market inside its opening window or the higher-risk zone shows a badge; a market order is refused with the window reason and a limit is accepted`, async ({
  page,
}) => {
  const markets = await (await fetch(`${EDGE}/api/v1/markets?limit=500`)).json();
  const windowed = markets.find((m) => m.listing?.openingWindowEndsAt || m.listing?.zone);
  expect(windowed, 'a market inside its opening window or in the higher-risk zone').toBeTruthy();
  const who = await account(page);
  await openDesk(page, who, windowed.symbol);
  await expect(page.getByTestId('dk-ticker')).toContainText(/Opening window|Higher-risk zone/, { timeout: UNBUILT_MS });
  const client = await api(who);
  const res = await client.post('/api/v1/orders', { symbol: windowed.symbol, side: 'buy', type: 'market', amount: '0.001' });
  expect(JSON.stringify(res.body)).toContain('trade.opening_window');
});

test(`${J} #8 public depth, tickers, candles and spreads: a snapshot then ordered updates, and a reconnect resumes from the last sequence`, async () => {
  const tickers = await (await fetch(`${EDGE}/api/v1/tickers`)).json();
  const btc = Object.values(tickers).find((t) => t?.symbol === 'BTC/USDT');
  expect(btc?.spread, 'the ticker carries a spread field').toBeTruthy();
  const spreads = await fetch(`${EDGE}/api/v1/spreads`);
  expect(spreads.status).toBe(200);
  const candles = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent('BTC/USDT')}?timeframe=1m&limit=5`);
  expect(candles.status).toBe(200);
});

test(`${J} #9 /trade/analytics/:pair shows the aggressor differential and window stats with the window named; a blank window refuses`, async ({
  page,
}) => {
  const who = await account(page);
  await signIn(page, who);
  await page.goto('/trade/analytics/BTC-USDT');
  // The figures are the service's own read of the public tape for the named window.
  const read = await (await fetch(`${EDGE}/api/v1/analytics/${encodeURIComponent('BTC/USDT')}?window=1h`)).json();
  expect(read).toMatchObject({ symbol: 'BTC/USDT', window: '1h' });
  expect(toUnits(read.aggressorDifferential)).toBe(toUnits(read.buyVolume) - toUnits(read.sellVolume));
  await expect(page.getByTestId('analytics-differential')).toContainText('Aggressor differential');
  await expect(page.getByTestId('analytics-trades')).toContainText('Trades');
  await expect(page.getByTestId('analytics-window')).toContainText(
    /^Window: Last 1 hour, \d{4}-\d{2}-\d{2} \d{2}:\d{2} to \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/,
  );
  // Another named window is read again and named.
  await page.getByTestId('analytics-windows').getByRole('button', { name: 'Last 24 hours' }).click();
  await expect(page.getByTestId('analytics-window')).toContainText('Window: Last 24 hours');
  // A blank window refuses with its typed code; it never falls back to a window of its own.
  const blank = await fetch(`${EDGE}/api/v1/analytics/${encodeURIComponent('BTC/USDT')}`);
  expect(blank.status).toBe(400);
  expect(JSON.stringify(await blank.json())).toContain('trade.analytics_window_unset');
});

test(`${J} #10 a USD-quoted pair and an equity-class market: the quote label reads USD`, async ({ page }) => {
  const who = await account(page);
  // A USD-quoted pair the service lists: its desk names the quote USD, from the listing, not from a stand-in.
  const markets = await (await fetch(`${EDGE}/api/v1/markets?limit=500`)).json();
  const usd = markets.find((m) => m.quote === 'USD' && m.spot && !m.paper);
  expect(usd, 'a USD-quoted spot pair on the list').toBeTruthy();
  await signIn(page, who);
  await page.goto(deskPath(usd.symbol));
  await expect(page.getByTestId('dk-pair')).toHaveText(`${usd.base}/USD`);
  // The equity class is not listed without a licence: the markets page names it, with its blocker, and lists no row.
  expect(markets.filter((m) => m.assetClass === 'equity')).toHaveLength(0);
  await page.goto('/trade');
  await expect(page.getByTestId('mkt-not-offered-equity')).toContainText('Tokenized equities');
  await expect(page.getByTestId('mkt-not-offered-equity')).toContainText('Not available: licence not named');
});

test(`${J} #11 the retail price improvement layer reads "Not available: priority class not specified", and no order accepts that flag`, async ({
  page,
}) => {
  const who = await account(page);
  const client = await api(who);
  await page.goto('/trade');
  await expect(page.getByTestId('mkt-not-offered-rpi')).toContainText('Not available: priority class not specified');
  await openDesk(page, who, 'BTC/USDT');
  await expect(page.getByTestId('dk-ticker')).toContainText('Retail price improvement');
  await expect(page.getByTestId('dk-ticker')).toContainText('Not available: priority class not specified');
  // An order that asks for the layer is refused with its typed code, before any hold, and is not stored.
  const before = await client.balances();
  const clientOrderId = `${J}-11-${who.handle}`;
  const res = await client.post('/api/v1/orders', {
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'limit',
    amount: '0.0001',
    price: '1',
    rpi: true,
    clientOrderId,
  });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toContain('trade.rpi_unavailable');
  expect(await client.balances()).toEqual(before);
  expect((await openOrders(who)).filter((o) => o.clientOrderId === clientOrderId)).toHaveLength(0);
});
