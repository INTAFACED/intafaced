// World: gates, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState, stepState, toUnits, fromUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  doorOk,
  openVenueDesk,
  sameDecimal,
  signPrepared,
  testDeposit,
  testVenue,
  venueForThisFile,
  venueInfo,
  venueRecord,
  walletDoorAct,
} from './venue.mjs';

// J-derivatives-32 "I set and move my stop and target by dragging them on the chart, and move my stop to breakeven in one
// press", in the running app (docs/roadmap/journeys.json), on the futures desk under the launch money model
// (docs/adr/2026-11-10-launch-money-model.md): the person's position, its stop and its target are on their own venue
// account, each stop and target the person's own reduce-only trigger order there, and the ledger posts nothing. One test
// per step, titled "J-derivatives-32 #<n>", run in order in one signed-in browser on one TEST account: verified, its
// TEST wallet connected, a TEST long on XEXA-PERP opened with a stop and a target, and a TEST short on XEXB-PERP with
// none. XEXA-PERP and XEXB-PERP are this journey's own TEST perpetuals on the stack's TEST venue (packages/venue-sim),
// priced by their TEST oracle, so a fill never moves their mark: #5 and #6 move XEXA-PERP's mark with /test/set-mark, and
// #4 sets the venue's refusal of a move on this account alone (/test/account-switches refuseTriggerMoves). Every price,
// order and fill is read from the TEST venue itself; every dollar figure is worked here from those records (the entry,
// size and opening fees the venue reports, its taker fee, and our published TEST builder fee), never typed. The steps
// run #1, #2, #3, #4, #6, #5, #7: #6's mark below breakeven must come before #5 moves the stop to breakeven, or the
// stop there would fire. Prices on the chart are found from the chart itself: the overlay names the prices at its price
// pane's top and bottom edges.
const J = 'J-derivatives-32';
const LONG = 'XEXA-PERP';
const SHORT = 'XEXB-PERP';
const DESK = `/trade/futures?symbol=${LONG}`;
const MARK = '100';
const STOP = '95';
const TARGET = '110';
const REFUSAL = 'TEST: the venue refuses this change to a resting trigger order';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const S = 10n ** 18n;
const BPS = 10_000n;

test.describe.configure({ mode: 'serial' });
venueForThisFile(test);

let page;
let wallet;
/** The target line #2 still holds, for #3 to let go. */
let heldTarget = null;
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 2200 } });
  page = await context.newPage();
});
test.afterAll(async () => {
  await page?.context().close();
  const s = run.read();
  if (s.walletKey) await testVenue('/test/account-switches', { owner: ownerOf(s), refuseTriggerMoves: null }).catch(() => undefined);
  for (const symbol of [LONG, SHORT]) await testVenue('/test/set-mark', { symbol, price: MARK }).catch(() => undefined);
});

const state = () => stepState(run, J)('account', 'walletKey');
const ownerOf = (s) => privateKeyToAccount(s.walletKey).address.toLowerCase();

// ── the TEST venue's own record ──

const since = () => new Date(Date.now() - 3_600_000).toISOString();
const positionOf = async (owner, symbol) => (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === symbol) ?? null;
const exitsOf = async (owner, symbol, role) =>
  (await venueRecord(owner, '/open-orders')).value.filter(
    (o) => o.symbol === symbol && o.reduceOnly && o.trigger?.role === role && o.trigger.state === 'waiting',
  );
const marketOf = async (symbol) => (await testVenue('/markets', {})).body.value.find((m) => m.symbol === symbol);
async function setMark(symbol, price) {
  const moved = await testVenue('/test/set-mark', { symbol, price });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
}
async function ladderAt(symbol, price) {
  const moved = await testVenue('/test/ladder-mid', { symbol, price });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
}
/** The venue's record read until `ok` holds of it, as `expect.poll` reads; answers the last read. */
async function until(read, ok, what, timeout = 20_000) {
  let last;
  await expect
    .poll(
      async () => {
        last = await read();
        return ok(last);
      },
      { message: what, timeout },
    )
    .toBe(true);
  return last;
}
/** Our ledger's view of this account: this journey's ledger posts nothing. */
const ledgerView = async (who) => (await api(who)).balances();
/** The wallet's signature prompts so far. */
const signatures = () => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;
/** Every write this page sends to the venue door from now on, by its path. */
function doorWrites() {
  const calls = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === 'POST' && path.startsWith('/api/v1/venue/')) calls.push(path.slice('/api/v1/venue/'.length));
  });
  return calls;
}

// ── the figures, worked here from the venue's records ──

/**
 * What the position's dollar figures rest on, from the venue: its entry and size, the fees its opening fills paid (the
 * venue's fee and our builder fee, on its fills), and the close's rate (the venue's taker fee plus our TEST builder fee).
 */
async function basisOf(s, symbol) {
  const owner = ownerOf(s);
  const position = await positionOf(owner, symbol);
  const fills = (await venueRecord(owner, '/fills', { since: since() })).value.filter((f) => f.symbol === symbol);
  // Every fill on this market opened the position (nothing on it was closed), so their fees are its opening fees.
  const opening = fills.reduce((sum, f) => sum + toUnits(f.venueFee) + toUnits(f.builderFee), 0n);
  const taker = (await marketOf(symbol)).takerFeeBps;
  expect(taker.known).toBe(true);
  return {
    side: position.side,
    size: toUnits(position.size),
    entry: toUnits(position.entryPrice),
    opening,
    rate: toUnits(taker.value) + toUnits(s.builderFeeBps),
  };
}
/** Closing the whole position at `price` after every fee, floored at the 18th place (the person's loss side). */
function netAt(b, price) {
  const p = toUnits(price);
  const move = b.side === 'long' ? p - b.entry : b.entry - p;
  const num = move * b.size * S * BPS - p * b.size * b.rate - b.opening * S * S * BPS;
  const den = S * S * BPS;
  const q = num / den;
  return q * den > num ? q - 1n : q;
}
/** R to two places toward zero: the result over what the opening stop risked. */
function rOf(net, risk) {
  const h = (net * 100n) / -risk;
  const abs = h < 0n ? -h : h;
  return `${h < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
/** The fee-adjusted breakeven of a long: (E·Q + F) / (Q·(1 − r)), up to the tick. */
function breakevenOf(b, tick) {
  const exact = ((b.entry * b.size + b.opening * S) * BPS * S) / (b.size * (BPS * S - b.rate));
  const t = toUnits(tick);
  return fromUnits(((exact + t - 1n) / t) * t);
}

// ── the chart ──

const overlay = () => page.getByTestId('exit-lines-overlay');
const host = () => page.getByTestId('venue-chart').getByTestId('pc-host');
const line = (kind) => page.getByTestId(`exit-line-${kind}`);
const strip = () => page.getByTestId('venue-risk-strip');
const note = () => page.getByTestId('exit-lines-note');

/** The page pixel of `price` on the chart, from the prices the overlay names at its price pane's edges. */
async function yOfPrice(price) {
  const box = await host().boundingBox();
  const o = overlay();
  const top = Number(await o.getAttribute('data-pane-top'));
  const height = Number(await o.getAttribute('data-pane-height'));
  const hi = Number(await o.getAttribute('data-price-top'));
  const lo = Number(await o.getAttribute('data-price-bottom'));
  expect(height).toBeGreaterThan(0);
  expect(hi).toBeGreaterThan(lo);
  return box.y + top + ((hi - Number(price)) / (hi - lo)) * height;
}
/** Press a line's handle and drag it to the pixel of `price`, still held; answers a function that lets go. */
async function holdAt(kind, price) {
  const handle = line(kind);
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, await yOfPrice(price), { steps: 12 });
  await expect(handle).toHaveAttribute('data-dragging', 'true');
  return () => page.mouse.up();
}

// ── the Starts line ──

/**
 * Made at the start of #1 (never a beforeAll: a restarted worker would replace the account the later steps act as): a
 * verified account and this run's TEST wallet key, TEST USDC on its venue account by the TEST deposit control, and,
 * through our door and signed by that key as the desk signs them, 5x isolated on both TEST perpetuals, our TEST builder
 * fee approved, a long of 1 XEXA-PERP with its stop at 95 and its target at 110 (each resting on the venue as the
 * person's own reduce-only trigger order, placed through our protections door), and a short of 1 XEXB-PERP with none.
 */
async function startsLine(browser) {
  const setup = await browser.newPage();
  let account;
  try {
    account = await signUp(setup, 'jd32v');
    await verify(setup, account);
  } finally {
    await setup.close();
  }
  const walletKey = testWalletKey();
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  for (const symbol of [LONG, SHORT]) {
    await setMark(symbol, MARK);
    await ladderAt(symbol, MARK);
  }
  expect(await testDeposit(owner, 'USDC', '2000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  const session = await api(account);
  const status = doorOk(await session.get('/api/v1/venue/status'));
  expect(status.builder, 'the TEST stack publishes our TEST builder fee').toBeTruthy();
  expect(status.movesTriggersInPlace).toBe(true);
  const draft = randomBytes(4).toString('hex');
  await walletDoorAct(session, key, {
    intent: { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
    actionKey: `builder-approval:${owner}:${status.builder.address}:${status.builder.feeBps}:${draft}`,
  });
  for (const [symbol, side, worst] of [
    [LONG, 'buy', '101'],
    [SHORT, 'sell', '99'],
  ]) {
    const part = symbol.toLowerCase();
    await walletDoorAct(session, key, {
      intent: { kind: 'update_leverage', symbol, leverageBps: 50_000, marginMode: 'isolated' },
      actionKey: `leverage:${owner}:${part}:isolated:50000:${draft}`,
    });
    const opened = await walletDoorAct(session, key, {
      intent: {
        kind: 'place_order',
        symbol,
        side,
        type: 'market',
        amount: '1',
        price: worst,
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: `order:${owner}:${part}:${draft}`,
        builderFee: null,
      },
    });
    expect(opened.outcome.order?.status).toBe('filled');
  }
  for (const [kind, triggerPrice] of [
    ['stop_loss', STOP],
    ['take_profit', TARGET],
  ]) {
    const made = doorOk(
      await session.post('/api/v1/venue/protections', {
        owner,
        symbol: LONG,
        kind,
        side: 'sell',
        quantity: '1',
        triggerPrice,
        triggerSource: 'mark',
        clientOrderId: `jd32-${kind.replace('_', '-')}-${draft}`,
      }),
    );
    expect(made.restsOn).toBe('venue');
    const sent = doorOk(
      await session.post('/api/v1/venue/submit', { actionKey: made.actionKey, signature: await signPrepared(key, made.prepared) }),
    );
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
  }
  run.reset({ account, walletKey, builderFeeBps: status.builder.feeBps, ledger: await ledgerView(account) });
}

test(`${J} #1 opens the futures desk: the chart first with the long's entry, stop and target lines at the venue's prices, the book and tape in one column that collapses and reopens, the position row, and every stop and target totalled after fees with the short named as having no stop`, async ({
  browser,
  stepPicture,
}) => {
  test.setTimeout(420_000);
  await startsLine(browser);
  const s = state();
  const owner = ownerOf(s);
  wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(LONG, { timeout: 20_000 });
  await expect(overlay()).toHaveCount(1, { timeout: 20_000 });

  // The lines sit at the prices the venue holds.
  const [stop] = await exitsOf(owner, LONG, 'stop_loss');
  const [target] = await exitsOf(owner, LONG, 'take_profit');
  const long = await positionOf(owner, LONG);
  await expect(line('stop')).toHaveAttribute('data-held', stop.trigger.price);
  await expect(line('target')).toHaveAttribute('data-held', target.trigger.price);
  expect(sameDecimal(stop.trigger.price, STOP) && sameDecimal(target.trigger.price, TARGET)).toBe(true);
  await expect(line('entry')).toHaveAttribute('data-price', long.entryPrice);
  // Stop below the entry, target above it, on the chart's own scale.
  const yOf = async (kind) => (await line(kind).boundingBox()).y;
  expect(await yOf('stop')).toBeGreaterThan(await yOf('entry'));
  expect(await yOf('target')).toBeLessThan(await yOf('entry'));
  const basis = await basisOf(s, LONG);
  const atStop = netAt(basis, STOP);
  await expect(line('target')).toHaveAttribute('data-net', fromUnits(netAt(basis, TARGET)));
  await expect(line('stop')).toHaveAttribute('data-net', fromUnits(atStop));

  // The venue's book and tape beside the chart, in one column that collapses and reopens.
  const column = page.getByTestId('venue-book-tape');
  const toggle = page.getByTestId('venue-book-tape-toggle');
  await expect(column).toBeVisible();
  await expect(column.getByRole('tab', { name: 'Order book', exact: true })).toBeVisible();
  await expect(column.getByRole('tab', { name: 'Last trades', exact: true })).toBeVisible();
  await toggle.click();
  await expect(column).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(column).toBeVisible();

  // The position row under the chart.
  await expect(page.getByTestId('venue-positions').locator(`tr[data-symbol="${LONG}"]`)).toBeVisible();
  await expect(page.getByTestId('venue-positions').locator(`tr[data-symbol="${SHORT}"]`)).toBeVisible();

  // The top strip, after fees from the venue's figures: the short has no stop, so it is named in place of a loss total.
  await expect(strip().getByTestId('venue-risk-stops')).toHaveText(`No stop on ${SHORT}`);
  await expect(strip().getByTestId('venue-risk-targets')).toHaveAttribute('data-value', fromUnits(netAt(basis, TARGET)));
  await expect(strip()).toContainText('After the venue’s fee and ours, in and out');
  await expect(strip().getByTestId('venue-risk-no-stop')).toHaveText(`no stop on ${SHORT}`);
  run.write({ riskAtStop: String(atStop) });
  await stepPicture(page);
});

test(`${J} #2 drags the target line up and holds it: the price snapped to the tick, the dollar result after the venue's fee and ours, and the R against the stop it opened with; nothing is sent while dragging`, async ({
  stepPicture,
}) => {
  const s = state();
  const owner = ownerOf(s);
  const writes = doorWrites();
  const asked = signatures();
  const letGo = await holdAt('target', '112.37');
  const handle = line('target');
  const shown = await handle.getAttribute('data-price');
  // Snapped to XEXA-PERP's tick of 0.01, near where the pointer is.
  const tick = (await marketOf(LONG)).tickSize;
  expect(toUnits(shown) % toUnits(tick)).toBe(0n);
  expect(Math.abs(Number(shown) - 112.37)).toBeLessThan(1);
  const basis = await basisOf(s, LONG);
  const net = netAt(basis, shown);
  await expect(handle).toHaveAttribute('data-net', fromUnits(net));
  await expect(handle).toHaveAttribute('data-r', rOf(net, BigInt(s.riskAtStop)));
  await expect(handle).toContainText(`Target ${shown}`);
  await expect(handle).toContainText(`${rOf(net, BigInt(s.riskAtStop))}R`);
  await expect(handle).toContainText('not sent');
  // Nothing sent while held: no door write, no signature, and the venue's target still where it was.
  // Proving nothing is sent while held: a while with the line held, then no write.
  // oxlint-disable-next-line garden/no-wait-for-timeout -- nothing happening is the outcome
  await page.waitForTimeout(800);
  expect(writes).toEqual([]);
  expect(signatures()).toBe(asked);
  const [target] = await exitsOf(owner, LONG, 'take_profit');
  expect(sameDecimal(target.trigger.price, TARGET)).toBe(true);
  await stepPicture(page);
  run.write({ dragged: shown });
  // Still held: #3 lets go.
  heldTarget = letGo;
});

test(`${J} #3 lets go of the target line: the venue holds one take-profit at the new price, never two and never none, and the line and the top strip show the new figures`, async ({
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const s = state();
  const owner = ownerOf(s);
  const [before] = await exitsOf(owner, LONG, 'take_profit');
  const writes = doorWrites();
  // Let go of the line #2 holds; a worker that restarted after #2 drags it to the same price again first.
  const letGo = heldTarget ?? (await holdAt('target', s.dragged));
  heldTarget = null;
  await letGo();
  await continueInWallet(page);
  await expect(note()).toHaveText(`The venue holds your target at ${s.dragged}.`, { timeout: 20_000 });
  // Read back from the venue: one take profit, the same order moved in place, at the new price.
  const targets = await until(
    () => exitsOf(owner, LONG, 'take_profit'),
    (list) => list.length === 1 && sameDecimal(list[0].trigger.price, s.dragged),
    'the venue holds the moved take profit',
  );
  expect(targets).toHaveLength(1);
  expect(targets[0].venueClientOrderId).toBe(before.venueClientOrderId);
  expect(targets[0]).toMatchObject({ side: 'sell', reduceOnly: true });
  expect(sameDecimal(targets[0].remaining, '1')).toBe(true);
  // One move, under its business key: prepared, then submitted once.
  expect(writes.filter((w) => w === 'protections/move')).toHaveLength(1);
  expect(writes.filter((w) => w === 'submit')).toHaveLength(1);
  // The line and the strip show the new figures.
  const basis = await basisOf(s, LONG);
  await expect(line('target')).toHaveAttribute('data-held', targets[0].trigger.price);
  await expect(line('target')).toHaveAttribute('data-net', fromUnits(netAt(basis, s.dragged)));
  await expect(strip().getByTestId('venue-risk-targets')).toHaveAttribute('data-value', fromUnits(netAt(basis, s.dragged)));
  expect(await ledgerView(s.account)).toEqual(s.ledger);
  await stepPicture(page);
});

test(`${J} #4 drags the stop line closer and lets go while the venue refuses the move: the venue's reason in words, the line back at the price the venue still holds, the strip unchanged, and the stop never shown at the refused price`, async ({
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const s = state();
  const owner = ownerOf(s);
  const switched = await testVenue('/test/account-switches', { owner, refuseTriggerMoves: REFUSAL });
  expect(switched.status, JSON.stringify(switched.body)).toBe(200);
  try {
    const stripBefore = await strip().innerText();
    const letGo = await holdAt('stop', '97.42');
    const refusedAt = await line('stop').getAttribute('data-price');
    expect(sameDecimal(refusedAt, STOP)).toBe(false);
    await letGo();
    await continueInWallet(page);
    await expect(note()).toHaveText(`The venue refused the move: ${REFUSAL} Your order stays where the venue holds it.`, {
      timeout: 20_000,
    });
    // The venue still holds the one stop where it was; the line is back there and never at the refused price.
    const stops = await exitsOf(owner, LONG, 'stop_loss');
    expect(stops).toHaveLength(1);
    expect(sameDecimal(stops[0].trigger.price, STOP)).toBe(true);
    await expect(line('stop')).toHaveAttribute('data-held', stops[0].trigger.price);
    await expect(line('stop')).toHaveAttribute('data-price', stops[0].trigger.price);
    await expect(line('stop')).toHaveAttribute('data-dragging', 'false');
    expect(
      Math.abs((await line('stop').boundingBox()).y + (await line('stop').boundingBox()).height / 2 - (await yOfPrice(STOP))),
    ).toBeLessThan(6);
    await expect(line('stop')).not.toContainText(refusedAt);
    await expect.poll(() => strip().innerText()).toBe(stripBefore);
    await stepPicture(page);
  } finally {
    await testVenue('/test/account-switches', { owner, refuseTriggerMoves: null });
  }
});

test(`${J} #6 presses Breakeven on the entry line on the chart while the mark has not passed the breakeven price: refused naming the breakeven price and the mark; nothing is sent and the stop stays where the venue holds it`, async ({
  stepPicture,
}) => {
  const s = state();
  const owner = ownerOf(s);
  await setMark(LONG, MARK);
  const basis = await basisOf(s, LONG);
  const breakeven = breakevenOf(basis, (await marketOf(LONG)).tickSize);
  // The mark has not passed it: a long's breakeven is above its entry, and the mark sits below.
  expect(toUnits(breakeven)).toBeGreaterThan(toUnits(MARK));
  const asked = signatures();
  const writes = doorWrites();
  await page
    .getByTestId('exit-line-entry-actions')
    .getByRole('button', { name: `Move the stop on ${LONG} to breakeven`, exact: true })
    .click();
  const refused = page.getByTestId('breakeven-note');
  await expect(refused).toHaveAttribute('data-tone', 'bad', { timeout: 20_000 });
  await expect(refused).toHaveAttribute('data-code', 'trade.protection_wrong_side');
  await expect(refused).toContainText(`Breakeven (${breakeven}) is on the wrong side of the mark price (now ${MARK})`);
  await expect(refused).toContainText('Nothing was prepared.');
  // Nothing sent: no submit and no signature; the venue's stop is where it was.
  expect(writes.filter((w) => w === 'submit')).toEqual([]);
  expect(signatures()).toBe(asked);
  const stops = await exitsOf(owner, LONG, 'stop_loss');
  expect(stops).toHaveLength(1);
  expect(sameDecimal(stops[0].trigger.price, STOP)).toBe(true);
  await expect(line('stop')).toHaveAttribute('data-held', stops[0].trigger.price);
  run.write({ breakeven });
  await stepPicture(page);
});

test(`${J} #5 presses Breakeven on the long's position row with the mark past breakeven: the stop moves to the entry adjusted by the venue's fee and ours in and out, rounded to the tick in the position's favour, the venue's stop reads it, and R at the stop reads 0 or better`, async ({
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const s = state();
  const owner = ownerOf(s);
  await setMark(LONG, '103');
  await page
    .getByTestId('venue-positions')
    .locator(`tr[data-symbol="${LONG}"]`)
    .getByRole('button', { name: `Breakeven ${LONG}`, exact: true })
    .click();
  // The old stop's cancel, then the new stop: each signed by the person.
  await continueInWallet(page);
  await continueInWallet(page);
  const basis = await basisOf(s, LONG);
  const note = page.getByTestId('breakeven-note');
  await expect(note).toHaveAttribute('data-tone', 'good', { timeout: 30_000 });
  await expect(note).toContainText(`Your stop rests at breakeven, ${s.breakeven}: the entry ${fromUnits(basis.entry)}`);
  // The venue holds one reduce-only stop for the whole position, at the breakeven worked here from its records.
  const stops = await until(
    () => exitsOf(owner, LONG, 'stop_loss'),
    (list) => list.length === 1 && sameDecimal(list[0].trigger.price, s.breakeven),
    'the venue holds one stop at breakeven',
  );
  expect(stops[0]).toMatchObject({ side: 'sell', reduceOnly: true });
  expect(sameDecimal(stops[0].remaining, '1')).toBe(true);
  // Rounded up to the tick: closing at it nets zero or better, one tick under it nets less than zero.
  const tick = toUnits((await marketOf(LONG)).tickSize);
  expect(netAt(basis, s.breakeven) >= 0n).toBe(true);
  expect(netAt(basis, fromUnits(toUnits(s.breakeven) - tick)) < 0n).toBe(true);
  await expect(line('stop')).toHaveAttribute('data-held', stops[0].trigger.price, { timeout: 15_000 });
  const r = await line('stop').getAttribute('data-r');
  expect(r).toBe(rOf(netAt(basis, s.breakeven), BigInt(s.riskAtStop)));
  expect(r.startsWith('-')).toBe(false);
  expect(await ledgerView(s.account)).toEqual(s.ledger);
  await stepPicture(page);
});

test(`${J} #7 switches the chart to the short and drags a new stop out from its entry line: a dollar loss while dragging, one reduce-only stop resting on the venue on letting go, and the strip's stop total with no position named as having no stop`, async ({
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const s = state();
  const owner = ownerOf(s);
  const { displayName } = await venueInfo();
  await page
    .getByTestId('venue-contract-list')
    .getByRole('button', { name: `${SHORT} · ${displayName}`, exact: true })
    .click();
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(SHORT, { timeout: 20_000 });
  await expect(line('entry')).toBeVisible({ timeout: 20_000 });
  await expect(line('stop')).toHaveCount(0);
  const writes = doorWrites();
  const letGo = await holdAt('entry', '104.18');
  const entry = line('entry');
  const at = await entry.getAttribute('data-price');
  const basis = await basisOf(s, SHORT);
  const loss = netAt(basis, at);
  expect(loss < 0n).toBe(true);
  await expect(entry).toHaveAttribute('data-net', fromUnits(loss));
  await expect(entry).toContainText(`New stop ${at} · -`);
  await expect(entry).toContainText('not sent');
  expect(writes).toEqual([]);
  await letGo();
  await continueInWallet(page);
  await expect(note()).toHaveText(`Your stop rests on the venue at ${at}, reduce-only for the whole position.`, { timeout: 20_000 });
  const stops = await until(
    () => exitsOf(owner, SHORT, 'stop_loss'),
    (list) => list.length === 1,
    'the venue holds the short’s new stop',
  );
  expect(stops[0]).toMatchObject({ side: 'buy', reduceOnly: true });
  expect(sameDecimal(stops[0].trigger.price, at) && sameDecimal(stops[0].remaining, '1')).toBe(true);
  await expect(line('stop')).toHaveAttribute('data-held', stops[0].trigger.price, { timeout: 15_000 });
  // Every position has a stop now: the strip's "If every stop hits" is a total, after fees, with no one named.
  const longStop = (await exitsOf(owner, LONG, 'stop_loss'))[0].trigger.price;
  const total = netAt(await basisOf(s, LONG), longStop) + netAt(basis, at);
  await expect(strip().getByTestId('venue-risk-stops')).toHaveAttribute('data-value', fromUnits(total), { timeout: 15_000 });
  await expect(strip().getByTestId('venue-risk-no-stop')).toHaveCount(0);
  expect(await ledgerView(s.account)).toEqual(s.ledger);
  await stepPicture(page);
});
