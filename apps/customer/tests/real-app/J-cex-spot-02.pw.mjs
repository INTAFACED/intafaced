// World: book, gates, restart, stack
import { createHash, randomBytes } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fromUnits, journeyState, toUnits } from './stack.mjs';
import { reviewSheet, signUp, verify } from './desk.mjs';
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

// J-cex-spot-02, in the running app (docs/roadmap/journeys.json; project-state operation-zero/modules/cex-spot/acceptance/
// journeys.md): a retry, a lost answer or a double press never makes a second venue order or asks for a second signature.
// One test per step, titled "J-cex-spot-02 #<n>", on one TEST account: verified, its TEST wallet connected, TEST 1,000 USDC
// in its own venue account, on the venue spot desk. Every figure is TEST, and the person's orders are read from the
// stack's TEST venue itself (packages/venue-sim), never our ledger or engine; the ledger is read only to show it posts
// nothing. Lost answers are the browser losing the door's reply (the order still reaches the venue) or a read; nothing
// else is stood in for. The user-venue door is on for this file only.
const J = 'J-cex-spot-02';
const DESK = '/trade/spot/BTC-USDC';
const SYMBOL = 'BTC-USDC';
/** A TEST buy of 0.001 BTC rests far under the venue's bid, so it locks about 54 TEST USDC and never fills. */
const AMOUNT = '0.001';
const START_USDC = '1000';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J}'s TEST setup made no account and wallet, so this step has no one to act as`);
  return s;
}
const ownerOf = (s) => privateKeyToAccount(s.walletKey).address.toLowerCase();

/** The person's open orders and one order by its venue client id, from the TEST venue's own record. */
const venueOpen = async (owner) => (await venueRecord(owner, '/open-orders')).value;
const venueByClientId = async (owner, venueClientOrderId) =>
  (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId })).value;

/** The wallet's signature prompts so far (typed data is the only thing an order is signed as). */
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;

/** Every door call this page makes, by its path (`prepare`, `submit`, `preview`). */
function doorCalls(page) {
  const calls = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === 'POST' && path.startsWith('/api/v1/venue/'))
      calls.push({ path: path.slice('/api/v1/venue/'.length), body: r.postDataJSON() });
  });
  return { all: calls, of: (name) => calls.filter((c) => c.path === name) };
}

/** A TEST price `percent` of the venue's own best bid on `symbol`, on its tick: a buy there rests and never fills. */
async function awayBid(percent, symbol = SYMBOL) {
  const { body } = await testVenue('/markets', {});
  const market = body.value.find((m) => m.symbol === symbol);
  expect(market, JSON.stringify(body).slice(0, 300)).toBeTruthy();
  const bids = [];
  const { id } = await venueInfo();
  // The TEST venue's own bid maker (venue-reads.mjs venueBook): the bid is read from the venue, never our engine.
  const bidder = privateKeyToAccount(keccak256(toHex('intafaced TEST venue maker bid'))).address.toLowerCase();
  const read = await testVenue('/open-orders', { account: { venueId: id, owner: bidder, subAccount: null } });
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  for (const o of read.body.value) if (o.symbol === symbol && o.side === 'buy') bids.push(toUnits(o.price));
  expect(bids.length, `the TEST venue has bids on ${symbol}`).toBeGreaterThan(0);
  const best = bids.reduce((a, b) => (b > a ? b : a));
  const tick = toUnits(market.tickSize);
  return fromUnits(((best * BigInt(percent)) / 100n / tick) * tick);
}

/** Fills the buy ticket (the first form) as a limit order and waits for the venue's own preview of it. */
async function typeLimitBuy(page, price, amount) {
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  const form = page.locator('form[data-testid="dk-form"][data-side="buy"]');
  await form.getByRole('textbox', { name: 'Price' }).fill(price);
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await form.getByRole('textbox', { name: 'Amount' }).fill(amount);
  return { form, preview: await answer };
}

/** Types a limit buy and opens its review once the venue's preview answers; returns the review and the client id shown. */
async function reviewLimitBuy(page, price, amount = AMOUNT) {
  const { form, preview } = await typeLimitBuy(page, price, amount);
  expect(preview.status()).toBe(200);
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  const review = reviewSheet(page);
  await expect(review).toBeVisible();
  const id = (await review.getByTestId('client-order-id').innerText()).trim();
  expect(id).toMatch(/^\S+$/);
  return { form, review, id };
}

/** Our ledger's view of this account: the venue journeys' ledger posts nothing. */
async function ledgerView(who) {
  return (await api(who)).balances();
}

/**
 * TEST setup, not a step (the Starts line), made at the start of #1: a verified account, this run's TEST wallet key, and
 * TEST 1,000 USDC in its own venue account by the TEST venue's deposit control (keyed by a chain-transfer-shaped
 * reference). Made in #1, never in a beforeAll: a worker that restarts after a failed step would run a beforeAll again and
 * replace the account the later steps act as.
 */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'js2v');
    await verify(page, account);
    const walletKey = testWalletKey();
    run.reset({ account, walletKey });
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', START_USDC, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    expect(sameDecimal((await venueBalance(owner, 'USDC')).free, START_USDC)).toBe(true);
  } finally {
    await page.close();
  }
}

test(`${J} #1 reviews and places a limit buy: one open venue order carrying the client order id the desk minted for that reviewed draft`, async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  await startsLine(browser);
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const owner = ownerOf(s);
  const door = doorCalls(page);
  const ledgerBefore = await ledgerView(s.account);
  const price = await awayBid(90);
  const { id } = await reviewLimitBuy(page, price);
  const asked = signatures(wallet);
  const prepareAnswer = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/v1/venue/prepare' && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Confirm buy' }).click();
  await continueInWallet(page);
  const prepared = (await (await prepareAnswer).json()).prepared;
  await expect(page.getByTestId('venue-bottom').getByTestId('venue-outcome')).toContainText('Open on the venue.', { timeout: 20_000 });
  // One signature, one prepare and one submit, under the business key whose end the review showed as the client id.
  expect(signatures(wallet)).toBe(asked + 1);
  expect(door.of('prepare')).toHaveLength(1);
  expect(door.of('submit')).toHaveLength(1);
  const key = door.of('prepare')[0].body.intent.clientOrderKey;
  expect(key.endsWith(id), `${key} is the draft the review named (${id})`).toBe(true);
  expect(door.of('submit')[0].body.actionKey).toBe(key);
  // The venue holds one open order of this person's: this one, at its price and amount, under that client id.
  const open = await venueOpen(owner);
  expect(open).toHaveLength(1);
  const [order] = open;
  expect(order).toMatchObject({ symbol: SYMBOL, side: 'buy', type: 'limit', status: 'open' });
  expect(sameDecimal(order.price, price)).toBe(true);
  expect(sameDecimal(order.amount, AMOUNT)).toBe(true);
  // The venue's order carries the client order id prepared for that reviewed draft's key, and the wallet signed that draft.
  expect(prepared.intent.clientOrderKey).toBe(key);
  expect(prepared.venueClientOrderId).toMatch(/^\S+$/);
  expect(order.venueClientOrderId).toBe(prepared.venueClientOrderId);
  const signedOrder = JSON.parse(
    JSON.parse(wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').at(-1).params[1]).message.payload,
  );
  expect(signedOrder.clientOrderKey, 'the wallet signed the reviewed draft').toBe(key);
  const placed = await venueByClientId(owner, prepared.venueClientOrderId);
  expect(placed.venueOrderId).toBe(order.venueOrderId);
  // The Open orders tab shows it, Open.
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
  await expect(page.getByTestId('venue-bottom').locator('tr', { hasText: 'Open' })).toHaveCount(1);
  // The ledger posts nothing.
  expect(await ledgerView(s.account)).toEqual(ledgerBefore);
  run.write({
    first: { key, price, venueClientOrderId: order.venueClientOrderId, venueOrderId: order.venueOrderId },
    firstSubmit: door.of('submit')[0].body,
  });
});

test(`${J} #2 presses Confirm twice, and the connection retries the same draft: the venue answers with the same order, one Open row, one signature`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const { first, firstSubmit } = s;
  expect(first, '#1 placed an order').toBeTruthy();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const owner = ownerOf(s);
  const door = doorCalls(page);
  const before = await venueOpen(owner);
  const price = await awayBid(89);
  await reviewLimitBuy(page, price);
  const asked = signatures(wallet);
  // Confirm pressed twice in a row.
  await page.getByRole('button', { name: 'Confirm buy' }).dblclick();
  await continueInWallet(page);
  await expect(page.getByTestId('venue-bottom').getByTestId('venue-outcome')).toContainText('Open on the venue.', { timeout: 20_000 });
  // One signature asked; every send of the draft named one key.
  expect(signatures(wallet)).toBe(asked + 1);
  expect(new Set(door.of('prepare').map((c) => c.body.intent.clientOrderKey)).size).toBe(1);
  expect(door.of('submit')).toHaveLength(1);
  const after = await venueOpen(owner);
  expect(after).toHaveLength(before.length + 1);
  const mine = after.filter((o) => sameDecimal(o.price, price));
  expect(mine, 'one venue order for the double press').toHaveLength(1);
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
  await expect(page.getByTestId('venue-bottom').locator('tr', { hasText: Number(price).toLocaleString('en-US') })).toHaveCount(1);
  // The connection retries #1's draft: the same signed submit, sent again. The venue answers with the order it holds.
  const client = await api(s.account);
  const again = await client.post('/api/v1/venue/submit', firstSubmit);
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.outcome).toMatchObject({ definite: true, accepted: true });
  expect(again.body.outcome.order.venueOrderId).toBe(first.venueOrderId);
  // So does preparing the same draft again: the stored, signed action and its first answer, nothing new to sign.
  const prepared = await client.post('/api/v1/venue/prepare', door.of('prepare')[0].body);
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 300)).toBe(200);
  expect(prepared.body).toMatchObject({ reused: true, signed: true });
  expect(prepared.body.lastOutcome).toMatchObject({ definite: true, accepted: true });
  expect(await venueOpen(owner)).toHaveLength(after.length);
  expect(signatures(wallet)).toBe(asked + 1);
});

test(`${J} #3 loses the answer after pressing Confirm: the desk says it is checking, looks the order up on the venue by client id, finds it, and offers no second placement`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const owner = ownerOf(s);
  const door = doorCalls(page);
  const before = await venueOpen(owner);
  // The order reaches the door and the venue; its answer never reaches the browser. The look-up is held for a moment
  // so the checking state can be read before the venue's answer arrives.
  await page.route('**/api/v1/venue/submit', async (route) => {
    await route.fetch();
    await route.abort('connectionreset');
  });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/api/v1/venue/orders/by-client-id**', async (route) => {
    await held;
    await route.continue();
  });
  const price = await awayBid(88);
  await reviewLimitBuy(page, price);
  const asked = signatures(wallet);
  await page.getByRole('button', { name: 'Confirm buy' }).click();
  await continueInWallet(page);
  const pending = page.getByTestId('venue-pending');
  await expect(pending).toContainText('Checking your earlier order with the venue');
  const cloid = await pending.locator('[data-pending]').getAttribute('data-pending');
  await expect(pending).toContainText(`by its client id ${cloid}`);
  // While it checks, no second placement is offered: the ticket's Buy is off and says why, and nothing is sent again.
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  await expect(pending).toContainText('New orders wait until the venue has answered about this order.');
  await expect(pending.getByRole('button', { name: 'Send the same order again' })).toHaveCount(0);
  release();
  // Found on the venue by its client id.
  await expect(page.getByTestId('venue-pending-found')).toHaveText(
    `Checked with the venue: your order ${cloid} is Open. Nothing was sent again.`,
    { timeout: 20_000 },
  );
  await expect(pending).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });
  expect(door.of('submit')).toHaveLength(1);
  expect(door.of('prepare')).toHaveLength(1);
  expect(signatures(wallet)).toBe(asked + 1);
  const placed = await venueByClientId(owner, cloid);
  expect(placed).toMatchObject({ status: 'open', symbol: SYMBOL });
  expect(sameDecimal(placed.price, price)).toBe(true);
  expect(await venueOpen(owner)).toHaveLength(before.length + 1);
  // The draft was let go once the venue named the order: the ticket is free for a new order.
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeEnabled();
  expect(await page.evaluate((o) => sessionStorage.getItem(`if.venue.pending.${o}`), owner)).toBe('[]');
});

test(`${J} #4 reloads the page while an answer is still unknown, then tries a new order: new orders wait until the venue has answered, in words`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const owner = ownerOf(s);
  const before = await venueOpen(owner);
  // The signed order is lost on the way (the connection drops before it reaches us), so no one has answered it: the venue
  // holds nothing under its client id, and the desk's own look-up says so.
  const sent = [];
  await page.route('**/api/v1/venue/submit', async (route) => {
    sent.push(route.request().postDataJSON());
    await route.abort('connectionreset');
  });
  const price = await awayBid(87);
  await reviewLimitBuy(page, price);
  const asked = signatures(wallet);
  await page.getByRole('button', { name: 'Confirm buy' }).click();
  await continueInWallet(page);
  const pending = page.getByTestId('venue-pending');
  await expect(pending).toContainText('Checking your earlier order with the venue');
  const cloid = await pending.locator('[data-pending]').getAttribute('data-pending');
  expect(signatures(wallet)).toBe(asked + 1);
  expect(sent).toHaveLength(1);
  await page.unrouteAll({ behavior: 'wait' });
  expect(await venueByClientId(owner, cloid)).toBeNull();
  await page.reload();
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  // The reloaded desk still knows the order has no answer: the venue, asked by client id, holds none yet, and the desk
  // says new orders wait.
  const row = pending.locator(`[data-pending="${cloid}"]`);
  await expect(row).toContainText(`The venue has no order under client id ${cloid} so far.`, { timeout: 20_000 });
  await expect(pending).toContainText('New orders wait until the venue has answered about this order.');
  // A new order is typed: it waits. Buy is off, and nothing is prepared or signed.
  const door = doorCalls(page);
  await typeLimitBuy(page, await awayBid(86), AMOUNT);
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  await page.getByRole('button', { name: 'Buy BTC' }).click({ force: true });
  await expect(reviewSheet(page)).toHaveCount(0);
  expect(door.of('prepare')).toHaveLength(0);
  expect(signatures(wallet)).toBe(asked + 1);
  expect(await venueOpen(owner)).toEqual(before);
  // The person sends the same order again: the same signed bytes under the same key, with no second signature. The venue
  // answers, the desk names the order, and new orders may go again.
  await row.getByRole('button', { name: 'Send the same order again' }).click();
  await expect(page.getByTestId('venue-pending-found')).toHaveText(
    `Checked with the venue: your order ${cloid} is Open. Nothing was sent again.`,
    { timeout: 20_000 },
  );
  expect(signatures(wallet)).toBe(asked + 1);
  expect(door.of('submit')).toHaveLength(1);
  expect(door.of('submit')[0].body.actionKey).toBe(sent[0].actionKey);
  expect(door.of('submit')[0].body.signature).toEqual(sent[0].signature);
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeEnabled();
  // One venue order for that draft, and none for the one that waited.
  const after = await venueOpen(owner);
  expect(after).toHaveLength(before.length + 1);
  expect(after.filter((o) => o.venueClientOrderId === cloid)).toHaveLength(1);
  expect(after.filter((o) => sameDecimal(o.price, price))).toHaveLength(1);
});

test(`${J} #5 sends the same client id with a different price: refused with a typed reason before signing; the first order is untouched`, async () => {
  const s = state();
  const owner = ownerOf(s);
  const { first } = s;
  expect(first, '#1 placed an order').toBeTruthy();
  const before = await venueByClientId(owner, first.venueClientOrderId);
  const open = await venueOpen(owner);
  const client = await api(s.account);
  const other = fromUnits(toUnits(first.price) - toUnits('1'));
  const refused = await client.post('/api/v1/venue/prepare', {
    owner,
    signer: { role: 'owner', address: owner },
    intent: {
      kind: 'place_order',
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      amount: AMOUNT,
      price: other,
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: first.key,
      builderFee: null,
    },
    actionKey: null,
    stepUpApprovalId: null,
  });
  // Refused at prepare, so there is nothing to sign: a typed reason, no typed data.
  expect(refused.status, JSON.stringify(refused.body).slice(0, 300)).toBe(409);
  expect(refused.body.intafacedCode).toBe('idempotency.conflict');
  expect(refused.body.prepared).toBeUndefined();
  // The first order is untouched on the venue, and nothing new rests.
  const after = await venueByClientId(owner, first.venueClientOrderId);
  expect(after).toEqual(before);
  expect(sameDecimal(after.price, first.price)).toBe(true);
  expect(await venueOpen(owner)).toEqual(open);
});

test(`${J} #6 types an order bigger than the venue's free balance: refused in words before Confirm, no raw code; nothing signed`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const owner = ownerOf(s);
  const open = await venueOpen(owner);
  const door = doorCalls(page);
  const asked = signatures(wallet);
  const free = (await venueBalance(owner, 'USDC')).free;
  // One whole TEST BTC at 90% of the bid locks far more than the account has free.
  const price = await awayBid(90);
  expect(toUnits(price) > toUnits(free)).toBe(true);
  const { form, preview } = await typeLimitBuy(page, price, '1');
  expect(preview.status()).toBe(200);
  const lock = (await preview.json()).value.lock;
  const short = form.getByTestId('venue-ticket-short');
  await expect(short).toHaveText(
    `Not enough USDC free on your venue account: this order locks ${Number(lock.amount).toLocaleString('en-US', { maximumFractionDigits: 8 })} USDC and ${Number(free).toLocaleString('en-US', { maximumFractionDigits: 8 })} USDC is free.`,
  );
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  await expect(form).not.toContainText(/[a-z_]+\.[a-z_]+/); // no raw code
  await page.getByRole('button', { name: 'Buy BTC' }).click({ force: true });
  await expect(reviewSheet(page)).toHaveCount(0);
  expect(door.of('prepare')).toHaveLength(0);
  expect(door.of('submit')).toHaveLength(0);
  expect(signatures(wallet)).toBe(asked);
  expect(await venueOpen(owner)).toEqual(open);
});

test(`${J} #7 the numbers change between Review and Confirm: the new numbers show and the person is asked again before anything is sent`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const owner = ownerOf(s);
  const open = await venueOpen(owner);
  const door = doorCalls(page);
  // A buy one tick over the venue's bid: it would rest, as a maker, filling nothing now.
  const { body } = await testVenue('/markets', {});
  const tick = toUnits(body.value.find((m) => m.symbol === SYMBOL).tickSize);
  const bid = toUnits(await awayBid(100));
  const price = fromUnits(bid + tick);
  const { review } = await reviewLimitBuy(page, price);
  await expect(review.locator('dt', { hasText: 'Fee role' }).locator('xpath=..')).toContainText('Maker');
  // After the review opened, another TEST trader offers at that price on the venue, so this buy would now take it.
  const seller = `${J}-7-${process.env.JOURNEY_RUN_ID ?? 'local'}-${owner.slice(2, 10)}`;
  await testVenue('/test/deposit', {
    account: await venueAccount(otherTraderKey(seller).address),
    asset: 'BTC',
    amount: '1',
    depositRef: `seed:${seller}:BTC`,
  });
  const offerKey = `order:${seller}:js2-7-ask`;
  const offer = await otherTraderRun(seller, {
    kind: 'place_order',
    symbol: SYMBOL,
    side: 'sell',
    type: 'limit',
    amount: AMOUNT,
    price,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: offerKey,
    builderFee: null,
  });
  expect(offer.definite && offer.accepted, JSON.stringify(offer)).toBe(true);
  const asked = signatures(wallet);
  try {
    await review.getByRole('button', { name: 'Confirm buy' }).click();
    // The new numbers show, and the person is asked again: nothing is prepared, signed or sent.
    await expect(review.getByTestId('venue-review-moved')).toHaveText(
      'The venue’s numbers for this order changed since you reviewed it. Nothing was sent: check the new numbers and confirm again.',
    );
    await expect(review.locator('dt', { hasText: 'Fee role' }).locator('xpath=..')).toContainText('Taker');
    await expect(review.getByRole('button', { name: 'Confirm buy' })).toBeVisible();
    const previews = door.of('preview');
    const shown = previews.at(-1);
    expect(shown.body.intent.clientOrderKey).toBe(door.of('preview')[0].body.intent.clientOrderKey);
    expect(door.of('prepare')).toHaveLength(0);
    expect(door.of('submit')).toHaveLength(0);
    expect(signatures(wallet)).toBe(asked);
    await review.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(review).toHaveCount(0);
    expect(door.of('prepare')).toHaveLength(0);
    expect(await venueOpen(owner)).toEqual(open);
  } finally {
    await otherTraderRun(seller, { kind: 'cancel_order', symbol: SYMBOL, clientOrderKey: offerKey });
  }
});

// ── #8: a halted market, by the venue or by our operators ──────────────────────────────────────────────────────────

let operators;
async function ops() {
  if (!operators) {
    const ctx = await makeContext({ log: () => undefined });
    operators = { ctx, sessions: await approverSessions(ctx) };
  }
  return operators;
}

/** Keys sorted, no spaces: the canonical form svc-trade hashes (services/svc-trade/src/admin/common.ts payloadHash). */
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

/** Two operators change one venue market's listing through svc-trade's own two-person door (setup for #8). */
async function operatorsWrite(symbol, action, procedure, fields, expectedVersion) {
  const { ctx, sessions } = await ops();
  const venueId = (await venueInfo()).id;
  const reason = `LOCAL TEST ${J}: ${procedure} ${symbol}`;
  const ids = await twoPerson(ctx, sessions, {
    actionType: action,
    targetService: 'svc-trade',
    targetId: `venue-listing:${venueId}:${symbol}`,
    expectedVersion,
    payloadHash: hashOf({ actionType: action, venueId, symbol, ...fields, expectedVersion, reason }),
    policyVersion: 'trade-venue-markets-v1',
  });
  const res = await ctx.edge.mutate(
    'trade',
    `admin.venueMarkets.${procedure}`,
    { symbol, ...fields, expectedVersion, reason, ...ids },
    await sessions.a.tradeOpsToken(),
  );
  expect(trpcData(res)?.listing?.version, res.text.slice(0, 300)).toBe(Number(expectedVersion) + 1);
}

/** A fresh TEST spot market on the TEST venue, listed by two operators and open: no other file trades it. */
async function freshListedMarket(tag) {
  const base = `JS2${tag}${randomBytes(3).toString('hex').toUpperCase()}`;
  const symbol = `${base}-USDC`;
  const added = await testVenue('/test/market-add', {
    symbol,
    baseAsset: base,
    quoteAsset: 'USDC',
    maxOrderQty: null,
    maxOrderNotional: null,
  });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  await operatorsWrite(symbol, 'trade.venue_listing_set', 'listingSet', { opensAt: new Date(Date.now() - 60_000).toISOString() }, '0');
  return { symbol, base };
}

/**
 * Another venue desk in the same signed-in page, its TEST wallet already installed (a page takes it once). The desk may
 * restore the still-authorised wallet on its own, so Connect is pressed only while no address shows.
 */
async function deskAgain(page, wallet, path) {
  await page.goto(path);
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  const address = page.getByTestId('venue-wallet-address');
  const connect = page.getByRole('button', { name: 'Connect TEST Wallet' });
  await expect(async () => {
    if (await address.isVisible()) return;
    await connect.click({ timeout: 2_000 });
    await expect(address).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(address).toHaveText(wallet.address);
}

/** On the desk for `symbol`: a TEST limit buy at 10 placed and signed, resting on the venue; returns its venue record. */
async function restingBuy(page, wallet, owner, symbol, base) {
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  const form = page.locator('form[data-testid="dk-form"][data-side="buy"]');
  await form.getByRole('textbox', { name: 'Price' }).fill('10');
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await form.getByRole('textbox', { name: 'Amount' }).fill('1');
  expect((await answer).status()).toBe(200);
  await page.getByRole('button', { name: `Buy ${base}` }).click();
  await expect(reviewSheet(page)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm buy' }).click();
  await continueInWallet(page);
  await expect(page.getByTestId('venue-bottom').getByTestId('venue-outcome')).toContainText('Open on the venue.', { timeout: 20_000 });
  const mine = (await venueOpen(owner)).filter((o) => o.symbol === symbol);
  expect(mine).toHaveLength(1);
  return mine[0];
}

/** A new order on the halted market: refused before Confirm, naming who halted it; nothing prepared, signed or resting. */
async function refusedNaming(page, wallet, owner, symbol, base, who) {
  const door = doorCalls(page);
  const asked = signatures(wallet);
  const open = await venueOpen(owner);
  const form = page.locator('form[data-testid="dk-form"][data-side="buy"]');
  await form.getByRole('textbox', { name: 'Price' }).fill('11');
  await form.getByRole('textbox', { name: 'Amount' }).fill('1');
  const refusal = form.getByTestId('venue-ticket-refused');
  await expect(refusal).toHaveText(who, { timeout: 20_000 });
  await expect(form).not.toContainText(/[a-z_]+\.[a-z_]+_[a-z_]+/); // no raw code
  await expect(page.getByRole('button', { name: `Buy ${base}` })).toBeDisabled();
  await page.getByRole('button', { name: `Buy ${base}` }).click({ force: true });
  await expect(reviewSheet(page)).toHaveCount(0);
  expect(door.of('prepare')).toHaveLength(0);
  expect(signatures(wallet)).toBe(asked);
  expect(await venueOpen(owner)).toEqual(open);
}

/** Cancel on the earlier order still works on the halted market: cancelled on the venue once, its lock released. */
async function cancelStillWorks(page, owner, earlier) {
  const usedBefore = toUnits((await venueBalance(owner, 'USDC')).locked);
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
  const row = page.getByTestId('venue-bottom').locator('tr', { hasText: earlier.symbol }).filter({ hasText: 'Open' });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: /Cancel/ }).click();
  await continueInWallet(page);
  await expect(page.getByTestId('venue-bottom').getByTestId('venue-outcome')).toContainText('Cancelled on the venue', { timeout: 20_000 });
  const after = await venueByClientId(owner, earlier.venueClientOrderId);
  expect(after.status).toBe('canceled');
  expect((await venueOpen(owner)).filter((o) => o.symbol === earlier.symbol)).toHaveLength(0);
  expect(usedBefore - toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(toUnits(earlier.locked));
}

test(`${J} #8 places a TEST order on a market the venue or our operator has halted: refused naming who halted it, nothing rests; Cancel on an earlier order still works`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const s = state();
  const owner = ownerOf(s);
  const { displayName } = await venueInfo();

  // Halted by the venue.
  const byVenue = await freshListedMarket('V');
  const wallet = await openVenueDesk(page, s.account, `/trade/spot/${byVenue.symbol}`, s.walletKey);
  const earlierV = await restingBuy(page, wallet, owner, byVenue.symbol, byVenue.base);
  expect((await testVenue('/test/market-status', { symbol: byVenue.symbol, status: 'halted' })).status).toBe(200);
  try {
    await page.reload();
    await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
    await refusedNaming(
      page,
      wallet,
      owner,
      byVenue.symbol,
      byVenue.base,
      `This order can’t be placed: ${byVenue.symbol} is halted on ${displayName}.`,
    );
    // A halt leaves the earlier order resting until a cancel ends it, once.
    expect((await venueByClientId(owner, earlierV.venueClientOrderId)).status).toBe('open');
    await cancelStillWorks(page, owner, earlierV);
  } finally {
    await testVenue('/test/market-status', { symbol: byVenue.symbol, status: 'trading' });
  }

  // Halted by our operators: two of them stop routing new orders to the market.
  const byUs = await freshListedMarket('O');
  await deskAgain(page, wallet, `/trade/spot/${byUs.symbol}`);
  const earlierO = await restingBuy(page, wallet, owner, byUs.symbol, byUs.base);
  await operatorsWrite(byUs.symbol, 'trade.venue_routing_set', 'routingSet', { routing: 'stop' }, '1');
  await page.reload();
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  await refusedNaming(
    page,
    wallet,
    owner,
    byUs.symbol,
    byUs.base,
    `This order can’t be placed: INTAFACED stopped routing new orders to ${byUs.symbol}.`,
  );
  expect((await venueByClientId(owner, earlierO.venueClientOrderId)).status).toBe('open');
  await cancelStillWorks(page, owner, earlierO);
});
