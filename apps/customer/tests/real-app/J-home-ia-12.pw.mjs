// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fromUnits, journeyState, restartService, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import { connectWhenAsked } from './dex.mjs';
import { ownSpotMarket } from './own-market.mjs';
import { continueInWallet, testDeposit, testVenue, venueAccount, venueForThisFile, venueInfo, venueRecord } from './venue.mjs';

// J-home-ia-12, "I cut my exposure from one risk screen", in the running app (docs/roadmap/journeys.json), on the person's
// own TEST venue account: the launch money model,
// where the venue holds the orders, the positions and their margin, INTAFACED holds none of it and the ledger posts
// nothing. One test per step, titled "J-home-ia-12 #<n>", run in order on one TEST account. Every order and position the
// page shows is checked against the TEST venue's own record (packages/venue-sim), read straight from it, never through our
// door; the ledger is read before and after to show it posts nothing. Every figure is TEST.
const J = 'J-home-ia-12';
const ROOM = '/trade/risk';
const PERP = 'BTC-PERP';
const STOCK = 'XSTK-PERP';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
// The stack's TEST venue, for this file only, cancels several orders in one signed action, as the venue it stands for
// does; svc-trade restarted so its door reads the venue afresh. After the file, it does not again.
const BATCH_CANCEL = { cancelsPerAction: 20 };
test.beforeAll(async () => {
  test.setTimeout(240_000);
  expect((await testVenue('/test/switches', BATCH_CANCEL)).body).toMatchObject(BATCH_CANCEL);
  await restartService('trade', { LOCAL_STACK_USER_VENUE: 'on' });
});
test.afterAll(async () => {
  await testVenue('/test/switches', { cancelsPerAction: null, venueDown: false });
});

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey || !s.empty || !s.spot)
    throw new Error(`${J} #1 made no accounts and wallets, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

/** One action signed by the person's own TEST key and sent to the TEST venue itself (setup, never a step's own action). */
async function ownRun(walletKey, intent) {
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  const account = await venueAccount(owner);
  const prepared = await testVenue('/prepare', { account, signer: { role: 'owner', address: owner }, intent });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 300)).toBe(200);
  const t = prepared.body.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
  expect(sent.body, JSON.stringify(sent.body).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  return sent.body;
}
const order = (symbol, side, amount, price, timeInForce, tag) => ({
  kind: 'place_order',
  symbol,
  side,
  type: 'limit',
  amount,
  price,
  timeInForce,
  reduceOnly: false,
  clientOrderKey: `order:${J.toLowerCase()}:${tag}:${randomBytes(4).toString('hex')}`,
  builderFee: null,
});

/** A TEST price `percent` of the venue's own best bid on `symbol`, on its tick: a buy there rests and never fills. */
async function awayBid(percent, symbol = PERP) {
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

/** The person's resting orders and open positions, from the TEST venue's own record. */
const venueOpen = async (owner) =>
  (await venueRecord(owner, '/open-orders')).value.filter((o) => o.status === 'open' || o.status === 'partially_filled');
const venuePositions = async (owner) => (await venueRecord(owner, '/positions')).value.filter((p) => toUnits(p.size) !== 0n);
const ledgerView = async (who) => (await api(who)).balances();

/**
 * TEST setup, not a step (the Starts line), made at the start of #1: a verified account, its own TEST venue account funded
 * by the TEST venue's deposit control, two open TEST futures positions (a long of 0.03 BTC-PERP and a long of 2 XSTK-PERP,
 * each taking the TEST makers' ladder) and three TEST orders resting far under the venue's bids in two markets (two on
 * a TEST spot market of this file's own, one on BTC-PERP), each placed by the person's own key; and a second verified account whose venue account
 * holds no order and no position. Made in #1, never in a beforeAll, so a restarted worker keeps the same accounts.
 */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'jh12');
    await verify(page, account);
    const walletKey = testWalletKey();
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', '5000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    await ownRun(walletKey, { kind: 'update_leverage', symbol: PERP, leverageBps: 100_000, marginMode: 'isolated' });
    await ownRun(walletKey, { kind: 'update_leverage', symbol: STOCK, leverageBps: 20_000, marginMode: 'isolated' });
    await ownRun(walletKey, order(PERP, 'buy', '0.03', '60100', 'IOC', 'long-btc'));
    await ownRun(walletKey, order(STOCK, 'buy', '2', '201', 'IOC', 'long-stock'));
    expect((await venuePositions(owner)).map((p) => `${p.symbol}:${p.side}`).sort()).toEqual([`${PERP}:long`, `${STOCK}:long`]);
    // The spot orders rest on a TEST spot market of this file's own, whose book only this file trades
    // (garden/no-shared-market-on-book): nothing another journey left there can fill them.
    const spot = (await ownSpotMarket(J, 'JHT', 'A')).symbol;
    const orders = [
      (await ownRun(walletKey, order(spot, 'buy', '1', '2', 'GTC', 'a'))).order.venueClientOrderId,
      (await ownRun(walletKey, order(spot, 'buy', '1', '3', 'GTC', 'b'))).order.venueClientOrderId,
      (await ownRun(walletKey, order(PERP, 'buy', '0.001', await awayBid(70, PERP), 'GTC', 'p'))).order.venueClientOrderId,
    ];
    expect((await venueOpen(owner)).map((o) => o.venueClientOrderId).sort()).toEqual([...orders].sort());
    const other = await browser.newContext();
    try {
      const second = await other.newPage();
      const empty = await signUp(second, 'jh12e');
      await verify(second, empty);
      run.reset({ account, walletKey, orders, spot, empty, emptyKey: testWalletKey(), ledger: await ledgerView(account) });
    } finally {
      await other.close();
    }
  } finally {
    await page.close();
  }
}

/** Installs the browser TEST wallet with `walletKey` on the venue's chain, signs in, opens the room and connects. */
async function openRoom(page, who, walletKey) {
  const { chainId } = await venueInfo();
  const wallet = await installTestWallet(page, { chainId, privateKey: walletKey });
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(ROOM);
  const address = page.getByTestId('venue-wallet-address');
  await connectWhenAsked(page, address);
  await expect(address).toHaveText(privateKeyToAccount(walletKey).address.toLowerCase());
  return wallet;
}
/** The room's section whose own heading is `title` (a sheet inside it has a heading of its own). */
const section = (page, title) => page.locator(`xpath=//section[h2[normalize-space(.)="${title}"]]`);
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;

/** Every door call this page makes, by its path (`prepare`, `submit`). */
function doorCalls(page) {
  const calls = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === 'POST' && path.startsWith('/api/v1/venue/'))
      calls.push({ path: path.slice('/api/v1/venue/'.length), body: r.postDataJSON() });
  });
  return { of: (name) => calls.filter((c) => c.path === name) };
}

test(`${J} #1 opens Risk control at /trade/risk while signed out, then signs in: "Sign in to see your exposure" with a Sign in button; after sign-in the same room opens`, async ({
  page,
  browser,
  stepPicture,
}) => {
  test.setTimeout(600_000);
  await startsLine(browser);
  const s = state();
  await page.goto(ROOM);
  await expect(page.getByText('Sign in to see your exposure', { exact: true })).toBeVisible({ timeout: 30_000 });
  const signInAction = page
    .getByRole('link', { name: 'Sign in', exact: true })
    .or(page.getByRole('button', { name: 'Sign in', exact: true }));
  await expect(signInAction.first()).toBeVisible();
  await signInAction.first().click();
  await expect(page).toHaveURL(/\/login\?redirect=%2Ftrade%2Frisk/);
  await page.fill('input[name=identifier]', s.account.email);
  await page.fill('input[name=password]', s.account.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(new RegExp(`${ROOM}$`), { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Risk control', exact: true }).first()).toBeVisible();
  await expect(page.getByText('Sign in to see your exposure', { exact: true })).toHaveCount(0);
  await expect(section(page, 'Exposure')).toBeVisible({ timeout: 30_000 });
  await stepPicture();
});

test(`${J} #2 reads Exposure: open orders as a count with each market and its count, open positions as a count; with none "You have no open orders." and "You have no open positions."; positions that can't be read say their count is unknown, never zero`, async ({
  page,
  browser,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const s = state();
  await openRoom(page, s.account, s.walletKey);
  const exposure = section(page, 'Exposure');
  // Three orders in two markets and two positions, as the venue's own record holds them.
  const open = await venueOpen(s.owner);
  expect(open).toHaveLength(3);
  const bySymbol = (symbol) => open.filter((o) => o.symbol === symbol).length;
  expect([bySymbol(s.spot), bySymbol(PERP)]).toEqual([2, 1]);
  await expect(exposure).toContainText(`${open.length} open orders`, { timeout: 30_000 });
  const markets = exposure.getByTestId('risk-orders-markets').locator('li');
  await expect(markets).toHaveText([`${s.spot}: ${bySymbol(s.spot)}`, `${PERP}: ${bySymbol(PERP)}`]);
  const positions = await venuePositions(s.owner);
  expect(positions).toHaveLength(2);
  await expect(exposure).toContainText(`${positions.length} open positions`);
  await stepPicture();

  // The venue can't be read: each count is unknown, never zero and never the last count.
  try {
    expect((await testVenue('/test/switches', { venueDown: true })).status).toBe(200);
    await expect(exposure).toContainText('Your positions could not be read, so their count is unknown.', { timeout: 30_000 });
    await expect(exposure).toContainText('Your open orders could not be read from the venue, so their count is unknown.');
    await expect(exposure).not.toContainText('open positions');
    await expect(exposure).not.toContainText('You have no open');
  } finally {
    await testVenue('/test/switches', { venueDown: false });
  }
  await expect(exposure).toContainText(`${positions.length} open positions`, { timeout: 30_000 });

  // With none: the second account's venue account holds no order and no position.
  const other = await browser.newContext();
  try {
    const empty = await other.newPage();
    const owner = privateKeyToAccount(s.emptyKey).address.toLowerCase();
    expect(await venueOpen(owner)).toEqual([]);
    expect(await venuePositions(owner)).toEqual([]);
    await openRoom(empty, s.empty, s.emptyKey);
    const none = section(empty, 'Exposure');
    await expect(none).toContainText('You have no open orders.', { timeout: 30_000 });
    await expect(none).toContainText('You have no open positions.');
  } finally {
    await other.close();
  }
  expect(await ledgerView(s.account)).toEqual(s.ledger);
});

test(`${J} #3 presses Cancel all orders and confirms: asked first, naming how many orders it cancels and that positions are not touched; one request cancels every open order in every market; "3 orders cancelled." and Exposure reads again with no open orders; with none open the button is disabled`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const wallet = await openRoom(page, s.account, s.walletKey);
  const door = doorCalls(page);
  const open = await venueOpen(s.owner);
  expect(open.map((o) => o.venueClientOrderId).sort()).toEqual([...s.orders].sort());
  const exposure = section(page, 'Exposure');
  await expect(exposure).toContainText(`${open.length} open orders`, { timeout: 30_000 });
  const positionsBefore = await venuePositions(s.owner);
  await section(page, 'Cancel all orders').getByRole('button', { name: 'Cancel all orders', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Cancel every open order?', exact: true });
  await expect(ask).toContainText(
    `This cancels ${open.length} open orders across all markets. Funds held for them are released. Positions are not touched.`,
  );
  // Asked first: nothing is sent before the person confirms.
  expect(door.of('prepare')).toHaveLength(0);
  const asked = signatures(wallet);
  await ask.getByRole('button', { name: 'Cancel all orders', exact: true }).click();
  await continueInWallet(page);
  await expect(page.getByRole('dialog', { name: 'Cancel every open order?', exact: true })).toContainText(
    `${open.length} orders cancelled.`,
    {
      timeout: 30_000,
    },
  );
  // One request, signed once, naming every open order in every market.
  expect(signatures(wallet)).toBe(asked + 1);
  expect(door.of('prepare')).toHaveLength(1);
  expect(door.of('submit')).toHaveLength(1);
  const sent = door.of('prepare')[0].body.intent;
  expect(sent.kind).toBe('cancel_orders');
  expect(sent.orders.map((o) => o.venueClientOrderId).sort()).toEqual([...s.orders].sort());
  expect(new Set(sent.orders.map((o) => o.symbol))).toEqual(new Set([s.spot, PERP]));
  expect(await venueOpen(s.owner)).toEqual([]);
  for (const id of s.orders)
    expect((await venueRecord(s.owner, '/order-by-client-id', { venueClientOrderId: id })).value.status).toBe('canceled');
  // Positions are not touched.
  expect((await venuePositions(s.owner)).map((p) => [p.symbol, p.side, p.size])).toEqual(
    positionsBefore.map((p) => [p.symbol, p.side, p.size]),
  );
  await expect(exposure).toContainText('You have no open orders.', { timeout: 30_000 });
  await stepPicture();
  await page
    .getByRole('dialog', { name: 'Cancel every open order?', exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(section(page, 'Cancel all orders').getByRole('button', { name: 'Cancel all orders', exact: true })).toBeDisabled();
  expect(await ledgerView(s.account)).toEqual(s.ledger);
});

test(`${J} #5 ticks two positions and presses Close selected positions: Select all and Clear work and the count of selected follows; with none ticked the button is disabled and says to select at least one; confirming closes each chosen position reduce-only, and the room reads again`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const wallet = await openRoom(page, s.account, s.walletKey);
  const door = doorCalls(page);
  const positions = await venuePositions(s.owner);
  expect(positions.map((p) => p.symbol).sort()).toEqual([PERP, STOCK]);
  const reduce = section(page, 'Reduce risk');
  const rows = reduce.getByTestId('risk-venue-positions').locator('li');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  const close = reduce.getByRole('button', { name: 'Close selected positions', exact: true });
  await expect(reduce.getByRole('status').filter({ hasText: 'selected' })).toHaveText('0 selected');
  await expect(close).toBeDisabled();
  await expect(reduce).toContainText('Select at least one position to close.');
  await reduce.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(reduce.getByRole('status').filter({ hasText: 'selected' })).toHaveText('2 selected');
  await reduce.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(reduce.getByRole('status').filter({ hasText: 'selected' })).toHaveText('0 selected');
  await expect(close).toBeDisabled();
  for (const p of positions) await reduce.getByRole('checkbox', { name: new RegExp(`^${p.symbol} · long`) }).click();
  await expect(reduce.getByRole('status').filter({ hasText: 'selected' })).toHaveText('2 selected');
  await expect(reduce).not.toContainText('Select at least one position to close.');
  await close.click();
  const review = page.getByTestId('risk-venue-close');
  await expect(review).toContainText('Each position closes with a reduce-only order at the market: it never opens or hedges.');
  expect(door.of('prepare')).toHaveLength(0);
  const asked = signatures(wallet);
  await review.getByRole('button', { name: 'Close 2 selected', exact: true }).click();
  for (let i = 0; i < positions.length; i += 1) await continueInWallet(page);
  await expect(review.getByTestId('venue-outcome')).toHaveCount(2, { timeout: 30_000 });
  // Each chosen position closed by its own reduce-only order, its full size, on the opposite side.
  expect(signatures(wallet)).toBe(asked + positions.length);
  const sent = door.of('prepare').map((c) => c.body.intent);
  expect(sent.map((i) => [i.symbol, i.side, i.amount, i.reduceOnly, i.timeInForce]).sort()).toEqual(
    positions.map((p) => [p.symbol, 'sell', p.size, true, 'IOC']).sort(),
  );
  await expect.poll(async () => (await venuePositions(s.owner)).length, { timeout: 30_000 }).toBe(0);
  // The room reads again: no position left in Exposure or in the list.
  await expect(section(page, 'Exposure')).toContainText('You have no open positions.', { timeout: 30_000 });
  await stepPicture();
  expect(await ledgerView(s.account)).toEqual(s.ledger);
});

test(`${J} #6 reads Alerts, Approvals and Platform incidents: Alerts links to notifications and to a chart; Approvals says the inbox is not connected with the code risk.approvals_source_unset and Open approvals disabled; incidents lists each open incident or says the feed lists none, and a feed that can't be read says this is not an all-clear`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const feed = page.waitForResponse((r) => r.url().includes('notify.statusFeed'), { timeout: 60_000 });
  await openRoom(page, s.account, s.walletKey);
  const alerts = section(page, 'Alerts');
  await expect(alerts.getByRole('link', { name: 'Open notifications', exact: true })).toHaveAttribute('href', '/notifications');
  await expect(alerts.getByRole('link', { name: 'Set a price alert on a chart', exact: true })).toHaveAttribute(
    'href',
    /^\/trade\/spot\/[A-Z]+-[A-Z]+$/,
  );
  const approvals = section(page, 'Approvals');
  await expect(approvals).toContainText(
    'The approvals inbox is not connected, so the count of approvals waiting for you cannot be read. It is not zero.',
  );
  await expect(approvals.locator('code')).toHaveText('risk.approvals_source_unset');
  await expect(approvals.getByRole('button', { name: 'Open approvals', exact: true })).toBeDisabled();
  // The incidents section says one honest state of the platform's status feed: each open incident with when it opened and
  // the status page, none listed, or not an all-clear with its code and Try again. Never a blank section.
  await feed;
  const shown = section(page, 'Platform incidents');
  const honest = shown.getByText(
    /Open since |^The status feed lists no open incident\.$|^The status feed could not be read, so incidents are unknown\. This is not an all-clear\.$/,
  );
  await expect(honest.first()).toBeVisible({ timeout: 30_000 });
  await stepPicture();
});
