import { test, expect } from './journey.mjs';
import { api, journeyState, toUnits, fromUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-derivatives-06, in the running app (docs/roadmap/journeys.json): watch and top up the margin on an isolated position.
// One test per step, titled "J-derivatives-06 #<n>", run in order on one TEST account funded with TEST USDT. The contract
// is the TEST perpetual `local-test-gates.mjs futures` lists; its maintenance tiers are the stack's LOCAL TEST ladder. The
// mark follows the stack's TEST book, which the TEST market maker walks, so every figure that needs the mark is compared
// with the service's own answer read at the same moment. Not here yet: #3, #4, #6 and #7 (each lands with its own
// slice; #3's floor waits on an owner decision).
const J = 'J-derivatives-06';
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

async function until(read, ok, what, ms = 30_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what}: still ${JSON.stringify(last)}`);
}

async function openLong(me) {
  const { body } = await me.get('/api/v1/positions');
  const open = body.find((p) => p.symbol === SYMBOL && p.side === 'long' && p.status === 'open');
  if (open) return open;
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

/** An exact decimal as the room draws it to its last digit: thousands grouped, nothing rounded, a true minus sign. */
function exact(decimal, unit = 'USDT') {
  const negative = decimal.startsWith('-');
  const [whole, frac] = decimal.replace(/^-/, '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}${grouped}${frac ? `.${frac}` : ''} ${unit}`;
}

/** A ratio as a percent with 16 places: the 18-digit ratio times 100, so not a digit is lost. */
function exactPct(ratio) {
  const units = toUnits(ratio);
  const step = 10n ** 16n;
  const whole = (units / step).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${whole}.${(units % step).toString().padStart(16, '0')}%`;
}

const METRICS = ['equity', 'available', 'used', 'maintenance', 'ratio'];

async function shownMetrics(region) {
  const out = {};
  for (const id of METRICS) out[id] = (await region.getByTestId(`metric-${id}`).innerText()).trim();
  return out;
}

const expected = (s) => ({
  equity: exact(s.equity),
  available: exact(s.available),
  used: exact(s.usedMargin),
  maintenance: exact(s.totalMaintenanceMargin),
  ratio: exactPct(s.marginRatio),
});

test(`${J} #1 opens Account metrics: equity, available, used margin and margin ratio as exact decimals`, async ({ page }) => {
  const who = await fundedTrader(page, 'jd6', '1000');
  run.reset({ account: who });
  const me = await api(who);
  const position = await openLong(me);
  run.write({ positionId: position.id });
  await signIn(page, who);
  await page.goto(DESK);
  const region = page.getByRole('region', { name: 'Account metrics' });
  await expect(region).toBeVisible();
  for (const label of ['Equity', 'Available', 'Used margin', 'Maintenance margin', 'Margin ratio']) {
    await expect(region.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) })).toBeVisible();
  }

  // What the service works out, from the same marked rows as the positions list, read in one moment: used margin is the
  // margin the position holds, maintenance is its maintenance, equity is its margin plus unrealised PnL, available is the
  // free balance, and the ratio is maintenance over equity, all to the last digit.
  const { summary, row, free } = await until(
    async () => {
      const [s, list, balances] = await Promise.all([
        me.get('/api/v1/futures/margin-summary?asset=USDT'),
        me.get('/api/v1/positions'),
        me.balances(),
      ]);
      return { summary: s, row: list.body.find((p) => p.id === position.id), free: balances.USDT?.free };
    },
    ({ summary: s, row: r, free: f }) =>
      s.status === 200 &&
      r?.maintenanceMargin != null &&
      s.body.totalMaintenanceMargin === r.maintenanceMargin &&
      s.body.available != null &&
      f != null &&
      toUnits(s.body.available) === toUnits(f) &&
      s.body.equity === fromUnits(toUnits(r.collateral) + toUnits(r.unrealizedPnl)),
    'the summary and the position read at one mark',
  );
  const s = summary.body;
  expect(s.asset).toBe('USDT');
  expect(s.usedMargin).toBe(row.collateral);
  expect(toUnits(s.available)).toBe(toUnits(free));
  for (const field of ['equity', 'available', 'usedMargin', 'totalMaintenanceMargin', 'marginRatio']) {
    expect(s[field], field).toMatch(/^-?\d+(\.\d+)?$/);
  }
  expect(s.marginRatio).toBe(fromUnits((toUnits(s.totalMaintenanceMargin) * 10n ** 18n) / toUnits(s.equity)));
  expect(s.missing.map((m) => m.field)).toEqual(
    expect.not.arrayContaining(['maintenanceMargin', 'unrealizedPnl', 'available', 'usedMargin']),
  );

  // The room draws the service's figures, not its own sums: every one matches the summary read at the same moment.
  const seen = await until(
    async () => {
      const [shown, fresh] = await Promise.all([shownMetrics(region), me.get('/api/v1/futures/margin-summary?asset=USDT')]);
      return { shown, want: expected(fresh.body) };
    },
    ({ shown, want }) => METRICS.every((id) => shown[id] === want[id]),
    'the Account metrics drawn from the service',
  );
  // Exact: nothing rounded away (the used margin carries every digit the service gave).
  expect(seen.shown.used).toBe(exact(row.collateral));
  await expect(region).toContainText('Exact figures, worked out by the platform from the current mark price.');
  await expect(region.getByRole('status')).toHaveCount(0);
});

test(`${J} #2 adds margin to a position: the margin and liquidation price after, from the service`, async ({ page }) => {
  const who = account();
  const me = await api(who);
  const { positionId } = run.read();
  if (!positionId) throw new Error(`${J} #1 opened no position, so there is nothing to add margin to`);
  const before = (await me.get('/api/v1/positions')).body.find((p) => p.id === positionId);
  expect(before?.status).toBe('open');
  expect(before.liquidationPrice, JSON.stringify(before.fieldReasons)).toMatch(/^\d+(\.\d+)?$/);
  const ADD = '5.12345678';
  const freeBefore = toUnits((await me.balances()).USDT.free);

  await signIn(page, who);
  await page.goto(DESK);
  await page.getByRole('tab', { name: 'Positions' }).click();
  await page.getByRole('button', { name: `Manage ${SYMBOL}` }).click();
  await page.getByRole('menuitem', { name: 'Add margin' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add margin' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/Amount/).fill(ADD);
  const sent = page.waitForResponse((r) => r.url().includes('/positions/margin') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Add margin' }).click();
  const answer = await sent;
  expect(answer.status()).toBe(200);
  const posted = await answer.json();
  // The service's answer: the margin moved by exactly the amount, once.
  expect(toUnits(posted.collateral)).toBe(toUnits(before.collateral) + toUnits(ADD));
  await expect(dialog).toBeHidden();

  // The row now shows the service's margin and its recomputed liquidation price: lower for a long with more margin.
  // The positions table is a grid (its rows open a position's detail), so its cells are grid cells.
  const table = page.getByRole('grid', { name: 'Open futures positions' });
  const row = table.getByRole('row').filter({ hasText: SYMBOL }).first();
  await expect(table.getByRole('columnheader', { name: 'Margin', exact: true })).toBeVisible();
  // The headers may be drawn in capitals by the style, so their text is read as written, not as shown.
  const headers = (await table.getByRole('columnheader').allTextContents()).map((h) => h.trim());
  const marginAt = headers.indexOf('Margin');
  const liqAt = headers.indexOf('Liquidation price');
  expect(marginAt, headers.join(' | ')).toBeGreaterThanOrEqual(0);
  expect(liqAt, headers.join(' | ')).toBeGreaterThanOrEqual(0);
  const number = (text) => toUnits((/[\d,]+(\.\d+)?/.exec(text)?.[0] ?? 'NaN').replace(/,/g, ''));
  const near = (a, b, places) => {
    const half = 5n * 10n ** BigInt(17 - places);
    return a - b <= half && b - a <= half;
  };
  const after = await until(
    async () => {
      const [list, margin, liq] = await Promise.all([
        me.get('/api/v1/positions'),
        row.getByRole('gridcell').nth(marginAt).innerText(),
        row.getByRole('gridcell').nth(liqAt).innerText(),
      ]);
      return { p: list.body.find((x) => x.id === positionId), margin, liq };
    },
    ({ p, margin, liq }) =>
      p?.collateral === posted.collateral &&
      p.liquidationPrice != null &&
      near(number(margin), toUnits(p.collateral), 4) &&
      near(number(liq), toUnits(p.liquidationPrice), 8),
    'the row drawn from the service after the top-up',
  );
  expect(toUnits(after.p.liquidationPrice)).toBeLessThan(toUnits(before.liquidationPrice));
  // Taken from the free balance once, to the last digit.
  expect(toUnits((await me.balances()).USDT.free)).toBe(freeBefore - toUnits(ADD));
});

test(`${J} #5 sets a pre-liquidation stop: a close order at the maintenance level, shown on the position`, async ({ page }) => {
  const who = account();
  const me = await api(who);
  const { positionId } = run.read();
  if (!positionId) throw new Error(`${J} #1 opened no position, so there is nothing to set a stop on`);
  const route = `/api/v1/positions/${positionId}/risk-stop`;
  const before = await me.get(route);
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  expect(before.body).toMatchObject({ positionId, status: 'none', level: null, triggerPrice: null });
  // The ratio now (maintenance over equity, in percent) is the service's, and a 5x long sits far below 50%.
  expect(before.body.marginRatio, JSON.stringify(before.body)).toMatch(/^\d+(\.\d+)?$/);
  expect(toUnits(before.body.marginRatio)).toBeLessThan(toUnits('50'));

  // At 100% the liquidation itself starts: the service refuses a stop there in words, and stores nothing.
  const late = await me.put(route, { level: '100', clientRequestId: `${J}-late-${Date.now()}` });
  expect(late.status).toBe(400);
  expect(late.body).toMatchObject({ error: 'trade.risk_stop_invalid' });
  expect(late.body.message).toMatch(/after the liquidation/);
  expect((await me.get(route)).body.status).toBe('none');

  await signIn(page, who);
  await page.goto(DESK);
  await page.getByRole('tab', { name: 'Positions' }).click();
  await page.getByRole('button', { name: `Manage ${SYMBOL}` }).click();
  await page.getByRole('menuitem', { name: 'Pre-liquidation stop' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pre-liquidation stop' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('places a market order that closes the whole position');
  await expect(dialog.getByRole('term').filter({ hasText: /^Margin ratio now$/ })).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'On this position now' })).toContainText('No pre-liquidation stop set');
  const level = dialog.getByLabel(/Close at margin ratio/);
  const save = dialog.getByRole('button', { name: 'Set stop' });
  // The dialog says so before anything is sent.
  await level.fill('100');
  await expect(dialog).toContainText('Enter a percent above 0 and below 100');
  await expect(save).toBeDisabled();

  const LEVEL = '50';
  await level.fill(LEVEL);
  await expect(save).toBeEnabled();
  const sent = page.waitForResponse((r) => r.url().endsWith(`/positions/${positionId}/risk-stop`) && r.request().method() === 'PUT');
  await save.click();
  const answer = await sent;
  expect(answer.status()).toBe(200);
  const set = await answer.json();
  await expect(dialog).toBeHidden();

  // The service holds the stop: the maintenance level as set (maintenance margin over equity), and a real close order
  // resting now: reduce-only, the whole position, triggered on the mark at which the ratio reaches that level.
  expect(set).toMatchObject({ positionId, status: 'armed', level: LEVEL });
  expect(set.triggerPrice, JSON.stringify(set)).toMatch(/^\d+(\.\d+)?$/);
  expect(set.closeOrder, JSON.stringify(set)).toMatchObject({ status: 'armed', triggerPrice: set.triggerPrice });
  const orders = await me.get('/api/v1/futures/conditional-orders');
  expect(orders.status, JSON.stringify(orders.body)).toBe(200);
  const closeOrder = (orders.body.orders ?? orders.body).find((o) => o.clientOrderId === set.closeOrder.clientOrderId);
  expect(closeOrder, JSON.stringify(orders.body)).toMatchObject({
    positionId,
    kind: 'stop_market',
    side: 'sell',
    quantity: SIZE,
    reduceOnly: true,
    triggerSource: 'mark',
    triggerPrice: set.triggerPrice,
    status: 'armed',
  });
  const held = await until(
    async () => {
      const [stop, list] = await Promise.all([me.get(route), me.get('/api/v1/positions')]);
      return { stop: stop.body, p: list.body.find((x) => x.id === positionId) };
    },
    ({ stop, p }) =>
      stop.status === 'armed' &&
      p?.liquidationPrice != null &&
      p?.markPrice != null &&
      p?.maintenanceMargin != null &&
      p?.collateral != null &&
      p?.unrealizedPnl != null,
    'the stop and the position read together',
  );
  expect(held.stop).toMatchObject({
    level: LEVEL,
    triggerPrice: set.triggerPrice,
    closeOrder: { clientOrderId: closeOrder.clientOrderId, status: 'armed' },
  });
  // For a long that mark lies between the liquidation price and the mark now ...
  const trigger = toUnits(held.stop.triggerPrice);
  expect(trigger).toBeGreaterThan(toUnits(held.p.liquidationPrice));
  expect(trigger).toBeLessThan(toUnits(held.p.markPrice));
  // ... and it is where the ratio reaches the level: with the position's own figures read now, the maintenance margin
  // at that mark over the equity at that mark is the level, to a millionth of it. (A linear contract: the maintenance
  // margin moves with the mark on the position's tier, and the long's equity by its size times the move.)
  const ONE = 10n ** 18n;
  const mark = toUnits(String(held.p.markPrice));
  const size = toUnits(SIZE);
  const maintenanceAt = (toUnits(String(held.p.maintenanceMargin)) * trigger) / mark;
  const equityAt = toUnits(String(held.p.collateral)) + toUnits(String(held.p.unrealizedPnl)) + (size * (trigger - mark)) / ONE;
  expect(equityAt).toBeGreaterThan(0n);
  const ratioAt = (maintenanceAt * ONE) / equityAt;
  const wanted = toUnits(LEVEL) / 100n;
  const off = ratioAt > wanted ? ratioAt - wanted : wanted - ratioAt;
  expect(off * 1_000_000n, `ratio at the trigger ${fromUnits(ratioAt)} against ${fromUnits(wanted)}`).toBeLessThanOrEqual(wanted);

  // Shown on the position: its row names the level and the close order's trigger, as the service holds them.
  const table = page.getByRole('grid', { name: 'Open futures positions' });
  const row = table.getByRole('row').filter({ hasText: SYMBOL }).first();
  const shown = row.getByTestId('risk-stop');
  await expect(shown).toContainText(`Stop ${LEVEL}%`);
  const number = (text) => toUnits((/[\d,]+\.\d+/.exec(text)?.[0] ?? 'NaN').replace(/,/g, ''));
  const half = 5n * 10n ** BigInt(17 - 8);
  await until(
    async () => number(await shown.innerText()),
    (drawn) => drawn - toUnits(set.triggerPrice) <= half && toUnits(set.triggerPrice) - drawn <= half,
    'the close price drawn on the row',
  );

  // Opened again, the dialog reads the stop back from the service, to the last digit.
  await page.getByRole('button', { name: `Manage ${SYMBOL}` }).click();
  await page.getByRole('menuitem', { name: 'Pre-liquidation stop' }).click();
  const current = dialog.getByRole('region', { name: 'On this position now' });
  await expect(current).toContainText(`Closes at margin ratio ${LEVEL}%`);
  await expect(current).toContainText(`Close order at mark ${exact(set.triggerPrice, '').trim()}`);
});
