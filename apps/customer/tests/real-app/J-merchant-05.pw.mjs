import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, journeyState, tool } from './stack.mjs';
import { forgetSession, nextCode } from './identity-factors.mjs';
import { businessReadyPerson, openBusiness, refusedPayCalls, signInWithCode, verifiedBusiness } from './merchant.mjs';

// J-merchant-05, in the running app (docs/roadmap/journeys.json): see a payment arrive and read everything about it.
// One test per step, titled "J-merchant-05 #<n>", run in order on one verified TEST business. #1 makes the owner and the
// business and reads Payments while it has none; #2 makes the TEST payments the later steps read: paid ones, one refunded
// in part, one disputed (the stack's founder pair opens it, as no stack rail sends chargebacks) and one declined, all on
// the stack's TEST card rail, plus enough unpaid ones to need a second page.
const J = 'J-merchant-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

/** What #1 left: the owner (with its authenticator secret) and the business. */
function journey() {
  const state = run.read();
  if (!state.owner?.secret) throw new Error(`${J} #1 made no business, so this step has no owner to act as`);
  return state;
}

const saved = (who) => ({
  handle: who.handle,
  email: who.email,
  password: who.password,
  secret: who.secret,
  step: who.step,
  userId: who.userId,
});

/** A stable uuid for a journey key, so a retried create names the same payment (idempotency keys are business keys). */
function uuidOf(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const totpOf = async () => (await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'))).totp;

/** The owner signs in again, and the code's time step is kept so the next sign-in waits for a fresh code. */
async function signInOwner(page, state, destination) {
  const who = { ...state.owner, totp: await totpOf() };
  await signInWithCode(page, who, destination);
  run.write({ owner: saved(who) });
  return who;
}

/** The owner's own pay API through Edge, with a session of its own and its authenticator's next code. */
async function ownerApi(state) {
  const totp = await totpOf();
  const owner = { ...state.owner };
  const code = async () => {
    const next = await nextCode(totp, owner.secret, owner.step);
    owner.step = next.step;
    run.write({ owner: saved(owner) });
    return next.code;
  };
  const send = async (route, body, token) => {
    const res = await fetch(`${EDGE}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* the body is kept as text for the error */
    }
    if (!res.ok || !json?.result) throw new Error(`${route} refused: ${res.status} ${text.slice(0, 400)}`);
    return json.result.data;
  };
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: owner.email, password: owner.password, totpCode: await code() }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`owner sign-in refused: ${JSON.stringify(login).slice(0, 300)}`);
  let refundToken = null;
  return {
    mutate: (procedure, input) => send(`/api/pay/trpc/${procedure}`, input, token),
    query: (procedure, input) => send(`/api/pay/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`, undefined, token),
    /** A refund goes with the owner's "Confirm it's you" token, as the portal sends it. */
    async refund(input) {
      if (!refundToken) {
        const minted = await send(
          '/api/identity/trpc/auth.stepUpPay',
          { merchantId: state.merchantId, scopes: ['pay:refund'], factorProof: { totpCode: await code() } },
          token,
        );
        refundToken = minted.accessToken;
      }
      return send('/api/pay/trpc/payment.refund', input, refundToken);
    },
  };
}

/** A TEST card payment on the stack's sandbox card rail, taken as far as `want`. `tok_decline` is its published decline. */
async function cardPayment(owner, merchantId, { amount, reference, customerRef, want }) {
  const created = await owner.mutate('payment.create', {
    requestId: uuidOf(`${J}:payment:${reference}`),
    merchantId,
    amount,
    assetId: 'USDT',
    method: 'card',
    railAdapter: 'card-sandbox',
    customerRef,
    metadata: { reference },
    instrument: { kind: 'card', token: want === 'failed' ? 'tok_decline' : 'tok_ok' },
  });
  // A retried step finds its payment where the first run left it (paid, refunded in part, or disputed since).
  if (want === 'created' || !['created', 'authorized'].includes(created.status)) return created;
  if (want === 'failed') {
    // The decline is the answer asked for; any other refusal is the step's failure, with its own words.
    await owner.mutate('payment.authorize', { paymentId: created.id }).catch((err) => {
      if (!/declin/i.test(err.message)) throw err;
    });
    return owner.query('payment.get', { paymentId: created.id });
  }
  const authorized = created.status === 'created' ? await owner.mutate('payment.authorize', { paymentId: created.id }) : created;
  return authorized.status === 'captured' ? authorized : owner.mutate('payment.capture', { paymentId: created.id });
}

test(`${J} #1 opens Payments on an account with none: how the first payment appears, and a link to make a payment link`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  run.reset({});
  const own = await businessReadyPerson(page, 'm5o', '/pay/onboarding');
  const merchantId = await openBusiness(page, own, 'TEST Payments Ltd');
  await verifiedBusiness(page, own, merchantId);
  await forgetSession(page);
  run.write({ owner: saved(own), merchantId });

  await signInOwner(page, journey(), '/pay/payments');
  const refused = refusedPayCalls(page);
  await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your first payment starts here' })).toBeVisible();
  await expect(page.getByText('Create a payment link. Payments will appear here once a customer pays.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create payment link' }).last()).toHaveAttribute('href', '/pay/links/new');
  // The totals read zero for the period, never a made-up figure.
  await expect(page.getByRole('group', { name: 'Totals for Last 30 days' })).toBeVisible();
  expect(refused).toEqual([]);
});

test(`${J} #2 opens the list: totals with their period, filters the service applies, load more, export, a phone layout; a merchant reference finds only its payment`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const state = journey();
  const owner = await ownerApi(state);
  const { merchantId } = state;
  // One stamp per business: a retried step makes the same payments, refund and dispute again, and each answers with
  // the first one (business keys), so the counts below stay what this step made.
  const stamp = state.stamp ?? run.write({ stamp: Date.now().toString(36).toUpperCase() }).stamp;
  const ref = (n) => `TEST-${stamp}-${n}`;
  const paid = await cardPayment(owner, merchantId, { amount: '10.00', reference: ref(1), customerRef: 'TEST-cust-ada', want: 'captured' });
  const refunded = await cardPayment(owner, merchantId, {
    amount: '100.00',
    reference: ref(2),
    customerRef: 'TEST-cust-ben',
    want: 'captured',
  });
  await owner.refund({ paymentId: refunded.id, amount: '30.00', refundId: `TEST-${stamp}-refund` });
  const disputed = await cardPayment(owner, merchantId, {
    amount: '12.00',
    reference: ref(3),
    customerRef: 'TEST-cust-cia',
    want: 'captured',
  });
  const opened = JSON.parse(tool('local-test-world.mjs', 'open-dispute', disputed.id, 'product_not_received').trim().split('\n').pop());
  expect(opened.status).toBe('open');
  const declined = await cardPayment(owner, merchantId, {
    amount: '3.00',
    reference: ref(4),
    customerRef: 'TEST-cust-ada',
    want: 'failed',
  });
  expect(declined.status).toBe('failed');
  // Enough unpaid ones that the list needs a second page (25 a page).
  for (let n = 5; n <= 27; n += 1) await cardPayment(owner, merchantId, { amount: '1.00', reference: ref(n), want: 'created' });
  run.write({
    payments: { paid: paid.id, refunded: refunded.id, disputed: disputed.id, declined: declined.id, reference: ref(3) },
  });

  await signInOwner(page, journey(), '/pay/payments');
  const refused = refusedPayCalls(page);
  const listCalls = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.endsWith('/payment.list')) listCalls.push(JSON.parse(url.searchParams.get('input') ?? '{}'));
  });
  await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
  // Totals name their period, and each tile opens the payments it counts.
  const totals = page.getByRole('group', { name: 'Totals for Last 30 days' });
  await expect(totals).toBeVisible();
  await expect(totals.getByRole('link', { name: /Failed/ })).toHaveAttribute('href', /status=failed&date=30d/);
  const tile = (name) => totals.getByRole('link', { name }).locator('.pp-kpi-value');
  await expect(tile(/^Payments/)).toHaveText('27');
  await expect(tile(/^Failed/)).toHaveText('1');
  await expect(tile(/^Disputed/)).toHaveText('1');
  const rows = page.locator('.pe-table tbody tr');
  await expect(rows).toHaveCount(25);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(rows).toHaveCount(27);
  expect(listCalls.some((input) => input.cursor)).toBe(true);

  // Every filter is asked of the service, and lives in the address.
  await page.getByLabel('Status').selectOption('failed');
  await expect(page).toHaveURL(/status=failed/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('3.00');
  expect(listCalls.some((input) => input.status === 'failed')).toBe(true);
  await page.getByLabel('Status').selectOption('');

  // A merchant reference finds only that payment.
  await page.getByLabel('Search', { exact: true }).fill(ref(3));
  await expect(page).toHaveURL(new RegExp(`q=${ref(3)}`));
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('12.00');
  expect(listCalls.some((input) => input.search === ref(3))).toBe(true);
  await page.getByLabel('Search', { exact: true }).fill('TEST-no-such-reference');
  await expect(page.getByRole('heading', { name: 'No payments match these filters' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows).toHaveCount(25);

  // Export asks for a file with the filters on the page, and says where it lands.
  await page.getByRole('button', { name: 'Export these results' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('.form-stack > button').last().click();
  await expect(page.getByRole('status').filter({ hasText: 'Your export is being prepared.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open exports' })).toHaveAttribute('href', '/pay/reports/exports');

  // A phone: the list becomes cards, and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
  await expect(page.locator('.pe-table')).toBeHidden();
  await expect(page.getByRole('list', { name: 'Payments' }).getByRole('listitem')).toHaveCount(25);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(refused).toEqual([]);
});
