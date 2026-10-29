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
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #6, #4's two parallel sends: svc-pay has no custody signer for any network, so every send out is refused before a claim.
//   They run after #7, which needs the balance still at 300.
// - #8: a failed withdrawal can't be seeded on the stack yet, so its failure sentence has no row to read.
// #5 (travel rule) and the sanctions clause of #2 wait for launch (owner decision 2026-10-27, no compliance work until then).
const J = 'J-wallet-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const LABEL = 'TEST send wallet';
// The address the stack's TEST fraud list holds (svc-bank, listed by `local-test-gates.mjs withdraw-terms`, W-withdraw-03).
const FRAUD_LISTED = '0x7e5700000000000000000000000000000000fa1d';
const UNBUILT = { timeout: 5_000 };

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

/** The "Left in the last 24 hours" part of the limit line, as a whole number of USDT. */
async function leftToday(page) {
  await expect(page.getByTestId('withdraw-limit')).toContainText('left in the last 24 hours');
  const line = await page.getByTestId('withdraw-limit').innerText();
  const left = /([\d,.]+) of [\d,.]+ left in the last 24 hours/.exec(line)?.[1];
  if (!left) throw new Error(`the limit line names no 24-hour allowance: ${line}`);
  return Number(left.replaceAll(',', ''));
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

const stepUp = (page) => page.getByRole('dialog', { name: 'Confirm it’s you' });

/** Gets the fee for the send `fillSend` set up and opens the step-up, with the next authenticator code typed in. */
async function readyToConfirm(page, amount) {
  await fillSend(page, amount);
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(confirmSend(page)).toBeEnabled();
  await confirmSend(page).click();
  await stepUp(page)
    .getByLabel('Authenticator code or recovery code')
    .fill(await freshCode());
}

/** Sends `amount` USDT to the saved TEST wallet and expects it recorded. */
async function sendOut(page, amount) {
  await readyToConfirm(page, amount);
  await stepUp(page).getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByTestId('withdraw-outcome')).toContainText('Withdrawal recorded', UNBUILT);
}

/** A withdrawal written straight into svc-pay in `state` by the stack (as J-wallet-06 does); returns its id. */
function seedWithdrawal(who, state, amount, label, ...extra) {
  const out = tool('local-test-stack.mjs', 'seed-withdrawal', who.email, 'USDT', amount, '--state', state, '--ref', label, ...extra);
  const id = /^\s*withdrawal\s+([0-9a-f-]{36})$/m.exec(out)?.[1];
  expect(id, out).toMatch(/^[0-9a-f-]{36}$/);
  return id;
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

test(`${J} #1 opens Withdraw and picks asset and network: the default network with its tag rule, minimum, maximum and step from the catalogue, and a changed network checks the address again`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  await pick(page, 'Asset').selectOption('USDT');
  await expect(pick(page, 'Network')).toHaveValue('ethereum');

  // A typed address is checked on the network chosen: saved on TEST Ethereum, not saved on TEST Base.
  const typed = form(page).getByRole('textbox', { name: /^Or enter a new address/ });
  await typed.fill(ADDRESS);
  await expect(form(page)).toContainText(`This is your saved address ${LABEL}. Choose it above to send to it.`);
  await pick(page, 'Network').selectOption('base');
  await expect(form(page)).toContainText('This address is not in your address book, so nothing is sent to it.');
  await pick(page, 'Network').selectOption('ethereum');

  // The network's own rules, as the catalogue publishes them for TEST Ethereum: no tag, and a minimum, maximum and step.
  const rules = page.getByTestId('withdraw-network-rules');
  await expect(rules).toBeVisible();
  await expect(rules).toContainText('This network takes no tag or memo.');
  for (const rule of ['Minimum', 'Maximum', 'Step']) await expect(rules).toContainText(new RegExp(`${rule}\\D*[\\d.,]+ USDT`));
  await expect(form(page).getByRole('textbox', { name: /^(Tag|Memo)/ })).toHaveCount(0);
});

test(`${J} #2 picks the saved address or pastes one: a mistyped address is refused before any call, and an address on the fraud list is refused by name with nothing held`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  const writes = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/pay\//.test(request.url())) writes.push(request.url());
  });
  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  await pick(page, 'Asset').selectOption('USDT');
  await form(page)
    .getByRole('textbox', { name: /^Or enter a new address/ })
    .fill(ADDRESS.slice(0, -1));
  await expect(form(page)).toContainText('This is not a valid address. It must be 0x followed by 40 letters a to f or digits.');
  expect(writes).toEqual([]);

  // The TEST fraud list holds FRAUD_LISTED: saving it is refused with the reason, and it never reaches the address book.
  await page.goto('/uc/withdraw/address');
  const add = page.getByRole('form', { name: 'Add an address' });
  await add.getByRole('textbox', { name: /^Label/ }).fill('TEST fraud-listed wallet');
  await add.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await add.getByRole('combobox', { name: /^Network/ }).selectOption('ethereum');
  await add.getByRole('textbox', { name: /^Address/ }).fill(FRAUD_LISTED);
  await add.getByRole('button', { name: 'Save address' }).click();
  const refusal = add.getByRole('alert');
  await expect(refusal.or(stepUp(page))).toBeVisible();
  if (await stepUp(page).isVisible()) await confirmItsMe(page);
  await expect(refusal).toContainText(/fraud/i);
  await expect(page.locator('tbody tr', { hasText: 'TEST fraud-listed wallet' })).toHaveCount(0);
  const api = await customerApi();
  expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
  expect(await api.withdrawals()).toEqual([]);
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

test(`${J} #6 reviews and confirms with a fresh step-up: no code keeps Confirm shut, a wrong one is refused in words, and neither sends anything; then one withdrawal, a success panel naming it, and its record`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInWithCode(page);
  await fillSend(page, '25');
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(page.getByTestId('withdraw-review')).toContainText('Leaves your balance26.5 USDT');
  await confirmSend(page).click();
  const dialog = stepUp(page);
  const code = dialog.getByLabel('Authenticator code or recovery code');
  // With no code typed, Confirm stays shut: nothing can be sent without one.
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await code.fill('000000');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toContainText('That code didn’t match. Check your authenticator app and try again.');
  const api = await customerApi();
  expect(await api.withdrawals()).toEqual([]);

  await code.fill(await freshCode());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  const outcome = page.getByTestId('withdraw-outcome');
  await expect(outcome).toContainText('Withdrawal recorded', UNBUILT);
  const [made] = await api.withdrawals();
  expect(made?.id).toBeTruthy();
  await expect(outcome).toContainText(`Withdrawal ${made.id} is recorded.`);
  expect(await api.withdrawals()).toHaveLength(1);
  await outcome.getByRole('link', { name: 'See this withdrawal' }).click();
  await expect(page.getByText(made.id).first()).toBeVisible();
});

test(`${J} #4 two withdrawals sent at once that together pass the 24-hour limit: exactly one goes through`, async ({ page, browser }) => {
  test.setTimeout(900_000);
  expect(fund(account().account.email, 'USDT', '5000').tx).toBeTruthy();
  await signInWithCode(page);
  // Use the allowance up 1,000 at a time (the most one withdrawal may send) until less than 1,000 is left.
  await fillSend(page, '1');
  let left = await leftToday(page);
  while (left > 1000) {
    await sendOut(page, '1000');
    await fillSend(page, '1');
    left = await leftToday(page);
  }
  // Each of the two fits what is left on its own; together they do not.
  const each = String(Math.floor(left / 2) + 1);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await signInWithCode(other);
    const api = await customerApi();
    const before = (await api.withdrawals()).length;
    await readyToConfirm(page, each);
    await readyToConfirm(other, each);
    await Promise.all([page, other].map((tab) => stepUp(tab).getByRole('button', { name: 'Confirm' }).click()));
    const states = await Promise.all(
      [page, other].map(async (tab) => {
        const outcome = tab.getByTestId('withdraw-outcome');
        await expect(outcome).toBeVisible({ timeout: 30_000 });
        return outcome.getAttribute('data-status');
      }),
    );
    expect(states.filter((state) => state === 'refused')).toHaveLength(1);
    expect(states.filter((state) => state !== 'refused' && state !== 'unknown')).toHaveLength(1);
    expect(await api.withdrawals()).toHaveLength(before + 1);
  } finally {
    await otherContext.close();
  }
});

test(`${J} #8 watches the status: requested, held, broadcast and settled in plain words, an old sent row reads settled, and a failure reads as a sentence`, async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  // A person of its own, so these withdrawals don't count against the limits the steps above use.
  const who = await signUp(page, 'wd8');
  await verify(page, who);
  await signIn(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  const tag = `jw05-${who.handle}-r${testInfo.retry}`;
  const words = { requested: 'Requested', held: 'Held', broadcast: 'Broadcast', sent: 'Settled' };
  const ids = Object.fromEntries(Object.keys(words).map((state) => [state, seedWithdrawal(who, state, '1', `${tag}-${state}`)]));

  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  const history = page.getByTestId('withdrawal-history');
  for (const [state, id] of Object.entries(ids)) {
    const row = history.locator(`[data-testid="withdrawal-row"][data-withdrawal-id="${id}"]`);
    await expect(row.locator('[data-withdrawal-status]')).toHaveText(words[state], { timeout: 30_000 });
  }

  // A failed withdrawal says what went wrong in a sentence, never as its code.
  const failed = seedWithdrawal(who, 'failed', '1', `${tag}-failed`, '--failure-code', 'rail.rejected');
  await page.goto(`/uc/withdraw?withdrawalId=${failed}`);
  await expect(page.getByTestId('withdrawal-status')).toHaveText('Failed', { timeout: 30_000 });
  await expect(page.getByTestId('withdrawal-facts')).not.toContainText('rail.rejected');
});
