import { test, expect } from '@playwright/test';
import { api, bestPrices, fromUnits, journeyState, otherTrader, toUnits } from './stack.mjs';
import { awayBid, fundedTrader, held, openDesk, openOrders, signIn } from './desk.mjs';

// J-cex-spot-06, in the running app (docs/roadmap/journeys.json): a person reads their order history, one order's
// detail and what each fill cost. One test per step, titled "J-cex-spot-06 #<n>", run in order on one TEST account
// funded with TEST USDT through the real ledger. The account starts with filled, cancelled, changed and many ended
// orders; the partly filled order is made in #4, where it is read and cancelled.
const J = 'J-cex-spot-06';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const FUNDED = '5000';
const SYMBOL = 'BTC/USDT';
/** More ended orders than one page holds at the smallest page size (20), so the history pages. */
const ENDED = 22;

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** One signed-in API session per account, so a step that places many orders signs in once. */
const sessions = new Map();
async function client(who) {
  if (!sessions.has(who.email)) sessions.set(who.email, await api(who));
  return sessions.get(who.email);
}

async function place(who, body, key) {
  const res = await (await client(who)).post('/api/v1/orders', { symbol: SYMBOL, clientOrderId: `${J}-${key}-${Date.now()}`, ...body });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
  return res.body;
}

async function orderById(who, id) {
  const { status, body } = await (await client(who)).get(`/api/v1/orders/${id}`);
  expect(status).toBe(200);
  return body;
}

async function fillsOf(who, id) {
  const { status, body } = await (await client(who)).get(`/api/v1/orders/${id}/trades?limit=500`);
  expect(status).toBe(200);
  return body;
}

/** The order ids a history or desk table links to, in the order shown. */
async function linkedIds(table) {
  const hrefs = await table.locator('a[data-testid="dk-order-link"]').evaluateAll((links) => links.map((a) => a.getAttribute('href')));
  return hrefs.map((href) => decodeURIComponent(href.split('/').pop()));
}

const historyTable = (page) => page.getByTestId('orders-table').locator('table');
const detail = (page) => page.locator('dl[data-testid="orders-list"]').first();
const rowValue = (scope, label) =>
  scope
    .getByTestId('orders-row')
    .filter({ has: scope.page().locator('dt', { hasText: label }) })
    .locator('dd');

test(`${J} #1 opens order history and filters by side, state and date: matching rows only, paged without repeats`, async ({ page }) => {
  // Signing up, verifying and placing the starting orders takes most of a minute before the history is opened.
  test.setTimeout(180_000);
  const who = await fundedTrader(page, 'js6', FUNDED);
  // A market buy that fills, then a market sell of part of what it bought: one filled buy, one filled sell.
  const bought = await place(who, { type: 'market', side: 'buy', amount: '0.002' }, 'mbuy');
  await expect.poll(async () => (await orderById(who, bought.id)).status, { timeout: 20_000 }).toBe('closed');
  const sold = await place(who, { type: 'market', side: 'sell', amount: '0.001' }, 'msell');
  await expect.poll(async () => (await orderById(who, sold.id)).status, { timeout: 20_000 }).toBe('closed');
  // A resting buy far under the book, cancelled by the person.
  const away = await awayBid(80);
  const cancelled = await place(who, { type: 'limit', side: 'buy', amount: '0.001', price: away, timeInForce: 'GTC' }, 'cxl');
  expect((await (await api(who)).delete(`/api/v1/orders/${cancelled.id}`)).status).toBe(200);
  // A resting buy whose amount is lowered: the amend is recorded with its time.
  const changed = await place(who, { type: 'limit', side: 'buy', amount: '0.002', price: away, timeInForce: 'GTC' }, 'amend');
  const amend = await (await api(who)).patch(`/api/v1/orders/${changed.id}`, { qty: '0.001' });
  expect(amend.body).toMatchObject({ accepted: true });
  // Immediate-or-cancel buys far under the book: each ends at once, cancelled for the part that could not fill.
  for (let i = 0; i < ENDED; i++)
    await place(who, { type: 'limit', side: 'buy', amount: '0.001', price: away, timeInForce: 'IOC' }, `ioc${i}`);
  run.reset({ account: who, ids: { bought: bought.id, sold: sold.id, cancelled: cancelled.id, changed: changed.id }, away });

  await signIn(page, who);
  await page.goto('/trade/orders');
  await expect(page.getByRole('heading', { name: 'Order history', level: 1 })).toBeVisible();
  // The smallest page is respected; older orders come a page at a time and no order is shown twice.
  await expect(page.getByText('20 orders shown')).toBeVisible();
  expect(await linkedIds(historyTable(page))).toHaveLength(20);
  await page.getByRole('button', { name: 'Show older orders' }).click();
  await expect(page.getByText(`${ENDED + 3} orders shown`)).toBeVisible();
  await expect(page.getByText('That’s every order that matches these filters.')).toBeVisible();
  const ids = await linkedIds(historyTable(page));
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of [bought.id, sold.id, cancelled.id]) expect(ids).toContain(id);
  expect(ids).not.toContain(changed.id); // still open: it is on the desk, not in history

  // Side: only the sell.
  await page.getByRole('combobox', { name: 'Side', exact: true }).selectOption({ label: 'Sell' });
  await expect(page).toHaveURL(/side=sell/);
  await expect.poll(() => linkedIds(historyTable(page))).toEqual([sold.id]);
  // State: the filled ones of both sides.
  await page.getByRole('combobox', { name: 'Side', exact: true }).selectOption({ label: 'All' });
  await page.getByRole('combobox', { name: 'State', exact: true }).selectOption({ label: 'Filled' });
  await expect.poll(async () => (await linkedIds(historyTable(page))).sort()).toEqual([bought.id, sold.id].sort());
  // Dates: today holds them; a window that ended yesterday holds none.
  const today = new Date();
  const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await page.getByRole('textbox', { name: 'From', exact: true }).fill(day(today));
  await expect.poll(async () => (await linkedIds(historyTable(page))).length).toBe(2);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  await page.getByRole('textbox', { name: 'From', exact: true }).fill(day(yesterday));
  await page.getByRole('textbox', { name: 'To', exact: true }).fill(day(yesterday));
  await expect(page.getByText('No orders match these filters.')).toBeVisible();

  // A mistyped filter in the address is refused in words, by the service's own check, never as a code.
  await page.goto('/trade/orders?side=bye');
  await expect(page.getByRole('alert')).toContainText('These filters can’t be used');
  await expect(page.getByRole('alert')).toContainText('isn’t a choice we know');
  await expect(page.getByRole('alert')).not.toContainText('trade.');
  const refused = await (await api(who)).get('/api/v1/orders/closed?limit=20&side=bye');
  expect(refused.status).toBe(400);
  expect(refused.body.intafacedCode).toBe('trade.invalid_filter');
});

test(`${J} #2 opens one order at /trade/orders/:id: state, fills and the reason, or "not recorded"`, async ({ page }) => {
  const who = account();
  const { ids } = run.read();
  await signIn(page, who);
  // Reached from the history: the row links to the order's own address.
  await page.goto('/trade/orders?status=closed');
  await historyTable(page).locator(`a[href="/trade/orders/${ids.bought}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/trade/orders/${ids.bought}$`));
  await expect(page.getByRole('heading', { name: 'Buy BTC/USDT', level: 1 })).toBeVisible();
  await expect(page.getByTestId('page-heading')).toContainText('Filled');
  await expect(rowValue(detail(page), 'Filled')).toHaveText('0.002 BTC');
  const fills = await fillsOf(who, ids.bought);
  expect(fills.length).toBeGreaterThan(0);
  await expect(page.getByTestId('orders-fill')).toHaveCount(fills.length);
  await expect(rowValue(detail(page), 'Why it ended')).toHaveCount(0);

  // A cancelled order says why it ended, or that no reason was recorded; never a raw code.
  const cancelled = await orderById(who, ids.cancelled);
  await page.goto(`/trade/orders/${ids.cancelled}`);
  await expect(page.getByTestId('page-heading')).toContainText('Cancelled');
  await expect(rowValue(detail(page), 'Why it ended')).toHaveText(cancelled.rejectCode ? /.+/ : 'Not recorded');
  await expect(page.getByText('Nothing has filled.')).toBeVisible();
  // An immediate-or-cancel order that could not fill names its reason.
  const { body: closed } = await (await api(who)).get('/api/v1/orders/closed?limit=1&status=canceled&type=limit');
  const ioc = closed[0];
  expect(ioc.rejectCode).toBe('ioc_remainder');
  await page.goto(`/trade/orders/${ioc.id}`);
  await expect(rowValue(detail(page), 'Why it ended')).toHaveText(/could not fill at once/);

  // The changed order shows its new amount, the one the service recorded.
  const changed = await orderById(who, ids.changed);
  expect(changed.amount).toBe('0.001');
  await page.goto(`/trade/orders/${ids.changed}`);
  await expect(page.getByTestId('page-heading')).toContainText('Open');
  await expect(rowValue(detail(page), 'Amount')).toHaveText('0.001 BTC');
});

test(`${J} #3 opens another person's order id: "Order not found" with no hint, and cancel and list refuse too`, async ({ page }) => {
  const who = account();
  const other = await api(otherTrader());
  const { body: theirs } = await other.post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'limit',
    side: 'buy',
    amount: '0.001',
    price: await awayBid(70),
    timeInForce: 'GTC',
    clientOrderId: `${J}-3-${Date.now()}`,
  });
  expect(theirs.id).toBeTruthy();
  try {
    await signIn(page, who);
    await page.goto(`/trade/orders/${theirs.id}`);
    await expect(page.getByRole('heading', { name: 'Order not found' })).toBeVisible();
    await expect(page.locator('#main')).not.toContainText(theirs.price ?? 'BTC/USDT');
    // A made-up id reads the same: nothing tells the two apart.
    await page.goto('/trade/orders/00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('heading', { name: 'Order not found' })).toBeVisible();
    const mine = await api(who);
    for (const [method, route] of [
      ['get', `/api/v1/orders/${theirs.id}`],
      ['get', `/api/v1/orders/${theirs.id}/trades?limit=10`],
      ['get', `/api/v1/orders/${theirs.id}/amendments`],
      ['delete', `/api/v1/orders/${theirs.id}`],
    ]) {
      const res = await mine[method](route);
      expect(res.status, route).toBe(404);
      expect(res.body.code, route).toBe('OrderNotFound');
    }
    // Lists hold only the person's own orders, and their order is still open, untouched.
    expect((await openOrders(who)).map((o) => o.id)).not.toContain(theirs.id);
    const closed = await mine.get('/api/v1/orders/closed?limit=500');
    expect(closed.body.map((o) => o.id)).not.toContain(theirs.id);
    const page2 = await mine.get(`/api/v1/orders/closed?limit=5&before=${theirs.id}`);
    expect(page2.status).toBe(400);
    expect(page2.body.intafacedCode).toBe('trade.invalid_cursor');
    expect((await other.get(`/api/v1/orders/${theirs.id}`)).body.status).toBe('open');
  } finally {
    await other.delete(`/api/v1/orders/${theirs.id}`);
  }
});

test(`${J} #4 reads the fills of a partly filled order, then cancel gives back exactly the rest`, async ({ page }) => {
  const who = account();
  // The buy rests 1% under the best bid, below the market maker's whole ladder. Another TEST trader sells the bids
  // ahead of it and half of it, so it fills as maker. Inside the spread it was the best bid, and the market maker's own
  // taker sells into the best bid every few cycles: it filled the rest between this check and Cancel (run 600 on main).
  // The maker's walk moves at most 12 bps a cycle of 8 s, so its bids need over a minute to come down this far.
  let order;
  let part;
  let price;
  const partlyFilled = (o) => o?.status === 'open' && o.filled !== '0';
  for (let attempt = 0; attempt < 3 && !partlyFilled(part); attempt++) {
    const { bid } = await bestPrices();
    const tick = toUnits('0.01');
    price = fromUnits(((toUnits(bid) * 99n) / 100n / tick) * tick);
    order = await place(who, { type: 'limit', side: 'buy', amount: '0.002', price, timeInForce: 'GTC' }, `part${attempt}`);
    const other = await api(otherTrader());
    // The maker places its new ladder before it cancels the old one, so a book read in between counts bids that are
    // gone by the time the sale lands, and the sale stops short of this order: sell again from a fresh read.
    for (let sale = 0; sale < 3 && (await orderById(who, order.id)).filled === '0'; sale++) {
      const { body: book } = await bestPrices();
      const ahead = book.bids.filter(([p]) => toUnits(p) > toUnits(price)).reduce((sum, [, size]) => sum + toUnits(size), 0n);
      const sell = await other.post('/api/v1/orders', {
        symbol: SYMBOL,
        type: 'limit',
        side: 'sell',
        amount: fromUnits(ahead + toUnits('0.001')),
        price,
        timeInForce: 'IOC',
        clientOrderId: `${J}-4-${order.id}-${sale}`,
      });
      expect(sell.status).toBeLessThan(300);
      await expect
        .poll(async () => (await orderById(who, order.id)).filled, { timeout: 5_000 })
        .not.toBe('0')
        .catch(() => {});
    }
    part = await orderById(who, order.id);
  }
  expect(partlyFilled(part), `a partly filled order to read, not ${part.status} with ${part.filled} filled`).toBe(true);
  run.write({ partial: order.id, partialPrice: price });

  await signIn(page, who);
  await page.goto(`/trade/orders/${order.id}`);
  await expect(page.getByTestId('page-heading')).toContainText('Partly filled');
  await expect(rowValue(detail(page), 'Filled')).toHaveText(`${part.filled} BTC`);
  await expect(rowValue(detail(page), 'Left to fill')).toHaveText(`${part.remaining} BTC`);
  const fills = await fillsOf(who, order.id);
  await expect(page.getByTestId('orders-fill')).toHaveCount(fills.length);
  // The hold left is what the remainder needs, and it is what the ledger holds for this person.
  expect(toUnits(part.hold.amount)).toBeGreaterThan(0n);
  const balances = await (await api(who)).balances();
  const openHolds = (await openOrders(who)).reduce((sum, o) => sum + toUnits(o.hold?.amount ?? '0'), 0n);
  expect(held(balances, 'USDT')).toBe(openHolds);
  const freeBefore = toUnits(balances.USDT.free);

  await page.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Cancelled.' })).toContainText(
    `${part.hold.amount.replace(/0+$/, '').replace(/\.$/, '')}`,
  );
  await expect(page.getByTestId('page-heading')).toContainText('Cancelled');
  const after = await (await api(who)).balances();
  expect(toUnits(after.USDT.free) - freeBefore).toBe(toUnits(part.hold.amount));
  expect(held(after, 'USDT')).toBe(openHolds - toUnits(part.hold.amount));
  // The filled part stays filled.
  expect((await orderById(who, order.id)).filled).toBe(part.filled);
});

test(`${J} #5 opens a fill's detail: price, amount, maker or taker, fee rate, fee asset and rank discount`, async ({ page }) => {
  const who = account();
  const { ids, partial } = run.read();
  await signIn(page, who);
  for (const [id, role] of [[ids.bought, 'Taker'], ...(partial ? [[partial, 'Maker']] : [])]) {
    const [fill] = await fillsOf(who, id);
    const order = await orderById(who, id);
    expect(fill.takerOrMaker).toBe(role.toLowerCase());
    await page.goto(`/trade/orders/${id}`);
    const opened = page.getByTestId('orders-fill').first();
    await opened.locator('summary').click();
    const rows = opened.locator('dl');
    await expect(rowValue(rows, 'Role')).toContainText(role);
    await expect(rowValue(rows, 'Fee asset')).toHaveText(fill.fee.currency);
    const shownRate = await rowValue(rows, 'Fee rate').innerText();
    expect(shownRate).toMatch(/^\d+(\.\d+)?%$/);
    expect(toUnits(shownRate.replace('%', ''))).toBe(toUnits(fill.fee.rate) * 100n);
    await expect(rowValue(rows, 'Fee asset')).not.toHaveText('Not stated');
    await expect(rowValue(rows, 'Rank fee discount')).toHaveText(order.feeDiscount === '0' ? 'None' : /%/);
    await expect(rowValue(rows, 'Amount')).toContainText(fill.amount);
  }
});

test(`${J} #6 a stop that fired says why: its stop price, the price that reached it and when, and the slippage`, async ({ page }) => {
  const who = account();
  // A buy stop-limit at the best ask fires when a trade prints at or above it. Another TEST trader lifts the ask to make
  // that trade; the stop's limit sits above it, so the order fills once it reaches the book.
  const { ask } = await bestPrices();
  const tick = toUnits('0.01');
  const stopPrice = ask;
  const limit = fromUnits(((toUnits(ask) * 102n) / 100n / tick) * tick);
  const order = await place(who, { type: 'stop_limit', side: 'buy', amount: '0.001', price: limit, stopPrice, timeInForce: 'GTC' }, 'stop');
  expect(order).toMatchObject({ type: 'stop_limit', stopPrice });
  const lift = await (
    await api(otherTrader())
  ).post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'limit',
    side: 'buy',
    amount: '0.001',
    price: limit,
    timeInForce: 'IOC',
    clientOrderId: `${J}-6-${order.id}`,
  });
  expect(lift.status).toBeLessThan(300);
  await expect.poll(async () => (await orderById(who, order.id)).triggered ?? null, { timeout: 30_000 }).not.toBeNull();
  await expect.poll(async () => (await orderById(who, order.id)).filled, { timeout: 30_000 }).toBe('0.001');
  const fired = await orderById(who, order.id);
  expect(fired.triggered.by).toBe('last');
  // A buy stop fires when the last trade is at or above its stop price.
  expect(toUnits(fired.triggered.referencePrice) >= toUnits(stopPrice)).toBe(true);
  expect(Date.parse(fired.triggered.at)).toBeGreaterThanOrEqual(fired.timestamp);

  await signIn(page, who);
  await page.goto(`/trade/orders/${order.id}`);
  const dl = detail(page);
  // As the page writes a USDT price: rounded to the 0.01 tick.
  const usd = (value) => Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  await expect(rowValue(dl, 'Stop price')).toHaveText(`${usd(stopPrice)} USDT`);
  await expect(rowValue(dl, 'Trigger')).toContainText(`when the last trade price reached ${usd(fired.triggered.referencePrice)} USDT`);
  await expect(rowValue(dl, 'Trigger')).toContainText(/Fired \d{1,2} \w{3}, \d{1,2}:\d{2}/);
  // Slippage: the average fill (from the order's fills) against the stop price, worse for a buy when above it.
  const fills = await fillsOf(who, order.id);
  const base = fills.reduce((sum, f) => sum + toUnits(f.amount), 0n);
  const quote = fills.reduce((sum, f) => sum + (toUnits(f.price) * toUnits(f.amount)) / 10n ** 18n, 0n);
  expect(fromUnits(base)).toBe('0.001');
  const average = fromUnits((quote * 10n ** 18n) / base);
  const worse = toUnits(average) - toUnits(stopPrice);
  await expect(rowValue(dl, 'Slippage')).toHaveText(
    worse === 0n
      ? /None/
      : worse > 0n
        ? new RegExp(`^${usd(fromUnits(worse)).replace('.', '\\.')} USDT \\(.+%\\) worse than the stop price$`)
        : /better than the stop price/,
  );
  await expect(rowValue(dl, 'Average price')).toHaveText(`${usd(average)} USDT`);
});

test(`${J} #7 reads the order states and the amend trail: the same words everywhere, each change with its time`, async ({ page }) => {
  const who = account();
  const { ids } = run.read();
  await openDesk(page, who);
  await page.locator('[role=tab]', { hasText: 'Order history' }).click();
  const deskRow = page.getByTestId('dk-bottom-body').locator('tr', { has: page.locator(`a[href="/trade/orders/${ids.cancelled}"]`) });
  await expect(deskRow).toContainText('Cancelled');
  await page.goto('/trade/orders?status=canceled&size=50');
  const historyRow = historyTable(page).locator('tr', { has: page.locator(`a[href="/trade/orders/${ids.cancelled}"]`) });
  await expect(historyRow).toContainText('Cancelled');
  await page.goto(`/trade/orders/${ids.cancelled}`);
  await expect(page.getByTestId('page-heading')).toContainText('Cancelled');

  const { body } = await (await api(who)).get(`/api/v1/orders/${ids.changed}/amendments`);
  expect(body.amendments.length).toBeGreaterThan(0);
  await page.goto(`/trade/orders/${ids.changed}`);
  const trail = page.getByTestId('orders-changes').locator('li');
  await expect(trail).toHaveCount(body.amendments.length);
  await expect(trail.first()).toContainText(/Changed to 0\.001 at/);
  await expect(trail.first()).toContainText(/\d{1,2}:\d{2}/);
  // Open, on the desk and here, reads the same.
  await expect(page.getByTestId('page-heading')).toContainText('Open');
  await (await api(who)).delete(`/api/v1/orders/${ids.changed}`);
});

test(`${J} #8 opens Activity, Trades: one row per trade from the fills, with price, total and fee`, async ({ page }) => {
  const who = account();
  const { body: fills } = await (await api(who)).get('/api/v1/account/trades?limit=100');
  expect(fills.length).toBeGreaterThan(0);
  await signIn(page, who);
  await page.goto('/money/activity?tab=trades');
  const rows = page.getByTestId('money-trade-tab').locator('table tbody tr');
  await expect(rows).toHaveCount(fills.length);
  const newest = fills.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
  const row = rows.first();
  await expect(row).toContainText(Number(newest.price).toLocaleString('en-US', { minimumFractionDigits: 2 }));
  await expect(row).toContainText(`${newest.fee.currency}`);
  // A USDT total is written with six places ("64.969840 USDT").
  await expect(row).toContainText(
    `${Number(newest.cost).toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 })} USDT`,
  );
});
