import { test, expect } from '@playwright/test';
import { api, bestPrices, fromUnits, fund, journeyState, toUnits } from './stack.mjs';
import { awayBid, confirm, free, fundedTrader, held, openDesk, openOrders, placements, previewed, reviewSheet } from './desk.mjs';

// J-cex-spot-03, in the running app (docs/roadmap/journeys.json): market orders and every time in force do exactly what
// the review said. One test per step, titled "J-cex-spot-03 #<n>", run in order on one TEST account funded with TEST
// USDT through the real ledger. The resting sells are the TEST market maker's; nothing is stood in for.
const J = 'J-cex-spot-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const FUNDED = '60000';

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

const buyForm = (page) => page.locator('form[data-testid="dk-form"][data-side="buy"]');
const sellForm = (page) => page.locator('form[data-testid="dk-form"][data-side="sell"]');
const tab = (page, name) => page.locator('[role=tab]', { hasText: new RegExp(`^${name}$`) });

async function pickTif(page, label) {
  await page.getByRole('combobox', { name: 'Time in force' }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

/** The desk's own order check for the next change the person makes; returns its body. */
async function checkOf(page, act) {
  const answer = page.waitForResponse((r) => r.url().includes('/api/v1/orders/preview') && r.request().method() === 'POST');
  await act();
  const res = await answer;
  expect(res.status()).toBe(200);
  return res.json();
}

/** A local "date and time" field value for `ms`, as the person would type it. */
function localField(ms) {
  const at = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A limit buy on the buy form with the picked time in force, reviewed and confirmed. Returns the order body sent. */
async function limitBuy(page, { tif, price, amount }) {
  const sent = placements(page);
  await tab(page, 'Limit').click();
  await pickTif(page, tif);
  await buyForm(page).getByRole('textbox', { name: 'Price' }).fill(price);
  await previewed(page, () => buyForm(page).getByRole('textbox', { name: 'Amount' }).fill(amount));
  await buyForm(page).getByRole('button', { name: 'Buy BTC' }).click();
  await expect(reviewSheet(page)).toContainText(tif);
  await confirm(page, 'buy');
  await expect.poll(() => sent.length).toBe(1);
  return sent[0];
}

test(`${J} #1 types a spend for a market buy: the amount is sized so the hold stays within the spend`, async ({ page }) => {
  const who = await fundedTrader(page, 'js3', FUNDED);
  run.reset({ account: who });
  await openDesk(page, who);
  await tab(page, 'Market').click();
  const spend = buyForm(page).getByRole('textbox', { name: 'Spend' });
  await expect(spend).toBeEditable();
  const check = await checkOf(page, () => spend.fill('100'));
  const amount = await buyForm(page).getByRole('textbox', { name: 'Amount' }).inputValue();
  expect(amount).not.toBe('');
  expect(check.holdAsset).toBe('USDT');
  expect(toUnits(check.holdAmount)).toBeGreaterThan(0n);
  expect(toUnits(check.holdAmount)).toBeLessThanOrEqual(toUnits('100'));
  // Leaving the market order drops the typed spend.
  await tab(page, 'Limit').click();
  await expect(buyForm(page).getByRole('textbox', { name: 'Total' })).not.toHaveValue('100');
});

test(`${J} #2 reviews the market buy: the fee and the price protection show first, and the unused hold comes back`, async ({ page }) => {
  const who = account();
  const before = await (await api(who)).balances();
  await openDesk(page, who);
  await tab(page, 'Market').click();
  await previewed(page, () => buyForm(page).getByRole('textbox', { name: 'Spend' }).fill('100'));
  await buyForm(page).getByRole('button', { name: 'Buy BTC' }).click();
  const review = reviewSheet(page);
  await expect(review).toContainText('Price protection');
  await expect(review).toContainText(/You won.t pay more than [\d,.]+ USDT per BTC/);
  await expect(review).toContainText(/Fee/);
  await confirm(page, 'buy');
  await expect(buyForm(page)).toContainText(/Your buy order filled/);
  const after = await (await api(who)).balances();
  const spent = toUnits(before.USDT.total) - toUnits(after.USDT.total);
  expect(spent).toBeGreaterThan(0n);
  expect(spent).toBeLessThanOrEqual(toUnits('100'));
  // The protection hold is released once: nothing stays held.
  expect(held(after, 'USDT')).toBe(0n);
  expect(toUnits(after.BTC?.total ?? '0')).toBeGreaterThan(toUnits(before.BTC?.total ?? '0'));
});

test(`${J} #3 asks for a market sell: offered where the protection is published, and it fills no lower than it`, async ({ page }) => {
  const who = account();
  const before = await (await api(who)).balances();
  const amount = '0.0005';
  expect(free(before, 'BTC')).toBeGreaterThanOrEqual(toUnits(amount));
  await openDesk(page, who);
  await tab(page, 'Market').click();
  await previewed(page, () => sellForm(page).getByRole('textbox', { name: 'Amount' }).fill(amount));
  await expect(sellForm(page).getByRole('button', { name: 'Sell BTC' })).toBeEnabled();
  await sellForm(page).getByRole('button', { name: 'Sell BTC' }).click();
  const review = reviewSheet(page);
  await expect(review).toContainText('Price protection');
  await expect(review).toContainText(/You won.t sell for less than [\d,.]+ USDT per BTC/);
  const floor = toUnits(/less than ([\d,.]+) USDT/.exec(await review.innerText())[1].replaceAll(',', ''));
  await confirm(page, 'sell');
  await expect(sellForm(page)).toContainText(/Your sell order filled/);
  const after = await (await api(who)).balances();
  expect(toUnits(before.BTC.total) - toUnits(after.BTC.total)).toBe(toUnits(amount));
  // Proceeds after the fee are at least the floor's value less the taker fee; never below the protection.
  const got = toUnits(after.USDT.total) - toUnits(before.USDT.total);
  expect(got * 100n).toBeGreaterThan(((floor * toUnits(amount)) / toUnits('1')) * 99n);
  expect(held(after, 'BTC')).toBe(0n);
});

test(`${J} #4 sends an immediate-or-cancel buy with nothing to match: nothing traded, no hold left`, async ({ page }) => {
  const who = account();
  const before = await (await api(who)).balances();
  await openDesk(page, who);
  const sent = await limitBuy(page, { tif: 'Immediate or cancel', price: await awayBid(90), amount: '0.001' });
  expect(sent).toMatchObject({ type: 'limit', timeInForce: 'IOC', postOnly: false });
  await expect(buyForm(page)).toContainText('Nothing filled');
  expect(await openOrders(who)).toHaveLength(0);
  const after = await (await api(who)).balances();
  expect(held(after, 'USDT')).toBe(0n);
  expect(after.USDT.total).toBe(before.USDT.total);
});

test(`${J} #5 sends a fill-or-kill buy bigger than the book: nothing fills, the resting sells stay`, async ({ page }) => {
  const who = account();
  const { ask, body } = await bestPrices();
  // Every sell at or under the best ask's price, plus every sell the depth read returns (the TEST ladder is a few levels
  // a side), and one lot more. The TEST market maker places its new ladder before it cancels the old one, so for a
  // moment both rest and the new one can put a whole ladder at or under this ask; even then the book cannot fill this.
  const atAsk = body.asks.filter(([p]) => toUnits(p) <= toUnits(ask)).reduce((sum, [, size]) => sum + toUnits(size), 0n);
  const allAsks = body.asks.reduce((sum, [, size]) => sum + toUnits(size), 0n);
  const amount = fromUnits(atAsk + allAsks + toUnits('0.001'));
  // The hold must fit, or the order is refused for funds and never reaches the fill-or-kill rule this step is about.
  const cost = (toUnits(ask) * toUnits(amount)) / toUnits('1');
  const freeUsdt = toUnits((await (await api(who)).balances()).USDT.free);
  if (cost > freeUsdt) fund(who.email, 'USDT', fromUnits(((cost - freeUsdt) / toUnits('1')) * toUnits('1') + toUnits('100')));
  const before = await (await api(who)).balances();
  await openDesk(page, who);
  const sent = await limitBuy(page, { tif: 'Fill or kill', price: ask, amount });
  expect(sent).toMatchObject({ type: 'limit', timeInForce: 'FOK', postOnly: false });
  await expect(buyForm(page)).toContainText('Fill-or-kill order not placed');
  await expect(buyForm(page)).toContainText('nothing was traded');
  const after = await (await api(who)).balances();
  expect(after.USDT.total).toBe(before.USDT.total);
  expect(after.BTC?.total).toBe(before.BTC?.total);
  expect(held(after, 'USDT')).toBe(0n);
  expect((await bestPrices()).body.asks.length).toBeGreaterThan(0);
});

test(`${J} #6 sends a post-only buy that would cross, then one that rests`, async ({ page }) => {
  const who = account();
  const before = await (await api(who)).balances();
  const { ask } = await bestPrices();
  const crossing = fromUnits(((toUnits(ask) * 101n) / 100n / toUnits('1')) * toUnits('1'));
  await openDesk(page, who);
  await limitBuy(page, { tif: 'Post only', price: crossing, amount: '0.001' });
  await expect(buyForm(page)).toContainText('Post-only order not placed');
  await expect(buyForm(page)).not.toContainText('is done');
  expect(await openOrders(who)).toHaveLength(0);
  expect((await (await api(who)).balances()).USDT.total).toBe(before.USDT.total);

  const price = await awayBid(90);
  const sent = await limitBuy(page, { tif: 'Post only', price, amount: '0.001' });
  expect(sent).toMatchObject({ timeInForce: 'PO', postOnly: true });
  await expect(buyForm(page)).toContainText('Your buy order is in');
  const orders = await openOrders(who);
  expect(orders).toHaveLength(1);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe((toUnits(price) * toUnits('0.001')) / toUnits('1'));
  await tab(page, 'Open orders').click();
  await expect(page.getByTestId('dk-bottom-body').locator('table tbody tr').first()).toContainText('Post only');
  // Leave the book as it was: cancel the resting post-only order.
  expect((await (await api(who)).delete(`/api/v1/orders/${orders[0].id}?symbol=BTC%2FUSDT`)).status).toBeLessThan(300);
  await expect.poll(async () => held(await (await api(who)).balances(), 'USDT')).toBe(0n);
});

test(`${J} #7 picks good-till-date: a past time sends nothing; at the expiry the order shows expired and its hold comes back`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = account();
  await openDesk(page, who);
  const sent = placements(page);
  await tab(page, 'Limit').click();
  await pickTif(page, 'Good till date');
  const price = await awayBid(90);
  await buyForm(page).getByRole('textbox', { name: 'Price' }).fill(price);
  await buyForm(page).getByRole('textbox', { name: 'Amount' }).fill('0.001');
  const expires = page.getByLabel('Expires');
  await expires.fill(localField(Date.now() - 3600_000));
  await expect(page.getByText('Pick a time in the future.')).toBeVisible();
  await expect(buyForm(page).getByRole('button', { name: 'Buy BTC' })).toBeDisabled();

  // The next whole minute at least 60 seconds away: the field is to the minute.
  const at = Math.ceil((Date.now() + 60_000) / 60_000) * 60_000;
  await previewed(page, () => expires.fill(localField(at)));
  await buyForm(page).getByRole('button', { name: 'Buy BTC' }).click();
  const review = reviewSheet(page);
  await expect(review).toContainText('Good till date');
  await expect(review).toContainText('Expires');
  await confirm(page, 'buy');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ timeInForce: 'GTD', expireAt: new Date(at).toISOString() });
  const orders = await openOrders(who);
  expect(orders).toHaveLength(1);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe((toUnits(price) * toUnits('0.001')) / toUnits('1'));

  // At the expiry the order leaves the book on its own and the hold is released, once.
  await expect.poll(async () => (await openOrders(who)).length, { timeout: 150_000, intervals: [2000] }).toBe(0);
  expect(Date.now()).toBeGreaterThanOrEqual(at);
  await expect.poll(async () => held(await (await api(who)).balances(), 'USDT'), { timeout: 20_000 }).toBe(0n);
  const { status, body } = await (await api(who)).get(`/api/v1/orders/${orders[0].id}?symbol=BTC%2FUSDT`);
  expect(status).toBe(200);
  expect(body.status).toBe('expired');
  await page.reload();
  await tab(page, 'Order history').click();
  await expect(page.getByTestId('dk-bottom-body').locator('table tbody tr').first()).toContainText(/Expired/i);
});

test(`${J} #8 chooses the self-trade mode and crosses their own resting order: the resting one is cancelled, as chosen`, async ({
  page,
}) => {
  const who = account();
  const { bid, ask } = await bestPrices();
  // Between the book's bid and ask, so nobody else's order meets either of the person's two.
  const price = fromUnits(((toUnits(bid) + toUnits(ask)) / 2n / toUnits('0.01')) * toUnits('0.01'));
  const amount = '0.0005';
  await openDesk(page, who);
  await expect(page.getByRole('combobox', { name: 'If it meets my own order' })).toContainText('Cancel my resting order');
  await page.getByRole('combobox', { name: 'If it meets my own order' }).click();
  await expect(page.getByRole('option', { name: 'Cancel this order' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('option', { name: 'Cancel both orders' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  const resting = await limitBuy(page, { tif: 'Good till cancelled', price, amount });
  expect(resting).toMatchObject({ stpMode: 'cancel_maker' });
  const [own] = await openOrders(who);
  expect(own).toBeTruthy();

  // The sell at the same price meets the person's own buy: the buy is cancelled and the sell rests in its place.
  const sent = placements(page);
  await sellForm(page).getByRole('textbox', { name: 'Price' }).fill(price);
  await previewed(page, () => sellForm(page).getByRole('textbox', { name: 'Amount' }).fill(amount));
  await sellForm(page).getByRole('button', { name: 'Sell BTC' }).click();
  await expect(reviewSheet(page)).toContainText('Cancel my resting order');
  await confirm(page, 'sell');
  expect(sent[0]).toMatchObject({ side: 'sell', stpMode: 'cancel_maker' });
  const a = await api(who);
  await expect.poll(async () => (await a.get(`/api/v1/orders/${own.id}?symbol=BTC%2FUSDT`)).body.status).toBe('canceled');
  expect((await a.get(`/api/v1/orders/${own.id}?symbol=BTC%2FUSDT`)).body.rejectCode).toBe('self_trade_prevention');
  const open = await openOrders(who);
  expect(open.map((o) => o.side)).toEqual(['sell']);
  // Nothing traded with itself: no USDT is held, and the sell holds exactly its amount.
  const balances = await a.balances();
  expect(held(balances, 'USDT')).toBe(0n);
  expect(held(balances, 'BTC')).toBe(toUnits(amount));
  await tab(page, 'Order history').click();
  await expect(
    page.getByTestId('dk-bottom-body').locator('table tbody tr', { hasText: 'Cancelled: met your own order' }).first(),
  ).toBeVisible();

  // A mode the engine cannot do is refused by the service with its own code, and nothing is placed.
  const refused = await a.post('/api/v1/orders', {
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    amount,
    price,
    timeInForce: 'GTC',
    clientOrderId: `${J}-8-taker-${Date.now()}`,
    stpMode: 'cancel_taker',
  });
  expect(refused.status).toBe(400);
  expect(refused.body.intafacedCode).toBe('trade.stp_mode_unsupported');
  expect(await openOrders(who)).toHaveLength(1);
  expect((await a.delete(`/api/v1/orders/${open[0].id}?symbol=BTC%2FUSDT`)).status).toBeLessThan(300);
  await expect.poll(async () => held(await a.balances(), 'BTC')).toBe(0n);
});

test(`${J} #9 adds a tag and types the order in value: the tag shows on the order and in history, the value sizes the amount`, async ({
  page,
}) => {
  const who = account();
  const price = await awayBid(90);
  await openDesk(page, who);
  const sent = placements(page);
  await tab(page, 'Limit').click();
  await pickTif(page, 'Good till cancelled');
  await page.getByRole('textbox', { name: 'Tag' }).fill('j3-grid');
  await buyForm(page).getByRole('textbox', { name: 'Price' }).fill(price);
  // In value: the person types what to spend in USDT; the amount in BTC follows, rounded down to the lot.
  const check = await checkOf(page, () => buyForm(page).getByRole('textbox', { name: 'Total' }).fill('50'));
  const amount = await buyForm(page).getByRole('textbox', { name: 'Amount' }).inputValue();
  expect(toUnits(amount)).toBeGreaterThan(0n);
  expect(toUnits(check.holdAmount)).toBeLessThanOrEqual(toUnits('50'));
  await buyForm(page).getByRole('button', { name: 'Buy BTC' }).click();
  await expect(reviewSheet(page)).toContainText('j3-grid');
  await confirm(page, 'buy');
  expect(sent[0]).toMatchObject({ tag: 'j3-grid', amount, price });
  const [order] = await openOrders(who);
  expect(order.tag).toBe('j3-grid');
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(toUnits(check.holdAmount));
  await tab(page, 'Open orders').click();
  await expect(page.getByTestId('dk-bottom-body').locator('table tbody tr').first()).toContainText('j3-grid');
  // In coins: typing the amount leaves the total to follow.
  await buyForm(page).getByRole('textbox', { name: 'Amount' }).fill('0.001');
  await expect(buyForm(page).getByRole('textbox', { name: 'Total' })).not.toHaveValue('50');

  expect((await (await api(who)).delete(`/api/v1/orders/${order.id}?symbol=BTC%2FUSDT`)).status).toBeLessThan(300);
  await page.reload();
  await tab(page, 'Order history').click();
  await expect(page.getByTestId('dk-bottom-body').locator('table tbody tr', { hasText: 'j3-grid' }).first()).toContainText('Cancelled');
});
