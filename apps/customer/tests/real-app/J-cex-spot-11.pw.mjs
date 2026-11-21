// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fromUnits, journeyState, restartWithSetting, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { connectWhenAsked } from './dex.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { keyHolder, makeKey, withKey } from './developer.mjs';
import { venueListingWrite } from './own-market.mjs';
import { approverSessions, makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import {
  continueInWallet,
  openVenuePage,
  otherTraderKey,
  otherTraderRun,
  sameDecimal,
  testDeposit,
  testVenue,
  venueAccount,
  venueForThisFile,
  venueInfo,
  venueBalance,
  venueRecord,
} from './venue.mjs';
import { setPartner } from './partner.mjs';
import { STACK_PORTS } from '../../../../tooling/scripts/local-test-facts.mjs';

// J-cex-spot-11, in the running app (docs/roadmap/journeys.json): I convert one coin to another in one tap and see it in
// my history. One test per step, titled "J-cex-spot-11 #<n>", run in order on one TEST account. #9 (very large amounts
// priced from our own book by the quote desk) is Later: its desk pricing waits for the custodial layer; today the room
// routes an amount past the per-conversion limit to the desk, which says it is closed.
//
// INTAFACED holds none of this person's money. With svc-trade's user-venue door on for this file (venueForThisFile), a
// conversion is one order on the person's own account at the stack's TEST venue simulator, signed by the person's
// wallet: a price is the venue's best price bounded by the owner's TEST slippage limit and holds nothing; accepting it
// signs one IOC order at that limit. Every fill, balance and resting order is read from the TEST venue's own record,
// never from the page, and the person's ledger is read to show it posts nothing for the swap. The steps trade on TEST
// spot markets of this file's own, made at the start of #1: A (TEST limit 1000 USDC per order, smallest 5 USDC), B (no
// limit published) and C (listed but not open, so its coin is restricted). Two other TEST traders sign on the TEST
// venue directly and make the other side. Every figure is TEST.
const J = 'J-cex-spot-11';
const ROOM = '/trade/convert';
const MAKER = 'js11-maker';
const TAKER = 'js11-taker';
/** The TEST partner bank's own book on svc-bank, read on loopback (svc-bank `partner/test-partner-record.ts`). */
const PARTNER_RECORD = `http://127.0.0.1:${STACK_PORTS.bank}/test-partner`;
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const ref = () => `84532:0x${randomBytes(32).toString('hex')}:0`;
const fresh = () => randomBytes(4).toString('hex');
const traderOwner = (name) => otherTraderKey(name).address.toLowerCase();
const since = () => new Date(Date.now() - 3_600_000).toISOString();

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

const card = (page) => page.getByTestId('cvt-card');
const amountBox = (page) => card(page).getByRole('textbox', { name: 'Amount to convert' });
const review = (page) => page.getByRole('dialog', { name: 'Review conversion' });
const line = (scope, name) => scope.locator(`[data-line="${name}"]`);
const picker = (page) => page.getByRole('dialog', { name: 'Choose an asset' });
const pickerRow = (page, ticker) =>
  picker(page)
    .getByTestId('picker__row')
    .filter({ has: page.getByTestId('picker__ticker').getByText(ticker, { exact: true }) });
/** "1,000.5 USDC" → "1000.5": the amount a line shows, without its asset. */
const amountOf = (text, asset) =>
  text
    .replace(new RegExp(`\\s*${asset}$`), '')
    .replace(/,/g, '')
    .trim();

/** A line that shows `value` of `asset`, read again until the page shows it (the same decimal, however written). */
const shows = (locator, asset, value) =>
  expect.poll(async () => sameDecimal(amountOf(await locator.innerText(), asset), value), { timeout: 15_000 }).toBe(true);

/** Every Convert request the page sends from now on, by path (quote, accept, limit, submit), so "nothing sent" is checked. */
function convertCalls(page) {
  const seen = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (r.method() === 'POST' && (p.startsWith('/api/v1/venue/convert/') || p === '/api/v1/venue/prepare' || p === '/api/v1/venue/submit'))
      seen.push(p.replace('/api/v1/venue/', ''));
  });
  return seen;
}

/** The person's signing requests to the browser TEST wallet: typed-data signatures only. */
const signatures = (wallet) => wallet.requests.filter((r) => /signTypedData/i.test(String(r.method))).length;

/** Opens the Convert room with the person's TEST wallet connected. */
const openRoom = (page, s, path = ROOM, key = s.walletKey) => openVenuePage(page, s.account, path, key);

/** Picks From and To through the room's pickers, as a person picks them. */
async function pick(page, from, to) {
  await card(page).getByRole('button', { name: 'Change the From asset' }).click();
  await pickerRow(page, from).click();
  await expect(picker(page)).toHaveCount(0);
  await card(page).getByRole('button', { name: 'Change the To asset' }).click();
  await pickerRow(page, to).click();
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByTestId('to-field')).toContainText(to);
}

/** Types an amount, asks for a price and returns the quote the venue priced (the answer the page shows). */
async function getPrice(page, amount) {
  await amountBox(page).fill(amount);
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/convert/quote');
  await card(page).getByRole('button', { name: 'Get a price', exact: true }).click();
  const res = await answer;
  const body = await res.json();
  expect(res.status(), JSON.stringify(body).slice(0, 400)).toBe(200);
  await expect(card(page).getByTestId('cvt-quote')).toHaveAttribute('data-quote-id', body.quoteId);
  return body;
}

/** The venue's own records for one owner. */
// The venue's order history is rows of { order, placedAt }; a step reads the orders themselves.
const orders = async (owner, cloid) =>
  (await venueRecord(owner, '/order-history')).value.map((r) => r.order).filter((o) => o.venueClientOrderId === cloid);
const fillsOf = async (owner, cloid) =>
  (await venueRecord(owner, '/fills', { since: since() })).value.filter((f) => f.venueClientOrderId === cloid);
const openOn = async (owner, symbol) => (await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === symbol);
const balanceOf = async (owner, asset) =>
  (await venueRecord(owner, '/balances')).value.find((b) => b.asset === asset) ?? { asset, free: '0', locked: '0', total: '0' };

/** What one order's venue fills paid and received, fees taken where the venue took them (its own fills, summed). */
function fromFills(fills, side, base, quote) {
  const scale = toUnits('1');
  let baseUnits = 0n;
  let quoteUnits = 0n;
  let feeBase = 0n;
  let feeQuote = 0n;
  for (const f of fills) {
    baseUnits += toUnits(f.amount);
    quoteUnits += (toUnits(f.price) * toUnits(f.amount)) / scale;
    const fee = toUnits(f.venueFee) + toUnits(f.builderFee);
    if (f.feeAsset === base) feeBase += fee;
    else if (f.feeAsset === quote) feeQuote += fee;
  }
  return side === 'buy'
    ? { paid: fromUnits(quoteUnits + feeQuote), received: fromUnits(baseUnits - feeBase), size: fromUnits(baseUnits) }
    : { paid: fromUnits(baseUnits + feeBase), received: fromUnits(quoteUnits - feeQuote), size: fromUnits(baseUnits) };
}

let operators;
/** One read of svc-ledger's own operator door, as the stack's TEST founder a with admin:treasury reads it. */
async function ledgerRead(path) {
  if (!operators) {
    const ctx = await makeContext({ log: () => undefined });
    operators = { ctx, sessions: await approverSessions(ctx) };
  }
  const { ctx, sessions } = operators;
  const res = await fetch(`${ctx.url('ledger')}${path}`, { headers: { authorization: `Bearer ${await sessions.a.treasuryToken()}` } });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}
const builderFeeTrace = async (owner, fillId) =>
  ledgerRead(`/operator/trace?businessKey=${encodeURIComponent(`builder-fee:${(await venueInfo()).id}:${owner}:${fillId}`)}`);

/** Svc-trade restarted with one setting (null: the stack's own value); the door stays on, as this file needs it. */
function restartTrade(envKey, value) {
  const before = process.env.LOCAL_STACK_USER_VENUE;
  process.env.LOCAL_STACK_USER_VENUE = 'on';
  try {
    restartWithSetting('trade', envKey, value);
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_USER_VENUE;
    else process.env.LOCAL_STACK_USER_VENUE = before;
  }
}
const restartConvert = (on) => restartTrade('LOCAL_STACK_TRADE_CONVERT', on ? null : 'off');

/** One TEST order of another trader, signed on the TEST venue directly. */
async function traderOrder(name, symbol, { side, price, amount, timeInForce }) {
  const answer = await otherTraderRun(name, {
    kind: 'place_order',
    symbol,
    side,
    type: 'limit',
    amount,
    price,
    timeInForce,
    reduceOnly: false,
    clientOrderKey: `order:${traderOwner(name)}:js11-${fresh()}`,
    builderFee: null,
  });
  expect(answer, JSON.stringify(answer).slice(0, 300)).toMatchObject({ accepted: true });
  return answer.order;
}

/**
 * A TEST spot market of this file's own, on the TEST venue with its own published limits, listed by two operators.
 * `opensAt` in the future keeps it listed and not open: its coin can't be converted.
 */
async function convertMarket(tag, { maxOrderNotional, opensAt = new Date(Date.now() - 60_000).toISOString() }) {
  const base = `JCV${tag}${fresh().toUpperCase().slice(0, 6)}`;
  const symbol = `${base}-USDC`;
  const added = await testVenue('/test/market-add', {
    symbol,
    baseAsset: base,
    quoteAsset: 'USDC',
    maxOrderQty: null,
    maxOrderNotional,
    minOrderNotional: '5',
  });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  await venueListingWrite(J, symbol, 'trade.venue_listing_set', 'listingSet', { opensAt }, '0');
  for (const name of [MAKER, TAKER])
    for (const [asset, amount] of [
      [base, '5000'],
      ['USDC', '500000'],
    ]) {
      const funded = await testVenue('/test/deposit', {
        account: await venueAccount(traderOwner(name)),
        asset,
        amount,
        depositRef: `seed:${name}:${symbol}:${asset}`,
      });
      expect(funded.status, JSON.stringify(funded.body)).toBe(200);
    }
  return { symbol, base };
}

/**
 * TEST setup, not a step (the Starts line), made at the start of #1: a verified account, this run's TEST wallet, TEST
 * 100 USDC in the person's venue account by the TEST venue's deposit control, and the file's three markets. On A the
 * maker rests an ask at 10 and a bid at 9.9; on B an ask at 10.
 */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const who = await signUp(page, 'js11v');
    await verify(page, who);
    const walletKey = testWalletKey();
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', '100', ref())).toBe(true);
    const session = await api(who);
    const status = (await session.get('/api/v1/venue/status')).body;
    expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
    const marketA = await convertMarket('A', { maxOrderNotional: '1000' });
    const marketB = await convertMarket('B', { maxOrderNotional: null });
    const marketC = await convertMarket('C', { maxOrderNotional: null, opensAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    await traderOrder(MAKER, marketA.symbol, { side: 'sell', price: '10', amount: '100', timeInForce: 'GTC' });
    await traderOrder(MAKER, marketA.symbol, { side: 'buy', price: '9.9', amount: '100', timeInForce: 'GTC' });
    await traderOrder(MAKER, marketB.symbol, { side: 'sell', price: '10', amount: '100', timeInForce: 'GTC' });
    return run.reset({
      account: who,
      walletKey,
      marketA,
      marketB,
      marketC,
      ledgerStart: await session.balances(),
      notTaken: [],
      accepted: [],
    });
  } finally {
    await page.close();
  }
}

test(`${J} #1 opens /trade/convert and picks the coins: only coins that can be converted, each with its per-transaction limit or "Limit not set"; a restricted coin is not listed`, async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  await startsLine(browser);
  const s = state();
  const { marketA: A, marketB: B, marketC: C } = s;

  // What can be converted, as svc-trade reads it from the venue's markets and our listings: C's coin is restricted.
  const pairs = (await (await api(s.account)).get('/api/v1/venue/convert/pairs')).body;
  expect(pairs.assets).toEqual(expect.arrayContaining(['USDC', A.base, B.base]));
  expect(pairs.assets).not.toContain(C.base);
  expect(pairs.restricted).toContain(C.base);

  await openRoom(page, s);
  await expect(card(page)).toHaveAttribute('data-mode', 'venue');
  // The From picker lists only convertible coins, each with a limit line; the restricted coin is not there.
  await card(page).getByRole('button', { name: 'Change the From asset' }).click();
  await expect(pickerRow(page, 'USDC')).toBeVisible();
  await expect(pickerRow(page, A.base)).toBeVisible();
  await expect(pickerRow(page, C.base)).toHaveCount(0);
  for (const row of await picker(page).getByTestId('picker__row').all())
    await expect(row).toContainText(/Up to [\d,.]+ \S+ per conversion|Limit not set/);
  // No coin the service reports restricted is offered, and every coin offered is one the service can convert.
  const fromTickers = await picker(page).getByTestId('picker__ticker').allInnerTexts();
  for (const r of pairs.restricted) expect(fromTickers).not.toContain(r);
  for (const ticker of fromTickers) expect(pairs.assets).toContain(ticker);
  await pickerRow(page, 'USDC').click();
  // To from USDC: A with the venue's published limit, B with none published, never C.
  await card(page).getByRole('button', { name: 'Change the To asset' }).click();
  await expect(pickerRow(page, A.base)).toContainText('Up to 1,000 USDC per conversion');
  await expect(pickerRow(page, B.base)).toContainText('Limit not set');
  await expect(pickerRow(page, C.base)).toHaveCount(0);
  const toTickers = await picker(page).getByTestId('picker__ticker').allInnerTexts();
  for (const r of pairs.restricted) expect(toTickers).not.toContain(r);
  for (const ticker of toTickers) expect(pairs.assets).toContain(ticker);
  await pickerRow(page, A.base).click();
  await expect(page.getByTestId('from-field')).toContainText('USDC');
  await expect(page.getByTestId('to-field')).toContainText(A.base);
  await expect(page.getByTestId('cvt-available')).toHaveText('Available on your trading account: 100 USDC');
  // A link to the restricted pair shows it can't be converted, priced nothing.
  await page.goto(`${ROOM}?from=USDC&to=${C.base}`);
  await expect(page.getByTestId('cvt-route-refused')).toHaveAttribute('data-code', 'trade.convert_pair_unlisted');
});

test(`${J} #2 types a TEST amount below the minimum or above the balance: "Too small" or "not enough" in words before any price is asked for; the not-enough card links to deposit`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const s = state();
  await openRoom(page, s);
  const sent = convertCalls(page);
  await pick(page, 'USDC', s.marketA.base);
  const priceButton = card(page).getByRole('button', { name: 'Get a price', exact: true });

  await amountBox(page).fill('1');
  await expect(card(page).getByTestId('cvt-too-small')).toHaveText('Too small: the smallest conversion is about 5 USDC.');
  await expect(priceButton).toBeDisabled();

  await amountBox(page).fill('150');
  const short = card(page).getByTestId('cvt-short');
  await expect(short).toContainText('Not enough USDC: you have 100 USDC available on your trading account.');
  await expect(card(page).getByTestId('cvt-too-small')).toHaveCount(0);
  await expect(priceButton).toBeDisabled();
  await short.getByRole('link', { name: 'Deposit USDC' }).click();
  const deposit = page.getByRole('dialog', { name: 'Deposit into your venue account' });
  await expect(deposit).toBeVisible();

  expect(sent, 'no price was asked for and nothing was sent').toEqual([]);
});

test(`${J} #3 gets a price: the venue's best price, our builder fee as none on a buy and a slippage limit; no price is held for a countdown; the order never costs more than the typed spend`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const s = state();
  const A = s.marketA;
  const usdcBefore = await balanceOf(s.owner, 'USDC');
  await openRoom(page, s);
  await pick(page, 'USDC', A.base);
  const q = await getPrice(page, '20');
  run.write({ notTaken: [...s.notTaken, q.quoteId] });

  // The venue's best price: the maker's ask at 10, the only ask on A.
  expect(q).toMatchObject({ side: 'buy', market: A.symbol, from: 'USDC', to: A.base, held: false, test: true });
  expect(sameDecimal(q.bestPrice.price, '10')).toBe(true);
  const shownQuote = card(page).getByTestId('cvt-quote');
  await expect(line(shownQuote, 'best-price')).toHaveText(`1 ${A.base} = 10 USDC`);
  // The slippage limit: the limit price the order is sent at, at the owner's TEST cap from the best price.
  expect(toUnits(q.limitPrice)).toBeGreaterThan(toUnits(q.bestPrice.price));
  await expect(line(shownQuote, 'slippage')).toContainText(
    `Fills at ${q.limitPrice} USDC or better (${q.slippageBps} bps from the best price)`,
  );
  // Our builder fee: none on a buy.
  expect(q.builderFee).toEqual({ kind: 'none', reason: 'buy' });
  await expect(line(shownQuote, 'builder-fee')).toHaveText('None on a buy: the venue charges builder fees only in the quote asset');
  await expect(line(shownQuote, 'venue-fee')).toBeVisible();
  // Never more than the typed spend: the size at the limit price is at most 20 USDC.
  expect(toUnits(q.maxCost)).toBeLessThanOrEqual(toUnits('20'));
  expect((toUnits(q.size) * toUnits(q.limitPrice)) / toUnits('1')).toBeLessThanOrEqual(toUnits('20'));
  await shows(line(shownQuote, 'max-cost'), 'USDC', q.maxCost);
  // Nothing is held: no countdown, the words say so, and the venue locked nothing and rests nothing for the person.
  await expect(shownQuote.getByTestId('cvt-no-hold')).toHaveText(
    'The venue holds no price and nothing is set aside: accept within the window, or get a fresh price.',
  );
  await expect(card(page).getByRole('progressbar')).toHaveCount(0);
  const usdcAfter = await balanceOf(s.owner, 'USDC');
  expect(sameDecimal(usdcAfter.free, usdcBefore.free)).toBe(true);
  expect(sameDecimal(usdcAfter.locked, usdcBefore.locked)).toBe(true);
  expect(await openOn(s.owner, A.symbol)).toEqual([]);
});

test(`${J} #4 waits past the slippage window with the review open: a fresh price must be accepted before anything is signed`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const s = state();
  const A = s.marketA;
  const wallet = await openRoom(page, s);
  const sent = convertCalls(page);
  await pick(page, 'USDC', A.base);
  const q = await getPrice(page, '20');
  await card(page).getByRole('button', { name: 'Review', exact: true }).click();
  await expect(review(page)).toBeVisible();
  await expect(review(page).getByRole('button', { name: 'Convert now' })).toBeVisible();

  // Past the price's window (the stack's TEST accept window), with the review still open.
  const wait = Math.max(0, Date.parse(q.freshUntil) - Date.now()) + 2_000;
  await expect(review(page).getByTestId('dlg-stale')).toBeVisible({ timeout: wait + 10_000 });
  await expect(review(page).getByTestId('dlg-stale')).toContainText('This price is past its window');
  await expect(review(page).getByRole('button', { name: 'Convert now' })).toHaveCount(0);
  // The service signs nothing for it either: accepting the old price is refused.
  const late = await (await api(s.account)).post('/api/v1/venue/convert/accept', { owner: s.owner, quoteId: q.quoteId });
  expect(late.status, JSON.stringify(late.body).slice(0, 300)).toBe(409);
  expect(JSON.stringify(late.body)).toContain('trade.convert_quote_expired');

  // A fresh price, a new quote, before anything can be signed.
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/convert/quote');
  await review(page).getByRole('button', { name: 'Get a fresh price' }).click();
  const fresher = await (await answer).json();
  expect(fresher.quoteId).not.toBe(q.quoteId);
  await expect(review(page).getByTestId('dlg-breakdown')).toHaveAttribute('data-quote-id', fresher.quoteId);
  await expect(review(page).getByTestId('dlg-stale')).toHaveCount(0);
  await expect(review(page).getByRole('button', { name: 'Convert now' })).toBeVisible();
  await review(page).getByRole('button', { name: 'Close' }).last().click();
  run.write({ notTaken: [...state().notTaken, q.quoteId, fresher.quoteId] });

  expect(
    sent.filter((p) => p !== 'convert/quote'),
    'nothing was accepted or sent',
  ).toEqual([]);
  expect(signatures(wallet), 'the wallet was never asked').toBe(0);
  expect(await openOn(s.owner, A.symbol)).toEqual([]);
});

test(`${J} #5 presses Convert now, twice: one signed swap; a receipt from the venue fill and the new venue balances`, async ({ page }) => {
  test.setTimeout(240_000);
  const s = state();
  const A = s.marketA;
  const usdcBefore = await balanceOf(s.owner, 'USDC');
  const coinBefore = await balanceOf(s.owner, A.base);
  const wallet = await openRoom(page, s);
  const sent = convertCalls(page);
  await pick(page, 'USDC', A.base);
  const q = await getPrice(page, '20');
  await card(page).getByRole('button', { name: 'Review', exact: true }).click();
  await review(page).getByRole('button', { name: 'Convert now' }).dblclick();
  await continueInWallet(page);
  const receipt = card(page).getByTestId('cvt-receipt');
  await expect(receipt).toHaveAttribute('data-state', 'filled', { timeout: 30_000 });
  const cloid = await receipt.getAttribute('data-client-id');
  expect(cloid).toBeTruthy();

  // One signed swap: one wallet signature, one accept, one submit, one order on the venue under that client id.
  expect(signatures(wallet)).toBe(1);
  expect(sent.filter((p) => p === 'convert/accept')).toHaveLength(1);
  expect(sent.filter((p) => p === 'convert/submit')).toHaveLength(1);
  const placed = await orders(s.owner, cloid);
  expect(placed, JSON.stringify(placed).slice(0, 400)).toHaveLength(1);
  expect(placed[0]).toMatchObject({ symbol: A.symbol, side: 'buy', status: 'filled' });
  expect(sameDecimal(placed[0].price, q.limitPrice)).toBe(true);
  // Filled at the price accepted, inside its slippage limit.
  const fills = await fillsOf(s.owner, cloid);
  expect(fills.length).toBeGreaterThan(0);
  for (const f of fills) expect(toUnits(f.price)).toBeLessThanOrEqual(toUnits(q.limitPrice));
  const got = fromFills(fills, 'buy', A.base, 'USDC');
  expect(sameDecimal(got.size, q.size)).toBe(true);
  // The receipt is the venue's fill, and the venue's balances moved by exactly that.
  await expect(line(receipt, 'paid')).toHaveText(new RegExp(`USDC$`));
  await shows(line(receipt, 'paid'), 'USDC', got.paid);
  await shows(line(receipt, 'received'), A.base, got.received);
  await expect(line(receipt, 'client-id')).toHaveText(cloid);
  const usdcAfter = await balanceOf(s.owner, 'USDC');
  const coinAfter = await balanceOf(s.owner, A.base);
  expect(fromUnits(toUnits(usdcBefore.total) - toUnits(usdcAfter.total))).toBe(fromUnits(toUnits(got.paid)));
  expect(fromUnits(toUnits(coinAfter.total) - toUnits(coinBefore.total))).toBe(fromUnits(toUnits(got.received)));
  const balances = card(page).getByTestId('cvt-balances');
  await expect(balances.locator(`tr[data-asset="${A.base}"]`)).toBeVisible();
  await shows(balances.locator(`tr[data-asset="${A.base}"] [data-cell="total"]`), A.base, coinAfter.total);

  // Money: the ledger posts nothing for the swap, and a buy carries no builder fee, so none is posted for any fill.
  for (const f of fills) {
    expect(toUnits(f.builderFee)).toBe(0n);
    expect((await builderFeeTrace(s.owner, f.fillId)).found).toBe(false);
  }
  expect(await (await api(s.account)).balances()).toEqual(s.ledgerStart);
  run.write({ accepted: [...s.accepted, { quoteId: q.quoteId, cloid, step: 5 }] });
});

test(`${J} #6 loses the connection on accept: the note stays; Check again reads the venue by client id and cannot swap twice`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const A = s.marketA;
  const wallet = await openRoom(page, s);
  const sent = convertCalls(page);
  await pick(page, 'USDC', A.base);
  const q = await getPrice(page, '20');
  // The venue applies the next submit on this account and its answer is lost on the way back (a timeout).
  const lose = await testVenue('/test/account-switches', { owner: s.owner, loseAnswers: 1 });
  expect(lose.status, JSON.stringify(lose.body)).toBe(200);
  await card(page).getByRole('button', { name: 'Review', exact: true }).click();
  await review(page).getByRole('button', { name: 'Convert now' }).click();
  await continueInWallet(page);
  const note = card(page).getByTestId('cvt-unknown');
  await expect(note).toBeVisible({ timeout: 30_000 });
  await expect(note).toContainText('We couldn’t confirm this conversion');
  const cloid = await note.getAttribute('data-client-id');
  expect(cloid).toBeTruthy();
  // The note stays: a poll of the room later it is still there, with no receipt in its place.
  await page.waitForTimeout(6_000);
  await expect(note).toBeVisible();
  await expect(card(page).getByTestId('cvt-receipt')).toHaveCount(0);
  // The note stays across a reload, for the same client id.
  await page.reload();
  await connectWhenAsked(page, page.getByTestId('venue-wallet-address'));
  await expect(note).toBeVisible({ timeout: 30_000 });
  await expect(note).toHaveAttribute('data-client-id', cloid);
  await expect(card(page).getByTestId('cvt-receipt')).toHaveCount(0);
  // The order did reach the venue once.
  expect(await orders(s.owner, cloid)).toHaveLength(1);

  // Check again reads the venue by this client id; it sends nothing again.
  const before = sent.length;
  await note.getByRole('button', { name: 'Check again' }).click();
  const receipt = card(page).getByTestId('cvt-receipt');
  await expect(receipt).toHaveAttribute('data-client-id', cloid, { timeout: 30_000 });
  await expect(note).toHaveCount(0);
  expect(sent.slice(before), 'Check again sent nothing').toEqual([]);
  expect(signatures(wallet)).toBe(1);
  const placed = await orders(s.owner, cloid);
  expect(placed).toHaveLength(1);
  const fills = await fillsOf(s.owner, cloid);
  expect(sameDecimal(fromFills(fills, 'buy', A.base, 'USDC').size, q.size)).toBe(true);
  for (const f of fills) expect(toUnits(f.price)).toBeLessThanOrEqual(toUnits(q.limitPrice));
  expect(await (await api(s.account)).balances()).toEqual(s.ledgerStart);
  run.write({ accepted: [...state().accepted, { quoteId: q.quoteId, cloid, step: 6 }] });
});

test(`${J} #7 converts while instant buys are paused: "Use Spot" with the reason; nothing sent`, async ({ page }) => {
  test.setTimeout(420_000);
  const s = state();
  const A = s.marketA;
  const historyBefore = (await venueRecord(s.owner, '/order-history')).value.length;
  restartConvert(false);
  try {
    const wallet = await openRoom(page, s);
    const sent = convertCalls(page);
    await pick(page, 'USDC', A.base);
    await amountBox(page).fill('20');
    const paused = card(page).getByTestId('cvt-paused');
    await expect(paused).toContainText('Instant buy is paused');
    await expect(paused).toContainText('Conversions are paused on this platform. Nothing was priced or sent.');
    await expect(paused.getByRole('link', { name: 'Use Spot' })).toHaveAttribute('href', `/trade/spot/${encodeURIComponent(A.symbol)}`);
    await expect(card(page).getByRole('button', { name: 'Get a price', exact: true })).toBeDisabled();
    // The service refuses a price the same way, with its typed reason.
    const asked = await (
      await api(s.account)
    ).post('/api/v1/venue/convert/quote', {
      owner: s.owner,
      from: 'USDC',
      to: A.base,
      amount: '20',
      quoteKey: `js11-paused-${fresh()}`,
    });
    expect(asked.status, JSON.stringify(asked.body).slice(0, 300)).toBe(409);
    expect(JSON.stringify(asked.body)).toContain('trade.convert_disabled');
    expect(sent, 'nothing sent from the page').toEqual([]);
    expect(signatures(wallet)).toBe(0);
    expect((await venueRecord(s.owner, '/order-history')).value).toHaveLength(historyBefore);
  } finally {
    restartConvert(true);
  }
});

test(`${J} #8 sets a limit convert at a target rate: a resting venue order at that price, filled once when the price is reached`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const B = s.marketB;
  const wallet = await openRoom(page, s);
  await pick(page, 'USDC', B.base);
  await card(page).getByRole('tab', { name: 'Limit' }).click();
  await amountBox(page).fill('20');
  await card(page).getByRole('textbox', { name: 'Target rate' }).fill('9.5');
  await card(page).getByRole('button', { name: 'Place limit convert' }).click();
  await continueInWallet(page);
  const result = card(page).getByTestId('cvt-limit-result');
  await expect(result).toBeVisible({ timeout: 30_000 });
  const cloid = await result.getAttribute('data-client-id');
  expect(cloid).toBeTruthy();
  expect(signatures(wallet)).toBe(1);

  // One venue order resting at the target rate: below the ask at 10, so nothing fills yet on the venue's book.
  const resting = await openOn(s.owner, B.symbol);
  expect(resting, JSON.stringify(resting).slice(0, 400)).toHaveLength(1);
  expect(resting[0]).toMatchObject({ venueClientOrderId: cloid, side: 'buy', status: 'open' });
  expect(sameDecimal(resting[0].price, '9.5')).toBe(true);
  const size = resting[0].amount;
  expect((toUnits(size) * toUnits('9.5')) / toUnits('1')).toBeLessThanOrEqual(toUnits('20'));
  await expect(result).toHaveText(`Resting on the venue: buy ${size} ${B.base} at 9.5 USDC.`);

  // The price is reached: another TEST trader sells at 9.5. The order fills once, for its whole size, and rests no more.
  await traderOrder(TAKER, B.symbol, { side: 'sell', price: '9.5', amount: size, timeInForce: 'IOC' });
  await expect.poll(async () => (await orders(s.owner, cloid))[0]?.status, { timeout: 30_000 }).toBe('filled');
  const fills = await fillsOf(s.owner, cloid);
  expect(sameDecimal(fromFills(fills, 'buy', B.base, 'USDC').size, size)).toBe(true);
  for (const f of fills) expect(sameDecimal(f.price, '9.5')).toBe(true);
  expect(new Set(fills.map((f) => f.fillId)).size).toBe(fills.length);
  expect(await orders(s.owner, cloid)).toHaveLength(1);
  expect(await openOn(s.owner, B.symbol)).toEqual([]);
  expect(await (await api(s.account)).balances()).toEqual(s.ledgerStart);
  run.write({ accepted: [...s.accepted, { quoteId: null, cloid, step: 8 }] });
});

test(`${J} #9 converts a very large amount: routed to the quote desk, which says it is closed until its rules are published`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const A = s.marketA;
  // The quote desk with no published rules: its TEST size bounds are taken away for this step, then put back.
  restartTrade('LOCAL_STACK_TRADE_OTC_CONVERT_BOUNDS', 'off');
  try {
    await nineAtTheDesk(page, s, A);
  } finally {
    restartTrade('LOCAL_STACK_TRADE_OTC_CONVERT_BOUNDS', null);
  }
});

async function nineAtTheDesk(page, s, A) {
  const wallet = await openRoom(page, s);
  const sent = convertCalls(page);
  await pick(page, 'USDC', A.base);
  // Market A's TEST limit is 1000 USDC per conversion: 5000 is past it, so the instant card asks no price and points to
  // the quote desk, which is closed for conversions until its rules are published.
  await amountBox(page).fill('5000');
  const routed = card(page).getByRole('note').filter({ hasText: 'Too large for an instant conversion' });
  await expect(routed).toContainText('Up to 1,000 USDC converts in one go.');
  await routed.getByRole('link', { name: 'Use the quote desk' }).click();
  const desk = page.getByRole('region', { name: 'Large conversions at the desk price' });
  await expect(desk).toBeFocused();
  await expect(desk).toContainText('The quote desk is closed for conversions until its rules are published.');
  await expect(card(page).getByRole('button', { name: 'Get a price', exact: true })).toBeDisabled();
  expect(sent.filter((p) => p === 'convert/quote')).toHaveLength(0);
  expect(signatures(wallet)).toBe(0);
}

test(`${J} #10 opens Recent conversions: the conversion with paid and received amounts and time; never the quotes that were not taken; an empty list reads as empty`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const s = state();
  expect(
    s.accepted.map((a) => a.step),
    'the conversions #5, #6 and #8 made',
  ).toEqual([5, 6, 8]);
  await openRoom(page, s);
  const recent = page.getByTestId('cvt-recent');
  await expect(recent.getByRole('heading', { name: /Recent conversions/ })).toBeVisible();
  const rows = recent.getByTestId('cvt-recent-row');
  await expect(rows).toHaveCount(s.accepted.length, { timeout: 30_000 });
  const markets = [s.marketA, s.marketA, s.marketB];
  for (const [i, a] of s.accepted.entries()) {
    const row = recent.locator(`[data-testid="cvt-recent-row"][data-client-id="${a.cloid}"]`);
    await expect(row).toHaveAttribute('data-state', 'filled');
    const base = markets[i].base;
    const got = fromFills(await fillsOf(s.owner, a.cloid), 'buy', base, 'USDC');
    await shows(row.locator('[data-cell="paid"]'), 'USDC', got.paid);
    await shows(row.locator('[data-cell="received"]'), base, got.received);
    await expect(row.locator('[data-cell="time"]')).toHaveText(/\d{4}.*\d{2}:\d{2}:\d{2}/);
  }
  // Never the quotes that were not taken (#3's and #4's).
  expect(s.notTaken.length).toBeGreaterThanOrEqual(3);
  const keys = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
  for (const quoteId of s.notTaken) expect(keys).not.toContain(`convert:${s.owner}:${quoteId}`);

  // Another wallet of the same person, with no conversions on its venue account: the list says it is empty.
  const other = await browser.newPage();
  try {
    await openRoom(other, s, ROOM, testWalletKey());
    const empty = other.getByTestId('cvt-recent');
    await expect(empty).toContainText('No conversions on this account');
    await expect(empty.getByTestId('cvt-recent-row')).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test(`${J} #11 converts a cash currency through a crypto leg: two linked legs shown as one record where the partner offers it; otherwise the screen says it is not offered`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const A = s.marketA;
  const session = await api(s.account);
  // Where the partner offers it: the TEST partner bank holds this person's cash (custody off: partner-held) and is funded
  // with TEST EUR, and the stack's TEST partner gives a TEST rate of 1.08 USDC a euro (tooling bank.mjs).
  await setPartner(s.account, { custody: 'off', notOffered: [] });
  try {
    const funded = await session.post('/api/bank/trpc/testPartner.fund', { fundId: `js11-eur-${fresh()}`, assetId: 'EUR', amount: '50' });
    expect(funded.status, JSON.stringify(funded.body).slice(0, 300)).toBe(200);
    const eurBefore = toUnits((await venueBalance(session.userId, 'EUR', PARTNER_RECORD)).total);
    const usdcBefore = await balanceOf(s.owner, 'USDC');
    const pairs = (await session.get('/api/v1/venue/convert/pairs')).body;
    expect(pairs.cash, JSON.stringify(pairs).slice(0, 400)).toEqual([
      expect.objectContaining({ asset: 'EUR', via: 'USDC', rate: '1.08', test: true }),
    ]);

    const wallet = await openRoom(page, s, `${ROOM}?from=EUR&to=${A.base}`);
    const sent = convertCalls(page);
    const linked = card(page).getByTestId('cvt-linked');
    await expect(linked).toHaveAttribute('data-cash', 'EUR');
    await expect(linked).toHaveAttribute('data-via', 'USDC');
    await expect(linked).toContainText('Two linked steps, one conversion');
    await expect(card(page).getByTestId('cvt-available')).toContainText('in your bank account');
    const q = await getPrice(page, '20');
    expect(q).toMatchObject({ from: 'EUR', to: A.base, side: 'buy', spend: '20', cashLeg: { cash: 'EUR', coin: 'USDC', rate: '1.08' } });
    expect(sameDecimal(q.cashLeg.coinSpend, '21.6')).toBe(true);
    // The venue order never spends more coin than the partner's leg pays in.
    expect(toUnits(q.maxCost)).toBeLessThanOrEqual(toUnits('21.6'));
    const quoted = card(page).getByTestId('cvt-quote');
    await expect(line(quoted, 'cash-leg')).toContainText('20 EUR for 21.6 USDC');
    await expect(line(quoted, 'coin-leg')).toContainText(`21.6 USDC for ${A.base}`);
    // A price moves nothing: the partner holds all the cash still.
    expect(toUnits((await venueBalance(session.userId, 'EUR', PARTNER_RECORD)).total)).toBe(eurBefore);

    await card(page).getByRole('button', { name: 'Review', exact: true }).click();
    await review(page).getByRole('button', { name: 'Convert now', exact: true }).dblclick();
    await continueInWallet(page);
    const receipt = card(page).getByTestId('cvt-receipt');
    await expect(receipt).toHaveAttribute('data-state', 'filled', { timeout: 30_000 });
    const cloid = await receipt.getAttribute('data-client-id');
    const legs = receipt.getByTestId('cvt-receipt-legs');
    await expect(legs.locator('[data-leg="cash"]')).toHaveAttribute('data-state', 'delivered');
    await expect(legs.locator('[data-leg="venue"]')).toHaveAttribute('data-state', 'filled');
    await expect(line(receipt, 'paid')).toContainText('EUR');

    // One record in Recent conversions, holding both legs.
    const key = `convert:${s.owner}:${q.quoteId}`;
    const row = page.getByTestId('cvt-recent-row').and(page.locator(`[data-key="${key}"]`));
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row.getByTestId('cvt-recent-legs').locator('li')).toHaveCount(2);
    await expect(row.locator('[data-cell="paid"]')).toContainText('20 EUR');
    await expect(row.locator('[data-cell="received"]')).toContainText(A.base);
    await stepPicture();

    // The records behind the screen. One signed venue order, one accept, one partner leg under one key.
    expect(signatures(wallet)).toBe(1);
    expect(sent.filter((p) => p === 'convert/accept')).toHaveLength(1);
    const history = (await session.get(`/api/v1/venue/convert/history?owner=${s.owner}`)).body;
    const mine = history.conversions.filter((c) => c.quoteId === q.quoteId);
    expect(mine, JSON.stringify(history).slice(0, 600)).toHaveLength(1);
    expect(mine[0]).toMatchObject({ from: 'EUR', to: A.base, paid: { asset: 'EUR' }, legs: { cash: { cash: 'EUR', coin: 'USDC' } } });
    const cashKey = `convert-cash:${s.owner}:${q.quoteId}`;
    expect(mine[0].legs.cash.legKey).toBe(cashKey);
    // The partner's own book: one move of 20 EUR out of the person's main balance under the leg's key.
    const moves = (await venueRecord(session.userId, '/moves', {}, PARTNER_RECORD, null)).value.filter((m) => m.key === cashKey);
    expect(moves, JSON.stringify(moves).slice(0, 400)).toHaveLength(1);
    expect(moves[0]).toMatchObject({ from: { owner: session.userId, assetId: 'EUR', spaceId: null } });
    expect(sameDecimal(moves[0].amount, '20')).toBe(true);
    expect(toUnits((await venueBalance(session.userId, 'EUR', PARTNER_RECORD)).total)).toBe(eurBefore - toUnits('20'));
    // The venue's own record: one filled order under the client id; the coin the partner paid in, less what it spent.
    const placed = await orders(s.owner, cloid);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ symbol: A.symbol, side: 'buy', status: 'filled' });
    const got = fromFills(await fillsOf(s.owner, cloid), 'buy', A.base, 'USDC');
    expect(sameDecimal(mine[0].legs.venue.paid.amount, got.paid)).toBe(true);
    const usdcAfter = await balanceOf(s.owner, 'USDC');
    expect(toUnits(usdcAfter.total) - toUnits(usdcBefore.total)).toBe(toUnits('21.6') - toUnits(got.paid));
    // Money: the ledger posts nothing for either leg.
    expect(await session.balances()).toEqual(s.ledgerStart);
    run.write({ accepted: [...s.accepted, { quoteId: q.quoteId, cloid, step: 11 }] });

    // Otherwise: the partner does not offer the cash leg for this person, so the screen says it is not offered and
    // nothing is priced, sent or signed, either way round.
    await setPartner(s.account, { notOffered: ['cash_leg'] });
    const off = (await session.get('/api/v1/venue/convert/pairs')).body;
    expect(off.cash).toEqual([]);
    expect(off.cashReason).toMatch(/switched cash through a coin off/);
    const quiet = convertCalls(page);
    const signedBefore = signatures(wallet);
    await page.goto(`${ROOM}?from=EUR&to=${A.base}`);
    const refused = page.getByTestId('cvt-route-refused');
    await expect(refused).toHaveAttribute('data-code', 'trade.convert_cash_not_offered');
    await expect(refused).toContainText('Cash through a coin isn’t offered here');
    await expect(card(page).getByRole('button', { name: 'Get a price', exact: true })).toBeDisabled();
    for (const [from, to] of [
      ['EUR', A.base],
      [A.base, 'EUR'],
    ]) {
      const route = await session.get(`/api/v1/venue/convert/route?from=${from}&to=${to}`);
      expect(route.status, JSON.stringify(route.body).slice(0, 300)).toBe(422);
      expect(JSON.stringify(route.body)).toContain('trade.convert_cash_not_offered');
    }
    expect(quiet).toEqual([]);
    expect(signatures(wallet)).toBe(signedBefore);
  } finally {
    await setPartner(s.account, { custody: 'on', notOffered: [] });
  }
});

/** A developer with a key, their own TEST wallet and TEST funds on their venue account, made once for #12 and #13. */
async function developer(browser) {
  const kept = run.read().developer;
  if (kept) return kept;
  const { page, who } = await keyHolder(browser, 'js11k');
  const key = await makeKey(page, { name: 'convert-bot', preset: 'Trade' });
  await page.context().close();
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  expect(await testDeposit(owner, 'USDC', '100', ref())).toBe(true);
  expect(await testDeposit(owner, state().marketA.base, '5', ref())).toBe(true);
  const dev = { who, key, walletKey, owner, ledgerStart: await (await api(who)).balances() };
  run.write({ developer: dev });
  return dev;
}

/** The developer's wallet signs a prepared action, as their program would. */
async function signedBy(dev, prepared) {
  const t = prepared.prepared.typedData;
  const signature = await privateKeyToAccount(dev.walletKey).signTypedData({
    domain: t.domain,
    types: t.types,
    primaryType: t.primaryType,
    message: t.message,
  });
  return { digest: prepared.prepared.digest, signature, signedBy: dev.owner };
}

test(`${J} #12 a developer asks for a quote through the convert API: a quote with no hold: asking locks no funds at the venue and holds no price`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const A = state().marketA;
  const dev = await developer(browser);
  const before = await balanceOf(dev.owner, 'USDC');
  const ask = { owner: dev.owner, from: 'USDC', to: A.base, amount: '10', quoteKey: `js11-api-${fresh()}` };
  const quote = await withKey(dev.key, { method: 'POST', path: '/api/v1/venue/convert/quote', body: ask });
  expect(quote.status, JSON.stringify(quote.body).slice(0, 400)).toBe(200);
  expect(quote.body).toMatchObject({ owner: dev.owner, from: 'USDC', to: A.base, side: 'buy', held: false, test: true });
  expect(toUnits(quote.body.maxCost)).toBeLessThanOrEqual(toUnits('10'));
  // Asking locks nothing at the venue and rests nothing: the developer's venue balance and open orders are as before.
  const after = await balanceOf(dev.owner, 'USDC');
  expect(sameDecimal(after.free, before.free)).toBe(true);
  expect(sameDecimal(after.locked, before.locked)).toBe(true);
  expect(await openOn(dev.owner, A.symbol)).toEqual([]);
  // The same ask again is the same quote, still holding nothing.
  const again = await withKey(dev.key, { method: 'POST', path: '/api/v1/venue/convert/quote', body: ask });
  expect(again.status).toBe(200);
  expect(again.body.quoteId).toBe(quote.body.quoteId);
  expect(sameDecimal((await balanceOf(dev.owner, 'USDC')).locked, before.locked)).toBe(true);
  expect(await (await api(dev.who)).balances()).toEqual(dev.ledgerStart);
});

test(`${J} #13 the developer accepts the same quote id twice through the convert API: the same quote id twice settles one convert`, async ({
  page,
  browser,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const A = state().marketA;
  const dev = await developer(browser);
  // A sale for the quote asset carries our builder fee, which the developer's wallet approves once.
  const session = await api(dev.who);
  const status = (await session.get('/api/v1/venue/status')).body;
  expect(status.builder, 'the stack publishes a TEST builder fee').toBeTruthy();
  const approve = await session.post('/api/v1/venue/prepare', {
    owner: dev.owner,
    signer: { role: 'owner', address: dev.owner },
    intent: { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
    actionKey: `builder-approval:${dev.owner}:${J}`,
  });
  expect(approve.status, JSON.stringify(approve.body).slice(0, 400)).toBe(200);
  const approved = await session.post('/api/v1/venue/submit', {
    actionKey: approve.body.actionKey,
    signature: await signedBy(dev, approve.body),
  });
  expect(approved.status, JSON.stringify(approved.body).slice(0, 400)).toBe(200);

  const quote = await withKey(dev.key, {
    method: 'POST',
    path: '/api/v1/venue/convert/quote',
    body: { owner: dev.owner, from: A.base, to: 'USDC', amount: '1', quoteKey: `js11-sell-${fresh()}` },
  });
  expect(quote.status, JSON.stringify(quote.body).slice(0, 400)).toBe(200);
  expect(quote.body).toMatchObject({ side: 'sell', builderFee: { kind: 'quote_asset' } });
  const accept = { method: 'POST', path: '/api/v1/venue/convert/accept', body: { owner: dev.owner, quoteId: quote.body.quoteId } };
  const [a, b] = await Promise.all([withKey(dev.key, accept), withKey(dev.key, accept)]);
  expect(a.status, JSON.stringify(a.body).slice(0, 400)).toBe(200);
  expect(b.status, JSON.stringify(b.body).slice(0, 400)).toBe(200);
  expect(b.body.actionKey).toBe(a.body.actionKey);
  expect(b.body.actionKey).toBe(`convert:${dev.owner}:${quote.body.quoteId}`);
  const cloid = a.body.prepared.venueClientOrderId;
  expect(b.body.prepared.venueClientOrderId).toBe(cloid);
  const submit = async (prepared) =>
    withKey(dev.key, {
      method: 'POST',
      path: '/api/v1/venue/convert/submit',
      body: { actionKey: prepared.actionKey, signature: await signedBy(dev, prepared) },
    });
  // Both signed copies sent at once: the first is sent to the venue; the second either answers with it or is told the
  // first is still being sent (idempotency.in_progress), and sent again after the first answered it gets the same order.
  const [x, y] = await Promise.all([submit(a.body), submit(b.body)]);
  const [first, second] = x.status === 200 ? [x, y] : [y, x];
  expect(first.status, JSON.stringify(first.body).slice(0, 400)).toBe(200);
  if (second.status !== 200) {
    expect(second.status, JSON.stringify(second.body).slice(0, 400)).toBe(409);
    expect(second.body.intafacedCode).toBe('idempotency.in_progress');
  }
  const again = await submit(b.body);
  expect(again.status, JSON.stringify(again.body).slice(0, 400)).toBe(200);
  const third = await withKey(dev.key, accept);
  expect(third.body.actionKey).toBe(a.body.actionKey);

  // One convert on the venue: one order under that client id, filled for the quote's size, and one conversion listed.
  await expect.poll(async () => (await orders(dev.owner, cloid))[0]?.status, { timeout: 30_000 }).toBe('filled');
  expect(await orders(dev.owner, cloid)).toHaveLength(1);
  const fills = await fillsOf(dev.owner, cloid);
  expect(sameDecimal(fromFills(fills, 'sell', A.base, 'USDC').size, quote.body.size)).toBe(true);
  const history = await withKey(dev.key, { path: `/api/v1/venue/convert/history?owner=${dev.owner}` });
  expect(history.status, JSON.stringify(history.body).slice(0, 400)).toBe(200);
  expect(history.body.conversions.filter((c) => c.quoteId === quote.body.quoteId)).toHaveLength(1);
  // The developer's own Recent conversions shows that one convert once, filled.
  await openRoom(page, { account: dev.who, walletKey: dev.walletKey });
  const recent = page.getByTestId('cvt-recent');
  const row = recent.locator(`[data-testid="cvt-recent-row"][data-client-id="${cloid}"]`);
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toHaveAttribute('data-state', 'filled');
  await stepPicture();

  // Money: the sale's builder fee is posted once per fill, for the venue's own figure; nothing else for the swap.
  for (const f of fills) {
    expect(toUnits(f.builderFee)).toBeGreaterThan(0n);
    await expect.poll(async () => (await builderFeeTrace(dev.owner, f.fillId)).found, { timeout: 90_000 }).toBe(true);
    const trace = await builderFeeTrace(dev.owner, f.fillId);
    expect(trace.reason).toBe('trade.builder_fee.earned');
    const debits = trace.postings.filter((p) => p.direction === 'debit');
    expect(debits).toHaveLength(1);
    expect(toUnits(debits[0].amount)).toBe(toUnits(f.builderFee));
  }
  expect(await (await api(dev.who)).balances()).toEqual(dev.ledgerStart);
});
