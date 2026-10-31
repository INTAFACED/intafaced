import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, fromUnits, fund, journeyState, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { METHOD, p2p, refusalCode, testInstrument } from './p2p.mjs';

// J-p2p-03, in the running app (docs/roadmap/journeys.json): I post an ad to buy or sell. One test per step part,
// titled "J-p2p-03 #<n>", run in order on one verified TEST advertiser with TEST 1000 USDT and a saved TEST bank
// transfer (`local-test-gates.mjs p2p` registers the method). Nothing is reserved at post: the escrow locks per order
// at take, so the ad's quantity is checked against the free balance and no coin moves.
const J = 'J-p2p-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const FUNDS = '1000';
const AD = { price: '0.93', min: '10', max: '100', total: '500' };
// A part of a step whose door is not built yet refuses at once, so the run stays short.
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

test.beforeAll(() => {
  tool('local-test-gates.mjs', 'p2p');
});

function journey() {
  const state = run.read();
  if (!state.seller) throw new Error(`${J} #1 made no advertiser, so this step has nothing to act on`);
  return state;
}

/** The advertiser's svc-p2p client. `bare` sees refusals as they are; nothing is accepted on the person's behalf. */
const advertiser = async (state) => p2p(await api(state.seller));

/** A sell ad's fields as the form sends them, with this run's marker in the terms so its ads can be told apart. */
const sellAd = (state, extra = {}) => ({
  side: 'sell',
  asset: 'USDT',
  fiatCurrency: 'EUR',
  priceType: 'fixed',
  price: AD.price,
  minAmount: AD.min,
  maxAmount: AD.max,
  totalAmount: AD.total,
  methods: [METHOD],
  terms: `TEST terms ${state.marker}: pay from an account in your own name.`,
  ...extra,
});

/** This advertiser's ads that carry `marker` in their terms, as the board pages them. */
async function adsMarked(state, marker) {
  const s = await advertiser(state);
  const page = await s.query('offers.page', { makerId: state.sellerId, limit: 200 });
  return page.offers.filter((offer) => offer.terms.includes(marker));
}

/** Fills the post-an-ad form for a sell ad of USDT for EUR, paid by the stack's TEST bank transfer. */
/** A decimal string as the customer app shows amounts: the whole part grouped by thousands (1000 is 1,000). */
const grouped = (decimal) => decimal.replace(/^\d+/, (whole) => whole.replace(/\B(?=(\d{3})+$)/g, ','));

async function fillAd(page, terms) {
  const form = page.getByTestId('offer-form');
  await expect(form).toBeVisible();
  await form.getByLabel('Sell crypto and receive fiat').check();
  await form.getByLabel('Asset').fill('USDT');
  await form.getByLabel('Fiat currency').selectOption('EUR');
  await form.getByLabel('Fixed price').check();
  await form.getByLabel('Price per unit').fill(AD.price);
  await form.getByLabel('Minimum per order').fill(AD.min);
  await form.getByLabel('Maximum per order').fill(AD.max);
  await form.getByLabel('Total quantity (optional)').fill(AD.total);
  // Exactly the stack's TEST bank transfer the advertiser holds an account for: the TEST content also registers
  // "TEST bank transfer (local test, not a real rail)", which this advertiser has no details for.
  await form.getByLabel('TEST bank transfer', { exact: true }).check();
  await form.getByLabel('Terms (optional)').fill(terms);
  return form;
}

test('J-p2p-03 #1 Post an ad shows the posting checklist for the coin and fiat, each requirement with both numbers', async ({ page }) => {
  test.setTimeout(180_000);
  // The advertiser: verified, TEST 1000 USDT, and a TEST bank account to be paid on.
  const seller = await signUp(page, 'p2p03s');
  await verify(page, seller);
  expect(fund(seller.email, 'USDT', FUNDS).tx).toBeTruthy();
  const session = await api(seller);
  const s = p2p(session);
  await testInstrument(s, seller);
  const me = await session.get('/api/identity/trpc/me');
  run.reset({ seller, sellerId: me.body.result.data.userId, marker: randomUUID().slice(0, 8) });

  // The checklist for USDT/EUR: every requirement, met or not, with the current value and the target.
  const checklist = await s.bare.query('merchants.postingEligibility', { fiatCurrency: 'EUR' });
  expect(checklist.status, 'svc-p2p has no posting checklist yet (P-ads-merchant-12)').toBe(200);
  const checks = checklist.body.result.data.checks;
  expect(checks.length).toBeGreaterThan(0);
  for (const check of checks)
    expect(check).toMatchObject({ id: expect.any(String), state: expect.stringMatching(/^(met|not_met|unknown)$/) });
  // TEST thresholds for EUR (tooling/profiles/test-owner-values/p2p.json): a verified level and no finished orders, both
  // with the person's value and the target. The thresholds are per fiat, the same for every coin.
  expect(checklist.body.result.data.policy).toBe('thresholds');
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  expect(byId.kyc_tier).toMatchObject({ state: 'met', current: expect.any(String), required: 'basic' });
  expect(byId.completed_orders).toMatchObject({ state: 'met', current: '0', required: '0' });

  // In the app: the checklist asks for a fiat, then shows each requirement with both numbers.
  await signIn(page, seller);
  await page.goto('/uc/ad/create');
  const panel = page.getByTestId('posting-checklist');
  await expect(panel).toBeVisible(UNBUILT);
  await expect(panel).toContainText('Pick a fiat currency');
  await page.getByTestId('offer-form').getByLabel('Fiat currency').selectOption('EUR');
  await expect(panel).toContainText('What posting an ad in EUR needs');
  // Every requirement the service lists is on screen with its state and both numbers, in the app's words for each.
  const LEVEL = { none: 'not verified', basic: 'basic', full: 'full', institutional: 'institutional' };
  const STATE = { met: 'Met', not_met: 'Not met', unknown: 'Cannot be checked' };
  const shown = (id, value) =>
    value === null ? 'not available' : id === 'kyc_tier' ? (LEVEL[value] ?? value) : id === 'completion_rate' ? `${value}%` : value;
  await expect(panel.locator('[data-check]')).toHaveCount(checks.length);
  for (const check of checks)
    await expect(panel.locator(`[data-check="${check.id}"]`)).toContainText(
      `${STATE[check.state]}. You: ${shown(check.id, check.current)}. Needed: ${shown(check.id, check.required)}.`,
    );
});

test('J-p2p-03 #2 posting before accepting the advertiser terms refuses and opens them with their version; accepting records it', async ({
  page,
}) => {
  const state = journey();
  const s = await advertiser(state);
  const terms = await s.bare.query('merchants.advertiserTerms');
  expect(terms.status, 'svc-p2p has no advertiser terms yet (P-ads-merchant-01)').toBe(200);
  const { version, acceptedAt } = terms.body.result.data;
  expect(version).toBeTruthy();
  expect(acceptedAt).toBeNull();
  // Straight to the service, the same refusal the form gets.
  const refused = await s.bare.mutate('offers.create', {
    ...sellAd(state),
    advertiserTermsVersion: version,
    idempotencyKey: `${J}:unaccepted:${state.seller.handle}`,
  });
  expect(refusalCode(refused)).toBe('p2p.terms_not_accepted');

  // In the app: fill the form, review it, post. The terms open with their version, and accepting records it.
  await signIn(page, state.seller);
  await page.goto('/uc/ad/create');
  await fillAd(page, `TEST terms ${state.marker}-unaccepted`);
  await page.getByTestId('offer-submit').click();
  await expect(page.getByTestId('offer-summary')).toBeVisible();
  await page.getByTestId('offer-confirm').click();
  const dialog = page.getByTestId('advertiser-terms');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Terms ${version}`);
  await dialog.getByRole('button', { name: 'I accept these terms' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('offer-summary')).toContainText(`You accepted advertiser terms ${version}`);
  const after = await s.query('merchants.advertiserTerms');
  expect(after).toMatchObject({ version, acceptedAt: expect.any(String) });
  // Nothing was posted by the refused attempt.
  expect(await adsMarked(state, `${state.marker}-unaccepted`)).toHaveLength(0);
});

test('J-p2p-03 #3 a floating price resolves to an exact decimal from the reference, or refuses without one while a fixed price posts', async ({
  page,
}) => {
  const state = journey();
  const s = await advertiser(state);
  const marker = `${state.marker}-float`;
  const floating = await s.raw.mutate('offers.create', {
    ...sellAd(state, { priceType: 'float', price: '1.02', terms: `TEST terms ${marker}` }),
    idempotencyKey: `${J}:float:${state.seller.handle}`,
  });
  if (floating.status !== 200) {
    // No reference price for USDT/EUR on this stack: the floating ad refuses with that reason, and nothing is listed.
    expect(refusalCode(floating)).toBe('p2p.reference_price_unavailable');
    expect(await adsMarked(state, marker)).toHaveLength(0);
    // From the form: the summary says why and points to a fixed price.
    await signIn(page, state.seller);
    await page.goto('/uc/ad/create');
    const form = await fillAd(page, `TEST terms ${marker}-form`);
    await form.getByLabel('Follows a reference (multiplier)').check();
    await form.getByLabel('Multiplier on the reference price').fill('1.02');
    await page.getByTestId('offer-submit').click();
    await page.getByTestId('offer-confirm').click();
    await expect(page.getByTestId('offer-summary').getByRole('alert')).toContainText(
      'No market price is published for this coin and currency, so a floating price cannot be worked out. Choose a fixed price instead.',
    );
    expect(await adsMarked(state, `${marker}-form`)).toHaveLength(0);
    // The same ad at a fixed price posts.
    const fixed = await s.mutate('offers.create', {
      ...sellAd(state, { terms: `TEST terms ${marker}-fixed` }),
      idempotencyKey: `${J}:float-fixed:${state.seller.handle}`,
    });
    expect(fixed.status).toBe('active');
    await s.mutate('offers.close', { offerId: fixed.id });
    return;
  }
  // Posted: the board must show the reference it resolves against, never an unresolved price.
  const [ad] = await adsMarked(state, marker);
  await s.mutate('offers.close', { offerId: floating.body.result.data.id });
  expect(ad?.referencePrice ?? null, 'a floating ad posted without a reference price (P-ads-merchant-03)').not.toBeNull();
});

test('J-p2p-03 #4 a total above the free balance refuses with the free amount, and the form shows what is free to sell', async ({
  page,
}) => {
  const state = journey();
  const s = await advertiser(state);
  const refused = await s.raw.mutate('offers.create', {
    ...sellAd(state, { maxAmount: '1001', totalAmount: '1001', terms: `TEST terms ${state.marker}-over` }),
    idempotencyKey: `${J}:over-balance:${state.seller.handle}`,
  });
  expect(refusalCode(refused)).toBe('p2p.insufficient_balance');
  expect(refused.body.error.data.p2pLimit).toMatchObject({ available: FUNDS, shortBy: '1' });
  expect(await adsMarked(state, `${state.marker}-over`)).toHaveLength(0);
  await signIn(page, state.seller);
  await page.goto('/uc/ad/create');
  const form = await fillAd(page, `TEST terms ${state.marker}-over-form`);
  await expect(form.getByTestId('offer-available')).toContainText('Free to sell: 1,000 USDT');
});

test('J-p2p-03 #4 the per-order limits for my level are shown, and a buy ad whose orders pass them refuses', async ({ page }) => {
  const state = journey();
  const s = await advertiser(state);
  // The level's per-order band, as svc-p2p reads it from the published table (TEST profile: 0.5 to 500 EUR).
  const level = await s.bare.query('limits.verification');
  expect(level.status, 'svc-p2p does not read the per-order limits for my level').toBe(200);
  const { currency, orderMin, orderMax } = level.body.result.data;
  // On a buy ad I am the buyer in every order, so my level caps each one: one coin past the level's maximum refuses.
  const marker = `${state.marker}-level`;
  const over = fromUnits((toUnits(orderMax) * 10n ** 18n) / toUnits(AD.price) + 10n ** 18n);
  const refused = await s.raw.mutate('offers.create', {
    ...sellAd(state, { side: 'buy', maxAmount: over, totalAmount: over, terms: `TEST terms ${marker}` }),
    idempotencyKey: `${J}:level:${state.seller.handle}`,
  });
  expect(refusalCode(refused), 'a buy ad past my level was not refused (P-ads-merchant-02)').toBe('p2p.verification_order_max');
  expect(refused.body.error.data.p2pLimit).toEqual({ until: null, min: orderMin, max: orderMax, currency });
  expect(await adsMarked(state, marker)).toHaveLength(0);
  // The form shows the same band before anything is posted.
  await signIn(page, state.seller);
  await page.goto('/uc/ad/create');
  await expect(page.getByTestId('offer-level-limits')).toContainText(`): ${grouped(orderMin)} to ${grouped(orderMax)} ${currency}.`);
});

test('J-p2p-03 #5 a flagged phrase in the terms refuses with the rule class, and nothing is posted', async () => {
  const state = journey();
  const s = await advertiser(state);
  const marker = `${state.marker}-flagged`;
  const flagged = await s.raw.mutate('offers.create', {
    ...sellAd(state, { terms: `TEST terms ${marker}: message me on telegram before you pay` }),
    idempotencyKey: `${J}:flagged:${state.seller.handle}`,
  });
  if (flagged.status === 200) await s.mutate('offers.close', { offerId: flagged.body.result.data.id });
  expect(refusalCode(flagged), 'ad terms are not screened yet (P-ads-merchant-05)').toBe('p2p.content_rule_violation');
  // The refusal names the rule class, never the phrase it matched, and nothing is listed.
  expect(flagged.body.error.data.p2pLimit).toEqual({ until: null, ruleClass: 'messenger' });
  expect(JSON.stringify(flagged.body.error)).not.toMatch(/telegram/i);
  expect(await adsMarked(state, marker)).toHaveLength(0);
});

test('J-p2p-03 #6 the summary lists every field; confirming twice posts one ad, listed on the board and in My Ads', async ({ page }) => {
  const state = journey();
  const marker = `${state.marker}-posted`;
  await signIn(page, state.seller);
  await page.goto('/uc/ad/create');
  await fillAd(page, `TEST terms ${marker}: pay from an account in your own name.`);
  await page.getByTestId('offer-submit').click();
  const summary = page.getByTestId('offer-summary');
  await expect(summary).toBeVisible();
  for (const text of ['Sell', 'USDT', 'EUR', AD.price, AD.min, AD.max, AD.total, 'TEST bank transfer', marker])
    await expect(summary).toContainText(text);
  await expect(summary).toContainText('Orders keep the terms they were placed on');
  // The same confirm twice, as a double tap: one ad.
  await page.getByTestId('offer-confirm').dblclick();
  const receipt = page.getByTestId('offer-receipt');
  await expect(receipt).toContainText('Listed');
  const ads = await adsMarked(state, marker);
  expect(ads).toHaveLength(1);
  expect(ads[0]).toMatchObject({ status: 'active', price: AD.price, totalAmount: AD.total, remainingAmount: AD.total });
  await expect(receipt).toContainText(ads[0].id);
  // A retry with the same key, as after a lost reply, answers the same ad.
  const s = await advertiser(state);
  const key = `${J}:replay:${state.seller.handle}`;
  const first = await s.mutate('offers.create', { ...sellAd(state, { terms: `TEST terms ${marker}-replay` }), idempotencyKey: key });
  const again = await s.mutate('offers.create', { ...sellAd(state, { terms: `TEST terms ${marker}-replay` }), idempotencyKey: key });
  expect(again.id).toBe(first.id);
  expect(await adsMarked(state, `${marker}-replay`)).toHaveLength(1);
  // Nothing is reserved at post: the free balance is what was funded.
  expect((await s.query('offers.sellBalance', { asset: 'USDT' })).available).toBe(FUNDS);
  // On the board, and in My Ads: the posted ad's own row, by its id, with its price and both limits in order.
  const limits = new RegExp(`(^|\\D)${AD.min}\\s*USDT\\s*–\\s*${AD.max}\\s*USDT`);
  await page.goto(`/p2p?makerId=${state.sellerId}`);
  const boardRow = page.locator(`li[data-testid="p2p-offer-row"][data-offer-id="${ads[0].id}"]`);
  await expect(boardRow).toHaveCount(1);
  await expect(boardRow).toContainText(AD.price);
  await expect(boardRow).toContainText(limits);
  await page.goto('/uc/ad');
  const mineRow = page.locator(`li.p2p-offer-row[data-offer-id="${ads[0].id}"]`);
  await expect(mineRow).toHaveCount(1);
  await expect(mineRow).toContainText(AD.price);
  await expect(mineRow).toContainText(limits);
});
