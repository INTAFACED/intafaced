import { test, expect } from '@playwright/test';
import { UNBUILT, connectWallet, dexRun } from './dex.mjs';

// J-dex-protocol-10, in the running app (docs/roadmap/journeys.json): place, edit and cancel limit, take-profit, stop and
// trailing orders from my own wallet. One test per step, titled "J-dex-protocol-10 #<n>", run in order with one TEST
// wallet for the whole run (its key is kept in the run's journey state). The orders are the person's own: TEST token A
// sits in the order vault under the wallet's own deposit credit and is only ever withdrawn to the maker; nothing posts to
// the ledger. While the keeper or a node is absent the room says rail.crypto; a blank order cap schedule refuses with its
// own code.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the Orders room (/dex/orders) is not in the Web3 route table, so #1 to #9 stop at its heading;
// - svc-dex (D-limit-dca-01 to -04: the order session, vault credit, trigger keeper and order list) does not run on the
//   stack, and the stack has no TEST chain, oracle or keeper for the price-cross steps (#3, #4, #5, #7, #8).
const J = 'J-dex-protocol-10';
const dex = dexRun(J);
// TEST token A, known only to the TEST wallet. 6 decimals, like the TEST token in J-dex-protocol-01.
const TOKEN_A = { address: '0x00000000000000000000000000000000000a11ce', name: 'TEST Token A', version: '1', decimals: 6, nonce: 0 };

test.describe.configure({ mode: 'default' });

const room = (page) => page.getByRole('main');
const orderForm = (page) => page.getByRole('form', { name: 'New order' });
const orderList = (page) => page.getByRole('table', { name: 'Your orders' });
const orderRow = (page, text) => orderList(page).getByRole('row').filter({ hasText: text });

/** Opens the Orders room with the run's wallet connected. */
async function openOrders(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/dex/orders');
  await expect(room(page).getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible(UNBUILT);
  return wallet;
}

/** Fills the new-order form: `kind` is the order type's name as the form lists it. */
async function fillOrder(page, { kind, side = 'Sell', amount, trigger, expiry }) {
  const form = orderForm(page);
  await form.getByRole('combobox', { name: 'Order type' }).selectOption({ label: kind });
  await form.getByRole('radio', { name: side }).check();
  await form.getByRole('textbox', { name: /^Amount/ }).fill(amount);
  if (trigger !== undefined) await form.getByRole('textbox', { name: /^Trigger price/ }).fill(trigger);
  if (expiry !== undefined) await form.getByRole('textbox', { name: /^Expires/ }).fill(expiry);
}

test(`${J} starts: a TEST wallet holding TEST token A and no order yet`, async ({ page }) => {
  dex.start();
  await openOrders(page);
  await expect(orderList(page)).toContainText('No orders yet.');
});

test(`${J} #1 opens Orders and signs the order session: scope, expiry and cap shown before the wallet prompt; a replayed challenge is refused`, async ({
  page,
}) => {
  const wallet = await openOrders(page);
  const session = room(page).getByRole('region', { name: 'Order session' });
  await expect(session).toBeVisible(UNBUILT);
  // Everything the signature grants is on the page before the wallet is asked.
  for (const term of ['Scope', 'Expires', 'Cap']) await expect(session.getByRole('term').filter({ hasText: term })).toBeVisible();
  expect(wallet.requests).toHaveLength(0);
  await session.getByRole('button', { name: 'Sign the order session' }).click();
  await expect(session.getByRole('status')).toContainText('Order session signed');
  expect(wallet.requests.map((r) => r.method)).toContain('eth_signTypedData_v4');

  // The same signed challenge sent again is refused by the service, by its code.
  await session.getByRole('button', { name: 'Send the last signature again' }).click();
  await expect(session.getByRole('alert')).toContainText('dex.auth.challenge_replayed');
});

test(`${J} #2 deposits 100 TEST and creates a sell-above order with an expiry: the vault credit is 100 and the order is open; no expiry is refused`, async ({
  page,
}) => {
  await openOrders(page);
  const vault = room(page).getByRole('region', { name: 'Order vault' });
  await vault.getByRole('textbox', { name: /^Deposit amount/ }).fill('100', UNBUILT);
  await vault.getByRole('button', { name: 'Deposit' }).click();
  await expect(vault.getByTestId('vault-credit')).toHaveText('100 TEST A');

  // A price order with no expiry never reaches the service.
  await fillOrder(page, { kind: 'Sell above', amount: '100', trigger: '1.25' });
  await orderForm(page).getByRole('button', { name: 'Place order' }).click();
  await expect(orderForm(page).getByRole('alert')).toContainText('A price order needs an expiry.');

  await fillOrder(page, { kind: 'Sell above', amount: '100', trigger: '1.25', expiry: '24' });
  await orderForm(page).getByRole('button', { name: 'Place order' }).click();
  await expect(orderRow(page, 'Sell above')).toContainText('Open');
});

test(`${J} #3 watches the price cross the trigger: the keeper fills at least the minimum output, 40 of 100 leaves 60, a stale oracle leaves it open with the reason`, async ({
  page,
}) => {
  await openOrders(page);
  const row = orderRow(page, 'Sell above');
  await expect(row).toBeVisible(UNBUILT);
  // The TEST price crosses the trigger with enough depth for 40 only: a partial fill leaves 60 open.
  await expect(row).toContainText('Filled 40 of 100');
  await expect(row).toContainText('60 open');
  await row.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('dialog', { name: 'Order history' });
  await expect(history).toContainText('Received at least the minimum output');
  // With the oracle stale the order stays open and the attempt log says why.
  await expect(history.getByRole('list', { name: 'Keeper attempts' })).toContainText('Price is stale');
  await expect(row).toContainText('Open');
});

test(`${J} #4 creates a take-profit and stop pair: one leg filling cancels its sibling "cancelled by link"; a take-profit below the stop on a sell is refused`, async ({
  page,
}) => {
  await openOrders(page);
  // A take-profit priced under its own stop on a sell cannot both make sense: refused before any call.
  await orderForm(page).getByRole('combobox', { name: 'Order type' }).selectOption({ label: 'Take-profit and stop' }, UNBUILT);
  await orderForm(page)
    .getByRole('textbox', { name: /^Amount/ })
    .fill('10');
  await orderForm(page)
    .getByRole('textbox', { name: /^Take-profit price/ })
    .fill('0.90');
  await orderForm(page)
    .getByRole('textbox', { name: /^Stop price/ })
    .fill('1.10');
  await orderForm(page)
    .getByRole('textbox', { name: /^Expires/ })
    .fill('24');
  await orderForm(page).getByRole('button', { name: 'Place order' }).click();
  await expect(orderForm(page).getByRole('alert')).toContainText('On a sell, the take-profit must be above the stop.');

  await orderForm(page)
    .getByRole('textbox', { name: /^Take-profit price/ })
    .fill('1.40');
  await orderForm(page)
    .getByRole('textbox', { name: /^Stop price/ })
    .fill('0.80');
  await orderForm(page).getByRole('button', { name: 'Place order' }).click();
  await expect(orderRow(page, 'Take-profit')).toContainText('Open');
  await expect(orderRow(page, 'Stop')).toContainText('Open');
  // The take-profit leg fills in full; its stop sibling ends with the link as its reason.
  await expect(orderRow(page, 'Take-profit')).toContainText('Filled');
  await expect(orderRow(page, 'Stop')).toContainText('Cancelled by link');
});

test(`${J} #5 creates a bracket and a trailing stop: the bracket covers the filled part of its parent, the trailing trigger follows the price one way only`, async ({
  page,
}) => {
  await openOrders(page);
  await orderForm(page).getByRole('combobox', { name: 'Order type' }).selectOption({ label: 'Bracket' }, UNBUILT);
  await fillOrder(page, { kind: 'Bracket', side: 'Buy', amount: '20', trigger: '0.95', expiry: '24' });
  await orderForm(page).getByRole('button', { name: 'Place order' }).click();
  const bracket = orderRow(page, 'Bracket');
  await expect(bracket).toBeVisible();
  // Its exit legs cover only the part of the parent that filled.
  await expect(bracket).toContainText(/Covers \d+(\.\d+)? of 20 filled/);

  await fillOrder(page, { kind: 'Trailing stop', amount: '10', trigger: '5%', expiry: '24' });
  await orderForm(page).getByRole('button', { name: 'Place order' }).click();
  const trailing = orderRow(page, 'Trailing stop');
  const triggerOf = async () => Number((await trailing.getByTestId('order-trigger').innerText()).replace(/[^\d.]/g, ''));
  const first = await triggerOf();
  // A rise moves the trigger up; a fall afterwards leaves it where it was.
  await expect.poll(triggerOf).toBeGreaterThan(first);
  const raised = await triggerOf();
  await expect.poll(triggerOf).toBe(raised);
});

test(`${J} #6 opens the order list and filters by state: open, filled and expired orders, paged at 100, with history`, async ({ page }) => {
  await openOrders(page);
  const filter = room(page).getByRole('combobox', { name: 'State' });
  for (const state of ['Open', 'Filled', 'Expired']) {
    await filter.selectOption({ label: state }, UNBUILT);
    const rows = orderList(page).getByRole('row');
    // Every row shown is in the chosen state (the header row aside).
    const count = await rows.count();
    for (let i = 1; i < count; i += 1) await expect(rows.nth(i)).toContainText(state);
  }
  await expect(room(page).getByRole('navigation', { name: 'Pages' })).toContainText('100 a page');
  await orderList(page).getByRole('row').nth(1).getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('dialog', { name: 'Order history' }).getByRole('listitem').first()).toBeVisible();
});

test(`${J} #7 edits the trigger of an open order, then a filled one: the version goes up and the keeper uses the new price; the filled one is not editable`, async ({
  page,
}) => {
  await openOrders(page);
  const open = orderRow(page, 'Open').first();
  await open.getByRole('button', { name: 'Edit' }).click(UNBUILT);
  const edit = page.getByRole('dialog', { name: 'Edit order' });
  const version = Number((await open.getByTestId('order-version').innerText()).replace(/\D/g, ''));
  await edit.getByRole('textbox', { name: /^Trigger price/ }).fill('1.30');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(open.getByTestId('order-version')).toHaveText(`v${version + 1}`);
  await expect(open.getByTestId('order-trigger')).toContainText('1.30');
  await open.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('dialog', { name: 'Order history' })).toContainText(`Keeper checked at 1.30 (v${version + 1})`);
  await page.keyboard.press('Escape');

  const filled = orderRow(page, 'Filled').first();
  await expect(filled.getByRole('button', { name: 'Edit' })).toBeDisabled();
  await expect(filled).toContainText('A filled order cannot be edited.');
});

test(`${J} #8 cancels an order and withdraws: the unfilled rest returns to the wallet; a keeper fill in the same second is refused by the stored state`, async ({
  page,
}) => {
  await openOrders(page);
  const vault = room(page).getByRole('region', { name: 'Order vault' });
  const credit = async () => Number((await vault.getByTestId('vault-credit').innerText()).replace(/[^\d.]/g, ''));
  const open = orderRow(page, 'Open').first();
  await open.getByRole('button', { name: 'Cancel' }).click(UNBUILT);
  await page.getByRole('dialog', { name: 'Cancel order' }).getByRole('button', { name: 'Cancel order' }).click();
  await expect(open).toContainText('Cancelled');
  // A keeper fill landing in the same second finds the order cancelled in the stored state and is refused.
  await open.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('dialog', { name: 'Order history' })).toContainText('Fill refused: the order was cancelled');
  await page.keyboard.press('Escape');

  const before = await credit();
  await vault.getByRole('button', { name: 'Withdraw to my wallet' }).click();
  await expect(vault.getByRole('status')).toContainText(`${before} TEST A returned to your wallet`);
  await expect(vault.getByTestId('vault-credit')).toHaveText('0 TEST A');
});

test(`${J} #9 sends tokens straight to the vault by mistake: the credit is unchanged and the sweep returns them to the maker only`, async ({
  page,
}) => {
  const wallet = await openOrders(page);
  const vault = room(page).getByRole('region', { name: 'Order vault' });
  const before = await vault.getByTestId('vault-credit').innerText(UNBUILT);
  // A plain token transfer to the vault address (sent from the wallet on the TEST chain) is not a deposit: no credit moves.
  await expect(vault.getByRole('status')).toContainText('Tokens sent to the vault without a deposit are not credited');
  await expect(vault.getByTestId('vault-credit')).toHaveText(before);
  await vault.getByRole('button', { name: 'Return stray tokens' }).click();
  await expect(vault.getByRole('status')).toContainText(`Returned to ${wallet.address}`);
});
