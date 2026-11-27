// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { fromUnits, journeyState, toUnits } from './stack.mjs';
import { confirm, reviewSheet, signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { continueInWallet, hyperliquidForThisFile, openVenueDesk, sameDecimal, testDeposit, venueBalance, venueRecord } from './venue.mjs';

// J-cex-spot-01 #10 on Hyperliquid's own test network: a first tester's spot order after funding. They rest a TEST limit
// buy on PURR-USDC well below the market, see it Open, cancel it, and cancel it again; each leg is read back from the
// venue's own record (the order, its lock and the USDC balance), so the test network's answer is what the step checks.
//
// The daily run on main (.github/workflows/hl-venue-daily.yml) runs this file live, signing with the funded TEST wallet,
// and writes its recording. Every other run replays that recording strictly. Until the first recording lands, the file
// runs on the TEST venue simulator (hyperliquidForThisFile), which lists no PURR-USDC, so there it trades BTC-USDC and
// is funded by the simulator's TEST deposit. On Hyperliquid the trading session key signs the order and the cancel, so
// no wallet sheet opens for them; on the simulator the wallet signs each. The price is half the venue's own best bid, so
// the order rests and never fills, and its size is the venue's smallest order value plus a tenth, on its lot. The
// simulator's own file, J-cex-spot-01.pw.mjs, proves #1 to #12. Every figure is TEST.
const J = 'J-cex-spot-01';
const run = journeyState(`${J}-hl-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
const venue = hyperliquidForThisFile(test, 'J-cex-spot-01-hl-venue');
/** On Hyperliquid (live or replayed) the trading session key signs every order: the wallet signs only the session. */
const sessionVenue = venue.kind !== 'on';
/** PURR-USDC is the one spot pair Hyperliquid's test network trades every day; the simulator lists BTC-USDC instead. */
const SYMBOL = sessionVenue ? 'PURR-USDC' : 'BTC-USDC';
const BASE = SYMBOL.split('-')[0];
const SCALE = toUnits('1');

/**
 * TEST teardown: any order this file left resting on the pair is cancelled from the desk, so the funded account holds no
 * lock into the next day's run. Declared before the venue's own switch, so it runs while the door is still on.
 */
test.afterAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const s = run.read();
  if (!s.account || !s.orderId || !s.owner) return;
  if (!(await openOrders(s.owner)).some((o) => o.venueClientOrderId === s.orderId)) return;
  const page = await browser.newPage();
  try {
    const { owner } = await desk(page);
    await openOrdersTab(page);
    await listedRow(page, s.orderId).getByRole('button', { name: 'Cancel', exact: true }).click();
    await signed(page);
    await expect.poll(async () => (await openOrders(owner)).length, { timeout: 30_000, message: 'the order cancelled' }).toBe(0);
  } finally {
    await page.close();
  }
});

/**
 * TEST setup, not a journey step: a verified account and the wallet it signs with, the trader's own key on Hyperliquid
 * (live or replayed, never written to the run's state file) and a fresh TEST key on the simulator.
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'h01');
    await verify(page, account);
    run.reset({ account, walletKey: venue.key ? null : testWalletKey() });
  } finally {
    await page.close();
  }
});

/** The spot desk on the pair, signed in as setup's person with the wallet connected. */
async function desk(page) {
  const { account, walletKey } = run.read();
  const key = venue.key ?? walletKey;
  if (!account || !key) throw new Error(`${J} setup made no account and wallet, so this step has no one to act as`);
  const wallet = await openVenueDesk(page, account, `/trade/spot/${SYMBOL}`, key);
  return { wallet, owner: wallet.address.toLowerCase() };
}

/** The trading session a session-key venue needs before any order, from the desk's own panel, signed once by the wallet. */
async function startSession(page) {
  if (!sessionVenue) return;
  const session = page.getByTestId('venue-session');
  const live = session.locator('[data-testid="venue-session-line"][data-session="live"]');
  if (await live.isVisible()) return;
  await session.getByTestId('venue-session-start').click();
  await continueInWallet(page);
  await live.waitFor({ timeout: 60_000 });
}

/** An action signed: on the simulator the wallet's sheet is passed; on Hyperliquid the session key signed it already. */
const signed = sessionVenue ? async () => {} : continueInWallet;

const openOrders = async (owner) => (await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === SYMBOL);
const venueOrder = async (owner, venueClientOrderId) => (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId })).value;
const listedRow = (page, id) => page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${id}"]`);
async function openOrdersTab(page) {
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
}

/**
 * `units` (scaled) put on the venue's price rule: a multiple of the tick and at most 5 significant figures, as
 * Hyperliquid takes a price (and the simulator's ticks already are), rounded down.
 */
function onPriceRule(units, tick) {
  const digits = (units / SCALE).toString().length;
  const sig = units >= SCALE ? (digits >= 5 ? SCALE * 10n ** BigInt(digits - 5) : SCALE / 10n ** BigInt(5 - digits)) : 1n;
  const step = sig > toUnits(tick) ? sig : toUnits(tick);
  return fromUnits((units / step) * step);
}

test(`${J} #10 rests a limit away from the market, cancels it, cancels it again: cancelled on the venue, the lock released, the repeat the same, on Hyperliquid's test network`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(360_000);
  const { owner, wallet } = await desk(page);
  // TEST funding on the simulator only: on the test network the trader's own account already holds TEST USDC.
  if (!sessionVenue && !(await testDeposit(owner, 'USDC', '200', `84532:0x${randomBytes(32).toString('hex')}:0`)))
    throw new Error(`${J}: the TEST venue credited no TEST USDC`);
  const market = (await venueRecord(owner, '/markets')).value.find((m) => m.symbol === SYMBOL);
  expect(market, `${SYMBOL} is on the venue's own market list`).toBeTruthy();
  expect(market.minOrderNotional, `${SYMBOL}'s smallest order value, as the venue publishes it`).toBeTruthy();
  const { bid } = (await venueRecord(owner, '/best-prices', { symbol: SYMBOL })).value;
  expect(bid, `the venue has a bid on ${SYMBOL}`).not.toBeNull();
  const away = onPriceRule(toUnits(bid) / 2n, market.tickSize);
  const value = (toUnits(market.minOrderNotional) * 11n) / 10n;
  const lot = toUnits(market.lotSize);
  // The smallest size on the venue's lot worth at least that value at that price.
  const amount = fromUnits((((value * SCALE) / toUnits(away) + lot - 1n) / lot) * lot);
  expect(await openOrders(owner), `no order of this file's rests on ${SYMBOL} before it starts`).toEqual([]);
  const before = await venueBalance(owner, 'USDC');

  // Rests the limit buy from the desk's own ticket: reviewed on the venue's own preview, confirmed and signed.
  await startSession(page);
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  await page
    .getByTestId('dk-order')
    .getByRole('group', { name: 'Buy or sell', exact: true })
    .getByRole('button', { name: 'Buy', exact: true })
    .click();
  const form = page.locator('form[data-testid="dk-form"][data-side="buy"]');
  await form.getByRole('textbox', { name: 'Price', exact: true }).fill(away);
  const preview = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await form.getByRole('textbox', { name: 'Amount', exact: true }).fill(amount);
  expect((await preview).status()).toBe(200);
  await form.getByRole('button', { name: `Buy ${BASE}`, exact: true }).click();
  await expect(reviewSheet(page)).toBeVisible();
  const placed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/submit' && r.request().method() === 'POST');
  await confirm(page, 'buy');
  await signed(page);
  const submitted = await placed;
  expect(submitted.status(), await submitted.text()).toBe(200);
  expect((await submitted.json()).outcome, 'the venue took the order').toMatchObject({ definite: true, accepted: true });

  // It rests on the venue at that price and size, and its lock is the venue's own.
  await expect.poll(async () => (await openOrders(owner)).length, { timeout: 30_000, message: 'the order rests on the venue' }).toBe(1);
  const [order] = await openOrders(owner);
  run.write({ owner, orderId: order.venueClientOrderId });
  expect(order).toMatchObject({ symbol: SYMBOL, side: 'buy', type: 'limit', status: 'open' });
  expect(sameDecimal(order.price, away)).toBe(true);
  expect(sameDecimal(order.amount, amount)).toBe(true);
  await expect
    .poll(async () => toUnits((await venueBalance(owner, 'USDC')).locked), { timeout: 20_000, message: 'the venue holds the lock' })
    .toBe(toUnits(before.locked) + toUnits(order.locked));
  await openOrdersTab(page);
  const row = listedRow(page, order.venueClientOrderId);
  await expect(row.locator('[data-cell="status"]')).toHaveText('Open', { timeout: 20_000 });

  // Cancels it from Open orders: the venue cancels the order and the lock is released.
  const asked = wallet.requests.length;
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await signed(page);
  const outcome = page.getByTestId('venue-bottom').getByTestId('venue-outcome');
  await expect(outcome).toContainText('Cancelled on the venue; its lock is released.', { timeout: 30_000 });
  await expect.poll(async () => (await venueOrder(owner, order.venueClientOrderId))?.status, { timeout: 30_000 }).toBe('canceled');
  expect(await openOrders(owner)).toEqual([]);
  expect(sameDecimal((await venueBalance(owner, 'USDC')).locked, before.locked)).toBe(true);
  const signs = wallet.requests.length;
  expect(signs, 'the cancel is signed once: by the wallet on the simulator, by the session key on Hyperliquid').toBe(
    asked + (sessionVenue ? 0 : 1),
  );

  // Cancels it again, as the person does: the same action under the same business key, answered with the venue's first
  // outcome; the wallet is not asked and nothing on the venue moves.
  await expect(row.locator('[data-cell="status"]')).toHaveText('Cancelled', { timeout: 20_000 });
  const submits = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/venue/submit') submits.push(r.url());
  });
  await row.getByRole('button', { name: 'Cancel again', exact: true }).click();
  await expect(outcome).toContainText('This is the same action as before', { timeout: 20_000 });
  await expect(outcome).toContainText('Cancelled on the venue; its lock is released.');
  await expect(page.getByRole('dialog', { name: 'Check before you sign', exact: true })).toHaveCount(0);
  expect(submits, 'the repeat sends nothing new to the venue').toEqual([]);
  expect(wallet.requests.length, 'the repeat asks the wallet nothing').toBe(signs);
  expect((await venueOrder(owner, order.venueClientOrderId))?.status).toBe('canceled');
  expect(await openOrders(owner)).toEqual([]);
  expect(sameDecimal((await venueBalance(owner, 'USDC')).locked, before.locked)).toBe(true);
  await stepPicture();
});
