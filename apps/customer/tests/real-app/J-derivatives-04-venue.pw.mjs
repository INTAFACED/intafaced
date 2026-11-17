// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState, restartWithSetting, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  sameDecimal,
  testDeposit,
  testVenue,
  venueAccount,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-derivatives-04's venue steps on the person's own venue account (the launch money model: the venue holds the margin
// and the orders, the ledger posts nothing), in the running app against the stack's TEST venue simulator
// (packages/venue-sim). #3 and #5 are the steps CUSTODY-DELTA marks Adapted (amend, cancel-on-disconnect); #4 and #6 are
// proven here on the venue too, since trading on our own engine is out at launch (OWNER 226, 237). One test per step,
// titled "J-derivatives-04 #<n>", run in order on one TEST account; #1 and #2 are in J-derivatives-04.pw.mjs.
//
// Every order, lock, schedule and answer is read from the TEST venue itself, never the page. #3 to #5 rest TEST buys on
// BTC-PERP at 40000, a third under the TEST makers' ladder (mid 60000), so they never fill. #6 needs the venue's trigger
// orders, which only ETH-PERP's TEST listing takes (triggerSources): this file opens a TEST long of 0.1 ETH there and
// reads its TEST mark (3000), never moves it, and rests the ladder at 3000 again after the file. The ledger is read before
// and after to show it posts nothing. Every figure is TEST.
const J = 'J-derivatives-04';
const PERP = 'BTC-PERP';
const DESK = `/trade/futures?symbol=${PERP}`;
const TRIGGER_PERP = 'ETH-PERP';
const TRIGGER_DESK = `/trade/futures?symbol=${TRIGGER_PERP}`;
const REST = '40000';
const LABEL = 'grid-7';
const START_USDC = '3000';
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
// The stack's TEST venue, for this file only, lowers an order in place and cancels several in one signed action, as the
// venue it stands for does; svc-trade restarted so its door reads the venue afresh. After the file it does neither again
// (J-cex-spot-05 does the same), and ETH-PERP's TEST ladder rests at its mark again.
const ORDER_CHANGES = { amendsInPlace: true, cancelsPerAction: 20 };
test.beforeAll(async () => {
  test.setTimeout(240_000);
  expect((await testVenue('/test/switches', ORDER_CHANGES)).body).toMatchObject(ORDER_CHANGES);
  restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'on');
});
test.afterAll(async () => {
  await testVenue('/test/switches', { amendsInPlace: false, cancelsPerAction: null });
  await testVenue('/test/ladder-mid', { symbol: TRIGGER_PERP, price: '3000' }).catch(() => undefined);
});

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #3 made no account and wallet, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

const venueOpen = async (owner) => (await venueRecord(owner, '/open-orders')).value;
const venueOrder = async (owner, venueClientOrderId) => (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId })).value;
const schedule = async (owner) => (await venueRecord(owner, '/scheduled-cancel')).value;
const ledgerView = async (who) => (await api(who)).balances();
/** The wallet's signature prompts so far (typed data is the only thing an action is signed as). */
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;

/** Every door call this page makes, by its path (`prepare`, `submit`, `preview`). */
function doorCalls(page) {
  const calls = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === 'POST' && path.startsWith('/api/v1/venue/'))
      calls.push({ path: path.slice('/api/v1/venue/'.length), body: r.postDataJSON() });
  });
  return { all: calls, of: (name) => calls.filter((c) => c.path === name) };
}

/** The person signs and sends one action on the TEST venue directly with their own wallet key, as from another device. */
async function ownRun(walletKey, intent) {
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  const account = await venueAccount(owner);
  const prepared = await testVenue('/prepare', { account, signer: { role: 'owner', address: owner }, intent });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const t = prepared.body.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  return sent.body;
}

/** A TEST resting buy of 0.001 BTC-PERP at REST placed from another device; its venue client id. */
async function restElsewhere(walletKey, tag) {
  const answer = await ownRun(walletKey, {
    kind: 'place_order',
    symbol: PERP,
    side: 'buy',
    type: 'limit',
    amount: '0.001',
    price: REST,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${J.toLowerCase()}:${tag}:${randomBytes(4).toString('hex')}`,
    builderFee: null,
  });
  expect(answer, JSON.stringify(answer).slice(0, 300)).toMatchObject({ accepted: true, order: { status: 'open' } });
  return answer.order.venueClientOrderId;
}

const ticket = (page) => page.getByTestId('venue-ticket');
const blotter = (page) => page.getByTestId('venue-blotter');
const rowOf = (page, cloid) => page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${cloid}"]`);

async function ordersTab(page) {
  await blotter(page).getByRole('button', { name: 'Open orders', exact: true }).click();
  await expect(page.getByTestId('venue-open-orders')).toBeVisible();
}

/** The desk's own ticket: a TEST limit buy of `size` at `price`, reviewed, confirmed and signed; its venue client id. */
async function restFromDesk(page, owner, size, price, label = '') {
  const before = new Set((await venueOpen(owner)).map((o) => o.venueClientOrderId));
  const t = ticket(page);
  await t.getByRole('button', { name: 'Long', exact: true }).click();
  await t.getByRole('button', { name: 'Limit', exact: true }).click();
  await t.getByRole('textbox', { name: 'Size (BTC)', exact: true }).fill(size);
  await t.getByRole('textbox', { name: 'Price', exact: true }).fill(price);
  await t.getByRole('textbox', { name: 'Label (optional)', exact: true }).fill(label);
  await t.getByRole('button', { name: 'Review long', exact: true }).click();
  const sheet = page.getByTestId('venue-review');
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  const approval = sheet.locator('[data-line="builder-approval"]');
  if ((await approval.count()) > 0 && !/Signed, up to/.test(await approval.innerText())) {
    await sheet.getByRole('button', { name: 'Approve our builder fee in your wallet', exact: true }).click();
    await continueInWallet(page);
    await expect(approval).toHaveText(/Signed, up to/, { timeout: 15_000 });
  }
  await sheet.getByRole('button', { name: 'Open long', exact: true }).click();
  await continueInWallet(page);
  await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Open on the venue.', { timeout: 15_000 });
  await sheet.getByRole('button', { name: 'Back', exact: true }).click();
  const placed = (await venueOpen(owner)).filter((o) => !before.has(o.venueClientOrderId));
  expect(placed, 'one new order rests on the venue').toHaveLength(1);
  expect(placed[0]).toMatchObject({ symbol: PERP, side: 'buy', status: 'open' });
  return placed[0].venueClientOrderId;
}

/** TEST setup, not a step (the Starts line), made at the start of #3: a verified account, its wallet, TEST USDC, 5x. */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'jd4v');
    await verify(page, account);
    const walletKey = testWalletKey();
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', START_USDC, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    for (const symbol of [PERP, TRIGGER_PERP])
      expect(await ownRun(walletKey, { kind: 'update_leverage', symbol, leverageBps: 50_000, marginMode: 'isolated' })).toMatchObject({
        accepted: true,
      });
    run.reset({ account, walletKey, ledger: await ledgerView(account) });
  } finally {
    await page.close();
  }
}

async function ledgerUntouched(s) {
  expect(await ledgerView(s.account)).toEqual(s.ledger);
}

test(`${J} #3 presses Amend on a futures order: the venue amends it in place, or a reviewed cancel-and-replace where it can't; nothing changes until confirmed`, async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  await startsLine(browser);
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(PERP, { timeout: 20_000 });
  const a = await restFromDesk(page, s.owner, '0.002', REST, 'amend-a');
  await ordersTab(page);
  await expect(rowOf(page, a)).toBeVisible({ timeout: 20_000 });
  await expect(rowOf(page, a).locator('[data-cell=tag]')).toHaveText('amend-a');
  const door = doorCalls(page);
  const dialog = page.getByTestId('venue-edit');
  const note = dialog.getByTestId('venue-edit-note');

  // The venue amends in place: a lower amount, the same order, its place kept.
  const before = await venueOrder(s.owner, a);
  await rowOf(page, a)
    .getByRole('button', { name: `Edit order ${a}`, exact: true })
    .click();
  await dialog.getByRole('textbox', { name: 'Amount left', exact: true }).fill('0.001');
  await expect(dialog).toContainText('Lowering the amount keeps your place in the queue; the venue changes the order in place.');
  // Nothing changes until it is confirmed: typed, not pressed, the order rests as it was and nothing was prepared.
  // oxlint-disable-next-line garden/no-wait-for-timeout -- proving nothing happens: a typed change sends nothing in this time
  await page.waitForTimeout(1_000);
  expect(door.of('prepare')).toHaveLength(0);
  expect(await venueOrder(s.owner, a)).toEqual(before);
  let asked = signatures(wallet);
  await dialog.getByRole('button', { name: 'Change amount', exact: true }).click();
  await continueInWallet(page);
  await expect(note).toContainText('Your place in the queue was kept', { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  const amended = await venueOrder(s.owner, a);
  expect(amended).toMatchObject({ venueOrderId: before.venueOrderId, status: 'open', symbol: PERP });
  expect(sameDecimal(amended.remaining, '0.001')).toBe(true);
  expect(sameDecimal(amended.price, before.price)).toBe(true);
  expect(toUnits(amended.locked)).toBeLessThan(toUnits(before.locked));
  expect(door.of('prepare').at(-1).body.intent).toMatchObject({ kind: 'amend_order', symbol: PERP, venueClientOrderId: a });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  // A new price is a reviewed cancel-and-replace: reviewed first with nothing sent, then one signature for both.
  await rowOf(page, a)
    .getByRole('button', { name: `Edit order ${a}`, exact: true })
    .click();
  await dialog.getByRole('textbox', { name: 'Price', exact: true }).fill('39000');
  await dialog.getByRole('button', { name: 'Review new price', exact: true }).click();
  await expect(dialog.getByTestId('venue-replace-review')).toContainText('One signature covers both.', { timeout: 20_000 });
  const preparedSoFar = door.of('prepare').length;
  asked = signatures(wallet);
  expect(await venueOrder(s.owner, a)).toEqual(amended);
  expect(signatures(wallet)).toBe(asked);
  const prepared = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/prepare' && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Cancel and replace', exact: true }).click();
  await continueInWallet(page);
  await expect(note).toContainText('The venue cancelled the original order and released its lock. The replacement', { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  expect(door.of('prepare')).toHaveLength(preparedSoFar + 1);
  expect(door.of('prepare').at(-1).body.intent).toMatchObject({ kind: 'replace_order', symbol: PERP, venueClientOrderId: a });
  const replacement = (await (await prepared).json()).prepared.venueClientOrderId;
  expect(await venueOrder(s.owner, a)).toMatchObject({ status: 'canceled', locked: '0' });
  const replaced = await venueOrder(s.owner, replacement);
  expect(replaced).toMatchObject({ status: 'open', symbol: PERP, side: 'buy' });
  expect(sameDecimal(replaced.price, '39000')).toBe(true);
  expect(sameDecimal(replaced.remaining, '0.001')).toBe(true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  // Where the venue can't amend in place: the same TEST venue declares no amend, svc-trade restarted so it reads it
  // afresh. Lowering the amount is then a reviewed cancel-and-replace too, and nothing changes until it is confirmed.
  const b = await restElsewhere(s.walletKey, 'amend-b');
  await testVenue('/test/switches', { amendsInPlace: false });
  restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'on');
  const other = await browser.newPage();
  try {
    expect((await testVenue('/venue')).body.venue.amendsInPlace).toBeUndefined();
    const plain = await openVenueDesk(other, s.account, DESK, s.walletKey);
    await ordersTab(other);
    const calls = doorCalls(other);
    const edit = other.getByTestId('venue-edit');
    const bBefore = await venueOrder(s.owner, b);
    await rowOf(other, b)
      .getByRole('button', { name: `Edit order ${b}`, exact: true })
      .click({ timeout: 30_000 });
    await edit.getByRole('textbox', { name: 'Amount left', exact: true }).fill('0.0005');
    await expect(edit).toContainText('This venue doesn’t change an order in place');
    await expect(edit.getByRole('button', { name: 'Change amount', exact: true })).toHaveCount(0);
    const before2 = signatures(plain);
    await edit.getByRole('button', { name: 'Review new amount', exact: true }).click();
    await expect(edit.getByTestId('venue-replace-review')).toContainText('One signature covers both.', { timeout: 20_000 });
    expect(calls.of('prepare')).toHaveLength(0);
    expect(signatures(plain)).toBe(before2);
    expect(await venueOrder(s.owner, b)).toEqual(bBefore);
    await edit.getByRole('button', { name: 'Cancel and replace', exact: true }).click();
    await continueInWallet(other);
    await expect(edit.getByTestId('venue-edit-note')).toContainText('The replacement', { timeout: 20_000 });
    expect(signatures(plain)).toBe(before2 + 1);
    expect(calls.of('prepare').map((c) => c.body.intent.kind)).toEqual(['replace_order']);
    expect(await venueOrder(s.owner, b)).toMatchObject({ status: 'canceled', locked: '0' });
  } finally {
    await other.close();
    await testVenue('/test/switches', { amendsInPlace: true });
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'on');
  }
  // What rests goes, from another device, so #4 starts with nothing resting.
  const left = (await venueOpen(s.owner)).filter((o) => o.symbol === PERP);
  if (left.length)
    expect(
      (
        await ownRun(s.walletKey, {
          kind: 'cancel_orders',
          orders: left.map((o) => ({ symbol: PERP, venueClientOrderId: o.venueClientOrderId })),
        })
      ).legs.every((l) => l.accepted),
    ).toBe(true);
  expect(await venueOpen(s.owner)).toEqual([]);
  await ledgerUntouched(s);
});

test(`${J} #4 cancels by id, by instrument and by label, singly and in a batch: each id answered; an unknown id reported while the rest cancel`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(PERP, { timeout: 20_000 });
  const l1 = await restFromDesk(page, s.owner, '0.001', REST, LABEL);
  const l2 = await restFromDesk(page, s.owner, '0.001', '39500', LABEL);
  const [x1, x2, x3, x4] = [
    await restElsewhere(s.walletKey, 'x1'),
    await restElsewhere(s.walletKey, 'x2'),
    await restElsewhere(s.walletKey, 'x3'),
    await restElsewhere(s.walletKey, 'x4'),
  ];
  await ordersTab(page);
  for (const id of [l1, l2, x1, x2, x3, x4]) await expect(rowOf(page, id)).toBeVisible({ timeout: 20_000 });
  const ask = page.getByTestId('venue-cancel-ask');

  // By id, singly: the row's Cancel, signed once; the venue cancels that order and nothing else.
  let asked = signatures(wallet);
  await rowOf(page, x1).getByRole('button', { name: 'Cancel', exact: true }).click();
  await continueInWallet(page);
  await expect.poll(async () => (await venueOrder(s.owner, x1)).status, { timeout: 20_000 }).toBe('canceled');
  expect(signatures(wallet)).toBe(asked + 1);
  expect((await venueOrder(s.owner, x1)).locked).toBe('0');
  expect((await venueOpen(s.owner)).map((o) => o.venueClientOrderId).sort()).toEqual([l1, l2, x2, x3, x4].sort());

  // By ids in a batch, as a bot sends it through the door: each id answered by the venue, an unknown one reported, the
  // rest cancelled.
  const unknown = `0x${randomBytes(16).toString('hex')}`;
  const me = await api(s.account);
  const key = privateKeyToAccount(s.walletKey);
  const prep = await me.post('/api/v1/venue/prepare', {
    owner: s.owner,
    signer: { role: 'owner', address: s.owner },
    intent: {
      kind: 'cancel_orders',
      orders: [
        { symbol: PERP, venueClientOrderId: x2 },
        { symbol: PERP, venueClientOrderId: unknown },
      ],
    },
    actionKey: `cancel-batch:${s.owner}:jd4-${randomBytes(4).toString('hex')}`,
  });
  expect(prep.status, JSON.stringify(prep.body).slice(0, 300)).toBe(200);
  const t = prep.body.prepared.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await me.post('/api/v1/venue/submit', {
    actionKey: prep.body.actionKey,
    signature: { digest: prep.body.prepared.digest, signature, signedBy: s.owner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
  expect(sent.body.outcome).toMatchObject({
    accepted: true,
    legs: [
      { accepted: true, order: { venueClientOrderId: x2, status: 'canceled' } },
      { accepted: false, refusal: { code: 'unknown_order' } },
    ],
  });
  expect(sent.body.outcome.legs[1].refusal.detail).toContain(unknown);
  expect((await venueOrder(s.owner, x2)).status).toBe('canceled');

  // By id in a batch, from the desk: the one selected, answered on its own line.
  await page.getByRole('checkbox', { name: `Select order ${x3}`, exact: true }).check();
  await page.getByRole('button', { name: 'Cancel selected (1)', exact: true }).click();
  await expect(ask).toContainText('Cancel the orders you selected?');
  asked = signatures(wallet);
  await ask.getByRole('button', { name: 'Cancel 1 orders', exact: true }).click();
  await continueInWallet(page);
  await expect(ask.locator(`li[data-client-order-id="${x3}"]`)).toContainText(`${PERP} ${x3}: cancelled on the venue`, { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  await ask.getByRole('button', { name: 'Close', exact: true }).click();

  // By label, in a batch: the two orders the ticket labelled, in one signature; the unlabelled one stays.
  await expect(rowOf(page, l1).locator('[data-cell=tag]')).toHaveText(LABEL);
  await page.getByRole('textbox', { name: 'Label to cancel', exact: true }).fill(LABEL);
  await page.getByRole('button', { name: 'Cancel by label', exact: true }).click();
  await expect(ask).toContainText(`Cancel every open order labelled ${LABEL}?`);
  await expect(ask).toContainText(`2 open orders labelled ${LABEL} are cancelled in one request you sign once. Other orders stay.`);
  asked = signatures(wallet);
  await ask.getByRole('button', { name: 'Cancel 2 orders', exact: true }).click();
  await continueInWallet(page);
  for (const id of [l1, l2])
    await expect(ask.locator(`li[data-client-order-id="${id}"]`)).toContainText('cancelled on the venue', { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  expect((await venueOrder(s.owner, x4)).status).toBe('open');
  await ask.getByRole('button', { name: 'Close', exact: true }).click();

  // By instrument: every open order on this contract, in one signature.
  await expect(rowOf(page, l1).filter({ has: page.locator('[data-cell=status]', { hasText: /^Open$/ }) })).toHaveCount(0, {
    timeout: 20_000,
  });
  await page.getByRole('button', { name: `Cancel all in ${PERP} (1)`, exact: true }).click();
  await expect(ask).toContainText(`Cancel every open order in ${PERP}?`);
  await ask.getByRole('button', { name: 'Cancel 1 orders', exact: true }).click();
  await continueInWallet(page);
  await expect(ask.locator(`li[data-client-order-id="${x4}"]`)).toContainText(`${PERP} ${x4}: cancelled on the venue`, { timeout: 20_000 });
  await ask.getByRole('button', { name: 'Close', exact: true }).click();
  // The futures desk offers no "spot only": it lists its own product's orders.
  await expect(page.getByRole('button', { name: 'Cancel all: spot only', exact: true })).toHaveCount(0);

  // Every order ended exactly once, its lock released; nothing rests.
  expect(await venueOpen(s.owner)).toEqual([]);
  for (const id of [l1, l2, x1, x2, x3, x4]) expect(await venueOrder(s.owner, id)).toMatchObject({ status: 'canceled', locked: '0' });
  await ledgerUntouched(s);
});

const switchButton = (page) => page.getByTestId('venue-dead-man');
const switchDialog = (page) => page.getByRole('alertdialog').filter({ hasText: 'Auto-cancel if you go quiet' });
const ARMED = /^On, on the venue’s own scheduled cancel\. Unless refreshed, your open orders are cancelled at (\d\d:\d\d:\d\d)\.$/;
const clock = (page, iso) =>
  page.evaluate(
    (at) =>
      new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(Date.parse(at)),
    iso,
  );

test(`${J} #5 arms cancel-on-disconnect: armed on the venue's scheduled cancel with its time, and orders cancelled when the connection stays silent; or "not offered by this venue"`, async ({
  page,
  browser,
}) => {
  test.setTimeout(480_000);
  const s = state();
  const resting = [await restElsewhere(s.walletKey, 'cod-1'), await restElsewhere(s.walletKey, 'cod-2')];
  await openVenueDesk(page, s.account, DESK, s.walletKey);
  await ordersTab(page);
  for (const id of resting) await expect(rowOf(page, id)).toBeVisible({ timeout: 30_000 });
  await expect(switchButton(page)).toHaveText('Auto-cancel: off', { timeout: 30_000 });
  expect((await schedule(s.owner)).cancelsAt).toBeNull();

  // Armed from the futures desk on the venue's own scheduled cancel: the time is the venue's record, shown on the desk.
  await switchButton(page).click();
  const box = switchDialog(page);
  await box.getByRole('radio', { name: '10 seconds', exact: true }).check();
  const signed = Date.now();
  await box.getByRole('button', { name: 'Turn on', exact: true }).click();
  await continueInWallet(page);
  await expect.poll(async () => (await schedule(s.owner)).cancelsAt, { timeout: 15_000 }).not.toBeNull();
  const at = (await schedule(s.owner)).cancelsAt;
  const lead = Date.parse(at) - signed;
  expect(lead).toBeGreaterThan(5_000);
  expect(lead).toBeLessThan(20_000);
  await expect(box.getByText(ARMED)).toHaveText(ARMED, { timeout: 15_000 });
  expect((await box.getByText(ARMED).innerText()).match(ARMED)[1]).toBe(await clock(page, at));
  await box.getByRole('button', { name: 'Close', exact: true }).click();

  // Nobody refreshes it: at its time the venue itself cancels the futures orders, once, their locks ended.
  await expect.poll(async () => (await venueOpen(s.owner)).length, { timeout: 30_000, intervals: [500] }).toBe(0);
  for (const id of resting) {
    const o = await venueOrder(s.owner, id);
    expect(o).toMatchObject({ status: 'canceled', cancelReason: 'scheduled_cancel', symbol: PERP });
    expect(toUnits(o.locked)).toBe(0n);
  }
  const fired = await schedule(s.owner);
  expect(fired.cancelsAt).toBeNull();
  expect(fired.lastFired.canceled).toBe(resting.length);
  await expect(switchButton(page)).toHaveText('Auto-cancel: off', { timeout: 15_000 });
  for (const id of resting) await expect(rowOf(page, id)).toHaveCount(0, { timeout: 15_000 });

  // Where the venue has none: the same TEST venue declares no scheduled cancel, svc-trade restarted to read it afresh.
  await testVenue('/test/switches', { scheduledCancelMinLeadMs: null });
  restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'on');
  const other = await browser.newPage();
  try {
    expect((await testVenue('/venue')).body.venue.scheduledCancel).toBeUndefined();
    const plain = await openVenueDesk(other, s.account, DESK, s.walletKey);
    await ordersTab(other);
    const { displayName } = await venueInfo();
    await expect(switchButton(other)).toHaveText('Auto-cancel: not offered by this venue', { timeout: 30_000 });
    await switchButton(other).click();
    const none = switchDialog(other);
    await expect(none.getByTestId('venue-dead-man-not-offered')).toHaveText(
      `Not offered by this venue: ${displayName} has no scheduled cancel, so auto-cancel can’t be turned on here.`,
    );
    await expect(none.getByRole('button', { name: /^(Turn on|Refresh now|Turn off)$/ })).toHaveCount(0);
    expect(signatures(plain)).toBe(0);
  } finally {
    await other.close();
    await testVenue('/test/switches', { scheduledCancelMinLeadMs: 5_000 });
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'on');
  }
  expect((await testVenue('/venue')).body.venue.scheduledCancel).toEqual({ minLeadMs: 5_000 });
  await ledgerUntouched(s);
});

test(`${J} #6 with a take-profit and a stop-loss for the whole position resting, places another order that would close the whole position: refused; partial ones don't count`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const s = state();
  // A TEST long of 0.1 ETH on ETH-PERP, at its TEST mark of 3000, as from another device.
  await testVenue('/test/ladder-mid', { symbol: TRIGGER_PERP, price: '3000' });
  const opened = await ownRun(s.walletKey, {
    kind: 'place_order',
    symbol: TRIGGER_PERP,
    side: 'buy',
    type: 'market',
    amount: '0.1',
    price: '3100',
    timeInForce: 'IOC',
    reduceOnly: false,
    clientOrderKey: `order:${J.toLowerCase()}:long:${randomBytes(4).toString('hex')}`,
    builderFee: null,
  });
  expect(opened, JSON.stringify(opened).slice(0, 300)).toMatchObject({ accepted: true, order: { status: 'filled' } });
  const position = (await venueRecord(s.owner, '/positions')).value.find((p) => p.symbol === TRIGGER_PERP);
  expect(position).toMatchObject({ side: 'long' });
  expect(sameDecimal(position.size, '0.1')).toBe(true);

  await openVenueDesk(page, s.account, TRIGGER_DESK, s.walletKey);
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(TRIGGER_PERP, { timeout: 20_000 });
  const row = page.getByTestId('venue-positions').locator(`tr[data-symbol="${TRIGGER_PERP}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: `Exit orders ${TRIGGER_PERP}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Exit orders for ${TRIGGER_PERP}`, exact: true });
  await expect(dialog).toBeVisible();

  async function arm(kind, size, price) {
    await dialog.getByRole('button', { name: kind, exact: true }).click();
    await dialog.getByRole('button', { name: 'Mark', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Size to close', exact: true }).fill(size);
    await dialog.getByRole('textbox', { name: 'Trigger price', exact: true }).fill(price);
    const answer = page.waitForResponse((r) => r.url().endsWith('/api/v1/venue/protections') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Arm exit order', exact: true }).click();
    return answer;
  }
  async function armOnVenue(kind, size, price) {
    const answer = await arm(kind, size, price);
    expect(answer.status(), await answer.text()).toBe(200);
    await continueInWallet(page);
    await expect(dialog.getByTestId('protection-outcome')).toHaveText('Armed on the venue.', { timeout: 15_000 });
  }
  const triggers = async () => (await venueOpen(s.owner)).filter((o) => o.symbol === TRIGGER_PERP && o.trigger);

  // One take profit and one stop loss for the whole position rest together, with part ones beside them.
  await armOnVenue('Take profit', '0.1', '3200');
  await armOnVenue('Stop loss', '0.1', '2800');
  await armOnVenue('Take profit', '0.04', '3250');
  const whole = (o) => sameDecimal(o.remaining, '0.1');
  const before = await triggers();
  expect(before.map((o) => [o.trigger.role, whole(o)]).sort()).toEqual([
    ['stop_loss', true],
    ['take_profit', false],
    ['take_profit', true],
  ]);

  // Another whole close, a take profit or a stop loss: refused by name, before the wallet is asked; nothing rests.
  for (const [kind, price] of [
    ['Take profit', '3300'],
    ['Stop loss', '2700'],
  ]) {
    const answer = await arm(kind, '0.1', price);
    expect(answer.status(), await answer.text()).toBe(409);
    expect((await answer.json()).intafacedCode).toBe('trade.venue_whole_close_taken');
    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText(`one take profit and one stop loss for the whole position may rest together on ${TRIGGER_PERP}`);
    await expect(alert).toContainText("part take profits and stop losses don't count");
    await expect(alert).toContainText('Code: trade.venue_whole_close_taken');
    await expect(page.getByRole('dialog', { name: 'Check before you sign', exact: true })).toHaveCount(0);
  }
  expect(await triggers()).toEqual(before);

  // A part one still rests: parts don't count toward the one of each.
  await armOnVenue('Stop loss', '0.05', '2750');
  expect((await triggers()).length).toBe(before.length + 1);
  // The position is as it was.
  const after = (await venueRecord(s.owner, '/positions')).value.find((p) => p.symbol === TRIGGER_PERP);
  expect(sameDecimal(after.size, '0.1')).toBe(true);

  // Closed again at the end, from another device, so the ETH-PERP book and this account are left as they were found.
  const closed = await ownRun(s.walletKey, {
    kind: 'place_order',
    symbol: TRIGGER_PERP,
    side: 'sell',
    type: 'market',
    amount: '0.1',
    price: '2900',
    timeInForce: 'IOC',
    reduceOnly: true,
    clientOrderKey: `order:${J.toLowerCase()}:close:${randomBytes(4).toString('hex')}`,
    builderFee: null,
  });
  expect(closed).toMatchObject({ accepted: true });
  await ledgerUntouched(s);
});
