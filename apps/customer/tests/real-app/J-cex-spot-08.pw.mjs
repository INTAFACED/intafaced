import { test, expect } from './journey.mjs';
import { api, bestPrices, fromUnits, fund, journeyState, otherTrader, times, toUnits } from './stack.mjs';
import { confirm, deskPath, fundedTrader, held, openDesk, openOrders, placements, previewed, reviewSheet } from './desk.mjs';

// J-cex-spot-08, in the running app (docs/roadmap/journeys.json): a person protects a position with stops, an OCO and a
// bracket. One test per step, titled "J-cex-spot-08 #<n>", run in order on one TEST account funded with TEST USDT and
// TEST BTC through the real ledger. Orders are placed on the desk's own ticket; the API reads say what is held and
// what rests on the book. The stack's other TEST trader is the buyer who takes a take-profit leg, and the seller who
// fills an OTO buy.
const J = 'J-cex-spot-08';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const SYMBOL = 'BTC/USDT';
const AMOUNT = '0.001';

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

const sessions = new Map();
async function client(who) {
  if (!sessions.has(who.email)) sessions.set(who.email, await api(who));
  return sessions.get(who.email);
}

const balances = async (who) => (await client(who)).balances();
async function orderById(who, id) {
  const { status, body } = await (await client(who)).get(`/api/v1/orders/${id}?symbol=${encodeURIComponent(SYMBOL)}`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}
async function bookAt(side, price) {
  const { body } = await bestPrices(SYMBOL, 100);
  return (side === 'buy' ? body.bids : body.asks).filter(([p]) => toUnits(p) === toUnits(price)).map(([, amount]) => amount);
}

/** `price` x percent / 100, on the whole-USDT grid (always a multiple of the tick). */
const pct = (price, percent) => fromUnits(((toUnits(price) * BigInt(percent)) / 100n / toUnits('1')) * toUnits('1'));
/** "64000" as the desk writes a USDT price: "64,000.00". */
const shown = (price) => Number(price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const tab = (page, name) => page.locator('[role=tab]', { hasText: new RegExp(`^${name}$`) });
const form = (page, side) => page.locator(`form[data-testid="dk-form"][data-side=${side}]`);
const field = (page, side, name) => form(page, side).getByRole('textbox', { name, exact: true });
const openTable = (page) => page.getByTestId('dk-bottom-body').locator('table');
const rowOf = (page, id) =>
  openTable(page)
    .locator('tbody tr')
    .filter({ has: page.locator(`a[data-testid="dk-order-link"][href$="${encodeURIComponent(id)}"]`) });

/** Each step starts from no open orders and nothing held, so a step that failed earlier leaves nothing behind for this one. */
async function fresh(who) {
  if ((await openOrders(who)).length > 0) await (await client(who)).delete(`/api/v1/orders?symbol=${encodeURIComponent(SYMBOL)}`);
  await expect.poll(async () => (await openOrders(who)).length, { timeout: 20_000 }).toBe(0);
  await expect
    .poll(
      async () => {
        const now = await balances(who);
        return held(now, 'BTC') + held(now, 'USDT');
      },
      { timeout: 20_000 },
    )
    .toBe(0n);
}

async function deskFor(page, who) {
  await fresh(who);
  await openDesk(page, who);
  // The pointer leaves the top bar, so its hover menu never covers the ticket.
  await page.mouse.move(0, 600);
}

/** Fill the ticket for `type` on `side` (fields by label), wait for the desk's preview, then press Buy/Sell and return the review. */
async function review(page, side, type, fields) {
  await tab(page, type).click();
  const entries = Object.entries(fields);
  for (const [name, value] of entries.slice(0, -1)) await field(page, side, name).fill(value);
  const [lastName, lastValue] = entries[entries.length - 1];
  await previewed(page, () => field(page, side, lastName).fill(lastValue));
  await page.getByRole('button', { name: side === 'buy' ? 'Buy BTC' : 'Sell BTC' }).click();
  const sheet = reviewSheet(page);
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Confirm the review and return the order the desk placed (its POST answer). */
async function place(page, side) {
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/orders' && r.request().method() === 'POST');
  await confirm(page, side);
  const res = await answer;
  expect(res.status(), await res.text()).toBeLessThan(300);
  return res.json();
}

async function openOrdersTab(page) {
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
}

test(`${J} #1 places a stop-limit with a trigger and a limit: trigger stored, funds held, off the book, and cancel releases them`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  // A failed sign-up leaves no account behind for the later steps, never the last run's.
  run.reset({});
  const who = await fundedTrader(page, 'js8', '5000');
  expect(fund(who.email, 'BTC', '0.02').tx).toBeTruthy();
  run.reset({ account: who });
  await deskFor(page, who);

  // A buy stop-limit above the market: it waits for a trade at its stop price, then buys at up to its limit.
  const { ask } = await bestPrices();
  const stop = pct(ask, 104);
  const limit = pct(ask, 105);
  const sheet = await review(page, 'buy', 'Stop-limit', { 'Stop price': stop, Price: limit, Amount: AMOUNT });
  await expect(sheet).toContainText(`${shown(stop)} USDT`);
  const order = await place(page, 'buy');
  expect(order).toMatchObject({ type: 'stop_limit', stopPrice: stop, status: 'open' });

  // The trigger is stored with the order, the funds are held at the limit, and nothing rests at the limit on the book.
  const stored = await orderById(who, order.id);
  expect(stored).toMatchObject({ type: 'stop_limit', stopPrice: stop, triggered: null });
  const holdUsdt = times(limit, AMOUNT);
  await expect.poll(async () => held(await balances(who), 'USDT')).toBe(holdUsdt);
  expect(await bookAt('buy', limit)).toEqual([]);

  // Cancel from Open orders: the hold goes back.
  await openOrdersTab(page);
  const row = rowOf(page, order.id);
  await expect(row).toContainText('Stop-limit');
  await row.getByRole('button', { name: /^Cancel/ }).click();
  await expect.poll(async () => held(await balances(who), 'USDT'), { timeout: 20_000 }).toBe(0n);
  expect((await orderById(who, order.id)).status).toBe('canceled');
});

test(`${J} #2 leaves the trigger blank: refused in words before anything is sent, and the service refuses it with a typed reason`, async ({
  page,
}) => {
  const who = account();
  await deskFor(page, who);
  const sent = placements(page);
  const { ask } = await bestPrices();
  await tab(page, 'Stop-limit').click();
  await field(page, 'buy', 'Price').fill(pct(ask, 105));
  await field(page, 'buy', 'Amount').fill(AMOUNT);
  await expect(form(page, 'buy')).toContainText('Enter a stop price.');
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  await expect(reviewSheet(page)).toHaveCount(0);
  expect(sent).toEqual([]);

  // The same order sent to the service without its trigger is refused, with words to show, and holds nothing.
  const res = await (
    await client(who)
  ).post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'stop_limit',
    side: 'buy',
    amount: AMOUNT,
    price: pct(ask, 105),
    timeInForce: 'GTC',
    clientOrderId: `${J}-2-${Date.now()}`,
  });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toMatch(/stopPrice/);
  expect(held(await balances(who), 'USDT')).toBe(0n);
});

/** A sell OCO whose take-profit sits inside the spread (the best ask once placed) and whose stop-loss sits under the market. */
async function ocoPrices() {
  const { bid, ask } = await bestPrices();
  const gap = toUnits(ask) - toUnits(bid);
  // A whole USDT one under the ask when the spread allows; else the ask itself, which can never cross the bid.
  const inside = pct(fromUnits(toUnits(ask) - toUnits('1')), 100);
  const takeProfit = gap > toUnits('2') && toUnits(inside) > toUnits(bid) ? inside : ask;
  return { takeProfit, stopLoss: pct(bid, 95) };
}

test(`${J} #3 places a stop-market and reads the pending list: trigger, reference price, and modify or cancel on each`, async ({
  page,
}) => {
  const who = account();
  await deskFor(page, who);
  // A sell stop-market under the market protects the BTC held: it sells when a trade prints at or below the stop.
  const { bid } = await bestPrices();
  const stop = pct(bid, 95);
  const sheet = await review(page, 'sell', 'Stop-market', { 'Stop price': stop, Amount: AMOUNT });
  await expect(sheet).toContainText('Stop-market');
  await expect(sheet).toContainText(`${shown(stop)} USDT`);
  // The review names the worst price it may sell at: the owner's protection under the stop, never above it.
  await expect(sheet).toContainText('Worst price');
  const order = await place(page, 'sell');
  expect(order).toMatchObject({ type: 'stop', stopPrice: stop, status: 'open', triggered: null });
  expect(toUnits(order.price)).toBeLessThan(toUnits(stop));
  await expect.poll(async () => held(await balances(who), 'BTC')).toBe(toUnits(AMOUNT));
  // Off the book until it fires: nothing rests at its protection price.
  expect(await bookAt('sell', order.price)).toEqual([]);

  // The pending list names the kind, the trigger and the price it watches (the last trade), with Edit and Cancel.
  await openOrdersTab(page);
  const row = rowOf(page, order.id);
  await expect(row).toContainText('Stop-market');
  await expect(row).toContainText(`Triggers at ${shown(stop)} USDT`);
  await expect(row).toContainText(/Last price \d{1,3}(,\d{3})*\.\d{2}/);
  await expect(row.getByRole('button', { name: /^Cancel/ })).toBeVisible();

  // Modify the trigger: reviewed first, then the stop is replaced by one at the new trigger, holding the same BTC.
  const lower = pct(bid, 93);
  await row.getByRole('button', { name: /^Change the stop/ }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(`triggers at ${shown(stop)} USDT`);
  await dialog.getByRole('textbox', { name: 'Stop price' }).fill(lower);
  await previewed(page, () => dialog.getByRole('button', { name: 'Review replacement' }).click());
  await expect(dialog).toContainText(`${shown(stop)} → ${shown(lower)} USDT`);
  const answer = page.waitForResponse((r) => /\/api\/v1\/orders\/[^/]+\/replace$/.test(new URL(r.url()).pathname));
  await dialog.getByRole('button', { name: 'Replace order' }).click();
  const replaced = await (await answer).json();
  expect(replaced).toMatchObject({ accepted: true, originalOrderId: order.id });
  await expect(dialog.getByRole('status')).toContainText(`triggers at ${shown(lower)} USDT`);
  await dialog.getByRole('button', { name: 'Close' }).click();
  const replacement = await orderById(who, replaced.replacementOrderId);
  expect(replacement).toMatchObject({ type: 'stop', stopPrice: lower, status: 'open', triggered: null });
  expect(await orderById(who, order.id)).toMatchObject({ status: 'canceled' });
  await expect(rowOf(page, replacement.id)).toContainText(`Triggers at ${shown(lower)} USDT`);
  await expect(rowOf(page, order.id)).toHaveCount(0);
  expect(held(await balances(who), 'BTC')).toBe(toUnits(AMOUNT));

  // Cancel: the BTC hold goes back.
  await rowOf(page, replacement.id)
    .getByRole('button', { name: /^Cancel/ })
    .click();
  await expect.poll(async () => held(await balances(who), 'BTC'), { timeout: 20_000 }).toBe(0n);
});

test(`${J} #4 places a sell OCO: the take-profit rests on one hold of the base, a cancel releases it, and a replay returns the same group`, async ({
  page,
}) => {
  const who = account();
  await deskFor(page, who);
  const { bid, ask } = await bestPrices();
  const takeProfit = pct(ask, 107);
  const stopLoss = pct(bid, 95);
  await review(page, 'sell', 'OCO', { 'Take profit': takeProfit, 'Stop loss': stopLoss, Amount: AMOUNT });
  const order = await place(page, 'sell');
  expect(order).toMatchObject({ side: 'sell', status: 'open', price: takeProfit });

  // One base hold for both legs; the take-profit rests at its price; the stop-loss is not on the book.
  await expect.poll(async () => held(await balances(who), 'BTC')).toBe(toUnits(AMOUNT));
  expect(await bookAt('sell', takeProfit)).toEqual([AMOUNT]);
  const stored = await orderById(who, order.id);
  expect(stored.exit).toMatchObject({ kind: 'oco', takeProfit, stopLoss });

  // The same client id sent again answers the same group, and holds nothing more.
  const replay = await (
    await client(who)
  ).post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'limit',
    side: 'sell',
    amount: AMOUNT,
    price: takeProfit,
    timeInForce: 'GTC',
    clientOrderId: order.clientOrderId,
    oco: true,
    takeProfit: { stopPrice: takeProfit },
    stopLoss: { stopPrice: stopLoss },
  });
  expect(replay.status, JSON.stringify(replay.body).slice(0, 300)).toBeLessThan(300);
  expect(replay.body.id).toBe(order.id);
  expect(held(await balances(who), 'BTC')).toBe(toUnits(AMOUNT));

  await openOrdersTab(page);
  const row = rowOf(page, order.id);
  await expect(row).toContainText('OCO');
  await row.getByRole('button', { name: /^Cancel/ }).click();
  await expect.poll(async () => held(await balances(who), 'BTC'), { timeout: 20_000 }).toBe(0n);
  expect(await bookAt('sell', takeProfit)).toEqual([]);
});

test(`${J} #5 reads the review of both legs: take-profit priced as maker and stop-loss as taker, from the published schedule`, async ({
  page,
}) => {
  const who = account();
  await deskFor(page, who);
  const { bid, ask } = await bestPrices();
  const takeProfit = pct(ask, 107);
  const stopLoss = pct(bid, 95);
  // The review shows the desk's last preview, made once every field was filled.
  const previews = [];
  page.on('response', (res) => {
    if (new URL(res.url()).pathname === '/api/v1/orders/preview' && res.request().method() === 'POST') previews.push(res);
  });
  const sheet = await review(page, 'sell', 'OCO', { 'Take profit': takeProfit, 'Stop loss': stopLoss, Amount: AMOUNT });
  const last = previews.at(-1);
  expect(last?.request().postDataJSON()).toMatchObject({ amount: AMOUNT, price: takeProfit });
  const exitFees = (await last.json()).exitFees;
  expect(exitFees).toMatchObject({ takeProfit: { feeRole: 'maker', feeAsset: 'USDT' }, stopLoss: { feeRole: 'taker', feeAsset: 'USDT' } });
  // The published schedule prices each role.
  const published = await (await client(who)).get('/api/v1/fees/published');
  expect(published.status).toBe(200);
  // Each leg's fee line on the review is at its role's published rate: the take-profit at maker, the stop-loss at taker.
  const rate = (bps) => `${(bps / 100).toFixed(2)}%`;
  const listed = published.body.fees[SYMBOL];
  // The account's rank can only lower a rate, never raise it.
  expect(exitFees.takeProfit.feeBps).toBeLessThanOrEqual(listed.makerBps);
  expect(exitFees.stopLoss.feeBps).toBeLessThanOrEqual(listed.takerBps);
  await expect(sheet.locator('div', { has: page.locator('dt', { hasText: 'Take-profit fee' }) })).toContainText(
    rate(exitFees.takeProfit.feeBps),
  );
  await expect(sheet.locator('div', { has: page.locator('dt', { hasText: 'Stop-loss fee' }) })).toContainText(
    rate(exitFees.stopLoss.feeBps),
  );
  await page.keyboard.press('Escape');
  expect(held(await balances(who), 'BTC')).toBe(0n);
});

/**
 * The stack's other TEST trader buys `amount` of the person's sell resting at `price` with `ours` left. Asks at or under
 * that price that are not the person's may stand ahead of it, so the buy is sized to take those too.
 */
async function takeAt(price, ours, amount, key) {
  const { body: book } = await bestPrices(SYMBOL, 100);
  const atOrUnder = book.asks.filter(([p]) => toUnits(p) <= toUnits(price)).reduce((sum, [, size]) => sum + toUnits(size), 0n);
  const ahead = atOrUnder > toUnits(ours) ? atOrUnder - toUnits(ours) : 0n;
  const res = await (
    await api(otherTrader())
  ).post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'limit',
    side: 'buy',
    amount: fromUnits(ahead + toUnits(amount)),
    price,
    timeInForce: 'IOC',
    clientOrderId: `${J}-${key}-${Date.now()}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
}

test(`${J} #6 a buyer takes the take-profit leg: it settles on the ledger, the stop-loss is cancelled and nothing stays held`, async ({
  page,
}) => {
  const who = account();
  await deskFor(page, who);
  const { takeProfit, stopLoss } = await ocoPrices();
  const before = await balances(who);
  await review(page, 'sell', 'OCO', { 'Take profit': takeProfit, 'Stop loss': stopLoss, Amount: AMOUNT });
  const order = await place(page, 'sell');
  expect(order).toMatchObject({ side: 'sell', amount: AMOUNT, price: takeProfit });

  // The stack's own taker may lift the take-profit first; either way a buyer takes it.
  if ((await orderById(who, order.id)).status === 'open') await takeAt(takeProfit, AMOUNT, AMOUNT, '6');
  await expect.poll(async () => (await orderById(who, order.id)).status, { timeout: 30_000 }).toBe('closed');

  // Settled through the ledger: the BTC left, USDT came in at the take-profit price less the fee, and nothing is held.
  await expect.poll(async () => held(await balances(who), 'BTC'), { timeout: 20_000 }).toBe(0n);
  const after = await balances(who);
  expect(toUnits(before.BTC.total) - toUnits(after.BTC.total)).toBe(toUnits(AMOUNT));
  const proceeds = toUnits(after.USDT.total) - toUnits(before.USDT.total);
  expect(proceeds > 0n && proceeds <= times(takeProfit, AMOUNT)).toBe(true);
  expect(held(after, 'USDT')).toBe(0n);
  // The stop-loss went with it: nothing of the pair is left open.
  expect((await openOrders(who)).filter((o) => o.side === 'sell')).toEqual([]);
});

test(`${J} #7 a partial fill on the take-profit leg keeps the rest held for the remaining leg, and a cancel releases exactly that`, async ({
  page,
}) => {
  const who = account();
  const amount = '0.002';
  // The stack's own taker can take the whole leg before ours takes half; then a new pair is placed (at most three).
  let order;
  let part;
  await deskFor(page, who);
  for (let attempt = 0; attempt < 3 && part?.status !== 'open'; attempt++) {
    if (attempt > 0) {
      // Signed in already: a second sign-in can land back on /login, so only the desk is opened again.
      await fresh(who);
      await page.goto(deskPath());
      await page.mouse.move(0, 600);
    }
    const { takeProfit, stopLoss } = await ocoPrices();
    await review(page, 'sell', 'OCO', { 'Take profit': takeProfit, 'Stop loss': stopLoss, Amount: amount });
    order = await place(page, 'sell');
    await takeAt(takeProfit, amount, AMOUNT, `7-${attempt}`);
    // A buy that took none of it (an ask ahead that was not counted) is one more attempt, not a failure.
    await expect
      .poll(async () => (await orderById(who, order.id)).filled, { timeout: 15_000 })
      .not.toBe('0')
      .catch(() => undefined);
    part = await orderById(who, order.id);
  }
  expect(part, 'a partly filled take-profit leg').toMatchObject({ status: 'open', filled: AMOUNT });
  const rest = toUnits(amount) - toUnits(AMOUNT);
  await expect.poll(async () => held(await balances(who), 'BTC'), { timeout: 20_000 }).toBe(rest);
  expect(toUnits(part.hold.amount)).toBe(rest);
  const totalBefore = toUnits((await balances(who)).BTC.total);

  await openOrdersTab(page);
  await rowOf(page, order.id)
    .getByRole('button', { name: /^Cancel/ })
    .click();
  await expect.poll(async () => held(await balances(who), 'BTC'), { timeout: 20_000 }).toBe(0n);
  // The cancel gave back exactly the rest: nothing more left the account.
  expect(toUnits((await balances(who)).BTC.total)).toBe(totalBefore);
});

test(`${J} #8 a buy OCO with no stop-loss limit, or with legs out of order: refused in words, the form before sending`, async ({
  page,
}) => {
  const who = account();
  await deskFor(page, who);
  const sent = placements(page);
  const { bid, ask } = await bestPrices();
  const takeProfit = pct(bid, 95);
  const stopLoss = pct(ask, 104);
  await tab(page, 'OCO').click();
  await field(page, 'buy', 'Take profit').fill(takeProfit);
  await field(page, 'buy', 'Stop loss').fill(stopLoss);
  await field(page, 'buy', 'Amount').fill(AMOUNT);
  await expect(form(page, 'buy')).toContainText('Enter a stop-loss limit price.');
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  // Legs out of order: the take-profit above the stop.
  await field(page, 'buy', 'Take profit').fill(pct(ask, 107));
  await field(page, 'buy', 'Stop-loss limit').fill(pct(ask, 105));
  await expect(form(page, 'buy')).toContainText('To buy, the take-profit price must be below the stop-loss price.');
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  await expect(reviewSheet(page)).toHaveCount(0);
  expect(sent).toEqual([]);

  // The service refuses both too, each with a typed reason, and holds nothing.
  for (const [stopLossLeg, code] of [
    [{ stopPrice: stopLoss }, 'trade.oco_stop_limit_required'],
    [{ stopPrice: pct(bid, 93), price: pct(bid, 94) }, 'trade.oco_price_order'],
  ]) {
    const res = await (
      await client(who)
    ).post('/api/v1/orders', {
      symbol: SYMBOL,
      type: 'limit',
      side: 'buy',
      amount: AMOUNT,
      price: pct(ask, 105),
      timeInForce: 'GTC',
      clientOrderId: `${J}-8-${code}-${Date.now()}`,
      oco: true,
      takeProfit: { stopPrice: takeProfit },
      stopLoss: stopLossLeg,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toContain(code);
  }
  expect(held(await balances(who), 'USDT')).toBe(0n);
});

test(`${J} #9 places a bracket: the entry buys, then the coins are held behind one exit pair; no fill places no exit; a resting entry waits`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const who = account();
  await deskFor(page, who);
  await openOrdersTab(page);
  const btcBefore = held(await balances(who), 'BTC');
  expect(btcBefore).toBe(0n);

  // An entry at the best ask, immediate-or-cancel: it buys, then one exit pair rests on what it bought.
  const { bid, ask } = await bestPrices();
  const entryPrice = pct(ask, 101);
  const takeProfit = pct(ask, 107);
  const stopLoss = pct(bid, 95);
  await review(page, 'buy', 'Bracket', { 'Entry price': entryPrice, 'Take profit': takeProfit, 'Stop loss': stopLoss, Amount: AMOUNT });
  const entry = await place(page, 'buy');
  await expect.poll(async () => (await orderById(who, entry.id)).filled, { timeout: 20_000 }).toBe(AMOUNT);
  let exit;
  await expect
    .poll(
      async () => {
        exit = (await openOrders(who)).find((o) => o.side === 'sell' && o.exit?.kind === 'bracket_exit');
        return exit?.id ?? null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  expect(exit.exit).toMatchObject({ takeProfit, stopLoss });
  // The exit holds what the entry received (the amount less a base fee), never more.
  const heldBtc = held(await balances(who), 'BTC');
  expect(heldBtc).toBe(toUnits(exit.amount));
  expect(heldBtc > 0n && heldBtc <= toUnits(AMOUNT)).toBe(true);
  await expect(rowOf(page, exit.id)).toContainText('Bracket exit');
  await rowOf(page, exit.id)
    .getByRole('button', { name: /^Cancel/ })
    .click();
  await expect.poll(async () => held(await balances(who), 'BTC'), { timeout: 20_000 }).toBe(0n);

  // An entry far under the market, immediate-or-cancel: nothing fills, so no exit is placed and nothing is held.
  await page.goto(deskPath());
  await page.mouse.move(0, 600);
  await review(page, 'buy', 'Bracket', {
    'Entry price': pct(bid, 93),
    'Take profit': takeProfit,
    'Stop loss': pct(bid, 92),
    Amount: AMOUNT,
  });
  const missed = await place(page, 'buy');
  expect(missed.filled ?? '0').toBe('0');
  await page.waitForTimeout(3000);
  expect((await openOrders(who)).filter((o) => o.exit)).toEqual([]);
  expect(held(await balances(who), 'USDT')).toBe(0n);

  // A resting entry (good till cancelled) waits on the book and holds USDT; a cancel places no exit.
  await page.goto(deskPath());
  await page.mouse.move(0, 600);
  await tab(page, 'Bracket').click();
  await page.getByRole('combobox', { name: 'Time in force' }).click();
  await page.getByRole('option', { name: 'Rest on the book' }).click();
  const restPrice = pct(bid, 94);
  await review(page, 'buy', 'Bracket', { 'Entry price': restPrice, 'Take profit': takeProfit, 'Stop loss': pct(bid, 93), Amount: AMOUNT });
  const resting = await place(page, 'buy');
  expect(resting).toMatchObject({ status: 'open', filled: '0' });
  expect(await bookAt('buy', restPrice)).toContain(AMOUNT);
  expect(held(await balances(who), 'USDT')).toBe(times(restPrice, AMOUNT));
  await openOrdersTab(page);
  await rowOf(page, resting.id)
    .getByRole('button', { name: /^Cancel/ })
    .click();
  await expect.poll(async () => held(await balances(who), 'USDT'), { timeout: 20_000 }).toBe(0n);
  await page.waitForTimeout(3000);
  expect((await openOrders(who)).filter((o) => o.exit)).toEqual([]);
});

/** The stack's other TEST trader sells `amount` into the bids at or above `price` (immediate-or-cancel), past `ours`. */
async function sellInto(price, ours, amount, key) {
  const { body: book } = await bestPrices(SYMBOL, 100);
  const atOrAbove = book.bids.filter(([p]) => toUnits(p) >= toUnits(price)).reduce((sum, [, size]) => sum + toUnits(size), 0n);
  const ahead = atOrAbove > toUnits(ours) ? atOrAbove - toUnits(ours) : 0n;
  const res = await (
    await api(otherTrader())
  ).post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'limit',
    side: 'sell',
    amount: fromUnits(ahead + toUnits(amount)),
    price,
    timeInForce: 'IOC',
    clientOrderId: `${J}-${key}-${Date.now()}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
}

test(`${J} #10 attaches a close to a buy (OTO): shown linked, cancelled with the buy, and placed the moment the buy fills`, async ({
  page,
}) => {
  test.setTimeout(150_000);
  const who = account();
  await deskFor(page, who);
  const { bid } = await bestPrices();
  const entryPrice = pct(bid, 98);
  const closePrice = pct(bid, 106);

  // A resting OTO buy: the buy holds USDT on the book and names its close, which waits for the fill.
  await tab(page, 'OTO').click();
  await expect(page.getByRole('combobox', { name: 'Time in force' })).toContainText('Rest on the book');
  const sheet = await review(page, 'buy', 'OTO', { 'Entry price': entryPrice, 'Close price': closePrice, Amount: AMOUNT });
  await expect(sheet).toContainText('OTO');
  await expect(sheet).toContainText(`${shown(closePrice)} USDT`);
  const first = await place(page, 'buy');
  expect(first).toMatchObject({ status: 'open', price: entryPrice, linked: { role: 'entry', closePrice, closeOrderId: null } });
  expect(held(await balances(who), 'USDT')).toBe(times(entryPrice, AMOUNT));
  await openOrdersTab(page);
  await expect(rowOf(page, first.id)).toContainText('OTO');
  await expect(rowOf(page, first.id)).toContainText(`Closes at ${shown(closePrice)} USDT once filled`);
  // Cancelled with the buy: the hold comes back and no close is ever placed.
  await rowOf(page, first.id)
    .getByRole('button', { name: /^Cancel/ })
    .click();
  await expect.poll(async () => held(await balances(who), 'USDT'), { timeout: 20_000 }).toBe(0n);
  await page.waitForTimeout(3000);
  expect((await openOrders(who)).filter((o) => o.side === 'sell')).toEqual([]);
  expect(held(await balances(who), 'BTC')).toBe(0n);

  // Again, and this time a seller fills the buy: the close is placed at once, for what the buy received, linked both ways.
  await page.goto(deskPath());
  await page.mouse.move(0, 600);
  await review(page, 'buy', 'OTO', { 'Entry price': entryPrice, 'Close price': closePrice, Amount: AMOUNT });
  const entry = await place(page, 'buy');
  expect(entry).toMatchObject({ status: 'open', linked: { role: 'entry', closeOrderId: null } });
  await sellInto(entryPrice, AMOUNT, AMOUNT, '10');
  await expect.poll(async () => (await orderById(who, entry.id)).status, { timeout: 30_000 }).toBe('closed');
  let close;
  await expect
    .poll(
      async () => {
        close = (await openOrders(who)).find((o) => o.side === 'sell' && o.linked?.role === 'close');
        return close?.id ?? null;
      },
      { timeout: 10_000 },
    )
    .not.toBeNull();
  expect(close).toMatchObject({ type: 'limit', price: closePrice, linked: { role: 'close', entryOrderId: entry.id } });
  expect((await orderById(who, entry.id)).linked).toEqual({ role: 'entry', closePrice, closeOrderId: close.id });
  // The close sells what the buy received (the amount less a base fee), and holds exactly that.
  const heldBtc = held(await balances(who), 'BTC');
  expect(heldBtc).toBe(toUnits(close.amount));
  expect(heldBtc > 0n && heldBtc <= toUnits(AMOUNT)).toBe(true);
  expect(held(await balances(who), 'USDT')).toBe(0n);
  await page.goto(deskPath());
  await page.mouse.move(0, 600);
  await openOrdersTab(page);
  await expect(rowOf(page, close.id)).toContainText('OTO close');
  await expect(rowOf(page, close.id).getByRole('link', { name: 'Open the OTO buy this sells for' })).toHaveAttribute(
    'href',
    `/trade/orders/${encodeURIComponent(entry.id)}`,
  );
  await rowOf(page, close.id)
    .getByRole('button', { name: /^Cancel/ })
    .click();
  await expect.poll(async () => held(await balances(who), 'BTC'), { timeout: 20_000 }).toBe(0n);
});
