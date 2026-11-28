// World: book, gates, restart
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { journeyState, toUnits, fromUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  sameDecimal,
  testDeposit,
  testVenue,
  venueForThisFile,
  venueRecord,
  venueRunState,
  venueWrites,
} from './venue.mjs';
import { displayedAmount, openExitOrders } from './venue-exits.mjs';
import { venueStatus } from './venue-reads.mjs';
import { ledgerUntouched, ledgerView } from './venue-door.mjs';
import { connectWhenAsked } from './dex.mjs';

// J-derivatives-34, "I size a trade from what I am willing to lose and tick my checklist before I open it", in the running
// app against the stack's TEST venue simulator. One test per step, titled "J-derivatives-34 #<n>", run in order on one
// TEST person. The size is worked out on the desk from the loss the person types, their stop, the venue's published fee
// rates (the higher of maker and taker on the way in, taker on the way out, since a stop fills at market) and our TEST
// builder fee both ways, rounded down to the venue's size step. The checklist is the person's own, kept on their device
// for their wallet; it holds only an opening order, at Confirm. Nothing here moves through INTAFACED: the ledger posts
// nothing.
//
// Every figure is TEST and read from its source: the mark, fee rates and size step from the TEST venue's own market, our
// builder fee from svc-trade's venue status, the margin and liquidation from the venue's own preview, and the orders,
// position and stop from the TEST venue itself, never the page. The market long enters at a worst price of 3100, so the
// worked-out loss holds even at the worst fill. #2 publishes a TEST smallest order of 100 USDC on ETH-PERP for one
// branch and takes it away again.
const J = 'J-derivatives-34';
const SYMBOL = 'ETH-PERP';
const DESK = `/trade/futures?symbol=${SYMBOL}`;
const START_USDC = '1000';
const RISK = '50';
const STOP = '2900';
const WORST = '3100';
const LEVERAGE = '5';
const TEST_MIN_ORDER = '100';
const LOT = '0.001';
const TP_SIZE = '0.01';
const ITEMS = ['TEST: the trend on the hour agrees', 'TEST: my stop sits past the last swing', 'TEST: no news in the next hour'];
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const S = 10n ** 18n;

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
test.afterAll(async () => {
  await testVenue('/test/market-limits', { symbol: SYMBOL, minOrderNotional: null }).catch(() => undefined);
});

const market = async () => (await testVenue('/markets', {})).body.value.find((m) => m.symbol === SYMBOL);
const positionOf = async (owner) => (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === SYMBOL) ?? null;
const openOrders = async (owner) => (await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === SYMBOL);
const state = () => venueRunState(run, J);
const shown = displayedAmount;
const exitOrders = (page) => openExitOrders(page, SYMBOL);
/** Every submit to the venue door from this page from now on: one per action the venue was sent. */
const submits = (page) => {
  const writes = venueWrites(page);
  return {
    get length() {
      return writes.filter((p) => p === '/api/v1/venue/submit').length;
    },
  };
};
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;

/**
 * The size's terms from their sources: the venue's mark, rates and step on ETH-PERP and our builder fee, in units. The
 * loss per unit at the stop, exactly (×10 000 × 10^18, so no rounding): the distance plus each fee at its price.
 */
async function terms(owner) {
  const m = await market();
  expect(m.makerFeeBps.known && m.takerFeeBps.known, 'the TEST venue publishes its rates on ETH-PERP').toBe(true);
  const status = await venueStatus(state().account);
  expect(status.builder, 'the owner has published our TEST builder fee').not.toBeNull();
  const maker = toUnits(m.makerFeeBps.value);
  const taker = toUnits(m.takerFeeBps.value);
  const builder = toUnits(status.builder.feeBps);
  const venueIn = maker > taker ? maker : taker;
  return { m, owner, lot: toUnits(m.lotSize), venueIn, taker, builder, builderBps: status.builder.feeBps };
}
/** A stop-out's loss for `size` (all in units), times 10 000 × 10^18 × 10^18: exact. */
const lossScaled = (t, size, entry, stop) =>
  size * ((entry - stop) * 10_000n * S + entry * (t.venueIn + t.builder) + stop * (t.taker + t.builder));

/**
 * The person's device: the checklist #4 saved is kept in this browser's storage, and each step opens a fresh browser,
 * so a later step starts with the exact value the app kept in #4, as the same device would.
 */
const CHECKLIST_KEY = (owner) => `if.venue.checklist.${owner}`;
async function sameDevice(page) {
  const { owner, device } = state();
  if (!device) throw new Error(`${J} #4 kept no checklist on the device, so this step has none to meet`);
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [CHECKLIST_KEY(owner), device]);
}

/** The TEST wallet each page already has: a page installs it once, then only reconnects. */
const wallets = new WeakMap();
async function openDesk(page) {
  let wallet = wallets.get(page);
  if (wallet) {
    await page.goto(DESK);
    const address = page.getByTestId('venue-wallet-address');
    await connectWhenAsked(page, address);
    await expect(address).toHaveText(wallet.address.toLowerCase());
  } else {
    const s = state();
    wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
    wallets.set(page, wallet);
  }
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(SYMBOL, { timeout: 20_000 });
  return wallet;
}

/** Every preview asked of the venue door from this page from now on. */
function previews(page) {
  const seen = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/v1/venue/preview')) seen.push(req.url());
  });
  return seen;
}

const ticket = (page) => page.getByTestId('venue-ticket');
const row = (page) => page.getByTestId('venue-positions').locator(`tr[data-symbol="${SYMBOL}"]`);

/** The ticket on a market long with "Size from my risk" on: the loss, the stop and the worst price typed. */
async function sizeFromRisk(page, { risk = RISK, stop = STOP } = {}) {
  const t = ticket(page);
  await t.getByRole('button', { name: 'Long', exact: true }).click();
  await t.getByRole('button', { name: 'Market', exact: true }).click();
  const on = t.getByRole('switch', { name: 'Size from my risk', exact: true });
  if ((await on.getAttribute('aria-checked')) !== 'true') await on.click();
  await expect(on).toHaveAttribute('aria-checked', 'true');
  await t.getByRole('textbox', { name: 'Worst price (slippage limit)', exact: true }).fill(WORST);
  await t.getByRole('textbox', { name: 'Loss at the stop (USDC)', exact: true }).fill(risk);
  await t.getByRole('textbox', { name: 'Stop loss (optional)', exact: true }).fill(stop);
  return t;
}

/** Review pressed on the ticket; the sheet, with our builder fee approved once if the wallet has not yet. */
async function review(page, name) {
  await ticket(page).getByRole('button', { name, exact: true }).click();
  const sheet = page.getByTestId('venue-review');
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  const approval = sheet.locator('[data-line="builder-approval"]');
  if ((await approval.count()) > 0 && !/Signed, up to/.test(await approval.innerText())) {
    await sheet.getByRole('button', { name: 'Approve our builder fee in your wallet', exact: true }).click();
    await continueInWallet(page);
    await expect(approval).toHaveText(/Signed, up to/, { timeout: 15_000 });
  }
  return sheet;
}

/** The ticket filled for a TEST limit long of `size` ETH at `price` (an opening order resting under the book). */
async function reviewLimitLong(page, size, price) {
  const t = ticket(page);
  const risk = t.getByRole('switch', { name: 'Size from my risk', exact: true });
  if ((await risk.getAttribute('aria-checked')) === 'true') await risk.click();
  await t.getByRole('button', { name: 'Long', exact: true }).click();
  await t.getByRole('button', { name: 'Limit', exact: true }).click();
  await t.getByRole('textbox', { name: 'Size (ETH)', exact: true }).fill(size);
  await t.getByRole('textbox', { name: 'Price', exact: true }).fill(price);
  await t.getByRole('textbox', { name: 'Stop loss (optional)', exact: true }).fill('');
  return review(page, 'Review long');
}

test(`${J} #1 turns on "Size from my risk" in the order ticket, types a TEST loss of 50 USDC and a stop price below the mark, and presses Review: the size worked out, rounded down to the venue's size step; the loss at the stop after the venue's fee and our builder fee both ways, no more than 50; margin and liquidation price from the venue's figures`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  // The journey's start: a verified TEST person, a TEST wallet with TEST 1000 USDC in its venue account, no position.
  const account = await signUp(page, 'jd34');
  await verify(page, account);
  const walletKey = testWalletKey();
  run.reset({ account, walletKey, owner: '' });
  const wallet = await openVenueDesk(page, account, DESK, walletKey);
  wallets.set(page, wallet);
  const owner = wallet.address.toLowerCase();
  run.write({ owner, ledger: await ledgerView(account) });
  expect(await testDeposit(owner, 'USDC', START_USDC, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  expect(await positionOf(owner)).toBeNull();
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(SYMBOL, { timeout: 20_000 });
  const margin = page.getByTestId('venue-margin');
  await margin.getByRole('textbox', { name: 'Leverage (times)', exact: true }).fill(LEVERAGE);
  await margin.getByRole('button', { name: 'Sign this leverage setting', exact: true }).click();
  await continueInWallet(page);
  await expect(margin.getByTestId('venue-outcome')).toContainText('The venue accepted it.', { timeout: 15_000 });

  const t = await terms(owner);
  // The stop sits below the venue's mark.
  expect(t.m.mark.known).toBe(true);
  expect(toUnits(STOP) < toUnits(t.m.mark.value)).toBe(true);
  const ticketNow = await sizeFromRisk(page);
  const note = ticketNow.getByTestId('venue-risk-size');
  await expect(note).toHaveAttribute('data-size', /^\d/);
  const size = await note.getAttribute('data-size');
  const loss = await note.getAttribute('data-loss');
  // The size is on the venue's step, and is the largest such size whose stop-out loses no more than 50 after every fee.
  const sizeU = toUnits(size);
  expect(sizeU % t.lot).toBe(0n);
  const budget = toUnits(RISK) * 10_000n * S;
  expect(lossScaled(t, sizeU, toUnits(WORST), toUnits(STOP)) <= budget * S).toBe(true);
  expect(lossScaled(t, sizeU + t.lot, toUnits(WORST), toUnits(STOP)) > budget * S).toBe(true);
  // The loss shown is that loss, rounded up, and no more than 50.
  const exact = lossScaled(t, sizeU, toUnits(WORST), toUnits(STOP));
  expect(toUnits(loss) * 10_000n * S * S >= exact).toBe(true);
  expect(toUnits(loss) * 10_000n * S * S - exact < 10_000n * S * S).toBe(true); // within one unit
  expect(toUnits(loss) <= toUnits(RISK)).toBe(true);
  await expect(ticketNow.getByRole('textbox', { name: 'Size (ETH)', exact: true })).toHaveValue(size);
  await expect(note).toHaveText(
    `Size ${size} ETH, worked out from a loss of ${RISK} USDC at a stop of ${shown(STOP)} USDC and rounded down to the venue’s step of ${t.m.lotSize} ETH. At the stop it loses ${shown(loss)} USDC, after the venue’s fee and our builder fee on the way in and out.`,
  );

  const sheet = await review(page, 'Review long');
  const lossLine = sheet.locator('[data-line="risk-loss"]');
  await expect(lossLine).toHaveAttribute('data-loss', loss);
  await expect(lossLine).toHaveText(`${shown(loss)} USDC at ${shown(STOP)} USDC, no more than your ${RISK} USDC`);
  // Margin and liquidation are the venue's own preview of this order, digit for digit.
  const clientId = (await sheet.locator('[data-line="client-id"]').innerText()).trim();
  const p = (
    await venueRecord(owner, '/preview', {
      intent: {
        kind: 'place_order',
        symbol: SYMBOL,
        side: 'buy',
        type: 'market',
        amount: size,
        price: WORST,
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: clientId,
        builderFee: { builder: (await venueStatus(account)).builder.address, feeBps: t.builderBps },
      },
    })
  ).value;
  const text = async (name) => (await sheet.locator(`[data-line="${name}"]`).innerText()).replace(/,/g, '').trim();
  expect(p.perpetual.initialMargin.known).toBe(true);
  expect(sameDecimal(await text('initial-margin'), p.perpetual.initialMargin.value)).toBe(true);
  expect(await text('liquidation')).toBe(p.perpetual.liquidationPrice.known ? p.perpetual.liquidationPrice.value : 'not known');
  await stepPicture();
  // Review sends nothing: no order and no position on the venue.
  expect(await openOrders(owner)).toEqual([]);
  expect(await positionOf(owner)).toBeNull();
});

test(`${J} #2 types a stop price above the mark for a long, then one so close that the size falls below the venue's minimum order: each refused naming its rule (the stop's side; the venue's minimum and the size it would need); nothing is sent`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const { owner } = state();
  const wallet = await openDesk(page);
  const t = await terms(owner);
  const signedBefore = signatures(wallet);
  const sent = venueWrites(page);
  const asked = previews(page);

  // A long's stop above the mark: refused naming the stop's side and the venue's mark.
  const above = fromUnits(toUnits(t.m.mark.value) + toUnits('10'));
  const tk = await sizeFromRisk(page, { stop: above });
  await tk.getByRole('button', { name: 'Review long', exact: true }).click();
  const refusal = tk.getByRole('alert');
  await expect(refusal).toHaveAttribute('data-code', 'trade.risk_size.stop_wrong_side');
  const mark = (await market()).mark.value;
  await expect(refusal).toHaveText(`Refused: a long’s stop must sit below the mark, ${shown(mark)} USDC. Nothing was sent.`);
  await expect(page.getByTestId('venue-review')).toHaveCount(0);

  // The venue's smallest order: a TEST 100 USDC published on ETH-PERP for this branch. A closer stop asks a larger size,
  // so the size falls under it at a stop far from the entry: 1500 here.
  const far = '1500';
  try {
    expect((await testVenue('/test/market-limits', { symbol: SYMBOL, minOrderNotional: TEST_MIN_ORDER })).status).toBe(200);
    await openDesk(page);
    await expect.poll(async () => (await market()).minOrderNotional).toBe(TEST_MIN_ORDER);
    const tk2 = await sizeFromRisk(page, { stop: far });
    await expect(tk2.getByTestId('venue-risk-size')).toHaveAttribute('data-reason', 'below_minimum', { timeout: 20_000 });
    await tk2.getByRole('button', { name: 'Review long', exact: true }).click();
    const below = tk2.getByRole('alert');
    await expect(below).toHaveAttribute('data-code', 'trade.risk_size.below_minimum');
    // The size worked out, and the size the venue's minimum needs at this entry, from their sources.
    const entry = toUnits(WORST);
    const budget = toUnits(RISK) * 10_000n * S * S;
    let worked = 0n;
    while (lossScaled(t, worked + t.lot, entry, toUnits(far)) <= budget) worked += t.lot;
    const need = (toUnits(TEST_MIN_ORDER) * S + entry - 1n) / entry; // 100 USDC at the entry, in ETH units, rounded up
    const needLots = ((need + t.lot - 1n) / t.lot) * t.lot;
    expect(worked < needLots).toBe(true);
    const words = await below.innerText();
    const m = words.match(/would need at least (\S+) ETH, which loses (\S+) USDC at this stop/);
    expect(m, words).not.toBeNull();
    expect(sameDecimal(m[1], fromUnits(needLots))).toBe(true);
    const minLoss = toUnits(m[2].replace(/,/g, '')) * 10_000n * S * S;
    const exact = lossScaled(t, needLots, entry, toUnits(far));
    expect(minLoss >= exact && minLoss - exact < 10_000n * S * S).toBe(true);
    await expect(below).toHaveText(
      `Refused: ${fromUnits(worked)} ETH is under the venue’s minimum order of ${TEST_MIN_ORDER} USDC. It would need at least ${fromUnits(needLots)} ETH, which loses ${m[2]} USDC at this stop. Nothing was sent.`,
    );
    await expect(page.getByTestId('venue-review')).toHaveCount(0);
    await stepPicture();
  } finally {
    await testVenue('/test/market-limits', { symbol: SYMBOL, minOrderNotional: null });
  }
  // Nothing was sent: no preview, no prepare or submit, no signature, and nothing on the venue.
  expect(asked).toHaveLength(0);
  expect(sent).toHaveLength(0);
  expect(signatures(wallet)).toBe(signedBefore);
  expect(await openOrders(owner)).toEqual([]);
  expect(await positionOf(owner)).toBeNull();
});

test(`${J} #3 confirms and signs: one opening order on the venue at the worked-out size with its stop resting on the venue, reduce-only; the position and stop as the venue reports them; the stop kept as the trade's planned stop`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const { owner } = state();
  const wallet = await openDesk(page);
  const tk = await sizeFromRisk(page);
  const size = await tk.getByTestId('venue-risk-size').getAttribute('data-size');
  expect(size).toMatch(/^\d/);
  const sheet = await review(page, 'Review long');
  const signedBefore = signatures(wallet);
  const sent = submits(page);
  await sheet.getByRole('button', { name: 'Open long', exact: true }).click();
  await continueInWallet(page);
  await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Filled on the venue.', { timeout: 15_000 });
  // The stop, attached to the entry on the size it filled, signed in the wallet.
  await continueInWallet(page);
  await expect(sheet.getByTestId('venue-attached')).toHaveText(`Stop loss set on the ${size} this order filled`, { timeout: 15_000 });
  const planned = sheet.getByTestId('venue-planned-stop');
  await expect(planned).toHaveText(`Kept as this trade’s planned stop: ${shown(STOP)} USDC.`);
  await stepPicture();
  // One opening order and one stop: two signatures, two submits.
  expect(signatures(wallet) - signedBefore).toBe(2);
  expect(sent).toHaveLength(2);

  // On the venue: the position at the worked-out size; the stop resting, reduce-only, attached to that one entry.
  const position = await positionOf(owner);
  expect(position).toMatchObject({ side: 'long' });
  expect(sameDecimal(position.size, size)).toBe(true);
  const stops = (await openOrders(owner)).filter((o) => o.trigger?.role === 'stop_loss');
  expect(stops).toHaveLength(1);
  const [stop] = stops;
  expect(stop).toMatchObject({ side: 'sell', reduceOnly: true });
  expect(sameDecimal(stop.trigger.price, STOP)).toBe(true);
  expect(sameDecimal(stop.amount, size)).toBe(true);
  expect(stop.parentClientOrderId).toBeTruthy();
  const entry = (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId: stop.parentClientOrderId })).value;
  expect(entry).toMatchObject({ status: 'filled', reduceOnly: false, side: 'buy' });
  expect(sameDecimal(entry.filled, size)).toBe(true);
  expect(sameDecimal(entry.amount, size)).toBe(true);
  // The desk shows the position and its stop as the venue reports them.
  await sheet.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(row(page)).toBeVisible({ timeout: 20_000 });
  await expect(row(page)).toContainText(size);
  const dialog = await exitOrders(page);
  await expect(dialog.locator('li[data-kind="stop_loss"][data-status="armed"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(dialog.locator('li[data-kind="stop_loss"][data-status="armed"]')).toContainText(`triggers at ${STOP}`);
});

test(`${J} #4 opens the ticket's checklist settings, writes three items and turns the checklist on: saved; the ticket shows the three items, unticked, above Confirm on an opening order`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const { owner } = state();
  await openDesk(page);
  const tk = ticket(page);
  await tk.getByRole('button', { name: 'Checklist settings', exact: true }).click();
  const settings = tk.getByTestId('checklist-settings');
  for (const [i, item] of ITEMS.entries()) await settings.getByRole('textbox', { name: `Checklist item ${i + 1}`, exact: true }).fill(item);
  await settings.getByRole('switch', { name: 'Checklist on', exact: true }).click();
  await settings.getByRole('button', { name: 'Save checklist', exact: true }).click();
  await expect(settings.getByTestId('checklist-saved')).toHaveText(
    'Saved. Opening orders wait at Confirm until every item is ticked. Kept on this device.',
  );
  // Saved: the app keeps it on this device, and it is there again after a reload.
  const device = await page.evaluate((key) => localStorage.getItem(key), CHECKLIST_KEY(owner));
  expect(JSON.parse(device)).toEqual({ on: true, items: ITEMS });
  run.write({ device });
  await openDesk(page);
  const sheet = await reviewLimitLong(page, '0.1', '2000');
  const list = sheet.getByTestId('pre-trade-checklist');
  await expect(list).toBeVisible();
  const boxes = list.getByRole('checkbox');
  await expect(boxes).toHaveCount(3);
  for (const [i, item] of ITEMS.entries()) {
    const box = list.getByRole('checkbox', { name: item, exact: true });
    await expect(box).not.toBeChecked();
    await expect(boxes.nth(i)).toHaveAccessibleName(item);
  }
  // Above Confirm.
  const confirm = sheet.getByRole('button', { name: 'Open long', exact: true });
  const [listBox, confirmBox] = [await list.boundingBox(), await confirm.boundingBox()];
  expect(listBox.y + listBox.height <= confirmBox.y).toBe(true);
  await stepPicture();
  await sheet.getByRole('button', { name: 'Back', exact: true }).click();
  expect((await openOrders(owner)).filter((o) => !o.reduceOnly)).toEqual([]);
});

test(`${J} #5 presses Confirm on an opening order with two of the three ticked, then ticks the third: Confirm waits and names the unticked item; nothing is sent; with all three ticked the order goes to the venue; the next opening order starts unticked`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const { owner } = state();
  await sameDevice(page);
  const wallet = await openDesk(page);
  const sent = submits(page);
  const signedBefore = signatures(wallet);
  const sheet = await reviewLimitLong(page, '0.1', '2000');
  const list = sheet.getByTestId('pre-trade-checklist');
  await list.getByRole('checkbox', { name: ITEMS[0], exact: true }).check();
  await list.getByRole('checkbox', { name: ITEMS[1], exact: true }).check();
  const confirm = sheet.getByRole('button', { name: 'Open long', exact: true });
  await confirm.click();
  await expect(list.getByTestId('checklist-wait')).toHaveText(`Confirm waits: tick “${ITEMS[2]}” first. Nothing was sent.`);
  await expect(page.getByRole('dialog', { name: 'Check before you sign', exact: true })).toHaveCount(0);
  expect(sent).toHaveLength(0);
  expect(signatures(wallet)).toBe(signedBefore);
  expect((await openOrders(owner)).filter((o) => !o.reduceOnly)).toEqual([]);

  await list.getByRole('checkbox', { name: ITEMS[2], exact: true }).check();
  await expect(list.getByTestId('checklist-wait')).toHaveCount(0);
  await confirm.click();
  await continueInWallet(page);
  await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Open on the venue.', { timeout: 15_000 });
  expect(sent).toHaveLength(1);
  expect(signatures(wallet) - signedBefore).toBe(1);
  const resting = (await openOrders(owner)).filter((o) => !o.reduceOnly && o.side === 'buy');
  expect(resting).toHaveLength(1);
  expect(sameDecimal(resting[0].price, '2000') && sameDecimal(resting[0].amount, '0.1')).toBe(true);
  await sheet.getByRole('button', { name: 'Back', exact: true }).click();

  // The next opening order starts unticked.
  const next = await reviewLimitLong(page, '0.1', '1990');
  const again = next.getByTestId('pre-trade-checklist');
  for (const item of ITEMS) await expect(again.getByRole('checkbox', { name: item, exact: true })).not.toBeChecked();
  await stepPicture();
  await next.getByRole('button', { name: 'Back', exact: true }).click();
  expect(sent).toHaveLength(1);
});

test(`${J} #6 closes part of the position, moves its stop and cancels a resting order: no checklist is shown and nothing waits; each is sent to the venue once`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(480_000);
  const { owner } = state();
  // The checklist is on, on this device: none of these meets it.
  await sameDevice(page);
  const wallet = await openDesk(page);
  const sent = submits(page);
  const before = await positionOf(owner);
  expect(before).not.toBeNull();
  const startedAt = new Date().toISOString();

  // Its stop moved: the old trigger cancelled and the new one placed, each sent once, no checklist on the way.
  const stopAt = async (price) => (await openOrders(owner)).filter((o) => o.reduceOnly && o.trigger && sameDecimal(o.trigger.price, price));
  expect(await stopAt(STOP)).toHaveLength(1);
  const dialog = await exitOrders(page);
  const armed = dialog.locator('li[data-kind="stop_loss"][data-status="armed"]');
  await expect(armed).toHaveCount(1, { timeout: 15_000 });
  let mark = { signed: signatures(wallet), sent: sent.length };
  await armed.getByTestId('protection-move').getByRole('textbox', { name: 'New trigger price', exact: true }).fill('2950');
  await armed.getByTestId('protection-move').getByRole('button', { name: 'Move', exact: true }).click();
  await continueInWallet(page);
  await continueInWallet(page);
  await expect.poll(async () => (await stopAt('2950')).length, { timeout: 20_000 }).toBe(1);
  expect(await stopAt(STOP)).toHaveLength(0);
  await expect(dialog.getByTestId('protection-refusal')).toHaveCount(0);
  await expect(page.getByTestId('pre-trade-checklist')).toHaveCount(0);
  expect(signatures(wallet) - mark.signed).toBe(2);
  expect(sent.length - mark.sent).toBe(2);

  // A resting order cancelled: a TEST take profit resting on the venue as a trigger order, then cancelled; one signed
  // cancel, and the venue no longer holds it.
  await dialog.getByRole('button', { name: 'Take profit', exact: true }).click();
  await dialog.getByRole('button', { name: 'Mark', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Size to close', exact: true }).fill(TP_SIZE);
  await dialog.getByRole('textbox', { name: 'Trigger price', exact: true }).fill('3300');
  await dialog.getByRole('button', { name: 'Arm exit order', exact: true }).click();
  await continueInWallet(page);
  await expect(dialog.getByTestId('protection-outcome')).toHaveText('Armed on the venue.', { timeout: 15_000 });
  const targetAt = async () => (await openOrders(owner)).filter((o) => o.reduceOnly && o.trigger && sameDecimal(o.trigger.price, '3300'));
  await expect.poll(async () => (await targetAt()).length, { timeout: 15_000 }).toBe(1);
  const target = dialog.locator('li[data-kind="take_profit"][data-status="armed"]');
  await expect(target).toHaveCount(1, { timeout: 15_000 });
  mark = { signed: signatures(wallet), sent: sent.length };
  await target.getByRole('button', { name: 'Cancel', exact: true }).click();
  await continueInWallet(page);
  await expect.poll(async () => (await targetAt()).length, { timeout: 20_000 }).toBe(0);
  await expect(page.getByTestId('pre-trade-checklist')).toHaveCount(0);
  expect(signatures(wallet) - mark.signed).toBe(1);
  expect(sent.length - mark.sent).toBe(1);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();

  // Part of the position closed from the ticket: a reduce-only market sell of half, which no checklist meets; one
  // signed close, filled.
  const half = fromUnits((toUnits(before.size) / 2n / toUnits(LOT)) * toUnits(LOT));
  mark = { signed: signatures(wallet), sent: sent.length };
  const tk = ticket(page);
  const risk = tk.getByRole('switch', { name: 'Size from my risk', exact: true });
  if ((await risk.getAttribute('aria-checked')) === 'true') await risk.click();
  await tk.getByRole('button', { name: 'Short', exact: true }).click();
  await tk.getByRole('button', { name: 'Market', exact: true }).click();
  await tk.getByRole('textbox', { name: 'Size (ETH)', exact: true }).fill(half);
  await tk.getByRole('textbox', { name: 'Worst price (slippage limit)', exact: true }).fill('2800');
  await tk.getByRole('textbox', { name: 'Stop loss (optional)', exact: true }).fill('');
  await tk.getByRole('checkbox', { name: 'Reduce-only', exact: true }).check();
  const sheet = await review(page, 'Review short');
  await expect(sheet.getByTestId('pre-trade-checklist')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Open short', exact: true }).click();
  await continueInWallet(page);
  await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Filled on the venue.', { timeout: 15_000 });
  await expect(sheet.getByTestId('checklist-wait')).toHaveCount(0);
  expect(signatures(wallet) - mark.signed).toBe(1);
  expect(sent.length - mark.sent).toBe(1);
  // The venue's own record: the close was reduce-only, and the position is that much smaller.
  const after = await positionOf(owner);
  expect(sameDecimal(after.size, fromUnits(toUnits(before.size) - toUnits(half)))).toBe(true);
  const fills = (await venueRecord(owner, '/fills', { since: startedAt })).value.filter((f) => f.symbol === SYMBOL && f.side === 'sell');
  const closeIds = [...new Set(fills.map((f) => f.venueClientOrderId))];
  expect(closeIds).toHaveLength(1);
  const closed = (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId: closeIds[0] })).value;
  expect(closed).toMatchObject({ reduceOnly: true, side: 'sell', status: 'filled' });
  expect(sameDecimal(closed.filled, half)).toBe(true);
  await sheet.getByRole('button', { name: 'Back', exact: true }).click();
  await stepPicture();
  // Nothing moved through INTAFACED: the ledger posted nothing for the person since the journey started.
  await ledgerUntouched(state());
});
