import path from 'node:path';
import { test, expect } from '@playwright/test';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, api, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-wallet-07, in the running app (docs/roadmap/journeys.json): I move money between my own accounts and to another
// user, instantly. One test per step, titled "J-wallet-07 #<n>", run in order on one verified TEST account funded with
// TEST 100 USDT and holding one named space. Balances are read through the person's own bank API. #3-#5 are W-withdraw-14:
// a withdrawal to an address that belongs to another account on the platform settles inside, as one transfer with no fee.
// #3 makes the friend (a second verified TEST account with a USDT deposit address) and gives the person an authenticator
// app, because sending needs a fresh confirmation; from then on the person signs in with a code.
const J = 'J-wallet-07';
const SPACE = 'Savings TEST';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function person() {
  const { who } = run.read();
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** The person's bank API through Edge, signed in once: `{ ok, data }` or `{ ok: false, status, code }`. */
async function bankFor(who) {
  const client = await api(who);
  const call = async (method, procedure, input) => {
    const route = `/api/bank/trpc/${procedure}`;
    const { status, body } =
      method === 'query'
        ? await client.get(`${route}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`)
        : await client.post(route, input);
    if (status !== 200) {
      const data = body?.error?.data;
      return { ok: false, status, code: data?.intafacedCode ?? data?.cause?.code ?? data?.code, body };
    }
    return { ok: true, data: body.result.data };
  };
  return {
    call,
    async spaces() {
      const res = await call('query', 'spaces.list', { limit: 50 });
      if (!res.ok) throw new Error(`spaces.list refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
      return res.data;
    },
  };
}

const main = (rows) => rows.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
const named = (rows) => rows.find((s) => s.kind === 'named' && s.name === SPACE);
/** Every USDT space of the person added up: the main balance plus the named space. */
const held = (rows) => rows.filter((s) => s.assetId === 'USDT').reduce((sum, s) => sum + toUnits(s.balance), 0n);

/** Opens the move form from main into the space and fills it, up to the review. */
async function reviewMove(page, rows, amount) {
  await page.goto('/bank/transfers');
  await page.getByLabel('From your space').selectOption(main(rows).id);
  await page.getByRole('button', { name: 'Continue' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('To which of your accounts').selectOption(named(rows).id);
  await dialog.getByLabel(/Amount/).fill(amount);
  await dialog.getByRole('button', { name: 'Review' }).click();
  return dialog;
}

test(`${J} #1 moves TEST 20 from the main balance into a space: instant, no fee, in History, and the same id twice is one move`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'w7');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ who });
  const bank = await bankFor(who);
  expect((await bank.call('mutation', 'spaces.create', { assetId: 'USDT', name: SPACE })).ok).toBe(true);
  const before = await bank.spaces();
  expect(named(before)).toBeTruthy();

  await signIn(page, who);
  const sent = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/bank/trpc/transfers.create')) sent.push(req.postDataJSON());
  });
  const dialog = await reviewMove(page, before, '20');
  const answered = page.waitForResponse((res) => res.url().includes('/api/bank/trpc/transfers.create'));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  const original = (await (await answered).json()).result.data;
  await expect(dialog.getByText(/ledger/i).first()).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(original.amount).toMatch(/^20(\.0+)?$/);

  // Instant and fee-free: exactly 20 left main and exactly 20 reached the space; together they still hold 100.
  const after = await bank.spaces();
  expect(toUnits(main(before).balance) - toUnits(main(after).balance)).toBe(toUnits('20'));
  expect(toUnits(named(after).balance) - toUnits(named(before).balance)).toBe(toUnits('20'));
  expect(held(after)).toBe(toUnits('100'));

  // The same transfer id sent again is the same move: the same ledger entry, and nothing moves twice.
  const first = sent[0];
  const again = await bank.call('mutation', 'transfers.create', first);
  expect(again).toMatchObject({ ok: true, data: { ledgerTxId: original.ledgerTxId } });
  const replayed = await bank.spaces();
  expect(replayed.map((s) => [s.id, s.balance])).toEqual(after.map((s) => [s.id, s.balance]));

  await page.goto('/money/activity');
  const moves = page
    .locator('main tr, main li, main article')
    .filter({ hasText: 'Moved between your accounts' })
    .filter({ hasText: SPACE });
  await expect(moves.first()).toContainText('+20 USDT');
  await expect(moves).toHaveCount(1);
});

test(`${J} #2 tries to move more than is available: refused by name, and nothing moves`, async ({ page }) => {
  const who = person();
  const bank = await bankFor(who);
  const before = await bank.spaces();
  expect(main(before).balance).toMatch(/^80(\.0+)?$/);
  await signIn(page, who);
  const sent = [];
  page.on('request', (req) => req.method() === 'POST' && req.url().includes('/api/bank/trpc/transfers.') && sent.push(req.url()));
  const dialog = await reviewMove(page, before, '81');
  await expect(dialog.getByRole('alert')).toContainText('The amount exceeds the available quantity in this space.');
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
  expect(sent).toEqual([]);

  // The bank refuses it by its code too, when asked directly, and posts nothing.
  const direct = await bank.call('mutation', 'transfers.create', {
    transferId: `jw07-over-${main(before).id}`,
    fromSpaceId: main(before).id,
    toSpaceId: named(before).id,
    amount: '81',
  });
  expect(direct).toMatchObject({ ok: false, status: 400, code: 'bank.insufficient_funds' });
  const after = await bank.spaces();
  expect(after.map((s) => [s.id, s.balance])).toEqual(before.map((s) => [s.id, s.balance]));
  expect(held(after)).toBe(toUnits('100'));
});

// ── W-withdraw-14: a withdrawal to an address on the platform ───────────────

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

function sender() {
  const state = run.read();
  if (!state.who || !state.secret || !state.friend) throw new Error(`${J} #3 set up no friend or authenticator, so this step cannot run`);
  return state;
}

/** The next authenticator code for the person, keeping its step so no code is used twice. */
async function code() {
  const state = sender();
  const { totp } = await totpLib();
  const next = await nextCode(totp, state.secret, state.step);
  run.reset({ ...state, step: next.step });
  return next.code;
}

async function signInWithCode(page) {
  const { who } = sender();
  const totpCode = await code();
  await page.goto('/login');
  await page.fill('input[name=totp]', totpCode);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Answers the "Confirm it's you" dialog with the next authenticator code. */
async function confirmItsMe(page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Authenticator code or recovery code').fill(await code());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  return dialog;
}

/** A person's own USDT deposit address on TEST Ethereum, asked of the bank through their own API. */
async function depositAddress(client) {
  const res = await client.post('/api/bank/trpc/deposits.address', { assetId: 'USDT', networkId: 'ethereum' });
  const address = res.body?.result?.data?.address;
  if (res.status !== 200 || !address) throw new Error(`deposits.address refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return address;
}

/** The friend's free USDT on the ledger, read through the friend's own API. */
const friendUsdt = async () => toUnits((await (await api(sender().friend)).balances()).USDT?.free ?? '0');

/** The Withdraw form filled with an address and an amount, after the bank answered where the address leads. */
async function fillWithdraw(page, address, amount) {
  await page.goto('/uc/withdraw');
  const form = page.getByTestId('withdraw-form');
  await expect(form.getByText(/^Available: /)).toBeVisible();
  await form.getByLabel('Or enter a new address').fill(address);
  await form.getByRole('textbox', { name: /^Amount/ }).fill(amount);
  return form;
}

/** What the form says the person has available, in units. */
async function available(page) {
  await page.goto('/uc/withdraw');
  const line = page.getByTestId('withdraw-form').getByText(/^Available: /);
  await expect(line).toBeVisible();
  return toUnits((await line.innerText()).match(/Available: ([\d.]+) USDT/)[1]);
}

/** Requests the page sends to `withdrawal.create`, by body. */
function creates(page) {
  const seen = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/pay/trpc/withdrawal.create')) seen.push(req.postDataJSON());
  });
  return seen;
}

test(`${J} #3 withdraws to a friend's address on the platform: told it settles inside with no fee, it completes at once, one transfer`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { who } = run.read();
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  // The friend: a second verified TEST account with a USDT deposit address on the platform.
  const friend = await signUp(page, 'w7f');
  await verify(page, friend);
  const friendAddress = await depositAddress(await api(friend));
  // The person's own address, for #4, asked before the authenticator is added (identity then wants a code to sign in).
  const ownAddress = await depositAddress(await api(who));
  await signIn(page, who);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ ...run.read(), friend, friendAddress, ownAddress, secret, step });

  const friendBefore = await friendUsdt();
  const before = await available(page);
  expect(before).toBe(toUnits('80'));
  const sent = creates(page);
  const form = await fillWithdraw(page, friendAddress, '10');
  const note = form.getByTestId('withdraw-destination');
  await expect(note).toHaveAttribute('data-kind', 'internal');
  await expect(note).toContainText('Settles inside INTAFACED');
  await expect(note).toContainText('It arrives at once, with no network fee.');
  const review = page.getByTestId('withdraw-review');
  await expect(review).toContainText('Inside INTAFACED, no network');
  await expect(review).toContainText('No fee');
  await page.getByRole('button', { name: 'Send inside INTAFACED' }).click();
  await confirmItsMe(page);
  const outcome = page.getByTestId('withdraw-outcome');
  await expect(outcome).toContainText('Sent inside INTAFACED');
  await expect(outcome).toContainText('10 USDT reached the other account at once, with no fee.');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ railId: 'internal', amount: '10', destination: { kind: 'crypto', ref: friendAddress } });

  // Exactly 10 left the person and exactly 10 reached the friend: no fee, one transfer.

  // The withdrawal itself: settled at once, inside the platform.
  const detail = await outcome.getByRole('link', { name: 'See this withdrawal' }).getAttribute('href');
  expect((await friendUsdt()) - friendBefore).toBe(toUnits('10'));
  expect(before - (await available(page))).toBe(toUnits('10'));
  await page.goto(detail);
  const status = page.getByTestId('withdrawal-status');
  await expect(status).toHaveAttribute('data-status', 'settled');
  await expect(status).toHaveText('Settled');
  await expect(page.getByTestId('withdrawal-facts')).toContainText('Inside INTAFACED, no network');
});

test(`${J} #4 withdraws to their own address on the platform: refused as a send to yourself, and nothing moves`, async ({ page }) => {
  test.setTimeout(300_000);
  const { ownAddress, friendAddress, who } = sender();
  await signInWithCode(page);
  const before = await available(page);
  const friendBefore = await friendUsdt();
  const sent = creates(page);
  const form = await fillWithdraw(page, ownAddress, '5');
  const note = form.getByTestId('withdraw-destination');
  await expect(note).toHaveAttribute('data-kind', 'self');
  await expect(note).toHaveAttribute('role', 'alert');
  await expect(note).toContainText('A withdrawal to yourself is refused.');
  await expect(page.getByRole('button', { name: 'Send inside INTAFACED' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();
  expect(sent).toEqual([]);

  // Asked directly with a fresh confirmation, svc-pay refuses it by name whatever rail is named, and claims nothing.
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, totpCode: await code() }),
  }).then((r) => r.json());
  const session = login?.result?.data?.accessToken;
  expect(session, 'sign-in with a code').toBeTruthy();
  const stepped = await fetch(`${EDGE}/api/identity/trpc/auth.stepUp`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${session}` },
    body: JSON.stringify({ totpCode: await code() }),
  }).then((r) => r.json());
  const token = stepped?.result?.data?.accessToken;
  expect(token, 'a fresh confirmation').toBeTruthy();
  for (const railId of ['internal', 'crypto-native']) {
    const res = await fetch(`${EDGE}/api/pay/trpc/withdrawal.create`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        assetId: 'USDT',
        amount: '5',
        railId,
        destination: { kind: 'crypto', ref: ownAddress },
        clientRef: `jw07-self-${railId}-${Date.now()}`,
      }),
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(400);
    expect(body?.error?.data?.intafacedCode ?? body?.error?.data?.cause?.code ?? body?.error?.message).toContain(
      'pay.withdrawal_self_send',
    );
  }
  expect(await friendUsdt()).toBe(friendBefore);
  expect(await available(page)).toBe(before);
  expect(friendAddress).not.toBe(ownAddress);
});

test(`${J} #5 loses the answer mid-send and retries: one transfer, and the retry reuses the stored key`, async ({ page }) => {
  test.setTimeout(300_000);
  const { friendAddress } = sender();
  await signInWithCode(page);
  const before = await available(page);
  const friendBefore = await friendUsdt();
  const sent = creates(page);
  // The first answer is dropped after svc-pay has done the work: the page hears nothing back.
  let first = null;
  await page.route('**/api/pay/trpc/withdrawal.create**', async (route) => {
    const response = await route.fetch();
    first = await response.json();
    await route.abort('connectionreset');
  });
  await fillWithdraw(page, friendAddress, '5');
  await expect(page.getByTestId('withdraw-destination')).toHaveAttribute('data-kind', 'internal');
  await page.getByRole('button', { name: 'Send inside INTAFACED' }).click();
  const dialog = await confirmItsMe(page);
  await expect(dialog.getByRole('alert')).toContainText('never sends twice');
  expect(first?.result?.data?.status).toBe('sent');
  await page.unroute('**/api/pay/trpc/withdrawal.create**');

  // Confirming again finishes the same withdrawal: the same reference, the same transfer.
  const answered = page.waitForResponse((res) => res.url().includes('/api/pay/trpc/withdrawal.create'));
  await confirmItsMe(page);
  const again = (await (await answered).json()).result.data;
  await expect(page.getByTestId('withdraw-outcome')).toContainText('5 USDT reached the other account at once, with no fee.');
  expect(sent).toHaveLength(2);
  expect(sent[1].clientRef).toBe(sent[0].clientRef);
  expect(again).toMatchObject({ id: first.result.data.id, status: 'sent', railRef: first.result.data.railRef });

  // One transfer: exactly 5 moved once.
  expect((await friendUsdt()) - friendBefore).toBe(toUnits('5'));
  expect(before - (await available(page))).toBe(toUnits('5'));
});
