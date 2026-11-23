// World: book, restart
import { expect, test } from './journey.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { FOUNDER_VAULT_NAME } from '../../../../tooling/scripts/local-test-founders.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, api, fund, signUpInBrowser, startService, stopService, toUnits } from './stack.mjs';
import { pictureFromTop, verify } from './desk.mjs';
import { takeBest } from './copy.mjs';
import { staffSignIn } from './staff.mjs';

// J-ops-console-02 steps #3 and #4: /accounts/:userId shows the money, trade, pay, cards, documents and tickets tabs for one
// account, each read loading or refusing on its own, and a part no service can read for one account names why; with svc-trade
// stopped only the trade tab's read refuses and every other read keeps its state (#3). And the risk card and indicator strip,
// which say there is no risk level and nothing is set rather than show a number (#4).
// #3's last clause, a staff member without the cards scope seeing "permission denied", signs in the stack's TEST support
// staff member (staff.mjs). Step #5
// (each document's status and the viewer) is its own test, J-ops-console-02-documents.pw.mjs.
// #4 looks at the stack's second TEST founder, an account that always exists on the stack. #3 looks at a fresh TEST
// customer who has, each made through the product's own door as that customer: a deposit (TEST USDT through the real
// ledger), a trade (a buy filled on the real BTC/USDT book), a payment (a send to another person), a card (a TEST card
// from the stack's card simulator) and a support request. The console has a per-account read of the card, so that tab
// shows it; for the deposit, the trade, the payment and the support request no service has an operator read of one
// account, and each of those tabs says so in words with its code in place of a list.

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
 * A fresh verified TEST customer with a deposit, a trade, a payment, a card and a support request, each made through the
 * running product as that customer: `usdt` TEST USDT through the real ledger, one buy filled in full on the real
 * BTC/USDT book, one send of TEST 5 USDT to another verified person, one TEST virtual card, and one support request.
 */
async function customerWithRecords(browser, usdt) {
  const who = await verifiedPerson(browser, 'ops23');
  const payee = await verifiedPerson(browser, 'ops2p');
  const tag = who.handle.slice(-8);
  // The deposit.
  expect(fund(who.email, 'USDT', usdt).tx, 'the TEST deposit posted to the ledger').toBeTruthy();
  const own = await api(who);
  if (!own.userId) throw new Error(`sign-in for ${who.email} gave no user id`);
  // The trade: one buy that fills in full against the TEST market maker on the real book.
  const order = await takeBest(who, 'buy', '0.001', `J-ops-console-02-3-${tag}`);
  expect(order.id, 'the trade has an order id').toBeTruthy();
  expect(toUnits(order.filled), 'the buy filled in full').toBe(toUnits('0.001'));
  // The payment: a send from the customer's own USDT to another person, posted to the ledger.
  const spaces = await own.get(`/api/bank/trpc/spaces.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(spaces.status, JSON.stringify(spaces.body).slice(0, 300)).toBe(200);
  const from = spaces.body.result.data.find((space) => space.kind === 'primary' && space.assetId === 'USDT');
  expect(from?.id, 'the customer has a primary USDT space to pay from').toBeTruthy();
  const paid = await own.post('/api/bank/trpc/transfers.toUser', {
    transferId: `ops23-pay-${tag}`,
    fromSpaceId: from.id,
    toUserId: (await api(payee)).userId,
    amount: '5',
  });
  expect(paid.status, JSON.stringify(paid.body).slice(0, 300)).toBe(200);
  expect(paid.body.result.data.ledgerTxId, 'the payment posted to the ledger').toBeTruthy();
  // The card.
  const cardId = randomUUID();
  const issued = await own.post('/api/bank/trpc/cards.issue', {
    cardId,
    assetId: 'USDT',
    perAuthorizationLimit: '50',
    cardType: 'virtual',
  });
  expect(issued.status, JSON.stringify(issued.body).slice(0, 300)).toBe(200);
  expect(issued.body.result.data).toMatchObject({ status: 'active', simulated: true });
  // The support request.
  const asked = await own.post('/api/support/trpc/create', {
    category: 'account',
    subject: `TEST J-ops-console-02 request ${tag}`,
    body: `TEST J-ops-console-02 #3 support request ${tag}`,
    clientRequestId: `J-ops-console-02:3:${tag}`,
  });
  expect(asked.status, JSON.stringify(asked.body).slice(0, 300)).toBe(200);
  expect(asked.body.result.data.id, 'the support request was stored').toBeTruthy();
  expect(asked.body.result.data.userId, 'the support request is this customer’s').toBe(own.userId);
  return { userId: own.userId, cardId };
}

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
  const { userId: customer, cardId } = await customerWithRecords(browser, '2000');
  await founderSignIn(page, 'a');
  /** A part no service can read for one account: its own words, "no source", and the code that tells it from a refusal. */
  const noSource = async (id, label) => {
    await expect(page.getByTestId(`unwired-${id}`)).toContainText(`${label}: no source`);
    await expect(page.getByTestId(`unwired-${id}`)).toContainText('Code: ops.customer_record_source_unwired');
  };
  /** The facts of a read that answered with a single record: each label with its value, in the order shown. */
  const facts = (read) => page.getByTestId(read).getByTestId('record');

  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  await page.getByLabel('Account id').fill(customer.toUpperCase());
  await page.getByRole('button', { name: 'Open customer record' }).click();
  await page.waitForURL((url) => url.pathname === `/accounts/${customer}`, { timeout: 60_000 });
  await expect(page.getByTestId('customer-record-id')).toHaveText(customer);
  for (const tab of ['money', 'trade', 'pay', 'cards', 'documents', 'tickets'])
    await expect(page.getByTestId(`customer-tab-${tab}`)).toBeVisible();

  // Money: svc-pay's three reads of this customer's deposits answer. The ledger's balance read refuses on its own, in
  // words and with its code: svc-bank asks for the treasury permission admin:treasury, which a founder session never
  // carries, so a founder's record cannot show the balance and says why in its place. The customer's deposit itself has
  // no operator read for one account, and the tab says so with its code.
  const money = await tabStates(page, 'money');
  expect(money).toEqual({
    'read-bank.customer-balances': 'COULD NOT LOAD THE CUSTOMER’S BALANCES / scope.denied',
    'read-money.deposit-addresses': 'read',
    'read-money.deposit-freezes': 'read',
    'read-money.deposit-travel-rule': 'read',
  });
  const balances = page.getByTestId('read-bank.customer-balances');
  await expect(balances.getByTestId('read-failed')).toContainText('Refused your session.');
  await expect(balances.getByTestId('read-failed')).toContainText('admin:treasury');
  await expect(balances.locator('tbody tr')).toHaveCount(0);
  await expect(page.getByTestId('unwired-money.deposits')).toContainText('no source');
  await noSource('money.deposits', 'Each deposit and withdrawal of this account');

  // Trade: svc-trade's restriction history answers for this customer, who has traded and never been restricted, so it
  // says nothing is logged; the customer's orders and positions, which no service can read for one account, name why.
  await page.getByTestId('customer-tab-trade').click();
  await expect(page.getByTestId('customer-panel-trade')).toBeVisible({ timeout: 60_000 });
  expect(await readState(page.getByTestId('read-trade.controls'))).toBe('read');
  await expect(page.getByTestId('read-trade.controls').getByTestId('list-empty')).toContainText(
    'svc-trade has no restriction logged for this account',
  );
  await expect(page.getByTestId('read-trade.controls').getByTestId('read-failed')).toHaveCount(0);
  await expect(page.getByTestId('unwired-trade.orders')).toContainText('no source');
  await noSource('trade.orders', 'Open orders and trade history');
  await noSource('trade.positions', 'Positions and margin');

  // Pay: svc-pay's two allowlist reads both answer for this customer, who has set neither: allowlist-only withdrawals
  // are off and one-time sends are not allowed. The customer's payments, which svc-pay cannot list for one account,
  // name why.
  const pay = await tabStates(page, 'pay');
  expect(Object.keys(pay)).toEqual(expect.arrayContaining(['read-pay.allowlist-mode', 'read-pay.allowlist-policy']));
  expect(pay).toEqual({ 'read-pay.allowlist-mode': 'read', 'read-pay.allowlist-policy': 'read' });
  await expect(facts('read-pay.allowlist-mode')).toHaveText(/^\s*Allowlist-only withdrawals\s*no\s*Set\s*—\s*$/);
  await expect(facts('read-pay.allowlist-policy')).toHaveText(
    /^\s*One-time sends allowed\s*no\s*Coin\s*—\s*Largest one-time send\s*—\s*Set\s*—\s*$/,
  );
  await noSource('pay.payments', 'Payments sent and received');

  // Documents: identity's document list for this account answers in words (a list or "holds no document"), and the
  // per-document decisions identity does not keep name their blocker.
  await page.getByTestId('customer-tab-documents').click();
  await expect(page.getByTestId('customer-panel-documents')).toBeVisible({ timeout: 60_000 });
  const documents = page.getByTestId('read-identity.documents');
  await expect(documents.getByText(/As of /).first()).toBeVisible();
  await expect(page.getByTestId('unwired-documents.decisions')).toContainText('no source');

  // Cards: svc-bank's card read answers with this customer's TEST card, active and virtual; card payments, which no
  // service can read for one account, name why.
  const cards = await tabStates(page, 'cards');
  expect(cards['read-cards.list'], "svc-bank's card read answered").toBe('read');
  expect(cards, 'the cards tab makes that one read').toEqual({ 'read-cards.list': 'read' });
  const card = page.getByTestId('read-cards.list').locator('tbody tr').filter({ hasText: cardId });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Active');
  await expect(card).toContainText('virtual');
  await expect(page.getByTestId('unwired-cards.payments')).toContainText('no source');
  await expect(page.getByTestId('unwired-cards.payments')).toContainText('ops.customer_record_source_unwired');
  await noSource('cards.payments', 'Card payments of this account');

  // Tickets: svc-support has no read of one customer's requests, so the tab reads nothing and names why in place of a list.
  await page.getByTestId('customer-tab-tickets').click();
  await expect(page.getByTestId('customer-panel-tickets')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('unwired-tickets.list')).toContainText('no source');
  await expect(page.getByTestId('unwired-tickets.list')).toContainText('ops.customer_record_source_unwired');
  await noSource('tickets.list', 'Support requests from this account');
  await expect(page.getByTestId('customer-panel-tickets').getByTestId('read-failed')).toHaveCount(0);

  // svc-trade down: the trade tab's read refuses as unavailable, and every other tab (money, pay, cards, documents and
  // tickets) keeps the state it had before, so only the trade tab refuses.
  /** A tab's whole state: each read's state, and its panel's words with the moments of reading left out. */
  const tabSnapshot = async (tab) => {
    const reads = await tabStates(page, tab);
    const words = (await page.getByTestId(`customer-panel-${tab}`).innerText())
      .replace(/As of [^\n]*/g, '')
      .replace(/as read at \d{1,2} \w{3} \d{4}, \d{2}:\d{2}:\d{2} UTC/g, 'as read at <time>');
    return { reads, words };
  };
  const before = {
    money: await tabSnapshot('money'),
    pay: await tabSnapshot('pay'),
    cards: await tabSnapshot('cards'),
    documents: await tabSnapshot('documents'),
    tickets: await tabSnapshot('tickets'),
  };
  expect(before.pay.reads).toEqual(pay);
  expect(before.money.reads).toEqual(money);
  expect(before.cards.reads).toEqual(cards);
  expect(before.cards.words.toLowerCase(), 'the cards tab holds the customer’s card').toContain(cardId);
  expect(before.tickets.reads).toEqual({});
  expect(Object.keys(before.money.reads)).toContain('read-bank.customer-balances');
  expect(Object.keys(before.documents.reads)).toContain('read-identity.documents');
  let failure = null;
  try {
    await stopService('trade');
    await page.goto(`${ADMIN}/accounts/${customer}`, { waitUntil: 'load' });
    await expect(page.getByTestId('customer-record-id')).toHaveText(customer, { timeout: 60_000 });
    await page.getByTestId('customer-tab-trade').click();
    await expect(page.getByTestId('customer-panel-trade')).toBeVisible({ timeout: 60_000 });
    const refused = page.getByTestId('read-trade.controls').getByTestId('read-failed');
    await expect(refused).toBeVisible({ timeout: 60_000 });
    // Unavailable, not a refused session or a part not switched on: the stopped service is the reason, in the tab's own
    // words. A service that does not answer gives no code, and the read shows nothing rather than an empty history.
    await expect(refused).toHaveAttribute('data-tone', 'danger');
    await expect(refused).toContainText('Could not load svc-trade’s restriction history');
    await expect(refused).toContainText('Unavailable.');
    await expect(refused).toContainText('svc-trade did not answer.');
    expect(await readState(page.getByTestId('read-trade.controls'))).toBe('COULD NOT LOAD SVC-TRADE’S RESTRICTION HISTORY / no code');
    await expect(page.getByTestId('read-trade.controls').getByTestId('list-empty')).toHaveCount(0);
    // The step's picture: the record's tabs, with the trade tab refusing on its own while svc-trade is stopped.
    await pictureFromTop(page, stepPicture);
    for (const tab of ['money', 'pay', 'cards', 'documents', 'tickets']) {
      const now = await tabSnapshot(tab);
      expect(now, `the ${tab} tab is as it was`).toEqual(before[tab]);
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
  // svc-trade answers again, so the journeys after this one find it as it was.
  await page.goto(`${ADMIN}/accounts/${customer}?tab=trade`, { waitUntil: 'load' });
  await expect(page.getByTestId('customer-panel-trade')).toBeVisible({ timeout: 60_000 });
  expect(await readState(page.getByTestId('read-trade.controls'))).toBe('read');

  // A staff member without the cards scope sees "permission denied" on the cards tab: the stack's TEST support staff member
  // (staff.mjs), whose role reads accounts, payments, trading and documents and not cards. Nothing is read for them
  // there, so the customer's card is not on it, and the other tabs still load for them, so the refusal is the cards
  // tab's own and not the whole record's.
  const staff = await (await browser.newContext()).newPage();
  try {
    await staffSignIn(staff, browser, 'support');
    await staff.goto(`${ADMIN}/accounts/${customer}?tab=cards`, { waitUntil: 'load' });
    await expect(staff.getByTestId('customer-record-id')).toHaveText(customer, { timeout: 60_000 });
    const cards = staff.getByTestId('customer-panel-cards');
    await expect(cards.getByTestId('customer-tab-denied')).toContainText('Permission denied');
    await expect(cards.getByTestId('customer-tab-denied')).toContainText('the cards area');
    await expect(cards.getByTestId('customer-tab-denied')).toContainText('ops.customer_record_permission_denied');
    await expect(cards.getByTestId('unwired-cards.list')).toHaveCount(0);
    await expect(cards.getByTestId('read-cards.list')).toHaveCount(0);
    await expect(cards).not.toContainText(cardId);
    await staff.goto(`${ADMIN}/accounts/${customer}?tab=documents`, { waitUntil: 'load' });
    await expect(staff.getByTestId('customer-panel-documents')).toBeVisible({ timeout: 60_000 });
    await expect(staff.getByTestId('customer-tab-denied')).toHaveCount(0);
    await expect(staff.getByTestId('read-identity.documents')).toBeVisible();
  } finally {
    await staff.context().close();
  }
});
