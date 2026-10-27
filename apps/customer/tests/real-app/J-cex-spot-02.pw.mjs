import { test, expect } from '@playwright/test';
import { api, bestPrices, fromUnits, journeyState, otherTrader, times, toUnits, tool } from './stack.mjs';
import {
  awayBid,
  confirm,
  free,
  fundedTrader,
  held,
  openDesk,
  openOrders,
  placements,
  previewed,
  reviewLimit,
  reviewSheet,
} from './desk.mjs';

// J-cex-spot-02, in the running app (docs/roadmap/journeys.json): a retry, a lost answer or a double press never makes
// a second order or a second hold. One test per step, titled "J-cex-spot-02 #<n>", run in order on one TEST account
// funded with TEST 1000 USDT. Lost answers are made by the browser losing the service's reply (the order still reaches
// the real service) or the request itself; nothing else is stood in for.
const J = 'J-cex-spot-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const HALTED = 'ETH/USDT'; // step 8 halts this book, not the BTC one the other journeys trade

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** The ledger's USDT hold equals the open buys' price x amount on both markets this journey trades, so no order holds
 * twice and no hold is orphaned. Returns the BTC/USDT open orders. */
async function oneHoldPerOrder(who) {
  const orders = await openOrders(who);
  const all = [...orders, ...(await openOrders(who, HALTED))];
  const expected = all.reduce((sum, o) => sum + times(o.price, o.amount), 0n);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(expected);
  return orders;
}

/** Press Confirm once. The market maker requotes every few seconds, and the desk asks again when a fresh preview
 * differs from the one reviewed (step 7); then the person confirms the new numbers. Never more than three presses. */
async function confirmSend(page) {
  const button = page.getByRole('button', { name: 'Confirm buy' });
  for (let i = 0; i < 3; i++) {
    await button.click();
    await expect
      .poll(async () => (await button.count()) === 0 || (await page.getByText('The price, fee or amount we hold changed').count()) > 0)
      .toBe(true);
    if (!(await button.count())) return;
  }
  throw new Error('the review kept changing; nothing was sent');
}

/** Only the order send itself (POST /api/v1/orders); `how` decides what the browser gets back. */
async function onPlace(page, how) {
  await page.route(
    (url) => url.pathname === '/api/v1/orders',
    async (route) => (route.request().method() === 'POST' ? how(route) : route.continue()),
  );
}

test(`${J} #1 reviews and places a limit buy: one Open order carrying the client order id the desk minted`, async ({ page }) => {
  const who = await fundedTrader(page, 'js2', '1000');
  run.reset({ account: who });
  await openDesk(page, who);
  const sent = placements(page);
  const price = await awayBid(90);
  const review = await reviewLimit(page, 'buy', price, '0.001');
  const shownId = (await review.getByText('Client order ID').locator('..').getByTestId('client-order-id').innerText()).trim();
  expect(shownId).not.toBe('');
  await confirm(page, 'buy');
  expect(sent).toHaveLength(1);
  expect(sent[0].clientOrderId).toMatch(/^desk:/);
  expect(sent[0].clientOrderId.endsWith(`:${shownId}`)).toBe(true);
  const orders = await oneHoldPerOrder(who);
  expect(orders).toHaveLength(1);
  expect(orders[0].clientOrderId).toBe(sent[0].clientOrderId);
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
  await expect(page.locator('tr', { hasText: Number(price).toLocaleString('en-US', { minimumFractionDigits: 2 }) })).toBeVisible();
  run.write({ first: { id: orders[0].id, body: sent[0] } });
});

test(`${J} #2 presses Confirm twice, and the same draft is sent again: the same order comes back, one hold`, async ({ page }) => {
  const who = account();
  const { first } = run.read();
  await openDesk(page, who);
  const sent = placements(page);
  const price = await awayBid(89);
  await reviewLimit(page, 'buy', price, '0.001');
  await page.getByRole('button', { name: 'Confirm buy' }).dblclick();
  await expect(reviewSheet(page)).toHaveCount(0);
  await expect(page.getByText(/Your buy order is in/)).toBeVisible();
  // Every send of this draft carried the same client order id, and there is one new order.
  expect(new Set(sent.map((b) => b.clientOrderId)).size).toBe(1);
  let orders = await oneHoldPerOrder(who);
  expect(orders).toHaveLength(2);
  const holdBefore = held(await (await api(who)).balances(), 'USDT');
  // The connection retries step 1's draft: the service answers with the order it already has.
  const again = await (await api(who)).post('/api/v1/orders', first.body);
  expect(again.status).toBeLessThan(300);
  expect(again.body.id).toBe(first.id);
  orders = await oneHoldPerOrder(who);
  expect(orders).toHaveLength(2);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(holdBefore);
});

test(`${J} #3 loses the answer after Confirm: the desk looks the order up by client id and never sends it again`, async ({ page }) => {
  const who = account();
  await openDesk(page, who);
  const sent = placements(page);
  // The order reaches the service; its answer never reaches the browser.
  await onPlace(page, async (route) => {
    await route.fetch();
    await route.abort('connectionreset');
  });
  await reviewLimit(page, 'buy', await awayBid(88), '0.001');
  await confirmSend(page);
  await expect(page.getByText(/Checked: your order is (open|new)/i)).toBeVisible({ timeout: 30_000 });
  await page.unrouteAll({ behavior: 'wait' });
  expect(sent).toHaveLength(1);
  const orders = await oneHoldPerOrder(who);
  expect(orders).toHaveLength(3);
  expect(orders.filter((o) => o.clientOrderId === sent[0].clientOrderId)).toHaveLength(1);
  // The marker that guarded the unknown answer is gone.
  expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('trade-pending:')))).toBe(false);
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
});

test(`${J} #4 reloads while an answer is unknown: new orders wait, in words, until the earlier one is settled`, async ({ page }) => {
  const who = account();
  await openDesk(page, who);
  const sent = placements(page);
  // This time the send itself is lost: the service never sees it.
  await onPlace(page, (route) => route.abort('connectionreset'));
  const price = await awayBid(87);
  await reviewLimit(page, 'buy', price, '0.001');
  await confirmSend(page);
  const notice = page.getByTestId('dk-note--warn');
  await expect(notice).toContainText('Checking your order…');
  await page.unrouteAll({ behavior: 'wait' });
  await page.reload();
  await expect(notice).toContainText('Checking your order…');
  await expect(notice).toContainText('You can’t place another order until this is settled');
  // A new order waits.
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  await page
    .getByRole('textbox', { name: 'Price' })
    .first()
    .fill(await awayBid(86));
  await page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001');
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  await notice.getByRole('button', { name: 'Check order' }).click();
  await expect(notice).toContainText('It may still arrive');
  expect(await openOrders(who)).toHaveLength(3);
  // The person sends the SAME order again, once: it is placed once.
  await notice.getByRole('button', { name: 'Send the same order again' }).click();
  await expect(page.getByText(/Done: your order is/)).toBeVisible();
  await expect(notice).toHaveCount(0);
  expect(sent.length).toBeGreaterThanOrEqual(2);
  expect(new Set(sent.map((b) => b.clientOrderId)).size).toBe(1);
  const orders = await oneHoldPerOrder(who);
  expect(orders).toHaveLength(4);
  expect(orders.filter((o) => o.clientOrderId === sent[0].clientOrderId)).toHaveLength(1);
});

test(`${J} #5 sends the same client id with a different price: refused with a typed reason, nothing changes`, async () => {
  const who = account();
  const { first } = run.read();
  const before = await oneHoldPerOrder(who);
  const holdBefore = held(await (await api(who)).balances(), 'USDT');
  const other = fromUnits(toUnits(first.body.price) - toUnits('1'));
  const refused = await (await api(who)).post('/api/v1/orders', { ...first.body, price: other });
  expect(refused.status).toBe(409);
  expect(JSON.stringify(refused.body)).toContain('trade.client_order_id_conflict');
  const after = await oneHoldPerOrder(who);
  expect(after).toHaveLength(before.length);
  expect(after.find((o) => o.id === first.id)?.price).toBe(before.find((o) => o.id === first.id)?.price);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(holdBefore);
});

test(`${J} #6 types an order bigger than the balance: refused in words before Confirm, nothing sent`, async ({ page }) => {
  const who = account();
  await openDesk(page, who);
  const sent = placements(page);
  const price = await awayBid(90);
  const freeNow = free(await (await api(who)).balances(), 'USDT');
  // One whole BTC at ~90% of the market is far above what is free.
  expect(times(price, '1')).toBeGreaterThan(freeNow);
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  await page.getByRole('textbox', { name: 'Price' }).first().fill(price);
  await page.getByRole('textbox', { name: 'Amount' }).first().fill('1');
  const form = page.locator('form[data-testid="dk-form"][data-side="buy"]');
  await expect(form).toContainText('Not enough USDT');
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  await expect(form).not.toContainText(/[a-z]+\.[a-z_]+_[a-z_]+/); // no raw code
  await page.waitForTimeout(1000);
  expect(sent).toHaveLength(0);
  expect(await oneHoldPerOrder(who)).toHaveLength(4);
});

test(`${J} #7 the numbers change between Review and Confirm: the new numbers show and nothing is sent`, async ({ page }) => {
  const who = account();
  await openDesk(page, who);
  const sent = placements(page);
  await page.locator('[role=tab]', { hasText: /^Market$/ }).click();
  await previewed(page, () => page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001'));
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  const review = reviewSheet(page);
  await expect(review).toContainText(/Price protection/);
  // Another TEST trader offers below the best ask after the review opened, so the price this buy protects moves.
  const { ask, bid } = await bestPrices();
  const inside = fromUnits(((toUnits(ask) + toUnits(bid)) / 2n / toUnits('0.01')) * toUnits('0.01'));
  const other = await api(otherTrader());
  const offer = await other.post('/api/v1/orders', {
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'sell',
    amount: '0.0005',
    price: inside,
    timeInForce: 'GTC',
    clientOrderId: `${J}-7-${Date.now()}`,
  });
  expect(offer.status).toBeLessThan(300);
  try {
    await review.getByRole('button', { name: 'Confirm buy' }).click();
    await expect(review).toContainText('The price, fee or amount we hold changed');
    expect(sent).toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(review).toHaveCount(0);
    expect(sent).toHaveLength(0);
  } finally {
    await other.delete(`/api/v1/orders/${offer.body.id}?symbol=BTC%2FUSDT`);
  }
  expect(await oneHoldPerOrder(who)).toHaveLength(4);
});

test(`${J} #8 an operator halts a market: a new order is refused with the halted state, and Cancel still works`, async ({ page }) => {
  const who = account();
  await openDesk(page, who, HALTED);
  const price = await awayBid(90, HALTED);
  // Taken now: while the book is halted, the market maker's new quotes are refused and its old ones come down.
  const next = await awayBid(89, HALTED);
  await reviewLimit(page, 'buy', price, '0.01', 'ETH');
  await confirm(page, 'buy');
  const before = (await openOrders(who, HALTED)).map((o) => o.id);
  const resting = (await openOrders(who, HALTED)).find((o) => o.price === price || Number(o.price) === Number(price));
  expect(resting).toBeTruthy();
  let halted = false;
  try {
    tool('local-test-gates.mjs', 'halt', HALTED);
    halted = true;
    const sent = placements(page);
    await page.reload();
    await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
    await page.getByRole('textbox', { name: 'Price' }).first().fill(next);
    await page.getByRole('textbox', { name: 'Amount' }).first().fill('0.01');
    // The halt is said in words before Confirm, from the desk's own preview; nothing is sent and nothing rests.
    const form = page.locator('form[data-testid="dk-form"][data-side="buy"]');
    await expect(form).toContainText('Trading is halted');
    await expect(form).toContainText('you can still cancel them');
    await expect(form).not.toContainText(/[a-z]+\.[a-z_]+_[a-z_]+/); // no raw code
    await expect(page.getByRole('button', { name: 'Buy ETH' })).toBeDisabled();
    await page.waitForTimeout(1000);
    expect(sent).toHaveLength(0);
    expect((await openOrders(who, HALTED)).map((o) => o.id).sort()).toEqual([...before].sort());
    // Cancel on the earlier order still works, and releases its hold once.
    await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
    const row = page.locator('tr', { hasText: Number(price).toLocaleString('en-US', { minimumFractionDigits: 2 }) });
    await row
      .getByRole('button', { name: /Cancel/ })
      .first()
      .click();
    // Only a confirm dialog's button: the desk's "Cancel orders…" control also reads "cancel order".
    const sure = page.getByRole('dialog').getByRole('button', { name: /cancel order|yes|confirm/i });
    if (await sure.count()) await sure.first().click();
    await expect(row).toHaveCount(0);
    expect((await openOrders(who, HALTED)).map((o) => o.id)).not.toContain(resting.id);
  } finally {
    // Always try to resume: the halt may have gone through even if the tool then failed.
    try {
      tool('local-test-gates.mjs', 'resume', HALTED);
    } catch (err) {
      if (halted) throw err;
    }
  }
  // The cancel released its hold once: what is held is exactly what is still open.
  expect(await oneHoldPerOrder(who)).toHaveLength(4);
});
