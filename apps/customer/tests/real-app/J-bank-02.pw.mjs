// World: none
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, fromUnits, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-bank-02, in the running app (docs/roadmap/journeys.json): I add money to my bank balance. One test per step, titled
// "J-bank-02 #<n>", run in order on one TEST account funded with TEST 50 USDT. The stack connects no real payment partner
// (BANK_RAMP_MODE none), so from DE every way to pay names the rail it needs and a request is kept refused (#1, #2).
// Balances are read through the person's own bank API. #6 links a bank account, which asks for a fresh confirmation, so
// it sets up an authenticator app first; every later sign-in through the API and in the browser then sends the next code.
// #4 asks from NL, which the stack's TEST rate stand-in prices (BANK_ONRAMP_RATES=ramp-sim; its bank-transfer price
// holds 20 seconds), and lets the price run out. #3 and #5 pay by bank from NL through the stack's TEST pay-in stand-in
// (BANK_ONRAMP_PARTNER=payin-sim, which takes no money): it answers with its own TEST payment page, where the payer
// approves and is sent back, and its signed "paid" call, made here as the partner would, credits through the deposit
// recipe. They pay as a second TEST person, who starts with nothing, so the first person's 50 USDT stays as #4 to #8
// read it. #8 runs on the stack's TEST plan, which publishes a TEST overdraft fee (a plan that allows a negative balance);
// no overdraft engine exists in this build, so the bank names it switched off and a payment to another person for more
// than the balance is refused with that rule, at the review and by the bank itself, and nothing moves.
const J = 'J-bank-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const WAYS = [
  ['bank_transfer', 'Bank transfer', 'rail.bank'],
  ['pay_by_bank', 'Pay by bank', 'rail.bank'],
  ['card', 'Card', 'rail.card'],
  ['wallet_pay', 'Wallet pay', 'rail.card'],
];

test.describe.configure({ mode: 'default' });

function person() {
  const { who } = run.read();
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

function payer() {
  const { payer: who } = run.read();
  if (!who) throw new Error(`${J} #3 made no paying account, so this step has no one to act as`);
  return who;
}

let jobCtx;
const stackCtx = () =>
  (jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} })));

/** One call of the TEST pay-in partner's signed job door, as the partner would make it: its status and its answer. */
async function partnerCall(what, body) {
  const ctx = await stackCtx();
  const raw = JSON.stringify(body);
  const res = await fetch(`${ctx.url('bank')}/internal/jobs/payin-sim/${what}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, answer: await res.json().catch(() => null) };
}

/** The partner says a payment was paid; anything but a 200 fails the step with the partner's answer. */
async function partnerPaid(body) {
  const { status, answer } = await partnerCall('paid', body);
  if (status !== 200) throw new Error(`payin-sim/paid refused: ${status} ${JSON.stringify(answer).slice(0, 300)}`);
  return answer;
}

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** The next authenticator code once #6 has set one up, keeping its step so no code is used twice; none before. */
async function codeFor() {
  const state = run.read();
  if (!state.secret) return undefined;
  const { totp } = await totpLib();
  const { code, step } = await nextCode(totp, state.secret, state.step);
  run.reset({ ...state, step });
  return code;
}

/** Signs in in the browser with the password and the next authenticator code (after #6 set one up). */
async function signInWithCode(page, who) {
  const totpCode = await codeFor();
  await page.goto('/login');
  if (totpCode) await page.fill('input[name=totp]', totpCode);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who) {
  const totpCode = await codeFor();
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, ...(totpCode ? { totpCode } : {}) }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const answer = async (res) => {
    const body = await res.json();
    if (!res.ok) return { ok: false, status: res.status, code: body?.error?.data?.intafacedCode ?? body?.error?.data?.code, body };
    return { ok: true, data: body.result.data };
  };
  return {
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
  };
}

/**
 * #8's own sign-in for `who`: the bank and identity doors on one session (a handle lookup and the step-up a payment to a
 * person asks for). `withCode: false` signs in a person with no authenticator without spending one of #6's codes.
 */
async function session(who, { withCode = true } = {}) {
  const totpCode = withCode ? await codeFor() : undefined;
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, ...(totpCode ? { totpCode } : {}) }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const answer = async (res) => {
    const body = await res.json();
    if (!res.ok) return { ok: false, status: res.status, code: body?.error?.data?.intafacedCode ?? body?.error?.data?.code, body };
    return { ok: true, data: body.result.data };
  };
  const doors = (service) => ({
    query: (procedure, input) =>
      fetch(`${EDGE}/api/${service}/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, {
        headers,
      }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/${service}/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
  });
  return { ...doors('bank'), identity: doors('identity') };
}

async function usdt(who) {
  const res = await (await bank(who)).query('spaces.list', { limit: 50 });
  if (!res.ok) throw new Error(`spaces.list refused: ${res.status}`);
  return res.data.find((s) => s.kind === 'primary' && s.assetId === 'USDT')?.balance;
}

/** The payer's USDT balance in units, a person with no USDT space yet holding none. */
async function usdtUnits(who) {
  return toUnits((await usdt(who)) ?? '0');
}

async function request(who, requestId) {
  const res = await (await bank(who)).query('addMoney.request', { requestId });
  if (!res.ok) throw new Error(`addMoney.request refused: ${res.status}`);
  return res.data;
}

/**
 * Ask for the ways to pay `amount` USDT from NL, and the pay-by-bank quote the bank answered the page with: the price the
 * row shows is the one the request is asked on.
 */
async function payByBankFromNL(page, amount) {
  await page.goto('/bank/ramps/new');
  await page.getByLabel('Add to').selectOption('USDT');
  await page.getByLabel('Amount').fill(amount);
  await page.getByLabel('Country you pay from').fill('NL');
  const answered = page.waitForResponse((res) => res.url().includes('/api/bank/trpc/addMoney.methods') && res.status() === 200);
  await page.getByRole('button', { name: 'See ways to pay' }).click();
  const methods = (await (await answered).json()).result.data.methods;
  const quote = methods.find((m) => m.method === 'pay_by_bank')?.quote;
  if (!quote) throw new Error(`no pay-by-bank price from NL: ${JSON.stringify(methods)}`);
  const row = page.getByTestId('method-pay_by_bank');
  await expect(row).toContainText('TEST price from a stand-in');
  await expect(row).toContainText('TEST payment page from a stand-in');
  return { quote, row };
}

/** Ask for the chosen way to pay and follow the redirect to the page the partner answered with. */
async function askAndGoToPage(page, who) {
  const confirm = await ask(page, 'pay_by_bank');
  await expect(confirm).toContainText('approve the payment, then come back here');
  const { url } = await stackCtx();
  const partnerPage = `${url('bank')}/test/payin-sim/pay/`;
  await confirm.getByRole('button', { name: 'Ask for this payment' }).click();
  await page.waitForURL((at) => at.href.startsWith(partnerPage));
  const [asked] = await requests(who);
  // The page is the one in the provider's response, kept on the request: nothing built it from an id.
  expect(asked).toMatchObject({ method: 'pay_by_bank', status: 'opened', onramp: { partnerRail: 'payin-sim' } });
  expect(page.url()).toBe(asked.onramp.hostedUrl);
  await expect(page.getByTestId('payin-sim-label')).toContainText(/^TEST\b/);
  return asked;
}

async function requests(who) {
  const res = await (await bank(who)).query('addMoney.requests', { limit: 50 });
  if (!res.ok) throw new Error(`addMoney.requests refused: ${res.status}`);
  return res.data;
}

/** Open Add money from the Ramps room and ask for the ways to pay TEST 20 USDT from DE. */
async function waysToPay(page) {
  await page.goto('/bank/ramps');
  await page.getByRole('link', { name: 'Add money' }).click();
  await expect(page).toHaveURL(/\/bank\/ramps\/new$/);
  await page.getByLabel('Add to').selectOption('USDT');
  await page.getByLabel('Amount').fill('20');
  await page.getByLabel('Country you pay from').fill('DE');
  await page.getByRole('button', { name: 'See ways to pay' }).click();
  await expect(page.getByTestId('add-money-ways')).toBeVisible();
}

async function ask(page, method) {
  await page.getByTestId(`method-${method}`).getByRole('radio').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  const confirm = page.getByTestId('add-money-confirm');
  await expect(confirm).toBeVisible();
  return confirm;
}

test(`${J} #1 presses Add money: every way to pay with its fee and arrival, a blank reading "not set"`, async ({ page }) => {
  const who = await signUp(page, 'jb2');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '50').tx).toBeTruthy();
  run.reset({ who });

  await signIn(page, who);
  await waysToPay(page);
  for (const [method, label, rail] of WAYS) {
    const row = page.getByTestId(`method-${method}`);
    await expect(row).toContainText(label);
    // No rate source on the stack: the fee, the arrival and the pay amount are blank, never a made-up zero.
    await expect(row.getByText('not set')).toHaveCount(3);
    await expect(row).toContainText(`Needs a partner for ${rail}. It is switched off in this build.`);
    await expect(row).toContainText('bank.fiat_ramp_socket');
  }
  await expect(page.getByTestId('add-money-ways')).not.toContainText(/fee[- ]free|0 EUR/i);
});

test(`${J} #2 picks bank transfer: the ownership rule, the rail.bank notice, and the request kept`, async ({ page }) => {
  const who = person();
  await signIn(page, who);
  await waysToPay(page);
  const confirm = await ask(page, 'bank_transfer');
  await expect(confirm).toContainText('The account you pay from must be in your name');
  await confirm.getByRole('button', { name: 'Ask for this payment' }).click();
  const refused = page.getByTestId('add-money-refused');
  await expect(refused).toContainText('This way to pay is switched off');
  await expect(refused).toContainText('rail.bank');
  await expect(refused).toContainText('bank.fiat_ramp_socket');
  // No account number is made up when no partner gave one.
  await expect(page.locator('main')).not.toContainText(/IBAN|Payment reference/);

  const kept = await requests(who);
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ method: 'bank_transfer', amount: '20', assetId: 'USDT', rail: 'rail.bank', status: 'refused' });
  // Asking again with the same request id is the same request, and nothing reached the balance.
  const again = await (
    await bank(who)
  ).mutate('addMoney.start', {
    requestId: kept[0].requestId,
    assetId: 'USDT',
    amount: '20',
    method: 'bank_transfer',
    country: 'DE',
  });
  expect(again).toMatchObject({ ok: true, data: { requestId: kept[0].requestId, status: 'refused' } });
  expect(await requests(who)).toHaveLength(1);
  expect(await usdt(who)).toBe('50');
});

test(`${J} #3 picks pay by bank: sent to the provider's page its response named, back here pending, then credited once`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'jb2pay');
  await verify(page, who);
  run.reset({ ...run.read(), payer: who });
  // The payer starts with nothing: a new account holds no currency, so they add USDT to it first (as on the Bank Overview).
  expect((await (await bank(who)).mutate('currencies.add', { assetId: 'USDT' })).ok).toBe(true);
  await signIn(page, who);
  const before = await usdtUnits(who);
  expect(before).toBe(0n);

  const { quote, row } = await payByBankFromNL(page, '20');
  // The stand-in's TEST price: 20 USDT at a TEST rate of 2 EUR plus a TEST fee of 1 EUR.
  await expect(row).toContainText(/You pay: 41(\.0+)? EUR/);
  await expect(row.getByTestId('method-receive')).toHaveText('You receive: 20 USDT');
  const asked = await askAndGoToPage(page, who);
  expect(asked.onramp.quoteId).toBe(quote.quoteId);
  await expect(page.getByTestId('payin-sim-amount')).toHaveText(`Pay ${quote.payAmount} EUR to add 20 USDT`);
  expect(await usdtUnits(who)).toBe(before);

  // The payer approves on the provider's page and is sent back here, to this request.
  await page.getByRole('button', { name: 'Approve payment' }).click();
  await page.waitForURL(`${ORIGIN}/bank/ramps/new?request=${asked.requestId}`);
  const tracker = page.getByTestId('add-money-tracker');
  await expect(tracker).toHaveAttribute('data-status', 'pending');
  await expect(tracker).toContainText('Pending: you approved it, the money is on its way');
  await expect(tracker.locator('[data-step=credited]')).toHaveAttribute('data-state', 'todo');
  await expect(page.getByTestId('tracker-credited')).toHaveCount(0);
  // Pending adds nothing.
  expect(await request(who, asked.requestId)).toMatchObject({ status: 'pending', creditedAt: null, creditedAmount: null });
  expect(await usdtUnits(who)).toBe(before);

  // The provider says the money arrived: the page, still open, turns to credited on its own.
  const paid = await partnerPaid({ requestId: asked.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' });
  expect(paid).toMatchObject({ requestId: asked.requestId, status: 'credited', creditedAmount: '20' });
  await expect(tracker).toHaveAttribute('data-status', 'credited');
  await expect(tracker.locator('[data-step=credited]')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('tracker-credited')).toHaveText('Credited: 20 USDT');
  expect(await usdtUnits(who)).toBe(before + toUnits('20'));

  // Once: the provider saying paid again is the same credit, and nothing more is added.
  const again = await partnerPaid({ requestId: asked.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' });
  expect(again).toEqual(paid);
  await page.reload();
  await expect(tracker).toHaveAttribute('data-status', 'credited');
  await expect(page.getByTestId('tracker-credited')).toHaveText('Credited: 20 USDT');
  expect(await usdtUnits(who)).toBe(before + toUnits('20'));
  const kept = await requests(who);
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ requestId: asked.requestId, status: 'credited', creditedAmount: '20' });
});

test(`${J} #4 accepts a price after it ran out: refused as expired, nothing kept, charged or added`, async ({ page }) => {
  test.setTimeout(120_000);
  const who = person();
  await signIn(page, who);
  await page.goto('/bank/ramps/new');
  await page.getByLabel('Add to').selectOption('USDT');
  await page.getByLabel('Amount').fill('20');
  await page.getByLabel('Country you pay from').fill('NL');
  await page.getByRole('button', { name: 'See ways to pay' }).click();
  const row = page.getByTestId('method-bank_transfer');
  // The stand-in's TEST price: 20 USDT at a TEST rate of 2 EUR plus a TEST fee of 1 EUR, labelled as a stand-in.
  await expect(row).toContainText('TEST price from a stand-in');
  await expect(row).toContainText(/You pay: 41(\.0+)? EUR/);
  await expect(row).toContainText(/Fee: 1(\.0+)? EUR/);
  await expect(row).toContainText('Price holds until');
  const holds = (await row.innerText()).match(/Price holds until: (.+)/)?.[1];
  // Every way it does not list stays refused by name.
  await expect(page.getByTestId('method-card')).toContainText('bank.fiat_ramp_socket');
  const confirm = await ask(page, 'bank_transfer');
  // The person stays on the review past the 20 seconds the TEST price holds, then asks.
  await page.waitForTimeout(21_000);
  await confirm.getByRole('button', { name: 'Ask for this payment' }).click();
  const refused = page.getByTestId('add-money-refused');
  await expect(refused).toContainText('The price ran out');
  await expect(refused).toContainText('nothing was asked for, kept or charged');
  await expect(refused).toContainText('bank.onramp_quote_expired');
  expect((await requests(who)).map((r) => r.method)).toEqual(['bank_transfer']);
  expect(await usdt(who)).toBe('50');
  // Asking for the ways to pay again gives a fresh price, never the one that ran out.
  await page.getByRole('button', { name: 'See ways to pay' }).click();
  await expect(row).toContainText('TEST price from a stand-in');
  await expect(row).not.toContainText(`Price holds until: ${holds}`);
});

test(`${J} #5 pays and watches the order: the tracker from created to credited, and the amount is the quote's receive amount exactly`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = payer();
  await signIn(page, who);
  const before = await usdtUnits(who);

  // An amount with decimals, so "exactly" has something to lose: the quote's receive amount is the bank's own string.
  const { quote, row } = await payByBankFromNL(page, '12.345678');
  expect(quote).toMatchObject({ assetId: 'USDT', amount: '12.345678', payCurrency: 'EUR' });
  await expect(row.getByTestId('method-receive')).toHaveText(`You receive: ${quote.amount} USDT`);
  const asked = await askAndGoToPage(page, who);
  expect(asked.onramp).toMatchObject({ quoteId: quote.quoteId, amount: quote.amount, payAmount: quote.payAmount });
  await expect(page.getByTestId('payin-sim-amount')).toHaveText(`Pay ${quote.payAmount} EUR to add ${quote.amount} USDT`);
  await page.getByRole('button', { name: 'Approve payment' }).click();
  await page.waitForURL(`${ORIGIN}/bank/ramps/new?request=${asked.requestId}`);

  // The tracker: created, sent to the payment page and pending, each with when; credited still waiting.
  const tracker = page.getByTestId('add-money-tracker');
  const steps = tracker.getByTestId('tracker-step');
  await expect(tracker).toHaveAttribute('data-status', 'pending');
  await expect(steps).toHaveCount(4);
  const names = ['Created', 'Sent to the payment page', 'Pending', 'Credited'];
  for (const [n, name] of names.entries()) await expect(steps.nth(n)).toContainText(name);
  for (const n of [0, 1, 2]) {
    await expect(steps.nth(n)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(n)).not.toContainText('Waiting');
  }
  await expect(steps.nth(3)).toHaveAttribute('data-state', 'todo');
  await expect(steps.nth(3)).toContainText('Waiting');
  await expect(page.getByTestId('tracker-receive')).toHaveText(`You receive: ${quote.amount} USDT`);

  // A "paid" for any other amount than the payment opened credits nothing.
  const short = fromUnits(toUnits(quote.payAmount) - 1n);
  const wrong = await partnerCall('paid', { requestId: asked.requestId, paidAmount: short, payCurrency: 'EUR' });
  expect(wrong).toMatchObject({ status: 400, answer: { code: 'bank.onramp_paid_mismatch' } });
  expect(await usdtUnits(who)).toBe(before);

  // Paid: the tracker reaches credited on its own, with the quote's receive amount exactly.
  await partnerPaid({ requestId: asked.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' });
  await expect(tracker).toHaveAttribute('data-status', 'credited');
  for (const n of [0, 1, 2, 3]) {
    await expect(steps.nth(n)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(n)).not.toContainText('Waiting');
  }
  await expect(tracker).toContainText('Credited');
  await expect(page.getByTestId('tracker-credited')).toHaveText(`Credited: ${quote.amount} USDT`);
  const done = await request(who, asked.requestId);
  expect(done.creditedAmount).toBe(quote.amount);
  // Each step happened after the one before it.
  const at = [done.createdAt, done.openedAt, done.pendingAt, done.creditedAt].map((t) => Date.parse(t));
  expect(at.every((t, n) => Number.isFinite(t) && (n === 0 || t >= at[n - 1]))).toBe(true);
  // The balance moved by the receive amount, to the last unit.
  expect((await usdtUnits(who)) - before).toBe(toUnits(quote.amount));
  // The request list says the same.
  const listed = page.getByTestId('add-money-request').first();
  await expect(listed).toContainText('Pay by bank');
  await expect(listed).toContainText(`${quote.amount} USDT`);
  await expect(listed).toContainText('Credited');
});

test(`${J} #6 links an external bank account: listed unverified with rail.bank, and it cannot be used`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = person();
  await signIn(page, who);
  // Linking changes where money can be paid out, so it asks for a fresh confirmation: set up an authenticator first.
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ ...run.read(), secret, step });

  await page.goto('/bank/ramps');
  await page.getByRole('link', { name: 'Linked bank accounts' }).click();
  await expect(page).toHaveURL(/\/bank\/ramps\/accounts$/);
  await expect(page.getByRole('heading', { name: 'Linked bank accounts', level: 1 })).toBeVisible();
  await expect(page.getByText('You have no linked bank account.')).toBeVisible();

  const form = page.getByRole('form', { name: 'Link a bank account' });
  await form.getByLabel('Name for this account').fill('TEST salary account');
  await form.getByLabel('Account holder').fill('TEST Holder');
  // A changed check digit is refused at the field, before any code is asked for.
  await form.getByLabel('IBAN', { exact: true }).fill('GB82 WEST 1234 5698 7654 33');
  await form.getByRole('button', { name: 'Link account' }).click();
  await expect(form).toContainText('This IBAN does not pass its check digits');
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' })).toHaveCount(0);

  // TEST: the standard example IBAN, not a customer's account.
  await form.getByLabel('IBAN', { exact: true }).fill('GB82 WEST 1234 5698 7654 32');
  await form.getByRole('button', { name: 'Link account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  const next = await nextCode(totp, secret, step);
  run.reset({ ...run.read(), step: next.step });
  await dialog.getByLabel('Authenticator code or recovery code').fill(next.code);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(form).toContainText('Linked TEST salary account. It is unverified.');

  const row = page.getByTestId('linked-accounts').locator('tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('TEST salary account');
  await expect(row).toContainText('GB82 •••• 5432');
  await expect(row).toContainText('Unverified');
  await expect(row).toContainText('No. Only a banking partner can verify it, and rail.bank is switched off in this build.');
  await expect(row).toContainText('bank.linked_account_unverified');
  await expect(page.getByTestId('linked-accounts')).not.toContainText('WEST1234');

  // The bank says the same, and a session without the fresh confirmation cannot link one.
  const api = await bank(who);
  const listed = await api.query('linkedAccounts.list', undefined);
  expect(listed.ok && listed.data.accounts).toEqual([
    expect.objectContaining({
      state: 'unverified',
      usable: false,
      blocker: 'bank.linked_account_unverified',
      verificationRail: 'rail.bank',
    }),
  ]);
  const plain = await api.mutate('linkedAccounts.link', { label: 'TEST other', holderName: 'TEST Holder', iban: 'DE89370400440532013000' });
  expect(plain).toMatchObject({ ok: false, status: 403 });
  expect((await api.query('linkedAccounts.list', undefined)).data.accounts).toHaveLength(1);
  expect(await usdt(who)).toBe('50');
});

test(`${J} #7 reads incoming payments: when each arrived, that it is available, and returns and refusals in plain words`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = person();
  await signInWithCode(page, who);
  await page.goto('/bank/ramps/new');
  const incoming = page.getByTestId('incoming-payments');
  // The TEST funding is the one payment that came in; the refused requests added nothing, so they are not here.
  const lines = incoming.getByTestId('incoming-line');
  await expect(lines).toHaveCount(1);
  await expect(lines.first()).toContainText('TEST funds');
  await expect(lines.first()).toContainText('50 USDT');
  await expect(lines.first()).toContainText(/Arrived .+\. Available to use since then\./);
  const rules = page.getByTestId('incoming-rules');
  await expect(rules).toContainText('When: each way to pay shows when its money arrives');
  await expect(rules).toContainText('Available: money shown here is already in your balance.');
  await expect(rules).toContainText('Returned: if a payment is sent back, it is taken out of your balance once');
  await expect(rules).toContainText('Refused: a refused request to add money adds nothing.');
  // The refusal itself stays listed with its reason, and the balance is still 50.
  await expect(page.getByTestId('add-money-request')).toHaveCount(1);
  await expect(page.getByTestId('add-money-request').first()).toContainText('bank.fiat_ramp_socket');

  const api = await bank(who);
  const page1 = await api.query('activity.list', { limit: 20, direction: 'in', kind: ['deposit', 'welcome_funds', 'transfer_in'] });
  expect(page1.ok && page1.data.items).toEqual([expect.objectContaining({ kind: 'welcome_funds', amount: '50', asset: 'USDT' })]);
  expect(await usdt(who)).toBe('50');
});

test(`${J} #8 pays another person more than the bank holds on a plan that allows a negative balance: refused with the plan's rule, and nothing moves`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = person();
  const payee = payer();
  const api = await session(who);
  const theirs = await session(payee, { withCode: false });
  const mainOf = async (doors) =>
    (await doors.query('spaces.list', { limit: 50 })).data.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
  const main = await mainOf(api);
  expect(main.balance).toBe('50');
  const payeeBefore = (await mainOf(theirs)).balance;

  // The plan allows a negative balance: the owner's TEST terms publish an overdraft fee. No overdraft engine exists in
  // this build, so the bank names it switched off rather than claim a negative balance it cannot book.
  const terms = await api.query('accounts.features', undefined);
  expect(terms).toMatchObject({
    ok: true,
    data: { tier: 'TEST base tier', overdraftFee: '1', overdraftBlocker: 'bank.overdraft_switched_off' },
  });
  const rule =
    'Your plan, TEST base tier, allows a negative balance at an overdraft fee of 1 USDT, but the overdraft is switched off in this build: the bank does not book a balance below zero. Asking to pay more than you hold is refused and nothing moves.';

  await signInWithCode(page, who);
  await page.goto('/bank/transfers');
  const planRule = page.getByTestId('plan-rule');
  await expect(planRule).toContainText(rule);
  await expect(planRule).toContainText('Reference: bank.overdraft_switched_off');
  const sent = [];
  page.on(
    'request',
    (req) => req.method() === 'POST' && /\/api\/(bank|identity)\/trpc\/(transfers|stepUp)\./.test(req.url()) && sent.push(req.url()),
  );

  // The person pays another person 60 USDT from the 50 USDT the bank holds for them.
  await page.getByLabel('From your space').selectOption(main.id);
  await page.getByLabel('Destination').selectOption({ label: 'Another person' });
  await page.getByPlaceholder('@handle').fill(payee.handle);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText(`Paying @${payee.handle}`)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Amount \(USDT\)/).fill('60');
  await dialog.getByRole('button', { name: 'Review' }).click();
  // Refused at the review with the shortfall and the plan's rule; no code is asked for and nothing is sent.
  await expect(dialog).toContainText(
    `The amount exceeds the available quantity in this space. This is 10 USDT more than this space holds (50 USDT). ${rule} Reference: bank.overdraft_switched_off`,
  );
  await expect(dialog.getByTestId('step-up-confirm')).toHaveCount(0);
  expect(sent).toEqual([]);

  // The bank refuses the same payment itself, after the person confirms it is them: its own figures, nothing posted.
  const found = await api.identity.query('users.resolveHandle', { handle: payee.handle });
  expect(found).toMatchObject({ ok: true, data: { found: true, self: false } });
  const toUserId = found.data.userId;
  const transferId = `jb2-8-${payee.handle}`;
  const fields = { transferId, fromSpaceId: main.id, toUserId, assetId: 'USDT', amount: '60' };
  const pay = async () => {
    const begun = await api.identity.mutate('stepUp.begin', {
      scope: 'bank.step_up.transfers.toUser',
      purpose: 'transfers.toUser',
      target: toUserId,
      amount: '60',
      fields,
    });
    expect(begun.ok, JSON.stringify(begun.body ?? '').slice(0, 300)).toBe(true);
    const done = await api.identity.mutate('stepUp.complete', { challengeId: begun.data.challengeId, totpCode: await codeFor() });
    expect(done.ok, JSON.stringify(done.body ?? '').slice(0, 300)).toBe(true);
    return api.mutate('transfers.toUser', {
      transferId,
      fromSpaceId: main.id,
      toUserId,
      amount: '60',
      stepUpApprovalId: done.data.stepUpApprovalId,
    });
  };
  const refused = await pay();
  expect(refused, JSON.stringify(refused.body ?? refused).slice(0, 600)).toMatchObject({ ok: false, status: 400 });
  expect(refused.body?.error?.data?.cause?.code).toBe('bank.insufficient_funds');
  expect(refused.body?.error?.data?.spend).toMatchObject({ assetId: 'USDT', available: '50' });
  // Asking again is refused the same way: never a second attempt that lands.
  const again = await pay();
  expect(again.body?.error?.data?.cause?.code).toBe('bank.insufficient_funds');

  // Nothing moved: the payer's balance never went below zero, the payee got nothing, and no payment is listed.
  expect((await mainOf(api)).balance).toBe('50');
  expect((await mainOf(theirs)).balance).toBe(payeeBefore);
  const out = await api.query('transfers.list', { limit: 50 });
  expect(out.ok && out.data.items.filter((item) => item.kind === 'transfer_out')).toEqual([]);
});
