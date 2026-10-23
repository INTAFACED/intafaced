import path from 'node:path';
import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, ROOT, fund, journeyState, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-wallet-05, in the running app (docs/roadmap/journeys.json): I withdraw crypto. Run in order on one verified TEST
// account with an authenticator app, TEST 300 USDT and 5 USDC, and one saved wallet past its cooling-off. The fee, the
// quote lifetime and the limits are the TEST withdrawal terms the stack's founders publish in svc-pay
// (`local-test-gates.mjs withdraw-terms`): a fixed 1.5 fee on TEST Ethereum and TEST Base, fee on top, a 90-second
// quote, and USDT limits of 100 per withdrawal and 200 a day for verified accounts; USDC has none. The cooling-off wait
// is stood in for by `local-test-stack.mjs age-addresses`. Not here yet: #1 (minimum, maximum, step and tag rules have
// no catalogue in svc-pay), #2 (the fraud list and screening at send), #4's two parallel sends (every send is refused
// before a claim while no custody signer is connected), #5 (travel rule), #6 (a sent withdrawal and its success panel)
// and #8 (status: nothing is recorded while every send is refused).
const J = 'J-wallet-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

test.describe.configure({ mode: 'default' });

function account() {
  const state = run.read();
  if (!state.account) throw new Error(`${J} made no account, so this step has no one to act as`);
  return state;
}

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** The next authenticator code after the last one this run used, so no code is used twice. */
async function freshCode() {
  const state = account();
  const { totp } = await totpLib();
  const { code, step } = await nextCode(totp, state.secret, state.step);
  run.reset({ ...state, step });
  return code;
}

async function signInWithCode(page) {
  const state = account();
  const code = await freshCode();
  await page.goto('/login');
  await page.fill('input[name=totp]', code);
  await page.fill('input[name=identifier]', state.account.email);
  await page.fill('input[name=password]', state.account.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Answers the "Confirm it's you" dialog with the next authenticator code. */
async function confirmItsMe(page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Authenticator code or recovery code').fill(await freshCode());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
}

/** The customer's own reads through Edge, signed in with the password and an authenticator code. */
async function customerApi() {
  const state = account();
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: state.account.email, password: state.account.password, totpCode: await freshCode() }),
  }).then((res) => res.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in refused: ${JSON.stringify(login).slice(0, 300)}`);
  const get = async (route) => {
    const res = await fetch(`${EDGE}${route}`, { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  };
  return {
    async available(asset) {
      const { status, body } = await get('/api/v1/account/balance');
      if (status !== 200) throw new Error(`balance read refused: ${status}`);
      return body.balances[asset]?.free ?? '0';
    },
    async withdrawals() {
      const { status, body } = await get(`/api/pay/trpc/withdrawal.mine?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`);
      if (status !== 200) throw new Error(`withdrawal list refused: ${status}`);
      return body.result.data;
    },
  };
}

const form = (page) => page.getByTestId('withdraw-form');
/** A field of the Withdraw form by its own label (each hint sits inside the label, so a plain label match is ambiguous). */
const field = (page, name) =>
  form(page)
    .locator('label.field', { has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) })
    .locator('input, select');

/** Opens Withdraw with USDT on its default network, the saved TEST wallet chosen and `amount` typed. */
async function fillSend(page, amount) {
  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  await field(page, 'Asset').selectOption('USDT');
  await expect(field(page, 'Network')).toHaveValue('ethereum');
  const saved = field(page, 'Saved address');
  await expect(saved.locator('option', { hasText: 'TEST send wallet' })).toHaveText('TEST send wallet · 0x5290…9EE7 · Ready to use');
  await saved.selectOption({ label: 'TEST send wallet · 0x5290…9EE7 · Ready to use' });
  await field(page, 'Amount').fill(amount);
}

test(`${J} starts: a verified TEST account with 300 USDT, a second factor and a saved wallet past its cooling-off`, async ({ page }) => {
  test.setTimeout(240_000);
  tool('local-test-gates.mjs', 'withdraw-terms');
  const who = await signUp(page, 'wd');
  await verify(page, who);
  await signIn(page, who);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ account: who, secret, step });
  expect(fund(who.email, 'USDT', '300').tx).toBeTruthy();
  expect(fund(who.email, 'USDC', '5').tx).toBeTruthy();

  await page.goto('/uc/withdraw/address');
  const add = page.getByRole('form', { name: 'Add an address' });
  const addField = (name) =>
    add.locator('label.field', { has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) }).locator('input, select');
  await addField('Label').fill('TEST send wallet');
  await addField('Asset').selectOption('USDT');
  await addField('Network').selectOption('ethereum');
  await addField('Address').fill(ADDRESS);
  await add.getByRole('button', { name: 'Save address' }).click();
  await confirmItsMe(page);
  await expect(page.getByText('TEST send wallet was saved to your address book.')).toBeVisible();
  expect(tool('local-test-stack.mjs', 'age-addresses', who.email, '25')).toContain('1 saved address(es)');
  await page.reload();
  await expect(page.locator('tbody tr', { hasText: 'TEST send wallet' })).toContainText('Ready to use');
});

test(`${J} #3 reads the fee quote: fee, what arrives and the total debit as exact decimals, and an expired quote must be got again`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInWithCode(page);
  await fillSend(page, '25');
  const fee = page.getByTestId('withdraw-fee');
  const review = page.getByTestId('withdraw-review');
  const confirm = page.getByRole('button', { name: 'Confirm and send' });
  await expect(fee).toContainText('Get the fee to see it');
  await expect(confirm).toBeDisabled();

  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(fee).toContainText('1.5 USDT');
  await expect(review).toContainText('Network fee1.5 USDT');
  await expect(review).toContainText('Arrives25 USDT');
  await expect(review).toContainText('Leaves your balance26.5 USDT');
  await expect(page.getByText('The fee is added to the amount.')).toBeVisible();
  await expect(confirm).toBeEnabled();

  // A changed amount drops the quote: no fee is shown for terms it was not quoted for.
  await field(page, 'Amount').fill('26');
  await expect(fee).toContainText('Get the fee to see it');
  await expect(confirm).toBeDisabled();

  // The TEST quote lives 90 seconds. Once it has expired, confirm goes off until the fee is got again.
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(review).toContainText('Leaves your balance27.5 USDT');
  await expect(page.getByText('This quote has expired. Get the fee again.')).toBeVisible({ timeout: 120_000 });
  await expect(confirm).toBeDisabled();
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(review).toContainText('Leaves your balance27.5 USDT');
  await expect(confirm).toBeEnabled();
});

test(`${J} limit line: the allowance for the account's level, an amount above it refused at the field, a blank limit refused`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  await fillSend(page, '150');
  const limit = page.getByTestId('withdraw-limit');
  await expect(limit).toContainText('You can send up to 100 USDT now: 100 per withdrawal, and 200 of 200 left in the last 24 hours.');
  await expect(form(page).locator('#withdraw-amount-help')).toHaveText('That is above what you can send now: 100 USDT.');
  await expect(page.getByRole('button', { name: 'Get the fee' })).toBeDisabled();

  // USDC has no TEST limit: the line refuses in words and nothing can be quoted or sent.
  await field(page, 'Asset').selectOption('USDC');
  await expect(limit).toContainText('No withdrawal limit is set for your account level and this asset, so nothing can be sent.');
  await field(page, 'Amount').fill('1');
  await expect(page.getByRole('button', { name: 'Confirm and send' })).toBeDisabled();
});

test(`${J} #7 confirms with a fresh step-up while no signer is connected: refused by name, nothing held, the balance still reads 300`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInWithCode(page);
  await fillSend(page, '25');
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(page.getByTestId('withdraw-review')).toContainText('Leaves your balance26.5 USDT');
  await page.getByRole('button', { name: 'Confirm and send' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' })).toContainText('Sending money out needs a fresh confirmation.');
  await confirmItsMe(page);

  const outcome = page.getByTestId('withdraw-outcome');
  await expect(outcome).toContainText('Not sent');
  await expect(outcome).toContainText(
    'Sending out of INTAFACED isn’t connected: no custody signer is set up, so every withdrawal is refused before anything is held.',
  );
  await expect(outcome).toContainText('Nothing was sent and nothing is held. Your available balance is 300 USDT.');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The ledger agrees: nothing left the available balance, and svc-pay recorded no withdrawal.
  const api = await customerApi();
  expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
  expect(await api.withdrawals()).toEqual([]);
  await page.reload();
  await expect(page.getByText('No withdrawals yet')).toBeVisible();
});
