// World: book, gates
import { test, expect } from './journey.mjs';
import { api, bestPrices, fromUnits, times, toUnits, tool } from './stack.mjs';
import { fundedTrader, held, openOrders, placements, signIn } from './desk.mjs';

// J-charts-desk-15 "I place and move orders from the chart itself", in the running app. One test per step, titled
// "J-charts-desk-15 #<n>", run in order in one signed-in browser on one TEST account funded with TEST 1000 USDT.
// Prices on the chart are found from the chart itself: the price-axis plus button names the price under the pointer, so
// two readings give the chart's own price-to-pixel line, and a drag goes to the pixel of the price wanted.
const J = 'J-charts-desk-15';
const CHART = '/charts/BTC-USDT';
const HALTED = 'ETH/USDT'; // step 6 halts this book, not the BTC one the steps before trade
const AMOUNT = '0.001';

test.describe.configure({ mode: 'serial' });

let page;
let who;
let order; // the order placed in #3, as the service holds it
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 2200 } });
  page = await context.newPage();
  who = await fundedTrader(page, 'jcd15', '1000');
});
test.afterAll(async () => {
  await page?.context().close();
});

const host = () => page.getByTestId('cw').getByTestId('wc-host');
const trading = () => page.getByTestId('cw').getByTestId('chart-trading');
const ticket = () => page.getByRole('form', { name: 'Order from the chart' });
const priceField = () => ticket().getByLabel(/Limit price/);
const orderLines = () => page.getByTestId('chart-order-line');

/** A whole-USDT price at `percent` of the best bid. */
async function atBid(percent, symbol = 'BTC/USDT') {
  const { bid } = await bestPrices(symbol);
  const one = toUnits('1');
  return fromUnits(((toUnits(bid) * BigInt(Math.round(percent * 10))) / 1000n / one) * one);
}

async function lastPrice(symbol = 'BTC/USDT') {
  const { status, body } = await (await api(who)).get(`/api/v1/ticker/${encodeURIComponent(symbol)}`);
  expect(status).toBe(200);
  return body.last ?? body.close;
}

/** The price pane's box on the page: the overlay names where it sits in the chart (a volume pane sits below it). */
async function pricePaneBox() {
  const box = await host().boundingBox();
  const overlay = page.getByTestId('cw').getByTestId('chart-trading-overlay');
  const top = Number(await overlay.getAttribute('data-pane-top'));
  const height = Number(await overlay.getAttribute('data-pane-height'));
  expect(height).toBeGreaterThan(0);
  return { x: box.x, y: box.y + top, width: box.width, height };
}

/** The price the chart names under the pointer at a fraction of the price pane's height, from the price-axis plus button. */
async function axisPriceAt(fy) {
  const box = await pricePaneBox();
  const y = box.y + box.height * fy;
  await page.mouse.move(box.x + box.width * 0.5, y - 1);
  await page.mouse.move(box.x + box.width * 0.5, y);
  const plus = page.getByTestId('chart-axis-plus');
  await expect(plus).toBeVisible();
  await expect.poll(async () => Math.abs((await plus.boundingBox()).y + (await plus.boundingBox()).height / 2 - y)).toBeLessThan(2);
  return { y, price: Number(await plus.getAttribute('data-price')) };
}

/** The page pixel of a price on the chart, from two of the chart's own readings (the price scale is linear). */
async function yOfPrice(price) {
  const a = await axisPriceAt(0.25);
  const b = await axisPriceAt(0.75);
  return a.y + ((Number(price) - a.price) * (b.y - a.y)) / (b.price - a.price);
}

/** Drag the order line's handle to the pixel of `price`. */
async function dragLineTo(line, price) {
  const target = await yOfPrice(price);
  const box = await line.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, target, { steps: 12 });
  await page.mouse.up();
}

/** Every create-order and replace request this page sends from now on. */
function orderWrites() {
  const sent = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && (path === '/api/v1/orders' || /^\/api\/v1\/orders\/[^/]+\/replace$/.test(path))) sent.push(path);
  });
  return sent;
}

test(`${J} #1 projects a buy limit at a TEST price below the market: a preview-styled line, and no order until Place and Confirm`, async () => {
  await signIn(page, who);
  await page.goto(CHART);
  await expect(host()).toBeVisible();
  await expect(host()).toHaveAttribute('data-bars', /^[1-9]/);
  const sent = orderWrites();
  const price = await atBid(97);
  await trading().getByRole('button', { name: 'Order on chart' }).click();
  await ticket().getByLabel('Side').selectOption('buy');
  await priceField().fill(price);
  await ticket()
    .getByLabel(/Amount/)
    .fill(AMOUNT);
  const preview = page.getByTestId('chart-preview-line');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('data-side', 'buy');
  await expect(preview).toHaveAttribute('data-price', price);
  await expect(preview).toContainText('Preview buy limit');
  await expect(preview).toContainText('not placed');
  // Dashed, unlike an order's line: the preview style.
  expect(await preview.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed');
  // It is below the market: lower on the chart than the last price.
  expect((await preview.boundingBox()).y).toBeGreaterThan((await yOfPrice(await lastPrice())) - 1);
  await page.waitForTimeout(1000);
  expect(sent).toHaveLength(0);
  expect(await openOrders(who)).toHaveLength(0);
  await expect(orderLines()).toHaveCount(0);
});

test(`${J} #2 creates an order at a price from the price-axis plus button or the context menu: the ticket opens at that price`, async () => {
  // The plus button: the ticket's price is the price the button names.
  const reading = await axisPriceAt(0.4);
  const plus = page.getByTestId('chart-axis-plus');
  const named = await plus.getAttribute('data-price');
  expect(Math.abs(Number(named) - reading.price)).toBeLessThan(0.0001);
  await expect(plus).toHaveAccessibleName(/^Create an order at /);
  await plus.click();
  await expect(ticket()).toBeVisible();
  await expect(priceField()).toHaveValue(named);
  // The context menu at another height: the ticket opens at that price, on the side chosen.
  const box = await pricePaneBox();
  const at = await axisPriceAt(0.6);
  const menuPrice = await page.getByTestId('chart-axis-plus').getAttribute('data-price');
  await page.mouse.click(box.x + box.width * 0.5, at.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Order at this price' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /^Buy limit at / }).click();
  await expect(menu).toHaveCount(0);
  await expect(ticket().getByLabel('Side')).toHaveValue('buy');
  await expect(priceField()).toHaveValue(menuPrice);
  expect(await openOrders(who)).toHaveLength(0);
});

test(`${J} #3 confirms: the order shows as a line with its size, and a retry sends the same key and creates one order`, async () => {
  const price = await atBid(97);
  await priceField().fill(price);
  await ticket()
    .getByLabel(/Amount/)
    .fill(AMOUNT);
  const sent = placements(page);
  // The first send reaches the service, and the browser loses its answer: the person sees it was not confirmed.
  let lostOnce = false;
  await page.route(
    (url) => url.pathname === '/api/v1/orders',
    async (route) => {
      if (route.request().method() !== 'POST' || lostOnce) return route.continue();
      lostOnce = true;
      await route.fetch();
      // The page may already have given up on this request (J-cex-spot-11 #6, run 42177314372): only that is tolerated.
      await route.abort('failed').catch((err) => {
        if (!/already handled/.test(String(err?.message))) throw err;
      });
    },
  );
  await ticket().getByRole('button', { name: 'Place' }).click();
  const review = page.getByRole('dialog', { name: 'Review order' });
  await expect(review).toContainText(`Buy ${AMOUNT} BTC`);
  await expect(review).toContainText('Held on confirm');
  expect(sent).toHaveLength(0); // Place only asks for the review
  await review.getByRole('button', { name: 'Confirm' }).click();
  const again = page.getByTestId('chart-send-again');
  await expect(again).toBeVisible();
  await again.click();
  await expect(page.getByTestId('chart-trading-note')).toContainText('is on the book');
  await page.unroute((url) => url.pathname === '/api/v1/orders');
  // Two sends, one number: the service kept one order.
  expect(sent).toHaveLength(2);
  expect(sent[1].clientOrderId).toBe(sent[0].clientOrderId);
  const orders = await openOrders(who);
  expect(orders).toHaveLength(1);
  expect(orders[0].clientOrderId).toBe(sent[0].clientOrderId);
  expect(Number(orders[0].price)).toBe(Number(price));
  order = orders[0];
  // Held once: exactly the order's price x amount.
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(times(order.price, order.amount));
  // The line on the chart, with its size.
  const line = orderLines();
  await expect(line).toHaveCount(1);
  await expect(line).toHaveAttribute('data-order-id', order.id);
  expect(Number(await line.getAttribute('data-amount'))).toBe(Number(AMOUNT));
  await expect(line).toContainText(`Buy`);
  await expect(line).toContainText('BTC');
});

test(`${J} #4 drags the order line to a new price: a review of the replacement, and the old order is cancelled only on confirm`, async () => {
  const sent = orderWrites();
  const target = await atBid(96.5); // 3.5% under the market: inside the TEST protection distance of 5%
  await dragLineTo(orderLines().first(), target);
  const review = page.getByRole('dialog', { name: 'Review the replacement' });
  await expect(review).toBeVisible();
  await expect(review).toContainText('cancelled only when you confirm');
  // Nothing sent yet: the old order still rests, its hold untouched.
  await page.waitForTimeout(1000);
  expect(sent).toHaveLength(0);
  const before = await openOrders(who);
  expect(before.map((o) => o.id)).toEqual([order.id]);
  await review.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByTestId('chart-trading-note')).toContainText('The order now rests at');
  expect(sent.filter((p) => p.endsWith('/replace'))).toHaveLength(1);
  const after = await openOrders(who);
  expect(after).toHaveLength(1);
  expect(after[0].id).not.toBe(order.id);
  // The new price is the dragged one (to a few ticks of the pixel), and it is held once: the old hold was released.
  expect(Math.abs(Number(after[0].price) - Number(target))).toBeLessThan(Number(target) * 0.002);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(times(after[0].price, after[0].amount));
  await expect(orderLines()).toHaveCount(1);
  await expect(orderLines().first()).toHaveAttribute('data-order-id', after[0].id);
  order = after[0];
});

test(`${J} #5 drags beyond the protection distance: a confirmation naming the distance before anything is sent`, async () => {
  const sent = orderWrites();
  const previews = [];
  page.on('request', (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/orders/preview' && previews.push(r));
  const last = await lastPrice();
  const target = await atBid(90); // 10% under the market
  await dragLineTo(orderLines().first(), target);
  const ask = page.getByRole('alertdialog', { name: 'Beyond the protection distance' });
  await expect(ask).toBeVisible();
  // The distance named is the dragged price's distance from the last price, and the limit is the owner's TEST 5.00%.
  const text = await ask.textContent();
  const [, priceText, distance, limit] = text.match(
    /^([\d,]+\.\d+) is (\d+\.\d\d)% from the last price, beyond the protection distance of (\d+\.\d\d)%/,
  );
  expect(limit).toBe('5.00');
  const dragged = Number(priceText.replaceAll(',', ''));
  expect(Math.abs(Number(distance) - (Math.abs(dragged - Number(last)) / Number(last)) * 100)).toBeLessThan(0.1);
  expect(Number(distance)).toBeGreaterThan(5);
  // Before anything is sent: no order, replace or even a preview went out, and the order is as it was.
  await page.waitForTimeout(1000);
  expect(sent).toHaveLength(0);
  expect(previews).toHaveLength(0);
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  expect((await openOrders(who)).map((o) => [o.id, o.price])).toEqual([[order.id, order.price]]);
});

test(`${J} #6 opens the chart of a halted market: order entry on the chart is disabled with the refusal naming the halt`, async () => {
  const sent = orderWrites();
  let halted = false;
  try {
    await tool('local-test-gates.mjs', 'halt', HALTED);
    halted = true;
    await page.goto(`/charts/${HALTED.replace('/', '-')}`);
    await expect(host()).toBeVisible();
    const refusal = trading().getByTestId('chart-trading-refusal');
    await expect(refusal).toContainText('this market is halted', { timeout: 30_000 });
    await expect(refusal).toHaveAttribute('data-code', 'trade.chart.order_entry_refused');
    await expect(trading().getByRole('button', { name: 'Order on chart' })).toBeDisabled();
    // No plus button and no order menu on the halted chart.
    const box = await host().boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(page.getByTestId('chart-axis-plus')).toHaveCount(0);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5, { button: 'right' });
    await expect(page.getByRole('menu', { name: 'Order at this price' })).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(sent).toHaveLength(0);
    expect(await openOrders(who, HALTED)).toHaveLength(0);
  } finally {
    try {
      await tool('local-test-gates.mjs', 'resume', HALTED);
    } catch (err) {
      if (halted) throw err;
    }
  }
});
