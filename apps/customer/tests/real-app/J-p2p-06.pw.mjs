import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { api, fromUnits, fund, journeyState, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { CASH_METHOD, METHOD, cashInstrument, p2p, readyTaker, refusalCode, restorePasskey, testInstrument } from './p2p.mjs';

// J-p2p-06, in the running app (docs/roadmap/journeys.json): an order goes wrong. One test per step, titled
// "J-p2p-06 #<n>", run in order on one verified TEST seller and one buyer, on the shared TEST bank transfer and, for #5,
// the TEST cash-in-person method, whose own release window an order copies at take (`local-test-gates.mjs p2p`). The
// stack's TEST deadlines (tooling/scripts/local-stack-services/p2p.mjs): payment 180 s, release 1800 s, swept every 30 s; the TEST cancel limit is 3 within 24 hours and the reminder wait 5 s
// (tooling/profiles/test-owner-values/p2p.json). A step whose door is not built yet fails at once, naming its slice.
const J = 'J-p2p-06';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const AD = { price: '0.92', min: '10', max: '30', total: '200' };
const PAYMENT_SECONDS = 180;
const SWEEP_SECONDS = 30;
const UNBUILT = { timeout: 5_000 };

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

const free = async (who) => (await (await api(who)).balances()).USDT?.free ?? '0';

test('J-p2p-06 #1 the buyer cancels before paying, with a reason: one refund to the seller, and the cancel counts', async ({ page }) => {
  test.setTimeout(240_000);
  const seller = await signUp(page, 'p2p06s');
  await verify(page, seller);
  expect(fund(seller.email, 'USDT', '300').tx).toBeTruthy();
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
  const buyer = await signUp(page, 'p2p06b');
  await verify(page, buyer);
  const b = await readyTaker(await api(buyer), buyer);
  run.reset({ seller, sellerPasskey: s.passkey().saved(), buyer, buyerPasskey: b.passkey().saved(), offerId: offer.id });
  const state = run.read();

  // Orders the later steps need, taken before #2 pauses this buyer: one left unpaid to run out (#4, #8) and one the
  // buyer marks paid (#3, #6, #7).
  const expiring = await b.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: '10', method: METHOD });
  const paid = await b.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: '10', method: METHOD });
  await b.mutate('trades.markFiatSent', { tradeId: paid.id });
  run.write({ buyerPasskey: b.passkey().saved(), expiringTradeId: expiring.id, paidTradeId: paid.id });
  // And one paid in cash in person (#5), whose release window (the method's own) starts now and runs under #2 to #4.
  await cashInstrument(s);
  const cashOffer = await s.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: AD.price,
    minAmount: AD.min,
    maxAmount: AD.max,
    totalAmount: '30',
    methods: [CASH_METHOD],
    terms: `TEST terms: ${J} cash release window`,
    idempotencyKey: `${J}:cash-release:${seller.handle}`,
  });
  const cash = await b.mutate('trades.take', { offerId: cashOffer.id, tradeId: randomUUID(), amount: '10', method: CASH_METHOD });
  const cashPaidAt = Date.now();
  await b.mutate('trades.markFiatSent', { tradeId: cash.id });
  run.write({ sellerPasskey: s.passkey().saved(), buyerPasskey: b.passkey().saved(), cashTradeId: cash.id, cashPaidAt });

  const before = await free(seller);
  const trade = await b.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: '10', method: METHOD });
  run.write({ buyerPasskey: b.passkey().saved(), cancelTradeId: trade.id });
  expect(trade.status).toBe('escrowed');
  // Held in escrow: the seller's free balance is down by the order.
  expect(await free(seller)).toBe(fromUnits(toUnits(before) - toUnits('10')));

  // In the app, the buyer cancels with a reason.
  await signIn(page, state.buyer);
  await page.goto(`/uc/order?tradeId=${trade.id}`);
  await page.getByText('Other actions').click();
  const cancel = page.getByTestId('order-cancel');
  await expect(cancel, 'the order page has no cancel with a reason (P-trade-orders-19)').toBeVisible(UNBUILT);
  // The buyer is warned not to cancel an order they already paid, and cannot cancel without a reason.
  await expect(cancel).toContainText('Do not cancel an order you have already paid');
  await expect(cancel.getByRole('button', { name: 'Cancel order' })).toBeDisabled();
  await cancel.getByLabel('Why are you cancelling?').selectOption({ label: 'I changed my mind' });
  await cancel.getByRole('button', { name: 'Cancel order' }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('I changed my mind');
  await review.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByTestId('p2p-order-identity')).toContainText('Cancelled');
  await expect(page.getByTestId('order-refund')).toContainText('I changed my mind');

  const cancelled = await b.query('trades.get', { tradeId: trade.id });
  expect(cancelled).toMatchObject({ status: 'cancelled', resolution: 'refunded', cancelReason: { by: 'buyer', code: 'changed_mind' } });
  // One refund: the seller's free balance is back where it was, and a second cancel moves nothing.
  await expect.poll(() => free(seller), { timeout: 30_000 }).toBe(before);
  const again = await b.raw.mutate('trades.cancel', { tradeId: trade.id, reason: 'TEST again' });
  // A second cancel is refused as a move on an ended order; the reason first given stands and nothing more moved.
  expect(refusalCode(again)).toBe('p2p.trade_terminal');
  expect((await b.query('trades.get', { tradeId: trade.id })).cancelReason).toEqual({ by: 'buyer', code: 'changed_mind' });
  expect(await free(seller)).toBe(before);
  // The cancel counts toward the buyer's daily threshold: one of three used.
  const limits = await b.raw.query('access.limits');
  expect(limits.status, 'svc-p2p does not show the buyer how many cancels count (P-trade-orders-05)').toBe(200);
  expect(limits.body.result.data.cancels).toMatchObject({ used: 1, cap: 3 });
});

test('J-p2p-06 #2 too many cancels restrict buying with the end time, and the count starts again at the day boundary', async () => {
  test.setTimeout(240_000);
  const state = journey();
  const { b, save } = await buyerClient(state);
  // Cancel until buying pauses: three cancels within the TEST window, counting #1's if it went through.
  let refused = null;
  const cancelledIds = [];
  for (let i = 0; i < 4 && !refused; i++) {
    const res = await b.raw.mutate('trades.take', { offerId: state.offerId, tradeId: randomUUID(), amount: '10', method: METHOD });
    if (res.status !== 200) refused = res;
    else {
      await b.mutate('trades.cancel', { tradeId: res.body.result.data.id, reasonCode: 'changed_mind' });
      cancelledIds.push(res.body.result.data.id);
    }
  }
  save();
  run.write({ cancelledIds });
  expect(refused, 'three cancels did not pause buying').not.toBeNull();
  expect(refusalCode(refused)).toBe('p2p.buying_restricted');
  const pause = refused.body.error.data.p2pLimit;
  expect(pause.until).toEqual(expect.any(String));
  expect(Date.parse(pause.until)).toBeGreaterThan(Date.now());
  // The spec counts cancels per day: the count starts again at the next UTC midnight, which the refusal names.
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  expect(pause, 'cancels are counted over a rolling window, not per day (P-trade-orders-05)').toMatchObject({
    until: midnight.toISOString(),
  });
});

test('J-p2p-06 #3 after paying, neither side cancels; the seller’s cancellation request is visible and waits for the founders’ decision', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const state = journey();
  const s = await sellerClient(state);
  const { b } = await buyerClient(state);
  const tradeId = state.paidTradeId;
  expect(tradeId, '#3 needs the order the buyer marked paid in #1').toBeTruthy();
  // Paid: the buyer's cancel is refused (open a dispute instead), and so is the seller's straight cancel.
  expect(refusalCode(await b.raw.mutate('trades.cancel', { tradeId, reasonCode: 'changed_mind' }))).toBe('p2p.not_the_seller');
  expect(refusalCode(await s.raw.mutate('trades.cancel', { tradeId, reasonCode: 'buyer_unresponsive' }))).toBe('p2p.cancel_after_paid');
  const before = await s.query('trades.get', { tradeId });
  expect(before.status).toBe('fiat_sent');
  // How a paid order may be cancelled is the founders' decision (P-trade-orders-19): the seller's request refuses with
  // that reason (the buyer is not the one who asks), and writes nothing.
  const request = await s.raw.mutate('trades.requestCancel', { tradeId });
  expect(request.status, 'svc-p2p has no seller cancellation request (P-trade-orders-19)').not.toBe(404);
  expect(refusalCode(request)).toBe('p2p.owner_decision_pending');
  expect(refusalCode(await b.raw.mutate('trades.requestCancel', { tradeId }))).toBe('p2p.not_the_seller');
  const after = await s.query('trades.get', { tradeId });
  expect(after).toMatchObject({ status: 'fiat_sent', resolution: null, resolvedAt: null });
  expect(after.escrowHeld).toBe(before.escrowHeld);
  // In the app: the seller sees the request, with the reason it is off; the buyer has no cancel on a paid order.
  await signIn(page, state.seller);
  await page.goto(`/uc/order?tradeId=${tradeId}`);
  const parked = page.getByTestId('order-request-cancel');
  await expect(parked).toBeVisible();
  await expect(parked.getByRole('button', { name: 'Request cancellation' })).toBeDisabled();
  await expect(parked).toContainText('Cancelling after the buyer has paid needs a founder decision. It is switched off in this build.');
  await expect(page.getByTestId('order-cancel')).toHaveCount(0);
});

test('J-p2p-06 #4 the payment window passes in escrow: one refund to the seller, and the order reads cancelled by timeout', async ({
  page,
}) => {
  test.setTimeout((PAYMENT_SECONDS + 4 * SWEEP_SECONDS + 60) * 1_000);
  const state = journey();
  const s = await sellerClient(state);
  const tradeId = state.expiringTradeId;
  expect(tradeId, '#4 needs an order left unpaid, taken in #1').toBeTruthy();
  // The seller's free balance while the order still holds its 10 USDT; the refund adds exactly that back, once.
  const holding = (await s.query('trades.get', { tradeId })).status === 'escrowed';
  expect(holding, 'the order ran out before this step could watch it').toBe(true);
  // #1's order, if its cancel did not go through, runs out in the same sweeps and is refunded too.
  const alsoRunning = state.cancelTradeId && (await s.query('trades.get', { tradeId: state.cancelTradeId })).status === 'escrowed';
  const refunds = alsoRunning ? '20' : '10';
  // The refunds of the orders cancelled in #1 and #2 post on their own time: wait for each before reading the balance.
  const settled = [...(alsoRunning ? [] : [state.cancelTradeId]), ...(state.cancelledIds ?? [])].filter(Boolean);
  for (const id of settled) {
    await expect.poll(async () => (await s.query('trades.get', { tradeId: id })).settledAt, { timeout: 30_000 }).toBeTruthy();
  }
  const before = await free(state.seller);
  await expect
    .poll(async () => (await s.query('trades.get', { tradeId })).status, {
      timeout: (PAYMENT_SECONDS + 3 * SWEEP_SECONDS) * 1_000,
      intervals: [10_000],
    })
    .toBe('cancelled');
  const expired = await s.query('trades.get', { tradeId });
  expect(expired).toMatchObject({ resolution: 'refunded', displayStatus: 'cancelled_by_timeout' });
  await expect.poll(() => free(state.seller), { timeout: 30_000 }).toBe(fromUnits(toUnits(before) + toUnits(refunds)));
  await new Promise((resolve) => setTimeout(resolve, SWEEP_SECONDS * 1_000));
  expect(await free(state.seller)).toBe(fromUnits(toUnits(before) + toUnits(refunds)));
  await signIn(page, state.buyer);
  await page.goto('/uc/order');
  await expect(page.getByRole('row').filter({ hasText: tradeId.slice(0, 8) })).toContainText('Cancelled: payment time ran out');
});

test('J-p2p-06 #5 the release window passes after payment: a dispute opens once, and the escrow does not move', async () => {
  const state = journey();
  const s = await sellerClient(state);
  const tradeId = state.cashTradeId;
  expect(tradeId, '#5 needs the cash order marked paid in #1').toBeTruthy();
  // The method's own release window, from the catalogue (the transfer's is 1800 s, too long to wait out here).
  const method = (await s.query('methods.list', { limit: 200 })).find((m) => m.methodId === CASH_METHOD);
  const windowSeconds = method?.cashRules?.releaseWindowSeconds;
  expect(windowSeconds, 'the TEST cash method carries no release window').toEqual(expect.any(Number));
  const left = Math.max(0, state.cashPaidAt + windowSeconds * 1_000 - Date.now());
  test.setTimeout(left + (4 * SWEEP_SECONDS + 120) * 1_000);
  const paid = await s.query('trades.get', { tradeId });
  // The order copied the method's window when it was paid, not the 1800 s default.
  const deadline = Date.parse(paid.deadlineAt) - state.cashPaidAt;
  expect(deadline).toBeGreaterThanOrEqual(windowSeconds * 1_000 - 5_000);
  expect(deadline).toBeLessThanOrEqual(windowSeconds * 1_000 + 60_000);
  expect(paid.escrowHeld).toBe('10');
  const sellerFree = await free(state.seller);
  const buyerFree = await free(state.buyer);

  await expect
    .poll(async () => (await s.query('trades.get', { tradeId })).status, {
      timeout: left + 4 * SWEEP_SECONDS * 1_000,
      intervals: [15_000],
    })
    .toBe('disputed');
  const disputesOf = async () => (await s.query('disputes.mine', { limit: 200 })).disputes.filter((d) => d.tradeId === tradeId);
  expect(await disputesOf()).toHaveLength(1);
  // The escrow does not move: still held for the order, nothing released to the buyer or returned to the seller.
  const escrowStays = async () => {
    expect(await s.query('trades.get', { tradeId })).toMatchObject({ status: 'disputed', resolution: null, escrowHeld: '10' });
    expect(await free(state.seller)).toBe(sellerFree);
    expect(await free(state.buyer)).toBe(buyerFree);
  };
  await escrowStays();
  // Two more sweeps open no second dispute and still move nothing.
  await new Promise((resolve) => setTimeout(resolve, 2 * SWEEP_SECONDS * 1_000));
  expect(await disputesOf()).toHaveLength(1);
  await escrowStays();
});

test('J-p2p-06 #6 a reminder before the wait is refused with the time left; after it, the seller gets one notice', async ({ page }) => {
  const state = journey();
  const tradeId = state.paidTradeId;
  expect(tradeId, '#6 needs an order the buyer marked paid, taken in #1').toBeTruthy();
  const { b } = await buyerClient(state);
  // The order was paid in #1, so the wait has passed: the reminder goes. Pressing again at once is before the next wait,
  // and is refused with the time left; the seller has one reminder.
  const first = await b.raw.mutate('trades.remind', { tradeId });
  expect(first.status).toBe(200);
  const early = await b.raw.mutate('trades.remind', { tradeId });
  expect(refusalCode(early)).toBe('p2p.remind_too_early');
  expect(Date.parse(early.body.error.data.p2pLimit.until)).toBeGreaterThan(Date.now() - 1_000);
  await signIn(page, state.seller);
  await page.goto(`/uc/order?tradeId=${tradeId}`);
  await expect(page.getByTestId('order-reminder')).toContainText('The buyer reminded you to release');
});

test('J-p2p-06 #7 the seller reports an underpayment: the order stays paid, and a dispute is offered', async ({ page }) => {
  const state = journey();
  const tradeId = state.paidTradeId;
  expect(tradeId, '#7 needs an order the buyer marked paid, taken in #1').toBeTruthy();
  const s = await sellerClient(state);
  await signIn(page, state.seller);
  await page.goto(`/uc/order?tradeId=${tradeId}`);
  const report = page.getByTestId('order-mismatch');
  await report.getByText('The amount in my bank is different').click();
  await report.getByLabel('Less than the order').check();
  await report.getByLabel('Amount received (EUR)').fill('4');
  await report.getByRole('button', { name: 'Report the amount' }).click();
  await expect(page.getByTestId('order-mismatch-result')).toContainText('You do not have to release.');
  expect((await s.query('trades.get', { tradeId })).status).toBe('fiat_sent');
  await expect(page.getByRole('button', { name: 'Open dispute' })).toBeVisible();
});

test('J-p2p-06 #8 after an expired order, the order shows its end and the refund that matches it', async ({ page }) => {
  const state = journey();
  const tradeId = state.expiringTradeId;
  expect(tradeId, '#8 needs the order that ran out in #4').toBeTruthy();
  await signIn(page, state.seller);
  await page.goto(`/uc/order?tradeId=${tradeId}`);
  await expect(page.getByTestId('p2p-order-identity')).toContainText('Cancelled');
  const refund = page.getByTestId('order-refund');
  await expect(refund, 'the order shows no refund proof (P-trade-orders-19)').toBeVisible(UNBUILT);
  await expect(refund).toContainText('Returned to the seller');
  await expect(refund).toContainText('10 USDT');
});
