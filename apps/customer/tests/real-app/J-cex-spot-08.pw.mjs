// World: book, gates, restart, stack
import { createHash, randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fromUnits, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { ownSpotMarket } from './own-market.mjs';
import {
  continueInWallet,
  openVenueDesk,
  otherTraderKey,
  otherTraderRun,
  sameDecimal,
  testDeposit,
  testVenue,
  venueAccount,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-cex-spot-08 on the venue model (row d115, 17 Nov 2026; docs/roadmap/journeys.json; project-state operation-zero/
// modules/cex-spot/acceptance/journeys.md): a person protects what they hold with stops, an OCO and a bracket on their own
// venue account. One test per step, titled "J-cex-spot-08 #<n>", run in order on one TEST account.
//
// INTAFACED holds none of this person's money: with svc-trade's user-venue door on for this file (venueForThisFile), every
// balance, lock, order and fill is read from the stack's TEST venue simulator (packages/venue-sim), never from the page,
// and the ledger is read before and after to show it posts nothing. Whether the venue holds a stop on spot is the
// market's own declaration (`triggerSources`); the TEST venue declares none on cash spot, so every stop kind here is one
// it lacks, held by our engine and sent once under the agent permission the person signs, labelled as run by INTAFACED.
// The person trades a TEST spot market of this file's own (ownSpotMarket), whose TEST coin stands in for the Starts
// line's TEST BTC: a step that prices off a book owns that book (garden/no-shared-market-on-book). Two other TEST traders
// make its last trade (the price a stop here is judged on) and take its orders. Every figure is TEST.
const J = 'J-cex-spot-08';
const ENGINE = 'Run by INTAFACED on our engine under your agent permission';
/** The stack runs our engine's pass each second (TRADE_PROTECTION_ENGINE_INTERVAL_MS). */
const ENGINE_WAIT = 20_000;
const MAKER = 'js8-maker';
const TAKER = 'js8-taker';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey || !s.market)
    throw new Error(`${J} #1 made no account, wallet and market, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}
const desk = (s) => `/trade/spot/${s.market.symbol}`;

// ── the venue's own records ──

const balanceOf = async (owner, asset) =>
  (await venueRecord(owner, '/balances')).value.find((b) => b.asset === asset) ?? { asset, free: '0', locked: '0', total: '0' };
const openOn = async (s) => (await venueRecord(s.owner, '/open-orders')).value.filter((o) => o.symbol === s.market.symbol);
const venueOrder = async (s, venueClientOrderId) => (await venueRecord(s.owner, '/order-by-client-id', { venueClientOrderId })).value;
const fillsOf = async (s, venueClientOrderId) =>
  (await venueRecord(s.owner, '/fills', { since: new Date(Date.now() - 3_600_000).toISOString() })).value.filter(
    (f) => f.venueClientOrderId === venueClientOrderId,
  );
/** The venue's client order id of a business key, as the venue derives it (venue-contracts `venueClientOrderId`). */
const cloidOf = (venueId, key) => `0x${createHash('sha256').update(`${venueId}\u0000${key}`).digest('hex').slice(0, 32)}`;
const fireKey = (s, clientId) => `spot-cond:fire:${s.owner}:${clientId}`;
const legKey = (s, clientId, leg) => `spot-cond:${s.owner}:${clientId}:${leg}`;
const ledgerView = async (who) => (await api(who)).balances();

/** svc-trade's record of the person's conditional spot orders: our engine's state and each leg as the venue reads it. */
async function conditionals(s) {
  const { status, body } = await (await api(s.account)).get(`/api/v1/venue/spot-orders?owner=${s.owner}`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.orders;
}
const conditional = async (s, clientId) => (await conditionals(s)).find((o) => o.clientOrderId === clientId);
async function untilStatus(s, clientId, wanted, ms = ENGINE_WAIT) {
  await expect.poll(async () => (await conditional(s, clientId))?.status, { timeout: ms }).toBe(wanted);
  return conditional(s, clientId);
}

// ── the other TEST traders: they sign on the TEST venue directly, as outside participants would ──

const traderOwner = (name) => otherTraderKey(name).address.toLowerCase();
const restingOf = {};
async function traderOrder(name, s, side, price, amount, timeInForce) {
  const key = `order:${traderOwner(name)}:js8-${randomBytes(4).toString('hex')}`;
  const answer = await otherTraderRun(name, {
    kind: 'place_order',
    symbol: s.market.symbol,
    side,
    type: 'limit',
    amount,
    price,
    timeInForce,
    reduceOnly: false,
    clientOrderKey: key,
    builderFee: null,
  });
  expect(answer, JSON.stringify(answer).slice(0, 300)).toMatchObject({ accepted: true });
  if (timeInForce === 'GTC' && answer.order.status !== 'filled') (restingOf[name] ??= []).push(key);
  return { ...answer.order, key };
}
/** Whatever the other traders still rest on the file's market is taken off, so the next step's book is only its own. */
async function clearTraders(s) {
  for (const name of [MAKER, TAKER]) {
    for (const key of restingOf[name] ?? []) {
      await otherTraderRun(name, { kind: 'cancel_order', symbol: s.market.symbol, clientOrderKey: key }).catch(() => undefined);
    }
    restingOf[name] = [];
  }
}
/** One TEST trade at `price` between the other traders: the venue's last trade, which a stop here is judged on. */
async function lastTradeAt(s, price) {
  const made = await traderOrder(MAKER, s, 'sell', price, '0.1', 'GTC');
  const taken = await traderOrder(TAKER, s, 'buy', price, '0.1', 'IOC');
  expect(taken.status, 'the TEST print traded').toBe('filled');
  restingOf[MAKER] = (restingOf[MAKER] ?? []).filter((k) => k !== made.key);
}

// ── the desk's conditional orders ──

const panel = (page) => page.getByRole('region', { name: 'Conditional orders', exact: true });
const pending = (page) => panel(page).getByTestId('spot-conditional-pending');
const row = (page, clientId) => pending(page).locator(`tr[data-client-order-id="${clientId}"]`);
const cell = (page, clientId, name) => row(page, clientId).locator(`td[data-cell="${name}"]`);
const leg = (page, clientId, role) => row(page, clientId).locator(`li[data-leg="${role}"]`);
const refusal = (page) => panel(page).getByTestId('spot-conditional-refusal');
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;

/** The panel's form filled for `kind` on `side`, each field by its label. Returns the client id the form will send. */
async function fill(page, s, kind, side, fields) {
  const p = panel(page);
  await p.getByRole('group', { name: 'Kind of conditional order', exact: true }).getByRole('button', { name: kind, exact: true }).click();
  await p.getByRole('group', { name: 'Side', exact: true }).getByRole('button', { name: side, exact: true }).click();
  for (const [label, value] of Object.entries(fields)) {
    if (label === 'Entry time in force') {
      await p.getByRole('group', { name: label, exact: true }).getByRole('button', { name: value, exact: true }).click();
      continue;
    }
    const name = label === 'Size' ? `Size (${s.market.base})` : label;
    await p.getByRole('textbox', { name, exact: true }).fill(value);
  }
  return p.getByTestId('spot-conditional-form').getAttribute('data-client-order-id');
}

/** Place order pressed; answers svc-trade's response to the create. */
async function placeOrder(page) {
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/v1/venue/spot-orders') && r.request().method() === 'POST');
  await panel(page).getByRole('button', { name: 'Place order', exact: true }).click();
  return sent;
}

/** Placed on our engine: 201, the outcome in words, and the order listed pending with its label. */
async function placeOnEngine(page, words = 'Placed. Run by INTAFACED on our engine under your agent permission.') {
  const answer = await placeOrder(page);
  expect(answer.status(), await answer.text()).toBe(201);
  const body = await answer.json();
  expect(body).toMatchObject({ restsOn: 'engine', conditional: { label: ENGINE, restsOn: 'engine' } });
  if (body.entry) await continueInWallet(page);
  await expect(panel(page).getByTestId('spot-conditional-outcome')).toHaveText(words, { timeout: 15_000 });
  return body.conditional;
}

/** The desk, signed in with the TEST wallet connected, the conditional orders panel on screen. */
async function openDesk(page, s) {
  const wallet = await openVenueDesk(page, s.account, desk(s), s.walletKey);
  await expect(panel(page)).toBeVisible({ timeout: 30_000 });
  await expect(panel(page).getByTestId('spot-conditional-where')).toHaveText(ENGINE);
  return wallet;
}

/** A step's own order cancelled from the pending list, when a check before it failed and left it live. */
async function cancelLeft(s) {
  const me = await api(s.account);
  for (const o of await conditionals(s)) {
    if (['entry', 'placing', 'open', 'armed'].includes(o.status) || (o.status === 'fired' && o.kind === 'stop_limit')) {
      await me.delete(`/api/v1/venue/spot-orders/${o.id}`);
    }
  }
  await clearTraders(s);
}

/**
 * TEST setup, not a step (the Starts line), made at the start of #1, never in a beforeAll (a worker that restarts after
 * a failed step would run a beforeAll again and replace the account later steps act as): a verified account, this run's
 * TEST wallet, the file's own TEST spot market, TEST coin and TEST USDC in the person's venue account by the TEST venue's
 * deposit control (keyed by chain-transfer-shaped references), our builder fee approved once by the person's wallet (a
 * spot sell carries it), and the two other TEST traders funded.
 */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const who = await signUp(page, 'js8v');
    await verify(page, who);
    const walletKey = testWalletKey();
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    const market = await ownSpotMarket(J, 'JSE', 'A');
    const ref = () => `84532:0x${randomBytes(32).toString('hex')}:0`;
    expect(await testDeposit(owner, market.base, '10', ref())).toBe(true);
    expect(await testDeposit(owner, 'USDC', '5000', ref())).toBe(true);
    for (const name of [MAKER, TAKER]) {
      for (const [asset, amount] of [
        [market.base, '50'],
        ['USDC', '50000'],
      ]) {
        const funded = await testVenue('/test/deposit', {
          account: await venueAccount(traderOwner(name)),
          asset,
          amount,
          depositRef: `seed:${name}:${market.symbol}:${asset}`,
        });
        expect(funded.status, JSON.stringify(funded.body)).toBe(200);
      }
    }
    const session = await api(who);
    const status = (await session.get('/api/v1/venue/status')).body;
    expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
    const s = { account: who, walletKey, owner, market };
    await throughUs(
      s,
      { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
      `builder-approval:${owner}:${J}`,
    );
    run.reset({ account: who, walletKey, market, ledgerStart: await session.balances() });
  } finally {
    await page.close();
  }
}

/** One action prepared by svc-trade's door, signed by the person's own wallet key, and sent (TEST setup only). */
async function throughUs(s, intent, actionKey) {
  const session = await api(s.account);
  const key = privateKeyToAccount(s.walletKey);
  let prepared;
  await expect(async () => {
    prepared = await session.post('/api/v1/venue/prepare', {
      owner: s.owner,
      signer: { role: 'owner', address: s.owner },
      intent,
      actionKey,
    });
    expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  }).toPass({ timeout: 30_000, intervals: [2_000] });
  const t = prepared.body.prepared.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await session.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: prepared.body.prepared.digest, signature, signedBy: s.owner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome).toMatchObject({ definite: true, accepted: true });
}

test(`${J} #1 places a stop-limit with a trigger and a limit: the trigger is stored, the venue locks the funds, the order is not on the book, and cancel releases them; a kind the venue doesn't hold runs on our engine under the agent permission, labelled as run by INTAFACED`, async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  await startsLine(browser);
  const s = state();
  const { id: venueId } = await venueInfo();
  // Whether the venue holds a stop on this spot market is its own declaration: the TEST venue declares none on cash spot.
  const declared = (await testVenue('/markets', {})).body.value.find((m) => m.symbol === s.market.symbol);
  expect(declared).toMatchObject({ kind: 'spot', triggerSources: [] });
  await lastTradeAt(s, '100');
  const wallet = await openDesk(page, s);
  const p = panel(page);
  await expect(
    p.getByRole('group', { name: 'Kind of conditional order', exact: true }).getByRole('button', { name: 'Stop limit', exact: true }),
  ).toBeEnabled();

  // The agent permission, signed once in the person's wallet: the venue lists the key our engine signs with.
  const permission = p.getByRole('region', { name: 'Agent permission', exact: true });
  await expect(permission).toContainText(
    'Our engine sends these orders with an agent key you approve on the venue. It can only trade, never withdraw.',
  );
  await permission.getByRole('button', { name: 'Approve the agent permission in your wallet', exact: true }).click();
  await continueInWallet(page);
  await expect(permission.getByRole('status')).toHaveText('Approved on the venue.', { timeout: 15_000 });
  const agent = (await (await api(s.account)).get(`/api/v1/venue/spot-agent?owner=${s.owner}`)).body;
  expect(agent).toMatchObject({ approved: true, agentName: 'spot-orders' });
  expect((await venueRecord(s.owner, '/agents')).value.map((a) => a.address.toLowerCase())).toContain(agent.agentAddress);

  // A sell stop-limit of 1: triggers at 95, sells no lower than 94.
  const before = await balanceOf(s.owner, s.market.base);
  const asked = signatures(wallet);
  const clientId = await fill(page, s, 'Stop limit', 'Sell', { Size: '1', 'Trigger price': '95', 'Limit price': '94' });
  const placed = await placeOnEngine(page);
  expect(signatures(wallet), 'our engine holds it: the wallet signs nothing for the stop itself').toBe(asked);
  // The trigger is stored, on our engine, under the agent permission, labelled.
  const stored = await conditional(s, clientId);
  expect(stored).toMatchObject({ kind: 'stop_limit', status: 'armed', triggerPrice: '95', limitPrice: '94', label: ENGINE });
  expect(stored.agentPermission).toEqual({ agentAddress: agent.agentAddress });
  expect(stored.legs).toEqual([expect.objectContaining({ role: 'stop', restsOn: 'engine', signedBy: 'agent', status: 'armed' })]);
  await expect(cell(page, clientId, 'where')).toHaveText(ENGINE);
  await expect(cell(page, clientId, 'trigger')).toHaveText('95');
  // Not on the book, and nothing locked at the venue until it fires.
  expect(await openOn(s)).toEqual([]);
  expect(await balanceOf(s.owner, s.market.base)).toEqual(before);
  expect(placed.id).toBe(stored.id);

  // The last trade crosses 95: our engine sends it once, a GTC limit at 94 signed by the agent key; the venue locks it.
  await lastTradeAt(s, '94.5');
  const fired = await untilStatus(s, clientId, 'fired');
  const cloid = cloidOf(venueId, fireKey(s, clientId));
  expect(fired.legs[0]).toMatchObject({ role: 'stop', venueClientOrderId: cloid, status: 'open', locked: '1', lockedAsset: s.market.base });
  const sent = await venueOrder(s, cloid);
  expect(sent).toMatchObject({ side: 'sell', type: 'limit', timeInForce: 'GTC', status: 'open' });
  expect(sameDecimal(sent.price, '94') && sameDecimal(sent.amount, '1')).toBe(true);
  // Once: the one order of the person's on the market, and the venue locks exactly its size.
  // oxlint-disable-next-line garden/no-real-clock-wait-in-tests -- proving nothing more happens over a few passes of our engine (one a second)
  await new Promise((r) => setTimeout(r, 3_000));
  expect((await openOn(s)).map((o) => o.venueClientOrderId)).toEqual([cloid]);
  const locked = await balanceOf(s.owner, s.market.base);
  expect(fromUnits(toUnits(locked.locked) - toUnits(before.locked))).toBe(fromUnits(toUnits('1')));

  // Cancel from the pending list: the venue cancels the order and releases exactly what it locked.
  await row(page, clientId)
    .getByRole('button', { name: `Cancel ${clientId}`, exact: true })
    .click();
  await expect.poll(async () => (await venueOrder(s, cloid)).status, { timeout: 15_000 }).toBe('canceled');
  expect(await balanceOf(s.owner, s.market.base)).toEqual(before);
  expect(await openOn(s)).toEqual([]);
  await expect(leg(page, clientId, 'stop')).toHaveAttribute('data-leg-status', 'cancelled', { timeout: 15_000 });
  expect(await ledgerView(s.account)).toEqual(s.ledgerStart);
});

test(`${J} #2 leaves the trigger blank: refused with a typed reason in words; nothing held`, async ({ page }) => {
  test.setTimeout(240_000);
  const s = state();
  await lastTradeAt(s, '100');
  const wallet = await openDesk(page, s);
  const before = await balanceOf(s.owner, s.market.base);
  const known = (await conditionals(s)).length;
  const asked = signatures(wallet);
  await fill(page, s, 'Stop limit', 'Sell', { Size: '1', 'Limit price': '94' });
  const answer = await placeOrder(page);
  expect(answer.status()).toBe(400);
  expect(await answer.json()).toMatchObject({ intafacedCode: 'trade.spot_conditional_trigger_missing' });
  await expect(refusal(page)).toContainText(
    'A stop-limit needs a trigger price: it is the price that sets it off. Nothing was placed and nothing is held.',
  );
  await expect(refusal(page)).toContainText('Code: trade.spot_conditional_trigger_missing');
  // Nothing held: no order stored, nothing on the venue, nothing locked, nothing signed.
  expect(await conditionals(s)).toHaveLength(known);
  expect(await openOn(s)).toEqual([]);
  expect(await balanceOf(s.owner, s.market.base)).toEqual(before);
  expect(signatures(wallet)).toBe(asked);
  expect(await ledgerView(s.account)).toEqual(s.ledgerStart);
});

test(`${J} #3 places a stop-market and looks at the pending list: pending orders listed with trigger, reference price and a way to modify or cancel each`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const { id: venueId } = await venueInfo();
  await lastTradeAt(s, '100');
  await openDesk(page, s);
  const market = await fill(page, s, 'Stop market', 'Sell', { Size: '0.5', 'Trigger price': '95' });
  await placeOnEngine(page);
  const limit = await fill(page, s, 'Stop limit', 'Sell', { Size: '0.5', 'Trigger price': '90', 'Limit price': '89' });
  await placeOnEngine(page);
  try {
    // Each pending order: its trigger, the reference price it is judged on (the venue's last trade), and Modify and Cancel.
    for (const [id, trigger] of [
      [market, '95'],
      [limit, '90'],
    ]) {
      await expect(cell(page, id, 'trigger')).toHaveText(trigger);
      await expect(cell(page, id, 'reference')).toHaveText('100 (last trade)');
      await expect(cell(page, id, 'status')).toHaveText('Armed');
      await expect(cell(page, id, 'where')).toHaveText(ENGINE);
      await expect(row(page, id).getByRole('button', { name: `Modify ${id}`, exact: true })).toBeEnabled();
      await expect(row(page, id).getByRole('button', { name: `Cancel ${id}`, exact: true })).toBeEnabled();
    }
    const head = pending(page).locator('thead th');
    await expect(head).toHaveText(['Kind', 'Side', 'Size', 'Trigger', 'Reference price', 'Status', 'Run by', 'Legs', 'Actions']);
    const shown = await conditional(s, market);
    expect(shown).toMatchObject({ kind: 'stop_market', triggerPrice: '95', referencePrice: '100', triggerSource: 'last', status: 'armed' });

    // Modify: the stop-market's trigger to 96, stored as the person typed it.
    await row(page, market)
      .getByRole('button', { name: `Modify ${market}`, exact: true })
      .click();
    await row(page, market).getByRole('textbox', { name: 'New trigger', exact: true }).fill('96');
    await row(page, market).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(cell(page, market, 'trigger')).toHaveText('96', { timeout: 15_000 });
    expect((await conditional(s, market)).triggerPrice).toBe('96');

    // Cancel: the stop-limit is gone from what our engine watches, and nothing was ever on the venue for it.
    await row(page, limit)
      .getByRole('button', { name: `Cancel ${limit}`, exact: true })
      .click();
    await expect(cell(page, limit, 'status')).toHaveText(/^Cancelled/, { timeout: 15_000 });
    expect((await conditional(s, limit)).status).toBe('cancelled');
    expect(await openOn(s)).toEqual([]);

    // The stop-market fires once on a trade under 96: one IOC sell at the owner's price protection, filled on the venue.
    await traderOrder(TAKER, s, 'buy', '95.4', '0.5', 'GTC');
    await traderOrder(MAKER, s, 'sell', '95.8', '1', 'GTC');
    await lastTradeAt(s, '95.6');
    const fired = await untilStatus(s, market, 'fired');
    const cloid = cloidOf(venueId, fireKey(s, market));
    expect(fired.legs[0]).toMatchObject({ venueClientOrderId: cloid, status: 'filled' });
    expect(await venueOrder(s, cloid)).toMatchObject({ side: 'sell', type: 'market', status: 'filled' });
    // oxlint-disable-next-line garden/no-real-clock-wait-in-tests -- proving nothing more happens over a few passes of our engine (one a second)
    await new Promise((r) => setTimeout(r, 3_000));
    const fills = await fillsOf(s, cloid);
    expect(fromUnits(fills.reduce((sum, f) => sum + toUnits(f.amount), 0n))).toBe(fromUnits(toUnits('0.5')));
  } finally {
    await cancelLeft(s);
  }
  expect(await ledgerView(s.account)).toEqual(s.ledgerStart);
});

test(`${J} #4 places a sell OCO with a take-profit and a stop-loss: the take-profit leg rests on one venue lock of the base; a cancel releases it; replaying the client id returns the same group; a kind the venue doesn't hold runs on our engine under the agent permission, labelled as run by INTAFACED`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const { id: venueId } = await venueInfo();
  await lastTradeAt(s, '100');
  await openDesk(page, s);
  const before = await balanceOf(s.owner, s.market.base);
  const clientId = await fill(page, s, 'OCO', 'Sell', { Size: '1', 'Take-profit price': '110', 'Stop-loss trigger': '95' });
  const made = await placeOnEngine(page);
  try {
    const tpCloid = cloidOf(venueId, legKey(s, clientId, 'tp'));
    // The take profit rests on the venue: one order, one lock of the base, exactly its size.
    const resting = await openOn(s);
    expect(resting.map((o) => o.venueClientOrderId)).toEqual([tpCloid]);
    expect(resting[0]).toMatchObject({ side: 'sell', type: 'limit', status: 'open', lockedAsset: s.market.base });
    expect(sameDecimal(resting[0].price, '110') && sameDecimal(resting[0].locked, '1')).toBe(true);
    const held = await balanceOf(s.owner, s.market.base);
    expect(fromUnits(toUnits(held.locked) - toUnits(before.locked))).toBe(fromUnits(toUnits('1')));
    // The stop loss is held by our engine on the same coins: no second lock.
    const group = await conditional(s, clientId);
    expect(group).toMatchObject({ kind: 'oco', status: 'open', label: ENGINE });
    expect(group.legs).toEqual([
      expect.objectContaining({
        role: 'take_profit',
        restsOn: 'venue',
        signedBy: 'agent',
        status: 'open',
        locked: '1',
        venueClientOrderId: tpCloid,
      }),
      expect.objectContaining({
        role: 'stop_loss',
        restsOn: 'engine',
        signedBy: 'agent',
        status: 'armed',
        triggerPrice: '95',
        locked: null,
      }),
    ]);
    await expect(leg(page, clientId, 'take_profit')).toContainText('rests on the venue');
    await expect(leg(page, clientId, 'stop_loss')).toContainText('run by INTAFACED on our engine');
    await expect(cell(page, clientId, 'where')).toHaveText(ENGINE);

    // The same client id again: the same group, and nothing new on the venue.
    const again = await (
      await api(s.account)
    ).post('/api/v1/venue/spot-orders', {
      owner: s.owner,
      symbol: s.market.symbol,
      kind: 'oco',
      side: 'sell',
      quantity: '1',
      takeProfitPrice: '110',
      triggerPrice: '95',
      clientOrderId: clientId,
    });
    expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(201);
    expect(again.body).toMatchObject({ reused: true, conditional: { id: made.id, clientOrderId: clientId } });
    expect((await conditionals(s)).filter((o) => o.clientOrderId === clientId)).toHaveLength(1);
    expect((await openOn(s)).map((o) => o.venueClientOrderId)).toEqual([tpCloid]);

    // Cancel: the take profit is cancelled on the venue and its lock released; the stop loss ends with it.
    await row(page, clientId)
      .getByRole('button', { name: `Cancel ${clientId}`, exact: true })
      .click();
    await untilStatus(s, clientId, 'cancelled');
    expect(await venueOrder(s, tpCloid)).toMatchObject({ status: 'canceled' });
    expect(await balanceOf(s.owner, s.market.base)).toEqual(before);
    expect(await openOn(s)).toEqual([]);
  } finally {
    await cancelLeft(s);
  }
  expect(await ledgerView(s.account)).toEqual(s.ledgerStart);
});

test(`${J} #5 reads the review of both legs: take-profit priced as maker and stop-loss as taker from the published schedule`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  await lastTradeAt(s, '100');
  const wallet = await openDesk(page, s);
  const published = (await testVenue('/markets', {})).body.value.find((m) => m.symbol === s.market.symbol);
  expect(published.makerFeeBps.known && published.takerFeeBps.known, 'the TEST market publishes its fees').toBe(true);
  const builder = (await (await api(s.account)).get('/api/v1/venue/status')).body.builder.feeBps;
  const known = (await conditionals(s)).length;
  const asked = signatures(wallet);
  await fill(page, s, 'OCO', 'Sell', { Size: '1', 'Take-profit price': '110', 'Stop-loss trigger': '95', 'Stop-loss limit': '94' });
  await panel(page).getByRole('button', { name: 'Review', exact: true }).click();
  const review = panel(page).getByRole('region', { name: 'Review of each leg', exact: true });
  await expect(review).toBeVisible();
  // Each leg's fee is the published rate plus our builder fee on a spot sell, on its price and size.
  const feeOf = (price, bps) => fromUnits((toUnits(price) * (toUnits(bps) + toUnits(builder))) / toUnits('10000'));
  const tp = review.locator('li[data-leg="take_profit"]');
  const sl = review.locator('li[data-leg="stop_loss"]');
  await expect(tp).toHaveAttribute('data-liquidity', 'maker');
  await expect(sl).toHaveAttribute('data-liquidity', 'taker');
  const bps = (x) => fromUnits(toUnits(x));
  await expect(tp).toHaveText(
    `Take profit: Sell 1 at 110, maker fee ${bps(published.makerFeeBps.value)} bps and our builder fee ${bps(builder)} bps, about ${feeOf('110', published.makerFeeBps.value)} USDC`,
  );
  await expect(sl).toHaveText(
    `Stop loss: Sell 1 at 94, taker fee ${bps(published.takerFeeBps.value)} bps and our builder fee ${bps(builder)} bps, about ${feeOf('94', published.takerFeeBps.value)} USDC`,
  );
  // A review places nothing and signs nothing.
  expect(await conditionals(s)).toHaveLength(known);
  expect(await openOn(s)).toEqual([]);
  expect(signatures(wallet)).toBe(asked);
});

test(`${J} #6 a buyer takes the take-profit leg: it fills on the venue, the stop-loss leg is cancelled and its venue lock released once, nothing stays locked; a kind the venue doesn't hold runs on our engine under the agent permission, labelled as run by INTAFACED`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const { id: venueId } = await venueInfo();
  await lastTradeAt(s, '100');
  await openDesk(page, s);
  const before = await balanceOf(s.owner, s.market.base);
  const clientId = await fill(page, s, 'OCO', 'Sell', { Size: '1', 'Take-profit price': '110', 'Stop-loss trigger': '95' });
  await placeOnEngine(page);
  try {
    const tpCloid = cloidOf(venueId, legKey(s, clientId, 'tp'));
    await expect(cell(page, clientId, 'where')).toHaveText(ENGINE);
    // The other TEST trader buys the whole take profit at 110.
    const taken = await traderOrder(TAKER, s, 'buy', '110', '1', 'IOC');
    expect(taken.status).toBe('filled');
    expect(await venueOrder(s, tpCloid)).toMatchObject({ status: 'filled' });
    // Our engine ends the stop loss once: the group is filled, the stop-loss leg cancelled, nothing locked.
    const done = await untilStatus(s, clientId, 'filled');
    expect(done.legs.map((l) => [l.role, l.status])).toEqual([
      ['take_profit', 'filled'],
      ['stop_loss', 'cancelled'],
    ]);
    await expect(leg(page, clientId, 'stop_loss')).toHaveAttribute('data-leg-status', 'cancelled', { timeout: 15_000 });
    const after = await balanceOf(s.owner, s.market.base);
    expect(after.locked).toBe(before.locked);
    expect(fromUnits(toUnits(before.free) - toUnits(after.free))).toBe(fromUnits(toUnits('1')));
    expect(await openOn(s)).toEqual([]);
    const fills = await fillsOf(s, tpCloid);
    expect(fills.every((f) => f.side === 'sell' && f.role === 'maker')).toBe(true);
    expect(fromUnits(fills.reduce((sum, f) => sum + toUnits(f.amount), 0n))).toBe(fromUnits(toUnits('1')));
    // Once: a later trade through the stop-loss trigger sends nothing.
    await lastTradeAt(s, '94');
    // oxlint-disable-next-line garden/no-real-clock-wait-in-tests -- proving nothing more happens over a few passes of our engine (one a second)
    await new Promise((r) => setTimeout(r, 4_000));
    const still = await conditional(s, clientId);
    expect(still.status).toBe('filled');
    expect(await venueOrder(s, cloidOf(venueId, fireKey(s, clientId)))).toBeNull();
    expect(await openOn(s)).toEqual([]);
  } finally {
    await cancelLeft(s);
  }
  expect(await ledgerView(s.account)).toEqual(s.ledgerStart);
});

test(`${J} #7 a partial fill hits the take-profit leg: the remaining venue lock stays for the remaining leg; a cancel releases exactly that; a kind the venue doesn't hold runs on our engine under the agent permission, labelled as run by INTAFACED`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const { id: venueId } = await venueInfo();
  await lastTradeAt(s, '100');
  await openDesk(page, s);
  const before = await balanceOf(s.owner, s.market.base);
  const clientId = await fill(page, s, 'OCO', 'Sell', { Size: '1', 'Take-profit price': '110', 'Stop-loss trigger': '95' });
  await placeOnEngine(page);
  try {
    const tpCloid = cloidOf(venueId, legKey(s, clientId, 'tp'));
    await expect(cell(page, clientId, 'where')).toHaveText(ENGINE);
    await traderOrder(TAKER, s, 'buy', '110', '0.4', 'IOC');
    // The take profit keeps 0.6 resting on its lock; the stop loss covers the same 0.6.
    await expect.poll(async () => (await venueOrder(s, tpCloid)).status, { timeout: 15_000 }).toBe('partially_filled');
    const tp = await venueOrder(s, tpCloid);
    expect(sameDecimal(tp.filled, '0.4') && sameDecimal(tp.locked, '0.6')).toBe(true);
    await expect
      .poll(async () => (await conditional(s, clientId)).legs.map((l) => [l.role, l.status, l.quantity]), { timeout: 15_000 })
      .toEqual([
        ['take_profit', 'partially_filled', '1'],
        ['stop_loss', 'armed', '0.6'],
      ]);
    await expect(leg(page, clientId, 'stop_loss')).toContainText('Stop loss: Sell 0.6', { timeout: 15_000 });
    await expect(leg(page, clientId, 'take_profit')).toContainText(`0.6 ${s.market.base} locked`);
    const held = await balanceOf(s.owner, s.market.base);
    expect(fromUnits(toUnits(held.locked) - toUnits(before.locked))).toBe(fromUnits(toUnits('0.6')));
    // Still open after a pass of our engine: a part fill ends nothing.
    // oxlint-disable-next-line garden/no-real-clock-wait-in-tests -- proving nothing more happens over a few passes of our engine (one a second)
    await new Promise((r) => setTimeout(r, 3_000));
    expect((await conditional(s, clientId)).status).toBe('open');

    // Cancel: exactly the 0.6 still locked comes back free; the sold 0.4 stays sold.
    await row(page, clientId)
      .getByRole('button', { name: `Cancel ${clientId}`, exact: true })
      .click();
    await untilStatus(s, clientId, 'cancelled');
    const after = await balanceOf(s.owner, s.market.base);
    expect(after.locked).toBe(before.locked);
    expect(fromUnits(toUnits(after.free) - toUnits(held.free))).toBe(fromUnits(toUnits('0.6')));
    expect(fromUnits(toUnits(before.free) - toUnits(after.free))).toBe(fromUnits(toUnits('0.4')));
    expect(await venueOrder(s, tpCloid)).toMatchObject({ status: 'canceled' });
    expect(await openOn(s)).toEqual([]);
  } finally {
    await cancelLeft(s);
  }
  expect(await ledgerView(s.account)).toEqual(s.ledgerStart);
});

test(`${J} #8 submits a buy OCO with no stop-loss limit, or legs out of order: refused in words with the reason; the form refuses out-of-order prices before sending`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  await lastTradeAt(s, '100');
  const wallet = await openDesk(page, s);
  const known = (await conditionals(s)).length;
  const asked = signatures(wallet);
  // A buy OCO with no stop-loss limit: svc-trade refuses it in words.
  await fill(page, s, 'OCO', 'Buy', { Size: '1', 'Take-profit price': '90', 'Stop-loss trigger': '105' });
  const answer = await placeOrder(page);
  expect(answer.status()).toBe(400);
  expect(await answer.json()).toMatchObject({ intafacedCode: 'trade.oco_stop_limit_missing' });
  await expect(refusal(page)).toContainText(
    'A buy stop loss needs a stop-loss limit: the most you will pay when it fires. Nothing was placed.',
  );

  // Legs out of order: the form refuses them before anything is sent.
  const writes = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/v1/venue/spot-orders')) writes.push(r.url());
  });
  await fill(page, s, 'OCO', 'Sell', { Size: '1', 'Take-profit price': '95', 'Stop-loss trigger': '110' });
  await panel(page).getByRole('button', { name: 'Place order', exact: true }).click();
  await expect(refusal(page)).toContainText(
    'The take-profit price must be above the stop-loss trigger: 95 is not above 110. Nothing was sent.',
  );
  await panel(page).getByRole('button', { name: 'Review', exact: true }).click();
  await expect(refusal(page)).toContainText('The take-profit price must be above the stop-loss trigger');
  // oxlint-disable-next-line garden/no-wait-for-timeout -- proving the form sends nothing
  await page.waitForTimeout(1_000);
  expect(writes, 'the form sent nothing').toEqual([]);
  // The same legs sent around the form are refused by svc-trade with the reason, in words.
  const around = await (
    await api(s.account)
  ).post('/api/v1/venue/spot-orders', {
    owner: s.owner,
    symbol: s.market.symbol,
    kind: 'oco',
    side: 'sell',
    quantity: '1',
    takeProfitPrice: '95',
    triggerPrice: '110',
    clientOrderId: `js8-around-${randomBytes(3).toString('hex')}`,
  });
  expect(around.status).toBe(400);
  expect(around.body).toMatchObject({
    intafacedCode: 'trade.oco_legs_out_of_order',
    message: 'The take-profit price must be above the stop-loss trigger: 95 is not above 110. Nothing was placed.',
  });
  expect(await conditionals(s)).toHaveLength(known);
  expect(await openOn(s)).toEqual([]);
  expect(signatures(wallet)).toBe(asked);
});

test(`${J} #9 places a bracket: entry plus exits: the entry fills on the venue, then the received coins are locked behind one OCO exit pair; an entry that fills nothing places no exit; a resting entry waits and a cancel places no exit; a kind the venue doesn't hold runs on our engine under the agent permission, labelled as run by INTAFACED`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const s = state();
  const { id: venueId } = await venueInfo();
  await lastTradeAt(s, '100');
  await openDesk(page, s);
  const usdcBefore = await balanceOf(s.owner, 'USDC');
  try {
    // An immediate-or-cancel entry at 99 meets no ask: it fills nothing, and no exit is placed.
    const nothing = await fill(page, s, 'Bracket', 'Buy', {
      Size: '1',
      'Entry price': '99',
      'Take-profit price': '110',
      'Stop-loss trigger': '95',
      'Entry time in force': 'Immediate or cancel',
    });
    await placeOnEngine(page, 'Entry signed. Its exits wait for it to fill.');
    const none = await untilStatus(s, nothing, 'cancelled');
    expect(none.cancelReason).toBe('entry_filled_nothing');
    await expect(cell(page, nothing, 'status')).toHaveText('Cancelled · The entry filled nothing, so no exit was placed.', {
      timeout: 15_000,
    });
    expect(await venueOrder(s, cloidOf(venueId, legKey(s, nothing, 'entry')))).toMatchObject({
      status: expect.stringMatching(/^(canceled|expired)$/),
    });
    expect(await venueOrder(s, cloidOf(venueId, legKey(s, nothing, 'tp')))).toBeNull();
    expect(await openOn(s)).toEqual([]);

    // A resting entry at 98 waits; its cancel cancels it on the venue and places no exit.
    const waits = await fill(page, s, 'Bracket', 'Buy', {
      Size: '1',
      'Entry price': '98',
      'Take-profit price': '110',
      'Stop-loss trigger': '95',
      'Entry time in force': 'Good till cancelled',
    });
    await placeOnEngine(page, 'Entry signed. Its exits wait for it to fill.');
    const entryCloid = cloidOf(venueId, legKey(s, waits, 'entry'));
    await expect.poll(async () => (await venueOrder(s, entryCloid))?.status, { timeout: 15_000 }).toBe('open');
    // oxlint-disable-next-line garden/no-real-clock-wait-in-tests -- proving nothing more happens over a few passes of our engine (one a second)
    await new Promise((r) => setTimeout(r, 3_000));
    expect((await conditional(s, waits)).status).toBe('entry');
    await expect(cell(page, waits, 'status')).toHaveText('Waiting for the entry');
    await expect(cell(page, waits, 'where')).toHaveText(ENGINE);
    expect((await openOn(s)).map((o) => o.venueClientOrderId)).toEqual([entryCloid]);
    await row(page, waits)
      .getByRole('button', { name: `Cancel ${waits}`, exact: true })
      .click();
    await untilStatus(s, waits, 'cancelled');
    expect(await venueOrder(s, entryCloid)).toMatchObject({ status: 'canceled' });
    expect(await venueOrder(s, cloidOf(venueId, legKey(s, waits, 'tp')))).toBeNull();
    expect(await openOn(s)).toEqual([]);
    expect((await balanceOf(s.owner, 'USDC')).locked).toBe(usdcBefore.locked);

    // An entry that fills: the other trader's ask at 100 is taken whole; then the coins it received are locked behind
    // one OCO exit pair: the take profit on the venue for exactly what was received, the stop loss on our engine.
    await traderOrder(MAKER, s, 'sell', '100', '1', 'GTC');
    const baseBefore = await balanceOf(s.owner, s.market.base);
    const fills = await fill(page, s, 'Bracket', 'Buy', {
      Size: '1',
      'Entry price': '100',
      'Take-profit price': '110',
      'Stop-loss trigger': '95',
      'Entry time in force': 'Immediate or cancel',
    });
    await placeOnEngine(page, 'Entry signed. Its exits wait for it to fill.');
    const open = await untilStatus(s, fills, 'open');
    const entry = await venueOrder(s, cloidOf(venueId, legKey(s, fills, 'entry')));
    expect(entry).toMatchObject({ side: 'buy', status: 'filled' });
    // Received: what filled, less the fee the venue took in the coin (a spot buy pays its fee in what it receives).
    const entryFills = await fillsOf(s, entry.venueClientOrderId);
    const fee = entryFills
      .filter((f) => f.feeAsset === s.market.base)
      .reduce((sum, f) => sum + toUnits(f.venueFee) + toUnits(f.builderFee), 0n);
    const lot = toUnits('0.001');
    const net = toUnits(entry.filled) - fee;
    const received = fromUnits(net - (net % lot));
    expect(sameDecimal(open.exitQuantity, received)).toBe(true);
    const tpCloid = cloidOf(venueId, legKey(s, fills, 'tp'));
    const tp = await venueOrder(s, tpCloid);
    expect(tp).toMatchObject({ side: 'sell', type: 'limit', status: 'open', lockedAsset: s.market.base });
    expect(sameDecimal(tp.amount, received) && sameDecimal(tp.locked, received) && sameDecimal(tp.price, '110')).toBe(true);
    expect(open.legs.map((l) => [l.role, l.restsOn, l.status])).toEqual([
      ['entry', 'venue', 'filled'],
      ['take_profit', 'venue', 'open'],
      ['stop_loss', 'engine', 'armed'],
    ]);
    expect(sameDecimal(open.legs[2].quantity, received)).toBe(true);
    // One lock: the take profit's, of exactly the coins received.
    expect((await openOn(s)).map((o) => o.venueClientOrderId)).toEqual([tpCloid]);
    const baseAfter = await balanceOf(s.owner, s.market.base);
    expect(fromUnits(toUnits(baseAfter.locked) - toUnits(baseBefore.locked))).toBe(fromUnits(toUnits(received)));
    await expect(cell(page, fills, 'where')).toHaveText(ENGINE);
    await expect(leg(page, fills, 'take_profit')).toContainText('linked to the entry');
  } finally {
    await cancelLeft(s);
  }
  expect(await openOn(s)).toEqual([]);
  expect(await ledgerView(s.account)).toEqual(s.ledgerStart);
});

test(`${J} #10 attaches a close that fires when the entry fills (one-triggers-other): the close appears as a linked order and is cancelled with the entry`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const { id: venueId } = await venueInfo();
  await lastTradeAt(s, '100');
  await openDesk(page, s);
  try {
    const clientId = await fill(page, s, 'Linked close', 'Buy', {
      Size: '1',
      'Entry price': '98',
      'Close price': '105',
      'Entry time in force': 'Good till cancelled',
    });
    await placeOnEngine(page, 'Entry signed. Its exits wait for it to fill.');
    const entryCloid = cloidOf(venueId, legKey(s, clientId, 'entry'));
    await expect.poll(async () => (await venueOrder(s, entryCloid))?.status, { timeout: 15_000 }).toBe('open');
    // The close is listed as an order linked to the entry, waiting for it.
    await expect(leg(page, clientId, 'close')).toHaveText('Close: Sell 1 at 105, rests on the venue, waiting; linked to the entry', {
      timeout: 15_000,
    });
    expect((await conditional(s, clientId)).legs.map((l) => [l.role, l.status, l.linkedTo])).toEqual([
      ['entry', 'open', null],
      ['close', 'waiting', 'entry'],
    ]);
    // Cancelled with the entry: the entry is cancelled on the venue, and the close is never placed.
    await row(page, clientId)
      .getByRole('button', { name: `Cancel ${clientId}`, exact: true })
      .click();
    await untilStatus(s, clientId, 'cancelled');
    expect(await venueOrder(s, entryCloid)).toMatchObject({ status: 'canceled' });
    await expect(leg(page, clientId, 'close')).toHaveAttribute('data-leg-status', 'cancelled', { timeout: 15_000 });
    // oxlint-disable-next-line garden/no-real-clock-wait-in-tests -- proving nothing more happens over a few passes of our engine (one a second)
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await venueOrder(s, cloidOf(venueId, legKey(s, clientId, 'close')))).toBeNull();
    expect(await openOn(s)).toEqual([]);

    // And when the entry fills, the close is placed on the venue for what it received, signed under the agent permission.
    await traderOrder(MAKER, s, 'sell', '100', '1', 'GTC');
    const fills = await fill(page, s, 'Linked close', 'Buy', {
      Size: '1',
      'Entry price': '100',
      'Close price': '105',
      'Entry time in force': 'Immediate or cancel',
    });
    await placeOnEngine(page, 'Entry signed. Its exits wait for it to fill.');
    await untilStatus(s, fills, 'fired');
    const close = await venueOrder(s, cloidOf(venueId, legKey(s, fills, 'close')));
    expect(close).toMatchObject({ side: 'sell', type: 'limit', status: 'open' });
    expect(sameDecimal(close.price, '105')).toBe(true);
    await expect(leg(page, fills, 'close')).toContainText('linked to the entry');
    // The close now rests as an order of its own: taken off here so nothing of this file is left on the venue.
    await throughUs(
      s,
      { kind: 'cancel_order', symbol: s.market.symbol, clientOrderKey: legKey(s, fills, 'close') },
      `cancel:js8-close:${fills}`,
    ).catch(() => undefined);
  } finally {
    await cancelLeft(s);
  }
  expect(await ledgerView(s.account)).toEqual(s.ledgerStart);
});
