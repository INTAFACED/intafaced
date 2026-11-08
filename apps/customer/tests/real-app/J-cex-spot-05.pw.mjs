// World: book
import { test, expect } from './journey.mjs';
import { api, fromUnits, fund, journeyState, toUnits } from './stack.mjs';
import { awayBid, confirm, free, fundedTrader, held, openDesk, openOrders } from './desk.mjs';

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

const openTable = (page) => page.getByTestId('dk-bottom-body').locator('table');
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
    'Select',
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
  // Every open order is a row, each with its own price, amount, filled and the hold its venue lock takes.
  const seeded = [
    [orders.a, 'BTC/USDT', btc, '0.002'],
    [orders.b, 'BTC/USDT', fromUnits(toUnits(btc) - toUnits('10')), '0.001'],
    [orders.e, 'ETH/USDT', eth, '0.01'],
  ];
  await expect(openTable(page).locator('tbody tr')).toHaveCount(seeded.length);
  let sum = 0n;
  for (const [order, symbol, price, amount] of seeded) {
    const hold = (await orderById(who, order.id, symbol)).hold;
    expect(hold?.asset).toBe('USDT');
    expect(toUnits(hold.amount)).toBeGreaterThanOrEqual((toUnits(price) * toUnits(amount)) / toUnits('1'));
    sum += toUnits(hold.amount);
    const cells = openTable(page)
      .locator('tbody tr')
      .filter({ hasText: symbol })
      .filter({ hasText: shown(price) })
      .locator('td');
    await expect(cells.nth(2)).toHaveText(symbol);
    await expect(cells.nth(5)).toHaveText(shown(price));
    await expect(cells.nth(6)).toHaveText(amount);
    await expect(cells.nth(7)).toHaveText('0');
    await expect(cells.nth(8)).toHaveText(`${shownHold(hold.amount)} USDT`);
  }
  // The holds of the open orders are what the ledger holds.
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

  // A replacement that fails after the original was cancelled never claims the old order is safe: a fresh TEST order,
  // replaced by one whose hold is more than the account has free once the old hold is back. The answer names the
  // original as cancelled, no replacement, nothing accepted; the old lock was released exactly once and no new one taken.
  const spare = await rest(who, 'BTC/USDT', fromUnits(toUnits(btc) - toUnits('3')), '0.001', '4c');
  const spareHold = toUnits((await orderById(who, spare.id)).hold.amount);
  const heldWithSpare = held(await (await api(who)).balances(), 'USDT');
  expect(heldWithSpare).toBe(heldNow + spareHold);
  const freeNow = free(await (await api(who)).balances(), 'USDT');
  const tooBig = fromUnits((((freeNow + spareHold) * 2n * toUnits('1')) / toUnits(next) / 10n ** 13n) * 10n ** 13n);
  const failed = await (
    await api(who)
  ).post(`/api/v1/orders/${spare.id}/replace`, {
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    price: next,
    amount: tooBig,
    timeInForce: 'GTC',
    clientOrderId: `${J}-4-fail-${Date.now()}`,
  });
  expect(failed.body, JSON.stringify(failed.body).slice(0, 400)).toMatchObject({
    accepted: false,
    code: 'REPLACEMENT_NOT_SUBMITTED',
    originalOrderId: spare.id,
    // The outcome names the original as cancelled (its own spelling; the order read below says `canceled`), never open.
    originalState: expect.stringMatching(/^cancell?ed$/),
    replacementOrderId: null,
  });
  expect((await orderById(who, spare.id)).status).toBe('canceled');
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(heldNow);
  expect((await openOrders(who)).map((o) => o.id).sort()).toEqual(open.map((o) => o.id).sort());
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

test(`${J} #6 cancels a batch by ids, then every spot order: each id answered, an unknown id reported, holds released`, async ({
  page,
}) => {
  const who = account();
  const { orders, btc } = run.read();
  const one = await rest(who, 'BTC/USDT', btc, '0.001', '6a');
  const two = await rest(who, 'BTC/USDT', fromUnits(toUnits(btc) - toUnits('7')), '0.001', '6b');
  const ethHold = toUnits((await orderById(who, orders.e.id, 'ETH/USDT')).hold.amount);

  // The service on its own: an id that is not the caller's open order is answered as refused, the rest still go.
  const unknown = await (await api(who)).post('/api/v1/orders/batch-cancel', { ids: [two.id, 'not-an-order'] });
  expect(unknown.status).toBe(200);
  expect(unknown.body.results.map((r) => [r.orderId, r.status])).toEqual([
    [two.id, 'success'],
    ['not-an-order', 'refused'],
  ]);
  expect((await orderById(who, two.id)).status).toBe('canceled');

  // In the desk: tick this market's order, the other market's, and a third that is gone by the time the batch is sent
  // (cancelled on its own door meanwhile). One batch request; each id answered from the venue, the gone one reported
  // as not cancelled, the rest cancelled.
  const three = await rest(who, 'BTC/USDT', fromUnits(toUnits(btc) - toUnits('9')), '0.001', '6e');
  await openDesk(page, who);
  const batches = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/orders/batch-cancel') batches.push(r.postDataJSON());
  });
  await rowOf(page, shown(btc)).getByRole('checkbox').check();
  await rowOf(page, shown(fromUnits(toUnits(btc) - toUnits('9'))))
    .getByRole('checkbox')
    .check();
  await openTable(page).locator('tbody tr').filter({ hasText: 'ETH/USDT' }).getByRole('checkbox').check();
  const gone = await (await api(who)).delete(`/api/v1/orders/${three.id}?symbol=${encodeURIComponent('BTC/USDT')}`);
  expect(gone.status, JSON.stringify(gone.body).slice(0, 300)).toBeLessThan(300);
  await page.getByRole('button', { name: 'Cancel orders…' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('radio', { name: 'The 3 selected' })).toBeChecked();
  expect(batches).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Cancel orders' }).click();
  await expect(dialog).toContainText('2 of 3 cancelled.');
  await expect(dialog).toContainText('ETH/USDT: Cancelled');
  await expect(dialog).toContainText('BTC/USDT: Cancelled');
  await expect(dialog).toContainText('Not cancelled:');
  expect(batches).toHaveLength(1);
  expect([...batches[0].ids].sort()).toEqual([one.id, three.id, orders.e.id].sort());
  await dialog.getByRole('button', { name: 'Close' }).click();
  expect(await openOrders(who)).toHaveLength(0);
  expect(await openOrders(who, 'ETH/USDT')).toHaveLength(0);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(0n);
  expect(ethHold).toBeGreaterThan(0n);

  // Spot only: two new orders in two spot markets and one resting TEST futures order (another product), one request
  // with kind=spot, both spot orders cancelled; the futures order still rests with its margin still held.
  const sixC = await rest(who, 'BTC/USDT', btc, '0.001', '6c');
  const sixD = await rest(who, 'ETH/USDT', run.read().eth, '0.01', '6d');
  const spotHolds = toUnits((await orderById(who, sixC.id)).hold.amount) + toUnits((await orderById(who, sixD.id, 'ETH/USDT')).hold.amount);
  const me = await api(who);
  const preview = await me.post('/api/v1/positions/preview', { symbol: 'BTC/USDT:USDT', side: 'long', size: '0.001', leverage: '2' });
  expect(preview.status, JSON.stringify(preview.body).slice(0, 300)).toBe(200);
  const cent = 10n ** 16n;
  const futPrice = fromUnits(((toUnits(preview.body.markPrice) * 97n) / 100n / cent) * cent);
  const fut = await me.post('/api/v1/futures/orders', {
    symbol: 'BTC/USDT:USDT',
    side: 'buy',
    type: 'limit',
    price: futPrice,
    amount: '0.001',
    leverage: '2',
    marginMode: 'isolated',
    clientOrderId: `${J}-6f-${Date.now()}`,
  });
  expect(fut.status, JSON.stringify(fut.body).slice(0, 300)).toBe(200);
  expect(fut.body).toMatchObject({ status: 'open', limitPrice: futPrice, filledQty: '0' });
  const futId = fut.body.orderId;
  const futOpen = await me.get(`/api/v1/futures/orders/${futId}`);
  expect(futOpen.body.status, JSON.stringify(futOpen.body).slice(0, 300)).toBe('open');
  const heldWithFutures = held(await me.balances(), 'USDT');
  await page.reload();
  await expect(rowOf(page, shown(btc))).toHaveCount(1);
  await expect(openTable(page).locator('tbody tr').filter({ hasText: 'ETH/USDT' })).toHaveCount(1);
  const deletes = [];
  page.on('request', (r) => {
    if (r.method() === 'DELETE' && new URL(r.url()).pathname === '/api/v1/orders') deletes.push(new URL(r.url()).search);
  });
  await page.getByRole('button', { name: 'Cancel orders…' }).click();
  await expect(dialog.getByRole('radio', { name: /Every spot order/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel orders' }).click();
  await expect(dialog).toContainText('Cancelled 2 orders.');
  expect(deletes).toEqual(['?kind=spot']);
  await dialog.getByRole('button', { name: 'Close' }).click();
  expect([...(await openOrders(who)), ...(await openOrders(who, 'ETH/USDT'))]).toHaveLength(0);
  const futAfter = await me.get(`/api/v1/futures/orders/${futId}`);
  expect(futAfter.body.status, JSON.stringify(futAfter.body).slice(0, 300)).toBe('open');
  // Exactly the two spot holds came back; whatever the futures order holds did not move.
  expect(held(await me.balances(), 'USDT')).toBe(heldWithFutures - spotHolds);
  expect({ ...futAfter.body, status: undefined }).toMatchObject({ ...futOpen.body, status: undefined });
  // The futures order is then cancelled on its own door (clean-up, not this step's claim).
  const futCancel = await me.delete(`/api/v1/futures/orders/${futId}`);
  expect(futCancel.status, JSON.stringify(futCancel.body).slice(0, 300)).toBeLessThan(300);
});

test(`${J} #7 looks at Positions: not applicable to cash spot, no zero row`, async ({ page }) => {
  const who = account();
  await openDesk(page, who);
  await page.getByRole('tab', { name: 'Positions', exact: true }).click();
  await expect(page.getByText('Not applicable: cash spot holds balances, not positions')).toBeVisible();
  await expect(page.getByTestId('dk-bottom-body').locator('table')).toHaveCount(0);
});

test(`${J} #8 presses Flatten on a held coin: one reviewed market sell of all of it, the same order on every retry`, async ({ page }) => {
  const who = account();
  expect(fund(who.email, 'BTC', '0.003', `${J}-8-${Date.now()}`).tx).toBeTruthy();
  const before = await (await api(who)).balances();
  const btcFree = before.BTC.free;
  expect(toUnits(btcFree)).toBeGreaterThan(0n);
  await openDesk(page, who);
  const posts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/orders') posts.push(r.postDataJSON());
  });
  await page.getByRole('tab', { name: 'Assets' }).click();
  const flatten = page.getByRole('button', { name: /^Flatten BTC: sell all/ });
  await flatten.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Review your sell');
  await expect(dialog).toContainText('Price protection');
  const reference = await dialog.getByText('Client order ID').locator('..').getByTestId('client-order-id').innerText();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await flatten.click();
  await expect(dialog).toContainText('Review your sell');
  expect(await dialog.getByText('Client order ID').locator('..').getByTestId('client-order-id').innerText()).toBe(reference);
  expect(posts).toHaveLength(0);
  // The TEST market can move the protection price between review and confirm; the desk then asks again, before sending.
  await confirm(page, 'sell');
  await expect(page.locator('form[data-testid="dk-form"][data-side="sell"]')).toContainText(/Your sell order (filled|is in)/, {
    timeout: 20_000,
  });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ symbol: 'BTC/USDT', side: 'sell', type: 'market', amount: btcFree });
  expect(posts[0].clientOrderId.endsWith(`:${reference}`)).toBe(true);
  // Sending the very same order again returns the first, never a second sell.
  const again = await (await api(who)).post('/api/v1/orders', posts[0]);
  expect(again.status).toBeLessThan(300);
  await expect.poll(async () => free(await (await api(who)).balances(), 'BTC')).toBe(0n);
  const sells = (await (await api(who)).get('/api/v1/orders/closed?symbol=BTC%2FUSDT&limit=50')).body.filter(
    (o) => o.side === 'sell' && o.clientOrderId === again.body.clientOrderId,
  );
  expect(sells).toHaveLength(1);
});
