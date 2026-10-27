import { test, expect } from '@playwright/test';
import { api, journeyState, toUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-derivatives-01, in the running app (docs/roadmap/journeys.json): open a first futures position with isolated
// margin, watch it, close 40 percent and then the rest. One test per step, titled "J-derivatives-01 #<n>", run in order
// on one TEST account. The contract is the TEST perpetual `local-test-gates.mjs futures` lists; no agreement, knowledge
// check or notice gates it (owner decision 2026-10-27). Every number is a TEST number on the local stack, read back
// through the customer's own API.
const J = 'J-derivatives-01';
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

const access = (page) => page.getByTestId('futures-access');

async function gateFor(who) {
  const { status, body } = await (await api(who)).get('/api/v1/account/gated-list');
  expect(status).toBe(200);
  return body.contracts.find((c) => c.symbol === SYMBOL);
}

async function positionsOf(who) {
  const { status, body } = await (await api(who)).get('/api/v1/positions');
  expect(status).toBe(200);
  return body;
}

/** Fills land through the matching events, so a position read waits for the book to settle. */
async function until(read, ok, what, waitMs = 20_000) {
  const end = Date.now() + waitMs;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what}: still ${JSON.stringify(last).slice(0, 400)}`);
}

/**
 * The stack's TEST perpetual taker fee on a fill: 5 bps (local-test-stack.mjs TRADE_FEE_SCHEDULE `perpetual`; a new TEST
 * account has no rank discount) of size × price, rounded up to the unit once (svc-trade `fillFee`).
 */
function takerFee(size, price) {
  const denominator = 10n ** 18n * 10_000n;
  return (toUnits(size) * toUnits(price) * 5n + denominator - 1n) / denominator;
}

/** Every write the page sends from now on (the steps that must send nothing read it back). */
function writes(page) {
  const sent = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/')) sent.push(`${r.method()} ${r.url()}`);
  });
  return sent;
}

test(`${J} #1 opens /trade/futures and sees the whole desk`, async ({ page }) => {
  const who = await fundedTrader(page, 'jd', '1000');
  run.reset({ account: who });
  await desk(page);
  await expect(page.getByRole('combobox', { name: 'Choose a contract' })).toContainText(SYMBOL);
  await expect(page.getByRole('region', { name: 'Order ticket' })).toBeVisible();
  for (const tab of ['Positions', 'Orders', 'History', 'Funding', 'ADL and liquidations', 'Margin calls']) {
    await expect(page.getByRole('tab', { name: tab })).toBeVisible();
  }
  await expect(page.getByRole('region', { name: 'Chart' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Risk' }).getByText('Free balance')).toBeVisible();
  await expect(access(page)).toBeVisible();
});

// The legal and suitability reasons the list used to carry. None of them is a reason any more (owner decision 2026-10-27).
const LEGAL_CODES = ['trade.derivatives_eligibility_unset', 'trade.agreement_required', 'trade.adl_disclosure_required'];

test(`${J} #2 reads the gated list: the contract is open for this verified account, and no legal step is a reason`, async ({ page }) => {
  const who = account();
  await desk(page);
  const panel = access(page);
  await expect(panel.getByText('Open for your account')).toBeVisible();
  for (const code of LEGAL_CODES) await expect(panel.locator(`[data-code="${code}"]`)).toHaveCount(0);
  // The screen shows what the service says for this account.
  const gate = await gateFor(who);
  expect(gate).toMatchObject({ open: true, blockers: [] });
});

// Step 3 was "reads and accepts the risk agreement and margin terms". Deferred until launch prep (owner decision
// 2026-10-27): this step proves nothing asks for an agreement, a knowledge check or the auto-deleveraging notice.
test(`${J} #3 nothing asks for a risk agreement, a knowledge check or a notice before an open`, async ({ page }) => {
  const who = account();
  const me = await api(who);
  await desk(page);
  const panel = access(page);
  await expect(panel.getByText('Open for your account')).toBeVisible();
  await expect(page.getByTestId('agreement-derivatives_risk')).toHaveCount(0);
  await expect(page.getByTestId('agreement-margin_terms')).toHaveCount(0);
  await expect(page.getByTestId('futures-quiz')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'I have read this' })).toHaveCount(0);
  // The customer doors for them are gone.
  expect((await me.get('/api/v1/account/agreements')).status).toBe(404);
  expect((await me.get('/api/v1/account/derivatives-eligibility')).status).toBe(404);
  expect(await positionsOf(who)).toHaveLength(0);
});

test(`${J} #4 picks the contract and reads its strip: family, settle asset, contract size, mark and funding`, async ({ page }) => {
  await desk(page);
  const strip = page.getByRole('region', { name: SYMBOL, exact: true });
  await expect(strip.getByText('Perpetual · Linear')).toBeVisible();
  await expect(strip.getByText('Settles in')).toBeVisible();
  await expect(strip).toContainText('USDT');
  await expect(strip.getByText('0.001 BTC')).toBeVisible();
  await expect(strip.getByText('Mark price')).toBeVisible();
  await expect(strip.getByText(/^\d{1,3}(,\d{3})*\.\d{2}$/).first()).toBeVisible();
  // Funding: the rate the service publishes, or a dash that says it is not published. Never an invented rate.
  await expect(strip.getByText('Funding rate')).toBeVisible();
  const markets = (await (await api(account())).get('/api/v1/markets?limit=500')).body;
  const listed = markets.find((m) => m.symbol === SYMBOL);
  expect([listed.family, listed.settleAsset, listed.contractSize]).toEqual(['linear', 'USDT', '0.001']);
});

test(`${J} #5 chooses the margin mode: isolated is live, cross and portfolio refuse and nothing changes`, async ({ page }) => {
  await desk(page);
  const sent = writes(page);
  const mode = page.getByRole('group', { name: 'Margin mode' });
  const isolated = mode.getByRole('button', { name: 'Isolated' });
  await expect(isolated).toHaveAttribute('aria-pressed', 'true');
  await mode.getByRole('button', { name: 'Cross' }).click();
  await expect(page.locator('[data-code="trade.cross_margin_unsupported"]')).toContainText('Cross margin is not offered');
  await expect(isolated).toHaveAttribute('aria-pressed', 'true');
  await mode.getByRole('button', { name: 'Portfolio' }).click();
  await expect(page.locator('[data-code="trade.portfolio_margin_unset"]')).toContainText('Portfolio margin is not offered');
  await expect(isolated).toHaveAttribute('aria-pressed', 'true');
  expect(sent).toEqual([]);
});

async function fillTicket(page) {
  const ticket = page.getByRole('region', { name: 'Order ticket' });
  await ticket.getByRole('textbox', { name: 'Size' }).fill(SIZE);
  await ticket.getByRole('textbox', { name: 'Leverage' }).fill(LEVERAGE);
  await ticket.getByRole('button', { name: 'Review', exact: true }).click();
  return ticket;
}

test(`${J} #6 types a TEST size and leverage and reviews: margin, fee, liquidation price and total from the preview`, async ({ page }) => {
  await desk(page);
  const ticket = await fillTicket(page);
  for (const row of ['Initial margin', 'Liquidation price', 'Total to commit now']) {
    await expect(ticket.getByText(row, { exact: true })).toBeVisible();
  }
  await expect(ticket.getByText(/fee/i).first()).toBeVisible();
  const preview = await (
    await api(account())
  ).post('/api/v1/positions/preview', { symbol: SYMBOL, side: 'long', size: SIZE, leverage: LEVERAGE });
  expect(preview.status).toBe(200);
  expect(preview.body.liquidationPrice).toMatch(/^\d+(\.\d+)?$/);
  expect(toUnits(preview.body.liquidationPrice)).toBeLessThan(toUnits(preview.body.markPrice));
});

test(`${J} #7 looks at the order types: market and limit offered, the rest listed with the reason and nothing sent`, async ({ page }) => {
  await desk(page);
  const sent = writes(page);
  const types = page.getByRole('group', { name: 'Order type' });
  await expect(types.getByRole('button', { name: 'Market' })).toBeEnabled();
  await expect(types.getByRole('button', { name: 'Limit' })).toBeEnabled();
  await types.getByRole('button', { name: 'Limit' }).click();
  await expect(page.getByRole('textbox', { name: 'Limit price' })).toBeVisible();
  await types.getByRole('button', { name: 'Market' }).click();
  await page.getByRole('button', { name: 'Order types not offered' }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  expect(await menu.getByRole('menuitem').count()).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  expect(sent).toEqual([]);
});

test(`${J} #8 confirms "Open long": one position opens and its margin is locked`, async ({ page }) => {
  const who = account();
  const before = (await (await api(who)).balances()).USDT;
  await desk(page);
  await expect(access(page).getByText('Open for your account')).toBeVisible();
  const ticket = await fillTicket(page);
  await expect(ticket.getByText('Total to commit now', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open long' }).click();
  const confirm = page.getByRole('alertdialog');
  // 0.01 BTC sits above the first margin tier on the TEST book's depth, so the confirm names the tier it opens in
  // (J-derivatives-02 #6) and the trader accepts it first.
  await expect(confirm).toBeVisible();
  const tier = confirm.getByRole('region', { name: 'New margin tier' });
  if ((await tier.count()) > 0) await tier.getByRole('checkbox').click();
  // A double press sends one order: the request id holds until the numbers change.
  await confirm.getByRole('button', { name: 'Confirm open long' }).dblclick();
  // The confirm re-checks the numbers; a mark that moved meanwhile shows the new figures, and the tier is ticked again.
  const filled = page.getByText('Order filled');
  await expect(filled.or(confirm.getByText('The numbers moved since you reviewed'))).toBeVisible({ timeout: 20_000 });
  if (!(await filled.isVisible())) {
    if ((await tier.count()) > 0) await tier.getByRole('checkbox').click();
    await confirm.getByRole('button', { name: 'Confirm open long' }).click();
  }
  await expect(filled).toBeVisible({ timeout: 20_000 });
  const positions = await until(
    () => positionsOf(who),
    (list) => list.length === 1 && list[0].contracts === SIZE,
    'one position of the TEST size',
  );
  expect(positions[0]).toMatchObject({ symbol: SYMBOL, side: 'long', marginMode: 'isolated', status: 'open' });
  const after = (await (await api(who)).balances()).USDT;
  // The opening fill took from the book, so it paid the TEST schedule's perpetual taker fee (5 bps of its notional, rounded up
  // once), and paid it once: the free balance fell by the margin and that one fee, and the rest of the hold came back.
  const fee = takerFee(SIZE, positions[0].entryPrice);
  expect(fee).toBeGreaterThan(0n);
  expect(toUnits(positions[0].fees)).toBe(fee);
  expect(toUnits(before.free) - toUnits(after.free)).toBe(toUnits(positions[0].initialMargin) + fee);
  const { body: orders } = await (await api(who)).get('/api/v1/futures/orders?scope=all&limit=100');
  expect(orders.filter((o) => !o.reduceOnly && o.status !== 'refused')).toHaveLength(1);
});

test(`${J} #9 opens the positions room: entry, mark, unrealised result, margin, leverage and liquidation price`, async ({ page }) => {
  const who = account();
  await desk(page);
  const [position] = await positionsOf(who);
  expect(position.liquidationPrice).toMatch(/^\d+(\.\d+)?$/);
  const row = page.getByRole('row').filter({ hasText: SYMBOL }).first();
  await expect(row).toContainText(`Long ${LEVERAGE}x`);
  await expect(row).toContainText(SIZE);
  for (const field of ['entryPrice', 'markPrice', 'collateral', 'liquidationPrice']) {
    expect(position[field], field).toMatch(/^\d+(\.\d+)?$/);
  }
  expect(position.unrealizedPnl).toMatch(/^-?\d+(\.\d+)?$/);
  // Shown as the exact decimal the service sends (to eight places): the whole number and the cents must match.
  const [whole, cents] = position.liquidationPrice.split('.');
  await expect(row).toContainText(`${Number(whole).toLocaleString('en-US')}.${(cents ?? '').padEnd(2, '0').slice(0, 2)}`);
});

test(`${J} #10 closes 40 percent, then the rest`, async ({ page }) => {
  const who = account();
  await desk(page);
  const [position] = await positionsOf(who);
  const part = '0.004';
  const row = page.getByRole('row').filter({ hasText: SYMBOL }).first();
  await row.getByRole('button', { name: `Close, ${SYMBOL}` }).click();
  let dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).first();
  await dialog.getByRole('textbox', { name: 'Size to close' }).fill(part);
  await dialog.getByRole('button', { name: 'Close this size' }).click();
  const smaller = await until(
    () => positionsOf(who),
    (list) => list.length === 1 && list[0].contracts === '0.006',
    'the position after closing 40 percent',
  );
  expect(smaller[0].id).toBe(position.id);

  await page.reload();
  await row.getByRole('button', { name: `Close, ${SYMBOL}` }).click();
  dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).first();
  await dialog.getByRole('button', { name: 'Close position' }).click();
  await until(
    () => positionsOf(who),
    (list) => list.length === 0,
    'no open position after the full close',
  );
  const { body: closed } = await (await api(who)).get('/api/v1/positions/closed?limit=5');
  expect(closed[0]).toMatchObject({ id: position.id, status: 'closed' });
  expect(closed[0].realizedPnl).toMatch(/^-?\d+(\.\d+)?$/);
  // Both closes are reduce-only orders through the book; together they are the whole position.
  const { body: orders } = await (await api(who)).get('/api/v1/futures/orders?scope=all&limit=100');
  const reduces = orders.filter((o) => o.reduceOnly && o.status === 'filled');
  expect(reduces.map((o) => o.filledQty).sort()).toEqual(['0.004', '0.006']);
  // Nothing stays held: the free balance is the whole USDT balance again.
  const usdt = (await (await api(who)).balances()).USDT;
  expect(toUnits(usdt.used ?? '0')).toBe(0n);
});

test(`${J} #11 opens History and sees the closed position with its realised result`, async ({ page }) => {
  const who = account();
  const { body: closed } = await (await api(who)).get('/api/v1/positions/closed?limit=5');
  await desk(page);
  await page.getByRole('tab', { name: 'History' }).click();
  const table = page.getByRole('table', { name: 'Position history' });
  const row = table.getByRole('row').filter({ hasText: SYMBOL }).first();
  await expect(row).toContainText('Closed');
  // The whole size it closed, across both reduces, not the last remainder.
  expect(closed[0].contracts).toBe(SIZE);
  await expect(row).toContainText(SIZE);
  const pnl = Number(closed[0].realizedPnl);
  await expect(row).toContainText(Math.abs(pnl).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));
  // Its fees: the opening fill's and both closing fills', every one through the book at the taker rate.
  const fees = toUnits(closed[0].fees);
  expect(fees).toBeGreaterThan(takerFee(SIZE, closed[0].entryPrice));
  await expect(table.getByRole('columnheader', { name: 'Fees paid' })).toBeVisible();
  await expect(row).toContainText(Number(closed[0].fees).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''));
});
