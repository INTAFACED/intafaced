import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { api, fund, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN } from './identity-factors.mjs';
import {
  METHOD,
  RETIRING_METHOD,
  TEST_IBAN,
  browserHoldsPasskey,
  confirmEmail,
  p2p,
  readyTaker,
  refusalCode,
  registerRetiringMethod,
  retireRetiringMethod,
  testInstrument,
  testPasskey,
  unconfirmedAccount,
} from './p2p.mjs';

// J-p2p-01, in the running app (docs/roadmap/journeys.json): I buy crypto from an ad, pay the seller outside, and
// receive the coins. One test per step, titled "J-p2p-01 #<n>", run in order on one verified TEST buyer. The other side
// is a verified TEST seller with a TEST USDT sell ad paid by the stack's TEST bank transfer (`local-test-gates.mjs
// p2p`). Fiat never moves; the coins move through the ledger's escrow. The risk notice version is the labelled TEST
// profile value (tooling/profiles/test-owner-values/p2p.json).
const J = 'J-p2p-01';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const AD = { price: '0.92', min: '10', max: '50', total: '200' };

test.describe.configure({ mode: 'default' });

test.beforeAll(() => {
  tool('local-test-gates.mjs', 'p2p');
});

function journey() {
  const state = run.read();
  if (!state.buyer) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return state;
}

/** The seller's user id, as the ad itself names its maker. */
const sellerId = async (client, offerId) => (await client.query('offers.get', { offerId })).makerId;

const eligibility = (page) => page.getByRole('region', { name: 'Before you trade' });
const check = (page, id) => eligibility(page).locator(`li[data-check="${id}"]`);

test('J-p2p-01 #1 the P2P hub opens from More, lists every requirement, and a take without a confirmed email is refused', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // The seller: verified, TEST USDT, a TEST bank account, a sell ad, and one completed order with someone else, so the
  // ad shows a real record (#3).
  const seller = await signUp(page, 'p2p01s');
  await verify(page, seller);
  expect(fund(seller.email, 'USDT', '500').tx).toBeTruthy();
  const s = p2p(await api(seller));
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
  const earlier = await signUp(page, 'p2p01e');
  await verify(page, earlier);
  const e = await readyTaker(await api(earlier), earlier);
  const first = await e.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: AD.min, method: METHOD });
  await e.mutate('trades.markFiatSent', { tradeId: first.id });
  expect((await s.mutate('trades.confirmReceived', { tradeId: first.id })).status).toBe('released');

  // The buyer: verified, with the email address never confirmed.
  const buyer = await unconfirmedAccount('p2p01b');
  await signIn(page, buyer);
  await verify(page, buyer);
  run.reset({ seller, buyer, offerId: offer.id });

  await signIn(page, buyer);
  await page.goto('/more');
  await page
    .getByRole('link', { name: /Person-to-person/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/p2p$/);
  // Every room by a real path.
  const rooms = page.getByRole('navigation', { name: 'P2P rooms' });
  for (const [name, href] of [
    ['Offers', '/p2p'],
    ['Your orders', '/uc/order'],
    ['Your offers', '/uc/ad'],
    ['Payment methods', '/p2p?view=methods'],
    ['Trading access', '/p2p/access'],
  ])
    await expect(rooms.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);

  // Each requirement, met or not, with the fix where the app has one.
  await expect(eligibility(page)).toContainText('Taking an ad is refused until every requirement below is met.');
  await expect(check(page, 'verification')).toHaveAttribute('data-state', 'met');
  await expect(check(page, 'verification')).toContainText('Verified at the full level.');
  await expect(check(page, 'contact')).toHaveAttribute('data-state', 'not_met');
  await expect(check(page, 'contact').getByRole('link', { name: 'Confirm your email' })).toHaveAttribute('href', '/uc/account');
  await expect(check(page, 'jurisdiction')).toHaveAttribute('data-state', 'met');
  await expect(check(page, 'deposit')).toHaveAttribute('data-state', 'met');
  await expect(check(page, 'deposit')).toContainText('Takers post no deposit.');
  await expect(check(page, 'risk')).toHaveAttribute('data-state', 'not_met');

  // Take refuses p2p.contact_required, and nothing was reserved.
  const b = p2p(await api(buyer));
  const before = (await b.query('offers.get', { offerId: offer.id })).remainingAmount;
  const refused = await b.raw.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: AD.min, method: METHOD });
  expect(refused.status).toBe(403);
  expect(refusalCode(refused)).toBe('p2p.contact_required');
  expect((await b.query('offers.get', { offerId: offer.id })).remainingAmount).toBe(before);

  // The fix link leads to the confirmation; once confirmed the check is met.
  await check(page, 'contact').getByRole('link', { name: 'Confirm your email' }).click();
  await expect(page).toHaveURL(/\/uc\/account$/);
  await expect(page.getByRole('region', { name: 'Verify your email address' })).toBeVisible();
  await confirmEmail(await api(buyer), buyer);
  await page.goto('/p2p');
  await expect(check(page, 'contact')).toHaveAttribute('data-state', 'met');
  await expect(check(page, 'contact')).toContainText('Your email address is confirmed.');
  // The Trading access room lists the same requirements at its own address.
  await rooms.getByRole('link', { name: 'Trading access', exact: true }).click();
  await expect(page).toHaveURL(/\/p2p\/access$/);
  await expect(check(page, 'contact')).toHaveAttribute('data-state', 'met');
  await expect(check(page, 'risk')).toHaveAttribute('data-state', 'not_met');
});

test('J-p2p-01 #2 the ad board searches by coin, fiat, method and amount, sorts by price, pages without a repeat, and names a floating ad that needs a market feed', async ({
  page,
}) => {
  const state = journey();
  const s = p2p(await api(state.seller));
  // Three more TEST ads from the same seller: dearer, cheaper with a higher minimum, and one floating on a reference.
  const ad = (key, extra) =>
    s.mutate('offers.create', {
      side: 'sell',
      asset: 'USDT',
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      minAmount: '10',
      maxAmount: '50',
      totalAmount: '60',
      methods: [METHOD],
      terms: 'TEST terms',
      idempotencyKey: `${J}:${key}:${state.seller.handle}`,
      ...extra,
    });
  const dear = (await ad('dear', { price: '0.95' })).id;
  const cheap = (await ad('cheap', { price: '0.90', minAmount: '30' })).id;
  const float = (await ad('float', { priceType: 'float', price: '1.01' })).id;
  const first = state.offerId;

  const buyer = p2p(await api(state.buyer));
  const maker = await sellerId(buyer, first);
  // Every page of the seller's ads, one row at a time: each ad once, in the board's order.
  const walk = async (sort) => {
    const seen = [];
    let cursor = null;
    do {
      const pageOf = await buyer.query('offers.page', { makerId: maker, limit: 1, sort, ...(cursor ? { cursor } : {}) });
      seen.push(...pageOf.offers.map((offer) => offer.id));
      cursor = pageOf.nextCursor;
    } while (cursor && seen.length < 10);
    return seen;
  };
  expect(await walk('price_asc')).toEqual([cheap, first, dear, float]);
  expect(await walk('price_desc')).toEqual([dear, first, cheap, float]);

  await signIn(page, state.buyer);
  await page.goto(`/p2p?makerId=${maker}`);
  const rows = page.locator('li.p2p-offer-row');
  const order = () => rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-offer-id')));
  await expect(rows).toHaveCount(4);
  expect(await order()).toEqual([cheap, first, dear, float]);
  // Each row: price, limits, method and maker.
  const firstRow = page.locator(`li[data-offer-id="${first}"]`);
  await expect(firstRow).toContainText('0.92');
  await expect(firstRow).toContainText(METHOD);
  await expect(page.locator(`li[data-offer-id="${float}"]`).getByTestId('p2p-offer-needs-feed')).toContainText(
    'Needs a market feed: no EUR / USDT reference price is published',
  );
  await expect(page.getByText('That is every open offer for these filters.')).toBeVisible();

  // Coin, fiat, method and a 20 EUR amount, dearest first: the cheap ad (30 USDT minimum) and the floating ad drop out.
  await page.getByText('Filters', { exact: true }).click();
  const filters = page.locator('form.pay-filters');
  await filters.getByLabel('Asset', { exact: true }).fill('USDT');
  await filters.getByLabel('Amount in fiat').fill('20');
  await filters.getByRole('button', { name: /Apply/ }).click();
  await expect(page.getByText('Choose a fiat currency to search by amount.')).toBeVisible();
  await filters.locator('select').nth(0).selectOption('EUR');
  await filters.locator('select').nth(2).selectOption(METHOD);
  await filters.locator('select').nth(3).selectOption('price_desc');
  await filters.getByRole('button', { name: /Apply/ }).click();
  await expect(rows).toHaveCount(2);
  expect(await order()).toEqual([dear, first]);
  await expect(page.getByText('Floating-price ads are left out of an amount search')).toBeVisible();
});

test('J-p2p-01 #3 an ad shows the seller’s record and terms, and the risk notice must be accepted before taking', async ({ page }) => {
  const state = journey();
  const b = p2p(await api(state.buyer));
  await signIn(page, state.buyer);
  await page.goto(`/p2p?offerId=${state.offerId}`);

  const take = page.getByTestId('take-offer');
  // The seller's record, recomputed by the service from their one completed order, and the ad's terms.
  const record = await b.query('reputation.get', { userId: (await b.query('offers.get', { offerId: state.offerId })).makerId });
  expect(record.completed).toBe(1);
  const current = page.getByRole('region', { name: 'Current offer' });
  await expect(current).toContainText('1 order · 100% completed · releases in about');
  await expect(current).toContainText('TEST terms: pay from an account in your own name; no third-party payments.');

  // Not accepted yet: the take panel names it, and the service refuses a take by name.
  await expect(take.locator('li[data-check="risk"]')).toHaveAttribute('data-state', 'not_met');
  const refused = await b.raw.mutate('trades.take', { offerId: state.offerId, tradeId: randomUUID(), amount: '10', method: METHOD });
  expect(refused.status).toBe(403);
  expect(refusalCode(refused)).toBe('p2p.risk_not_accepted');

  await take.getByRole('button', { name: 'Read the risk and fraud notice' }).click();
  const sheet = page.getByTestId('p2p-risk-sheet');
  await expect(sheet).toContainText('It is not the other side of your trade.');
  await expect(sheet).toContainText('Never cancel an order after you paid.');
  await sheet.getByRole('button', { name: 'I have read this and accept it' }).click();
  await expect(sheet).toHaveCount(0);
  // Every requirement met: the take panel no longer lists any.
  await expect(take.getByRole('region', { name: 'Before you trade' })).toHaveCount(0);
  const notice = await b.query('risk.notice');
  expect(notice.acceptedAt).toBeTruthy();
  expect((await b.query('access.eligibility')).canTake).toBe(true);
});

test('J-p2p-01 #4 a fiat amount becomes a quote held with a countdown, and a quote past its window refuses by name', async ({ page }) => {
  test.setTimeout(300_000);
  const state = journey();
  // The buyer's TEST passkey, saved on the account here: it confirms the service-side take below, and the browser
  // holds the same one in #5.
  const session = await api(state.buyer);
  const key = await testPasskey(session);
  const b = p2p(session, key);
  // A quote held through the service's own window (the stack's TEST escrow window, 120 s), placed after it ends.
  const held = await b.mutate('trades.lockQuote', {
    quoteId: randomUUID(),
    offerId: state.offerId,
    fiatAmount: '20',
    method: METHOD,
  });
  // 20 EUR at 0.92 is 21.739130434782608695… USDT, rounded down: never more fiat than asked.
  expect(held.amount).toBe('21.739130434782608695');
  expect(held.fiatAmount).toBe('20');

  await signIn(page, state.buyer);
  await page.goto(`/p2p?offerId=${state.offerId}`);
  const take = page.getByTestId('take-offer');
  await take.getByTestId('take-fiat-amount').fill('20');
  await take.locator('select').selectOption(METHOD);
  await expect(take.getByLabel('Quantity in USDT')).toHaveValue('21.739130434782608695');
  const quote = take.getByTestId('take-quote');
  await expect(quote).toContainText('20 EUR');
  await expect(quote).toContainText('0.92 EUR / USDT');
  await take.getByTestId('take-review').click();
  const dialog = page.getByTestId('take-review-dialog');
  const countdown = dialog.getByTestId('take-quote-countdown');
  await expect(countdown).toContainText(/Price, fee and amounts held for 1:[45]\d/);
  // Placing is the fresh confirmation (#5): offered while the quote holds.
  const passkey = dialog.getByRole('button', { name: 'Use a passkey' });
  await expect(passkey).toBeEnabled();

  // Past the window: the service refuses the held quote by name and reserves nothing; the dialog turns placing off.
  const before = (await b.query('offers.get', { offerId: state.offerId })).remainingAmount;
  await page.waitForTimeout(Math.max(0, Date.parse(held.expiresAt) - Date.now()) + 1_000);
  const refused = await b.raw.mutate('trades.take', {
    offerId: state.offerId,
    tradeId: randomUUID(),
    amount: held.amount,
    method: METHOD,
    quoteId: held.quoteId,
  });
  expect(refused.status).toBe(409);
  expect(refusalCode(refused)).toBe('p2p.quote_expired');
  expect((await b.query('offers.get', { offerId: state.offerId })).remainingAmount).toBe(before);
  await expect(countdown).toHaveAttribute('data-ended', 'true');
  await expect(countdown).toContainText('This quote ended at');
  await expect(passkey).toBeDisabled();
  await dialog.getByTestId('take-quote-renew').click();
  await expect(countdown).toContainText(/held for 1:[45]\d/);
  await expect(passkey).toBeEnabled();
  run.write({ passkey: key.saved() });
});

test('J-p2p-01 #4 a pair limit, the ongoing-order cap and the daily verification allowance each refuse in plain words with the end time', async ({
  page,
}) => {
  test.setTimeout(300_000);
  // Its own seller and two buyers, so the 450 EUR order and the 20 open orders stay out of the main buyer's day. The
  // limits are the labelled TEST profile values: USDT/EUR orders of 0.5 to 500 EUR, 600 EUR a day for every
  // verification level, 20 ongoing orders.
  const seller = await signUp(page, 'p2p01l');
  await verify(page, seller);
  expect(fund(seller.email, 'USDT', '1200').tx).toBeTruthy();
  const s = p2p(await api(seller));
  await testInstrument(s, seller);
  const offer = await s.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: AD.price,
    minAmount: '1',
    maxAmount: '1000',
    totalAmount: '1200',
    methods: [METHOD],
    terms: 'TEST terms: pay from an account in your own name.',
    idempotencyKey: `${J}:limits-offer:${seller.handle}`,
  });
  const takeFiat = async (fiat) => {
    const take = page.getByTestId('take-offer');
    await take.getByTestId('take-fiat-amount').fill(fiat);
    await take.locator('select').selectOption(METHOD);
    return take.getByTestId('take-failure');
  };

  // Over the pair's bounds: refused while typing, with the bounds and no end time.
  const daily = await signUp(page, 'p2p01d');
  await verify(page, daily);
  const d = await readyTaker(await api(daily), daily);
  await signIn(page, daily);
  await page.goto(`/p2p?offerId=${offer.id}`);
  let failure = await takeFiat('600');
  await expect(failure).toHaveAttribute('data-kind', 'pairLimit');
  await expect(failure).toContainText('Each order on this pair is between 0.5 and 500 EUR. This limit has no end time');
  const overPair = await d.raw.mutate('trades.lockQuote', { quoteId: randomUUID(), offerId: offer.id, fiatAmount: '600', method: METHOD });
  expect(overPair.status).toBe(400);
  expect(refusalCode(overPair)).toBe('p2p.pair_limit_exceeded');
  expect(overPair.body.error.data.p2pLimit).toEqual({ until: null, min: '0.5', max: '500', currency: 'EUR' });

  // 449.88 EUR bought today; 200 EUR more passes the 600 EUR day: what is left, and the next UTC day it starts again.
  expect((await d.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: '489', method: METHOD })).status).toBe(
    'escrowed',
  );
  const overDay = await d.raw.query('trades.quote', { offerId: offer.id, fiatAmount: '200', method: METHOD });
  expect(refusalCode(overDay)).toBe('p2p.verification_daily_limit');
  // The allowance starts again at the next UTC midnight, as the service's own clock has it.
  const dayLimit = overDay.body.error.data.p2pLimit;
  expect(dayLimit).toEqual({ until: expect.stringMatching(/T00:00:00\.000Z$/), remaining: '150.12', currency: 'EUR' });
  expect(Date.parse(dayLimit.until) - Date.now()).toBeGreaterThan(0);
  expect(Date.parse(dayLimit.until) - Date.now()).toBeLessThanOrEqual(86_400_000);
  await page.reload();
  failure = await takeFiat('200');
  await expect(failure).toHaveAttribute('data-kind', 'verificationLimit');
  await expect(failure).toContainText('150.12 EUR is left today, and the allowance starts again at');
  await expect(failure.getByRole('link', { name: 'Raise your verification level' })).toHaveAttribute('href', '/verification');

  // Twenty ongoing orders: the next is refused with each of them linked and the soonest deadline.
  const busy = await signUp(page, 'p2p01c');
  await verify(page, busy);
  const c = await readyTaker(await api(busy), busy);
  const open = [];
  for (let i = 0; i < 20; i++) {
    open.push((await c.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: '1', method: METHOD })).id);
  }
  const before = (await c.query('offers.get', { offerId: offer.id })).remainingAmount;
  const capped = await c.raw.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: '1', method: METHOD });
  expect(capped.status).toBe(409);
  expect(refusalCode(capped)).toBe('p2p.active_order_cap');
  const limit = capped.body.error.data.p2pLimit;
  expect(limit.cap).toBe('20');
  expect([...limit.openTradeIds].sort()).toEqual([...open].sort());
  expect(Date.parse(limit.until)).toBeGreaterThan(Date.now());
  expect((await c.query('offers.get', { offerId: offer.id })).remainingAmount).toBe(before);
  await signIn(page, busy);
  await page.goto(`/p2p?offerId=${offer.id}`);
  failure = await takeFiat('5');
  await expect(failure).toHaveAttribute('data-kind', 'orderCap');
  await expect(failure).toContainText('You already have 20 ongoing orders, the most you can hold at once.');
  await expect(failure).toContainText('The soonest of them reaches its deadline at');
  await expect(failure.getByTestId('take-open-order')).toHaveCount(20);
  await expect(failure.getByTestId('take-open-order').first()).toHaveAttribute('href', /^\/p2p\/orders\/[0-9a-f-]{36}$/);
});

test('J-p2p-01 #4 a payment method retired while the ad is open refuses in plain words with the reason and no end time', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // Its own seller and buyer, and a second TEST method the founder pair retires; the shared TEST bank transfer stays.
  await registerRetiringMethod();
  const seller = await signUp(page, 'p2p01r');
  await verify(page, seller);
  expect(fund(seller.email, 'USDT', '100').tx).toBeTruthy();
  const s = p2p(await api(seller));
  await testInstrument(s, seller);
  await s.mutate('instruments.create', {
    instrumentId: randomUUID(),
    methodId: RETIRING_METHOD,
    country: 'DE',
    fiatCurrency: 'EUR',
    label: 'TEST second account',
    details: { account_holder: seller.handle, iban: TEST_IBAN },
  });
  const offer = await s.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: AD.price,
    minAmount: AD.min,
    maxAmount: AD.max,
    totalAmount: '100',
    methods: [METHOD, RETIRING_METHOD],
    terms: 'TEST terms: pay from an account in your own name.',
    idempotencyKey: `${J}:retired-offer:${seller.handle}`,
  });
  const buyer = await signUp(page, 'p2p01m');
  await verify(page, buyer);
  const b = await readyTaker(await api(buyer), buyer);

  // The buyer has the ad open with the second method chosen, and it quotes.
  await signIn(page, buyer);
  await page.goto(`/p2p?offerId=${offer.id}`);
  const take = page.getByTestId('take-offer');
  await take.locator('select').selectOption(RETIRING_METHOD);
  await take.getByTestId('take-fiat-amount').fill('20');
  await expect(take.getByTestId('take-quote')).toContainText('20 EUR');

  // The operators retire it: the payment provider withdrew it. The take names that, with no end time, and reserves nothing.
  const retired = await retireRetiringMethod('provider_withdrawn');
  expect(retired.enabled).toBe(false);
  const refused = await b.raw.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: '20', method: RETIRING_METHOD });
  expect(refused.status).toBe(400);
  expect(refusalCode(refused)).toBe('p2p.method_delisted');
  expect(refused.body.error.data.p2pLimit).toEqual({ until: null, reason: 'provider_withdrawn' });
  expect((await b.query('offers.get', { offerId: offer.id })).remainingAmount).toBe('100');
  await take.getByTestId('take-fiat-amount').fill('21');
  const failure = take.getByTestId('take-failure');
  await expect(failure).toHaveAttribute('data-kind', 'methodRetired');
  await expect(failure).toContainText(
    'This payment method has been retired because the payment provider withdrew it. This has no end time: choose another method on this ad, or another ad. Nothing was placed.',
  );
  // The ad still takes orders by the method that is not retired.
  await take.locator('select').selectOption(METHOD);
  await expect(take.getByTestId('take-quote')).toContainText('21 EUR');
});

test('J-p2p-01 #4 after three cancelled orders buying is paused, in plain words with the end time', async ({ page }) => {
  test.setTimeout(240_000);
  // Its own seller and buyer. The limit is the labelled TEST profile value: 3 cancelled orders within 24 hours.
  const seller = await signUp(page, 'p2p01x');
  await verify(page, seller);
  expect(fund(seller.email, 'USDT', '100').tx).toBeTruthy();
  const s = p2p(await api(seller));
  await testInstrument(s, seller);
  const offer = await s.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: AD.price,
    minAmount: AD.min,
    maxAmount: AD.max,
    totalAmount: '100',
    methods: [METHOD],
    terms: 'TEST terms: pay from an account in your own name.',
    idempotencyKey: `${J}:cancel-offer:${seller.handle}`,
  });
  const buyer = await signUp(page, 'p2p01k');
  await verify(page, buyer);
  const b = await readyTaker(await api(buyer), buyer);
  const cancelled = [];
  for (let i = 0; i < 3; i++) {
    const trade = await b.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: '10', method: METHOD });
    cancelled.push(await b.mutate('trades.cancel', { tradeId: trade.id, reason: 'TEST changed my mind' }));
  }

  // The fourth take refuses before anything is reserved, with when buying starts again: 24 hours after the first cancel.
  const refused = await b.raw.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: '10', method: METHOD });
  expect(refused.status).toBe(409);
  expect(refusalCode(refused)).toBe('p2p.buying_restricted');
  const pause = refused.body.error.data.p2pLimit;
  expect(pause).toEqual({ until: expect.any(String), cap: '3', windowHours: '24' });
  const firstCancel = Date.parse(cancelled[0].resolvedAt);
  expect(Date.parse(pause.until) - firstCancel).toBeGreaterThan(24 * 3_600_000 - 60_000);
  expect(Date.parse(pause.until) - firstCancel).toBeLessThan(24 * 3_600_000 + 60_000);
  expect((await b.query('offers.get', { offerId: offer.id })).remainingAmount).toBe('100');

  await signIn(page, buyer);
  await page.goto(`/p2p?offerId=${offer.id}`);
  const take = page.getByTestId('take-offer');
  await take.locator('select').selectOption(METHOD);
  await take.getByTestId('take-fiat-amount').fill('20');
  const failure = take.getByTestId('take-failure');
  await expect(failure).toHaveAttribute('data-kind', 'buyingPaused');
  await expect(failure).toContainText(
    'You cancelled 3 orders, or let their payment time run out, within 24 hours, so buying is paused until',
  );
  await expect(failure).toContainText('Selling is not paused. Nothing was placed.');
});

test('J-p2p-01 #5 the order is placed once, confirmed with a fresh passkey; a take without one is refused; the order keeps its terms', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const state = journey();
  // Passkeys belong to the stack's relying party, localhost, so the buyer uses the app there; the browser's (virtual)
  // authenticator holds the passkey saved on the account in #4.
  const context = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  const page = await context.newPage();
  await browserHoldsPasskey(page, state.passkey);
  await signIn(page, state.buyer);

  // A take with no confirmation is refused by name, and nothing is reserved or locked.
  const b = p2p(await api(state.buyer));
  const s = p2p(await api(state.seller));
  const before = (await b.query('offers.get', { offerId: state.offerId })).remainingAmount;
  const refused = await b.bare.mutate('trades.take', { offerId: state.offerId, tradeId: randomUUID(), amount: '10', method: METHOD });
  expect(refused.status).toBe(403);
  expect(refusalCode(refused)).toBe('auth.step_up_required');
  expect((await b.query('offers.get', { offerId: state.offerId })).remainingAmount).toBe(before);

  // Review, then confirm with the passkey: the order is placed and opens.
  const review = async (open = () => page.goto(`/p2p?offerId=${state.offerId}`)) => {
    await open();
    const take = page.getByTestId('take-offer');
    await take.getByTestId('take-fiat-amount').fill('9.2');
    await take.locator('select').selectOption(METHOD);
    await expect(take.getByLabel('Quantity in USDT')).toHaveValue('10');
    await take.getByTestId('take-review').click();
    return page.getByTestId('take-review-dialog');
  };
  let dialog = await review();
  await expect(dialog).toContainText('Placing an order holds the seller’s coins in escrow, so it needs a fresh check that it’s you.');
  await dialog.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(page).toHaveURL(/\/uc\/order\?tradeId=/);
  const tradeId = new URL(page.url()).searchParams.get('tradeId');
  const ordersOnAd = async () =>
    (await b.query('trades.page', { limit: 50 })).trades.filter((trade) => trade.offerId === state.offerId).map((trade) => trade.id);
  expect(await ordersOnAd()).toEqual([tradeId]);
  expect(Number(before) - Number((await b.query('offers.get', { offerId: state.offerId })).remainingAmount)).toBe(10);
  expect(await b.query('trades.get', { tradeId })).toMatchObject({
    status: 'escrowed',
    amount: '10',
    price: '0.92',
    fiatAmount: '9.2',
    method: METHOD,
  });

  // Back to the ad in the app: the confirmation covers the next orders here for up to ten minutes, and says so; a
  // double press places one order.
  dialog = await review(() => page.goBack());
  await expect(dialog.getByTestId('take-step-up-covered')).toContainText(
    'You confirmed it’s you here, so this order needs no new check until',
  );
  await dialog.getByTestId('take-confirm').dblclick();
  await expect(page).toHaveURL(/\/uc\/order\?tradeId=/);
  const second = new URL(page.url()).searchParams.get('tradeId');
  expect(second).not.toBe(tradeId);
  expect((await ordersOnAd()).sort()).toEqual([tradeId, second].sort());
  expect(Number(before) - Number((await b.query('offers.get', { offerId: state.offerId })).remainingAmount)).toBe(20);
  await page.goto(`/uc/order?tradeId=${tradeId}`);

  // The seller edits the ad: the order keeps the price, amount and method it was placed under.
  await s.mutate('offers.update', {
    offerId: state.offerId,
    idempotencyKey: `${J}:edit:${tradeId}`,
    price: '0.95',
    terms: 'TEST terms changed after the order was placed.',
  });
  expect((await s.query('offers.get', { offerId: state.offerId })).price).toBe('0.95');
  expect(await b.query('trades.get', { tradeId })).toMatchObject({ price: '0.92', amount: '10', fiatAmount: '9.2', method: METHOD });
  await page.reload();
  const order = page.getByRole('main');
  await expect(order).toContainText('0.92');
  await expect(order).toContainText('9.2 EUR');
  await expect(order).not.toContainText('0.95');
  // The ad's terms as they were when the order was placed, not the edit.
  await order.getByText('Order details').click();
  await expect(order.getByTestId('order-terms')).toHaveText('TEST terms: pay from an account in your own name; no third-party payments.');
  await expect(order).not.toContainText('TEST terms changed after the order was placed.');
  run.write({ tradeId });
  await context.close();
});
