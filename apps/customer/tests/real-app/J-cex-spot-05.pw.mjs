import { test, expect } from '@playwright/test';
import { api, fromUnits, journeyState, toUnits } from './stack.mjs';
import { awayBid, fundedTrader, held, openDesk, openOrders } from './desk.mjs';

// J-cex-spot-05, in the running app (docs/roadmap/journeys.json): a person changes and cancels open orders, one by one
// or all at once, and the hold matches the order after every step. One test per step, titled "J-cex-spot-05 #<n>", run
// in order on one TEST account funded with TEST USDT through the real ledger. The orders rest far under the TEST market
// maker's bids, so nothing fills while the journey runs.
const J = 'J-cex-spot-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const FUNDED = '5000';

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

const openTable = (page) => page.locator('.dk-bottom-body table');
const rowOf = (page, price) => openTable(page).locator('tbody tr').filter({ hasText: price });
const editDialog = (page) => page.getByRole('alertdialog');
/** "64000" as the desk writes a USDT price: "64,000.00". */
const shown = (price) => Number(price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** A quote hold as the desk writes it: six places, "52.108000". */
const shownHold = (amount) => Number(amount).toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });

async function rest(who, symbol, price, amount, key) {
  const res = await (
    await api(who)
  ).post('/api/v1/orders', {
    symbol,
    type: 'limit',
    side: 'buy',
    amount,
    price,
    timeInForce: 'GTC',
    clientOrderId: `${J}-${key}-${Date.now()}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
  return res.body;
}

async function orderById(who, id, symbol = 'BTC/USDT') {
  const { status, body } = await (await api(who)).get(`/api/v1/orders/${id}?symbol=${encodeURIComponent(symbol)}`);
  expect(status).toBe(200);
  return body;
}

test(`${J} #1 opens Open orders: each order with its price, amount, filled and hold`, async ({ page }) => {
  const who = await fundedTrader(page, 'js5', FUNDED);
  const btc = await awayBid(80);
  const eth = await awayBid(80, 'ETH/USDT');
  const orders = {
    a: await rest(who, 'BTC/USDT', btc, '0.002', 'a'),
    b: await rest(who, 'BTC/USDT', fromUnits(toUnits(btc) - toUnits('10')), '0.001', 'b'),
    e: await rest(who, 'ETH/USDT', eth, '0.01', 'e'),
  };
  run.reset({ account: who, orders, btc, eth });
  await openDesk(page, who);
  await expect(openTable(page).locator('thead th')).toHaveText([
    'Time',
    'Market',
    'Type',
    'Side',
    'Price',
    'Amount',
    'Filled',
    'Held',
    'Action',
  ]);
  const cells = rowOf(page, shown(btc)).locator('td');
  const hold = (await orderById(who, orders.a.id)).hold;
  expect(hold?.asset).toBe('USDT');
  expect(toUnits(hold.amount)).toBeGreaterThanOrEqual((toUnits(btc) * toUnits('0.002')) / toUnits('1'));
  await expect(cells.nth(4)).toHaveText(shown(btc));
  await expect(cells.nth(5)).toHaveText('0.002');
  await expect(cells.nth(6)).toHaveText('0');
  await expect(cells.nth(7)).toHaveText(`${shownHold(hold.amount)} USDT`);
  // The holds of the open orders are what the ledger holds.
  const all = [orders.a, orders.b].map((o) => o.id);
  let sum = 0n;
  for (const id of all) sum += toUnits((await orderById(who, id)).hold.amount);
  sum += toUnits((await orderById(who, orders.e.id, 'ETH/USDT')).hold.amount);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(sum);
});

test(`${J} #2 lowers the amount of an open order: the same order, a smaller hold, the same price and place`, async ({ page }) => {
  const who = account();
  const { orders, btc } = run.read();
  const before = await orderById(who, orders.a.id);
  await openDesk(page, who);
  await rowOf(page, shown(btc))
    .getByRole('button', { name: /Edit buy order/ })
    .click();
  await editDialog(page).getByRole('textbox', { name: 'Amount left' }).fill('0.001');
  await expect(editDialog(page)).toContainText('Lowering the amount keeps your place in the queue.');
  await editDialog(page).getByRole('button', { name: 'Change amount' }).click();
  await expect(editDialog(page)).toContainText('Your place in the queue was kept');
  await editDialog(page).getByRole('button', { name: 'Close' }).click();
  const after = await orderById(who, orders.a.id);
  expect(after.id).toBe(before.id);
  expect(after.price).toBe(before.price);
  expect(after.remaining).toBe('0.001');
  expect(toUnits(after.hold.amount)).toBeLessThan(toUnits(before.hold.amount));
  await expect(rowOf(page, shown(btc))).toContainText(`${shownHold(after.hold.amount)} USDT`);
});

test(`${J} #3 tries to raise the amount: refused in words, the order and its hold untouched`, async ({ page }) => {
  const who = account();
  const { orders, btc } = run.read();
  const before = await orderById(who, orders.a.id);
  const heldBefore = held(await (await api(who)).balances(), 'USDT');
  await openDesk(page, who);
  await rowOf(page, shown(btc))
    .getByRole('button', { name: /Edit buy order/ })
    .click();
  await editDialog(page).getByRole('textbox', { name: 'Amount left' }).fill('0.005');
  await expect(editDialog(page)).toContainText(/can’t raise|cannot raise|only lower/i);
  await expect(editDialog(page)).not.toContainText('trade.');
  // The service refuses the same on its own: the amend door answers with its outcome, not accepted, and the typed reason.
  const raised = await (await api(who)).patch(`/api/v1/orders/${orders.a.id}`, { qty: '0.005' });
  expect(raised.body).toMatchObject({ accepted: false, code: 'NOT_AMENDABLE', reasonCode: 'trade.amend_qty_up' });
  const after = await orderById(who, orders.a.id);
  expect([after.remaining, after.price, after.hold.amount]).toEqual([before.remaining, before.price, before.hold.amount]);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(heldBefore);
});

test(`${J} #4 changes the price: reviewed first, then the original is cancelled and the replacement rests under its own id`, async ({
  page,
}) => {
  const who = account();
  const { orders, btc } = run.read();
  const next = fromUnits(toUnits(btc) - toUnits('5'));
  await openDesk(page, who);
  await rowOf(page, shown(btc))
    .getByRole('button', { name: /Edit buy order/ })
    .click();
  await editDialog(page).getByRole('textbox', { name: 'Price' }).fill(next);
  await expect(editDialog(page)).toContainText('the old one is cancelled first');
  await editDialog(page).getByRole('button', { name: 'Review replacement' }).click();
  await expect(editDialog(page)).toContainText(`${shown(btc)} → ${shown(next)}`);
  const sent = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/v1\/orders\/[^/]+\/replace$/.test(new URL(r.url()).pathname));
  await editDialog(page).getByRole('button', { name: 'Replace order' }).click();
  const request = await sent;
  await expect(editDialog(page)).toContainText('Replaced.');
  await editDialog(page).getByRole('button', { name: 'Close' }).click();

  const original = await orderById(who, orders.a.id);
  expect(original.status).toBe('canceled');
  const open = await openOrders(who);
  const replacement = open.find((o) => o.price === next);
  expect(replacement, 'the replacement rests').toBeTruthy();
  expect(replacement.id).not.toBe(orders.a.id);
  expect(replacement.clientOrderId).not.toBe(original.clientOrderId);
  expect(replacement.hold.asset).toBe('USDT');

  // Sending the same replacement again returns the first, never a second order or hold.
  const body = request.postDataJSON();
  const heldNow = held(await (await api(who)).balances(), 'USDT');
  const again = await (await api(who)).post(`/api/v1/orders/${orders.a.id}/replace`, body);
  expect(again.status).toBeLessThan(300);
  expect(again.body.replacementOrderId).toBe(replacement.id);
  expect(await openOrders(who)).toHaveLength(open.length);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(heldNow);

  // A replacement the service refuses before the cancel leaves the original live and says why.
  const far = fromUnits(toUnits(next) * 3n);
  const refused = await (
    await api(who)
  ).post(`/api/v1/orders/${replacement.id}/replace`, {
    ...body,
    price: far,
    clientOrderId: `${J}-4-far-${Date.now()}`,
  });
  expect(JSON.stringify(refused.body)).toContain('trade.price_band');
  expect((await orderById(who, replacement.id)).status).toBe('open');
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(heldNow);
  run.write({ ...run.read(), replacement });
});

test(`${J} #5 presses Cancel all in this market: asked first, only this market's orders cancel in one request, holds released`, async ({
  page,
}) => {
  const who = account();
  const { orders } = run.read();
  const btcOpen = await openOrders(who);
  expect(btcOpen.length).toBeGreaterThanOrEqual(2);
  const ethHold = toUnits((await orderById(who, orders.e.id, 'ETH/USDT')).hold.amount);
  await openDesk(page, who);
  const deletes = [];
  page.on('request', (r) => {
    if (r.method() === 'DELETE' && new URL(r.url()).pathname === '/api/v1/orders') deletes.push(r.url());
  });
  await page.getByRole('button', { name: `Cancel all (${btcOpen.length})` }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Cancel all BTC/USDT orders?');
  expect(deletes).toHaveLength(0);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel all orders' }).click();
  await expect(page.getByRole('alertdialog')).toContainText(`Cancelled ${btcOpen.length} orders.`);
  expect(deletes).toHaveLength(1);
  expect(deletes[0]).toContain('symbol=BTC');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close' }).click();
  expect(await openOrders(who)).toHaveLength(0);
  expect(await openOrders(who, 'ETH/USDT')).toHaveLength(1);
  // Every BTC hold came back once: what is still held is exactly the ETH order's hold.
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(ethHold);
});

test(`${J} #7 looks at Positions: not applicable to cash spot, no zero row`, async ({ page }) => {
  const who = account();
  await openDesk(page, who);
  await page.getByRole('tab', { name: 'Positions', exact: true }).click();
  await expect(page.getByText('Not applicable: cash spot holds balances, not positions')).toBeVisible();
  await expect(page.locator('.dk-bottom-body table')).toHaveCount(0);
});
