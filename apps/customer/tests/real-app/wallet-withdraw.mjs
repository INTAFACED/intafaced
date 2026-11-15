// The shared world of J-wallet-05's part files (J-wallet-05.pw.mjs and J-wallet-05-send.pw.mjs):
// its TEST constants and helpers, and the account each part starts from. Each part has its own account and its own
// journey state, so the parts run in any order, in one shard or in several.
//
// (Failure it prevents: as one file J-wallet-05 ran 23 to 26 minutes, one step after another in one shard, and main's whole
// journeys run waited on that shard; #6 alone waits out a five-minute step-up and #4 uses up a day's limit. Split in two,
// the longer part is about 14 minutes.)
import path from 'node:path';
import { expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, fund, journeyState, mailedLines, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { keptSession } from '../../../../tooling/scripts/kept-session.mjs';

// J-wallet-05, in the running app (docs/roadmap/journeys.json): I withdraw crypto. One test per step, titled
// "J-wallet-05 #<n>", each part run in order on its own verified TEST account with an authenticator app, TEST 300 USDT, and two saved
// wallets, one on TEST Ethereum and one on TEST Base, each approved by its emailed link and past its cooling-off (the wait is
// stood in for by `local-test-stack.mjs age-addresses`). The fee, the quote lifetime and the limits are the TEST withdrawal
// terms the stack's founders publish in svc-pay (`local-test-gates.mjs withdraw-terms`): a fixed 1.5 network fee on TEST
// Ethereum and TEST Base, the fee on top, a 90-second quote, USDT limits of 1000 a withdrawal and 5000 a day for verified
// accounts (the day counts the fee), and a TEST custody policy that lets a TEST send out on the crypto-native rail through.
// The stack's svc-pay has a TEST custody signer for TEST Ethereum only (`PAY_TEST_WITHDRAW_SIGNER_NETWORKS`), sending through
// the in-memory MemoryChain; TEST Base has none, which is what #7 meets.
// #2's sanctions clause uses the stack's LOCAL TEST destination sanctions list (svc-bank `BANK_DESTINATION_SANCTIONS`, set only
// by local-stack-services/bank.mjs), one made-up address and not a real list.
// #5 (travel rule) waits for launch (owner decision 2026-10-27).
export const J = 'J-wallet-05';
export const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
export const LABEL = 'TEST send wallet';
// A second saved wallet, on TEST Base, where no custody signer is connected (#7). Another address than ADDRESS, so #1's
// "not in your address book" check of ADDRESS on TEST Base still holds.
export const BASE_ADDRESS = '0x8ba1f109551bd432803012645ac136ddd64dba72';
export const BASE_LABEL = 'TEST Base wallet';
// The address the stack's TEST fraud list holds (svc-bank, listed by `local-test-gates.mjs withdraw-terms`, W-withdraw-03).
export const FRAUD_LISTED = '0x7e5700000000000000000000000000000000fa1d';

/** The helpers of one part, on its own journey state (`part` names it; the first part has none, as before). */
export function withdrawWorld(part) {
  const run = journeyState(`${J}${part ? `-${part}` : ''}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

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

  const sessions = new Map();
  /** The journey's person's kept session, one per account. */
  function personSession(email, signIn) {
    if (!sessions.has(email)) sessions.set(email, keptSession(signIn));
    return sessions.get(email);
  }

  /**
   * The customer's own reads through Edge: the journey's person, signed in with the password and an authenticator code, or
   * another person with no second factor (`who` from signUp), signed in with the password.
   */
  async function customerApi(who) {
    const person = who ?? account().account;
    const signIn = async () => {
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
      return token;
    };
    // The journey's person reads on one kept session (tooling/scripts/kept-session.mjs), so each step's reads no longer
    // wait for a new authenticator step; every code the step is about (a sign-in, a step-up, a confirm) is still fresh.
    const session = personSession(person.email, signIn);
    /** Sends with the session's token, and once more on a new sign-in if that token is refused as signed out. */
    const withSession = async (send) => {
      const res = await send(await session());
      if (res.status !== 401) return res;
      session.drop();
      return send(await session());
    };
    const get = (route) =>
      withSession(async (token) => {
        const res = await fetch(`${EDGE}${route}`, { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } });
        return { status: res.status, body: await res.json() };
      });
    const post = async (route, body, bearer) => {
      const send = async (token) => {
        const res = await fetch(`${EDGE}${route}`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      };
      // A token the step passes (a step-up's) is sent as it is: its refusal is what the step reads.
      return bearer ? send(bearer) : withSession(send);
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
      /** svc-pay's limits for the person's tier and `assetId`: the owner's figures, what 24 hours used and what is left. */
      async limits(assetId) {
        const { status, body } = await get(`/api/pay/trpc/withdrawal.limits?input=${encodeURIComponent(JSON.stringify({ assetId }))}`);
        return { status, data: body?.result?.data ?? null, body };
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
    // Named and bounded: without it a tab that lost its sign-in waits out the step's whole 900 s on selectOption (#7588).
    await expect(pick(page, 'Asset'), 'Withdraw shows no Asset picker: the tab is signed out or the asset list was refused').toBeVisible({
      timeout: 30_000,
    });
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

  /** The account every part starts from: verified, an authenticator app, TEST 300 USDT, and both wallets ready to use. */
  async function startAccount(page, browser) {
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
  }

  return {
    account,
    totpLib,
    freshCode,
    signInWithCode,
    payScreener,
    payWithdrawDepth,
    confirmItsMe,
    customerApi,
    leftToday,
    form,
    pick,
    amountBox,
    confirmSend,
    fillSend,
    approvalLink,
    stepUp,
    saveAndApprove,
    readyToConfirm,
    sendOut,
    run,
    startAccount,
  };
}
