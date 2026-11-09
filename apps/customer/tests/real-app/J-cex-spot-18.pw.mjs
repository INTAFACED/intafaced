// World: book, gates, restart, stack
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { awayBid, fundedTrader, signIn } from './desk.mjs';
import { asDesk, deskPeople, ensureDeskGroup } from './help-centre.mjs';
import { api, bestPrices, fromUnits, journeyState, times, toUnits, tool } from './stack.mjs';

// J-cex-spot-18 "I look up a customer's order and reconcile or bust a trade", in the running app and the founder console.
// One test per step, titled "J-cex-spot-18 #<n>". The support agent is founder B (the stack's TEST desk agent, as in
// J-support-public-10); the finance operator who approves is founder A. The customer is a fresh TEST account funded with
// TEST 1000 USDT, with one filled buy (the order they report), one resting buy that stays live, and one resting buy whose
// book entry the stack drops and whose cancel it loses (`local-test-gates.mjs engine-drop`, a LOCAL TEST fault that
// stops and restarts svc-trade): its hold is then an orphan.
const J = 'J-cex-spot-18';
const SYMBOL = 'BTC/USDT';
const AMOUNT = '0.001';
const RUN = Date.now().toString(36);
const run = journeyState(J);

test.describe.configure({ mode: 'serial' });

const usdtUsed = async (who) => toUnits((await (await api(who)).balances()).USDT?.used ?? '0');
const usdtTotal = async (who) => toUnits((await (await api(who)).balances()).USDT?.total ?? '0');
const btcTotal = async (who) => toUnits((await (await api(who)).balances()).BTC?.total ?? '0');

async function customerOrder(who, id) {
  const { status, body } = await (await api(who)).get(`/api/v1/orders/${id}`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}

async function customerFills(who, id) {
  const { status, body } = await (await api(who)).get(`/api/v1/orders/${id}/trades?limit=100`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return Array.isArray(body) ? body : (body.trades ?? body.items ?? []);
}

async function place(who, body) {
  const res = await (await api(who)).post('/api/v1/orders', { symbol: SYMBOL, timeInForce: 'GTC', ...body });
  // A new order answers 201 Created (run 42196142904); any other answer is a refusal to read.
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
  return res.body;
}

/** A desk call that must succeed; its data. */
async function desk(who, kind, procedure, input) {
  const res = await asDesk(who, kind, procedure, input);
  if (res.json?.result?.data === undefined) throw new Error(`${procedure} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return res.json.result.data;
}

/** The stack's own audit read of order lookups on one customer (svc-trade admin.audit.feed, as founder A). */
function lookupAudit(customerId, orderId) {
  const out = tool('local-test-gates.mjs', 'trade-audit', '--kind', 'orders.get', '--account', customerId);
  const line = out.split('\n').find((l) => l.startsWith('TRADE_AUDIT_JSON '));
  if (!line) throw new Error(`trade-audit printed no rows line: ${out.slice(-300)}`);
  return JSON.parse(line.slice('TRADE_AUDIT_JSON '.length)).filter((row) => row.objectId === orderId);
}

test.beforeAll(async ({ browser }) => {
  if (run.read().customer) return;
  test.setTimeout(240_000);
  const page = await browser.newPage();
  const customer = await fundedTrader(page, 'jcs18', '1000');
  await page.close();
  // The order the customer reports: a buy priced through the best ask, so it fills.
  const { ask } = await bestPrices(SYMBOL);
  const one = toUnits('1');
  const through = fromUnits(((toUnits(ask) * 105n) / 100n / one) * one);
  const reported = await place(customer, {
    type: 'limit',
    side: 'buy',
    amount: AMOUNT,
    price: through,
    clientOrderId: `${J}-filled-${RUN}`,
  });
  await expect.poll(async () => (await customerOrder(customer, reported.id)).status, { timeout: 30_000 }).toBe('closed');
  // Two resting buys well under the market: one stays live, the other's book entry is dropped in #3.
  const live = await place(customer, {
    type: 'limit',
    side: 'buy',
    amount: AMOUNT,
    price: await awayBid(80),
    clientOrderId: `${J}-live-${RUN}`,
  });
  const orphan = await place(customer, {
    type: 'limit',
    side: 'buy',
    amount: AMOUNT,
    price: await awayBid(81),
    clientOrderId: `${J}-orphan-${RUN}`,
  });
  // The customer reports the problem through their own support API, naming the order.
  const res = await (
    await api(customer)
  ).post('/api/support/trpc/create', {
    category: 'trading',
    subject: `TEST ${J} my order ${reported.id}`,
    body: `TEST ${J}: something is wrong with order ${reported.id}.`,
    clientRequestId: `${J}:${RUN}:report`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  const ticket = res.body.result.data;
  // In the TEST agents' group, so founder B (the agent) may work it.
  // Founder B is appointed the desk's agent on the first agent call (help-centre.mjs appointAgent), as in
  // J-support-public-10; before that the lead cannot put B in a group (support.not_staff, run 42201499550).
  await desk('agent', 'query', 'staffList', undefined);
  const { agent } = await deskPeople();
  const group = await ensureDeskGroup(`TEST ${J} agents`);
  if (!group.memberIds.includes(agent)) await desk('lead', 'mutation', 'groupsAddMember', { groupId: group.id, userId: agent });
  await desk('lead', 'mutation', 'ticketSetGroup', { ticketId: ticket.id, groupId: group.id });
  const customerId = (await api(customer)).userId;
  run.write({ customer, customerId, ticketId: ticket.id, reported: reported.id, live: live.id, orphan: orphan.id, placedAt: Date.now() });
});

const orderRead = (page) => page.locator('[data-order-read]');

test(`${J} #1 opens /trade-ops/orders/:id from the support desk: status, fills and reject reason from the read`, async ({ page }) => {
  const { ticketId, reported, customer, customerId } = run.read();
  await founderSignIn(page, 'b');
  await page.goto(`${ADMIN}/support/${ticketId}`);
  const workspace = page.getByRole('region', { name: 'Ticket', exact: true });
  await workspace.getByRole('link', { name: `Open order ${reported}` }).click();
  await expect(page).toHaveURL(new RegExp(`/trade-ops/orders/${reported}$`));
  // From the order read, whatever the order's state: a filled order is not "not in the open projection".
  await expect(page.getByText('This order is not in the open projection')).toHaveCount(0);
  const read = orderRead(page);
  await expect(read).toHaveAttribute('data-order-id', reported);
  await expect(read).toHaveAttribute('data-account-id', customerId);
  await expect(read.getByTestId('order-read-status')).toHaveText('Filled');
  const fills = await customerFills(customer, reported);
  expect(fills.length).toBeGreaterThan(0);
  await expect(page.getByRole('region', { name: 'Fills' }).getByTestId('order-read-fill')).toHaveCount(fills.length);
  await expect(read.getByTestId('order-read-reject')).toHaveText('None recorded');
  await expect(page.locator('[data-not-connected]')).toHaveCount(0);
});

test(`${J} #2 reads the same order as the customer sees it: the customer's view and the operator's read agree`, async ({
  page,
  browser,
}) => {
  const { reported, customer } = run.read();
  const mine = await customerOrder(customer, reported);
  const fills = await customerFills(customer, reported);
  await founderSignIn(page, 'b');
  await page.goto(`${ADMIN}/trade-ops/orders/${reported}`);
  const read = orderRead(page);
  // The operator's read in the customer's own words, and the same figures.
  await expect(read).toHaveAttribute('data-customer-status', mine.status);
  expect(Number(await read.getAttribute('data-filled'))).toBe(Number(mine.filled));
  await expect(read.getByTestId('order-read-filled')).toContainText(fromUnits(toUnits(mine.filled)).replace(/\.?0+$/, ''));
  await expect(page.getByRole('region', { name: 'Fills' }).getByTestId('order-read-fill')).toHaveCount(fills.length);
  // And the customer's own page says the same.
  const context = await browser.newContext();
  const theirs = await context.newPage();
  await signIn(theirs, customer);
  await theirs.goto(`/trade/orders/${reported}`);
  await expect(theirs.getByTestId('page-heading')).toContainText('Filled');
  await expect(theirs.getByTestId('orders-fill')).toHaveCount(fills.length);
  await context.close();
});

test(`${J} #3 starts a reconcile sweep: orders checked and holds released counts; a second run releases none`, async ({ page }) => {
  test.setTimeout(300_000);
  const { customer, orphan, live, placedAt } = run.read();
  // A sweep looks only at orders unchanged for the owner's age floor (the stack's TEST value is 15 s,
  // tooling/scripts/local-stack-services/trade.mjs): the first sweep must already see the orphan.
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
  const sweep = page.getByRole('region', { name: 'Reconcile sweep' });

  let runs = 0;
  const runSweep = async () => {
    await sweep.getByRole('button', { name: 'Start reconcile sweep' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByLabel('Reason (kept in the audit)').fill(`TEST ${J} reported order problem`);
    await dialog.getByRole('button', { name: 'Start reconcile sweep' }).click();
    // The service confirms in the dialog, which stays open on its result. While it is open the page behind it is inert
    // (out of the accessibility tree), so the run's counts are read once it is closed (run 42206331204).
    await expect(dialog.getByRole('status')).toContainText('Swept', { timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Close' }).click();
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
  const { customer, reported } = run.read();
  const fillsBefore = await customerFills(customer, reported);
  const usdtBefore = await usdtTotal(customer);
  const btcBefore = await btcTotal(customer);
  await founderSignIn(page, 'b');
  await page.goto(`${ADMIN}/trade-ops/orders/${reported}`);
  const bust = page.getByRole('region', { name: 'Trade bust' });
  await bust.getByLabel('Reason (kept in the audit)').fill(`TEST ${J} customer reported a wrong fill`);
  await bust.getByRole('button', { name: 'Propose a trade bust' }).click();
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
  // press before it lands and a release after miss the button (J-cex-spot-17 #4, main run 42455893390, #7536).
  await expect(a.getByRole('grid', { name: 'Approvals waiting for this operator' })).toBeVisible();
  await a.getByLabel('Approval id', { exact: true }).fill(approvalId);
  await a.getByLabel('Payload hash you reviewed').fill(payloadHash);
  await a.getByRole('button', { name: 'Approve request' }).click();
  const approveDialog = a.getByRole('alertdialog');
  await expect(approveDialog).toBeVisible();
  await approveDialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(approveDialog.locator('[data-outcome=ok]')).toBeVisible();
  await context.close();

  // Approved, the bust is carried out by the service, which refuses it with its own typed blocker today.
  await bust.getByRole('button', { name: 'Carry out the approved bust' }).click();
  const outcome = bust.locator('[data-outcome]');
  await expect(outcome).toHaveAttribute('data-outcome', 'refused');
  await expect(outcome.locator('code')).toHaveText('trade_bust_recipe_missing');
  await expect(page.locator('[data-not-connected]')).toHaveCount(0);
  // Nothing moved: the fill stands and the balances are as they were.
  expect((await customerFills(customer, reported)).map((f) => f.id)).toEqual(fillsBefore.map((f) => f.id));
  expect(await usdtTotal(customer)).toBe(usdtBefore);
  expect(await btcTotal(customer)).toBe(btcBefore);
});

test(`${J} #5 reads the audit of the lookup: one row with the agent, the customer and the time`, async ({ page }) => {
  const { customerId, reported } = run.read();
  const agent = await founderSignIn(page, 'b');
  const before = lookupAudit(customerId, reported).length;
  const at = Date.now();
  await page.goto(`${ADMIN}/trade-ops/orders/${reported}`);
  await expect(orderRead(page)).toHaveAttribute('data-order-id', reported);
  // That one lookup wrote one row.
  const rows = lookupAudit(customerId, reported);
  expect(rows).toHaveLength(before + 1);
  const row = rows.at(-1);
  expect(row.operatorId).toBe(agent.userId);
  expect(row.accountId).toBe(customerId);
  expect(Math.abs(Date.parse(row.occurredAt) - at)).toBeLessThan(60_000);
  // The console's audit room shows it: the agent, the customer and the time.
  await page.goto(`${ADMIN}/trade-ops/audit?kind=orders.get&account=${customerId}`);
  const shown = page.getByRole('table', { name: 'Audit rows' }).locator(`tr[data-audit-id="${row.id}"]`);
  await expect(shown).toHaveCount(1);
  await expect(shown.getByTestId('audit-operator')).toContainText(agent.userId);
  await expect(shown.getByTestId('audit-account')).toContainText(customerId);
  await expect(shown.locator('time')).toHaveAttribute('datetime', row.occurredAt);
});
