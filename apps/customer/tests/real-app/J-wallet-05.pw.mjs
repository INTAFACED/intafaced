import path from 'node:path';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, fund, journeyState, mailedLines, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { TEST_WITHDRAW_NETWORK_RULES } from '../../../../tooling/scripts/local-test-gates.mjs';
import { LOCAL_TEST_SANCTIONED_ADDRESS } from '../../../../tooling/scripts/local-stack-services/bank.mjs';

// J-wallet-05, in the running app (docs/roadmap/journeys.json): I withdraw crypto. One test per step, titled
// "J-wallet-05 #<n>", run in order on one verified TEST account with an authenticator app, TEST 300 USDT, and two saved
// wallets, one on TEST Ethereum and one on TEST Base, each approved by its emailed link and past its cooling-off (the wait is
// stood in for by `local-test-stack.mjs age-addresses`). The fee, the quote lifetime and the limits are the TEST withdrawal
// terms the stack's founders publish in svc-pay (`local-test-gates.mjs withdraw-terms`): a fixed 1.5 network fee on TEST
// Ethereum and TEST Base, the fee on top, a 90-second quote, USDT limits of 1000 a withdrawal and 5000 a day for verified
// accounts (the day counts the fee), and a TEST custody policy that lets a TEST send out on the crypto-native rail through.
// The stack's svc-pay has a TEST custody signer for TEST Ethereum only (`PAY_TEST_WITHDRAW_SIGNER_NETWORKS`), sending through
// the in-memory MemoryChain; TEST Base has none, which is what #7 meets. #6 and #4's two parallel sends run after #7, which
// needs the balance still at 300. #8 watches the withdrawal #6 sent, so it runs after #6.
// #2's sanctions clause uses the stack's LOCAL TEST destination sanctions list (svc-bank `BANK_DESTINATION_SANCTIONS`, set only
// by local-stack-services/bank.mjs), one made-up address and not a real list.
// #5 (travel rule) waits for launch (owner decision 2026-10-27).
const J = 'J-wallet-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const LABEL = 'TEST send wallet';
// A second saved wallet, on TEST Base, where no custody signer is connected (#7). Another address than ADDRESS, so #1's
// "not in your address book" check of ADDRESS on TEST Base still holds.
const BASE_ADDRESS = '0x8ba1f109551bd432803012645ac136ddd64dba72';
const BASE_LABEL = 'TEST Base wallet';
// The address the stack's TEST fraud list holds (svc-bank, listed by `local-test-gates.mjs withdraw-terms`, W-withdraw-03).
const FRAUD_LISTED = '0x7e5700000000000000000000000000000000fa1d';

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

/** svc-pay restarted with no sanctions screener (the blank list), or back on the stack's local-test screener. */
function payScreener(on) {
  const before = process.env.LOCAL_STACK_PAY_SCREENER;
  if (on) delete process.env.LOCAL_STACK_PAY_SCREENER;
  else process.env.LOCAL_STACK_PAY_SCREENER = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'pay');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_PAY_SCREENER;
    else process.env.LOCAL_STACK_PAY_SCREENER = before;
  }
}

/** svc-pay restarted with no settle depth for a send out (blank), or back on the stack's TEST depth (local-stack-services/pay.mjs). */
function payWithdrawDepth(published) {
  const before = process.env.LOCAL_STACK_PAY_WITHDRAW_DEPTH;
  if (published) delete process.env.LOCAL_STACK_PAY_WITHDRAW_DEPTH;
  else process.env.LOCAL_STACK_PAY_WITHDRAW_DEPTH = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'pay');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_PAY_WITHDRAW_DEPTH;
    else process.env.LOCAL_STACK_PAY_WITHDRAW_DEPTH = before;
  }
}

/** Answers the "Confirm it's you" dialog with the next authenticator code. */
async function confirmItsMe(page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Authenticator code or recovery code').fill(await freshCode());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
}

/**
 * The customer's own reads through Edge: the journey's person, signed in with the password and an authenticator code, or
 * another person with no second factor (`who` from signUp), signed in with the password.
 */
async function customerApi(who) {
  const person = who ?? account().account;
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceKey: DEVICE_KEY,
      identifier: person.email,
      password: person.password,
      ...(who ? {} : { totpCode: await freshCode() }),
    }),
  }).then((res) => res.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in refused: ${JSON.stringify(login).slice(0, 300)}`);
  const get = async (route) => {
    const res = await fetch(`${EDGE}${route}`, { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  };
  const post = async (route, body, bearer = token) => {
    const res = await fetch(`${EDGE}${route}`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return {
    /** A send straight to svc-pay with the given token: the session's own unless a step-up token is passed. */
    create: (body, bearer) => post('/api/pay/trpc/withdrawal.create', body, bearer),
    /** A fee quote straight from svc-pay. */
    quote: (body) => post('/api/pay/trpc/withdrawal.quote', body),
    /** An address-book save straight to svc-bank with the given step-up token. */
    saveAddress: (body, bearer) => post('/api/bank/trpc/ramps.destinations.save', body, bearer),
    /** "Confirm it's you" by API: the five-minute token that alone may send. */
    async stepUp() {
      const { status, body } = await post('/api/identity/trpc/auth.stepUp', { totpCode: await freshCode() });
      if (status !== 200) throw new Error(`step-up refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
      return body.result.data;
    },
    async available(asset) {
      const { status, body } = await get('/api/v1/account/balance');
      if (status !== 200) throw new Error(`balance read refused: ${status}`);
      return body.balances[asset]?.free ?? '0';
    },
    /** What the ledger holds against the person for `asset` (holds and escrow), as svc-bank reads it from svc-ledger. */
    async reserved(asset) {
      const { status, body } = await get('/api/v1/account/balance');
      if (status !== 200) throw new Error(`balance read refused: ${status}`);
      return body.balances[asset]?.used ?? '0';
    },
    /** One withdrawal as svc-pay's `withdrawal.get` answers it, with the state the person is shown (`customerStatus`). */
    async withdrawal(withdrawalId) {
      const { status, body } = await get(`/api/pay/trpc/withdrawal.get?input=${encodeURIComponent(JSON.stringify({ withdrawalId }))}`);
      if (status !== 200) throw new Error(`withdrawal read refused: ${status}`);
      return body.result.data;
    },
    /** The person's address book as svc-bank lists it. */
    async addresses() {
      const { status, body } = await get('/api/bank/trpc/ramps.destinations.list');
      if (status !== 200) throw new Error(`address book read refused: ${status}`);
      return body.result.data;
    },
    /** svc-bank's network catalogue, as the Withdraw form reads it: each asset's networks and its default. */
    async networks() {
      const { status, body } = await get('/api/bank/trpc/ramps.destinations.networks');
      if (status !== 200) throw new Error(`network catalogue read refused: ${status}`);
      return body.result.data;
    },
    async withdrawals(limit = 10) {
      const { status, body } = await get(`/api/pay/trpc/withdrawal.history?input=${encodeURIComponent(JSON.stringify({ limit }))}`);
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

/** Opens Withdraw with USDT on its default network (or on TEST Base), the saved TEST wallet there chosen and `amount` typed. */
async function fillSend(page, amount, { base = false } = {}) {
  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  await pick(page, 'Asset').selectOption('USDT');
  await expect(pick(page, 'Network')).toHaveValue('ethereum');
  if (base) await pick(page, 'Network').selectOption('base');
  const saved = pick(page, 'Saved address');
  const ready = base ? `${BASE_LABEL} · 0x8ba1…ba72 · Ready to use` : `${LABEL} · 0x5290…9EE7 · Ready to use`;
  await expect(saved.locator('option', { hasText: base ? BASE_LABEL : LABEL })).toHaveText(ready);
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

/** Saves `address` on `network` for USDT, then approves it by its emailed link, opened and confirmed in another browser. */
async function saveAndApprove(page, browser, who, label, network, address) {
  await page.goto('/uc/withdraw/address');
  const add = page.getByRole('form', { name: 'Add an address' });
  await add.getByRole('textbox', { name: /^Label/ }).fill(label);
  await add.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await add.getByRole('combobox', { name: /^Network/ }).selectOption(network);
  await add.getByRole('textbox', { name: /^Address/ }).fill(address);
  await add.getByRole('button', { name: 'Save address' }).click();
  await confirmItsMe(page);
  await expect(page.getByText(`${label} was saved to your address book.`)).toBeVisible();

  const seen = mailedLines(who.email, 'withdraw-address-approval').length;
  const row = page.locator('tbody tr', { hasText: label });
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
}

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
  await expect(page.getByTestId('withdraw-outcome')).toContainText('Withdrawal recorded', { timeout: 30_000 });
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

  // Two wallets, each saved and then approved by its emailed link opened in another browser (J-wallet-04 #5).
  for (const [label, network, address] of [
    [LABEL, 'ethereum', ADDRESS],
    [BASE_LABEL, 'base', BASE_ADDRESS],
  ]) {
    await saveAndApprove(page, browser, who, label, network, address);
  }

  // The cooling-off runs from the approval; the LOCAL TEST clock moves it past its end.
  expect(tool('local-test-stack.mjs', 'age-addresses', who.email, '25')).toContain('2 saved address(es)');
  await page.reload();
  await expect(page.locator('tbody tr', { hasText: LABEL })).toContainText('Ready to use');
  await expect(page.locator('tbody tr', { hasText: BASE_LABEL })).toContainText('Ready to use');
});

test(`${J} #1 opens Withdraw and picks asset and network: the default network with its tag rule, minimum, maximum and step from the catalogue, and a changed network checks the address again`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  // The default is the one svc-bank's catalogue names for USDT, read from the catalogue itself, never a guess.
  const api = await customerApi();
  const usdt = (await api.networks()).find((entry) => entry.assetId === 'USDT');
  expect(usdt?.defaultNetworkId, 'the catalogue names a default network for USDT').toBeTruthy();
  expect(usdt.networks.map((network) => network.networkId)).toContain(usdt.defaultNetworkId);
  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  await pick(page, 'Asset').selectOption('USDT');
  await expect(pick(page, 'Network')).toHaveValue(usdt.defaultNetworkId);
  // The steps below use TEST Ethereum's address book and rules, so the stack's default must be that one.
  expect(usdt.defaultNetworkId, 'the stack publishes TEST Ethereum as the USDT default').toBe('ethereum');

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
  // Each figure is the one the stack's founders published (TEST_WITHDRAW_NETWORK_RULES: 1, 1000 and 0.01), compared as a
  // number so a grouped or zero-padded display of the same value still matches, and any other value fails.
  const figure = (text) =>
    text
      .replace(/,/g, '')
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '');
  for (const [rule, want] of [
    ['Minimum', TEST_WITHDRAW_NETWORK_RULES.minimum],
    ['Maximum', TEST_WITHDRAW_NETWORK_RULES.maximum],
    ['Step', TEST_WITHDRAW_NETWORK_RULES.step],
  ]) {
    const shown = (await rules.textContent()).match(new RegExp(`${rule}\\D*?([\\d.,]+) USDT`));
    expect(shown, `${rule} is shown`).not.toBeNull();
    expect(figure(shown[1]), `${rule} is the catalogue's TEST ${want} USDT`).toBe(figure(want));
  }
  await expect(form(page).getByRole('textbox', { name: /^(Tag|Memo)/ })).toHaveCount(0);
  // A tag on a network without tags is refused by svc-pay itself, by name, with a real quote and a fresh step-up: never
  // dropped and sent without it. Then nothing is held and nothing is recorded.
  const quoteRef = `${J}-tag-quote-${Date.now()}`;
  const quoted = await api.quote({ quoteRef, assetId: 'USDT', networkId: 'ethereum', amount: '25' });
  expect(quoted.status, JSON.stringify(quoted.body).slice(0, 400)).toBe(200);
  const tagged = await api.create(
    {
      assetId: 'USDT',
      amount: '25',
      railId: 'crypto-native',
      networkId: 'ethereum',
      quoteRef,
      destination: { kind: 'crypto', ref: ADDRESS, tag: '12345' },
      clientRef: `${J}-tag-${Date.now()}`,
    },
    (await api.stepUp()).accessToken,
  );
  expect(tagged.body?.error?.data?.cause?.code, JSON.stringify(tagged.body).slice(0, 400)).toBe('pay.withdrawal_tag_not_taken');
  expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
  expect(await api.withdrawals()).toEqual([]);
});

test(`${J} #2 picks the saved address or pastes one: a mistyped address is refused before any call, and an address on the fraud list is refused by name with nothing held, and so is a sanctioned address`, async ({
  page,
}) => {
  // Two svc-pay restarts (screener off, then back on) take most of a minute each.
  test.setTimeout(480_000);
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
  await expect(refusal).toHaveText('This address is on our fraud list, so it can’t be saved. Nothing was saved.');
  await expect(page.locator('tbody tr', { hasText: 'TEST fraud-listed wallet' })).toHaveCount(0);

  // The screen may refuse on its pre-check; the bank itself refuses the save with its typed code, even with a fresh step-up.
  const api = await customerApi();
  const listed = await api.saveAddress(
    { assetId: 'USDT', network: 'ethereum', ref: FRAUD_LISTED, label: 'TEST fraud-listed wallet' },
    (await api.stepUp()).accessToken,
  );
  expect(listed.body?.error?.data?.cause?.code).toBe('bank.destination_fraud_listed');
  expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
  expect(await api.withdrawals()).toEqual([]);

  // The blank-list half: with no screener set, svc-pay refuses a send to the saved, ready address with its typed code before
  // anything is held. svc-pay is put back on the stack's local-test screener afterwards, so #6 and #4 can still send.
  try {
    payScreener(false);
    await fillSend(page, '25');
    await page.getByRole('button', { name: 'Get the fee' }).click();
    await expect(page.getByTestId('withdraw-review')).toContainText('Leaves your balance26.5 USDT');
    const answered = page.waitForResponse((res) => res.url().includes('/api/pay/trpc/withdrawal.create'));
    await confirmSend(page).click();
    await confirmItsMe(page);
    const refused = await (await answered).json();
    expect(refused?.error?.data?.cause?.code, JSON.stringify(refused).slice(0, 400)).toBe('pay.guard_screening_unavailable');
    const outcome = page.getByTestId('withdraw-outcome');
    await expect(outcome).toContainText('Not sent');
    await expect(outcome).toContainText('Nothing was sent: no sanctions screening service is connected, and every send needs one.');
    await expect(outcome).toContainText('Nothing was sent and nothing is held. Your available balance is 300 USDT.');
    expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
    expect(await api.withdrawals()).toEqual([]);
  } finally {
    payScreener(true);
  }

  // The sanctions clause: the address on the stack's LOCAL TEST destination sanctions list is refused by name when saved,
  // in the customer's words, and never reaches the address book; nothing is held and nothing is sent.
  await page.goto('/uc/withdraw/address');
  const again = page.getByRole('form', { name: 'Add an address' });
  await again.getByRole('textbox', { name: /^Label/ }).fill('TEST sanctioned wallet');
  await again.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await again.getByRole('combobox', { name: /^Network/ }).selectOption('ethereum');
  await again.getByRole('textbox', { name: /^Address/ }).fill(LOCAL_TEST_SANCTIONED_ADDRESS);
  await again.getByRole('button', { name: 'Save address' }).click();
  // The check before the confirmation code refuses it, so no code is asked for.
  await expect(again.getByRole('alert')).toHaveText('This address is on the sanctions list, so it can’t be saved. Nothing was saved.');
  await expect(stepUp(page)).toHaveCount(0);
  await expect(page.locator('tbody tr', { hasText: 'TEST sanctioned wallet' })).toHaveCount(0);
  // The bank itself refuses it with its typed code, however its letters are cased, even with a fresh step-up.
  for (const ref of [LOCAL_TEST_SANCTIONED_ADDRESS, LOCAL_TEST_SANCTIONED_ADDRESS.toUpperCase().replace('0X', '0x')]) {
    const sanctioned = await api.saveAddress(
      { assetId: 'USDT', network: 'ethereum', ref, label: 'TEST sanctioned wallet' },
      (await api.stepUp()).accessToken,
    );
    expect(sanctioned.body?.error?.data?.cause?.code, JSON.stringify(sanctioned.body).slice(0, 400)).toBe(
      'bank.destination_sanctions_listed',
    );
  }
  expect((await api.addresses()).filter((row) => row.label === 'TEST sanctioned wallet')).toEqual([]);
  expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
  expect(await api.withdrawals()).toEqual([]);
});

test(`${J} #3 reads the fee quote: fee, what arrives and the total debit as exact decimals, an expired quote must be got again, and a blank fee is a refusal`, async ({
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

  // A blank fee is a refusal: TEST Ethereum's fee is cleared through the founders' own door for this clause only, and put
  // back in the finally. The page names it in words, svc-pay answers one typed code, and nothing is quoted or held.
  const api = await customerApi();
  try {
    tool('local-test-gates.mjs', 'withdraw-fee', 'ethereum', 'unset');
    await amountBox(page).fill('25');
    await page.getByRole('button', { name: 'Get the fee' }).click();
    await expect(page.getByText('No fee is set for this network, so nothing can be sent on it.')).toBeVisible();
    await expect(fee).not.toContainText('1.5 USDT');
    await expect(page.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();
    await expect(confirmSend(page)).toHaveCount(0);
    const blank = await api.quote({ quoteRef: `${J}-blank-fee-${Date.now()}`, assetId: 'USDT', networkId: 'ethereum', amount: '25' });
    expect(blank.body?.error?.data?.cause?.code, JSON.stringify(blank.body).slice(0, 400)).toBe('pay.fee_unset');
    expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
    expect(await api.withdrawals()).toEqual([]);
  } finally {
    tool('local-test-gates.mjs', 'withdraw-fee', 'ethereum', 'test');
  }
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(fee).toContainText('1.5 USDT');
});

test(`${J}, part of #4 reads the limit line: what the account's level may send now, per withdrawal and in 24 hours`, async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  await fillSend(page, '25');
  await expect(page.getByTestId('withdraw-limit')).toContainText(
    'You can send up to 1,000 USDT now: 1,000 per withdrawal, and 5,000 of 5,000 left in the last 24 hours.',
  );
});

test(`${J} #4 a blank limit refuses and holds nothing`, async ({ page }) => {
  test.setTimeout(300_000);
  await signInWithCode(page);
  const api = await customerApi();
  // The account's level (full) and USDT: the stack's TEST limit is cleared to unset through the founders' own door for this
  // step only, and put back in the finally, so every other step still meets the TEST figures.
  try {
    tool('local-test-gates.mjs', 'withdraw-limit', 'full', 'USDT', 'unset');
    await fillSend(page, '25');
    // The limit line says in words that no limit is set, and nothing can be reviewed, so nothing can be confirmed.
    await expect(page.getByTestId('withdraw-limit').locator('p')).toHaveText(
      'No withdrawal limit is set for your account level and this asset, so nothing can be sent.',
    );
    await page.getByRole('button', { name: 'Get the fee' }).click();
    await expect(page.getByTestId('withdraw-fee')).toContainText('1.5 USDT');
    // With the fee in hand the send still cannot be reviewed: no limit, no confirm.
    await expect(page.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();
    await expect(confirmSend(page)).toHaveCount(0);
    // svc-pay itself refuses a send that skips the page: one exact typed code, with a real quote and a fresh step-up.
    const quoteRef = `${J}-blank-limit-quote-${Date.now()}`;
    const quoted = await api.quote({ quoteRef, assetId: 'USDT', networkId: 'ethereum', amount: '25' });
    expect(quoted.status, JSON.stringify(quoted.body).slice(0, 400)).toBe(200);
    const refused = await api.create(
      {
        assetId: 'USDT',
        amount: '25',
        railId: 'crypto-native',
        networkId: 'ethereum',
        quoteRef,
        destination: { kind: 'crypto', ref: ADDRESS },
        clientRef: `${J}-blank-limit-${Date.now()}`,
      },
      (await api.stepUp()).accessToken,
    );
    expect(refused.body?.error?.data?.cause?.code, JSON.stringify(refused.body).slice(0, 400)).toBe('pay.guard_withdrawal_limit_unset');
    // Nothing held, nothing recorded.
    expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
    expect(await api.withdrawals()).toEqual([]);
  } finally {
    tool('local-test-gates.mjs', 'withdraw-limit', 'full', 'USDT', 'test');
  }
  // Back to the TEST figures: the limit line reads them again.
  await fillSend(page, '25');
  await expect(page.getByTestId('withdraw-limit')).toContainText('You can send up to 1,000 USDT now');
});

test(`${J} #7 confirms with a fresh step-up while no signer is connected: refused by name, nothing held, the balance still reads 300`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInWithCode(page);
  // TEST Base has no custody signer on the stack; TEST Ethereum's TEST signer is what #6 and #4 use.
  await fillSend(page, '25', { base: true });
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(page.getByTestId('withdraw-review')).toContainText('Leaves your balance26.5 USDT');
  await confirmSend(page).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' })).toContainText('Sending money out needs a fresh confirmation.');
  const answered = page.waitForResponse((res) => res.url().includes('/api/pay/trpc/withdrawal.create'));
  await confirmItsMe(page);
  // svc-pay refuses with the one typed code for a network with no signer.
  const refused = await (await answered).json();
  expect(refused?.error?.data?.cause?.code, JSON.stringify(refused).slice(0, 400)).toBe('pay.wallet_withdraw_unavailable');

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
  test.setTimeout(600_000);
  await signInWithCode(page);
  const api = await customerApi();
  // A missing step-up is a typed refusal: the signed-in session alone may not send, it lacks `trade:withdraw`.
  const send = {
    assetId: 'USDT',
    amount: '25',
    railId: 'crypto-native',
    networkId: 'ethereum',
    quoteRef: 'J-wallet-05-no-quote',
    destination: { kind: 'crypto', ref: ADDRESS },
    clientRef: `${J}-no-step-up`,
  };
  const unstepped = await api.create(send);
  expect(unstepped.status, JSON.stringify(unstepped.body)).toBe(403);
  expect(unstepped.body?.error?.data?.code).toBe('FORBIDDEN');
  expect(unstepped.body?.error?.message).toContain('trade:withdraw');
  // An expired step-up is refused too: its token lives five minutes, and once past that it sends nothing.
  const elevated = await api.stepUp();
  expect(Date.parse(elevated.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
  // While it lives, the same token gets past the step-up check: svc-pay stops only at the quote this send names, which
  // does not exist, so nothing is held.
  const live = await api.create({ ...send, clientRef: `${J}-live-step-up` }, elevated.accessToken);
  expect(live.status, JSON.stringify(live.body).slice(0, 400)).toBe(404);
  expect(live.body?.error?.data?.cause?.code, JSON.stringify(live.body).slice(0, 400)).toBe('withdrawal_quote.not_found');
  await page.waitForTimeout(Math.max(0, Date.parse(elevated.expiresAt) - Date.now()) + 2_000);
  // Once expired, the edge no longer vouches for it, and svc-pay refuses it as signed out: UNAUTHORIZED, not the
  // FORBIDDEN of a session that never stepped up.
  const expired = await api.create({ ...send, clientRef: `${J}-expired-step-up` }, elevated.accessToken);
  expect(expired.status, JSON.stringify(expired.body)).toBe(401);
  expect(expired.body?.error?.data?.code).toBe('UNAUTHORIZED');
  expect(await api.withdrawals()).toEqual([]);
  expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));

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
  expect(await api.withdrawals()).toEqual([]);

  await code.fill(await freshCode());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  const outcome = page.getByTestId('withdraw-outcome');
  await expect(outcome).toContainText('Withdrawal recorded', { timeout: 30_000 });
  const [made] = await api.withdrawals();
  expect(made?.id).toBeTruthy();
  // #8 watches this one by its id.
  run.reset({ ...account(), sent6: made.id });
  await expect(outcome).toContainText(`Withdrawal ${made.id} is recorded.`);
  expect(await api.withdrawals()).toHaveLength(1);
  // One withdrawal: 25 out with the 1.5 fee on top, so the balance reads 273.5.
  expect(toUnits(await api.available('USDT'))).toBe(toUnits('273.5'));
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
    const availableBefore = toUnits(await api.available('USDT'));
    await readyToConfirm(page, each);
    await readyToConfirm(other, each);
    const answers = [page, other].map((tab) => tab.waitForResponse((res) => res.url().includes('/api/pay/trpc/withdrawal.create')));
    // Each tab passes its own step-up, one after the other: a code from an earlier 30-second step than one already used is
    // refused, so the two can't verify in either order. Each send then waits in its browser until both are made, and the two
    // go to svc-pay together.
    const isCreate = (url) => url.href.includes('/api/pay/trpc/withdrawal.create');
    let release;
    const bothMade = new Promise((resolve) => (release = resolve));
    let made = 0;
    for (const tab of [page, other]) {
      await tab.route(isCreate, async (route) => {
        if (++made === 2) release();
        await bothMade;
        await route.continue();
      });
    }
    // readyToConfirm typed each tab's code, the second from a later step, so neither send is held for long once it is made
    // and both quotes are still live (90 seconds) when they reach svc-pay.
    for (const tab of [page, other]) {
      const sent = tab.waitForRequest((req) => isCreate(new URL(req.url())));
      await stepUp(tab).getByRole('button', { name: 'Confirm' }).click();
      await sent;
    }
    // svc-pay answers one send and refuses the other with the one typed code for a limit that would be passed.
    const bodies = await Promise.all(answers.map(async (answer) => (await answer).json()));
    const codes = bodies.map((body) => body?.error?.data?.cause?.code ?? null);
    expect(
      codes.filter((c) => c === null),
      JSON.stringify(bodies).slice(0, 600),
    ).toHaveLength(1);
    expect(codes.filter((c) => c !== null)).toEqual(['pay.guard_withdrawal_limit_exceeded']);
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
    // Exactly one amount and its 1.5 fee left the available balance; the refused one held nothing.
    expect(toUnits(await api.available('USDT'))).toBe(availableBefore - toUnits(each) - toUnits('1.5'));
  } finally {
    await otherContext.close();
  }
});

test(`${J} #8 watches the status: requested, held, broadcast, confirming and settled in plain words, settled only at the owner's depth, and a failure reads as a sentence`, async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(600_000);
  // Every word the page may show, in the order a withdrawal moves through them, then the ends that are not Settled.
  const order = ['requested', 'pending_review', 'approved', 'held', 'dispatching', 'broadcast', 'confirming', 'settled'];
  const word = {
    requested: 'Requested',
    pending_review: 'In review',
    approved: 'Approved',
    held: 'Held',
    dispatching: 'Sending',
    broadcast: 'Broadcast',
    confirming: 'Confirming',
    settled: 'Settled',
    rejected: 'Rejected',
    canceled: 'Cancelled',
    failed: 'Failed',
    needs_review: 'Needs review',
  };
  const ownContext = await browser.newContext();
  try {
    const own = await ownContext.newPage();
    await signInWithCode(own);
    const api = await customerApi();
    const record = async (id) => {
      const found = (await api.withdrawals(200)).find((w) => w.id === id);
      expect(found, `svc-pay has withdrawal ${id}`).toBeTruthy();
      return found;
    };
    /**
     * The withdrawal's page, read between two reads of svc-pay's record: it shows a state the record held in that time
     * (the one read before, the one read after, or a step between them on the way to Settled), in its word.
     */
    const look = async (tab, id, reader = api, reads = []) => {
      const before = (await reader.withdrawal(id)).customerStatus;
      await tab.goto(`/uc/withdraw?withdrawalId=${id}`);
      const status = tab.getByTestId('withdrawal-status');
      await expect(status).toBeVisible({ timeout: 15_000 });
      const shown = { state: await status.getAttribute('data-status'), text: (await status.textContent())?.trim() };
      const after = (await reader.withdrawal(id)).customerStatus;
      reads.push(before, after);
      const [from, to, at] = [before, after, shown.state].map((state) => order.indexOf(state));
      const between = from >= 0 && to >= 0 && from <= at && at <= to;
      expect(
        between || [before, after].includes(shown.state),
        `the page reads ${shown.state} while svc-pay read ${before}, then ${after}`,
      ).toBe(true);
      expect(shown.text, `${shown.state} in its word`).toBe(word[shown.state]);
      return shown.state;
    };
    const forwards = (seen) => {
      for (const state of seen) expect(order, `${state} is a step on the way to Settled (${seen.join(' → ')})`).toContain(state);
      const steps = seen.map((state) => order.indexOf(state));
      expect(steps, `never backwards: ${seen.join(' → ')}`).toEqual([...steps].sort((a, b) => a - b));
    };
    /**
     * One real send from the Withdraw form. Its create is let through to svc-pay unchanged, and svc-pay's answer is held back
     * from the page until the form has been read: while the call is in flight the room says Requested. Returns svc-pay's
     * answer, as the page then gets it.
     */
    const sendWatched = async (amount) => {
      await readyToConfirm(page, amount);
      let release;
      const released = new Promise((resolve) => (release = resolve));
      let answered;
      const answer = new Promise((resolve) => (answered = resolve));
      await page.route('**/api/pay/trpc/withdrawal.create**', async (route) => {
        const response = await route.fetch();
        answered(await response.json());
        await released;
        await route.fulfill({ response });
      });
      try {
        await stepUp(page).getByRole('button', { name: 'Confirm' }).click();
        const requested = page.getByTestId('withdraw-requested');
        await expect(requested).toHaveAttribute('data-status', 'requested', { timeout: 30_000 });
        await expect(requested.locator('strong')).toHaveText(word.requested);
        const body = await answer;
        // Still in flight for the page while svc-pay has answered: the room still says Requested.
        await expect(requested).toBeVisible();
        release();
        await expect(requested).toBeHidden({ timeout: 30_000 });
        return body?.result?.data;
      } finally {
        release?.();
        await page.unroute('**/api/pay/trpc/withdrawal.create**');
      }
    };

    // #6's send, picked by the id #6 kept: Settled on its page and in svc-pay's record, and in the person's list.
    const sent6 = run.read().sent6;
    expect(sent6, 'the withdrawal #6 sent (#8 runs after #6)').toBeTruthy();
    await expect.poll(async () => (await api.withdrawal(sent6)).customerStatus, { timeout: 90_000 }).toBe('settled');
    expect(await look(own, sent6)).toBe('settled');
    const made6 = await record(sent6);
    expect(made6).toMatchObject({ status: 'settled', destination: { kind: 'crypto', ref: ADDRESS } });
    expect(toUnits(made6.amount)).toBe(toUnits('25'));
    await own.goto('/uc/withdraw');
    await own.mouse.move(0, 600);
    const row6 = own.getByTestId('withdrawal-history').locator(`[data-testid="withdrawal-row"][data-withdrawal-id="${sent6}"]`);
    await expect(row6.locator('[data-withdrawal-status]')).toHaveText('Settled', { timeout: 30_000 });

    // A new real send of 12, watched from the request to Settled. svc-pay books the hold inside the create and answers
    // Held; its advance worker then sends it on the stack's TEST chain, which answers after a few seconds and makes a block
    // every few seconds after that; svc-pay settles it only once the chain holds it at PAY_MIN_CONFIRMATIONS deep.
    const freeBeforeTwelve = toUnits(await api.available('USDT'));
    const reservedBeforeTwelve = toUnits(await api.reserved('USDT'));
    await signInWithCode(page);
    const twelve = await sendWatched('12');
    expect(twelve, 'svc-pay answered the create').toBeTruthy();
    expect(twelve).toMatchObject({ status: 'held', customerStatus: 'held', cancellable: true });
    expect(toUnits(twelve.amount)).toBe(toUnits('12'));
    // svc-pay's own record reads it back held, and the ledger has reserved the 12 with the TEST 1.5 fee on top.
    expect((await api.withdrawal(twelve.id)).customerStatus, 'withdrawal.get reads the new send back').toBe('held');
    expect(toUnits(await api.reserved('USDT')), 'the ledger holds 12 + 1.5 for it').toBe(reservedBeforeTwelve + toUnits('13.5'));
    expect(toUnits(await api.available('USDT')), 'and it left the available balance').toBe(freeBeforeTwelve - toUnits('13.5'));
    await expect(page.getByTestId('withdraw-outcome')).toContainText(`Withdrawal ${twelve.id} is recorded.`);
    await expect(page.getByTestId('withdraw-outcome-status')).toHaveText(word.held);

    const seen = [];
    const reads = [];
    const until = Date.now() + 120_000;
    while (seen.at(-1) !== 'settled' && Date.now() < until) {
      const state = await look(own, twelve.id, api, reads);
      if (seen.at(-1) !== state) seen.push(state);
    }
    expect(seen.at(-1), `seen: ${seen.join(' → ')}`).toBe('settled');
    forwards(seen);
    for (const state of ['held', 'dispatching', 'broadcast', 'confirming']) {
      expect(seen, `the page read the real send ${state} on its way: ${seen.join(' → ')}`).toContain(state);
      expect(reads, `svc-pay itself read it ${state}: ${reads.join(', ')}`).toContain(state);
    }
    const made12 = await record(twelve.id);
    expect(made12.status).toBe('settled');
    expect(toUnits(made12.amount)).toBe(toUnits('12'));
    // Settled, read back from the ledger: the hold is gone and the 12 with its 1.5 fee left the person's money for good.
    expect(toUnits(await api.reserved('USDT')), 'the settle consumed the hold').toBe(reservedBeforeTwelve);
    expect(toUnits(await api.available('USDT')), 'the settled 12 took 12 + 1.5 from the balance').toBe(freeBeforeTwelve - toUnits('13.5'));

    // A real send the TEST chain refuses (any send of exactly 13, `PAY_TEST_CHAIN_REFUSE_AMOUNT`): held by the create, then
    // refused when the worker sends it, its hold back, and the page says why in a sentence, never as its code.
    const freeBeforeThirteen = toUnits(await api.available('USDT'));
    const reservedBeforeThirteen = toUnits(await api.reserved('USDT'));
    const thirteen = await sendWatched('13');
    expect(thirteen).toMatchObject({ status: 'held', customerStatus: 'held' });
    expect(toUnits(await api.reserved('USDT')), 'the ledger holds 13 + 1.5 for it').toBe(reservedBeforeThirteen + toUnits('14.5'));
    await expect.poll(async () => (await api.withdrawal(thirteen.id)).customerStatus, { timeout: 60_000 }).toBe('failed');
    const refused = await record(thirteen.id);
    expect(refused).toMatchObject({ status: 'failed', failure: { code: 'rail.refused', known: true } });
    expect(toUnits(refused.amount)).toBe(toUnits('13'));
    expect(toUnits(await api.reserved('USDT')), 'the refused send’s hold went back').toBe(reservedBeforeThirteen);
    expect(toUnits(await api.available('USDT')), 'and the balance is whole again').toBe(freeBeforeThirteen);
    expect(await look(own, thirteen.id)).toBe('failed');
    await expect(own.getByTestId('withdrawal-facts')).toContainText(
      'The network refused this withdrawal. Nothing was sent, and any amount held for it went back to your available balance.',
    );
    await expect(own.getByTestId('withdrawal-facts')).not.toContainText('rail.refused');

    // Settled comes only from the owner's settle depth. With it blank, svc-pay invents none: a send out refuses with its one
    // typed code before anything is held, and the room says so in a sentence. svc-pay is restarted on the TEST depth after.
    const freeBeforeBlank = toUnits(await api.available('USDT'));
    const reservedBeforeBlank = toUnits(await api.reserved('USDT'));
    const countBeforeBlank = (await api.withdrawals(200)).length;
    try {
      payWithdrawDepth(false);
      await signInWithCode(page);
      await readyToConfirm(page, '11');
      const answered = page.waitForResponse((res) => res.url().includes('/api/pay/trpc/withdrawal.create'));
      await stepUp(page).getByRole('button', { name: 'Confirm' }).click();
      const blank = await (await answered).json();
      expect(blank?.error?.data?.cause?.code, JSON.stringify(blank).slice(0, 400)).toBe('pay.withdraw_confirmations_unset');
      const outcome = page.getByTestId('withdraw-outcome');
      await expect(outcome).toContainText('Not sent');
      await expect(outcome).toContainText(
        'No confirmation depth is published for sending to a wallet outside INTAFACED, so this withdrawal was refused before anything was held.',
      );
      await expect(outcome).not.toContainText('pay.withdraw_confirmations_unset');
      expect(toUnits(await api.available('USDT')), 'nothing left the available balance').toBe(freeBeforeBlank);
      expect(toUnits(await api.reserved('USDT')), 'and nothing is held').toBe(reservedBeforeBlank);
      expect(await api.withdrawals(200), 'svc-pay recorded no withdrawal').toHaveLength(countBeforeBlank);
    } finally {
      payWithdrawDepth(true);
    }
  } finally {
    await ownContext.close();
  }
});
