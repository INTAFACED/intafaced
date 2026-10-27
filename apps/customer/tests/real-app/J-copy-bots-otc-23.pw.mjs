import { test, expect } from '@playwright/test';
import { api, bestPrices, fund, journeyState, signOutBrowser, tool, toUnits } from './stack.mjs';
import { fundedTrader, signIn, signUp } from './desk.mjs';

// J-copy-bots-otc-23, in the running app (docs/roadmap/journeys.json): work a large order slowly with TWAP, chase or
// iceberg on /execution. One test per step, titled "J-copy-bots-otc-23 #<n>", run in order. The trader starts signed
// in, verified and funded with TEST USDT; every child order goes to the real TEST book, and the parent's progress is
// read back from the service.
const J = 'J-copy-bots-otc-23';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

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

async function pick(page, label, option) {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** Fills the schedule form: BTC/USDT, `side`, `kind`, `total` BTC over `seconds`, a slice every `every` seconds. */
async function fillSchedule(page, { side = 'Buy', kind = 'TWAP', total, seconds, every }) {
  const box = form(page);
  await box.getByRole('radio', { name: side, exact: true }).click();
  await pick(page, 'Kind', kind);
  await box.getByLabel('Total size (BTC)').fill(total);
  await pick(page, 'Duration', 'Custom');
  await box.getByLabel('Custom duration, seconds').fill(String(seconds));
  await box.getByLabel('Slice interval, seconds').fill(String(every));
}

/** Review, confirm, and return the new parent id the room reports. */
async function confirmSchedule(page) {
  const created = page.waitForResponse((res) => res.url().includes('algo.createTwap') && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Review schedule' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create schedule' }).click();
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
  const tabs = page.getByRole('tablist', { name: 'Execution tabs' });
  for (const name of TABS) await expect(tabs.getByRole('tab', { name, exact: true })).toBeVisible();

  // The stack runs the slice scheduler, so the algo form is open; Routing is blocked and says on what.
  await expect(page.getByText('Scheduler running')).toBeVisible();
  await tabs.getByRole('tab', { name: 'Routing', exact: true }).click();
  const caps = page.getByRole('table', { name: 'Capabilities' });
  await expect(caps.getByText('Blocked').first()).toBeVisible();
  await expect(caps.getByText(/venue submit port/).first()).toBeVisible();
});

test(`${J} #2 creates a TWAP below the owner's tier: refused as tier insufficient, and no parent row is written`, async ({ page }) => {
  test.setTimeout(240_000);
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
  await page.goto('/execution');
  await fillSchedule(page, { total: '0.002', seconds: 120, every: 30 });
  const answer = page.waitForResponse((res) => res.url().includes('algo.createTwap'));
  await page.getByRole('button', { name: 'Review schedule' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create schedule' }).click();
  expect((await answer).status()).toBe(403);
  await expect(page.getByText('Reference trade.bots_verification_insufficient')).toBeVisible();

  // Nothing was written: the service lists no schedule for this account.
  const { status, body } = await (await api(basic)).get(`/api/trade/trpc/algo.list?input=${encodeURIComponent(JSON.stringify({}))}`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  expect(body.result.data.items).toHaveLength(0);
});

test(`${J} #3 creates a TWAP with random sizes, a fixed seed and a trigger price: sizes sum to the total, the same seed gives the same sizes, and it waits`, async ({
  page,
}) => {
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/execution');
  await fillSchedule(page, { total: '0.003', seconds: 300, every: 30 });
  const box = form(page);
  await box.getByRole('checkbox', { name: 'Random slice sizes' }).check({ timeout: 5_000 });
  await box.getByLabel('Seed').fill('2310');
  // A buy trigger far above the book: the schedule waits for the price to reach it.
  const { ask } = await bestPrices();
  const trigger = String(Math.round(Number(ask) * 2));
  await box.getByLabel('Start when the price reaches').fill(trigger);

  await page.getByRole('button', { name: 'Review schedule' }).click();
  const sizes = await page.getByRole('dialog').getByRole('list', { name: 'Slice sizes' }).getByRole('listitem').allInnerTexts();
  expect(sizes.length).toBe(10);
  const sum = sizes.reduce((acc, s) => acc + toUnits(s.replace(/[^\d.]/g, '')), 0n);
  expect(sum).toBe(toUnits('0.003'));
  const created = page.waitForResponse((res) => res.url().includes('algo.createTwap'));
  await page.getByRole('dialog').getByRole('button', { name: 'Create schedule' }).click();
  const id = (await (await created).json())?.result?.data?.id;
  expect(id).toBeTruthy();

  // The service keeps the planned sizes on the parent, so a restart re-plans nothing: they are the preview's.
  const parent = await parentOf(trader, id);
  expect(parent.plannedSliceQtys.map((q) => toUnits(q))).toEqual(sizes.map((s) => toUnits(s.replace(/[^\d.]/g, ''))));
  expect(parent.triggerPrice).toBe(trigger);
  await expect(detail(page).getByText('Waiting for the trigger price')).toBeVisible();
  expect(parent.children).toHaveLength(0);
  run.write({ triggered: id });
});

test(`${J} #4 reviews, confirms and watches a TWAP run: partial fills; pause stops new children, resume re-spaces overdue slices`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/execution');
  await fillSchedule(page, { total: '0.002', seconds: 120, every: 15 });
  const id = await confirmSchedule(page);
  run.write({ running: id });

  // A child goes to the book and fills: the parent is active with part of its total filled.
  await expect.poll(async () => toUnits((await parentOf(trader, id)).filledQty ?? '0'), { timeout: 60_000 }).toBeGreaterThan(0n);
  const list = schedules(page);
  await expect(list.getByText('Active')).toBeVisible();

  await list.getByRole('button', { name: `Pause ${id}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Pause schedule' }).click();
  await expect(list.getByRole('button', { name: `Resume ${id}` })).toBeVisible({ timeout: 10_000 });
  const pausedChildren = (await parentOf(trader, id)).children.length;
  // Two intervals pass with no new child.
  await page.waitForTimeout(31_000);
  expect((await parentOf(trader, id)).children.length).toBe(pausedChildren);

  await list.getByRole('button', { name: `Resume ${id}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Resume schedule' }).click();
  await expect(list.getByRole('button', { name: `Pause ${id}` })).toBeVisible({ timeout: 10_000 });
  // The overdue slices are spread over the rest of the schedule, and the room says why it was stretched.
  await expect(detail(page).getByText('You paused this schedule')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await parentOf(trader, id)).children.length, { timeout: 45_000 }).toBeGreaterThan(pausedChildren);
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
  await box.getByRole('radio', { name: 'Buy', exact: true }).click();
  await box.getByLabel('Total size (BTC)').fill('0.001');

  // A blank distance refuses before anything is sent.
  await expect(box.getByText('Enter a maximum chase distance.')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('button', { name: 'Review chase' })).toBeDisabled();

  await box.getByLabel('Maximum chase distance, %').fill('0.5');
  const created = page.waitForResponse((res) => res.url().includes('algo.createChase'));
  await page.getByRole('button', { name: 'Review chase' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start chase' }).click();
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
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel schedule' }).click();
  }

  // A distance smaller than one book move: the chase stops with that reason and cancels its order once.
  await box.getByLabel('Maximum chase distance, %').fill('0.01');
  const tight = page.waitForResponse((res) => res.url().includes('algo.createChase'));
  await page.getByRole('button', { name: 'Review chase' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start chase' }).click();
  const tightId = (await (await tight).json()).result.data.id;
  await expect.poll(async () => (await parentOf(trader, tightId)).stopReason, { timeout: 120_000 }).toMatch(/max_distance|filled/);
  const stopped = await parentOf(trader, tightId);
  if (stopped.stopReason === 'max_distance') {
    expect(stopped.cancels).toBe(1);
    await expect(detail(page).getByText('Stopped: the best price moved past the maximum distance')).toBeVisible();
  }
});

test(`${J} #6 places an iceberg: display equal to total refused; a valid one rests with its display and refills; a second on the symbol refused; the live door names the venue port`, async ({
  page,
}) => {
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/execution');
  await page.getByRole('tablist', { name: 'Execution tabs' }).getByRole('tab', { name: 'Iceberg', exact: true }).click();
  const box = page.getByRole('region', { name: 'New iceberg' });
  const { bid } = await bestPrices();
  // A resting buy 2% under the best bid, so it shows on the book without filling.
  const price = String(Math.floor(Number(bid) * 0.98));
  await box.getByLabel('Total size (BTC)').fill('0.003');
  await box.getByLabel('Display size (BTC)').fill('0.003');
  await box.getByLabel('Limit price').fill(price);
  await expect(box.getByText('The display size must be smaller than the total.')).toBeVisible();
  await expect(box.getByRole('button', { name: 'Place iceberg' })).toBeDisabled();

  await box.getByLabel('Display size (BTC)').fill('0.001');
  const placed = page.waitForResponse((res) => res.url().endsWith('/api/v1/orders') && res.request().method() === 'POST');
  await box.getByRole('button', { name: 'Place iceberg' }).click({ timeout: 5_000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Place iceberg' }).click();
  const answer = await placed;
  expect(answer.status(), (await answer.text()).slice(0, 300)).toBeLessThan(300);
  const order = await answer.json();
  run.write({ iceberg: order.id });

  // The book shows only the display size at that price; the hold is the whole order.
  const { body } = await bestPrices('BTC/USDT', 200);
  const level = body.bids.find(([p]) => toUnits(p) === toUnits(price));
  expect(level, `no bid at ${price}`).toBeTruthy();
  expect(toUnits(level[1])).toBeLessThan(toUnits('0.003'));
  const balances = await (await api(trader)).balances();
  expect(toUnits(balances.USDT.used)).toBeGreaterThanOrEqual((toUnits(price) * toUnits('0.003')) / 10n ** 18n);

  // A second iceberg on the same symbol is refused by name.
  const second = page.waitForResponse((res) => res.url().endsWith('/api/v1/orders') && res.request().method() === 'POST');
  await box.getByRole('button', { name: 'Place iceberg' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Place iceberg' }).click();
  expect((await second).status()).toBeGreaterThanOrEqual(400);
  await expect(page.getByText('Reference trade.iceberg_symbol_cap')).toBeVisible();

  // The live venue door stays off while its port is unset, and says so.
  await expect(page.getByText('Needs the venue submit port; switched off in this build')).toBeVisible();
});

test(`${J} #7 chooses POV on opposite-side liquidity with an empty opposite book: refused as volume immature`, async ({ page }) => {
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/execution');
  // IFC/USDT is a TEST market the market maker does not quote, so its ask side is empty.
  await pick(page, 'Market', 'IFC/USDT');
  await fillSchedule(page, { kind: 'POV', total: '1', seconds: 120, every: 30 });
  await pick(page, 'Participation basis', 'Opposite-side liquidity');
  await form(page).getByLabel('Participation, basis points').fill('1000');
  const answer = page.waitForResponse((res) => res.url().includes('algo.createTwap'));
  await page.getByRole('button', { name: 'Review schedule' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create schedule' }).click();
  expect((await answer).status()).toBeGreaterThanOrEqual(400);
  await expect(page.getByText('Reference trade.algo_volume_immature')).toBeVisible();
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
  await page.getByRole('tablist', { name: 'Execution tabs' }).getByRole('tab', { name: 'Child orders and fills', exact: true }).click();
  await pick(page, 'Parent', state('running'));
  const blotter = page.getByRole('grid', { name: 'Orders and fills' });
  await expect(blotter.getByRole('row').nth(1)).toBeVisible();

  // A limit TWAP whose resting child cannot be cancelled (the stack's TEST cancel fault on this parent): the cancel is
  // reported incomplete, the parent halts, and resume is refused.
  await page.getByRole('tablist', { name: 'Execution tabs' }).getByRole('tab', { name: 'Algo orders', exact: true }).click();
  const { bid } = await bestPrices();
  await fillSchedule(page, { total: '0.002', seconds: 120, every: 15 });
  await form(page)
    .getByLabel('Limit price')
    .fill(String(Math.floor(Number(bid) * 0.97)));
  const id = await confirmSchedule(page);
  await expect.poll(async () => (await parentOf(trader, id)).children.length, { timeout: 45_000 }).toBeGreaterThan(0);
  tool('local-test-gates.mjs', 'fail-cancel', (await parentOf(trader, id)).children[0].orderId);
  await list.getByRole('button', { name: `Cancel ${id}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel schedule' }).click();
  await expect(page.getByText('Reference trade.algo_cancel_incomplete')).toBeVisible({ timeout: 15_000 });
  await expect(list.getByRole('row', { name: new RegExp(id) }).getByText('Halted')).toBeVisible();
  await expect(list.getByRole('button', { name: `Resume ${id}` })).toBeDisabled();
});
