import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { api, fund, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { METHOD, confirmEmail, p2p, readyTaker, refusalCode, testInstrument, unconfirmedAccount } from './p2p.mjs';

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
