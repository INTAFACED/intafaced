// World: book, market, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ORIGIN, api, bestPrices, fromUnits, fund, journeyState, restartWith, toUnits, tool } from './stack.mjs';
import {
  awayBid as engineAwayBid,
  confirm,
  deskPath,
  fundedTrader,
  held,
  openDesk,
  openOrders as engineOpenOrders,
  placements,
  previewed,
  reviewSheet,
  signUp,
  verify,
} from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueRecord,
} from './venue.mjs';
import { otherVenueTrader, venueBook, VENUE_SPOT } from './venue-reads.mjs';

// J-cex-spot-03 on the person's own venue account (B1, project-state #1789), in the running app against the stack's TEST
// venue simulator. One test per step, titled "J-cex-spot-03 #<n>", run in order on one TEST account: #1 makes the verified
// account, connects its TEST wallet and puts TEST USDC (and a little TEST BTC) in its venue account, the Starts line;
// the TEST market maker's sells rest on the venue's book. Every balance, lock, order and fill is read from the venue
// itself (venue.mjs, on loopback), never from our ledger or engine; the ledger is read only to show it posts nothing.
// Every figure is TEST. The user-venue door is on for this file only.
const J = 'J-cex-spot-03';
const DESK = deskPath('BTC/USDC');
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** The journey stack's owner market price protection: TEST 50 bps (tooling/scripts/local-stack-services/trade.mjs). */
const PROTECTION_BPS = 50n;
const ONE = toUnits('1');

// Our own engine's fill-or-kill and good-till-date (BTC/USDT, TEST USDT on the ledger), as main proved them before this
// file moved to the venue: the venue offers neither, so #5 and #7 keep that proof unchanged beside the venue's refusal.
// #5's words now say fill-or-kill is listed as not offered by this venue (Nino's decision, project-state #2260).
const ENGINE_FUNDED = '60000';
const engineTab = (page, name) => page.locator('[role=tab]', { hasText: new RegExp(`^${name}$`) });
async function enginePickTif(page, label) {
  await page.getByRole('combobox', { name: 'Time in force' }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}
/** A local "date and time" field value for `ms`, as the person would type it. */
function localField(ms) {
  const at = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
/** A limit buy on our engine's desk with the picked time in force, reviewed and confirmed. Returns the order body sent. */
async function engineLimitBuy(page, { tif, price, amount }) {
  const sent = placements(page);
  await engineTab(page, 'Limit').click();
  await enginePickTif(page, tif);
  await buyForm(page).getByRole('textbox', { name: 'Price' }).fill(price);
  await previewed(page, () => buyForm(page).getByRole('textbox', { name: 'Amount' }).fill(amount));
  await buyForm(page).getByRole('button', { name: 'Buy BTC' }).click();
  await expect(reviewSheet(page)).toContainText(tif);
  await confirm(page, 'buy');
  await expect.poll(() => sent.length).toBe(1);
  return sent[0];
}
/** The TEST USDT trader on our engine, in its own browser context: made once in this run, then signed in again. */
async function engineDesk(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN });
  const page = await context.newPage();
  let who = run.read().engine;
  if (!who) {
    who = await fundedTrader(page, 'js3e', ENGINE_FUNDED);
    run.write({ engine: who });
  }
  await openDesk(page, who);
  return { page, who, context };
}

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return s;
}
async function desk(page) {
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  await expect(page.getByTestId('venue-account')).toBeVisible();
  return { ...s, wallet, owner: wallet.address.toLowerCase() };
}

const buyForm = (page) => page.locator('form[data-testid="dk-form"][data-side="buy"]');
const sellForm = (page) => page.locator('form[data-testid="dk-form"][data-side="sell"]');
const orderTab = (page, name) => page.getByTestId('dk-order').locator('[role=tab]', { hasText: new RegExp(`^${name}$`) });
const line = (scope, name) => scope.locator(`[data-line="${name}"]`);
const tifTrigger = (page) => page.getByTestId('venue-tif').getByRole('combobox');
const stpTrigger = (page) => page.getByTestId('venue-self-trade').getByRole('combobox');

/** A number as the desk draws it ("60,010", "0.0016 USDC"), as scaled units. */
function shownUnits(text) {
  const found = /[\d,]+(\.\d+)?/.exec(text);
  if (!found) throw new Error(`no number in "${text}"`);
  return toUnits(found[0].replace(/,/g, ''));
}
const mul = (a, b) => (a * b) / ONE;

/** Every signing write the page sends to the door (prepare, submit), so a step can show nothing was sent. */
function writes(page) {
  const sent = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (r.method() === 'POST' && (p === '/api/v1/venue/prepare' || p === '/api/v1/venue/submit')) sent.push(p);
  });
  return sent;
}

/** The previews the page asks the door for, with the venue's answers, in order. */
function previews(page) {
  const seen = [];
  page.on('response', async (res) => {
    if (res.request().method() !== 'POST' || new URL(res.url()).pathname !== '/api/v1/venue/preview') return;
    seen.push({ intent: res.request().postDataJSON().intent, status: res.status(), body: await res.json().catch(() => null) });
  });
  return seen;
}

/** The TEST venue's own BTC-USDC market: what it offers, its tick and lot. */
async function market() {
  const { status, body } = await testVenue('/markets', {});
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.value.find((m) => m.symbol === VENUE_SPOT);
}

/** The worst price a market order may fill at: the venue's own best price moved by the owner's protection, to the tick. */
async function protectionBound(side) {
  const { bid, ask } = await venueBook(VENUE_SPOT);
  const tick = toUnits((await market()).tickSize);
  if (side === 'buy') return (((ask * (10_000n + PROTECTION_BPS)) / 10_000n + tick - 1n) / tick) * tick;
  return ((bid * (10_000n - PROTECTION_BPS)) / 10_000n / tick) * tick;
}

/** The venue's fills of `owner` since `since`. */
const fillsSince = async (owner, since) => (await venueRecord(owner, '/fills', { since: since.toISOString() })).value;
/** The venue's own record of one order by client id. */
const orderOf = async (owner, clientOrderId) =>
  (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId: clientOrderId })).value;
const openOrders = async (owner) => (await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === VENUE_SPOT);

/**
 * The step's added clause: every order type and time in force the venue doesn't offer on the market is listed disabled
 * with "not offered by this venue", and trying one signs and sends nothing. What is "not offered" is read from the venue.
 */
async function notOfferedSignsNothing(page, wallet) {
  const m = await market();
  const sent = writes(page);
  const asked = wallet.requests.length;
  const types = page.getByTestId('venue-order-types');
  const TYPE_NAMES = { stop_limit: 'Stop limit', stop: 'Stop', take_profit: 'Take profit', trailing_stop: 'Trailing stop' };
  const missingTypes = Object.keys(TYPE_NAMES).filter((x) => !m.orderTypes.includes(x));
  expect(missingTypes.length, 'the TEST venue lists only some order types, so the clause is exercised').toBeGreaterThan(0);
  for (const x of missingTypes) {
    const button = types.getByRole('button', { name: `${TYPE_NAMES[x]}: not offered by this venue`, exact: true });
    await expect(button).toBeDisabled();
    await button.click({ force: true });
  }
  const TIF_NAMES = { FOK: 'Fill or kill', GTD: 'Good till date' };
  const missingTifs = Object.keys(TIF_NAMES).filter((x) => !m.timeInForce.includes(x));
  await orderTab(page, 'Limit').click();
  const before = await tifTrigger(page).innerText();
  await tifTrigger(page).click();
  for (const x of missingTifs) {
    const option = page.getByRole('option', { name: `${TIF_NAMES[x]} · not offered by this venue`, exact: true });
    await expect(option).toHaveAttribute('aria-disabled', 'true');
    await option.click({ force: true });
  }
  await page.keyboard.press('Escape');
  await expect(tifTrigger(page)).toHaveText(before);
  await page.waitForTimeout(500);
  expect(sent, 'a choice the venue does not offer sends nothing').toEqual([]);
  expect(wallet.requests.length, 'and the wallet is asked for nothing').toBe(asked);
  return { missingTifs, sent };
}

/** Picks a time in force the venue offers from the desk's picker. */
async function pickTif(page, name) {
  await orderTab(page, 'Limit').click();
  await tifTrigger(page).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(tifTrigger(page)).toHaveText(name);
}

/** A limit on one side's form, reviewed (the venue previews it first). Returns the review sheet. */
async function reviewLimit(page, side, price, amount) {
  const form = side === 'buy' ? buyForm(page) : sellForm(page);
  await orderTab(page, 'Limit').click();
  await form.getByRole('textbox', { name: 'Price' }).fill(price);
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await form.getByRole('textbox', { name: 'Amount' }).fill(amount);
  expect((await answer).status()).toBe(200);
  await form.getByRole('button', { name: side === 'buy' ? 'Buy BTC' : 'Sell BTC' }).click();
  await expect(reviewSheet(page)).toBeVisible();
  return reviewSheet(page);
}

/** Confirms the open review and signs once in the wallet; returns the client id the door prepared. */
async function confirmAndSign(page, wallet, side) {
  const sheet = reviewSheet(page);
  // A spot sell carries our builder fee: until the wallet has approved it, the review asks for that approval first and
  // Confirm sell waits (J-cex-spot-01 #11). The approval is one signature of its own.
  const approve = sheet.getByRole('button', { name: 'Approve our builder fee in your wallet' });
  if (side === 'sell' && (await approve.count()) > 0) {
    const before = wallet.requests.length;
    await approve.click();
    await continueInWallet(page);
    await expect.poll(() => wallet.requests.length, { timeout: 20_000 }).toBe(before + 1);
    await expect(sheet.getByRole('button', { name: 'Confirm sell' })).toBeEnabled({ timeout: 20_000 });
  }
  const prepared = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/prepare' && r.request().method() === 'POST');
  const asked = wallet.requests.length;
  await confirm(page, side);
  await continueInWallet(page);
  await expect.poll(() => wallet.requests.length, { timeout: 20_000 }).toBe(asked + 1);
  expect(wallet.requests.at(-1).method).toBe('eth_signTypedData_v4');
  const body = await (await prepared).json();
  expect(body.prepared.venueClientOrderId, 'the door prepared the order under a client id').toBeTruthy();
  return body.prepared.venueClientOrderId;
}

/** A price far below the venue's best bid, on the tick: a buy there rests and meets nothing. */
async function awayBid() {
  const { bid } = await venueBook(VENUE_SPOT);
  return fromUnits((bid / 2n / ONE) * ONE);
}

/**
 * The owner values a venue spot market order needs, each blanked on a restart (tooling/scripts/local-stack-services/
 * trade.mjs): the price protection and the spread limit. Either blank refuses with "protection not set".
 */
const PRICE_PROTECTION = { env: 'LOCAL_STACK_TRADE_SLIPPAGE_CAP', code: 'trade.slippage_cap_unset' };
const SPREAD_LIMIT = { env: 'LOCAL_STACK_TRADE_SPREAD_LIMIT', code: 'trade.spread_limit_unset' };

/** The trade lane restarted with one owner value blank (or put back), the venue door kept on. */
function ownerValue(setting, on) {
  const before = process.env.LOCAL_STACK_USER_VENUE;
  process.env.LOCAL_STACK_USER_VENUE = 'on';
  try {
    restartWith('trade', setting.env, on);
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_USER_VENUE;
    else process.env.LOCAL_STACK_USER_VENUE = before;
  }
}

/** With one owner value blank: the market ticket on `side` is off with the true reason, and nothing is sent. */
async function marketOffWithoutProtection(earlier, side, setting = PRICE_PROTECTION) {
  try {
    ownerValue(setting, false);
    // A fresh page after the restart, as the person would open it.
    const page = await earlier.context().newPage();
    const { wallet, owner, account } = await desk(page);
    const sent = writes(page);
    const asked = wallet.requests.length;
    const form = side === 'buy' ? buyForm(page) : sellForm(page);
    await orderTab(page, 'Market').click();
    await form.getByRole('textbox', { name: 'Amount' }).fill('0.001');
    const note = form.locator(`[data-code="${setting.code}"]`);
    await expect(note).toContainText('protection not set', { timeout: 30_000 });
    const button = form.getByRole('button', { name: side === 'buy' ? 'Buy BTC' : 'Sell BTC' });
    await expect(button).toBeDisabled();
    await button.click({ force: true });
    await expect(reviewSheet(page)).toHaveCount(0);
    // The door refuses it too: a market preview with the protection blank is refused by that code, before any venue call.
    const client = await api(account);
    const { bid, ask } = await venueBook(VENUE_SPOT);
    const refused = await client.post('/api/v1/venue/preview', {
      owner,
      intent: {
        kind: 'place_order',
        symbol: VENUE_SPOT,
        side,
        type: 'market',
        amount: '0.001',
        price: fromUnits(side === 'buy' ? ask * 2n : bid / 2n),
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: `order:${J}:no-protection:${side}:${Date.now()}`,
        builderFee: null,
      },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain(setting.code);
    await page.waitForTimeout(500);
    expect(sent).toEqual([]);
    expect(wallet.requests.length).toBe(asked);
  } finally {
    ownerValue(setting, true);
  }
}

test(`${J} #1 types a TEST spend for a market buy: the amount is sized inside the protection price so the venue's lock stays within the spend; the spend is dropped off market; types the venue doesn't offer are disabled and sign nothing`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const account = await signUp(page, 'vs3');
  await verify(page, account);
  run.reset({ account, walletKey: testWalletKey() });
  const { wallet, owner } = await desk(page);
  // The Starts line: TEST USDC (and a little TEST BTC, for the sells of #3 and #8) in the person's own venue account.
  expect(await testDeposit(owner, 'USDC', '2000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  expect(await testDeposit(owner, 'BTC', '0.01', `84532:0x${randomBytes(32).toString('hex')}:1`)).toBe(true);
  await expect(page.getByTestId('venue-account').locator('[data-asset="USDC"] [data-cell="free"]')).toContainText('2,000', {
    timeout: 20_000,
  });

  const m = await market();
  const lot = toUnits(m.lotSize);
  const seen = previews(page);
  await orderTab(page, 'Market').click();
  const form = buyForm(page);
  await form.getByTestId('venue-unit').getByRole('button', { name: 'USDC', exact: true }).click();
  const spend = form.getByRole('textbox', { name: 'Spend' });
  await expect(spend).toBeEditable();
  await expect(form.getByRole('textbox', { name: 'Amount' })).not.toBeEditable();
  await spend.fill('100');
  await expect
    .poll(() => seen.filter((p) => p.intent.type === 'market' && p.status === 200).length, { timeout: 20_000 })
    .toBeGreaterThan(0);
  const { intent, body } = seen.filter((p) => p.intent.type === 'market' && p.status === 200).at(-1);
  expect(intent).toMatchObject({ kind: 'place_order', symbol: VENUE_SPOT, side: 'buy', type: 'market', timeInForce: 'IOC' });
  // Sized at the worst price the protection allows: the most whole lots whose cost at that price is within the spend.
  const worst = toUnits(intent.price);
  expect(worst <= (await protectionBound('buy')), `worst ${intent.price} inside the protection`).toBe(true);
  const amount = toUnits(intent.amount);
  expect(amount % lot).toBe(0n);
  expect(mul(amount, worst) <= toUnits('100')).toBe(true);
  expect(mul(amount + lot, worst) > toUnits('100'), 'one more lot would pass the spend').toBe(true);
  await expect(form.getByRole('textbox', { name: 'Amount' })).toHaveValue(new RegExp(`^${fromUnits(amount).replace('.', '\\.')}0*$`));
  // The venue's own lock for this order stays within the spend.
  expect(body.value.lock.asset).toBe('USDC');
  expect(toUnits(body.value.lock.amount) <= toUnits('100'), `the venue locks ${body.value.lock.amount}`).toBe(true);
  // The same order asked of the TEST venue itself, not through our door: the same lock.
  const direct = await testVenue('/preview', { account: await venueAccount(owner), intent });
  expect(direct.status, JSON.stringify(direct.body).slice(0, 300)).toBe(200);
  expect(direct.body.value.lock).toEqual(body.value.lock);

  // Off market, the typed spend is dropped: the limit's Total is empty, and back on market the spend is empty too.
  await orderTab(page, 'Limit').click();
  await expect(form.getByRole('textbox', { name: 'Total' })).toHaveValue('');
  await orderTab(page, 'Market').click();
  await expect(form.getByRole('textbox', { name: 'Spend' })).toHaveValue('');

  await notOfferedSignsNothing(page, wallet);
  expect(await openOrders(owner)).toEqual([]);
});

test(`${J} #2 reviews the market buy: the fee and the price protection show before confirming; the fill stays within the spend and nothing stays locked; a blank protection refuses with "protection not set"`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { wallet, owner, account } = await desk(page);
  const ledgerBefore = await (await api(account)).balances();
  const before = { usdc: await venueBalance(owner, 'USDC'), btc: await venueBalance(owner, 'BTC') };
  const since = new Date(Date.now() - 1_000);
  const bound = await protectionBound('buy');
  await orderTab(page, 'Market').click();
  const form = buyForm(page);
  await form.getByTestId('venue-unit').getByRole('button', { name: 'USDC', exact: true }).click();
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await form.getByRole('textbox', { name: 'Spend' }).fill('100');
  const preview = await (await answer).json();
  await form.getByRole('button', { name: 'Buy BTC' }).click();
  const review = reviewSheet(page);
  await expect(review).toBeVisible();
  // Before confirming: the price protection in words, inside the owner's bound, and the venue's fee.
  await expect(review).toContainText('Price protection');
  const protectionText = await line(review, 'protection').innerText();
  const shown = /won.t pay more than ([\d,.]+) USDC per BTC \(50 bps above the best ask\)/.exec(protectionText);
  expect(shown, protectionText).not.toBeNull();
  const worst = toUnits(shown[1].replace(/,/g, ''));
  expect(worst <= bound, `${fromUnits(worst)} within ${fromUnits(bound)}`).toBe(true);
  expect(shownUnits(await line(review, 'worst').innerText())).toBe(worst);
  expect(preview.value.venueFee.known).toBe(true);
  expect(shownUnits(await line(review, 'venue-fee').innerText())).toBe(toUnits(preview.value.venueFee.value.amount));
  await confirmAndSign(page, wallet, 'buy');
  const filled = async () => (await fillsSince(owner, since)).reduce((s, f) => s + toUnits(f.amount), 0n);
  await expect.poll(filled, { timeout: 20_000 }).toBeGreaterThan(0n);
  const fills = await fillsSince(owner, since);
  for (const f of fills) expect(toUnits(f.price) <= worst, `${f.price} inside ${fromUnits(worst)}`).toBe(true);
  const cost = fills.reduce((s, f) => s + mul(toUnits(f.price), toUnits(f.amount)), 0n);
  const fee = (asset) => fills.filter((f) => f.feeAsset === asset).reduce((s, f) => s + toUnits(f.venueFee), 0n);
  const after = { usdc: await venueBalance(owner, 'USDC'), btc: await venueBalance(owner, 'BTC') };
  // What left the venue account is the fills' cost and their fee, within the spend; the unused lock came back, once.
  const spent = toUnits(before.usdc.total) - toUnits(after.usdc.total);
  expect(spent).toBe(cost + fee('USDC'));
  expect(spent <= toUnits('100')).toBe(true);
  expect(toUnits(after.usdc.locked)).toBe(0n);
  expect(toUnits(after.usdc.free)).toBe(toUnits(before.usdc.free) - spent);
  expect(toUnits(after.btc.total) - toUnits(before.btc.total)).toBe(fills.reduce((s, f) => s + toUnits(f.amount), 0n) - fee('BTC'));
  // The fee is only on what filled, and our builder fee is none on a spot buy.
  for (const f of fills) expect(toUnits(f.builderFee)).toBe(0n);
  expect(await openOrders(owner)).toEqual([]);
  // The ledger posts nothing.
  expect(await (await api(account)).balances()).toEqual(ledgerBefore);

  // With the price protection blank, and then the spread limit blank, the market buy is refused with "protection not set"
  // and nothing is sent.
  test.setTimeout(900_000);
  await marketOffWithoutProtection(page, 'buy', PRICE_PROTECTION);
  await marketOffWithoutProtection(page, 'buy', SPREAD_LIMIT);
});

test(`${J} #3 asks for a market sell: offered where the protection is published, it fills no lower than it; with no protection the control is off with a true reason`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { wallet, owner } = await desk(page);
  const amount = '0.0005';
  const before = { usdc: await venueBalance(owner, 'USDC'), btc: await venueBalance(owner, 'BTC') };
  expect(toUnits(before.btc.free) >= toUnits(amount)).toBe(true);
  const since = new Date(Date.now() - 1_000);
  const bound = await protectionBound('sell');
  await orderTab(page, 'Market').click();
  const form = sellForm(page);
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await form.getByRole('textbox', { name: 'Amount' }).fill(amount);
  expect((await answer).status()).toBe(200);
  await expect(form.getByRole('button', { name: 'Sell BTC' })).toBeEnabled();
  await form.getByRole('button', { name: 'Sell BTC' }).click();
  const review = reviewSheet(page);
  const text = await line(review, 'protection').innerText();
  const shown = /won.t sell for less than ([\d,.]+) USDC per BTC \(50 bps below the best bid\)/.exec(text);
  expect(shown, text).not.toBeNull();
  const floor = toUnits(shown[1].replace(/,/g, ''));
  expect(floor >= bound, `${fromUnits(floor)} no lower than ${fromUnits(bound)}`).toBe(true);
  await confirmAndSign(page, wallet, 'sell');
  await expect
    .poll(async () => (await fillsSince(owner, since)).reduce((s, f) => s + toUnits(f.amount), 0n), { timeout: 20_000 })
    .toBe(toUnits(amount));
  const fills = await fillsSince(owner, since);
  for (const f of fills) {
    expect(f.side).toBe('sell');
    expect(toUnits(f.price) >= floor, `${f.price} no lower than ${fromUnits(floor)}`).toBe(true);
  }
  const after = { usdc: await venueBalance(owner, 'USDC'), btc: await venueBalance(owner, 'BTC') };
  const fee = (asset) => fills.filter((f) => f.feeAsset === asset).reduce((s, f) => s + toUnits(f.venueFee), 0n);
  expect(toUnits(before.btc.total) - toUnits(after.btc.total)).toBe(toUnits(amount) + fee('BTC'));
  expect(toUnits(after.usdc.total) - toUnits(before.usdc.total)).toBe(
    fills.reduce((s, f) => s + mul(toUnits(f.price), toUnits(f.amount)), 0n) -
      fee('USDC') -
      fills.reduce((s, f) => s + toUnits(f.builderFee), 0n),
  );
  expect(toUnits(after.btc.locked)).toBe(0n);

  // Where no protection is published, the market sell is off with that reason.
  test.setTimeout(600_000);
  await marketOffWithoutProtection(page, 'sell', PRICE_PROTECTION);
});

test(`${J} #4 sends an immediate-or-cancel buy with nothing to match: it ends without resting, says nothing traded, and the venue's lock is released; types the venue doesn't offer sign nothing`, async ({
  page,
}) => {
  const { wallet, owner } = await desk(page);
  const before = await venueBalance(owner, 'USDC');
  const since = new Date(Date.now() - 1_000);
  await pickTif(page, 'Immediate or cancel');
  const review = await reviewLimit(page, 'buy', await awayBid(), '0.001');
  await expect(line(review, 'tif')).toHaveText('Immediate or cancel');
  const prepares = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/venue/prepare') prepares.push(r.postDataJSON().intent);
  });
  await confirmAndSign(page, wallet, 'buy');
  expect(prepares.at(-1)).toMatchObject({ kind: 'place_order', type: 'limit', timeInForce: 'IOC', side: 'buy' });
  const outcome = buyForm(page).getByTestId('venue-ticket-outcome');
  await expect(outcome).toHaveAttribute('data-outcome', 'nothing-traded', { timeout: 20_000 });
  await expect(outcome).toContainText('Nothing traded');
  expect(await openOrders(owner)).toEqual([]);
  expect(await fillsSince(owner, since)).toEqual([]);
  const after = await venueBalance(owner, 'USDC');
  expect(toUnits(after.locked)).toBe(0n);
  expect(after.total).toBe(before.total);
  expect(after.free).toBe(before.free);
  await notOfferedSignsNothing(page, wallet);
});

test(`${J} #5 picks fill-or-kill for a buy bigger than the book: the venue can fill part of an order, so fill-or-kill is listed disabled with "not offered by this venue" and nothing is signed or sent (the owner's choice, project-state #2260); our own engine's fill-or-kill still fills nothing`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  // On our engine, as main proved it: a fill-or-kill bigger than the book fills nothing and the resting sells stay.
  {
    const { page: enginePage, who, context } = await engineDesk(browser);
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
    await openDesk(enginePage, who);
    // The TEST maker's quotes held where they rest (local-test-market.mjs hold), so the resting sells can be compared level
    // for level after the order; released however the step ends.
    tool('local-test-market.mjs', 'hold', 'BTC/USDT');
    let asksBefore;
    let asksAfter;
    let sent;
    try {
      asksBefore = (await bestPrices()).body.asks;
      sent = await engineLimitBuy(enginePage, { tif: 'Fill or kill', price: ask, amount });
      await expect(buyForm(enginePage)).toContainText('Fill-or-kill order not placed');
      asksAfter = (await bestPrices()).body.asks;
    } finally {
      tool('local-test-market.mjs', 'release', 'BTC/USDT');
    }
    expect(asksAfter, 'the resting sells stay, level for level').toEqual(asksBefore);
    expect(sent).toMatchObject({ type: 'limit', timeInForce: 'FOK', postOnly: false });
    await expect(buyForm(enginePage)).toContainText('Fill-or-kill order not placed');
    await expect(buyForm(enginePage)).toContainText('nothing was traded');
    const after = await (await api(who)).balances();
    expect(after.USDT.total).toBe(before.USDT.total);
    expect(after.BTC?.total).toBe(before.BTC?.total);
    expect(held(after, 'USDT')).toBe(0n);
    expect((await bestPrices()).body.asks.length).toBeGreaterThan(0);
    await context.close();
  }

  // On the venue: it offers no fill-or-kill, so it is listed disabled, nothing is signed, nothing fills and the venue's
  // resting sells are untouched, level for level.
  const { wallet, owner } = await desk(page);
  const before = { usdc: await venueBalance(owner, 'USDC'), btc: await venueBalance(owner, 'BTC') };
  const book = async () => (await testVenue('/book', { symbol: VENUE_SPOT, depth: 50 })).body.value.asks;
  const asksBefore = await book();
  expect(asksBefore.length, 'TEST sells rest on the venue').toBeGreaterThan(0);
  const { missingTifs } = await notOfferedSignsNothing(page, wallet);
  expect(missingTifs, 'the TEST venue offers no fill-or-kill').toContain('FOK');
  expect(await openOrders(owner)).toEqual([]);
  expect(await book()).toEqual(asksBefore);
  expect(await venueBalance(owner, 'USDC')).toMatchObject({ total: before.usdc.total, locked: before.usdc.locked });
  expect(await venueBalance(owner, 'BTC')).toMatchObject({ total: before.btc.total, locked: before.btc.locked });
});

test(`${J} #6 sends a post-only buy that would cross, then one that rests: the first is refused in words and never placed, the second rests; types the venue doesn't offer sign nothing`, async ({
  page,
}) => {
  const { wallet, owner } = await desk(page);
  const before = await venueBalance(owner, 'USDC');
  const since = new Date(Date.now() - 1_000);
  const { bid, ask } = await venueBook(VENUE_SPOT);
  await pickTif(page, 'Post only');
  // Crossing: at the best ask, it would take. The venue refuses it; nothing moves and nothing is placed.
  const crossing = await reviewLimit(page, 'buy', fromUnits(ask), '0.001');
  await expect(line(crossing, 'tif')).toHaveText('Post only');
  const id = await confirmAndSign(page, wallet, 'buy');
  const refused = buyForm(page).getByTestId('venue-ticket-outcome');
  await expect(refused).toHaveAttribute('data-outcome', 'post-only-refused', { timeout: 20_000 });
  await expect(refused).toContainText('Not placed: a post-only order that would trade at once is refused');
  expect(await openOrders(owner)).toEqual([]);
  expect(await fillsSince(owner, since)).toEqual([]);
  if (id) expect(await orderOf(owner, id)).toBeNull();
  expect(await venueBalance(owner, 'USDC')).toMatchObject({ total: before.total, free: before.free, locked: '0' });
  // Resting: one tick under the best bid, it meets nothing and rests as post-only, its lock the venue's.
  const tick = toUnits((await market()).tickSize);
  const price = fromUnits(bid - tick);
  await reviewLimit(page, 'buy', price, '0.001');
  await confirmAndSign(page, wallet, 'buy');
  await expect.poll(async () => (await openOrders(owner)).length, { timeout: 20_000 }).toBe(1);
  const [order] = await openOrders(owner);
  expect(order).toMatchObject({ side: 'buy', type: 'limit', timeInForce: 'ALO', status: 'open' });
  expect(toUnits(order.price)).toBe(bid - tick);
  expect(toUnits(order.locked)).toBe(mul(bid - tick, toUnits('0.001')));
  expect(toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(toUnits(order.locked));
  await page.locator('[role=tab]', { hasText: /^Open orders$/ }).click();
  const row = page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${order.venueClientOrderId}"]`);
  await expect(row.locator('[data-cell="tif"]')).toHaveText('Post only');
  await expect(row.locator('[data-cell="status"]')).toHaveText('Open');
  await notOfferedSignsNothing(page, wallet);
  // Cancelled again so the next steps start with nothing resting.
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await continueInWallet(page);
  await expect.poll(async () => (await openOrders(owner)).length, { timeout: 20_000 }).toBe(0);
  expect(toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(0n);
});

test(`${J} #7 picks good-till-date: the review shows the chosen expiry, a past time sends nothing, and at the expiry the order shows expired and its hold comes back; on the venue, which offers no good-till-date, it is listed disabled with "not offered by this venue" and nothing is signed`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  // On our engine, as main proved it.
  {
    const { page: enginePage, who, context } = await engineDesk(browser);
    const sent = placements(enginePage);
    await engineTab(enginePage, 'Limit').click();
    await enginePickTif(enginePage, 'Good till date');
    const price = await engineAwayBid(90);
    await buyForm(enginePage).getByRole('textbox', { name: 'Price' }).fill(price);
    await buyForm(enginePage).getByRole('textbox', { name: 'Amount' }).fill('0.001');
    const expires = enginePage.getByLabel('Expires');
    await expires.fill(localField(Date.now() - 3600_000));
    await expect(enginePage.getByText('Pick a time in the future.')).toBeVisible();
    await expect(buyForm(enginePage).getByRole('button', { name: 'Buy BTC' })).toBeDisabled();

    // The next whole minute at least 60 seconds away: the field is to the minute.
    const at = Math.ceil((Date.now() + 60_000) / 60_000) * 60_000;
    await previewed(enginePage, () => expires.fill(localField(at)));
    await buyForm(enginePage).getByRole('button', { name: 'Buy BTC' }).click();
    const review = reviewSheet(enginePage);
    await expect(review).toContainText('Good till date');
    // The review's Expires row is the time that was picked, as this browser writes it.
    const picked = await enginePage.evaluate((ms) => new Date(ms).toLocaleString(), at);
    await expect(review.locator('div', { has: enginePage.locator('dt', { hasText: /^Expires$/ }) }).locator('dd')).toHaveText(picked);
    await confirm(enginePage, 'buy');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ timeInForce: 'GTD', expireAt: new Date(at).toISOString() });
    const orders = await engineOpenOrders(who);
    expect(orders).toHaveLength(1);
    expect(held(await (await api(who)).balances(), 'USDT')).toBe((toUnits(price) * toUnits('0.001')) / toUnits('1'));

    // At the expiry the order leaves the book on its own and the hold is released, once.
    await expect.poll(async () => (await engineOpenOrders(who)).length, { timeout: 150_000, intervals: [2000] }).toBe(0);
    expect(Date.now()).toBeGreaterThanOrEqual(at);
    await expect.poll(async () => held(await (await api(who)).balances(), 'USDT'), { timeout: 20_000 }).toBe(0n);
    const { status, body } = await (await api(who)).get(`/api/v1/orders/${orders[0].id}?symbol=BTC%2FUSDT`);
    expect(status).toBe(200);
    expect(body.status).toBe('expired');
    await enginePage.reload();
    await engineTab(enginePage, 'Order history').click();
    await expect(enginePage.getByTestId('dk-bottom-body').locator('table tbody tr').first()).toContainText(/Expired/i);
    await context.close();
  }

  // On the venue: it offers no good-till-date, so it is listed disabled, no expiry is asked and nothing is signed.
  const { wallet, owner } = await desk(page);
  const before = await venueBalance(owner, 'USDC');
  const { missingTifs } = await notOfferedSignsNothing(page, wallet);
  expect(missingTifs, 'the TEST venue offers no good-till-date').toContain('GTD');
  await expect(tifTrigger(page)).not.toHaveText(/Good till date/);
  await expect(page.getByRole('textbox', { name: /expir/i })).toHaveCount(0);
  expect(await openOrders(owner)).toEqual([]);
  expect(await venueBalance(owner, 'USDC')).toMatchObject({ total: before.total, locked: before.locked });
});

test(`${J} #8 chooses the self-trade mode and crosses their own resting order: the venue's own rule cancels the resting one; the modes it can't do are listed disabled and sign nothing`, async ({
  page,
}) => {
  const { wallet, owner } = await desk(page);
  const m = await market();
  expect(m.selfTrade).toEqual({ known: true, value: 'cancel_resting' });
  // The picker: the venue's rule chosen, the others listed disabled with "not offered by this venue"; trying one sends nothing.
  await expect(stpTrigger(page)).toHaveText('Cancel my resting order');
  const sent = writes(page);
  const asked = wallet.requests.length;
  await stpTrigger(page).click();
  for (const name of ['Cancel the new order', 'Cancel both']) {
    const option = page.getByRole('option', { name: `${name} · not offered by this venue`, exact: true });
    await expect(option).toHaveAttribute('aria-disabled', 'true');
    await option.click({ force: true });
  }
  await page.keyboard.press('Escape');
  await expect(stpTrigger(page)).toHaveText('Cancel my resting order');
  await page.waitForTimeout(500);
  expect(sent).toEqual([]);
  expect(wallet.requests.length).toBe(asked);

  // Their own sell rests between the venue's best bid and ask, so it meets no one else.
  const { bid, ask } = await venueBook(VENUE_SPOT);
  expect(ask - bid >= 3n * toUnits(m.tickSize), 'the TEST book has room between its best bid and ask').toBe(true);
  const tick = toUnits(m.tickSize);
  const mid = ((bid + ask) / 2n / tick) * tick;
  const since = new Date(Date.now() - 1_000);
  await pickTif(page, 'Good till cancelled');
  await reviewLimit(page, 'sell', fromUnits(mid), '0.001');
  await confirmAndSign(page, wallet, 'sell');
  await expect.poll(async () => (await openOrders(owner)).length, { timeout: 20_000 }).toBe(1);
  const [resting] = await openOrders(owner);
  expect(resting).toMatchObject({ side: 'sell', status: 'open' });
  expect(toUnits((await venueBalance(owner, 'BTC')).locked)).toBe(toUnits('0.001'));
  // Their buy at the same price crosses it: the review names the rule, and the venue cancels the resting sell.
  const review = await reviewLimit(page, 'buy', fromUnits(mid), '0.001');
  await expect(line(review, 'self-trade')).toHaveText('Cancel my resting order');
  await confirmAndSign(page, wallet, 'buy');
  await expect.poll(async () => (await orderOf(owner, resting.venueClientOrderId))?.status, { timeout: 20_000 }).toBe('canceled');
  const gone = await orderOf(owner, resting.venueClientOrderId);
  expect(toUnits(gone.filled)).toBe(0n);
  // The new buy rests; the two never traded with each other.
  const open = await openOrders(owner);
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({ side: 'buy', status: 'open' });
  expect(toUnits(open[0].price)).toBe(mid);
  expect(await fillsSince(owner, since)).toEqual([]);
  expect(toUnits((await venueBalance(owner, 'BTC')).locked)).toBe(0n);
  expect(toUnits((await venueBalance(owner, 'USDC')).locked)).toBe(toUnits(open[0].locked));
  await notOfferedSignsNothing(page, wallet);
  // Cancelled so #9 starts with nothing resting.
  await page.locator('[role=tab]', { hasText: /^Open orders$/ }).click();
  const row = page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${open[0].venueClientOrderId}"]`);
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await continueInWallet(page);
  await expect.poll(async () => (await openOrders(owner)).length, { timeout: 20_000 }).toBe(0);
});

test(`${J} #9 adds a client tag and types the order in value: the tag shows on the order and in history, the unit flag decides the typed field`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { wallet, owner } = await desk(page);
  const m = await market();
  const lot = toUnits(m.lotSize);
  const form = buyForm(page);
  await orderTab(page, 'Limit').click();
  await pickTif(page, 'Good till cancelled');
  // One tick above the venue's best bid (still under its ask): the order rests, and a sell at its price meets it first.
  const { bid, ask } = await venueBook(VENUE_SPOT);
  const tick = toUnits(m.tickSize);
  expect(ask - bid >= 2n * tick, 'the TEST book has room above its best bid').toBe(true);
  const price = fromUnits(bid + tick);
  await form.getByRole('textbox', { name: 'Price' }).fill(price);
  // The unit flag on BTC: Amount is the typed field and Total follows it.
  await expect(form.getByRole('textbox', { name: 'Amount' })).toBeEditable();
  await expect(form.getByRole('textbox', { name: 'Total' })).not.toBeEditable();
  await form.getByRole('textbox', { name: 'Amount' }).fill('0.001');
  expect(toUnits(await form.getByRole('textbox', { name: 'Total' }).inputValue())).toBe(mul(toUnits(price), toUnits('0.001')));
  // On USDC: Total is the typed field and the amount is the whole lots it buys at the price.
  await form.getByTestId('venue-unit').getByRole('button', { name: 'USDC', exact: true }).click();
  await expect(form.getByRole('textbox', { name: 'Total' })).toBeEditable();
  await expect(form.getByRole('textbox', { name: 'Amount' })).not.toBeEditable();
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await form.getByRole('textbox', { name: 'Total' }).fill('50');
  const sized = (await answer).request().postDataJSON().intent;
  const amount = toUnits(sized.amount);
  expect(amount % lot).toBe(0n);
  expect(mul(amount, toUnits(price)) <= toUnits('50')).toBe(true);
  expect(mul(amount + lot, toUnits(price)) > toUnits('50')).toBe(true);
  expect(toUnits(await form.getByRole('textbox', { name: 'Amount' }).inputValue())).toBe(amount);
  // The tag, shown in the review and kept with the order.
  const tag = `js3-${randomBytes(3).toString('hex')}`;
  await form.getByRole('textbox', { name: 'Tag (optional)' }).fill(tag);
  await form.getByRole('button', { name: 'Buy BTC' }).click();
  await expect(line(reviewSheet(page), 'tag')).toHaveText(tag);
  await confirmAndSign(page, wallet, 'buy');
  await expect.poll(async () => (await openOrders(owner)).length, { timeout: 20_000 }).toBe(1);
  const [order] = await openOrders(owner);
  expect(toUnits(order.amount)).toBe(amount);
  expect(toUnits(order.price)).toBe(toUnits(price));
  await page.locator('[role=tab]', { hasText: /^Open orders$/ }).click();
  const row = page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${order.venueClientOrderId}"]`);
  await expect(row.locator('[data-cell="tag"]')).toHaveText(tag);
  // Another TEST trader sells into it: the fill in Trade history carries the tag too.
  const seller = await otherVenueTrader({ BTC: fromUnits(amount) });
  await seller.place({
    symbol: VENUE_SPOT,
    side: 'sell',
    amount: fromUnits(amount),
    price,
    timeInForce: 'IOC',
    key: `order:test-seller:${owner}:${J}:9`,
  });
  await expect.poll(async () => (await orderOf(owner, order.venueClientOrderId))?.status, { timeout: 20_000 }).toBe('filled');
  await page.locator('[role=tab]', { hasText: /^Trade history$/ }).click();
  const fill = page.getByTestId('venue-fills').locator(`tr[data-client-order-id="${order.venueClientOrderId}"]`).first();
  await expect(fill.locator('[data-cell="tag"]')).toHaveText(tag, { timeout: 20_000 });
});
