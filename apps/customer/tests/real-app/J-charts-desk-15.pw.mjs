// World: book, gates, restart, stack
import { createHash, randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { approverSessions, makeContext, twoPerson } from '../../../../tooling/scripts/local-test-gates.mjs';
import {
  continueInWallet,
  openVenueDesk,
  otherTraderKey,
  otherTraderRun,
  sameDecimal,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-charts-desk-15 "I place and move orders from the chart itself", in the running app (docs/roadmap/journeys.json), on
// the venue spot desk's chart under the launch money model (docs/adr/2026-11-10-launch-money-model.md): the person's money
// is in their own venue account and the ledger records none of it. One test per step, titled "J-charts-desk-15 #<n>", run
// in order in one signed-in browser on one TEST account: verified, its TEST wallet connected, TEST USDC in its own venue
// account, the chart open on a TEST spot market of this run's own (listed by two operators, quoted and traded by other
// TEST traders), so no other journey's order meets this one's. Every order, lock and answer is read from the stack's TEST
// venue itself (packages/venue-sim) on loopback, never our engine or ledger; the ledger is read only to show it posts
// nothing. Money line: an order from the chart is the same signed venue order as the desk's (J-cex-spot-05): nothing is
// signed or sent before Confirm, and the venue locks only for the order it accepts; a re-price cancels the old venue order
// (its lock released once, as the venue reports) and places the new one under a client order id that is the same on every
// retry; a drag past the protection distance asks first. Prices on the chart are found from the chart itself: the
// price-axis plus button names the price under the pointer, so two readings give the chart's own price-to-pixel line.
const J = 'J-charts-desk-15';
const START_USDC = '200';
const AMOUNT = '0.1';
const LAST = '100'; // the market's last trade, made by other TEST traders before the steps
const BELOW = '97.0'; // 3% under the last trade: a buy limit that rests
const INSIDE = '96.5'; // 3.5% under: inside the owner's TEST protection distance of 5%
const BEYOND = '90.0'; // 10% under: beyond it
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'serial' });
venueForThisFile(test);

let page;
let wallet;
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 2200 } });
  page = await context.newPage();
});
test.afterAll(async () => {
  await page?.context().close();
});

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey || !s.symbol) throw new Error(`${J}'s TEST setup made no account, wallet and market to act on`);
  return s;
}
const ownerOf = (s) => privateKeyToAccount(s.walletKey).address.toLowerCase();

// ── the TEST venue's own record ──

/** The person's open orders on `symbol`, as the TEST venue itself keeps them. */
const venueOpen = async (owner, symbol) => (await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === symbol);
const venueByClientId = async (owner, venueClientOrderId) =>
  (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId })).value;
/** The market's newest trade on the TEST venue. */
async function venueLast(symbol) {
  const { status, body } = await testVenue('/trades', { symbol, limit: 1 });
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.value[0].price;
}
/** Our ledger's view of this account: this journey's ledger posts nothing. */
const ledgerView = async (who) => (await api(who)).balances();
/** The wallet's signature prompts so far (typed data is the only thing a venue action is signed as). */
const signatures = () => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;
/** Every door call this page makes from now on, by its path (`preview`, `prepare`, `submit`), with its body. */
function doorCalls() {
  const calls = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === 'POST' && path.startsWith('/api/v1/venue/'))
      calls.push({ path: path.slice('/api/v1/venue/'.length), body: r.postDataJSON() });
  });
  return { all: calls, of: (name) => calls.filter((c) => c.path === name), sent: () => calls.filter((c) => c.path !== 'route-preview') };
}

// ── TEST setup: this run's own market, quoted and traded by other TEST traders ──

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
const hashOf = (body) => `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`;
const trpcData = (res) => res.json?.result?.data?.json ?? res.json?.result?.data;

/** Two operators list `symbol` through svc-trade's own two-person door (J-cex-spot-16), open a minute ago. */
async function listByOperators(symbol) {
  const action = 'trade.venue_listing_set';
  const ctx = await makeContext({ log: () => undefined });
  const sessions = await approverSessions(ctx);
  const venueId = (await venueInfo()).id;
  const opensAt = new Date(Date.now() - 60_000).toISOString();
  const reason = `LOCAL TEST ${J}: list ${symbol} for the chart's orders`;
  const ids = await twoPerson(ctx, sessions, {
    actionType: action,
    targetService: 'svc-trade',
    targetId: `venue-listing:${venueId}:${symbol}`,
    expectedVersion: '0',
    payloadHash: hashOf({ actionType: action, venueId, symbol, opensAt, expectedVersion: '0', reason }),
    policyVersion: 'trade-venue-markets-v1',
  });
  const res = await ctx.edge.mutate(
    'trade',
    'admin.venueMarkets.listingSet',
    { symbol, opensAt, expectedVersion: '0', reason, ...ids },
    await sessions.a.tradeOpsToken(),
  );
  expect(trpcData(res)?.listing?.version, res.text.slice(0, 300)).toBe(1);
}

const limitIntent = (symbol, side, price, amount, key, timeInForce = 'GTC') => ({
  kind: 'place_order',
  symbol,
  side,
  type: 'limit',
  amount,
  price,
  timeInForce,
  reduceOnly: false,
  clientOrderKey: key,
  builderFee: null,
});
async function fundedOther(name, funds) {
  const owner = otherTraderKey(name).address.toLowerCase();
  for (const [asset, amount] of Object.entries(funds))
    expect(await testDeposit(owner, asset, amount, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
}
const accepted = { definite: true, accepted: true };

/**
 * A fresh TEST spot market (tick 0.1, lot 0.001), listed by two operators, with two trades (101, then 100: its last price
 * and its candles) and a quote around them (99.9 / 100.1), all by other TEST traders. No other file trades it.
 */
async function ownMarket(tag) {
  const base = `J15${tag}${randomBytes(3).toString('hex').toUpperCase()}`;
  const symbol = `${base}-USDC`;
  const added = await testVenue('/test/market-add', {
    symbol,
    baseAsset: base,
    quoteAsset: 'USDC',
    maxOrderQty: null,
    maxOrderNotional: null,
  });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  await listByOperators(symbol);
  const maker = `jcd15-maker-${symbol}`;
  const taker = `jcd15-taker-${symbol}`;
  await fundedOther(maker, { USDC: '1000', [base]: '10' });
  await fundedOther(taker, { USDC: '1000' });
  for (const price of ['101', LAST]) {
    expect(await otherTraderRun(maker, limitIntent(symbol, 'sell', price, '0.5', `order:jcd15:${symbol}:ask:${price}`))).toMatchObject(
      accepted,
    );
    expect(
      await otherTraderRun(taker, limitIntent(symbol, 'buy', price, '0.5', `order:jcd15:${symbol}:take:${price}`, 'IOC')),
    ).toMatchObject(accepted);
  }
  expect(sameDecimal(await venueLast(symbol), LAST)).toBe(true);
  for (const [side, price] of [
    ['buy', '99.9'],
    ['sell', '100.1'],
  ])
    expect(await otherTraderRun(maker, limitIntent(symbol, side, price, '1', `order:jcd15:${symbol}:quote:${side}`))).toMatchObject(
      accepted,
    );
  return symbol;
}

/** The person signs one action on the TEST venue with their own TEST wallet key, outside the app: TEST setup only. */
async function personRun(walletKey, intent) {
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  const prepared = await testVenue('/prepare', { account: await venueAccount(owner), signer: { role: 'owner', address: owner }, intent });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 300)).toBe(200);
  const typed = prepared.body.typedData;
  const signature = await key.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
  return sent.body;
}

/**
 * The Starts line, made at the start of #1 (never a beforeAll: a worker restarted after a failed step would replace the
 * account the later steps act as): a verified account, this run's TEST wallet key, TEST USDC in its own venue account by
 * the TEST venue's deposit control, our TEST builder fee approved on that account by its own key, this run's own open
 * market, and a second one of its own for #6.
 */
async function startsLine(browser) {
  const setup = await browser.newPage();
  let account;
  try {
    account = await signUp(setup, 'jcd15v');
    await verify(setup, account);
  } finally {
    await setup.close();
  }
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  expect(await testDeposit(owner, 'USDC', START_USDC, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  const status = await (await api(account)).get('/api/v1/venue/status');
  expect(status.status, JSON.stringify(status.body).slice(0, 300)).toBe(200);
  const builder = status.body.builder;
  expect(builder, 'the TEST stack publishes our TEST builder fee').toBeTruthy();
  expect(await personRun(walletKey, { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps })).toMatchObject(
    accepted,
  );
  run.reset({ account, walletKey, symbol: await ownMarket('A'), halted: await ownMarket('H'), ledger: await ledgerView(account) });
}

// ── the chart ──

const chart = () => page.getByTestId('venue-chart');
const host = () => chart().getByTestId('pc-host');
const trading = () => page.getByTestId('venue-market').getByTestId('chart-trading');
const ticket = () => page.getByRole('form', { name: 'Order from the chart' });
const priceField = () => ticket().getByLabel(/Limit price/);
const amountField = () => ticket().getByLabel(/Amount/);
const orderLines = () => page.getByTestId('chart-order-line');

/** The price pane's box on the page: the overlay names where it sits in the chart (the volume pane sits below it). */
async function pricePaneBox() {
  const box = await host().boundingBox();
  const overlay = chart().getByTestId('chart-trading-overlay');
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

/** The person's USDC on the venue, free and locked, in units, from the venue's own record. */
async function usdc(owner) {
  const b = await venueBalance(owner, 'USDC');
  return { free: toUnits(b.free), locked: toUnits(b.locked) };
}

test(`${J} #1 projects a buy limit at a TEST price below the market: a preview-styled line, and no order until Place and Confirm`, async ({
  browser,
}) => {
  test.setTimeout(420_000);
  await startsLine(browser);
  const s = state();
  const owner = ownerOf(s);
  wallet = await openVenueDesk(page, s.account, `/trade/spot/${s.symbol}`, s.walletKey);
  await expect(host()).toBeVisible();
  await expect(chart().getByTestId('chart-trading-overlay')).toHaveCount(1, { timeout: 20_000 });
  const door = doorCalls();
  await trading().getByRole('button', { name: 'Order on chart' }).click();
  await ticket().getByLabel('Side').selectOption('buy');
  await priceField().fill(BELOW);
  await amountField().fill(AMOUNT);
  const preview = page.getByTestId('chart-preview-line');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('data-side', 'buy');
  await expect(preview).toHaveAttribute('data-price', BELOW);
  await expect(preview).toContainText('Preview buy limit');
  await expect(preview).toContainText('not placed');
  // Dashed, unlike an order's line: the preview style.
  expect(await preview.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed');
  // Below the market: lower on the chart than the venue's own last trade.
  const last = await venueLast(s.symbol);
  expect(sameDecimal(last, LAST)).toBe(true);
  expect(Number(BELOW)).toBeLessThan(Number(last));
  expect((await preview.boundingBox()).y).toBeGreaterThan((await yOfPrice(last)) - 1);
  // No order exists: nothing was previewed, prepared, signed or sent, the venue holds no order and locks nothing for one.
  await page.waitForTimeout(1000);
  expect(door.sent()).toEqual([]);
  expect(signatures()).toBe(0);
  expect(await venueOpen(owner, s.symbol)).toEqual([]);
  expect((await usdc(owner)).locked).toBe(0n);
  await expect(orderLines()).toHaveCount(0);
  expect(await ledgerView(s.account)).toEqual(s.ledger);
});

test(`${J} #2 creates an order at a price from the price-axis plus button or the context menu: the ticket opens at that price`, async () => {
  const s = state();
  const owner = ownerOf(s);
  const door = doorCalls();
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
  expect(menuPrice).not.toBe(named);
  await page.mouse.click(box.x + box.width * 0.5, at.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Order at this price' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /^Buy limit at / }).click();
  await expect(menu).toHaveCount(0);
  await expect(ticket().getByLabel('Side')).toHaveValue('buy');
  await expect(priceField()).toHaveValue(menuPrice);
  // Opening the ticket places nothing.
  expect(door.sent()).toEqual([]);
  expect(signatures()).toBe(0);
  expect(await venueOpen(owner, s.symbol)).toEqual([]);
});

test(`${J} #3 confirms: the order shows as a line with its size, and a retry sends the same key and creates one order`, async () => {
  test.setTimeout(240_000);
  const s = state();
  const owner = ownerOf(s);
  await priceField().fill(BELOW);
  await amountField().fill(AMOUNT);
  const door = doorCalls();
  const preview = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await ticket().getByRole('button', { name: 'Place' }).click();
  const venuePreview = (await (await preview).json()).value;
  const review = page.getByRole('dialog', { name: 'Review order' });
  await expect(review).toContainText(`Buy ${AMOUNT} `);
  await expect(review).toContainText(`at ${BELOW.replace(/\.0$/, '')}`);
  // The review shows what the venue would lock for this order, from the venue's own preview.
  const lock = review.getByTestId('chart-review-lock');
  await expect(lock).toHaveAttribute('data-lock', venuePreview.lock.amount);
  await expect(lock).toHaveAttribute('data-lock-asset', 'USDC');
  await expect(review).toContainText('Nothing is signed or sent until you confirm.');
  // Place only asks for the preview: nothing prepared, signed or sent, nothing locked.
  expect(door.sent().map((c) => c.path)).toEqual(['preview']);
  expect(signatures()).toBe(0);
  expect(await venueOpen(owner, s.symbol)).toEqual([]);
  expect((await usdc(owner)).locked).toBe(0n);

  // The first send reaches the venue, and the browser loses its answer: the person is offered to send it again.
  let lostOnce = false;
  await page.route('**/api/v1/venue/submit', async (route) => {
    if (lostOnce) return route.continue();
    lostOnce = true;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await review.getByRole('button', { name: 'Confirm' }).click();
  await continueInWallet(page);
  const again = page.getByTestId('chart-send-again');
  await expect(again).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('chart-trading-note')).toContainText('same client order id');
  await again.click();
  await expect(page.getByTestId('chart-trading-note')).toContainText('rests on the venue as order', { timeout: 20_000 });
  await page.unrouteAll({ behavior: 'wait' });
  // Two sends of one action: the same key and the same signed bytes, signed once.
  const submits = door.of('submit');
  expect(submits).toHaveLength(2);
  expect(submits[1].body.actionKey).toBe(submits[0].body.actionKey);
  expect(submits[1].body.signature).toEqual(submits[0].body.signature);
  expect(signatures()).toBe(1);
  const intent = door.of('prepare')[0].body.intent;
  expect(intent).toMatchObject({ kind: 'place_order', symbol: s.symbol, side: 'buy', type: 'limit', timeInForce: 'GTC' });
  expect(submits[0].body.actionKey).toBe(intent.clientOrderKey);
  expect(sameDecimal(intent.price, BELOW) && sameDecimal(intent.amount, AMOUNT)).toBe(true);
  // The venue kept one order for it, at the price and size confirmed.
  const open = await venueOpen(owner, s.symbol);
  expect(open).toHaveLength(1);
  const order = open[0];
  expect(order).toMatchObject({ side: 'buy', type: 'limit', status: 'open' });
  expect(sameDecimal(order.price, BELOW) && sameDecimal(order.remaining, AMOUNT)).toBe(true);
  // The venue locks only for the order it accepted: its lock is the one reviewed, and the account's whole lock.
  expect(sameDecimal(order.locked, venuePreview.lock.amount)).toBe(true);
  expect((await usdc(owner)).locked).toBe(toUnits(order.locked));
  // The line on the chart, with its size.
  const line = orderLines();
  await expect(line).toHaveCount(1, { timeout: 20_000 });
  await expect(line).toHaveAttribute('data-client-order-id', order.venueClientOrderId);
  expect(sameDecimal(await line.getAttribute('data-amount'), AMOUNT)).toBe(true);
  await expect(line).toContainText(`Buy ${AMOUNT}`);
  run.write({ order: order.venueClientOrderId });
  expect(await ledgerView(s.account)).toEqual(s.ledger);
});

test(`${J} #4 drags the order line to a new price: a review of the replacement, and the old order is cancelled only on confirm`, async () => {
  test.setTimeout(240_000);
  const s = state();
  const owner = ownerOf(s);
  const before = await usdc(owner);
  const door = doorCalls();
  await dragLineTo(orderLines().first(), INSIDE);
  const review = page.getByRole('dialog', { name: 'Review the replacement' });
  await expect(review).toBeVisible({ timeout: 20_000 });
  await expect(review).toContainText('cancelled only when you confirm');
  // Only the venue's preview of the replacement: nothing prepared, signed or sent; the old order rests, its lock untouched.
  await page.waitForTimeout(1000);
  expect(door.sent().map((c) => c.path)).toEqual(['preview']);
  const replacement = door.of('preview')[0].body.intent;
  expect(signatures()).toBe(1);
  expect((await venueOpen(owner, s.symbol)).map((o) => o.venueClientOrderId)).toEqual([s.order]);
  expect(await usdc(owner)).toEqual(before);
  await review.getByRole('button', { name: 'Confirm' }).click();
  await continueInWallet(page);
  await expect(page.getByTestId('chart-trading-note')).toContainText('The order now rests at', { timeout: 20_000 });
  // One signed cancel-and-replace, under the replacement's own key.
  const prepared = door.of('prepare');
  expect(prepared).toHaveLength(1);
  expect(prepared[0].body.intent).toMatchObject({ kind: 'replace_order', symbol: s.symbol, venueClientOrderId: s.order });
  expect(prepared[0].body.intent.order.clientOrderKey).toBe(replacement.clientOrderKey);
  expect(door.of('submit')).toHaveLength(1);
  expect(signatures()).toBe(2);
  // On the venue: the old order cancelled, its lock released; the new one at the dragged price (to a tick or two of the
  // pixel), the only order, and the account's whole lock is its lock.
  expect((await venueByClientId(owner, s.order)).status).toBe('canceled');
  const open = await venueOpen(owner, s.symbol);
  expect(open).toHaveLength(1);
  const now = open[0];
  expect(now.venueClientOrderId).not.toBe(s.order);
  expect(sameDecimal(now.price, replacement.price)).toBe(true);
  expect(Math.abs(Number(now.price) - Number(INSIDE))).toBeLessThanOrEqual(0.2);
  expect(sameDecimal(now.remaining, AMOUNT)).toBe(true);
  const after = await usdc(owner);
  expect(after.locked).toBe(toUnits(now.locked));
  expect(after.free + after.locked).toBe(before.free + before.locked);
  await expect(orderLines()).toHaveCount(1);
  await expect(orderLines().first()).toHaveAttribute('data-client-order-id', now.venueClientOrderId, { timeout: 20_000 });
  run.write({ order: now.venueClientOrderId, orderPrice: now.price });
  expect(await ledgerView(s.account)).toEqual(s.ledger);
});

test(`${J} #5 drags beyond the protection distance: a confirmation naming the distance before anything is sent`, async () => {
  const s = state();
  const owner = ownerOf(s);
  const before = await usdc(owner);
  const door = doorCalls();
  await dragLineTo(orderLines().first(), BEYOND);
  const ask = page.getByRole('alertdialog', { name: 'Beyond the protection distance' });
  await expect(ask).toBeVisible({ timeout: 20_000 });
  // The distance named is the dragged price's distance from the venue's last trade, and the limit is the owner's TEST 5.00%.
  const last = await venueLast(s.symbol);
  const text = await ask.textContent();
  const [, priceText, distance, limit] = text.match(
    /^([\d,]+(?:\.\d+)?) is (\d+\.\d\d)% from the last price, beyond the protection distance of (\d+\.\d\d)%/,
  );
  expect(limit).toBe('5.00');
  const dragged = Number(priceText.replaceAll(',', ''));
  expect(Math.abs(dragged - Number(BEYOND))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(Number(distance) - (Math.abs(dragged - Number(last)) / Number(last)) * 100)).toBeLessThan(0.01);
  expect(Number(distance)).toBeGreaterThan(5);
  // Before anything is sent: no preview, prepare or submit went out, no signature was asked, and the order is as it was.
  await page.waitForTimeout(1000);
  expect(door.sent()).toEqual([]);
  expect(signatures()).toBe(2);
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  const open = await venueOpen(owner, s.symbol);
  expect(open.map((o) => [o.venueClientOrderId, o.status])).toEqual([[s.order, 'open']]);
  expect(sameDecimal(open[0].price, s.orderPrice)).toBe(true);
  expect(await usdc(owner)).toEqual(before);
});

test(`${J} #6 opens the chart of a halted market: order entry on the chart is disabled with the refusal naming the halt`, async () => {
  test.setTimeout(240_000);
  const s = state();
  const owner = ownerOf(s);
  const { displayName } = await venueInfo();
  expect((await testVenue('/test/market-status', { symbol: s.halted, status: 'halted' })).status).toBe(200);
  try {
    const door = doorCalls();
    await page.goto(`/trade/spot/${s.halted}`);
    await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
    await expect(host()).toBeVisible({ timeout: 20_000 });
    const refusal = trading().getByTestId('chart-trading-refusal');
    await expect(refusal).toHaveText(`Order entry on the chart is off: ${s.halted} is halted on ${displayName}.`, { timeout: 30_000 });
    await expect(refusal).toHaveAttribute('data-code', 'trade.chart.order_entry_refused');
    await expect(trading().getByRole('button', { name: 'Order on chart' })).toBeDisabled();
    // No plus button and no order menu on the halted chart.
    const box = await host().boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35);
    await expect(page.getByTestId('chart-axis-plus')).toHaveCount(0);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.35, { button: 'right' });
    await expect(page.getByRole('menu', { name: 'Order at this price' })).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(door.sent()).toEqual([]);
    expect(signatures()).toBe(2);
    expect(await venueOpen(owner, s.halted)).toEqual([]);
  } finally {
    await testVenue('/test/market-status', { symbol: s.halted, status: 'trading' });
  }
});
