import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { api, fromUnits, fund, journeyState, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN } from './identity-factors.mjs';
import { draftNotice, openNotices, publishNotice, publishedNotices } from './notices.mjs';
import { METHOD, browserHoldsPasskey, p2p, readyTaker, refusalCode, restorePasskey, testInstrument, testPasskey } from './p2p.mjs';

// J-p2p-02, in the running app (docs/roadmap/journeys.json): I sell crypto, confirm the money arrived outside, and
// release. One test per step part, titled "J-p2p-02 #<n>", run in order on one verified TEST seller with TEST 50 USDT,
// a saved TEST bank transfer and a sell ad paid by the stack's TEST bank transfer (`local-test-gates.mjs p2p`). The
// other side is a verified TEST buyer who takes the ad and marks it paid. Fiat never moves; the coins move through the
// ledger's escrow. The seller confirms a release with a TEST passkey, as the person does.
const J = 'J-p2p-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const AD = { price: '0.92', min: '10', max: '50', total: '50' };
// A part of a step whose door is not built yet refuses at once, so the run stays short.
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

test.beforeAll(() => {
  tool('local-test-gates.mjs', 'p2p');
});

function journey() {
  const state = run.read();
  if (!state.tradeId) throw new Error(`${J} #1 placed no order, so this step has nothing to act on`);
  return state;
}

/** The seller's svc-p2p client, confirming releases with the account's TEST passkey. */
const sellerClient = async (state) => p2p(await api(state.seller), await restorePasskey(state.sellerPasskey));

/** A new 10 USDT order on the seller's ad, taken and marked paid by the buyer. */
async function paidOrder(state) {
  const passkey = await restorePasskey(state.buyerPasskey);
  const b = await readyTaker(await api(state.buyer), state.buyer, passkey);
  const trade = await b.mutate('trades.take', { offerId: state.offerId, tradeId: randomUUID(), amount: AD.min, method: METHOD });
  // A passkey's counter only goes up: keep how far it went, so the next order's confirmation is not read as a replay.
  state.buyerPasskey = passkey.saved();
  run.write({ buyerPasskey: state.buyerPasskey });
  await b.mutate('trades.markFiatSent', { tradeId: trade.id });
  return trade.id;
}

test('J-p2p-02 #1 the buyer marks the order paid and the seller gets one inbox row for it, still one after the next sweep', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // The seller: verified, TEST 50 USDT, a TEST bank account, a sell ad, and a TEST passkey to confirm releases.
  const seller = await signUp(page, 'p2p02s');
  await verify(page, seller);
  expect(fund(seller.email, 'USDT', '50').tx).toBeTruthy();
  const sellerSession = await api(seller);
  const sellerPasskey = await testPasskey(sellerSession);
  const s = p2p(sellerSession, sellerPasskey);
  await testInstrument(s, seller);
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
    terms: 'TEST terms: pay from an account in your own name; no third-party payments.',
    idempotencyKey: `${J}:offer:${seller.handle}`,
  });
  // The buyer: verified, meets every take requirement, takes 10 USDT and marks it paid.
  const buyer = await signUp(page, 'p2p02b');
  await verify(page, buyer);
  const buyerSession = await api(buyer);
  const buyerPasskey = await testPasskey(buyerSession);
  const b = await readyTaker(buyerSession, buyer, buyerPasskey);
  const trade = await b.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: AD.min, method: METHOD });
  expect(trade).toMatchObject({ status: 'escrowed', amount: '10', fiatAmount: '9.2' });
  await b.mutate('trades.markFiatSent', { tradeId: trade.id });
  run.reset({
    seller,
    buyer,
    offerId: offer.id,
    tradeId: trade.id,
    sellerPasskey: sellerPasskey.saved(),
    buyerPasskey: buyerPasskey.saved(),
  });

  // The seller's inbox has exactly one "the buyer marked it paid" row for this order.
  const notices = async () => {
    const res = await sellerSession.get(`/api/notify/trpc/notify.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
    expect(res.status).toBe(200);
    return res.body.result.data.items.filter((n) => n.kind === 'p2p.trade.fiat_sent' && n.params?.tradeId === trade.id);
  };
  await expect.poll(async () => (await notices()).length, { timeout: 30_000 }).toBe(1);
  await signIn(page, seller);
  await page.goto('/notifications');
  await expect(page.getByText('The buyer marked the order paid').first()).toBeVisible();
  // Still one after the next svc-p2p sweep (every 30 s on the stack) has had its chance to hand it over again.
  await page.waitForTimeout(35_000);
  expect(await notices()).toHaveLength(1);
});

test('J-p2p-02 #1 a notice to P2P merchants reaches P2P merchants only', async () => {
  const state = journey();
  // The founders' notice desk names who a notice is for; "P2P merchants" is one audience, and this seller is not one.
  const s = await api(state.seller);
  const audiences = await s.get('/api/notify/trpc/notify.noticeAudiences');
  expect(audiences.status, 'notify has no notice audiences (P-trade-orders-23 merchant notices)').toBe(200);
  expect(audiences.body.result.data).toContainEqual({ id: 'p2p-merchants', available: true });
  // Two founders publish an announcement for P2P merchants, open for a few minutes.
  const key = `j-p2p-02-merchants-${state.tradeId}`;
  const title = `LOCAL TEST notice for P2P merchants ${state.tradeId.slice(0, 8)}`;
  const draft = await draftNotice({
    kind: 'announcement',
    title,
    body: 'LOCAL TEST for P2P merchants only.',
    minutes: 5,
    key,
    audience: 'p2p-merchants',
  });
  const published = await publishNotice(draft, key);
  expect(published).toMatchObject({ status: 'published', audience: 'p2p-merchants' });
  // Not on the public board, not as the current announcement, and not to a trader who is not a merchant.
  expect((await publishedNotices()).map((n) => n.id)).not.toContain(published.id);
  expect((await openNotices()).announcement?.id).not.toBe(published.id);
  const mine = await s.get(`/api/notify/trpc/notify.memberNotices?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(mine.status, 'notify has no signed-in read of member notices').toBe(200);
  expect(mine.body.result.data.map((n) => n.id)).not.toContain(published.id);
  // A merchant reading it signed in is proven in svc-notify's tests against svc-p2p's merchant answer; this stack has
  // no approved P2P merchant (10 earned trades and a two-founder decision), so the room's merchant view is the next slice.
});

test('J-p2p-02 #2 the seller opens the order: the buyer by handle, the exact quantity and amount, and the release deadline', async ({
  page,
}) => {
  const state = journey();
  await signIn(page, state.seller);
  await page.goto(`/uc/order?tradeId=${state.tradeId}`);
  const order = page.getByRole('main');
  await expect(order.getByTestId('p2p-order-identity')).toContainText('You are the seller');
  await expect(order.getByTestId('p2p-order-quantities')).toContainText('10');
  await expect(order.getByTestId('p2p-order-quantities')).toContainText('USDT');
  await expect(order.getByTestId('p2p-order-quantities')).toContainText('9.2');
  await expect(order.getByTestId('p2p-order-quantities')).toContainText('EUR');
  // The release clock: the buyer marked it paid, so the seller has until the deadline to release or dispute.
  const path = order.getByTestId('escrow-path');
  await expect(path).toContainText('Waiting for you to release');
  await expect(path).toContainText(/\d+ h \d+ min left/);
  // The buyer by their handle, never by account id, anywhere on the order.
  await order.getByText('Order details').click();
  await expect(order).toContainText(`@${state.buyer.handle}`, UNBUILT);
  const buyerId = (await p2p(await api(state.seller)).query('trades.get', { tradeId: state.tradeId })).buyerId;
  await expect(order).not.toContainText(buyerId);
});

test('J-p2p-02 #2 the buyer reminds the seller, and the reminder shows on the seller’s order', async ({ page }) => {
  const state = journey();
  const b = p2p(await api(state.buyer));
  const reminded = await b.raw.mutate('trades.remind', { tradeId: state.tradeId });
  expect(reminded.status, 'svc-p2p has no seller reminder yet (P-trade-orders-15)').toBe(200);
  await signIn(page, state.seller);
  await page.goto(`/uc/order?tradeId=${state.tradeId}`);
  await expect(page.getByTestId('order-reminder')).toContainText('The buyer reminded you to release', UNBUILT);
});

test('J-p2p-02 #2 selling into a buy ad from a balance that falls short refuses with the amount short, and nothing is held', async ({
  page,
}) => {
  const state = journey();
  // Another trader's buy ad for more than the seller has free.
  const other = await signUp(page, 'p2p02o');
  await verify(page, other);
  const o = p2p(await api(other));
  const ad = await o.raw.mutate('offers.create', {
    side: 'buy',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: AD.price,
    minAmount: '10',
    maxAmount: '500',
    totalAmount: '500',
    methods: [METHOD],
    idempotencyKey: `${J}:buy-ad:${other.handle}`,
  });
  expect(ad.status, 'a buy ad could not be posted').toBe(200);
  // The seller meets the take requirements as anyone taking an ad does: email confirmed, the risk notice accepted.
  const s = await readyTaker(await api(state.seller), state.seller, await restorePasskey(state.sellerPasskey));
  const free = (await (await api(state.seller)).balances()).USDT?.free ?? '0';
  const refused = await s.raw.mutate('trades.take', {
    offerId: ad.body.result.data.id,
    tradeId: randomUUID(),
    amount: '400',
    method: METHOD,
  });
  expect(refusalCode(refused)).toBe('p2p.insufficient_balance');
  expect(refused.body?.error?.data?.p2pLimit?.shortBy ?? null).toBe(fromUnits(toUnits('400') - toUnits(free)));
  const available = refused.body?.error?.data?.p2pLimit?.available;
  expect(available, 'the refusal names the seller’s free balance').toBeTruthy();
  expect(toUnits(available)).toBe(toUnits(free));
  expect((await (await api(state.seller)).balances()).USDT?.free ?? '0').toBe(free);
});

test('J-p2p-02 #3 a payment within tolerance lets the order go on; one outside it cannot be forced to release and offers a dispute', async ({
  page,
}) => {
  const state = journey();
  const s = await sellerClient(state);
  const tradeId = await paidOrder(state);
  // The seller's bank shows 9.19 EUR of the 9.2 agreed.
  const within = await s.raw.mutate('trades.reportMismatch', { tradeId, kind: 'under', amountReceived: '9.19' });
  expect(within.status, 'svc-p2p has no amount-mismatch report yet (P-trade-orders-20)').toBe(200);
  // 9.19 of 9.2 is 11 basis points short, inside the TEST tolerance of 50: the order goes on, and the page says so.
  expect(within.body.result.data).toMatchObject({ classification: 'within_tolerance', toleranceBps: 50 });
  expect((await s.query('trades.get', { tradeId })).status).toBe('fiat_sent');
  await signIn(page, state.seller);
  await page.goto(`/uc/order?tradeId=${tradeId}`);
  const inside = page.getByTestId('order-mismatch-result');
  await expect(inside).toContainText('You reported 9.19 EUR received of 9.2 EUR.');
  await expect(inside).toContainText('That is within this service’s tolerance, so the order goes on.');

  // Another order: only 5 EUR arrived. The seller says so on the order page.
  const other = await paidOrder(state);
  await page.goto(`/uc/order?tradeId=${other}`);
  const report = page.getByTestId('order-mismatch');
  await report.getByText('The amount in my bank is different').click();
  await report.getByLabel('Less than the order').check();
  await report.getByLabel('Amount received (EUR)').fill('5');
  await report.getByRole('button', { name: 'Report the amount' }).click();
  const result = page.getByTestId('order-mismatch-result');
  await expect(result).toContainText('You reported 5 EUR received of 9.2 EUR.');
  await expect(result).toContainText('You do not have to release.');
  const order = await s.query('trades.get', { tradeId: other });
  expect(order.mismatch?.classification).toBe('outside_tolerance');
  expect(order.status).toBe('fiat_sent');
  // No one can force the release: the buyer, confirmed with their own passkey, is refused as not the seller, and the
  // escrow stays held.
  const passkey = await restorePasskey(state.buyerPasskey);
  const buyer = p2p(await api(state.buyer), passkey);
  const forced = await buyer.raw.mutate('trades.confirmReceived', { tradeId: other });
  state.buyerPasskey = passkey.saved();
  run.write({ buyerPasskey: state.buyerPasskey });
  expect(refusalCode(forced)).toBe('p2p.not_the_seller');
  expect((await s.query('trades.get', { tradeId: other })).status).toBe('fiat_sent');
  // The way on is a dispute, on the same page.
  await expect(page.getByRole('button', { name: 'Open dispute' })).toBeVisible();
});

test('J-p2p-02 #4 with no payment validation rail the order says the bank rail is switched off, and nothing is released', async ({
  page,
}) => {
  const state = journey();
  const s = await sellerClient(state);
  const res = await s.raw.mutate('trades.validatePayment', { tradeId: state.tradeId });
  expect(refusalCode(res), 'svc-p2p has no payment validation door yet (P-trade-orders-11)').toBe('rail.bank');
  expect((await s.query('trades.get', { tradeId: state.tradeId })).status).toBe('fiat_sent');
  // The seller's order shows the check, switched off, with the blocker named.
  await signIn(page, state.seller);
  await page.goto(`/uc/order?tradeId=${state.tradeId}`);
  const check = page.getByTestId('order-validate');
  await expect(check.getByRole('button', { name: 'Check the payment with the bank' })).toBeDisabled();
  await expect(check).toContainText('Payment validation needs a bank rail. It is switched off in this build');
});

test('J-p2p-02 #5 the seller ticks the five checks, confirms with a passkey and releases once; a second press returns the same order', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const state = journey();
  // Passkeys belong to the stack's relying party, localhost: the seller uses the app there, and the browser's (virtual)
  // authenticator holds the passkey saved on the account in #1.
  const context = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  const page = await context.newPage();
  await browserHoldsPasskey(page, state.sellerPasskey);
  await signIn(page, state.seller);

  // A release with no confirmation is refused by name, and the escrow stays held.
  const s = p2p(await api(state.seller));
  const refused = await s.bare.mutate('trades.confirmReceived', { tradeId: state.tradeId });
  expect(refused.status).toBe(403);
  expect(refusalCode(refused)).toBe('auth.step_up_required');
  expect((await s.query('trades.get', { tradeId: state.tradeId })).status).toBe('fiat_sent');

  await page.goto(`/uc/order?tradeId=${state.tradeId}`);
  const order = page.getByRole('main');
  await order.getByRole('button', { name: 'Release to the buyer' }).click();
  const review = page.getByRole('dialog');
  // To whom, by handle; what leaves the escrow, what the buyer gets and the fee.
  const details = review.getByTestId('order-release-review');
  await expect(details).toContainText(`@${state.buyer.handle}`);
  const trade = await s.query('trades.get', { tradeId: state.tradeId });
  await expect(details).not.toContainText(trade.buyerId);
  await expect(details).toContainText('The buyer gets');
  await expect(details).toContainText(`${trade.releasePreview.netAmount} USDT`);
  await expect(details).toContainText('Service fee');
  // The release stays off until each line is ticked and the seller confirms it's them.
  const confirm = review.getByRole('button', { name: 'Release to the buyer' });
  const checklist = review.getByTestId('order-release-checklist');
  await expect(checklist).toContainText('I received 9.2 EUR, the exact amount of this order');
  const boxes = await checklist.getByRole('checkbox').all();
  expect(boxes).toHaveLength(5);
  await expect(confirm).toBeDisabled();
  await expect(review).toContainText('Tick each line to release.');
  for (const box of boxes) await box.check();
  await expect(confirm).toBeDisabled();
  await review.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(review.getByTestId('order-release-confirmed')).toContainText('You confirmed it’s you for this release.');
  await expect(confirm).toBeEnabled();
  // The buyer's free USDT before the release: the ledger, not the order record, proves one release.
  const buyerSession = await api(state.buyer);
  const buyerUsdt = async () => (await buyerSession.balances()).USDT?.free ?? '0';
  const before = await buyerUsdt();
  await confirm.dblclick();
  await expect(review).toHaveCount(0);
  await expect(order.getByTestId('p2p-order-identity')).toContainText('Completed');

  // One release on the ledger: a second press returns the same order, and nothing more moves.
  const released = await s.query('trades.get', { tradeId: state.tradeId });
  expect(released).toMatchObject({ status: 'released', resolution: 'released' });
  const again = await s.mutate('trades.confirmReceived', { tradeId: state.tradeId });
  expect(again).toMatchObject({ id: state.tradeId, status: 'released', resolution: 'released', resolvedAt: released.resolvedAt });
  // The double press and the repeat call credited the buyer exactly once: once the release has settled, their free
  // balance is up by the net amount, no more.
  await expect.poll(async () => (await s.query('trades.get', { tradeId: state.tradeId })).settledAt, { timeout: 30_000 }).not.toBeNull();
  expect(await buyerUsdt()).toBe(fromUnits(toUnits(before) + toUnits(released.netAmount)));
  await context.close();
});

test('J-p2p-02 #6 the completed order says Completed, its fee is the published rate, and nothing is left in escrow', async ({ page }) => {
  const state = journey();
  const s = await sellerClient(state);
  const trade = await s.query('trades.get', { tradeId: state.tradeId });
  expect(trade).toMatchObject({ status: 'released', displayStatus: 'completed' });
  await expect.poll(async () => (await s.query('trades.get', { tradeId: state.tradeId })).settledAt, { timeout: 30_000 }).not.toBeNull();
  // The fee is the published schedule's rate, taken off the released amount.
  const schedule = await s.query('fees.schedule');
  expect(trade.feeBps).toBe(schedule.feeBps);
  expect(fromUnits(toUnits(trade.netAmount) + toUnits(trade.fee))).toBe(fromUnits(toUnits(trade.amount)));

  await signIn(page, state.seller);
  await page.goto(`/uc/order?tradeId=${state.tradeId}`);
  const order = page.getByRole('main');
  await expect(order.getByTestId('p2p-order-identity')).toContainText('Completed');
  const result = order.getByTestId('order-result');
  await expect(result).toContainText(`${trade.fee} USDT (`);
  // Nothing of this order is held any more.
  await expect(order.getByTestId('order-escrow-held')).toContainText('0 USDT');
  expect((await s.query('trades.get', { tradeId: state.tradeId })).escrowHeld).toBe('0');
});
