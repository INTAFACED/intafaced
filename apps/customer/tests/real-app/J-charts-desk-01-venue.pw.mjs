// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { EDGE, journeyState, toUnits } from './stack.mjs';
import { closedMinute, MINUTE, minuteStart } from './clock.mjs';
import {
  STEP_MS,
  drawnOf,
  drawsAs,
  heikinAshiOf,
  keepsRightEdgeOf,
  libraryPointsOf,
  near,
  settledViewOf,
  viewOf,
} from './charts-desk-01.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { ownSpotMarket, venueListingWrite } from './own-market.mjs';
import { otherTraderKey, otherTraderRun, testDeposit, testVenue, venueForThisFile, venueRecord } from './venue.mjs';

// J-charts-desk-01 on the launch model, in the running app against the stack's TEST venue simulator
// (docs/roadmap/journeys.json): a person opens `/charts/BTC-USDT` on the TEST venue (signed out), switches
// interval and chart style, scrolls back through venue candle history, jumps to a date, changes colours and price
// source, reads the venue's plotted numbers and tick-size axis formatting, and sees an unoffered interval refused.
// Every candle and market rule is compared straight against the TEST venue's own record (venueRecord), never from our
// own engine's book or `/ohlcv`. J-charts-desk-01.pw.mjs keeps the engine-path checks on `/charts/BTC-USDT` as
// "part of #<n>" beside this file (judged on main by tooling/ci/journey-verdict.mjs).
const J = 'J-charts-desk-01';
const SYMBOL = 'BTC-USDT';
const CHART = `/charts/${SYMBOL}`;
const DESK = `/trade/spot/${SYMBOL}`;
const VENUE_READER = otherTraderKey('charts01-live-btc').address.toLowerCase();
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const trpcData = (res) => res.json?.result?.data?.json ?? res.json?.result?.data;

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const title = (page) => page.getByTestId('chart-title').first();
const canvas = (page, symbol = SYMBOL) => page.getByRole('img', { name: `Price chart of ${symbol}`, exact: true }).first();
const pressedInterval = (page) =>
  page.getByRole('group', { name: 'Chart intervals', exact: true }).first().locator('button[aria-pressed="true"]');

const view = (page) => viewOf(canvas(page));
const settledView = (page) => settledViewOf(canvas(page));
const drawn = (page, symbol = SYMBOL) => drawnOf(canvas(page, symbol));
const libraryPoints = (page) => libraryPointsOf(canvas(page));
const keepsRightEdge = (page, interval) => keepsRightEdgeOf(canvas(page), async () => (await expectedWindow(interval)).last);

async function openChart(page, path = CHART, symbol = SYMBOL) {
  await page.goto(path);
  await expect(canvas(page, symbol)).toBeVisible();
  await expect.poll(async () => Number(await canvas(page, symbol).getAttribute('data-bars'))).toBeGreaterThan(0);
}

/** Parse a formatted price text ("60,010", "1.2345") as exact scaled bigint units. */
function shownUnits(text) {
  const clean = String(text ?? '').replace(/[,\s]/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(clean)) return null;
  return toUnits(clean);
}

/** Read candles straight from the TEST venue's own record (loopback), never through our door. */
async function venueCandles(symbol, interval, limit, since) {
  return venueRecord(VENUE_READER, '/candles', {
    symbol,
    interval,
    limit,
    ...(since ? { since: new Date(since).toISOString() } : {}),
  });
}

/**
 * The bars the chart should open with at an interval: the last 240 buckets up to the venue's current bucket, starting
 * at the first bucket that traded when history is younger than 240 buckets.
 */
async function expectedWindow(interval, symbol = SYMBOL) {
  const step = STEP_MS[interval];
  const body = await venueCandles(symbol, interval, 240);
  const rows = body.value;
  expect(rows.length, `TEST venue serves ${symbol} ${interval} candles`).toBeGreaterThan(0);
  const now = Math.floor(Date.parse(body.asOf) / step) * step;
  const first = Math.max(Math.floor(Date.parse(rows[0].openAt) / step) * step, now - 239 * step);
  return { first, last: now, bars: (now - first) / step + 1 };
}

/** A market as the TEST venue publishes it in its own record (its tick size is `tickSize`). */
async function venueMarketOf(symbol) {
  const body = await venueRecord(VENUE_READER, '/markets', {});
  const market = body.value.find((m) => m.symbol === symbol);
  expect(market, `${symbol} is published on the TEST venue`).toBeTruthy();
  return market;
}

/** The newest candle the TEST venue serves for `symbol` at `interval`. */
async function lastVenueCandle(interval, symbol = SYMBOL) {
  const body = await venueCandles(symbol, interval, 1);
  expect(body.value.length).toBeGreaterThan(0);
  return body.value[body.value.length - 1];
}

/** Read the spot desk PriceChart's main Candlestick series points directly from Lightweight Charts via React fiber. */
async function deskLibraryPoints(host) {
  return host.evaluate((el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    for (let fiber = key ? el[key] : null; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook && typeof hook === 'object' && 'next' in hook; hook = hook.next) {
        const series = hook.memoizedState?.current;
        if (
          series &&
          typeof series.seriesType === 'function' &&
          typeof series.data === 'function' &&
          series.seriesType() === 'Candlestick'
        ) {
          const points = series.data().map((p) => ({ time: p.time, open: p.open, high: p.high, low: p.low, close: p.close }));
          return { type: series.seriesType(), points };
        }
      }
    }
    return null;
  });
}

/** BTC-USDT on the TEST venue, and our listing of it open: added and listed once per stack (as J-copy-bots-otc-20 does). */
async function btcUsdtListed() {
  const venueMarkets = await venueRecord(VENUE_READER, '/markets', {});
  if (!venueMarkets.value.some((m) => m.symbol === SYMBOL)) {
    const added = await testVenue('/test/market-add', {
      symbol: SYMBOL,
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      maxOrderQty: '10',
      maxOrderNotional: '1000000',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.label).toBe('TEST');
  }
  const ctx = await makeContext({ log: () => undefined });
  const sessions = await approverSessions(ctx);
  const listed = await ctx.edge.query('trade', 'admin.venueMarkets.list', undefined, await sessions.a.tradeOpsToken());
  const row = trpcData(listed)?.markets.find((m) => m.symbol === SYMBOL);
  if (row?.listing?.open) return;
  await venueListingWrite(
    J,
    SYMBOL,
    'trade.venue_listing_set',
    'listingSet',
    { opensAt: new Date(Date.now() - 60_000).toISOString() },
    String(row?.listing?.version ?? 0),
  );
}

/** Execute one real signed TEST trade on the TEST venue against a resting maker ask so a live print lands now. */
async function executeLiveVenueTrade(symbol, price, amount, tag) {
  const sellerName = `charts01-seller-${tag}`;
  const buyerName = `charts01-buyer-${tag}`;
  const seller = otherTraderKey(sellerName).address.toLowerCase();
  const buyer = otherTraderKey(buyerName).address.toLowerCase();
  const [base, quote] = symbol.split('-');
  expect(await testDeposit(seller, base, '100', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  expect(await testDeposit(buyer, quote, '100000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  const suffix = randomBytes(4).toString('hex');
  const sell = await otherTraderRun(sellerName, {
    kind: 'place_order',
    symbol,
    side: 'sell',
    type: 'limit',
    amount,
    price,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:jcd01:sell:${tag}:${suffix}`,
    builderFee: null,
  });
  expect(sell.accepted, JSON.stringify(sell)).toBe(true);
  const buy = await otherTraderRun(buyerName, {
    kind: 'place_order',
    symbol,
    side: 'buy',
    type: 'limit',
    amount,
    price,
    timeInForce: 'IOC',
    reduceOnly: false,
    clientOrderKey: `order:jcd01:buy:${tag}:${suffix}`,
    builderFee: null,
  });
  expect(buy.accepted, JSON.stringify(buy)).toBe(true);
}

/**
 * TEST setup (not a step): list BTC-USDT on the TEST venue (if not already open), seed past TEST prints spanning
 * 90 hours (for 15m history > 240 bars and an earlier empty region inside the 7.5-day 720-bar 15m window) plus 320
 * consecutive 1m prints (for 1m scroll-back > 240 bars) and one live signed trade, plus one verified account for #1's
 * spot-desk verification, and one 4-decimal own TEST venue spot market for #7's tick-size check.
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().seeded && run.read().account && run.read().smallMarket) return;
  test.setTimeout(300_000);
  await btcUsdtListed();
  const nowMin = minuteStart(Date.now());
  const entries = [];
  // 100 prints spaced every 30 min from 90 h ago to 40.5 h ago (inside 7.5 d 15m depth, older than 240 15m bars = 60 h).
  for (let i = 0; i < 100; i += 1) {
    const t = nowMin - (90 * 60 - i * 30) * MINUTE;
    const price = 59500 + ((i * 19) % 420);
    entries.push({ tradedAt: new Date(t).toISOString(), price: String(price), amount: '0.02', takerSide: i % 2 === 0 ? 'buy' : 'sell' });
  }
  // 320 prints spaced every 1 min from 325 min ago to 6 min ago (older than 240 1m bars, inside 720 1m depth), with two
  // prints in several buckets so open/high/low/close vary and Heikin Ashi differs from plain candles.
  for (let i = 0; i < 320; i += 1) {
    const t = nowMin - (325 - i) * MINUTE;
    const base = 59800 + ((i * 23) % 350);
    entries.push({ tradedAt: new Date(t + 5_000).toISOString(), price: String(base), amount: '0.01', takerSide: 'buy' });
    if (i % 3 === 0) {
      entries.push({ tradedAt: new Date(t + 25_000).toISOString(), price: String(base + 37), amount: '0.01', takerSide: 'sell' });
    }
  }
  const seeded = await testVenue('/test/seed-prints', { symbol: SYMBOL, entries });
  expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
  // One live signed TEST trade on BTC-USDT so the current 1m/15m bucket has a live print.
  await executeLiveVenueTrade(SYMBOL, '60010', '0.001', 'init');

  // A second TEST venue spot market with a 4-decimal tick size (0.0001) and one real signed trade for #7.
  const small = await ownSpotMarket(J, 'JCD', 'A', { tickSize: '0.0001', lotSize: '1' });
  await executeLiveVenueTrade(small.symbol, '1.2345', '10', 'small');

  // One verified TEST account for #1's spot-desk verification.
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'jcd1');
    await verify(page, account);
    run.reset({ seeded: true, account, smallMarket: small.symbol });
  } finally {
    await page.close();
  }
});

test(`${J} #1 opens /charts/BTC-USDT on the launch model and sees the last bars at the saved interval with a header naming both`, async ({
  page,
  stepPicture,
}) => {
  // Signed out on /charts/BTC-USDT: draws the TEST venue's own bars (never our engine's).
  await openChart(page);
  await expect(title(page)).toHaveText(`${SYMBOL} · 15m`);
  await expect(pressedInterval(page)).toHaveText('15m');
  await expect(page.getByTestId('chart-test').first()).toBeVisible();
  await expect
    .poll(
      async () => {
        const [want, got] = [await expectedWindow('15m'), await drawn(page)];
        return [got.heldFirst === want.first, got.heldLast === want.last, got.held === want.bars, got.bars === got.held];
      },
      { timeout: 30_000 },
    )
    .toEqual([true, true, true, true]);
  await expect(canvas(page).locator('canvas').first()).toBeVisible();

  // The saved interval: picking 1h persists across reloads, header and bars both.
  await page.getByRole('group', { name: 'Chart intervals', exact: true }).first().getByRole('button', { name: '1h', exact: true }).click();
  await expect(title(page)).toHaveText(`${SYMBOL} · 1h`);
  await page.goto(CHART);
  await expect(title(page)).toHaveText(`${SYMBOL} · 1h`);
  await expect(pressedInterval(page)).toHaveText('1h');
  await expect.poll(async () => (await drawn(page)).heldLast, { timeout: 30_000 }).toBe((await expectedWindow('1h')).last);
  await stepPicture();

  // The spot desk shows the same venue market's chart body: real canvas, 1m library bars matching the TEST venue's
  // 1m candle window and OHLC, and newest close matching the TEST venue's newest 1m close.
  const { account } = run.read();
  await signIn(page, account);
  await page.goto(DESK);
  const venueChart = page.getByTestId('venue-chart').first();
  const desk = venueChart.getByRole('img', { name: `Price chart of ${SYMBOL}`, exact: true }).first();
  await expect(desk).toBeVisible({ timeout: 30_000 });
  await expect(venueChart.locator('canvas').first()).toBeVisible();
  const deskIntervals = venueChart.getByRole('group', { name: 'Chart intervals', exact: true });
  await deskIntervals.getByRole('button', { name: '1m', exact: true }).click();
  await expect(deskIntervals.getByRole('button', { name: '1m', exact: true })).toHaveAttribute('aria-pressed', 'true');
  let deskBars = [];
  await expect
    .poll(
      async () => {
        const [want, latest, series] = [
          await expectedWindow('1m'),
          await lastVenueCandle('1m'),
          await deskLibraryPoints(venueChart.getByTestId('pc-host').first()),
        ];
        deskBars = series?.points ?? [];
        const legendClose = shownUnits(await desk.getByTestId('pc-legend').locator('b').nth(3).textContent());
        return [
          series?.type === 'Candlestick',
          deskBars.length === want.bars,
          deskBars[0]?.time * 1000 === want.first,
          deskBars[deskBars.length - 1]?.time * 1000 === want.last,
          legendClose !== null && legendClose === toUnits(latest.closePrice),
        ];
      },
      { timeout: 30_000 },
    )
    .toEqual([true, true, true, true, true]);
  const venue1m = (await venueCandles(SYMBOL, '1m', 240)).value;
  const byTime = new Map(venue1m.map((row) => [Math.floor(Date.parse(row.openAt) / 1000), row]));
  const shared = deskBars.slice(0, -1).filter((b) => byTime.has(b.time));
  expect(shared.length, 'TEST venue serves 1m candles among the bars the spot desk chart draws').toBeGreaterThan(0);
  for (const b of shared) {
    const row = byTime.get(b.time);
    expect([b.open, b.high, b.low, b.close], `desk 1m candle at ${b.time}`).toEqual([
      Number(row.openPrice),
      Number(row.highPrice),
      Number(row.lowPrice),
      Number(row.closePrice),
    ]);
  }
});

test(`${J} #2 picks 1h on the launch model, then another interval from More, and the pressed one is marked`, async ({
  page,
  stepPicture,
}) => {
  await openChart(page);
  await page.getByRole('group', { name: 'Chart intervals', exact: true }).first().getByRole('button', { name: '1h', exact: true }).click();
  await expect(title(page)).toHaveText(`${SYMBOL} · 1h`);
  await expect(pressedInterval(page)).toHaveText('1h');
  await keepsRightEdge(page, '1h');
  await page.getByRole('button', { name: /More/ }).first().click();
  await page.getByRole('menuitem', { name: '30m', exact: true }).click();
  await expect(title(page)).toHaveText(`${SYMBOL} · 30m`);
  await expect(page.locator('[data-testid="cw-more"][data-active]').first()).toContainText('30m');
  await expect(pressedInterval(page)).toHaveCount(0);
  await keepsRightEdge(page, '30m');
  await stepPicture();
});

test(`${J} #3 switches between candles, bars, line, area, columns and Heikin Ashi on the launch model, and the choice is kept`, async ({
  page,
  stepPicture,
}) => {
  await openChart(page);
  const styles = page.getByRole('group', { name: 'Chart style', exact: true }).first();
  const pick = async (label, id) => {
    await styles.getByRole('button', { name: label, exact: true }).click();
    await expect(canvas(page)).toHaveAttribute('data-style', id);
    await expect(styles.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
  };

  // The plain bars match the TEST venue's own 15m candles, open, high, low and close.
  await pick('Candles', 'candles');
  let bars = [];
  await expect
    .poll(async () => {
      const got = await libraryPoints(page);
      const held = await drawn(page);
      bars = got.points;
      return [got.type, got.own, got.points.length === held.held, got.points[0]?.time * 1000 === held.heldFirst];
    })
    .toEqual(['Candlestick', true, true, true]);
  const venueRows = (await venueCandles(SYMBOL, '15m', 240)).value;
  const byTime = new Map(venueRows.map((row) => [Math.floor(Date.parse(row.openAt) / 1000), row]));
  const shared = bars.slice(0, -1).filter((b) => byTime.has(b.time));
  expect(shared.length, 'TEST venue serves candles among the bars the chart draws').toBeGreaterThan(0);
  for (const b of shared) {
    const row = byTime.get(b.time);
    expect([b.open, b.high, b.low, b.close], `the venue candle at ${b.time}`).toEqual([
      Number(row.openPrice),
      Number(row.highPrice),
      Number(row.lowPrice),
      Number(row.closePrice),
    ]);
  }
  expect(
    heikinAshiOf(bars)
      .slice(0, -1)
      .some((ha, i) => !near(ha.close, bars[i].close) || !near(ha.open, bars[i].open)),
  ).toBe(true);

  for (const [label, id, kind] of [
    ['Bars', 'bars', 'Bar'],
    ['Line', 'line', 'Line'],
    ['Area', 'area', 'Area'],
    ['Columns', 'columns', 'Histogram'],
    ['Heikin Ashi', 'heikin-ashi', 'Candlestick'],
    ['Candles', 'candles', 'Candlestick'],
  ]) {
    await pick(label, id);
    await expect
      .poll(async () => {
        const held = await drawn(page);
        const got = await libraryPoints(page);
        return [
          held.type,
          held.bars === held.held,
          held.first === held.heldFirst,
          held.last === held.heldLast,
          got.type,
          got.own,
          drawsAs(id, got.points, bars),
        ];
      })
      .toEqual([kind, true, true, true, kind, true, 'ok']);
  }

  // Choice persists across a reload on this device.
  await pick('Heikin Ashi', 'heikin-ashi');
  await page.reload();
  await expect(canvas(page)).toHaveAttribute('data-style', 'heikin-ashi');
  await expect(styles.getByRole('button', { name: 'Heikin Ashi', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => {
      const held = await drawn(page);
      const got = await libraryPoints(page);
      return [
        held.type,
        held.bars === held.held,
        held.first === held.heldFirst,
        held.last === held.heldLast,
        got.type,
        got.own,
        drawsAs('heikin-ashi', got.points, bars),
      ];
    })
    .toEqual(['Candlestick', true, true, true, 'Candlestick', true, 'ok']);
  await stepPicture();
});

test(`${J} #4 scrolls back to the oldest bar on the launch model, more history loads with a stated depth, and keys zoom and pan`, async ({
  page,
  stepPicture,
}) => {
  await openChart(page, `${CHART}?interval=1m`);
  const before = Number(await canvas(page).getAttribute('data-bars'));
  await expect(page.getByTestId('chart-depth').first()).toContainText(`${before} bars loaded. Scroll back for more.`);
  const firstBefore = Number(await canvas(page).getAttribute('data-first'));
  await canvas(page).focus();
  const v0 = await settledView(page);
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await expect
    .poll(async () => {
      const v = await view(page);
      return v.to - v.from;
    })
    .toBeLessThan(v0.to - v0.from);
  const v1 = await settledView(page);
  expect(Math.abs(v1.to - v0.to)).toBeLessThan(1);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await view(page)).to).toBeCloseTo(v1.to - 10, 0);
  const panned = await settledView(page);
  expect(panned.from).toBeCloseTo(v1.from - 10, 0);
  expect(panned.to).toBeCloseTo(v1.to - 10, 0);
  const plotBox = await canvas(page).boundingBox();
  await page.mouse.move(plotBox.x + plotBox.width / 2, plotBox.y + plotBox.height / 2);
  await page.mouse.wheel(0, -400);
  await expect
    .poll(async () => {
      const v = await view(page);
      return v.to - v.from;
    })
    .toBeLessThan(panned.to - panned.from - 1);
  await settledView(page);

  for (let i = 0; i < 12; i += 1) await page.keyboard.press('-');
  for (let i = 0; i < 40; i += 1) await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('chart-depth').first()).toContainText(/bars loaded, from .+\. This interval keeps the last 720 bars/);
  const deepSince = (Math.floor(Date.now() / STEP_MS['1m']) - 719) * STEP_MS['1m'];
  await closedMinute(page, deepSince);
  const deepRows = (await venueCandles(SYMBOL, '1m', 720, deepSince)).value;
  expect(deepRows.length, 'TEST venue serves deeper 1m history than the opening 240-bar window').toBeGreaterThan(0);
  const venueFirst = Math.floor(Date.parse(deepRows[0].openAt) / STEP_MS['1m']) * STEP_MS['1m'];
  expect(venueFirst).toBeLessThan(firstBefore);
  await expect
    .poll(async () => {
      const got = await drawn(page);
      return [got.held > before, got.heldFirst === venueFirst, got.held === (got.heldLast - venueFirst) / STEP_MS['1m'] + 1];
    })
    .toEqual([true, true, true]);
  const after = Number(await canvas(page).getAttribute('data-bars'));
  expect(after).toBeGreaterThan(before);
  await expect(page.getByTestId('chart-depth').first()).toContainText(`${after} bars loaded, from `);

  const box = await canvas(page).boundingBox();
  await page.keyboard.press('Home');
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  const v2 = await settledView(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await view(page)).from).toBeLessThan(v2.from - 1);
  const v3 = await settledView(page);
  expect(v3.to - v3.from).toBeCloseTo(v2.to - v2.from, 0);
  await stepPicture();
});

test(`${J} #5 jumps to a date on the launch model and sees it, or is told there is no data that far back`, async ({
  page,
  stepPicture,
}) => {
  await openChart(page, `${CHART}?interval=15m`);
  const date = page.getByLabel('Go to date', { exact: true }).first();
  const go = async (ms) => {
    const at = new Date(ms);
    await date.fill(new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    await page.getByRole('button', { name: 'Go', exact: true }).first().click();
  };
  const note = page.getByTestId('chart-date-note');
  // Two years back: older than the 720 bars a 15m chart keeps (7.5 days).
  await go(Date.now() - 730 * 86_400_000);
  await expect(note).toContainText('older than the 720 bars this interval keeps');
  // Inside those 720 bars but two hours before the earliest trade on the TEST venue: no data.
  const step = STEP_MS['15m'];
  const since = (Math.floor(Date.now() / step) - 719) * step;
  await closedMinute(page, since);
  const deep = (await venueCandles(SYMBOL, '15m', 720, since)).value;
  const earliest = Math.min(...deep.map((row) => Date.parse(row.openAt)));
  expect(earliest - 2 * 3_600_000, 'TEST venue history starts inside the 7.5-day 15m window').toBeGreaterThan(since);
  await go(earliest - 2 * 3_600_000);
  await expect(note).toContainText('There’s no data that far back: this market has no trades from that date until');
  // A time that has bars, 100 bars before the newest: centres that bar and clears the note.
  await canvas(page).focus();
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('+');
  const before = await drawn(page);
  const target = before.heldLast - 100 * STEP_MS['15m'];
  await go(target);
  await expect(note).toHaveCount(0);
  await expect
    .poll(async () => {
      const [got, v] = [await drawn(page), await view(page)];
      const index = (target - got.heldFirst) / STEP_MS['15m'];
      return Math.abs((v.from + v.to) / 2 - index) <= 1 && v.to < got.bars - 1;
    })
    .toBe(true);
  await stepPicture();
});

test(`${J} #6 changes the colour scheme and the price source on the launch model; a source the market does not serve is refused`, async ({
  page,
  stepPicture,
}) => {
  await openChart(page);
  const themeBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--if-bg').trim());
  expect(themeBg).not.toBe('');
  await expect.poll(async () => (await drawn(page)).bg).toBe(themeBg);
  const standard = await drawn(page);
  expect(standard.up).not.toBe(standard.down);
  const colours = page.getByRole('combobox', { name: 'Colours', exact: true }).first();
  await colours.selectOption({ label: 'Red up, green down' });
  await expect(canvas(page)).toHaveAttribute('data-scheme', 'inverted');
  await expect.poll(async () => [(await drawn(page)).up, (await drawn(page)).down]).toEqual([standard.down, standard.up]);
  await page.reload();
  await expect(canvas(page)).toHaveAttribute('data-scheme', 'inverted');
  await expect.poll(async () => [(await drawn(page)).up, (await drawn(page)).down]).toEqual([standard.down, standard.up]);
  const market = await venueMarketOf(SYMBOL);
  expect(market.kind).toBe('spot');
  expect(market.mark.known).toBe(false);
  const source = page.getByRole('combobox', { name: 'Price source', exact: true }).first();
  await source.selectOption({ label: 'Best bid' });
  const refusal = page.locator('[data-code="trade.chart.basis_unpublished"]').first();
  await expect(refusal).toContainText('Best bid is unavailable here');
  await expect(refusal).toContainText('last trade prices');
  await expect(source).toHaveValue('last');
  await source.selectOption({ label: 'Mark price' });
  await expect(refusal).toContainText('Mark price is unavailable here');
  await expect
    .poll(
      async () => {
        const latest = await lastVenueCandle('15m');
        const shown = shownUnits(await page.getByTestId('chart-legend').first().locator('b').nth(3).textContent());
        return shown !== null && shown === toUnits(latest.closePrice);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await stepPicture();
});

test(`${J} #7 reads the numbers the chart plots on the launch model: the venue's bars in seconds, the axis format from the tick size`, async ({
  page,
  stepPicture,
}) => {
  // Place a fresh live signed trade on BTC-USDT at a distinct price so the newest 1m bar updates from the venue.
  await executeLiveVenueTrade(SYMBOL, '60005', '0.002', 'step7');
  await openChart(page, `${CHART}?interval=1m`);
  const legend = page.getByTestId('chart-legend').first();
  await expect
    .poll(
      async () => {
        const latest = await lastVenueCandle('1m');
        const shown = shownUnits(await legend.locator('b').nth(3).textContent());
        return shown !== null && shown === toUnits(latest.closePrice);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  // Plotted library bars are built from the TEST venue's own 1m candles with epoch-second bar times (not ms).
  let plotted = [];
  await expect
    .poll(
      async () => {
        const [got, lib, latest] = [await drawn(page), await libraryPoints(page), Date.parse((await lastVenueCandle('1m')).openAt)];
        plotted = lib.points;
        return [
          lib.type === 'Candlestick',
          lib.own,
          plotted.length === got.held,
          plotted[0]?.time * 1000 === got.heldFirst,
          plotted[plotted.length - 1]?.time * 1000 === got.heldLast,
          got.last === got.heldLast,
          got.first === got.heldFirst,
          minuteStart(got.last) === got.last,
          minuteStart(latest) === latest,
          latest <= got.last,
        ];
      },
      { timeout: 30_000 },
    )
    .toEqual([true, true, true, true, true, true, true, true, true, true]);
  for (const b of plotted) {
    expect(b.time, 'bar time is in epoch seconds, not milliseconds').toBeGreaterThan(1_000_000_000);
    expect(b.time, 'bar time is in epoch seconds, not milliseconds').toBeLessThan(10_000_000_000);
    expect(b.time % 60, '1m bar time sits on a whole minute in seconds').toBe(0);
  }
  const venueRows = (await venueCandles(SYMBOL, '1m', 240)).value;
  const byTime = new Map(venueRows.map((row) => [Math.floor(Date.parse(row.openAt) / 1000), row]));
  const shared = plotted.slice(0, -1).filter((b) => byTime.has(b.time));
  expect(shared.length, 'TEST venue serves 1m candles among the bars the chart plots').toBeGreaterThan(0);
  for (const b of shared) {
    const row = byTime.get(b.time);
    expect([b.open, b.high, b.low, b.close], `plotted 1m candle at ${b.time}`).toEqual([
      Number(row.openPrice),
      Number(row.highPrice),
      Number(row.lowPrice),
      Number(row.closePrice),
    ]);
  }

  // Axis format comes from each venue market's published tick size: BTC-USDT (0.1 -> 1 decimal) and our 0.0001 market (4 decimals).
  const { smallMarket } = run.read();
  for (const [symbol, expectedTick, expectedFormat, pattern] of [
    [SYMBOL, '0.1', '0.0', /^[\d,]+\.\d$/],
    [smallMarket, '0.0001', '0.0000', /^[\d,]+\.\d{4}$/],
  ]) {
    const tick = (await venueMarketOf(symbol)).tickSize;
    expect(tick).toBe(expectedTick);
    if (symbol !== SYMBOL) await openChart(page, `/charts/${symbol}?interval=1m`, symbol);
    const chart = canvas(page, symbol);
    await expect(chart).toHaveAttribute('data-drawn-format', expectedFormat);
    await expect(chart).toHaveAttribute('data-drawn-min-move', String(Number(tick)));
    const shown = page.getByTestId('chart-legend').first().locator('b');
    for (let i = 0; i < 4; i += 1) await expect(shown.nth(i)).toHaveText(pattern);
  }
  await stepPicture();
});

test(`${J} #8 opens a symbol at an interval the feed does not offer on the launch model and is told so by name`, async ({
  page,
  stepPicture,
}) => {
  const market = await venueMarketOf(SYMBOL);
  expect(market.symbol).toBe(SYMBOL);
  await openChart(page, `${CHART}?interval=3d`);
  const note = page.locator('[data-code="trade.datafeed.interval_unsupported"]');
  await expect(note).toContainText('doesn’t offer the 3d interval');
  await expect(title(page)).toHaveText(`${SYMBOL} · 15m`);
  await expect(
    page.getByRole('group', { name: 'Chart intervals', exact: true }).first().getByRole('button', { name: '3d', exact: true }),
  ).toHaveCount(0);
  await expect.poll(async () => (await drawn(page)).heldLast, { timeout: 30_000 }).toBe((await expectedWindow('15m')).last);
  // The public venue candles route itself refuses the unoffered interval with a typed code.
  const refused = await fetch(`${EDGE}/api/v1/venue/chart-candles?symbol=${encodeURIComponent(SYMBOL)}&interval=3d`);
  expect(refused.status).toBe(400);
  expect((await refused.json()).intafacedCode).toBe('trade.venue_request_invalid');
  await stepPicture();
});
