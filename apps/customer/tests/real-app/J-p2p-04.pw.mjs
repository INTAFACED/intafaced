import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { api, fund, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN } from './identity-factors.mjs';
import {
  METHOD,
  TEST_IBAN,
  browserHoldsPasskey,
  holderOf,
  p2p,
  readyTaker,
  refusalCode,
  registerTestMethod,
  restorePasskey,
  retireTestMethod,
  testInstrument,
  verifiedName,
} from './p2p.mjs';

// J-p2p-04, in the running app (docs/roadmap/journeys.json): I add and manage the payment methods I get paid with. One
// test per step part, titled "J-p2p-04 #<n>", run in order on one verified TEST seller whose TEST legal name the founder
// pair recorded (the own-name rule compares against it). The shared TEST bank transfer (`local-test-gates.mjs p2p`)
// asks for an account holder in the person's own name and an IBAN with a format hint. Every payment-method change is
// confirmed with the seller's TEST passkey (P-ads-merchant-18), saved on the account the first time one asks.
const J = 'J-p2p-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** This journey's own TEST method, which step 1 retires; no other journey pays with it. */
const J04_METHOD = 'test-j04-transfer';
const J04_LABEL = 'TEST J-p2p-04 transfer';
/** The stack's TEST cash-in-person method (`local-test-gates.mjs p2p`), whose row carries cash rules. */
const CASH_METHOD = 'test-cash-in-person';
const AD = { price: '0.93', min: '10', max: '100' };
// A part of a step whose door is not built yet refuses at once, so the run stays short.
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

test.beforeAll(() => {
  tool('local-test-gates.mjs', 'p2p');
});

function journey() {
  const state = run.read();
  if (!state.seller) throw new Error(`${J} #1 made no seller, so this step has nothing to act on`);
  return state;
}

/** The seller's svc-p2p client in a new session, confirming payment-method changes with the account's TEST passkey. */
const seller = async (state) => p2p(await api(state.seller), await restorePasskey(state.sellerPasskey));
/** A passkey's counter only goes up: keep how far it went, so the next confirmation is not read as a replay. */
const keepCounter = (s) => run.write({ sellerPasskey: s.passkey().saved() });
/**
 * The seller in the app on the passkey origin, the browser's (virtual) authenticator holding the account's TEST passkey.
 * The browser counts its own answers past every count the stored key used, so later API answers start well past them.
 */
async function sellerInApp(browser, state, who = 'seller') {
  const context = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  const page = await context.newPage();
  const key = state[`${who}Passkey`];
  await browserHoldsPasskey(page, key);
  run.write({ [`${who}Passkey`]: { ...key, signCount: key.signCount + 1000 } });
  await signIn(page, state[who]);
  return page;
}

/** A TEST bank account for `methodId` as the add form sends it, held in `holder`. */
const account = (methodId, holder, extra = {}) => ({
  instrumentId: randomUUID(),
  methodId,
  country: 'DE',
  fiatCurrency: 'EUR',
  label: 'TEST account',
  details: { account_holder: holder, iban: TEST_IBAN },
  ...extra,
});

/** Picks DE and `label` in the add form, and the currency the person receives. */
async function pickMethod(page, label) {
  const form = page.getByTestId('method-add-form');
  await expect(form).toBeVisible();
  await form.getByTestId('method-add-country').fill('DE');
  await form.getByTestId('method-add-method').selectOption({ label });
  await form.getByTestId('method-add-fiat').selectOption('EUR');
  return form;
}

test('J-p2p-04 #1 the catalogue shows each method per country with what it asks for; a retired method leaves new ads and stays on an open order', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // This journey's own TEST method, switched on, beside the shared TEST bank transfer.
  await registerTestMethod(J04_METHOD, J04_LABEL);
  const who = await signUp(page, 'p2p04s');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  const session = await api(who);
  const s = p2p(session);
  await testInstrument(s, who);
  await s.mutate('instruments.create', account(J04_METHOD, await verifiedName(session, who), { label: 'TEST second account' }));
  const me = await session.get('/api/identity/trpc/me');
  // An ad paid by both methods, and an open order on it by this journey's method.
  const offer = await s.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: AD.price,
    minAmount: AD.min,
    maxAmount: AD.max,
    totalAmount: '100',
    methods: [METHOD, J04_METHOD],
    terms: 'TEST terms: pay from an account in your own name.',
    idempotencyKey: `${J}:offer:${who.handle}`,
  });
  const buyer = await signUp(page, 'p2p04b');
  await verify(page, buyer);
  const b = await readyTaker(await api(buyer), buyer);
  const trade = await b.mutate('trades.take', { offerId: offer.id, tradeId: randomUUID(), amount: '20', method: J04_METHOD });
  // Saving the first method asked for a confirmation, so the seller now holds a TEST passkey.
  run.reset({
    seller: who,
    sellerId: me.body.result.data.userId,
    offerId: offer.id,
    tradeId: trade.id,
    buyer,
    sellerPasskey: s.passkey().saved(),
  });

  // In the app: the catalogue for DE lists the TEST bank transfer with each field it asks for and the own-name rule.
  await signIn(page, who);
  await page.goto('/p2p/methods');
  const catalogue = page.getByTestId('methods-catalogue');
  await expect(catalogue).toBeVisible();
  await catalogue.getByLabel('Country').selectOption('DE');
  const bank = catalogue.locator(`[data-testid="catalogue-method"][data-method="${METHOD}"][data-country="DE"]`);
  await expect(bank).toContainText('Account holder (required)');
  await expect(bank).toContainText('IBAN (required): Two capital letters, two digits, then 11 to 30 capital letters or digits');
  await expect(bank.getByTestId('catalogue-own-name')).toContainText('The account must be in your own name');
  await expect(catalogue.locator(`[data-method="${J04_METHOD}"]`)).toContainText('enabled');

  // The founder pair retires this journey's method: the payment provider withdrew it.
  expect((await retireTestMethod(J04_METHOD, 'provider_withdrawn')).enabled).toBe(false);
  await page.reload();
  await page.getByTestId('methods-catalogue').getByLabel('Country').selectOption('DE');
  // Gone from the catalogue and the add form, refused straight to the service, and gone from the post-an-ad form.
  await expect(page.getByTestId('methods-catalogue').locator(`[data-method="${METHOD}"]`)).toBeVisible();
  await expect(page.getByTestId('methods-catalogue').locator(`[data-method="${J04_METHOD}"]`)).toHaveCount(0);
  const form = page.getByTestId('method-add-form');
  await form.getByTestId('method-add-country').fill('DE');
  await expect(form.getByTestId('method-add-method').locator('option', { hasText: 'TEST bank transfer' }).first()).toBeAttached();
  await expect(form.getByTestId('method-add-method').locator('option', { hasText: J04_LABEL })).toHaveCount(0);
  const refused = await s.raw.mutate('instruments.create', account(J04_METHOD, holderOf(who), { fiatCurrency: 'USD' }));
  keepCounter(s);
  expect(refusalCode(refused)).toBe('p2p.instrument_method_disabled');
  await page.goto('/uc/ad/create');
  await expect(page.getByTestId('offer-form').getByLabel('TEST bank transfer', { exact: true })).toBeVisible();
  await expect(page.getByTestId('offer-form').getByLabel(J04_LABEL, { exact: true })).toHaveCount(0);
  // The open order keeps it.
  await page.goto(`/p2p/orders/${trade.id}`);
  await expect(page.getByText(J04_METHOD, { exact: true })).toBeVisible();
});

test('J-p2p-04 #1 cash in person and payment-note rules come from the method row', async ({ page }) => {
  const state = journey();
  await signIn(page, state.seller);
  await page.goto('/p2p/methods');
  await page.getByTestId('methods-catalogue').getByLabel('Country').selectOption('DE');
  // The remittance note rules the bank transfer's row carries, shown beside it (P-ads-merchant-19).
  const notes = page.locator(`[data-testid="catalogue-method"][data-method="${METHOD}"] [data-testid="catalogue-note-rules"]`);
  await expect(notes).toContainText('Payment note');
  await expect(notes).toContainText('TEST: write only the order number in the payment note.');
  await expect(notes.getByTestId('catalogue-note-forbidden')).toHaveText('Never write: USDT, crypto, P2P');
  // The TEST cash-in-person row: a locked price, the meeting and proof guidance, and its own release window.
  const cash = page.locator(`[data-testid="catalogue-method"][data-method="${CASH_METHOD}"] [data-testid="catalogue-cash-rules"]`);
  await expect(cash).toContainText('Cash in person');
  await expect(cash).toContainText('The price is locked: an ad with a floating price cannot offer this method.');
  await expect(cash).toContainText('Meeting: TEST: meet in a busy public place in daylight.');
  await expect(cash).toContainText('Proof: TEST: count the notes together before the seller releases.');
  await expect(cash.getByTestId('catalogue-cash-release')).toHaveText(
    'Once the buyer marks the order paid, the seller has 10 minutes to release.',
  );
  // A transfer method shows no cash rules.
  await expect(page.locator(`[data-testid="catalogue-method"][data-method="${METHOD}"] [data-testid="catalogue-cash-rules"]`)).toHaveCount(
    0,
  );
  // The locked price is the service's rule, not only the page's: a floating ad listing the cash method is refused by name.
  const s = await seller(state);
  const floating = await s.raw.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'float',
    price: '1.01',
    minAmount: AD.min,
    maxAmount: AD.max,
    totalAmount: '100',
    methods: [METHOD, CASH_METHOD],
    terms: 'TEST terms: J-p2p-04 #1 floating cash ad',
    idempotencyKey: `${J}:float-cash:${state.seller.handle}`,
  });
  expect(refusalCode(floating)).toBe('p2p.floating_not_allowed_for_method');
});

test('J-p2p-04 #2 a holder name that is not the verified name is refused and nothing is stored; a badly formatted IBAN shows the format hint', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const state = journey();
  const s = await seller(state);
  const before = await s.query('instruments.list', { limit: 200 });
  // Straight to the service, confirmed with the passkey: someone else's name, then an IBAN in the wrong shape. Neither
  // stores anything.
  const mismatch = await s.raw.mutate('instruments.create', account(METHOD, 'TEST Somebody Else', { fiatCurrency: 'USD' }));
  expect(refusalCode(mismatch)).toBe('p2p.holder_name_mismatch');
  const badIban = await s.raw.mutate(
    'instruments.create',
    account(METHOD, holderOf(state.seller), {
      fiatCurrency: 'USD',
      details: { account_holder: holderOf(state.seller), iban: 'de89 3704' },
    }),
  );
  keepCounter(s);
  expect(refusalCode(badIban)).toBe('p2p.account_format_invalid');
  expect(badIban.body.error.data.p2pLimit).toEqual({ until: null, field: 'iban' });
  expect(await s.query('instruments.list', { limit: 200 })).toEqual(before);

  // In the app: the same two refusals, each on its field, and the saved list unchanged. Each save is confirmed with the
  // passkey, for exactly the details under review.
  const page = await sellerInApp(browser, run.read());
  await page.goto('/p2p/methods');
  const saved = page.getByTestId('saved-method');
  await expect(saved).toHaveCount(before.filter((row) => row.status === 'active').length);
  const form = await pickMethod(page, 'TEST bank transfer');
  await form.getByTestId('method-add-fiat').selectOption('USD');
  await expect(form.locator('[data-field="account_holder"]')).toContainText('Enter your name exactly as on your verified identity');
  await form.getByLabel('Account holder').fill('TEST Somebody Else');
  await form.getByLabel('IBAN').fill(TEST_IBAN);
  await form.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByTestId('method-add-review')).toContainText('TEST Somebody Else');
  await page.getByTestId('method-add-review').getByRole('button', { name: 'Use a passkey' }).click();
  await expect(form.locator('[data-field="account_holder"] [role="alert"]')).toHaveText(
    'The account holder must be you. The name you entered does not match your verified name, so nothing was saved.',
  );
  await form.getByLabel('Account holder').fill(holderOf(state.seller));
  await form.getByLabel('IBAN').fill('de89 3704');
  await form.getByRole('button', { name: 'Review' }).click();
  await page.getByTestId('method-add-review').getByRole('button', { name: 'Use a passkey' }).click();
  await expect(form.locator('[data-field="iban"] [role="alert"]')).toHaveText(
    'This is not in the format the method needs: Two capital letters, two digits, then 11 to 30 capital letters or digits, with no spaces',
  );
  await expect(saved).toHaveCount(before.filter((row) => row.status === 'active').length);
  expect(await s.query('instruments.list', { limit: 200 })).toEqual(before);
});

test('J-p2p-04 #3 saving a payment method asks for a step-up and shows it masked; with the key service off the owner notice shows', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const state = journey();
  // Straight to the service from a new session with no confirmation: refused by name, nothing stored.
  const s = p2p(await api(state.seller));
  const before = await s.query('instruments.list', { limit: 200 });
  const bare = await s.bare.mutate('instruments.create', account(METHOD, holderOf(state.seller), { fiatCurrency: 'GBP' }));
  expect(bare.status).toBe(403);
  expect(refusalCode(bare)).toBe('auth.step_up_required');
  expect(await s.query('instruments.list', { limit: 200 })).toEqual(before);

  // In the app: the review asks the seller to confirm it's them; the passkey saves the method.
  const page = await sellerInApp(browser, state);
  await page.goto('/p2p/methods');
  const saved = page.getByTestId('saved-method');
  await expect(saved).toHaveCount(before.length);
  const form = await pickMethod(page, 'TEST bank transfer');
  await form.getByTestId('method-add-fiat').selectOption('GBP');
  await form.getByLabel('Account holder').fill(holderOf(state.seller));
  await form.getByLabel('IBAN').fill(TEST_IBAN);
  await form.getByLabel('Your name for it (optional)').fill('TEST pounds account');
  await form.getByRole('button', { name: 'Review' }).click();
  const review = page.getByTestId('method-add-review');
  // No way to save but confirming: the passkey or code approves exactly these details.
  await expect(review.getByTestId('step-up-confirm')).toBeVisible();
  await review.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(form.getByTestId('method-add-saved')).toBeVisible();
  await expect(saved).toHaveCount(before.length + 1);

  // Shown masked by the service: the holder whole, the IBAN by its last four only, read through the logged read.
  const row = saved.filter({ hasText: 'TEST pounds account' });
  await row.getByTestId('saved-method-show').click();
  const details = row.getByTestId('saved-method-details');
  await expect(details.locator('[data-field="account_holder"]')).toHaveText(holderOf(state.seller));
  await expect(details.locator('[data-field="iban"]')).toHaveText(`•••• ${TEST_IBAN.slice(-4)}`);
  await expect(details).not.toContainText(TEST_IBAN);
  const [pounds] = (await s.query('instruments.list', { limit: 200 })).filter((r) => r.label === 'TEST pounds account');
  const log = await s.query('instruments.accessLog', { limit: 50 });
  expect(log.some((entry) => entry.instrumentId === pounds.id && entry.viewerRole === 'owner' && entry.outcome === 'revealed')).toBe(true);

  // With the owner's key service off, the owner-decision notice shows and the form stays shut.
  await page.route('**/api/p2p/trpc/health*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.result.data.instrumentKeyProvider = 'none';
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(page.getByTestId('methods-key-off')).toContainText('the owner has not switched one on');
  await expect(page.getByTestId('method-add-form').getByTestId('method-add-country')).toBeDisabled();
});

test('J-p2p-04 #4 removing a method an ad uses lists the ads first; confirming pauses them and tells me; re-adding it and resuming works', async ({
  browser,
  page: signUpPage,
}) => {
  test.setTimeout(240_000);
  // Its own TEST seller with one euro account and one ad paid by it: every payment-method change asks identity for a
  // confirmation, and identity allows eight a person in ten minutes, which #1 to #3 have already spent on theirs.
  const who = await signUp(signUpPage, 'p2p04r');
  await verify(signUpPage, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  const s = p2p(await api(who));
  const bank = await testInstrument(s, who);
  const ad = await s.mutate('offers.create', {
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
    idempotencyKey: `${J}:offer:${who.handle}`,
  });
  run.write({ remover: who, removerPasskey: s.passkey().saved() });

  // Straight to the service, confirmed but without saying yes to pausing: refused by name, and nothing changes.
  const refused = await s.raw.mutate('instruments.remove', { instrumentId: bank.id });
  run.write({ removerPasskey: s.passkey().saved() });
  expect(refusalCode(refused)).toBe('p2p.method_in_use');
  expect((await s.query('offers.get', { offerId: ad.id })).status).toBe('active');

  // In the app: the review lists the ad and says it pauses; the passkey confirms; the method goes and the ad pauses.
  const page = await sellerInApp(browser, run.read(), 'remover');
  await page.goto('/p2p/methods');
  await page
    .locator(`[data-testid="saved-method"][data-instrument-id="${bank.id}"]`)
    .getByRole('button', { name: 'Remove destination' })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('method-remove-impact').locator(`[data-offer-id="${ad.id}"]`)).toHaveAttribute('data-pauses', 'true');
  await expect(dialog.getByTestId('method-remove-warning')).toContainText('Removing this method pauses 1 of your ads');
  await dialog.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(dialog.getByTestId('method-remove-confirmed')).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove destination' }).click();
  await expect(page.locator(`[data-testid="saved-method"][data-instrument-id="${bank.id}"]`)).toHaveCount(0);
  expect(await s.query('offers.get', { offerId: ad.id })).toMatchObject({ status: 'paused', pauseReason: 'method_removed' });

  // My offers lists it under paused, with why and the way back; resuming before a method is back is refused.
  await page.goto('/uc/ad');
  const row = page.getByTestId('paused-offers').locator(`[data-offer-id="${ad.id}"]`);
  await expect(row).toHaveAttribute('data-pause-reason', 'method_removed');
  await expect(row.getByTestId('pause-reason')).toContainText('you removed the last payment method it could be paid with');
  expect(refusalCode(await s.raw.mutate('offers.resume', { offerId: ad.id }))).toBe('p2p.offer_method_no_destination');

  // Re-add a euro account in the app, confirmed with the passkey, then resume the ad from My offers.
  await page.goto('/p2p/methods');
  const form = await pickMethod(page, 'TEST bank transfer');
  await form.getByLabel('Account holder').fill(holderOf(who));
  await form.getByLabel('IBAN').fill(TEST_IBAN);
  await form.getByLabel('Your name for it (optional)').fill('TEST euro account again');
  await form.getByRole('button', { name: 'Review' }).click();
  await page.getByTestId('method-add-review').getByRole('button', { name: 'Use a passkey' }).click();
  await expect(form.getByTestId('method-add-saved')).toBeVisible();
  await page.goto('/uc/ad');
  await page
    .getByTestId('paused-offers')
    .locator(`[data-offer-id="${ad.id}"]`)
    .getByRole('button', { name: 'Inspect current offer' })
    .click();
  await page.getByRole('button', { name: 'Resume offer' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Resume offer' }).click();
  await expect.poll(async () => (await s.query('offers.get', { offerId: ad.id })).status).toBe('active');
  expect((await s.query('offers.get', { offerId: ad.id })).pauseReason).toBeNull();
  await page.goto('/uc/ad');
  await expect(page.getByTestId('paused-offers').locator(`[data-offer-id="${ad.id}"]`)).toHaveCount(0);

  // The maker was told, once, in the inbox.
  const notices = async () => {
    const res = await s.session.get(`/api/notify/trpc/notify.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
    expect(res.status).toBe(200);
    return res.body.result.data.items.filter((n) => n.kind === 'p2p.offer.paused' && n.params?.instrumentId === bank.id);
  };
  await expect
    .poll(async () => (await notices()).length, {
      timeout: 30_000,
      message: 'svc-notify does not turn p2p.offer.paused into the maker’s notice yet (P-ads-merchant-18 notice slice)',
    })
    .toBe(1);
});

test('J-p2p-04 #5 reporting a sensitive remark in a payment note opens a case and tells the reported party', async ({ page }) => {
  test.setTimeout(120_000);
  const state = journey();
  // The open order from #1: the buyer pays by this journey's TEST transfer and the seller quotes what the note said.
  await signIn(page, state.seller);
  await page.goto(`/p2p/orders/${state.tradeId}`);
  const report = page.getByTestId('order-remark-report');
  await expect(report).toBeVisible();
  await report.locator('summary').click();
  const quote = 'TEST: USDT for P2P order';
  await report.getByLabel('The remark, as written').fill(quote);
  await report.getByRole('button', { name: 'Report the remark' }).click();
  const opened = page.getByTestId('order-remark-case');
  await expect(opened).toContainText('A case is open for staff to decide.');
  const caseId = await opened.getAttribute('data-case-id');
  expect(caseId).toMatch(/^[0-9a-f-]{36}$/);

  // A second report on the same order is refused by name; the same report again answers the same case.
  const s = await seller(state);
  expect(
    refusalCode(await s.raw.mutate('trades.reportSensitiveRemark', { caseId: randomUUID(), tradeId: state.tradeId, remark: 'again' })),
  ).toBe('p2p.remark_case_exists');
  expect(await s.mutate('trades.reportSensitiveRemark', { caseId, tradeId: state.tradeId, remark: quote })).toMatchObject({
    id: caseId,
    reporterRole: 'seller',
    status: 'open',
  });
  run.write({ remarkCaseId: caseId });
});
