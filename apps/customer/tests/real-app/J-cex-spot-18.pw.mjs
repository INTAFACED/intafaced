// World: book, gates, restart, stack
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { awayBid, fundedTrader, signIn } from './desk.mjs';
import { deskData, deskPeople, ensureDeskGroup } from './help-centre.mjs';
import { ownOrderFills, placeOwnOrder } from './own-book.mjs';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { api, bestPrices, fromUnits, journeyState, times, toUnits, tool } from './stack.mjs';
import { openVenuePage, otherTraderKey, otherTraderRun, testDeposit, venueForThisFile, venueRecord } from './venue.mjs';

// J-cex-spot-18 "I look up a customer's routed order, and later reconcile or bust a trade on our own book", in the
// running app and the founder console. One test per step, titled "J-cex-spot-18 #<n>". The support agent is founder B
// (the stack's TEST desk agent, as in J-support-public-10); the finance operator who approves is founder A.
//
// #1 #2 #5 (row d115): the customer is a fresh verified TEST account with a TEST wallet whose own venue account on the
// stack's TEST venue holds TEST USDC. Through svc-trade's user-venue door (on for this file) they buy TEST BTC-USDC
// against another TEST trader's resting ask, so the order fills: that routed order is the one they report. The agent
// reads it from the venue by the customer's own address, the customer's own order page agrees, and the lookup's audit
// row is in the customer's own access list. INTAFACED holds none of it.
//
// #3 #4 (Later: they work only while INTAFACED holds customer money, on our own book, the custodial layer): the same customer is funded with TEST 1000 USDT on our own
// book, with one filled buy, one resting buy that stays live, and one resting buy whose book entry the stack drops and
// whose cancel it loses (`local-test-gates.mjs engine-drop`, a LOCAL TEST fault that stops and restarts svc-trade): its
// hold is then an orphan.
const J = 'J-cex-spot-18';
const SYMBOL = 'BTC/USDT';
const AMOUNT = '0.001';
const RUN = Date.now().toString(36);
const run = journeyState(J);

test.describe.configure({ mode: 'serial' });
venueForThisFile(test);
// #3's fault restarts svc-trade: it keeps the door on for the rest of the file, as the restart above set it.
const DOOR = 'LOCAL_STACK_USER_VENUE';
const doorBefore = process.env[DOOR];
test.beforeAll(() => {
  process.env[DOOR] = 'on';
});
test.afterAll(() => {
  if (doorBefore === undefined) delete process.env[DOOR];
  else process.env[DOOR] = doorBefore;
});
const VENUE_SYMBOL = 'BTC-USDC';
const VENUE_ASK = '60010';

const usdtUsed = async (who) => toUnits((await (await api(who)).balances()).USDT?.used ?? '0');
const usdtTotal = async (who) => toUnits((await (await api(who)).balances()).USDT?.total ?? '0');
const btcTotal = async (who) => toUnits((await (await api(who)).balances()).BTC?.total ?? '0');

async function customerOrder(who, id) {
  const { status, body } = await (await api(who)).get(`/api/v1/orders/${id}`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}

/** The stack's own audit read of routed-order lookups on one customer (svc-trade admin.audit.feed, as founder A). */
function lookupAudit(customerId, orderId) {
  const out = tool('local-test-gates.mjs', 'trade-audit', '--kind', 'venue_orders.get', '--account', customerId);
  const line = out.split('\n').find((l) => l.startsWith('TRADE_AUDIT_JSON '));
  if (!line) throw new Error(`trade-audit printed no rows line: ${out.slice(-300)}`);
  return JSON.parse(line.slice('TRADE_AUDIT_JSON '.length)).filter((row) => row.objectId === orderId);
}

/** One order through svc-trade's user-venue door as `who`, from their own venue account: prepare, sign with their TEST key, submit. */
async function doorOrder(who, walletKey, intent) {
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  const session = await api(who);
  const prepared = await session.post('/api/v1/venue/prepare', { owner, signer: { role: 'owner', address: owner }, intent });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  const p = prepared.body.prepared;
  const t = p.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await session.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: p.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
  return p.venueClientOrderId;
}

/** The routed order as the venue itself keeps it, and its fills: what every read of it must equal. */
async function venueTruth(owner, cloid, since) {
  const order = (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId: cloid })).value;
  const fills = (await venueRecord(owner, '/fills', { since })).value.filter((f) => f.venueClientOrderId === cloid);
  return { order, fills };
}

test.beforeAll(async ({ browser }) => {
  if (run.read().customer) return;
  test.setTimeout(240_000);
  const page = await browser.newPage();
  const customer = await fundedTrader(page, 'jcs18', '1000');
  await page.close();
  // The routed order the customer reports: their own venue account buys against another TEST trader's resting ask.
  const walletKey = keccak256(toHex(`intafaced TEST venue journey trader ${J} customer ${RUN}`));
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  await testDeposit(owner, 'USDC', '1000', `84532:${keccak256(toHex(`${J} ${RUN} ${owner} USDC`))}:0`);
  const seller = `${J}-seller-${RUN}`;
  await testDeposit(otherTraderKey(seller).address, 'BTC', '1', `84532:${keccak256(toHex(`${J} ${RUN} seller BTC`))}:0`);
  const resting = await otherTraderRun(seller, {
    kind: 'place_order',
    symbol: VENUE_SYMBOL,
    side: 'sell',
    type: 'limit',
    amount: AMOUNT,
    price: VENUE_ASK,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${seller}:ask`,
    builderFee: null,
  });
  expect(resting, JSON.stringify(resting).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  const venueSince = new Date(Date.now() - 60_000).toISOString();
  const routed = await doorOrder(customer, walletKey, {
    kind: 'place_order',
    symbol: VENUE_SYMBOL,
    side: 'buy',
    type: 'limit',
    amount: AMOUNT,
    price: VENUE_ASK,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${owner}:${VENUE_SYMBOL}:${J}-${RUN}`,
    builderFee: null,
  });
  await expect.poll(async () => (await venueTruth(owner, routed, venueSince)).order?.status, { timeout: 30_000 }).toBe('filled');
  // The customer reports the problem through their own support API, naming the order.
  const res = await (
    await api(customer)
  ).post('/api/support/trpc/create', {
    category: 'trading',
    subject: `TEST ${J} my order ${routed}`,
    body: `TEST ${J}: something is wrong with my order ${routed}.`,
    clientRequestId: `${J}:${RUN}:report`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  const ticket = res.body.result.data;
  // In the TEST agents' group, so founder B (the agent) may work it.
  // Founder B is appointed the desk's agent on the first agent call (help-centre.mjs appointAgent), as in
  // J-support-public-10; before that the lead cannot put B in a group (support.not_staff, run 42201499550).
  await deskData('agent', 'query', 'staffList', undefined);
  const { agent } = await deskPeople();
  const group = await ensureDeskGroup(`TEST ${J} agents`);
  if (!group.memberIds.includes(agent)) await deskData('lead', 'mutation', 'groupsAddMember', { groupId: group.id, userId: agent });
  await deskData('lead', 'mutation', 'ticketSetGroup', { ticketId: ticket.id, groupId: group.id });
  const customerId = (await api(customer)).userId;
  run.write({
    customer,
    customerId,
    ticketId: ticket.id,
    walletKey,
    owner,
    routed,
    venueSince,
  });
});

/**
 * #3 #4 only (Later): the customer's orders on our own TEST book, placed once on the first step that needs them, so the
 * routed-order steps never wait on our book.
 */
async function ownBook() {
  const state = run.read();
  if (state.reported) return state;
  const { customer } = state;
  // The order on our book the bust is about: a buy priced through the best ask, so it fills.
  const { ask } = await bestPrices(SYMBOL);
  const one = toUnits('1');
  const through = fromUnits(((toUnits(ask) * 105n) / 100n / one) * one);
  const reported = await placeOwnOrder(customer, SYMBOL, {
    type: 'limit',
    side: 'buy',
    amount: AMOUNT,
    price: through,
    clientOrderId: `${J}-filled-${RUN}`,
  });
  await expect.poll(async () => (await customerOrder(customer, reported.id)).status, { timeout: 30_000 }).toBe('closed');
  // Two resting buys well under the market: one stays live, the other's book entry is dropped in #3.
  const live = await placeOwnOrder(customer, SYMBOL, {
    type: 'limit',
    side: 'buy',
    amount: AMOUNT,
    price: await awayBid(80),
    clientOrderId: `${J}-live-${RUN}`,
  });
  const orphan = await placeOwnOrder(customer, SYMBOL, {
    type: 'limit',
    side: 'buy',
    amount: AMOUNT,
    price: await awayBid(81),
    clientOrderId: `${J}-orphan-${RUN}`,
  });
  run.write({ ...state, reported: reported.id, live: live.id, orphan: orphan.id, placedAt: Date.now() });
  return run.read();
}

const venueRead = (page) => page.locator('[data-venue-order-read]');

test(`${J} #1 opens a customer's routed order from the support desk: the venue order, fills and reject reason, read from the venue by the customer's address`, async ({
  page,
}) => {
  const { ticketId, routed, customerId, owner, venueSince } = run.read();
  const truth = await venueTruth(owner, routed, venueSince);
  expect(truth.fills.length).toBeGreaterThan(0);
  await founderSignIn(page, 'b');
  await page.goto(`${ADMIN}/support/${ticketId}`);
  const workspace = page.getByRole('region', { name: 'Ticket', exact: true });
  await workspace.getByRole('link', { name: `Open order ${routed}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/trade-ops/orders/${routed}\\?account=${customerId}$`));
  const read = venueRead(page);
  // Read by the customer's own address, the one their wallet placed it from: never one an operator typed.
  await expect(read).toHaveAttribute('data-order-id', routed);
  await expect(read).toHaveAttribute('data-account-id', customerId);
  await expect(read).toHaveAttribute('data-owner', owner);
  await expect(read.getByTestId('venue-read-owner')).toHaveText(owner);
  // The venue order as the venue keeps it: its status, what filled, every fill, and no reject reason recorded.
  await expect(read).toHaveAttribute('data-status', truth.order.status);
  await expect(read.getByTestId('venue-read-status')).toHaveText('Filled');
  expect(toUnits(await read.getAttribute('data-filled'))).toBe(toUnits(truth.order.filled));
  const shown = page.getByRole('region', { name: 'Venue fills', exact: true }).getByTestId('venue-read-fill');
  await expect(shown).toHaveCount(truth.fills.length);
  for (const fill of truth.fills) await expect(shown.and(page.locator(`[data-fill-id="${fill.fillId}"]`))).toHaveCount(1);
  await expect(read.getByTestId('venue-read-reject')).toHaveText('None recorded');
  await expect(page.locator('[data-not-connected]')).toHaveCount(0);
});

test(`${J} #2 reads the same order as the customer sees it: the customer's view and the venue read agree`, async ({ page, browser }) => {
  const { routed, customer, customerId, walletKey, owner, venueSince } = run.read();
  const truth = await venueTruth(owner, routed, venueSince);
  await founderSignIn(page, 'b');
  await page.goto(`${ADMIN}/trade-ops/orders/${routed}?account=${customerId}`);
  const read = venueRead(page);
  await expect(read).toHaveAttribute('data-order-id', routed);
  const operatorStatus = (await read.getByTestId('venue-read-status').textContent()).trim();
  const operatorFilled = await read.getAttribute('data-filled');
  const operatorFills = await page
    .getByRole('region', { name: 'Venue fills', exact: true })
    .getByTestId('venue-read-fill')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-fill-id')).sort());
  // The customer's own order page, on their own wallet, says the same.
  const context = await browser.newContext();
  const theirs = await context.newPage();
  await openVenuePage(theirs, customer, `/trade/orders/${routed}`, walletKey);
  const mine = theirs.getByTestId('venue-order');
  await expect(mine.getByTestId('venue-order-heading').locator('[data-cell="status"]')).toHaveText(operatorStatus);
  const theirFills = await mine.getByTestId('venue-order-fill').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-fill')).sort());
  expect(theirFills).toEqual(operatorFills);
  expect(theirFills).toEqual(truth.fills.map((f) => f.fillId).sort());
  await expect(mine.getByTestId('venue-order-facts')).toContainText(fromUnits(toUnits(operatorFilled)).replace(/\.?0+$/, ''));
  expect(toUnits(operatorFilled)).toBe(toUnits(truth.order.filled));
  await context.close();
});

test(`${J} #3 starts a reconcile sweep: orders checked and holds released counts; a second run releases none`, async ({ page }) => {
  test.setTimeout(300_000);
  const { customer, orphan, live, placedAt } = await ownBook();
  // A sweep looks only at orders unchanged for the owner's age floor (the stack's TEST value is 15 s,
  // tooling/scripts/local-stack-services/trade.mjs): the first sweep must already see the orphan.
  // oxlint-disable-next-line garden/no-real-clock-wait-in-tests -- the sweep compares the engine's live book with trade's own order age; the engine's book has no age door
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, placedAt + 20_000 - Date.now())));
  const orphanOrder = await customerOrder(customer, orphan);
  const hold = times(orphanOrder.price, orphanOrder.amount);
  // LOCAL TEST fault: the order leaves the book and its cancel is lost on the way to svc-trade (run 42212975613: a cancel
  // that arrives is released by trade itself, leaving no orphan). Trade still has the order open, holding its funds.
  tool('local-test-gates.mjs', 'engine-drop', SYMBOL, orphan);
  expect((await customerOrder(customer, orphan)).status).toBe('open');
  const usedBefore = await usdtUsed(customer);
  const totalBefore = await usdtTotal(customer);
  await founderSignIn(page, 'b');
  await page.goto(`${ADMIN}/trade-ops/orders`);
  const sweep = page.getByRole('region', { name: 'Reconcile sweep', exact: true });

  let runs = 0;
  const runSweep = async () => {
    await sweep.getByRole('button', { name: 'Start reconcile sweep', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByLabel('Reason (kept in the audit)', { exact: true }).fill(`TEST ${J} reported order problem`);
    await dialog.getByRole('button', { name: 'Start reconcile sweep', exact: true }).click();
    // The service confirms in the dialog, which stays open on its result. While it is open the page behind it is inert
    // (out of the accessibility tree), so the run's counts are read once it is closed (run 42206331204).
    await expect(dialog.getByRole('status')).toContainText('Swept', { timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const result = sweep.locator('[data-sweep-result]').nth(runs++);
    await expect(result).toBeVisible();
    return result;
  };

  // The first look sees the orphan missing from the book and releases nothing yet: an empty book and an empty fill
  // record are proof only on a second look at least the owner's wait apart (the stack's TEST wait is 15 s).
  const sighted = await runSweep();
  expect((await sighted.getAttribute('data-released-orders')).split(',')).not.toContain(orphan);
  expect(await usdtUsed(customer)).toBe(usedBefore);
  // oxlint-disable-next-line garden/no-wait-for-timeout -- the second look must be a real floor apart on the engine's live book, which has no age door
  await page.waitForTimeout(20_000);

  const first = await runSweep();
  const checked = Number(await first.getAttribute('data-checked'));
  expect(checked).toBeGreaterThan(0);
  expect(Number(await first.getAttribute('data-released'))).toBeGreaterThanOrEqual(1);
  expect((await first.getAttribute('data-released-orders')).split(',')).toContain(orphan);
  await expect(first).toContainText(`${checked} orders checked`);
  // The orphan's hold came back once: used fell by exactly its hold, nothing left the account.
  expect(usedBefore - (await usdtUsed(customer))).toBe(hold);
  expect(await usdtTotal(customer)).toBe(totalBefore);
  expect((await customerOrder(customer, orphan)).status).toBe('canceled');
  // The live order on the book was checked and left alone.
  expect((await customerOrder(customer, live)).status).toBe('open');

  // A second run after the release releases none.
  const second = await runSweep();
  await expect(second).toHaveAttribute('data-released', '0');
  await expect(second).toContainText('0 holds released');
  expect(usedBefore - (await usdtUsed(customer))).toBe(hold);
  expect((await customerOrder(customer, live)).status).toBe('open');
});

test(`${J} #4 proposes a trade bust: a second operator approves; the typed blocker trade_bust_recipe_missing, not the outside-service notice`, async ({
  page,
  browser,
}) => {
  const { customer, reported } = await ownBook();
  const fillsBefore = await ownOrderFills(customer, reported);
  const usdtBefore = await usdtTotal(customer);
  const btcBefore = await btcTotal(customer);
  await founderSignIn(page, 'b');
  await page.goto(`${ADMIN}/trade-ops/orders/${reported}`);
  const bust = page.getByRole('region', { name: 'Trade bust', exact: true });
  await bust.getByLabel('Reason (kept in the audit)', { exact: true }).fill(`TEST ${J} customer reported a wrong fill`);
  await bust.getByRole('button', { name: 'Propose a trade bust', exact: true }).click();
  const proposal = bust.locator('[data-bust-proposal]');
  await expect(proposal).toBeVisible();
  const approvalId = await proposal.getAttribute('data-approval-id');
  const payloadHash = await proposal.getAttribute('data-payload-hash');
  expect(approvalId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(proposal).toContainText('Waiting for a second operator');

  // Founder A, the finance operator, approves exactly that request.
  const context = await browser.newContext();
  const a = await context.newPage();
  await founderSignIn(a, 'a');
  await a.goto(`${ADMIN}/trade-ops/approvals`);
  // The pending list loads after the page and lands above the form, moving "Approve request": act once it is in, or a
  // press before it lands and a release after miss the button.
  await expect(a.getByRole('grid', { name: 'Approvals waiting for this operator', exact: true })).toBeVisible();
  await a.getByLabel('Approval id', { exact: true }).fill(approvalId);
  await a.getByLabel('Payload hash you reviewed', { exact: true }).fill(payloadHash);
  await a.getByRole('button', { name: 'Approve request', exact: true }).click();
  const approveDialog = a.getByRole('alertdialog');
  await expect(approveDialog).toBeVisible();
  await approveDialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(approveDialog.locator('[data-outcome=ok]')).toBeVisible();
  await context.close();

  // Approved, the bust is carried out by the service, which refuses it with its own typed blocker today.
  await bust.getByRole('button', { name: 'Carry out the approved bust', exact: true }).click();
  const outcome = bust.locator('[data-outcome]');
  await expect(outcome).toHaveAttribute('data-outcome', 'refused');
  await expect(outcome.locator('code')).toHaveText('trade_bust_recipe_missing');
  await expect(page.locator('[data-not-connected]')).toHaveCount(0);
  // Nothing moved: the fill stands and the balances are as they were.
  expect((await ownOrderFills(customer, reported)).map((f) => f.id)).toEqual(fillsBefore.map((f) => f.id));
  expect(await usdtTotal(customer)).toBe(usdtBefore);
  expect(await btcTotal(customer)).toBe(btcBefore);
});

test(`${J} #5 reads the audit of the lookup: one row with the agent, the customer and the time, which the customer sees in their own access list`, async ({
  page,
  browser,
}) => {
  const { customerId, routed, customer } = run.read();
  const agent = await founderSignIn(page, 'b');
  const before = lookupAudit(customerId, routed).length;
  const at = Date.now();
  await page.goto(`${ADMIN}/trade-ops/orders/${routed}?account=${customerId}`);
  await expect(venueRead(page)).toHaveAttribute('data-order-id', routed);
  // That one lookup wrote one row.
  const rows = lookupAudit(customerId, routed);
  expect(rows).toHaveLength(before + 1);
  const row = rows.at(-1);
  expect(row.operatorId).toBe(agent.userId);
  expect(row.accountId).toBe(customerId);
  expect(Math.abs(Date.parse(row.occurredAt) - at)).toBeLessThan(60_000);
  // The console's audit room shows it: the agent, the customer and the time.
  await page.goto(`${ADMIN}/trade-ops/audit?kind=venue_orders.get&account=${customerId}`);
  const shown = page.getByRole('table', { name: 'Audit rows', exact: true }).locator(`tr[data-audit-id="${row.id}"]`);
  await expect(shown).toHaveCount(1);
  await expect(shown.getByTestId('audit-operator')).toContainText(agent.userId);
  await expect(shown.getByTestId('audit-account')).toContainText(customerId);
  await expect(shown.locator('time')).toHaveAttribute('datetime', row.occurredAt);
  // And the customer sees that same row in their own access list: who looked, at which order, and when.
  const context = await browser.newContext();
  const theirs = await context.newPage();
  await signIn(theirs, customer);
  await theirs.goto('/uc/safe');
  await theirs.getByTestId('staff-access-link').click();
  await expect(theirs).toHaveURL(/\/uc\/safe\/staff-access$/);
  const list = theirs.getByTestId('staff-access');
  const mine = list.locator(`tr[data-access-id="${row.id}"]`);
  await expect(mine).toHaveCount(1);
  await expect(mine).toHaveAttribute('data-kind', 'venue_orders.get');
  await expect(mine).toHaveAttribute('data-object-id', routed);
  await expect(mine).toContainText('Looked up one of your routed orders');
  await expect(mine.getByTestId('staff-access-operator')).toHaveText(agent.userId);
  await expect(mine.locator('time')).toHaveAttribute('datetime', row.occurredAt);
  await context.close();
});
