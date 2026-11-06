// World: stack
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, journeyState, tool } from './stack.mjs';
import { forgetSession, nextCode } from './identity-factors.mjs';
import { businessReadyPerson, openBusiness, paidCardPayment, payApiOf, signInWithCode, uuidOf, verifiedBusiness } from './merchant.mjs';

// J-merchant-06, in the running app (docs/roadmap/journeys.json): refund, void or reverse a payment safely. One test per
// step, titled "J-merchant-06 #<n>", run in order on one verified TEST business.
//
// It starts as the row says: the owner signed in; a captured payment of TEST 100 USDC with TEST 30 refunded; an
// authorised and uncaptured payment; and a finance teammate with refund approval rules on (the owner's TEST rule:
// refunds above TEST 100 USDC wait for a second person). #1 makes all of it through the service, never by writing rows.
// Step 8 (an unlinked refund to a stored customer destination) is DEFERRED until launch prep (owner decision 2026-10-27).
const J = 'J-merchant-06';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ASSET = 'USDC';
/** The owner's TEST refund approval rule: a refund above this waits for a second person. */
const THRESHOLD = '100';

test.describe.configure({ mode: 'default' });

const saved = (who) => ({
  handle: who.handle,
  email: who.email,
  password: who.password,
  secret: who.secret,
  step: who.step,
  userId: who.userId,
});

function journey() {
  const state = run.read();
  if (!state.owner?.secret || !state.payments) throw new Error(`${J} #1 made no business, so this step has nothing to act on`);
  return state;
}

const totpOf = async () => (await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'))).totp;

async function signIn(page, key, destination) {
  const state = run.read();
  const who = { ...state[key], totp: await totpOf() };
  // Signed in on the room's own path, then sent to the address with its query (the helper matches a plain path). The
  // code's step is kept even when the sign-in fails, so no authenticator code is used twice.
  const [plain, query] = destination.split('?');
  try {
    await signInWithCode(page, who, plain);
  } finally {
    run.write({ [key]: saved(who) });
  }
  if (query) await page.goto(destination);
  return who;
}

/** A person's own pay API through Edge; the code's time step is kept for the next sign-in. */
async function apiOf(key) {
  const state = run.read();
  return payApiOf(state[key], (step) => run.write({ [key]: { ...run.read()[key], step } }));
}

/** The next authenticator code for a person, its time step kept so no code is used twice. */
async function codeFor(key) {
  const who = run.read()[key];
  const next = await nextCode(await totpOf(), who.secret, who.step);
  run.write({ [key]: { ...who, step: next.step } });
  return next.code;
}

/** A refund the person may send: their session after "Confirm it's you" with a fresh code. */
async function refunder(key, merchantId) {
  const api = await apiOf(key);
  return api.steppedUp(merchantId, ['pay:refund'], await codeFor(key));
}

/** Fills "Confirm it's you" with the person's next code. */
async function confirmItsYou(page, key) {
  const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
  await dialog.getByLabel('6-digit code from your authenticator app').fill(await codeFor(key));
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/** A decimal string the service answers, at any scale ("70", "70.00"): compared as the exact decimal, never as a float. */
const dec = (whole) => expect.stringMatching(new RegExp(`^${whole.replace('.', '\\.')}(\\.0+)?$`));
/** How the portal writes a TEST USDC amount: two places (ui/format.ts formatMoney). The amounts here are under 1,000. */
const twoPlaces = (v) => {
  const [w, f = ''] = v.split('.');
  return `${w}.${(f + '00').slice(0, 2)}`;
};
const money = (amount) => new RegExp(`^${amount.replace('.', '\\.')}\\s*${ASSET}$`);
const fact = (scope, label) =>
  scope
    .getByTestId('pp-facts')
    .locator('dt', { hasText: new RegExp(`^${label}$`) })
    .locator('xpath=following-sibling::dd[1]');

/** Every refund the service holds for one payment, as the owner reads them. */
async function refundsOf(paymentId) {
  const { merchantId } = journey();
  const api = await apiOf('owner');
  return (await api.query('payment.refunds.list', { merchantId, paymentId, limit: 100 })).items;
}

/** A card payment the stack's sandbox rail authorises, left uncaptured. */
async function authorisedPayment(api, merchantId, key, amount) {
  const created = await api.mutate('payment.create', {
    requestId: uuidOf(key),
    merchantId,
    amount,
    assetId: ASSET,
    method: 'card',
    railAdapter: 'card-sandbox',
    metadata: { reference: key },
    instrument: { kind: 'card', token: 'tok_ok' },
  });
  return created.status === 'created' ? api.mutate('payment.authorize', { paymentId: created.id }) : created;
}

/** The finance teammate the journey starts with: invited by account ID by the owner and accepted by them. */
async function financeTeammate(page) {
  const finance = await businessReadyPerson(page, 'mrf', '/pay/merchant');
  run.write({ finance: saved(finance) });
  await forgetSession(page);
  await signIn(page, 'owner', '/pay/team');
  await page.getByRole('button', { name: 'Invite by account ID instead' }).click();
  await page.getByLabel('Account ID *').fill(finance.userId);
  await page.getByRole('combobox', { name: /^Role \*/ }).selectOption({ label: 'Finance' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await forgetSession(page);
  await signIn(page, 'finance', '/pay/team');
  const accept = page.locator('li').filter({ hasText: 'Finance' }).getByRole('button', { name: 'Accept' }).first();
  await expect(async () => {
    await page.reload();
    await expect(accept).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await accept.click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await forgetSession(page);
}

test(`${J} #1 opens a captured payment and presses Refund: maximum refundable TEST 70 and the funding balance; TEST 80 is refused in a sentence; a payment with nothing left refuses closed without a mutation; an open dispute blocks it`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  const owner = await businessReadyPerson(page, 'mr', '/pay/merchant');
  const merchantId = await openBusiness(page, owner);
  await verifiedBusiness(page, owner, merchantId);
  run.reset({ owner: saved(owner), merchantId });
  await financeTeammate(page);

  // The owner's refund approval rule, set through the service: refunds above TEST 100 USDC wait for a second person.
  const api = await apiOf('owner');
  const rule = await api.mutate('payment.refundRules.set', { merchantId, assetId: ASSET, threshold: THRESHOLD });
  expect(rule).toMatchObject({ assetId: ASSET, threshold: expect.stringMatching(/^100(\.0+)?$/) });

  // The TEST payments the steps act on, each named by a business key so a retried step finds the same one.
  const key = (name) => `${J}:${name}:${merchantId}`;
  const paid = (name, amount, token) =>
    paidCardPayment(api, merchantId, { key: key(name), amount, assetId: ASSET, ...(token ? { token } : {}) });
  const main = await paid('main', '100.00');
  const spent = await paid('spent', '10.00');
  const lost = await paid('lost', '20.00');
  const refused = await paid('refused', '5.00', 'tok_refund_refused');
  const large = await paid('large', '150.00');
  const reverse = await paid('reverse', '25.00');
  const disputed = await paid('disputed', '12.00');
  const bulk = await Promise.all(['bulk-a', 'bulk-b', 'bulk-c'].map((n) => paid(n, '8.00')));
  for (const p of [main, spent, lost, refused, large, reverse, disputed, ...bulk]) expect(p.status).toBe('captured');
  const uncaptured = await authorisedPayment(api, merchantId, key('authorised'), '40.00');
  expect(uncaptured.status).toBe('authorized');
  // TEST 30 refunded on the main payment, and the whole of the spent one, by the owner with a fresh confirmation.
  const send = await refunder('owner', merchantId);
  await send.mutate('payment.refund', { paymentId: main.id, amount: '30.00', refundId: `refund:${main.id}:${uuidOf(key('first-30'))}` });
  await send.mutate('payment.refund', { paymentId: spent.id, amount: '10.00', refundId: `refund:${spent.id}:${uuidOf(key('all'))}` });
  JSON.parse(tool('local-test-world.mjs', 'open-dispute', disputed.id, 'product_not_received').trim().split('\n').pop());
  run.write({
    payments: {
      main: main.id,
      spent: spent.id,
      lost: lost.id,
      refused: refused.id,
      large: large.id,
      reverse: reverse.id,
      disputed: disputed.id,
      bulk: bulk.map((p) => p.id),
      authorised: uncaptured.id,
    },
  });

  const refundsSent = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.endsWith('/payment.refund')) refundsSent.push(r.postData());
  });
  await signIn(page, 'owner', `/pay/payments/${main.id}`);
  await page.getByRole('link', { name: 'Refund', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/pay/refunds/new\\?payment=${main.id}$`));
  const facts = page.getByTestId('pay-section').filter({ hasText: 'Can still refund' });
  await expect(fact(facts, 'Paid in')).toHaveText(money('100.00'));
  await expect(fact(facts, 'Already refunded')).toHaveText(money('30.00'));
  await expect(fact(facts, 'Can still refund')).toHaveText(money('70.00'));
  // The funding balance is the service's own figure for the balance the refund is taken from: the payment is still
  // clearing, so clearing funds it, and it holds the 70 left of this payment and nothing the page made up.
  const pre = await api.query('payment.refundCheck', { paymentId: main.id });
  expect(pre).toMatchObject({ maxRefundable: expect.stringMatching(/^70(\.0+)?$/), source: 'clearing', blockedBy: null });
  await expect(fact(facts, 'Funding balance')).toHaveText(`Clearing · ${twoPlaces(pre.fundingBalance)} ${ASSET}`);

  // TEST 80 is more than is left: refused in a sentence, and nothing is asked of the service.
  await page.getByLabel(`Refund amount (${ASSET})`).fill('80');
  await page.getByRole('button', { name: 'Review refund' }).click();
  await expect(page.getByText('Enter an amount above zero that is no more than what can still be refunded.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: "Confirm it's you" })).toHaveCount(0);
  // By the service as well: TEST 80 is refused by its code and moves nothing.
  const by = await refunder('owner', merchantId);
  await expect(
    by.mutate('payment.refund', { paymentId: main.id, amount: '80.00', refundId: `refund:${main.id}:${uuidOf(key('eighty'))}` }),
  ).rejects.toThrow(/pay\.refund_exceeds_captured/);
  expect((await api.query('payment.get', { paymentId: main.id })).refundedAmount).toMatch(/^30(\.0+)?$/);

  // A payment with nothing left: no Refund on it, and its refund page refuses closed without a mutation.
  await page.goto(`/pay/payments/${spent.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Refund', exact: true })).toHaveCount(0);
  await page.goto(`/pay/refunds/new?payment=${spent.id}`);
  await expect(page.getByText('Nothing is left to refund on this payment.')).toBeVisible();
  await expect(page.getByLabel(`Refund amount (${ASSET})`)).toHaveCount(0);

  // An open dispute blocks it, on the page and by the service.
  await page.goto(`/pay/refunds/new?payment=${disputed.id}`);
  await expect(page.getByText('This payment has an open dispute. It can’t be refunded until the dispute is closed.')).toBeVisible();
  await expect(page.getByLabel(`Refund amount (${ASSET})`)).toHaveCount(0);
  expect((await api.query('payment.refundCheck', { paymentId: disputed.id })).blockedBy).toBe('pay.refund_open_dispute');
  await expect(
    by.mutate('payment.refund', { paymentId: disputed.id, amount: '1.00', refundId: `refund:${disputed.id}:${uuidOf(key('d'))}` }),
  ).rejects.toThrow(/pay\.refund_open_dispute/);
  expect(refundsSent, 'the page sent no refund in this step').toEqual([]);
});

test(`${J} #2 confirms it's them, reviews and sends: a fresh confirmation before the review; the refund goes with the confirmation token and nothing else does; a confirmation that ran out is asked for again and the same refund reference is used`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { payments } = journey();
  // Who carried the confirmation token: every request the page sends, by procedure and bearer.
  const sent = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/')) sent.push({ path: url.pathname, auth: r.headers().authorization ?? '', body: r.postData() });
  });
  let stepUpTokens = [];
  page.on('response', async (res) => {
    if (new URL(res.url()).pathname.endsWith('auth.stepUpPay') && res.ok()) {
      const token = (await res.json().catch(() => null))?.result?.data?.accessToken;
      if (token) stepUpTokens.push(token);
    }
  });
  // The first send is answered as a confirmation that ran out (the service's own refusal), and never reaches it.
  let expiredOnce = false;
  await page.route('**/api/pay/trpc/payment.refund', async (route) => {
    if (!expiredOnce) {
      expiredOnce = true;
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            message: 'pay.refund_step_up_expired',
            code: -32001,
            data: { code: 'UNAUTHORIZED', httpStatus: 401, intafacedCode: 'pay.refund_step_up_expired' },
          },
        }),
      });
    }
    return route.continue();
  });
  await signIn(page, 'owner', `/pay/refunds/new?payment=${payments.main}`);
  await page.getByLabel(`Refund amount (${ASSET})`).fill('70');
  await page.getByRole('button', { name: 'Review refund' }).click();
  // A fresh confirmation comes before the review.
  await expect(page.getByRole('dialog', { name: 'Review refund' })).toHaveCount(0);
  await confirmItsYou(page, 'owner');
  const review = page.getByRole('dialog', { name: 'Review refund' });
  await expect(review).toContainText('70');
  await review.getByRole('button', { name: 'Confirm refund' }).click();
  // The confirmation ran out: it is asked for again, then the same review goes out.
  await confirmItsYou(page, 'owner');
  await expect(page.getByRole('heading', { name: 'Refund recorded' })).toBeVisible({ timeout: 30_000 });

  const refundCalls = sent.filter((s) => s.path.endsWith('/payment.refund'));
  expect(refundCalls).toHaveLength(2);
  const ids = refundCalls.map((c) => JSON.parse(c.body).refundId);
  expect(ids[0]).toBe(ids[1]);
  expect(ids[0]).toMatch(new RegExp(`^refund:${payments.main}:`));
  // The refund went with a confirmation token, and nothing else did.
  expect(stepUpTokens.length).toBeGreaterThanOrEqual(2);
  for (const call of refundCalls) expect(stepUpTokens.some((t) => call.auth === `Bearer ${t}`)).toBe(true);
  for (const other of sent.filter((s) => !s.path.endsWith('/payment.refund')))
    expect(stepUpTokens.some((t) => other.auth === `Bearer ${t}`)).toBe(false);

  // Posted once, under that reference: the payment's refunds are the first TEST 30 and this TEST 70, nothing more.
  const refunds = await refundsOf(payments.main);
  expect(refunds).toHaveLength(2);
  expect(refunds.find((r) => r.refundId === ids[0])?.amount).toEqual(dec('70'));
  expect(refunds.find((r) => r.refundId !== ids[0])?.amount).toEqual(dec('30'));
});

test(`${J} #3 the send reply is lost: the page says the outcome is unknown, reuses the stored request id on retry and shows exactly one refund; a reload keeps it`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { payments } = journey();
  const bodies = [];
  // The refund reaches the service; its answer never reaches the page.
  await page.route('**/api/pay/trpc/payment.refund', async (route) => {
    bodies.push(route.request().postData());
    await route.fetch();
    await route.abort('connectionreset');
  });
  // The network is down for the first look back too: the page cannot yet tell what happened.
  let historyDown = true;
  await page.route('**/api/pay/trpc/payment.history*', (route) => (historyDown ? route.abort('connectionreset') : route.continue()));
  await signIn(page, 'owner', `/pay/refunds/new?payment=${payments.lost}`);
  await page.getByLabel(`Refund amount (${ASSET})`).fill('20');
  await page.getByRole('button', { name: 'Review refund' }).click();
  await confirmItsYou(page, 'owner');
  await page.getByRole('dialog', { name: 'Review refund' }).getByRole('button', { name: 'Confirm refund' }).click();
  await expect(page.getByText('Refund outcome unknown')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel(`Refund amount (${ASSET})`)).toHaveCount(0);
  // A reload keeps it: the stored request id, and no new review (the network is still down for the look back).
  await page.reload();
  await expect(page.getByText('Refund outcome unknown')).toBeVisible();
  await expect(page.getByLabel(`Refund amount (${ASSET})`)).toHaveCount(0);
  historyDown = false;
  await page.getByRole('button', { name: 'Check original refund' }).click();
  await expect(page.getByRole('heading', { name: 'Refund recorded' })).toBeVisible({ timeout: 30_000 });
  // Every send carried the one stored request id, and exactly one refund exists.
  const ids = new Set(bodies.map((b) => JSON.parse(b).refundId));
  expect(ids.size).toBe(1);
  const refunds = await refundsOf(payments.lost);
  expect(refunds).toHaveLength(1);
  expect(refunds[0]).toMatchObject({ refundId: [...ids][0], amount: dec('20') });
  // After a reload the payment itself shows the one refund: TEST 20 already refunded and nothing left to send again.
  await page.reload();
  const facts = page.getByTestId('pay-section').filter({ hasText: 'Can still refund' });
  await expect(fact(facts, 'Already refunded')).toHaveText(money('20.00'));
  await expect(page.getByText('Nothing is left to refund on this payment.')).toBeVisible();
});

test(`${J} #4 opens the refund: status in plain words, the reason when the rail refused and that the money is back in the balance; a queued refund can be cancelled once`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { merchantId, payments } = journey();
  const send = await refunder('owner', merchantId);
  // A refund the TEST rail refuses: posted, then reversed through the refund recipe.
  await expect(
    send.mutate('payment.refund', {
      paymentId: payments.refused,
      amount: '5.00',
      refundId: `refund:${payments.refused}:${uuidOf(`${J}:refused`)}`,
    }),
  ).rejects.toThrow(/pay\.rail_failed/);
  const [reversed] = await refundsOf(payments.refused);
  expect(reversed.status).toBe('reversed');
  await signIn(page, 'owner', `/pay/refunds/${reversed.id}`);
  await expect(page.getByTestId('pp-chip').first()).toHaveText('Reversed');
  await expect(page.getByText('The customer’s card issuer refused the refund.')).toBeVisible();
  await expect(page.getByText('The money is back in your balance. Nothing was sent to the customer.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel refund' })).toHaveCount(0);

  // A sent refund (#3's) says so in plain words and cannot be cancelled.
  const [done] = await refundsOf(payments.lost);
  await page.goto(`/pay/refunds/${done.id}`);
  await expect(page.getByTestId('pp-chip').first()).toHaveText(/^(In progress|Refunded)$/);
  await expect(page.getByText('It has already been sent and cannot be cancelled.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel refund' })).toHaveCount(0);

  // A queued refund: above the TEST approval rule it waits, posts nothing, and can be cancelled once.
  const queued = await send.mutate('payment.refundRequests.request', {
    paymentId: payments.large,
    amount: '120.00',
    refundId: `refund:${payments.large}:${uuidOf(`${J}:queued`)}`,
  });
  expect(queued.status).toBe('queued');
  await page.goto(`/pay/refunds/requests/${queued.id}`);
  await expect(page.getByTestId('pp-chip').first()).toHaveText('Waiting for approval');
  await page.getByRole('button', { name: 'Cancel refund' }).click();
  await page.getByRole('dialog', { name: 'Cancel this refund?' }).getByRole('button', { name: 'Cancel refund' }).click();
  await expect(page.getByTestId('pp-chip').first()).toHaveText('Cancelled');
  await expect(page.getByRole('button', { name: 'Cancel refund' })).toHaveCount(0);
  const api = await apiOf('owner');
  await expect(api.mutate('payment.refundRequests.cancel', { requestId: queued.id })).rejects.toThrow(/pay\.refund_request_closed/);
  expect((await api.query('payment.get', { paymentId: payments.large })).refundedAmount).toMatch(/^0(\.0+)?$/);
  expect(await refundsOf(payments.large)).toEqual([]);
});

test(`${J} #5 asks for a refund above the approval threshold: pending with no ledger post; the checker approves and it runs once; editing the amount voids the approval; the maker cannot approve their own`, async ({
  page,
}) => {
  test.setTimeout(400_000);
  const { merchantId, payments } = journey();
  await signIn(page, 'owner', `/pay/refunds/new?payment=${payments.large}`);
  await page.getByLabel(`Refund amount (${ASSET})`).fill('150');
  await page.getByRole('button', { name: 'Review refund' }).click();
  await confirmItsYou(page, 'owner');
  const review = page.getByRole('dialog', { name: 'Review refund' });
  await expect(review).toContainText('A teammate must approve refunds above 100.00 USDC.');
  await review.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(page.getByText('Waiting for approval')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Nothing has been refunded yet.')).toBeVisible();
  const api = await apiOf('owner');
  expect((await api.query('payment.get', { paymentId: payments.large })).refundedAmount).toMatch(/^0(\.0+)?$/);
  const [first] = (await api.query('payment.refundRequests.list', { merchantId, paymentId: payments.large, status: 'queued' })).items;
  expect(first).toMatchObject({ amount: dec('150'), status: 'queued' });

  // The maker cannot approve their own.
  const maker = await refunder('owner', merchantId);
  await expect(maker.mutate('payment.refundRequests.decide', { requestId: first.id, decision: 'approve' })).rejects.toThrow(
    /pay\.refund_approval_self/,
  );

  // Editing the amount voids the approval: the owner asks for TEST 140 instead, and the TEST 150 request is void.
  const second = await maker.mutate('payment.refundRequests.request', {
    paymentId: payments.large,
    amount: '140.00',
    refundId: `refund:${payments.large}:${uuidOf(`${J}:large:140`)}`,
  });
  const all = (await api.query('payment.refundRequests.list', { merchantId, paymentId: payments.large })).items;
  expect(all.find((r) => r.id === first.id)).toMatchObject({ status: 'voided' });
  expect(second).toMatchObject({ status: 'queued', amount: dec('140') });

  // The checker, the finance teammate, approves it with their own confirmation, and it runs once.
  await forgetSession(page);
  await signIn(page, 'finance', '/pay/approvals');
  const item = page.locator('li').filter({ hasText: 'Refund' }).filter({ hasText: '140.00' });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: 'Approve' }).click();
  await confirmItsYou(page, 'finance');
  await page.getByRole('dialog', { name: 'Approve this refund?' }).getByRole('button', { name: 'Approve' }).click();
  await expect(item).toContainText('Refunded');
  const checker = await refunder('finance', merchantId);
  await expect(checker.mutate('payment.refundRequests.decide', { requestId: second.id, decision: 'approve' })).rejects.toThrow(
    /pay\.refund_request_closed/,
  );
  const refunds = await refundsOf(payments.large);
  expect(refunds.map((r) => [r.refundId, r.amount])).toEqual([[second.refundId, dec('140')]]);
  expect((await api.query('payment.get', { paymentId: payments.large })).refundedAmount).toMatch(/^140(\.0+)?$/);
});

test(`${J} #6 voids an authorised payment, and reverses a captured one: void ends it voided with the balance unchanged and a second void returns the same result; reverse creates a refund of the captured amount through the refund path`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { merchantId, payments } = journey();
  const api = await apiOf('owner');
  const balances = async () =>
    (await api.query('merchantMetrics.snapshot', { merchantId, window: { kind: 'preset', preset: 'rolling_30d' } })).balances;
  const before = await balances();

  await signIn(page, 'owner', `/pay/payments/${payments.authorised}`);
  await expect(page.getByRole('link', { name: 'Refund', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Void payment' }).click();
  await page.getByRole('dialog', { name: 'Void this payment?' }).getByRole('button', { name: 'Void payment' }).click();
  await expect(page.getByTestId('pp-chip').first()).toHaveText('Voided');
  await expect(page.getByText('Nothing was taken from the customer, and your balance did not change.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Void payment' })).toHaveCount(0);
  const voided = await api.query('payment.get', { paymentId: payments.authorised });
  expect(voided.status).toBe('voided');
  // A second void returns the same result and changes nothing.
  expect(await api.mutate('payment.void', { paymentId: payments.authorised })).toMatchObject({ id: payments.authorised, status: 'voided' });
  expect(await balances()).toEqual(before);
  await expect(api.mutate('payment.capture', { paymentId: payments.authorised })).rejects.toThrow(/refused/);

  // Reverse a captured payment: the server picks a refund of the captured amount, sent with a fresh confirmation.
  await page.goto(`/pay/payments/${payments.reverse}`);
  await page.getByRole('button', { name: 'Reverse payment' }).click();
  await confirmItsYou(page, 'owner');
  const dialog = page.getByRole('dialog', { name: 'Reverse this payment?' });
  await expect(dialog).toContainText('This payment was captured, so reversing it refunds 25.00 USDC.');
  await dialog.getByRole('button', { name: 'Reverse payment' }).click();
  await expect(page.getByText('Reversed with a refund of 25.00 USDC.')).toBeVisible({ timeout: 30_000 });
  const refunds = await refundsOf(payments.reverse);
  expect(refunds).toHaveLength(1);
  expect(refunds[0]).toMatchObject({ amount: dec('25'), refundId: `reverse:${payments.reverse}` });
  expect((await api.query('payment.get', { paymentId: payments.reverse })).status).toBe('refunded');
  // Reversing again reports the same refund and sends nothing more.
  const again = await (await refunder('owner', merchantId)).mutate('payment.reverse', { paymentId: payments.reverse });
  expect(again).toMatchObject({ used: 'refund', payment: { refundedAmount: dec('25') } });
  expect(await refundsOf(payments.reverse)).toHaveLength(1);
});

test(`${J} #7 selects several payments and refunds in bulk: each runs once and the report names the ones refused`, async ({ page }) => {
  test.setTimeout(300_000);
  const { payments } = journey();
  await signIn(page, 'owner', '/pay/payments');
  // The three TEST 8 bulk payments, and the spent one (nothing left), selected on Payments.
  for (const id of [...payments.bulk, payments.spent])
    await page.getByRole('checkbox', { name: new RegExp(`Select payment .*${id.slice(0, 8)}`) }).check();
  await page.getByRole('button', { name: 'Refund selected' }).click();
  await confirmItsYou(page, 'owner');
  const dialog = page.getByRole('dialog', { name: 'Refund 4 payments?' });
  await dialog.getByRole('button', { name: 'Refund all' }).click();
  const report = page.getByRole('region', { name: 'Bulk refund report' });
  await expect(report).toContainText('3 refunded, 1 refused', { timeout: 60_000 });
  await expect(report.getByRole('row').filter({ hasText: 'Refused' })).toContainText('Nothing is left to refund on this payment.');
  // Each ran once: running the same batch again refunds nothing more.
  await report.getByRole('button', { name: 'Run again' }).click();
  await expect(report).toContainText('3 refunded, 1 refused', { timeout: 60_000 });
  for (const id of payments.bulk) {
    const refunds = await refundsOf(id);
    expect(refunds, id).toHaveLength(1);
    expect(refunds[0].amount).toEqual(dec('8'));
  }
});
