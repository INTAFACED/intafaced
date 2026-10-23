import { test, expect } from '@playwright/test';
import { api, fromUnits, journeyState, toUnits } from './stack.mjs';
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

  // The same numbers typed into the Calculator tab.
  await page.getByRole('tab', { name: 'Calculator' }).click();
  const panel = page.getByRole('region', { name: 'Margin and P&L calculator' });
  await expect(panel.getByText('Nothing is placed, held or saved.')).toBeVisible();
  await panel.getByLabel('Size').fill(SIZE);
  await panel.getByLabel('Entry price').fill(mark);
  await panel.getByLabel('Exit price (optional)').fill(exit);
  await panel.getByLabel('Leverage').fill(LEVERAGE);
  const answered = page.waitForResponse((r) => r.url().includes('/api/v1/futures/calculator') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Calculate' }).click();
  const shown = await (await answered).json();
  expect(shown.initialMargin).toBe(calc.body.initialMargin);
  expect(shown.liquidationPrice).toBe(calc.body.liquidationPrice);
  expect(shown.pnl).toBe(calc.body.pnl);

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
  // Clear derivatives access first, so the refusal below is the collateral rule and nothing else.
  await page.getByRole('button', { name: 'I have read this' }).click();
  const quiz = page.getByTestId('futures-quiz');
  await quiz.getByRole('radio', { name: /liquidated and can lose all of its margin/ }).check();
  await quiz.getByRole('button', { name: 'Submit answers' }).click();
  await expect(quiz.getByText('Passed. You can trade derivatives under the current rules.')).toBeVisible();
  for (const kind of ['derivatives_risk', 'margin_terms']) {
    const card = page.getByTestId(`agreement-${kind}`);
    await card.getByRole('button', { name: /^Accept / }).click();
    await expect(card).toContainText('Accepted');
  }
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
