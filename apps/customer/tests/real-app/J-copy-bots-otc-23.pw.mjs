import { test, expect } from '@playwright/test';
import { api, bestPrices, fromUnits, fund, journeyState, otherTrader, signOutBrowser, times, tool, toUnits } from './stack.mjs';
import { free, fundedTrader, held, openOrders, signIn, signUp } from './desk.mjs';
import { tableIn } from './tables.mjs';

// J-copy-bots-otc-23, in the running app (docs/roadmap/journeys.json): work a large order slowly with TWAP, chase or
// iceberg on /execution. One test per step, titled "J-copy-bots-otc-23 #<n>", run in order. The trader starts signed
// in, verified and funded with TEST USDT; every child order goes to the real TEST book, and the parent's progress is
// read back from the service.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #5: the order form offers no Chase; #7: no participation basis; #8: the list and blotter do not read the service.
const J = 'J-copy-bots-otc-23';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

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
  await expect(list.getByText('Active')).toBeVisible();

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

test(`${J} #5 places a chase limit order with a maximum distance: re-priced with the book inside the distance, stopped beyond it, blank refused`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/execution');
  const box = form(page);
  await pick(page, 'Kind', 'Chase');
  await box.getByRole('button', { name: 'Buy', exact: true }).click();
  await box.getByLabel('Total size (BTC)').fill('0.001');

  // A blank distance refuses before anything is sent.
  await expect(box.getByText('Enter a maximum chase distance.')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('button', { name: 'Review chase' })).toBeDisabled();

  await box.getByLabel('Maximum chase distance, %').fill('0.5');
  const created = page.waitForResponse((res) => res.url().includes('algo.createChase'));
  await page.getByRole('button', { name: 'Review chase' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Start chase' }).click();
  const answer = await created;
  expect(answer.status(), (await answer.text()).slice(0, 300)).toBe(200);
  const id = (await answer.json()).result.data.id;

  // It rests at the best bid and follows it; every price it used stays inside 0.5% of where it started.
  const chase = await parentOf(trader, id);
  expect(chase.kind).toBe('chase');
  await expect.poll(async () => (await parentOf(trader, id)).repriceCount ?? 0, { timeout: 90_000 }).toBeGreaterThan(0);
  const now = await parentOf(trader, id);
  const start = toUnits(now.chaseStartPrice);
  for (const p of now.chasePrices) expect(toUnits(p) - start).toBeLessThanOrEqual((start * 5n) / 1000n);
  if (now.status !== 'completed') {
    await page
      .getByRole('grid', { name: 'Schedules' })
      .getByRole('button', { name: `Cancel ${id}` })
      .click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel schedule' }).click();
  }

  // A distance smaller than one book move: the chase stops with that reason and cancels its order once.
  await box.getByLabel('Maximum chase distance, %').fill('0.01');
  const tight = page.waitForResponse((res) => res.url().includes('algo.createChase'));
  await page.getByRole('button', { name: 'Review chase' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Start chase' }).click();
  const tightId = (await (await tight).json()).result.data.id;
  await expect.poll(async () => (await parentOf(trader, tightId)).stopReason, { timeout: 120_000 }).toMatch(/max_distance|filled/);
  const stopped = await parentOf(trader, tightId);
  if (stopped.stopReason === 'max_distance') {
    expect(stopped.cancels).toBe(1);
    await expect(detail(page).getByText('Stopped: the best price moved past the maximum distance')).toBeVisible();
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

test(`${J} #7 chooses POV on opposite-side liquidity with an empty opposite book: refused as volume immature`, async ({ page }) => {
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/execution');
  // IFC/USDT is a TEST market the market maker does not quote, so its ask side is empty.
  await fillSchedule(page, { market: 'IFC/USDT', kind: 'POV', total: '1', seconds: 120, every: 30 });
  await pick(page, 'Participation basis', 'Opposite-side liquidity');
  await form(page).getByLabel('Participation, in basis points').fill('1000');
  const answer = page.waitForResponse((res) => res.url().includes('algo.createTwap'));
  await page.getByRole('button', { name: 'Review schedule' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Create schedule' }).click();
  expect((await answer).status()).toBeGreaterThanOrEqual(400);
  await expect(page.getByText('trade.algo_volume_immature', { exact: true })).toBeVisible();
});

test(`${J} #8 opens the algo list and blotter, and cancels with a child failing: statuses, average fill price, cancel incomplete, halt and resume refused`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const trader = state('trader');
  await signIn(page, trader);
  // A new browser: the list comes from the service, not from ids this device remembered.
  await page.evaluate(() => localStorage.clear());
  await page.goto('/execution');
  const list = schedules(page);
  for (const id of [state('running'), state('triggered')]) await expect(list.getByRole('row', { name: new RegExp(id) })).toBeVisible();
  // The waiting schedule has no fills, so its average price is not a number.
  await list.getByRole('row', { name: new RegExp(state('triggered')) }).click();
  await expect(detail(page).getByText(/Average fill price\s*Not set/)).toBeVisible();

  // The blotter links each child to its parent.
  await page.getByRole('tablist', { name: 'Execution sections' }).getByRole('tab', { name: 'Child orders and fills', exact: true }).click();
  await pick(page, 'Parent', state('running'));
  const blotter = page.getByRole('grid', { name: 'Orders and fills' });
  await expect(blotter.getByRole('row').nth(1)).toBeVisible();

  // A limit TWAP whose resting child cannot be cancelled (the stack's TEST cancel fault on this parent): the cancel is
  // reported incomplete, the parent halts, and resume is refused.
  await page.getByRole('tablist', { name: 'Execution sections' }).getByRole('tab', { name: 'Algo orders', exact: true }).click();
  const { bid } = await bestPrices();
  await fillSchedule(page, { total: '0.002', seconds: 120, every: 15 });
  await form(page)
    .getByLabel('Limit price')
    .fill(String((toUnits(bid) * 97n) / 100n / toUnits('1')));
  const id = await confirmSchedule(page);
  await expect.poll(async () => (await parentOf(trader, id)).children.length, { timeout: 45_000 }).toBeGreaterThan(0);
  tool('local-test-gates.mjs', 'fail-cancel', (await parentOf(trader, id)).children[0].orderId);
  await list.getByRole('button', { name: `Cancel ${id}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel schedule' }).click();
  await expect(page.getByText('trade.algo_cancel_incomplete', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(list.getByRole('row', { name: new RegExp(id) }).getByText('Halted')).toBeVisible();
  await expect(list.getByRole('button', { name: `Resume ${id}` })).toBeDisabled();
});
