// World: book
import { test, expect } from './journey.mjs';
import { api, bestPrices, fromUnits, journeyState, toUnits } from './stack.mjs';
import { awayBid, fundedTrader, openOrders, signIn } from './desk.mjs';
import { followOnScreen, leadFill, listLeader, takeBest } from './copy.mjs';

// J-copy-bots-otc-30, in the running app (docs/roadmap/journeys.json): see my orders, positions, history and depth in one
// MetaTrader-style view. One test per step, titled "J-copy-bots-otc-30 #<n>", run in order. #1 makes the start: a
// verified TEST trader with TEST 2000 USDT, one resting order, one fill, a copied position (it follows a TEST leader the
// stack's TEST founder lists) and one algo order, all on the TEST book. Every row is checked against the books.
// The view is the Terminal room at /trade/terminal: Orders, History, Positions, Algo orders, DOM and Order tree tabs.
const J = 'J-copy-bots-otc-30';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const OPENS = { timeout: 15_000 };
const ONE = toUnits('1');

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

async function terminal(page, tab) {
  await signIn(page, state('trader'));
  await page.goto('/trade/terminal');
  await expect(page.getByRole('tablist', { name: 'Terminal' })).toBeVisible(OPENS);
  // Exact: "Orders" is also part of "Algo orders".
  if (tab) await page.getByRole('tab', { name: tab, exact: true }).click();
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
  await followOnScreen(page, trader, leaderRef, { perOrder: '50', total: '200', fixed: '20' });
  await leadFill(leader, 'buy', '0.001', `${J}-lead-${tag}`);
  // A buy limit must sit at or over the ask (the slice price band): a whole number 1% over it. One slice an hour, so
  // the schedule stays running, with children, while the later steps read it.
  const { ask } = await bestPrices();
  const algo = await me.post('/api/trade/trpc/algo.createTwap', {
    symbol: 'BTC/USDT',
    side: 'buy',
    totalQty: '0.002',
    durationMs: 7_200_000,
    sliceIntervalMs: 3_600_000,
    limitPrice: fromUnits(((toUnits(ask) * 101n) / 100n / ONE + 1n) * ONE),
    clientAlgoId: `${J}-algo-${tag}`,
    kind: 'twap',
  });
  expect(algo.status, JSON.stringify(algo.body).slice(0, 300)).toBe(200);
  run.write({ algoId: algo.body.result.data.id });

  await terminal(page, 'Orders');
  const open = await openOrders(trader);
  expect(open.map((o) => o.id)).toContain(resting.body.id);
  const table = page.getByRole('table', { name: 'Open orders' });
  await expect(table.locator('tbody tr')).toHaveCount(open.length, OPENS);
  // Each open order on the book is one row, with the book's market and state.
  for (const order of open) {
    const row = table.locator('tbody tr').filter({ hasText: order.id });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(order.symbol);
    await expect(row).toContainText(Number(order.filled) > 0 ? 'Partly filled' : 'Open');
  }
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  const history = page.getByRole('table', { name: 'Order history' });
  // The IOC buy the book filled in full reads Filled, and its fill is listed beside it.
  const done = history.locator('tbody tr').filter({ hasText: filled.id });
  await expect(done.filter({ hasText: 'Filled' })).toHaveCount(1, OPENS);
  await expect(done.filter({ hasText: 'Fill' })).not.toHaveCount(0);
});

test(`${J} #2 opens a copied position: the follower position and its close action`, async ({ page }) => {
  await terminal(page, 'Positions');
  const row = page.getByRole('table', { name: 'Positions' }).locator('tbody tr').filter({ hasText: 'Copied' }).first();
  await expect(row).toContainText('BTC/USDT', OPENS);
  await expect(row).toContainText(state('leaderRef'));
  // The close action asks first and says what it sells; going back closes nothing.
  await row.getByRole('button', { name: 'Close', exact: true }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('Close this copied position?');
  await expect(ask).toContainText('BTC/USDT');
  await ask.getByRole('button', { name: 'Go back' }).click();
  await expect(ask).toBeHidden();
  await expect(row.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
});

test(`${J} #3 opens the algo order list from the same view: parents and children with progress`, async ({ page }) => {
  await terminal(page, 'Algo orders');
  const table = page.getByRole('table', { name: 'Algo orders' });
  const row = table.getByRole('row', { name: new RegExp(state('algoId')) });
  await expect(row).toContainText(/\d+%/, OPENS);
  await expect(row).toContainText('TWAP');
  // Its children (the slices it placed) are listed under it, each with its order.
  const algo = await (
    await api(state('trader'))
  ).get(`/api/trade/trpc/algo.get?input=${encodeURIComponent(JSON.stringify({ algoId: state('algoId') }))}`);
  expect(algo.status, JSON.stringify(algo.body).slice(0, 300)).toBe(200);
  const children = algo.body.result.data.children ?? [];
  expect(children.length).toBeGreaterThan(0);
  for (const child of children) await expect(table.getByRole('row', { name: new RegExp(child.orderId) })).toContainText('Slice');
});

test(`${J} #4 opens the DOM tab: the preview card names the engine; the sample list is labelled "Preview · sample data" and TEST`, async ({
  page,
}) => {
  await terminal(page, 'DOM');
  const dom = page.getByRole('region', { name: 'Depth of market' });
  await expect(dom).toContainText('Preview · sample data', OPENS);
  await expect(dom).toContainText(/Engine: \S+/);
  // Every row of the sample list carries TEST.
  const sample = dom.getByRole('table', { name: 'Preview · sample data' });
  const rows = sample.locator('tbody tr');
  await expect(rows).not.toHaveCount(0);
  for (const r of await rows.all()) await expect(r).toContainText('TEST');
});

test(`${J} #5 sees one tree of care, synthetic, algo, RFQ and routed orders with parent and children, ownership and exposure`, async ({
  page,
}) => {
  await terminal(page, 'Order tree');
  const tree = page.getByRole('tree', { name: 'Orders' });
  // One branch for each kind of order, each saying what it holds (an empty kind says why it is empty).
  for (const kind of ['Care orders', 'Synthetic orders', 'Algo orders', 'RFQ orders', 'Routed orders'])
    await expect(tree.getByRole('treeitem', { name: new RegExp(`^${kind}`) })).toBeVisible(OPENS);
  const parent = tree.getByRole('treeitem', { name: new RegExp(state('algoId')) });
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  await expect(parent).toContainText('Owner: you');
  await expect(parent).toContainText(/Exposure: [\d.,]+ USDT/);
  // Its children hang under it.
  await expect(parent.getByRole('group').getByRole('treeitem')).not.toHaveCount(0);
  await parent.getByRole('button', { name: /Collapse/ }).click();
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
});
