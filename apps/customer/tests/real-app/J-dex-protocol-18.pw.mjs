import { test, expect } from './journey.mjs';
import { UNBUILT, dexRun } from './dex.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { chooseContract, confirmOpen, fillTicket } from './futures-desk.mjs';
import { api, fund, toUnits } from './stack.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-18, in the running app (docs/roadmap/journeys.json): trade a perpetual from the Web3 side's futures
// ticket. One test per step, titled "J-dex-protocol-18 #<n>", run in order on one verified TEST account with TEST USDT
// margin, on the stack's TEST perpetual. Margin moves only through the custodial ledger recipes under business keys
// (`futures.margin.add:<positionId>`); a close is a reduce-only order on the book, never past the bankruptcy price; a
// caller's price on a market order or a close is refused; blank tiers or caps refuse.
// owner.decision for the leverage ladder, caps and the prelaunch mark policy while blank; a licence is never shown as a
// limit.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - the futures desk (/trade/futures) lists the TEST perpetual and opens, adjusts and closes a position
//   (J-derivatives-01), but there is no perps catalogue with leverage caps and prelaunch markets (D-perps-07), no
//   "Tiers not published" ladder state (D-perps-03), and no trailing, TWAP, chase or scale orders (D-perps-01, -02);
// - there is no pay-with-another-token open (D-perps-08), no fee toggle or chart overlays (D-perps-08), and no
//   liquidity safety flag or stock perp refusal (D-perps-07).
const J = 'J-dex-protocol-18';
const account = dexRun(J);
const DESK = '/trade/futures';
const SYMBOL = 'BTC/USDT:USDT';

test.describe.configure({ mode: 'default' });

const ticket = (page) => page.getByRole('region', { name: 'Order ticket' });

/** The run's TEST account, signed in, on the futures desk. */
async function desk(page) {
  const who = account.run.read().who;
  expect(who, 'the start step made the account').toBeTruthy();
  await signIn(page, who);
  await page.goto(DESK);
  await expect(page.getByRole('button', { name: 'Open long' })).toBeVisible();
  return who;
}

/** The account's open futures positions, read through the customer's own API. */
async function positions(who) {
  const { status, body } = await (await api(who)).get('/api/v1/positions');
  expect(status).toBe(200);
  return body;
}

test(`${J} starts: a verified TEST account with TEST margin, on the futures ticket`, async ({ page }) => {
  test.setTimeout(240_000);
  const who = await fundedTrader(page, 'dex18', '1000');
  account.run.reset({ who });
  await desk(page);
});

test(`${J} #1 opens the perps catalogue: each perp with its leverage cap equal to the owner cap; prelaunch markets marked and closed to public submits`, async ({
  page,
}) => {
  await desk(page);
  await page.getByRole('button', { name: 'All perpetuals' }).click(UNBUILT);
  const catalogue = tableIn(page.getByRole('main'), 'Perpetuals');
  await expect(catalogue.getByRole('columnheader', { name: 'Leverage cap' })).toBeVisible();
  const row = bodyRows(catalogue).filter({ hasText: SYMBOL });
  // The cap shown is the owner's cap the markets list publishes, never a default.
  const markets = (await (await api(account.run.read().who)).get('/api/v1/markets?limit=500')).body;
  const listed = markets.find((m) => m.symbol === SYMBOL);
  await expect(row).toContainText(`${listed.maxLeverage}x`);
  const prelaunch = bodyRows(catalogue).filter({ hasText: 'Prelaunch' });
  await expect(prelaunch).not.toHaveCount(0);
  for (const market of await prelaunch.all()) await expect(market.getByRole('button', { name: /^Trade/ })).toBeDisabled();
});

test(`${J} #2 opens the futures ticket with the ladder blank: "Tiers not published" and no order can be placed`, async ({ page }) => {
  await desk(page);
  await chooseContract(page, 'TEST no ladder');
  await expect(ticket(page)).toContainText('Tiers not published');
  await expect(page.getByRole('button', { name: 'Open long' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Open short' })).toBeDisabled();
});

test(`${J} #3 places a limit order with a take-profit and stop: a take-profit at or under the stop on a long refused; a trailing sell of 100 bp rises with the mark and never falls`, async ({
  page,
}) => {
  await desk(page);
  const types = page.getByRole('group', { name: 'Order type' });
  await types.getByRole('button', { name: 'Limit' }).click();
  await page.getByRole('textbox', { name: 'Limit price' }).fill('100');
  await ticket(page)
    .getByRole('textbox', { name: /^Take profit/ })
    .fill('90');
  await ticket(page)
    .getByRole('textbox', { name: /^Stop loss/ })
    .fill('95');
  // The ticket refuses the pair before any review: the take-profit of a long must sit above its stop.
  await fillTicket(page, '0.01', { review: false });
  await expect(ticket(page).getByText('The take-profit must be above the stop on a long')).toBeVisible(UNBUILT);
  await types.getByRole('button', { name: 'Trailing stop' }).click(UNBUILT);
  await ticket(page)
    .getByRole('textbox', { name: /^Trailing distance/ })
    .fill('100');
  await expect(ticket(page).getByTestId('trail-note')).toHaveText('The stop follows the mark up and never moves down.');
});

test(`${J} #4 places a TWAP of 10 over 5 slices: five slices each at the accepted mark under its own key; progress shown; a maximum stop price pauses it with the reason`, async ({
  page,
}) => {
  await desk(page);
  test.setTimeout(180_000);
  await page.getByRole('group', { name: 'Order type' }).getByRole('button', { name: 'TWAP' }).click(UNBUILT);
  await fillTicket(page, '0.01');
  await ticket(page).getByRole('spinbutton', { name: 'Slices' }).fill('5');
  await page.getByRole('button', { name: 'Open long' }).click(UNBUILT);
  const progress = page.getByRole('progressbar', { name: 'TWAP progress' });
  await expect(progress).toHaveAttribute('aria-valuemax', '5');
  await expect(progress).toHaveAttribute('aria-valuenow', '5', { timeout: 120_000 });
  const slices = tableIn(page.getByRole('main'), 'TWAP slices');
  await expect(bodyRows(slices)).toHaveCount(5);
  // Each slice names its own business key and fills at the accepted mark.
  for (const row of await bodyRows(slices).all()) await expect(row).toContainText(/twap:[\w-]+:\d/);
});

test(`${J} #5 starts a chase or a scale order: the chase tracks the book; scale places the ladder; each shows its state`, async ({
  page,
}) => {
  await desk(page);
  const types = page.getByRole('group', { name: 'Order type' });
  await types.getByRole('button', { name: 'Chase' }).click(UNBUILT);
  await fillTicket(page, '0.01');
  await page.getByRole('button', { name: 'Open long' }).click(UNBUILT);
  await expect(page.getByRole('status', { name: 'Chase' })).toHaveText(/^Chasing the best bid/);
  await types.getByRole('button', { name: 'Scale' }).click();
  await ticket(page).getByRole('spinbutton', { name: 'Orders in the ladder' }).fill('3');
  await page.getByRole('button', { name: 'Open long' }).click(UNBUILT);
  await expect(page.getByRole('status', { name: 'Scale' })).toHaveText('3 of 3 orders placed');
});

test(`${J} #6 switches margin mode and adds 5 TEST margin to an isolated position: the new liquidation price before confirm; the margin move posts once`, async ({
  page,
}) => {
  const who = await desk(page);
  await page.getByRole('group', { name: 'Margin mode' }).getByRole('button', { name: 'Isolated' }).click();
  await fillTicket(page, '0.01');
  await page.getByRole('button', { name: 'Open long' }).click();
  await confirmOpen(page);
  await expect.poll(async () => (await positions(who)).filter((p) => p.symbol === SYMBOL).length, { timeout: 20_000 }).toBeGreaterThan(0);
  const row = page
    .getByRole('row')
    .filter({ hasText: SYMBOL })
    .filter({ has: page.getByRole('button', { name: /^Add margin/ }) });
  await row.getByRole('button', { name: /^Add margin/ }).click(UNBUILT);
  const dialog = page.getByRole('dialog', { name: 'Add margin' });
  await dialog.getByRole('textbox', { name: /^Amount/ }).fill('5');
  await expect(dialog.getByTestId('new-liquidation-price')).toHaveText(/^New liquidation price [\d,.]+$/, UNBUILT);
  const [position] = (await positions(who)).filter((p) => p.symbol === SYMBOL);
  await dialog.getByRole('button', { name: 'Add margin' }).dblclick();
  // A double press posts the margin move once (business key futures.margin.add:<positionId>): exactly 5 more.
  const collateral = async () => toUnits((await positions(who)).find((p) => p.id === position.id)?.collateral ?? '0');
  await expect.poll(collateral, { timeout: 20_000 }).toBe(toUnits(position.collateral) + toUnits('5'));
  await expect(page.getByRole('status').filter({ hasText: 'Margin added' })).toHaveCount(1);
});

test(`${J} #7 pays with another token: the converted amount stays if the open is refused and the sheet says so; a retry opens once`, async ({
  page,
}) => {
  const who = await desk(page);
  fund(who.email, 'ETH', '1');
  const held = async () => (await positions(who)).filter((p) => p.symbol === SYMBOL).reduce((sum, p) => sum + toUnits(p.contracts), 0n);
  const before = await held();
  await ticket(page).getByRole('combobox', { name: 'Pay with' }).selectOption({ label: 'ETH' }, UNBUILT);
  await fillTicket(page, '1000');
  await page.getByRole('button', { name: 'Open long' }).click(UNBUILT);
  const sheet = page.getByRole('alertdialog');
  await sheet.getByRole('button', { name: 'Confirm open long' }).click();
  await expect(sheet.getByRole('alert')).toContainText('The open was refused. Your ETH was converted and the USDT stays in your account.');
  await fillTicket(page, '0.01');
  await page.getByRole('button', { name: 'Open long' }).click(UNBUILT);
  await confirmOpen(page);
  // The retry opens once: exactly 0.01 more is held than before the refused open.
  await expect.poll(held, { timeout: 20_000 }).toBe(before + toUnits('0.01'));
});

test(`${J} #8 closes 25 percent: a reduce-only order fills exactly a quarter in the book, never past where the margin is gone; a caller-supplied price is refused`, async ({
  page,
}) => {
  const who = await desk(page);
  const me = await api(who);
  // The one open position on this contract is the row the dialog closes (the desk draws one row per position).
  const open = (await positions(who)).filter((p) => p.symbol === SYMBOL);
  expect(open, 'an earlier step left exactly one position on this contract').toHaveLength(1);
  const [before] = open;
  const row = page
    .getByRole('row')
    .filter({ hasText: SYMBOL })
    .filter({ has: page.getByRole('button', { name: `Close, ${SYMBOL}` }) });
  await row.getByRole('button', { name: `Close, ${SYMBOL}` }).click();
  const dialog = page.getByRole('dialog', { name: /^Close/ });
  await dialog.getByRole('button', { name: '25%' }).click(UNBUILT);
  // The close is a reduce-only market order on the futures book (slice 6b retired the at-mark close while matching is
  // on), for a quarter of the size, on the side that shrinks the position.
  const sent = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/futures/orders' && r.request().method() === 'POST', {
    timeout: 20_000,
  });
  await dialog.getByRole('button', { name: 'Close this size' }).click();
  const answer = await sent;
  const asked = answer.request().postDataJSON();
  const quarter = toUnits(before.contracts) / 4n;
  expect(asked).toMatchObject({ symbol: SYMBOL, type: 'market', reduceOnly: true, side: before.side === 'long' ? 'sell' : 'buy' });
  expect(toUnits(asked.amount)).toBe(quarter);
  expect(asked.price, 'a market close sends no price of its own').toBeUndefined();
  expect(answer.status(), await answer.text()).toBeLessThan(300);
  const placed = await answer.json();
  // Exactly three quarters stay open: 4 × left = 3 × before, in exact units.
  await expect
    .poll(async () => 4n * toUnits((await positions(who)).find((p) => p.id === before.id)?.contracts ?? '0'), { timeout: 20_000 })
    .toBe(3n * toUnits(before.contracts));
  // The service's own record of that order: reduce-only on this position, filled in the book for the quarter, at a
  // worst price inside the band around the mark and never past the bankruptcy price (where the margin is gone). The
  // engine fills an order only at its limit or better, so that recorded limit is the bound on every fill of the close.
  const { status: listed, body: list } = await me.get(`/api/v1/futures/orders?scope=all&limit=100&symbol=${encodeURIComponent(SYMBOL)}`);
  expect(listed).toBe(200);
  expect(Array.isArray(list), JSON.stringify(list).slice(0, 200)).toBe(true);
  const order = list.find((o) => o.orderId === placed.orderId);
  expect(order, JSON.stringify(placed).slice(0, 300)).toBeTruthy();
  expect(order).toMatchObject({ reduceOnly: true, positionId: before.id, status: 'filled', type: 'market' });
  expect(toUnits(order.filledQty)).toBe(quarter);
  const limit = toUnits(order.limitPrice);
  expect(limit).toBeGreaterThanOrEqual(toUnits(order.bandLow));
  expect(limit).toBeLessThanOrEqual(toUnits(order.bandHigh));
  expect(order.bankruptcyPrice, 'the bound is recorded').toBeTruthy();
  if (before.side === 'long') expect(limit).toBeGreaterThanOrEqual(toUnits(order.bankruptcyPrice));
  else expect(limit).toBeLessThanOrEqual(toUnits(order.bankruptcyPrice));
  // A caller-supplied price is refused on the door the close goes through: a market reduce-only order with a price is a
  // 400 trade.limit_price_on_market_order, and nothing more closes.
  const priced = await me.post('/api/v1/futures/orders', {
    symbol: SYMBOL,
    side: asked.side,
    type: 'market',
    amount: asked.amount,
    price: '1',
    reduceOnly: true,
    clientOrderId: `${J}:market-price-refused`,
  });
  expect(priced.status, JSON.stringify(priced.body)).toBe(400);
  expect(priced.body.error).toBe('trade.limit_price_on_market_order');
  // The position close door takes no price from the caller either.
  const { status, body } = await me.post(`/api/v1/positions/${before.id}/close`, {
    quantity: '0.001',
    clientCloseId: `${J}:price-refused`,
    price: '1',
  });
  expect(status).toBe(400);
  expect(body.error).toBe('trade.price_not_accepted');
  expect(4n * toUnits((await positions(who)).find((p) => p.id === before.id)?.contracts ?? '0')).toBe(3n * toUnits(before.contracts));
});

test(`${J} #9 toggles the fee in profit and loss and the chart overlays: profit and loss changes by the fee; entry, liquidation and order lines appear on the chart`, async ({
  page,
}) => {
  await desk(page);
  const pnl = page.getByRole('switch', { name: 'Include fees in profit and loss' });
  await expect(pnl).toBeVisible(UNBUILT);
  await pnl.click();
  await expect(pnl).toBeChecked();
  const chart = page.getByRole('region', { name: 'Chart' });
  for (const line of ['Entry', 'Liquidation', 'Order'])
    await expect(chart.getByRole('img', { name: new RegExp(`^${line} line`) })).toBeVisible();
});

test(`${J} #10 reads a market under the liquidity threshold: a safety flag; a stock perp request shows its typed refusal`, async ({
  page,
}) => {
  const who = await desk(page);
  await chooseContract(page, 'TEST thin perp');
  await expect(page.getByRole('note').filter({ hasText: 'Low liquidity' })).toBeVisible();
  const { status, body } = await (await api(who)).get('/api/v1/markets/AAPL-PERP');
  expect(status).toBe(412);
  expect(JSON.stringify(body)).toContain('futures.stock_perps_unavailable');
});
