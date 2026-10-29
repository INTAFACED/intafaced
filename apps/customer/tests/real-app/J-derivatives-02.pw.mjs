import { test, expect } from '@playwright/test';
import { api, bestPrices, fromUnits, fund, journeyState, toUnits, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-derivatives-02, in the running app (docs/roadmap/journeys.json): size a trade and check its risk before opening it.
// One test per step, titled "J-derivatives-02 #<n>", run in order on one TEST account. The contract is the TEST
// perpetual `local-test-gates.mjs futures` lists; its maintenance tiers are the stack's LOCAL TEST ladder
// (local-test-stack.mjs TEST_FUTURES_LADDER_POLICY), never an owner table. Every figure is read back through the
// customer's own API.
const J = 'J-derivatives-02';
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

/** Every write the page sends from now on: the calculator and the tier table must hold and place nothing. */
function writes(page) {
  const sent = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/') && !r.url().includes('/futures/calculator'))
      sent.push(`${r.method()} ${r.url()}`);
  });
  return sent;
}

test(`${J} #1 opens the margin and P&L calculator: margin, liquidation price and P&L for typed inputs, formulas named`, async ({
  page,
}) => {
  const who = await fundedTrader(page, 'jd2', '1000');
  run.reset({ account: who });
  const me = await api(who);
  const before = await me.balances();
  await desk(page);
  const sent = writes(page);

  // The service's own preview at the mark, then the calculator with that mark as the entry: the same figures.
  const preview = await me.post('/api/v1/positions/preview', { symbol: SYMBOL, side: 'long', size: SIZE, leverage: LEVERAGE });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const mark = preview.body.markPrice;
  expect(mark).toBeTruthy();
  // A TEST exit 2 percent above the mark, in whole units.
  const unit = 10n ** 18n;
  const exit = fromUnits(((toUnits(mark) * 102n) / 100n / unit) * unit);
  const calc = await me.post('/api/v1/futures/calculator', {
    symbol: SYMBOL,
    side: 'long',
    size: SIZE,
    entryPrice: mark,
    exitPrice: exit,
    leverage: LEVERAGE,
  });
  expect(calc.status, JSON.stringify(calc.body)).toBe(200);
  expect(calc.body.liquidationPrice).toBeTruthy();
  expect(calc.body.initialMargin).toBe(preview.body.initialMargin);
  expect(calc.body.liquidationPrice).toBe(preview.body.liquidationPrice);
  expect(calc.body.entryFee).toBe(preview.body.estimatedFee);
  // The tier the notional falls in against today's depth, at that tier's own rate.
  const rateOf = { 1: 50, 2: 100, 3: 250, 4: 500 };
  expect(calc.body.maintenanceBps).toBe(rateOf[calc.body.tier]);
  expect(calc.body.refusals).toEqual([]);

  // The tab takes a price on the tick (0.01 on the TEST perpetual) and the mark can carry more places, so the tab is
  // given the mark on the tick and shows the service's own answer for that entry.
  const tick = 10n ** 16n;
  const entry = fromUnits((toUnits(mark) / tick) * tick);
  const typed = await me.post('/api/v1/futures/calculator', {
    symbol: SYMBOL,
    side: 'long',
    size: SIZE,
    entryPrice: entry,
    exitPrice: exit,
    leverage: LEVERAGE,
  });
  expect(typed.status, JSON.stringify(typed.body)).toBe(200);

  // Those numbers typed into the Calculator tab.
  await page.getByRole('tab', { name: 'Calculator' }).click();
  const panel = page.getByRole('region', { name: 'Margin and P&L calculator' });
  await expect(panel.getByText('Nothing is placed, held or saved.')).toBeVisible();
  await panel.getByLabel('Size').fill(SIZE);
  await panel.getByLabel('Entry price').fill(entry);
  await expect(panel.getByLabel('Entry price')).toHaveValue(new RegExp(entry.replace('.', '\\.')));
  await panel.getByLabel('Exit price (optional)').fill(exit);
  await panel.getByLabel('Leverage').fill(LEVERAGE);
  const answered = page.waitForResponse((r) => r.url().includes('/api/v1/futures/calculator') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Calculate' }).click();
  const shown = await (await answered).json();
  expect(shown.initialMargin).toBe(typed.body.initialMargin);
  expect(shown.liquidationPrice).toBe(typed.body.liquidationPrice);
  expect(shown.pnl).toBe(typed.body.pnl);

  const results = panel.getByLabel('Calculator results');
  for (const label of ['Initial margin', 'Maintenance margin', 'Liquidation price', 'P&L at exit', 'Return on margin', 'P&L after fees']) {
    await expect(results.getByText(label, { exact: true })).toBeVisible();
  }
  // The P&L the service worked out is on screen in the account's quote asset.
  await expect(results).toContainText(`${shown.pnl.split('.')[0]}`);
  const formulas = panel.getByRole('list', { name: 'Formulas' });
  await expect(formulas).toContainText('Initial margin = size × entry price ÷ leverage');
  await expect(formulas).toContainText('Liquidation price: where margin plus P&L equals the maintenance margin');
  await expect(formulas).toContainText('P&L = size × (exit − entry) for a long');

  // Nothing was placed or held.
  expect(sent).toEqual([]);
  expect(await me.balances()).toEqual(before);
  const orders = await me.get('/api/v1/futures/orders?scope=all&limit=10');
  expect(orders.status).toBe(200);
  expect(orders.body).toEqual([]);
});

test(`${J} #2 reads the tier table: the published tiers and maintenance rates`, async ({ page }) => {
  const who = account();
  await desk(page);
  const sent = writes(page);
  const tiers = await (await api(who)).get(`/api/v1/futures/tiers?symbol=${encodeURIComponent(SYMBOL)}`);
  expect(tiers.status, JSON.stringify(tiers.body)).toBe(200);
  // The stack's LOCAL TEST ladder, as published: four tiers, rates rising with size against depth.
  expect(tiers.body.tiers.map((t) => [t.tier, t.uptoDepthBps, t.maintenanceRate])).toEqual([
    [1, 500, '0.005'],
    [2, 2000, '0.01'],
    [3, 5000, '0.025'],
    [4, null, '0.05'],
  ]);
  expect(tiers.body.leverageBasis).toBe('listing_cap');

  await page.getByRole('tab', { name: 'Margin tiers' }).click();
  const table = page.getByRole('table', { name: 'Maintenance margin tiers' });
  await expect(table).toBeVisible();
  const rows = table.getByRole('row');
  await expect(rows).toHaveCount(5); // the header and four tiers
  for (const [n, share, rate] of [
    ['1', '5.00%', '0.50%'],
    ['2', '20.00%', '1.00%'],
    ['3', '50.00%', '2.50%'],
    ['4', 'Any larger size', '5.00%'],
  ]) {
    const row = rows.nth(Number(n));
    await expect(row).toContainText(share);
    await expect(row).toContainText(rate);
  }
  await expect(page.getByText(/every tier answers to the contract’s cap of \d+(\.\d+)?x/)).toBeVisible();
  await expect(page.getByText(/notional as a share of the book depth it would close into/)).toBeVisible();
  // With no ladder published the same read refuses `trade.ladder_unset` and opens refuse on that code: proved by the
  // service tests (risk-calculator-rest.test.ts, slice-futures-amounts.test.ts), since the stack publishes a ladder.
  expect(sent).toEqual([]);
});

test(`${J} #3 reads what counts as margin: cash with its haircut and buying power, the other classes refused`, async ({ page }) => {
  const who = account();
  const me = await api(who);
  await desk(page);
  const sent = writes(page);
  const { status, body } = await me.get('/api/v1/futures/collateral');
  expect(status, JSON.stringify(body)).toBe(200);
  // The stack's LOCAL TEST haircut is 0 bps (local-test-stack.mjs TRADE_COLLATERAL_HAIRCUT_BPS). Nothing is placed yet,
  // so the posted cash is the free balance and all of it is buying power.
  const usdt = body.assets.find((a) => a.asset === 'USDT');
  expect(usdt).toMatchObject({ collateralClass: 'cash', counts: true, haircutBps: 0, haircutReason: null, buyingPowerReason: null });
  const free = (await me.balances()).USDT.free;
  expect(toUnits(usdt.free)).toBe(toUnits(free));
  expect(toUnits(usdt.posted)).toBe(toUnits(usdt.free));
  expect(toUnits(usdt.committed)).toBe(0n);
  expect(toUnits(usdt.buyingPower)).toBe(toUnits(usdt.free));
  expect(body.refusedClasses.map((r) => [r.collateralClass, r.counts, r.code])).toEqual([
    ['yield_bearing', false, 'trade.unsupported_collateral_class'],
    ['staked', false, 'trade.unsupported_collateral_class'],
    ['lending_idle', false, 'trade.unsupported_collateral_class'],
  ]);

  await page.getByRole('tab', { name: 'Collateral' }).click();
  const table = page.getByRole('table', { name: 'What counts as futures margin' });
  const row = table.getByRole('row').filter({ hasText: 'USDT' });
  await expect(row).toContainText('Cash');
  await expect(row).toContainText('0.00%');
  // Free, posted and buying power are the same whole TEST amount here, with thousands grouped as the screen shows them.
  const whole = usdt.free.split('.')[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  await expect(row).toContainText(`Cash0.00%${whole} USDT${whole} USDT0 USDT${whole} USDT`);
  await expect(page.getByText(/Buying power is posted less the haircut/)).toBeVisible();
  const refused = page.getByRole('list', { name: 'Not taken as margin' });
  await expect(refused.getByRole('listitem')).toHaveCount(3);
  for (const name of ['Yield-bearing balances', 'Staked balances', 'Lending balances']) {
    await expect(refused.getByText(name)).toBeVisible();
  }
  await expect(refused.locator('[data-code="trade.unsupported_collateral_class"]')).toHaveCount(3);
  // A blank haircut reads "Haircut not set" and opens refuse `trade.haircut_unset`: proved by the service tests
  // (collateral-rest.test.ts, matched-orders.money.test.ts), since the stack sets a TEST haircut.
  expect(sent).toEqual([]);
});

test(`${J} #4 tries to post staked balance as margin: the review and the order both refuse it, nothing moves`, async ({ page }) => {
  const who = account();
  const me = await api(who);
  await desk(page);
  // Derivatives access is open (no agreement, quiz or notice since owner decision 2026-10-27), so the refusal below is
  // the collateral rule and nothing else.
  await expect(page.getByTestId('futures-access').getByText('Open for your account')).toBeVisible();
  const before = await me.balances();

  const ticket = page.getByRole('region', { name: 'Order ticket' });
  await ticket.getByRole('textbox', { name: 'Size' }).fill(SIZE);
  await ticket.getByRole('textbox', { name: 'Leverage' }).fill(LEVERAGE);
  const from = ticket.getByRole('group', { name: 'Margin from' });
  await from.getByRole('button', { name: 'Staked' }).click();
  await ticket.getByRole('button', { name: 'Review', exact: true }).click();
  const why = ticket.locator('[data-code="trade.unsupported_collateral_class"]');
  await expect(why).toContainText('Only cash can be posted as margin');
  await expect(ticket.getByRole('button', { name: 'Open long' })).toBeDisabled();

  // The order path refuses on the same code, whatever the screen does.
  const refused = await me.post('/api/v1/futures/orders', {
    symbol: SYMBOL,
    side: 'buy',
    type: 'market',
    amount: SIZE,
    leverage: LEVERAGE,
    marginMode: 'isolated',
    collateralClass: 'staked',
    clientOrderId: `${J}-staked`,
  });
  expect(refused.status, JSON.stringify(refused.body)).toBe(400);
  expect(refused.body.error).toBe('trade.unsupported_collateral_class');

  // Back to cash, the same review is orderable again.
  await from.getByRole('button', { name: 'Cash' }).click();
  await ticket.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(ticket.getByText('Initial margin', { exact: true })).toBeVisible();
  await expect(why).toHaveCount(0);
  await expect(ticket.getByRole('button', { name: 'Open long' })).toBeEnabled();

  // Nothing was held, placed or opened.
  expect(await me.balances()).toEqual(before);
  expect((await me.get('/api/v1/futures/orders?scope=all&limit=10')).body).toEqual([]);
  expect((await me.get('/api/v1/positions')).body).toEqual([]);
});

test(`${J} #5 previews past the order cap and the price band: a split offered and placed, the price moved to the band edge, the slippage cap shown`, async ({
  page,
}) => {
  const who = account();
  const me = await api(who);
  // The stack's LOCAL TEST owner values (local-test-stack.mjs): max-order 100,000 USDT, band 0.05, slippage cap 50 bps.
  const MAX_ORDER = 100_000n;
  const unit = 10n ** 18n;
  const lot = 10n ** 15n; // 0.001 BTC, the TEST perp's lot

  // A market review first: the slippage cap and the protection price it gives, inside the band.
  await desk(page);
  const ticket = page.getByRole('region', { name: 'Order ticket' });
  await ticket.getByRole('textbox', { name: 'Size' }).fill(SIZE);
  await ticket.getByRole('textbox', { name: 'Leverage' }).fill(LEVERAGE);
  await ticket.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(ticket.getByText('Slippage cap', { exact: true })).toBeVisible();
  await expect(ticket.getByText('50 bps of the mark')).toBeVisible();
  await expect(ticket.getByText('Protection price', { exact: true })).toBeVisible();
  const market = await me.post('/api/v1/positions/preview', { symbol: SYMBOL, side: 'long', size: SIZE, leverage: LEVERAGE });
  expect(market.status, JSON.stringify(market.body)).toBe(200);
  expect(market.body).toMatchObject({ type: 'market', slippageCapBps: 50, maxOrderNotional: String(MAX_ORDER), split: null });
  const mark = toUnits(market.body.markPrice);
  expect(toUnits(market.body.orderPrice)).toBe(mark + (mark * 50n) / 10_000n);
  expect(toUnits(market.body.band.low)).toBe(mark - (mark * 5n) / 100n);
  expect(toUnits(market.body.band.high)).toBe(mark + (mark * 5n) / 100n);

  // A size worth about 1.5 times the max-order, as a long limit at half the mark: outside the band, and over the cap.
  const size = fromUnits(((MAX_ORDER * 3n * unit * unit) / 2n / mark / lot) * lot);
  const far = fromUnits((mark / 2n / unit) * unit);
  fund(who.email, 'USDT', '40000'); // TEST money: the whole order's margin at 5x
  const before = await me.balances();
  await page.reload();
  await expect(ticket.getByRole('button', { name: 'Open long' })).toBeVisible();
  await ticket.getByRole('group', { name: 'Order type' }).getByRole('button', { name: 'Limit' }).click();
  await ticket.getByRole('textbox', { name: 'Limit price' }).fill(far);
  await ticket.getByRole('textbox', { name: 'Size' }).fill(size);
  await ticket.getByRole('textbox', { name: 'Leverage' }).fill(LEVERAGE);
  await ticket.getByRole('button', { name: 'Review', exact: true }).click();
  // Refused as asked: the band is named, and so is the cap with the split it offers.
  const band = ticket.locator('[data-code="trade.futures_price_outside_band"]');
  await expect(band).toContainText('outside the band');
  await expect(ticket.locator('[data-code="trade.limit_max_order"]')).toContainText('it can be placed as 2 orders');
  await expect(ticket.getByRole('button', { name: 'Open long' })).toBeDisabled();
  const split = ticket.getByRole('region', { name: 'Place as smaller orders' });
  await expect(split.getByRole('button', { name: 'Place as 2 orders' })).toBeDisabled();

  // With the price correction on, the same review moves the price to the band's low edge and only the cap remains.
  await ticket.getByRole('switch', { name: 'Move a price outside the band to its edge' }).click();
  await ticket.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(ticket.getByText('Price moved to the band', { exact: true })).toBeVisible();
  await expect(band).toHaveCount(0);
  await expect(ticket.getByRole('button', { name: 'Open long' })).toBeDisabled();
  await expect(split).toContainText('This one can go as 2 orders');
  await split.getByRole('button', { name: 'Place as 2 orders' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('2 orders within the max order value');
  // The whole order is far past tier 1 on the TEST book, so the confirm names the tier it opens in (step 6) and waits.
  const accept = confirm.getByRole('region', { name: 'New margin tier' }).getByRole('checkbox');
  await accept.click();
  // The confirm re-checks the numbers; a mark that moved meanwhile shows the new figures and asks once more.
  await confirm.getByRole('button', { name: 'Confirm open long' }).click();
  const placed = page.getByRole('heading', { name: 'Placed as 2 orders' });
  await expect(placed.or(confirm.getByText('The numbers moved since you reviewed'))).toBeVisible({ timeout: 20_000 });
  if (!(await placed.isVisible())) {
    await accept.click();
    await confirm.getByRole('button', { name: 'Confirm open long' }).click();
  }
  await expect(placed).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('status').filter({ has: placed }).getByRole('listitem')).toHaveCount(2);

  // Two children on the book, keyed by the open's id, each worth no more than the cap, resting at the band's low edge.
  const open = await me.get('/api/v1/futures/orders?scope=open&limit=10');
  expect(open.status).toBe(200);
  // Each child is keyed `<open id>:<n>:<tag>`, the tag naming this one request.
  const children = open.body.filter((o) => /:[12]:[0-9a-f]{8}$/.test(o.clientOrderId ?? ''));
  expect(children, JSON.stringify(open.body)).toHaveLength(2);
  const [, base, tag] = /^(.*):\d:([0-9a-f]{8})$/.exec(children[0].clientOrderId);
  expect(children.map((o) => o.clientOrderId).sort()).toEqual([`${base}:1:${tag}`, `${base}:2:${tag}`]);
  expect(children.reduce((sum, o) => sum + toUnits(o.qty), 0n)).toBe(toUnits(size));
  for (const child of children) {
    expect(child).toMatchObject({ side: 'buy', type: 'limit', status: 'open', reduceOnly: false });
    expect(child.limitPrice).toBe(child.bandLow);
    expect((toUnits(child.qty) * toUnits(child.markPrice)) / unit <= MAX_ORDER * unit).toBe(true);
  }
  const held = children.reduce((sum, o) => sum + toUnits(o.holdAmount), 0n);
  const during = await me.balances();
  expect(toUnits(before.USDT.free) - toUnits(during.USDT.free)).toBe(held);

  // The same request again (the screen's request id) places nothing more.
  const again = await me.post('/api/v1/futures/orders/split', {
    symbol: SYMBOL,
    side: 'buy',
    type: 'limit',
    amount: size,
    price: far,
    priceCorrection: 'adjust',
    leverage: LEVERAGE,
    marginMode: 'isolated',
    clientOrderId: base,
  });
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  expect(again.body.orders.map((o) => o.orderId).sort()).toEqual(children.map((o) => o.orderId).sort());
  expect((await me.balances()).USDT.free).toBe(during.USDT.free);
  // The same key with another size names another request: refused, nothing placed.
  const other = await me.post('/api/v1/futures/orders/split', {
    symbol: SYMBOL,
    side: 'buy',
    type: 'limit',
    amount: fromUnits(toUnits(size) * 2n),
    price: far,
    priceCorrection: 'adjust',
    leverage: LEVERAGE,
    marginMode: 'isolated',
    clientOrderId: base,
  });
  expect(other.status, JSON.stringify(other.body)).toBe(409);
  expect(other.body.error).toBe('trade.client_order_id_conflict');
  expect((await me.balances()).USDT.free).toBe(during.USDT.free);

  // Cancelled, every hold comes back: nothing was ever filled.
  for (const child of children) expect((await me.delete(`/api/v1/futures/orders/${child.orderId}`)).status).toBe(200);
  expect((await me.balances()).USDT.free).toBe(before.USDT.free);
  // A blank slippage cap refusing every market open (`trade.slippage_cap_unset`) is proved by the service tests
  // (matched-orders.money.test.ts, position-preview-rest.test.ts), since the stack publishes a TEST cap.
});

test(`${J} #6 adds size that crosses a tier threshold: a confirm step names the new tier and its leverage`, async ({ page }) => {
  const who = account();
  const me = await api(who);
  // On the stack's TEST book a tier-1 position is worth at most 5% of the depth it closes into (about 150 USDT today),
  // so 0.001 BTC opens in tier 1 and 0.004 more carries it into a higher tier.
  const FIRST = '0.001';
  const ADD = '0.004';
  await desk(page);
  const ticket = page.getByRole('region', { name: 'Order ticket' });
  const confirm = page.getByRole('alertdialog');
  const tierStep = confirm.getByRole('region', { name: 'New margin tier' });

  async function review(size) {
    await ticket.getByRole('textbox', { name: 'Size' }).fill(size);
    await ticket.getByRole('textbox', { name: 'Leverage' }).fill(LEVERAGE);
    await ticket.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(ticket.getByText('Margin tier', { exact: true })).toBeVisible();
  }
  async function positionSize() {
    const { body } = await me.get('/api/v1/positions');
    return body.find((p) => p.symbol === SYMBOL && p.side === 'long')?.contracts ?? '0';
  }
  async function until(read, ok, what) {
    const end = Date.now() + 20_000;
    let last;
    while (Date.now() < end) {
      last = await read();
      if (ok(last)) return last;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${what}: still ${JSON.stringify(last)}`);
  }

  // A first position inside tier 1: the review names the tier and the confirm asks nothing more.
  const small = await me.post('/api/v1/positions/preview', { symbol: SYMBOL, side: 'long', size: FIRST, leverage: LEVERAGE });
  expect(small.status, JSON.stringify(small.body)).toBe(200);
  expect(small.body.riskTier).toMatchObject({ current: null, projected: 1, maintenanceBps: 50, confirmRequired: false });
  await review(FIRST);
  await expect(ticket.getByText('Tier 1, maintenance 0.50%')).toBeVisible();
  await ticket.getByRole('button', { name: 'Open long' }).click();
  await expect(confirm).toBeVisible();
  await expect(tierStep).toHaveCount(0);
  await confirm.getByRole('button', { name: 'Confirm open long' }).click();
  // The confirm re-checks the numbers; a mark that moved meanwhile shows the new figures and asks once more.
  const firstFilled = page.getByText('Order filled');
  await expect(firstFilled.or(confirm.getByText('The numbers moved since you reviewed'))).toBeVisible({ timeout: 20_000 });
  if (!(await firstFilled.isVisible())) await confirm.getByRole('button', { name: 'Confirm open long' }).click();
  await expect(firstFilled).toBeVisible({ timeout: 20_000 });
  await until(positionSize, (s) => s === FIRST, 'the tier-1 position');

  // Adding 0.004 crosses out of tier 1. The service refuses the add until the tier is named, and holds nothing.
  const add = await me.post('/api/v1/positions/preview', { symbol: SYMBOL, side: 'long', size: ADD, leverage: LEVERAGE });
  expect(add.status, JSON.stringify(add.body)).toBe(200);
  const tier = add.body.riskTier;
  expect(tier).toMatchObject({ current: 1, confirmRequired: true });
  expect(tier.projected).toBeGreaterThan(1);
  const rate = { 2: '1.00%', 3: '2.50%', 4: '5.00%' }[tier.projected];
  const before = await me.balances();
  const unconfirmed = await me.post('/api/v1/futures/orders', {
    symbol: SYMBOL,
    side: 'buy',
    type: 'market',
    amount: ADD,
    leverage: LEVERAGE,
    marginMode: 'isolated',
    clientOrderId: `${J}-add-unconfirmed`,
  });
  expect(unconfirmed.status, JSON.stringify(unconfirmed.body)).toBe(409);
  expect(unconfirmed.body.error).toBe('trade.risk_limit_confirm_required');
  expect(unconfirmed.body.message).toContain(`moves the position from tier 1 into tier ${tier.projected} (maintenance ${rate})`);
  expect(unconfirmed.body.message).toContain(`at ${LEVERAGE}x leverage; every tier answers to the listing cap of 10x`);
  expect(await me.balances()).toEqual(before);
  expect((await me.get('/api/v1/futures/orders?scope=open&limit=10')).body).toEqual([]);

  // On the desk: the review names the higher tier, and the confirm step names it with its leverage and waits for a tick.
  await page.getByRole('button', { name: 'Open another' }).click();
  await review(ADD);
  await expect(ticket.getByText(`Tier ${tier.projected}, maintenance ${rate}`)).toBeVisible();
  await expect(ticket.getByText('Higher than the tier your position sits in now.', { exact: false })).toBeVisible();
  await ticket.getByRole('button', { name: 'Open long' }).click();
  await expect(tierStep).toBeVisible();
  await expect(tierStep.getByRole('heading')).toHaveText(`New margin tier: tier ${tier.projected}`);
  await expect(tierStep).toContainText(`This order moves your position from tier 1 into tier ${tier.projected}.`);
  await expect(tierStep).toContainText(`Tier ${tier.projected} keeps ${rate} of the position’s value as maintenance margin`);
  await expect(tierStep).toContainText(`Leverage ${LEVERAGE}x. Every tier allows up to the listing cap of 10x.`);
  const go = confirm.getByRole('button', { name: 'Confirm open long' });
  await expect(go).toBeDisabled();
  const accept = tierStep.getByRole('checkbox', { name: `I accept tier ${tier.projected}` });
  await accept.click();
  await expect(go).toBeEnabled();
  const sent = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/v1/futures/orders')) sent.push(r.postDataJSON());
  });
  await go.click();
  // The confirm re-checks the numbers first; a mark that moved shows the new figures, and the tier is ticked again.
  const filled = page.getByText('Order filled');
  await expect(filled.or(confirm.getByText('The numbers moved since you reviewed'))).toBeVisible({ timeout: 20_000 });
  if (!(await filled.isVisible())) {
    await expect(go).toBeDisabled();
    await accept.click();
    await go.click();
  }
  await expect(filled).toBeVisible({ timeout: 20_000 });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ amount: ADD, confirmTier: tier.projected });
  await until(positionSize, (s) => s === '0.005', 'the position after the confirmed add');

  // Back to nothing open for the next step: a reduce-only close is never asked to confirm a tier.
  const close = await me.post('/api/v1/futures/orders', {
    symbol: SYMBOL,
    side: 'sell',
    type: 'market',
    amount: '0.005',
    reduceOnly: true,
    marginMode: 'isolated',
    clientOrderId: `${J}-close-6`,
  });
  expect(close.status, JSON.stringify(close.body)).toBe(200);
  await until(positionSize, (s) => s === '0', 'no open position after the close');
});

test(`${J} #7 opens beyond the open-interest share and with no limit published: refused with the room left, then refused by name`, async ({
  page,
}) => {
  const who = account();
  const me = await api(who);
  const SIZE_OVER = '0.2';
  const order = (amount, key) =>
    me.post('/api/v1/futures/orders', {
      symbol: SYMBOL,
      side: 'buy',
      type: 'market',
      amount,
      leverage: LEVERAGE,
      marginMode: 'isolated',
      clientOrderId: `${J}-7-${key}-${Date.now()}`,
      // The tier step is #6's; naming the top TEST tier keeps it out of the way here.
      confirmTier: 4,
    });
  const preview = (size) => me.post('/api/v1/positions/preview', { symbol: SYMBOL, side: 'long', size, leverage: LEVERAGE });

  // The stack publishes LOCAL TEST open-interest limits on the TEST perpetual (local-test-gates.mjs TEST_FUTURES_OI_LIMITS);
  // the preview reads them back, with the room this account has.
  const published = (await preview('0.001')).body.openInterest;
  expect(published, 'the TEST perpetual publishes open-interest limits').toMatchObject({ binding: 'account' });
  expect(published.accountCommitted).toBe('0');
  const restore = [`oiLimit=${published.limit}`, `oiShareBps=${published.shareBps}`];
  const ticket = page.getByRole('region', { name: 'Order ticket' });
  const row = () =>
    ticket
      .locator('div')
      .filter({ has: page.getByText('Open interest you can add', { exact: true }) })
      .last();
  async function review(size) {
    await ticket.getByRole('textbox', { name: 'Size' }).fill(size);
    await ticket.getByRole('textbox', { name: 'Leverage' }).fill(LEVERAGE);
    await ticket.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(ticket.getByText('Open interest you can add', { exact: true })).toBeVisible();
  }
  try {
    // One basis point per account: with a TEST limit of 1000 BTC, one account may hold 0.1 BTC.
    tool('local-test-gates.mjs', 'risk', SYMBOL, 'oiShareBps=1');
    await expect.poll(async () => (await preview('0.001')).body.openInterest?.accountCap).toBe('0.1');

    // The review shows the room before Confirm, and names the rule when the size is past it; Open stays off.
    await desk(page);
    await review(SIZE_OVER);
    await expect(row()).toContainText('0.1 BTC');
    await expect(ticket.getByText('One account may hold up to 0.1 BTC', { exact: false })).toBeVisible();
    const line = ticket.locator('[data-code="trade.oi_share_limit"]');
    await expect(line).toContainText('room left 0.1 BTC');
    await expect(ticket.getByRole('button', { name: 'Open long' })).toBeDisabled();

    // The service refuses on its own with the room left, before any hold.
    const before = await me.balances();
    const over = await order(SIZE_OVER, 'over');
    expect(over.status, JSON.stringify(over.body)).toBe(422);
    expect(over.body.error).toBe('trade.oi_share_limit');
    expect(over.body.message).toContain(
      `past the 0.1 BTC one account may hold (0.01% of the market's limit of ${published.limit} BTC); room left 0.1 BTC`,
    );
    expect(await me.balances()).toEqual(before);
    expect((await me.get('/api/v1/futures/orders?scope=open&limit=10')).body).toEqual([]);

    // With the limit unset, every open on the contract refuses by name; nothing is held.
    tool('local-test-gates.mjs', 'risk', SYMBOL, 'oiLimit=unset');
    await expect.poll(async () => (await preview('0.001')).body.openInterest ?? null).toBeNull();
    const blank = await preview('0.001');
    expect(blank.body.refusals).toContainEqual(expect.objectContaining({ code: 'trade.oi_limit_unset', field: 'openInterest' }));
    await review('0.001');
    await expect(row()).toContainText('Not published');
    await expect(ticket.locator('[data-code="trade.oi_limit_unset"]')).toBeVisible();
    await expect(ticket.getByRole('button', { name: 'Open long' })).toBeDisabled();
    const unset = await order('0.001', 'unset');
    expect(unset.status, JSON.stringify(unset.body)).toBe(503);
    expect(unset.body.error).toBe('trade.oi_limit_unset');
    expect(await me.balances()).toEqual(before);
  } finally {
    tool('local-test-gates.mjs', 'risk', SYMBOL, ...restore);
  }
  const back = (await preview('0.001')).body.openInterest;
  expect([back?.limit, back?.shareBps]).toEqual([published.limit, published.shareBps]);
});

test(`${J} #8 previews while the dynamic price range is wider than usual: the band shown with its current width, an order outside refused`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = account();
  const me = await api(who);
  const tick = 10n ** 16n; // 0.01 USDT, the TEST perp's price step
  const preview = (body = {}) =>
    me.post('/api/v1/positions/preview', { symbol: SYMBOL, side: 'long', size: SIZE, leverage: LEVERAGE, ...body });
  // TEST values through the two-person risk door: widen up to 20% past any premium, worked out every second (the band
  // job itself runs on the stack's 15 s futures cadence).
  const RANGE = ['priceRangeMax=0.2', 'priceRangeTrigger=0', 'priceRangeCadenceSeconds=1'];
  const UNSET = ['priceRangeMax=unset', 'priceRangeTrigger=unset', 'priceRangeCadenceSeconds=unset'];

  // No range is published on the stack: the owner's static band (LOCAL TEST 5%) is in force, and says why.
  tool('local-test-gates.mjs', 'risk', SYMBOL, ...UNSET);
  await expect.poll(async () => (await preview()).body.band?.reason).toBe('price_range_unset');
  expect((await preview()).body.band).toMatchObject({ fraction: '0.05', staticFraction: '0.05', source: 'static', max: null });

  // The premium is the futures book's mid away from the mark (the BTC/USDT spot book's mid). The TEST market maker
  // quotes both books round the same mid, so on its own the premium is there only for the moment between its two
  // requotes (#6664: run 712 saw none in 120 s). This step makes it on the book instead: a TEST bid 1 USDT above the
  // maker's best bid becomes the best bid and lifts the futures mid by 0.5 USDT, 50 price steps, while it rests. The
  // maker quotes 6 bps either side of the mid and its walk moves at most 12 bps a cycle, so its next ask meets the bid
  // only on the largest down step; nothing else trades the TEST perp (one worker). When the bid is no longer the best
  // (the maker moved up past it, or it filled) it is re-placed, and it is cancelled in the `finally`.
  let lean = null;
  const leanOnTheBook = async () => {
    const { bid } = await bestPrices(SYMBOL, 1);
    if (lean && bid === lean.price) return;
    if (lean) await me.delete(`/api/v1/futures/orders/${encodeURIComponent(lean.id)}`);
    const price = fromUnits(toUnits(bid) + 100n * tick);
    const placed = await me.post('/api/v1/futures/orders', {
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      price,
      amount: SIZE,
      leverage: LEVERAGE,
      marginMode: 'isolated',
      clientOrderId: `${J}-8-lean-${Date.now()}`,
      confirmTier: 4,
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(200);
    expect(placed.body).toMatchObject({ status: 'open', limitPrice: price, filledQty: '0' });
    lean = { id: placed.body.orderId, price };
  };

  try {
    tool('local-test-gates.mjs', 'risk', SYMBOL, ...RANGE);
    // While the bid rests the band in force is the static band plus the premium. Each check below reads one preview,
    // so its band and its verdict belong together.
    const dynamic = async (body) => {
      let res = null;
      await expect
        .poll(
          async () => {
            await leanOnTheBook();
            res = await preview(body);
            return res.body.band?.source;
          },
          { timeout: 120_000, intervals: [1_000], message: 'the band job widens the band by the premium it reads' },
        )
        .toBe('dynamic');
      return res.body;
    };
    const wide = await dynamic();
    expect(wide.band).toMatchObject({ staticFraction: '0.05', source: 'dynamic', reason: 'widened', max: '0.2' });
    const fraction = toUnits(wide.band.fraction);
    expect(fraction).toBe(toUnits('0.05') + toUnits(wide.band.premium));
    expect(fraction > toUnits('0.05') && fraction < toUnits('0.2')).toBe(true);
    const mark = toUnits(wide.markPrice);
    expect(toUnits(wide.band.high)).toBe(mark + (mark * fraction) / 10n ** 18n);

    // A limit between the usual edge and the wider one is inside the band in force.
    const inside = await dynamic({ type: 'limit', limitPrice: wide.band.high });
    const usualHigh = toUnits(inside.markPrice) + (toUnits(inside.markPrice) * 5n) / 100n;
    // The bid's premium is 0.5 USDT, so the wider edge sits 50 price steps past the usual one.
    expect(toUnits(inside.band.high) - tick > usualHigh).toBe(true);
    const between = fromUnits(((usualHigh + toUnits(inside.band.high)) / 2n / tick) * tick);
    const check = await dynamic({ type: 'limit', limitPrice: between });
    expect(toUnits(between) > usualHigh && toUnits(between) <= toUnits(check.band.high)).toBe(true);
    expect(check.refusals.map((r) => r.code)).not.toContain('trade.futures_price_outside_band');

    // The review shows the band at its current width, and says it is wider than usual and why.
    await desk(page);
    const ticket = page.getByRole('region', { name: 'Order ticket' });
    await ticket.getByRole('textbox', { name: 'Size' }).fill(SIZE);
    await ticket.getByRole('textbox', { name: 'Leverage' }).fill(LEVERAGE);
    const wider = ticket.getByText(
      /Wider than usual: the mark plus or minus [\d.]+%, not the usual 5\.00%, while the futures price is [\d.]+% away/,
    );
    await expect
      .poll(
        async () => {
          await leanOnTheBook();
          await ticket.getByRole('button', { name: 'Review', exact: true }).click();
          await expect(ticket.getByText('Price band', { exact: true })).toBeVisible();
          return wider.isVisible();
        },
        { timeout: 120_000, intervals: [2_000], message: 'the review shows the wider band' },
      )
      .toBe(true);

    // Past the band in force refuses, in the review and at the service, before anything is held. 100 USDT past the
    // wider edge is past it whichever way the premium moves meanwhile (it moves by a few USDT on the TEST book).
    const past = fromUnits(((toUnits(wide.band.high) + 100n * 10n ** 18n) / tick) * tick);
    const outside = await preview({ type: 'limit', limitPrice: past });
    expect(outside.body.refusals).toContainEqual(
      expect.objectContaining({
        code: 'trade.futures_price_outside_band',
        message: expect.stringContaining(`to ${outside.body.band.high}`),
      }),
    );
    await ticket.getByRole('group', { name: 'Order type' }).getByRole('button', { name: 'Limit' }).click();
    await ticket.getByRole('textbox', { name: 'Limit price' }).fill(past);
    await ticket.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(ticket.locator('[data-code="trade.futures_price_outside_band"]')).toContainText('outside the band');
    await expect(ticket.getByRole('button', { name: 'Open long' })).toBeDisabled();
    const before = await me.balances();
    const refused = await me.post('/api/v1/futures/orders', {
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      price: past,
      amount: SIZE,
      leverage: LEVERAGE,
      marginMode: 'isolated',
      clientOrderId: `${J}-8-outside-${Date.now()}`,
      confirmTier: 4,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
    expect(refused.body.error).toBe('trade.futures_price_outside_band');
    expect(await me.balances()).toEqual(before);
  } finally {
    if (lean) await me.delete(`/api/v1/futures/orders/${encodeURIComponent(lean.id)}`);
    tool('local-test-gates.mjs', 'risk', SYMBOL, ...UNSET);
  }
  // With the range cleared, the static band is in force again.
  await expect.poll(async () => (await preview()).body.band?.reason).toBe('price_range_unset');
});
