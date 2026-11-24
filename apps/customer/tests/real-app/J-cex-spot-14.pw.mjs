import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, api, bestPrices, fund, journeyState, toUnits } from './stack.mjs';
import { deskPath, fundedTrader, held, openDesk, openOrders, placements, signIn } from './desk.mjs';
import { cancelMaintenance, draftNotice, publishNotice } from './notices.mjs';
import { testVenue, tradePayloadHash, venueForThisFile, venueInfo } from './venue.mjs';
import { utcMinuteOf } from './clock.mjs';

// J-cex-spot-14, in the running app (docs/roadmap/journeys.json): a pro trader knows whether a market is open, limited,
// closing, new or risky before trading it, and never sends an order into a state that refuses it without being told
// why first. One test per step, titled "J-cex-spot-14 #<n>", run in order on one TEST account funded with TEST USDC
// through the real ledger. Operators set a market's trading mode through svc-trade's two-person door
// (`setMarketMode`, two TEST operators), as TEST changes on books only this file holds in a restricted mode, each put
// back to Open in the same step. Money: none moves; a refusal in any state leaves no hold, and cancels always work.
// World: book, gates, restart
// (book: limit orders rest and cancel on BTC/USDC; gates: a market's trading mode is set and put back to Open; restart:
// #1 and #2 switch svc-trade's venue door on, and it is switched off again before #3.)
const J = 'J-cex-spot-14';
/** The status component a maintenance notice names one market by (`market-btc-usdc`), as svc-notify reads it. */
const marketComponent = (symbol) => `market-${symbol.toLowerCase().replace('/', '-')}`;
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

// ── #1 and #2 on the stack's outside TEST venue ──
//
// At launch the markets list and /status read the venue, never our own book: each market INTAFACED shows on the venue,
// in the venue's own state, with our listing beside it (svc-trade's public `GET /api/v1/venue/market-states`). The door
// is on for these two steps only (the steps after them still trade our own book). Each attempt adds its own fresh TEST
// markets to the TEST venue (`/test/market-add`, a random TEST symbol per attempt) and two operators list them through
// svc-trade's two-person door: one open, one opening tomorrow, one open and delisting in two days, and one the venue
// itself takes cancels only on. No other journey's market is touched. Every figure is TEST.

const LISTING_SET = 'trade.venue_listing_set';
const DELISTING = 'trade.venue_delisting_schedule';
const POLICY = 'trade-venue-markets-v1';
const DAY = 86_400_000;

const trpcData = (res) => res.json?.result?.data?.json ?? res.json?.result?.data;

/** A fresh TEST spot market on the TEST venue, trading. */
async function freshMarket(tag) {
  const base = `T14${tag}${randomBytes(3).toString('hex').toUpperCase()}`;
  const symbol = `${base}-USDC`;
  const added = await testVenue('/test/market-add', {
    symbol,
    baseAsset: base,
    quoteAsset: 'USDC',
    maxOrderQty: '10',
    maxOrderNotional: '1000',
  });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  return { symbol, base, quote: 'USDC' };
}

/** Setup, not a step: two operators write one change on `symbol`'s listing line through svc-trade's two-person door. */
async function listingWrite(symbol, actionType, procedure, fields, expectedVersion) {
  const { ctx, sessions } = await ops();
  const venueId = (await venueInfo()).id;
  const reason = `LOCAL TEST ${J}: ${actionType} on ${symbol} for this step`;
  const ids = await gates.twoPerson(ctx, sessions, {
    actionType,
    targetService: 'svc-trade',
    targetId: `venue-listing:${venueId}:${symbol}`,
    expectedVersion,
    payloadHash: tradePayloadHash({ actionType, venueId, symbol, ...fields, expectedVersion, reason }),
    policyVersion: POLICY,
  });
  const res = await ctx.edge.mutate(
    'trade',
    procedure,
    { symbol, ...fields, expectedVersion, reason, ...ids },
    await sessions.a.tradeOpsToken(),
  );
  expect(trpcData(res)?.listing?.version, res.text.slice(0, 300)).toBe(Number(expectedVersion) + 1);
}
const list = (symbol, opensAt) => listingWrite(symbol, LISTING_SET, 'admin.venueMarkets.listingSet', { opensAt }, '0');
const delist = (symbol, delistsAt) => listingWrite(symbol, DELISTING, 'admin.venueMarkets.delistingSchedule', { delistsAt }, '1');

/** This attempt's four markets, made once per attempt and kept for #2. */
async function venueMarkets() {
  const known = run.read().venueMarkets;
  if (known) return known;
  const now = Date.now();
  const open = await freshMarket('O');
  const upcoming = await freshMarket('U');
  const delisting = await freshMarket('D');
  const cancelOnly = await freshMarket('C');
  const minuteAgo = new Date(now - 60_000).toISOString();
  await list(open.symbol, minuteAgo);
  await list(upcoming.symbol, new Date(now + DAY).toISOString());
  await list(delisting.symbol, minuteAgo);
  await delist(delisting.symbol, new Date(now + 2 * DAY).toISOString());
  await list(cancelOnly.symbol, minuteAgo);
  // The venue's own state, not ours: the TEST venue takes cancels only on this market.
  expect((await testVenue('/test/market-status', { symbol: cancelOnly.symbol, status: 'cancel_only' })).status).toBe(200);
  const markets = { open, upcoming, delisting, cancelOnly };
  run.write({ ...run.read(), venueMarkets: markets });
  return markets;
}

/** svc-trade's public read of the venue's market states, signed out. */
async function marketStates() {
  const res = await fetch(`${EDGE}/api/v1/venue/market-states`);
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}

/**
 * The trading mode a market is in now, from the read's own fields, the stricter first: our stop, delisting or opening
 * time; then the venue's own state; then our close-only routing. `none` where the venue reports no state.
 */
function modeOf(m) {
  if (m.listing.delisted || m.status === 'delisted') return 'DELISTING';
  if (m.listing.routing === 'stop') return 'HALTED';
  if (!m.listing.open) return 'PRELAUNCH';
  if (m.status === null) return 'none';
  if (m.status === 'halted') return 'HALTED';
  if (m.status === 'cancel_only') return 'CANCEL_ONLY';
  if (m.listing.routing === 'close_only') return 'REDUCE_ONLY';
  return 'OPEN';
}
/** Only an open market with no delisting set, in mode Open, is a tradeable row. */
const tradeable = (m) => modeOf(m) === 'OPEN' && m.listing.delistsAt === null;

test.describe('on the outside TEST venue', () => {
  venueForThisFile(test);

  test(`${J} #1 the markets list shows open, upcoming and delisting markets with listing status and dated delisting; only open real markets are tradeable`, async ({
    page,
    stepPicture,
  }) => {
    const mine = await venueMarkets();
    // The venue read the list draws: each of this attempt's markets with the venue's state and our listing beside it.
    const states = await marketStates();
    expect(states.value.test, 'the TEST venue').toBe(true);
    const bySymbol = new Map(states.value.markets.map((m) => [m.symbol, m]));
    const read = (x) => bySymbol.get(x.symbol);
    expect(read(mine.open), 'the open market on the venue read').toMatchObject({
      status: 'trading',
      listing: { open: true, delistsAt: null },
    });
    expect(read(mine.upcoming)?.listing.open, 'the upcoming market has not opened').toBe(false);
    expect(Date.parse(read(mine.delisting)?.listing.delistsAt ?? ''), 'the delisting carries its date').toBeGreaterThan(Date.now());
    expect(read(mine.cancelOnly)?.status, "the venue's own state").toBe('cancel_only');

    // Signed out, as anyone opens it.
    await page.goto('/trade');
    const grid = page.getByRole('grid', { name: 'Markets', exact: true });
    await expect(grid).toBeVisible();
    const more = page.getByRole('button', { name: /^Show \d+ more markets$/ });
    const pair = (x) => new RegExp(`^${x.base}/${x.quote}$`);
    const rowOf = (x) => grid.getByRole('row').filter({ has: page.getByTestId('mkt-name__ticker').filter({ hasText: pair(x) }) });
    const action = (row) => row.getByRole('button', { name: /^(Trade|Buy) / });
    // This attempt's markets are on the read the page makes on opening: wait for the list's rows, then open the whole list.
    await expect(
      grid
        .getByRole('row')
        .filter({ has: page.getByTestId('mkt-name__ticker') })
        .first(),
    ).toBeVisible();
    while (await more.isVisible()) await more.click();
    await expect(rowOf(mine.open)).toHaveCount(1);

    // The open market's row trades, and links to its venue desk.
    await expect(action(rowOf(mine.open))).toBeEnabled();
    await expect(action(rowOf(mine.open))).toHaveAttribute('href', /\/trade\/|\/coin\//);
    await expect(rowOf(mine.open).getByTestId('mkt-listing')).toHaveCount(0);
    // The upcoming listing: named Upcoming, and not a tradeable row.
    await expect(rowOf(mine.upcoming).getByTestId('mkt-listing')).toHaveText('Upcoming', { timeout: UNBUILT_MS });
    await expect(action(rowOf(mine.upcoming))).toBeDisabled();
    // The delisting: named Delisting, with the day its own delistsAt falls on in the person's zone, and not a tradeable row.
    const leaves = (iso) =>
      page.evaluate(
        (at) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(Date.parse(at)),
        iso,
      );
    const downRow = rowOf(mine.delisting);
    await expect(downRow.getByTestId('mkt-listing')).toContainText('Delisting');
    await expect(downRow.getByTestId('mkt-listing')).toContainText(
      `Leaves the board on ${await leaves(read(mine.delisting).listing.delistsAt)}`,
    );
    await expect(action(downRow)).toBeDisabled();
    // The market the venue takes cancels only on is paused, whatever our listing says: the open list does not draw it.
    await expect(rowOf(mine.cancelOnly)).toHaveCount(0);

    // Every row the list draws, not a sample: each against its own market on the venue read. Only an open market in mode
    // Open with no delisting set trades and links to its desk; every other row's action is disabled and links nowhere.
    // Every row is a venue spot market we list: none comes from our own book.
    const spot = states.value.markets.filter((m) => m.kind === 'spot');
    const rows = grid.getByRole('row').filter({ has: page.getByTestId('mkt-name__ticker') });
    const drawn = await rows.count();
    expect(drawn, 'the list draws rows').toBeGreaterThan(0);
    const seen = new Set();
    for (let i = 0; i < drawn; i++) {
      const row = rows.nth(i);
      const name = (await row.getByTestId('mkt-name__ticker').innerText()).trim();
      const m = spot.find((x) => `${x.baseAsset}/${x.quoteAsset}` === name);
      expect(m, `${name} is a venue spot market we list`).toBeTruthy();
      seen.add(m.symbol);
      const button = action(row);
      await expect(button, name).toHaveCount(1);
      const trades = tradeable(m);
      await expect(button, `${name} ${trades ? 'trades' : 'is not a tradeable row'}`).toBeEnabled({ enabled: trades });
      // A tradeable row links to trading it; every other row links nowhere.
      await expect
        .poll(() => button.getAttribute('href'), { message: `${name}'s link` })
        .toEqual(trades ? expect.stringMatching(/\/trade\/|\/coin\//) : null);
    }
    for (const x of [mine.open, mine.upcoming, mine.delisting]) expect(seen.has(x.symbol), `${x.symbol} is drawn`).toBe(true);
    await stepPicture();
    // Activating a row that does not trade opens no desk.
    await rowOf(mine.upcoming).click();
    await expect(page).toHaveURL(/\/trade(\?.*)?$/);
  });

  test(`${J} #2 /status shows each market's trading mode and the platform status, with the time they are as of`, async ({
    page,
    stepPicture,
  }) => {
    const mine = await venueMarkets();
    await page.goto('/status');
    await expect(page.getByRole('heading', { name: 'Platform status', exact: true })).toBeVisible();

    // Platform status: the page draws exactly the components svc-notify's status read publishes (statusPage.read, the read
    // the page itself makes), each by its name and its state, and the overall state the read gives; or, with none defined,
    // the honest line and no overall state. Read again on each poll: the page re-reads every 30 seconds.
    const statusRead = async () => (await (await fetch(`${ORIGIN}/api/notify/trpc/statusPage.read`)).json()).result.data;
    const drawnStatus = async () => {
      const none = await page.getByTestId('status-components-none').count();
      const overall = none ? 'none_defined' : await page.getByTestId('status-overall').getAttribute('data-state');
      const rows = await page.locator('[data-testid^="status-component-"]').evaluateAll((els) =>
        els
          .filter((el) => el.tagName === 'LI')
          .map((el) => ({
            id: el.dataset.testid.slice('status-component-'.length),
            name: el.querySelector('strong')?.textContent ?? '',
            state: el.dataset.state,
          })),
      );
      return { overall, rows };
    };
    const publishedStatus = async () => {
      const read = await statusRead();
      return {
        overall: read.overall,
        rows: read.overall === 'none_defined' ? [] : read.components.map((c) => ({ id: c.id, name: c.name, state: c.state })),
      };
    };
    await expect(page.getByTestId('status-components').first()).toBeVisible();
    await expect
      .poll(async () => JSON.stringify(await drawnStatus()) === JSON.stringify(await publishedStatus()), {
        timeout: 45_000,
        message: 'the page shows the components and overall state svc-notify publishes',
      })
      .toBe(true);
    const published = await publishedStatus();
    if (published.overall === 'none_defined') await expect(page.getByTestId('status-components-none')).toBeVisible();
    else expect(published.rows.length, 'a defined status page has components').toBeGreaterThan(0);

    // Trading modes per market, each with its effect, from the venue's own state with our listing beside it: every market
    // the venue read lists has its row, in the mode its own fields give.
    await expect(page.getByRole('heading', { name: 'Trading modes', exact: true })).toBeVisible();
    const open = page.getByTestId(`status-mode-${mine.open.symbol}`);
    await expect(open).toContainText('Open');
    await expect(open).toContainText('Orders are accepted and can be cancelled.');
    const cancelOnly = page.getByTestId(`status-mode-${mine.cancelOnly.symbol}`);
    await expect(cancelOnly).toContainText('Cancel-only');
    await expect(cancelOnly).toContainText('New orders are refused. You can cancel resting orders.');
    const upcoming = page.getByTestId(`status-mode-${mine.upcoming.symbol}`);
    await expect(upcoming).toHaveAttribute('data-state', 'PRELAUNCH');
    await expect(upcoming).toContainText('The market has not opened. New orders are refused; orders are not queued.');
    const states = await marketStates();
    expect(states.value.markets.length, 'the venue read lists markets').toBeGreaterThan(0);
    for (const m of states.value.markets)
      await expect(page.getByTestId(`status-mode-${m.symbol}`), `${m.symbol}'s mode row`).toHaveAttribute('data-state', modeOf(m));
    await expect(page.locator('[data-testid^="status-mode-"][data-state]')).toHaveCount(states.value.markets.length);

    // The as-of time is the venue read's own time, in UTC, to the minute. The venue read is read before and after the
    // page's line, so the line is one of the two answers, never a time of the page's own.
    const line = page.getByTestId('status-modes-asof');
    await expect(line).toHaveText(/^As of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    const asOfLine = (read) => `As of ${utcMinuteOf(Date.parse(read.asOf)).replace('T', ' ')} UTC`;
    await expect
      .poll(
        async () => {
          const before = asOfLine(await marketStates());
          const shown = (await line.textContent())?.trim();
          const after = asOfLine(await marketStates());
          return shown === before || shown === after;
        },
        { timeout: 75_000, message: "the as-of line is the venue market-states read's own asOf" },
      )
      .toBe(true);
    await stepPicture();
  });
});

test(`${J} #3 a market order on a limit-only market is refused as limit-only, and a limit inside the band is accepted`, async ({
  page,
  stepPicture,
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
    // A market order: the ticket offers no Market tab here; it lists Market, disabled, with the limit-only reason (the
    // desk's order-type list, J-cex-spot-04 #1), so nothing can be sent or held.
    await expect(page.locator('[role=tab]', { hasText: /^Market$/ })).toHaveCount(0);
    await expect(page.locator('[role=tab]', { hasText: /^Limit$/ })).toBeEnabled();
    await page.getByRole('button', { name: 'Other order types (not available)', exact: true }).click();
    const marketRow = page.getByTestId('dk-type-off-market');
    await expect(marketRow).toHaveAttribute('aria-disabled', 'true');
    await expect(marketRow).toHaveText('MarketThis market is taking limit orders only right now.');
    await stepPicture();
    await page.keyboard.press('Escape');
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
    await page.getByRole('textbox', { name: 'Price', exact: true }).first().fill(price);
    await page.getByRole('textbox', { name: 'Amount', exact: true }).first().fill('0.001');
    const form = page.locator('form[data-testid="dk-form"][data-side="buy"]');
    await expect(form).toContainText('This market is cancel-only');
    await expect(form).toContainText('you can still cancel them');
    await expect(form).not.toContainText(/[a-z]+\.[a-z_]+_[a-z_]+/);
    await expect(page.getByRole('button', { name: 'Buy BTC', exact: true })).toBeDisabled();
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
  test.setTimeout(4 * 60_000);
  // Two TEST operators publish a maintenance window on the limited market, starting an hour from now, with no end time
  // (svc-notify's four-eyes publish). The window is cancelled at the end of the step, so it never opens on the stack.
  const key = `${J}:${process.env.JOURNEY_RUN_ID ?? 'local'}:${Date.now()}:maintenance`;
  const startsAt = new Date(Date.now() + 61 * 60_000).toISOString();
  const draft = await draftNotice({
    kind: 'maintenance',
    title: `TEST ${LIMITED} maintenance`,
    body: 'TEST: a journey maintenance window on the local stack.',
    startsAt,
    noEnd: true,
    components: [marketComponent(LIMITED)],
    key,
  });
  const published = await publishNotice(draft, key);
  try {
    // The lifecycle read carries it, from the notice's own start time, with no end.
    await expect
      .poll(
        async () => (await (await fetch(`${EDGE}/api/v1/market-lifecycle/${encodeURIComponent(LIMITED)}`)).json()).upcomingMaintenance,
        {
          timeout: 30_000,
        },
      )
      .toMatchObject({ status: 'scheduled', noticeId: published.id, startsAt, endsAt: null });
    // The ticket says it.
    const who = await account(page);
    await openDesk(page, who, LIMITED);
    const ticket = page.getByTestId('dk-maintenance');
    await expect(ticket).toContainText('Maintenance in 1 hour');
    await expect(page.getByTestId('dk-ticker')).toContainText('Maintenance in 1 hour');
    await expect(ticket).toContainText('End time not set');
    // The markets list flags it on that market's row.
    await page.goto('/trade');
    const row = page.getByRole('grid', { name: 'Markets', exact: true }).getByRole('row').filter({ hasText: LIMITED });
    await expect(row.getByTestId('mkt-maintenance')).toHaveText('Maintenance in 1 hour');
    // /status lists it on the market's row, and its blank end reads "End time not set".
    await page.goto('/status');
    await expect(page.getByTestId(`status-maintenance-${LIMITED}`)).toContainText('End time not set');
  } finally {
    await cancelMaintenance(published, `${J}: TEST window cancelled at the end of the step`);
  }
  // Cancelled, it is gone from the market's read.
  await expect
    .poll(
      async () =>
        (await (await fetch(`${EDGE}/api/v1/market-lifecycle/${encodeURIComponent(LIMITED)}`)).json()).upcomingMaintenance?.status,
      {
        timeout: 30_000,
      },
    )
    .toBe('none');
});

test(`${J} #6 an order while the market session is closed: the closed-market rule is applied and explained`, async ({ page }) => {
  const who = await account(page);
  const client = await api(who);
  // A session market whose session is shut now: the stack lists one TEST commodity on hours open one minute a week
  // (`seed-spot-test-listing.mjs`, TSES/USD). Its published lifecycle refuses placement with the closed-session reason,
  // the list reads "Closed, opens at", and an order refuses `trade.market_closed` with no order stored and nothing held.
  const markets = await (await fetch(`${EDGE}/api/v1/markets?limit=500`)).json();
  const shut = markets.find((m) => m.spot && !m.paper && m.sessionOpen === false && m.lifecycle?.reasonCode === 'trade.market_closed');
  expect(shut, 'a session market whose published lifecycle says its session is shut now').toBeTruthy();
  expect(shut.nextSessionChange?.open, 'the read names when it next opens').toBe(true);
  await signIn(page, who);
  // A market that is not open now is listed among the paused rows, so the list is asked to include them (as in #10).
  await page.goto(`/trade?q=${encodeURIComponent(shut.base)}`);
  await expect(page.getByRole('grid', { name: 'Markets', exact: true })).toBeVisible({ timeout: UNBUILT_MS });
  const includePaused = page
    .getByRole('group', { name: 'Filter by status', exact: true })
    .getByRole('button', { name: 'Include paused', exact: true });
  await includePaused.click();
  await expect(includePaused).toHaveAttribute('aria-pressed', 'true');
  const row = page
    .getByRole('grid', { name: 'Markets', exact: true })
    .getByRole('row')
    .filter({ hasText: `${shut.base}/${shut.quote}` });
  await expect(row).toContainText(/Closed.*Opens/, { timeout: UNBUILT_MS });
  // Not a tradeable row: its action is disabled, says why, and links nowhere.
  const button = row.getByRole('button', { name: new RegExp(`^(Trade|Buy) `) });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', 'This market is closed. Orders are not queued while it is closed');
  const before = await client.balances();
  const clientOrderId = `${J}-6-${who.handle}`;
  const res = await client.post('/api/v1/orders', {
    symbol: shut.symbol,
    side: 'buy',
    type: 'limit',
    amount: '1',
    price: '1',
    clientOrderId,
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(res.body)).toContain('trade.market_closed');
  // Nothing held, and the order was not stored to wait for the open.
  expect(await client.balances()).toEqual(before);
  expect((await openOrders(who, shut.symbol)).filter((o) => o.clientOrderId === clientOrderId)).toHaveLength(0);
  // The desk says so before any order: closed, when it opens, and that orders are not queued.
  await page.goto(deskPath(shut.symbol));
  await expect(page.getByTestId('dk-ticker')).toContainText('Closed, opens', { timeout: UNBUILT_MS });
  await expect(page.getByText(/Orders are not queued while it is closed/)).toBeVisible({ timeout: UNBUILT_MS });
});

test(`${J} #7 a market inside its opening window or the higher-risk zone shows a badge; a market order is refused with the window reason and a limit is accepted`, async ({
  page,
  stepPicture,
}) => {
  // A new listing inside its opening window: the stack lists one TEST market whose window ends weeks after the seed
  // (TWIN/USDC). The read names when the window ends.
  const markets = await (await fetch(`${EDGE}/api/v1/markets?limit=500`)).json();
  const windowed = markets.find(
    (m) => m.spot && !m.paper && m.orderable && m.openingWindowEndsAt && Date.parse(m.openingWindowEndsAt) > Date.now(),
  );
  expect(windowed, 'a market inside its opening window').toBeTruthy();
  const who = await account(page);
  const client = await api(who);
  await openDesk(page, who, windowed.symbol);
  // The badge on the desk names the window and what it allows.
  await expect(page.getByTestId('dk-opening-window')).toContainText('Opening window', { timeout: UNBUILT_MS });
  await expect(page.getByTestId('dk-opening-window')).toContainText('Limit orders only until');
  const quote = windowed.quote;
  const before = held(await client.balances(), quote);
  const sent = placements(page);
  // A market order: the ticket offers no Market tab inside the window; it lists Market, disabled, with the window reason
  // (the desk's order-type list, J-cex-spot-04 #1), so nothing can be sent or held.
  await expect(page.locator('[role=tab]', { hasText: /^Market$/ })).toHaveCount(0);
  await expect(page.locator('[role=tab]', { hasText: /^Limit$/ })).toBeEnabled();
  await page.getByRole('button', { name: 'Other order types (not available)', exact: true }).click();
  await expect(page.getByTestId('dk-type-off-market')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('dk-type-off-market')).toHaveText(
    'MarketThis market takes limit orders only until its opening window ends.',
  );
  await page.keyboard.press('Escape');
  // oxlint-disable-next-line garden/no-wait-for-timeout -- proving nothing happens: no order request leaves the page
  await page.waitForTimeout(1000);
  expect(sent.filter((body) => body?.symbol === windowed.symbol)).toHaveLength(0);
  // The door refuses the same market order with the window reason, before any hold.
  const market = await client.post('/api/v1/orders', {
    symbol: windowed.symbol,
    side: 'buy',
    type: 'market',
    amount: '1',
    clientOrderId: `${J}-7m-${who.handle}`,
  });
  expect(market.status).toBe(400);
  expect(JSON.stringify(market.body)).toContain('trade.opening_window');
  expect(held(await client.balances(), quote)).toBe(before);
  // A limit buy is accepted and rests, holding exactly its price x amount; it is then cancelled, so nothing stays held.
  const price = '1';
  const amount = '1';
  const limit = await client.post('/api/v1/orders', {
    symbol: windowed.symbol,
    side: 'buy',
    type: 'limit',
    amount,
    price,
    clientOrderId: `${J}-7-${who.handle}`,
  });
  expect(limit.status, JSON.stringify(limit.body).slice(0, 300)).toBeLessThan(300);
  const resting = (await openOrders(who, windowed.symbol)).find((o) => o.id === limit.body.id);
  expect(resting, 'the limit order rests on the book').toBeTruthy();
  expect(held(await client.balances(), quote) - before).toBe((toUnits(price) * toUnits(amount)) / toUnits('1'));
  const cancel = await client.delete(`/api/v1/orders/${encodeURIComponent(limit.body.id)}`);
  expect(cancel.status, JSON.stringify(cancel.body).slice(0, 300)).toBeLessThan(300);
  await expect.poll(async () => (await openOrders(who, windowed.symbol)).map((o) => o.id)).not.toContain(limit.body.id);
  await expect.poll(async () => held(await client.balances(), quote)).toBe(before);

  // The higher-risk zone: the stack lists one TEST market in it (TRSK/USDC) with a TEST order cap. The read flags it and
  // names its cap; the desk shows the zone badge with that cap.
  const zoned = markets.find((m) => m.spot && !m.paper && m.orderable && m.zone === 'higher_risk' && m.zoneOrderCap);
  expect(zoned, 'a market in the higher-risk zone, with its order cap').toBeTruthy();
  const cap = zoned.zoneOrderCap;
  await openDesk(page, who, zoned.symbol);
  await expect(page.getByTestId('dk-zone')).toContainText('Higher-risk zone', { timeout: UNBUILT_MS });
  await expect(page.getByTestId('dk-zone')).toContainText(`Limit orders only, up to ${cap} ${zoned.quote} an order`);
  const zoneQuote = zoned.quote;
  const zoneBefore = held(await client.balances(), zoneQuote);
  const zoneSent = placements(page);
  // A market order: no Market tab in the zone; Market is listed, disabled, with the zone reason (J-cex-spot-04 #1).
  await expect(page.locator('[role=tab]', { hasText: /^Market$/ })).toHaveCount(0);
  await expect(page.locator('[role=tab]', { hasText: /^Limit$/ })).toBeEnabled();
  await page.getByRole('button', { name: 'Other order types (not available)', exact: true }).click();
  await expect(page.getByTestId('dk-type-off-market')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('dk-type-off-market')).toHaveText(
    'MarketThis market is in the higher-risk zone, which takes limit orders only.',
  );
  await stepPicture();
  await page.keyboard.press('Escape');
  // The door refuses the same market order with the zone reason, before any hold.
  const zoneMarket = await client.post('/api/v1/orders', {
    symbol: zoned.symbol,
    side: 'buy',
    type: 'market',
    amount: '1',
    clientOrderId: `${J}-7zm-${who.handle}`,
  });
  expect(zoneMarket.status).toBe(400);
  expect(JSON.stringify(zoneMarket.body)).toContain('trade.higher_risk_zone');
  expect(held(await client.balances(), zoneQuote)).toBe(zoneBefore);
  // By now the page has had the door's round trip and more to send an order, and it sent none.
  expect(zoneSent.filter((body) => body?.symbol === zoned.symbol)).toHaveLength(0);
  // A limit worth more than the cap is refused by its cap, before any hold.
  const over = await client.post('/api/v1/orders', {
    symbol: zoned.symbol,
    side: 'buy',
    type: 'limit',
    amount: '101',
    price: '1',
    clientOrderId: `${J}-7zo-${who.handle}`,
  });
  expect(toUnits('101'), 'the over-cap order is worth more than the cap').toBeGreaterThan(toUnits(cap));
  expect(over.status).toBe(400);
  expect(JSON.stringify(over.body)).toContain('trade.zone_cap_exceeded');
  expect(held(await client.balances(), zoneQuote)).toBe(zoneBefore);
  // A limit buy under the cap is accepted and rests, holding exactly its price x amount; it is then cancelled.
  const zonePrice = '1';
  const zoneAmount = '10';
  const zoneLimit = await client.post('/api/v1/orders', {
    symbol: zoned.symbol,
    side: 'buy',
    type: 'limit',
    amount: zoneAmount,
    price: zonePrice,
    clientOrderId: `${J}-7z-${who.handle}`,
  });
  expect(zoneLimit.status, JSON.stringify(zoneLimit.body).slice(0, 300)).toBeLessThan(300);
  const zoneResting = (await openOrders(who, zoned.symbol)).find((o) => o.id === zoneLimit.body.id);
  expect(zoneResting, 'the zone limit order rests on the book').toBeTruthy();
  expect(held(await client.balances(), zoneQuote) - zoneBefore).toBe((toUnits(zonePrice) * toUnits(zoneAmount)) / toUnits('1'));
  const zoneCancel = await client.delete(`/api/v1/orders/${encodeURIComponent(zoneLimit.body.id)}`);
  expect(zoneCancel.status, JSON.stringify(zoneCancel.body).slice(0, 300)).toBeLessThan(300);
  await expect.poll(async () => (await openOrders(who, zoned.symbol)).map((o) => o.id)).not.toContain(zoneLimit.body.id);
  await expect.poll(async () => held(await client.balances(), zoneQuote)).toBe(zoneBefore);
});

test(`${J} #8 public depth, tickers, candles and spreads: a snapshot then ordered updates, and a reconnect resumes from the last sequence`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // The reads: a ticker's spread is its best ask minus its best bid, exactly; so is every row of the spreads read; and
  // candles come oldest first, each [open time, open, high, low, close, volume] in decimal strings.
  const tickers = await (await fetch(`${EDGE}/api/v1/tickers?limit=500`)).json();
  const btc = Object.values(tickers).find((t) => t?.symbol === 'BTC/USDT');
  expect(btc?.bid && btc?.ask, 'the BTC/USDT ticker carries both sides of its book').toBeTruthy();
  expect(toUnits(btc.spread), 'the ticker spread is best ask minus best bid').toBe(toUnits(btc.ask) - toUnits(btc.bid));
  const spreadsRes = await fetch(`${EDGE}/api/v1/spreads?limit=500`);
  expect(spreadsRes.status).toBe(200);
  const spreads = await spreadsRes.json();
  expect(
    spreads.some((r) => r.symbol === 'BTC/USDT' && r.spread !== null),
    'the spreads read has BTC/USDT',
  ).toBe(true);
  for (const r of spreads)
    if (r.bid !== null && r.ask !== null) expect(toUnits(r.spread), `${r.symbol}'s spread`).toBe(toUnits(r.ask) - toUnits(r.bid));
    else expect(r.spread, `${r.symbol} has one side, so no spread`).toBeNull();
  const candlesRes = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent('BTC/USDT')}?timeframe=1m&limit=5`);
  expect(candlesRes.status).toBe(200);
  const candleRows = await candlesRes.json();
  for (const [i, row] of candleRows.entries()) {
    expect(row).toHaveLength(6);
    for (const v of row.slice(1)) expect(typeof v, 'a candle amount is a decimal string').toBe('string');
    if (i > 0) expect(row[0], 'candles come oldest first').toBeGreaterThan(candleRows[i - 1][0]);
  }

  // The live tickers (spreads with them) and candles: the multiplexed stream a desk opens (/ws/stream, no market). Two
  // TEST traders trade each other on TAPE, a book no market maker quotes and no other journey trades, so its ticker and
  // candles move by real taker fills while the step watches. A subscriber gets a snapshot first (the ticker channel's
  // `snapshot`, the candle channel's current candles), then updates in order: ticker frames in time order, every one
  // after the snapshot an `update`; candle frames never going back to an earlier bucket, the open bucket's volume
  // growing by each fill.
  const TAPE = 'USDT/USDC';
  const buyer = await account(page);
  const buyerApi = await api(buyer);
  const seller = await fundedTrader(page, 'j14t', '50');
  const sellerApi = await api(seller);
  const trade = async (n, amount) => {
    const ask = await sellerApi.post('/api/v1/orders', {
      symbol: TAPE,
      side: 'sell',
      type: 'limit',
      amount,
      price: '1',
      clientOrderId: `${J}-8s${n}-${seller.handle}`,
    });
    expect(ask.status, JSON.stringify(ask.body).slice(0, 300)).toBeLessThan(300);
    const bid = await buyerApi.post('/api/v1/orders', {
      symbol: TAPE,
      side: 'buy',
      type: 'limit',
      amount,
      price: '1',
      clientOrderId: `${J}-8b${n}-${seller.handle}`,
    });
    expect(bid.status, JSON.stringify(bid.body).slice(0, 300)).toBeLessThan(300);
    await expect.poll(async () => (await openOrders(seller, TAPE)).length, { message: `trade ${n} on ${TAPE} filled` }).toBe(0);
  };
  await trade(1, '5');
  const mux = await openMux(`${ORIGIN.replace(/^http/, 'ws')}/ws/stream`);
  try {
    mux.send({ op: 'subscribe', id: 'j14-8', channels: [{ ch: 'ticker' }, { ch: 'candles', market: TAPE, interval: '1m' }] });
    await expect
      .poll(() => mux.frames.find((f) => f.op === 'ack' && f.id === 'j14-8')?.results?.every((r) => r.ok), { timeout: 15_000 })
      .toBe(true);
    const tickerFrames = () => mux.frames.filter((f) => f.ch === 'ticker').map((f) => f.data);
    const candleFrames = () => mux.frames.filter((f) => f.ch === 'candles').map((f) => f.data);
    await expect.poll(() => tickerFrames().length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => candleFrames().length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    const snapshot = tickerFrames()[0];
    expect(snapshot.type, 'the ticker channel opens with a snapshot').toBe('snapshot');
    const liveBtc = snapshot.tickers.find((r) => r.symbol === 'BTC/USDT');
    expect(liveBtc?.bid && liveBtc?.ask, 'the live BTC/USDT row carries its book top').toBeTruthy();
    expect(toUnits(liveBtc.spread), 'the live spread is best ask minus best bid').toBe(toUnits(liveBtc.ask) - toUnits(liveBtc.bid));
    const tapeBefore = snapshot.tickers.find((r) => r.symbol === TAPE);
    expect(tapeBefore?.last, `${TAPE}'s row has its last trade`).toBe('1');
    const firstCandles = candleFrames().length;
    const openBucket = candleFrames().at(-1);
    expect(openBucket.type).toBe('candle');
    expect(openBucket.c, `${TAPE}'s current candle closes at the trade`).toBe('1');

    await trade(2, '3');
    // The candles: an update after the current candles, for the open bucket (or a later one), with trade 2 in it.
    await expect
      .poll(
        () =>
          candleFrames()
            .slice(firstCandles)
            .some((c) => c.t > openBucket.t || (c.t === openBucket.t && toUnits(c.v) - toUnits(openBucket.v) >= toUnits('3'))),
        { timeout: 30_000, message: `${TAPE}'s candle grows by trade 2` },
      )
      .toBe(true);
    // The ticker: an update naming TAPE with trade 2 in its 24 h volume.
    await expect
      .poll(
        () =>
          tickerFrames()
            .slice(1)
            .some((f) => f.tickers.some((r) => r.symbol === TAPE && toUnits(r.volume) - toUnits(tapeBefore.volume) >= toUnits('3'))),
        { timeout: 30_000, message: `${TAPE}'s ticker updates with trade 2` },
      )
      .toBe(true);
    // In order: the ticker frames in time order, a snapshot and then updates (a snapshot again only as a repair); the
    // candle frames never back to an earlier bucket.
    const ticks = tickerFrames();
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].ts, 'ticker frames come in time order').toBeGreaterThanOrEqual(ticks[i - 1].ts);
      expect(['update', 'snapshot']).toContain(ticks[i].type);
    }
    expect(
      ticks.slice(1).some((f) => f.type === 'update'),
      'updates follow the snapshot',
    ).toBe(true);
    const bars = candleFrames();
    for (let i = 1; i < bars.length; i++) expect(bars[i].t, 'candle frames never go back a bucket').toBeGreaterThanOrEqual(bars[i - 1].t);
  } finally {
    mux.close();
  }

  // The stream: the public depth socket a desk opens (/ws/stream on the app's own origin). A snapshot first, then deltas
  // in sequence order, each continuing the one before. Another screen keeps watching the book (`watcher`) while this one
  // drops and reconnects naming the last sequence it holds: it is sent only the deltas it missed, the first continuing
  // from that sequence, never a fresh snapshot.
  const markets = await (await fetch(`${EDGE}/api/v1/markets?limit=500`)).json();
  const listing = markets.find((m) => m.symbol === 'BTC/USDT' && m.spot && !m.paper);
  expect(listing?.id, 'BTC/USDT is listed').toBeTruthy();
  const streamUrl = (since) =>
    `${ORIGIN.replace(/^http/, 'ws')}/ws/stream?market=${encodeURIComponent(listing.id)}${since === undefined ? '' : `&since=${since}`}`;
  const watcher = openStream(streamUrl());
  const first = openStream(streamUrl());
  try {
    await expect.poll(() => first.frames.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    expect(first.frames[0].type, 'the stream opens with a snapshot').toBe('snapshot');
    const held = continues(first.frames);
    first.close();
    await expect.poll(() => watcher.frames.at(-1)?.sequence ?? 0, { timeout: 30_000 }).toBeGreaterThan(held);
    const again = openStream(streamUrl(held));
    try {
      await expect.poll(() => again.frames.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      expect(again.frames[0], 'the reconnect resumes from the last sequence, not from a new snapshot').toMatchObject({
        type: 'delta',
        fromSequence: held,
      });
      await expect.poll(() => again.frames.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
      continues(again.frames, held);
    } finally {
      again.close();
    }
  } finally {
    first.close();
    watcher.close();
  }
});

/** A multiplexed public socket (/ws/stream with no market), once open: every frame it has received, parsed, and a sender. */
async function openMux(url) {
  const socket = new WebSocket(url);
  const frames = [];
  socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`the multiplexed stream ${url} did not open`)), { once: true });
  });
  return { frames, send: (value) => socket.send(JSON.stringify(value)), close: () => socket.close() };
}

/** A public depth socket and every frame it has received, parsed. */
function openStream(url) {
  const socket = new WebSocket(url);
  const frames = [];
  socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
  return { frames, close: () => socket.close() };
}

/**
 * The frames, read as a client does: from a snapshot (or from `from`, the sequence the client already holds), every
 * delta continues the sequence before it. Returns the last sequence held.
 */
function continues(frames, from = null) {
  let cursor = from;
  for (const frame of frames) {
    if (frame.type === 'snapshot') {
      cursor = frame.sequence;
      continue;
    }
    if (frame.type !== 'delta') continue;
    expect(cursor, 'a delta arrives only after a snapshot or a held sequence').not.toBeNull();
    expect(frame.fromSequence, 'each update continues the one before').toBe(cursor);
    expect(frame.sequence).toBeGreaterThan(cursor);
    cursor = frame.sequence;
  }
  return cursor;
}

test(`${J} #9 /trade/analytics/:pair shows the aggressor differential and window stats with the window named; a blank window refuses`, async ({
  page,
}) => {
  const who = await account(page);
  await signIn(page, who);
  // Every analytics read the room makes, with the service's answer: the figures it shows are compared with these.
  const reads = [];
  page.on('response', async (r) => {
    const url = new URL(r.url());
    if (r.request().method() !== 'GET' || url.pathname !== `/api/v1/analytics/${encodeURIComponent('BTC/USDT')}`) return;
    reads.push({ window: url.searchParams.get('window'), status: r.status(), body: await r.json().catch(() => null) });
  });
  await page.goto('/trade/analytics/BTC-USDT');
  const utc = (iso) => iso.slice(0, 16).replace('T', ' ');
  /** The room shows the service's latest read of `window`, figure for figure, with the window named. */
  const showsRead = async (window, named) => {
    let read;
    await expect(async () => {
      read = reads.filter((x) => x.window === window).at(-1);
      expect(read, `the room read the ${window} window`).toBeTruthy();
      expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
      expect(read.body).toMatchObject({ symbol: 'BTC/USDT', window });
      const b = read.body;
      // The service's own sum: the differential is taker buys minus taker sells, and the trades split adds up.
      expect(toUnits(b.aggressorDifferential)).toBe(toUnits(b.buyVolume) - toUnits(b.sellVolume));
      expect(b.buyTrades + b.sellTrades).toBe(b.trades);
      await expect(page.getByTestId('analytics-differential').locator('strong')).toHaveText(b.aggressorDifferential, { timeout: 1_000 });
      await expect(page.getByTestId('analytics-differential')).toContainText('Aggressor differential');
      await expect(page.getByTestId('analytics-differential')).toContainText('Bought by takers minus sold by takers, in BTC');
      await expect(page.getByTestId('analytics-bought').locator('strong')).toHaveText(b.buyVolume, { timeout: 1_000 });
      await expect(page.getByTestId('analytics-sold').locator('strong')).toHaveText(b.sellVolume, { timeout: 1_000 });
      await expect(page.getByTestId('analytics-trades').locator('strong')).toHaveText(String(b.trades), { timeout: 1_000 });
      await expect(page.getByTestId('analytics-trades')).toContainText(`${b.buyTrades} buy-initiated, ${b.sellTrades} sell-initiated`, {
        timeout: 1_000,
      });
      await expect(page.getByTestId('analytics-range')).toHaveText(
        b.high !== null && b.low !== null ? `Range: ${b.low} – ${b.high}` : 'Range: No trades in this window',
        { timeout: 1_000 },
      );
      await expect(page.getByTestId('analytics-window')).toHaveText(`Window: ${named}, ${utc(b.from)} to ${utc(b.to)} UTC`, {
        timeout: 1_000,
      });
      if (b.complete) await expect(page.getByTestId('analytics-partial')).toHaveCount(0);
      else
        await expect(page.getByTestId('analytics-partial')).toHaveText(
          `More trades than one read holds: these figures cover ${utc(b.coveredFrom ?? b.from)} to ${utc(b.to)} UTC only.`,
          { timeout: 1_000 },
        );
    }).toPass({ timeout: 20_000 });
    // The window it names is the window it read.
    const span = Date.parse(read.body.to) - Date.parse(read.body.from);
    expect(span).toBe({ '5m': 5 * 60_000, '1h': 3_600_000, '24h': 86_400_000 }[window]);
  };
  await showsRead('1h', 'Last 1 hour');
  await expect(page.getByTestId('analytics-windows').getByRole('button', { name: 'Last 1 hour', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Another named window is read again and named, with its own figures.
  await page.getByTestId('analytics-windows').getByRole('button', { name: 'Last 24 hours', exact: true }).click();
  await showsRead('24h', 'Last 24 hours');
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
  // The markets list labels that pair's quote USD too. A USD pair whose session or settlement is not open is a paused
  // row, so the list is asked to include paused markets first.
  await page.getByRole('button', { name: 'Include paused', exact: true }).click();
  const list = page.getByRole('grid', { name: 'Markets', exact: true });
  const usdRows = list.getByRole('row').filter({ has: page.getByTestId('mkt-name__quote').getByText('/USD', { exact: true }) });
  await expect(usdRows.first()).toBeVisible();
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
