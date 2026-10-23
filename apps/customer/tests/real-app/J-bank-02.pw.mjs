import path from 'node:path';
import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, ROOT, fund, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-bank-02, in the running app (docs/roadmap/journeys.json): I add money to my bank balance. One test per step, titled
// "J-bank-02 #<n>", run in order on one TEST account funded with TEST 50 USDT. The stack connects no payment partner and
// no rate source (BANK_RAMP_MODE none), so this run proves the journey's other ending: every way to pay names the rail it
// needs, a request is kept refused, and nothing is charged or added. Balances are read through the person's own bank API.
// #6 links a bank account, which asks for a fresh confirmation, so it sets up an authenticator app first; every later
// sign-in through the API then sends the next code. Not here: #4 and the live credit (they need a TEST payment partner),
// #7 and #8.
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

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who) {
  const totpCode = await codeFor();
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: who.email, password: who.password, ...(totpCode ? { totpCode } : {}) }),
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

async function usdt(who) {
  const res = await (await bank(who)).query('spaces.list', { limit: 50 });
  if (!res.ok) throw new Error(`spaces.list refused: ${res.status}`);
  return res.data.find((s) => s.kind === 'primary' && s.assetId === 'USDT')?.balance;
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

test(`${J} #3 picks pay by bank: no partner page to go to, the request kept refused, and the person stays here`, async ({ page }) => {
  const who = person();
  await signIn(page, who);
  await waysToPay(page);
  const confirm = await ask(page, 'pay_by_bank');
  await expect(confirm).toContainText('approve the payment, then come back here');
  await confirm.getByRole('button', { name: 'Ask for this payment' }).click();
  await expect(page.getByTestId('add-money-refused')).toContainText('rail.bank');
  await expect(page.getByRole('link', { name: 'Go to the payment page' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/bank\/ramps\/new$/);
  expect((await requests(who)).map((r) => r.method)).toEqual(['pay_by_bank', 'bank_transfer']);
  expect(await usdt(who)).toBe('50');
});

test(`${J} #5 watches the requests: each with its amount and where it stands, and the balance untouched`, async ({ page }) => {
  const who = person();
  await signIn(page, who);
  await page.goto('/bank/ramps/new');
  const rows = page.getByTestId('add-money-request');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Pay by bank');
  await expect(rows.nth(1)).toContainText('Bank transfer');
  for (const n of [0, 1]) {
    await expect(rows.nth(n)).toContainText('20 USDT');
    await expect(rows.nth(n)).toContainText('Refused: rail.bank is switched off');
    await expect(rows.nth(n)).toContainText('bank.fiat_ramp_socket');
  }
  expect(await usdt(who)).toBe('50');
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
