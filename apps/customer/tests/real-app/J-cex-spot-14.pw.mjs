// World: book, gates, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, api, journeyState, toUnits } from './stack.mjs';
import { reviewSheet, signIn, signUp, verify } from './desk.mjs';
import { cancelMaintenance, draftNotice, publishNotice } from './notices.mjs';
import {
  continueInWallet,
  openVenueDesk,
  otherTraderKey,
  otherTraderRun,
  sameDecimal,
  testDeposit,
  testVenue,
  tradePayloadHash,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
  venueWrites,
  walletDoorAct,
} from './venue.mjs';
import { utcMinuteOf } from './clock.mjs';
import { configureStatusPage, statusDefinition, statusRead } from './status-page.mjs';

// J-cex-spot-14, in the running app (docs/roadmap/journeys.json): a pro trader knows whether a market is open, limited,
// closing, new or risky before trading it, and never sends an order into a state that refuses it without being told
// why first. One test per step, titled "J-cex-spot-14 #<n>", run on the stack's outside TEST venue (at launch our own
// order book is off, docs/adr/2026-11-10-launch-money-model.md). Each step creates or uses its own fresh TEST venue
// markets so no other journey's book is touched; every money/order/state claim is checked against the venue's own
// record (`venueRecord` / `venueBalance`). Every figure is TEST.
const J = 'J-cex-spot-14';
const ZERO_OWNER = '0x0000000000000000000000000000000000000000';
/** The status component a maintenance notice names one market by (`market-<base>-<quote>`), as svc-notify reads it. */
const marketComponent = (symbol) => `market-${symbol.toLowerCase().replace(/[/_]/g, '-')}`;
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT_MS = 10_000;
/** #2's one TEST platform-status component, and the labelled TEST owner values it runs with where the stack has none. */
const STATUS_COMPONENT = { id: 'trading', name: 'TEST Trading', group: null, source: null };
const TEST_STATUS_VALUES = { componentCap: 5, stalenessSeconds: 600, uptimeDays: 7 };

const LISTING_SET = 'trade.venue_listing_set';
const DELISTING = 'trade.venue_delisting_schedule';
const POLICY = 'trade-venue-markets-v1';
const DAY = 86_400_000;

const trpcData = (res) => res.json?.result?.data?.json ?? res.json?.result?.data;

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

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

/** A fresh TEST spot market on the TEST venue, optionally configured with session, opening window, zone, or quote. */
async function freshMarket(tag, extra = {}) {
  const base = `T14${tag}${randomBytes(2).toString('hex').toUpperCase()}`;
  const quote = extra.quoteAsset ?? 'USDC';
  const symbol = `${base}-${quote}`;
  const added = await testVenue('/test/market-add', {
    symbol,
    baseAsset: base,
    quoteAsset: quote,
    maxOrderQty: '100',
    maxOrderNotional: '100000',
    ...extra,
  });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  return { symbol, base, quote };
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
const list = async (symbol, opensAt) => {
  await listingWrite(symbol, LISTING_SET, 'admin.venueMarkets.listingSet', { opensAt }, '0');
  // Refresh svc-trade's market cache immediately so newly added TEST markets are visible to prepare without waiting 5s.
  await marketStates();
};
const delist = (symbol, delistsAt) => listingWrite(symbol, DELISTING, 'admin.venueMarkets.delistingSchedule', { delistsAt }, '1');
const minuteAgoIso = () => new Date(Date.now() - 60_000).toISOString();
const orderKey = (actor, label) => `order:${actor.toLowerCase()}:${label}`;

/** Verified TEST account + TEST venue wallet funded on the TEST venue with TEST USDC. */
async function trader(page) {
  const known = run.read();
  if (known.account && known.walletKey) {
    const key = privateKeyToAccount(known.walletKey);
    return { who: known.account, walletKey: known.walletKey, key, owner: key.address.toLowerCase() };
  }
  const who = await signUp(page, 'j14');
  await verify(page, who);
  const walletKey = `0x${randomBytes(32).toString('hex')}`;
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  const { chainId } = await venueInfo();
  await testDeposit(owner, 'USDC', '100000', `${chainId}:0x${randomBytes(32).toString('hex')}:0`);
  run.write({ ...run.read(), account: who, walletKey });
  return { who, walletKey, key, owner };
}

/** This attempt's four markets for #1 and #2, created once per attempt. */
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

/** The trading mode a market is in now, from the read's own fields, the stricter first. */
function modeOf(m) {
  if (m.listing.delisted || m.status === 'delisted') return 'DELISTING';
  if (m.listing.routing === 'stop') return 'HALTED';
  if (!m.listing.open) return 'PRELAUNCH';
  if (m.status === null) return 'none';
  if (m.status === 'halted') return 'HALTED';
  if (m.status === 'cancel_only') return 'CANCEL_ONLY';
  if (m.session?.known && m.session.value.state === 'closed') return 'HALTED';
  if (m.status === 'limit_only') return 'LIMIT_ONLY';
  if (m.listing.routing === 'close_only') return 'REDUCE_ONLY';
  return 'OPEN';
}
/** Only an open market with no delisting set, in mode Open, is a tradeable row. */
const tradeable = (m) => modeOf(m) === 'OPEN' && m.listing.delistsAt === null;

/** Hold a TEST venue market in `status` while `body` runs, then always restore `'trading'`. */
async function inVenueStatus(symbol, status, body) {
  let failed = null;
  try {
    const res = await testVenue('/test/market-status', { symbol, status });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await body();
  } catch (err) {
    failed = err;
  }
  try {
    await testVenue('/test/market-status', { symbol, status: 'trading' });
  } catch (err) {
    if (failed) throw new AggregateError([failed, err], `${J}: step failed and ${symbol} could not be put back to trading`);
    throw err;
  }
  if (failed) throw failed;
}

/** #2 restores the founders' status definition after the step, whatever happens. */
let restoreStatus = null;
test.afterEach(async () => {
  const restore = restoreStatus;
  restoreStatus = null;
  if (restore) await restore();
});

test(`${J} #1 the markets list shows open, upcoming and delisting markets with listing status and dated delisting; only open real markets are tradeable`, async ({
  page,
  stepPicture,
}) => {
  const mine = await venueMarkets();
  // Compare svc-trade's public read against the venue's own `/markets` record directly.
  const venueOwn = (await venueRecord(ZERO_OWNER, '/markets')).value;
  const ownBySymbol = new Map(venueOwn.map((m) => [m.symbol, m]));
  expect(ownBySymbol.get(mine.open.symbol)?.status).toBe('trading');
  expect(ownBySymbol.get(mine.cancelOnly.symbol)?.status).toBe('cancel_only');

  const states = await marketStates();
  expect(states.value.test, 'the TEST venue').toBe(true);
  const bySymbol = new Map(states.value.markets.map((m) => [m.symbol, m]));
  const read = (x) => bySymbol.get(x.symbol);
  expect(read(mine.open), 'the open market on the venue read').toMatchObject({
    status: ownBySymbol.get(mine.open.symbol).status,
    listing: { open: true, delistsAt: null },
  });
  expect(read(mine.upcoming)?.listing.open, 'the upcoming market has not opened').toBe(false);
  expect(Date.parse(read(mine.delisting)?.listing.delistsAt ?? ''), 'the delisting carries its date').toBeGreaterThan(Date.now());
  expect(read(mine.cancelOnly)?.status, "the venue's own state").toBe(ownBySymbol.get(mine.cancelOnly.symbol).status);

  // Signed out, as anyone opens it.
  await page.goto('/trade');
  const grid = page.getByRole('grid', { name: 'Markets', exact: true });
  await expect(grid).toBeVisible();
  const more = page.getByRole('button', { name: /^Show \d+ more markets$/ });
  const pair = (x) => new RegExp(`^${x.base}/${x.quote}$`);
  const rowOf = (x) => grid.getByRole('row').filter({ has: page.getByTestId('mkt-name__ticker').filter({ hasText: pair(x) }) });
  const action = (row) => row.getByRole('button', { name: /^(Trade|Buy) / });
  await expect(
    grid
      .getByRole('row')
      .filter({ has: page.getByTestId('mkt-name__ticker') })
      .first(),
  ).toBeVisible();
  while (await more.isVisible()) await more.click();
  await expect(rowOf(mine.open)).toHaveCount(1);

  await expect(action(rowOf(mine.open))).toBeEnabled();
  await expect(action(rowOf(mine.open))).toHaveAttribute('href', /\/trade\/|\/coin\//);
  await expect(rowOf(mine.open).getByTestId('mkt-listing')).toHaveCount(0);
  await expect(rowOf(mine.upcoming).getByTestId('mkt-listing')).toHaveText('Upcoming', { timeout: UNBUILT_MS });
  await expect(action(rowOf(mine.upcoming))).toBeDisabled();

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
  await expect(rowOf(mine.cancelOnly)).toHaveCount(0);

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
    await expect
      .poll(() => button.getAttribute('href'), { message: `${name}'s link` })
      .toEqual(trades ? expect.stringMatching(/\/trade\/|\/coin\//) : null);
  }
  for (const x of [mine.open, mine.upcoming, mine.delisting]) expect(seen.has(x.symbol), `${x.symbol} is drawn`).toBe(true);
  await stepPicture();
  await rowOf(mine.upcoming).click();
  await expect(page).toHaveURL(/\/trade(\?.*)?$/);
});

test(`${J} #2 /status shows each market's trading mode and the platform status, with the time they are as of`, async ({
  page,
  stepPicture,
}) => {
  const mine = await venueMarkets();
  const venueOwn = new Map((await venueRecord(ZERO_OWNER, '/markets')).value.map((m) => [m.symbol, m]));
  expect(venueOwn.get(mine.open.symbol)?.status).toBe('trading');
  expect(venueOwn.get(mine.cancelOnly.symbol)?.status).toBe('cancel_only');

  const definedBefore = await statusDefinition();
  test.info().attach('status definition before', { body: JSON.stringify(definedBefore), contentType: 'application/json' });
  await configureStatusPage(
    {
      components: [STATUS_COMPONENT],
      componentCap: definedBefore.componentCap ?? TEST_STATUS_VALUES.componentCap,
      stalenessSeconds: definedBefore.stalenessSeconds ?? TEST_STATUS_VALUES.stalenessSeconds,
      uptimeDays: definedBefore.uptimeDays ?? TEST_STATUS_VALUES.uptimeDays,
    },
    `TEST journey ${J} #2`,
  );
  restoreStatus = () =>
    configureStatusPage(
      {
        components: definedBefore.components,
        componentCap: definedBefore.componentCap,
        stalenessSeconds: definedBefore.stalenessSeconds,
        uptimeDays: definedBefore.uptimeDays,
      },
      `TEST journey ${J} #2: definition put back`,
    );
  await page.goto('/status');
  await expect(page.getByRole('heading', { name: 'Platform status', exact: true })).toBeVisible();

  const drawnStatus = async () => {
    const overall = await page.getByTestId('status-overall').getAttribute('data-state');
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
    return { overall: read.overall, rows: read.components.map((c) => ({ id: c.id, name: c.name, state: c.state })) };
  };
  await expect(page.getByTestId('status-overall')).toBeVisible();
  await expect
    .poll(async () => JSON.stringify(await drawnStatus()) === JSON.stringify(await publishedStatus()), {
      timeout: 45_000,
      message: 'the page shows the components and overall state svc-notify publishes',
    })
    .toBe(true);
  expect((await publishedStatus()).rows.map((r) => r.id)).toEqual([STATUS_COMPONENT.id]);
  await expect(page.getByTestId(`status-component-${STATUS_COMPONENT.id}`)).toContainText(STATUS_COMPONENT.name);

  const statusAsOf = page.getByTestId('status-asof');
  await expect(statusAsOf).toHaveText(/^As of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  const minuteLine = (iso) => `As of ${utcMinuteOf(Date.parse(iso)).replace('T', ' ')} UTC`;
  await expect
    .poll(
      async () => {
        const before = minuteLine((await statusRead()).asOf);
        const shown = (await statusAsOf.textContent())?.trim();
        const after = minuteLine((await statusRead()).asOf);
        return shown === before || shown === after;
      },
      { timeout: 75_000, message: "the platform status as-of line is svc-notify's status read's own asOf" },
    )
    .toBe(true);

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

  const line = page.getByTestId('status-modes-asof');
  await expect(line).toHaveText(/^As of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  const asOfLine = (read) => minuteLine(read.asOf);
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

test(`${J} #3 a market order on a limit-only market is refused as limit-only, and a limit inside the band is accepted`, async ({
  page,
  stepPicture,
}) => {
  const { who, walletKey, owner } = await trader(page);
  const client = await api(who);
  const lim = await freshMarket('L3');
  await list(lim.symbol, minuteAgoIso());
  // Seed a resting bid + ask from another TEST trader so the book has a live two-sided spread inside protection limits.
  const { chainId } = await venueInfo();
  const maker = otherTraderKey(`j14-3-${lim.base}`);
  await testDeposit(maker.address, lim.base, '20', `${chainId}:0x${randomBytes(32).toString('hex')}:0`);
  await testDeposit(maker.address, 'USDC', '5000', `${chainId}:0x${randomBytes(32).toString('hex')}:0`);
  await otherTraderRun(`j14-3-${lim.base}`, {
    kind: 'place_order',
    symbol: lim.symbol,
    side: 'sell',
    type: 'limit',
    amount: '2',
    price: '100',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: orderKey(maker.address, `j14-3-ask-${lim.base}`),
  });
  await otherTraderRun(`j14-3-${lim.base}`, {
    kind: 'place_order',
    symbol: lim.symbol,
    side: 'buy',
    type: 'limit',
    amount: '2',
    price: '99.8',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: orderKey(maker.address, `j14-3-bid-${lim.base}`),
  });

  await inVenueStatus(lim.symbol, 'limit_only', async () => {
    const venueMkt = (await venueRecord(owner, '/markets')).value.find((m) => m.symbol === lim.symbol);
    expect(venueMkt?.status).toBe('limit_only');
    // /status names Limit-only and its effect.
    await page.goto('/status');
    const row = page.getByTestId(`status-mode-${lim.symbol}`);
    await expect(row).toContainText('Limit-only');
    await expect(row).toContainText('Market orders are refused.');

    // Venue spot desk: ticker says Limit only, no Market tab, Market listed disabled with the limit-only reason.
    await openVenueDesk(page, who, `/trade/spot/${lim.symbol}`, walletKey);
    await expect(page.getByTestId('dk-ticker')).toContainText('Limit only');
    const lockedBefore = toUnits((await venueBalance(owner, 'USDC')).locked);
    const writes = venueWrites(page);
    await expect(page.locator('[role=tab]', { hasText: /^Market$/ })).toHaveCount(0);
    await expect(page.locator('[role=tab]', { hasText: /^Limit$/ })).toBeEnabled();
    const marketRow = page.getByTestId('dk-type-off-market');
    await expect(marketRow).toHaveAttribute('aria-disabled', 'true');
    await expect(marketRow).toHaveText('Market: This market is taking limit orders only right now.');
    await stepPicture();
    await page.waitForTimeout(1000);
    expect(writes).toHaveLength(0);

    // Door refuses a market order on a limit-only market before signing or locking anything (venue refusals answer 422).
    const marketIntent = {
      kind: 'place_order',
      symbol: lim.symbol,
      side: 'buy',
      type: 'market',
      amount: '0.5',
      price: '100',
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: orderKey(owner, `j14-3-mkt-${lim.base}`),
    };
    const preview = await client.post('/api/v1/venue/preview', { owner, intent: marketIntent });
    expect(preview.status).toBe(422);
    expect(preview.body?.intafacedCode).toBe('trade.venue.market_limit_only');
    const prepare = await client.post('/api/v1/venue/prepare', {
      owner,
      signer: { role: 'owner', address: owner },
      intent: marketIntent,
    });
    expect(prepare.status).toBe(422);
    expect(prepare.body?.intafacedCode).toBe('trade.venue.market_limit_only');
    expect(toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(lockedBefore);

    // A limit buy inside the band is accepted on the desk, rests on the venue, and locks exactly price × amount (95 × 0.5 = 47.5).
    const buyForm = page.locator('form[data-testid="dk-form"][data-side="buy"]');
    await buyForm.getByRole('textbox', { name: 'Price', exact: true }).fill('95');
    await buyForm.getByRole('textbox', { name: 'Amount', exact: true }).fill('0.5');
    await buyForm.getByRole('button', { name: `Buy ${lim.base}`, exact: true }).click();
    await reviewSheet(page).getByRole('button', { name: 'Confirm buy', exact: true }).click();
    await continueInWallet(page);

    await expect
      .poll(async () => (await venueRecord(owner, '/open-orders')).value.some((o) => o.symbol === lim.symbol && o.side === 'buy'), {
        timeout: 20_000,
        message: 'limit buy rests on the venue',
      })
      .toBe(true);
    const resting = (await venueRecord(owner, '/open-orders')).value.find((o) => o.symbol === lim.symbol && o.side === 'buy');
    expect(resting).toBeTruthy();
    expect(toUnits((await venueBalance(owner, 'USDC')).locked) - lockedBefore).toBe(toUnits('47.5'));
    // Carry the browser's kept venue order keys (sessionStorage) into #4 so the same trader can cancel from its row. The
    // desk keeps the key only once its submit answer is back, which can land after the venue already lists the order:
    // wait for this order's key before taking the copy, or #4's Cancel finds no key and asks no signature.
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) => Object.entries(sessionStorage).some(([k, v]) => k.startsWith('if.venue.keys.') && Object.hasOwn(JSON.parse(v), id)),
            resting.venueClientOrderId,
          ),
        { timeout: 20_000, message: 'the desk keeps the resting order key' },
      )
      .toBe(true);
    const venueStorage = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([k]) => k.includes('venue'))));
    run.write({ ...run.read(), limitedMarket: lim, restingOrderId: resting.venueClientOrderId, venueStorage });
  });
});

test(`${J} #4 a new order on a cancel-only market is refused, and cancel works`, async ({ page, stepPicture }) => {
  const { who, walletKey, owner } = await trader(page);
  const client = await api(who);
  const { limitedMarket: lim, restingOrderId, venueStorage } = run.read();
  if (!lim || !restingOrderId) throw new Error(`${J} #3 left no resting order, so this step has nothing to cancel`);

  await inVenueStatus(lim.symbol, 'cancel_only', async () => {
    const venueMkt = (await venueRecord(owner, '/markets')).value.find((m) => m.symbol === lim.symbol);
    expect(venueMkt?.status).toBe('cancel_only');
    await page.goto('/status');
    await expect(page.getByTestId(`status-mode-${lim.symbol}`)).toContainText('Cancel-only');

    if (venueStorage) {
      await page.addInitScript((entries) => {
        for (const [k, v] of Object.entries(entries)) sessionStorage.setItem(k, v);
      }, venueStorage);
    }
    await openVenueDesk(page, who, `/trade/spot/${lim.symbol}`, walletKey);
    await expect(page.getByTestId('dk-ticker')).toContainText('Cancel only, no new orders on this desk');
    const lockedBefore = toUnits((await venueBalance(owner, 'USDC')).locked);
    const writes = venueWrites(page);

    // New limit buy on the ticket: explained in plain words, no raw code, Buy button disabled, nothing sent.
    const buyForm = page.locator('form[data-testid="dk-form"][data-side="buy"]');
    await buyForm.getByRole('textbox', { name: 'Price', exact: true }).fill('90');
    await buyForm.getByRole('textbox', { name: 'Amount', exact: true }).fill('0.5');
    await expect(buyForm).toContainText('This market is cancel-only');
    await expect(buyForm).toContainText('you can still cancel them');
    await expect(buyForm).not.toContainText(/[a-z]+\.[a-z_]+_[a-z_]+/);
    await expect(buyForm.getByRole('button', { name: `Buy ${lim.base}`, exact: true })).toBeDisabled();
    await page.waitForTimeout(1000);
    expect(writes).toHaveLength(0);

    // Door refuses a new limit buy with 422 trade.venue.market_cancel_only, leaving balance lock untouched.
    const refused = await client.post('/api/v1/venue/prepare', {
      owner,
      signer: { role: 'owner', address: owner },
      intent: {
        kind: 'place_order',
        symbol: lim.symbol,
        side: 'buy',
        type: 'limit',
        amount: '0.5',
        price: '90',
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: orderKey(owner, `j14-4-new-${lim.base}`),
      },
    });
    expect(refused.status).toBe(422);
    expect(refused.body?.intafacedCode).toBe('trade.venue.market_cancel_only');
    expect(toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(lockedBefore);
    await stepPicture();

    // Cancel works on the venue desk: the resting order from #3 comes off the venue book and releases its lock.
    const openRow = page.getByTestId('venue-bottom').getByRole('row').filter({ hasText: lim.symbol }).first();
    await expect(openRow).toBeVisible({ timeout: 15_000 });
    await openRow.getByRole('button', { name: /^Cancel/ }).click();
    await continueInWallet(page);

    await expect
      .poll(async () => (await venueRecord(owner, '/open-orders')).value.some((o) => o.venueClientOrderId === restingOrderId), {
        timeout: 20_000,
        message: 'resting order cancelled on the venue',
      })
      .toBe(false);
    expect(lockedBefore - toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(toUnits('47.5'));
  });
});

test(`${J} #5 a market with scheduled maintenance an hour away says "Maintenance in 1 hour" on the ticket and flags it on the list; no end time reads "End time not set"`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(4 * 60_000);
  const { who, walletKey, owner } = await trader(page);
  const maint = await freshMarket('M5');
  await list(maint.symbol, minuteAgoIso());
  expect((await venueRecord(owner, '/markets')).value.some((m) => m.symbol === maint.symbol)).toBe(true);

  const key = `${J}:${process.env.JOURNEY_RUN_ID ?? 'local'}:${Date.now()}:maintenance`;
  const startsAt = new Date(Date.now() + 61 * 60_000).toISOString();
  const draft = await draftNotice({
    kind: 'maintenance',
    title: `TEST ${maint.symbol} maintenance`,
    body: 'TEST: a journey maintenance window on the local stack.',
    startsAt,
    noEnd: true,
    components: [marketComponent(maint.symbol)],
    key,
  });
  const published = await publishNotice(draft, key);
  try {
    await expect
      .poll(async () => (await marketStates()).value.markets.find((m) => m.symbol === maint.symbol)?.upcomingMaintenance, {
        timeout: 30_000,
        message: 'venue market-states carries upcoming maintenance',
      })
      .toMatchObject({ status: 'scheduled', noticeId: published.id, startsAt, endsAt: null });

    // The venue desk ticket and ticker say it.
    await openVenueDesk(page, who, `/trade/spot/${maint.symbol}`, walletKey);
    const ticket = page.getByTestId('dk-maintenance');
    await expect(ticket).toContainText('Maintenance in 1 hour');
    await expect(ticket).toContainText('End time not set');
    await expect(page.getByTestId('dk-ticker')).toContainText('Maintenance in 1 hour');
    await stepPicture();

    // The markets list flags it on that market's row.
    await page.goto('/trade');
    await page.getByRole('textbox', { name: 'Search markets', exact: true }).fill(maint.base);
    const row = page
      .getByRole('grid', { name: 'Markets', exact: true })
      .getByRole('row')
      .filter({ hasText: `${maint.base}/${maint.quote}` });
    await expect(row.getByTestId('mkt-maintenance')).toHaveText('Maintenance in 1 hour');

    // /status lists it on the market's row, and its blank end reads "End time not set".
    await page.goto('/status');
    await expect(page.getByTestId(`status-maintenance-${maint.symbol}`)).toContainText('End time not set');
  } finally {
    await cancelMaintenance(published, `${J}: TEST window cancelled at the end of the step`);
  }
  await expect
    .poll(async () => (await marketStates()).value.markets.find((m) => m.symbol === maint.symbol)?.upcomingMaintenance?.status, {
      timeout: 30_000,
    })
    .toBe('none');
});

test(`${J} #6 an order while the market session is closed: the closed-market rule is applied and explained`, async ({
  page,
  stepPicture,
}) => {
  const { who, walletKey, owner } = await trader(page);
  const client = await api(who);
  const shut = await freshMarket('S6', {
    session: {
      homeMarket: 'TEST Session',
      reopensAfterMs: 3_600_000,
      closed: true,
      closedRule: 'Orders are not queued while this market is closed',
    },
  });
  await list(shut.symbol, minuteAgoIso());

  const venueMkt = (await venueRecord(owner, '/markets')).value.find((m) => m.symbol === shut.symbol);
  expect(venueMkt?.session).toMatchObject({ known: true, value: { state: 'closed' } });
  expect(venueMkt?.session?.value?.reopensAt).toBeTruthy();

  // On /trade (with paused rows included): shows Closed + Opens, action disabled explaining orders are not queued.
  await signIn(page, who);
  await page.goto('/trade');
  await expect(page.getByRole('grid', { name: 'Markets', exact: true })).toBeVisible({ timeout: UNBUILT_MS });
  await page.getByRole('textbox', { name: 'Search markets', exact: true }).fill(shut.base);
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
  const button = row.getByRole('button', { name: /^(Trade|Buy) / });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', 'This market is closed. Orders are not queued while it is closed');

  // Door refuses any order while closed, leaving balances and open orders unchanged.
  const lockedBefore = toUnits((await venueBalance(owner, 'USDC')).locked);
  const openBefore = (await venueRecord(owner, '/open-orders')).value.length;
  const refused = await client.post('/api/v1/venue/prepare', {
    owner,
    signer: { role: 'owner', address: owner },
    intent: {
      kind: 'place_order',
      symbol: shut.symbol,
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '10',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: orderKey(owner, `j14-6-closed-${shut.base}`),
    },
  });
  expect(refused.status).toBe(422);
  expect(refused.body?.intafacedCode).toBe('trade.venue.market_closed');
  expect(toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(lockedBefore);
  expect((await venueRecord(owner, '/open-orders')).value).toHaveLength(openBefore);

  // Venue desk says Closed, when it opens, and that orders are not queued; Buy disabled.
  await openVenueDesk(page, who, `/trade/spot/${shut.symbol}`, walletKey);
  await expect(page.getByTestId('dk-ticker')).toContainText('Closed, opens', { timeout: UNBUILT_MS });
  await expect(page.getByTestId('dk-ticker')).toContainText('Orders are not queued while it is closed');
  await expect(
    page.locator('form[data-testid="dk-form"][data-side="buy"]').getByRole('button', { name: `Buy ${shut.base}`, exact: true }),
  ).toBeDisabled();
  await stepPicture();
});

test(`${J} #7 a market inside its opening window or the higher-risk zone shows a badge; a market order is refused with the window reason and a limit is accepted`, async ({
  page,
  stepPicture,
}) => {
  const { who, walletKey, key, owner } = await trader(page);
  const client = await api(who);
  const { chainId } = await venueInfo();
  const seedBook = async (mkt) => {
    const makerName = `j14-7-mk-${mkt.base}`;
    const mk = otherTraderKey(makerName);
    await testDeposit(mk.address, mkt.base, '20', `${chainId}:0x${randomBytes(32).toString('hex')}:0`);
    await testDeposit(mk.address, 'USDC', '500', `${chainId}:0x${randomBytes(32).toString('hex')}:0`);
    await otherTraderRun(makerName, {
      kind: 'place_order',
      symbol: mkt.symbol,
      side: 'sell',
      type: 'limit',
      amount: '5',
      price: '20',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: orderKey(mk.address, `j14-7-ask-${mkt.base}`),
    });
    await otherTraderRun(makerName, {
      kind: 'place_order',
      symbol: mkt.symbol,
      side: 'buy',
      type: 'limit',
      amount: '5',
      price: '19.9',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: orderKey(mk.address, `j14-7-bid-${mkt.base}`),
    });
  };

  // Create and list both markets up front so the desk's market switcher carries both in one session.
  const winEnds = new Date(Date.now() + 7 * DAY).toISOString();
  const windowed = await freshMarket('W7', { openingWindowEndsAt: winEnds });
  await list(windowed.symbol, minuteAgoIso());
  await seedBook(windowed);
  const zoned = await freshMarket('Z7', { zone: 'higher_risk', zoneOrderCap: '100' });
  await list(zoned.symbol, minuteAgoIso());
  await seedBook(zoned);

  // 1) Opening window market
  const winRecord = (await venueRecord(owner, '/markets')).value.find((m) => m.symbol === windowed.symbol);
  expect(winRecord?.openingWindowEndsAt).toBe(winEnds);

  await openVenueDesk(page, who, `/trade/spot/${windowed.symbol}`, walletKey);
  await expect(page.getByTestId('dk-opening-window')).toContainText('Opening window', { timeout: UNBUILT_MS });
  await expect(page.getByTestId('dk-opening-window')).toContainText('Limit orders only until');
  const lockedBeforeWin = toUnits((await venueBalance(owner, 'USDC')).locked);
  const writesWin = venueWrites(page);
  await expect(page.locator('[role=tab]', { hasText: /^Market$/ })).toHaveCount(0);
  await expect(page.locator('[role=tab]', { hasText: /^Limit$/ })).toBeEnabled();
  await expect(page.getByTestId('dk-type-off-market')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('dk-type-off-market')).toHaveText(
    'Market: This market takes limit orders only until its opening window ends.',
  );
  // oxlint-disable-next-line garden/no-wait-for-timeout -- proving nothing happens: no order request leaves the page
  await page.waitForTimeout(1000);
  expect(writesWin).toHaveLength(0);

  // Door refuses market order with 422 trade.venue.opening_window, accepts limit buy, then cancels cleanly.
  const winMkt = await client.post('/api/v1/venue/prepare', {
    owner,
    signer: { role: 'owner', address: owner },
    intent: {
      kind: 'place_order',
      symbol: windowed.symbol,
      side: 'buy',
      type: 'market',
      amount: '1',
      price: '20',
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: orderKey(owner, `j14-7-wm-${windowed.base}`),
    },
  });
  expect(winMkt.status).toBe(422);
  expect(winMkt.body?.intafacedCode).toBe('trade.venue.opening_window');
  expect(toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(lockedBeforeWin);

  const winKey = orderKey(owner, `j14-7-wl-${windowed.base}`);
  await walletDoorAct(client, key, {
    intent: {
      kind: 'place_order',
      symbol: windowed.symbol,
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '19',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: winKey,
    },
  });
  expect((await venueRecord(owner, '/open-orders')).value.some((o) => o.symbol === windowed.symbol)).toBe(true);
  expect(toUnits((await venueBalance(owner, 'USDC')).locked) - lockedBeforeWin).toBe(toUnits('19'));
  await walletDoorAct(client, key, { intent: { kind: 'cancel_order', symbol: windowed.symbol, clientOrderKey: winKey } });
  expect(toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(lockedBeforeWin);

  // 2) Higher-risk zone market with order cap (opened from /trade in Pro layout in the same browser session)
  const zoneRecord = (await venueRecord(owner, '/markets')).value.find((m) => m.symbol === zoned.symbol);
  expect(zoneRecord).toMatchObject({ zone: 'higher_risk', zoneOrderCap: '100' });

  await page.goto('/trade');
  await page.getByRole('button', { name: 'Pro', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search markets', exact: true }).fill(zoned.base);
  const zoneRow = page
    .getByRole('grid', { name: 'Markets', exact: true })
    .getByRole('row')
    .filter({ hasText: `${zoned.base}/${zoned.quote}` });
  const writesZone = venueWrites(page);
  await zoneRow.getByRole('button', { name: /^Trade / }).click();
  await expect(page.getByTestId('dk-zone')).toContainText('Higher-risk zone', { timeout: UNBUILT_MS });
  await expect(page.getByTestId('dk-zone')).toContainText(`Limit orders only, up to 100 ${zoned.quote} an order`);
  await expect(page.locator('[role=tab]', { hasText: /^Market$/ })).toHaveCount(0);
  await expect(page.locator('[role=tab]', { hasText: /^Limit$/ })).toBeEnabled();
  await expect(page.getByTestId('dk-type-off-market')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('dk-type-off-market')).toHaveText(
    'Market: This market is in the higher-risk zone, which takes limit orders only.',
  );
  await stepPicture();

  const lockedBeforeZone = toUnits((await venueBalance(owner, 'USDC')).locked);
  const zoneMkt = await client.post('/api/v1/venue/prepare', {
    owner,
    signer: { role: 'owner', address: owner },
    intent: {
      kind: 'place_order',
      symbol: zoned.symbol,
      side: 'buy',
      type: 'market',
      amount: '1',
      price: '20',
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: orderKey(owner, `j14-7-zm-${zoned.base}`),
    },
  });
  expect(zoneMkt.status).toBe(422);
  expect(zoneMkt.body?.intafacedCode).toBe('trade.venue.higher_risk_zone');
  expect(toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(lockedBeforeZone);
  // By now the page has had the door's round trip and more to send an order, and it sent none.
  expect(writesZone).toHaveLength(0);

  const overCap = await client.post('/api/v1/venue/prepare', {
    owner,
    signer: { role: 'owner', address: owner },
    intent: {
      kind: 'place_order',
      symbol: zoned.symbol,
      side: 'buy',
      type: 'limit',
      amount: '6',
      price: '19',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: orderKey(owner, `j14-7-zo-${zoned.base}`),
    },
  });
  expect(overCap.status).toBe(422);
  expect(overCap.body?.intafacedCode).toBe('trade.venue.zone_cap_exceeded');
  expect(toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(lockedBeforeZone);

  const zoneKey = orderKey(owner, `j14-7-zl-${zoned.base}`);
  await walletDoorAct(client, key, {
    intent: {
      kind: 'place_order',
      symbol: zoned.symbol,
      side: 'buy',
      type: 'limit',
      amount: '2',
      price: '19',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: zoneKey,
    },
  });
  expect((await venueRecord(owner, '/open-orders')).value.some((o) => o.symbol === zoned.symbol)).toBe(true);
  expect(toUnits((await venueBalance(owner, 'USDC')).locked) - lockedBeforeZone).toBe(toUnits('38'));
  await walletDoorAct(client, key, { intent: { kind: 'cancel_order', symbol: zoned.symbol, clientOrderKey: zoneKey } });
  expect(toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(lockedBeforeZone);
});

test(`${J} #8 public depth, tickers, candles and spreads: a snapshot then ordered updates, and a reconnect resumes from the last sequence`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const { who, walletKey, key, owner } = await trader(page);
  const client = await api(who);
  const tape = await freshMarket('T8');
  await list(tape.symbol, minuteAgoIso());

  const { chainId } = await venueInfo();
  const sellerName = `j14-8-seller-${tape.base}`;
  const seller = otherTraderKey(sellerName);
  await testDeposit(seller.address, tape.base, '200', `${chainId}:0x${randomBytes(32).toString('hex')}:0`);

  // Seed resting bid + ask on the TEST venue so book/ticker/spread all carry two sides.
  await otherTraderRun(sellerName, {
    kind: 'place_order',
    symbol: tape.symbol,
    side: 'sell',
    type: 'limit',
    amount: '10',
    price: '12',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: orderKey(seller.address, `j14-8-top-ask-${tape.base}`),
  });
  const topBidKey = orderKey(owner, `j14-8-top-bid-${tape.base}`);
  await walletDoorAct(client, key, {
    intent: {
      kind: 'place_order',
      symbol: tape.symbol,
      side: 'buy',
      type: 'limit',
      amount: '10',
      price: '8',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: topBidKey,
    },
  });

  const executeTrade = async (n, amount) => {
    await otherTraderRun(sellerName, {
      kind: 'place_order',
      symbol: tape.symbol,
      side: 'sell',
      type: 'limit',
      amount,
      price: '10',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: orderKey(seller.address, `j14-8-s${n}-${tape.base}`),
    });
    await walletDoorAct(client, key, {
      intent: {
        kind: 'place_order',
        symbol: tape.symbol,
        side: 'buy',
        type: 'limit',
        amount,
        price: '10',
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: orderKey(owner, `j14-8-b${n}-${tape.base}`),
      },
    });
  };
  await executeTrade(1, '5');

  // Verify REST public-book, tickers, spreads, and chart-candles directly against the venue's own records.
  const ownBook = (await venueRecord(ZERO_OWNER, '/book', { symbol: tape.symbol, depth: 20 })).value;
  const bookRes = await fetch(`${EDGE}/api/v1/venue/public-book?symbol=${encodeURIComponent(tape.symbol)}&depth=20`);
  expect(bookRes.status).toBe(200);
  const pubBook = (await bookRes.json()).value;
  expect(pubBook.sequence).toBe(ownBook.sequence);
  expect(pubBook.bids).toEqual(ownBook.bids);
  expect(pubBook.asks).toEqual(ownBook.asks);

  const tickersRes = await fetch(`${EDGE}/api/v1/venue/tickers`);
  expect(tickersRes.status).toBe(200);
  const tickerRow = (await tickersRes.json()).value[tape.symbol];
  expect(tickerRow?.bid && tickerRow?.ask, 'ticker carries both sides').toBeTruthy();
  expect(toUnits(tickerRow.spread), 'ticker spread = ask - bid').toBe(toUnits(tickerRow.ask) - toUnits(tickerRow.bid));
  expect(sameDecimal(tickerRow.bid, ownBook.bids[0].price)).toBe(true);
  expect(sameDecimal(tickerRow.ask, ownBook.asks[0].price)).toBe(true);

  // Also add one listed one-sided TEST market (ask only, no bid) so the every-row spreads check exercises both branches.
  const oneSided = await freshMarket('O8');
  await list(oneSided.symbol, minuteAgoIso());
  await testDeposit(seller.address, oneSided.base, '20', `${chainId}:0x${randomBytes(32).toString('hex')}:0`);
  await otherTraderRun(sellerName, {
    kind: 'place_order',
    symbol: oneSided.symbol,
    side: 'sell',
    type: 'limit',
    amount: '1',
    price: '10',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: orderKey(seller.address, `j14-8-onesided-${oneSided.base}`),
  });

  const spreadsRes = await fetch(`${EDGE}/api/v1/venue/spreads`);
  expect(spreadsRes.status).toBe(200);
  const spreads = (await spreadsRes.json()).value;
  const spreadRow = spreads.find((r) => r.symbol === tape.symbol);
  expect(spreadRow?.spread).toBeTruthy();
  expect(toUnits(spreadRow.spread)).toBe(toUnits(spreadRow.ask) - toUnits(spreadRow.bid));
  const oneSidedRow = spreads.find((r) => r.symbol === oneSided.symbol);
  expect(oneSidedRow, 'one-sided market appears in spreads with null bid and null spread').toMatchObject({
    bid: null,
    spread: null,
  });
  for (const r of spreads) {
    const expected = r.bid !== null && r.ask !== null ? toUnits(r.ask) - toUnits(r.bid) : null;
    expect(r.spread === null ? null : toUnits(r.spread), `${r.symbol}'s spread`).toBe(expected);
  }

  const ownCandles = (await venueRecord(ZERO_OWNER, '/candles', { symbol: tape.symbol, interval: '1m', limit: 5 })).value;
  const candlesRes = await fetch(`${EDGE}/api/v1/venue/chart-candles?symbol=${encodeURIComponent(tape.symbol)}&interval=1m&limit=5`);
  expect(candlesRes.status).toBe(200);
  const pubCandles = (await candlesRes.json()).value;
  expect(pubCandles).toEqual(ownCandles);
  for (let i = 1; i < pubCandles.length; i++) {
    expect(Date.parse(pubCandles[i].openAt)).toBeGreaterThan(Date.parse(pubCandles[i - 1].openAt));
  }

  // Multiplexed WS stream: ticker + candles snapshot followed by ordered updates on trade 2.
  const mux = await openMux(`${ORIGIN.replace(/^http/, 'ws')}/ws/stream`);
  try {
    mux.send({ op: 'subscribe', id: 'j14-8', channels: [{ ch: 'ticker' }, { ch: 'candles', market: tape.symbol, interval: '1m' }] });
    await expect
      .poll(() => mux.frames.find((f) => f.op === 'ack' && f.id === 'j14-8')?.results?.every((r) => r.ok), { timeout: 20_000 })
      .toBe(true);
    const tickerFrames = () => mux.frames.filter((f) => f.ch === 'ticker').map((f) => f.data);
    const candleFrames = () => mux.frames.filter((f) => f.ch === 'candles').map((f) => f.data);
    await expect.poll(() => tickerFrames().length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => candleFrames().length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

    const snapshot = tickerFrames()[0];
    expect(snapshot.type).toBe('snapshot');
    const tapeBefore = snapshot.tickers.find((r) => r.symbol === tape.symbol);
    expect(tapeBefore?.bid && tapeBefore?.ask).toBeTruthy();
    expect(toUnits(tapeBefore.spread)).toBe(toUnits(tapeBefore.ask) - toUnits(tapeBefore.bid));
    expect(sameDecimal(tapeBefore.last, '10')).toBe(true);
    const firstCandles = candleFrames().length;
    const openBucket = candleFrames().at(-1);
    expect(openBucket.type).toBe('candle');
    expect(sameDecimal(openBucket.c, '10')).toBe(true);

    await executeTrade(2, '3');
    await expect
      .poll(
        () =>
          candleFrames()
            .slice(firstCandles)
            .some((c) => c.t > openBucket.t || (c.t === openBucket.t && toUnits(c.v) - toUnits(openBucket.v) >= toUnits('3'))),
        { timeout: 30_000, message: `${tape.symbol} candle grows by trade 2` },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          tickerFrames()
            .slice(1)
            .some((f) => f.tickers.some((r) => r.symbol === tape.symbol && toUnits(r.volume) - toUnits(tapeBefore.volume) >= toUnits('3'))),
        { timeout: 30_000, message: `${tape.symbol} ticker updates with trade 2` },
      )
      .toBe(true);

    const ticks = tickerFrames();
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].ts).toBeGreaterThanOrEqual(ticks[i - 1].ts);
      expect(['update', 'snapshot']).toContain(ticks[i].type);
    }
    expect(ticks.slice(1).some((f) => f.type === 'update')).toBe(true);
    const bars = candleFrames();
    for (let i = 1; i < bars.length; i++) expect(bars[i].t).toBeGreaterThanOrEqual(bars[i - 1].t);
  } finally {
    mux.close();
  }

  // Public depth WS stream: snapshot -> ordered deltas -> disconnect -> mutate -> reconnect with since=held resumes via delta.
  const streamUrl = (since) =>
    `${ORIGIN.replace(/^http/, 'ws')}/ws/stream?market=${encodeURIComponent(tape.symbol)}${since === undefined ? '' : `&since=${since}`}`;
  const watcher = openStream(streamUrl());
  const first = openStream(streamUrl());
  try {
    await expect.poll(() => first.frames.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    expect(first.frames[0].type).toBe('snapshot');

    // Mutate book twice, waiting for each delta so first receives snapshot + 2 ordered deltas.
    const k1 = orderKey(owner, `j14-8-d1-${tape.base}`);
    await walletDoorAct(client, key, {
      intent: {
        kind: 'place_order',
        symbol: tape.symbol,
        side: 'buy',
        type: 'limit',
        amount: '1',
        price: '7',
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: k1,
      },
    });
    await expect.poll(() => first.frames.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await walletDoorAct(client, key, { intent: { kind: 'cancel_order', symbol: tape.symbol, clientOrderKey: k1 } });
    await expect.poll(() => first.frames.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);

    const heldSeq = continues(first.frames);
    first.close();

    // Mutate while first is disconnected; watcher confirms sequence advances past heldSeq.
    const k2 = orderKey(owner, `j14-8-d2-${tape.base}`);
    await walletDoorAct(client, key, {
      intent: {
        kind: 'place_order',
        symbol: tape.symbol,
        side: 'buy',
        type: 'limit',
        amount: '1',
        price: '6',
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: k2,
      },
    });
    await expect.poll(() => watcher.frames.at(-1)?.sequence ?? 0, { timeout: 20_000 }).toBeGreaterThan(heldSeq);

    const again = openStream(streamUrl(heldSeq));
    try {
      await expect.poll(() => again.frames.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
      expect(again.frames[0], 'reconnect resumes from held sequence via delta, never a fresh snapshot').toMatchObject({
        type: 'delta',
        fromSequence: heldSeq,
      });
      await walletDoorAct(client, key, { intent: { kind: 'cancel_order', symbol: tape.symbol, clientOrderKey: k2 } });
      await expect.poll(() => again.frames.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
      continues(again.frames, heldSeq);
    } finally {
      again.close();
    }
  } finally {
    first.close();
    watcher.close();
  }

  // Clean up resting top-of-book bid so wallet lock returns to zero, and take the step picture on the venue desk.
  await walletDoorAct(client, key, { intent: { kind: 'cancel_order', symbol: tape.symbol, clientOrderKey: topBidKey } });
  await openVenueDesk(page, who, `/trade/spot/${tape.symbol}`, walletKey);
  await expect(page.getByTestId('dk-pair')).toHaveText(`${tape.base}/${tape.quote}`);
  await stepPicture();
});

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

function openStream(url) {
  const socket = new WebSocket(url);
  const frames = [];
  socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
  return { frames, close: () => socket.close() };
}

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
  stepPicture,
}) => {
  const { who, walletKey, key, owner } = await trader(page);
  const client = await api(who);
  const ana = await freshMarket('A9');
  await list(ana.symbol, minuteAgoIso());

  const { chainId } = await venueInfo();
  const otherName = `j14-9-other-${ana.base}`;
  const other = otherTraderKey(otherName);
  await testDeposit(other.address, ana.base, '50', `${chainId}:0x${randomBytes(32).toString('hex')}:0`);

  // Trade 1 (buy-initiated): other rests ask 4 @ 25, buyer crosses -> taker buy 4 @ 25.
  await otherTraderRun(otherName, {
    kind: 'place_order',
    symbol: ana.symbol,
    side: 'sell',
    type: 'limit',
    amount: '4',
    price: '25',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: orderKey(other.address, `j14-9-t1s-${ana.base}`),
  });
  await walletDoorAct(client, key, {
    intent: {
      kind: 'place_order',
      symbol: ana.symbol,
      side: 'buy',
      type: 'limit',
      amount: '4',
      price: '25',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: orderKey(owner, `j14-9-t1b-${ana.base}`),
    },
  });
  // Trade 2 (sell-initiated): buyer rests bid 1.5 @ 24, other crosses -> taker sell 1.5 @ 24.
  await walletDoorAct(client, key, {
    intent: {
      kind: 'place_order',
      symbol: ana.symbol,
      side: 'buy',
      type: 'limit',
      amount: '1.5',
      price: '24',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: orderKey(owner, `j14-9-t2b-${ana.base}`),
    },
  });
  await otherTraderRun(otherName, {
    kind: 'place_order',
    symbol: ana.symbol,
    side: 'sell',
    type: 'limit',
    amount: '1.5',
    price: '24',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: orderKey(other.address, `j14-9-t2s-${ana.base}`),
  });

  // Read the venue's own trade tape directly to independently verify the differential and stats.
  const ownTrades = (await venueRecord(owner, '/trades', { symbol: ana.symbol, limit: 500 })).value;
  expect(ownTrades).toHaveLength(2);
  const ownBuyVol = ownTrades.filter((t) => t.takerSide === 'buy').reduce((s, t) => s + toUnits(t.amount), 0n);
  const ownSellVol = ownTrades.filter((t) => t.takerSide === 'sell').reduce((s, t) => s + toUnits(t.amount), 0n);
  expect(ownBuyVol).toBe(toUnits('4'));
  expect(ownSellVol).toBe(toUnits('1.5'));

  const reads = [];
  page.on('response', async (r) => {
    const url = new URL(r.url());
    if (r.request().method() !== 'GET' || url.pathname !== '/api/v1/venue/analytics') return;
    reads.push({ window: url.searchParams.get('window'), status: r.status(), body: await r.json().catch(() => null) });
  });
  await openVenueDesk(page, who, `/trade/spot/${ana.symbol}`, walletKey);
  await page.getByTestId('dk-analytics-link').click();
  await expect(page).toHaveURL(new RegExp(`/trade/analytics/${ana.symbol}$`));
  const utc = (iso) => iso.slice(0, 16).replace('T', ' ');

  const showsRead = async (window, named) => {
    let read;
    await expect(async () => {
      read = reads.filter((x) => x.window === window).at(-1);
      expect(read, `the room read the ${window} window`).toBeTruthy();
      expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
      expect(read.body).toMatchObject({ symbol: ana.symbol, window, trades: 2, buyTrades: 1, sellTrades: 1, complete: true });
      const b = read.body;
      expect(toUnits(b.buyVolume)).toBe(ownBuyVol);
      expect(toUnits(b.sellVolume)).toBe(ownSellVol);
      expect(toUnits(b.aggressorDifferential)).toBe(ownBuyVol - ownSellVol);
      await expect(page.getByTestId('analytics-differential').locator('strong')).toHaveText(b.aggressorDifferential, { timeout: 1_000 });
      await expect(page.getByTestId('analytics-differential')).toContainText('Aggressor differential');
      await expect(page.getByTestId('analytics-differential')).toContainText(`Bought by takers minus sold by takers, in ${ana.base}`);
      await expect(page.getByTestId('analytics-bought').locator('strong')).toHaveText(b.buyVolume, { timeout: 1_000 });
      await expect(page.getByTestId('analytics-sold').locator('strong')).toHaveText(b.sellVolume, { timeout: 1_000 });
      await expect(page.getByTestId('analytics-trades').locator('strong')).toHaveText('2', { timeout: 1_000 });
      await expect(page.getByTestId('analytics-trades')).toContainText('1 buy-initiated, 1 sell-initiated', { timeout: 1_000 });
      await expect(page.getByTestId('analytics-range')).toHaveText(`Range: ${b.low} – ${b.high}`, { timeout: 1_000 });
      await expect(page.getByTestId('analytics-window')).toHaveText(`Window: ${named}, ${utc(b.from)} to ${utc(b.to)} UTC`, {
        timeout: 1_000,
      });
      await expect(page.getByTestId('analytics-partial')).toHaveCount(0);
    }).toPass({ timeout: 20_000 });
    const span = Date.parse(read.body.to) - Date.parse(read.body.from);
    expect(span).toBe({ '5m': 5 * 60_000, '1h': 3_600_000, '24h': 86_400_000 }[window]);
  };

  await showsRead('1h', 'Last 1 hour');
  await expect(page.getByTestId('analytics-windows').getByRole('button', { name: 'Last 1 hour', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByTestId('analytics-windows').getByRole('button', { name: 'Last 24 hours', exact: true }).click();
  await showsRead('24h', 'Last 24 hours');
  await stepPicture();

  // A blank window refuses with its typed code; never defaults.
  const blank = await fetch(`${EDGE}/api/v1/venue/analytics?symbol=${encodeURIComponent(ana.symbol)}`);
  expect(blank.status).toBe(400);
  expect(JSON.stringify(await blank.json())).toContain('trade.analytics_window_unset');
});

test(`${J} #10 a USD-quoted pair and an equity-class market: the quote label reads USD`, async ({ page, stepPicture }) => {
  const { who, walletKey, owner } = await trader(page);
  const usd = await freshMarket('USD', { quoteAsset: 'USD' });
  await list(usd.symbol, minuteAgoIso());
  const ownMkt = (await venueRecord(owner, '/markets')).value.find((m) => m.symbol === usd.symbol);
  expect(ownMkt?.quoteAsset).toBe('USD');

  // The equity class is parked until an equity licence is named (AGENTS.md floor 8: never fake an unlicensed equity
  // listing): neither svc-trade's markets catalogue nor the venue read lists any equity-class row, and /trade surfaces
  // `mkt-not-offered-equity` naming the real licence blocker.
  const ownMarkets = await (await fetch(`${EDGE}/api/v1/markets?limit=500`)).json();
  expect(ownMarkets.filter((m) => m.assetClass === 'equity')).toHaveLength(0);
  const venueListed = (await marketStates()).value.markets;
  expect(venueListed.filter((m) => m.assetClass === 'equity')).toHaveLength(0);

  // The venue desk names the quote USD from the venue listing.
  await openVenueDesk(page, who, `/trade/spot/${usd.symbol}`, walletKey);
  await expect(page.getByTestId('dk-pair')).toHaveText(`${usd.base}/USD`);

  // The markets list labels that pair's quote /USD and names tokenized equities with their licence blocker.
  await page.goto('/trade');
  await page.getByRole('textbox', { name: 'Search markets', exact: true }).fill(usd.base);
  const listGrid = page.getByRole('grid', { name: 'Markets', exact: true });
  const usdRow = listGrid
    .getByRole('row')
    .filter({ hasText: usd.base })
    .filter({ has: page.getByTestId('mkt-name__quote').getByText('/USD', { exact: true }) });
  await expect(usdRow.first()).toBeVisible();
  await expect(page.getByTestId('mkt-not-offered-equity')).toContainText('Tokenized equities');
  await expect(page.getByTestId('mkt-not-offered-equity')).toContainText('Not available: licence not named');
  await stepPicture();
});

test(`${J} #11 the retail price improvement layer reads "Not available: priority class not specified", and no order accepts that flag`, async ({
  page,
  stepPicture,
}) => {
  const { who, walletKey, owner } = await trader(page);
  const client = await api(who);
  const mine = await venueMarkets();

  await page.goto('/trade');
  await expect(page.getByTestId('mkt-not-offered-rpi')).toContainText('Not available: priority class not specified');

  await openVenueDesk(page, who, `/trade/spot/${mine.open.symbol}`, walletKey);
  await expect(page.getByTestId('dk-ticker')).toContainText('Retail price improvement');
  await expect(page.getByTestId('dk-ticker')).toContainText('Not available: priority class not specified');
  await stepPicture();

  // An order requesting RPI is refused with trade.rpi_unavailable before any venue call or lock.
  const lockedBefore = toUnits((await venueBalance(owner, 'USDC')).locked);
  const openBefore = (await venueRecord(owner, '/open-orders')).value.length;
  const rpiBody = {
    owner,
    signer: { role: 'owner', address: owner },
    rpi: true,
    intent: {
      kind: 'place_order',
      symbol: mine.open.symbol,
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '10',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: orderKey(owner, `j14-11-rpi-${mine.open.base}`),
    },
  };
  const prepareRes = await client.post('/api/v1/venue/prepare', rpiBody);
  expect(prepareRes.status).toBe(400);
  expect(JSON.stringify(prepareRes.body)).toContain('trade.rpi_unavailable');
  const previewRes = await client.post('/api/v1/venue/preview', { owner, intent: { ...rpiBody.intent, rpi: true } });
  expect(previewRes.status).toBe(400);
  expect(JSON.stringify(previewRes.body)).toContain('trade.rpi_unavailable');
  expect(toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(lockedBefore);
  expect((await venueRecord(owner, '/open-orders')).value).toHaveLength(openBefore);
});
