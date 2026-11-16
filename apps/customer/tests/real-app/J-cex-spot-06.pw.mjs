// World: book, gates, restart, stack
import { createHash, randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext, twoPerson } from '../../../../tooling/scripts/local-test-gates.mjs';
import { api, fromUnits, journeyState, restartWithSetting, toUnits } from './stack.mjs';
import { reviewSheet, signIn, signUp, verify } from './desk.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  otherTraderKey,
  otherTraderRun,
  sameDecimal,
  testDeposit,
  testVenue,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-cex-spot-06, in the running app (docs/roadmap/journeys.json; project-state operation-zero/modules/cex-spot/acceptance/
// journeys.md): a person reads their order history on their own venue account, one order's detail and what each fill
// cost. One test per step, titled "J-cex-spot-06 #<n>", run in order on one TEST account: verified, its TEST wallet
// connected, TEST USDC and a TEST coin in its own venue account, and open, filled, partly filled and cancelled TEST venue
// orders. The spot steps trade a TEST spot market of this file's own (a fresh symbol the TEST venue lists by its
// `/test/market-add` control, listed for INTAFACED by svc-trade's two-person door, as J-cex-spot-04-venue does), so no
// other journey's order is in its book; another TEST trader rests its asks and bids and takes the other side. #6's stop
// is on BTC-PERP, the TEST venue's perpetual, with trigger orders on for this file by the TEST venue's /test/market-triggers
// control and off again after it: the venue offers no trigger orders on cash spot.
//
// Every order, fill, fee and state is read from the stack's TEST venue itself (packages/venue-sim, through venueRecord),
// never our engine; our ledger is read only for our builder fee on a fill (one entry, earned once) and to show nothing of
// the person's is posted. Every figure is TEST. The user-venue door is on for this file only, and for this file only the
// TEST venue lowers an order in place, as J-cex-spot-05 sets it.
const J = 'J-cex-spot-06';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const LISTING_SET = 'trade.venue_listing_set';
const POLICY = 'trade-venue-markets-v1';
const PERP = 'BTC-PERP';
/** More ended orders than the smallest page holds (20), so the history pages. */
const ENDED = 22;
/** The other TEST trader's resting quotes on the file's market. */
const ASK = '101';
const BID = '99';

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
// It also cancels an order placed elsewhere by its client id (up to 20 in one signed action), so the desk can cancel the
// orders this file placed through the door (#4, #7).
const ORDER_CHANGES = { amendsInPlace: true, cancelsPerAction: 20 };
test.beforeAll(async () => {
  test.setTimeout(240_000);
  expect((await testVenue('/test/switches', ORDER_CHANGES)).body).toMatchObject(ORDER_CHANGES);
  restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'on');
});
test.afterAll(async () => {
  test.setTimeout(120_000);
  const s = run.read();
  // Nothing of this file is left resting on BTC-PERP for the next file, and the venue amends in place no more.
  if (s.walletKey) await cancelEverything(s, PERP).catch(() => undefined);
  await testVenue('/test/switches', { amendsInPlace: false, cancelsPerAction: null });
  await testVenue('/test/market-triggers', { symbol: PERP, sources: [] });
});

// ── setup, not steps ──

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

/** A fresh TEST spot market on the TEST venue, listed for INTAFACED through svc-trade's two-person door. */
async function freshMarket() {
  const base = `J06${randomBytes(3).toString('hex').toUpperCase()}`;
  const symbol = `${base}-USDC`;
  const added = await testVenue('/test/market-add', {
    symbol,
    baseAsset: base,
    quoteAsset: 'USDC',
    maxOrderQty: '1000',
    maxOrderNotional: '1000000',
  });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  const { ctx, sessions } = await ops();
  const venueId = (await venueInfo()).id;
  const opensAt = new Date(Date.now() - 60_000).toISOString();
  const reason = `LOCAL TEST ${J}: list ${symbol} for this file`;
  const ids = await twoPerson(ctx, sessions, {
    actionType: LISTING_SET,
    targetService: 'svc-trade',
    targetId: `venue-listing:${venueId}:${symbol}`,
    expectedVersion: '0',
    payloadHash: hashOf({ actionType: LISTING_SET, venueId, symbol, opensAt, expectedVersion: '0', reason }),
    policyVersion: POLICY,
  });
  const res = await ctx.edge.mutate(
    'trade',
    'admin.venueMarkets.listingSet',
    { symbol, opensAt, expectedVersion: '0', reason, ...ids },
    await sessions.a.tradeOpsToken(),
  );
  expect(trpcData(res)?.listing?.version, res.text.slice(0, 300)).toBe(1);
  return { symbol, base };
}

/** One read of svc-ledger's own operator door, as the stack's TEST founder a with admin:treasury reads it. */
async function ledgerRead(path) {
  const { ctx, sessions } = await ops();
  const res = await fetch(`${ctx.url('ledger')}${path}`, { headers: { authorization: `Bearer ${await sessions.a.treasuryToken()}` } });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J}'s TEST setup made no account and wallet, so this step has no one to act as`);
  return s;
}
const ownerOf = (s) => privateKeyToAccount(s.walletKey).address.toLowerCase();
const fresh = () => randomBytes(4).toString('hex');

/** One signed-in API session per account, so a step that sends many actions signs in once. */
const sessions = new Map();
async function client(who) {
  if (!sessions.has(who.email)) sessions.set(who.email, await api(who));
  return sessions.get(who.email);
}

/**
 * One action through our door, signed by the person's own TEST wallet key, as the desk sends it: prepared, signed once,
 * submitted. Returns the door's answer (`outcome` is the venue's).
 */
async function door(s, intent, actionKey) {
  const owner = ownerOf(s);
  const key = privateKeyToAccount(s.walletKey);
  const session = await client(s.account);
  const prepared = await session.post('/api/v1/venue/prepare', {
    owner,
    signer: { role: 'owner', address: owner },
    intent,
    ...(actionKey ? { actionKey } : {}),
  });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  const p = prepared.body.prepared;
  const t = p.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await session.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: p.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  return { ...sent.body, prepared: p };
}

/** A limit order through our door, accepted by the venue; returns its business key and the venue's client order id. */
async function order(s, symbol, side, price, amount, timeInForce, tag, extra = {}) {
  const clientOrderKey = `order:${J.toLowerCase()}:${tag}:${fresh()}`;
  const sent = await door(s, {
    kind: 'place_order',
    symbol,
    side,
    type: 'limit',
    amount,
    price,
    timeInForce,
    reduceOnly: false,
    clientOrderKey,
    builderFee: null,
    ...extra,
  });
  expect(sent.outcome, JSON.stringify(sent.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
  return { key: clientOrderKey, cloid: sent.prepared.venueClientOrderId };
}

/** The person's order as the TEST venue itself records it (by its client id). */
const venueOrder = async (s, cloid) => (await venueRecord(ownerOf(s), '/order-by-client-id', { venueClientOrderId: cloid })).value;
/** The person's fills of one order, as the TEST venue records them. */
async function venueFillsOf(s, cloid) {
  const all = (await venueRecord(ownerOf(s), '/fills', { since: new Date(0).toISOString() })).value;
  return all.filter((f) => f.venueClientOrderId === cloid);
}
/** Every order of the person's venue account, newest placed first, as the TEST venue keeps them. */
const venueHistory = async (s) => (await venueRecord(ownerOf(s), '/order-history')).value;

/** The other TEST trader on the file's market: its asks and bids rest there, and it takes the person's resting orders. */
const MAKER = `${J} maker`;
async function makerQuotes(symbol, base) {
  const owner = otherTraderKey(MAKER).address.toLowerCase();
  expect(await testDeposit(owner, 'USDC', '100000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  expect(await testDeposit(owner, base, '100', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  for (const [side, price] of [
    ['sell', ASK],
    ['buy', BID],
  ]) {
    const answer = await otherTraderRun(MAKER, {
      kind: 'place_order',
      symbol,
      side,
      type: 'limit',
      amount: '20',
      price,
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${J.toLowerCase()}:maker-${side}:${fresh()}`,
      builderFee: null,
    });
    expect(answer, JSON.stringify(answer).slice(0, 300)).toMatchObject({ accepted: true });
  }
}

/** The other TEST trader sells `amount` at `price` at once (IOC): it takes the person's resting buy there. */
async function makerSells(symbol, price, amount) {
  const answer = await otherTraderRun(MAKER, {
    kind: 'place_order',
    symbol,
    side: 'sell',
    type: 'limit',
    amount,
    price,
    timeInForce: 'IOC',
    reduceOnly: false,
    clientOrderKey: `order:${J.toLowerCase()}:maker-take:${fresh()}`,
    builderFee: null,
  });
  expect(answer, JSON.stringify(answer).slice(0, 300)).toMatchObject({ accepted: true });
}

/** Cancels every order of the person still resting on `symbol`, through our door. */
async function cancelEverything(s, symbol) {
  const open = (await venueRecord(ownerOf(s), '/open-orders')).value.filter((o) => o.symbol === symbol);
  const keys = s.keys ?? {};
  for (const o of open) {
    const key = Object.entries(keys).find(([, cloid]) => cloid === o.venueClientOrderId)?.[0];
    if (key) await door(s, { kind: 'cancel_order', symbol, clientOrderKey: key });
  }
}

/**
 * TEST setup, not a step (the Starts line), made at the start of #1: a verified account, this run's TEST wallet key, TEST
 * USDC and the file's TEST coin in its own venue account by the TEST venue's deposit control (keyed by chain-transfer-
 * shaped references), our builder fee approved once by the person's wallet, and the person's orders on the file's market:
 * a filled buy and a filled sell (each taking the other trader's quote), a resting buy they cancelled, a resting buy still
 * open, and ENDED immediate-or-cancel buys under the book that ended at once with nothing filled. Made in #1, never in a
 * beforeAll: a worker that restarts after a failed step would run a beforeAll again and replace the account.
 */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'js6v');
    await verify(page, account);
    const walletKey = testWalletKey();
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    const { symbol, base } = await freshMarket();
    await makerQuotes(symbol, base);
    expect(await testDeposit(owner, 'USDC', '5000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    expect(await testDeposit(owner, base, '5', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    const s = { account, walletKey, symbol, base };
    const status = (await (await client(account)).get('/api/v1/venue/status')).body;
    expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
    const approval = await door(
      s,
      { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
      `builder-approval:${owner}:${J}:${fresh()}`,
    );
    expect(approval.outcome).toMatchObject({ definite: true, accepted: true });
    const keys = {};
    const placed = async (side, price, amount, tif, tag) => {
      const o = await order(s, symbol, side, price, amount, tif, tag);
      keys[o.key] = o.cloid;
      return o;
    };
    const bought = await placed('buy', ASK, '0.2', 'IOC', 'bought');
    const sold = await placed('sell', BID, '0.2', 'IOC', 'sold');
    const cancelled = await placed('buy', '90', '0.2', 'GTC', 'cancelled');
    const cancel = await door(s, { kind: 'cancel_order', symbol, clientOrderKey: cancelled.key });
    expect(cancel.outcome).toMatchObject({ definite: true, accepted: true });
    const open = await placed('buy', '95', '0.3', 'GTC', 'open');
    for (let i = 0; i < ENDED; i++) await placed('buy', '90', '0.2', 'IOC', `ended${i}`);
    run.reset({
      account,
      walletKey,
      symbol,
      base,
      keys,
      ids: { bought: bought.cloid, sold: sold.cloid, cancelled: cancelled.cloid, open: open.cloid },
      openKey: open.key,
      ledger: await (await api(account)).balances(),
    });
  } finally {
    await page.close();
  }
}

/** Signs in, installs the TEST wallet with the run's key and opens `path`, connecting the wallet when it isn't yet. */
const wallets = new WeakMap();
async function openWithWallet(page, s, path) {
  const { chainId } = await venueInfo();
  if (!wallets.has(page)) wallets.set(page, await installTestWallet(page, { chainId, privateKey: s.walletKey }));
  const wallet = wallets.get(page);
  await signIn(page, s.account);
  await page.goto(path);
  const connect = page.getByRole('button', { name: 'Connect TEST Wallet' });
  const address = page.getByTestId('venue-wallet-address');
  await expect(connect.or(address).first()).toBeVisible({ timeout: 30_000 });
  if (await connect.isVisible()) await connect.click();
  await expect(address).toHaveText(wallet.address.toLowerCase());
  return wallet;
}

const historyRows = (page) => page.getByTestId('venue-history').locator('tbody tr');
async function shownIds(page) {
  const hrefs = await page
    .getByTestId('venue-history')
    .locator('a[data-testid="venue-order-link"]')
    .evaluateAll((links) => links.map((a) => a.getAttribute('href')));
  return hrefs.map((href) => href.split('/').pop());
}
const fact = (page, label) =>
  page
    .getByTestId('venue-order-facts')
    .getByTestId('venue-order-row')
    .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
    .locator('dd');
const heading = (page) => page.getByTestId('venue-order-heading');
/** A decimal as the page writes it: grouped whole part, the venue's own fraction digits. */
function shown(value) {
  const [whole, fraction] = String(value).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

test(`${J} #1 opens order history and filters by side, state and date: matching rows only, paged without duplicates; a mistyped filter is refused in words; the page size is respected`, async ({
  page,
  browser,
}) => {
  test.setTimeout(480_000);
  await startsLine(browser);
  const s = state();
  const all = await venueHistory(s);
  expect(all).toHaveLength(ENDED + 4);
  await openWithWallet(page, s, '/trade/orders?product=venue');
  await expect(page.getByRole('heading', { name: 'Order history', level: 1 })).toBeVisible();
  // The smallest page is respected; older orders come a page at a time and no order is shown twice.
  await expect(page.getByText('20 orders shown')).toBeVisible({ timeout: 20_000 });
  expect(await shownIds(page)).toHaveLength(20);
  expect(await shownIds(page)).toEqual(all.slice(0, 20).map((r) => r.order.venueClientOrderId));
  await page.getByRole('button', { name: 'Show older orders' }).click();
  await expect(page.getByText(`${ENDED + 4} orders shown`)).toBeVisible();
  await expect(page.getByText('That’s every order that matches these filters.')).toBeVisible();
  const ids = await shownIds(page);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(all.map((r) => r.order.venueClientOrderId));
  for (const id of Object.values(s.ids)) expect(ids).toContain(id);

  // A larger page holds them all at once.
  await page.getByRole('combobox', { name: 'Per page' }).selectOption('50');
  await expect(page).toHaveURL(/size=50/);
  await expect(page.getByText(`${ENDED + 4} orders shown`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show older orders' })).toHaveCount(0);

  // Side: only the sell, as the venue records it.
  const sells = all.filter((r) => r.order.side === 'sell').map((r) => r.order.venueClientOrderId);
  expect(sells).toEqual([s.ids.sold]);
  await page.getByRole('combobox', { name: 'Side', exact: true }).selectOption({ label: 'Sell' });
  await expect(page).toHaveURL(/side=sell/);
  await expect.poll(() => shownIds(page)).toEqual(sells);
  // State: the filled ones of both sides, and every row says Filled.
  await page.getByRole('combobox', { name: 'Side', exact: true }).selectOption({ label: 'All' });
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption({ label: 'Filled' });
  const filled = all.filter((r) => r.order.status === 'filled').map((r) => r.order.venueClientOrderId);
  expect([...filled].sort()).toEqual([s.ids.bought, s.ids.sold].sort());
  await expect.poll(() => shownIds(page)).toEqual(filled);
  for (const cell of await historyRows(page).locator('[data-cell="status"]').allInnerTexts()) expect(cell).toBe('Filled');
  // Dates: today holds them; a window that ended yesterday holds none.
  const today = new Date();
  const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await page.getByLabel('From', { exact: true }).fill(day(today));
  await expect(page).toHaveURL(/from=/);
  await expect.poll(() => shownIds(page)).toEqual(filled);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  await page.getByLabel('From', { exact: true }).fill(day(yesterday));
  await page.getByLabel('To', { exact: true }).fill(day(yesterday));
  await expect(page.getByText('No orders match these filters.')).toBeVisible();

  // A mistyped filter in the address is refused in words, by the service's own check, never as a code.
  await page.goto('/trade/orders?product=venue&side=bye');
  const alert = page.getByTestId('venue-history').getByRole('alert');
  await expect(alert).toContainText('These filters can’t be used');
  await expect(alert).toContainText('side “bye” isn’t a choice we know');
  await expect(alert).not.toContainText('trade.');
  const refused = await (await client(s.account)).get(`/api/v1/venue/orders/history?owner=${ownerOf(s)}&side=bye`);
  expect(refused.status).toBe(400);
  expect(refused.body.intafacedCode).toBe('trade.invalid_filter');
  const size = await (await client(s.account)).get(`/api/v1/venue/orders/history?owner=${ownerOf(s)}&limit=7`);
  expect(size.status).toBe(400);
  expect(size.body.intafacedCode).toBe('trade.invalid_filter');
});

/**
 * A small TEST long on BTC-PERP and a stop loss under it judged on the last trade price, fired by another TEST trader's
 * sale at the best bid. `stopOrder(bid)` gives the stop its type, price and time in force: a limit under the bid fills
 * once it fires; a market order whose worst price sits above every bid can't, and the venue rejects it. Returns the
 * stop's client order id once it has triggered.
 */
/** "Why it ended", in the page's words for the reason the venue gives, or "Not recorded" where it gives none. */
function endedWords(o) {
  if (o.cancelReason === 'position_closed') return 'The position it closed is gone, so the venue cancelled it';
  if (o.cancelReason === 'linked') return 'The other order attached to the same entry filled first';
  if (o.status === 'rejected' && o.trigger?.failure) return `The venue refused it: ${o.trigger.failure}`;
  return 'Not recorded';
}

async function firedStop(s, tag, stopOrder) {
  const owner = ownerOf(s);
  // A small TEST long on BTC-PERP, the TEST venue's perpetual, and a stop loss under it judged on the last trade price.
  expect(await testDeposit(owner, 'USDC', '2000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  const leverage = await door(
    s,
    { kind: 'update_leverage', symbol: PERP, leverageBps: 10_000, marginMode: 'isolated' },
    `leverage:${owner}:${PERP}:isolated:10000:${fresh()}`,
  );
  expect(leverage.outcome).toMatchObject({ definite: true, accepted: true });
  const top = (await testVenue('/best-prices', { symbol: PERP })).body.value;
  const entry = await order(s, PERP, 'buy', top.ask, '0.001', 'IOC', 'long');
  await expect.poll(async () => (await venueOrder(s, entry.cloid)).status, { timeout: 20_000 }).toBe('filled');
  // TEST control: BTC-PERP takes trigger orders judged on the last trade price for this file only (put back after it).
  expect((await testVenue('/test/market-triggers', { symbol: PERP, sources: ['last'] })).status).toBe(200);
  const { bid } = (await testVenue('/best-prices', { symbol: PERP })).body.value;
  const triggerPrice = bid;
  const stopKey = `order:${J.toLowerCase()}:${tag}:${fresh()}`;
  const stop = await door(s, {
    kind: 'place_order',
    symbol: PERP,
    side: 'sell',
    ...stopOrder(bid),
    amount: '0.001',
    reduceOnly: true,
    trigger: { price: triggerPrice, source: 'last', role: 'stop_loss' },
    clientOrderKey: stopKey,
    builderFee: null,
  });
  expect(stop.outcome).toMatchObject({ definite: true, accepted: true });
  const stopId = stop.prepared.venueClientOrderId;
  run.write({ [tag]: stopId, keys: { ...run.read().keys, [stopKey]: stopId } });
  // Another TEST trader sells at the best bid: the last trade prints at the stop's price, and the stop fires.
  const seller = `${J} stop seller ${fresh()}`;
  const sellerOwner = otherTraderKey(seller).address.toLowerCase();
  expect(await testDeposit(sellerOwner, 'USDC', '2000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  const sellerLeverage = await otherTraderRun(seller, {
    kind: 'update_leverage',
    symbol: PERP,
    leverageBps: 10_000,
    marginMode: 'isolated',
  });
  expect(sellerLeverage).toMatchObject({ accepted: true });
  const print = await otherTraderRun(seller, {
    kind: 'place_order',
    symbol: PERP,
    side: 'sell',
    type: 'limit',
    amount: '0.001',
    price: triggerPrice,
    timeInForce: 'IOC',
    reduceOnly: false,
    clientOrderKey: `order:${J.toLowerCase()}:print:${fresh()}`,
    builderFee: null,
  });
  expect(print).toMatchObject({ accepted: true });
  await expect.poll(async () => (await venueOrder(s, stopId)).trigger?.state, { timeout: 30_000 }).toMatch(/^(triggered|failed)$/);
  return stopId;
}

test(`${J} #2 opens one order at /trade/orders/:id: status, fills, and the reject reason or "not recorded"`, async ({ page }) => {
  test.setTimeout(240_000);
  const s = state();
  await openWithWallet(page, s, '/trade/orders?product=venue&status=filled');
  // Reached from the history: the row links to the order's own address.
  await page.getByTestId('venue-history').locator(`a[href="/trade/orders/${s.ids.sold}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/trade/orders/${s.ids.sold}$`));
  const sold = await venueOrder(s, s.ids.sold);
  expect(sold.status).toBe('filled');
  await expect(heading(page)).toContainText(`Sell ${s.symbol}`);
  await expect(heading(page).locator('[data-cell="status"]')).toHaveText('Filled');
  await expect(fact(page, 'Filled')).toHaveText(`${shown(sold.filled)} ${s.base}`);
  const fills = await venueFillsOf(s, s.ids.sold);
  expect(fills.length).toBeGreaterThan(0);
  await expect(page.getByTestId('venue-order-fill')).toHaveCount(fills.length);
  for (const f of fills) await expect(page.locator(`[data-testid="venue-order-fill"][data-fill="${f.fillId}"]`)).toHaveCount(1);
  // A filled order did not end for a reason: no reason line.
  await expect(fact(page, 'Why it ended')).toHaveCount(0);

  // A cancelled order says why it ended, or that no reason was recorded; never a raw code. Nothing filled.
  const cancelled = await venueOrder(s, s.ids.cancelled);
  expect(cancelled.status).toBe('canceled');
  await page.goto(`/trade/orders/${s.ids.cancelled}`);
  await expect(heading(page).locator('[data-cell="status"]')).toHaveText('Cancelled');
  await expect(fact(page, 'Why it ended')).toHaveText(endedWords(cancelled));
  await expect(page.getByText('Nothing has filled.')).toBeVisible();
  // An immediate-or-cancel order that could not fill reads the same, as the venue records no reason for it.
  const ended = (await venueHistory(s)).find((r) => r.order.timeInForce === 'IOC' && r.order.status === 'canceled').order;
  await page.goto(`/trade/orders/${ended.venueClientOrderId}`);
  await expect(heading(page).locator('[data-cell="status"]')).toHaveText('Cancelled');
  await expect(fact(page, 'Why it ended')).toHaveText(endedWords(ended));

  // A rejected order: a stop whose worst price sits above every bid fires and can't fill, so the venue rejects it and
  // says why. The page gives the venue's own reason.
  const rejectedId = await firedStop(s, 'rejected', (bid) => ({
    type: 'market',
    price: ((toUnits(bid) * 102n) / 100n / toUnits('1') + 1n).toString(),
    timeInForce: 'IOC',
  }));
  await expect.poll(async () => (await venueOrder(s, rejectedId)).status, { timeout: 30_000 }).toBe('rejected');
  const rejected = await venueOrder(s, rejectedId);
  expect(rejected.trigger.failure).toBeTruthy();
  await page.goto(`/trade/orders/${rejectedId}`);
  await expect(heading(page).locator('[data-cell="status"]')).toHaveText('Rejected');
  await expect(fact(page, 'Why it ended')).toHaveText(`The venue refused it: ${rejected.trigger.failure}`);
  await expect(page.getByText('Nothing has filled.')).toBeVisible();
});

test(`${J} #3 opens another person's order id: "Order not found", no hint it exists; cancel and list refuse too`, async ({ page }) => {
  const s = state();
  // Another TEST person's order, resting on the file's market from their own venue account.
  const other = `${J} other ${fresh()}`;
  const theirOwner = otherTraderKey(other).address.toLowerCase();
  expect(await testDeposit(theirOwner, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  const theirKey = `order:${J.toLowerCase()}:theirs:${fresh()}`;
  const theirs = await otherTraderRun(other, {
    kind: 'place_order',
    symbol: s.symbol,
    side: 'buy',
    type: 'limit',
    amount: '0.2',
    price: '80',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: theirKey,
    builderFee: null,
  });
  expect(theirs).toMatchObject({ accepted: true, order: { status: 'open' } });
  const theirId = theirs.order.venueClientOrderId;
  try {
    await openWithWallet(page, s, `/trade/orders/${theirId}`);
    await expect(page.getByRole('heading', { name: 'Order not found' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#main')).not.toContainText(s.symbol);
    await expect(page.getByTestId('venue-order')).toHaveCount(0);
    // A made-up id reads the same: nothing tells the two apart.
    await page.goto(`/trade/orders/0x${'0'.repeat(32)}`);
    await expect(page.getByRole('heading', { name: 'Order not found' })).toBeVisible({ timeout: 20_000 });

    const mine = await client(s.account);
    const owner = ownerOf(s);
    // Read: the same answer for their order and for no order at all.
    for (const id of [theirId, `0x${'0'.repeat(32)}`]) {
      const record = await mine.get(`/api/v1/venue/orders/record?owner=${owner}&clientOrderId=${id}`);
      expect(record.status, id).toBe(404);
      expect(record.body.intafacedCode, id).toBe('trade.venue_order_not_found');
      const byId = await mine.get(`/api/v1/venue/orders/by-client-id?owner=${owner}&clientOrderId=${id}`);
      expect(byId.status).toBe(200);
      expect(byId.body.value).toBeNull();
    }
    // Cancel: sent from the person's own account, the venue finds no such order there and refuses; theirs stays open.
    const cancel = await door(s, { kind: 'cancel_order', symbol: s.symbol, clientOrderKey: theirKey });
    expect(cancel.outcome).toMatchObject({ definite: true, accepted: false, refusal: { code: 'unknown_order' } });
    // List: the person's history holds none of their orders, and their id is no page marker here.
    expect((await venueHistory(s)).map((r) => r.order.venueClientOrderId)).not.toContain(theirId);
    const page2 = await mine.get(`/api/v1/venue/orders/history?owner=${owner}&before=${theirId}`);
    expect(page2.status).toBe(400);
    expect(page2.body.intafacedCode).toBe('trade.invalid_cursor');
    const listed = await mine.get(`/api/v1/venue/orders/history?owner=${owner}&limit=100`);
    expect(listed.body.orders.map((r) => r.order.venueClientOrderId)).not.toContain(theirId);
    expect((await venueRecord(theirOwner, '/order-by-client-id', { venueClientOrderId: theirId })).value.status).toBe('open');
  } finally {
    await otherTraderRun(other, { kind: 'cancel_order', symbol: s.symbol, clientOrderKey: theirKey });
  }
});

test(`${J} #4 reads the fills of a partly filled order, cancels the rest, and reads the fills again: the filled part and open remainder as the venue reports them; cancel ends exactly the rest; no fee row and no ledger entry for the remainder`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const owner = ownerOf(s);
  // The person's buy rests above the other trader's bid, the best bid; the other trader sells half of it there, so it
  // fills as maker and the rest stays open.
  const partial = await order(s, s.symbol, 'buy', '99.5', '0.4', 'GTC', 'partial');
  run.write({ partial: partial.cloid, keys: { ...s.keys, [partial.key]: partial.cloid } });
  await makerSells(s.symbol, '99.5', '0.2');
  await expect.poll(async () => (await venueOrder(s, partial.cloid)).status, { timeout: 20_000 }).toBe('partially_filled');
  const part = await venueOrder(s, partial.cloid);
  expect(sameDecimal(part.filled, '0.2')).toBe(true);
  expect(sameDecimal(part.remaining, '0.2')).toBe(true);
  const fills = await venueFillsOf(s, partial.cloid);
  expect(fills.map((f) => f.role)).toEqual(fills.map(() => 'maker'));

  await openWithWallet(page, s, `/trade/orders/${partial.cloid}`);
  await expect(heading(page).locator('[data-cell="status"]')).toHaveText('Partly filled');
  await expect(fact(page, 'Filled')).toHaveText(`${shown(part.filled)} ${s.base}`);
  await expect(fact(page, 'Left to fill')).toHaveText(`${shown(part.remaining)} ${s.base}`);
  await expect(fact(page, 'The venue locks')).toHaveText(`${shown(part.locked)} ${part.lockedAsset}`);
  await expect(page.getByTestId('venue-order-fill')).toHaveCount(fills.length);
  const lockedBefore = toUnits((await venueBalance(owner, 'USDC')).locked);
  const freeBefore = toUnits((await venueBalance(owner, 'USDC')).free);

  // Cancels the rest on the desk.
  await openWithWallet(page, s, `/trade/spot/${s.symbol}`);
  await page.getByRole('tab', { name: 'Open orders' }).click();
  const row = page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${partial.cloid}"]`);
  await expect(row.locator('[data-cell="status"]')).toHaveText('Partly filled', { timeout: 20_000 });
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await continueInWallet(page);
  await expect.poll(async () => (await venueOrder(s, partial.cloid)).status, { timeout: 20_000 }).toBe('canceled');
  const after = await venueOrder(s, partial.cloid);
  // Cancel ended exactly the rest: the filled part stays filled, and the venue gave back exactly the remainder's lock.
  expect(after.filled).toBe(part.filled);
  expect(toUnits(after.locked)).toBe(0n);
  const balance = await venueBalance(owner, 'USDC');
  expect(lockedBefore - toUnits(balance.locked)).toBe(toUnits(part.locked));
  expect(toUnits(balance.free) - freeBefore).toBe(toUnits(part.locked));

  // Reads the fills again: exactly the same fills, which add up to the filled part, and the page lists exactly them.
  const fillsAfter = await venueFillsOf(s, partial.cloid);
  expect(fillsAfter.map((f) => f.fillId).sort()).toEqual(fills.map((f) => f.fillId).sort());
  expect(fillsAfter.reduce((sum, f) => sum + toUnits(f.amount), 0n)).toBe(toUnits(part.filled));
  await page.goto(`/trade/orders/${partial.cloid}`);
  await expect(heading(page).locator('[data-cell="status"]')).toHaveText('Cancelled');
  await expect(fact(page, 'Filled')).toHaveText(`${shown(part.filled)} ${s.base}`);
  await expect(page.getByTestId('venue-order-fill')).toHaveCount(fills.length);
  // The cancelled remainder has no fill, so no fee row; and nothing is posted for it or for the person on our ledger:
  // a spot buy carries no builder fee, so none of these fills has a builder-fee entry, and the person's ledger is unchanged.
  const { id: venueId } = await venueInfo();
  for (const f of fillsAfter) {
    expect(toUnits(f.builderFee)).toBe(0n);
    const trace = await ledgerRead(`/operator/trace?businessKey=${encodeURIComponent(`builder-fee:${venueId}:${owner}:${f.fillId}`)}`);
    expect(trace.found).toBe(false);
  }
  expect(await (await api(s.account)).balances()).toEqual(s.ledger);
});

test(`${J} #5 opens a fill's detail: price, size, maker or taker role, the venue's fee and our builder fee as separate lines, fee asset and rank discount ("none" when none)`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const s = run.read();
  const owner = ownerOf(s);
  const { id: venueId } = await venueInfo();
  await openWithWallet(page, s, `/trade/orders/${s.ids.sold}`);
  for (const [id, role] of [
    [s.ids.sold, 'Taker'],
    [s.partial, 'Maker'],
  ]) {
    const [fill] = await venueFillsOf(s, id);
    expect(fill.role).toBe(role.toLowerCase());
    await page.goto(`/trade/orders/${id}`);
    const opened = page.locator(`[data-testid="venue-order-fill"][data-fill="${fill.fillId}"]`);
    await opened.locator('summary').click();
    const rows = opened.locator('dl');
    const line = (label) =>
      rows
        .getByTestId('venue-order-row')
        .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
        .locator('dd');
    const quote = s.symbol.split('-')[1];
    await expect(line('Price')).toHaveText(`${shown(fill.price)} ${quote}`);
    await expect(line('Size')).toHaveText(`${shown(fill.amount)} ${s.base}`);
    await expect(line('Maker or taker')).toHaveText(role);
    // The venue's fee and our builder fee, each as the venue reports it for this fill, on lines of their own.
    await expect(line('Venue’s fee')).toHaveText(`${fill.venueFee} ${fill.feeAsset}`);
    await expect(line('Our builder fee')).toHaveText(`${fill.builderFee} ${fill.feeAsset}`);
    await expect(line('Fee asset')).toHaveText(fill.feeAsset);
    // A new TEST account has no rank discount, and a spot buy carries no builder fee to discount.
    await expect(line('Rank discount')).toHaveText('None');
  }
  // Money: our builder fee on the sell's fill is the venue's figure, and our ledger holds exactly one entry for that
  // fill, under the venue's own fill id, earned once, for exactly that figure.
  const fills = await venueFillsOf(s, s.ids.sold);
  for (const f of fills) {
    expect(toUnits(f.builderFee)).toBeGreaterThan(0n);
    const key = `builder-fee:${venueId}:${owner}:${f.fillId}`;
    await expect
      .poll(async () => (await ledgerRead(`/operator/trace?businessKey=${encodeURIComponent(key)}`)).found, { timeout: 90_000 })
      .toBe(true);
    const trace = await ledgerRead(`/operator/trace?businessKey=${encodeURIComponent(key)}`);
    expect(trace.reason).toBe('trade.builder_fee.earned');
    const debits = trace.postings.filter((p) => p.direction === 'debit');
    expect(debits).toHaveLength(1);
    expect(toUnits(debits[0].amount)).toBe(toUnits(f.builderFee));
    expect(debits[0].assetId).toBe(f.feeAsset);
  }
});

test(`${J} #6 opens a triggered stop order: why it triggered, the trigger price against the execution price, and the slippage between them`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  // The stop's limit, 2% under the trigger on the market's whole-dollar tick: it sells into the bids once it fires.
  const stopId = await firedStop(s, 'stop', (bid) => ({
    type: 'limit',
    price: ((toUnits(bid) * 98n) / 100n / toUnits('1')).toString(),
    timeInForce: 'GTC',
  }));
  await expect.poll(async () => (await venueOrder(s, stopId)).status, { timeout: 30_000 }).toBe('filled');
  const fired = await venueOrder(s, stopId);
  expect(fired.trigger.triggeredAt).toBeTruthy();

  await openWithWallet(page, s, `/trade/orders/${stopId}`);
  await expect(heading(page).locator('[data-cell="status"]')).toHaveText('Filled');
  await expect(fact(page, 'Why it triggered')).toHaveText(
    new RegExp(
      `^The last trade price reached ${shown(fired.trigger.price).replace(/[.,]/g, '\\$&')} USDC at \\d{1,2} \\w{3}, \\d{2}:\\d{2}:\\d{2}$`,
    ),
  );
  await expect(fact(page, 'Trigger price')).toHaveText(`${shown(fired.trigger.price)} USDC`);
  await expect(fact(page, 'Execution price')).toHaveText(`${shown(fired.averagePrice)} USDC`);
  // Slippage: the execution price against the trigger price; a sell is worse below it.
  const diff = toUnits(fired.averagePrice) - toUnits(fired.trigger.price);
  const size = diff < 0n ? -diff : diff;
  const pct = (size * 10_000n) / toUnits(fired.trigger.price);
  const pctText = `${pct / 100n}.${String(pct % 100n).padStart(2, '0')}`;
  await expect(fact(page, 'Slippage')).toHaveText(
    size === 0n
      ? 'None: it filled at the trigger price'
      : `${shown(fromUnits(size))} USDC (${pctText}%) ${diff < 0n ? 'worse' : 'better'} than the trigger price`,
  );
});

test(`${J} #7 reads one order in each state on the desk, in history and on its detail page: the same state words on all three`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  // A partly filled order, resting again, so each state is on the desk at once.
  // Priced above anything of the person's left resting, so the other trader's sale meets this order first.
  const partly = await order(s, s.symbol, 'buy', '99.6', '0.4', 'GTC', 'partly');
  run.write({ keys: { ...run.read().keys, [partly.key]: partly.cloid } });
  await makerSells(s.symbol, '99.6', '0.2');
  await expect.poll(async () => (await venueOrder(s, partly.cloid)).status, { timeout: 20_000 }).toBe('partially_filled');

  const wallet = await openVenueDesk(page, s.account, `/trade/spot/${s.symbol}`, s.walletKey);
  expect(wallet.address.toLowerCase()).toBe(ownerOf(s));
  // Filled: a buy placed here at the other trader's ask fills at once; the desk keeps it listed, Filled.
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  const form = page.locator('form[data-testid="dk-form"][data-side="buy"]');
  await form.getByRole('textbox', { name: 'Price' }).fill(ASK);
  const previewed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await form.getByRole('textbox', { name: 'Amount' }).fill('0.2');
  expect((await previewed).status()).toBe(200);
  await page.getByRole('button', { name: `Buy ${s.base}` }).click();
  await expect(reviewSheet(page)).toBeVisible();
  const prepared = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/prepare' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Confirm buy' }).click();
  await continueInWallet(page);
  const filledId = (await (await prepared).json()).prepared.venueClientOrderId;
  await expect.poll(async () => (await venueOrder(s, filledId))?.status, { timeout: 20_000 }).toBe('filled');
  await page.getByRole('tab', { name: 'Open orders' }).click();
  const deskRow = (id) => page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${id}"] [data-cell="status"]`);
  await expect(deskRow(filledId)).toHaveText('Filled', { timeout: 20_000 });
  await expect(deskRow(s.ids.open)).toHaveText('Open');
  await expect(deskRow(partly.cloid)).toHaveText('Partly filled');
  // Cancelled: the partly filled one is cancelled here; the desk keeps it listed, Cancelled.
  const states = { [filledId]: 'Filled', [s.ids.open]: 'Open' };
  await page
    .getByTestId('venue-open-orders')
    .locator(`tr[data-client-order-id="${partly.cloid}"]`)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await continueInWallet(page);
  await expect(deskRow(partly.cloid)).toHaveText('Cancelled', { timeout: 20_000 });
  states[partly.cloid] = 'Cancelled';
  // Partly filled, on all three while it rested, read before the cancel above: a second one rests now for history and detail.
  const resting = await order(s, s.symbol, 'buy', '99.7', '0.4', 'GTC', 'partly2');
  run.write({ keys: { ...run.read().keys, [resting.key]: resting.cloid } });
  await makerSells(s.symbol, '99.7', '0.2');
  await expect.poll(async () => (await venueOrder(s, resting.cloid)).status, { timeout: 20_000 }).toBe('partially_filled');
  await page.reload();
  await expect(page.getByTestId('venue-wallet-address')).toHaveText(ownerOf(s), { timeout: 30_000 });
  await page.getByRole('tab', { name: 'Open orders' }).click();
  await expect(deskRow(resting.cloid)).toHaveText('Partly filled', { timeout: 20_000 });
  states[resting.cloid] = 'Partly filled';

  // The venue's own state for each, and the same words in the history and on each order's page.
  const venueWord = { open: 'Open', partially_filled: 'Partly filled', filled: 'Filled', canceled: 'Cancelled' };
  for (const [id, words] of Object.entries(states)) expect(venueWord[(await venueOrder(s, id)).status]).toBe(words);
  await page.goto('/trade/orders?product=venue&size=100');
  for (const [id, words] of Object.entries(states)) {
    await expect(page.getByTestId('venue-history').locator(`tr[data-client-order-id="${id}"] [data-cell="status"]`)).toHaveText(words, {
      timeout: 20_000,
    });
  }
  for (const [id, words] of Object.entries(states)) {
    await page.goto(`/trade/orders/${id}`);
    await expect(heading(page).locator('[data-cell="status"]')).toHaveText(words, { timeout: 20_000 });
  }
  await door(s, { kind: 'cancel_order', symbol: s.symbol, clientOrderKey: resting.key });
});

test(`${J} #8 opens Activity, Trades: one row per venue fill with price, total and both fees`, async ({ page }) => {
  const s = state();
  const fills = (await venueRecord(ownerOf(s), '/fills', { since: new Date(0).toISOString() })).value;
  expect(fills.length).toBeGreaterThan(0);
  await openWithWallet(page, s, '/money/activity?tab=trades');
  const rows = page.getByTestId('money-venue-trades').getByTestId('venue-fills').locator('tbody tr');
  await expect(rows).toHaveCount(fills.length, { timeout: 20_000 });
  for (const f of fills) {
    const row = page.getByTestId('money-venue-trades').locator(`tr[data-fill="${f.fillId}"]`);
    await expect(row.locator('[data-cell="price"]')).toHaveText(shown(f.price));
    // Total: price times size, exactly, in the quote asset.
    const total = fromUnits((toUnits(f.price) * toUnits(f.amount)) / toUnits('1'));
    await expect(row.locator('[data-cell="total"]')).toHaveText(`${shown(total)} ${f.symbol.split('-')[1]}`);
    await expect(row.locator('[data-cell="venue-fee"]')).toHaveText(f.venueFee);
    await expect(row.locator('[data-cell="builder-fee"]')).toHaveText(f.builderFee);
  }
});

test(`${J} #9 amends an order's quantity and opens it while the venue's answer is held, then after the answer: the old quantity while held, the new quantity only after the amendment is recorded`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const s = state();
  const owner = ownerOf(s);
  const before = await venueOrder(s, s.ids.open);
  expect(before.status).toBe('open');
  expect(sameDecimal(before.amount, '0.3')).toBe(true);
  await openWithWallet(page, s, `/trade/orders/${s.ids.open}`);
  await expect(fact(page, 'Amount')).toHaveText(`${shown(before.amount)} ${s.base}`);
  // TEST switch: the venue holds its answer to this account's next submits for 4 s, inside our door's 5 s wait for it.
  const held = await testVenue('/test/account-switches', { owner, submitDelayMs: 4_000 });
  expect(held.status, JSON.stringify(held.body)).toBe(200);
  try {
    const amendKey = `amend:${owner}:${s.ids.open}:0.2`;
    const sending = door(
      s,
      { kind: 'amend_order', symbol: s.symbol, venueClientOrderId: s.ids.open, amount: '0.2', price: before.price },
      amendKey,
    );
    // While the answer is held, the venue still has the old quantity, and so does the page.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(sameDecimal((await venueOrder(s, s.ids.open)).amount, '0.3')).toBe(true);
    const reread = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/orders/by-client-id');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await reread;
    await expect(fact(page, 'Amount')).toHaveText(`${shown(before.amount)} ${s.base}`);
    expect(sameDecimal((await venueOrder(s, s.ids.open)).amount, '0.3')).toBe(true);
    await expect(page.getByTestId('venue-order-changes')).toHaveCount(0);
    const answered = await sending;
    expect(answered.outcome).toMatchObject({ definite: true, accepted: true });
  } finally {
    await testVenue('/test/account-switches', { owner, submitDelayMs: 0 });
  }
  // After the answer: the venue records the new quantity, and the page shows it, with the change listed.
  const after = await venueOrder(s, s.ids.open);
  expect(sameDecimal(after.amount, '0.2')).toBe(true);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(fact(page, 'Amount')).toHaveText(`${shown(after.amount)} ${s.base}`);
  await expect(page.getByTestId('venue-order-changes').locator('li')).toHaveCount(1);
});

test(`${J} #10 reads the amend trail: each amendment listed with its time`, async ({ page }) => {
  const s = state();
  const owner = ownerOf(s);
  const price = (await venueOrder(s, s.ids.open)).price;
  // A second change, so the trail has two.
  const second = await door(
    s,
    { kind: 'amend_order', symbol: s.symbol, venueClientOrderId: s.ids.open, amount: '0.1', price },
    `amend:${owner}:${s.ids.open}:0.1`,
  );
  expect(second.outcome).toMatchObject({ definite: true, accepted: true });
  expect(sameDecimal((await venueOrder(s, s.ids.open)).amount, '0.1')).toBe(true);
  const record = await (await client(s.account)).get(`/api/v1/venue/orders/record?owner=${owner}&clientOrderId=${s.ids.open}`);
  expect(record.status).toBe(200);
  const trail = record.body.amendments;
  expect(trail.map((a) => a.amount)).toEqual(['0.2', '0.1']);
  expect(Date.parse(trail[0].recordedAt)).toBeLessThanOrEqual(Date.parse(trail[1].recordedAt));
  await openWithWallet(page, s, `/trade/orders/${s.ids.open}`);
  const items = page.getByTestId('venue-order-changes').locator('li');
  await expect(items).toHaveCount(2, { timeout: 20_000 });
  // Each with its time, in the order the venue recorded them (the page writes the time in the person's own time zone).
  const at = '\\d{1,2} \\w{3}, \\d{2}:\\d{2}:\\d{2}';
  await expect(items.nth(0)).toHaveText(new RegExp(`^Changed to 0\\.2 ${s.base} at ${at}$`));
  await expect(items.nth(1)).toHaveText(new RegExp(`^Changed to 0\\.1 ${s.base} at ${at}$`));
  // The same times as the service's record: the page's time for each is the one the service's time formats to here.
  const shownTimes = await page.evaluate(
    (isos) =>
      isos.map((iso) =>
        new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(
          new Date(iso),
        ),
      ),
    trail.map((a) => a.recordedAt),
  );
  for (const [i, text] of shownTimes.entries()) await expect(items.nth(i)).toContainText(text);
  await door(s, { kind: 'cancel_order', symbol: s.symbol, clientOrderKey: s.openKey });
});
