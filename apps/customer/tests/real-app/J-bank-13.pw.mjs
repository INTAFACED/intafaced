// World: book, restart
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, fromUnits, fund, journeyState, json, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

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
// (RC-bank-02, owner decision 2026-11-06: add cashback): an IFC card's spend is paid cashback in IFC at the rate for the
// person's rank card tier, from the one reward pot, which the two TEST founders fund from IFC trade fees the platform
// earned. The simulator pays it only through the stack's TEST stand-in (BANK_CARD_SIM_CASHBACK=test, refused outside
// dev/test); a simulated card elsewhere still pays none.
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

/** Founder A asks to sweep earned trade fees into the one reward pot; founder B approves, which posts it (as J-campaigns-02). */
async function fundRewardPot(reference, asset, amount) {
  const { ctx, sessions } = await founders();
  const a = await sessions.a.campaignsOpsToken();
  const b = await sessions.b.campaignsOpsToken();
  const asked = await ctx.edge.mutate('campaigns', 'ops.pot.request', { reference, sourceModule: 'trade', asset, amount }, a);
  expect(asked.status, asked.text.slice(0, 300)).toBe(200);
  const funded = await ctx.edge.mutate('campaigns', 'ops.pot.approve', { reference }, b);
  expect(funded.status, funded.text.slice(0, 300)).toBe(200);
  expect(funded.json.result.data.state).toBe('posted');
}

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

/**
 * The reward pot is funded from trade fees the platform earned in IFC: the person buys TEST IFC on the stack's IFC/USDT
 * book, paying the taker fee in IFC, and the two TEST founders sweep `amount` of it into the pot.
 */
async function earnFeesIntoPot(who, token, amount) {
  expect(fund(who.email, 'USDT', '60').tx).toBeTruthy();
  const order = await fetch(`${EDGE}/api/v1/orders`, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ symbol: 'IFC/USDT', type: 'market', side: 'buy', amount: '50', clientOrderId: `${J}-ifc-${randomUUID()}` }),
  }).then(json);
  expect(order.status, JSON.stringify(order.body).slice(0, 300)).toBeLessThan(300);
  await fundRewardPot(`TEST-${J}-${randomUUID().slice(0, 8)}`, 'IFC', fromUnits(amount));
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

test(`${J} #7 sees cashback in token on card spend with the rank-linked tier`, async ({ page }) => {
  test.setTimeout(360_000);
  const who = person();
  const api = await bank();
  const spend = '4';
  const earnedAt = (bps) => (toUnits(spend) * BigInt(bps)) / 10_000n;

  // The tier the bank pays at is the one the person's rank gives in svc-identity, read there, not from the bank.
  const token = await accessToken(who);
  const start = await rankOf(token);
  const before = await api.query('cards.cashback');
  expect(before.ok, JSON.stringify(before.body ?? {}).slice(0, 300)).toBe(true);
  expect(before.data).toMatchObject({ assetId: 'IFC', paying: true, simulated: true, tier: start.cardTier });
  const rateOf = (tier) => before.data.rates.find((r) => r.tier === tier)?.bps ?? null;
  const firstBps = before.data.rateBps;
  expect(firstBps, `a TEST rate for tier ${start.cardTier}`).not.toBeNull();
  expect(firstBps).toBe(rateOf(start.cardTier));
  const first = earnedAt(firstBps);

  // A virtual card that draws on IFC, ordered in the card room.
  await earnFeesIntoPot(who, token, first);
  await signInPerson(page);
  await page.goto('/bank/cards/new');
  await page.getByLabel('Country you live in').selectOption('DE');
  await page.getByRole('radio', { name: 'Virtual card' }).check();
  await page.getByLabel('Card draws on').selectOption('IFC');
  await page.getByLabel('Limit per payment (IFC)').fill('20');
  await page.getByRole('button', { name: 'Issue virtual card' }).click();
  const result = page.getByTestId('card-order-result');
  await expect(result).toContainText('Virtual card issued');
  const cardId = await result.getAttribute('data-card-id');
  expect(await cardOf(cardId)).toMatchObject({ assetId: 'IFC', status: 'active' });

  // A TEST spend of 4 IFC at the starting tier: cashback is paid once, in IFC, at that tier's rate.
  const ifcBefore = toUnits((await api.holding('IFC')).free);
  const one = await spendOn(api, cardId, spend);
  expect(one.cashback).toMatchObject({ status: 'paid', amount: fromUnits(first) });
  expect(ifcBefore - toUnits((await api.holding('IFC')).free)).toBe(toUnits(spend) - first);

  // The person's rank rises, one rank at a time by the XP identity says the next rank needs, until it gives the next
  // card tier on identity's ladder. That tier's TEST rate differs, so a bank that ignored rank would fail here.
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
  const mid = await api.query('cards.cashback');
  expect(mid.data).toMatchObject({ tier: risen.cardTier, rateBps: secondBps });

  // The same spend now pays at the new tier's rate, once. Before it is paid (authorised, not yet captured) the cashback
  // it will earn is nowhere spendable: the free balance has dropped by the whole spend and not a unit more came back,
  // the bank lists no cashback for that authorisation, and the card page's paid figure has not moved.
  await earnFeesIntoPot(who, token, second);
  const ifcMid = toUnits((await api.holding('IFC')).free);
  const two = await spendOn(api, cardId, spend, async (held) => {
    expect(ifcMid - toUnits((await api.holding('IFC')).free)).toBe(toUnits(spend));
    const pending = await api.query('cards.cashback');
    expect(toUnits(pending.data.paid)).toBe(toUnits(before.data.paid) + first);
    expect(pending.data.payments.filter((p) => p.authorizationId === held.authorizationId)).toEqual([]);
    await page.goto('/bank/cards');
    const paidLine = page.getByTestId('card-cashback').getByTestId('card-cashback-paid');
    await expect(paidLine).toHaveAttribute('data-paid', pending.data.paid);
    await expect(paidLine).toContainText(`Cashback paid: ${pending.data.paid} IFC`);
  });
  expect(two.cashback).toMatchObject({ status: 'paid', amount: fromUnits(second) });
  expect(ifcMid - toUnits((await api.holding('IFC')).free)).toBe(toUnits(spend) - second);

  const after = await api.query('cards.cashback');
  expect(toUnits(after.data.paid) - toUnits(before.data.paid)).toBe(first + second);
  for (const [spent, amount] of [
    [one, first],
    [two, second],
  ]) {
    expect(after.data.payments.filter((p) => p.authorizationId === spent.held.authorizationId)).toEqual([
      expect.objectContaining({ status: 'settled', amount: fromUnits(amount) }),
    ]);
  }

  // Each payment is recorded in svc-ledger as owed by INTAFACED: one transaction under the authorisation's reward key,
  // taking exactly the cashback from the platform's reward pot (house:rewards-engine, IFC) and putting exactly that in
  // the person's own available IFC (user:<id>), and nothing else.
  const house = await ledgerAccounts('house:rewards-engine');
  const mine = await ledgerAccounts(`user:${start.userId}`);
  for (const [spent, amount] of [
    [one, first],
    [two, second],
  ]) {
    const [payment] = after.data.payments.filter((p) => p.authorizationId === spent.held.authorizationId);
    expect(payment.ledgerTxId, 'a settled cashback names its ledger transaction').toBeTruthy();
    const tx = await ledgerTx(payment.ledgerTxId);
    expect(tx).toMatchObject({
      txId: payment.ledgerTxId,
      businessKey: `reward:bank.card.cashback:${spent.held.authorizationId}`,
      reason: 'bank.card.cashback',
    });
    expect(tx.postings).toHaveLength(2);
    const from = tx.postings.find((p) => p.side === 'source');
    const to = tx.postings.find((p) => p.side === 'destination');
    expect(from).toMatchObject({ assetId: 'IFC', amount: fromUnits(amount) });
    expect(house.get(from.accountId)).toMatchObject({ address: 'house:rewards-engine', kind: 'available', assetId: 'IFC' });
    expect(to).toMatchObject({ assetId: 'IFC', amount: fromUnits(amount) });
    expect(mine.get(to.accountId)).toMatchObject({ address: `user:${start.userId}`, kind: 'available', assetId: 'IFC' });
  }

  // The card page shows it: the tier the rank now gives, its rate in IFC, the tier table, and the cashback paid.
  await page.goto('/bank/cards');
  const panelCashback = page.getByTestId('card-cashback');
  const tierName = { none: 'None', standard: 'Standard', metal: 'Metal', obsidian: 'Obsidian' }[risen.cardTier];
  await expect(panelCashback).toContainText(`Your rank’s card tier: ${tierName}`);
  const percent = (secondBps / 100).toString();
  await expect(panelCashback).toContainText(`${percent}% cashback in IFC on spend from your IFC card`);
  const table = panelCashback.getByRole('table', { name: 'Cashback by card tier' });
  await expect(table.getByRole('row')).toHaveCount(after.data.rates.length + 1);
  await expect(panelCashback.getByTestId('card-cashback-paid')).toHaveAttribute('data-paid', after.data.paid);
  await expect(panelCashback.getByTestId('card-cashback-paid')).toContainText(`Cashback paid: ${after.data.paid} IFC`);
});
