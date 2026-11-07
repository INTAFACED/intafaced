// World: freeze, gates
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, fund, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { METHOD, operatorP2p, p2p, readyTaker, refusalCode, restorePasskey, testInstrument, testPasskey } from './p2p.mjs';

// J-p2p-12, in the running app (docs/roadmap/journeys.json): I check a trader, follow them, rate a trade, and block
// someone. One test per step, titled "J-p2p-12 #<n>", run in order on one verified TEST person. The journey starts
// "signed in, a completed trade with a counterparty": #1 makes it through svc-p2p's own doors. The counterparty is a
// verified TEST seller with a TEST USDT sell ad paid by the stack's TEST bank transfer (`local-test-gates.mjs p2p`);
// a second TEST buyer gives the seller a record that is not all one outcome (one order completed, one cancelled after
// escrow), so the page's figures can be checked against a recomputation from the trades themselves. Fiat never moves;
// the coins move through the ledger's escrow. Money: none moves in this journey beyond the escrow of those orders.
const J = 'J-p2p-12';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const AD = { price: '0.92', min: '10', max: '50', total: '200' };

test.describe.configure({ mode: 'default' });

test.beforeAll(() => {
  tool('local-test-gates.mjs', 'p2p');
});

function journey() {
  const state = run.read();
  if (!state.person) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return state;
}

/** The seller's svc-p2p client, confirming releases with the account's TEST passkey. */
const sellerClient = async (state) => p2p(await api(state.trader), await restorePasskey(state.traderPasskey));

/**
 * The trader's record recomputed from the trades themselves, as svc-p2p's counters define it: an order counts once it
 * reached escrow; completed is released; cancelled is cancelled after escrow; the rate is completed over counted
 * (four places); the release time is escrow to release, averaged over completed orders, in whole seconds.
 */
function recompute(trades) {
  const counted = trades.filter((t) => t.escrowedAt !== null);
  const completed = counted.filter((t) => t.status === 'released');
  const cancelled = counted.filter((t) => t.status === 'cancelled');
  const disputed = counted.filter((t) => t.status === 'disputed');
  const secs = completed.map((t) => Math.max(0, Math.round((Date.parse(t.resolvedAt) - Date.parse(t.escrowedAt)) / 1000)));
  const outcome = completed.length + cancelled.length + disputed.length;
  const pct = (part, whole) => (whole === 0 ? null : (Math.floor((part * 10_000 * 2 + whole) / (whole * 2)) / 100).toFixed(2));
  return {
    tradesTotal: counted.length,
    completed: completed.length,
    cancelled: cancelled.length,
    disputed: disputed.length,
    disputesLost: 0,
    completionRate: counted.length === 0 ? 0 : Math.round((completed.length / counted.length) * 10_000) / 10_000,
    avgReleaseSecs: secs.length === 0 ? 0 : Math.round(secs.reduce((a, b) => a + b, 0) / secs.length),
    // Every order here is from today, so the 30-day window and all time count the same orders.
    completionRate30d: pct(completed.length, outcome),
    completionRateTotal: pct(completed.length, outcome),
  };
}

/** Every one of the trader's orders, read by a party to it (the person or the other buyer). */
async function traderTrades(state) {
  const person = p2p(await api(state.person));
  const other = p2p(await api(state.other));
  const rows = [];
  for (const id of state.personTrades) rows.push(await person.query('trades.get', { tradeId: id }));
  for (const id of state.otherTrades) rows.push(await other.query('trades.get', { tradeId: id }));
  return rows;
}

const record = (page) => page.getByTestId('counterparty-page');
const metric = (page, name) => page.locator(`[data-counterparty-metric="${name}"]`);

test('J-p2p-12 #1 a counterparty page shows every metric as recomputed from trades, the handle, and honest zeros for no history', async ({
  page,
}) => {
  test.setTimeout(300_000);
  // The counterparty: verified, TEST USDT, a TEST bank account and a sell ad.
  const trader = await signUp(page, 'p2p12t');
  await verify(page, trader);
  expect(fund(trader.email, 'USDT', '500').tx).toBeTruthy();
  const traderSession = await api(trader);
  const traderPasskey = await testPasskey(traderSession);
  const t = p2p(traderSession, traderPasskey);
  await testInstrument(t, trader);
  const offer = await t.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: AD.price,
    minAmount: AD.min,
    maxAmount: AD.max,
    totalAmount: AD.total,
    methods: [METHOD],
    terms: 'TEST terms: pay from an account in your own name.',
    idempotencyKey: `${J}:offer:${trader.handle}`,
  });
  // Another buyer: one order completed, one cancelled after escrow.
  const other = await signUp(page, 'p2p12o');
  await verify(page, other);
  const otherPasskey = await testPasskey(await api(other));
  const o = await readyTaker(await api(other), other, otherPasskey);
  const done = await o.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: AD.min, method: METHOD });
  await o.mutate('trades.markFiatSent', { tradeId: done.id });
  expect((await t.mutate('trades.confirmReceived', { tradeId: done.id })).status).toBe('released');
  const dropped = await o.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: AD.min, method: METHOD });
  expect(dropped.status).toBe('escrowed');
  await o.mutate('trades.cancel', { tradeId: dropped.id, reason: 'TEST changed my mind' });

  // The person: verified, confirmed, and a completed trade with the trader.
  const person = await signUp(page, 'p2p12p');
  await verify(page, person);
  const personSession = await api(person);
  const personPasskey = await testPasskey(personSession);
  const b = await readyTaker(personSession, person, personPasskey);
  const trade = await b.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: AD.min, method: METHOD });
  await b.mutate('trades.markFiatSent', { tradeId: trade.id });
  expect((await t.mutate('trades.confirmReceived', { tradeId: trade.id })).status).toBe('released');

  // A trader with no history at all: verified, signed up, never traded.
  const fresh = await signUp(page, 'p2p12z');
  await verify(page, fresh);
  const freshId = (await api(fresh)).userId;

  const state = run.reset({
    trader,
    other,
    person,
    fresh,
    traderId: traderSession.userId,
    personId: personSession.userId,
    freshId,
    offerId: offer.id,
    tradeId: trade.id,
    personTrades: [trade.id],
    otherTrades: [done.id, dropped.id],
    traderPasskey: traderPasskey.saved(),
    personPasskey: personPasskey.saved(),
    otherPasskey: otherPasskey.saved(),
  });

  // What svc-p2p answers equals a recomputation from the trades.
  const expected = recompute(await traderTrades(state));
  expect(expected).toMatchObject({ tradesTotal: 3, completed: 2, cancelled: 1, disputed: 0 });
  const answered = await b.query('reputation.get', { userId: state.traderId });
  for (const key of ['tradesTotal', 'completed', 'cancelled', 'disputed', 'disputesLost', 'completionRate', 'avgReleaseSecs'])
    expect(answered[key], key).toBe(expected[key]);
  // The profile reader is wired on the stack: the handle is identity's.
  expect(answered.profile.status).toBe('found');
  expect(answered.handle).toBe(trader.handle);

  // The page shows the same figures, under the trader's handle.
  await signIn(page, person);
  await page.goto(`/checkuser?userId=${state.traderId}`);
  await expect(page.getByTestId('counterparty-name')).toHaveText(`@${trader.handle}`);
  await expect(metric(page, 'completion')).toHaveText('66.67%');
  await expect(record(page)).toContainText(`${expected.completed} of ${expected.tradesTotal} escrowed trades completed`);
  await expect(metric(page, 'average')).toHaveText(`${expected.avgReleaseSecs.toLocaleString('en-US')}s`);
  await expect(metric(page, 'cancelled')).toHaveText(String(expected.cancelled));
  await expect(metric(page, 'disputed')).toHaveText(String(expected.disputed));
  await expect(metric(page, 'lost')).toHaveText(String(expected.disputesLost));

  // No history: zeros as zeros, a dash where there is no rate, and the person's handle, never "Member".
  const none = await b.query('reputation.get', { userId: freshId });
  expect(none).toMatchObject({
    tradesTotal: 0,
    completed: 0,
    cancelled: 0,
    disputed: 0,
    disputesLost: 0,
    completionRate30d: null,
    completionRateTotal: null,
    handle: fresh.handle,
  });
  await page.goto(`/checkuser?userId=${freshId}`);
  await expect(page.getByTestId('counterparty-name')).toHaveText(`@${fresh.handle}`);
  await expect(page.getByTestId('counterparty-name')).not.toContainText('Member');
  await expect(metric(page, 'completion')).toHaveText('—');
  await expect(record(page)).toContainText('No trades yet');
  await expect(metric(page, 'cancelled')).toHaveText('0');
  await expect(metric(page, 'disputed')).toHaveText('0');
  await expect(metric(page, 'lost')).toHaveText('0');
});

test('J-p2p-12 #2 the completion rate shows 30 days and all time with its definition; one appeal is accepted once, a second refused p2p.appeal_used', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const state = journey();
  const b = p2p(await api(state.person), await restorePasskey(state.personPasskey));
  const expected = recompute(await traderTrades(state));
  const answered = await b.query('reputation.get', { userId: state.traderId });
  expect(answered.completionRate30d).toBe(expected.completionRate30d);
  expect(answered.completionRateTotal).toBe(expected.completionRateTotal);
  const definition = answered.completionDefinition;

  // On the trader's page: both rates, each with what it counts.
  await signIn(page, state.person);
  await page.goto(`/checkuser?userId=${state.traderId}`);
  const rates = page.getByRole('region', { name: 'Completion rate by period' });
  await expect(rates.locator('[data-counterparty-metric="completion-30d"]')).toHaveText(`${expected.completionRate30d}%`);
  await expect(rates.locator('[data-counterparty-metric="completion-total"]')).toHaveText(`${expected.completionRateTotal}%`);
  await expect(rates).toContainText('Last 30 days');
  await expect(rates).toContainText('All time');
  await rates.getByText('How the rate is counted').click();
  for (const line of [definition.numerator, definition.denominator, definition.window30d]) await expect(rates).toContainText(line);

  // The person's own record: one order completed with the trader, then one cancelled after escrow, so 50%.
  const cancelled = await b.mutate('trades.take', { offerId: state.offerId, tradeId: randomUUID(), amount: AD.min, method: METHOD });
  expect(cancelled.status).toBe('escrowed');
  await b.mutate('trades.cancel', { tradeId: cancelled.id, reason: 'TEST the seller asked me to cancel' });
  state.personTrades.push(cancelled.id);
  state.personPasskey = b.passkey().saved();
  run.write({ personTrades: state.personTrades, cancelledId: cancelled.id, personPasskey: state.personPasskey });
  const own = await b.query('reputation.get', { userId: state.personId });
  expect(own.completionRateTotal).toBe('50.00');

  // The appeal, from the person's own trading page: one order, a reason, sent.
  await page.goto('/p2p/access');
  const mine = page.getByRole('region', { name: 'Your completion rate' });
  await expect(mine.locator('[data-counterparty-metric="completion-total"]')).toHaveText('50.00%');
  const form = mine.getByRole('form', { name: 'Appeal one order' });
  await expect(form).toContainText('You can appeal one order, once.');
  await form.getByLabel('Order', { exact: true }).selectOption(cancelled.id);
  await form.getByLabel('Why this order should not count').fill('TEST the seller asked me to cancel');
  await form.getByRole('button', { name: 'Send appeal' }).click();
  await expect(mine.getByTestId('appeal-status')).toContainText('Your appeal is with support');
  await expect(mine.getByRole('form', { name: 'Appeal one order' })).toHaveCount(0);
  const appeal = await b.query('reputation.myAppeal');
  expect(appeal).toMatchObject({ tradeId: cancelled.id, status: 'submitted' });
  // The same appeal sent again is the same appeal, not a second one.
  expect((await b.mutate('reputation.appeal', { tradeId: cancelled.id, reason: 'TEST the seller asked me to cancel' })).id).toBe(appeal.id);

  // Support accepts it, once: the rate changes once, and a second decision changes nothing.
  const accepted = await operatorP2p('reputation.decideAppeal', {
    appealId: appeal.id,
    decision: 'accepted',
    reason: 'LOCAL TEST the cancel was the seller’s request',
  });
  expect(accepted).toMatchObject({ id: appeal.id, status: 'accepted' });
  expect(accepted.decidedBy).toBeTruthy();
  const again = await operatorP2p(
    'reputation.decideAppeal',
    { appealId: appeal.id, decision: 'rejected', reason: 'LOCAL TEST a second decision' },
    { raw: true },
  );
  expect(again.code).toBe('p2p.appeal_decided');
  expect((await b.query('reputation.get', { userId: state.personId })).completionRateTotal).toBe('100.00');
  expect((await b.query('reputation.myAppeal')).status).toBe('accepted');

  // A second appeal is refused p2p.appeal_used, and the page offers none.
  const second = await b.raw.mutate('reputation.appeal', { tradeId: state.tradeId, reason: 'TEST another one' });
  expect(refusalCode(second)).toBe('p2p.appeal_used');
  await page.reload();
  await expect(mine.getByTestId('appeal-status')).toContainText('Your appeal was accepted');
  await expect(mine.getByTestId('appeal-status')).toContainText('You have used your one appeal.');
  await expect(mine.locator('[data-counterparty-metric="completion-total"]')).toHaveText('100.00%');
  await expect(mine.getByRole('form', { name: 'Appeal one order' })).toHaveCount(0);
});

test('J-p2p-12 #3 a released trade is rated once by each side; a second returns the first; a bad rating needs an explanation; a cancelled trade is not eligible', async ({
  page,
}) => {
  const state = journey();
  if (!state.cancelledId) throw new Error(`${J} #2 left no cancelled order, so this step has none to check`);
  const b = p2p(await api(state.person));
  const t = p2p(await api(state.trader));
  await signIn(page, state.person);
  await page.goto(`/uc/order?tradeId=${state.tradeId}`);

  // A bad rating needs an explanation before it can be left.
  const panel = page.getByTestId('order-review');
  const form = panel.getByRole('form', { name: 'Leave a review' });
  await form.getByRole('button', { name: 'Bad' }).click();
  await expect(form.getByRole('button', { name: 'Leave review' })).toBeDisabled();
  expect(refusalCode(await b.raw.mutate('reviews.leave', { tradeId: state.tradeId, rating: 'bad' }))).toBe('p2p.explanation_required');
  expect(await b.query('reviews.forTrade', { tradeId: state.tradeId })).toMatchObject({ mine: null });

  // The person rates the trader good, once.
  await form.getByRole('button', { name: 'Good' }).click();
  await form.getByLabel('Comment (optional)').fill('TEST quick release');
  await form.getByRole('button', { name: 'Leave review' }).click();
  const mine = panel.getByRole('region', { name: 'Your review' });
  await expect(mine).toContainText('Good');
  await expect(mine).toContainText('TEST quick release');
  await expect(panel.getByRole('form', { name: 'Leave a review' })).toHaveCount(0);
  const first = (await b.query('reviews.forTrade', { tradeId: state.tradeId })).mine;
  expect(first).toMatchObject({ rating: 'good', subjectId: state.traderId });
  // A second rating returns the first, unchanged.
  const again = await b.mutate('reviews.leave', { tradeId: state.tradeId, rating: 'bad', explanation: 'TEST second try' });
  expect(again).toMatchObject({ id: first.id, rating: 'good', comment: 'TEST quick release' });

  // The trader rates the person once too: bad needs its explanation, then it stands.
  expect(refusalCode(await t.raw.mutate('reviews.leave', { tradeId: state.tradeId, rating: 'bad' }))).toBe('p2p.explanation_required');
  const theirs = await t.mutate('reviews.leave', { tradeId: state.tradeId, rating: 'bad', explanation: 'TEST paid late' });
  expect(theirs).toMatchObject({ rating: 'bad', subjectId: state.personId });
  expect((await t.mutate('reviews.leave', { tradeId: state.tradeId, rating: 'good' })).id).toBe(theirs.id);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Their review of you' })).toContainText('TEST paid late');
  // One each: the trader's record counts the person's one good rating.
  expect((await b.query('reputation.get', { userId: state.traderId })).rating).toMatchObject({ good: 1, bad: 0 });

  // A cancelled trade is not eligible.
  await page.goto(`/uc/order?tradeId=${state.cancelledId}`);
  await expect(page.getByText('Only a completed order can be reviewed.')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Leave a review' })).toHaveCount(0);
  expect(refusalCode(await b.raw.mutate('reviews.leave', { tradeId: state.cancelledId, rating: 'good' }))).toBe('p2p.review_not_eligible');
});

/** `who`'s inbox rows telling them the trader they follow posted the ad `offerId`. */
async function postedNotices(session, offerId) {
  const res = await session.get(`/api/notify/trpc/notify.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
  expect(res.status).toBe(200);
  return res.body.result.data.items.filter((n) => n.kind === 'p2p.trader.posted' && n.params?.offerId === offerId);
}

test('J-p2p-12 #4 following the trader gives one notification per follower when they post, not repeated on edits', async ({ page }) => {
  test.setTimeout(180_000);
  const state = journey();
  await signIn(page, state.person);
  await page.goto(`/checkuser?userId=${state.traderId}`);
  const contact = page.getByTestId('contact-actions');
  await contact.getByRole('button', { name: 'Follow' }).click();
  await expect(page.getByTestId('contact-status')).toContainText('You follow this member');
  const b = p2p(await api(state.person));
  expect((await b.query('contacts.list')).following).toContain(state.traderId);
  // A second follower, and the same follow sent twice, are still one follow each.
  const o = p2p(await api(state.other));
  await o.mutate('contacts.follow', { peerId: state.traderId, idempotencyKey: `${J}:follow:${state.other.handle}` });
  await o.mutate('contacts.follow', { peerId: state.traderId, idempotencyKey: `${J}:follow:${state.other.handle}` });

  // The trader posts a new ad, then edits it.
  const t = p2p(await api(state.trader));
  const posted = await t.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: '0.93',
    minAmount: AD.min,
    maxAmount: AD.max,
    totalAmount: '50',
    methods: [METHOD],
    terms: 'TEST terms: a new ad for followers.',
    idempotencyKey: `${J}:followed-ad:${state.trader.handle}`,
  });
  run.write({ followedOfferId: posted.id });
  const personSession = await api(state.person);
  const otherSession = await api(state.other);
  await expect.poll(async () => (await postedNotices(personSession, posted.id)).length, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await postedNotices(otherSession, posted.id)).length, { timeout: 30_000 }).toBe(1);
  const [notice] = await postedNotices(personSession, posted.id);
  expect(notice.params.traderId).toBe(state.traderId);
  await t.mutate('offers.update', { offerId: posted.id, idempotencyKey: `${J}:edit:${posted.id}`, price: '0.94' });
  await t.mutate('offers.update', { offerId: posted.id, idempotencyKey: `${J}:edit2:${posted.id}`, terms: 'TEST terms: edited.' });

  // The person sees it in their notifications.
  await page.goto('/notifications');
  await expect(page.getByText('A trader you follow posted an ad').first()).toBeVisible();
  // Still one each after the edits and the next svc-p2p sweep (every 30 s on the stack) had its chance to hand it again.
  await page.waitForTimeout(35_000);
  expect(await postedNotices(personSession, posted.id)).toHaveLength(1);
  expect(await postedNotices(otherSession, posted.id)).toHaveLength(1);
});

test('J-p2p-12 #5 blocking the trader, confirmed, hides their ads for both, stops take and chat, and unblocking brings the ads back', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const state = journey();
  const b = p2p(await api(state.person), await restorePasskey(state.personPasskey));
  const t = await sellerClient(state);
  // The person has an ad of their own, a buy ad the trader could sell into.
  const personAd = await b.mutate('offers.create', {
    side: 'buy',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: '0.91',
    minAmount: AD.min,
    maxAmount: AD.max,
    totalAmount: '50',
    methods: [METHOD],
    terms: 'TEST terms: I pay from an account in my own name.',
    idempotencyKey: `${J}:buy-ad:${state.person.handle}`,
  });
  const boardOf = async (client, makerId) =>
    (await client.query('offers.page', { makerId, limit: 50, sort: 'price_asc' })).offers.map((offer) => offer.id);
  expect(await boardOf(b, state.traderId)).toContain(state.offerId);
  expect(await boardOf(t, state.personId)).toContain(personAd.id);

  // Block, with a confirmation first.
  await signIn(page, state.person);
  await page.goto(`/checkuser?userId=${state.traderId}`);
  const contact = page.getByTestId('contact-actions');
  await contact.getByRole('button', { name: 'Block' }).click();
  const confirm = page.getByTestId('block-confirm');
  await expect(confirm).toBeVisible();
  expect((await b.query('contacts.list')).blocking).not.toContain(state.traderId);
  await confirm.getByRole('button', { name: 'Block' }).click();
  await expect(page.getByTestId('contact-status')).toContainText('You blocked this member');
  expect((await b.query('contacts.list')).blocking).toContain(state.traderId);

  // Their ads disappear for both: the trader's from the person's board, the person's from the trader's.
  expect(await boardOf(b, state.traderId)).toEqual([]);
  expect(await boardOf(t, state.personId)).toEqual([]);
  await page.goto(`/p2p?makerId=${state.traderId}`);
  await expect(page.locator('li[data-testid="p2p-offer-row"]')).toHaveCount(0);

  // A blocked pair cannot take, either way, or chat, either way.
  const take = await b.raw.mutate('trades.take', { offerId: state.offerId, tradeId: randomUUID(), amount: AD.min, method: METHOD });
  expect(refusalCode(take)).toBe('p2p.blocked');
  const sellInto = await t.raw.mutate('trades.take', { offerId: personAd.id, tradeId: randomUUID(), amount: AD.min, method: METHOD });
  expect(refusalCode(sellInto)).toBe('p2p.blocked');
  const say = (client, text) => client.raw.mutate('chat.messages.send', { tradeId: state.tradeId, text, clientId: randomUUID() });
  expect(refusalCode(await say(b, 'TEST hello'))).toBe('p2p.blocked');
  expect(refusalCode(await say(t, 'TEST hello'))).toBe('p2p.blocked');

  // Unblock from the same page: the ads come back for both.
  await page.goto(`/checkuser?userId=${state.traderId}`);
  await contact.getByRole('button', { name: 'Unblock' }).click();
  await expect(page.getByTestId('contact-saved')).toHaveText('You unblocked this member.');
  expect((await b.query('contacts.list')).blocking).not.toContain(state.traderId);
  expect(await boardOf(b, state.traderId)).toContain(state.offerId);
  expect(await boardOf(t, state.personId)).toContain(personAd.id);
  await page.goto(`/p2p?makerId=${state.traderId}`);
  await expect(page.locator(`li[data-testid="p2p-offer-row"][data-offer-id="${state.offerId}"]`)).toHaveCount(1);
  await b.mutate('offers.close', { offerId: personAd.id });
});
