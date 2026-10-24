import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { api, fund, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import {
  METHOD,
  TEST_IBAN,
  holderOf,
  p2p,
  readyTaker,
  refusalCode,
  registerTestMethod,
  retireTestMethod,
  testInstrument,
  verifiedName,
} from './p2p.mjs';

// J-p2p-04, in the running app (docs/roadmap/journeys.json): I add and manage the payment methods I get paid with. One
// test per step part, titled "J-p2p-04 #<n>", run in order on one verified TEST seller whose TEST legal name the founder
// pair recorded (the own-name rule compares against it). The shared TEST bank transfer (`local-test-gates.mjs p2p`)
// asks for an account holder in the person's own name and an IBAN with a format hint.
const J = 'J-p2p-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** This journey's own TEST method, which step 1 retires; no other journey pays with it. */
const J04_METHOD = 'test-j04-transfer';
const J04_LABEL = 'TEST J-p2p-04 transfer';
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

const seller = async (state) => p2p(await api(state.seller));

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
  await form.getByLabel('Country of the account').fill('DE');
  await form.getByLabel('Payment method').selectOption({ label });
  await form.getByLabel('Currency you receive').selectOption('EUR');
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
  run.reset({ seller: who, sellerId: me.body.result.data.userId, offerId: offer.id, tradeId: trade.id });

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
  await form.getByLabel('Country of the account').fill('DE');
  await expect(form.getByLabel('Payment method').locator('option', { hasText: 'TEST bank transfer' }).first()).toBeAttached();
  await expect(form.getByLabel('Payment method').locator('option', { hasText: J04_LABEL })).toHaveCount(0);
  const refused = await s.bare.mutate('instruments.create', account(J04_METHOD, holderOf(who), { fiatCurrency: 'USD' }));
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
  // The remittance note rules the method row carries, shown beside it (P-ads-merchant-19).
  await expect(
    page.locator(`[data-testid="catalogue-method"][data-method="${METHOD}"] [data-testid="catalogue-note-rules"]`),
    'the catalogue shows no payment-note rules yet (P-ads-merchant-19 catalogue rules slice)',
  ).toBeVisible(UNBUILT);
});

test('J-p2p-04 #2 a holder name that is not the verified name is refused and nothing is stored; a badly formatted IBAN shows the format hint', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const state = journey();
  const s = await seller(state);
  const before = await s.query('instruments.list', { limit: 200 });
  // Straight to the service: someone else's name, then an IBAN in the wrong shape. Neither stores anything.
  const mismatch = await s.bare.mutate('instruments.create', account(METHOD, 'TEST Somebody Else', { fiatCurrency: 'USD' }));
  expect(refusalCode(mismatch)).toBe('p2p.holder_name_mismatch');
  const badIban = await s.bare.mutate(
    'instruments.create',
    account(METHOD, holderOf(state.seller), {
      fiatCurrency: 'USD',
      details: { account_holder: holderOf(state.seller), iban: 'de89 3704' },
    }),
  );
  expect(refusalCode(badIban)).toBe('p2p.account_format_invalid');
  expect(badIban.body.error.data.p2pLimit).toEqual({ until: null, field: 'iban' });
  expect(await s.query('instruments.list', { limit: 200 })).toEqual(before);

  // In the app: the same two refusals, each on its field, and the saved list unchanged.
  await signIn(page, state.seller);
  await page.goto('/p2p/methods');
  const saved = page.getByTestId('saved-method');
  await expect(saved).toHaveCount(before.filter((row) => row.status === 'active').length);
  const form = await pickMethod(page, 'TEST bank transfer');
  await form.getByLabel('Currency you receive').selectOption('USD');
  await expect(form.locator('[data-field="account_holder"]')).toContainText('Enter your name exactly as on your verified identity');
  await form.getByLabel('Account holder').fill('TEST Somebody Else');
  await form.getByLabel('IBAN').fill(TEST_IBAN);
  await form.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByTestId('method-add-review')).toContainText('TEST Somebody Else');
  await page.getByTestId('method-add-confirm').click();
  await expect(form.locator('[data-field="account_holder"] [role="alert"]')).toHaveText(
    'The account holder must be you. The name you entered does not match your verified name, so nothing was saved.',
  );
  await form.getByLabel('Account holder').fill(holderOf(state.seller));
  await form.getByLabel('IBAN').fill('de89 3704');
  await form.getByRole('button', { name: 'Review' }).click();
  await page.getByTestId('method-add-confirm').click();
  await expect(form.locator('[data-field="iban"] [role="alert"]')).toHaveText(
    'This is not in the format the method needs: Two capital letters, two digits, then 11 to 30 capital letters or digits, with no spaces',
  );
  await expect(saved).toHaveCount(before.filter((row) => row.status === 'active').length);
  expect(await s.query('instruments.list', { limit: 200 })).toEqual(before);
});

test('J-p2p-04 #3 saving a payment method asks for a step-up and shows it masked', async () => {
  const state = journey();
  const s = await seller(state);
  const res = await s.bare.mutate('instruments.create', account(METHOD, holderOf(state.seller), { fiatCurrency: 'GBP' }));
  expect(refusalCode(res), 'saving a payment method asks for no step-up yet (P-ads-merchant-18 step-up slice)').toBe(
    'auth.step_up_required',
  );
});

test('J-p2p-04 #4 removing a method an ad uses lists the ads first; confirming pauses them and tells me', async () => {
  const state = journey();
  const s = await seller(state);
  const [bank] = (await s.query('instruments.list', { limit: 200 })).filter((row) => row.methodId === METHOD && row.status === 'active');
  const res = await s.bare.mutate('instruments.remove', { instrumentId: bank.id });
  expect(refusalCode(res), 'removing a method an ad uses refuses with no list of ads yet (P-ads-merchant-18 removal slice)').toBe(
    'p2p.method_in_use',
  );
});

test('J-p2p-04 #5 reporting a sensitive remark in a payment note opens a case and tells the reported party', async () => {
  const state = journey();
  const s = await seller(state);
  const res = await s.bare.mutate('trades.reportSensitiveRemark', { tradeId: state.tradeId, reason: 'TEST sensitive remark' });
  expect(res.status, 'svc-p2p has no sensitive-remark report yet (P-ads-merchant-19 report slice)').toBe(200);
});
