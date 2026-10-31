import { test, expect } from './journey.mjs';
import { api, journeyState, toUnits, fromUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-derivatives-03, in the running app (docs/roadmap/journeys.json): protect a position with a take profit and a stop
// loss. One test per step, titled "J-derivatives-03 #<n>", run in order on one TEST account. The contract is the TEST
// perpetual `local-test-gates.mjs futures` lists; its mark follows the stack's TEST book, which the TEST market maker
// walks a few basis points at a time, so a trigger set 3 bps from the mark is crossed within a minute or two. Every
// figure is read back through the customer's own API.
const J = 'J-derivatives-03';
const DESK = '/trade/futures';
const SYMBOL = 'BTC/USDT:USDT';
const SIZE = '0.01';
const LEVERAGE = '5';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

async function desk(page) {
  await signIn(page, account());
  await page.goto(DESK);
  await expect(page.getByRole('button', { name: 'Open long' })).toBeVisible();
}

async function until(read, ok, what, ms = 20_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what}: still ${JSON.stringify(last)}`);
}

async function openPosition(me) {
  const { body } = await me.get('/api/v1/positions');
  const open = body.find((p) => p.symbol === SYMBOL && p.side === 'long' && p.status === 'open');
  if (open) return open;
  // The confirm step names the tier the order moves the position into, as the ticket does.
  const preview = await me.post('/api/v1/positions/preview', { symbol: SYMBOL, side: 'long', size: SIZE, leverage: LEVERAGE });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const placed = await me.post('/api/v1/futures/orders', {
    symbol: SYMBOL,
    side: 'buy',
    type: 'market',
    amount: SIZE,
    leverage: LEVERAGE,
    marginMode: 'isolated',
    confirmTier: preview.body.riskTier?.projected,
    clientOrderId: `${J}-open-${Date.now()}`,
  });
  expect(placed.status, JSON.stringify(placed.body)).toBeLessThan(300);
  const positions = await until(
    async () => (await me.get('/api/v1/positions')).body,
    (list) => list.some((p) => p.symbol === SYMBOL && p.side === 'long' && p.status === 'open' && p.contracts === SIZE),
    'the TEST long',
  );
  return positions.find((p) => p.symbol === SYMBOL && p.side === 'long');
}

/** The mark, as the service prices a preview: the price protection is checked against. */
async function markOf(me) {
  const preview = await me.post('/api/v1/positions/preview', { symbol: SYMBOL, side: 'long', size: SIZE, leverage: LEVERAGE });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  return toUnits(preview.body.markPrice);
}

/** `bps` basis points from the mark, in whole units of price. */
const away = (mark, bps) => fromUnits(((mark + (mark * BigInt(bps)) / 10_000n) / 10n ** 18n) * 10n ** 18n);

async function legs(me, positionId) {
  const { status, body } = await me.get('/api/v1/futures/conditional-orders');
  expect(status, JSON.stringify(body)).toBe(200);
  return body.orders.filter((o) => o.positionId === positionId && o.attachment !== null);
}

/** The position's take-profit and stop-loss dialog, opened from its row's Manage menu in the Positions tab. */
async function protection(page) {
  await page.getByRole('tab', { name: 'Positions' }).click();
  await page.getByRole('button', { name: `Manage ${SYMBOL}` }).click();
  await page.getByRole('menuitem', { name: 'Take profit / stop loss' }).click();
  const dialog = page.getByRole('dialog', { name: 'Take profit and stop loss' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'On this position now' }).getByRole('list')).toBeVisible();
  return dialog;
}

test(`${J} #1 sets a take profit and a stop loss for the whole position: both shown armed with their trigger and its source`, async ({
  page,
}) => {
  const who = await fundedTrader(page, 'jd3', '1000');
  run.reset({ account: who });
  const me = await api(who);
  await signIn(page, who);
  await page.goto(DESK);
  const position = await openPosition(me);
  await page.reload();

  // Far enough from the mark that neither fires during the next step.
  const mark = await markOf(me);
  const tp = away(mark, 300);
  const sl = away(mark, -300);
  const dialog = await protection(page);
  const current = dialog.getByRole('region', { name: 'On this position now' });
  await expect(current).toContainText('Take profit: None set');
  await expect(current).toContainText('Stop loss: None set');
  await dialog.getByLabel(/Take-profit trigger/).fill(tp);
  await dialog.getByLabel(/Stop-loss trigger/).fill(sl);
  // The result at each trigger, worked out from the position's own entry and size.
  await expect(dialog.getByText(/If the whole position closed at this price: \+/)).toBeVisible();
  await expect(dialog.getByText(/If the whole position closed at this price: −/)).toBeVisible();
  const sent = page.waitForResponse((r) => r.url().includes(`/positions/${position.id}/protection`) && r.request().method() === 'PUT');
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await sent).status()).toBe(200);
  await expect(dialog.getByRole('status')).toHaveText('Saved. What is armed now is listed above.');
  await expect(current.locator('[data-leg="take_profit"]')).toContainText('Take profit: Armed');
  await expect(current.locator('[data-leg="stop_loss"]')).toContainText('Stop loss: Armed');
  await expect(current).toContainText('judged on the mark price');

  // What the service armed: one leg each side, for the whole position, judged on the mark.
  const armed = await legs(me, position.id);
  expect(armed.map((o) => [o.attachment, o.status, o.side, o.quantity, o.triggerSource]).sort()).toEqual([
    ['stop_loss', 'armed', 'sell', SIZE, 'mark'],
    ['take_profit', 'armed', 'sell', SIZE, 'mark'],
  ]);
  expect(toUnits(armed.find((o) => o.attachment === 'take_profit').triggerPrice)).toBe(toUnits(tp));
  expect(toUnits(armed.find((o) => o.attachment === 'stop_loss').triggerPrice)).toBe(toUnits(sl));
  run.write({ positionId: position.id });
});

test(`${J} #2 sets a take profit on the wrong side of the mark: refused in words, and the armed pair is unchanged`, async ({ page }) => {
  const me = await api(account());
  const { positionId } = run.read();
  const before = await legs(me, positionId);
  await desk(page);
  const dialog = await protection(page);
  // The fields start from what is armed, so saving one change keeps the other leg.
  const tpField = dialog.getByLabel(/Take-profit trigger/);
  await expect(tpField).not.toHaveValue('');
  await expect(dialog.getByText('Must be above the mark price.')).toBeVisible();

  const mark = await markOf(me);
  await tpField.fill(away(mark, -100));
  const sent = page.waitForResponse((r) => r.url().includes(`/positions/${positionId}/protection`) && r.request().method() === 'PUT');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const answer = await sent;
  expect(answer.status()).toBe(400);
  expect((await answer.json()).error).toBe('trade.protection_wrong_side');
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('That price is on the wrong side of the mark');
  await expect(alert).toContainText('Nothing was saved.');
  await expect(alert).toContainText('Code: trade.protection_wrong_side');

  // Nothing stored: the same two legs, still armed at their prices.
  const after = await legs(me, positionId);
  expect(after.map((o) => [o.id, o.status, o.triggerPrice])).toEqual(before.map((o) => [o.id, o.status, o.triggerPrice]));
});

test(`${J} #3 sets a part take profit: the size it covers and the remainder shown, the stop loss still on the whole`, async ({ page }) => {
  const me = await api(account());
  const { positionId } = run.read();
  await desk(page);
  const dialog = await protection(page);
  const current = dialog.getByRole('region', { name: 'On this position now' });
  // 40% of the 0.01 long; the stop loss field is left as it is, so it stays on the whole position.
  const PART = '0.004';
  await dialog.getByLabel('Take-profit size (optional)').fill(PART);
  await expect(dialog.getByText(`If ${PART} of the position closed at this price: +`)).toBeVisible();
  const sent = page.waitForResponse((r) => r.url().includes(`/positions/${positionId}/protection`) && r.request().method() === 'PUT');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const answer = await sent;
  expect(answer.status()).toBe(200);
  expect(answer.request().postDataJSON().takeProfit).toMatchObject({ quantity: PART });
  await expect(current.locator('[data-leg="take_profit"]')).toContainText(`Covers ${PART} of ${SIZE}; 0.006 not covered by it`);
  await expect(current.locator('[data-leg="stop_loss"]')).toContainText('Covers the whole position');

  const armed = (await legs(me, positionId)).filter((o) => o.status === 'armed');
  expect(armed.map((o) => [o.attachment, o.quantity, o.wholePosition]).sort()).toEqual([
    ['stop_loss', SIZE, true],
    ['take_profit', PART, false],
  ]);
});

test(`${J} #4 attaches a take profit and a stop loss to an opening order: the order fills, then they arm on the filled size`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const me = await api(account());
  const { positionId } = run.read();
  const sizeOf = async () => (await me.get('/api/v1/positions')).body.find((p) => p.id === positionId)?.contracts;
  const before = await sizeOf();
  await desk(page);
  const ticket = page.getByRole('region', { name: 'Order ticket' });
  await ticket.getByRole('textbox', { name: 'Size' }).fill(SIZE);
  await ticket.getByRole('textbox', { name: 'Leverage' }).fill(LEVERAGE);
  // 3% either side of the mark, well clear of the TEST walk.
  const mark = await markOf(me);
  const tp = away(mark, 300);
  const sl = away(mark, -300);
  await ticket.getByRole('textbox', { name: /^Take profit/ }).fill(tp);
  await ticket.getByRole('textbox', { name: /^Stop loss/ }).fill(sl);
  await ticket.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(ticket.getByText('Total to commit now', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open long' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  const tier = confirm.getByRole('region', { name: 'New margin tier' });
  if ((await tier.count()) > 0) await tier.getByRole('checkbox').click();
  await expect(confirm.getByText('Take profit', { exact: true })).toBeVisible();
  await expect(confirm.getByText('Stop loss', { exact: true })).toBeVisible();
  const sent = page.waitForResponse((r) => r.url().endsWith('/futures/orders') && r.request().method() === 'POST');
  await confirm.getByRole('button', { name: 'Confirm open long' }).click();
  // The confirm re-checks the numbers; a mark that moved meanwhile shows the new figures, and the tier is ticked again.
  const placed = page.getByText(/arm on what this order fills/);
  await expect(placed.or(confirm.getByText('The numbers moved since you reviewed'))).toBeVisible({ timeout: 20_000 });
  if (!(await placed.isVisible())) {
    if ((await tier.count()) > 0) await tier.getByRole('checkbox').click();
    await confirm.getByRole('button', { name: 'Confirm open long' }).click();
  }
  await expect(placed).toBeVisible({ timeout: 20_000 });
  const request = (await sent).request().postDataJSON();
  expect(request).toMatchObject({ side: 'buy', amount: SIZE, takeProfit: tp, stopLoss: sl });

  // The order filled into the long, and the protection armed on the 0.01 it filled, not on the whole position.
  const entry = await until(
    async () => (await me.get('/api/v1/futures/entry-protection')).body.protections.find((e) => e.clientOrderId === request.clientOrderId),
    (e) => e?.status === 'done',
    'the protection on the order',
  );
  expect(entry).toMatchObject({ takeProfit: tp, stopLoss: sl, armedQuantity: SIZE });
  expect(await sizeOf()).toBe(fromUnits(toUnits(before) + toUnits(SIZE)));
  // The legs are a pair on the position the fills landed in, named after it and the order.
  expect(entry.takeProfitClientOrderId).toBe(`entry:${positionId}:${request.clientOrderId}:tp`);
  const ids = [entry.takeProfitClientOrderId, entry.stopLossClientOrderId];
  const armed = (await legs(me, positionId)).filter((o) => ids.includes(o.clientOrderId));
  expect(armed.map((o) => [o.attachment, o.status, o.quantity, o.wholePosition, o.triggerPrice]).sort()).toEqual([
    ['stop_loss', 'armed', SIZE, false, sl],
    ['take_profit', 'armed', SIZE, false, tp],
  ]);

  // The Orders tab lists it with what it covers, beside the legs themselves.
  await page.getByRole('tab', { name: 'Orders' }).click();
  const attached = page.getByRole('region', { name: 'Take profits and stop losses attached to orders' });
  const row = attached.getByRole('row').filter({ hasText: 'Set on everything the order filled' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(SIZE);
});

/** The position's stop order dialog, opened from its row's Manage menu in the Positions tab. */
async function stopDialog(page) {
  await page.getByRole('tab', { name: 'Positions' }).click();
  await page.getByRole('button', { name: `Manage ${SYMBOL}` }).click();
  await page.getByRole('menuitem', { name: 'Stop order' }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop order' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test(`${J} #5 places a stop market, a stop limit and a trailing stop judged on the last trade or the mark: armed and listed; the index, a field a kind does not take and an exit that would enlarge are refused`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const me = await api(account());
  const { positionId } = run.read();
  const PART = '0.004';
  const mark = await markOf(me);
  const below = away(mark, -300);
  const limitAt = away(mark, -350);
  // 3% of the mark, in whole units of price.
  const distance = fromUnits(((mark * 300n) / 10_000n / 10n ** 18n) * 10n ** 18n);
  await desk(page);
  const dialog = await stopDialog(page);
  const listed = dialog.getByRole('region', { name: 'Stops working on this position' });
  const arm = async (kind, source, fields) => {
    await dialog.getByRole('button', { name: kind, exact: true }).click();
    await dialog.getByRole('button', { name: source, exact: true }).click();
    await dialog.getByLabel('Size to close').fill(PART);
    for (const [label, value] of fields) await dialog.getByLabel(label).fill(value);
    const sent = page.waitForResponse((r) => r.url().endsWith('/futures/conditional-orders') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Arm stop' }).click();
    return sent;
  };

  // A stop market judged on the last trade.
  const market = await arm('Stop market', 'Last trade', [[/^Trigger price/, below]]);
  expect(market.status(), await market.text()).toBe(201);
  expect(market.request().postDataJSON()).toMatchObject({
    kind: 'stop_market',
    side: 'sell',
    quantity: PART,
    triggerSource: 'last',
    reduceOnly: true,
  });
  await expect(dialog.getByText('Armed. It is listed here and in the Orders tab')).toBeVisible();
  await expect(listed.locator('[data-stop="stop_market"]')).toContainText(`Stop market for ${PART}: Armed`);
  await expect(listed.locator('[data-stop="stop_market"]')).toContainText('judged on the last traded price');

  // A stop limit and a trailing stop judged on the mark.
  const limit = await arm('Stop limit', 'Mark', [
    [/^Trigger price/, below],
    [/^Limit price/, limitAt],
  ]);
  expect(limit.status(), await limit.text()).toBe(201);
  expect(limit.request().postDataJSON()).toMatchObject({ kind: 'stop_limit', limitPrice: limitAt, triggerSource: 'mark' });
  const trailing = await arm('Trailing stop', 'Mark', [[/^Trailing distance/, distance]]);
  expect(trailing.status(), await trailing.text()).toBe(201);
  expect(trailing.request().postDataJSON()).toMatchObject({ kind: 'trailing_stop', trailingDistance: distance });
  expect(trailing.request().postDataJSON().triggerPrice).toBeUndefined();
  await expect(listed.locator('[data-stop="stop_limit"]')).toContainText('judged on the mark price');
  await expect(listed.locator('[data-stop="trailing_stop"]')).toContainText(`Trailing stop for ${PART}: Armed`);

  // The index is not published here: the choice says so, and the service refuses it by name.
  await dialog.getByRole('button', { name: 'Index', exact: true }).click();
  await expect(dialog.getByText('The index price is not published on this exchange')).toBeVisible();
  await dialog.getByRole('button', { name: 'Arm stop' }).click();
  await expect(dialog.getByText('The index price is not published here', { exact: true })).toBeVisible();
  await expect(dialog.getByText('trade.trigger_source_unset')).toBeVisible();

  // More than the position holds is refused in the field, before anything is sent.
  await dialog.getByRole('button', { name: 'Mark', exact: true }).click();
  await dialog.getByLabel('Size to close').fill('5');
  await expect(dialog.getByText('That is more than the position holds.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Arm stop' })).toBeDisabled();

  // Through the API, each kind refuses a field it does not take, with a 400 and the code: a stop market a limit price
  // or a trailing distance, a stop limit a trailing distance, a trailing stop a trigger or a limit price, a take profit a
  // limit price or a trailing distance. One armed by mistake is cancelled before the step fails, so it guards nothing.
  const base = { market: SYMBOL, side: 'sell', quantity: PART };
  const extras = [
    ['stop_market', { triggerPrice: below, limitPrice: limitAt }],
    ['stop_market', { triggerPrice: below, trailingDistance: distance }],
    ['stop_limit', { triggerPrice: below, limitPrice: limitAt, trailingDistance: distance }],
    ['trailing_stop', { trailingDistance: distance, triggerPrice: below }],
    ['trailing_stop', { trailingDistance: distance, limitPrice: limitAt }],
    ['take_profit', { triggerPrice: away(mark, 300), limitPrice: away(mark, 250) }],
    ['take_profit', { triggerPrice: away(mark, 300), trailingDistance: distance }],
  ];
  for (const [i, [kind, fields]] of extras.entries()) {
    const extra = await me.post('/api/v1/futures/conditional-orders', {
      ...base,
      kind,
      ...fields,
      clientOrderId: `${J}-extra-${i}-${Date.now()}`,
    });
    if (extra.status < 300 && extra.body?.id) await me.delete(`/api/v1/futures/conditional-orders/${extra.body.id}`);
    expect(extra.status, `${kind} ${Object.keys(fields).join('+')}: ${JSON.stringify(extra.body)}`).toBe(400);
    expect(extra.body).toMatchObject({ error: 'trade.conditional_field_unsupported' });
  }
  const enlarge = await me.post('/api/v1/futures/conditional-orders', {
    market: SYMBOL,
    kind: 'stop_market',
    side: 'buy',
    quantity: PART,
    triggerPrice: away(mark, 300),
    clientOrderId: `${J}-enlarge-${Date.now()}`,
  });
  expect(enlarge.status, JSON.stringify(enlarge.body)).toBe(400);
  expect(enlarge.body).toMatchObject({ error: 'trade.conditional_would_increase' });

  // The three stops, as the service has them; then they are cancelled so the next step's pair is the only protection.
  const { body } = await me.get('/api/v1/futures/conditional-orders');
  const stops = body.orders.filter((o) => o.positionId === positionId && o.attachment === null && o.status === 'armed');
  expect(stops.map((o) => [o.kind, o.triggerSource, o.quantity]).sort()).toEqual([
    ['stop_limit', 'mark', PART],
    ['stop_market', 'last', PART],
    ['trailing_stop', 'mark', PART],
  ]);
  for (const stop of stops) expect((await me.delete(`/api/v1/futures/conditional-orders/${stop.id}`)).status).toBe(200);
});

test(`${J} #6 the mark crosses a trigger: armed, triggered, filled through a reduce-only order in the book, once; the other leg cancelled`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const me = await api(account());
  const { positionId } = run.read();
  // The size as it stands: #4 added to it.
  const size = (await me.get('/api/v1/positions')).body.find((p) => p.id === positionId).contracts;
  await desk(page);
  const dialog = await protection(page);
  const current = dialog.getByRole('region', { name: 'On this position now' });

  // 3 bps either side of the mark. The mark can step across one before the save lands; the refusal then says so and
  // the pair is set again from the new mark.
  for (let attempt = 0; ; attempt += 1) {
    const mark = await markOf(me);
    const tp = fromUnits(mark + (mark * 3n) / 10_000n + 10n ** 18n);
    const sl = fromUnits(mark - (mark * 3n) / 10_000n - 10n ** 18n);
    await dialog.getByLabel(/Take-profit trigger/).fill(tp.split('.')[0]);
    await dialog.getByLabel(/Stop-loss trigger/).fill(sl.split('.')[0]);
    // Both on the whole position again, so whichever fires closes it.
    await dialog.getByLabel('Take-profit size (optional)').fill('');
    await dialog.getByLabel('Stop-loss size (optional)').fill('');
    const sent = page.waitForResponse((r) => r.url().includes(`/positions/${positionId}/protection`) && r.request().method() === 'PUT');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const answer = await sent;
    if (answer.status() === 200) break;
    expect((await answer.json()).error).toBe('trade.protection_wrong_side');
    expect(attempt).toBeLessThan(4);
  }
  await expect(current.locator('[data-leg="take_profit"]')).toContainText('Take profit: Armed');
  await expect(current.locator('[data-leg="stop_loss"]')).toContainText('Stop loss: Armed');
  const pair = (await legs(me, positionId)).filter((o) => o.status === 'armed');
  expect(pair).toHaveLength(2);

  // The pair is listed with every stop on the Orders tab, which keeps a fired one after its position has gone.
  await expect(dialog.getByRole('button', { name: 'Close dialog' }).first()).toBeInViewport();
  await dialog.getByRole('button', { name: 'Close dialog' }).first().click();
  await page.getByRole('tab', { name: 'Orders' }).click();
  const triggers = page.getByRole('region', { name: 'Take-profit, stop-loss and stop orders' });
  const rows = triggers.getByRole('row');
  // Both listed; at 3 bps the walk can cross one before the tab is read, so a leg may already be on its way out.
  await expect(rows.filter({ hasText: 'judged on the mark price' }).first()).toBeVisible();

  // The walk crosses one: it shows filled, with what it closed and through which order, and the other cancelled
  // because the position closed.
  const filled = rows.filter({ hasText: 'Filled' });
  await expect(filled).toHaveCount(1, { timeout: 180_000 });
  await expect(filled).toContainText(`Fired for ${size}; ${size} closed so far`);
  await expect(filled).toContainText('Close order ');
  await expect(rows.filter({ hasText: 'The position closed, so this one is no longer needed.' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Armed' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Positions' }).click();
  await expect(page.getByText('No open futures positions')).toBeVisible();

  // Through the API: one leg filled, the other cancelled position_closed, the position gone.
  const done = await legs(me, positionId);
  const live = done.filter((o) => pair.some((p) => p.id === o.id));
  const fired = live.find((o) => o.status === 'filled');
  const other = live.find((o) => o.id !== fired.id);
  expect(other).toMatchObject({ status: 'cancelled', cancelReason: 'position_closed' });
  expect(fired).toMatchObject({ firedQuantity: size, closedQuantity: size, triggerSource: 'mark' });
  expect((await me.get('/api/v1/positions')).body.filter((p) => p.id === positionId)).toEqual([]);

  // It closed through the book: one reduce-only sell for the whole size, on the fired leg's own client id, filled.
  // A few more conditional ticks later there is still only that one.
  await new Promise((r) => setTimeout(r, 6_000));
  const { body } = await me.get('/api/v1/futures/orders?scope=all&limit=50');
  const orders = body.orders ?? body;
  const closes = orders.filter((o) => (o.clientOrderId ?? '').startsWith(`cond:${fired.id}`));
  expect(closes.map((o) => [o.orderId, o.side, o.reduceOnly, o.status, o.filledQty])).toEqual([
    [fired.closeOrderId, 'sell', true, 'filled', size],
  ]);
  expect(orders.filter((o) => (o.clientOrderId ?? '').startsWith(`cond:${other.id}`))).toEqual([]);
});

test(`${J} #7 a fired stop fails: the reason in words and what happened to the position`, async ({ page }) => {
  test.setTimeout(240_000);
  const me = await api(account());
  // #6 closed the position: a new one, and a reduce-only sell resting 3% above the mark for all of it. A take profit
  // or stop loss that fires then has nothing left to close, which the service refuses rather than over-closing.
  const position = await openPosition(me);
  const size = position.contracts;
  const mark = await markOf(me);
  const resting = await me.post('/api/v1/futures/orders', {
    symbol: SYMBOL,
    side: 'sell',
    type: 'limit',
    price: away(mark, 300),
    amount: size,
    reduceOnly: true,
    marginMode: 'isolated',
    clientOrderId: `${J}-cover-${Date.now()}`,
  });
  expect(resting.status, JSON.stringify(resting.body)).toBeLessThan(300);
  expect(resting.body).toMatchObject({ status: 'open', reduceOnly: true });
  const restingId = resting.body.orderId ?? resting.body.id;

  await desk(page);
  const dialog = await protection(page);
  for (let attempt = 0; ; attempt += 1) {
    const now = await markOf(me);
    await dialog.getByLabel(/Take-profit trigger/).fill(fromUnits(now + (now * 3n) / 10_000n + 10n ** 18n).split('.')[0]);
    await dialog.getByLabel(/Stop-loss trigger/).fill(fromUnits(now - (now * 3n) / 10_000n - 10n ** 18n).split('.')[0]);
    const sent = page.waitForResponse((r) => r.url().includes(`/positions/${position.id}/protection`) && r.request().method() === 'PUT');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const answer = await sent;
    if (answer.status() === 200) break;
    expect((await answer.json()).error).toBe('trade.protection_wrong_side');
    expect(attempt).toBeLessThan(4);
  }

  // The walk crosses one leg. It fires and fails: the dialog says why and where the position stands.
  const current = dialog.getByRole('region', { name: 'On this position now' });
  const failedLeg = current.locator('[data-status="failed"]');
  await expect(failedLeg.first()).toBeVisible({ timeout: 180_000 });
  const why = 'It fired, but your other close orders already cover the whole position, so it had nothing left to close.';
  const where = `Nothing was closed by it. Now the position is open: Long ${size}.`;
  await expect(failedLeg.first()).toContainText('Failed');
  await expect(failedLeg.first()).toContainText(why);
  await expect(failedLeg.first()).toContainText(where);

  // The Orders tab keeps the same record.
  await dialog.getByRole('button', { name: 'Close dialog' }).first().click();
  await page.getByRole('tab', { name: 'Orders' }).click();
  const row = page
    .getByRole('region', { name: 'Take-profit, stop-loss and stop orders' })
    .getByRole('row')
    .filter({ hasText: why })
    .first();
  await expect(row).toContainText('Failed');
  await expect(row).toContainText(where);

  // Through the API: failed by name, nothing closed, the position as it was, and no close order placed for it.
  const failed = (await legs(me, position.id)).find((o) => o.status === 'failed');
  expect(failed).toMatchObject({ failureReason: 'trade.futures_reduce_only_exceeds_position' });
  expect(failed.closedQuantity ?? '0').toMatch(/^0(\.0+)?$/);
  const after = (await me.get('/api/v1/positions')).body.find((p) => p.id === position.id);
  expect(after).toMatchObject({ status: 'open', contracts: size });
  const { body } = await me.get('/api/v1/futures/orders?scope=all&limit=50');
  const orders = body.orders ?? body;
  expect(orders.filter((o) => (o.clientOrderId ?? '').startsWith(`cond:${failed.id}`) && !/^0(\.0+)?$/.test(o.filledQty ?? '0'))).toEqual(
    [],
  );

  // Back to nothing open for the next step: any leg still armed comes off first (so it cannot fire once the cover is
  // gone), then the resting sell, then a reduce-only close.
  for (const leg of (await legs(me, position.id)).filter((o) => o.status === 'armed')) {
    expect((await me.delete(`/api/v1/futures/conditional-orders/${leg.id}`)).status).toBe(200);
  }
  expect((await me.delete(`/api/v1/futures/orders/${restingId}`)).status).toBe(200);
  const close = await me.post('/api/v1/futures/orders', {
    symbol: SYMBOL,
    side: 'sell',
    type: 'market',
    amount: size,
    reduceOnly: true,
    marginMode: 'isolated',
    clientOrderId: `${J}-close-7-${Date.now()}`,
  });
  expect(close.status, JSON.stringify(close.body)).toBeLessThan(300);
  await until(
    async () => (await me.get('/api/v1/positions')).body.filter((p) => p.id === position.id && p.status === 'open'),
    (open) => open.length === 0,
    'no open position after the close',
  );
});

test(`${J} #8 a reduce-only order with nothing open is refused; a linked take profit and stop loss: one fills, the other is cancelled`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const me = await api(account());
  // #7 closed everything on the contract.
  expect((await me.get('/api/v1/positions')).body.filter((p) => p.symbol === SYMBOL && p.status === 'open')).toEqual([]);
  await desk(page);
  const ticket = page.getByRole('region', { name: 'Order ticket' });

  // Reduce-only from the ticket: a sell only lowers a long, and there is none.
  await ticket.getByRole('button', { name: 'Short', exact: true }).click();
  await ticket.getByRole('switch', { name: 'Reduce-only' }).click();
  await expect(ticket.getByText(/^On: a buy only lowers an open short and a sell only lowers an open long/)).toBeVisible();
  await expect(ticket.getByRole('textbox', { name: 'Leverage' })).toBeDisabled();
  await expect(ticket.getByRole('textbox', { name: /^Take profit/ })).toBeDisabled();
  // The direction says what the order does once reduce-only is on.
  await expect(ticket.getByRole('button', { name: 'Sell (lowers a long)', exact: true })).toBeVisible();
  await ticket.getByRole('textbox', { name: 'Size' }).fill(SIZE);
  await ticket.getByRole('button', { name: 'Sell, reduce only' }).click();
  const confirm = page.getByRole('alertdialog', { name: `Reduce-only sell on ${SYMBOL}` });
  await expect(confirm).toContainText('It can only lower your open long, by at most this size.');
  const sent = page.waitForResponse((r) => r.url().endsWith('/futures/orders') && r.request().method() === 'POST');
  await confirm.getByRole('button', { name: 'Confirm reduce-only sell' }).click();
  const answer = await sent;
  const request = answer.request().postDataJSON();
  expect(request).toMatchObject({ side: 'sell', amount: SIZE, reduceOnly: true });
  expect(request.leverage).toBeUndefined();
  expect(request.clientOrderId).toMatch(/^reduce:/);
  expect((await answer.json()).error).toBe('trade.futures_reduce_only_no_position');
  await expect(ticket.getByText('No open position to reduce')).toBeVisible();
  await expect(ticket.getByText('trade.futures_reduce_only_no_position')).toBeVisible();
  // Nothing was placed and nothing opened.
  const { body } = await me.get('/api/v1/futures/orders?scope=all&limit=50');
  expect((body.orders ?? body).filter((o) => o.clientOrderId === request.clientOrderId && o.status !== 'refused')).toEqual([]);
  expect((await me.get('/api/v1/positions')).body.filter((p) => p.symbol === SYMBOL && p.status === 'open')).toEqual([]);
  await ticket.getByRole('switch', { name: 'Reduce-only' }).click();

  // A linked pair: a take profit and a stop loss each on half of a new long, 3 bps either side of the mark.
  const position = await openPosition(me);
  const half = fromUnits(toUnits(position.contracts) / 2n);
  await page.reload();
  const dialog = await protection(page);
  for (let attempt = 0; ; attempt += 1) {
    const now = await markOf(me);
    await dialog.getByLabel(/Take-profit trigger/).fill(fromUnits(now + (now * 3n) / 10_000n + 10n ** 18n).split('.')[0]);
    await dialog.getByLabel(/Stop-loss trigger/).fill(fromUnits(now - (now * 3n) / 10_000n - 10n ** 18n).split('.')[0]);
    await dialog.getByLabel('Take-profit size (optional)').fill(half);
    await dialog.getByLabel('Stop-loss size (optional)').fill(half);
    const saved = page.waitForResponse((r) => r.url().includes(`/positions/${position.id}/protection`) && r.request().method() === 'PUT');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const reply = await saved;
    if (reply.status() === 200) break;
    expect((await reply.json()).error).toBe('trade.protection_wrong_side');
    expect(attempt).toBeLessThan(4);
  }
  const pair = (await legs(me, position.id)).filter((o) => o.status === 'armed');
  expect(pair.map((o) => [o.attachment, o.quantity, o.wholePosition]).sort()).toEqual([
    ['stop_loss', half, false],
    ['take_profit', half, false],
  ]);

  // The walk crosses one: it fills its half, and its partner is cancelled as linked. The other half stays open.
  await dialog.getByRole('button', { name: 'Close dialog' }).first().click();
  await page.getByRole('tab', { name: 'Orders' }).click();
  const rows = page.getByRole('region', { name: 'Take-profit, stop-loss and stop orders' }).getByRole('row');
  const linked = 'Its linked take profit or stop loss filled, so this one was cancelled.';
  await expect(rows.filter({ hasText: linked })).toHaveCount(1, { timeout: 180_000 });
  await expect(rows.filter({ hasText: `Fired for ${half}; ${half} closed so far` })).toHaveCount(1);
  const done = (await legs(me, position.id)).filter((o) => pair.some((p) => p.id === o.id));
  const fired = done.find((o) => o.status === 'filled');
  expect(fired).toMatchObject({ closedQuantity: half });
  expect(done.find((o) => o.id !== fired.id)).toMatchObject({ status: 'cancelled', cancelReason: 'linked' });
  const left = await until(
    async () => (await me.get('/api/v1/positions')).body.find((p) => p.id === position.id),
    (p) => p?.contracts === half,
    'the half left open',
  );
  expect(left).toMatchObject({ status: 'open' });

  // Back to nothing open for the next step.
  const close = await me.post('/api/v1/futures/orders', {
    symbol: SYMBOL,
    side: 'sell',
    type: 'market',
    amount: half,
    reduceOnly: true,
    marginMode: 'isolated',
    clientOrderId: `${J}-close-8-${Date.now()}`,
  });
  expect(close.status, JSON.stringify(close.body)).toBeLessThan(300);
  await until(
    async () => (await me.get('/api/v1/positions')).body.filter((p) => p.id === position.id && p.status === 'open'),
    (open) => open.length === 0,
    'no open position after the close',
  );
});

test(`${J} #9 presses one-tap reverse: a reviewed close and an open on the other side, under one request`, async ({ page }) => {
  test.setTimeout(180_000);
  const me = await api(account());
  // A short left by an earlier run of this step that stopped part way is closed first.
  const left = (await me.get('/api/v1/positions')).body.find((p) => p.symbol === SYMBOL && p.side === 'short' && p.status === 'open');
  if (left) {
    const flat = await me.post('/api/v1/futures/orders', {
      symbol: SYMBOL,
      side: 'buy',
      type: 'market',
      amount: left.contracts,
      reduceOnly: true,
      marginMode: 'isolated',
      clientOrderId: `${J}-flat-9-${Date.now()}`,
    });
    expect(flat.status, JSON.stringify(flat.body)).toBeLessThan(300);
    await until(
      async () => (await me.get('/api/v1/positions')).body.filter((p) => p.symbol === SYMBOL && p.status === 'open'),
      (open) => open.length === 0,
      'no open position before the reverse',
    );
  }
  const position = await openPosition(me);
  const size = position.contracts;
  await desk(page);
  await page.getByRole('tab', { name: 'Positions' }).click();
  await page.getByRole('button', { name: `Manage ${SYMBOL}` }).click();
  await page.getByRole('menuitem', { name: 'Reverse' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reverse position' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Closes your Long ${size} on ${SYMBOL} at market, then opens a Short ${size} at market`);

  // The review prices the short from the service's own preview; a margin tier it moves into is accepted first.
  const review = dialog.getByRole('region', { name: 'The Short it opens' });
  await expect(review.getByText('Initial margin')).toBeVisible();
  await expect(review.getByText('Liquidation price')).toBeVisible();
  const accept = review.getByRole('checkbox');
  if ((await accept.count()) > 0) await accept.click();

  const sent = page.waitForResponse((r) => r.url().endsWith(`/positions/${position.id}/reverse`) && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Reverse to Short' }).click();
  const first = await sent;
  const { clientRequestId } = first.request().postDataJSON();
  expect(clientRequestId).toMatch(/^reverse:/);
  const outcome = dialog.locator('[data-reverse]');
  await expect(outcome).toHaveAttribute('data-reverse', 'done', { timeout: 30_000 });
  await expect(outcome).toContainText(`Reversed: now Short ${size} at ${LEVERAGE}x.`);

  // Through the API: the long closed, a short of the same size open, and exactly two legs under the one request.
  const positions = await until(
    async () => (await me.get('/api/v1/positions')).body.filter((p) => p.symbol === SYMBOL && p.status === 'open'),
    (open) => open.length === 1 && open[0].side === 'short',
    'the short after the reverse',
  );
  expect(positions[0]).toMatchObject({ side: 'short', contracts: size });
  // The long has left the positions list, and the outcome is still on screen.
  await page.waitForResponse(async (r) => {
    if (r.request().method() !== 'GET' || !/\/positions(\?|$)/.test(r.url())) return false;
    const body = await r.json().catch(() => null);
    return Array.isArray(body) && !body.some((p) => p.id === position.id && p.status === 'open');
  });
  await expect(page.locator('[data-reverse="done"]')).toContainText(`Reversed: now Short ${size} at ${LEVERAGE}x.`);
  const legsOf = async () => {
    const { body } = await me.get('/api/v1/futures/orders?scope=all&limit=50');
    return (body.orders ?? body)
      .filter((o) => (o.clientOrderId ?? '').endsWith(clientRequestId))
      .map((o) => [o.clientOrderId, o.side, o.reduceOnly, o.status, o.filledQty])
      .sort();
  };
  const legs = await legsOf();
  expect(legs).toEqual([
    [`rv:c:${clientRequestId}`, 'sell', true, 'filled', size],
    [`rv:o:${clientRequestId}`, 'sell', false, 'filled', size],
  ]);

  // The same request again answers the same reverse and places nothing.
  const again = await me.post(`/api/v1/positions/${position.id}/reverse`, { clientRequestId });
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ status: 'done', from: 'long', to: 'short', size, newPositionId: positions[0].id });
  expect(await legsOf()).toEqual(legs);

  // Back to nothing open.
  const close = await me.post('/api/v1/futures/orders', {
    symbol: SYMBOL,
    side: 'buy',
    type: 'market',
    amount: size,
    reduceOnly: true,
    marginMode: 'isolated',
    clientOrderId: `${J}-close-9-${Date.now()}`,
  });
  expect(close.status, JSON.stringify(close.body)).toBeLessThan(300);
  await until(
    async () => (await me.get('/api/v1/positions')).body.filter((p) => p.symbol === SYMBOL && p.status === 'open'),
    (open) => open.length === 0,
    'no open position after the close',
  );
});
