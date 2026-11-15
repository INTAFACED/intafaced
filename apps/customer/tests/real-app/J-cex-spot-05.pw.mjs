// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fromUnits, journeyState, restartWithSetting, toUnits } from './stack.mjs';
import { reviewSheet, signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  sameDecimal,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-cex-spot-05, in the running app (docs/roadmap/journeys.json; project-state operation-zero/modules/cex-spot/acceptance/
// journeys.md): a person changes and cancels open venue orders, one by one or all at once, and the venue's lock matches
// the order after every step. One test per step, titled "J-cex-spot-05 #<n>", on one TEST account: verified, its TEST
// wallet connected, TEST USDC and TEST BTC in its own venue account, TEST orders resting far under the venue's bids in two
// markets (BTC-USDC spot and BTC-PERP), on the venue spot desk. Every figure is TEST, and every order, lock and answer is
// read from the stack's TEST venue itself (packages/venue-sim), never our ledger or engine; the ledger is read only to
// show it posts nothing. The user-venue door is on for this file only.
const J = 'J-cex-spot-05';
const DESK = '/trade/spot/BTC-USDC';
const SPOT = 'BTC-USDC';
const PERP = 'BTC-PERP';
const START_USDC = '3000';
const START_BTC = '0.01';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J}'s TEST setup made no account and wallet, so this step has no one to act as`);
  return s;
}
const ownerOf = (s) => privateKeyToAccount(s.walletKey).address.toLowerCase();

/** The person's open orders and one order by its client id, from the TEST venue's own record. */
const venueOpen = async (owner) => (await venueRecord(owner, '/open-orders')).value;
const venueOrder = async (owner, venueClientOrderId) => (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId })).value;
/** USDC free and locked on the venue account, in units. */
async function usdc(owner) {
  const b = await venueBalance(owner, 'USDC');
  return { free: toUnits(b.free), locked: toUnits(b.locked) };
}
/** What the venue locks for every live order of the person, summed, in units. */
const lockedByOrders = async (owner) => (await venueOpen(owner)).reduce((sum, o) => sum + toUnits(o.locked), 0n);

/** The wallet's signature prompts so far (typed data is the only thing an action is signed as). */
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

/**
 * The person signs and sends one action on the TEST venue directly with their own TEST wallet key, as from another app or
 * device: an order placed this way rests on the venue and is the person's, though this page never placed it.
 */
async function ownRun(walletKey, intent) {
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  const account = await venueAccount(owner);
  const prepared = await testVenue('/prepare', { account, signer: { role: 'owner', address: owner }, intent });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const t = prepared.body.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  return sent.body;
}

/** A TEST resting buy placed from another device; returns its client id on the venue. */
async function restBuy(walletKey, symbol, price, amount, tag) {
  const answer = await ownRun(walletKey, {
    kind: 'place_order',
    symbol,
    side: 'buy',
    type: 'limit',
    amount,
    price,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${J.toLowerCase()}:${tag}:${randomBytes(4).toString('hex')}`,
    builderFee: null,
  });
  expect(answer, JSON.stringify(answer).slice(0, 300)).toMatchObject({ accepted: true, order: { status: 'open' } });
  return answer.order.venueClientOrderId;
}

/** A TEST price `percent` of the venue's own best bid on `symbol`, on its tick: a buy there rests and never fills. */
async function awayBid(percent, symbol = SPOT) {
  const { body } = await testVenue('/markets', {});
  const market = body.value.find((m) => m.symbol === symbol);
  expect(market, JSON.stringify(body).slice(0, 300)).toBeTruthy();
  const { id } = await venueInfo();
  // The TEST venue's own bid maker (venue-reads.mjs venueBook): the bid is read from the venue, never our engine.
  const bidder = privateKeyToAccount(keccak256(toHex('intafaced TEST venue maker bid'))).address.toLowerCase();
  const read = await testVenue('/open-orders', { account: { venueId: id, owner: bidder, subAccount: null } });
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  const bids = read.body.value.filter((o) => o.symbol === symbol && o.side === 'buy').map((o) => toUnits(o.price));
  expect(bids.length, `the TEST venue has bids on ${symbol}`).toBeGreaterThan(0);
  const best = bids.reduce((a, b) => (b > a ? b : a));
  const tick = toUnits(market.tickSize);
  return fromUnits(((best * BigInt(percent)) / 100n / tick) * tick);
}

/** Our ledger's view of this account: the venue journeys' ledger posts nothing. */
const ledgerView = async (who) => (await api(who)).balances();

const openRows = (page) => page.getByTestId('venue-open-orders').locator('tbody tr');
const rowOf = (page, cloid) => page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${cloid}"]`);
/** A figure as the desk writes it ("43,200" or "0.002 USDC"), read back as units. */
const shownUnits = (text) => toUnits(text.replace(/,/g, '').trim().split(/\s+/)[0]);

/**
 * TEST setup, not a step (the Starts line), made at the start of #1: a verified account, this run's TEST wallet key, TEST
 * USDC and TEST BTC in its own venue account by the TEST venue's deposit control (keyed by chain-transfer-shaped
 * references), and TEST orders resting far under the venue's bids, placed from another device: three on BTC-USDC and one
 * on BTC-PERP. Made in #1, never in a beforeAll: a worker that restarts after a failed step would run a beforeAll again and
 * replace the account the later steps act as.
 */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'js5v');
    await verify(page, account);
    const walletKey = testWalletKey();
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', START_USDC, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    expect(await testDeposit(owner, 'BTC', START_BTC, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    const leverage = await ownRun(walletKey, { kind: 'update_leverage', symbol: PERP, leverageBps: 10_000, marginMode: 'isolated' });
    expect(leverage).toMatchObject({ accepted: true });
    const prices = { a: await awayBid(80), b: await awayBid(70), c: await awayBid(60), p: await awayBid(70, PERP) };
    const orders = {
      a: await restBuy(walletKey, SPOT, prices.a, '0.002', 'a'),
      b: await restBuy(walletKey, SPOT, prices.b, '0.001', 'b'),
      c: await restBuy(walletKey, SPOT, prices.c, '0.001', 'c'),
      p: await restBuy(walletKey, PERP, prices.p, '0.001', 'p'),
    };
    run.reset({ account, walletKey, orders, prices, ledger: await ledgerView(account) });
  } finally {
    await page.close();
  }
}

/** The ledger shows the same as at the start: nothing in this journey posts to it. */
async function ledgerUntouched(s) {
  expect(await ledgerView(s.account)).toEqual(s.ledger);
}

test(`${J} #1 opens Open orders: each open venue order with its price, amount, filled and the venue's lock`, async ({ page, browser }) => {
  test.setTimeout(420_000);
  await startsLine(browser);
  const s = state();
  const owner = ownerOf(s);
  await openVenueDesk(page, s.account, DESK, s.walletKey);
  await page.getByRole('tab', { name: 'Open orders' }).click();
  const heads = page.getByTestId('venue-open-orders').locator('thead th');
  for (const head of ['Select', 'Market', 'Price', 'Amount', 'Filled', 'Locked'])
    await expect(heads.filter({ hasText: head })).toHaveCount(1);
  const open = await venueOpen(owner);
  expect(open.map((o) => o.venueClientOrderId).sort()).toEqual(Object.values(s.orders).sort());
  await expect(openRows(page)).toHaveCount(open.length, { timeout: 20_000 });
  // Two markets: every one of the person's orders on the venue is a row, each with the venue's own figures.
  expect(new Set(open.map((o) => o.symbol))).toEqual(new Set([SPOT, PERP]));
  for (const o of open) {
    const row = rowOf(page, o.venueClientOrderId);
    await expect(row.locator('td').nth(1)).toHaveText(o.symbol);
    expect(shownUnits(await row.locator('[data-cell=price]').innerText())).toBe(toUnits(o.price));
    expect(shownUnits(await row.locator('[data-cell=amount]').innerText())).toBe(toUnits(o.amount));
    expect(shownUnits(await row.locator('[data-cell=filled]').innerText())).toBe(0n);
    const locked = await row.locator('[data-cell=locked]').innerText();
    expect(shownUnits(locked)).toBe(toUnits(o.locked));
    expect(locked).toContain(o.lockedAsset);
    // The venue's lock matches the order: a spot buy locks its price times its amount, never nothing.
    expect(toUnits(o.locked)).toBeGreaterThan(0n);
    if (o.symbol === SPOT) expect(toUnits(o.locked)).toBe((toUnits(o.price) * toUnits(o.remaining)) / toUnits('1'));
  }
  // What the venue account has locked is exactly what its orders lock.
  expect((await usdc(owner)).locked).toBe(await lockedByOrders(owner));
  await ledgerUntouched(s);
});

test(`${J} #2 lowers the amount of an open order: the same order, a smaller venue lock, the same price, its place in the queue kept, where the venue amends in place; otherwise a reviewed cancel-and-replace, signed once`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const s = state();
  const owner = ownerOf(s);
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const before = await venueOrder(owner, s.orders.a);
  const queue = (await venueOpen(owner)).map((o) => o.venueClientOrderId);
  await rowOf(page, s.orders.a)
    .getByRole('button', { name: `Edit order ${s.orders.a}` })
    .click();
  const dialog = page.getByTestId('venue-edit');
  await dialog.getByRole('textbox', { name: 'Amount left' }).fill('0.001');
  await expect(dialog).toContainText('Lowering the amount keeps your place in the queue; the venue changes the order in place.');
  const asked = signatures(wallet);
  await dialog.getByRole('button', { name: 'Change amount' }).click();
  await continueInWallet(page);
  const note = dialog.getByTestId('venue-edit-note');
  await expect(note).toContainText('Your place in the queue was kept', { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  const after = await venueOrder(owner, s.orders.a);
  expect(after).toMatchObject({ venueOrderId: before.venueOrderId, status: 'open', symbol: SPOT });
  expect(sameDecimal(after.price, before.price)).toBe(true);
  expect(sameDecimal(after.remaining, '0.001')).toBe(true);
  expect(toUnits(after.locked)).toBeLessThan(toUnits(before.locked));
  expect(toUnits(after.locked)).toBe((toUnits(after.price) * toUnits(after.remaining)) / toUnits('1'));
  await expect(note).toContainText(`${fromUnits(toUnits(after.locked)).split('.')[0]}`);
  // Its place: the venue still lists it where it was, ahead of every order placed after it.
  expect((await venueOpen(owner)).map((o) => o.venueClientOrderId)).toEqual(queue);
  await dialog.getByRole('button', { name: 'Close' }).click();
  // On screen: the same order's row, its smaller lock, its smaller amount, its same price.
  await expect(rowOf(page, s.orders.a)).toHaveCount(1);
  const cell = async (cloid, name) => shownUnits(await rowOf(page, cloid).locator(`[data-cell=${name}]`).innerText());
  await expect.poll(() => cell(s.orders.a, 'locked'), { timeout: 20_000 }).toBe(toUnits(after.locked));
  expect(await cell(s.orders.a, 'amount')).toBe(toUnits(after.amount));
  expect(await cell(s.orders.a, 'price')).toBe(toUnits(before.price));
  expect((await usdc(owner)).locked).toBe(await lockedByOrders(owner));

  // Where the venue doesn't amend in place: the same running TEST venue declares no amend, and svc-trade restarted so it
  // reads the venue afresh. A TEST order from another device is lowered: reviewed first, then one signed
  // cancel-and-replace at the same price under the replacement's own client id.
  const d = await restBuy(s.walletKey, SPOT, await awayBid(55), '0.002', 'lower-replace');
  await testVenue('/test/switches', { amendsInPlace: false });
  restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'on');
  let replacementId = null;
  try {
    expect((await testVenue('/venue')).body.venue.amendsInPlace).toBeUndefined();
    const plain = await openVenueDesk(page, s.account, DESK, s.walletKey);
    const door = doorCalls(page);
    const dBefore = await venueOrder(owner, d);
    await rowOf(page, d)
      .getByRole('button', { name: `Edit order ${d}` })
      .click({ timeout: 30_000 });
    await dialog.getByRole('textbox', { name: 'Amount left' }).fill('0.001');
    await expect(dialog).toContainText(
      'This venue doesn’t change an order in place: the order is cancelled and placed again for the new amount, signed once, and it loses its place in the queue. You review it first.',
    );
    await expect(dialog.getByRole('button', { name: 'Change amount' })).toHaveCount(0);
    const askedPlain = signatures(plain);
    await dialog.getByRole('button', { name: 'Review new amount' }).click();
    const review = dialog.getByTestId('venue-replace-review');
    await expect(review).toContainText('One signature covers both.', { timeout: 20_000 });
    const lockShown = shownUnits((await review.getByTestId('venue-replace-lock').innerText()).replace('The venue locks ', ''));
    expect(lockShown).toBe((toUnits(dBefore.price) * toUnits('0.001')) / toUnits('1'));
    // Reviewed first: nothing prepared or signed yet, and the order rests as it was.
    expect(door.of('prepare')).toHaveLength(0);
    expect(signatures(plain)).toBe(askedPlain);
    expect(await venueOrder(owner, d)).toEqual(dBefore);
    const prepared = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/prepare' && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Cancel and replace' }).click();
    await continueInWallet(page);
    await expect(note).toContainText('The venue cancelled the original order and released its lock. The replacement', { timeout: 20_000 });
    // Signed once: one signature, one prepared action, the cancel-and-replace of this order at its own price.
    expect(signatures(plain)).toBe(askedPlain + 1);
    expect(door.of('prepare')).toHaveLength(1);
    const sent = door.of('prepare')[0].body.intent;
    expect(sent).toMatchObject({ kind: 'replace_order', symbol: SPOT, venueClientOrderId: d });
    expect(sameDecimal(sent.order.amount, '0.001')).toBe(true);
    expect(sameDecimal(sent.order.price, dBefore.price)).toBe(true);
    replacementId = (await (await prepared).json()).prepared.venueClientOrderId;
    expect(replacementId).toBeTruthy();
    expect(replacementId).not.toBe(d);
    const original = await venueOrder(owner, d);
    expect(original).toMatchObject({ status: 'canceled' });
    expect(toUnits(original.locked)).toBe(0n);
    const replacement = await venueOrder(owner, replacementId);
    expect(replacement).toMatchObject({ status: 'open', symbol: SPOT, side: 'buy' });
    expect(sameDecimal(replacement.price, dBefore.price)).toBe(true);
    expect(sameDecimal(replacement.remaining, '0.001')).toBe(true);
    expect(toUnits(replacement.locked)).toBe(lockShown);
    expect(toUnits(replacement.locked)).toBeLessThan(toUnits(dBefore.locked));
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => cell(replacementId, 'locked'), { timeout: 20_000 }).toBe(lockShown);
    expect(await cell(replacementId, 'price')).toBe(toUnits(dBefore.price));
    expect(await cell(replacementId, 'amount')).toBe(toUnits('0.001'));
    expect((await usdc(owner)).locked).toBe(await lockedByOrders(owner));
  } finally {
    // The replacement goes, from the same other device, so the later steps meet only their own orders; the venue amends
    // in place again.
    if (replacementId)
      expect(
        (await ownRun(s.walletKey, { kind: 'cancel_orders', orders: [{ symbol: SPOT, venueClientOrderId: replacementId }] })).legs[0],
      ).toMatchObject({ accepted: true });
    await testVenue('/test/switches', { amendsInPlace: true });
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'on');
  }
  expect((await testVenue('/venue')).body.venue.amendsInPlace).toBe(true);
  await ledgerUntouched(s);
});

test(`${J} #3 tries to raise the amount: refused with a typed reason in words before the wallet is asked; the order and its venue lock untouched`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const owner = ownerOf(s);
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const before = await venueOrder(owner, s.orders.a);
  const balanceBefore = await usdc(owner);
  await rowOf(page, s.orders.a)
    .getByRole('button', { name: `Edit order ${s.orders.a}` })
    .click();
  const dialog = page.getByTestId('venue-edit');
  await dialog.getByRole('textbox', { name: 'Amount left' }).fill('0.005');
  const asked = signatures(wallet);
  await dialog.getByRole('button', { name: 'Change amount' }).click();
  const note = dialog.getByTestId('venue-edit-note');
  await expect(note).toHaveAttribute('data-code', 'trade.venue_order_amount_raise', { timeout: 20_000 });
  await expect(note).toContainText("raising an order's amount is refused");
  await expect(note).toContainText('This order and its lock are untouched');
  expect(signatures(wallet)).toBe(asked);
  expect(await venueOrder(owner, s.orders.a)).toEqual(before);
  expect(await usdc(owner)).toEqual(balanceBefore);
  await ledgerUntouched(s);
});

test(`${J} #4 changes the price: reviewed first, then the original is cancelled on the venue and the replacement rests under its own client id; a failed replacement never calls the old order safe; submitting twice returns the first`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const owner = ownerOf(s);
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const door = doorCalls(page);
  const dialog = page.getByTestId('venue-edit');

  // A replacement the venue refuses after cancelling the original: a TEST order from another device first takes almost
  // all the free USDC, so the dearer replacement can't be locked.
  const higher = await awayBid(90);
  const free = (await usdc(owner)).free;
  const fillerPrice = await awayBid(50);
  const lot = toUnits('0.0001');
  const fillerAmount = fromUnits((((free - toUnits('2')) * toUnits('1')) / toUnits(fillerPrice) / lot) * lot);
  const filler = await restBuy(s.walletKey, SPOT, fillerPrice, fillerAmount, 'filler');
  await rowOf(page, s.orders.c)
    .getByRole('button', { name: `Edit order ${s.orders.c}` })
    .click();
  await dialog.getByRole('textbox', { name: 'Price' }).fill(higher);
  await expect(dialog).toContainText('A new price cancels this order on the venue and places a new one under its own client id.');
  await dialog.getByRole('button', { name: 'Review new price' }).click();
  await expect(dialog.getByTestId('venue-replace-review')).toContainText('One signature covers both.', { timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Cancel and replace' }).click();
  await continueInWallet(page);
  const note = dialog.getByTestId('venue-edit-note');
  await expect(note).toContainText('The venue cancelled the original order and released its lock, then refused the replacement', {
    timeout: 20_000,
  });
  await expect(note).toContainText('Nothing of yours rests at the new price.');
  // It never says a replacement rests, nor that the original still does.
  await expect(note).not.toContainText(/The replacement \S+ rests at/);
  await expect(note).not.toContainText(/original order (still )?rests/);
  expect(await venueOrder(owner, s.orders.c)).toMatchObject({ status: 'canceled' });
  expect(toUnits((await venueOrder(owner, s.orders.c)).locked)).toBe(0n);
  const failedKey = (await dialog.getByTestId('venue-replace-id').innerText()).split(': ').at(-1).trim();
  const failedId = door.of('prepare').at(-1).body.intent.order.clientOrderKey;
  expect(failedId).toBe(failedKey);
  await dialog.getByRole('button', { name: 'Close' }).click();
  // The filler goes, from the same other device.
  expect(
    (await ownRun(s.walletKey, { kind: 'cancel_orders', orders: [{ symbol: SPOT, venueClientOrderId: filler }] })).legs[0],
  ).toMatchObject({
    accepted: true,
  });
  // The refused replacement rests nowhere: no open order carries its key.
  expect((await venueOpen(owner)).filter((o) => o.side === 'buy' && sameDecimal(o.price, higher))).toEqual([]);

  // The change that goes through: order b at a new price, reviewed, then cancelled and replaced in one signed action.
  const before = await venueOrder(owner, s.orders.b);
  const newPrice = await awayBid(65);
  await rowOf(page, s.orders.b)
    .getByRole('button', { name: `Edit order ${s.orders.b}` })
    .click();
  await dialog.getByRole('textbox', { name: 'Price' }).fill(newPrice);
  await dialog.getByRole('button', { name: 'Review new price' }).click();
  const review = dialog.getByTestId('venue-replace-review');
  await expect(review).toBeVisible({ timeout: 20_000 });
  const lockShown = shownUnits((await review.getByTestId('venue-replace-lock').innerText()).replace('The venue locks ', ''));
  expect(lockShown).toBe((toUnits(newPrice) * toUnits(before.remaining)) / toUnits('1'));
  const asked = signatures(wallet);
  const prepared = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/prepare' && r.request().method() === 'POST');
  const submitted = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/submit' && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Cancel and replace' }).click();
  await continueInWallet(page);
  await expect(note).toContainText('The venue cancelled the original order and released its lock. The replacement', { timeout: 20_000 });
  const firstAnswer = await (await submitted).json();
  expect(signatures(wallet)).toBe(asked + 1);
  const replacementId = (await (await prepared).json()).prepared.venueClientOrderId;
  expect(replacementId).toBeTruthy();
  expect(replacementId).not.toBe(s.orders.b);
  await expect(note).toContainText(`The replacement ${replacementId} rests at`);
  const original = await venueOrder(owner, s.orders.b);
  expect(original).toMatchObject({ status: 'canceled' });
  expect(toUnits(original.locked)).toBe(0n);
  const replacement = await venueOrder(owner, replacementId);
  expect(replacement).toMatchObject({ status: 'open', symbol: SPOT, side: 'buy' });
  expect(sameDecimal(replacement.price, newPrice)).toBe(true);
  expect(sameDecimal(replacement.remaining, before.remaining)).toBe(true);
  expect(toUnits(replacement.locked)).toBe(lockShown);
  // Submitting twice returns the first. The same signed action sent to the door again, as a lost answer's retry sends it:
  // the door answers with the first answer, word for word, and nothing new happens on the venue.
  expect(firstAnswer.outcome).toMatchObject({
    accepted: true,
    legs: [
      { accepted: true, order: { venueClientOrderId: s.orders.b, status: 'canceled' } },
      { accepted: true, order: { venueClientOrderId: replacementId, status: 'open' } },
    ],
  });
  const firstSubmit = door.of('submit').at(-1).body;
  expect(firstSubmit.actionKey).toBe(door.of('prepare').at(-1).body.actionKey);
  const again = await (await api(s.account)).post('/api/v1/venue/submit', firstSubmit);
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.actionKey).toBe(firstAnswer.actionKey);
  expect(again.body.outcome).toEqual(firstAnswer.outcome);
  expect(signatures(wallet)).toBe(asked + 1);
  expect((await venueOpen(owner)).filter((o) => o.venueClientOrderId === replacementId)).toHaveLength(1);
  expect(await venueOrder(owner, replacementId)).toEqual(replacement);
  expect(await venueOrder(owner, s.orders.b)).toEqual(original);
  // And pressed twice on the page: the same answer shown, no second signature asked.
  await dialog.getByRole('button', { name: 'Cancel and replace' }).click();
  await expect(note).toContainText(`The replacement ${replacementId} rests at`);
  expect(signatures(wallet)).toBe(asked + 1);
  expect((await venueOpen(owner)).filter((o) => o.venueClientOrderId === replacementId)).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Close' }).click();
  // Every lock the venue holds is an order's: the original's was released once.
  expect((await usdc(owner)).locked).toBe(await lockedByOrders(owner));
  run.write({ ...run.read(), replacement: replacementId });
  await ledgerUntouched(s);
});

test(`${J} #5 presses Cancel all in this market: asked first; only this market's orders cancel, in one request; every venue lock released`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const owner = ownerOf(s);
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const door = doorCalls(page);
  const open = await venueOpen(owner);
  const here = open.filter((o) => o.symbol === SPOT).map((o) => o.venueClientOrderId);
  const elsewhere = open.filter((o) => o.symbol !== SPOT);
  expect(here.sort()).toEqual([s.orders.a, s.replacement].sort());
  expect(elsewhere.map((o) => o.venueClientOrderId)).toEqual([s.orders.p]);
  await expect(openRows(page)).toHaveCount(open.length, { timeout: 20_000 });
  await page.getByRole('button', { name: `Cancel all in ${SPOT} (2)` }).click();
  const ask = page.getByTestId('venue-cancel-ask');
  await expect(ask).toContainText(`Cancel every open order in ${SPOT}?`);
  await expect(ask).toContainText('Orders in other markets stay.');
  // Asked first: nothing is sent before the person confirms.
  expect(door.of('prepare')).toHaveLength(0);
  const asked = signatures(wallet);
  await ask.getByRole('button', { name: 'Cancel 2 orders' }).click();
  await continueInWallet(page);
  const lines = ask.getByTestId('venue-cancel-lines');
  await expect(lines.locator('li[data-ok=yes]')).toHaveCount(2, { timeout: 20_000 });
  // One request, signed once, naming exactly this market's orders.
  expect(signatures(wallet)).toBe(asked + 1);
  expect(door.of('prepare')).toHaveLength(1);
  expect(door.of('submit')).toHaveLength(1);
  const sent = door.of('prepare')[0].body.intent;
  expect(sent.kind).toBe('cancel_orders');
  expect(sent.orders.map((o) => o.venueClientOrderId).sort()).toEqual(here.sort());
  for (const id of here) {
    await expect(lines.locator(`li[data-client-order-id="${id}"]`)).toContainText('cancelled on the venue; its lock is released');
    const o = await venueOrder(owner, id);
    expect(o.status).toBe('canceled');
    expect(toUnits(o.locked)).toBe(0n);
  }
  // The other market's order and its lock are untouched.
  const perp = await venueOrder(owner, s.orders.p);
  expect(perp).toEqual(elsewhere[0]);
  expect((await usdc(owner)).locked).toBe(toUnits(perp.locked));
  await ledgerUntouched(s);
});

test(`${J} #6 cancels a batch by ids, then the selected, then spot only, then all markets: each id answered from the venue, an unknown id reported, "Spot only" leaves other products alone`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const owner = ownerOf(s);
  const x1 = await restBuy(s.walletKey, SPOT, await awayBid(75), '0.001', 'x1');
  const x2 = await restBuy(s.walletKey, SPOT, await awayBid(74), '0.001', 'x2');
  const x3 = await restBuy(s.walletKey, SPOT, await awayBid(73), '0.001', 'x3');

  // By ids, as a pro trader's own script sends it through the door: one signed action, each id answered by the venue.
  const unknown = `0x${randomBytes(16).toString('hex')}`;
  const door = await api(s.account);
  const key = privateKeyToAccount(s.walletKey);
  const prep = await door.post('/api/v1/venue/prepare', {
    owner,
    signer: { role: 'owner', address: owner },
    intent: {
      kind: 'cancel_orders',
      orders: [
        { symbol: SPOT, venueClientOrderId: x1 },
        { symbol: SPOT, venueClientOrderId: unknown },
      ],
    },
    actionKey: `cancel-batch:${owner}:js5-${randomBytes(4).toString('hex')}`,
  });
  expect(prep.status, JSON.stringify(prep.body).slice(0, 300)).toBe(200);
  const t = prep.body.prepared.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await door.post('/api/v1/venue/submit', {
    actionKey: prep.body.actionKey,
    signature: { digest: prep.body.prepared.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
  expect(sent.body.outcome).toMatchObject({
    accepted: true,
    legs: [
      { accepted: true, order: { venueClientOrderId: x1, status: 'canceled' } },
      { accepted: false, refusal: { code: 'unknown_order' } },
    ],
  });
  expect(sent.body.outcome.legs[1].refusal.detail).toContain(unknown);
  expect(await venueOrder(owner, x1)).toMatchObject({ status: 'canceled', locked: '0' });

  // The ones selected on the desk.
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  await expect(rowOf(page, x2)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('checkbox', { name: `Select order ${x2}` }).check();
  await page.getByRole('button', { name: 'Cancel selected (1)' }).click();
  const ask = page.getByTestId('venue-cancel-ask');
  await expect(ask).toContainText('Cancel the orders you selected?');
  let asked = signatures(wallet);
  await ask.getByRole('button', { name: 'Cancel 1 orders' }).click();
  await continueInWallet(page);
  await expect(ask.locator(`li[data-client-order-id="${x2}"]`)).toContainText(`${SPOT} ${x2}: cancelled on the venue`, { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  expect((await venueOrder(owner, x2)).status).toBe('canceled');
  expect((await venueOrder(owner, x3)).status).toBe('open');
  await ask.getByRole('button', { name: 'Close' }).click();

  // Spot only: every spot order, and the perpetual left alone.
  const perpBefore = await venueOrder(owner, s.orders.p);
  await page.getByRole('button', { name: 'Cancel all: spot only' }).click();
  await expect(ask).toContainText('Cancel every open spot order?');
  await expect(ask).toContainText('1 open spot orders are cancelled in one request you sign once. Other products’ orders stay.');
  asked = signatures(wallet);
  await ask.getByRole('button', { name: 'Cancel 1 orders' }).click();
  await continueInWallet(page);
  await expect(ask.locator(`li[data-client-order-id="${x3}"]`)).toContainText('cancelled on the venue', { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  expect((await venueOrder(owner, x3)).status).toBe('canceled');
  expect(await venueOrder(owner, s.orders.p)).toEqual(perpBefore);
  await ask.getByRole('button', { name: 'Close' }).click();

  // All markets: the perpetual too.
  // The desk has read the venue again: no row shows that order open (one this page didn't place leaves the table).
  await expect(rowOf(page, x3).filter({ has: page.locator('[data-cell=status]', { hasText: /^Open$/ }) })).toHaveCount(0, {
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Cancel all markets' }).click();
  await expect(ask).toContainText('Cancel every open order in every market?');
  await ask.getByRole('button', { name: 'Cancel 1 orders' }).click();
  await continueInWallet(page);
  await expect(ask.locator(`li[data-client-order-id="${s.orders.p}"]`)).toContainText(`${PERP} ${s.orders.p}: cancelled on the venue`, {
    timeout: 20_000,
  });
  // Every venue order of this journey ended exactly once: none is open, none locks anything, and the account's USDC is
  // all free again, exactly what was deposited (nothing filled, nothing released twice).
  expect(await venueOpen(owner)).toEqual([]);
  for (const id of [...Object.values(s.orders), s.replacement, x1, x2, x3]) expect(toUnits((await venueOrder(owner, id)).locked)).toBe(0n);
  expect(await usdc(owner)).toEqual({ free: toUnits(START_USDC), locked: 0n });
  await ledgerUntouched(s);
});

test(`${J} #7 looks at the Positions tab: not applicable to cash spot, and no zero row`, async ({ page }) => {
  test.setTimeout(240_000);
  const s = state();
  await openVenueDesk(page, s.account, DESK, s.walletKey);
  await page.getByTestId('venue-bottom').getByRole('tab', { name: 'Positions' }).click();
  const panel = page.getByTestId('venue-bottom').getByRole('tabpanel');
  await expect(page.getByTestId('venue-positions-na')).toHaveText('Not applicable: cash spot holds balances, not positions');
  await expect(panel.locator('table, tr')).toHaveCount(0);
  await expect(panel).not.toContainText(/\b0(\.0+)?\s*BTC\b/);
});

test(`${J} #8 presses Flatten on a held coin: one reviewed market sell of all of it on the venue, signed once, under a retry-safe client id that is the same on every retry`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const owner = ownerOf(s);
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const door = doorCalls(page);
  const btcBefore = await venueBalance(owner, 'BTC');
  expect(sameDecimal(btcBefore.free, START_BTC)).toBe(true);
  const account = page.getByTestId('venue-account');
  const flatten = account.getByRole('button', { name: 'Flatten BTC' });
  await expect(flatten).toBeVisible({ timeout: 20_000 });

  // The review comes first; leaving it and pressing Flatten again keeps the same client id for the same sell.
  await flatten.click();
  const sheet = reviewSheet(page);
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await expect(sheet).toContainText(START_BTC);
  const id = (await sheet.getByTestId('client-order-id').innerText()).trim();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0);
  await flatten.click();
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await expect(sheet.getByTestId('client-order-id')).toHaveText(id);
  expect(door.of('prepare')).toHaveLength(0);

  // A spot sell carries our builder fee: until the wallet has approved it, the review asks for that approval first.
  const approve = sheet.getByRole('button', { name: 'Approve our builder fee in your wallet' });
  if ((await approve.count()) > 0) {
    const before = wallet.requests.length;
    await approve.click();
    await continueInWallet(page);
    await expect.poll(() => wallet.requests.length, { timeout: 20_000 }).toBe(before + 1);
  }
  await expect(sheet.getByRole('button', { name: 'Confirm sell' })).toBeEnabled({ timeout: 20_000 });

  // The answer is lost on its way back: the sell reaches the venue once, and the desk reads it back by the same id.
  await page.route('**/api/v1/venue/submit', async (route) => {
    await route.fetch();
    await route.abort('connectionreset');
  });
  const asked = signatures(wallet);
  const submitsBefore = door.of('submit').length;
  const prepared = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/prepare' && r.request().method() === 'POST');
  await sheet.getByRole('button', { name: 'Confirm sell' }).click();
  await continueInWallet(page);
  const prep = await (await prepared).json();
  const sell = prep.prepared.intent;
  expect(sell).toMatchObject({ kind: 'place_order', symbol: SPOT, side: 'sell', type: 'market' });
  expect(sameDecimal(sell.amount, START_BTC)).toBe(true);
  const cloid = prep.prepared.venueClientOrderId;
  await expect(page.getByTestId('venue-pending-found')).toContainText(`your order ${cloid} is Filled. Nothing was sent again.`, {
    timeout: 30_000,
  });
  await page.unrouteAll({ behavior: 'wait' });
  expect(signatures(wallet)).toBe(asked + 1);
  // The sell was sent once (an approval of our builder fee, when the wallet needed one, is its own action before it).
  expect(door.of('submit')).toHaveLength(submitsBefore + 1);
  expect(door.of('submit').at(-1).body.actionKey).toBe(sell.clientOrderKey);
  // The client id the review showed is the one the venue holds; one sell of all of it, filled once.
  expect(sell.clientOrderKey).toBe(id);
  const placed = await venueOrder(owner, cloid);
  expect(placed).toMatchObject({ side: 'sell', type: 'market', status: 'filled', symbol: SPOT });
  expect(sameDecimal(placed.filled, START_BTC)).toBe(true);
  expect(toUnits((await venueBalance(owner, 'BTC')).free)).toBe(0n);
  const fills = (await venueRecord(owner, '/fills', { since: new Date(0).toISOString() })).value.filter(
    (f) => f.venueClientOrderId === cloid,
  );
  expect(fills.reduce((sum, f) => sum + toUnits(f.amount), 0n)).toBe(toUnits(START_BTC));
  // Nothing left to flatten: the control goes, and no second sell can be made of the same coin.
  await expect(flatten).toHaveCount(0, { timeout: 20_000 });
  await ledgerUntouched(s);
});
