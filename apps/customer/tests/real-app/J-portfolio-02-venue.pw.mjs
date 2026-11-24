// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { ownSpotMarket, venueListingWrite } from './own-market.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, fromUnits, journeyState, toUnits } from './stack.mjs';
import { confirm, reviewSheet, signIn, signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  otherTraderKey,
  otherTraderRun,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-portfolio-02, in the running app against the stack's TEST venue simulator (docs/roadmap/journeys.json): "I see what my
// trades made or lost". At launch a person trades in their own venue account, never through our book, so every trade here
// is a signed order on the venue desk against a TEST order another TEST trader rests on the venue's book, on TEST spot
// markets of this file's own (an empty book no other file trades), and every coin sits in the person's own venue account. One
// test per step, titled "J-portfolio-02 #<n>", run in order: #1 to #5 and #7 on one TEST account funded with TEST USDC in
// its venue account; #6 ("coins that arrived from outside") on an account of its own, so its arrived coins never share a
// lot book with the bought ones. Every figure is TEST, and every expected figure is a hand count from the venue's own
// record (its fills, balances and best prices, read through venueRecord, venueBalance and testVenue), never from the lot
// book the screen itself reads. The door is on for this file only.
const J = 'J-portfolio-02';
const DESK = '/trade/spot/BTC-USDC';
const SYMBOL = 'BTC-USDC';
/** TEST: 0.05 BTC arrives from outside; 0.02 of it is sold, so 0.03 stays. */
const ARRIVED = '0.05';
const SOLD = '0.02';
const LEFT = '0.03';
/** TEST: the price per BTC the person enters for the arrived coins. */
const ENTERED = '50000';
/**
 * TEST: #1 to #5 trade a TEST coin on a spot market of this file's own (an empty book only these steps trade): another
 * TEST trader rests a sell at 77, the person buys it, and later sells at 133. A spot buy on the venue pays its fee in the
 * coin it receives (3.5 bps as taker), so 20 coins arrive as 19.993, a whole number of the market's 0.001 steps: #3 can
 * sell every coin of the lot and close it.
 */
const BUY_PRICE = '77';
const BOUGHT = '20';
const SELL_PRICE = '133';
/** TEST: the other trader's two-sided quote #2 reads the price now from (its middle is 120), around neither trade price. */
const QUOTE_BID = '100';
const QUOTE_ASK = '140';
/** TEST USDC in the person's venue account, enough for #1's buy and #7's. */
const FUNDS = '5000';
/**
 * TEST: #7 buys 2 coins with dollars first (a known cost), then pays 1 of them for 2 of a second TEST coin priced at 0.5 in
 * the first: 1 is the smallest order the venue takes on that market.
 */
const FIRST_FOR_7 = '2';
const FIRST_PRICE_7 = '77';
const SECOND_PRICE = '0.5';
const SECOND_AMOUNT = '2';
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const trades = journeyState(`${J}-venue-trades-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ONE = toUnits('1');

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J}'s TEST setup made no account and wallet, so this step has no one to act as`);
  return s;
}

/** The screen's dollar text for an exact amount (fmtUsd): under 1 dollar at up to 4 places, else cents, half-up. */
function usd(units, signed = false) {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const places = abs < ONE ? 4 : 2;
  const step = 10n ** BigInt(18 - places);
  const rounded = (abs + step / 2n) / step;
  let frac = (rounded % 10n ** BigInt(places)).toString().padStart(places, '0');
  if (places === 4) frac = frac.replace(/0{1,2}$/, '');
  const whole = (rounded / 10n ** BigInt(places)).toLocaleString('en-US');
  const sign = rounded === 0n ? '' : negative ? '−' : signed ? '+' : '';
  return `${sign}$${whole}.${frac}`;
}

/**
 * What a venue sale paid, by hand from the venue's own fill: price times amount, rounded up as the venue settles it, less
 * everything the venue charged in USDC (its fee and our builder fee).
 */
function proceedsOf(f) {
  const product = toUnits(f.price) * toUnits(f.amount);
  const notional = (product + ONE - 1n) / ONE;
  return notional - (f.feeAsset === 'USDC' ? toUnits(f.venueFee) + toUnits(f.builderFee) : 0n);
}

async function pnl(page, query = '') {
  await page.goto(`/money/pnl${query}`);
  const main = page.locator('main').first();
  await expect(main.getByRole('heading', { name: 'Profit and loss', level: 1, exact: true })).toBeVisible();
  return main;
}

/**
 * TEST setup, not a journey step: two verified accounts, each with this run's TEST wallet key of its own; the trading one
 * holds TEST USDC in its venue account by the TEST venue's deposit control (keyed by a chain-transfer-shaped reference,
 * so a replay credits nothing).
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account && trades.read().account) return;
  test.setTimeout(420_000);
  const page = await browser.newPage();
  try {
    const trader = await signUp(page, 'pf2t');
    await verify(page, trader);
    const traderKey = testWalletKey();
    const owner = privateKeyToAccount(traderKey).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', FUNDS, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    expect(toUnits((await venueBalance(owner, 'USDC')).free)).toBe(toUnits(FUNDS));
    trades.reset({ account: trader, walletKey: traderKey });
    const account = await signUp(page, 'pf2v');
    await verify(page, account);
    run.reset({ account, walletKey: testWalletKey() });
  } finally {
    await page.close();
  }
});

function trader() {
  const s = trades.read();
  if (!s.account || !s.walletKey)
    throw new Error(`${J}'s TEST setup made no trading account and wallet, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

/** The venue's own best bid and ask on `symbol`, and its tick, read straight from the TEST venue. */
async function venueBook(symbol) {
  const { body: markets } = await testVenue('/markets', {});
  const market = markets.value.find((m) => m.symbol === symbol);
  expect(market, JSON.stringify(markets).slice(0, 300)).toBeTruthy();
  const best = await testVenue('/best-prices', { symbol });
  expect(best.status, JSON.stringify(best.body)).toBe(200);
  return {
    tick: toUnits(market.tickSize),
    bid: best.body.value.bid === null ? null : toUnits(best.body.value.bid),
    ask: best.body.value.ask === null ? null : toUnits(best.body.value.ask),
  };
}

/** Another TEST trader, named for this run and this person, funded on the TEST venue with `amount` of `asset`. */
async function otherTrader(owner, tag, asset, amount) {
  const name = `${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}-${owner.slice(2, 10)}-${tag}`;
  await testVenue('/test/deposit', {
    account: await venueAccount(otherTraderKey(name).address),
    asset,
    amount,
    depositRef: `seed:${name}:${asset}`,
  });
  return name;
}

/** The other TEST trader rests a limit order on the venue's book. */
async function rest(name, symbol, side, amount, price, key) {
  const rested = await otherTraderRun(name, {
    kind: 'place_order',
    symbol,
    side,
    type: 'limit',
    amount,
    price,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${name}:${key}`,
    builderFee: null,
  });
  expect(rested.definite && rested.accepted, JSON.stringify(rested)).toBe(true);
}

/** A limit order on the venue desk now open, reviewed once the venue's own preview answers, signed in the wallet. */
async function deskOrder(page, side, price, amount, coin = 'BTC') {
  const form = side === 'buy' ? 0 : 1;
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  await page.getByRole('textbox', { name: 'Price', exact: true }).nth(form).fill(price);
  const preview = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).nth(form).fill(amount);
  expect((await preview).status()).toBe(200);
  await page.getByRole('button', { name: `${side === 'buy' ? 'Buy' : 'Sell'} ${coin}`, exact: true }).click();
  const sheet = reviewSheet(page);
  await expect(sheet).toBeVisible();
  // A sell carries our builder fee: the wallet approves it first, then Confirm sell signs the order.
  const approve = sheet.getByRole('button', { name: 'Approve our builder fee in your wallet', exact: true });
  if (side === 'sell' && (await approve.isVisible())) {
    await approve.click();
    await continueInWallet(page);
    await expect(sheet.getByRole('button', { name: 'Confirm sell', exact: true })).toBeEnabled({ timeout: 20_000 });
  }
  await confirm(page, side);
  await continueInWallet(page);
}

/** The person's own fills on `symbol` and `side` since `since`, from the venue's own record, oldest first. */
async function fillsOf(owner, symbol, side, since) {
  return (await venueRecord(owner, '/fills', { since })).value
    .filter((f) => f.symbol === symbol && f.side === side)
    .sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt) || a.fillId.localeCompare(b.fillId));
}
const sumOf = (fills, of) => fills.reduce((sum, f) => sum + of(f), 0n);
/** What a venue buy paid: price times amount, rounded up as the venue settles it, plus any fee it took in the quote coin. */
function paidOf(f, quote) {
  const product = toUnits(f.price) * toUnits(f.amount);
  const notional = (product + ONE - 1n) / ONE;
  return notional + (f.feeAsset === quote ? toUnits(f.venueFee) + toUnits(f.builderFee) : 0n);
}
/** What a venue buy brought in: the amount less any fee the venue took in the coin received. */
const gotOf = (f, base) => toUnits(f.amount) - (f.feeAsset === base ? toUnits(f.venueFee) + toUnits(f.builderFee) : 0n);
/** The venue's own fee on a fill, in whichever coin it took it. */
const feeOf = (f) => toUnits(f.venueFee) + toUnits(f.builderFee);
/** fmtPct: the ratio half-up at 4 places, shown as a percent at 2, signed. */
function pct(num, den) {
  const negative = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const bp = (a * 10000n * 2n + d) / (2n * d);
  const text = `${bp / 100n}.${(bp % 100n).toString().padStart(2, '0')}%`;
  return `${bp === 0n ? '' : negative ? '−' : '+'}${text}`;
}

/**
 * TEST setup for #7: a fresh TEST spot market of this file's own between two coins that are not dollars, a second TEST
 * coin priced in `quote` (the TEST venue's /test/market-add control), listed for INTAFACED through svc-trade's two-person
 * door as ownSpotMarket lists its own.
 */
async function nonDollarMarket(quote) {
  const base = `PF2Q${randomBytes(3).toString('hex').toUpperCase()}`;
  const symbol = `${base}-${quote}`;
  const added = await testVenue('/test/market-add', {
    symbol,
    baseAsset: base,
    quoteAsset: quote,
    maxOrderQty: null,
    maxOrderNotional: null,
  });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  await venueListingWrite(
    J,
    symbol,
    'trade.venue_listing_set',
    'listingSet',
    { opensAt: new Date(Date.now() - 60_000).toISOString() },
    '0',
  );
  return { symbol, base };
}

/** The person's own venue account's row for `asset` on the profit and loss page. */
async function venueRow(main, owner, asset) {
  const { id } = await venueInfo();
  return main.locator(`tr[data-asset="${asset}"][data-venue="venue:${id}:${owner}"]`);
}

test(`${J} #1 buys a TEST coin on the venue desk, then reads the open lot: quantity, average price and cost with the fee inside`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const s = trader();
  const { symbol, base } = await ownSpotMarket(J, 'PF2', 'A');
  trades.write({ symbol, base });
  // Another TEST trader rests a sell of 20 coins at 77 on the market's empty book, so the buy below meets it at once.
  const seller = await otherTrader(s.owner, 'ask', base, BOUGHT);
  await rest(seller, symbol, 'sell', BOUGHT, BUY_PRICE, 'pf2-ask');

  const since = new Date(Date.now() - 1_000).toISOString();
  const wallet = await openVenueDesk(page, s.account, `/trade/spot/${symbol}`, s.walletKey);
  expect(wallet.address.toLowerCase()).toBe(s.owner);
  await deskOrder(page, 'buy', BUY_PRICE, BOUGHT, base);
  const bought = () => fillsOf(s.owner, symbol, 'buy', since);
  await expect.poll(async () => fromUnits(sumOf(await bought(), (f) => toUnits(f.amount))), { timeout: 30_000 }).toBe(BOUGHT);
  // By hand from the venue's own fills: what arrived (the amount less the fee taken in the coin) and what it cost.
  const fills = await bought();
  const qty = sumOf(fills, (f) => gotOf(f, base));
  const cost = sumOf(fills, (f) => paidOf(f, 'USDC'));
  const fee = sumOf(fills, feeOf);
  expect(fee).toBeGreaterThan(0n);
  expect(qty).toBe(toUnits(BOUGHT) - fee);
  expect(cost).toBe((toUnits(BOUGHT) * toUnits(BUY_PRICE)) / ONE);
  expect(toUnits((await venueBalance(s.owner, base)).total)).toBe(qty);
  trades.write({ qty: fromUnits(qty), cost: fromUnits(cost) });

  const main = await pnl(page);
  const row = await venueRow(main, s.owner, base);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.locator('td').first()).toHaveText(fromUnits(qty));
  await expect(row.locator('[data-col="cost"]')).toHaveText(usd(cost));
  // The fee came out of the coins received, so the price per coin is what was paid over what arrived: the fee is inside.
  const average = (cost * ONE) / qty;
  expect(average).toBeGreaterThan(toUnits(BUY_PRICE));
  await expect(row.locator('[data-col="average"]')).toHaveText(usd(average));
  await expect(main).toContainText('The fee on a buy is inside the cost');
});

test(`${J} #2 reads unrealised profit and loss for the coin, as an amount and a percent of the cost, at the venue's price now`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = trader();
  const { symbol, base, qty, cost } = trades.read();
  // Another TEST trader quotes the coin on both sides of the book, so the venue has a price now: the middle, 120.
  const quoter = await otherTrader(s.owner, 'quote', base, '10');
  await testDeposit(otherTraderKey(quoter).address, 'USDC', '10000', `seed:${quoter}:USDC`);
  await rest(quoter, symbol, 'buy', '1', QUOTE_BID, 'pf2-quote-bid');
  await rest(quoter, symbol, 'sell', '1', QUOTE_ASK, 'pf2-quote-ask');
  const book = await venueBook(symbol);
  expect([book.bid, book.ask]).toEqual([toUnits(QUOTE_BID), toUnits(QUOTE_ASK)]);
  await openVenueDesk(page, s.account, `/trade/spot/${symbol}`, s.walletKey);
  const main = await pnl(page);
  const row = await venueRow(main, s.owner, base);
  // By hand: worth now is the open coins at the venue's middle price (half-up at 18 places), less the lot's cost.
  const mid = (book.bid + book.ask) / 2n;
  const worth = (toUnits(qty) * mid + ONE / 2n) / ONE;
  const unrealised = worth - toUnits(cost);
  await expect(row.locator('[data-col="unrealised"]')).toHaveText(`${usd(unrealised, true)} (${pct(unrealised, toUnits(cost))})`, {
    timeout: 30_000,
  });
  await expect(row.locator('td').nth(3)).toHaveText(usd(worth));
  await expect(main.locator('[data-figure="unrealised"]')).toHaveText(usd(unrealised, true));
  // The venue's book is as it was: nothing the page read moved it.
  const after = await venueBook(symbol);
  expect([after.bid, after.ask]).toEqual([book.bid, book.ask]);
});

test(`${J} #3 sells the coins on the venue desk: a sale row with what was received, the cost of the lot it used and the realised result; the lot closes`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const s = trader();
  const { symbol, base, qty, cost } = trades.read();
  // Another TEST trader rests a buy of every coin held at 133, the best bid, so the sale meets it at once.
  const buyer = await otherTrader(s.owner, 'bid', 'USDC', '10000');
  await rest(buyer, symbol, 'buy', qty, SELL_PRICE, 'pf2-bid');

  const since = new Date(Date.now() - 1_000).toISOString();
  await openVenueDesk(page, s.account, `/trade/spot/${symbol}`, s.walletKey);
  await deskOrder(page, 'sell', SELL_PRICE, qty, base);
  const sold = () => fillsOf(s.owner, symbol, 'sell', since);
  await expect.poll(async () => fromUnits(sumOf(await sold(), (f) => toUnits(f.amount))), { timeout: 30_000 }).toBe(qty);
  // The venue's own record: no coin left, and what the sale paid (price times amount, rounded up, less its USDC fees).
  await expect.poll(async () => toUnits((await venueBalance(s.owner, base)).total), { timeout: 15_000 }).toBe(0n);
  const sells = await sold();
  expect(sells.every((f) => f.price === SELL_PRICE || toUnits(f.price) === toUnits(SELL_PRICE))).toBe(true);
  const proceeds = sumOf(sells, proceedsOf);
  // One lot, sold whole: the sale takes all of its cost.
  const realised = proceeds - toUnits(cost);
  expect(realised).toBeGreaterThan(0n);
  trades.write({ realised: fromUnits(realised) });

  const main = await pnl(page);
  const sale = main.locator('tr[data-sale]').filter({ hasText: base }).first();
  await expect(sale).toBeVisible({ timeout: 30_000 });
  await expect(sale.locator('td').nth(0)).toHaveText(qty);
  await expect(sale.locator('td').nth(1)).toHaveText(usd(proceeds));
  await expect(sale.locator('td').nth(2)).toHaveText(usd(toUnits(cost)));
  await expect(sale.locator('[data-col="result"]')).toHaveText(usd(realised, true));
  await expect(main.locator('[data-figure="realised"]')).toHaveText(usd(realised, true));
  // Every coin of the lot was sold: the lot is closed and no open row for the coin is left.
  await expect(main.locator(`tr[data-asset="${base}"]`)).toHaveCount(0);
});

test(`${J} #4 reads the label: an indicator, not a tax form, with the method FIFO and what it means`, async ({ page }) => {
  const who = trader().account;
  await signIn(page, who);
  const main = await pnl(page);
  // The step's own words name the label: "Indicator, not tax advice".
  await expect(main.locator('[data-indicator="true"]')).toContainText('Indicator, not tax advice');
  const methods = main.getByRole('group', { name: 'Matching method', exact: true });
  await expect(methods.getByRole('button', { name: 'FIFO: oldest first', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(main).toContainText('Each sale is matched against the lots you bought, one lot at a time, using the method you pick.');
});

test(`${J} #5 switches to LIFO (one lot: the same result), then asks for an unknown method and is refused`, async ({ page }) => {
  test.setTimeout(300_000);
  const s = trader();
  const who = s.account;
  const { realised } = trades.read();
  await openVenueDesk(page, who, DESK, s.walletKey);
  const main = await pnl(page);
  await expect(main.locator('[data-figure="realised"]')).toHaveText(usd(toUnits(realised), true), { timeout: 30_000 });
  const methods = main.getByRole('group', { name: 'Matching method', exact: true });
  await methods.getByRole('button', { name: 'LIFO: newest first', exact: true }).click();
  await expect(methods.getByRole('button', { name: 'LIFO: newest first', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(main.locator('[data-figure="realised"]')).toHaveText(usd(toUnits(realised), true));

  // An unknown method in the link: nothing is worked out, the refusal is in words with the service's code.
  const refused = await pnl(page, '?method=LOFO');
  await expect(refused).toContainText('That matching method isn’t offered');
  await expect(page).toHaveURL(/method=LOFO/);
  await expect(refused.locator('[data-figure="realised"]')).toHaveCount(0);
  // The service refuses the same method on its own door, so the screen is not the only guard.
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${JSON.stringify(login).slice(0, 300)}`);
  const res = await fetch(`${EDGE}/api/tax/trpc/lotBook?input=${encodeURIComponent(JSON.stringify({ method: 'LOFO' }))}`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(400);
  // Picking a method again brings the figures back.
  await refused
    .getByRole('group', { name: 'Matching method', exact: true })
    .getByRole('button', { name: 'FIFO: oldest first', exact: true })
    .click();
  await expect(page).toHaveURL(/method=FIFO/);
  await expect(refused.locator('[data-figure="realised"]')).toHaveText(usd(toUnits(realised), true));
});

test(`${J} #7 trades between two non-dollar coins on the venue: no dollar figure on either side where none is known`, async ({ page }) => {
  test.setTimeout(600_000);
  const s = trader();
  // TEST: buy a first coin with USDC, so the coin that pays has a known cost; then a second coin priced in the first.
  const first = await ownSpotMarket(J, 'PF2', 'C');
  const second = await nonDollarMarket(first.base);
  const seller = await otherTrader(s.owner, 'ask7', first.base, FIRST_FOR_7);
  await rest(seller, first.symbol, 'sell', FIRST_FOR_7, FIRST_PRICE_7, 'pf2-ask7');
  const secondSeller = await otherTrader(s.owner, 'second', second.base, SECOND_AMOUNT);
  await rest(secondSeller, second.symbol, 'sell', SECOND_AMOUNT, SECOND_PRICE, 'pf2-second');

  const since = new Date(Date.now() - 1_000).toISOString();
  await openVenueDesk(page, s.account, `/trade/spot/${first.symbol}`, s.walletKey);
  await deskOrder(page, 'buy', FIRST_PRICE_7, FIRST_FOR_7, first.base);
  await expect
    .poll(async () => fromUnits(sumOf(await fillsOf(s.owner, first.symbol, 'buy', since), (f) => toUnits(f.amount))), { timeout: 30_000 })
    .toBe(FIRST_FOR_7);
  const firstBefore = toUnits((await venueBalance(s.owner, first.base)).total);
  // Then the second coin bought on its own book, paid in the first: neither leg is in dollars.
  await openVenueDesk(page, s.account, `/trade/spot/${second.symbol}`, s.walletKey);
  await deskOrder(page, 'buy', SECOND_PRICE, SECOND_AMOUNT, second.base);
  const bought = () => fillsOf(s.owner, second.symbol, 'buy', since);
  await expect.poll(async () => fromUnits(sumOf(await bought(), (f) => toUnits(f.amount))), { timeout: 30_000 }).toBe(SECOND_AMOUNT);
  // By hand from the venue's own fills and balances: the first coin that paid and the second that arrived.
  const fills = await bought();
  const paid = sumOf(fills, (f) => paidOf(f, first.base));
  const got = sumOf(fills, (f) => gotOf(f, second.base));
  expect(paid).toBeGreaterThan(0n);
  expect(got).toBeGreaterThan(0n);
  expect(firstBefore - toUnits((await venueBalance(s.owner, first.base)).total)).toBe(paid);
  expect(toUnits((await venueBalance(s.owner, second.base)).total)).toBe(got);

  const main = await pnl(page);
  // The first coin that paid is a sale with no dollar proceeds, so its result is not known; never a made-up price.
  const sale = main.locator('tr[data-sale]').filter({ hasText: first.base }).first();
  await expect(sale).toBeVisible({ timeout: 30_000 });
  await expect(sale.locator('td').nth(0)).toHaveText(fromUnits(paid));
  await expect(sale.locator('td').nth(1)).toHaveText('Not known');
  await expect(sale.locator('[data-col="result"]')).not.toContainText('$');
  // The second coin that arrived is a bought lot with no dollar cost.
  await page.goto(`/money/pnl?asset=${second.base}`);
  const lots = page.getByRole('region', { name: 'Lots', exact: true });
  const lot = lots.locator('tbody tr[data-source="trade"]');
  await expect(lot).toHaveCount(1, { timeout: 30_000 });
  await expect(lot.locator('[data-col="qty"]')).toHaveText(fromUnits(got));
  await expect(lot.locator('[data-col="cost"]')).toHaveText('Cost unknown');
  await expect((await venueRow(page.locator('main').first(), s.owner, second.base)).locator('[data-col="cost"]')).toHaveText('Not known');
});

test(`${J} #6 sells coins that arrived from outside: the lot's cost is unknown unless the person enters it, never zero, and until then the result is unknown and the realised total blank`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const s = state();
  const owner = privateKeyToAccount(s.walletKey).address.toLowerCase();

  // TEST 0.05 BTC arrives in the person's own venue account from outside, by the TEST venue's deposit control (keyed by
  // a chain-transfer-shaped reference, so a replay credits nothing): no trade, so no cost is known.
  const ref = `84532:0x${randomBytes(32).toString('hex')}:0`;
  expect(await testDeposit(owner, 'BTC', ARRIVED, ref)).toBe(true);
  expect(toUnits((await venueBalance(owner, 'BTC')).total)).toBe(toUnits(ARRIVED));
  // The venue's own record of it: one credit from outside, 0.05 BTC.
  const arrivals = (await venueRecord(owner, '/arrivals')).value;
  expect(arrivals).toEqual([expect.objectContaining({ arrivalId: ref, kind: 'deposit', asset: 'BTC', amount: ARRIVED })]);

  // Another TEST trader rests a buy of 0.02 BTC one tick over the venue's best bid, so the sale below meets it at once.
  const { body: markets } = await testVenue('/markets', {});
  const market = markets.value.find((m) => m.symbol === SYMBOL);
  expect(market, JSON.stringify(markets).slice(0, 300)).toBeTruthy();
  const tick = toUnits(market.tickSize);
  // The venue's own best bid and ask, read straight from the TEST venue.
  const best = await testVenue('/best-prices', { symbol: SYMBOL });
  expect(best.status, JSON.stringify(best.body)).toBe(200);
  expect(best.body.value.bid && best.body.value.ask, `the TEST venue has a two-sided book on ${SYMBOL}`).toBeTruthy();
  const bid = toUnits(best.body.value.bid);
  const ask = toUnits(best.body.value.ask);
  const price = bid + tick < ask ? bid + tick : bid;
  const buyer = `${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}-${owner.slice(2, 10)}`;
  await testVenue('/test/deposit', {
    account: await venueAccount(otherTraderKey(buyer).address),
    asset: 'USDC',
    amount: '10000',
    depositRef: `seed:${buyer}:USDC`,
  });
  const rested = await otherTraderRun(buyer, {
    kind: 'place_order',
    symbol: SYMBOL,
    side: 'buy',
    type: 'limit',
    amount: SOLD,
    price: fromUnits(price),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${buyer}:pf2-bid`,
    builderFee: null,
  });
  expect(rested.definite && rested.accepted, JSON.stringify(rested)).toBe(true);

  // The person sells 0.02 of those coins on the venue desk, a limit sell at that bid, signed in their own wallet.
  const since = new Date(Date.now() - 1_000).toISOString();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  expect(wallet.address.toLowerCase()).toBe(owner);
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  await page.getByRole('textbox', { name: 'Price', exact: true }).nth(1).fill(fromUnits(price));
  const preview = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).nth(1).fill(SOLD);
  expect((await preview).status()).toBe(200);
  await page.getByRole('button', { name: 'Sell BTC', exact: true }).click();
  const sheet = reviewSheet(page);
  await expect(sheet).toBeVisible();
  // A sell carries our builder fee: the wallet approves it first, then Confirm sell signs the order.
  const approve = sheet.getByRole('button', { name: 'Approve our builder fee in your wallet', exact: true });
  if (await approve.isVisible()) {
    await approve.click();
    await continueInWallet(page);
    await expect(sheet.getByRole('button', { name: 'Confirm sell', exact: true })).toBeEnabled({ timeout: 20_000 });
  }
  await confirm(page, 'sell');
  await continueInWallet(page);
  const sells = async () => (await venueRecord(owner, '/fills', { since })).value.filter((f) => f.symbol === SYMBOL && f.side === 'sell');
  await expect.poll(async () => fromUnits((await sells()).reduce((sum, f) => sum + toUnits(f.amount), 0n)), { timeout: 30_000 }).toBe(SOLD);
  // The venue's own record: 0.03 BTC left, and what the sale paid.
  await expect.poll(async () => fromUnits(toUnits((await venueBalance(owner, 'BTC')).total)), { timeout: 15_000 }).toBe(LEFT);
  const proceeds = (await sells()).reduce((sum, f) => sum + proceedsOf(f), 0n);
  expect(proceeds).toBeGreaterThan(0n);

  // Profit and loss: the sale drew on the coins that arrived, whose cost is unknown, so its result is unknown and the
  // whole 0.02 is named as sold with no cost (Missing cost, PF-cost-basis-04).
  const main = await pnl(page);
  const sale = main.locator('tr[data-sale]').filter({ hasText: 'BTC' }).first();
  await expect(sale).toBeVisible({ timeout: 30_000 });
  await expect(sale.locator('td').nth(0)).toHaveText(SOLD);
  await expect(sale.locator('td').nth(1)).toHaveText(usd(proceeds));
  await expect(sale.locator('td').nth(2)).toHaveText('Not known');
  await expect(sale.locator('[data-col="result"]')).toHaveText(`Cost unknown Unknown share: ${SOLD} BTC sold with no cost`);
  await expect(sale.locator('[data-col="result"] [data-effect="unknown-share"]')).toHaveCount(1);
  // Never a made-up cost: the realised total is blank while one sale's result is unknown.
  await expect(main.locator('[data-figure="realised"]')).toHaveText('Not known');
  await expect(main.getByRole('list', { name: 'Why some figures are not known', exact: true })).toBeVisible();
  // The 0.03 BTC still held has no recorded cost either: unknown, never zero.
  const btc = main.locator('tr[data-asset="BTC"]');
  await expect(btc).toHaveCount(1);
  await expect(btc.locator('td').first()).toHaveText(LEFT);
  await expect(btc.locator('[data-col="cost"]')).toHaveText('Not known');

  // Unless the person enters it: a TEST price of 50000 per BTC for the coins that arrived. The sale then has a cost (0.02
  // at 50000 = $1,000.00) and a result (what the sale paid less that), both labelled customer-entered; the 0.03 still
  // held costs $1,500.00; and the realised total is no longer blank: it is that one result.
  const costSold = (toUnits(SOLD) * toUnits(ENTERED)) / ONE;
  const result = proceeds - costSold;
  const missingCard = main.getByRole('region', { name: 'Missing cost', exact: true });
  await missingCard.getByRole('button', { name: 'Enter a cost', exact: true }).click();
  const form = missingCard.getByRole('form', { name: 'Enter a cost for this lot', exact: true });
  await form.getByLabel('Price you paid per BTC, in USD', { exact: true }).fill(ENTERED);
  await form.getByLabel('Where this price comes from', { exact: true }).fill('TEST receipt');
  await form.getByRole('button', { name: 'Save price', exact: true }).click();
  await expect(page.getByTestId('basis-notice')).toHaveText('Price saved. The figures use it, marked customer-entered.');
  await expect(sale.locator('td').nth(1)).toHaveText(usd(proceeds));
  await expect(sale.locator('td').nth(2)).toHaveText(usd(costSold));
  await expect(sale.locator('[data-col="result"]')).toContainText(usd(result, true));
  await expect(sale.locator('[data-col="result"] [data-label="customer-entered"]')).toHaveText('Customer-entered');
  await expect(btc.locator('[data-col="cost"]')).toHaveText(usd((toUnits(LEFT) * toUnits(ENTERED)) / ONE));
  await expect(main.locator('[data-figure="realised"]')).toHaveText(usd(result, true));

  // Taking the price back, on the lot it was entered for, makes the cost unknown again and the total blank again.
  const btcBook = await pnl(page, '?asset=BTC');
  const pricedLot = btcBook
    .getByRole('region', { name: 'Lots', exact: true })
    .locator('tbody tr')
    .filter({ has: page.locator('[data-label="customer-entered"]') });
  await expect(pricedLot).toHaveCount(1);
  await pricedLot.getByRole('button', { name: 'Remove my price', exact: true }).click();
  await expect(page.getByTestId('basis-notice')).toHaveText('Price removed. That lot’s cost is unknown again.');
  await expect(pricedLot).toHaveCount(0);
  await pnl(page);
  await expect(sale.locator('td').nth(2)).toHaveText('Not known');
  await expect(sale.locator('[data-col="result"]')).toHaveText(`Cost unknown Unknown share: ${SOLD} BTC sold with no cost`);
  await expect(main.locator('[data-figure="realised"]')).toHaveText('Not known');
  await expect(btc.locator('[data-col="cost"]')).toHaveText('Not known');

  // With balances hidden (the eye, the account's own choice) the quantity inside that sentence is masked too, as every
  // figure on the page is. The eye is pressed on Home, where a venue account's wallet stays connected (as
  // J-home-ia-01-venue does); on Money with the venue door on it was redrawn under the click (run 43613224113).
  const eye = async (name) => {
    await page.goto('/');
    const button = page.getByRole('button', { name }).first();
    await expect(button).toBeVisible({ timeout: 30_000 });
    const written = page.waitForResponse((res) => res.url().includes('preferences.set') && res.request().method() === 'POST', {
      timeout: 30_000,
    });
    await button.click({ timeout: 30_000 });
    expect((await written).status()).toBe(200);
  };
  await eye('Hide balances');
  try {
    const hidden = await pnl(page);
    await expect(hidden.locator('tr[data-sale]').filter({ hasText: 'BTC' }).first().locator('[data-effect="unknown-share"]')).toHaveText(
      'Unknown share: •••• BTC sold with no cost',
    );
  } finally {
    await eye('Show balances');
  }

  // The venue's own record is untouched by any of it: the price is the person's note in the indicator, nothing moved.
  expect(fromUnits(toUnits((await venueBalance(owner, 'BTC')).total))).toBe(LEFT);
});
