import { test, expect } from '@playwright/test';
import { api, journeyState } from './stack.mjs';
import { awayBid, fundedTrader, openOrders, signIn } from './desk.mjs';
import { followOnScreen, leadFill, listLeader, takeBest } from './copy.mjs';

// J-copy-bots-otc-30, in the running app (docs/roadmap/journeys.json): see my orders, positions, history and depth in one
// MetaTrader-style view. One test per step, titled "J-copy-bots-otc-30 #<n>", run in order. #1 makes the start: a
// verified TEST trader with TEST 2000 USDT, one resting order, one fill, a copied position (it follows a TEST leader the
// stack's TEST founder lists) and one algo order, all on the TEST book. Every row is checked against the books.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: there is no one-view terminal (positions and history, copied positions, algo list, DOM preview, order
//   tree) at /trade/terminal.
const J = 'J-copy-bots-otc-30';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

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
  await expect(page.getByRole('tablist', { name: 'Terminal' })).toBeVisible(UNBUILT);
  if (tab) await page.getByRole('tab', { name: tab }).click();
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
  await takeBest(trader, 'buy', '0.001', `${J}-fill-${tag}`);
  await signIn(page, trader);
  await followOnScreen(page, trader, leaderRef, { perOrder: '50', total: '200', fixed: '20' });
  await leadFill(leader, 'buy', '0.001', `${J}-lead-${tag}`);
  const algo = await me.post('/api/trade/trpc/algo.createTwap', {
    symbol: 'BTC/USDT',
    side: 'buy',
    totalQty: '0.002',
    durationMs: 600_000,
    sliceIntervalMs: 60_000,
    limitPrice: await awayBid(50),
    clientAlgoId: `${J}-algo-${tag}`,
    kind: 'twap',
  });
  // On the stack today svc-trade refuses every algo create (no TEST bots verification level is set): this names it.
  expect(algo.status, JSON.stringify(algo.body).slice(0, 300)).toBe(200);
  run.write({ algoId: algo.body.result.data.id });

  await terminal(page, 'Orders');
  const open = await openOrders(trader);
  const rows = page.getByRole('table', { name: 'Open orders' }).locator('tbody tr');
  await expect(rows).toHaveCount(open.length);
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('table', { name: 'Order history' }).locator('tbody tr').filter({ hasText: 'Filled' }).first()).toBeVisible();
});

test(`${J} #2 opens a copied position: the follower position and its close action`, async ({ page }) => {
  await terminal(page, 'Positions');
  const row = page.getByRole('table', { name: 'Positions' }).locator('tbody tr').filter({ hasText: 'Copied' }).first();
  await expect(row).toContainText('BTC/USDT');
  await expect(row.getByRole('button', { name: 'Close' })).toBeEnabled();
});

test(`${J} #3 opens the algo order list from the same view: parents and children with progress`, async ({ page }) => {
  await terminal(page, 'Algo orders');
  const row = page.getByRole('table', { name: 'Algo orders' }).getByRole('row', { name: new RegExp(state('algoId')) });
  await expect(row).toContainText(/\d+%/);
});

test(`${J} #4 opens the DOM tab: the preview card names the engine; the sample list is labelled "Preview · sample data" and TEST`, async ({
  page,
}) => {
  await terminal(page, 'DOM');
  const dom = page.getByRole('region', { name: 'Depth of market' });
  await expect(dom).toContainText('Preview · sample data');
  await expect(dom).toContainText('TEST');
  await expect(dom).toContainText(/Engine/);
});

test(`${J} #5 sees one tree of care, synthetic, algo, RFQ and routed orders with parent and children, ownership and exposure`, async ({
  page,
}) => {
  await terminal(page, 'Order tree');
  const tree = page.getByRole('tree', { name: 'Orders' });
  const parent = tree.getByRole('treeitem', { name: new RegExp(state('algoId')) });
  await expect(parent).toHaveAttribute('aria-expanded', /true|false/);
  await expect(parent).toContainText(/Owner/);
  await expect(parent).toContainText(/Exposure/);
});
