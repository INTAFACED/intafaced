// World: book
import { test, expect } from './journey.mjs';
import { api, bestPrices, journeyState, toUnits } from './stack.mjs';
import { awayBid, fundedTrader, openOrders, signIn } from './desk.mjs';
import { followOnScreen, leadFill, listLeader, takeBest } from './copy.mjs';

// J-copy-bots-otc-30, in the running app (docs/roadmap/journeys.json): see my orders, positions, history and depth in one
// MetaTrader-style view at /trade/terminal. One test per step, titled "J-copy-bots-otc-30 #<n>", run in order. #1 makes the
// start: a verified TEST trader with TEST 2000 USDT, one resting order, one fill, a copied position (it follows a TEST
// leader the stack's TEST founder lists) and one algo order (a TWAP), all on the TEST book. Every row is checked against
// the books, read through the service as the trader.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - none: every step is built.
const J = 'J-copy-bots-otc-30';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const ONE = toUnits('1');
const trpc = (proc, input) => `/api/trade/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

async function read(who, proc, input) {
  const res = await (await api(who)).get(trpc(proc, input));
  expect(res.status, `${proc}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  return res.body.result.data;
}

async function terminal(page, tab) {
  await signIn(page, state('trader'));
  await page.goto('/trade/terminal');
  await expect(page.getByRole('tablist', { name: 'Terminal' })).toBeVisible(UNBUILT);
  if (tab) await page.getByRole('tab', { name: tab, exact: true }).click();
}

/** The order ids a terminal table lists, read from its Order column. */
async function idsIn(table) {
  return (await table.locator('tbody tr td .font-mono').allTextContents()).map((s) => s.trim()).filter(Boolean);
}

test(`${J} #1 opens positions and history: orders and fills listed with statuses that match the book`, async ({ page }) => {
  test.setTimeout(360_000);
  const tag = Date.now().toString(36);
  const leader = await fundedTrader(page, 'jtl', '2000');
  const leaderRef = await listLeader(leader, `Journey Terminal ${tag}`);
  const trader = await fundedTrader(page, 'jtt', '2000');
  run.reset({ trader, leaderRef, tag });
  // A resting buy, a fill, a copied position and an algo order.
  const me = await api(trader);
  const resting = await me.post('/api/v1/orders', {
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    amount: '0.001',
    price: await awayBid(80),
    clientOrderId: `${J}-rest-${tag}`,
  });
  expect(resting.status, JSON.stringify(resting.body).slice(0, 300)).toBeLessThan(300);
  const filled = await takeBest(trader, 'buy', '0.001', `${J}-fill-${tag}`);
  await signIn(page, trader);
  const followId = await followOnScreen(page, trader, leaderRef, { perOrder: '50', total: '200', fixed: '20' });
  await leadFill(leader, 'buy', '0.001', `${J}-lead-${tag}`);
  const { ask } = await bestPrices();
  const algo = await me.post('/api/trade/trpc/algo.createTwap', {
    symbol: 'BTC/USDT',
    side: 'buy',
    totalQty: '0.002',
    // Ten slices over 20 minutes: the schedule is still open when #5 reads the tree.
    durationMs: 1_200_000,
    sliceIntervalMs: 120_000,
    // A buy limit must sit at or over the ask (the slice price band); a whole number 1% over it.
    limitPrice: String((toUnits(ask) * 101n) / 100n / ONE + 1n),
    clientAlgoId: `${J}-algo-${tag}`,
    kind: 'twap',
  });
  expect(algo.status, JSON.stringify(algo.body).slice(0, 300)).toBe(200);
  run.write({ followId, algoId: algo.body.result.data.id, restingId: resting.body.id, filledId: filled.id });

  // Open orders: the resting buy shows Open, and the table lists exactly the orders the book holds open.
  await terminal(page, 'Orders');
  const openTable = page.getByRole('table', { name: 'Open orders' });
  const restingRow = openTable.locator('tbody tr').filter({ hasText: resting.body.id });
  await expect(restingRow).toContainText('BTC/USDT');
  await expect(restingRow).toContainText('Buy');
  await expect(restingRow).toContainText('Open');
  await expect
    .poll(
      async () => {
        const book = (await openOrders(trader)).map((o) => o.id).sort();
        const shown = (await idsIn(openTable)).sort();
        return JSON.stringify(shown) === JSON.stringify(book);
      },
      { timeout: 45_000, message: 'the open orders on screen are not the orders the book holds open' },
    )
    .toBe(true);

  // History: the filled order shows Filled, and its fill is listed under Fills with that order's id.
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  const book = await me.get(`/api/v1/orders/${filled.id}?symbol=${encodeURIComponent('BTC/USDT')}`);
  expect(book.status).toBe(200);
  expect(book.body.status, 'the book holds the IOC buy as filled').toBe('closed');
  const historyRow = page.getByRole('table', { name: 'Order history' }).locator('tbody tr').filter({ hasText: filled.id });
  await expect(historyRow).toContainText('Filled');
  await expect(historyRow).not.toContainText('Open');
  const fillRow = page.getByRole('table', { name: 'Fills' }).locator('tbody tr').filter({ hasText: filled.id }).first();
  await expect(fillRow).toContainText('Fill');
  await expect(fillRow).toContainText('BTC/USDT');
  // The resting order is not in the history: it is still open on the book.
  await expect(page.getByRole('table', { name: 'Order history' }).locator('tbody tr').filter({ hasText: resting.body.id })).toHaveCount(0);
});

test(`${J} #2 opens a copied position: the follower position and its close action`, async ({ page }) => {
  test.setTimeout(180_000);
  const trader = state('trader');
  const followId = state('followId');
  // The copy of the leader's buy is open on the trader's own book before the view is opened.
  let position;
  await expect
    .poll(
      async () => {
        position = (await read(trader, 'copy.copiedPositions', { followId })).positions.find((p) => p.status === 'open');
        return Boolean(position);
      },
      { timeout: 60_000, message: 'the leader buy was never copied into an open position' },
    )
    .toBe(true);
  await terminal(page, 'Positions');
  const section = page.getByRole('region', { name: `Copied from ${state('leaderRef')}` });
  const row = section.getByRole('table', { name: 'Copied positions' }).locator('tbody tr').filter({ hasText: position.market }).first();
  await expect(row).toContainText('BTC/USDT');
  await expect(row).toContainText('Open');
  const close = row.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toBeEnabled();
  // The close action is real: it sends this position's close, and the book shows it closing or closed.
  const sent = page.waitForRequest((r) => r.url().includes('copy.closeCopiedPosition'));
  await close.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close', exact: true }).click();
  expect((await sent).postData() ?? '', 'the screen closed another position').toContain(position.positionId);
  await expect
    .poll(
      async () =>
        (await read(trader, 'copy.copiedPositions', { followId })).positions.find((p) => p.positionId === position.positionId)?.status,
      { timeout: 60_000 },
    )
    .toMatch(/^(closing|closed)$/);
});

test(`${J} #3 opens the algo order list from the same view: parents and children with progress`, async ({ page }) => {
  test.setTimeout(240_000);
  const trader = state('trader');
  const algoId = state('algoId');
  // The TWAP has placed at least one child on the book before the list is read.
  let parent;
  await expect
    .poll(
      async () => {
        parent = await read(trader, 'algo.get', { algoId });
        return parent.children?.length ?? 0;
      },
      { timeout: 150_000, message: 'the TWAP placed no child order' },
    )
    .toBeGreaterThan(0);
  await terminal(page, 'Algo orders');
  const parentRow = page
    .getByRole('grid', { name: 'Schedules' })
    .getByRole('row')
    .filter({ hasText: `Schedule ${algoId}` });
  await expect(parentRow).toContainText('BTC/USDT');
  await expect(parentRow).toContainText('TWAP');
  await expect(parentRow).toContainText(/\d+(\.\d+)?%/);
  await expect(parentRow).toContainText(new RegExp(`\\d+ / ${parent.slicesPlanned}`));
  await parentRow.click();
  const children = page.getByRole('table', { name: `Child orders and fills of ${algoId}` });
  const childIds = new Set((await read(trader, 'algo.get', { algoId })).children.map((c) => c.orderId));
  await expect(children.locator('tbody tr').first()).toBeVisible();
  const shown = await idsIn(children);
  expect(shown.length, 'no child order listed under its parent').toBeGreaterThan(0);
  for (const id of shown) expect(childIds, `row ${id} is not a child the service lists for ${algoId}`).toContain(id);
});

test(`${J} #4 opens the DOM tab: the preview card names the engine; the sample list is labelled "Preview · sample data" and TEST`, async ({
  page,
}) => {
  await terminal(page, 'DOM');
  const dom = page.getByRole('region', { name: 'Depth of market' });
  const card = dom.getByRole('note');
  await expect(card).toContainText('Preview');
  await expect(card).toContainText('Engine: CFD dealing and MetaTrader 5-class account server');
  await expect(card).toContainText('not connected');
  await expect(dom).toContainText('Preview · sample data');
  await expect(dom.getByText('TEST', { exact: true })).toBeVisible();
  const sample = dom.getByRole('table', { name: 'Preview · sample data' });
  const rows = sample.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  // Every sample level says it is a sample: none can pass for a live price.
  const n = await rows.count();
  for (let i = 0; i < n; i += 1) await expect(rows.nth(i)).toContainText('Sample');
});

test(`${J} #5 sees one tree of care, synthetic, algo, RFQ and routed orders with parent and children, ownership and exposure`, async ({
  page,
}) => {
  const trader = state('trader');
  const algoId = state('algoId');
  const service = await read(trader, 'algo.get', { algoId });
  await terminal(page, 'Order tree');
  const tree = page.getByRole('tree', { name: 'Orders' });
  // One branch for each kind of order, in one tree; a kind with nothing open says why, never a blank.
  for (const kind of ['Care orders', 'Synthetic orders', 'Algo orders', 'RFQ orders', 'Routed orders'])
    await expect(tree.getByRole('treeitem', { name: new RegExp(`^${kind}`) })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /^Care orders/ })).toContainText('that desk does not take orders');
  await expect(tree.getByRole('treeitem', { name: /^Routed orders/ })).toContainText('outside venues are not connected');
  // The algo order is a parent with its owner and its open exposure, and its children hang under it.
  const parent = tree.getByRole('treeitem', { name: new RegExp(algoId) });
  // The schedule runs 20 minutes, so it is still open here; an ended one would not be in a tree of open orders.
  expect(['active', 'paused', 'halted'], `the TWAP ${algoId} ended before the tree was read`).toContain(service.status);
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  await expect(parent).toContainText('Owner: you');
  await expect(parent).toContainText(/Exposure: [\d.,]+ USDT/);
  const children = parent.getByRole('group').getByRole('treeitem');
  // A slice can land while the tree is read, so the two are compared until they agree.
  await expect
    .poll(async () => (await children.count()) === (await read(trader, 'algo.get', { algoId })).children.length, { timeout: 30_000 })
    .toBe(true);
  expect(await children.count(), 'the algo parent lists no child').toBeGreaterThan(0);
  await parent.getByRole('button', { name: /Collapse/ }).click();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
});
