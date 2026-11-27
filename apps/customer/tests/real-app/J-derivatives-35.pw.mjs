// World: book, gates, restart
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { ageRecord } from './test-age.mjs';
import {
  continueInWallet,
  openVenueDesk,
  openVenuePage,
  sameDecimal,
  testDeposit,
  testVenue,
  venueForThisFile,
  venueRecord,
} from './venue.mjs';
import { ledgerUntouched, ledgerView } from './venue-door.mjs';

// J-derivatives-35, "I set a daily loss limit that warns me or stops new trades, can't be loosened for 24 hours, and never
// stops an exit", in the running app against the stack's TEST venue simulator. One test per step, titled
// "J-derivatives-35 #<n>", run in order on one TEST person. The limit is the person's own setting, kept by svc-trade
// (src/venue/daily-loss-limit.ts): today's loss is the venue's own realised result on its fills, and every opening order
// is judged against it at the door's prepare, before anything is signed. A close, a stop and a cancel are reduce-only or
// open nothing, so the limit never holds them. Nothing here moves through INTAFACED: the ledger posts nothing.
//
// Every figure is TEST and read from its source: today's loss and the times from svc-trade's own record of the limit
// (`trade.dailyLoss.get`), the orders, fills and positions from the TEST venue itself, never the page. The TEST perpetual
// ETH-PERP's TEST mark and ladder start at 3000; #2 moves both to 2600 so the half it closes realises a TEST loss of more
// than 100 USDC, and the file puts them back after. #5's 24 hours pass on the TEST age door (`daily-loss-limit`), which
// moves only this account's waiting change back in time; no clock moves.
const J = 'J-derivatives-35';
const SYMBOL = 'ETH-PERP';
const DESK = `/trade/futures?symbol=${SYMBOL}`;
const RULES = '/trade/risk/rules';
const START_USDC = '1000';
const MARK = '3000';
const LOW = '2600';
const LEVERAGE = '3';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const DAY_MS = 86_400_000;

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
test.afterAll(async () => {
  await testVenue('/test/set-mark', { symbol: SYMBOL, price: MARK }).catch(() => undefined);
  await testVenue('/test/ladder-mid', { symbol: SYMBOL, price: MARK }).catch(() => undefined);
});

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey || !s.owner) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return s;
}

/** svc-trade's own record of the limit: the terms in force, a change waiting, and today's loss with its times. */
async function limitView() {
  const s = state();
  const me = await api(s.account);
  const res = await me.get(`/api/trade/trpc/dailyLoss.get?input=${encodeURIComponent(JSON.stringify({ owner: s.owner }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** A figure as the app writes it (displayAmount): thousands grouped, every decimal kept. */
const shown = (v) => {
  const [whole, fraction] = v.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
};
const nextUtcMidnight = (sinceIso) => new Date(Date.parse(sinceIso) + DAY_MS).toISOString();
const positionOf = async (owner) => (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === SYMBOL) ?? null;
const openOrders = async (owner) => (await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === SYMBOL);
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;

/** Every POST to the venue door's submit from this page from now on: one per action the venue was sent. */
function submits(page) {
  const seen = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/v1/venue/submit')) seen.push(req.postDataJSON());
  });
  return seen;
}

async function setMarket(price) {
  for (const route of ['/test/set-mark', '/test/ladder-mid']) {
    const moved = await testVenue(route, { symbol: SYMBOL, price });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  }
}

const rules = (page) => page.getByTestId('daily-loss');
const form = (page) => page.getByTestId('daily-loss-form');
const ticket = (page) => page.getByTestId('venue-ticket');
const row = (page) => page.getByTestId('venue-positions').locator(`tr[data-symbol="${SYMBOL}"]`);

async function openRules(page) {
  const s = state();
  return openVenuePage(page, s.account, RULES, s.walletKey);
}
async function openDesk(page) {
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(SYMBOL, { timeout: 20_000 });
  return wallet;
}

/** Chooses the mode and limit on the Risk rules form and saves; answers the saved line. */
async function saveRule(page, { mode, limit }) {
  const f = form(page);
  await f.getByRole('group', { name: 'When the limit is reached', exact: true }).getByRole('button', { name: mode, exact: true }).click();
  await f.getByRole('textbox', { name: 'Limit (USDC)', exact: true }).fill(limit);
  await f.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = page.getByTestId('daily-loss-saved');
  await expect(saved).toBeVisible({ timeout: 15_000 });
  return saved;
}

/** The ticket filled for a long of `size` ETH (market, or a limit at `price`) and Review pressed; returns the sheet. */
async function reviewLong(page, size, price = null) {
  const t = ticket(page);
  await t.getByRole('button', { name: 'Long', exact: true }).click();
  await t.getByRole('button', { name: price ? 'Limit' : 'Market', exact: true }).click();
  await t.getByRole('textbox', { name: 'Size (ETH)', exact: true }).fill(size);
  await t.getByRole('textbox', { name: price ? 'Price' : 'Worst price (slippage limit)', exact: true }).fill(price ?? '3100');
  await t.getByRole('button', { name: 'Review long', exact: true }).click();
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

/** The position's exit-orders dialog, from its row. */
async function exitOrders(page) {
  await row(page)
    .getByRole('button', { name: `Exit orders ${SYMBOL}`, exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: `Exit orders for ${SYMBOL}`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test(`${J} #1 opens Risk rules: the daily loss limit off; turning it on offers "Warn me" (the default) or "Stop new trades", the limit and the time the day resets`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  // The journey's start: a verified TEST person, a TEST wallet with TEST 1000 USDC in its venue account, no limit set.
  const account = await signUp(page, 'jd35');
  await verify(page, account);
  const walletKey = testWalletKey();
  run.reset({ account, walletKey, owner: '' });
  const wallet = await openVenueDesk(page, account, DESK, walletKey);
  const owner = wallet.address.toLowerCase();
  run.write({ owner, ledger: await ledgerView(account) });
  expect(await testDeposit(owner, 'USDC', START_USDC, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  const before = await limitView();
  expect(before).toMatchObject({ owner, asset: 'USDC', active: null, pending: null });

  await page.goto(RULES);
  await expect(page.getByRole('heading', { name: 'Risk rules', exact: true, level: 1 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('venue-wallet-address')).toHaveText(owner, { timeout: 20_000 });
  const section = rules(page);
  await expect(section.getByTestId('daily-loss-state')).toHaveText('Off');
  await expect(section.getByTestId('daily-loss-state')).toHaveAttribute('data-mode', 'off');
  await expect(form(page)).toHaveCount(0);
  await section.getByRole('button', { name: 'Turn on', exact: true }).click();

  const modes = form(page).getByRole('group', { name: 'When the limit is reached', exact: true });
  await expect(modes.getByRole('button')).toHaveText(['Warn me', 'Stop new trades']);
  await expect(modes.getByRole('button', { name: 'Warn me', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(modes.getByRole('button', { name: 'Stop new trades', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(form(page).getByRole('textbox', { name: 'Limit (USDC)', exact: true })).toHaveValue('');
  // The day resets at the next 00:00 UTC, as svc-trade counts it.
  const view = await limitView();
  const reset = section.getByTestId('daily-loss-reset');
  await expect(reset).toHaveAttribute('data-resets-at', view.today.resetsAt);
  expect(view.today.resetsAt).toBe(nextUtcMidnight(view.today.since));
  await expect(reset).toContainText('The day resets at 00:00 UTC: next at');
  await stepPicture();
  // Opening the form saved nothing: the limit is still off.
  expect((await limitView()).active).toBeNull();
});

test(`${J} #2 sets a TEST limit of 100 USDC with "Warn me" and closes TEST trades that lose more than that: today's realised loss from the venue, with its as-of time, against the limit; once reached, a warning on the desk naming both figures; an opening order still goes after a confirm that names the limit`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(480_000);
  const { owner } = state();
  await openRules(page);
  await rules(page).getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(await saveRule(page, { mode: 'Warn me', limit: '100' })).toHaveText('Saved. It applies now.');
  await expect(rules(page).getByTestId('daily-loss-state')).toHaveText('On: warn me once today’s loss reaches 100 USDC');
  expect((await limitView()).active).toEqual({ mode: 'advisory', limit: '100' });

  // TEST trades: a long of 0.6 ETH at 3x from the desk, then the TEST market falls to 2600 and half is closed.
  const wallet = await openDesk(page);
  const margin = page.getByTestId('venue-margin');
  await margin.getByRole('textbox', { name: 'Leverage (times)', exact: true }).fill(LEVERAGE);
  await margin.getByRole('button', { name: 'Sign this leverage setting', exact: true }).click();
  await continueInWallet(page);
  await expect(margin.getByTestId('venue-outcome')).toContainText('The venue accepted it.', { timeout: 15_000 });
  const entry = await reviewLong(page, '0.6');
  // Below the limit, no confirm is asked.
  await expect(entry.getByTestId('daily-loss-confirm')).toHaveCount(0);
  await entry.getByRole('button', { name: 'Open long', exact: true }).click();
  await continueInWallet(page);
  await expect(entry.getByTestId('venue-outcome').last()).toContainText('Filled on the venue.', { timeout: 15_000 });
  await entry.getByRole('button', { name: 'Back', exact: true }).click();
  expect(sameDecimal((await positionOf(owner)).size, '0.6')).toBe(true);
  await setMarket(LOW);
  const close = row(page).getByTestId('venue-close');
  await close.getByRole('textbox').fill('50');
  await close.getByRole('button', { name: 'Close 50%', exact: true }).click();
  await continueInWallet(page);
  await expect(close.getByTestId('venue-close-outcome')).toContainText('Close of 0.3 ETH: Filled on the venue.', { timeout: 15_000 });

  // Today's loss is the venue's own realised result less every fee: more than the TEST 100 USDC limit.
  const since = new Date(Date.parse((await limitView()).today.since)).toISOString();
  const fills = (await venueRecord(owner, '/fills', { since })).value;
  const realised = fills.reduce((sum, f) => sum + (f.realisedPnl === null ? 0n : toUnits(f.realisedPnl)), 0n);
  expect(realised < -toUnits('100')).toBe(true);
  const view = await limitView();
  expect(view.today.reached).toBe(true);
  expect(toUnits(view.today.loss) > toUnits('100')).toBe(true);

  // The desk warns, naming both figures.
  const warning = page.getByTestId('daily-loss-desk');
  await expect(warning).toHaveAttribute('data-state', 'advisory', { timeout: 20_000 });
  const lossNow = await warning.getAttribute('data-loss');
  expect(lossNow).toBe((await limitView()).today.loss);
  await expect(warning).toContainText(`you have lost ${shown(lossNow)} USDC today, reaching your limit of 100 USDC`);

  // An opening order (a TEST limit long of 0.1 ETH at 2000, resting under the book) asks a confirm naming the limit; it
  // goes once ticked.
  const signedBefore = signatures(wallet);
  const sheet = await reviewLong(page, '0.1', '2000');
  const confirm = sheet.getByTestId('daily-loss-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAttribute('data-limit', '100');
  await expect(confirm).toContainText('has reached your daily loss limit of 100 USDC');
  const open = sheet.getByRole('button', { name: 'Open long', exact: true });
  await expect(open).toBeDisabled();
  await confirm.getByRole('checkbox', { name: 'Open it anyway, past my daily loss limit of 100 USDC', exact: true }).check();
  await expect(open).toBeEnabled();
  await open.click();
  await continueInWallet(page);
  await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Open on the venue.', { timeout: 15_000 });
  expect(signatures(wallet) - signedBefore).toBe(1);
  const resting = (await openOrders(owner)).filter((o) => !o.reduceOnly && o.side === 'buy');
  expect(resting).toHaveLength(1);
  expect(sameDecimal(resting[0].price, '2000')).toBe(true);
  run.write({ resting: resting[0].venueClientOrderId });
  await sheet.getByRole('button', { name: 'Back', exact: true }).click();

  // Risk rules shows today's loss from the venue, with its as-of time, against the limit.
  await page.goto(RULES);
  const today = rules(page).getByTestId('daily-loss-today');
  const shownLoss = await today.getAttribute('data-loss', { timeout: 20_000 });
  const read = await limitView();
  expect(shownLoss).toBe(read.today.loss);
  await expect(today).toContainText(`Today’s realised loss from`);
  await expect(today).toContainText(`${shown(shownLoss)} USDC of your 100 USDC limit.`);
  await expect(today).toContainText('As of');
  await expect(today).toHaveAttribute('data-as-of', /^\d{4}-\d{2}-\d{2}T/);
  await expect(rules(page).getByTestId('daily-loss-reached')).toContainText('has reached your limit of 100 USDC');
  await stepPicture();
});

test(`${J} #3 switches to "Stop new trades": takes effect at once; an opening order is refused naming the limit, today's loss and when the day resets; nothing is sent`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const { owner } = state();
  await openRules(page);
  await expect(await saveRule(page, { mode: 'Stop new trades', limit: '100' })).toHaveText('Saved. It applies now.');
  await expect(rules(page).getByTestId('daily-loss-state')).toHaveText('On: stop new trades once today’s loss reaches 100 USDC');
  await expect(rules(page).getByTestId('daily-loss-pending')).toHaveCount(0);
  expect(await limitView()).toMatchObject({ active: { mode: 'blocking', limit: '100' }, pending: null });

  const wallet = await openDesk(page);
  const view = await limitView();
  const banner = page.getByTestId('daily-loss-desk');
  await expect(banner).toHaveAttribute('data-state', 'blocking', { timeout: 20_000 });
  await expect(banner).toHaveAttribute('data-resets-at', view.today.resetsAt);
  await expect(banner).toContainText('New opening orders are stopped until the day resets at');

  const ordersBefore = await openOrders(owner);
  const positionBefore = await positionOf(owner);
  const signedBefore = signatures(wallet);
  const sent = submits(page);
  const sheet = await reviewLong(page, '0.1', '2000');
  await sheet.getByRole('button', { name: 'Open long', exact: true }).click();
  const refused = sheet.getByTestId('daily-loss-refused');
  await expect(refused).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByTestId('venue-outcome').last()).toHaveAttribute('data-code', 'trade.daily_loss_limit_reached');
  const now = await limitView();
  await expect(refused).toHaveAttribute('data-resets-at', now.today.resetsAt);
  expect(now.today.resetsAt).toBe(nextUtcMidnight(now.today.since));
  await expect(refused).toContainText(
    `Today’s loss of ${shown(now.today.loss)} USDC has reached your daily loss limit of 100 USDC, so this opening order was refused. Nothing was sent. The day resets at`,
  );
  // svc-trade's own refusal names the same: the limit, today's loss and the reset.
  await expect(sheet.getByTestId('venue-outcome').last()).toContainText(
    `reaching your daily loss limit of 100 USDC, so no new opening order is placed until the day resets at ${now.today.resetsAt}`,
  );
  await stepPicture();
  // Nothing was sent: the refusal is the answer to the prepare, before any wallet prompt or submit.
  expect(signatures(wallet)).toBe(signedBefore);
  expect(sent).toHaveLength(0);
  expect(await openOrders(owner)).toEqual(ordersBefore);
  expect((await positionOf(owner)).size).toBe(positionBefore.size);
});

test(`${J} #4 closes a position, moves its stop and cancels an order while stopped: each goes to the venue once, with no warning or wait`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(480_000);
  const { owner, resting } = state();
  expect((await limitView()).active).toEqual({ mode: 'blocking', limit: '100' });
  const wallet = await openDesk(page);
  await expect(page.getByTestId('daily-loss-desk')).toHaveAttribute('data-state', 'blocking', { timeout: 20_000 });
  const sent = submits(page);

  // A stop loss on the position, then moved: the old trigger order cancelled and the new one placed, each sent once.
  const dialog = await exitOrders(page);
  await dialog.getByRole('button', { name: 'Stop loss', exact: true }).click();
  await dialog.getByRole('button', { name: 'Mark', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Size to close', exact: true }).fill('0.3');
  await dialog.getByRole('textbox', { name: 'Trigger price', exact: true }).fill('2300');
  await dialog.getByRole('button', { name: 'Arm exit order', exact: true }).click();
  await continueInWallet(page);
  await expect(dialog.getByTestId('protection-outcome')).toHaveText('Armed on the venue.', { timeout: 15_000 });
  const stopAt = async (price) => (await openOrders(owner)).filter((o) => o.reduceOnly && o.trigger && sameDecimal(o.trigger.price, price));
  await expect.poll(async () => (await stopAt('2300')).length, { timeout: 15_000 }).toBe(1);
  const armed = dialog.locator('li[data-kind="stop_loss"][data-status="armed"]');
  await expect(armed).toHaveCount(1, { timeout: 15_000 });
  const beforeMove = { signed: signatures(wallet), sent: sent.length };
  await armed.getByTestId('protection-move').getByRole('textbox', { name: 'New trigger price', exact: true }).fill('2400');
  await armed.getByTestId('protection-move').getByRole('button', { name: 'Move', exact: true }).click();
  await continueInWallet(page);
  await continueInWallet(page);
  await expect.poll(async () => (await stopAt('2400')).length, { timeout: 20_000 }).toBe(1);
  expect(await stopAt('2300')).toHaveLength(0);
  await expect(dialog.locator('li[data-kind="stop_loss"][data-status="armed"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(dialog.getByTestId('protection-refusal')).toHaveCount(0);
  expect(signatures(wallet) - beforeMove.signed).toBe(2);
  expect(sent.length - beforeMove.sent).toBe(2);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();

  // The resting opening order from #2 cancelled: one signed cancel, the venue no longer holds it.
  const beforeCancel = { signed: signatures(wallet), sent: sent.length };
  await page.getByTestId('venue-blotter').getByRole('button', { name: 'Open orders', exact: true }).click();
  const order = page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${resting}"]`);
  await expect(order).toBeVisible({ timeout: 20_000 });
  await order.getByRole('button', { name: 'Cancel', exact: true }).click();
  await continueInWallet(page);
  await expect.poll(async () => (await openOrders(owner)).some((o) => o.venueClientOrderId === resting), { timeout: 20_000 }).toBe(false);
  expect(signatures(wallet) - beforeCancel.signed).toBe(1);
  expect(sent.length - beforeCancel.sent).toBe(1);

  // The whole position closed: one signed reduce-only close, filled; no confirm, warning or refusal on the way.
  const beforeClose = { signed: signatures(wallet), sent: sent.length };
  const close = row(page).getByTestId('venue-close');
  await close.getByRole('textbox').fill('100');
  await close.getByRole('button', { name: 'Close 100%', exact: true }).click();
  await continueInWallet(page);
  await expect(close).toHaveCount(0, { timeout: 20_000 });
  expect(await positionOf(owner)).toBeNull();
  expect(signatures(wallet) - beforeClose.signed).toBe(1);
  expect(sent.length - beforeClose.sent).toBe(1);
  await expect(page.getByTestId('daily-loss-confirm')).toHaveCount(0);
  await expect(page.getByTestId('daily-loss-refused')).toHaveCount(0);
  await stepPicture();
  // The limit held all along: it is still stop new trades at 100.
  expect((await limitView()).active).toEqual({ mode: 'blocking', limit: '100' });
  // Nothing moved through INTAFACED: the ledger posted nothing for the person since the journey started.
  await ledgerUntouched(state());
});

test(`${J} #5 raises the limit to TEST 300 USDC, then switches back to "Warn me": each change shown as waiting, with the time it takes effect, 24 hours later; until then the 100 USDC limit and "Stop new trades" still hold; after 24 hours (TEST clock) the new settings apply`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(480_000);
  const { owner } = state();
  await openRules(page);
  const section = rules(page);
  const pending = section.getByTestId('daily-loss-pending');

  // Raise to 300: it waits 24 hours from when it was asked.
  const askedRaise = Date.now();
  await expect(await saveRule(page, { mode: 'Stop new trades', limit: '300' })).toContainText(
    'Saved. It loosens your limit, so it waits 24 hours, until',
  );
  const raised = await limitView();
  expect(raised).toMatchObject({ active: { mode: 'blocking', limit: '100' }, pending: { terms: { mode: 'blocking', limit: '300' } } });
  const raiseAt = Date.parse(raised.pending.effectiveAt);
  expect(raiseAt - askedRaise).toBeGreaterThanOrEqual(DAY_MS - 1_000);
  expect(raiseAt - Date.now()).toBeLessThanOrEqual(DAY_MS);
  await expect(pending).toHaveAttribute('data-effective-at', raised.pending.effectiveAt);
  await expect(pending).toContainText('Asked: stop new trades at 300 USDC. Takes effect at');
  await expect(pending).toContainText('Until then stop new trades at 100 USDC still holds.');
  await expect(section.getByTestId('daily-loss-state')).toHaveText('On: stop new trades once today’s loss reaches 100 USDC');

  // Back to "Warn me" (at 300): looser again, so it waits too, 24 hours from this ask.
  const askedWarn = Date.now();
  await expect(await saveRule(page, { mode: 'Warn me', limit: '300' })).toContainText('waits 24 hours, until');
  const warned = await limitView();
  expect(warned).toMatchObject({ active: { mode: 'blocking', limit: '100' }, pending: { terms: { mode: 'advisory', limit: '300' } } });
  expect(Date.parse(warned.pending.effectiveAt) - askedWarn).toBeGreaterThanOrEqual(DAY_MS - 1_000);
  await expect(pending).toHaveAttribute('data-effective-at', warned.pending.effectiveAt);
  await expect(pending).toContainText('Asked: warn me at 300 USDC. Takes effect at');
  await expect(pending).toContainText('Until then stop new trades at 100 USDC still holds.');
  await stepPicture();

  // Until then the 100 USDC limit and "Stop new trades" still hold: an opening order is refused, nothing sent.
  const wallet = await openDesk(page);
  await expect(page.getByTestId('daily-loss-desk')).toHaveAttribute('data-state', 'blocking', { timeout: 20_000 });
  const signedBefore = signatures(wallet);
  const sheet = await reviewLong(page, '0.1', '2000');
  await sheet.getByRole('button', { name: 'Open long', exact: true }).click();
  await expect(sheet.getByTestId('daily-loss-refused')).toBeVisible({ timeout: 15_000 });
  expect(signatures(wallet)).toBe(signedBefore);
  expect(await positionOf(owner)).toBeNull();
  await sheet.getByRole('button', { name: 'Back', exact: true }).click();

  // 24 hours pass on the TEST clock: the waiting change is moved back until its time is a second gone.
  const left = Date.parse((await limitView()).pending.effectiveAt) - Date.now();
  await ageRecord('trade', 'daily-loss-limit', owner, Math.min(DAY_MS, left + 1_000));
  const after = await limitView();
  expect(after).toMatchObject({ active: { mode: 'advisory', limit: '300' }, pending: null });
  await page.goto(RULES);
  await expect(rules(page).getByTestId('daily-loss-state')).toHaveText('On: warn me once today’s loss reaches 300 USDC', {
    timeout: 20_000,
  });
  await expect(rules(page).getByTestId('daily-loss-pending')).toHaveCount(0);
  // Today's loss is under the new 300 USDC limit, so the desk neither warns nor asks a confirm of an opening order.
  expect(toUnits(after.today.loss) < toUnits('300')).toBe(true);
  expect(after.today.reached).toBe(false);
  await openDesk(page);
  await expect(page.getByTestId('venue-ticket')).toBeVisible();
  await expect(page.getByTestId('daily-loss-desk')).toHaveCount(0);
  const next = await reviewLong(page, '0.1', '2000');
  await expect(next.getByTestId('daily-loss-confirm')).toHaveCount(0);
  await expect(next.getByRole('button', { name: 'Open long', exact: true })).toBeEnabled();
});

test(`${J} #6 lowers the limit to TEST 50 USDC: takes effect at once`, async ({ page, stepPicture }) => {
  test.setTimeout(300_000);
  await openRules(page);
  await expect(await saveRule(page, { mode: 'Warn me', limit: '50' })).toHaveText('Saved. It applies now.');
  await expect(rules(page).getByTestId('daily-loss-state')).toHaveText('On: warn me once today’s loss reaches 50 USDC');
  await expect(rules(page).getByTestId('daily-loss-state')).toHaveAttribute('data-limit', '50');
  await expect(rules(page).getByTestId('daily-loss-pending')).toHaveCount(0);
  const view = await limitView();
  expect(view).toMatchObject({ active: { mode: 'advisory', limit: '50' }, pending: null });
  // At once: today's loss already passes 50, so the limit is reached now.
  expect(view.today.reached).toBe(true);
  await expect(rules(page).getByTestId('daily-loss-reached')).toContainText('has reached your limit of 50 USDC');
  await stepPicture();
});
