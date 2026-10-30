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

/** The owner's own pay API through Edge, with a session of its own and its authenticator's next code. `as` names the
 * saved person to act as: the owner, or `foreign`, the owner of a second TEST business. */
async function ownerApi(state, as = 'owner') {
  const totp = await totpOf();
  const owner = { ...state[as] };
  const code = async () => {
    const next = await nextCode(totp, owner.secret, owner.step);
    owner.step = next.step;
    run.write({ [as]: saved(owner) });
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
    if (!res.ok || !json?.result) {
      throw Object.assign(new Error(`${route} refused: ${res.status} ${text.slice(0, 400)}`), {
        status: res.status,
        // The typed code leads the message, alone or before a colon and its detail.
        typed: /^([a-z0-9]+\.[a-z0-9_]+)(?::|$)/.exec(json?.error?.message ?? '')?.[1] ?? null,
      });
    }
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

test(`${J} #1 opens Payments on an account with none: "No payments yet", how the first payment appears, and a link to make a payment link`, async ({
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
  // The row's own words: "No payments yet", then how the first payment appears.
  await expect(page.getByRole('heading', { name: 'No payments yet' })).toBeVisible();
  await expect(
    page.getByText('Your first payment starts here. Create a payment link. Payments will appear here once a customer pays.'),
  ).toBeVisible();
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

/** A teammate signs in to the portal through the form, and the code's time step is kept for the next sign-in. */
async function signInAs(page, state, as, destination) {
  const who = { ...state[as], totp: await totpOf() };
  await signInWithCode(page, who, destination);
  run.write({ [as]: saved(who) });
  return who;
}

/** The team member `as` holds `role` on the journey's business: invited by the owner, accepted by that person. A retried
 * step finds the membership where its first run left it. */
async function onTeam(state, as, role) {
  const mate = await ownerApi(state, as);
  const member = await mate.query('merchantOps.team.me', {}).catch(() => null);
  if (member?.merchantId !== state.merchantId) {
    let invitation = (await mate.query('merchantOps.team.myInvitations', {})).find((i) => i.merchantId === state.merchantId);
    if (!invitation) {
      const owner = await ownerApi(journey());
      await owner.mutate('merchantOps.team.invite', { userId: state[as].userId, role });
      invitation = (await mate.query('merchantOps.team.myInvitations', {})).find((i) => i.merchantId === state.merchantId);
    }
    expect(invitation?.role, `${as} was invited as ${role}`).toBe(role);
    await mate.mutate('merchantOps.team.acceptInvite', { memberId: invitation.memberId });
  }
  const me = await mate.query('merchantOps.team.me', {});
  expect(me).toMatchObject({ merchantId: state.merchantId, role });
  return mate;
}

test(`${J} #3 saves a view with chosen columns: reopening restores filter and columns; a viewer sees the email masked and Unmask is absent; finance with the permission asks for a reason and an audit line is written`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const state = journey();
  const paidId = state.payments?.paid;
  expect(paidId, `${J} #2 made the TEST payments this step reads`).toBeTruthy();

  // Two teammates, each a person of their own: a viewer and a finance member.
  for (const [as, prefix] of [
    ['viewer', 'm5v'],
    ['finance', 'm5f'],
  ]) {
    if (journey()[as]?.secret) continue;
    const who = await businessReadyPerson(page, prefix, '/pay/onboarding');
    await forgetSession(page);
    run.write({ [as]: saved(who) });
  }
  const viewerApi = await onTeam(journey(), 'viewer', 'viewer');
  const financeApi = await onTeam(journey(), 'finance', 'finance');

  // The payer's email is the one on the TEST invoice the first paid payment settled.
  const owner = await ownerApi(journey());
  const email = `ada.${state.stamp.toLowerCase()}@example.test`;
  const invoice = await owner.mutate('merchantOps.invoices.create', {
    requestId: uuidOf(`${J}:invoice:${state.stamp}`),
    assetId: 'USDT',
    amount: '10.00',
    customerRef: 'TEST-cust-ada',
    customerEmail: email,
    description: 'TEST invoice the first payment paid',
  });
  if (invoice.status !== 'paid')
    await owner.mutate('merchantOps.invoices.markPaidByPayment', {
      requestId: uuidOf(`${J}:invoice-paid:${state.stamp}`),
      invoiceId: invoice.id,
      paymentId: paidId,
    });

  // The owner saves a shared view: captured payments, with the payer email in place of method and created.
  const viewName = `TEST captured ${state.stamp}`;
  const chosen = ['Payment', 'Amount', 'Status', 'Payer email'];
  const chosenIds = ['payment', 'amount', 'status', 'customerEmail'];
  await signInOwner(page, journey(), '/pay/payments');
  const refused = refusedPayCalls(page);
  const headers = page.locator('.pe-table thead th');
  const rows = page.locator('.pe-table tbody tr');
  await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
  await expect(headers.filter({ hasText: 'Method' })).toHaveCount(1);
  await page.getByLabel('Status').selectOption('captured');
  await expect(page).toHaveURL(/status=captured/);
  await page.getByRole('button', { name: 'Columns' }).click();
  const columnsBox = page.getByRole('group', { name: 'Columns on the list' });
  await columnsBox.getByLabel('Method').uncheck();
  await columnsBox.getByLabel('Created').uncheck();
  await columnsBox.getByLabel('Payer email').check();
  await expect(headers).toHaveText([...chosen, 'Open']);
  await page.getByRole('button', { name: 'Save view' }).click();
  const saveDialog = page.getByRole('dialog');
  await saveDialog.getByLabel('View name').fill(viewName);
  await saveDialog.getByLabel('Share with the team').check();
  await saveDialog.getByRole('button', { name: 'Save view' }).click();
  await expect(saveDialog).toBeHidden();
  // The service keeps exactly the filter and the columns chosen, as a shared view.
  const kept = (await owner.query('payment.views.list', { limit: 200 })).items.find((v) => v.name === viewName);
  expect(kept, 'the service kept the view').toBeTruthy();
  expect(kept).toMatchObject({ visibility: 'shared', filters: { status: 'captured' }, columns: chosenIds, mine: true });

  // Reopening Payments clean, then choosing the view, puts the filter and the columns back.
  await page.goto('/pay/payments');
  await expect(page.getByLabel('Status')).toHaveValue('');
  await expect(headers.filter({ hasText: 'Method' })).toHaveCount(1);
  await page.getByLabel('Saved views').selectOption({ label: `${viewName} (shared)` });
  await expect(page.getByLabel('Status')).toHaveValue('captured');
  await expect(page).toHaveURL(new RegExp(`status=captured.*cols=${chosenIds.join('%2C')}|cols=${chosenIds.join('%2C')}.*status=captured`));
  await expect(headers).toHaveText([...chosen, 'Open']);
  // The rows are the service's own captured payments, matched one by one by payment id.
  const captured = await owner.query('payment.list', { merchantId: state.merchantId, status: 'captured', limit: 25 });
  expect(captured.items.length).toBeGreaterThan(0);
  await expect(rows).toHaveCount(captured.items.length);
  const shownIds = async () =>
    (await rows.locator('a[href^="/pay/payments/"]').evaluateAll((links) => links.map((a) => a.getAttribute('href'))))
      .map((href) => decodeURIComponent(href.replace('/pay/payments/', '')))
      .filter((id, i, all) => all.indexOf(id) === i)
      .sort();
  const capturedIds = captured.items.map((p) => p.id).sort();
  expect(capturedIds).toContain(paidId);
  expect(await shownIds(), 'the rows are the service captured payments').toEqual(capturedIds);
  // A reload keeps the view on: its filter, its columns and the same rows.
  await page.reload();
  await expect(page.getByLabel('Saved views')).toHaveValue(kept.id);
  await expect(page.getByLabel('Status')).toHaveValue('captured');
  await expect(headers).toHaveText([...chosen, 'Open']);
  await expect(rows).toHaveCount(capturedIds.length);
  expect(await shownIds()).toEqual(capturedIds);
  expect(refused, 'the owner was refused nothing').toEqual([]);

  // A viewer opens the team's shared view: the email is the service's masked value, and there is no Unmask.
  const viewerRow = (await viewerApi.query('payment.list', { merchantId: state.merchantId, status: 'captured', limit: 25 })).items.find(
    (p) => p.id === paidId,
  );
  expect(viewerRow?.customerEmail, 'the service masks the email for a viewer').toMatch(/^a\*\*\*@e\*\*\*\.test$/);
  expect(viewerRow.customerEmail).not.toBe(email);
  expect(viewerRow.railRef === null || viewerRow.railRef.startsWith('***'), 'a viewer reads the rail reference masked').toBe(true);
  await forgetSession(page);
  await signInAs(page, journey(), 'viewer', '/pay/payments');
  await page.getByLabel('Saved views').selectOption({ label: `${viewName} (shared)` });
  await expect(headers).toHaveText([...chosen, 'Open']);
  await expect(page.getByTestId('payer-email-masked').filter({ hasText: viewerRow.customerEmail })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Unmask' })).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(email);
  // The payment's own page has no Unmask for the viewer either, and never the clear email.
  await page.goto(`/pay/payments/${encodeURIComponent(paidId)}`);
  await expect(page.locator('.pp-detail-head')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unmask' })).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(email);
  // The service refuses a viewer's unmask too, with its typed code, and the audit and the view read back unchanged.
  // Who holds the permission, as the service's role catalogue (the one the team settings page reads) states it.
  const catalogue = await owner.query('merchantOps.permissions.catalogue', {});
  const grants = (role) => catalogue.roles.find((r) => r.role === role)?.grants ?? [];
  expect(grants('finance'), 'finance holds payments.unmask').toContain('payments.unmask');
  expect(grants('viewer'), 'a viewer does not').not.toContain('payments.unmask');
  // Fresh sessions for the two API refusals: the ones minted at the start may have outlived their access token by now.
  const viewerNow = await ownerApi(journey(), 'viewer');
  const financeNow = await ownerApi(journey(), 'finance');
  expect(await viewerNow.query('merchantOps.team.me', {})).toMatchObject({ merchantId: state.merchantId, role: 'viewer' });
  expect(await financeNow.query('merchantOps.team.me', {})).toMatchObject({ merchantId: state.merchantId, role: 'finance' });
  const readsBefore = await owner.query('payment.unmaskReads', { paymentId: paidId, limit: 50 });
  const viewsBefore = await owner.query('payment.views.list', { limit: 200 });
  const viewerAsk = await viewerNow
    .mutate('payment.unmask', { paymentId: paidId, field: 'customerEmail', reason: 'TEST viewer asks' })
    .then(
      () => null,
      (err) => err,
    );
  expect(viewerAsk, 'the service refused the viewer').not.toBeNull();
  expect(viewerAsk.typed, viewerAsk.message).toBe('pay.team_role_forbidden');
  expect(await owner.query('payment.unmaskReads', { paymentId: paidId, limit: 50 }), 'a refused unmask writes no audit line').toEqual(
    readsBefore,
  );
  expect(
    (await viewerNow.query('payment.list', { merchantId: state.merchantId, status: 'captured', limit: 25 })).items.find(
      (p) => p.id === paidId,
    )?.customerEmail,
    'the email stays masked for the viewer after the refusal',
  ).toBe(viewerRow.customerEmail);
  expect(await owner.query('payment.views.list', { limit: 200 }), 'the views read back unchanged').toEqual(viewsBefore);

  // The service holds finance to a reason too: none, or a short one, is refused with its typed code and audits nothing.
  for (const short of ['', '  short ']) {
    const ask = await financeNow.mutate('payment.unmask', { paymentId: paidId, field: 'customerEmail', reason: short }).then(
      () => null,
      (err) => err,
    );
    expect(ask, `finance was refused for the reason ${JSON.stringify(short)}`).not.toBeNull();
    expect(ask.typed, ask.message).toBe('pay.payment_unmask_reason_required');
  }
  expect(await owner.query('payment.unmaskReads', { paymentId: paidId, limit: 50 }), 'a refused reason writes no audit line').toEqual(
    readsBefore,
  );

  // Finance unmasks: the review asks for a reason first, then shows the email in full.
  await forgetSession(page);
  const finance = await signInAs(page, journey(), 'finance', '/pay/payments');
  await page.getByLabel('Saved views').selectOption({ label: `${viewName} (shared)` });
  const paidRow = rows.filter({ has: page.getByTestId('payer-email-masked') });
  await expect(paidRow).toHaveCount(1);
  await paidRow.getByRole('button', { name: 'Unmask' }).click();
  const unmask = page.getByRole('dialog');
  const confirm = unmask.getByRole('button', { name: 'Unmask' });
  await expect(confirm).toBeDisabled();
  await expect(unmask.getByText('Give a reason of at least 8 characters.')).toBeVisible();
  const reason = `TEST payer asked for a receipt ${state.stamp}-${Date.now()}`;
  await unmask.getByLabel('Reason *').fill(reason);
  await expect(confirm).toBeEnabled();
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/api/pay/trpc/payment.unmask'));
  await confirm.click();
  const response = await answered;
  expect(response.status(), 'the service answered the unmask').toBe(200);
  const body = await response.json();
  const unmasked = body?.result?.data?.json ?? body?.result?.data;
  // The clear value is the service's own answer, and it is the email on the paid invoice.
  expect(unmasked).toMatchObject({ paymentId: paidId, field: 'customerEmail', value: email });
  await expect(page.getByTestId('payer-email-clear')).toHaveText(unmasked.value);

  // The audit line: who, which payment, which field, why; and the business's activity feed shows it.
  const reads = await owner.query('payment.unmaskReads', { paymentId: paidId, limit: 50 });
  const line = reads.items.find((r) => r.id === unmasked.auditId);
  expect(line, 'the audit line the unmask answered with').toMatchObject({
    paymentId: paidId,
    field: 'customerEmail',
    actorId: finance.userId,
    actorRole: 'finance',
    reason,
  });
  expect(reads.items.length, 'exactly one more audit line than before the viewer was refused').toBe(readsBefore.items.length + 1);
  const activity = await owner.query('merchantOps.activity.list', { limit: 50, action: 'payment.unmasked' });
  expect(
    activity.items.some((a) => a.id === unmasked.auditId && a.objectId === paidId && a.actorId === finance.userId),
    'the activity feed names the unmask',
  ).toBe(true);
  expect(refused).toEqual([]);
});

/** One fact's value in a facts list: the `dd` under the `dt` with exactly this label. */
const fact = (section, label) =>
  section
    .locator('[data-testid="pp-facts"] > div')
    .filter({ has: section.page().locator('dt').getByText(label, { exact: true }) })
    .locator('dd');

/** The status word in a payment page's header. */
const statusWord = (page) => page.locator('.pp-detail-head [data-testid="pp-chip"]');

/** The typed code a pay read refused with. A read that answers is the step's failure. */
async function refusalOf(read) {
  const answered = await read.then(
    () => null,
    (err) => err,
  );
  expect(answered, 'the read was refused').not.toBeNull();
  return answered.typed;
}

test(`${J} #4 opens one payment: facts, amounts, timeline, linked refunds and the dispute card, never the payer's instrument, a count while it waits for confirmations; an unknown or foreign id reads as not found`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  const state = journey();
  const ids = state.payments;
  expect(ids?.refunded, `${J} #2 made the TEST payments this step reads`).toBeTruthy();

  // A second TEST business with a paid payment of its own: its id is the foreign id this business must not read.
  if (!state.foreign?.secret || !state.foreignMerchantId) {
    const other = await businessReadyPerson(page, 'm5x', '/pay/onboarding');
    const foreignMerchantId = await openBusiness(page, other, 'TEST Other Shop Ltd');
    await verifiedBusiness(page, other, foreignMerchantId);
    await forgetSession(page);
    run.write({ foreign: saved(other), foreignMerchantId });
  }
  const foreignApi = await ownerApi(journey(), 'foreign');
  const foreignPaid = await cardPayment(foreignApi, journey().foreignMerchantId, {
    amount: '5.00',
    reference: `TEST-${state.stamp}-foreign`,
    want: 'captured',
  });
  expect(
    (await foreignApi.query('payment.get', { paymentId: foreignPaid.id })).status,
    'the foreign payment exists for its own business',
  ).toBe('captured');

  // A TEST crypto payment whose one transfer is 2 confirmations deep of the stack's 6: the page counts it while it
  // waits, then drops the count once the transfer is final.
  const owner = await ownerApi(journey());
  const waiting = await owner.mutate('payment.create', {
    // A fresh payment per attempt: a retried step must not find the one its first attempt already completed.
    requestId: uuidOf(`${J}:payment:confirming:${state.merchantId}:${Date.now()}`),
    merchantId: state.merchantId,
    amount: '7.00',
    assetId: 'USDT',
    method: 'crypto',
    railAdapter: 'crypto-native',
    metadata: { reference: `TEST-${state.stamp}-confirming` },
  });
  const opened = waiting.status === 'created' ? await owner.mutate('payment.authorize', { paymentId: waiting.id }) : waiting;
  expect(opened.railRef, 'the crypto rail gives the payment its address').toBeTruthy();
  const tx = `j-merchant-05-confirming-${waiting.id}`;
  tool('local-test-stack.mjs', 'chain-deposit', opened.railRef, 'USDT', '7', '2', '--tx', tx);
  expect((await owner.mutate('payment.authorize', { paymentId: waiting.id })).status).toBe('created');
  await signInOwner(page, journey(), `/pay/payments/${ids.refunded}`);
  const refused = refusedPayCalls(page);
  const section = (name) => page.locator('section.pay-section').filter({ has: page.getByRole('heading', { name, level: 2 }) });
  // Each payment's status word is the one the page's vocabulary gives the status the service reads back.
  const WORD = {
    created: 'Created',
    authorized: 'Authorised',
    captured: 'Paid',
    settled: 'Settled',
    refunded: 'Refunded',
    disputed: 'Disputed',
    failed: 'Failed',
  };
  const showsItsStatus = async (paymentId, expected) => {
    const read = await owner.query('payment.get', { paymentId });
    expect(read.status, `payment ${paymentId} is ${expected}`).toBe(expected);
    await expect(statusWord(page)).toHaveText(WORD[expected]);
    return read;
  };

  // A timeline step's words for each kind of event in the service's history (the page's vocabulary).
  const STEP = {
    created: 'Payment created',
    authorized: 'Authorised',
    captured: 'Money taken',
    settled: 'Added to a settlement',
    refunded: 'Refunded',
    'refund.reversed': 'A refund did not go through and was put back',
    disputed: 'Customer disputed the payment',
    failed: 'The payment did not go through',
    'payer_name.held': 'Bank transfer held for a name check',
  };
  const REFUND_WORD = { posted: 'Refund sent', settled: 'Refund settled', reversed: 'Refund reversed' };
  /** The page's Timeline lists the payment's history from the service, oldest first, one step per event it names. */
  const showsItsTimeline = async (paymentId) => {
    const events = await owner.query('payment.history', { paymentId, limit: 200 });
    const expected = events
      .filter((e) => STEP[e.event])
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
      .map((e) => STEP[e.event]);
    expect(expected.length, `payment ${paymentId} has a history`).toBeGreaterThan(1);
    await expect(section('Timeline').getByRole('list', { name: 'Timeline' }).getByRole('listitem').locator('strong')).toHaveText(expected);
    return expected;
  };

  // The payment refunded in part: its facts and amounts, each read back from the service, and its timeline.
  const refundedRead = await showsItsStatus(ids.refunded, 'captured');
  const summary = section('Summary');
  await expect(summary).toBeVisible();
  // Decimal strings, compared as scaled whole cents (the wire drops trailing zeros).
  const cents = (v) => BigInt(Math.round(Number(v) * 100));
  expect([refundedRead.amount, refundedRead.capturedAmount, refundedRead.refundedAmount].map(cents)).toEqual([10000n, 10000n, 3000n]);
  await expect(fact(summary, 'Amount')).toHaveText(/^100\.00\s*USDT$/);
  await expect(fact(summary, 'Paid')).toHaveText(/^100\.00\s*USDT$/);
  await expect(fact(summary, 'Refunded')).toHaveText(/^30\.00\s*USDT$/);
  await expect(fact(summary, 'Still refundable')).toHaveText(/^70\.00\s*USDT$/);
  const facts = section('Key facts');
  await expect(fact(facts, 'Payer reference')).toHaveText('TEST-cust-ben');
  await expect(fact(facts, 'Payer reference').getByRole('link')).toHaveAttribute('href', '/pay/customers/TEST-cust-ben');
  expect(refundedRead.railAdapter).toBe('card-sandbox');
  await expect(fact(facts, 'Paid with')).toHaveText('Card');
  await expect(fact(facts, 'Created').locator('time')).toHaveAttribute('datetime', refundedRead.createdAt);
  // The timeline is the service's own history of the payment, step for step and oldest first, the refund included.
  const refundedSteps = await showsItsTimeline(ids.refunded);
  expect(refundedSteps).toContain('Refunded');
  // The refunds card is the service's refunds list for this payment: each refund's id, amount and status.
  const refundRows = (await owner.query('payment.refunds.list', { merchantId: state.merchantId, paymentId: ids.refunded, limit: 200 }))
    .items;
  expect(refundRows).toHaveLength(1);
  const [refundRow] = refundRows;
  expect([refundRow.paymentId, cents(refundRow.amount), refundRow.assetId]).toEqual([ids.refunded, 3000n, 'USDT']);
  const refundItems = section('Refunds').getByRole('listitem');
  await expect(refundItems).toHaveCount(1);
  await expect(refundItems.first()).toContainText(/^30\.00\s*USDT · /);
  await expect(refundItems.first()).toContainText(REFUND_WORD[refundRow.status]);
  await expect(refundItems.first().getByRole('link')).toHaveAttribute('href', `/pay/refunds/${encodeURIComponent(refundRow.id)}`);
  // The card the payer used never shows.
  await expect(page.locator('body')).not.toContainText('tok_ok');
  await expect(page.locator('body')).not.toContainText('tok_decline');

  // The disputed payment: its status word, the dispute card with its amount and reason, and a way to it.
  await page.goto(`/pay/payments/${ids.disputed}`);
  await showsItsStatus(ids.disputed, 'disputed');
  // The dispute card is the service's one dispute on this payment: its amount, its reason and a way to it by its id.
  const disputes = (await owner.query('merchantOps.disputes.list', { limit: 200 })).items.filter((d) => d.paymentId === ids.disputed);
  expect(disputes).toHaveLength(1);
  const [disputeRead] = disputes;
  // The stack's TEST tool labels the reason it opens the dispute with (local-test-world.mjs open-dispute).
  expect([cents(disputeRead.amount), disputeRead.assetId, disputeRead.reasonCode]).toEqual([
    1200n,
    'USDT',
    'LOCAL-TEST product_not_received',
  ]);
  const dispute = section('Dispute');
  await expect(fact(dispute, 'Amount')).toHaveText(/^12\.00\s*USDT$/);
  await expect(fact(dispute, 'Reason')).toHaveText(disputeRead.reasonCode);
  await expect(dispute.getByRole('link', { name: 'Open the dispute' })).toHaveAttribute(
    'href',
    `/pay/disputes/${encodeURIComponent(disputeRead.disputeId)}`,
  );
  expect(await showsItsTimeline(ids.disputed)).toContain('Customer disputed the payment');

  // The declined payment: one plain word for its status, and why it failed.
  await page.goto(`/pay/payments/${ids.declined}`);
  await showsItsStatus(ids.declined, 'failed');
  await expect(page.getByText('Why it failed:')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('tok_decline');

  // The crypto payment: its status word and its confirmation count while it waits, and no count once the transfer is
  // final.
  await page.goto(`/pay/payments/${waiting.id}`);
  await showsItsStatus(waiting.id, 'created');
  await expect(page.getByTestId('payment-confirmations')).toContainText('Waiting for confirmations: 2 of 6');
  tool('local-test-stack.mjs', 'chain-deposit', opened.railRef, 'USDT', '7', '6', '--tx', tx);
  await owner.mutate('payment.authorize', { paymentId: waiting.id });
  await page.reload();
  await expect(section('Timeline')).toBeVisible();
  await expect(page.getByTestId('payment-confirmations')).toHaveCount(0);
  expect(refused).toEqual([]);

  // An unknown id, and the id of the other business's payment, both refuse with the one not-found code, and the page
  // says so; an id that is not one reads as not found too.
  const unknownId = crypto.randomUUID();
  expect(await refusalOf(owner.query('payment.get', { paymentId: unknownId }))).toBe('pay.payment_not_found');
  expect(await refusalOf(owner.query('payment.get', { paymentId: foreignPaid.id }))).toBe('pay.payment_not_found');
  for (const id of [unknownId, foreignPaid.id, 'not-an-id']) {
    await page.goto(`/pay/payments/${id}`);
    await expect(page.getByText('We could not find that payment.').first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('TEST Other Shop Ltd');
    await expect(page.locator('body')).not.toContainText('5.00 USDT');
  }
});
