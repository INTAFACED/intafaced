// World: book, restart
import { expect, test } from './journey.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME } from '../../../../tooling/scripts/local-test-founders.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, api, fund, signUpInBrowser, startService, stopService, toUnits } from './stack.mjs';
import { verify } from './desk.mjs';
import { takeBest } from './copy.mjs';
import { staffSignIn } from './staff.mjs';

// J-ops-console-02 steps #3 and #4: /accounts/:userId shows the money, trade, pay, cards, documents and tickets tabs for one
// account, each read loading or refusing on its own; with svc-trade stopped only the trade tab refuses and every other tab
// keeps what it showed (#3). And the risk card and indicator strip, which say there is no risk level and nothing is set
// rather than show a number (#4). Step #5 (each document's status and the viewer) is its own test,
// J-ops-console-02-documents.pw.mjs.
// #4 looks at the stack's second TEST founder, an account that always exists on the stack. #3 looks at a fresh TEST
// customer who has, each made as that customer through the running product: a deposit (TEST USDT posted through the real
// ledger), a trade (a buy filled on the real BTC/USDT book), a payment (a send to another person), a card (a TEST card from
// the stack's card simulator) and a support request. Each tab then shows that customer's own record, value for value, read
// from the service that holds it. #3's last clause, a staff member without the cards scope seeing "permission denied",
// signs in the stack's TEST support staff member (staff.mjs), whose role reads accounts, payments, trading and documents
// and not cards.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');
/** A time as the console prints when something happened (apps/admin as-of.ts): "15 Oct 2026, 10:02:03 UTC". */
const deskWhen = (iso) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} UTC`;
};
const DESK_TIME = /^\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}, \d{2}:\d{2}:\d{2} UTC$/;

/** A fresh TEST person, signed up and verified in a browser of their own. */
async function verifiedPerson(browser, prefix) {
  const tag = randomUUID().slice(0, 8);
  const who = { handle: `${prefix}${tag}`, email: `${prefix}-${tag}@local-test.invalid`, password: `Ops23-${tag}-Test!pass` };
  const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  try {
    await signUpInBrowser(page, who);
    await verify(page, who);
  } finally {
    await page.context().close();
  }
  return who;
}

/**
 * A fresh verified TEST customer with a deposit, a trade, a payment, a card and a support request, each made as that
 * customer through the running product, and what the product answered for each. Their balances are read last, through
 * the customer's own door, once every record above has moved their money.
 */
async function customerWithRecords(browser) {
  const who = await verifiedPerson(browser, 'ops23');
  const payee = await verifiedPerson(browser, 'ops2p');
  const tag = randomUUID().slice(0, 8);
  // The deposit: TEST USDT posted to the customer through the real ledger.
  expect(fund(who.email, 'USDT', '2000').tx, 'the TEST deposit posted to the ledger').toBeTruthy();
  const own = await api(who);
  // The trade: one buy that fills in full against the TEST market maker on the real BTC/USDT book.
  const order = await takeBest(who, 'buy', '0.001', `ops02-3-${tag}`);
  expect(toUnits(order.filled), 'the buy filled in full').toBe(toUnits('0.001'));
  // The payment: a send of TEST 5 USDT from the customer's primary space to another person, posted to the ledger.
  const spaces = await own.get(`/api/bank/trpc/spaces.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(spaces.status, JSON.stringify(spaces.body).slice(0, 300)).toBe(200);
  const from = spaces.body.result.data.find((space) => space.kind === 'primary' && space.assetId === 'USDT');
  expect(from?.id, 'the customer has a primary USDT space to pay from').toBeTruthy();
  const payeeId = (await api(payee)).userId;
  const paymentId = `ops02-pay-${tag}`;
  const paid = await own.post('/api/bank/trpc/transfers.toUser', {
    transferId: paymentId,
    fromSpaceId: from.id,
    toUserId: payeeId,
    amount: '5',
  });
  expect(paid.status, JSON.stringify(paid.body).slice(0, 300)).toBe(200);
  expect(paid.body.result.data.ledgerTxId, 'the payment posted to the ledger').toBeTruthy();
  // The card: one TEST virtual card from the stack's card simulator.
  const cardId = randomUUID();
  const issued = await own.post('/api/bank/trpc/cards.issue', {
    cardId,
    assetId: 'USDT',
    perAuthorizationLimit: '50',
    cardType: 'virtual',
  });
  expect(issued.status, JSON.stringify(issued.body).slice(0, 300)).toBe(200);
  const card = issued.body.result.data;
  expect(card).toMatchObject({ id: cardId, status: 'active', simulated: true, cardType: 'virtual', assetId: 'USDT' });
  // The support request.
  const asked = await own.post('/api/support/trpc/create', {
    category: 'account',
    subject: `TEST J-ops-console-02 request ${tag}`,
    body: `TEST J-ops-console-02 #3 support request ${tag}`,
    clientRequestId: `J-ops-console-02:3:${tag}`,
  });
  expect(asked.status, JSON.stringify(asked.body).slice(0, 300)).toBe(200);
  const ticket = asked.body.result.data;
  expect(ticket.userId, 'the support request is this customer’s').toBe(own.userId);
  // The balances, as the customer's own breakdown reads them from the ledger.
  const breakdown = await own.get('/api/bank/trpc/portfolio.balanceBreakdown');
  expect(breakdown.status, JSON.stringify(breakdown.body).slice(0, 300)).toBe(200);
  const assets = breakdown.body.result.data.assets;
  // The deposit, less what the payment and the buy took, is still there in USDT; the buy brought BTC.
  expect(assets.map((a) => a.assetId)).toEqual(expect.arrayContaining(['USDT', 'BTC']));
  expect(toUnits(assets.find((a) => a.assetId === 'USDT').total) > 0n, 'the customer holds USDT').toBe(true);
  return { userId: own.userId, payeeId, order, paymentId, card, ticket, assets };
}

/** The table row of `read` whose first cell is exactly `first`. */
const rowOf = (page, read, first) =>
  page
    .getByTestId(read)
    .locator('tbody tr')
    .filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

/** The customer's balance of each coin, as the console's balances table must show it: coin, total, available and each lock. */
const balanceRows = (assets) =>
  assets.map((a) => {
    const lock = (kind) => a.locked.find((l) => l.kind === kind)?.amount ?? '0';
    return [a.assetId, a.total, a.available, lock('hold'), lock('escrow'), lock('stake'), lock('collateral'), 'Open'];
  });

async function secondFounder() {
  const ctx = await makeContext({ log: () => {} });
  const vault = JSON.parse(readFileSync(path.join(ctx.paths.stateDir, FOUNDER_VAULT_NAME), 'utf8'));
  const customer = vault.founders[1]?.userId;
  if (!customer) throw new Error('the stack has no second founder yet: start the stack first (pnpm local:stack)');
  return customer;
}

/**
 * A read's state: 'read' when it answered, or its refusal (heading and code; a read can refuse for its own reason, such as
 * a scope). Times are left out, so the same answer read twice compares equal.
 */
async function readState(section) {
  await expect(section.getByText(/As of /).first()).toBeVisible({ timeout: 60_000 });
  const failed = section.getByTestId('read-failed');
  if (!(await failed.count())) return 'read';
  const text = await failed.innerText();
  return `${text.split('\n')[0]} / ${/Code: (\S+)/.exec(text)?.[1] ?? 'no code'}`;
}

/** Every read on one tab of the record, by its id, after opening that tab. */
async function tabStates(page, tab) {
  await page.getByTestId(`customer-tab-${tab}`).click();
  const panel = page.getByTestId(`customer-panel-${tab}`);
  await expect(panel).toBeVisible({ timeout: 60_000 });
  const states = {};
  for (const section of await panel.locator('[data-testid^="read-"]:not([data-testid="read-failed"])').all())
    states[await section.getAttribute('data-testid')] = await readState(section);
  return states;
}

test('J-ops-console-02 #4 the risk card says no risk level and the indicator strip says not set, never a made-up number', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const customer = await secondFounder();
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/accounts/${customer}`, { waitUntil: 'load' });
  await expect(page.getByTestId('customer-record-id')).toHaveText(customer, { timeout: 60_000 });
  // No risk ruleset exists, so the record says there is no risk level and why, never a made-up score.
  const risk = page.getByTestId('customer-risk-card');
  await expect(risk).toContainText('Risk: No risk level');
  await expect(risk).toContainText('No risk ruleset exists');
  // ...and the indicator strip says "not set" with its code, never a made-up value.
  const indicators = page.getByTestId('customer-indicator-strip');
  await expect(indicators).toContainText('Indicators: Not set');
  await expect(indicators).toContainText('compliance.indicators_unset');
  // Nothing numeric: once slice ids and codes are left out, neither shows a digit, a meter or a progress bar.
  for (const part of [risk, indicators]) {
    const words = (await part.innerText()).replace(/\b[A-Z]+(?:-[a-z]+)+-\d+\b/g, '').replace(/Code: \S+/g, '');
    expect(words, 'no score, level number or value').not.toMatch(/\d/);
    await expect(part.getByRole('meter')).toHaveCount(0);
    await expect(part.getByRole('progressbar')).toHaveCount(0);
  }
});

test('J-ops-console-02 #3 one customer record: six tabs each loading or refusing on its own', async ({ page, browser, stepPicture }) => {
  test.setTimeout(720_000);
  const record = await customerWithRecords(browser);
  const { userId: customer, order, card, ticket } = record;
  await founderSignIn(page, 'a');
  /** A part no service can read for one account: its own words, "no source", and the code that tells it from a refusal. */
  const noSource = async (id, label) => {
    await expect(page.getByTestId(`unwired-${id}`)).toContainText(`${label}: no source`);
    await expect(page.getByTestId(`unwired-${id}`)).toContainText('Code: ops.customer_record_source_unwired');
  };
  /** The one row of a list read, cell by cell (the last cell is its Open button). */
  const onlyRow = async (p, read, cells) => {
    const rows = p.getByTestId(read).locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator('td')).toHaveText(cells);
  };
  /** Each of the customer's records, value for value, on the tab that holds it. */
  const orderCells = [
    deskWhen(order.datetime),
    order.symbol,
    order.side,
    order.type,
    order.status,
    order.amount,
    order.filled,
    order.price,
    'Open',
  ];
  const paymentCells = [DESK_TIME, 'Sent', record.payeeId, '5', 'USDT', 'Posted', 'Open'];
  const ticketCells = [deskWhen(ticket.createdAt), ticket.subject, ticket.category, ticket.status, 'Open'];
  const balancesShown = async (p) => {
    await expect(p.getByTestId('read-bank.customer-balances').locator('tbody tr')).toHaveCount(record.assets.length);
    for (const cells of balanceRows(record.assets))
      await expect(rowOf(p, 'read-bank.customer-balances', cells[0]).locator('td')).toHaveText(cells);
  };

  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  await page.getByLabel('Account id').fill(customer.toUpperCase());
  await page.getByRole('button', { name: 'Open customer record' }).click();
  await page.waitForURL((url) => url.pathname === `/accounts/${customer}`, { timeout: 60_000 });
  await expect(page.getByTestId('customer-record-id')).toHaveText(customer);
  for (const tab of ['money', 'trade', 'pay', 'cards', 'documents', 'tickets'])
    await expect(page.getByTestId(`customer-tab-${tab}`)).toBeVisible();

  // Money: the ledger's balances of this customer load, one row per coin, each figure exactly what the customer's own
  // breakdown reads (the USDT the deposit brought, less the payment and the buy; the BTC the buy brought). svc-pay's three
  // deposit reads answer too. Each deposit one by one has no operator read, and the tab says so with its code.
  expect(await tabStates(page, 'money')).toEqual({
    'read-bank.customer-balances': 'read',
    'read-money.deposit-addresses': 'read',
    'read-money.deposit-freezes': 'read',
    'read-money.deposit-travel-rule': 'read',
  });
  await balancesShown(page);
  await noSource('money.deposits', 'Each deposit and withdrawal of this account');

  // Trade: svc-trade's orders of this customer load, and the one order is the buy they placed, as svc-trade holds it;
  // its restriction history loads and says nothing is logged, since this customer was never restricted.
  expect(await tabStates(page, 'trade')).toEqual({ 'read-trade.orders': 'read', 'read-trade.controls': 'read' });
  await onlyRow(page, 'read-trade.orders', orderCells);
  await page.getByTestId('read-trade.orders').getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByTestId('read-trade.orders').getByTestId('row-detail')).toContainText(order.id);
  await page.getByTestId('read-trade.orders').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('read-trade.controls').getByTestId('list-empty')).toHaveText(
    'svc-trade has no restriction logged for this account: it has never been restricted or restored here.',
  );
  await noSource('trade.positions', 'Positions and margin');

  // Pay: svc-bank's payments of this customer load, and the one payment is the send of 5 USDT to the other person, posted;
  // svc-pay's two allowlist reads load and say this customer set neither.
  expect(await tabStates(page, 'pay')).toEqual({
    'read-pay.payments': 'read',
    'read-pay.allowlist-mode': 'read',
    'read-pay.allowlist-policy': 'read',
  });
  await onlyRow(page, 'read-pay.payments', paymentCells);
  await page.getByTestId('read-pay.payments').getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByTestId('read-pay.payments').getByTestId('row-detail')).toContainText(record.paymentId);
  await page.getByTestId('read-pay.payments').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('read-pay.allowlist-mode').getByTestId('record').locator('dd')).toHaveText(['no', '—']);
  await expect(page.getByTestId('read-pay.allowlist-policy').getByTestId('record').locator('dd')).toHaveText(['no', '—', '—', '—']);
  await noSource('pay.checkouts', 'Payments to merchants at checkout');

  // Documents: identity's document list for this account answers in words, and the per-document decisions identity does
  // not keep name their blocker.
  await page.getByTestId('customer-tab-documents').click();
  await expect(page.getByTestId('customer-panel-documents')).toBeVisible({ timeout: 60_000 });
  await expect(
    page
      .getByTestId('read-identity.documents')
      .getByText(/As of /)
      .first(),
  ).toBeVisible();
  await expect(page.getByTestId('unwired-documents.decisions')).toContainText('no source');

  // Cards: svc-bank's card read loads, and the one card is the TEST card the customer was issued, as svc-bank holds it.
  expect(await tabStates(page, 'cards')).toEqual({ 'read-cards.list': 'read' });
  await onlyRow(page, 'read-cards.list', [
    card.id,
    'Active',
    card.cardType,
    card.panTail,
    card.assetId,
    'yes',
    card.perAuthorizationLimit,
    'Open',
  ]);
  await noSource('cards.payments', 'Card payments of this account');

  // Tickets: svc-support's requests from this customer load, and the one request is the one they sent, as svc-support holds it.
  expect(await tabStates(page, 'tickets')).toEqual({ 'read-tickets.list': 'read' });
  await onlyRow(page, 'read-tickets.list', ticketCells);
  await noSource('tickets.thread', 'Each request’s messages');

  // svc-trade down: only the trade tab refuses, each of its reads as unavailable in its own words, and every other tab
  // (money, pay, cards, documents and tickets) shows exactly what it showed before, values included.
  /** A tab's whole state: each read's state, and its panel's words with the moments of reading left out. */
  const tabSnapshot = async (tab) => {
    const reads = await tabStates(page, tab);
    const words = (await page.getByTestId(`customer-panel-${tab}`).innerText()).replace(/As of [^\n]*/g, '');
    return { reads, words };
  };
  const others = ['money', 'pay', 'cards', 'documents', 'tickets'];
  const before = {};
  for (const tab of others) before[tab] = await tabSnapshot(tab);
  expect(before.money.words).toContain(balanceRows(record.assets)[0][1]);
  expect(before.pay.words).toContain(record.payeeId);
  expect(before.cards.words).toContain(card.id);
  expect(before.tickets.words).toContain(ticket.subject);
  let failure = null;
  try {
    await stopService('trade');
    await page.goto(`${ADMIN}/accounts/${customer}?tab=trade`, { waitUntil: 'load' });
    await expect(page.getByTestId('customer-record-id')).toHaveText(customer, { timeout: 60_000 });
    expect(await tabStates(page, 'trade')).toEqual({
      'read-trade.orders': 'COULD NOT LOAD SVC-TRADE’S ORDERS FOR THIS ACCOUNT / no code',
      'read-trade.controls': 'COULD NOT LOAD SVC-TRADE’S RESTRICTION HISTORY / no code',
    });
    for (const read of ['read-trade.orders', 'read-trade.controls']) {
      const refused = page.getByTestId(read).getByTestId('read-failed');
      await expect(refused).toHaveAttribute('data-tone', 'danger');
      await expect(refused).toContainText('Unavailable.');
      await expect(refused).toContainText('svc-trade did not answer.');
      await expect(page.getByTestId(read).locator('tbody tr')).toHaveCount(0);
      await expect(page.getByTestId(read).getByTestId('list-empty')).toHaveCount(0);
    }
    for (const tab of others) {
      expect(await tabSnapshot(tab), `the ${tab} tab is as it was`).toEqual(before[tab]);
      await expect(page.getByTestId(`customer-panel-${tab}`).getByTestId('read-failed').filter({ hasText: 'trade' })).toHaveCount(0);
    }
  } catch (error) {
    failure = error;
  }
  // Bring svc-trade back for the journeys after this one; a failure to restart never hides the tab's own failure.
  try {
    await startService('trade');
  } catch (restart) {
    failure ??= restart;
  }
  if (failure) throw failure;
  // svc-trade answers again, with the same order.
  await page.goto(`${ADMIN}/accounts/${customer}?tab=trade`, { waitUntil: 'load' });
  expect(await tabStates(page, 'trade')).toEqual({ 'read-trade.orders': 'read', 'read-trade.controls': 'read' });
  await onlyRow(page, 'read-trade.orders', orderCells);

  // A staff member without the cards scope: the stack's TEST support staff member (staff.mjs), whose role reads accounts,
  // payments, trading and documents and not cards. The customer's balances, order and payment load for them as they did
  // for the founder, so the refusal is the cards tab's own; on the cards tab they see "permission denied", and nothing is
  // read for them there.
  const staff = await (await browser.newContext()).newPage();
  try {
    await staffSignIn(staff, browser, 'support');
    for (const tab of ['money', 'trade', 'pay', 'documents', 'tickets']) {
      await staff.goto(`${ADMIN}/accounts/${customer}?tab=${tab}`, { waitUntil: 'load' });
      await expect(staff.getByTestId('customer-record-id')).toHaveText(customer, { timeout: 60_000 });
      await expect(staff.getByTestId(`customer-panel-${tab}`)).toBeVisible({ timeout: 60_000 });
      await expect(staff.getByTestId('customer-tab-denied')).toHaveCount(0);
      if (tab === 'documents') await expect(staff.getByTestId('read-identity.documents')).toBeVisible();
    }
    await staff.goto(`${ADMIN}/accounts/${customer}?tab=money`, { waitUntil: 'load' });
    expect(await readState(staff.getByTestId('read-bank.customer-balances'))).toBe('read');
    await balancesShown(staff);
    await staff.goto(`${ADMIN}/accounts/${customer}?tab=trade`, { waitUntil: 'load' });
    expect(await readState(staff.getByTestId('read-trade.orders'))).toBe('read');
    await onlyRow(staff, 'read-trade.orders', orderCells);
    await staff.goto(`${ADMIN}/accounts/${customer}?tab=pay`, { waitUntil: 'load' });
    expect(await readState(staff.getByTestId('read-pay.payments'))).toBe('read');
    await onlyRow(staff, 'read-pay.payments', paymentCells);

    await staff.goto(`${ADMIN}/accounts/${customer}?tab=cards`, { waitUntil: 'load' });
    await expect(staff.getByTestId('customer-record-id')).toHaveText(customer, { timeout: 60_000 });
    const cards = staff.getByTestId('customer-panel-cards');
    const denied = cards.getByTestId('customer-tab-denied');
    await expect(denied.locator('strong')).toHaveText('Permission denied');
    await expect(denied).toContainText(
      'Your staff role may not read cards (the cards area), so nothing on this tab was read for this account.',
    );
    await expect(denied).toContainText('Code: ops.customer_record_permission_denied');
    await expect(cards.getByTestId('read-cards.list')).toHaveCount(0);
    await expect(cards.getByTestId('unwired-cards.list')).toHaveCount(0);
    await expect(cards).not.toContainText(card.id);
    // The step's picture: the record's cards tab as this staff member sees it, permission denied.
    await stepPicture(staff);
  } finally {
    await staff.context().close();
  }
});
