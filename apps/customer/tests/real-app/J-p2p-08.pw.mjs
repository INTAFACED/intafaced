// World: freeze, gates
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, fromUnits, fund, journeyState, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { METHOD, p2p, readyTaker, refusalCode, restorePasskey, testInstrument } from './p2p.mjs';

// J-p2p-08, in the running app (docs/roadmap/journeys.json; the step words are project-state
// operation-zero/modules/p2p/acceptance/journeys.md): raise a dispute, answer it, add evidence, and settle or get a
// ruling. One test per step, titled "J-p2p-08 #<n>", run in order on one verified TEST seller with a sell ad and one
// verified TEST buyer, on the stack's TEST bank transfer (`local-test-gates.mjs p2p`). Each step works on its own order
// so one step's outcome never decides another's. Fiat never moves; the coins move only through the ledger's escrow, read
// here as the order's `escrowHeld` and the seller's free balance.
//
// Written by a test-writer from the step's words (OWNER 212), before the dispute stages, the counterparty response, the
// mutual settlement, the evidence store and "my disputes" are built (P-disputes-security-01 to -04). The door names
// these tests call for a part not built yet are the ones its slice names in project-state
// operation-zero/modules/p2p/specs/p2p-disputes-security.md (`disputes.respond`, `disputes.proposeSettlement`,
// `disputes.acceptSettlement`, `disputes.cancel`, `disputes.mine`, `disputes.events`, `disputes.policy`, the stage
// enum). A part whose door is not built fails at once, naming its slice.
const J = 'J-p2p-08';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const AD = { price: '0.92', min: '10', max: '20', total: '300' };
const ORDER = '10';
/** The stack's svc-p2p sweep (tooling/scripts/local-stack-services/p2p.mjs): timed moves are applied every 30 s. */
const SWEEP_SECONDS = 30;
const UNBUILT = { timeout: 5_000 };
const REASON = 'seller did not release';

test.describe.configure({ mode: 'default' });

test.beforeAll(() => {
  tool('local-test-gates.mjs', 'p2p');
});

function journey() {
  const state = run.read();
  if (!state.offerId) throw new Error(`${J} #1 made no ad, so this step has nothing to act on`);
  return state;
}

const sellerClient = async (state) => p2p(await api(state.seller), await restorePasskey(state.sellerPasskey));

/** The buyer's client; keeps how far the passkey's counter went after each use, so the next is not read as a replay. */
async function buyerClient(state) {
  const passkey = await restorePasskey(state.buyerPasskey);
  const b = await readyTaker(await api(state.buyer), state.buyer, passkey);
  return {
    b,
    save: () => {
      state.buyerPasskey = passkey.saved();
      run.write({ buyerPasskey: state.buyerPasskey });
    },
  };
}

/** A new order on the seller's ad, taken by the buyer, and marked paid unless `paid` is false. */
async function order(state, { paid = true } = {}) {
  const { b, save } = await buyerClient(state);
  const trade = await b.mutate('trades.take', { offerId: state.offerId, tradeId: randomUUID(), amount: ORDER, method: METHOD });
  save();
  if (paid) await b.mutate('trades.markFiatSent', { tradeId: trade.id });
  return { b, tradeId: trade.id };
}

const free = async (who) => (await (await api(who)).balances()).USDT?.free ?? '0';

/** `who`'s inbox rows of `kind` for one order. */
async function notices(who, kind, tradeId) {
  const res = await (await api(who)).get(`/api/notify/trpc/notify.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
  expect(res.status).toBe(200);
  return res.body.result.data.items.filter((n) => n.kind === kind && n.params?.tradeId === tradeId);
}

/** The dispute section of the order page, as `who` sees it. */
async function disputePanel(page, who, tradeId) {
  await signIn(page, who);
  await page.goto(`/uc/order?tradeId=${tradeId}`);
  const panel = page
    .locator('section, div')
    .filter({ has: page.getByRole('heading', { name: 'Dispute and evidence' }) })
    .last();
  await expect(panel).toBeVisible();
  return panel;
}

/** Opens a dispute on `tradeId` in the app, as the buyer, with the reason typed in the dispute form. */
async function openInApp(page, state, tradeId, reason = REASON) {
  const panel = await disputePanel(page, state.buyer, tradeId);
  await panel.getByLabel('Describe the payment issue').fill(reason);
  await panel.getByRole('button', { name: 'Open dispute' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Open dispute' }).click();
  await expect(page.getByTestId('p2p-order-identity')).toContainText('In dispute');
}

test('J-p2p-08 #1 the buyer opens a dispute "seller did not release": disputed, escrow held, both told, once; a released order refuses and offers support; a cap refuses with its reset time', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const seller = await signUp(page, 'p2p08s');
  await verify(page, seller);
  expect(fund(seller.email, 'USDT', AD.total).tx).toBeTruthy();
  const first = p2p(await api(seller));
  await testInstrument(first, seller);
  const s = p2p(await api(seller), first.passkey());
  const offer = await s.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: AD.price,
    minAmount: AD.min,
    maxAmount: AD.max,
    totalAmount: AD.total,
    methods: [METHOD],
    terms: `TEST terms: ${J}`,
    idempotencyKey: `${J}:ad:${seller.handle}`,
  });
  const buyer = await signUp(page, 'p2p08b');
  await verify(page, buyer);
  const ready = await readyTaker(await api(buyer), buyer);
  run.reset({ seller, sellerPasskey: s.passkey().saved(), buyer, buyerPasskey: ready.passkey().saved(), offerId: offer.id });
  const state = run.read();

  const { b, tradeId } = await order(state);
  run.write({ disputedTradeId: tradeId });
  const held = (await b.query('trades.get', { tradeId })).escrowHeld;
  const sellerFree = await free(seller);
  const buyerFree = await free(buyer);

  // In the app, the buyer opens the dispute with the reason "seller did not release".
  await openInApp(page, state, tradeId);
  const disputed = await b.query('trades.get', { tradeId });
  expect(disputed).toMatchObject({ status: 'disputed', escrowHeld: held });
  const dispute = await b.query('disputes.get', { tradeId });
  expect(dispute).toMatchObject({ status: 'open', reason: REASON, openedBy: b.session.userId });
  // The escrow is still held: nothing reached the buyer and nothing went back to the seller.
  expect(await free(seller)).toBe(sellerFree);
  expect(await free(buyer)).toBe(buyerFree);
  // The seller sees it too, with the buyer's reason.
  const sellerPanel = await disputePanel(page, seller, tradeId);
  await expect(page.getByTestId('p2p-order-identity')).toContainText('In dispute');
  await expect(sellerPanel).toContainText(REASON);

  // Both are told: one inbox row each for this order.
  await expect.poll(async () => (await notices(buyer, 'p2p.trade.disputed', tradeId)).length, { timeout: 30_000 }).toBe(1);
  await expect
    .poll(async () => (await notices(seller, 'p2p.trade.disputed', tradeId)).length, {
      timeout: 30_000,
      message:
        'the seller is not told a dispute was opened on their order (p2pTradeDisputed notifies the opener only; P-disputes-security-01)',
    })
    .toBe(1);

  // Opening twice returns the same dispute, and moves nothing.
  const again = await b.raw.mutate('disputes.open', { tradeId, reason: REASON });
  expect(
    again.status,
    `a second open does not return the existing dispute (P-disputes-security-01): ${JSON.stringify(again.body).slice(0, 200)}`,
  ).toBe(200);
  expect(again.body.result.data.disputeId).toBe(dispute.id);
  expect((await b.query('trades.get', { tradeId })).escrowHeld).toBe(held);

  // A released order refuses `p2p.dispute_not_allowed`, and its page offers the support route.
  const done = await order(state);
  expect((await (await sellerClient(state)).mutate('trades.confirmReceived', { tradeId: done.tradeId })).status).toBe('released');
  run.write({ releasedTradeId: done.tradeId });
  const late = await b.raw.mutate('disputes.open', { tradeId: done.tradeId, reason: REASON });
  expect(refusalCode(late), 'a released order is not refused as p2p.dispute_not_allowed (P-disputes-security-01)').toBe(
    'p2p.dispute_not_allowed',
  );
  await signIn(page, state.buyer);
  await page.goto(`/uc/order?tradeId=${done.tradeId}`);
  const support = page.getByRole('link', { name: 'Report a problem with a finished order' });
  await expect(support, 'a finished order offers no support route (P-disputes-security-01)').toBeVisible(UNBUILT);
  await expect(support).toHaveAttribute('href', new RegExp(`/support.*${done.tradeId}`));

  // The caps in force are published; an open past a cap refuses, naming when the cap resets.
  const policy = await b.raw.query('disputes.policy');
  expect(policy.status, 'svc-p2p publishes no dispute policy read (disputes.policy, P-disputes-security-01)').toBe(200);
  const cap = policy.body.result.data.caps?.perDay;
  expect(cap, 'the stack sets no TEST per-day dispute cap, so a cap cannot be reached (P-disputes-security-01)').toEqual(
    expect.objectContaining({ limit: expect.any(Number) }),
  );
  expect(cap.limit, 'the TEST per-day dispute cap is too high to reach in one step').toBeLessThanOrEqual(5);
  let refused = null;
  for (let i = 0; i < cap.limit + 1 && !refused; i += 1) {
    const extra = await order(state);
    const res = await b.raw.mutate('disputes.open', { tradeId: extra.tradeId, reason: REASON });
    if (res.status !== 200) refused = res;
  }
  expect(refused, 'opening past the per-day dispute cap was never refused').not.toBeNull();
  expect(refusalCode(refused)).toBe('p2p.dispute_cap_reached');
  const resetAt = Date.parse(refused.body.error.data.cause?.resetAt ?? '');
  expect(resetAt, 'the cap refusal names no reset time').toBeGreaterThan(Date.now());
});

test('J-p2p-08 #2 the stage reads counterparty response with a deadline, then under review; an invalid jump refuses; "my disputes" lists both roles; no internal note shows', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const state = journey();
  if (!state.disputedTradeId) throw new Error(`${J} #1 opened no dispute, so this step has nothing to watch`);
  const tradeId = state.disputedTradeId;
  const { b } = await buyerClient(state);
  const s = await sellerClient(state);

  // The stage, beside the order's status: counterparty response, with its deadline.
  const dispute = await b.query('disputes.get', { tradeId });
  expect(dispute.stage, 'a dispute has no stage (P-disputes-security-02)').toBe('counterparty_response');
  expect(Date.parse(dispute.stageDeadlineAt ?? '')).toBeGreaterThan(Date.now());
  const panel = await disputePanel(page, state.buyer, tradeId);
  const progress = panel.getByTestId('dispute-progress');
  await expect(progress.locator('[aria-current="step"]')).toContainText('Counterparty response', UNBUILT);
  await expect(progress).toContainText('Respond by');

  // The seller answers on a second dispute, so this one keeps its stage for #3: the stage then reads under review, and
  // a jump back (a second response) is refused as an invalid stage move.
  const other = await order(state);
  await other.b.mutate('disputes.open', { tradeId: other.tradeId, reason: REASON });
  run.write({ stagedTradeId: other.tradeId });
  await s.mutate('disputes.respond', { tradeId: other.tradeId, agree: false, text: 'TEST I have not received the money' });
  expect((await b.query('disputes.get', { tradeId: other.tradeId })).stage).toBe('under_review');
  const again = await s.raw.mutate('disputes.respond', { tradeId: other.tradeId, agree: false, text: 'TEST twice' });
  expect(refusalCode(again)).toBe('p2p.invalid_stage');

  // "My disputes" lists both roles: the buyer's as buyer and the seller's as seller.
  const mine = await b.query('disputes.mine', {});
  expect(mine.disputes.find((d) => d.tradeId === tradeId)).toMatchObject({ role: 'buyer' });
  expect((await s.query('disputes.mine', {})).disputes.find((d) => d.tradeId === tradeId)).toMatchObject({ role: 'seller' });
  await signIn(page, state.seller);
  await page.goto('/p2p/disputes');
  const row = page.getByRole('row').filter({ hasText: tradeId.slice(0, 8) });
  await expect(row, 'there is no "my disputes" room (P-disputes-security-02)').toContainText('Seller', UNBUILT);

  // The history a party reads never carries a moderator's internal note.
  const events = await b.query('disputes.events', { tradeId });
  expect(events.events.length).toBeGreaterThan(0);
  expect(events.events.filter((e) => e.kind === 'internal_note' || e.internal === true)).toHaveLength(0);
});

test('J-p2p-08 #3 the seller responds: the response and the history show for both', async ({ page }) => {
  test.setTimeout(180_000);
  const state = journey();
  if (!state.disputedTradeId) throw new Error(`${J} #1 opened no dispute, so this step has nothing to answer`);
  const tradeId = state.disputedTradeId;
  const text = 'TEST I have not received the money in my bank yet';

  // In the app, the seller answers the buyer's dispute.
  const panel = await disputePanel(page, state.seller, tradeId);
  const respond = panel.getByTestId('dispute-respond');
  await expect(respond, 'the order page has no response box (P-disputes-security-03)').toBeVisible(UNBUILT);
  await respond.getByLabel('Your response').fill(text);
  await respond.getByRole('button', { name: 'Send response' }).click();
  await expect(panel.getByTestId('dispute-history')).toContainText(text);

  // Both read the same response and the same history: opened, then responded.
  for (const who of [state.buyer, state.seller]) {
    const view = await disputePanel(page, who, tradeId);
    const history = view.getByTestId('dispute-history');
    await expect(history).toContainText(REASON);
    await expect(history).toContainText(text);
    await expect(view.getByTestId('dispute-progress').locator('[aria-current="step"]')).toContainText('Under review');
  }
  const { b } = await buyerClient(state);
  const events = (await b.query('disputes.events', { tradeId })).events.map((e) => e.kind);
  expect(events).toEqual(expect.arrayContaining(['opened', 'responded']));
});

test('J-p2p-08 #4 evidence: an allowed file is scanned and shows; a disallowed type or a failed scan is refused and never shown to the other side; a duplicate folds; an invalid mark shows its reason', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const state = journey();
  if (!state.disputedTradeId) throw new Error(`${J} #1 opened no dispute, so this step has nothing to add evidence to`);
  const tradeId = state.disputedTradeId;
  // A one-pixel PNG, a file whose type is not allowed, and the EICAR anti-malware test file a scanner must refuse.
  const png = {
    name: 'TEST-bank-statement.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  };
  const exe = { name: 'TEST-proof.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ TEST not a real program') };
  const eicar = {
    name: 'TEST-scan-fail.png',
    mimeType: 'image/png',
    buffer: Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
  };

  const panel = await disputePanel(page, state.buyer, tradeId);
  const upload = panel.getByTestId('dispute-evidence-upload');
  await expect(upload, 'the order page has no evidence upload (P-disputes-security-04)').toBeVisible(UNBUILT);
  const items = panel.getByTestId('dispute-evidence-item');

  // An allowed type is scanned, then shows as accepted.
  await upload.getByLabel('Kind of evidence').selectOption({ label: 'Bank statement' });
  await upload.locator('input[type=file]').setInputFiles(png);
  await expect(items.filter({ hasText: png.name })).toContainText('Accepted', { timeout: 60_000 });
  // The same file again folds into the one item.
  await upload.locator('input[type=file]').setInputFiles(png);
  await expect(upload).toContainText('already attached');
  await expect(items.filter({ hasText: png.name })).toHaveCount(1);
  // A disallowed type is refused before it is stored.
  await upload.locator('input[type=file]').setInputFiles(exe);
  await expect(upload).toContainText('This type of file is not allowed');
  await expect(items.filter({ hasText: exe.name })).toHaveCount(0);
  // A file that fails the scan is rejected.
  await upload.locator('input[type=file]').setInputFiles(eicar);
  await expect(items.filter({ hasText: eicar.name })).toContainText('Rejected', { timeout: 60_000 });

  // The seller sees the accepted file, and never the refused or rejected ones.
  const theirs = (await disputePanel(page, state.seller, tradeId)).getByTestId('dispute-evidence-item');
  await expect(theirs.filter({ hasText: png.name })).toHaveCount(1);
  await expect(theirs.filter({ hasText: exe.name })).toHaveCount(0);
  await expect(theirs.filter({ hasText: eicar.name })).toHaveCount(0);

  // A reviewer marks the accepted file invalid with a reason, in the console; both parties see the mark and the reason.
  const { b } = await buyerClient(state);
  const dispute = await b.query('disputes.get', { tradeId });
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/p2p-ops/disputes/${dispute.id}`);
  const item = page.getByTestId('dispute-evidence-item').filter({ hasText: png.name });
  await expect(item, 'the console has no dispute page to mark evidence on (P-disputes-security-04)').toBeVisible(UNBUILT);
  await item.getByRole('button', { name: 'Mark invalid' }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('TEST the statement does not show the payer name');
  await page.getByRole('dialog').getByRole('button', { name: 'Mark invalid' }).click();
  for (const who of [state.buyer, state.seller]) {
    const mark = (await disputePanel(page, who, tradeId)).getByTestId('dispute-evidence-item').filter({ hasText: png.name });
    await expect(mark).toContainText('Invalid');
    await expect(mark).toContainText('TEST the statement does not show the payer name');
  }
});

test('J-p2p-08 #5 a proposed refund is accepted: one refund, one post when both accept at once; the filer cancelling instead resumes the order with a fresh deadline and no post', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const state = journey();
  const s = await sellerClient(state);

  // A dispute the buyer opens before paying (the payment details looked wrong), settled by a refund the seller proposes.
  const refund = await order(state, { paid: false });
  const before = await free(state.seller);
  await refund.b.mutate('disputes.open', { tradeId: refund.tradeId, reason: 'TEST payment details wrong' });
  const proposed = await s.raw.mutate('disputes.proposeSettlement', { tradeId: refund.tradeId, outcome: 'refund' });
  expect(
    proposed.status,
    `disputes.proposeSettlement is not built (P-disputes-security-03): ${JSON.stringify(proposed.body).slice(0, 200)}`,
  ).toBe(200);

  // Both parties accept at the same moment, and the buyer twice: one is the counterparty's acceptance, the rest refuse.
  const { b } = await buyerClient(state);
  const accepts = await Promise.all([
    b.raw.mutate('disputes.acceptSettlement', { tradeId: refund.tradeId }),
    b.raw.mutate('disputes.acceptSettlement', { tradeId: refund.tradeId }),
    s.raw.mutate('disputes.acceptSettlement', { tradeId: refund.tradeId }),
  ]);
  expect(refusalCode(accepts[2])).toBe('p2p.not_the_counterparty');
  expect(accepts.slice(0, 2).some((r) => r.status === 200)).toBe(true);
  // One refund: the seller's free balance is up by exactly the order, once, and stays there.
  await expect.poll(() => free(state.seller), { timeout: 30_000 }).toBe(fromUnits(toUnits(before) + toUnits(ORDER)));
  expect(await b.query('trades.get', { tradeId: refund.tradeId })).toMatchObject({ status: 'cancelled', resolution: 'refunded' });
  await new Promise((resolve) => setTimeout(resolve, SWEEP_SECONDS * 1000 + 5_000));
  expect(await free(state.seller)).toBe(fromUnits(toUnits(before) + toUnits(ORDER)));
  await signIn(page, state.buyer);
  await page.goto(`/uc/order?tradeId=${refund.tradeId}`);
  await expect(page.getByTestId('p2p-order-identity')).toContainText('Cancelled');

  // Instead of settling, the filer cancels the dispute: the order is back where it was, with a fresh deadline, and
  // nothing posts.
  const resumed = await order(state);
  const prior = await b.query('trades.get', { tradeId: resumed.tradeId });
  await resumed.b.mutate('disputes.open', { tradeId: resumed.tradeId, reason: REASON });
  const sellerFree = await free(state.seller);
  const panel = await disputePanel(page, state.buyer, resumed.tradeId);
  const cancel = panel.getByRole('button', { name: 'Cancel dispute' });
  await expect(cancel, 'the order page has no Cancel dispute (P-disputes-security-03)').toBeVisible(UNBUILT);
  await cancel.click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('The order goes back to');
  await confirm.getByRole('button', { name: 'Cancel dispute' }).click();
  await expect(page.getByTestId('p2p-order-identity')).not.toContainText('In dispute');
  const after = await b.query('trades.get', { tradeId: resumed.tradeId });
  expect(after).toMatchObject({ status: 'fiat_sent', escrowHeld: prior.escrowHeld, resolution: null });
  expect(Date.parse(after.deadlineAt)).toBeGreaterThan(Date.parse(prior.deadlineAt));
  expect(await free(state.seller)).toBe(sellerFree);
});

test('J-p2p-08 #6 the response window passes with no response: the stage moves to under review and the escrow is untouched', async () => {
  test.setTimeout(420_000);
  const state = journey();
  const { b, tradeId } = await order(state);
  await b.mutate('disputes.open', { tradeId, reason: REASON });
  const held = (await b.query('trades.get', { tradeId })).escrowHeld;
  const sellerFree = await free(state.seller);
  const dispute = await b.query('disputes.get', { tradeId });
  expect(dispute.stage, 'a dispute has no stage (P-disputes-security-02)').toBe('counterparty_response');
  const due = Date.parse(dispute.stageDeadlineAt ?? '');
  expect(due, 'the dispute names no response deadline (P-disputes-security-02)').toBeGreaterThan(Date.now());
  expect(due - Date.now(), "the stack's TEST response window is too long to wait for in one step").toBeLessThan(300_000);

  // Nobody answers; once the window and the next sweep have passed, the stage is under review.
  await expect
    .poll(async () => (await b.query('disputes.get', { tradeId })).stage, { timeout: due - Date.now() + (SWEEP_SECONDS + 15) * 1000 })
    .toBe('under_review');
  expect(await b.query('trades.get', { tradeId })).toMatchObject({ status: 'disputed', escrowHeld: held, resolution: null });
  expect(await free(state.seller)).toBe(sellerFree);
});

test('J-p2p-08 #7 told the outcome: the order shows the result, both get a notice, and a late complaint after release goes through support', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const state = journey();
  const s = await sellerClient(state);

  // A dispute settled by a release the seller proposes and the buyer accepts in the app.
  const { b, tradeId } = await order(state);
  await b.mutate('disputes.open', { tradeId, reason: REASON });
  const proposed = await s.raw.mutate('disputes.proposeSettlement', { tradeId, outcome: 'release' });
  expect(
    proposed.status,
    `disputes.proposeSettlement is not built (P-disputes-security-03): ${JSON.stringify(proposed.body).slice(0, 200)}`,
  ).toBe(200);
  const buyerFree = await free(state.buyer);
  const panel = await disputePanel(page, state.buyer, tradeId);
  const settlement = panel.getByTestId('dispute-settlement');
  await expect(settlement).toContainText('release');
  await settlement.getByRole('button', { name: 'Accept' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Accept' }).click();

  // The order shows the result for both.
  for (const who of [state.buyer, state.seller]) {
    await disputePanel(page, who, tradeId);
    await expect(page.getByTestId('p2p-order-identity')).toContainText('Completed');
    await expect(page.getByTestId('dispute-outcome')).toContainText('Released to the buyer');
  }
  expect(await b.query('trades.get', { tradeId })).toMatchObject({ status: 'released' });
  await expect.poll(() => free(state.buyer), { timeout: 30_000 }).not.toBe(buyerFree);

  // A notice reaches both parties.
  for (const who of [state.buyer, state.seller]) {
    await expect
      .poll(async () => (await notices(who, 'p2p.dispute.resolved', tradeId)).length, {
        timeout: 30_000,
        message: 'no dispute outcome notice reaches the parties (p2pDisputeResolved is not wired to notify; P-trade-orders-23)',
      })
      .toBe(1);
  }

  // After the release, a complaint goes through support: the order page opens a support case naming the order.
  await signIn(page, state.buyer);
  await page.goto(`/uc/order?tradeId=${tradeId}`);
  await expect(page.getByRole('button', { name: 'Open dispute' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Report a problem with a finished order' }).click();
  await expect(page).toHaveURL(/\/support/);
  await expect(page.getByLabel('Order')).toHaveValue(tradeId);
  await page.getByLabel('What happened?').fill('TEST the amount released was not what we agreed');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/case|ticket/i).first()).toBeVisible();
});
