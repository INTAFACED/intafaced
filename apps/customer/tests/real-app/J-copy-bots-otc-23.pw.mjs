import { test, expect } from '@playwright/test';
import {
  EDGE,
  ORIGIN,
  api,
  bestPrices,
  fund,
  fromUnits,
  json,
  journeyState,
  otherTrader,
  signOutBrowser,
  times,
  tool,
  toUnits,
} from './stack.mjs';
import { free, fundedTrader, held, openOrders, signIn, signUp } from './desk.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-copy-bots-otc-23, in the running app (docs/roadmap/journeys.json): work a large order slowly with TWAP, chase or
// iceberg on /execution. One test per step, titled "J-copy-bots-otc-23 #<n>", run in order. The trader starts signed
// in, verified and funded with TEST USDT; every child order goes to the real TEST book, and the parent's progress is
// read back from the service.
// #5 and #7 build their own book on the unquoted TEST market IFC/USDC, where the other trader moves the price.
// #8 stops the stack's matching engine for a moment (local-test-stack.mjs stop matching), so a child cancel fails the
// way it would with the engine unreachable, and restarts it before the step ends.
const J = 'J-copy-bots-otc-23';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
/** The TEST spot market the market maker never quotes (seed-spot-test-listing.mjs `UNQUOTED_TEST_SPOT`). */
const UNQUOTED = 'IFC/USDC';

test.describe.configure({ mode: 'default' });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const TABS = ['Algo orders', 'Iceberg', 'Scaled', 'Child orders and fills', 'Routing'];
const schedules = (page) => page.getByRole('grid', { name: 'Schedules' });
const detail = (page) => page.getByRole('region', { name: 'Schedule detail' });
const form = (page) => page.getByRole('region', { name: 'New schedule' });

/** Opens a list and chooses the option whose name starts with `option` (a kind's name carries its one-line meaning). */
async function pick(page, label, option) {
  await page.getByRole('combobox', { name: label, exact: true }).click(UNBUILT);
  const leading = new RegExp(`^${option.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?:,|$)`);
  await page.getByRole('option', { name: leading }).click(UNBUILT);
}

/** Fills the schedule form: `market` (BTC/USDT), `side`, `kind`, `total` base over `seconds`, a slice every `every` seconds. */
async function fillSchedule(page, { market = 'BTC/USDT', side = 'Buy', kind = 'TWAP', total, seconds, every }) {
  const box = form(page);
  await pick(page, 'Market', market);
  await box.getByRole('button', { name: side, exact: true }).click(UNBUILT);
  await pick(page, 'Kind', kind);
  await box.getByLabel(`Total size (${market.split('/')[0]})`).fill(total);
  await pick(page, 'Duration', 'Custom');
  await box.getByLabel('Custom duration, in seconds').fill(String(seconds));
  await box.getByLabel('Slice interval, in seconds').fill(String(every));
}

/** Review, confirm, and return the new parent id the room reports. */
async function confirmSchedule(page) {
  const created = page.waitForResponse((res) => res.url().includes('algo.createTwap') && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Review schedule' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Create schedule' }).click();
  const answer = await created;
  expect(answer.status(), (await answer.text()).slice(0, 300)).toBe(200);
  const id = (await answer.json())?.result?.data?.id;
  expect(id).toBeTruthy();
  return id;
}

/** The parent as the service reports it now. */
async function parentOf(who, algoId) {
  const { status, body } = await (await api(who)).get(`/api/trade/trpc/algo.get?input=${encodeURIComponent(JSON.stringify({ algoId }))}`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

test(`${J} #1 opens Execution: five tabs render, and a blocked tab names its dependency`, async ({ page }) => {
  // Signing up, verifying and funding takes most of a minute.
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jex', '2000');
  run.reset({ trader, tag: Date.now().toString(36) });
  await signIn(page, trader);
  await page.goto('/execution');
  await expect(page.getByRole('heading', { name: 'Execution', level: 1 })).toBeVisible();
  const tabs = page.getByRole('tablist', { name: 'Execution sections' });
  for (const name of TABS) await expect(tabs.getByRole('tab', { name, exact: true })).toBeVisible();

  // The stack runs the slice scheduler, so the algo form is open; Routing is blocked and says on what.
  await expect(page.getByText('Scheduler running')).toBeVisible();
  await tabs.getByRole('tab', { name: 'Routing', exact: true }).click();
  const caps = tableIn(page, 'Capabilities');
  await expect(caps.getByText('Blocked').first()).toBeVisible();
  await expect(caps.getByText(/venue submit port/).first()).toBeVisible();
});

/** The service's typed refusal code, from a tRPC error body. */
const codeOf = (body) => body?.error?.data?.cause?.code;

/** The account's schedules as the service lists them. */
async function algoRows(who) {
  const { status, body } = await (
    await api(who)
  ).get(`/api/trade/trpc/algo.list?input=${encodeURIComponent(JSON.stringify({ limit: 20 }))}`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data.rows;
}

/** USDT and BTC on the ledger, free and held, so a refusal can show nothing moved or was held. */
async function funds(who) {
  const balances = await (await api(who)).balances();
  return Object.fromEntries(['USDT', 'BTC'].map((asset) => [asset, { free: free(balances, asset), held: held(balances, asset) }]));
}

/** Restarts trade with the slice scheduler off (or back on), as the stack's TEST switch sets it. */
function algoJobs(on) {
  const before = process.env.LOCAL_STACK_TRADE_ALGO_JOBS;
  if (on) delete process.env.LOCAL_STACK_TRADE_ALGO_JOBS;
  else process.env.LOCAL_STACK_TRADE_ALGO_JOBS = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_TRADE_ALGO_JOBS;
    else process.env.LOCAL_STACK_TRADE_ALGO_JOBS = before;
  }
}

test(`${J} #2 creates a TWAP below the owner's tier: refused as tier insufficient, and no parent row is written`, async ({ page }) => {
  test.setTimeout(300_000);
  // Verified at basic, funded; the TEST bot verification level is full.
  const basic = await signUp(page, 'jeb');
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: 'Basic' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  tool('local-test-gates.mjs', 'verify');
  fund(basic.email, 'USDT', '1000');
  await signOutBrowser(page.context());
  await signIn(page, basic);
  const basicBefore = await funds(basic);
  await page.goto('/execution');
  await fillSchedule(page, { total: '0.002', seconds: 120, every: 30 });
  const answer = page.waitForResponse((res) => res.url().includes('algo.createTwap'));
  await page.getByRole('button', { name: 'Review schedule' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Create schedule' }).click();
  const refused = await answer;
  expect(refused.status()).toBe(403);
  expect(codeOf(await refused.json())).toBe('trade.bots_verification_insufficient');
  await expect(page.getByText('trade.bots_verification_insufficient', { exact: true })).toBeVisible();

  // Nothing was written or held: the service lists no schedule for this account, and the ledger is as it was.
  expect(await algoRows(basic)).toHaveLength(0);
  expect(await funds(basic)).toEqual(basicBefore);

  // With the slice scheduler off, the same create is refused before a row is written: a schedule would sit and place
  // nothing. The trader from #1 is verified at the bot level, so only the scheduler stands in the way.
  const trader = state('trader');
  const rowsBefore = (await algoRows(trader)).map((row) => row.id);
  const traderBefore = await funds(trader);
  algoJobs(false);
  try {
    await signOutBrowser(page.context());
    await signIn(page, trader);
    await page.goto('/execution');
    await expect(page.getByText('Scheduler off: new schedules will not slice')).toBeVisible();
    await fillSchedule(page, { total: '0.002', seconds: 120, every: 30 });
    await expect(form(page).locator('[data-code="trade.algo_jobs_disabled"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review schedule' })).toBeDisabled();

    // The service refuses the create itself, not only the form.
    const { status, body } = await (
      await api(trader)
    ).post('/api/trade/trpc/algo.createTwap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      totalQty: '0.002',
      durationMs: 120_000,
      sliceIntervalMs: 30_000,
      clientAlgoId: `j23-jobs-off-${state('tag')}`,
    });
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(400);
    expect(codeOf(body)).toBe('trade.algo_jobs_disabled');
    expect((await algoRows(trader)).map((row) => row.id)).toEqual(rowsBefore);
    expect(await funds(trader)).toEqual(traderBefore);
  } finally {
    algoJobs(true);
  }
});

test(`${J} #3 creates a TWAP with random size on, a fixed seed and a trigger price: slice sizes sum to the total to the decimal, a restart gives the same sizes, and the parent waits for the trigger`, async ({
  page,
}) => {
  // It watches one whole slice interval pass while the schedule waits, then restarts the trade service.
  test.setTimeout(180_000);
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/execution');
  await fillSchedule(page, { total: '0.003', seconds: 300, every: 30 });
  const box = form(page);
  await box.getByRole('checkbox', { name: 'Random slice sizes' }).check({ timeout: 5_000 });
  await box.getByLabel('Seed').fill('2310');
  // A buy trigger far above the book: the schedule waits for the price to reach it.
  const { ask } = await bestPrices();
  const trigger = String((toUnits(ask) * 2n) / toUnits('1'));
  await box.getByLabel('Start when the price reaches').fill(trigger);

  await page.getByRole('button', { name: 'Review schedule' }).click();
  const sizes = await page.getByRole('alertdialog').getByRole('list', { name: 'Slice sizes' }).getByRole('listitem').allInnerTexts();
  expect(sizes.length).toBe(10);
  const sum = sizes.reduce((acc, s) => acc + toUnits(s.replace(/[^\d.]/g, '')), 0n);
  expect(sum).toBe(toUnits('0.003'));
  const created = page.waitForResponse((res) => res.url().includes('algo.createTwap'));
  await page.getByRole('alertdialog').getByRole('button', { name: 'Create schedule' }).click();
  const id = (await (await created).json())?.result?.data?.id;
  expect(id).toBeTruthy();

  // The service keeps the planned sizes on the parent, so a restart re-plans nothing: they are the preview's.
  const parent = await parentOf(trader, id);
  expect(parent.plannedSliceQtys.map((q) => toUnits(q))).toEqual(sizes.map((s) => toUnits(s.replace(/[^\d.]/g, ''))));
  expect(parent.triggerPrice).toBe(trigger);
  await expect(detail(page).getByText('Waiting for the trigger price')).toBeVisible();
  expect(parent.children).toHaveLength(0);
  // Random: the sizes are not all the same.
  expect(new Set(sizes).size).toBeGreaterThan(1);

  // The same seed gives the same sizes; another seed gives other sizes.
  const preview = async (randomSeed) => {
    const input = { symbol: 'BTC/USDT', totalQty: '0.003', durationMs: 300_000, sliceIntervalMs: 30_000, randomSeed };
    const { status, body } = await (
      await api(trader)
    ).get(`/api/trade/trpc/algo.previewTwapSizes?input=${encodeURIComponent(JSON.stringify(input))}`);
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
    return body.result.data.sliceQtys.map((q) => toUnits(q));
  };
  expect(await preview(2310)).toEqual(parent.plannedSliceQtys.map((q) => toUnits(q)));
  expect(await preview(2311)).not.toEqual(parent.plannedSliceQtys.map((q) => toUnits(q)));

  // It waits: after more than one slice interval it is still active, awaiting the trigger, with no slice placed or missed.
  await page.waitForTimeout(31_000);
  const later = await parentOf(trader, id);
  expect(later.status).toBe('active');
  expect(later.awaitingTrigger).toBe(true);
  expect(later.triggeredAt).toBeNull();
  expect(later.children).toHaveLength(0);
  expect(later.misses).toHaveLength(0);
  await expect(detail(page).getByText('Waiting for the trigger price')).toBeVisible();

  // A restart of the trade service gives the same sizes, and the schedule still waits.
  tool('local-test-stack.mjs', 'restart', 'trade');
  const restarted = await parentOf(trader, id);
  expect(restarted.plannedSliceQtys.map((q) => toUnits(q))).toEqual(sizes.map((s) => toUnits(s.replace(/[^\d.]/g, ''))));
  expect(await preview(2310)).toEqual(sizes.map((s) => toUnits(s.replace(/[^\d.]/g, ''))));
  expect(restarted.status).toBe('active');
  expect(restarted.awaitingTrigger).toBe(true);
  expect(restarted.children).toHaveLength(0);
  run.write({ triggered: id });
});

/** Every slice the service recorded (placed children and misses), as times in ms, oldest first. */
const sliceTimes = (parent) => [...parent.children, ...parent.misses].map((slice) => Date.parse(slice.time)).sort((a, b) => a - b);

test(`${J} #4 reviews, confirms and watches a TWAP run: partial fills; pause stops new children, resume re-spaces overdue slices`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/execution');
  await fillSchedule(page, { total: '0.002', seconds: 120, every: 15 });
  const id = await confirmSchedule(page);
  run.write({ running: id });

  // A child goes to the book and fills: the parent is active with part, not all, of its total filled.
  await expect.poll(async () => toUnits((await parentOf(trader, id)).filledQty ?? '0'), { timeout: 60_000 }).toBeGreaterThan(0n);
  const partial = await parentOf(trader, id);
  expect(partial.status).toBe('active');
  expect(partial.totalQty).toBe('0.002');
  expect(toUnits(partial.filledQty)).toBeGreaterThan(0n);
  expect(toUnits(partial.filledQty)).toBeLessThan(toUnits(partial.totalQty));
  const list = schedules(page);
  // The list holds every schedule the service keeps for the account; this one's row says Active.
  await expect(list.getByRole('row', { name: new RegExp(id) }).getByText('Active', { exact: true })).toBeVisible();

  await list.getByRole('button', { name: `Pause ${id}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Pause schedule' }).click();
  await expect(list.getByRole('button', { name: `Resume ${id}` })).toBeVisible({ timeout: 10_000 });
  const paused = await parentOf(trader, id);
  expect(paused.status).toBe('paused');
  // Two intervals pass with no new child and no missed slice.
  await page.waitForTimeout(31_000);
  const stillPaused = await parentOf(trader, id);
  expect(stillPaused.children).toEqual(paused.children);
  expect(stillPaused.misses).toEqual(paused.misses);

  const resumed = page.waitForResponse((res) => res.url().includes('algo.resume') && res.request().method() === 'POST');
  await list.getByRole('button', { name: `Resume ${id}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Resume schedule' }).click();
  const answer = await resumed;
  expect(answer.status(), (await answer.text()).slice(0, 300)).toBe(200);
  const back = (await answer.json()).result.data;
  await expect(list.getByRole('button', { name: `Pause ${id}` })).toBeVisible({ timeout: 10_000 });

  // The service re-spaced from the resume instant: the remaining slices run one interval apart from now, so the end
  // moved later than it stood before the pause, and the reason is the pause.
  const resumedAt = Date.parse(back.nextDueAt);
  const remaining = back.slicesPlanned - back.nextSliceIndex;
  expect(back.status).toBe('active');
  expect(back.scheduleStretchReason).toBe('user_pause');
  expect(back.nextSliceIndex).toBe(paused.nextSliceIndex);
  expect(Date.parse(back.projectedEndsAt)).toBe(resumedAt + remaining * back.sliceIntervalMs);
  expect(Date.parse(back.projectedEndsAt)).toBeGreaterThan(Date.parse(paused.projectedEndsAt));
  await expect(detail(page).getByText(/The schedule was paused, so its end moved later/)).toBeVisible({ timeout: 15_000 });

  // No burst: the overdue slices are not caught up at once. Every slice the parent has recorded, before and after the
  // pause, unfiltered, is at least one interval after the one before it, and the count after resume is no more than
  // one interval's worth of time allows.
  const atPause = sliceTimes(stillPaused);
  await expect
    .poll(async () => sliceTimes(await parentOf(trader, id)).length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(atPause.length + 2);
  const final = await parentOf(trader, id);
  const readAt = Date.now();
  const all = sliceTimes(final);
  expect(all.slice(0, atPause.length)).toEqual(atPause);
  const sinceResume = all.slice(atPause.length);
  // Still running (or run out), not halted after the resume.
  expect(['active', 'completed']).toContain(final.status);
  expect(sinceResume.length).toBeLessThanOrEqual(Math.floor((readAt - resumedAt) / back.sliceIntervalMs) + 1);
  expect(sinceResume[0]).toBeGreaterThanOrEqual(resumedAt);
  for (let i = 1; i < all.length; i++) expect(all[i] - all[i - 1]).toBeGreaterThanOrEqual(back.sliceIntervalMs);
});

/** The chase's form: Chase on IFC/USDC, `side`, `total` over `seconds`, and the maximum distance as typed (blank allowed). */
async function fillChase(page, { side = 'Buy', total, seconds, distance }) {
  const box = form(page);
  await pick(page, 'Market', UNQUOTED);
  await box.getByRole('button', { name: side, exact: true }).click(UNBUILT);
  await pick(page, 'Kind', 'Chase');
  await box.getByLabel('Total size (IFC)').fill(total);
  await pick(page, 'Duration', 'Custom');
  await box.getByLabel('Custom duration, in seconds').fill(String(seconds));
  await box.getByLabel('Maximum chase distance, %').fill(distance);
}

/** The value cell of one line of the schedule detail, found by its label. */
const detailValue = (page, label) =>
  detail(page)
    .locator('[data-slot="key-value-row"]')
    .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
    .locator('dd');

/** A child order as the trader's own order read reports it. */
/** The order ids of a schedule's cancel execution reports from the service, oldest first, one entry per report. */
async function cancelReports(who, algoId) {
  const { status, body } = await (
    await api(who)
  ).get(`/api/trade/trpc/algo.reports?input=${encodeURIComponent(JSON.stringify({ algoId, limit: 100 }))}`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  expect(body.result.data.nextCursor).toBeNull();
  return body.result.data.rows.filter((r) => r.kind === 'cancel').map((r) => r.orderId);
}

/** Waits `ms` while the scheduler ticks (about once a second), so a chase that would act has had many chances to. */
const ticks = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(`${J} #5 places a chase limit order with a maximum distance: it re-prices once per book move without passing the distance; beyond it the chase stops with that reason and cancels once; a blank distance refuses`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const trader = state('trader');
  const tag = state('tag');
  const maker = otherTrader();
  const other = await api(maker);
  expect(fund(maker.email, 'USDC', '1000').tx).toBeTruthy();
  expect(fund(maker.email, 'IFC', '1000').tx).toBeTruthy();
  expect(fund(trader.email, 'USDC', '100').tx).toBeTruthy();
  await clearIfc(maker);
  await clearIfc(trader);
  // A run stopped before its clean-up can leave an earlier trader's orders resting, which no account here can cancel: the
  // other trader trades them out, then cancels what of its own orders is left, so both sides start empty.
  for (const [levels, side] of [
    [(await ifcBook()).asks, 'buy'],
    [(await ifcBook()).bids, 'sell'],
  ]) {
    if (levels.length === 0) continue;
    const size = levels.reduce((sum, [, qty]) => sum + toUnits(qty), 0n);
    const sweep = await other.post('/api/v1/orders', {
      symbol: UNQUOTED,
      type: 'limit',
      side,
      amount: fromUnits(size),
      price: levels.at(-1)[0],
      clientOrderId: `${J}-5-sweep-${side}-${tag}`,
    });
    // Set-up, not a clause: a refused sweep stops the step here rather than asserting under a condition.
    if (sweep.status >= 300) throw new Error(`sweeping a stale IFC/USDC ${side} was refused: ${JSON.stringify(sweep.body).slice(0, 300)}`);
    await clearIfc(maker);
  }
  const empty = await ifcBook();
  expect([empty.bids, empty.asks]).toEqual([[], []]);

  // The other trader rests the best bid the chase will join, and a far ask so the market has a two-sided mark (a schedule
  // is refused without one). The ask at 2.00 stays above every price the chase may reach.
  const rest = async (price, amount, n, side = 'buy') => {
    const res = await other.post('/api/v1/orders', {
      symbol: UNQUOTED,
      type: 'limit',
      side,
      amount,
      price,
      clientOrderId: `${J}-5-${side}${n}-${tag}`,
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
  };
  await rest('0.99', '10', 0);
  await rest('2.00', '1', 0, 'sell');

  // A blank distance refuses: in the room the field names the refusal and Review stays off; the service refuses the same
  // request with its typed code. No schedule is written and nothing is held.
  const rowsBefore = (await algoRows(trader)).map((row) => row.id);
  // The list read is the trader's whole set (fewer rows than the page holds), so a row written by the refusal would show.
  expect(rowsBefore.length).toBeLessThan(20);
  const before = await (await api(trader)).balances();
  await signIn(page, trader);
  await page.goto('/execution');
  const creates = [];
  const countCreate = (req) => {
    if (req.url().includes('algo.createTwap')) creates.push(req.url());
  };
  page.on('request', countCreate);
  await fillChase(page, { total: '5', seconds: 600, distance: '' });
  await expect(form(page).getByText('Enter a maximum chase distance, from 0.01 to 100 percent.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review schedule' })).toBeDisabled();
  // The room sends nothing while the distance is blank.
  expect(creates).toEqual([]);
  page.off('request', countCreate);
  const blank = await (
    await api(trader)
  ).post('/api/trade/trpc/algo.createTwap', {
    symbol: UNQUOTED,
    side: 'buy',
    totalQty: '5',
    durationMs: 600_000,
    sliceIntervalMs: 600_000,
    kind: 'chase',
    clientAlgoId: `j23-chase-blank-${tag}`,
  });
  expect(blank.status).toBe(400);
  expect(codeOf(blank.body)).toBe('trade.algo_chase_distance_required');
  expect((await algoRows(trader)).map((row) => row.id)).toEqual(rowsBefore);
  const after = await (await api(trader)).balances();
  expect(free(after, 'USDC')).toBe(free(before, 'USDC'));
  expect(held(after, 'USDC')).toBe(held(before, 'USDC'));

  // A chase buy with a 2% distance joins the best bid, 0.99; it may follow the bid up to 0.99 × 1.02 = 1.0098.
  await form(page).getByLabel('Maximum chase distance, %').fill('2');
  const id = await confirmSchedule(page);
  try {
    const created = await parentOf(trader, id);
    expect(created.kind).toBe('chase');
    expect(created.chaseMaxDistanceBps).toBe(200);
    expect(toUnits(created.chaseStartPrice)).toBe(toUnits('0.99'));
    await expect.poll(async () => (await parentOf(trader, id)).children.length, { timeout: 30_000 }).toBe(1);
    const joined = (await parentOf(trader, id)).children[0];
    expect(toUnits(joined.price)).toBe(toUnits('0.99'));
    const joinedOrder = await orderOf(trader, joined.orderId);
    expect([joinedOrder.type, joinedOrder.status, toUnits(joinedOrder.price)]).toEqual(['limit', 'open', toUnits('0.99')]);

    // No book move, no re-price: many ticks later it is still the one order.
    await ticks(8_000);
    expect((await parentOf(trader, id)).children).toHaveLength(1);

    // Each book move inside the distance is one re-price: the chase cancels its order once and rests the rest as a limit
    // order at the new best, then stays there while the book holds still. The last move lands exactly on the distance.
    const moves = ['1.00', '1.005', '1.0098'];
    for (const [n, price] of moves.entries()) {
      await rest(price, '1', n + 1);
      await expect.poll(async () => (await parentOf(trader, id)).children.length, { timeout: 30_000 }).toBe(n + 2);
      await ticks(6_000);
      const moved = await parentOf(trader, id);
      expect(moved.children).toHaveLength(n + 2);
      expect(moved.chaseReprices).toBe(n + 1);
      expect(moved.status).toBe('active');
      expect(moved.children.map((c) => toUnits(c.price))).toEqual(['0.99', ...moves.slice(0, n + 1)].map(toUnits));
      const newest = await orderOf(trader, moved.children.at(-1).orderId);
      expect([newest.type, newest.status, toUnits(newest.price)]).toEqual(['limit', 'open', toUnits(price)]);
      for (const c of moved.children.slice(0, -1)) expect((await orderOf(trader, c.orderId)).status).toBe('canceled');
      expect((await openOrders(trader, UNQUOTED)).map((o) => o.id)).toEqual([moved.children.at(-1).orderId]);
      // Cancelled once: the service's execution reports hold one cancel for each replaced child and none for the new one.
      expect(await cancelReports(trader, id)).toEqual(moved.children.slice(0, -1).map((c) => c.orderId));
    }
    // Never past the distance: 0.99 × 1.02 = 1.0098 is the furthest any child rests.
    const atCap = await parentOf(trader, id);
    expect(atCap.children).toHaveLength(moves.length + 1);
    for (const c of atCap.children) expect(toUnits(c.price)).toBeLessThanOrEqual(toUnits('1.0098'));
    // The detail reads the same numbers back.
    await expect(detailValue(page, 'Start price')).toHaveText(/^0\.990*$/, { timeout: 15_000 });
    await expect(detailValue(page, 'Current price')).toHaveText(/^1\.00980*$/, { timeout: 15_000 });
    await expect(detailValue(page, 'Re-prices')).toHaveText('3');

    // A move past the distance by one tick: the bid goes to 1.0099. The chase stops with that reason, cancels its order
    // once, and places nothing more however long it is left.
    await rest('1.0099', '1', moves.length + 1);
    await expect.poll(async () => (await parentOf(trader, id)).status, { timeout: 30_000 }).toBe('halted');
    await ticks(8_000);
    const stopped = await parentOf(trader, id);
    expect(stopped.haltReason).toBe('chase_max_distance');
    expect(stopped.children.map((c) => c.orderId)).toEqual(atCap.children.map((c) => c.orderId));
    expect(stopped.chaseReprices).toBe(3);
    for (const c of stopped.children) expect((await orderOf(trader, c.orderId)).status).toBe('canceled');
    // The stop cancelled its resting order once: every child has exactly one cancel report, in the order they were placed.
    expect(await cancelReports(trader, id)).toEqual(stopped.children.map((c) => c.orderId));
    expect(await openOrders(trader, UNQUOTED)).toEqual([]);
    await expect(detailValue(page, 'Halt reason')).toContainText('Maximum chase distance reached', { timeout: 15_000 });
  } finally {
    await (await api(trader)).post('/api/trade/trpc/algo.cancel', { algoId: id });
    await clearIfc(maker);
    await clearIfc(trader);
  }
});

/** The order as the service reports it now. */
async function orderOf(who, id) {
  const { status, body } = await (await api(who)).get(`/api/v1/orders/${id}`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}

/** Size resting at exactly `price` on the BTC/USDT bid side, in units (0 when no level is there). */
async function bidAt(price) {
  const { body } = await bestPrices('BTC/USDT', 200);
  const level = body.bids.find(([p]) => toUnits(p) === toUnits(price));
  return level ? toUnits(level[1]) : 0n;
}

test(`${J} #6 places an iceberg with the display quantity equal to the total: refused; a valid iceberg rests with the displayed quantity and refills; a second iceberg on the symbol is refused; the live door shows the venue-submit notice`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const trader = state('trader');
  const me = await api(trader);
  const tag = `${state('tag')}-6-${Date.now().toString(36)}`;
  const { bid, ask } = await bestPrices();
  // A whole-USDT buy a quarter of the way into the spread: the best bid, so a sell reaches it, far from the ask.
  const one = toUnits('1');
  const price = fromUnits(((toUnits(bid) + (toUnits(ask) - toUnits(bid)) / 4n) / one) * one);
  expect(toUnits(price)).toBeGreaterThan(toUnits(bid));
  expect(toUnits(price)).toBeLessThan(toUnits(ask));
  const iceberg = (clientOrderId, displayQty) =>
    me.post('/api/v1/orders', {
      symbol: 'BTC/USDT',
      type: 'limit',
      side: 'buy',
      amount: '0.003',
      price,
      timeInForce: 'GTC',
      clientOrderId,
      displayQty,
    });

  // Display equal to the total: the service refuses it by code, and nothing rests or is held.
  const before = { open: await openOrders(trader), funds: await funds(trader) };
  const equal = await iceberg(`${tag}-equal`, '0.003');
  expect(equal.status, JSON.stringify(equal.body).slice(0, 300)).toBe(400);
  expect(equal.body.intafacedCode).toBe('trade.iceberg_display_invalid');
  expect((await openOrders(trader)).map((o) => o.id)).toEqual(before.open.map((o) => o.id));
  expect(await funds(trader)).toEqual(before.funds);

  // The room refuses the same numbers before sending anything.
  await signIn(page, trader);
  await page.goto('/execution');
  await page.getByRole('tablist', { name: 'Execution sections' }).getByRole('tab', { name: 'Iceberg', exact: true }).click();
  const box = page.getByRole('region', { name: 'New iceberg' });
  await box.getByRole('combobox', { name: 'Market', exact: true }).click();
  await page.getByRole('option', { name: /^BTC\/USDT(?:,|$)/ }).click();
  await box.getByLabel('Total size (BTC)').fill('0.003');
  await box.getByLabel('Display size (BTC)').fill('0.003');
  await box.getByLabel('Limit price').fill(price);
  await expect(box.getByText('The display size must be smaller than the total.')).toBeVisible();
  await expect(box.getByRole('button', { name: 'Review iceberg' })).toBeDisabled();

  // A valid iceberg, placed from the room: the book shows only the display, the hold is the whole order.
  await box.getByLabel('Display size (BTC)').fill('0.001');
  const placed = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/orders' && res.request().method() === 'POST');
  await box.getByRole('button', { name: 'Review iceberg' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Place iceberg' }).click();
  const answer = await placed;
  expect(answer.status(), (await answer.text()).slice(0, 300)).toBe(201);
  const order = await answer.json();
  expect(order.displayQty).toBe('0.001');
  await expect(box.getByText('Iceberg placed. It rests on the house order book.')).toBeVisible();
  const other = await api(otherTrader());
  try {
    expect(await bidAt(price)).toBe(toUnits('0.001'));
    const rested = await funds(trader);
    expect(rested.USDT.held - before.funds.USDT.held).toBe(times(price, '0.003'));

    // A second iceberg on the symbol is refused by code; nothing more rests or is held.
    await box.getByRole('button', { name: 'Review iceberg' }).click();
    const second = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/orders' && res.request().method() === 'POST');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Place iceberg' }).click();
    expect((await second).status()).toBe(409);
    await expect(box.getByText('trade.iceberg_symbol_cap', { exact: true })).toBeVisible();
    expect((await openOrders(trader)).map((o) => o.id).sort()).toEqual([...before.open.map((o) => o.id), order.id].sort());
    expect(await funds(trader)).toEqual(rested);

    // Refill: another trader sells exactly the display into it. One display fills, and the same size shows again.
    const { body: book } = await bestPrices('BTC/USDT', 200);
    const ahead = book.bids.filter(([p]) => toUnits(p) > toUnits(price)).reduce((sum, [, size]) => sum + toUnits(size), 0n);
    expect(ahead).toBe(0n);
    const sell = await other.post('/api/v1/orders', {
      symbol: 'BTC/USDT',
      type: 'limit',
      side: 'sell',
      amount: '0.001',
      price,
      timeInForce: 'IOC',
      clientOrderId: `${tag}-sell`,
    });
    expect(sell.status, JSON.stringify(sell.body).slice(0, 300)).toBeLessThan(300);
    await expect.poll(async () => (await orderOf(trader, order.id)).filled, { timeout: 15_000 }).toBe('0.001');
    const after = await orderOf(trader, order.id);
    expect(after.status).toBe('open');
    expect(after.remaining).toBe('0.002');
    await expect.poll(() => bidAt(price), { timeout: 15_000 }).toBe(toUnits('0.001'));

    // The live venue door stays off while its port is unset, and says so.
    await expect(box.getByRole('button', { name: 'Send to a live venue' })).toBeDisabled();
    await expect(
      box.getByText('Sending an iceberg to a live venue needs an authorised venue submit port. It is switched off in this build.'),
    ).toBeVisible();
  } finally {
    await me.delete(`/api/v1/orders/${order.id}`);
  }
});

/** IFC/USDC's book as the public depth route reports it: `[price, size]` levels a side. */
async function ifcBook() {
  const { status, body } = await fetch(`${EDGE}/api/v1/orderbook/${encodeURIComponent(UNQUOTED)}?limit=50`, {
    headers: { origin: ORIGIN },
  }).then(json);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}

/** Cancels every open order `who` has on IFC/USDC, so the book holds only what this step rests. */
async function clearIfc(who) {
  const client = await api(who);
  for (const order of await openOrders(who, UNQUOTED)) {
    const { status } = await client.delete(`/api/v1/orders/${order.id}?symbol=${encodeURIComponent(UNQUOTED)}`);
    expect(status).toBeLessThan(300);
  }
}

test(`${J} #7 chooses POV with opposite-side liquidity on an empty opposite book: refused as volume immature; participation is applied to the book size`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const trader = state('trader');
  const tag = state('tag');
  const maker = otherTrader();
  const other = await api(maker);
  expect(fund(maker.email, 'USDC', '1000').tx).toBeTruthy();
  expect(fund(maker.email, 'IFC', '1000').tx).toBeTruthy();
  expect(fund(trader.email, 'USDC', '100').tx).toBeTruthy();
  expect(fund(trader.email, 'IFC', '100').tx).toBeTruthy();
  await clearIfc(maker);
  await clearIfc(trader);
  // A run stopped before its clean-up can leave an earlier trader's sell resting, which no account here can cancel: the
  // other trader buys it out, then cancels what of that buy is left, so the ask side starts empty.
  const leftover = (await ifcBook()).asks;
  if (leftover.length > 0) {
    const size = leftover.reduce((sum, [, qty]) => sum + toUnits(qty), 0n);
    const sweep = await other.post('/api/v1/orders', {
      symbol: UNQUOTED,
      type: 'limit',
      side: 'buy',
      amount: fromUnits(size),
      price: leftover.at(-1)[0],
      clientOrderId: `${J}-7-sweep-${tag}`,
    });
    // Set-up, not a clause: a refused sweep stops the step here rather than asserting under a condition.
    if (sweep.status >= 300) throw new Error(`sweeping a stale IFC/USDC ask was refused: ${JSON.stringify(sweep.body).slice(0, 300)}`);
    await clearIfc(maker);
  }

  // The other trader rests one bid on IFC/USDC, which the market maker never quotes: the book has bids and no asks.
  const bid = await other.post('/api/v1/orders', {
    symbol: UNQUOTED,
    type: 'limit',
    side: 'buy',
    amount: '40',
    price: '0.99',
    clientOrderId: `${J}-7-bid-${tag}`,
  });
  expect(bid.status, JSON.stringify(bid.body).slice(0, 300)).toBeLessThan(300);
  const oneSided = await ifcBook();
  expect(oneSided.asks).toEqual([]);
  expect(oneSided.bids.map(([price, size]) => [toUnits(price), toUnits(size)])).toEqual([[toUnits('0.99'), toUnits('40')]]);

  // A POV buy on opposite-side liquidity: the side it would take from (asks) is empty, so the service refuses it as
  // volume immature, and nothing is written or held.
  const rowsBefore = (await algoRows(trader)).map((row) => row.id);
  const before = await (await api(trader)).balances();
  await signIn(page, trader);
  await page.goto('/execution');
  await fillSchedule(page, { market: UNQUOTED, kind: 'POV', total: '10', seconds: 120, every: 15 });
  await pick(page, 'Participation basis', 'Opposite-side liquidity');
  await form(page).getByLabel('Participation, in basis points').fill('1000');
  const answer = page.waitForResponse((res) => res.url().includes('algo.createTwap'));
  await page.getByRole('button', { name: 'Review schedule' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Create schedule' }).click();
  const refused = await answer;
  expect(refused.status()).toBe(400);
  expect(codeOf(await refused.json())).toBe('trade.algo_volume_immature');
  await expect(page.getByText('trade.algo_volume_immature', { exact: true })).toBeVisible();
  expect((await algoRows(trader)).map((row) => row.id)).toEqual(rowsBefore);
  const after = await (await api(trader)).balances();
  for (const asset of ['USDC', 'IFC']) {
    expect(free(after, asset)).toBe(free(before, asset));
    expect(held(after, asset)).toBe(held(before, asset));
  }

  // With an ask resting too, a POV sell on opposite-side liquidity takes from the bids: its first child is the
  // participation rate applied to the size resting on the bid side, floored to the lot (0.01), as the service records.
  const ask = await other.post('/api/v1/orders', {
    symbol: UNQUOTED,
    type: 'limit',
    side: 'sell',
    amount: '50',
    price: '1.01',
    clientOrderId: `${J}-7-ask-${tag}`,
  });
  expect(ask.status, JSON.stringify(ask.body).slice(0, 300)).toBeLessThan(300);
  const twoSided = await ifcBook();
  const bidSize = twoSided.bids.reduce((sum, [, size]) => sum + toUnits(size), 0n);
  expect(bidSize).toBe(toUnits('40'));

  await page.goto('/execution');
  await fillSchedule(page, { market: UNQUOTED, side: 'Sell', kind: 'POV', total: '10', seconds: 120, every: 15 });
  await pick(page, 'Participation basis', 'Opposite-side liquidity');
  await form(page).getByLabel('Participation, in basis points').fill('1000');
  await form(page).getByLabel('Limit price (optional)').fill('0.99');
  const id = await confirmSchedule(page);
  try {
    const created = await parentOf(trader, id);
    expect(created.kind).toBe('pov');
    expect(created.povBasis).toBe('opposite_liquidity');
    expect(created.participationBps).toBe(1000);

    await expect.poll(async () => (await parentOf(trader, id)).children.length, { timeout: 60_000 }).toBeGreaterThan(0);
    const first = (await parentOf(trader, id)).children[0];
    // The book size it read is the bid side above: 40 × 1000 bps = 4, under the 10 remaining.
    expect(first.basisQty).toBe('40');
    expect(toUnits(first.qty)).toBe(toUnits('4'));
    // The detail names the newest child, and a second one may land while it loads (the first fills 4 of the 40, so the
    // next reads 36): the line must be a child the service recorded, in its own numbers.
    const line = detail(page).getByText(/ resting on the opposite side$/);
    await expect
      .poll(
        async () => {
          const text = (await line.textContent({ timeout: 2_000 }).catch(() => null)) ?? '';
          const m = /^([\d.]+) of ([\d.]+) resting on the opposite side$/.exec(text.trim());
          if (!m) return false;
          const kids = (await parentOf(trader, id)).children;
          return kids.some((c) => toUnits(c.qty) === toUnits(m[1]) && toUnits(c.basisQty) === toUnits(m[2]));
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  } finally {
    await (await api(trader)).post('/api/trade/trpc/algo.cancel', { algoId: id });
    await clearIfc(maker);
    await clearIfc(trader);
  }
});

const STATUS_WORD = { active: 'Active', paused: 'Paused', halted: 'Halted', completed: 'Completed', cancelled: 'Cancelled' };

/** The schedule's average fill price as the service reports it (null while nothing has filled). */
async function averageOf(who, algoId) {
  const { status, body } = await (
    await api(who)
  ).get(`/api/trade/trpc/algo.result?input=${encodeURIComponent(JSON.stringify({ algoId }))}`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data.quotes.find((q) => q.averageFillPrice !== null)?.averageFillPrice ?? null;
}

/** A pause or resume sent straight to the service: its typed refusal code, or null when it was accepted. */
async function actionCode(who, action, algoId) {
  const { status, body } = await (await api(who)).post(`/api/trade/trpc/algo.${action}`, { algoId });
  return status < 300 ? null : (codeOf(body) ?? `${status} ${JSON.stringify(body).slice(0, 300)}`);
}

function stack(...args) {
  return tool('local-test-stack.mjs', ...args);
}

test(`${J} #8 opens the algo list and blotter and cancels with one child failing: rows with statuses and an average fill price ("Not set" with zero fills); the cancel is reported incomplete and halt and resume are refused`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const trader = state('trader');
  await signIn(page, trader);
  // A new browser: the list comes from the service, not from ids this device remembered.
  await page.evaluate(() => localStorage.clear());
  await page.goto('/execution');
  const list = schedules(page);
  await expect(list.getByRole('columnheader', { name: 'Average fill price' })).toBeVisible();
  const headers = await list.getByRole('columnheader').allInnerTexts();
  const averageColumn = headers.findIndex((h) => h.trim() === 'Average fill price');
  expect(averageColumn).toBeGreaterThan(-1);
  const cellOf = (id, column) =>
    list
      .getByRole('row', { name: new RegExp(id) })
      .getByRole('gridcell')
      .nth(column);

  // Each row carries the service's status. The schedule that ran (#4) shows the average price of its real fills; the
  // one still waiting for its trigger (#3) has no fills, so its average is "Not set".
  // The service and the room are read again together until they agree, so a fill or status change landing between the
  // two reads cannot fail it.
  for (const id of [state('running'), state('triggered')]) {
    await expect(async () => {
      const parent = await parentOf(trader, id);
      await expect(list.getByRole('row', { name: new RegExp(id) }).getByText(STATUS_WORD[parent.status], { exact: true })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 30_000 });
  }
  // The cell shows the service's average rounded to the digits it draws (a mean of several fill prices can run long):
  // it is within half of its last digit of the service's number.
  await expect(async () => {
    const ranAverage = await averageOf(trader, state('running'));
    expect(ranAverage).not.toBeNull();
    const shown = (await cellOf(state('running'), averageColumn).innerText()).replace(/,/g, '').trim();
    expect(shown).toMatch(/^\d+(\.\d+)?$/);
    const digits = shown.split('.')[1]?.length ?? 0;
    const step = toUnits(digits ? `0.${'0'.repeat(digits - 1)}1` : '1');
    const gap = toUnits(shown) - toUnits(ranAverage);
    expect((gap < 0n ? -gap : gap) * 2n).toBeLessThanOrEqual(step);
  }).toPass({ timeout: 30_000 });
  expect(await averageOf(trader, state('triggered'))).toBeNull();
  await expect(cellOf(state('triggered'), averageColumn)).toHaveText('Not set');
  await list.getByRole('row', { name: new RegExp(state('triggered')) }).click();
  await expect(
    detail(page)
      .getByRole('definition')
      .filter({ hasText: /^\s*Not set/ }),
  ).toBeVisible();

  // The blotter opens with the account's child orders and fills.
  const tabs = page.getByRole('tablist', { name: 'Execution sections' });
  await tabs.getByRole('tab', { name: 'Child orders and fills', exact: true }).click();
  await expect(bodyRows(tableIn(page, 'Orders and fills')).first()).toBeVisible();

  // A TWAP buy on the unquoted TEST book, where the other trader rests a bid and a small ask: its first child (1 IFC at
  // the ask, the band's edge) takes the 0.5 resting and leaves the rest open. The next slice is five minutes away, so
  // nothing else is placed while the matching engine is stopped: the child cancel fails for real.
  const maker = otherTrader();
  const other = await api(maker);
  expect(fund(maker.email, 'USDC', '100').tx).toBeTruthy();
  expect(fund(maker.email, 'IFC', '100').tx).toBeTruthy();
  expect(fund(trader.email, 'USDC', '100').tx).toBeTruthy();
  await clearIfc(maker);
  await clearIfc(trader);
  const tag = state('tag');
  for (const [side, amount, price] of [
    ['buy', '1', '0.99'],
    ['sell', '0.5', '1.01'],
  ]) {
    const rest = await other.post('/api/v1/orders', {
      symbol: UNQUOTED,
      type: 'limit',
      side,
      amount,
      price,
      clientOrderId: `${J}-8-${side}-${tag}`,
    });
    expect(rest.status, JSON.stringify(rest.body).slice(0, 300)).toBeLessThan(300);
  }
  await expect
    .poll(async () => (await ifcBook()).asks.map(([price, size]) => [toUnits(price), toUnits(size)]), { timeout: 15_000 })
    .toEqual([[toUnits('1.01'), toUnits('0.5')]]);
  await tabs.getByRole('tab', { name: 'Algo orders', exact: true }).click();
  await fillSchedule(page, { market: UNQUOTED, total: '2', seconds: 600, every: 300 });
  await form(page).getByLabel('Limit price (optional)').fill('1.01');
  const id = await confirmSchedule(page);
  let stopped = false;
  try {
    await expect.poll(async () => (await parentOf(trader, id)).children.length, { timeout: 45_000 }).toBe(1);
    const child = (await parentOf(trader, id)).children[0].orderId;
    await expect.poll(async () => (await openOrders(trader, UNQUOTED)).map((o) => o.id), { timeout: 15_000 }).toContain(child);
    // Marked first, so a stop that times out after its signal still brings the engine back.
    stopped = true;
    stack('stop', 'matching');
    await list.getByRole('button', { name: `Cancel ${id}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel schedule' }).click();
    await expect(page.getByText('trade.algo_child_cancel_failed', { exact: true })).toBeVisible({ timeout: 30_000 });
    // Reported incomplete: parked, not cancelled, with the cancel-incomplete reason.
    const parked = await parentOf(trader, id);
    expect(parked.status).toBe('paused');
    expect(parked.haltReason).toBe('cancel_incomplete');
    await list.getByRole('row', { name: new RegExp(id) }).click();
    await expect(detail(page).getByText('Cancel only partly done: some child orders may still be open.', { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // The room offers neither halt (pause) nor resume.
    await expect(list.getByRole('button', { name: `Pause ${id}` })).toBeDisabled();
    await expect(list.getByRole('button', { name: `Resume ${id}` })).toBeDisabled();

    // Edge refuses every trade write while it cannot read the venue halt, so the service's own refusals are read once
    // the engine is back. The schedule stays parked until it is cancelled again: halt and resume are refused, and
    // nothing about it changes (its child is still open).
    stack('start', '--only', 'matching');
    stopped = false;
    await expect
      .poll(async () => actionCode(trader, 'pause', id), { timeout: 60_000, intervals: [2_000] })
      .toBe('trade.algo_cancel_incomplete');
    expect(await actionCode(trader, 'resume', id)).toBe('trade.algo_cancel_incomplete');
    const after = await parentOf(trader, id);
    expect(after.status).toBe('paused');
    expect(after.haltReason).toBe('cancel_incomplete');
    expect(after.children.map((c) => c.orderId)).toEqual([child]);
    expect((await openOrders(trader, UNQUOTED)).map((o) => o.id)).toContain(child);

    // Cancelling again finishes: the schedule is cancelled and its child is no longer open.
    await expect.poll(async () => actionCode(trader, 'cancel', id), { timeout: 60_000, intervals: [2_000] }).toBeNull();
    expect((await parentOf(trader, id)).status).toBe('cancelled');
    expect((await openOrders(trader, UNQUOTED)).map((o) => o.id)).not.toContain(child);
  } finally {
    // The engine comes back before anything else, and a failed restart still lets the rest of the clean-up run.
    let restart = null;
    if (stopped) {
      try {
        stack('start', '--only', 'matching');
      } catch (err) {
        restart = err;
      }
    }
    await (await api(trader)).post('/api/trade/trpc/algo.cancel', { algoId: id });
    await clearIfc(maker);
    await clearIfc(trader);
    if (restart) throw restart;
  }
});
