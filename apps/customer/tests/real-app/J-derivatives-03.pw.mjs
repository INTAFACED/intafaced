// World: book, gates, restart
import { createHash, randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, journeyState, tool, toUnits, fromUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  sameDecimal,
  testDeposit,
  testVenue,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-derivatives-03, in the running app: protect a position with take profits, stop losses, stops and a trailing stop, on
// the person's own venue account (the launch money model: the venue holds the position and the margin, the ledger posts
// nothing). The TEST perpetual ETH-PERP on the stack's TEST venue simulator is J-derivatives-03's alone: its mark is a
// TEST oracle price this file moves with /test/set-mark (a fill never moves it), its TEST index with /test/set-index, and
// #7 pulls its TEST bids with /test/pull-ladder; every one is put back after the file (packages/venue-sim). Every figure
// and word the desk shows is compared with the venue's own record, never typed here. One test per step, titled
// "J-derivatives-03 #<n>", run in order on one TEST account.
// World: the door switched on for this file (restart); ETH-PERP's TEST mark, index and ladder on the shared TEST venue
// (gates), each put back after the file; #6's second trade worker (restart). The desk's "Open long" is a book write.
const J = 'J-derivatives-03';
const SYMBOL = 'ETH-PERP';
const DESK = `/trade/futures?symbol=${SYMBOL}`;
const MARK = '3000';
const LEVERAGE = '5';
const VENUE_LABEL = 'Rests on the venue as its trigger order';
const ENGINE_LABEL = 'Runs on our engine under your agent permission';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
test.afterAll(async () => {
  await putBack().catch(() => undefined);
});

/** ETH-PERP as the stack starts it: its TEST mark and index at 3000 and the TEST makers' ladder resting. */
async function putBack() {
  await testVenue('/test/set-mark', { symbol: SYMBOL, price: MARK });
  await testVenue('/test/set-index', { symbol: SYMBOL, price: MARK });
  await testVenue('/test/seed', {});
}

async function setMark(price) {
  const moved = await testVenue('/test/set-mark', { symbol: SYMBOL, price });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
}

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return s;
}

const desk = async (page) => {
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(SYMBOL, { timeout: 20_000 });
  return { ...s, wallet, owner: wallet.address };
};

const market = async () => (await testVenue('/markets', {})).body.value.find((m) => m.symbol === SYMBOL);
const positionOf = async (owner) => (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === SYMBOL) ?? null;
const openOrders = async (owner) => (await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === SYMBOL);
const since = () => new Date(Date.now() - 3_600_000).toISOString();
const fillsOf = async (owner, cloid) =>
  (await venueRecord(owner, '/fills', { since: since() })).value.filter((f) => f.venueClientOrderId === cloid);
/** The venue's client order id of a business key, as the venue derives it (venue-contracts `venueClientOrderId`). */
const cloidOf = (venueId, key) => `0x${createHash('sha256').update(`${venueId}\u0000${key}`).digest('hex').slice(0, 32)}`;

/** Our record of the person's protections: the venue's trigger orders our door sent and our engine's stops. */
async function protections(owner) {
  const me = await api(state().account);
  const { status, body } = await me.get(`/api/v1/venue/protections?owner=${owner}`);
  expect(status, JSON.stringify(body)).toBe(200);
  return body.protections;
}

async function until(read, ok, what, ms = 20_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what}: still ${JSON.stringify(last)}`);
}

const row = (page) => page.getByTestId('venue-positions').locator(`tr[data-symbol="${SYMBOL}"]`);

/** The ticket filled for a market long of `size` ETH and Review pressed; the open signed, and the venue's fill awaited. */
async function openLong(page, size, extra = async () => {}) {
  const ticket = page.getByTestId('venue-ticket');
  await ticket.getByRole('button', { name: 'Long', exact: true }).click();
  await ticket.getByRole('button', { name: 'Market', exact: true }).click();
  await ticket.getByRole('textbox', { name: 'Size (ETH)' }).fill(size);
  await ticket.getByRole('textbox', { name: 'Worst price (slippage limit)' }).fill('3100');
  await extra(ticket);
  await ticket.getByRole('button', { name: 'Review long' }).click();
  const sheet = page.getByTestId('venue-review');
  await expect(sheet).toBeVisible();
  const approval = sheet.locator('[data-line="builder-approval"]');
  if ((await approval.count()) > 0 && !/Signed, up to/.test(await approval.innerText())) {
    await sheet.getByRole('button', { name: 'Approve our builder fee in your wallet' }).click();
    await continueInWallet(page);
    await expect(approval).toHaveText(/Signed, up to/, { timeout: 15_000 });
  }
  await sheet.getByRole('button', { name: 'Open long' }).click();
  await continueInWallet(page);
  await expect(sheet.getByTestId('venue-outcome').first()).toContainText('Filled on the venue.', { timeout: 15_000 });
  return sheet;
}

/** The position's protection dialog, from its row on the Positions table. */
async function protect(page) {
  await row(page)
    .getByRole('button', { name: `Protect ${SYMBOL}` })
    .click();
  const dialog = page.getByRole('dialog', { name: `Protect ${SYMBOL}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Choose a kind and a source, fill its fields, and press Arm protection; answers the create's response. */
async function arm(page, dialog, kind, source, fields) {
  await dialog.getByRole('button', { name: kind, exact: true }).click();
  await dialog.getByRole('button', { name: source, exact: true }).click();
  for (const [label, value] of fields) await dialog.getByRole('textbox', { name: label, exact: true }).fill(value);
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/v1/venue/protections') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Arm protection' }).click();
  return sent;
}

/** Arm a kind that rests on the venue: the person signs its trigger order in their wallet, and the venue takes it. */
async function armOnVenue(page, dialog, kind, source, fields) {
  const answer = await arm(page, dialog, kind, source, fields);
  expect(answer.status(), await answer.text()).toBe(200);
  expect((await answer.json()).restsOn).toBe('venue');
  await continueInWallet(page);
  await expect(dialog.getByTestId('protection-outcome')).toHaveText('Armed on the venue.', { timeout: 15_000 });
  return answer.request().postDataJSON();
}

const listed = (dialog) => dialog.getByRole('region', { name: 'Protections on this position' });
const item = (dialog, clientOrderId) => listed(dialog).locator(`li[data-client-order-id="${clientOrderId}"]`);

test(`${J} #1 sets a stop loss and a take profit for the whole position: both rest on the venue as its trigger orders, shown armed with their trigger and source`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  await putBack();
  const account = await signUp(page, 'jd3v');
  await verify(page, account);
  run.reset({ account, walletKey: testWalletKey() });
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const owner = wallet.address;
  expect(await testDeposit(owner, 'USDC', '3000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  // The journey's start: a TEST long of 1 ETH at 5x, open on the venue, from the futures desk.
  const margin = page.getByTestId('venue-margin');
  await margin.getByRole('textbox', { name: 'Leverage (times)' }).fill(LEVERAGE);
  await margin.getByRole('button', { name: 'Sign this leverage setting' }).click();
  await continueInWallet(page);
  await expect(margin.getByTestId('venue-outcome')).toContainText('The venue accepted it.', { timeout: 15_000 });
  const sheet = await openLong(page, '1');
  await sheet.getByRole('button', { name: 'Back', exact: true }).click();
  const position = await positionOf(owner);
  expect(position).toMatchObject({ side: 'long' });
  expect(sameDecimal(position.size, '1')).toBe(true);
  await expect(row(page)).toBeVisible({ timeout: 15_000 });

  // What the venue judges trigger orders on for ETH-PERP, as it publishes it.
  const m = await market();
  expect(m.triggerSources).toEqual(['mark', 'last']);
  const dialog = await protect(page);
  await expect(listed(dialog)).toContainText('No protection on this position yet.');
  await dialog.getByRole('button', { name: 'Take profit', exact: true }).click();
  await dialog.getByRole('button', { name: 'Mark', exact: true }).click();
  await expect(dialog.getByTestId('protection-where')).toHaveText(VENUE_LABEL);
  const tp = await armOnVenue(page, dialog, 'Take profit', 'Mark', [
    ['Size to close', '1'],
    ['Trigger price', '3100'],
  ]);
  const sl = await armOnVenue(page, dialog, 'Stop loss', 'Mark', [
    ['Size to close', '1'],
    ['Trigger price', '2900'],
  ]);
  expect(tp).toMatchObject({ kind: 'take_profit', side: 'sell', quantity: '1', triggerPrice: '3100', triggerSource: 'mark' });
  expect(sl).toMatchObject({ kind: 'stop_loss', side: 'sell', quantity: '1', triggerPrice: '2900', triggerSource: 'mark' });

  // Both rest on the venue as its trigger orders: reduce-only, waiting, each with its own venue order id.
  const resting = await openOrders(owner);
  const triggers = resting.filter((o) => o.trigger);
  expect(triggers.map((o) => [o.trigger.role, o.trigger.state, o.trigger.source, o.side, o.reduceOnly]).sort()).toEqual([
    ['stop_loss', 'waiting', 'mark', 'sell', true],
    ['take_profit', 'waiting', 'mark', 'sell', true],
  ]);
  expect(new Set(triggers.map((o) => o.venueOrderId)).size).toBe(2);
  const ours = await protections(owner);
  for (const [p, kind, price] of [
    [ours.find((x) => x.clientOrderId === tp.clientOrderId), 'take_profit', '3100'],
    [ours.find((x) => x.clientOrderId === sl.clientOrderId), 'stop_loss', '2900'],
  ]) {
    expect(p).toMatchObject({ kind, restsOn: 'venue', status: 'armed', triggerSource: 'mark', label: VENUE_LABEL });
    expect(sameDecimal(p.triggerPrice, price)).toBe(true);
    const onVenue = triggers.find((o) => o.venueOrderId === p.venueOrderId);
    expect(onVenue, `${kind} rests on the venue as its own trigger order`).toBeTruthy();
    // Shown armed, with its trigger and source, as the venue has it.
    const li = item(dialog, p.clientOrderId);
    await expect(li).toHaveAttribute('data-rests-on', 'venue');
    await expect(li).toHaveAttribute('data-venue-order-id', onVenue.venueOrderId);
    await expect(li).toContainText(`${kind === 'take_profit' ? 'Take profit' : 'Stop loss'} for 1: Armed`);
    await expect(li).toContainText(`triggers at ${price}, judged on the mark price`);
    await expect(li).toContainText(VENUE_LABEL);
  }
  run.write({ tp: tp.clientOrderId, sl: sl.clientOrderId });
});

test(`${J} #2 sets a take profit on the wrong side of the mark: refused with the reason; nothing stored`, async ({ page }) => {
  test.setTimeout(180_000);
  const { owner } = await desk(page);
  const before = await openOrders(owner);
  const ours = await protections(owner);
  const dialog = await protect(page);
  const signs = [];
  page.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/api/v1/venue/prepare') && signs.push(r.url()));
  // The mark is 3000; a take profit that sells at 2950 is below it, so it would fire at once.
  const answer = await arm(page, dialog, 'Take profit', 'Mark', [
    ['Size to close', '1'],
    ['Trigger price', '2950'],
  ]);
  expect(answer.status()).toBe(400);
  expect((await answer.json()).error).toBe('trade.protection_wrong_side');
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText(
    'That price is on the wrong side of the mark price (now 3000): it must be above it. Nothing was saved.',
  );
  await expect(alert).toContainText('Code: trade.protection_wrong_side');
  // Nothing stored and nothing built: no wallet sheet, nothing prepared, the venue's orders and ours as they were.
  await expect(page.getByRole('dialog', { name: 'Check before you sign' })).toHaveCount(0);
  expect(signs).toHaveLength(0);
  expect(await openOrders(owner)).toEqual(before);
  expect((await protections(owner)).length).toBe(ours.length);
});

test(`${J} #3 sets a part take profit: the size it covers and the remainder shown`, async ({ page }) => {
  test.setTimeout(180_000);
  const { owner } = await desk(page);
  const dialog = await protect(page);
  await dialog.getByRole('button', { name: 'Take profit', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Size to close', exact: true }).fill('0.4');
  await expect(dialog.getByTestId('protection-covers')).toHaveText('Covers 0.4 of 1; 0.6 not covered by it');
  const part = await armOnVenue(page, dialog, 'Take profit', 'Mark', [
    ['Size to close', '0.4'],
    ['Trigger price', '3150'],
  ]);
  const li = item(dialog, part.clientOrderId);
  await expect(li).toContainText('Take profit for 0.4: Armed');
  await expect(li).toContainText('Covers 0.4 of 1; 0.6 not covered by it');
  await expect(item(dialog, state().sl)).toContainText('Covers the whole position');
  const onVenue = (await openOrders(owner)).find((o) => o.trigger && o.trigger.price === '3150');
  expect(onVenue).toMatchObject({ reduceOnly: true, trigger: { role: 'take_profit', state: 'waiting' } });
  expect(sameDecimal(onVenue.amount, '0.4')).toBe(true);
  run.write({ part: part.clientOrderId });
});

test(`${J} #4 attaches a take profit and a stop loss to an entry order: the entry opens, then they arm on the filled size`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner } = await desk(page);
  const before = await positionOf(owner);
  const sheet = await openLong(page, '0.5', async (ticket) => {
    await ticket.getByRole('textbox', { name: 'Take profit (optional)' }).fill('3200');
    await ticket.getByRole('textbox', { name: 'Stop loss (optional)' }).fill('2850');
  });
  // The entry opened first; then the person signs the two protections, attached to it, in their wallet.
  await continueInWallet(page);
  await continueInWallet(page);
  await expect(sheet.getByTestId('venue-attached')).toHaveText('Take profit and stop loss set on the 0.5 this order filled', {
    timeout: 15_000,
  });
  const after = await positionOf(owner);
  expect(fromUnits(toUnits(after.size))).toBe(fromUnits(toUnits(before.size) + toUnits('0.5')));
  // On the venue: two trigger orders attached to the entry, each sized to what it filled.
  const { id: venueId } = await venueInfo();
  const attached = (await openOrders(owner)).filter((o) => o.parentClientOrderId);
  expect(attached.map((o) => [o.trigger.role, o.trigger.price]).sort()).toEqual([
    ['stop_loss', '2850'],
    ['take_profit', '3200'],
  ]);
  const entryCloid = attached[0].parentClientOrderId;
  expect(attached.every((o) => o.parentClientOrderId === entryCloid && sameDecimal(o.amount, '0.5'))).toBe(true);
  const entry = (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId: entryCloid })).value;
  expect(entry).toMatchObject({ status: 'filled', reduceOnly: false, side: 'buy' });
  expect(sameDecimal(entry.filled, '0.5')).toBe(true);
  // Ours read the same: attached to the entry, on the filled size.
  const ours = (await protections(owner)).filter((p) => p.parentClientOrderId === entryCloid);
  expect(ours.map((p) => [p.kind, p.status, p.quantity]).sort()).toEqual([
    ['stop_loss', 'armed', '0.5'],
    ['take_profit', 'armed', '0.5'],
  ]);
  expect(venueId).toBeTruthy();
});

test(`${J} #5 places a stop market, a stop limit and a trailing stop with a trigger source: the venue's kinds rest there, the trailing stop and the index run on our engine under the agent permission, labelled so; a field a kind does not take and an exit that would enlarge are refused`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner } = await desk(page);
  const dialog = await protect(page);
  // A stop market judged on the last trade, and a stop limit judged on the mark: kinds the venue offers, resting there.
  const market = await armOnVenue(page, dialog, 'Stop market', 'Last trade', [
    ['Size to close', '0.2'],
    ['Trigger price', '2800'],
  ]);
  const limit = await armOnVenue(page, dialog, 'Stop limit', 'Mark', [
    ['Size to close', '0.2'],
    ['Trigger price', '2790'],
    ['Limit price', '2780'],
  ]);
  for (const [p, kind, source] of [
    [market, 'Stop market', 'last traded price'],
    [limit, 'Stop limit', 'mark price'],
  ]) {
    const li = item(dialog, p.clientOrderId);
    await expect(li).toHaveAttribute('data-rests-on', 'venue');
    await expect(li).toContainText(`${kind} for 0.2: Armed`);
    await expect(li).toContainText(`judged on the ${source}`);
    await expect(li).toContainText(VENUE_LABEL);
  }
  const resting = await openOrders(owner);
  expect(resting.find((o) => o.trigger?.price === '2800')).toMatchObject({
    type: 'market',
    trigger: { source: 'last', role: 'stop_loss' },
  });
  expect(resting.find((o) => o.trigger?.price === '2790')).toMatchObject({ type: 'limit', price: '2780', trigger: { source: 'mark' } });

  // A trailing stop the venue lacks runs on our engine, under the agent permission the person signs once.
  await dialog.getByRole('button', { name: 'Trailing stop', exact: true }).click();
  await dialog.getByRole('button', { name: 'Mark', exact: true }).click();
  await expect(dialog.getByTestId('protection-where')).toHaveText(ENGINE_LABEL);
  const permission = dialog.getByRole('region', { name: 'Agent permission' });
  await expect(permission).toContainText(
    'Our engine sends the closing order with an agent key you approve on the venue. It can only trade, never withdraw.',
  );
  await permission.getByRole('button', { name: 'Approve the agent permission in your wallet' }).click();
  await continueInWallet(page);
  await expect(permission).toContainText('Approved on the venue.', { timeout: 15_000 });
  const me = await api(state().account);
  const agent = (await me.get(`/api/v1/venue/protection-agent?owner=${owner}`)).body;
  expect(agent).toMatchObject({ approved: true, agentName: 'protections' });
  expect((await venueRecord(owner, '/agents')).value.map((a) => a.address)).toContain(agent.agentAddress);
  const trailing = await arm(page, dialog, 'Trailing stop', 'Mark', [
    ['Size to close', '0.2'],
    ['Trailing distance', '150'],
  ]);
  expect(trailing.status(), await trailing.text()).toBe(201);
  const trailingBody = await trailing.json();
  expect(trailingBody.protection).toMatchObject({
    kind: 'trailing_stop',
    restsOn: 'engine',
    venueOrderId: null,
    agentPermission: { agentAddress: agent.agentAddress },
    label: ENGINE_LABEL,
    status: 'armed',
  });
  expect(trailing.request().postDataJSON().triggerPrice).toBeUndefined();
  await expect(item(dialog, trailingBody.protection.clientOrderId)).toContainText('Trailing stop for 0.2: Armed');
  await expect(item(dialog, trailingBody.protection.clientOrderId)).toContainText(ENGINE_LABEL);

  // A stop judged on the index: the venue judges no trigger on it, so it too runs on our engine, on the venue's index.
  expect((await market()).index).toMatchObject({ known: true });
  await dialog.getByRole('button', { name: 'Stop market', exact: true }).click();
  await dialog.getByRole('button', { name: 'Index', exact: true }).click();
  await expect(dialog.getByTestId('protection-where')).toHaveText(ENGINE_LABEL);
  const index = await arm(page, dialog, 'Stop market', 'Index', [
    ['Size to close', '0.2'],
    ['Trigger price', '2700'],
  ]);
  expect(index.status(), await index.text()).toBe(201);
  const indexBody = await index.json();
  expect(indexBody.protection).toMatchObject({ kind: 'stop_market', triggerSource: 'index', restsOn: 'engine', label: ENGINE_LABEL });
  await expect(item(dialog, indexBody.protection.clientOrderId)).toContainText('judged on the index price');

  // Through the API, each kind refuses a field it does not take, with a 400 and the code; nothing is stored.
  const base = { owner, symbol: SYMBOL, side: 'sell', quantity: '0.1', triggerSource: 'mark' };
  const extras = [
    ['stop_market', { triggerPrice: '2800', limitPrice: '2790' }],
    ['stop_market', { triggerPrice: '2800', trailingDistance: '100' }],
    ['stop_limit', { triggerPrice: '2800', limitPrice: '2790', trailingDistance: '100' }],
    ['trailing_stop', { trailingDistance: '100', triggerPrice: '2800' }],
    ['trailing_stop', { trailingDistance: '100', limitPrice: '2790' }],
    ['take_profit', { triggerPrice: '3300', limitPrice: '3290' }],
    ['take_profit', { triggerPrice: '3300', trailingDistance: '100' }],
  ];
  const count = (await protections(owner)).length;
  for (const [i, [kind, fields]] of extras.entries()) {
    const extra = await me.post('/api/v1/venue/protections', { ...base, kind, ...fields, clientOrderId: `${J}-extra-${i}-${Date.now()}` });
    expect(extra.status, `${kind} ${Object.keys(fields).join('+')}: ${JSON.stringify(extra.body)}`).toBe(400);
    expect(extra.body).toMatchObject({ error: 'trade.conditional_field_unsupported' });
  }
  // An exit that would open or enlarge (a buy, on a long) is refused before anything is built.
  const enlarge = await me.post('/api/v1/venue/protections', {
    ...base,
    side: 'buy',
    kind: 'stop_market',
    triggerPrice: '3300',
    clientOrderId: `${J}-enlarge-${Date.now()}`,
  });
  expect(enlarge.status, JSON.stringify(enlarge.body)).toBe(400);
  expect(enlarge.body).toMatchObject({ error: 'trade.conditional_would_increase' });
  expect((await protections(owner)).length).toBe(count);
  run.write({ trailing: trailingBody.protection.id, index: indexBody.protection.id });
});

test(`${J} #6 the mark crosses the trigger: the venue fires it once and the position closes on the venue; a stop on our engine is sent once, even with two workers`, async ({
  page,
}) => {
  test.setTimeout(360_000);
  const { owner } = await desk(page);
  const { id: venueId } = await venueInfo();
  const before = await positionOf(owner);
  expect(sameDecimal(before.size, '1.5')).toBe(true);
  const ours = await protections(owner);
  const engineStops = ours.filter((p) => p.restsOn === 'engine' && p.status === 'armed');
  expect(engineStops).toHaveLength(2);
  // The engine's stops are cancelled first, so the venue alone closes this position.
  const me = await api(state().account);
  for (const p of engineStops) expect((await me.delete(`/api/v1/venue/protections/${p.id}`)).status).toBe(200);

  // The mark crosses 3200: the take profits at 3100, 3150 and 3200 are crossed. The venue fires each once, in the
  // order they were placed, for no more than the position still holds, until it is closed; then every other leg is
  // cancelled with it.
  await setMark('3250');
  await expect.poll(async () => await positionOf(owner), { timeout: 15_000 }).toBeNull();
  const venueOnes = (await protections(owner)).filter((p) => p.restsOn === 'venue');
  const fired = venueOnes.filter((p) => p.status === 'filled');
  expect(fired.map((p) => p.kind).every((k) => k === 'take_profit')).toBe(true);
  let sold = 0n;
  for (const p of fired) {
    const fills = await fillsOf(owner, p.venueClientOrderId);
    // Once: one reduce-only sell each, on the venue.
    expect(fills.length, `${p.clientOrderId} fired once`).toBe(1);
    expect(fills[0].side).toBe('sell');
    sold += toUnits(fills[0].amount);
  }
  // It closed the position on the venue, and no more: what the venue sold is what was open.
  expect(fromUnits(sold)).toBe(fromUnits(toUnits(before.size)));
  const others = venueOnes.filter((p) => p.status !== 'filled');
  expect(others.length > 0).toBe(true);
  for (const p of others) expect(p).toMatchObject({ status: 'cancelled', cancelReason: 'position_closed' });
  expect((await openOrders(owner)).filter((o) => o.trigger)).toEqual([]);
  // The mark crossing again fires nothing more.
  await setMark('3300');
  for (const p of fired) expect(await fillsOf(owner, p.venueClientOrderId)).toHaveLength(1);

  // On our engine: a new long of 1 and a trailing stop of 50 under the agent permission, judged on the mark, with two
  // trade workers running. The mark rises to 3350 and falls to 3290, past its trigger (3300): it is sent once.
  await setMark(MARK);
  await testVenue('/test/seed', {});
  await page.goto(DESK);
  await expect(page.getByTestId('venue-wallet-address')).toBeVisible({ timeout: 30_000 });
  const sheet = await openLong(page, '1');
  await sheet.getByRole('button', { name: 'Back', exact: true }).click();
  const dialog = await protect(page);
  const trail = await arm(page, dialog, 'Trailing stop', 'Mark', [
    ['Size to close', '1'],
    ['Trailing distance', '50'],
  ]);
  expect(trail.status(), await trail.text()).toBe(201);
  const stop = (await trail.json()).protection;
  tool('local-test-stack.mjs', 'second-worker', 'trade', 'start');
  try {
    await setMark('3350');
    await expect
      .poll(async () => (await protections(owner)).find((p) => p.id === stop.id)?.currentTrigger, { timeout: 20_000 })
      .toBe('3300');
    await setMark('3290');
    const done = await until(
      async () => (await protections(owner)).find((p) => p.id === stop.id),
      (p) => p?.status === 'filled',
      'the trailing stop on our engine',
      30_000,
    );
    // Sent once: one reduce-only order under its one key, one fill, and the position closed on the venue.
    const key = `protection:fire:${stop.id}`;
    expect(done.venueClientOrderId).toBe(cloidOf(venueId, key));
    await new Promise((r) => setTimeout(r, 4_000));
    const fills = await fillsOf(owner, done.venueClientOrderId);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ side: 'sell' });
    expect(sameDecimal(fills[0].amount, '1')).toBe(true);
    const order = (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId: done.venueClientOrderId })).value;
    expect(order).toMatchObject({ reduceOnly: true, type: 'market', status: 'filled' });
    expect(await positionOf(owner)).toBeNull();
  } finally {
    tool('local-test-stack.mjs', 'second-worker', 'trade', 'stop');
  }
});

test(`${J} #7 a triggered order fails: the failure reason in words and what happened to the position`, async ({ page }) => {
  test.setTimeout(300_000);
  const { owner } = await desk(page);
  await setMark(MARK);
  await testVenue('/test/seed', {});
  const sheet = await openLong(page, '1');
  await sheet.getByRole('button', { name: 'Back', exact: true }).click();
  const dialog = await protect(page);
  const sl = await armOnVenue(page, dialog, 'Stop loss', 'Mark', [
    ['Size to close', '1'],
    ['Trigger price', '2900'],
  ]);
  // No one is buying: the TEST makers' bids are pulled; then the mark falls through the stop.
  const pulled = await testVenue('/test/pull-ladder', { symbol: SYMBOL, side: 'bid' });
  expect(pulled.status, JSON.stringify(pulled.body)).toBe(200);
  try {
    await setMark('2890');
    const failed = await until(
      async () => (await protections(owner)).find((p) => p.clientOrderId === sl.clientOrderId),
      (p) => p?.status === 'failed',
      'the stop loss that found no buyer',
    );
    const order = (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId: failed.venueClientOrderId })).value;
    expect(order.trigger).toMatchObject({ state: 'failed' });
    expect(failed.failure).toBe(order.trigger.failure);
    // What happened to the position: nothing closed; it is open as it was.
    const position = await positionOf(owner);
    expect(position).toMatchObject({ side: 'long' });
    expect(sameDecimal(position.size, '1')).toBe(true);
    const li = item(dialog, sl.clientOrderId);
    await expect(li).toHaveAttribute('data-status', 'failed', { timeout: 15_000 });
    await expect(li).toContainText(`Failed: ${order.trigger.failure}.`);
    await expect(li).toContainText('Nothing was closed: the position is still 1 ETH long.');
  } finally {
    await testVenue('/test/seed', {});
  }
});

test(`${J} #8 uses reduce-only and a linked take profit and stop loss: reduce-only is refused with no opposite position; one leg's fill cancels the other`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner } = await desk(page);
  await setMark(MARK);
  // A linked pair on the long #7 left open: the stop loss fills, and the take profit is cancelled with the position.
  const dialog = await protect(page);
  const tp = await armOnVenue(page, dialog, 'Take profit', 'Mark', [
    ['Size to close', '1'],
    ['Trigger price', '3100'],
  ]);
  const sl = await armOnVenue(page, dialog, 'Stop loss', 'Mark', [
    ['Size to close', '1'],
    ['Trigger price', '2950'],
  ]);
  await setMark('2940');
  const [tpRead, slRead] = await until(
    async () => {
      const all = await protections(owner);
      return [all.find((p) => p.clientOrderId === tp.clientOrderId), all.find((p) => p.clientOrderId === sl.clientOrderId)];
    },
    ([t, s]) => s?.status === 'filled' && t?.status === 'cancelled',
    'the linked pair',
  );
  expect(tpRead).toMatchObject({ status: 'cancelled', cancelReason: 'position_closed' });
  expect(await fillsOf(owner, slRead.venueClientOrderId)).toHaveLength(1);
  expect(await fillsOf(owner, tpRead.venueClientOrderId)).toHaveLength(0);
  expect(await positionOf(owner)).toBeNull();
  await expect(item(dialog, tp.clientOrderId)).toContainText('Cancelled: the position it closed is gone.', { timeout: 15_000 });
  await page.keyboard.press('Escape');

  // Reduce-only with no position to reduce: the venue refuses it, naming why, and nothing opens.
  await setMark(MARK);
  const ticket = page.getByTestId('venue-ticket');
  await ticket.getByRole('button', { name: 'Short', exact: true }).click();
  await ticket.getByRole('button', { name: 'Market', exact: true }).click();
  await ticket.getByRole('textbox', { name: 'Size (ETH)' }).fill('0.5');
  await ticket.getByRole('textbox', { name: 'Worst price (slippage limit)' }).fill('2900');
  await ticket.getByRole('checkbox', { name: 'Reduce-only' }).check();
  await ticket.getByRole('button', { name: 'Review short' }).click();
  const sheet = page.getByTestId('venue-review');
  await sheet.getByRole('button', { name: 'Open short' }).click();
  await continueInWallet(page);
  await expect(sheet.getByTestId('venue-outcome').first()).toContainText('reduce-only order would open or grow a position', {
    timeout: 15_000,
  });
  expect(await positionOf(owner)).toBeNull();
});

test(`${J} #9 presses one-tap reverse: one reviewed close and open in the opposite direction, as one idempotent request`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner, wallet } = await desk(page);
  await setMark(MARK);
  await testVenue('/test/seed', {});
  const opened = await openLong(page, '1');
  await opened.getByRole('button', { name: 'Back', exact: true }).click();
  await row(page)
    .getByRole('button', { name: `Reverse ${SYMBOL}` })
    .click();
  const review = page.getByRole('dialog', { name: `Reverse ${SYMBOL}` });
  await expect(review).toContainText('Close 1 ETH long, then open 1 ETH short');
  // The TEST venue takes one order per signed action, so the close and the open are each signed, under one request.
  await expect(review).toContainText('This venue takes one order per signature: you sign the close, then the open.');
  const signedBefore = wallet.requests.length;
  const prepares = [];
  page.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/api/v1/venue/prepare') && prepares.push(r.postDataJSON()));
  // Two presses in the same moment: one reverse.
  await review.getByRole('button', { name: 'Sign the reverse' }).evaluate((b) => {
    b.click();
    b.click();
  });
  await continueInWallet(page);
  await continueInWallet(page);
  await expect(review.getByTestId('reverse-outcome')).toHaveText('Reversed: now 1 ETH short.', { timeout: 20_000 });
  expect(wallet.requests.length - signedBefore).toBe(2);
  // One idempotent request: the close and the open carry the one reverse key, once each.
  const keys = prepares.map((p) => p.intent.clientOrderKey);
  expect(new Set(keys).size).toBe(2);
  const reverseKey = keys[0].replace(/:close$|:open$/, '');
  expect(keys.sort()).toEqual([`${reverseKey}:close`, `${reverseKey}:open`]);
  const [close, open] = [
    prepares.find((p) => p.intent.clientOrderKey.endsWith(':close')),
    prepares.find((p) => p.intent.clientOrderKey.endsWith(':open')),
  ];
  expect(close.intent).toMatchObject({ side: 'sell', reduceOnly: true, amount: '1' });
  expect(open.intent).toMatchObject({ side: 'sell', reduceOnly: false, amount: '1' });
  const position = await positionOf(owner);
  expect(position).toMatchObject({ side: 'short' });
  expect(sameDecimal(position.size, '1')).toBe(true);
  const { id: venueId } = await venueInfo();
  for (const key of keys) expect(await fillsOf(owner, cloidOf(venueId, key))).toHaveLength(1);
});
