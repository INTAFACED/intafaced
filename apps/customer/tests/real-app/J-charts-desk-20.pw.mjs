// World: book, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fromUnits, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { connectWhenAsked } from './dex.mjs';
import { closedMinute, MINUTE, minuteStart } from './clock.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  doorOk,
  openVenuePage,
  otherTraderKey,
  otherTraderRun,
  testDeposit,
  testVenue,
  venueForThisFile,
  venueRecord,
  venueRunState,
  walletDoorAct,
} from './venue.mjs';

// J-charts-desk-20, in the running app on the launch model: "I replay a closed trade from my journal, with its entry,
// stop and exit appearing as the bars reach them". The person's closed TEST perp trade is on their own venue account on
// the TEST venue simulator, on the TEST perpetual XRPY-PERP that only this file trades (no makers' ladder, its mark fixed
// by its TEST oracle, so every print on it is one made here and no stop fires by itself). The Starts line, as TEST setup
// through our door, signed by the person's wallet, one minute apart so each moment falls in its own 1m bar:
//   TEST prints at 100 on each of the 12 minutes before the trade (its bars before the entry);
//   minute 0: long 1 @ 100, its stop placed at 95;
//   minute 1: the stop moved to 90 (cancelled and placed again, as the desk moves a stop), and a TEST print that minute;
//   minute 2: sold @ 102.
// Every figure a step checks is read here from the venue's own records (`/fills`, `/order-history`, `/candles`), never
// from the page or the replay's code. One test per step, titled "J-charts-desk-20 #<n>". Every figure is TEST.
const J = 'J-charts-desk-20';
const SYMBOL = 'XRPY-PERP';
const BARS_BEFORE = 10;
const runId = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${runId}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
// #3 takes the market's history away on the venue (TEST switch); it is put back whatever happens.
const keepAll = () => testVenue('/test/history-kept', { symbol: SYMBOL, fillsFrom: null, candlesFrom: null });
test.afterAll(async () => {
  await keepAll();
});

const tag = () => randomBytes(4).toString('hex');
const bucket = minuteStart;
/** A venue decimal as the page writes it: no trailing zeros. */
const plain = (decimal) => fromUnits(toUnits(decimal));

/**
 * The makers: two TEST other traders, each resting one order on XRPY-PERP for the person to take at the price chosen.
 * One rests the ask and one the bid, so each only ever opens (the TEST venue rests no reduce-only order).
 */
const MAKERS = { sell: `${J}-${runId}-asks`, buy: `${J}-${runId}-bids` };
async function makerRests(side, price) {
  const name = MAKERS[side];
  const owner = otherTraderKey(name).address.toLowerCase();
  const rested = await otherTraderRun(name, {
    kind: 'place_order',
    symbol: SYMBOL,
    side,
    type: 'limit',
    amount: '1',
    price,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${owner}:jcd20:${tag()}`,
    builderFee: null,
  });
  expect(rested.definite && rested.accepted, JSON.stringify(rested)).toBe(true);
}

async function seedPrint(at) {
  const seeded = await testVenue('/test/seed-prints', {
    symbol: SYMBOL,
    entries: [{ tradedAt: new Date(at).toISOString(), price: '100', amount: '0.1', takerSide: 'buy' }],
  });
  expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
}

/** TEST setup, not a step (the Starts line): the person and their closed trade whose stop was moved once. */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(420_000);
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'cd20');
    await verify(page, account);
    const walletKey = testWalletKey();
    const key = privateKeyToAccount(walletKey);
    const owner = key.address.toLowerCase();
    const session = await api(account);
    const act = (intent, actionKey = null) => walletDoorAct(session, key, { intent, actionKey });

    expect(await testDeposit(owner, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    for (const name of Object.values(MAKERS)) {
      const maker = otherTraderKey(name).address.toLowerCase();
      expect(await testDeposit(maker, 'USDC', '100000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    }
    const leverage = { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 50_000, marginMode: 'isolated' };
    for (const name of Object.values(MAKERS))
      expect(await otherTraderRun(name, leverage)).toMatchObject({ definite: true, accepted: true });
    await expect(() => act(leverage, `leverage:${owner}:${SYMBOL}:5x`)).toPass({ timeout: 30_000, intervals: [2_000] });
    const status = doorOk(await session.get('/api/v1/venue/status'));
    expect(status.builder, 'the TEST builder fee is set on the door').toBeTruthy();
    await act(
      { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
      `approve-builder:${owner}:jcd20`,
    );

    const order = (side, price, over = {}) => ({
      kind: 'place_order',
      symbol: SYMBOL,
      side,
      type: 'limit',
      amount: '1',
      price,
      timeInForce: 'IOC',
      reduceOnly: side === 'sell',
      clientOrderKey: `order:${owner}:jcd20:${tag()}`,
      builderFee: null,
      ...over,
    });
    const stop = (trigger) =>
      order('sell', String(Number(trigger) - 1), {
        timeInForce: 'GTC',
        reduceOnly: true,
        trigger: { price: trigger, source: 'mark', role: 'stop_loss' },
      });

    // Minute 0 starts with a fresh minute, so the entry and its stop fall in one bar; the 12 bars before it are TEST prints.
    await closedMinute(page, Date.now());
    const entryMinute = bucket(Date.now());
    for (let k = 12; k >= 1; k -= 1) await seedPrint(entryMinute - k * MINUTE + 5_000);
    await makerRests('sell', '100');
    await act(order('buy', '100'));
    const first = stop('95');
    await act(first);
    // Minute 1: the stop moved further away, and a TEST print so the minute has its bar.
    await closedMinute(page, Date.now());
    await act({ kind: 'cancel_order', symbol: SYMBOL, clientOrderKey: first.clientOrderKey });
    const moved = stop('90');
    await act(moved);
    await seedPrint(Date.now() - 1_000);
    // Minute 2: closed.
    await closedMinute(page, Date.now());
    await makerRests('buy', '102');
    await act(order('sell', '102'));
    await act({ kind: 'cancel_order', symbol: SYMBOL, clientOrderKey: moved.clientOrderKey });
    const position = (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === SYMBOL);
    expect(position, 'the position is closed on the venue').toBeFalsy();
    run.reset({ account, walletKey });
  } finally {
    await page.close();
  }
});

const state = () => venueRunState(run, J);

/**
 * The trade as the venue records it: its opening and closing fills, the stops placed on it with their times, and its
 * 1m bars from the venue from 10 before the entry bar. Each moment's bar is the minute it falls in.
 */
async function venueTrade(owner) {
  const fills = (await venueRecord(owner, '/fills', { since: new Date(Date.now() - 86_400_000).toISOString() })).value
    .filter((f) => f.symbol === SYMBOL)
    .sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt));
  expect(fills.map((f) => f.side)).toEqual(['buy', 'sell']);
  const [open, close] = fills;
  const stops = (await venueRecord(owner, '/order-history')).value
    .filter((r) => r.order.symbol === SYMBOL && r.order.trigger?.role === 'stop_loss')
    .sort((a, b) => Date.parse(a.placedAt) - Date.parse(b.placedAt))
    .map((r) => ({ price: plain(r.order.trigger.price), at: Date.parse(r.placedAt) }));
  expect(stops.map((s) => s.price)).toEqual(['95', '90']);
  const entryBar = bucket(Date.parse(open.filledAt));
  const candles = (
    await testVenue('/candles', {
      symbol: SYMBOL,
      interval: '1m',
      query: { limit: 720, since: new Date(entryBar - BARS_BEFORE * MINUTE).toISOString() },
    })
  ).body.value.map((c) => Date.parse(c.openAt));
  const entryIndex = candles.indexOf(entryBar);
  expect(entryIndex, 'the venue returns the entry bar').toBe(BARS_BEFORE);
  return {
    open,
    close,
    entry: plain(open.price),
    exit: plain(close.price),
    entryBar,
    stopBar: Math.max(entryBar, bucket(stops[0].at)),
    movedBar: bucket(stops[1].at),
    exitBar: bucket(Date.parse(close.filledAt)),
    stops,
    candles,
    start: entryIndex - BARS_BEFORE,
  };
}

/** The marks the replay must show once it has reached the bar opening at `t`, from the venue's records. */
function expectedMarks(v, t) {
  const all = [
    { mark: 'entry', price: v.entry, bar: v.entryBar },
    { mark: 'stop', price: v.stops[0].price, bar: v.stopBar },
    { mark: 'stop-moved', price: v.stops[1].price, bar: v.movedBar },
    { mark: 'exit', price: v.exit, bar: v.exitBar },
  ];
  return all.filter((m) => m.bar <= t).map((m) => ({ ...m, bar: new Date(m.bar).toISOString() }));
}

async function shownMarks(page) {
  return page
    .getByTestId('replay-marks')
    .locator('li')
    .evaluateAll((items) => items.map((li) => ({ mark: li.dataset.mark, price: li.dataset.price, bar: li.dataset.bar })));
}

const chart = (page) => page.getByTestId('trade-replay').getByRole('img', { name: /Price chart of/ });

const rowOf = (page, v) => page.locator(`[data-testid="journal-row"][data-trade="${v.open.fillId}"]`);

/** In Journal, opens the trade from its row and presses "Replay this trade" on it, as the person does. */
async function openReplay(page, v) {
  const { account, walletKey } = state();
  await openVenuePage(page, account, '/trade/journal', walletKey);
  const row = rowOf(page, v);
  await expect(row).toBeVisible({ timeout: 30_000 });
  const figures = await row.locator('td').allInnerTexts();
  const storedAt = await row.getAttribute('data-stored-at');
  await row.getByRole('link').first().click();
  const detail = page.locator(`[data-testid="journal-trade"][data-trade="${v.open.fillId}"]`);
  await expect(detail).toBeVisible({ timeout: 15_000 });
  await detail.getByRole('link', { name: 'Replay this trade', exact: true }).click();
  await expect(page.getByTestId('trade-replay')).toHaveAttribute('data-trade', v.open.fillId, { timeout: 30_000 });
  return { row: figures, storedAt };
}

test(`${J} #1 presses "Replay this trade" on the closed trade in Journal: the chart of its market in bar replay, its bars from the venue, stopped 10 bars before the entry bar, no marker of the trade yet`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const { owner } = state();
  const v = await venueTrade(owner);
  await openReplay(page, v);
  await expect(page.getByTestId('trade-replay').getByRole('heading', { level: 2 })).toHaveText(`Replay: Long ${SYMBOL}`);
  // The venue's bars, cut 10 bars before the entry bar: the first bar the venue returned up to the start bar, no later.
  await expect(page.getByTestId('replay-position')).toHaveText(`Replay: bar ${v.start + 1} of ${v.candles.length}`);
  await expect(chart(page)).toHaveAttribute('data-bars', String(v.start + 1));
  await expect(chart(page)).toHaveAttribute('data-first', String(v.candles[0]));
  await expect(chart(page)).toHaveAttribute('data-last', String(v.candles[v.start]));
  expect(v.candles[v.start]).toBe(v.entryBar - BARS_BEFORE * MINUTE);
  await expect(page.getByTestId('replay-source')).toContainText('TEST');
  await expect(page.getByTestId('replay-source')).toContainText('1m');
  // No marker of the trade yet.
  await expect(page.getByTestId('replay-marks').locator('li')).toHaveCount(0);
  await expect(page.getByTestId('replay-stop')).toHaveText('No stop at this bar.');
  await stepPicture();
});

test(`${J} #2 steps forward bar by bar: the entry marker on the entry bar, the stop line from then on, stepping to its new price on the bar it was moved, the exit marker on the exit bar; no bar or marker from later than the replay's place`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const { owner } = state();
  const v = await venueTrade(owner);
  // The moments fall in three bars, one after another, as the Starts line made them.
  expect([v.stopBar - v.entryBar, v.movedBar - v.entryBar, v.exitBar - v.entryBar]).toEqual([0, MINUTE, 2 * MINUTE]);
  await openReplay(page, v);
  const last = v.candles.indexOf(v.exitBar);
  expect(last, 'the venue returns the exit bar').toBeGreaterThan(v.start);
  for (let i = v.start + 1; i <= last; i += 1) {
    await page.getByRole('button', { name: 'Step', exact: true }).click();
    const t = v.candles[i];
    await expect(page.getByTestId('replay-position')).toHaveText(`Replay: bar ${i + 1} of ${v.candles.length}`);
    // No bar later than the replay's place.
    await expect(chart(page)).toHaveAttribute('data-bars', String(i + 1));
    await expect(chart(page)).toHaveAttribute('data-last', String(t));
    // Exactly the marks whose bar has been reached, each on its bar at its price.
    await expect.poll(() => shownMarks(page), { message: `marks at bar ${new Date(t).toISOString()}` }).toEqual(expectedMarks(v, t));
    // The stop line: none before the entry bar, the first stop from the entry bar, the moved stop from the bar it moved.
    const stopNow = t < v.stopBar ? null : t < v.movedBar ? v.stops[0].price : v.stops[1].price;
    await expect(page.getByTestId('replay-stop')).toHaveAttribute('data-price', stopNow ?? '');
    await expect(page.getByTestId('replay-stop')).toHaveText(stopNow === null ? 'No stop at this bar.' : `Stop at this bar: ${stopNow}`);
  }
  // At the exit bar every mark is drawn, the exit last, at the venue's exit price.
  expect((await shownMarks(page)).map((m) => m.mark)).toEqual(['entry', 'stop', 'stop-moved', 'exit']);
  await expect(page.getByTestId('replay-marks').locator('[data-mark="exit"]')).toHaveText(
    `Exit at ${v.exit}, bar ${new Date(v.exitBar).toISOString().replace('T', ' ').slice(0, 16)} UTC`,
  );
  await stepPicture();
});

test(`${J} #3 replays the older trade whose candles the venue no longer returns: its bars from the journal's own record, with the time they were stored; where none were kept, "bars not kept for this trade", never a made-up chart`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const { owner } = state();
  // The trade and its bars as the venue returned them, read before they go.
  const v = await venueTrade(owner);
  const kept = v.candles.filter((t) => t <= v.exitBar);
  // The Starts line's older trade: the venue keeps the market's fills and candles only from now on (TEST switch), as a
  // venue past the history it keeps.
  const now = new Date().toISOString();
  expect((await testVenue('/test/history-kept', { symbol: SYMBOL, fillsFrom: now, candlesFrom: now })).status).toBe(200);
  try {
    const since = new Date(v.entryBar - BARS_BEFORE * MINUTE).toISOString();
    const gone = await testVenue('/candles', { symbol: SYMBOL, interval: '1m', query: { limit: 720, since } });
    expect(
      gone.body.value.filter((c) => Date.parse(c.openAt) <= v.exitBar),
      'the venue no longer returns its candles',
    ).toEqual([]);
    const { storedAt } = await openReplay(page, v);
    // Its bars come from the journal's own record, named with the time they were stored: the trade's own stored time.
    const source = page.getByTestId('replay-source');
    await expect(source).toHaveAttribute('data-source', 'record');
    await expect(source).toHaveAttribute('data-stored-at', storedAt ?? '');
    await expect(source).toContainText(`stored ${new Date(storedAt ?? '').toISOString().replace('T', ' ').slice(0, 16)} UTC`);
    await expect(source).toContainText('TEST');
    // The bars kept are the venue's own 1m bars from 10 before the entry bar to the exit bar, stopped 10 bars before the
    // entry bar: never a made-up chart.
    await expect(page.getByTestId('replay-bars-none')).toHaveCount(0);
    await expect(page.getByTestId('replay-position')).toHaveText(`Replay: bar ${v.start + 1} of ${kept.length}`);
    await expect(chart(page)).toHaveAttribute('data-first', String(kept[0]));
    await expect(chart(page)).toHaveAttribute('data-last', String(kept[v.start]));
    // Stepped to the exit bar, the trade's marks appear on these bars as on the venue's.
    for (let i = v.start + 1; i < kept.length; i += 1) await page.getByRole('button', { name: 'Step', exact: true }).click();
    await expect(chart(page)).toHaveAttribute('data-last', String(v.exitBar));
    await expect.poll(() => shownMarks(page)).toEqual(expectedMarks(v, v.exitBar));
    await stepPicture();
  } finally {
    await keepAll();
  }
});

test(`${J} #4 leaves replay: the live chart again; the journal trade and its figures unchanged`, async ({ page, stepPicture }) => {
  test.setTimeout(180_000);
  const { owner } = state();
  const v = await venueTrade(owner);
  const { row: before } = await openReplay(page, v);
  await page.getByRole('button', { name: 'Step', exact: true }).click();
  await page.getByTestId('replay-leave').click();
  // The market's live chart: every bar up to now, no replay.
  await expect(page).toHaveURL(new RegExp(`/charts/${SYMBOL}\\?interval=1m$`));
  const live = page.getByRole('img', { name: /Price chart of/ }).first();
  await expect.poll(async () => Number(await live.getAttribute('data-last')), { timeout: 30_000 }).toBeGreaterThanOrEqual(v.exitBar);
  await expect.poll(async () => Number(await live.getAttribute('data-bars'))).toBeGreaterThan(v.start + 1);
  await expect(page.getByTestId('replay-position')).toHaveCount(0);
  await stepPicture();
  // The journal trade, read again, is the same row with the same figures, and those are the venue's own.
  // Back the way they came, on the same page and its TEST wallet: the replay, then the trade in Journal.
  await page.goBack();
  await expect(page).toHaveURL(/\/trade\/journal\?replay=/);
  await page.goBack();
  await expect(page).toHaveURL(/\/trade\/journal\?trade=/);
  await connectWhenAsked(page, page.getByTestId('venue-wallet-address'));
  const row = rowOf(page, v);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => row.locator('td').allInnerTexts()).toEqual(before);
  await expect(row).toHaveAttribute('data-source', 'venue');
  await expect(row).toHaveAttribute('data-symbol', SYMBOL);
  await expect(row).toHaveAttribute('data-side', 'long');
  await expect(row.locator('[data-cell="entry"]')).toHaveText(v.entry);
  await expect(row.locator('[data-cell="exit"]')).toHaveText(v.exit);
  const fees = toUnits(v.open.venueFee) + toUnits(v.open.builderFee) + toUnits(v.close.venueFee) + toUnits(v.close.builderFee);
  const net = toUnits(v.close.price) - toUnits(v.open.price) - fees;
  await expect(row.locator('[data-cell="net"]')).toHaveText(`${fromUnits(net)} ${v.close.feeAsset}`);
  expect(
    (await venueRecord(owner, '/fills', { since: new Date(Date.now() - 86_400_000).toISOString() })).value.filter(
      (f) => f.symbol === SYMBOL,
    ),
  ).toHaveLength(2);
});
