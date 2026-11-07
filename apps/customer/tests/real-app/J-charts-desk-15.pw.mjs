// World: book, gates
import { test, expect } from './journey.mjs';
import { api, bestPrices, fromUnits, times, toUnits, tool } from './stack.mjs';
import { fundedTrader, held, openOrders, placements, signIn } from './desk.mjs';

// J-charts-desk-15 "I place and move orders from the chart itself", in the running app. Independent tests (OWNER 212):
// written from the step's own words by someone other than the builder, one test per step, titled "J-charts-desk-15 #<n>".
// The steps run in order in one signed-in browser, on one TEST account funded with TEST 1000 USDT, on the BTC/USDT
// chart (an open market). Step 6 halts the ETH/USDT book and resumes it after.
//
// The money lines, each checked where its step does it:
// - an order is held only on confirm (#1 and #3: nothing is held, or exists, before Confirm);
// - a re-price cancels the old order, its hold released once, and holds the new one under a key that is the same on
//   every retry (#4: the browser's own replace request, sent again, answers with the same one replacement and one hold);
// - a drag past the protection distance asks first (#5: nothing is sent, not even a check, before the person answers).
//
// Prices on the chart come from the chart itself: the price-axis plus button names the price under the pointer, so two
// readings give the chart's price-to-pixel line, and a drag goes to the pixel of the price wanted.
const J = 'J-charts-desk-15';
const BOOK = 'BTC/USDT';
const CHART = '/charts/BTC-USDT';
const HALTED = 'ETH/USDT';
const AMOUNT = '0.001';
const FUNDED = '1000';

test.describe.configure({ mode: 'serial' });

let page;
let who;
let previewStyle; // the preview line's border style in #1, which an order's line in #3 must not share
let order; // the order #3 placed, then the replacement #4 made, as the service holds it

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 2200 } });
  page = await context.newPage();
  who = await fundedTrader(page, 'ijcd15', FUNDED);
});
test.afterAll(async () => {
  await page?.context().close();
});

const chart = () => page.getByTestId('cw');
const host = () => chart().getByTestId('wc-host');
const bar = () => chart().getByTestId('chart-trading');
const orderOnChart = () => bar().getByRole('button', { name: 'Order on chart' });
const ticket = () => page.getByRole('form', { name: 'Order from the chart' });
const priceField = () => ticket().getByLabel(/Limit price/);
const amountField = () => ticket().getByLabel(/Amount/);
const previewLine = () => page.getByTestId('chart-preview-line');
const orderLines = () => page.getByTestId('chart-order-line');
const plus = () => page.getByTestId('chart-axis-plus');
const orderMenu = () => page.getByRole('menu', { name: 'Order at this price' });
const reviewOrder = () => page.getByRole('dialog', { name: 'Review order' });
const reviewMove = () => page.getByRole('dialog', { name: 'Review the replacement' });
const protectionAsk = () => page.getByRole('alertdialog', { name: 'Beyond the protection distance' });
const note = () => page.getByTestId('chart-trading-note');

/** A whole-USDT price at `percent` of the best bid: a buy there rests, below the market. */
async function belowBid(percent, symbol = BOOK) {
  const { bid } = await bestPrices(symbol);
  const one = toUnits('1');
  return fromUnits(((toUnits(bid) * BigInt(Math.round(percent * 100))) / 10_000n / one) * one);
}

async function lastPrice(symbol = BOOK) {
  const { status, body } = await (await api(who)).get(`/api/v1/ticker/${encodeURIComponent(symbol)}`);
  expect(status).toBe(200);
  return Number(body.last ?? body.close);
}

/** The owner's protection distance for the market, in percent, as the service publishes it to the chart. */
async function protectionPercent(symbol = BOOK) {
  const { status, body } = await (await api(who)).get(`/api/v1/charts/owner-values?symbol=${encodeURIComponent(symbol)}`);
  expect(status).toBe(200);
  expect(body.orderProtectionBps, 'the protection distance is set on the test stack').toEqual(expect.any(Number));
  return body.orderProtectionBps / 100;
}

/** USDT on hold and in total for the account, in ledger units. */
async function usdt() {
  const balances = await (await api(who)).balances();
  return { held: held(balances, 'USDT'), total: toUnits(balances.USDT?.total ?? '0') };
}

/** The price pane's box on the page, as the chart's overlay names it (a volume pane may sit below it). */
async function pricePane() {
  const box = await host().boundingBox();
  const overlay = chart().getByTestId('chart-trading-overlay');
  const top = Number(await overlay.getAttribute('data-pane-top'));
  const height = Number(await overlay.getAttribute('data-pane-height'));
  expect(height).toBeGreaterThan(0);
  return { x: box.x, y: box.y + top, width: box.width, height };
}

/** Hover the price pane at a fraction of its height; returns the pixel and the price the plus button names there. */
async function hoverAt(fy) {
  const pane = await pricePane();
  const y = pane.y + pane.height * fy;
  await page.mouse.move(pane.x + pane.width * 0.5, y - 2);
  await page.mouse.move(pane.x + pane.width * 0.5, y);
  await expect(plus()).toBeVisible();
  await expect.poll(async () => Math.abs(centreY(await plus().boundingBox()) - y)).toBeLessThan(2);
  return { x: pane.x + pane.width * 0.5, y, price: await plus().getAttribute('data-price') };
}

const centreY = (box) => box.y + box.height / 2;

/** The page pixel of a price, from two of the chart's own readings (the price scale is linear). */
async function yOf(price) {
  const a = await hoverAt(0.25);
  const b = await hoverAt(0.75);
  return a.y + ((Number(price) - Number(a.price)) * (b.y - a.y)) / (Number(b.price) - Number(a.price));
}

/** Press the order line's handle and drop it at the pixel of `price`. */
async function drag(line, price) {
  const to = await yOf(price);
  const box = await line.boundingBox();
  await page.mouse.move(box.x + box.width / 2, centreY(box));
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, to, { steps: 15 });
  await page.mouse.up();
}

/** Every write about an order this page sends from now on: creates, checks, replaces, amends and cancels. */
function orderWrites() {
  const sent = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && path.startsWith('/api/v1/orders')) sent.push(`${request.method()} ${path}`);
  });
  return sent;
}

test(`${J} #1 projects a buy limit at a TEST price below the market: a preview-styled line, and no order exists until Place is pressed and confirmed`, async () => {
  await signIn(page, who);
  await page.goto(CHART);
  await expect(host()).toBeVisible();
  await expect(host()).toHaveAttribute('data-bars', /^[1-9]/);
  const creates = placements(page);
  const price = await belowBid(97);
  expect(Number(price)).toBeLessThan(await lastPrice());

  await orderOnChart().click();
  await expect(ticket()).toBeVisible();
  await ticket().getByLabel('Side').selectOption('buy');
  await priceField().fill(price);
  await amountField().fill(AMOUNT);

  // The projection: a buy line at that price, styled as a preview and saying it is not placed.
  await expect(previewLine()).toBeVisible();
  await expect(previewLine()).toHaveAttribute('data-side', 'buy');
  expect(Number(await previewLine().getAttribute('data-price'))).toBe(Number(price));
  await expect(previewLine()).toContainText(/preview/i);
  await expect(previewLine()).toContainText(/not placed/i);
  previewStyle = await previewLine().evaluate((el) => getComputedStyle(el).borderTopStyle);
  expect(['dashed', 'dotted']).toContain(previewStyle);
  // Drawn at its price on the chart, below the market's last price.
  const at = await yOf(price);
  expect(Math.abs(centreY(await previewLine().boundingBox()) - at)).toBeLessThan(6);
  expect(at).toBeGreaterThan(await yOf(await lastPrice()));

  // No order exists and nothing is held while it is only projected.
  await page.waitForTimeout(1000);
  expect(creates).toHaveLength(0);
  expect(await openOrders(who)).toHaveLength(0);
  expect((await usdt()).held).toBe(0n);
  await expect(orderLines()).toHaveCount(0);

  // Place pressed, not yet confirmed: the review shows, and still no order exists and nothing is held.
  await ticket().getByRole('button', { name: 'Place' }).click();
  await expect(reviewOrder()).toBeVisible();
  await page.waitForTimeout(1000);
  expect(creates).toHaveLength(0);
  expect(await openOrders(who)).toHaveLength(0);
  expect((await usdt()).held).toBe(0n);
  await expect(orderLines()).toHaveCount(0);

  // Backing out of the review leaves no order behind.
  await reviewOrder().getByRole('button', { name: 'Cancel' }).click();
  await expect(reviewOrder()).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(creates).toHaveLength(0);
  expect(await openOrders(who)).toHaveLength(0);
});

test(`${J} #2 creates an order at a price from the price-axis plus button or the context menu: the ticket opens at that price`, async () => {
  // Start from a closed ticket, so it is the plus button that opens it.
  if (await ticket().isVisible()) await orderOnChart().click();
  await expect(ticket()).toHaveCount(0);

  // The plus button on the price axis names the price under the pointer; pressed, the ticket opens at that price.
  const hovered = await hoverAt(0.4);
  expect(Number(hovered.price)).toBeGreaterThan(0);
  await expect(plus()).toHaveAccessibleName(/Create an order at/);
  await plus().click();
  await expect(ticket()).toBeVisible();
  expect(Number(await priceField().inputValue())).toBe(Number(hovered.price));

  // The context menu at another price: the ticket opens at that price, on the side chosen.
  await orderOnChart().click();
  await expect(ticket()).toHaveCount(0);
  const there = await hoverAt(0.6);
  expect(Number(there.price)).not.toBe(Number(hovered.price));
  await page.mouse.click(there.x, there.y, { button: 'right' });
  await expect(orderMenu()).toBeVisible();
  await orderMenu()
    .getByRole('menuitem', { name: /Buy limit at/ })
    .click();
  await expect(orderMenu()).toHaveCount(0);
  await expect(ticket()).toBeVisible();
  await expect(ticket().getByLabel('Side')).toHaveValue('buy');
  expect(Number(await priceField().inputValue())).toBe(Number(there.price));

  // Opening the ticket creates nothing.
  expect(await openOrders(who)).toHaveLength(0);
  expect((await usdt()).held).toBe(0n);
});

test(`${J} #3 confirms: the order shows as a line with its size, and a retry sends the same key and creates one order`, async () => {
  const price = await belowBid(97);
  await priceField().fill(price);
  await amountField().fill(AMOUNT);
  const creates = placements(page);
  await ticket().getByRole('button', { name: 'Place' }).click();
  await expect(reviewOrder()).toBeVisible();
  expect(creates).toHaveLength(0);
  expect((await usdt()).held).toBe(0n);

  // The first send reaches the service and its answer is lost on the way back, so the person retries it.
  let lost = false;
  const isCreate = (url) => url.pathname === '/api/v1/orders';
  await page.route(isCreate, async (route) => {
    if (route.request().method() !== 'POST' || lost) return route.continue();
    lost = true;
    await route.fetch();
    await route.abort('failed').catch((err) => {
      if (!/already handled/.test(String(err?.message))) throw err;
    });
  });
  await reviewOrder().getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(() => lost).toBe(true);
  const again = page.getByTestId('chart-send-again');
  await expect(again).toBeVisible();
  await again.click();
  await expect(note()).toContainText(/on the book/i);
  await page.unroute(isCreate);

  // The retry sent the same key, and the service holds one order under it, at the price confirmed.
  expect(creates).toHaveLength(2);
  expect(creates[0].clientOrderId).toEqual(expect.any(String));
  expect(creates[1].clientOrderId).toBe(creates[0].clientOrderId);
  const orders = await openOrders(who);
  expect(orders).toHaveLength(1);
  expect(orders[0].clientOrderId).toBe(creates[0].clientOrderId);
  expect(orders[0].side).toBe('buy');
  expect(Number(orders[0].price)).toBe(Number(price));
  expect(Number(orders[0].amount)).toBe(Number(AMOUNT));
  order = orders[0];

  // Held once, on confirm: exactly price x amount, and nothing lost.
  const money = await usdt();
  expect(money.held).toBe(times(order.price, order.amount));
  expect(money.total).toBe(toUnits(FUNDED));

  // The order on the chart: one line, for that order, showing its size, at its price, in an order's style.
  await expect(orderLines()).toHaveCount(1);
  const line = orderLines().first();
  await expect(line).toHaveAttribute('data-order-id', order.id);
  await expect(line).toContainText(AMOUNT);
  await expect(line).toContainText('BTC');
  expect(Math.abs(centreY(await line.boundingBox()) - (await yOf(order.price)))).toBeLessThan(6);
  expect(await line.evaluate((el) => getComputedStyle(el).borderTopStyle)).not.toBe(previewStyle);
  await expect(previewLine()).toHaveCount(0);
});

test(`${J} #4 drags the order line to a new price: a review of the replacement, and the old order is cancelled only when the new one is confirmed`, async () => {
  const limit = await protectionPercent();
  const last = await lastPrice();
  // Inside the protection distance: half of it below the last price, and a whole USDT away from the order's price.
  const target = String(Math.floor(last * (1 - limit / 200)));
  expect(Math.abs(Number(target) - Number(order.price))).toBeGreaterThanOrEqual(1);
  const before = await usdt();
  const sent = orderWrites();

  await drag(orderLines().first(), target);
  await expect(reviewMove()).toBeVisible();
  // The review names the replacement and says the old order stays until the new one is confirmed.
  await expect(reviewMove()).toContainText(/replace/i);
  await expect(reviewMove()).toContainText(/cancelled only when you confirm/i);
  // Nothing cancelled or placed while the review is open: the old order rests, its hold untouched.
  await page.waitForTimeout(1000);
  expect(sent.filter((s) => !s.endsWith('/orders/preview'))).toEqual([]);
  expect((await openOrders(who)).map((o) => o.id)).toEqual([order.id]);
  expect((await usdt()).held).toBe(before.held);

  // Backing out keeps the old order exactly as it was.
  await reviewMove().getByRole('button', { name: 'Cancel' }).click();
  await expect(reviewMove()).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(sent.filter((s) => !s.endsWith('/orders/preview'))).toEqual([]);
  expect((await openOrders(who)).map((o) => [o.id, o.price])).toEqual([[order.id, order.price]]);

  // Dragged again and confirmed: one replace, the old order cancelled, the new one resting at the dragged price.
  await drag(orderLines().first(), target);
  await expect(reviewMove()).toBeVisible();
  const replaceSent = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/v1\/orders\/[^/]+\/replace$/.test(new URL(r.url()).pathname));
  const replaceAnswered = page.waitForResponse((r) => /\/api\/v1\/orders\/[^/]+\/replace$/.test(new URL(r.url()).pathname));
  await reviewMove().getByRole('button', { name: 'Confirm' }).click();
  const request = await replaceSent;
  const answer = await replaceAnswered;
  expect(answer.status()).toBe(200);
  const first = await answer.json();
  await expect(note()).toContainText(/now rests at/i);
  expect(sent.filter((s) => s.endsWith('/replace'))).toHaveLength(1);
  expect(sent.filter((s) => s.startsWith('DELETE'))).toEqual([]);
  const after = await openOrders(who);
  expect(after).toHaveLength(1);
  const moved = after[0];
  expect(moved.id).not.toBe(order.id);
  expect(moved.id).toBe(first.replacementOrderId);
  expect(Math.abs(Number(moved.price) - Number(target))).toBeLessThan(Number(target) * 0.002);
  const old = await (await api(who)).get(`/api/v1/orders/${encodeURIComponent(order.id)}`);
  expect(old.status).toBe(200);
  expect(String(old.body.status)).toMatch(/cancel/i);

  // The old hold released once and the new one held once: exactly the new price x amount, and nothing lost.
  let money = await usdt();
  expect(money.held).toBe(times(moved.price, moved.amount));
  expect(money.total).toBe(toUnits(FUNDED));

  // A retry of the same re-price carries the same key: sent again as it was, the service answers with the same one
  // replacement and holds nothing more.
  const key = request.postDataJSON()?.clientOrderId;
  expect(key).toEqual(expect.any(String));
  const retry = await (await api(who)).post(new URL(request.url()).pathname, request.postDataJSON());
  expect(retry.status).toBe(200);
  expect(retry.body.replacementOrderId).toBe(first.replacementOrderId);
  expect(retry.body.idempotent).toBe(true);
  expect((await openOrders(who)).map((o) => o.id)).toEqual([moved.id]);
  money = await usdt();
  expect(money.held).toBe(times(moved.price, moved.amount));
  expect(money.total).toBe(toUnits(FUNDED));

  // The chart shows the one order, at its new price.
  await expect(orderLines()).toHaveCount(1);
  await expect(orderLines().first()).toHaveAttribute('data-order-id', moved.id);
  expect(Math.abs(centreY(await orderLines().first().boundingBox()) - (await yOf(moved.price)))).toBeLessThan(6);
  order = moved;
});

test(`${J} #5 drags beyond the protection distance: a confirmation naming the distance before anything is sent`, async () => {
  const limit = await protectionPercent();
  const last = await lastPrice();
  // Twice the protection distance below the last price.
  const target = String(Math.floor(last * (1 - (2 * limit) / 100)));
  expect(Number(target)).toBeGreaterThan(0);
  const before = await usdt();
  const sent = orderWrites();

  await drag(orderLines().first(), target);
  await expect(protectionAsk()).toBeVisible();
  // It names the distance dragged from the last price, and the protection distance it goes beyond.
  const text = await protectionAsk().textContent();
  const percents = [...text.matchAll(/(\d+(?:\.\d+)?)\s?%/g)].map((m) => Number(m[1]));
  const dragged = (Math.abs(Number(target) - last) / last) * 100;
  expect(percents.some((p) => Math.abs(p - dragged) < 0.2)).toBe(true);
  expect(percents.some((p) => Math.abs(p - limit) < 0.005)).toBe(true);

  // Before anything is sent: no order, check, replace or cancel went out, and the order rests as it was.
  await page.waitForTimeout(1000);
  expect(sent).toEqual([]);
  expect((await openOrders(who)).map((o) => [o.id, o.price])).toEqual([[order.id, order.price]]);
  expect((await usdt()).held).toBe(before.held);

  // Declined: still nothing sent, the order unchanged and its line back at its price.
  await protectionAsk().getByRole('button', { name: 'Cancel' }).click();
  await expect(protectionAsk()).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(sent).toEqual([]);
  expect((await openOrders(who)).map((o) => [o.id, o.price])).toEqual([[order.id, order.price]]);
  expect(Math.abs(centreY(await orderLines().first().boundingBox()) - (await yOf(order.price)))).toBeLessThan(6);
});

test(`${J} #6 opens the chart of a halted market: order entry on the chart is disabled, with the refusal naming the halt`, async () => {
  const sent = orderWrites();
  let halted = false;
  try {
    tool('local-test-gates.mjs', 'halt', HALTED);
    halted = true;
    await page.goto(`/charts/${HALTED.replace('/', '-')}`);
    await expect(host()).toBeVisible();
    // The refusal names the halt.
    const refusal = bar().getByTestId('chart-trading-refusal');
    await expect(refusal).toBeVisible({ timeout: 30_000 });
    await expect(refusal).toContainText(/halt/i);
    // Order entry on the chart is disabled: the ticket button, the price-axis plus button and the order menu.
    await expect(orderOnChart()).toBeDisabled();
    await expect(ticket()).toHaveCount(0);
    const box = await host().boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35);
    await page.waitForTimeout(500);
    await expect(plus()).toHaveCount(0);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.35, { button: 'right' });
    await page.waitForTimeout(500);
    await expect(orderMenu()).toHaveCount(0);
    // Nothing reached the service for the halted market.
    expect(sent).toEqual([]);
    expect(await openOrders(who, HALTED)).toHaveLength(0);
  } finally {
    try {
      tool('local-test-gates.mjs', 'resume', HALTED);
    } catch (err) {
      if (halted) throw err;
    }
  }
});
