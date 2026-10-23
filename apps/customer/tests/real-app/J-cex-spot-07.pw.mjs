import { test, expect } from '@playwright/test';
import { api, journeyState, otherTrader } from './stack.mjs';
import { awayBid, deskPath, fundedTrader, held, openOrders, signIn } from './desk.mjs';

// J-cex-spot-07, in the running app (docs/roadmap/journeys.json): a pro trader arms the dead-man switch on the desk,
// lets it fire, keeps it alive and turns it off. One test per step, titled "J-cex-spot-07 #<n>", run in order on one
// TEST account funded with TEST USDT through the real ledger. The stack publishes the TEST timeouts 10, 30, 60 and 120
// seconds (TRADE_CANCEL_ALL_AFTER_TIMEOUTS_SEC) with a one-second sweep.
const J = 'J-cex-spot-07';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const FUNDED = '2000';
const SYMBOL = 'BTC/USDT';

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

const sessions = new Map();
async function client(who) {
  if (!sessions.has(who.email)) sessions.set(who.email, await api(who));
  return sessions.get(who.email);
}

/** A buy that rests well under the market, so only a cancel ends it. */
async function rest(who, key) {
  const price = await awayBid(80, SYMBOL);
  const res = await (
    await client(who)
  ).post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'limit',
    side: 'buy',
    amount: '0.001',
    price,
    clientOrderId: `${J}-${key}-${Date.now()}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
  return res.body.id;
}

async function openIds(who) {
  return (await openOrders(who, SYMBOL)).map((o) => o.id);
}

const switchButton = (page) => page.getByRole('button', { name: /^Auto-cancel/ });
const dialog = (page) => page.getByRole('alertdialog').filter({ hasText: 'Auto-cancel if you go quiet' });

async function openSwitch(page) {
  await switchButton(page).click();
  await expect(dialog(page)).toBeVisible();
}

test(`${J} #1 arms the switch with a timeout the owner has published: armed, with the trigger time shown`, async ({ page }) => {
  const who = await fundedTrader(page, 'jspot07', FUNDED);
  run.write({ account: who });
  await signIn(page, who);
  await page.goto(deskPath(SYMBOL));
  await expect(switchButton(page)).toHaveText('Auto-cancel: off');
  await openSwitch(page);
  const box = dialog(page);
  // Only the published timeouts are offered.
  for (const s of [10, 30, 60, 120]) await expect(box.getByRole('radio', { name: `${s} seconds` })).toBeVisible();
  await box.getByRole('radio', { name: '120 seconds' }).check();
  const before = Date.now();
  await box.getByRole('button', { name: 'Turn on' }).click();
  const armed = box.getByText(/^On\. Unless refreshed, your open orders are cancelled at \d\d:\d\d:\d\d\.$/);
  await expect(armed).toBeVisible();
  // The service's own record agrees: armed for 120 seconds, firing about 120 seconds from now.
  const state = (await (await client(who)).get('/api/v1/orders/cancel-all-after')).body;
  expect(state).toMatchObject({ armed: true, timeout: 120, timeouts: [10, 30, 60, 120] });
  const fires = Date.parse(state.triggerTime) - before;
  expect(fires).toBeGreaterThan(110_000);
  expect(fires).toBeLessThan(130_000);
  await expect(switchButton(page)).toHaveText(/^Auto-cancel at \d\d:\d\d:\d\d$/);
  // Off again, so nothing fires during the next steps.
  await box.getByRole('button', { name: 'Turn off' }).click();
  await expect(box.getByText('Off. Nothing will be cancelled.')).toBeVisible();
});

test(`${J} #2 arms it with an unpublished timeout: refused with a typed reason, nothing armed`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  await page.goto(deskPath(SYMBOL));
  await openSwitch(page);
  const box = dialog(page);
  await box.getByRole('radio', { name: 'Other' }).check();
  await box.getByLabel('Seconds').fill('7');
  const answer = page.waitForResponse((r) => r.url().includes('/api/v1/orders/cancel-all-after') && r.request().method() === 'POST');
  await box.getByRole('button', { name: 'Turn on' }).click();
  const res = await answer;
  expect(res.status()).toBe(400);
  expect((await res.json()).intafacedCode).toBe('trade.cancel_all_after_rejected');
  await expect(box.getByRole('alert')).toHaveText('That time isn’t offered. Choose one of: 10, 30, 60, 120 seconds.');
  expect((await (await client(who)).get('/api/v1/orders/cancel-all-after')).body).toMatchObject({ armed: false, triggerTime: null });
});

test(`${J} #3 stops talking past the deadline: every resting order cancelled, holds released, another customer's orders untouched`, async ({
  page,
}) => {
  test.setTimeout(90_000);
  const who = account();
  const mine = [await rest(who, 'a'), await rest(who, 'b')];
  const theirs = await rest(otherTrader(), 'other');
  expect(held(await (await client(who)).balances(), 'USDT')).toBeGreaterThan(0n);

  await signIn(page, who);
  await page.goto(deskPath(SYMBOL));
  await openSwitch(page);
  const box = dialog(page);
  await box.getByRole('radio', { name: '10 seconds' }).check();
  await box.getByRole('button', { name: 'Turn on' }).click();
  await expect(box.getByText(/^On\. Unless refreshed/)).toBeVisible();
  await box.getByRole('button', { name: 'Close' }).click();
  expect(await openIds(who)).toEqual(expect.arrayContaining(mine));

  // Nothing refreshes it: past the deadline the sweep cancels every open order and the desk says so.
  await expect.poll(async () => (await openIds(who)).length, { timeout: 30_000, intervals: [1000] }).toBe(0);
  await expect.poll(async () => held(await (await client(who)).balances(), 'USDT'), { timeout: 15_000 }).toBe(0n);
  for (const id of mine) expect((await (await client(who)).get(`/api/v1/orders/${id}`)).body.status).toBe('canceled');
  await expect(switchButton(page)).toHaveText('Auto-cancel: off', { timeout: 15_000 });
  await page.getByRole('tab', { name: 'Open orders' }).click();
  await expect(page.getByText('No open orders')).toBeVisible({ timeout: 15_000 });
  // Another customer's resting order is still there.
  expect(await openIds(otherTrader())).toContain(theirs);
  await (await client(otherTrader())).delete(`/api/v1/orders/${theirs}`);
});

test(`${J} #4 keeps refreshing, then disarms with timeout 0: nothing cancelled while refreshed, nor after the old deadline`, async ({
  page,
}) => {
  test.setTimeout(90_000);
  const who = account();
  const order = await rest(who, 'kept');
  await signIn(page, who);
  await page.goto(deskPath(SYMBOL));
  await openSwitch(page);
  const box = dialog(page);
  await box.getByRole('radio', { name: '10 seconds' }).check();
  await box.getByRole('checkbox', { name: 'Keep refreshing while this page is open' }).check();
  await box.getByRole('button', { name: 'Turn on' }).click();
  await expect(box.getByText(/^On\. Unless refreshed/)).toBeVisible();
  const first = Date.parse((await (await client(who)).get('/api/v1/orders/cancel-all-after')).body.triggerTime);

  // Two deadlines' worth of time passes while the page keeps refreshing: the deadline moves on and the order stays.
  await page.waitForTimeout(22_000);
  const now = (await (await client(who)).get('/api/v1/orders/cancel-all-after')).body;
  expect(now.armed).toBe(true);
  expect(Date.parse(now.triggerTime)).toBeGreaterThan(first + 10_000);
  expect(await openIds(who)).toContain(order);

  // Off: timeout 0. Past the deadline it had, the order is still open.
  const off = page.waitForResponse(
    (r) =>
      r.url().includes('/api/v1/orders/cancel-all-after') &&
      r.request().method() === 'POST' &&
      r.request().postData()?.includes('"timeout":0'),
  );
  await box.getByRole('button', { name: 'Turn off' }).click();
  expect(await (await off).json()).toMatchObject({ armed: false, timeout: 0, triggerTime: null });
  await expect(box.getByText('Off. Nothing will be cancelled.')).toBeVisible();
  await page.waitForTimeout(13_000);
  expect(await openIds(who)).toContain(order);
  expect((await (await client(who)).get('/api/v1/orders/cancel-all-after')).body).toMatchObject({ armed: false });
  await (await client(who)).delete(`/api/v1/orders/${order}`);
});
