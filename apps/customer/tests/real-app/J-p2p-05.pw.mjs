import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { api, fund, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { METHOD, p2p, readyTaker, refusalCode, testInstrument } from './p2p.mjs';

// J-p2p-05, in the running app (docs/roadmap/journeys.json): run my ads. One test per step part, titled
// "J-p2p-05 #<n>", run in order on one verified TEST seller with several ads in different states and orders on them.
// The shared TEST bank transfer (`local-test-gates.mjs p2p`) pays every ad. The TEST edit cap is 20 a day
// (tooling/profiles/test-owner-values/p2p.json); #1's cap part uses its own maker so #2's edits are not counted there.
const J = 'J-p2p-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const EDITS_PER_DAY = 20;

test.describe.configure({ mode: 'default' });

test.beforeAll(() => {
  tool('local-test-gates.mjs', 'p2p');
});

function journey() {
  const state = run.read();
  if (!state.seller) throw new Error(`${J} #1 made no seller, so this step has nothing to act on`);
  return state;
}

/** A TEST sell ad on the shared bank transfer. */
const sellAd = (s, who, name, { total = '60', min = '10', max = '30', price = '0.92' } = {}) =>
  s.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price,
    minAmount: min,
    maxAmount: max,
    totalAmount: total,
    methods: [METHOD],
    terms: `TEST terms: ${J} ${name}`,
    idempotencyKey: `${J}:${name}:${who.handle}`,
  });

/** The next UTC midnight, when the day's edit count starts again. */
function nextUtcMidnight() {
  const at = new Date();
  at.setUTCHours(24, 0, 0, 0);
  return at.toISOString();
}

/** A verified TEST seller with funds and a saved TEST bank account, and its svc-p2p client (it holds the TEST passkey). */
async function seller(page, prefix) {
  const who = await signUp(page, prefix);
  await verify(page, who);
  expect(fund(who.email, 'USDT', '300').tx).toBeTruthy();
  const session = await api(who);
  const first = p2p(session);
  await testInstrument(first, who);
  // A client that releases with the passkey the saved method asked for.
  return { who, s: p2p(session, first.passkey()) };
}

test('J-p2p-05 #1 My Ads lists listed, paused and closed ads, each with why and since when', async ({ page }) => {
  test.setTimeout(300_000);
  const { who, s } = await seller(page, 'p2p05s');
  const listed = await sellAd(s, who, 'listed');
  const paused = await sellAd(s, who, 'paused');
  const closed = await sellAd(s, who, 'closed');
  const soldOut = await sellAd(s, who, 'sold-out', { total: '30', min: '10', max: '25' });
  await s.mutate('offers.pause', { offerId: paused.id });
  await s.mutate('offers.close', { offerId: closed.id });
  // A buyer takes 25 of the sold-out ad's 30 and pays; the release leaves 5, under the 10 minimum, so it closes by itself.
  const buyer = await signUp(page, 'p2p05b');
  await verify(page, buyer);
  const b = await readyTaker(await api(buyer), buyer);
  const trade = await b.mutate('trades.take', { offerId: soldOut.id, tradeId: randomUUID(), amount: '25', method: METHOD });
  await b.mutate('trades.markFiatSent', { tradeId: trade.id });
  await s.mutate('trades.confirmReceived', { tradeId: trade.id });
  expect(await s.query('offers.get', { offerId: soldOut.id })).toMatchObject({ status: 'closed', closeReason: 'sold_out' });
  run.reset({ seller: who, sellerPasskey: s.passkey().saved(), buyer, listedId: listed.id, pausedId: paused.id, closedId: closed.id });

  await signIn(page, who);
  await page.goto('/uc/ad');
  // Listed: on the board part, with since when.
  const listedRow = page.locator(`[data-testid="p2p-offer-row"][data-offer-id="${listed.id}"]`);
  await expect(listedRow.getByTestId('state-since')).toContainText('Listed since');
  // Paused by the person, with the way back and since when.
  const pausedRow = page.getByTestId('paused-offers').locator(`[data-offer-id="${paused.id}"]`);
  await expect(pausedRow).toContainText('Paused by you.');
  await expect(pausedRow.getByTestId('state-since')).toContainText('Paused since');
  // Closed: one by the person, one sold out, each with why and since when.
  const closedList = page.getByTestId('closed-offers');
  const byYou = closedList.locator(`[data-offer-id="${closed.id}"]`);
  await expect(byYou).toHaveAttribute('data-close-reason', 'by_you');
  await expect(byYou.getByTestId('close-reason')).toHaveText('Closed by you.');
  await expect(byYou.getByTestId('state-since')).toContainText('Closed since');
  const sold = closedList.locator(`[data-offer-id="${soldOut.id}"]`);
  await expect(sold).toHaveAttribute('data-close-reason', 'sold_out');
  await expect(sold.getByTestId('close-reason')).toContainText('Sold out');
  // The day's edits so far, and when the count starts again.
  await expect(page.getByTestId('edit-quota')).toContainText(
    `You have made 0 of ${EDITS_PER_DAY} ad edits today. The count starts again at`,
  );
});

test('J-p2p-05 #1 the edit cap shows when editing opens again, and an edit past it is refused with that time', async ({ page }) => {
  test.setTimeout(240_000);
  journey();
  const { who, s } = await seller(page, 'p2p05c');
  const ad = await sellAd(s, who, 'capped');
  for (let n = 1; n <= EDITS_PER_DAY; n++) {
    await s.mutate('offers.update', { offerId: ad.id, idempotencyKey: `${J}:cap:${ad.id}:${n}`, price: `0.${900 + n}` });
  }
  const quota = await s.query('offers.editQuota');
  expect(quota).toEqual({ limit: EDITS_PER_DAY, used: EDITS_PER_DAY, remaining: 0, resetsAt: nextUtcMidnight() });
  const past = await s.raw.mutate('offers.update', { offerId: ad.id, idempotencyKey: `${J}:cap:${ad.id}:over`, price: '0.99' });
  expect(past.status).toBe(429);
  expect(refusalCode(past)).toBe('p2p.edit_quota_reached');
  expect(past.body.error.data.p2pLimit).toEqual({ until: nextUtcMidnight(), cap: String(EDITS_PER_DAY), remaining: '0' });
  expect((await s.query('offers.get', { offerId: ad.id })).price).toBe(`0.${900 + EDITS_PER_DAY}`);

  await signIn(page, who);
  await page.goto('/uc/ad');
  await expect(page.getByTestId('edit-quota')).toContainText(
    `You have made all ${EDITS_PER_DAY} ad edits for today. Editing opens again at`,
  );
  // The edit form says the same when the person tries anyway.
  await page.goto(`/uc/ad/update?offerId=${ad.id}`);
  const form = page.getByTestId('offer-form');
  await form.getByLabel('Price per unit').fill('0.98');
  await form.getByTestId('offer-submit').click();
  await expect(page.getByTestId('offer-edit-spent')).toContainText(
    `You have made all ${EDITS_PER_DAY} ad edits for today. Editing opens again at`,
  );
});

test('J-p2p-05 #1 a pending ad shows that it waits for review', async () => {
  // P-ads-merchant-06 part 2: drafts and ads waiting for review (offers.saveDraft, offers.submitForListing).
  const state = journey();
  const s = p2p(await api(state.seller));
  const res = await s.raw.mutate('offers.saveDraft', { side: 'sell', asset: 'USDT', fiatCurrency: 'EUR' });
  expect(res.status, 'offers.saveDraft (P-ads-merchant-06 part 2) is not built').toBe(200);
});

test('J-p2p-05 #2 the person edits price and limits, pauses an ad and relists a closed one; closing with an open order refuses with the number', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const state = journey();
  const s = p2p(await api(state.seller));
  await signIn(page, state.seller);

  // Edit price and limits in the form; the board shows the new figures.
  await page.goto(`/uc/ad/update?offerId=${state.listedId}`);
  const form = page.getByTestId('offer-form');
  await form.getByLabel('Price per unit').fill('0.95');
  await form.getByLabel('Minimum per order').fill('12');
  await form.getByLabel('Maximum per order').fill('28');
  await form.getByTestId('offer-submit').click();
  await expect(page.getByTestId('offer-edit-saved')).toContainText('Saved.');
  expect(await s.query('offers.get', { offerId: state.listedId })).toMatchObject({ price: '0.95', minAmount: '12', maxAmount: '28' });
  expect((await s.query('offers.editQuota')).used).toBe(1);

  // Pause it from My Ads: it moves under paused.
  await page.goto('/uc/ad');
  await page
    .locator(`[data-testid="p2p-offer-row"][data-offer-id="${state.listedId}"]`)
    .getByRole('button', { name: 'Inspect current offer' })
    .click();
  await page.getByRole('button', { name: 'Pause offer' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Pause offer' }).click();
  await expect.poll(async () => (await s.query('offers.get', { offerId: state.listedId })).status).toBe('paused');
  await page.goto('/uc/ad');
  await expect(page.getByTestId('paused-offers').locator(`[data-offer-id="${state.listedId}"]`)).toBeVisible();

  // Relist the closed one: a new active ad from it, with a fresh create time, on the board; the closed one stays closed.
  const before = await s.query('offers.get', { offerId: state.closedId });
  const closedRow = page.getByTestId('closed-offers').locator(`[data-offer-id="${state.closedId}"]`);
  await closedRow.getByRole('button', { name: 'Relist' }).click();
  const relisted = closedRow.getByTestId('relisted');
  await expect(relisted).toContainText('Relisted as a new ad.');
  const newId = await relisted.getAttribute('data-new-offer-id');
  const fresh = await s.query('offers.get', { offerId: newId });
  expect(fresh).toMatchObject({ status: 'active', relistedFrom: state.closedId, price: before.price, minAmount: before.minAmount });
  expect(Date.parse(fresh.createdAt)).toBeGreaterThan(Date.parse(before.createdAt));
  expect((await s.query('offers.get', { offerId: state.closedId })).status).toBe('closed');
  await page.goto('/uc/ad');
  await expect(page.locator(`[data-testid="p2p-offer-row"][data-offer-id="${newId}"]`)).toBeVisible();

  // An order on the relisted ad; closing it refuses with the number, in plain words, and the order is untouched.
  const b = await readyTaker(await api(state.buyer), state.buyer);
  const trade = await b.mutate('trades.take', { offerId: newId, tradeId: randomUUID(), amount: '15', method: METHOD });
  const refused = await s.raw.mutate('offers.close', { offerId: newId });
  expect(refusalCode(refused)).toBe('p2p.offer_has_open_trades');
  expect(refused.body.error.data.p2pLimit).toMatchObject({ openTrades: '1', openTradeIds: [trade.id] });
  await page.goto('/uc/ad');
  await page
    .locator(`[data-testid="p2p-offer-row"][data-offer-id="${newId}"]`)
    .getByRole('button', { name: 'Inspect current offer' })
    .click();
  await page.getByRole('button', { name: 'Close offer' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close offer' }).click();
  await expect(page.getByText('This ad has 1 open order. It can close once it finishes; closing never cancels an order.')).toBeVisible();
  expect((await s.query('offers.get', { offerId: newId })).status).toBe('active');
  expect((await b.query('trades.get', { tradeId: trade.id })).status).toBe('escrowed');
});

test('J-p2p-05 #3 a private ad is off the board and reachable by its link until the link expires or is revoked', async () => {
  // P-ads-merchant-07: offers.setVisibility, offers.shareLink.create / revoke, offers.getByShareToken.
  const state = journey();
  const s = p2p(await api(state.seller));
  const res = await s.raw.mutate('offers.setVisibility', { offerId: state.pausedId, visibility: 'private' });
  expect(res.status, 'offers.setVisibility (P-ads-merchant-07) is not built').toBe(200);
});

test('J-p2p-05 #4 operating hours hide ads off hours, and the console to-do list orders trades by deadline', async () => {
  // P-ads-merchant-08: operating hours and the merchant console to-do list.
  const state = journey();
  const s = p2p(await api(state.seller));
  const res = await s.raw.query('merchants.todo');
  expect(res.status, 'merchants.todo (P-ads-merchant-08) is not built').toBe(200);
});

test('J-p2p-05 #5 an ad that hides itself says why, and comes back once the cause is fixed', async () => {
  // P-ads-merchant-09 (with -03's price guard): automatic hiding for unprocessed orders, disputes and balance.
  const state = journey();
  const s = p2p(await api(state.seller));
  const offer = await s.query('offers.get', { offerId: state.pausedId });
  expect(offer.hideReason, 'an automatic hide reason on the ad (P-ads-merchant-09) is not built').toBeDefined();
});

test('J-p2p-05 #6 the board says why an ad sits where it does', async () => {
  // P-ads-merchant-10: the ranking policy and its weights.
  const state = journey();
  const s = p2p(await api(state.seller));
  const res = await s.raw.query('offers.rankingPolicy');
  expect(res.status, 'offers.rankingPolicy (P-ads-merchant-10) is not built').toBe(200);
});

test('J-p2p-05 #7 a long absence delists ads once, and the person sees why and how to relist', async () => {
  // P-ads-merchant-05 part: the inactivity sweeper and its delisted reason.
  const state = journey();
  const s = p2p(await api(state.seller));
  const offer = await s.query('offers.get', { offerId: state.closedId });
  expect(offer.closeReason, 'the inactivity delist reason (P-ads-merchant-05) is not built').toBe('inactive');
});
