// World: book, gates, restart, stack
import { test, expect } from './journey.mjs';
import { ADMIN } from './admin.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { deskData, deskPeople, ensureDeskGroup } from './help-centre.mjs';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { api, fromUnits, journeyState, toUnits, tool } from './stack.mjs';
import { connectWhenAsked } from './dex.mjs';
import { installTestWallet } from './test-wallet.mjs';
import { otherTraderKey, otherTraderRun, testDeposit, venueForThisFile, venueInfo, venueRecord } from './venue.mjs';

// J-cex-spot-18 "I look up a customer's routed order, and later reconcile or bust a trade on our own book", in the
// running app and the founder console. One test per step, titled "J-cex-spot-18 #<n>". The support agent is founder B
// (the stack's TEST desk agent, as in J-support-public-10).
//
// #1 #2 #5 (row d115): the customer is a fresh verified TEST account with a TEST wallet whose own venue account on the
// stack's TEST venue holds TEST USDC. Through svc-trade's user-venue door (on for this file) they buy TEST BTC-USDC
// against another TEST trader's resting ask, so the order fills: that routed order is the one they report. The agent
// reads it from the venue by the customer's own address, the customer's own order page agrees, and the lookup's audit
// row is in the customer's own access list. INTAFACED holds none of it: the customer holds nothing on our ledger, so the
// file runs custody off, as launch does.
//
// #3 #4 (Later: they work only while INTAFACED holds customer money, on our own book, the custodial layer) are in
// J-cex-spot-18-custodial.pw.mjs, which keeps today's custody switch.
const J = 'J-cex-spot-18';
const AMOUNT = '0.001';
const RUN = Date.now().toString(36);
// One state per run: the TEST venue keeps its accounts in memory, so a customer an earlier run made has no venue order
// after a stack restart. Within a run, a retried test acts as the same customer.
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? RUN}`);

test.describe.configure({ mode: 'serial' });
venueForThisFile(test);
const VENUE_SYMBOL = 'BTC-USDC';
const VENUE_ASK = '60010';

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
  const customer = await signUp(page, 'jcs18');
  await verify(page, customer);
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

const venueRead = (page) => page.locator('[data-venue-order-read]');

test(`${J} #1 opens a customer's routed order from the support desk: the venue order, fills and reject reason, read from the venue by the customer's address`, async ({
  founders,
  stepPicture,
}) => {
  const { ticketId, routed, customerId, owner, venueSince } = run.read();
  const truth = await venueTruth(owner, routed, venueSince);
  expect(truth.fills.length).toBeGreaterThan(0);
  const { page } = await founders.console('b');
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
  await expect.poll(async () => toUnits(await read.getAttribute('data-filled'))).toBe(toUnits(truth.order.filled));
  const shown = page.getByRole('region', { name: 'Venue fills', exact: true }).getByTestId('venue-read-fill');
  await expect(shown).toHaveCount(truth.fills.length);
  for (const fill of truth.fills) await expect(shown.and(page.locator(`[data-fill-id="${fill.fillId}"]`))).toHaveCount(1);
  await expect(read.getByTestId('venue-read-reject')).toHaveText('None recorded');
  await expect(page.locator('[data-not-connected]')).toHaveCount(0);
  await stepPicture(page);
});

test(`${J} #2 reads the same order as the customer sees it: the customer's view and the venue read agree`, async ({
  founders,
  browser,
  stepPicture,
}) => {
  const { routed, customer, customerId, walletKey, owner, venueSince } = run.read();
  const truth = await venueTruth(owner, routed, venueSince);
  const { page } = await founders.console('b');
  await page.goto(`${ADMIN}/trade-ops/orders/${routed}?account=${customerId}`);
  const read = venueRead(page);
  await expect(read).toHaveAttribute('data-order-id', routed);
  const operatorStatus = (await read.getByTestId('venue-read-status').textContent()).trim();
  const operatorFilled = await read.getAttribute('data-filled');
  const operatorRows = page.getByRole('region', { name: 'Venue fills', exact: true }).getByTestId('venue-read-fill');
  await expect(operatorRows).toHaveCount(truth.fills.length);
  const operatorFills = await operatorRows.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-fill-id')).sort());
  // The customer reaches their own order page from /trade/orders (reached from the menus) on their own wallet: it says the same.
  const context = await browser.newContext();
  const theirs = await context.newPage();
  const { chainId } = await venueInfo();
  const wallet = await installTestWallet(theirs, { chainId, privateKey: walletKey });
  await signIn(theirs, customer);
  await theirs.goto('/trade/orders');
  await theirs
    .getByRole('group', { name: 'Which orders', exact: true })
    .getByRole('button', { name: 'Connected wallet', exact: true })
    .click();
  await expect(theirs).toHaveURL(/product=venue/);
  const address = theirs.getByTestId('venue-wallet-address');
  await connectWhenAsked(theirs, address);
  await expect(address).toHaveText(wallet.address.toLowerCase());
  await theirs.getByTestId('venue-history').locator(`a[href="/trade/orders/${routed}"]`).click();
  await expect(theirs).toHaveURL(new RegExp(`/trade/orders/${routed}$`));
  const mine = theirs.getByTestId('venue-order');
  await expect(mine.getByTestId('venue-order-heading').locator('[data-cell="status"]')).toHaveText(operatorStatus);
  await expect(mine.getByTestId('venue-order-fill')).toHaveCount(truth.fills.length);
  const theirFills = await mine.getByTestId('venue-order-fill').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-fill')).sort());
  expect(theirFills).toEqual(operatorFills);
  expect(theirFills).toEqual(truth.fills.map((f) => f.fillId).sort());
  await expect(mine.getByTestId('venue-order-facts')).toContainText(fromUnits(toUnits(operatorFilled)).replace(/\.?0+$/, ''));
  expect(toUnits(operatorFilled)).toBe(toUnits(truth.order.filled));
  await context.close();
  await stepPicture(page);
});

test(`${J} #5 reads the audit of the lookup: one row with the agent, the customer and the time, which the customer sees in their own access list`, async ({
  founders,
  browser,
  stepPicture,
}) => {
  const { customerId, routed, customer } = run.read();
  const { page, founder: agent } = await founders.console('b');
  // The audit is read once, after the lookup: each read signs founder a in with a fresh TOTP step, and a founder has at
  // most two steps per 30 s window. Every row on this order before `at` came from an earlier lookup (steps 1 and 2, or
  // an earlier attempt of this test), so the rows from `at` on are this lookup's.
  const at = Date.now();
  await page.goto(`${ADMIN}/trade-ops/orders/${routed}?account=${customerId}`);
  await expect(venueRead(page)).toHaveAttribute('data-order-id', routed);
  // That one lookup wrote one row.
  const rows = lookupAudit(customerId, routed).filter((r) => Date.parse(r.occurredAt) >= at);
  expect(rows).toHaveLength(1);
  const [row] = rows;
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
  await stepPicture(page);
});
