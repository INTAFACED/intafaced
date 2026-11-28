// World: book, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fromUnits, journeyState, restartService, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { signedOnVenue, venueNow } from './venue-door.mjs';
import {
  doorOk,
  otherTraderKey,
  openVenueDesk,
  sameDecimal,
  startVenueSession,
  testDeposit,
  testVenue,
  venueForThisFile,
  venueRecord,
  venueRunState,
  venueWrites,
  walletDoorAct,
} from './venue.mjs';

// J-derivatives-33, in the running app (docs/roadmap/journeys.json): I flatten everything with one hold and hear "all
// clear" only when the venue confirms it. One test per step, titled "J-derivatives-33 #<n>", against the stack's TEST
// venue simulator. For this file only the simulator declares that a trading session's key signs its trades, as
// Hyperliquid's orders name an approved agent (`/test/switches` `tradesSignedBy`), and takes several cancels in one signed
// action; svc-trade is restarted so its door reads the venue afresh. Each step's page starts its own trading session (the
// one wallet signature, before the hold); the hold itself asks for none.
//
// TEST setup, in the journey's start: a verified TEST person with a TEST wallet, TEST 2000 USDC on the venue, our builder
// fee approved, 5x isolated on three perpetuals, and before each flatten a TEST long on each of the three (BTC-PERP,
// XFND-PERP, XBIL-PERP, bought at the TEST ladder's asks) and a resting TEST limit buy on two of them. The failed close
// of #4 is the simulator's TEST switch `refuseClose` on one owner's account. Every check reads the venue's own record
// (`/positions`, `/open-orders`, `/order-history`); the ledger is read before and after and posts nothing.
const J = 'J-derivatives-33';
const DESK = '/trade/futures';
const runId = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${runId}`);
/** The three TEST perpetuals the person holds, each with its TEST size; orders rest on the first two. */
const LEGS = [
  { symbol: 'BTC-PERP', size: '0.001' },
  { symbol: 'XFND-PERP', size: '1' },
  { symbol: 'XBIL-PERP', size: '1' },
];
const RESTING = ['BTC-PERP', 'XFND-PERP'];
/** The market whose close the venue fails in #4 (TEST switch), and the venue's reason. */
const FAILING = 'XFND-PERP';
const REASON = 'TEST: the venue refused this close';
const DECLARED = { tradesSignedBy: 'session_key', cancelsPerAction: 20 };

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
test.beforeAll(async () => {
  test.setTimeout(240_000);
  expect((await testVenue('/test/switches', DECLARED)).body).toMatchObject(DECLARED);
  await restartService('trade', { LOCAL_STACK_USER_VENUE: 'on' });
});
test.afterAll(async () => {
  await testVenue('/test/switches', { tradesSignedBy: null, cancelsPerAction: null });
});

/** The run's person and wallet, as the setup made them. */
const state = () => venueRunState(run, J);

const positionsOf = async (owner) => (await venueRecord(owner, '/positions')).value;
const openOrdersOf = async (owner) => (await venueRecord(owner, '/open-orders')).value;
const historyOf = async (owner) => (await venueRecord(owner, '/order-history')).value.map((r) => r.order);
const switches = async (body) => expect((await testVenue('/test/account-switches', { owner: state().owner, ...body })).status).toBe(200);
const marketOf = async (symbol) => {
  const m = (await testVenue('/markets', {})).body.value.find((x) => x.symbol === symbol);
  expect(m?.mark?.known, `${symbol}'s mark, as the venue publishes it`).toBe(true);
  return m;
};
/** The market's mark moved by `bps` (signed), down onto its tick: a TEST price for the setup's own orders. */
async function priceFrom(symbol, bps) {
  const m = await marketOf(symbol);
  const tick = toUnits(m.tickSize);
  const moved = (toUnits(m.mark.value) * (10_000n + bps)) / 10_000n;
  return fromUnits((moved / tick) * tick);
}

/** TEST setup, not a step: the positions and resting orders a flatten starts from, each signed through our door. */
async function holdEverything(markets = LEGS.map((l) => l.symbol)) {
  const { account, walletKey, owner } = state();
  const key = privateKeyToAccount(walletKey);
  const session = await api(account);
  const venue = await venueNow();
  for (const { symbol, size } of LEGS.filter((l) => markets.includes(l.symbol))) {
    // A TEST other trader rests an ask at the mark for the long to buy, and a bid 1% under it for the flatten's close to
    // sell into, so neither depends on what earlier rounds left of the shared TEST ladder.
    for (const [side, bps] of [
      ['sell', 0n],
      ['buy', -100n],
    ]) {
      await signedOnVenue(venue, otherTraderKey(`${J}-${runId}-${side}`), {
        kind: 'place_order',
        symbol,
        side,
        type: 'limit',
        amount: size,
        price: await priceFrom(symbol, bps),
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: `order:${J.toLowerCase()}:${symbol.toLowerCase()}:${side}-${randomBytes(4).toString('hex')}`,
        builderFee: null,
      });
    }
    await walletDoorAct(session, key, {
      intent: {
        kind: 'place_order',
        symbol,
        side: 'buy',
        type: 'market',
        amount: size,
        // The other trader's ask at the mark is the best one: 0.3% above the mark takes it.
        price: await priceFrom(symbol, 30n),
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: `order:${owner}:${symbol.toLowerCase()}:open-${randomBytes(4).toString('hex')}`,
        builderFee: null,
      },
    });
  }
  for (const symbol of RESTING.filter((s) => markets.includes(s))) {
    const size = LEGS.find((l) => l.symbol === symbol).size;
    await walletDoorAct(session, key, {
      intent: {
        kind: 'place_order',
        symbol,
        side: 'buy',
        type: 'limit',
        amount: size,
        price: await priceFrom(symbol, -500n),
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: `order:${owner}:${symbol.toLowerCase()}:rest-${randomBytes(4).toString('hex')}`,
        builderFee: null,
      },
    });
  }
  const held = await positionsOf(owner);
  for (const { symbol, size } of LEGS.filter((l) => markets.includes(l.symbol))) {
    const p = held.find((x) => x.symbol === symbol);
    expect(p, `the TEST long on ${symbol}, on the venue's record`).toMatchObject({ side: 'long' });
    expect(sameDecimal(p.size, size)).toBe(true);
  }
}

/** The desk, signed in, the TEST wallet connected and this page's trading session started (one wallet signature). */
async function desk(page) {
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  await startVenueSession(page);
  const flatten = page.getByTestId('venue-flatten');
  await expect(flatten.getByRole('button', { name: 'Flatten everything', exact: true })).toBeVisible({ timeout: 30_000 });
  return { ...s, wallet, flatten, button: flatten.getByRole('button', { name: /Flatten everything|Flattening/ }) };
}
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;

/**
 * The person holds the button and lets go once `until` holds: the flatten has started (its leg lines are shown, which only
 * a hold of 0.65 s does), or what the step waits for while the button is held.
 */
async function hold(page, button, until) {
  await button.hover();
  await page.mouse.down();
  await until();
  await page.mouse.up();
}
const started = (flatten) => () => expect(flatten.getByTestId('venue-flatten-legs')).toBeVisible({ timeout: 10_000 });
/** Two of the desk's own reads of the open orders: one poll interval of the desk (2 s) has passed. */
async function twoPolls(page) {
  for (let i = 0; i < 2; i++)
    await page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/orders/open', { timeout: 30_000 });
}

/** Every leg line the flatten shows, as `{ kind, symbol, state, text }`. */
async function legLines(flatten) {
  return flatten.locator('[data-testid="venue-flatten-legs"] li').evaluateAll((lis) =>
    lis.map((li) => ({
      kind: li.getAttribute('data-leg'),
      symbol: li.getAttribute('data-symbol'),
      state: li.getAttribute('data-state'),
      text: li.textContent ?? '',
    })),
  );
}
const settled = (flatten) => expect(flatten.getByTestId('venue-flatten-verdict')).toBeVisible({ timeout: 60_000 });

test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'flat');
    await verify(page, account);
    const walletKey = testWalletKey();
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    run.reset({ account, walletKey });
    expect(await testDeposit(owner, 'USDC', '2000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    const key = privateKeyToAccount(walletKey);
    const session = await api(account);
    const status = doorOk(await session.get('/api/v1/venue/status'));
    expect(status, 'the door reads the venue afresh: a trading session signs its trades').toMatchObject({ tradesSignedBy: 'session_key' });
    expect(status.builder, 'the TEST builder fee is set on the door').toBeTruthy();
    await walletDoorAct(session, key, {
      intent: { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
      actionKey: `approve-builder:${owner}:${J.toLowerCase()}`,
    });
    for (const { symbol } of LEGS) {
      await walletDoorAct(session, key, {
        intent: { kind: 'update_leverage', symbol, leverageBps: 50_000, marginMode: 'isolated' },
        actionKey: `leverage:${owner}:${symbol.toLowerCase()}:5x`,
      });
    }
    // The TEST other traders the setup trades against, one selling and one buying (the simulator rests one account's
    // opening orders on one side of a market only): funded, and 5x isolated on the same perpetuals.
    const venue = await venueNow();
    for (const side of ['sell', 'buy']) {
      const other = otherTraderKey(`${J}-${runId}-${side}`);
      expect(await testDeposit(other.address.toLowerCase(), 'USDC', '100000', `84532:0x${randomBytes(32).toString('hex')}:1`)).toBe(true);
      for (const { symbol } of LEGS)
        await signedOnVenue(venue, other, { kind: 'update_leverage', symbol, leverageBps: 50_000, marginMode: 'isolated' });
    }
    run.write({ ledger: await session.balances() });
  } finally {
    await page.close();
  }
});

test(`${J} #1 presses "Flatten everything" and lets go at once: the button fills while held and empties on release; nothing is sent to the venue`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  await holdEverything();
  const { owner, wallet, button } = await desk(page);
  const before = { positions: await positionsOf(owner), orders: await openOrdersOf(owner), signed: signatures(wallet) };
  const sent = venueWrites(page);

  await button.hover();
  await page.mouse.down();
  // Held: the button fills (its hold state is on while the pointer is down).
  await expect(button).toHaveAttribute('data-holding', 'true');
  await page.mouse.up();
  // Let go: it empties at once, and nothing is sent, now or once the hold would have ended (the desk polls twice).
  await expect(button).not.toHaveAttribute('data-holding');
  await twoPolls(page);
  expect(sent, 'no prepare or submit reached our door').toEqual([]);
  expect(signatures(wallet)).toBe(before.signed);
  expect(await positionsOf(owner)).toEqual(before.positions);
  expect(await openOrdersOf(owner)).toEqual(before.orders);
  await expect(page.getByTestId('venue-flatten-legs')).toHaveCount(0);
  await stepPicture();
});

test(`${J} #2 holds "Flatten everything" for 0.65 seconds: no passkey, signature prompt or confirm step; one line per leg, each order cancelled and each position closed reduce-only at market within 10 percent of the mark, each marked sent, then done`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  if ((await positionsOf(state().owner)).length === 0) await holdEverything();
  const { owner, wallet, flatten, button } = await desk(page);
  const positions = await positionsOf(owner);
  const orders = await openOrdersOf(owner);
  expect(positions).toHaveLength(LEGS.length);
  expect(orders.filter((o) => RESTING.includes(o.symbol))).toHaveLength(RESTING.length);
  const marks = Object.fromEntries(positions.map((p) => [p.symbol, p.markPrice]));
  const signed = signatures(wallet);
  const ledger = await (await api(state().account)).balances();
  // Each submit takes a moment at the venue (TEST switch), so each line is seen sent before its answer.
  await switches({ submitDelayMs: 1500 });
  // Every state each leg line shows, in order, recorded in the page as the line changes.
  await flatten.evaluate((el) => {
    const seen = {};
    globalThis.flattenLegStates = seen;
    const note = () =>
      el.querySelectorAll('[data-testid="venue-flatten-legs"] li').forEach((li) => {
        const states = (seen[`${li.getAttribute('data-leg')} ${li.getAttribute('data-symbol')}`] ??= []);
        const now = li.getAttribute('data-state');
        if (states.at(-1) !== now) states.push(now);
      });
    new MutationObserver(note).observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
  });
  try {
    await hold(page, button, started(flatten));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await settled(flatten);
  } finally {
    await switches({ submitDelayMs: 0 });
  }
  // No passkey, signature prompt or confirm step: the wallet was asked nothing, and no dialog opened.
  expect(signatures(wallet), 'the wallet was asked for no signature').toBe(signed);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const lines = await legLines(flatten);
  expect(
    lines
      .filter((l) => l.kind === 'cancel')
      .map((l) => l.symbol)
      .sort(),
  ).toEqual([...RESTING].sort());
  expect(
    lines
      .filter((l) => l.kind === 'close')
      .map((l) => l.symbol)
      .sort(),
  ).toEqual(LEGS.map((l) => l.symbol).sort());
  for (const l of lines) expect(l, `${l.kind} ${l.symbol}`).toMatchObject({ state: 'done' });
  // Each line was marked sent before it showed done.
  const shown = await page.evaluate(() => globalThis.flattenLegStates);
  expect(Object.keys(shown).sort()).toEqual(lines.map((l) => `${l.kind} ${l.symbol}`).sort());
  for (const l of lines)
    expect(shown[`${l.kind} ${l.symbol}`].slice(-2), `${l.kind} ${l.symbol} went sent, then done`).toEqual(['sent', 'done']);
  for (const l of lines.filter((x) => x.kind === 'close')) expect(l.text).toContain('reduce-only at market');

  // The venue's own record: each order cancelled, and each position closed by one reduce-only market order, no worse
  // than 10 percent from the mark, under a client order id of its own.
  const history = await historyOf(owner);
  for (const o of orders.filter((x) => RESTING.includes(x.symbol))) {
    expect(history.find((h) => h.venueClientOrderId === o.venueClientOrderId)).toMatchObject({ status: 'canceled' });
  }
  const closes = history.filter((h) => h.reduceOnly && LEGS.some((l) => l.symbol === h.symbol));
  for (const { symbol, size } of LEGS) {
    const mine = closes.filter((h) => h.symbol === symbol);
    expect(mine, `one close of ${symbol}`).toHaveLength(1);
    const close = mine[0];
    expect(close).toMatchObject({ side: 'sell', type: 'market', reduceOnly: true, status: 'filled' });
    expect(sameDecimal(close.amount, size)).toBe(true);
    const mark = toUnits(marks[symbol]);
    const worst = toUnits(close.price);
    expect(worst * 10_000n >= mark * 9_000n, `${symbol}'s close is no worse than 10% below the mark ${marks[symbol]}`).toBe(true);
    expect(worst < mark).toBe(true);
    expect(lines.find((l) => l.kind === 'close' && l.symbol === symbol).text).toContain('10% from the mark');
  }
  expect(new Set(closes.map((c) => c.venueClientOrderId)).size).toBe(closes.length);
  // The ledger posts nothing: every leg is the person's own venue action.
  expect(await (await api(state().account)).balances()).toEqual(ledger);
  await stepPicture();
});

test(`${J} #3 waits for every leg to finish: "All clear" only after the venue's account is read back with no open position and no open order, with the time it was read; the positions and orders rooms are empty, from the venue`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  if ((await positionsOf(state().owner)).length === 0) await holdEverything();
  const { owner, flatten, button } = await desk(page);
  await hold(page, button, started(flatten));
  await settled(flatten);
  const verdict = flatten.getByTestId('venue-flatten-verdict');
  await expect(verdict).toHaveAttribute('data-verdict', 'clear');
  await expect(verdict).toContainText('All clear');
  await expect(verdict).toContainText('reads no open position and no open order');
  // The time it was read, as the venue stamped its read.
  const readAt = await verdict.locator('time').getAttribute('datetime');
  expect(Number.isNaN(Date.parse(readAt))).toBe(false);
  expect(Math.abs(Date.now() - Date.parse(readAt))).toBeLessThan(120_000);
  // The venue's own record agrees: nothing open.
  expect(await positionsOf(owner)).toEqual([]);
  expect(await openOrdersOf(owner)).toEqual([]);
  // The rooms, from the venue: no position, no open order.
  const blotter = page.getByTestId('venue-blotter');
  await expect(blotter.getByTestId('venue-positions')).toContainText('No open position on the venue.', { timeout: 20_000 });
  await blotter
    .getByRole('radio', { name: 'Open orders', exact: true })
    .or(blotter.getByRole('button', { name: 'Open orders', exact: true }))
    .first()
    .click();
  await expect(blotter.getByTestId('venue-open-orders')).toContainText('No open orders on the venue.', { timeout: 20_000 });
  await blotter
    .getByRole('radio', { name: 'Positions', exact: true })
    .or(blotter.getByRole('button', { name: 'Positions', exact: true }))
    .first()
    .click();
  await stepPicture();
});

test(`${J} #4 flattens again with positions open while the venue fails the close of one market (TEST switch): "Not all clear", naming the market still open and the venue's reason; every other leg done; a Retry for that leg alone`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  await holdEverything();
  const { owner, flatten, button } = await desk(page);
  await switches({ refuseClose: { symbol: FAILING, reason: REASON } });
  await hold(page, button, started(flatten));
  await settled(flatten);
  const verdict = flatten.getByTestId('venue-flatten-verdict');
  await expect(verdict).toHaveAttribute('data-verdict', 'not_clear');
  await expect(verdict).toContainText('Not all clear');
  await expect(verdict).toContainText(`${FAILING} (${REASON} (TEST switch))`);
  const lines = await legLines(flatten);
  const failed = lines.filter((l) => l.state !== 'done');
  expect(failed).toEqual([expect.objectContaining({ kind: 'close', symbol: FAILING, state: 'failed' })]);
  expect(failed[0].text).toContain(REASON);
  // A Retry for that leg alone.
  await expect(flatten.getByRole('button', { name: /^Retry / })).toHaveCount(1);
  await expect(flatten.getByRole('button', { name: `Retry ${FAILING}`, exact: true })).toBeVisible();
  // The venue's record: only the failing market is still held; every order is cancelled.
  expect((await positionsOf(owner)).map((p) => p.symbol)).toEqual([FAILING]);
  expect(await openOrdersOf(owner)).toEqual([]);
  run.write({ failedClose: (await historyOf(owner)).filter((h) => h.symbol === FAILING && h.reduceOnly).length });
  await stepPicture();
});

test(`${J} #5 presses Retry on the failed leg: only that market's close is sent, once; "All clear" after the account reads back empty from the venue`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  // A new page holds none of #4's lines: the failed flatten is made again here, as #4 left it, then retried.
  if ((await positionsOf(state().owner)).length === 0) await holdEverything();
  const { owner, flatten, button } = await desk(page);
  // What the page prepares at our door, and the client order id the door answers for each.
  const prepares = [];
  page.on('response', async (r) => {
    if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/venue/prepare')
      prepares.push({ body: r.request().postDataJSON(), answer: await r.json().catch(() => null) });
  });
  const closeIdsOf = () =>
    prepares
      .filter((p) => p.body.intent.kind === 'place_order' && p.body.intent.symbol === FAILING)
      .map((p) => p.answer?.prepared?.venueClientOrderId);
  await switches({ refuseClose: { symbol: FAILING, reason: REASON } });
  await hold(page, button, started(flatten));
  await settled(flatten);
  await expect(flatten.getByTestId('venue-flatten-verdict')).toHaveAttribute('data-verdict', 'not_clear');
  const refusedIds = closeIdsOf();
  expect(refusedIds).toHaveLength(1);
  const refusedClose = (await legLines(flatten)).find((l) => l.state === 'failed');
  expect(refusedClose).toMatchObject({ symbol: FAILING });
  // The venue now takes the close.
  await switches({ refuseClose: null });
  const closesOf = async () => (await historyOf(owner)).filter((h) => h.symbol === FAILING && h.reduceOnly);
  const before = new Set((await closesOf()).map((h) => h.venueClientOrderId));
  const sentBefore = prepares.length;
  await flatten.getByRole('button', { name: `Retry ${FAILING}`, exact: true }).click();
  const verdict = flatten.getByTestId('venue-flatten-verdict');
  await expect(verdict).toHaveAttribute('data-verdict', 'clear', { timeout: 60_000 });
  await expect(verdict).toContainText('All clear');
  // Only that market's close was sent, once, under the same client order id as the close the venue refused.
  const sent = prepares.slice(sentBefore).map((p) => p.body);
  expect(sent.map((b) => [b.intent.kind, b.intent.symbol, b.intent.reduceOnly])).toEqual([['place_order', FAILING, true]]);
  expect(sent[0].retryRefused).toBe(true);
  expect(closeIdsOf(), 'the retry is sent under the client order id of the close the venue refused').toEqual([
    refusedIds[0],
    refusedIds[0],
  ]);
  // On the venue's record: one new close of that market, filled, under the client order id the retry was prepared with.
  const added = (await closesOf()).filter((h) => !before.has(h.venueClientOrderId));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ status: 'filled', reduceOnly: true, venueClientOrderId: refusedIds[0] });
  expect(await positionsOf(owner)).toEqual([]);
  expect(await openOrdersOf(owner)).toEqual([]);
  await stepPicture();
});

test(`${J} #6 holds the button again while a flatten is still running: no second flatten starts; each leg is sent to the venue once`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  await holdEverything();
  const { owner, flatten, button } = await desk(page);
  const legs = (await positionsOf(owner)).length + (await openOrdersOf(owner)).length;
  const submits = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/venue/submit') submits.push(r.postDataJSON().actionKey);
  });
  await switches({ submitDelayMs: 1500 });
  try {
    await hold(page, button, started(flatten));
    const sentLine = flatten.locator('[data-testid="venue-flatten-legs"] li[data-state="sent"]').first();
    await expect(sentLine).toBeVisible({ timeout: 10_000 });
    await expect(button).toHaveText('Flattening…');
    // Still running: held again while one leg's answer takes 1.5 s at the venue, longer than the 0.65 s hold, twice.
    const done = flatten.locator('[data-testid="venue-flatten-legs"] li[data-state="done"]');
    for (const n of [1, 2]) await hold(page, button, () => expect(done).toHaveCount(n, { timeout: 20_000 }));
    await settled(flatten);
  } finally {
    await switches({ submitDelayMs: 0 });
  }
  await expect(flatten.getByTestId('venue-flatten-verdict')).toHaveAttribute('data-verdict', 'clear');
  // One line per leg and one submit per leg: no second flatten started.
  expect(await legLines(flatten)).toHaveLength(legs);
  expect(submits).toHaveLength(legs);
  expect(new Set(submits).size).toBe(legs);
  // The venue's record: each close sent once.
  const closes = (await historyOf(owner)).filter((h) => h.reduceOnly);
  expect(new Set(closes.map((c) => c.venueClientOrderId)).size).toBe(closes.length);
  expect(await positionsOf(owner)).toEqual([]);
  await stepPicture();
});
