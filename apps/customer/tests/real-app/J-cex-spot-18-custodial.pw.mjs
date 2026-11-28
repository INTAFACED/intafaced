// World: book, gates, restart
import { test, expect } from './journey.mjs';
import { ADMIN } from './admin.mjs';
import { awayBid, fundedTrader } from './desk.mjs';
import { ownOrderFills, placeOwnOrder } from './own-book.mjs';
import { api, bestPrices, fromUnits, journeyState, times, toUnits, tool } from './stack.mjs';

// J-cex-spot-18's Later steps, #3 and #4: they work only while INTAFACED holds customer money, on our own book, the
// custodial layer. #1, #2 and #5, the routed-order steps launch runs, are proven custody off in J-cex-spot-18.pw.mjs.
// As a custodial part file this keeps today's custody switch (launch-custody.mjs CUSTODIAL_PART), since it funds its
// customer through our ledger.
//
// The customer is a fresh verified TEST account funded with TEST 1000 USDT on our own book, with one filled buy, one
// resting buy that stays live, and one resting buy whose book entry the stack drops and whose cancel it loses
// (`local-test-gates.mjs engine-drop`, a LOCAL TEST fault that stops and restarts svc-trade): its hold is then an orphan.
// The support agent is founder B (the stack's TEST desk agent); the finance operator who approves is founder A.
const J = 'J-cex-spot-18';
const SYMBOL = 'BTC/USDT';
const AMOUNT = '0.001';
const RUN = Date.now().toString(36);
// One state per run; within a run, a retried test acts as the same customer.
const run = journeyState(`${J}-custodial-${process.env.JOURNEY_RUN_ID ?? RUN}`);

test.describe.configure({ mode: 'serial' });

const usdtUsed = async (who) => toUnits((await (await api(who)).balances()).USDT?.used ?? '0');
const usdtTotal = async (who) => toUnits((await (await api(who)).balances()).USDT?.total ?? '0');
const btcTotal = async (who) => toUnits((await (await api(who)).balances()).BTC?.total ?? '0');

async function customerOrder(who, id) {
  const { status, body } = await (await api(who)).get(`/api/v1/orders/${id}`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}

test.beforeAll(async ({ browser }) => {
  if (run.read().customer) return;
  test.setTimeout(240_000);
  const page = await browser.newPage();
  const customer = await fundedTrader(page, 'jcs18c', '1000');
  await page.close();
  run.write({ customer });
});

/** The customer's orders on our own TEST book, placed once, on the first step that needs them. */
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

test(`${J} #3 starts a reconcile sweep: orders checked and holds released counts; a second run releases none`, async ({
  founders,
  stepPicture,
}) => {
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
  const { page } = await founders.console('b');
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
  await expect(sighted).toHaveAttribute('data-released-orders');
  await expect.poll(async () => (await sighted.getAttribute('data-released-orders')).split(',')).not.toContain(orphan);
  expect(await usdtUsed(customer)).toBe(usedBefore);
  // oxlint-disable-next-line garden/no-wait-for-timeout -- the second look must be a real floor apart on the engine's live book, which has no age door
  await page.waitForTimeout(20_000);

  const first = await runSweep();
  await expect.poll(async () => Number(await first.getAttribute('data-checked'))).toBeGreaterThan(0);
  const checked = Number(await first.getAttribute('data-checked'));
  await expect.poll(async () => Number(await first.getAttribute('data-released'))).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await first.getAttribute('data-released-orders')).split(',')).toContain(orphan);
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
  await stepPicture(page);
});

test(`${J} #4 proposes a trade bust: a second operator approves; the typed blocker trade_bust_recipe_missing, not the outside-service notice`, async ({
  founders,
  stepPicture,
}) => {
  const { customer, reported } = await ownBook();
  const fillsBefore = await ownOrderFills(customer, reported);
  const usdtBefore = await usdtTotal(customer);
  const btcBefore = await btcTotal(customer);
  const { page } = await founders.console('b');
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

  // Founder A, the finance operator, approves exactly that request, in a console session of their own.
  const { page: a } = await founders.console('a');
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
  await stepPicture(page);
});
