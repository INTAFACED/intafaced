// World: book, restart
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, api, fromUnits, fund, journeyState, json, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { CHAIN_ID, TOKEN_USD, fundOnTestChain, testChain } from './dex.mjs';
import { installTestWallet, TEST_WALLET, testWalletKey } from './test-wallet.mjs';
import { otherTraderKey, otherTraderRun, testDeposit, testVenue, venueRecord } from './venue.mjs';
import { GATE_URL } from '../../../../tooling/scripts/local-test-facts.mjs';
import { TEST_VENUE_DEPOSIT_ADDRESS } from '../../../../tooling/scripts/local-test-venue.mjs';

// J-bank-13, in the running app (docs/roadmap/journeys.json): I get a card. One TEST account, signed up in Germany,
// verified and funded with TEST 100 USDT, starts on /bank/cards/new. The stack's card issuer is the simulator
// (`card-sim`, no issuer, no network): every card it makes is a labelled simulation record, never a live card. The
// stack publishes a TEST card programme in the bank profile (tooling/profiles/test-owner-values/bank.json): eligible
// countries, a TEST count limit of 3 virtual and 1 physical card, TEST cardholder terms, two TEST designs, two TEST
// delivery speeds. A card payment arrives through the bank's
// four-eyes ops doors that stand in for the issuer's webhook, approved by the stack's two TEST founders, as in
// J-bank-07. There is no printer and no courier on this stack (`hardware`): the stand-in printer's signed job door
// (`card-sim/shipment`), called here as a printer would, is the only thing that marks a card produced.
// Step 1 (BK-cissue-01): eligibility by country with its reason, the count limit and the terms. Step 2 (BK-cissue-02):
// a virtual card, then a single-use card that closes after its first capture. Steps 3 and 4 (BK-cissue-03): a physical
// card with a design and a speed, and its delivery address changed before print and refused once produced. Steps 5 and
// 6 (BK-cissue-04): activation with a fresh authenticator code (the owner's step-up rule on, for that restart), then a
// lost report that closes the card once, reverses its open hold once and leaves one new inactive card. Step 7
// (RC-bank-02, owner decision 2026-11-06: add cashback; launch money model, OWNER 226 and 288): the person's TEST
// partner switch `custody: 'off'` puts a USDC card's money at the TEST card partner, and each spend earns cashback at the
// rate of the person's rank card tier. svc-bank records it once per authorisation and announces it
// (bank.card_cashback.earned); this run's TEST card cashback programme (a campaign the two TEST founders make, which the
// person joins) owes it in USDC in svc-ledger from INTAFACED's own budget, and svc-campaigns' payer pays it to the
// wallet the person connected, from INTAFACED's TEST rewards wallet on the stack's TEST chain. That money is our own TEST
// builder fees, earned on a TEST trader's sells through our venue door (#7 restarts trade with `LOCAL_STACK_USER_VENUE=on`
// and the file puts it back off after), as J-campaigns-03 does. The simulator earns cashback only through the stack's
// TEST stand-in (BANK_CARD_SIM_CASHBACK=test, refused outside dev/test). Step 8 (NO-SLICE): with the TEST card partner's
// per-person switch saying it does not add cards to phone wallets, the panel reads "not offered by the partner" and an
// add is refused; with it offered, the #7 card goes into a phone wallet as the partner reports its token.
const J = 'J-bank-13';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ADDRESS = { name: 'Ada TEST', line1: '1 TEST Strasse', city: 'Berlin', postalCode: '10115', country: 'DE' };
const MOVED = { name: 'Ada TEST', line1: '9 TEST Allee', city: 'Hamburg', postalCode: '20095', country: 'DE' };

test.describe.configure({ mode: 'default' });

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

function person() {
  const { who } = run.read();
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** The next authenticator code, once #5 has set one up, keeping its step so no code is ever used twice. */
async function code() {
  const state = run.read();
  if (!state.secret) return undefined;
  const { totp } = await totpLib();
  const next = await nextCode(totp, state.secret, state.step);
  run.write({ step: next.step });
  return next.code;
}

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
const kept = new Map();
async function bank(who = person()) {
  const held = kept.get(who.email);
  if (held && Date.now() - held.at < 4 * 60_000) return held.client;
  const totpCode = await code();
  const { status, body: login } = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, ...(totpCode ? { totpCode } : {}) }),
  }).then(json);
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${status} ${JSON.stringify(login).slice(0, 300)}`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const answer = async (res) => {
    const body = await res.json();
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        code: body?.error?.data?.intafacedCode ?? body?.error?.data?.cause?.code ?? body?.error?.data?.code,
        body,
      };
    return { ok: true, data: body.result.data };
  };
  const client = {
    /** The session's access token, for the person's own calls to other services through Edge. */
    token,
    query: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, {
        headers,
      }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
    async usdt() {
      return this.holding('USDT');
    },
    async holding(asset) {
      const res = await fetch(`${EDGE}/api/v1/account/balance`, { headers }).then(json);
      if (res.status !== 200) throw new Error(`balance read refused: ${res.status}`);
      return res.body.balances[asset] ?? { free: '0', used: '0' };
    },
  };
  kept.set(who.email, { client, at: Date.now() });
  return client;
}

/** Signs the person in on the page; once #5 set up an authenticator, with a fresh code too. */
async function signInPerson(page) {
  const who = person();
  const totpCode = await code();
  if (!totpCode) return signIn(page, who);
  await page.goto('/login');
  await page.fill('input[name=totp]', totpCode);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

let gatesCtx;
async function founders() {
  gatesCtx ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { gates, ctx, sessions: await gates.approverSessions(ctx) };
  })();
  return gatesCtx;
}
/** One card-issuer event through the bank's ops door, approved by two founders as the simulator's stand-in requires. */
async function cardEvent(actionType, procedure, fields) {
  const { gates, ctx, sessions } = await founders();
  const approval = await gates.twoPerson(ctx, sessions, {
    actionType,
    targetService: 'svc-bank',
    targetId: actionType,
    expectedVersion: '1',
    payloadHash: gates.bankPayloadHash(actionType, fields),
    policyVersion: gates.MARKERS.policyVersion,
  });
  const res = await ctx.edge.mutate('bank', procedure, { ...fields, ...approval }, await sessions.a.treasuryToken());
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
}
const authorize = (cardId, amount) =>
  cardEvent('bank.card_authorize', 'ops.cardAuthorize', { cardId, authorizationRef: `jb13-${randomUUID()}`, amount });
const capture = (cardId, authorizationRef, amount) =>
  cardEvent('bank.card_capture', 'ops.cardCapture', { cardId, authorizationRef, amount });

/** The stand-in printer's signed call (no printer or courier on this stack), as a printer would make it. */
async function printer(cardId, state, carried = {}) {
  const { ctx } = await founders();
  const raw = JSON.stringify({ cardId, state, ...carried });
  const res = await fetch(`${ctx.url('bank')}/internal/jobs/card-sim/shipment`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}

async function cards() {
  const res = await (await bank()).query('cards.list', { limit: 50 });
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 300)).toBe(true);
  return res.data;
}
const cardOf = async (id) => (await cards()).find((card) => card.id === id);
/** The card's own panel on /bank/cards, by its four-digit tail. */
const panel = (page, card) => page.getByTestId(`card-${card.id}`);

/** The bank's step-up rule on the stack (BANK_STEP_UP_MONEY_OUT): `required` for #5's restart only. */
function stepUpRule(required) {
  const key = 'LOCAL_STACK_BANK_STEP_UP_MONEY_OUT';
  const before = process.env[key];
  if (required) process.env[key] = 'required';
  else delete process.env[key];
  try {
    tool('local-test-stack.mjs', 'restart', 'bank');
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
  kept.clear();
}

test(`${J} #1 opens Cards and the product list: eligibility by country with the reason, a country off the list refused bank.card_not_eligible, the count limit and the cardholder terms`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await signUp(page, 'jb13');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ who });

  await signInPerson(page);
  await page.goto('/bank/cards');
  await page.getByRole('link', { name: 'Get a card' }).first().click();
  await expect(page).toHaveURL(/\/bank\/cards\/new$/);
  await expect(page.getByRole('heading', { name: 'Get a card' })).toBeVisible();
  const products = page.getByTestId('card-products');
  // The programme says what it is: the simulator, so every card here is a simulation record and not a live card.
  await expect(page.getByTestId('card-programme')).toContainText('Simulation record');
  await expect(products.getByTestId('card-product-virtual')).toContainText('Virtual debit card');
  await expect(products.getByTestId('card-product-physical')).toContainText('Physical debit card');
  await expect(products).toContainText('TEST network');

  // Germany is on the owner's (TEST) list: both products can be ordered.
  const country = page.getByLabel('Country you live in');
  await country.selectOption('DE');
  const eligibility = page.getByTestId('card-eligibility');
  await expect(eligibility).toHaveAttribute('data-eligible', 'yes');
  await expect(eligibility).toContainText('Cards are offered in Germany');

  // The United States is not on it: the page names the reason and ordering is refused by name.
  await country.selectOption('US');
  await expect(eligibility).toHaveAttribute('data-eligible', 'no');
  await expect(eligibility).toContainText('Cards are not offered in United States');
  await expect(eligibility).toHaveAttribute('data-code', 'bank.card_not_eligible');
  await expect(page.getByRole('button', { name: 'Issue virtual card' })).toBeDisabled();
  const api = await bank();
  const refused = await api.mutate('cards.order', {
    cardId: randomUUID(),
    country: 'US',
    assetId: 'USDT',
    perAuthorizationLimit: '50',
    cardType: 'virtual',
    termsVersion: 'local-test-1',
  });
  expect(refused).toMatchObject({ ok: false, code: 'bank.card_not_eligible' });

  // The count limit: the owner's TEST cap for each kind of card, and how many this person holds now.
  const limits = page.getByTestId('card-count-limit');
  await expect(limits).toContainText('Virtual cards: 0 of 3 active');
  await expect(limits).toContainText('Physical cards: 0 of 1 active');

  // The cardholder terms: their version and text, accepted once; accepting again records nothing new.
  await country.selectOption('DE');
  const terms = page.getByTestId('card-terms');
  await expect(terms).toContainText('Version local-test-1');
  await expect(terms).toContainText('TEST cardholder terms');
  await expect(page.getByRole('button', { name: 'Issue virtual card' })).toBeDisabled();
  await terms.getByLabel('I accept the cardholder terms').check();
  await terms.getByRole('button', { name: 'Accept terms' }).click();
  await expect(terms).toContainText('You accepted version local-test-1');
  const catalogue = await api.query('cards.catalogue', { country: 'DE' });
  expect(catalogue.ok, JSON.stringify(catalogue.body ?? {}).slice(0, 300)).toBe(true);
  const consent = catalogue.data.terms.acceptance;
  expect(consent).toMatchObject({ version: 'local-test-1' });
  const again = await api.mutate('cards.acceptTerms', { termsVersion: 'local-test-1', textHash: catalogue.data.terms.textHash });
  expect(again.ok, JSON.stringify(again.body ?? {}).slice(0, 300)).toBe(true);
  expect(again.data.id).toBe(consent.id);
  run.write({ consent: consent.id });
});

test(`${J} #2 issues a virtual card, then a single-use card: both on the labelled simulation record, and the single-use card closes after its first capture so a second authorisation declines`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  if (!run.read().consent) throw new Error(`${J} #1 accepted no terms, so no card can be ordered`);
  await signInPerson(page);
  await page.goto('/bank/cards/new');
  await page.getByLabel('Country you live in').selectOption('DE');
  await expect(page.getByTestId('card-terms')).toContainText('You accepted version local-test-1');

  // A virtual card: it works at once, on the simulation record.
  await page.getByRole('radio', { name: 'Virtual card' }).check();
  await page.getByLabel('Limit per payment (USDT)').fill('50');
  await page.getByRole('button', { name: 'Issue virtual card' }).click();
  const result = page.getByTestId('card-order-result');
  await expect(result).toContainText('Virtual card issued');
  await expect(result).toContainText('Simulation record');
  const virtualId = await result.getAttribute('data-card-id');
  const virtual = await cardOf(virtualId);
  expect(virtual).toMatchObject({ cardType: 'virtual', status: 'active', simulated: true, issuer: 'card-sim', usesAllowed: null });

  // A single-use card.
  await page.getByRole('radio', { name: 'Virtual card' }).check();
  await page.getByLabel('Single-use: closes after its first payment').check();
  await page.getByLabel('Limit per payment (USDT)').fill('20');
  await page.getByRole('button', { name: 'Issue virtual card' }).click();
  await expect(result).toContainText('Single-use virtual card issued');
  const singleId = await result.getAttribute('data-card-id');
  expect(singleId).not.toBe(virtualId);
  expect(await cardOf(singleId)).toMatchObject({ status: 'active', simulated: true, usesAllowed: 1 });

  // Two authorisations in flight: only the first is approved, the second declines on the use limit.
  const first = await authorize(singleId, '5');
  expect(first).toMatchObject({ decision: 'approved', declineCode: null });
  const parallel = await authorize(singleId, '5');
  expect(parallel).toMatchObject({ decision: 'declined', declineCode: 'bank.card_use_limit_reached' });
  // The first capture clears, and the card closes itself.
  const authorizations = await (await bank()).query('cards.authorizations', { cardId: singleId, limit: 50 });
  const ref = authorizations.data.find((row) => row.id === first.authorizationId).authorizationRef;
  const captured = await capture(singleId, ref, '5');
  expect(captured).toMatchObject({ captured: '5' });
  expect((await cardOf(singleId)).status).toBe('closed');
  // A later authorisation declines.
  expect(await authorize(singleId, '1')).toMatchObject({ decision: 'declined', declineCode: 'bank.card_not_active' });

  // Cards lists both, each as a simulation record; the single-use card reads closed after its one payment.
  await page.goto('/bank/cards');
  const single = panel(page, { id: singleId });
  await expect(single).toContainText('Simulation record');
  await expect(single).toContainText('Single-use');
  await expect(single).toContainText('Closed');
  await expect(single).toContainText('1 of 1 payment used');
  await expect(panel(page, { id: virtualId })).toContainText('Active');
  run.write({ virtualId, singleId });
});

test(`${J} #3 orders a physical card with a design and a speed: design choice, delivery estimate and tracking, and the notice names hardware`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  if (!run.read().virtualId) throw new Error(`${J} #2 issued no card, so the terms were never shown accepted`);
  await signInPerson(page);
  await page.goto('/bank/cards/new');
  await page.getByLabel('Country you live in').selectOption('DE');
  await page.getByRole('radio', { name: 'Physical card' }).check();
  const designs = page.getByRole('radiogroup', { name: 'Card design' });
  await expect(designs.getByRole('radio')).toHaveCount(2);
  await designs.getByRole('radio', { name: 'TEST Night' }).check();
  const speeds = page.getByRole('radiogroup', { name: 'Delivery speed' });
  await expect(speeds).toContainText('Standard: about 7 days');
  await expect(speeds).toContainText('Express: about 2 days');
  await speeds.getByRole('radio', { name: /Express/ }).check();
  await page.getByLabel('Limit per payment (USDT)').fill('50');
  await page.getByLabel('Name on the card').fill(ADDRESS.name);
  await page.getByLabel('Address line 1').fill(ADDRESS.line1);
  await page.getByLabel('City', { exact: true }).fill(ADDRESS.city);
  await page.getByLabel('Postal code').fill(ADDRESS.postalCode);
  await page.getByLabel('Delivery country').selectOption(ADDRESS.country);
  const ordered = Date.now();
  await page.getByRole('button', { name: 'Order physical card' }).click();
  const result = page.getByTestId('card-order-result');
  await expect(result).toContainText('Physical card ordered');
  const physicalId = await result.getAttribute('data-card-id');
  const physical = await cardOf(physicalId);
  expect(physical).toMatchObject({ cardType: 'physical', status: 'inactive', designId: 'night', deliverySpeed: 'express' });

  // The card's delivery panel: design, speed, the estimate from the speed's TEST days, the state, and tracking that
  // names the missing printer and courier.
  await page.goto('/bank/cards');
  const delivery = panel(page, physical).getByTestId('card-delivery');
  await expect(delivery).toContainText('TEST Night');
  await expect(delivery).toContainText('Express');
  await expect(delivery).toContainText('Ordered');
  const estimate = new Date(ordered + 2 * 86_400_000);
  const expected = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(estimate);
  await expect(delivery.getByTestId('card-delivery-estimate')).toContainText(expected);
  // Tracking: the bank itself names what delivery cannot do here (no printer or courier: `hardware`), and the page
  // shows the bank's code, with no tracking number until a carrier gives one.
  const read = await (await bank()).query('cards.delivery', { cardId: physicalId });
  expect(read.ok, JSON.stringify(read.body ?? {}).slice(0, 300)).toBe(true);
  expect(read.data).toMatchObject({
    state: 'ordered',
    speed: 'express',
    designId: 'night',
    carrier: null,
    trackingRef: null,
    notConnected: 'hardware',
  });
  const tracking = delivery.getByTestId('card-tracking');
  await expect(tracking).toHaveAttribute('data-code', read.data.notConnected);
  await expect(tracking).toContainText('Tracking: No tracking number yet.');
  await expect(tracking).toContainText('Printing and delivery need hardware. It is switched off in this build.');
  await expect(tracking.getByTestId('card-tracking-ref')).toHaveCount(0);
  run.write({ physicalId });
});

test(`${J} #4 changes the delivery address: allowed before print with the old address kept in history, refused once produced`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { physicalId } = run.read();
  if (!physicalId) throw new Error(`${J} #3 ordered no physical card, so there is no address to change`);
  await signInPerson(page);
  await page.goto('/bank/cards');
  const delivery = panel(page, { id: physicalId }).getByTestId('card-delivery');
  await delivery.getByRole('button', { name: 'Change delivery address' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change delivery address' });
  await dialog.getByLabel('Address line 1').fill(MOVED.line1);
  await dialog.getByLabel('City', { exact: true }).fill(MOVED.city);
  await dialog.getByLabel('Postal code').fill(MOVED.postalCode);
  await dialog.getByRole('button', { name: 'Save address' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(delivery.getByTestId('card-delivery-address')).toContainText(MOVED.line1);
  const history = delivery.getByTestId('card-address-history');
  await expect(history).toContainText(ADDRESS.line1);
  await expect(history).toContainText(ADDRESS.city);
  const read = await (await bank()).query('cards.delivery', { cardId: physicalId });
  expect(read.data.address).toMatchObject({ line1: MOVED.line1, city: MOVED.city });
  expect(read.data.history.map((row) => row.address.line1)).toEqual([ADDRESS.line1]);

  // The stand-in printer produces it; from then the address is locked and the refusal is named.
  await printer(physicalId, 'produced');
  await page.reload();
  await expect(delivery).toContainText('Produced');
  await delivery.getByRole('button', { name: 'Change delivery address' }).click();
  await dialog.getByLabel('Address line 1').fill('5 TEST Weg');
  await dialog.getByRole('button', { name: 'Save address' }).click();
  await expect(dialog.getByRole('alert')).toContainText('This card is already printed, so its delivery address can no longer change.');
  await expect(dialog.getByRole('alert')).toHaveAttribute('data-code', 'bank.card_address_locked');
  const after = await (await bank()).query('cards.delivery', { cardId: physicalId });
  expect(after.data.address.line1).toBe(MOVED.line1);
  expect(after.data.history).toHaveLength(1);
  const retry = await (await bank()).mutate('cards.updateShipping', { cardId: physicalId, requestId: randomUUID(), address: ADDRESS });
  expect(retry).toMatchObject({ ok: false, code: 'bank.card_address_locked' });
  // It ships with a TEST carrier and tracking number (the stand-in printer's call, as a courier would make it), and the
  // card's tracking shows them from the bank; then it arrives.
  const trackingRef = `TEST-${J}-${physicalId.slice(0, 8)}`;
  await printer(physicalId, 'shipped', { carrier: 'TEST Post', trackingRef });
  await page.reload();
  await expect(delivery).toContainText('Shipped');
  await expect(delivery.getByTestId('card-tracking-ref')).toHaveText(`TEST Post: ${trackingRef}`);
  const shipped = await (await bank()).query('cards.delivery', { cardId: physicalId });
  expect(shipped.data).toMatchObject({ state: 'shipped', carrier: 'TEST Post', trackingRef, notConnected: 'hardware' });
  await printer(physicalId, 'delivered');
});

test(`${J} #5 activates the card on arrival with step-up`, async ({ page }) => {
  test.setTimeout(420_000);
  const { physicalId } = run.read();
  if (!physicalId) throw new Error(`${J} #3 ordered no physical card, so there is nothing to activate`);
  // Before activation the card declines by name.
  expect(await authorize(physicalId, '1')).toMatchObject({ decision: 'declined', declineCode: 'bank.card_not_active' });

  // The person sets up an authenticator, and the owner's step-up rule is on for this restart.
  await signInPerson(page);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.write({ secret, step });
  stepUpRule(true);
  try {
    // Without a fresh confirmation the bank refuses and nothing changes.
    const bare = await (await bank()).mutate('cards.activate', { cardId: physicalId });
    expect(bare).toMatchObject({ ok: false, code: 'bank.step_up_required' });
    expect((await cardOf(physicalId)).status).toBe('inactive');

    await page.goto('/bank/cards');
    const card = panel(page, { id: physicalId });
    await expect(card).toContainText('Not activated');
    await card.getByRole('button', { name: 'Activate card' }).click();
    const dialog = page.getByRole('dialog', { name: 'Activate card' });
    await expect(dialog).toContainText('Confirm it’s you');
    await dialog.getByLabel('Authenticator code').fill(await code());
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toContainText('Active');
    expect((await cardOf(physicalId)).status).toBe('active');
  } finally {
    stepUpRule(false);
  }
  // Active, it now authorises.
  const paid = await authorize(physicalId, '1');
  expect(paid).toMatchObject({ decision: 'approved', declineCode: null });
});

test(`${J} #6 reports it lost or stolen: the old card closes once, a new inactive card exists, its hold is reversed, and retrying changes nothing`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { physicalId } = run.read();
  if (!physicalId) throw new Error(`${J} #3 ordered no physical card, so there is nothing to report`);
  const api = await bank();
  // An open TEST hold of 3 USDT on the card.
  const before = await api.usdt();
  const hold = await authorize(physicalId, '3');
  expect(hold).toMatchObject({ decision: 'approved' });
  const holding = await api.usdt();
  expect(toUnits(before.free) - toUnits(holding.free)).toBe(toUnits('3'));
  const countBefore = (await cards()).length;
  // Every hold still open on the card when it is reported: this 3 USDT, and #5's approved 1 USDT, never captured. The
  // report reverses each one (BK-cissue-04: "open holds follow the existing reverse path").
  const auths = await api.query('cards.authorizations', { cardId: physicalId, limit: 50 });
  expect(auths.ok, JSON.stringify(auths.body ?? {}).slice(0, 300)).toBe(true);
  // Nothing is ever captured on this physical card in this journey, so every approved authorisation still holds funds.
  const open = auths.data.filter((row) => row.decision === 'approved');
  expect(open.map((row) => row.amount).sort()).toEqual(['1', '3']);
  const openTotal = open.reduce((sum, row) => sum + toUnits(row.amount), 0n);
  const afterReport = fromUnits(toUnits(holding.free) + openTotal);

  await signInPerson(page);
  await page.goto('/bank/cards');
  const card = panel(page, { id: physicalId });
  await card.getByRole('button', { name: 'Report lost or stolen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Report lost or stolen' });
  await dialog.getByRole('radio', { name: 'Stolen' }).check();
  await dialog.getByRole('button', { name: 'Report and replace' }).click();
  const done = page.getByTestId('card-report-result');
  await expect(done).toContainText('Card closed. A replacement is on its way; activate it when it arrives.');
  const replacementId = await done.getAttribute('data-card-id');

  const old = await cardOf(physicalId);
  expect(old).toMatchObject({ status: 'closed', replacedByCardId: replacementId });
  const fresh = await cardOf(replacementId);
  expect(fresh).toMatchObject({ status: 'inactive', cardType: 'physical', replacesCardId: physicalId });
  expect((await cards()).length).toBe(countBefore + 1);
  // Every open hold came back to the person's available balance, once.
  const released = await api.usdt();
  expect(released.free).toBe(afterReport);
  await expect(card).toContainText('Closed');
  await expect(panel(page, fresh)).toContainText('Not activated');

  // Retrying the same report returns the same replacement and moves nothing.
  const retry = await api.mutate('cards.replace', { cardId: physicalId, replacementId, reason: 'stolen' });
  expect(retry.ok, JSON.stringify(retry.body ?? {}).slice(0, 300)).toBe(true);
  expect(retry.data.id).toBe(replacementId);
  expect((await cards()).length).toBe(countBefore + 1);
  expect((await api.usdt()).free).toBe(afterReport);
  // The old card authorises nothing.
  expect(await authorize(physicalId, '1')).toMatchObject({ decision: 'declined', declineCode: 'bank.card_not_active' });
});

/** A fresh access token for the person (with an authenticator code once #5 set one up). */
async function accessToken(who = person()) {
  const totpCode = await code();
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, ...(totpCode ? { totpCode } : {}) }),
  }).then(json);
  const token = login.body?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${login.status} ${JSON.stringify(login.body).slice(0, 300)}`);
  return token;
}

/** The person's own rank, from svc-identity (the one rank book), never from the bank. */
async function rankOf(token) {
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const state = await fetch(`${EDGE}/api/identity/trpc/rank.get`, { headers }).then(json);
  const perks = await fetch(`${EDGE}/api/identity/trpc/rank.perks`, { headers }).then(json);
  expect(state.status, JSON.stringify(state.body).slice(0, 300)).toBe(200);
  expect(perks.status, JSON.stringify(perks.body).slice(0, 300)).toBe(200);
  return { ...state.body.result.data, cardTier: perks.body.result.data.cardTier };
}

/**
 * XP awarded through svc-identity's one award door (`rank.awardXp`, service-signed), as the modules that earn XP
 * (trading, P2P, the academy) call it. A TEST stand-in for a season of activity: one key per person and rank, so a
 * retry awards nothing more.
 */
async function awardXp(userId, xpDelta, rank) {
  const { ctx } = await founders();
  const raw = JSON.stringify({
    userId,
    sourceModule: 'local-test-stack',
    action: 'test.rank_up',
    xpDelta,
    idempotencyKey: `${J}:rank-up:${userId}:${rank}`,
  });
  const res = await fetch(`${ctx.url('identity')}/trpc/rank.awardXp`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

/** One TEST spend on the card, authorised then captured; returns the capture's cashback and the authorisation. */
async function spendOn(api, cardId, spend, beforeCapture = async () => {}) {
  const held = await authorize(cardId, spend);
  expect(held).toMatchObject({ decision: 'approved' });
  const rows = await api.query('cards.authorizations', { cardId, limit: 50 });
  const ref = rows.data.find((row) => row.id === held.authorizationId).authorizationRef;
  await beforeCapture(held);
  const captured = await capture(cardId, ref, spend);
  return { held, cashback: captured.cashback };
}

/** svc-ledger's own accounts under one address prefix, by account id, read as an operator (founder a, admin:treasury). */
async function ledgerAccounts(prefix) {
  const { ctx, sessions } = await founders();
  const res = await fetch(`${ctx.url('ledger')}/operator/accounts?prefix=${encodeURIComponent(prefix)}`, {
    headers: { authorization: `Bearer ${await sessions.a.treasuryToken()}` },
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  const page = JSON.parse(text);
  expect(page.nextCursor, `one page holds every account under ${prefix}`).toBeNull();
  return new Map(page.accounts.map((row) => [row.accountId, row]));
}

/** One booked transaction as svc-ledger itself holds it, read as an operator (founder a, admin:treasury). */
async function ledgerTx(txId) {
  const { ctx, sessions } = await founders();
  const res = await fetch(`${ctx.url('ledger')}/operator/transactions/${encodeURIComponent(txId)}`, {
    headers: { authorization: `Bearer ${await sessions.a.treasuryToken()}` },
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}

// ── #7: the cashback programme, our own money, the person's wallet ──────────────────────────────────────────────────

const USDC = 'USDC';
const reply = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/**
 * This run's TEST card cashback programme: a campaign whose one earning rule owes, for each `bank.card_cashback.earned`,
 * exactly the cashback the bank worked out (`formula: cashback`), in USDC, from a TEST budget. Founder A creates and asks,
 * founder B approves, A activates (the campaigns desk's two-person rule).
 */
async function liveCashbackProgramme() {
  const { ctx, sessions } = await founders();
  const a = await sessions.a.campaignsOpsToken();
  const b = await sessions.b.campaignsOpsToken();
  const name = `TEST card cashback ${Date.now().toString(36)}`;
  const definition = {
    name,
    type: 'task',
    rules: `TEST rules for ${name}: card spend the card partner holds earns cashback at your rank's card tier, owed by INTAFACED in TEST USDC and paid to your connected wallet.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: USDC, limit: '1' },
    // TEST limits (CM-eligibility-rules-03), wide enough that only a step about limits meets them.
    limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
    reward: { asset: USDC, amount: '1' },
    earning: [{ name: 'Card cashback', trigger: 'bank.card_cashback.earned', minAmount: null, formula: 'cashback' }],
  };
  const made = reply(await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition, a), 'ops.campaigns.create');
  reply(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'submit', revision: 1 }, a), 'submit');
  reply(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'approve', revision: 1 }, b), 'approve');
  const live = reply(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'activate', revision: 1 }, a),
    'activate',
  );
  expect(live.state).toBe('active');
  return live;
}

/** Founders A and B sweep `amount` of the builder fees the platform earned into the USDC reward pot, once svc-trade posted them. */
async function fundPotFromBuilderFees(amount) {
  const { ctx, sessions } = await founders();
  await expect
    .poll(
      async () => {
        const reference = `TEST-${J}-${Date.now().toString(36)}`;
        const a = await sessions.a.campaignsOpsToken();
        const b = await sessions.b.campaignsOpsToken();
        const asked = await ctx.edge.mutate('campaigns', 'ops.pot.request', { reference, sourceModule: 'builder', asset: USDC, amount }, a);
        if (asked.status !== 200) return asked.text.slice(0, 200);
        const funded = await ctx.edge.mutate('campaigns', 'ops.pot.approve', { reference }, b);
        return funded.json?.result?.data?.state ?? funded.text.slice(0, 200);
      },
      { timeout: 90_000, intervals: [5_000] },
    )
    .toBe('posted');
}

/** Restarts trade with the user-venue door on (it starts the TEST venue) or off, and puts this process's env back. */
function userVenue(on) {
  const before = process.env.LOCAL_STACK_USER_VENUE;
  if (on) process.env.LOCAL_STACK_USER_VENUE = 'on';
  else delete process.env.LOCAL_STACK_USER_VENUE;
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_USER_VENUE;
    else process.env.LOCAL_STACK_USER_VENUE = before;
  }
}
let doorTurnedOn = false;
test.afterAll(() => {
  if (doorTurnedOn) userVenue(false);
});

const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const traderKey = privateKeyToAccount(keccak256(toHex(`intafaced TEST venue journey trader ${J} ${RUN}`)));
const traderOwner = traderKey.address.toLowerCase();

/** One action through svc-trade's user-venue door as the TEST trader account: prepare, sign with its key, submit. */
async function door(session, intent, actionKey) {
  const signer = { role: 'owner', address: traderOwner };
  const prepared = await session.post('/api/v1/venue/prepare', { owner: traderOwner, signer, intent, ...(actionKey ? { actionKey } : {}) });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  const p = prepared.body.prepared;
  const t = p.typedData;
  const signature = await traderKey.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await session.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: p.digest, signature, signedBy: traderOwner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
  return sent.body;
}

/**
 * INTAFACED's own TEST money for the cashback: builder fees the TEST venue credits us on a TEST trader's sells through our
 * venue door (seven sells of 0.5 BTC at the stack's TEST 0.5 bps, about 10.5 TEST USDC, as J-campaigns-03 earns them).
 * Returns the builder address the venue credits.
 */
async function earnBuilderFees(session) {
  const sells = 7;
  const size = 0.5;
  const since = new Date(Date.now() - 1000);
  const account = { venueId: (await testVenue('/venue')).body.venue.id, owner: traderOwner, subAccount: null };
  for (const [asset, amount] of [
    [USDC, '10000'],
    ['BTC', String(size * sells + 0.5)],
  ]) {
    const ref = `84532:${keccak256(toHex(`${J} ${RUN} ${traderOwner} ${asset}`))}:0`;
    const funded = await testVenue('/test/deposit', { account, asset, amount, depositRef: ref });
    expect(funded.status, JSON.stringify(funded.body)).toBe(200);
  }
  const status = (await session.get('/api/v1/venue/status')).body;
  expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
  const markets = await testVenue('/markets', { account: null });
  const cap = markets.body.value.find((m) => m.symbol === 'BTC-USDC').builderFeeCapBps.value;
  await door(
    session,
    { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: cap },
    `approve-builder:${traderOwner}:${J}`,
  );
  const buyer = `${J}-buyer-${RUN}`;
  await testDeposit(otherTraderKey(buyer).address, USDC, '400000', `seed:${buyer}:USDC`);
  const bidKey = `order:${buyer}:bid:${Date.now()}`;
  const bid = await otherTraderRun(buyer, {
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: String(size * sells),
    price: '59990',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: bidKey,
    builderFee: null,
  });
  expect(bid, JSON.stringify(bid).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  // The TEST maker's own bid at this price sits ahead of the buyer's in time, so the sells fill it first and part of the
  // buyer's bid is left resting above the maker's next level. It is cancelled once the sells are done, so no later file
  // on this stack meets a TEST bid it did not place (#8546: J-cex-spot-02 #7's sell filled at once against the remainder).
  try {
    for (let i = 0; i < sells; i += 1) {
      await door(session, {
        kind: 'place_order',
        symbol: 'BTC-USDC',
        side: 'sell',
        type: 'limit',
        amount: String(size),
        price: '59990',
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: `order:${J}:${RUN}:${Date.now()}:${i}`,
        builderFee: null,
      });
    }
    await expect
      .poll(
        async () => {
          const body = await venueRecord(traderOwner, '/fills', { since: since.toISOString() });
          return body.value.filter((f) => f.feeAsset === USDC && !/^0(\.0+)?$/.test(f.builderFee)).length;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(sells);
  } finally {
    const left = (await venueRecord(otherTraderKey(buyer).address, '/open-orders')).value.filter((o) => o.symbol === 'BTC-USDC');
    if (left.length) await otherTraderRun(buyer, { kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey: bidKey });
  }
  // Nothing of the buyer's rests on BTC-USDC now, as the venue's own record says.
  expect((await venueRecord(otherTraderKey(buyer).address, '/open-orders')).value.filter((o) => o.symbol === 'BTC-USDC')).toEqual([]);
  return status.builder.address;
}

/** TEST USD (base units) `address` holds on the TEST chain, read from the node itself. */
async function chainUsd(address) {
  const res = await fetch(GATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: TOKEN_USD.address, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest'],
    }),
  });
  return BigInt((await res.json()).result);
}

/** Mines `n` empty blocks on the stack's TEST chain (`evm_mine`, the TEST chain's own control). */
async function mineBlocks(n) {
  for (let i = 0; i < n; i += 1) {
    const res = await fetch(testChain().gateUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`evm_mine: ${JSON.stringify(body.error)}`);
  }
}

/**
 * Pays INTAFACED's TEST rewards wallet from our own TEST builder fees, as the launch money model moves them: the TEST
 * trader sends 20 TEST USD to the TEST venue's deposit address on the chain (so the venue holds tokens to pay a withdrawal
 * from), then the TEST venue records a claim of our unclaimed builder fees (its TEST claim control). svc-trade books it
 * collected and sweeps what is above the TEST float to the rewards wallet; nothing here moves our money itself.
 */
async function claimOurBuilderFees(builder) {
  fundOnTestChain(traderOwner, 'venue');
  const { createWalletClient, encodeFunctionData, http, parseAbiItem } = await import('viem');
  const chain = {
    id: CHAIN_ID,
    name: 'TEST chain',
    nativeCurrency: { name: 'TEST ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [GATE_URL] } },
  };
  const before = await chainUsd(TEST_VENUE_DEPOSIT_ADDRESS);
  const wallet = createWalletClient({ account: traderKey, chain, transport: http(GATE_URL) });
  await wallet.sendTransaction({
    to: TOKEN_USD.address,
    data: encodeFunctionData({
      abi: [parseAbiItem('function transfer(address to, uint256 value) returns (bool)')],
      functionName: 'transfer',
      args: [TEST_VENUE_DEPOSIT_ADDRESS, 20_000_000n],
    }),
  });
  await mineBlocks(4);
  expect(await chainUsd(TEST_VENUE_DEPOSIT_ADDRESS)).toBe(before + 20_000_000n);
  const claimed = await testVenue('/test/builder-claim', { builder });
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** The TEST chain's own receipt of `txHash`: the token transfers it made, as { token, to, value } (read from the chain). */
async function chainTransfers(txHash) {
  const res = await fetch(GATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
  });
  const receipt = (await res.json()).result;
  expect(receipt, `the TEST chain has a receipt for ${txHash}`).toBeTruthy();
  expect(receipt.status).toBe('0x1');
  return receipt.logs
    .filter((l) => l.topics[0] === TRANSFER_TOPIC)
    .map((l) => ({ token: l.address.toLowerCase(), to: `0x${l.topics[2].slice(26)}`, value: BigInt(l.data) }));
}

/** A decimal TEST USD amount in the token's base units (6 decimals), exactly. */
const usdUnits = (amount) => {
  const [w, f = ''] = amount.split('.');
  return BigInt(w + f.padEnd(TOKEN_USD.decimals, '0'));
};

/** The person's own campaigns API through Edge, on the bank client's session. */
async function campaignsAs(api, procedure, input) {
  const res = await fetch(
    `${EDGE}/api/campaigns/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
    { headers: { origin: ORIGIN, authorization: `Bearer ${api.token}` } },
  ).then(json);
  if (!res.body?.result) throw new Error(`${procedure} refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

/** The person's reward for one card authorisation's cashback, as My rewards lists it (the earning key ends with it). */
async function cashbackReward(api, authorizationId) {
  const mine = await campaignsAs(api, 'rewards.mine', {});
  return mine.rewards.find((r) => r.rewardKey.endsWith(`:${authorizationId}`)) ?? null;
}

test(`${J} #7 sees cashback in USDC on card spend with the rank-linked tier: recorded in the ledger as owed by INTAFACED and paid to the person's own wallet, never spendable before it is paid`, async ({
  page,
  browser,
}) => {
  test.setTimeout(900_000);
  const who = person();
  const spend = '4';
  const earnedAt = (bps) => (toUnits(spend) * BigInt(bps)) / 10_000n;

  // INTAFACED's own TEST money first: a TEST trader's sells through our venue door earn us builder fees; the founders sweep
  // some into the USDC reward pot, and our claimed fees reach our TEST rewards wallet on the chain.
  const traderPage = await (await browser.newContext()).newPage();
  const trader = await signUp(traderPage, 'jb13trader');
  await verify(traderPage, trader);
  const traderSession = await api(trader);
  if (!(await traderSession.get('/api/v1/venue/status')).body?.deposit) {
    userVenue(true);
    doorTurnedOn = true;
  }
  const builder = await earnBuilderFees(await api(trader));
  await claimOurBuilderFees(builder);
  await fundPotFromBuilderFees('0.5');
  const programme = await liveCashbackProgramme();

  // The person's card money is the card partner's (TEST partner switch `custody: 'off'`): nothing of theirs is in our book.
  const switched = await (await bank(who)).mutate('testPartner.set', { custody: 'off', cardDecline: 'none' });
  expect(switched, JSON.stringify(switched.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { custody: 'off' } });
  const joined = await fetch(`${EDGE}/api/campaigns/trpc/participation.join`, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: `Bearer ${(await bank(who)).token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ campaignId: programme.id }),
  }).then(json);
  expect(joined.body?.result?.data?.participation, JSON.stringify(joined.body).slice(0, 300)).toBeTruthy();

  // The person connects their own TEST wallet (svc-protocol's record), the wallet INTAFACED pays cashback to.
  const walletKey = testWalletKey();
  const walletAddress = privateKeyToAccount(walletKey).address.toLowerCase();
  await installTestWallet(page, { chainId: CHAIN_ID, privateKey: walletKey });
  await signInPerson(page);
  await page.goto('/wallet');
  await page.getByRole('button', { name: 'Venue account', exact: true }).click();
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  await page.getByRole('button', { name: 'Connect to my account' }).click();
  await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible();
  const walletBefore = await chainUsd(walletAddress);

  // The tier the bank earns at is the one the person's rank gives in svc-identity, read there, not from the bank.
  const token = await accessToken(who);
  const start = await rankOf(token);
  const before = await (await bank(who)).query('cards.cashback');
  expect(before.ok, JSON.stringify(before.body ?? {}).slice(0, 300)).toBe(true);
  expect(before.data).toMatchObject({ assetId: USDC, paying: true, simulated: true, tier: start.cardTier, toWallet: '0' });
  const rateOf = (tier) => before.data.rates.find((r) => r.tier === tier)?.bps ?? null;
  const firstBps = before.data.rateBps;
  expect(firstBps, `a TEST rate for tier ${start.cardTier}`).not.toBeNull();
  expect(firstBps).toBe(rateOf(start.cardTier));
  const first = earnedAt(firstBps);

  // A virtual card in USDC, which the TEST card partner holds for this person (its TEST USDC spendable, never our book's):
  // issued through the person's own card door, as J-bank-14 #6 does, since the card room's funding list names only what
  // INTAFACED's book holds for them.
  const issued = await (await bank(who)).mutate('cards.issue', { cardId: randomUUID(), assetId: USDC, perAuthorizationLimit: '20' });
  expect(issued.ok, JSON.stringify(issued.body ?? {}).slice(0, 300)).toBe(true);
  const cardId = issued.data.id;
  expect(await cardOf(cardId)).toMatchObject({ assetId: USDC, status: 'active' });
  run.write({ cashbackCardId: cardId });

  // Our book's USDC for the person stays exactly as it was through every spend and every cashback: nothing is credited.
  const ledgerUsdc = await (await bank(who)).holding(USDC);
  const partnerAvailable = async () => (await (await bank(who)).query('cards.partnerHeld', { cardId, limit: 50 })).data.figures.available;
  const partnerStart = toUnits(await partnerAvailable());

  /** One spend at the current tier: owed once by INTAFACED, never spendable, then paid once to the connected wallet. */
  async function spendAndPaid(expected, bps, tier) {
    const spent = await spendOn(await bank(who), cardId, spend);
    // The bank earned it at the tier's rate and handed it on; it holds none of it.
    expect(spent.cashback).toMatchObject({ status: 'owed', amount: fromUnits(expected) });
    const row = (await (await bank(who)).query('cards.cashback')).data.payments.find(
      (p) => p.authorizationId === spent.held.authorizationId,
    );
    expect(row).toMatchObject({ paidBy: 'wallet', announced: true, amount: fromUnits(expected), ledgerTxId: null });
    expect(await (await bank(who)).holding(USDC)).toEqual(ledgerUsdc);

    // svc-campaigns owes exactly that, once, under the authorisation's key; then pays it to the connected wallet.
    let reward = null;
    await expect
      .poll(
        async () => {
          reward = await cashbackReward(await bank(who), spent.held.authorizationId);
          return reward?.owed ? 'owed' : (reward?.state ?? 'none');
        },
        { timeout: 60_000 },
      )
      .toBe('owed');
    expect(reward).toMatchObject({ campaignId: programme.id, asset: USDC, amount: fromUnits(expected), form: 'paid' });
    // The owe in svc-ledger: our campaign budget to what we owe for this reward, both INTAFACED's own module accounts.
    const owe = await ledgerTx(reward.owed.txId);
    expect(owe).toMatchObject({ reason: 'campaigns.reward.owed' });
    expect(owe.postings).toHaveLength(2);
    const ours = await ledgerAccounts('module:campaigns:');
    const from = owe.postings.find((p) => p.side === 'source');
    const to = owe.postings.find((p) => p.side === 'destination');
    expect(from).toMatchObject({ assetId: USDC, amount: fromUnits(expected) });
    expect(to).toMatchObject({ assetId: USDC, amount: fromUnits(expected) });
    expect(ours.get(from.accountId)?.address).toBe(`module:campaigns:budget:${programme.id}`);
    expect(ours.get(to.accountId)?.address).toMatch(/^module:campaigns:owed:/);

    await expect
      .poll(
        async () => {
          reward = await cashbackReward(await bank(who), spent.held.authorizationId);
          return reward?.state;
        },
        { timeout: 180_000, intervals: [3_000] },
      )
      .toBe('paid');
    expect(reward.payout.toWallet.toLowerCase()).toBe(walletAddress);
    // The chain's own receipt: exactly the cashback in TEST USD, to the person's own wallet.
    expect(await chainTransfers(reward.payout.chainTx)).toEqual([
      { token: TOKEN_USD.address.toLowerCase(), to: walletAddress, value: usdUnits(fromUnits(expected)) },
    ]);
    // A capture replayed owes and pays nothing more.
    expect(
      (await campaignsAs(await bank(who), 'rewards.mine', {})).rewards.filter((r) =>
        r.rewardKey.endsWith(`:${spent.held.authorizationId}`),
      ),
    ).toHaveLength(1);
    expect(await (await bank(who)).holding(USDC)).toEqual(ledgerUsdc);
    return { spent, reward, tier, bps };
  }

  const one = await spendAndPaid(first, firstBps, start.cardTier);

  // The person's rank rises, one rank at a time by the XP identity says the next rank needs, until it gives the next card
  // tier on identity's ladder. That tier's TEST rate differs, so a bank that ignored rank would fail here.
  let risen = start;
  while (risen.cardTier === start.cardTier) {
    expect(risen.nextRankAt, `identity's ladder has a card tier above ${start.cardTier}`).not.toBeNull();
    await awardXp(start.userId, Number(risen.nextRankAt), risen.rank + 1);
    const next = await rankOf(token);
    expect(next.rank).toBeGreaterThan(risen.rank);
    risen = next;
  }
  const secondBps = rateOf(risen.cardTier);
  expect(secondBps, `a TEST rate for tier ${risen.cardTier}`).not.toBeNull();
  expect(secondBps).not.toBe(firstBps);
  const second = earnedAt(secondBps);
  expect(second).not.toBe(first);
  expect((await (await bank(who)).query('cards.cashback')).data).toMatchObject({ tier: risen.cardTier, rateBps: secondBps });

  const two = await spendAndPaid(second, secondBps, risen.cardTier);

  // The partner spent exactly the two spends; the wallet received exactly the two cashbacks; our book moved nothing of theirs.
  expect(partnerStart - toUnits(await partnerAvailable())).toBe(2n * toUnits(spend));
  expect((await chainUsd(walletAddress)) - walletBefore).toBe(usdUnits(fromUnits(first)) + usdUnits(fromUnits(second)));
  const after = await (await bank(who)).query('cards.cashback');
  expect(after.data).toMatchObject({ paid: '0', unpaid: '0', toWallet: fromUnits(first + second) });

  // The card page: the tier the rank now gives, its rate in USDC, the tier table, and the cashback owed to the wallet,
  // which is never shown as spendable.
  await page.goto('/bank/cards');
  const panelCashback = page.getByTestId('card-cashback');
  const tierName = { none: 'None', standard: 'Standard', metal: 'Metal', obsidian: 'Obsidian' }[risen.cardTier];
  await expect(panelCashback).toContainText(`Your rank’s card tier: ${tierName}`);
  await expect(panelCashback).toContainText(`${(secondBps / 100).toString()}% cashback in USDC on spend from your USDC card`);
  await expect(panelCashback.getByRole('table', { name: 'Cashback by card tier' }).getByRole('row')).toHaveCount(
    after.data.rates.length + 1,
  );
  const owedLine = panelCashback.getByTestId('card-cashback-wallet');
  await expect(owedLine).toHaveAttribute('data-owed', fromUnits(first + second));
  await expect(owedLine).toContainText('INTAFACED owes it to you and pays it to your own wallet. It is not spendable until it is paid.');
  await expect(panelCashback.getByTestId('card-cashback-paid')).toHaveAttribute('data-paid', '0');

  // My rewards: each cashback paid to the connected wallet, with its chain transaction.
  await owedLine.getByRole('link', { name: 'See each payment in My rewards' }).click();
  await expect(page).toHaveURL(/\/uc\/promotion$/);
  for (const paid of [one, two]) {
    const rowEl = page.locator(`[data-testid="reward-row"][data-reward-key="${paid.reward.rewardKey}"]`);
    await expect(rowEl).toHaveAttribute('data-state', 'paid');
    await expect(rowEl.getByTestId('reward-chain-tx')).toBeVisible();
  }
});

test(`${J} #8 adds the card to the phone's wallet: the card shows as added, as the partner reports it; or "not offered by the partner"`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { cashbackCardId: cardId } = run.read();
  if (!cardId) throw new Error(`${J} #7 issued no card, so there is nothing to add to a phone wallet`);
  expect((await cardOf(cardId)).status).toBe('active');
  const here = page.locator(`[data-card="${cardId}"]`);
  const wallets = here.getByRole('region', { name: 'Phone wallets', exact: true });
  // The card's own panels open from its row, as J-bank-14 opens them.
  const showCard = async () => {
    const inspect = page.getByRole('button', { name: `Inspect decisions for card ${cardId}` });
    const controls = here.getByRole('region', { name: 'Card controls', exact: true });
    await expect(controls.or(inspect)).toBeVisible();
    if (await inspect.isVisible()) await inspect.click();
    await expect(controls).toBeVisible();
  };

  // The TEST card partner does not add this person's cards to phone wallets (its per-person "not offered" switch): the
  // panel says it is not offered by the partner, nothing can be added, and the bank refuses an add by that name.
  const off = await (await bank()).mutate('testPartner.set', { notOffered: ['phone_wallet'] });
  expect(off, JSON.stringify(off.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { notOffered: ['phone_wallet'] } });
  try {
    await signInPerson(page);
    await page.goto('/bank/cards');
    await showCard();
    await expect(wallets.getByTestId('card-wallets')).toHaveAttribute('data-offered', 'not-by-partner');
    await expect(wallets).toContainText('Not offered by the partner: your card partner does not add cards to phone wallets.');
    await expect(wallets.getByRole('button', { name: 'Add to Google Wallet' })).toBeDisabled();
    const refused = await (
      await bank()
    ).mutate('cards.walletProvision', {
      cardId,
      provisionId: randomUUID(),
      wallet: 'google',
      nonce: randomUUID(),
    });
    expect(refused).toMatchObject({ ok: false, code: 'bank.not_offered_by_partner' });
    expect((await (await bank()).query('cards.walletTokens', { cardId })).data.tokens).toEqual([]);
  } finally {
    const on = await (await bank()).mutate('testPartner.set', { notOffered: [] });
    expect(on, JSON.stringify(on.body ?? {}).slice(0, 300)).toMatchObject({ ok: true, data: { notOffered: [] } });
  }

  // The partner offers it: the card goes into Google Wallet, and shows as added as the partner reports it.
  await page.reload();
  await showCard();
  await expect(wallets).toContainText('This card is in no phone wallet.');
  await wallets.getByRole('button', { name: 'Add to Google Wallet' }).click();
  const google = wallets.locator('li[data-wallet="google"]');
  await expect(google).toHaveText('Google Wallet: Added');
  await expect(wallets).toContainText('TEST wallet tokens from a stand-in card partner');
  // As the partner reports it: svc-bank's read of the card partner's tokens, labelled TEST, one token in state added.
  const tokens = await (await bank()).query('cards.walletTokens', { cardId });
  expect(tokens).toMatchObject({ ok: true, data: { test: true } });
  expect(tokens.data.tokens).toEqual([expect.objectContaining({ wallet: 'google', state: 'added' })]);
  await page.reload();
  await showCard();
  await expect(google).toHaveText('Google Wallet: Added');
});
