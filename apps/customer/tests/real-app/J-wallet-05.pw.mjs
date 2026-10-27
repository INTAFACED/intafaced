import path from 'node:path';
import { test, expect } from '@playwright/test';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, fund, journeyState, mailedLines, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-wallet-05, in the running app (docs/roadmap/journeys.json): I withdraw crypto. One test per step, titled
// "J-wallet-05 #<n>", run in order on one verified TEST account with an authenticator app, TEST 300 USDT, and one saved
// wallet approved by its emailed link and past its cooling-off (the wait is stood in for by `local-test-stack.mjs
// age-addresses`). The fee, the quote lifetime and the limits are the TEST withdrawal terms the stack's founders publish
// in svc-pay (`local-test-gates.mjs withdraw-terms`): a fixed 1.5 network fee on TEST Ethereum and TEST Base, the fee on
// top, a 90-second quote, and USDT limits of 1000 a withdrawal and 5000 a day for verified accounts.
// Not here yet: #1 (minimum, maximum, step and tag rules have no catalogue in svc-pay), #2 (the fraud list at send), #4's
// two parallel sends, #6 (a sent withdrawal and its success panel) and #8 (status): svc-pay has
// no custody signer for any network, so every send to an outside wallet is refused before a claim. #5 (travel rule) and the
// sanctions clause of #2 wait for launch (owner decision 2026-10-27, no compliance work until then).
const J = 'J-wallet-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const LABEL = 'TEST send wallet';

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
    body: JSON.stringify({
      deviceKey: DEVICE_KEY,
      identifier: state.account.email,
      password: state.account.password,
      totpCode: await freshCode(),
    }),
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
      const { status, body } = await get(`/api/pay/trpc/withdrawal.history?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`);
      if (status !== 200) throw new Error(`withdrawal history refused: ${status}`);
      return body.result.data.items;
    },
  };
}

const form = (page) => page.getByTestId('withdraw-form');
// Each field's hint sits inside its label, so a field's name starts with its label.
const pick = (page, name) => form(page).getByRole('combobox', { name: new RegExp(`^${name}`) });
const amountBox = (page) => form(page).getByRole('textbox', { name: /^Amount/ });
const confirmSend = (page) => page.getByRole('button', { name: 'Confirm and send' });

/** Opens Withdraw with USDT on its default network, the saved TEST wallet chosen and `amount` typed. */
async function fillSend(page, amount) {
  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  await pick(page, 'Asset').selectOption('USDT');
  await expect(pick(page, 'Network')).toHaveValue('ethereum');
  const saved = pick(page, 'Saved address');
  const ready = `${LABEL} · 0x5290…9EE7 · Ready to use`;
  await expect(saved.locator('option', { hasText: LABEL })).toHaveText(ready);
  await saved.selectOption({ label: ready });
  await amountBox(page).fill(amount);
}

/** The approval link mailed to `email` once more than `seen` have been, from the stack's LOCAL-TEST outbox. */
async function approvalLink(email, seen) {
  const links = () =>
    mailedLines(email, 'withdraw-address-approval').map((line) => `/${/link=(approveAddress\?token=\S+)/.exec(line)?.[1]}`);
  await expect.poll(() => links().length, { timeout: 20_000 }).toBeGreaterThan(seen);
  return links().at(-1);
}

test(`${J} starts: a verified TEST account with 300 USDT, a second factor and a saved wallet approved and past its cooling-off`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  tool('local-test-gates.mjs', 'withdraw-terms');
  const who = await signUp(page, 'wd');
  await verify(page, who);
  await signIn(page, who);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ account: who, secret, step });
  expect(fund(who.email, 'USDT', '300').tx).toBeTruthy();

  await page.goto('/uc/withdraw/address');
  const add = page.getByRole('form', { name: 'Add an address' });
  await add.getByRole('textbox', { name: /^Label/ }).fill(LABEL);
  await add.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await add.getByRole('combobox', { name: /^Network/ }).selectOption('ethereum');
  await add.getByRole('textbox', { name: /^Address/ }).fill(ADDRESS);
  await add.getByRole('button', { name: 'Save address' }).click();
  await confirmItsMe(page);
  await expect(page.getByText(`${LABEL} was saved to your address book.`)).toBeVisible();

  // A new address waits for approval by its emailed link, opened in another browser (J-wallet-04 #5).
  const seen = mailedLines(who.email, 'withdraw-address-approval').length;
  const row = page.locator('tbody tr', { hasText: LABEL });
  await row.getByRole('button', { name: 'Withdraw to this address' }).click();
  await page.getByTestId('address-use').getByRole('button', { name: 'Email me an approval link' }).click();
  const link = await approvalLink(who.email, seen);
  const other = await browser.newContext();
  try {
    const away = await other.newPage();
    await away.goto(link);
    await away.getByRole('link', { name: 'Sign in' }).last().click();
    await away.fill('input[name=totp]', await freshCode());
    await away.fill('input[name=identifier]', who.email);
    await away.fill('input[name=password]', who.password);
    await away.getByRole('button', { name: /^sign in$/i }).click();
    await expect(away).toHaveURL(/\/approveAddress$/);
    await away.getByTestId('approve-address').getByRole('button', { name: 'Approve' }).click();
    await confirmItsMe(away);
    await expect(away.getByRole('heading', { name: 'Address approved' })).toBeVisible();
  } finally {
    await other.close();
  }

  // The cooling-off runs from the approval; the LOCAL TEST clock moves it past its end.
  expect(tool('local-test-stack.mjs', 'age-addresses', who.email, '25')).toContain('1 saved address(es)');
  await page.reload();
  await expect(page.locator('tbody tr', { hasText: LABEL })).toContainText('Ready to use');
});

test(`${J} #3 reads the fee quote: fee, what arrives and the total debit as exact decimals, and an expired quote must be got again`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInWithCode(page);
  await fillSend(page, '25');
  const fee = page.getByTestId('withdraw-fee');
  const review = page.getByTestId('withdraw-review');
  await expect(fee).toContainText('Get the fee to see it');
  await expect(page.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();

  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(fee).toContainText('1.5 USDT');
  await expect(review).toContainText('Network fee1.5 USDT');
  await expect(review).toContainText('Arrives25 USDT');
  await expect(review).toContainText('Leaves your balance26.5 USDT');
  await expect(page.getByText('The fee is added to the amount.')).toBeVisible();
  await expect(confirmSend(page)).toBeEnabled();

  // A changed amount drops the quote: no fee is shown for terms it was not quoted for.
  await amountBox(page).fill('26');
  await expect(fee).toContainText('Get the fee to see it');
  await expect(page.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();

  // The TEST quote lives 90 seconds. Once it has expired, confirm goes off until the fee is got again.
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(review).toContainText('Leaves your balance27.5 USDT');
  await expect(page.getByText('This quote has expired. Get the fee again.')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(review).toContainText('Leaves your balance27.5 USDT');
  await expect(confirmSend(page)).toBeEnabled();
});

test(`${J}, part of #4 reads the limit line: what the account's level may send now, per withdrawal and in 24 hours`, async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  await fillSend(page, '25');
  await expect(page.getByTestId('withdraw-limit')).toContainText(
    'You can send up to 1,000 USDT now: 1,000 per withdrawal, and 5,000 of 5,000 left in the last 24 hours.',
  );
});

test(`${J} #7 confirms with a fresh step-up while no signer is connected: refused by name, nothing held, the balance still reads 300`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInWithCode(page);
  await fillSend(page, '25');
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(page.getByTestId('withdraw-review')).toContainText('Leaves your balance26.5 USDT');
  await confirmSend(page).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' })).toContainText('Sending money out needs a fresh confirmation.');
  await confirmItsMe(page);

  const outcome = page.getByTestId('withdraw-outcome');
  await expect(outcome).toContainText('Not sent');
  await expect(outcome).toContainText(
    'Sending to a wallet outside INTAFACED isn’t connected: no custody signer is set up, so this withdrawal was refused before anything was held.',
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
