// World: book, market
import { test, expect } from './journey.mjs';
import { api, bestPrices, journeyState, toUnits, tool } from './stack.mjs';
import { awayBid, fundedTrader, openOrders, signIn } from './desk.mjs';
import { followOnScreen, leadFill, listLeader, takeBest } from './copy.mjs';
import { HOLD_MAX_MS } from '../../../../tooling/scripts/local-test-market.mjs';

// J-copy-bots-otc-30, in the running app (docs/roadmap/journeys.json): see my orders, positions, history and depth in one
// MetaTrader-style view at /trade/terminal. One test per step, titled "J-copy-bots-otc-30 #<n>", run in order. #1 makes the
// start: a verified TEST trader with TEST 2000 USDT, one resting order, one fill, a copied position (it follows a TEST
// leader the stack's TEST founder lists) and one algo order (a TWAP), all on the TEST book. Every row is checked against
// the books, read through the service as the trader.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #5: there is no unified order tree (care, synthetic, algo, RFQ and routed orders) in the terminal.
const J = 'J-copy-bots-otc-30';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const ONE = toUnits('1');
/**
 * The TEST maker's BTC/USDT quotes held where they rest, or quoted again (local-test-market.mjs hold, release). The copy
 * of the leader's buy is a resting limit at the leader's fill price, and the maker quotes post-only, so the copy fills
 * only while the ask the leader took from still rests. Its walk moves up to 12 bps every 8 s cycle; when it moved up
 * between the lead fill and the copy, that ask was gone and the copy rested unfilled, so #2 never saw an open copied
 * position (PR #7517's journeys run 42455921357, attempt 2: "the leader buy was never copied into an open position";
 * the same race J-copy-bots-otc-12 #1 holds the maker for). Held, the leader and the copy meet the same ask.
 */
const hold = () => tool('local-test-market.mjs', 'hold', 'BTC/USDT');
const release = () => tool('local-test-market.mjs', 'release', 'BTC/USDT');
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
  // Timed from before the ask, as the hold's own lapse is (it is asked, then waits for a cycle to pass).
  const heldAt = Date.now();
  hold();
  await leadFill(leader, 'buy', '0.001', `${J}-lead-${tag}`);
  // The copy fills while the maker is held: its position is open on the trader's book before the hold ends.
  let copied = [];
  await expect
    .poll(
      async () => {
        copied = (await read(trader, 'copy.copiedPositions', { followId })).positions;
        return copied.some((p) => p.status === 'open');
      },
      { timeout: 60_000, message: 'the leader buy was never copied into an open position while the maker was held' },
    )
    .toBe(true)
    .catch((err) => {
      err.message += `\ncopied positions last read: ${JSON.stringify(copied.map((p) => p.status))}`;
      throw err;
    });
  // The hold lapses HOLD_MAX_MS after it was asked for; the lead fill and its copy must both fall inside it, or the
  // maker's walk was back on and this proved nothing about the race it guards.
  expect(Date.now() - heldAt, 'the BTC/USDT hold lapsed before the copy was open').toBeLessThan(HOLD_MAX_MS);
  release();
  const { ask } = await bestPrices();
  const algo = await me.post('/api/trade/trpc/algo.createTwap', {
    symbol: 'BTC/USDT',
    side: 'buy',
    totalQty: '0.002',
    durationMs: 600_000,
    sliceIntervalMs: 60_000,
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

// Held for #1's lead fill and its copy only, passed or not: the next step's book is quoted again.
test.afterEach(() => {
  if (test.info().title.startsWith(`${J} #1 `)) release();
});

test(`${J} #2 opens a copied position: the follower position and its close action`, async ({ page }) => {
  test.setTimeout(180_000);
  const trader = state('trader');
  const followId = state('followId');
  // The copy of the leader's buy is open on the trader's own book before the view is opened.
  let position;
  let seen = [];
  await expect
    .poll(
      async () => {
        seen = (await read(trader, 'copy.copiedPositions', { followId })).positions;
        position = seen.find((p) => p.status === 'open');
        return Boolean(position);
      },
      { timeout: 60_000, message: 'the leader buy was never copied into an open position' },
    )
    .toBe(true)
    .catch((err) => {
      err.message += `\ncopied positions last read: ${JSON.stringify(seen.map((p) => p.status))}`;
      throw err;
    });
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
  await terminal(page, 'Order tree');
  const tree = page.getByRole('tree', { name: 'Orders' });
  const parent = tree.getByRole('treeitem', { name: new RegExp(state('algoId')) });
  await expect(parent).toHaveAttribute('aria-expanded', /true|false/);
  await expect(parent).toContainText(/Owner/);
  await expect(parent).toContainText(/Exposure/);
});
