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
  // The desk's own button (behind the open dialog) says when it fires.
  await box.getByRole('button', { name: 'Close' }).click();
  await expect(switchButton(page)).toHaveText(/^Auto-cancel at \d\d:\d\d:\d\d$/);
  // Off again, so nothing fires during the next steps.
  await openSwitch(page);
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
  await box.getByRole('textbox', { name: 'Seconds', exact: true }).fill('7');
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

/** Every ledger line of the account, newest first, read page by page through the service. */
async function ledgerLines(who) {
  const lines = [];
  let cursor = null;
  for (;;) {
    const { status, body } = await (await client(who)).get(`/api/v1/ledger?limit=200${cursor ? `&cursor=${cursor}` : ''}`);
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
    lines.push(...body.entries);
    if (!body.nextCursor) return lines;
    cursor = body.nextCursor;
  }
}

/** Every order of the account in any state, through the open and closed reads. */
async function allOrders(who) {
  const open = await openOrders(who, SYMBOL);
  const { status, body } = await (await client(who)).get('/api/v1/orders/closed?limit=500');
  expect(status).toBe(200);
  return [...open, ...body];
}

const parseCsv = (text) => {
  const [head, ...rows] = text.trimEnd().split('\n');
  const columns = head.split(',');
  return rows.map((row) => Object.fromEntries(row.split(',').map((v, i) => [columns[i], v])));
};

test(`${J} #5 requests a statement of orders, trades and ledger lines for a date range: one job, the file lists exactly the range's rows`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = account();
  // A trade of its own, so the file has a trade row: a market buy that fills against the TEST book.
  const bought = await (
    await client(who)
  ).post('/api/v1/orders', { symbol: SYMBOL, type: 'market', side: 'buy', amount: '0.0002', clientOrderId: `${J}-mbuy-${Date.now()}` });
  expect(bought.status, JSON.stringify(bought.body).slice(0, 300)).toBeLessThan(300);
  // A statement that ends today ends at the last whole minute that has been over for a minute (the service lists only
  // settled time); wait until that end is past the trade, so the trade is inside the range.
  const placedAt = Date.now();
  const settledEnd = () => Math.floor((Date.now() - 60_000) / 60_000) * 60_000;
  await expect.poll(settledEnd, { timeout: 130_000, intervals: [1000] }).toBeGreaterThan(placedAt);

  await signIn(page, who);
  await page.goto(deskPath(SYMBOL));
  await page.getByRole('tab', { name: 'Ledger' }).click();
  await page.getByRole('button', { name: 'Statement…' }).click();
  const box = page.getByRole('alertdialog').filter({ hasText: 'Download a statement' });
  const today = new Date().toISOString().slice(0, 10);
  await box.getByLabel('From').fill(today);
  await box.getByLabel('To (included)').fill(today);
  const asks = [];
  page.on('response', (r) => {
    if (r.url().endsWith('/api/v1/statements') && r.request().method() === 'POST') asks.push(r);
  });
  await box.getByRole('button', { name: 'Make statement' }).click();
  const ready = box.getByText(/^Ready: \d+ orders, \d+ trades and \d+ balance changes\. Statement [0-9a-f-]{36}\.$/);
  await expect(ready).toBeVisible({ timeout: 30_000 });
  // Asking again from the same dialog is the same job, not a second file.
  await box.getByRole('button', { name: 'Make statement' }).click();
  await expect.poll(() => asks.length).toBe(2);
  const [first, second] = await Promise.all(asks.map((r) => r.json()));
  expect(second.id).toBe(first.id);
  expect(second.sha256).toBe(first.sha256);
  const job = first;
  expect(job).toMatchObject({ status: 'finished', from: `${today}T00:00:00.000Z` });

  // The file the desk saves is the one the job fingerprinted.
  const download = page.waitForEvent('download');
  await box.getByRole('button', { name: 'Download' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe(`statement-${today}-${today}.csv`);
  const text = await new Promise((resolve, reject) => {
    saved.createReadStream().then((stream) => {
      const parts = [];
      stream.on('data', (chunk) => parts.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      stream.on('error', reject);
    }, reject);
  });
  const { createHash } = await import('node:crypto');
  expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(job.sha256);
  await expect(box.getByText(`Saved statement-${today}-${today}.csv.`)).toBeVisible();

  // Exactly the range's rows: every order placed, trade filled and ledger line posted in [from, to), and nothing else.
  const from = Date.parse(job.from);
  const to = Date.parse(job.to);
  const inRange = (at) => at >= from && at < to;
  const rows = parseCsv(text);
  const ids = (record) =>
    rows
      .filter((r) => r.record === record)
      .map((r) => r.id)
      .sort();
  const orders = (await allOrders(who))
    .filter((o) => inRange(o.timestamp))
    .map((o) => o.id)
    .sort();
  const trades = (await (await client(who)).get('/api/v1/account/trades?limit=500')).body
    .filter((f) => inRange(f.timestamp))
    .map((f) => f.id)
    .sort();
  const lines = (await ledgerLines(who))
    .filter((l) => inRange(l.timestamp))
    .map((l) => l.id)
    .sort();
  expect(ids('order')).toEqual(orders);
  expect(ids('trade')).toEqual(trades);
  expect(ids('ledger')).toEqual(lines);
  expect(ids('order')).toContain(bought.body.id);
  expect(ids('trade').length).toBeGreaterThan(0);
  expect(job.rows).toEqual({ orders: orders.length, trades: trades.length, ledger: lines.length });
});

test(`${J} #6 opens ledger history: every balance change with its ledger reference, adding up to the balances`, async ({ page }) => {
  test.setTimeout(90_000);
  const who = account();
  await signIn(page, who);
  await page.goto(deskPath(SYMBOL));
  await page.getByRole('tab', { name: 'Ledger' }).click();
  const table = page.getByRole('table', { name: 'Ledger history' });
  await expect(table).toBeVisible({ timeout: 15_000 });
  // Read every page.
  const older = page.getByRole('button', { name: 'Show older' });
  while (await older.isVisible()) await older.click();
  const totals = page.getByRole('table', { name: 'Ledger totals' });
  await expect(totals).toBeVisible();

  // Every line the ledger holds for this account is listed, with its own ledger reference.
  const lines = await ledgerLines(who);
  const shown = await table
    .locator('tbody tr')
    .evaluateAll((trs) =>
      trs.map((tr) => ({ id: tr.getAttribute('data-entry'), ref: tr.querySelector('[data-testid="dk-ledger-ref"]')?.textContent?.trim() })),
    );
  expect(shown).toEqual(lines.map((l) => ({ id: l.id, ref: l.referenceId })));

  // Each asset's lines add up to its available balance, and the desk says so.
  const balances = await (await client(who)).balances();
  const assets = [...new Set(lines.map((l) => l.currency))];
  expect(assets.length).toBeGreaterThan(0);
  for (const asset of assets) {
    const row = totals.locator(`tr[data-asset="${asset}"]`);
    await expect(row).toContainText('Matches your balance');
    expect(balances[asset]).toBeDefined();
  }
});
