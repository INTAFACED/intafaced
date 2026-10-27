import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { api, fund, fromUnits, journeyState, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { p2p, readyTaker, testPasskey, verifiedName } from './p2p.mjs';

// J-p2p-18, in the running app (docs/roadmap/journeys.json): I export my P2P order history and keep a receipt. One test
// per step, titled "J-p2p-18 #<n>", run in order on one verified TEST account. The journey starts "signed in with a few
// hundred TEST orders in every status": #1 makes them through svc-p2p's own doors, with a second TEST trader selling to
// this person from a TEST ad paid by the stack's TEST bank transfer method (`local-test-gates.mjs p2p`). Fiat never moves;
// the coins move through the ledger's escrow. The stack's export caps and receipt quotas are the labelled TEST profile
// values (tooling/profiles/test-owner-values.json): 90 days per file, 20 receipts a day.
const J = 'J-p2p-18';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const METHOD = 'test-bank-transfer';
// How many orders the person starts with, by what happens to each. In-progress orders are paid (fiat_sent): an unpaid
// one would time out during the journey (the stack's payment window is 180 s) and change the counts under the test.
const MADE = { completed: 120, cancelled: 70, paid: 12, disputed: 6 };
const PAGE = 50;
const MAX_RANGE_DAYS = 90;
const RECEIPTS_A_DAY = 20;

test.describe.configure({ mode: 'default' });

// The stack must have the TEST payment method this journey's ad uses; `local-test-gates.mjs apply` registers it.
test.beforeAll(() => {
  tool('local-test-gates.mjs', 'p2p');
});

function journey() {
  const state = run.read();
  if (!state.buyer) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return state;
}

const ordersTable = (page) => page.getByRole('region', { name: 'Your P2P orders' });
const orderRows = (page) => ordersTable(page).locator('tbody tr');

test('J-p2p-18 #1 the order list counts every order exactly, pages back to the oldest, and labels a timeout', async ({ page }) => {
  test.setTimeout(480_000);
  // The other trader: a verified seller with TEST USDT, a saved TEST bank transfer, and a sell ad.
  const seller = await signUp(page, 'p2p18s');
  await verify(page, seller);
  const total = MADE.completed + MADE.cancelled + MADE.paid + MADE.disputed + 1;
  expect(fund(seller.email, 'USDT', String(total * 2)).tx).toBeTruthy();
  const buyer = await signUp(page, 'p2p18b');
  await verify(page, buyer);
  run.reset({ seller, buyer });
  const sellerSession = await api(seller);
  // The seller confirms releases with a TEST passkey (P-trade-orders-07); one confirmation covers ten minutes of them.
  const s = p2p(sellerSession, await testPasskey(sellerSession));
  // The buyer meets every take requirement: email confirmed by the sign-up code.
  const b = await readyTaker(await api(buyer), buyer);
  await s.mutate('instruments.create', {
    instrumentId: randomUUID(),
    methodId: METHOD,
    country: 'DE',
    fiatCurrency: 'EUR',
    label: 'TEST account',
    details: { account_holder: await verifiedName(sellerSession, seller), iban: 'DE89370400440532013000' },
  });
  const offer = await s.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: '0.92',
    minAmount: '1',
    maxAmount: '2',
    totalAmount: String(total * 2),
    methods: [METHOD],
    idempotencyKey: `${J}:offer:${seller.handle}`,
  });

  // Each order: 1 or 2 USDT, so the export totals add up to something a recomputation can miss.
  const made = [];
  const take = async (n) => {
    const trade = await b.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: n % 2 ? '1' : '2', method: METHOD });
    expect(trade.status).toBe('escrowed');
    made.push(trade);
    return trade;
  };
  // The oldest order: taken first and never paid, so the payment window runs out and svc-p2p's sweeper cancels it.
  const timedOut = await take(0);
  let n = 1;
  for (let i = 0; i < MADE.completed; i++) {
    const trade = await take(n++);
    await b.mutate('trades.markFiatSent', { tradeId: trade.id });
    expect((await s.mutate('trades.confirmReceived', { tradeId: trade.id })).status).toBe('released');
  }
  // The buyer cancels two before payment and the seller the rest: three of the buyer's own within a day would pause
  // their buying (the TEST profile's limit) before the orders below are placed.
  for (let i = 0; i < MADE.cancelled; i++) {
    const trade = await take(n++);
    const by = i < 2 ? b : s;
    expect((await by.mutate('trades.cancel', { tradeId: trade.id, reason: 'TEST changed my mind' })).status).toBe('cancelled');
  }
  for (let i = 0; i < MADE.paid; i++) {
    const trade = await take(n++);
    expect((await b.mutate('trades.markFiatSent', { tradeId: trade.id })).status).toBe('fiat_sent');
  }
  const disputed = [];
  for (let i = 0; i < MADE.disputed; i++) {
    const trade = await take(n++);
    await b.mutate('trades.markFiatSent', { tradeId: trade.id });
    await b.mutate('disputes.open', { tradeId: trade.id, reason: 'TEST the seller has not released' });
    disputed.push(trade.id);
  }
  const counts = { in_progress: MADE.paid, in_dispute: MADE.disputed, completed: MADE.completed, cancelled: MADE.cancelled + 1 };
  const sum = (key) => fromUnits(made.reduce((acc, trade) => acc + toUnits(trade[key]), 0n));
  run.write({
    made: made.map((t) => t.id),
    timedOut: timedOut.id,
    disputed,
    counts,
    total,
    amount: sum('amount'),
    fiatAmount: sum('fiatAmount'),
  });

  // Wait for the payment window (180 s on the stack) and the next sweep to cancel the unpaid order.
  await expect
    .poll(async () => (await b.query('trades.get', { tradeId: timedOut.id })).status, { timeout: 300_000, intervals: [5_000] })
    .toBe('cancelled');

  await signIn(page, buyer);
  await page.goto('/uc/order');
  const filters = page.getByTestId('order-filters');
  await expect(filters.getByRole('button', { name: `All (${total})` })).toBeVisible();
  await expect(filters.getByRole('button', { name: `Active (${counts.in_progress})` })).toBeVisible();
  await expect(filters.getByRole('button', { name: `Disputed (${counts.in_dispute})` })).toBeVisible();
  await expect(filters.getByRole('button', { name: `Completed (${counts.completed})` })).toBeVisible();
  await expect(filters.getByRole('button', { name: `Cancelled (${counts.cancelled})` })).toBeVisible();
  await expect(page.getByText('Counts are all your orders, from the service.')).toBeVisible();

  // Page back to the oldest: every order once, newest first, ending at the one that timed out.
  await expect(orderRows(page)).toHaveCount(PAGE);
  for (let shown = PAGE; shown < total; shown = Math.min(total, shown + PAGE)) {
    await page.getByRole('button', { name: 'Load older orders' }).click();
    await expect(orderRows(page)).toHaveCount(Math.min(total, shown + PAGE));
  }
  await expect(page.getByText('That is your oldest order in this view.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load older orders' })).toHaveCount(0);
  await expect(page.getByText(`Showing ${total} of ${total}`)).toBeVisible();
  const ids = await orderRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-order')));
  expect(new Set(ids).size).toBe(total);
  expect(ids.at(-1)).toBe(timedOut.id);
  await expect(orderRows(page).last()).toContainText('Cancelled: payment time ran out');

  // The dispute tab holds exactly the disputed orders.
  await filters.getByRole('button', { name: `Disputed (${counts.in_dispute})` }).click();
  await expect(orderRows(page)).toHaveCount(MADE.disputed);
  const inDispute = await orderRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-order')));
  expect(inDispute.sort()).toEqual([...disputed].sort());
  for (const row of await orderRows(page).all()) await expect(row).toContainText('In dispute');
});

test('J-p2p-18 #2 an export over the range cap is refused, and a valid range saves a file that matches the orders', async ({ page }) => {
  const state = journey();
  await signIn(page, state.buyer);
  await page.goto('/uc/order');
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('From (UTC day)').fill(day(-MAX_RANGE_DAYS - 5));
  await page.getByLabel('To (UTC day)').fill(day(0));
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await expect(page.getByRole('alert')).toContainText(`Choose at most ${MAX_RANGE_DAYS} days per file.`);

  await page.getByLabel('From (UTC day)').fill(day(-1));
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
  const lines = readFileSync(await download.path(), 'utf8')
    .trim()
    .split('\n');
  const header = lines[0].split(',');
  const rows = lines.slice(1).map((line) => Object.fromEntries(line.split(',').map((cell, i) => [header[i], cell])));
  // One row per order this person has, each once, and the totals the file's own rows add up to.
  expect(rows).toHaveLength(state.total);
  expect(new Set(rows.map((row) => row.tradeId))).toEqual(new Set(state.made));
  const add = (key) => fromUnits(rows.reduce((acc, row) => acc + toUnits(row[key]), 0n));
  expect(add('amount')).toBe(state.amount);
  expect(add('fiatAmount')).toBe(state.fiatAmount);
  const summary = page.getByTestId('order-export');
  await expect(summary).toContainText(`${state.total} orders`);
  await expect(summary).toContainText(`${state.amount} USDT for ${state.fiatAmount} EUR`);
});

test('J-p2p-18 #3 a completed order has a receipt, an open one does not, and the daily quota says when it resets', async ({ page }) => {
  const state = journey();
  const b = p2p(await api(state.buyer));
  const completed = [];
  for (const id of state.made) {
    if (completed.length > RECEIPTS_A_DAY) break;
    if ((await b.query('trades.get', { tradeId: id })).status === 'released') completed.push(id);
  }
  await signIn(page, state.buyer);
  await page.goto(`/uc/order?tradeId=${completed[0]}`);
  await page.getByRole('button', { name: 'Get receipt' }).click();
  const receipt = page.getByTestId('order-receipt');
  await expect(receipt).toContainText(completed[0]);
  await expect(receipt).toContainText('Buyer');
  await expect(receipt).toContainText(`You can get ${RECEIPTS_A_DAY - 1} more receipts today`);
  const [download] = await Promise.all([page.waitForEvent('download'), receipt.getByRole('button', { name: 'Download receipt' }).click()]);
  expect(readFileSync(await download.path(), 'utf8')).toContain(completed[0]);

  // An order still open: the page says why there is none, and the service refuses one by name.
  const open = state.disputed[0];
  await page.goto(`/uc/order?tradeId=${open}`);
  await expect(page.getByText('A receipt is available once the order is completed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Get receipt' })).toHaveCount(0);
  const refused = await b.raw.mutate('trades.receipt', { tradeId: open });
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body)).toContain('p2p.receipt_not_available');

  // Use up the day's receipts on other completed orders, then ask once more in the app.
  for (const id of completed.slice(1, RECEIPTS_A_DAY)) await b.mutate('trades.receipt', { tradeId: id });
  await page.goto(`/uc/order?tradeId=${completed[RECEIPTS_A_DAY]}`);
  await page.getByRole('button', { name: 'Get receipt' }).click();
  await expect(page.getByRole('alert')).toContainText('You have used today’s receipts. You can get more from');
  await expect(page.getByTestId('order-receipt')).toHaveCount(0);
});
