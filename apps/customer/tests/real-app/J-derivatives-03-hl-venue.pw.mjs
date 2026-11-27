// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { fromUnits, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  startVenueSession,
  hyperliquidForThisFile,
  openVenueDesk,
  sameDecimal,
  testDeposit,
  venueRecord,
} from './venue.mjs';

// J-derivatives-03 #1 on Hyperliquid's own test network: what a first tester does after funding. They start a
// trading session, set a leverage, open a small long on ETH-PERP, and set a stop loss and a take profit for the whole
// position, each resting on the venue as its own trigger order. The file's teardown then flattens: each exit order is
// cancelled and the position closed reduce-only, one leg at a time, each leg confirmed on the venue's own record.
//
// The daily run on main (.github/workflows/hl-venue-daily.yml) runs this file live, signing with the funded TEST wallet,
// and writes its recording. Every other run replays that recording strictly. Until the first recording lands, the file
// runs on the TEST venue simulator (hyperliquidForThisFile), where the TEST funding is the simulator's TEST deposit.
// Every price comes from the venue's own best bid and ask, and every size from its own lot and the smallest order
// value. On the venue the trading session key signs orders and exit orders, so no wallet sheet opens for them. On the
// simulator the wallet signs each one, after its "Check before you sign" sheet. The simulator's own file,
// J-derivatives-03.pw.mjs, proves #1 to #9. Every figure is TEST.
const J = 'J-derivatives-03';
const SYMBOL = 'ETH-PERP';
const DESK = `/trade/futures?symbol=${SYMBOL}`;
const LEVERAGE = '5';
/** TEST: the open's value in USDC, above the venue's smallest order value (Hyperliquid: 10 USDC). */
const OPEN_VALUE = '12';
const VENUE_LABEL = 'Rests on the venue as its trigger order';
const run = journeyState(`${J}-hl-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
/**
 * TEST teardown: the account flattened (`flatten`), so the funded account holds nothing into the next day's run.
 * Declared before the venue's own switch, so it runs while the door is still on (Playwright runs a file's afterAll hooks
 * in the order they are declared).
 */
test.afterAll(async ({ browser }) => {
  test.setTimeout(240_000);
  if (!run.read().account) return;
  const page = await browser.newPage();
  try {
    const { owner } = await desk(page);
    await flatten(page, owner);
  } finally {
    await page.close();
  }
});

const venue = hyperliquidForThisFile(test, 'J-derivatives-03-hl-venue');
/** On Hyperliquid (live or replayed) the trading session key signs every order: the wallet signs only the session. */
const sessionVenue = venue.kind !== 'on';
const SCALE = toUnits('1');

/**
 * TEST setup, not a journey step: a verified account and the wallet it signs with, the trader's own key on Hyperliquid
 * (live or replayed, never written to the run's state file) and a fresh TEST key on the simulator.
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'h03');
    await verify(page, account);
    run.reset({ account, walletKey: venue.key ? null : testWalletKey() });
  } finally {
    await page.close();
  }
});

function state() {
  const s = run.read();
  const walletKey = venue.key ?? s.walletKey;
  if (!s.account || !walletKey) throw new Error(`${J} setup made no account and wallet, so this step has no one to act as`);
  return { ...s, walletKey };
}

async function desk(page) {
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(SYMBOL, { timeout: 30_000 });
  return { ...s, wallet, owner: wallet.address.toLowerCase() };
}

/**
 * TEST, the flatten a tester does by hand: every exit order on ETH-PERP cancelled from its dialog and the position closed
 * in full, reduce-only, each leg confirmed on the venue's own record. Every exit order listed, not only this run's: a run
 * cut short leaves its own on the funded account, and the next day's
 * run starts by clearing them. A new page holds no session key, so it starts its own session first.
 */
async function flatten(page, owner) {
  if ((await positionOf(owner)) === null) return;
  if (sessionVenue) await startVenueSession(page);
  const dialog = await exitOrders(page);
  const resting = async () => (await openOrders(owner)).filter((o) => o.trigger).length;
  const listedOrders = listed(dialog).locator('li[data-client-order-id]');
  // The dialog lists every exit order the venue holds once it has read them, so the count waited for is the venue's.
  const onVenue = await resting();
  await expect(listedOrders, `the dialog lists the venue's ${onVenue} exit order(s)`).toHaveCount(onVenue, { timeout: 20_000 });
  while ((await listedOrders.count()) > 0) {
    const before = await resting();
    const id = await listedOrders.first().getAttribute('data-client-order-id');
    await listedOrders.first().getByRole('button', { name: 'Cancel', exact: true }).click();
    await signed(page);
    await expect.poll(resting, { timeout: 20_000, message: `exit order ${id} cancelled on the venue` }).toBe(before - 1);
    await expect(item(dialog, id)).toHaveCount(0, { timeout: 20_000 });
  }
  expect(await resting()).toBe(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const close = row(page).getByTestId('venue-close');
  await close.getByRole('textbox').fill('100');
  await close.getByRole('button', { name: 'Close 100%', exact: true }).click();
  await signed(page);
  await expect.poll(async () => positionOf(owner), { timeout: 30_000, message: 'the position closed' }).toBeNull();
  expect(await openOrders(owner)).toEqual([]);
}

/** TEST funding of the simulator's venue account; throws when the simulator credits nothing. */
async function fundOnSimulator(owner) {
  if (!(await testDeposit(owner, 'USDC', '200', `84532:0x${randomBytes(32).toString('hex')}:0`)))
    throw new Error(`${J}: the TEST venue credited no TEST USDC`);
}

/** An action signed: on the simulator the wallet's sheet is passed; on Hyperliquid the session key signed it already. */
async function signed(page) {
  if (!sessionVenue) await continueInWallet(page);
}

const positionOf = async (owner) => (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === SYMBOL) ?? null;
const openOrders = async (owner) => (await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === SYMBOL);
const row = (page) => page.getByTestId('venue-positions').locator(`tr[data-symbol="${SYMBOL}"]`);
const listed = (dialog) => dialog.getByRole('region', { name: 'Exit orders on this position', exact: true });
const item = (dialog, clientOrderId) => listed(dialog).locator(`li[data-client-order-id="${clientOrderId}"]`);

async function exitOrders(page) {
  await expect(row(page)).toBeVisible({ timeout: 20_000 });
  await row(page)
    .getByRole('button', { name: `Exit orders ${SYMBOL}`, exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: `Exit orders for ${SYMBOL}`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * `units` (scaled) put on the venue's price rule: a multiple of the tick and at most 5 significant figures, as
 * Hyperliquid takes a price (and the simulator's ticks already are), rounded up or down.
 */
function onPriceRule(units, tick, up) {
  const digits = (units / SCALE).toString().length;
  const sig = digits >= 5 ? SCALE * 10n ** BigInt(digits - 5) : SCALE / 10n ** BigInt(5 - digits);
  const step = sig > toUnits(tick) ? sig : toUnits(tick);
  const down = (units / step) * step;
  return fromUnits(up && down < units ? down + step : down);
}
/** `units` (scaled) up to the next whole lot. */
const upToLot = (units, lot) => {
  const step = toUnits(lot);
  return fromUnits(((units + step - 1n) / step) * step);
};
/** `x` times `bps / 10000`, on the price rule. */
const times = (x, bps, tick, up) => onPriceRule((x * BigInt(bps)) / 10_000n, tick, up);

test(`${J} #1 sets a stop loss and a take profit for the whole position: both rest on the venue as its trigger orders, shown armed with their trigger and source, on Hyperliquid's test network`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(360_000);
  const { owner } = await desk(page);
  // TEST funding on the simulator only: on the test network the trader's own account already holds TEST USDC.
  if (!sessionVenue) await fundOnSimulator(owner);
  // TEST setup: whatever an earlier run cut short left on the funded account is flattened first.
  await flatten(page, owner);
  const market = (await venueRecord(owner, '/markets')).value.find((m) => m.symbol === SYMBOL);
  expect(market, `${SYMBOL} is on the venue's own market list`).toBeTruthy();
  // What the venue judges trigger orders on: its mark (Hyperliquid triggers on the mark price).
  expect(market.triggerSources).toContain('mark');
  const { bid, ask } = (await venueRecord(owner, '/best-prices', { symbol: SYMBOL })).value;
  expect(bid !== null && ask !== null, `the venue has a two-sided book on ${SYMBOL}`).toBe(true);
  const size = upToLot((toUnits(OPEN_VALUE) * SCALE) / toUnits(bid), market.lotSize);
  const worst = times(toUnits(ask), 10_300, market.tickSize, true);
  const takeProfit = times(toUnits(ask), 15_000, market.tickSize, true);
  const stopLoss = times(toUnits(bid), 6_000, market.tickSize, false);

  // The journey's start: a trading session where the venue needs one, a leverage, and a TEST long open on the venue.
  if (sessionVenue) await startVenueSession(page);
  const margin = page.getByTestId('venue-margin');
  await margin.getByRole('textbox', { name: 'Leverage (times)', exact: true }).fill(LEVERAGE);
  await margin.getByRole('button', { name: 'Sign this leverage setting', exact: true }).click();
  await signed(page);
  await expect(margin.getByTestId('venue-outcome')).toContainText('The venue accepted it.', { timeout: 30_000 });

  const ticket = page.getByTestId('venue-ticket');
  await ticket.getByRole('button', { name: 'Long', exact: true }).click();
  await ticket.getByRole('button', { name: 'Market', exact: true }).click();
  await ticket.getByRole('textbox', { name: 'Size (ETH)', exact: true }).fill(size);
  await ticket.getByRole('textbox', { name: 'Worst price (slippage limit)', exact: true }).fill(worst);
  await ticket.getByRole('button', { name: 'Review long', exact: true }).click();
  const sheet = page.getByTestId('venue-review');
  await expect(sheet).toBeVisible();
  const approval = sheet.locator('[data-line="builder-approval"]');
  // Our builder fee is approved by the wallet itself, once, on either venue: asked for only while not yet signed.
  if (!/Signed, up to/.test(await approval.innerText())) {
    await sheet.getByRole('button', { name: 'Approve our builder fee in your wallet', exact: true }).click();
    await continueInWallet(page);
    await approval.filter({ hasText: /Signed, up to/ }).waitFor({ timeout: 30_000 });
  }
  await sheet.getByRole('button', { name: 'Open long', exact: true }).click();
  await signed(page);
  await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Filled on the venue.', { timeout: 30_000 });
  await sheet.getByRole('button', { name: 'Back', exact: true }).click();
  await expect.poll(async () => (await positionOf(owner))?.side ?? null, { timeout: 20_000 }).toBe('long');
  const position = await positionOf(owner);
  expect(sameDecimal(position.size, size)).toBe(true);

  const dialog = await exitOrders(page);
  await expect(listed(dialog)).toContainText('No exit order on this position.');
  const arm = async (kind, price) => {
    await dialog.getByRole('button', { name: kind, exact: true }).click();
    await dialog.getByRole('button', { name: 'Mark', exact: true }).click();
    await expect(dialog.getByTestId('protection-where')).toHaveText(VENUE_LABEL);
    await dialog.getByRole('textbox', { name: 'Size to close', exact: true }).fill(position.size);
    await dialog.getByRole('textbox', { name: 'Trigger price', exact: true }).fill(price);
    const sent = page.waitForResponse((r) => r.url().endsWith('/api/v1/venue/protections') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Arm exit order', exact: true }).click();
    const answer = await sent;
    expect(answer.status(), await answer.text()).toBe(200);
    expect((await answer.json()).restsOn).toBe('venue');
    await signed(page);
    await expect(dialog.getByTestId('protection-outcome')).toHaveText('Armed on the venue.', { timeout: 30_000 });
    return answer.request().postDataJSON();
  };
  const tp = await arm('Take profit', takeProfit);
  const sl = await arm('Stop loss', stopLoss);
  expect(tp).toMatchObject({ kind: 'take_profit', side: 'sell', triggerPrice: takeProfit, triggerSource: 'mark' });
  expect(sl).toMatchObject({ kind: 'stop_loss', side: 'sell', triggerPrice: stopLoss, triggerSource: 'mark' });
  // Each is signed by what signs the venue's orders: the session key on Hyperliquid, the wallet on the simulator.
  const signer = sessionVenue ? 'agent' : 'owner';
  expect(tp.signer?.role ?? 'owner').toBe(signer);
  expect(sl.signer?.role ?? 'owner').toBe(signer);

  // Both rest on the venue as its trigger orders: reduce-only, waiting, each with its own venue order id and price.
  const triggers = (await openOrders(owner)).filter((o) => o.trigger);
  expect(triggers.map((o) => [o.trigger.role, o.trigger.state, o.trigger.source, o.side, o.reduceOnly]).sort()).toEqual([
    ['stop_loss', 'waiting', 'mark', 'sell', true],
    ['take_profit', 'waiting', 'mark', 'sell', true],
  ]);
  expect(new Set(triggers.map((o) => o.venueOrderId)).size).toBe(2);
  for (const [sent, kind, price, words] of [
    [tp, 'take_profit', takeProfit, 'Take profit'],
    [sl, 'stop_loss', stopLoss, 'Stop loss'],
  ]) {
    const onVenue = triggers.find((o) => o.trigger.role === kind);
    expect(sameDecimal(onVenue.trigger.price, price)).toBe(true);
    expect(sameDecimal(onVenue.amount, position.size)).toBe(true);
    // Shown armed, with its trigger and source, as the venue has it.
    const li = item(dialog, sent.clientOrderId);
    await expect(li).toHaveAttribute('data-rests-on', 'venue', { timeout: 20_000 });
    await expect(li).toHaveAttribute('data-venue-order-id', onVenue.venueOrderId);
    await expect(li).toContainText(`${words} for ${fromUnits(toUnits(position.size))}: Armed`);
    await expect(li).toContainText(`triggers at ${price}, judged on the mark price`);
    await expect(li).toContainText(VENUE_LABEL);
  }
  await stepPicture();
});
