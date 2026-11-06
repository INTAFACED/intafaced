// World: gates, stack
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import {
  DEVICE_KEY,
  EDGE,
  ORIGIN,
  ROOT,
  fund,
  journeyState,
  mailedLines,
  signOutBrowser,
  staffFreeze,
  staffRestore,
  toUnits,
  tool,
} from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addAuthenticator, addPasskey, nextCode, virtualAuthenticator } from './identity-factors.mjs';
import { makeKey, withKey } from './developer.mjs';

// J-wallet-13, in the running app (docs/roadmap/journeys.json): I freeze everything in an emergency. One test per step,
// titled "J-wallet-13 #<n>", run in order on one verified TEST account that holds TEST 300 USDT, a passkey and an
// authenticator app (each a second factor), a live API key, a deposit address and a saved withdrawal wallet approved by
// its emailed link and past its cooling-off. The freeze is the person's own (svc-identity self-freeze, W-security-accounts-03):
// it ends every session and key at once, stops money out, address-book changes and new keys with the freeze named, and
// leaves deposits landing. Lifting it needs the stack's TEST wait (IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS) and a fresh
// second factor; a staff freeze is lifted only by staff, through the two-founder unfreeze. Every balance is read back from
// the ledger through the person's own API. The page runs on http://localhost:3210 so the passkey's relying party matches.
const J = 'J-wallet-13';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ASSET = 'USDT';
const NETWORK = 'TEST Ethereum';
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const LABEL = 'TEST freeze wallet';
const OTHER_ADDRESS = '0x8ba1f109551bd432803012645ac136ddd64dba72';

test.describe.configure({ mode: 'default' });
test.use({ baseURL: PASSKEY_ORIGIN });

function state() {
  const saved = run.read();
  if (!saved.account) throw new Error(`${J} made no account, so this step has no one to act as`);
  return saved;
}

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** The next authenticator code after the last one this run used, so no code is used twice. */
async function freshCode() {
  const saved = state();
  const { totp } = await totpLib();
  const { code, step } = await nextCode(totp, saved.secret, saved.step);
  run.reset({ ...saved, step });
  return code;
}

const query = (route, input) => `${route}?input=${encodeURIComponent(JSON.stringify(input))}`;
const codeOn = (body) =>
  body?.error?.data?.intafacedCode ?? body?.error?.data?.cause?.code ?? body?.error?.data?.code ?? body?.code ?? null;

/** The person's own API through Edge, on a sign-in of its own (password and a fresh authenticator code). */
async function customerApi() {
  const who = state().account;
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, totpCode: await freshCode() }),
  }).then((res) => res.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in refused: ${JSON.stringify(login).slice(0, 300)}`);
  const send = async (method, route, body, bearer = token) => {
    const res = await fetch(`${EDGE}${route}`, {
      method,
      headers: { origin: ORIGIN, authorization: `Bearer ${bearer}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return {
    token,
    get: (route) => send('GET', route),
    post: (route, body, bearer) => send('POST', route, body, bearer),
    async balance() {
      const { status, body } = await send('GET', '/api/v1/account/balance');
      if (status !== 200) throw new Error(`balance read refused: ${status} ${JSON.stringify(body).slice(0, 200)}`);
      return { free: toUnits(body.balances[ASSET]?.free ?? '0'), used: toUnits(body.balances[ASSET]?.used ?? '0') };
    },
    async withdrawals() {
      const { status, body } = await send('GET', query('/api/pay/trpc/withdrawal.history', { limit: 20 }));
      if (status !== 200) throw new Error(`withdrawal history refused: ${status}`);
      return body.result.data.items;
    },
    async sessions(userId) {
      const { status, body } = await send('GET', query('/api/identity/trpc/listSessions', { userId, limit: 200 }));
      if (status !== 200) throw new Error(`session list refused: ${status}`);
      return body.result.data.sessions;
    },
    async keys() {
      const { status, body } = await send('GET', query('/api/identity/trpc/apiKeys.list', { limit: 200 }));
      if (status !== 200) throw new Error(`key list refused: ${status}`);
      return body.result.data;
    },
    async accountStatus() {
      const { status, body } = await send('GET', '/api/identity/trpc/accountStatus.mine');
      return status === 200 ? body.result.data : { status, code: codeOn(body) };
    },
  };
}

/** Answers the "Confirm it's you" dialog with the next authenticator code. */
async function confirmItsMe(page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Authenticator code or recovery code').fill(await freshCode());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
}

async function signInWithCode(page) {
  const { account } = state();
  await page.goto('about:blank');
  await signOutBrowser(page.context());
  await page.goto('/login');
  await page.fill('input[name=totp]', await freshCode());
  await page.fill('input[name=identifier]', account.email);
  await page.fill('input[name=password]', account.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

/** The approval link mailed to `email` once more than `seen` have been. */
async function approvalLink(email, seen) {
  const links = () =>
    mailedLines(email, 'withdraw-address-approval').map((line) => `/${/link=(approveAddress\?token=\S+)/.exec(line)?.[1]}`);
  await expect.poll(() => links().length, { timeout: 20_000 }).toBeGreaterThan(seen);
  return links().at(-1);
}

/** One TEST chain delivery of `amount` to `address`, `confirmations` deep, as transfer `label`. Returns its hash. */
function chainDeposit(address, amount, confirmations, label) {
  const out = tool('local-test-stack.mjs', 'chain-deposit', address, ASSET, amount, String(confirmations), '--tx', label);
  expect(out).toContain('"received":true');
  const tx = /^\s*tx\s+(0x[0-9a-f]{64}):\d+/m.exec(out)?.[1];
  expect(tx, out).toBeTruthy();
  return tx;
}

const freezeCard = (page) => page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'Freeze your account' }) });
const frozenCard = (page) =>
  page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'You froze this account' }) });

test(`${J} starts: a verified TEST account with 300 USDT, a passkey and an authenticator, a live key, a deposit address and a saved wallet`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  tool('local-test-gates.mjs', 'withdraw-terms');
  await virtualAuthenticator(page);
  const who = await signUp(page, 'wf');
  await verify(page, who);
  await signIn(page, who);
  await addPasskey(page);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ account: who, secret, step });
  expect(fund(who.email, ASSET, '300').tx).toBeTruthy();

  // A live key, made through the form with the passkey (W-security-accounts-01).
  const key = await makeKey(page, { name: 'freeze-key', preset: 'Read only' });
  expect(key).toBeTruthy();

  // The deposit address on TEST Ethereum, as Deposit shows it.
  await page.goto('/uc/recharge');
  await page.mouse.move(0, 600);
  await page.getByRole('combobox', { name: /^Asset Coins you hold/ }).selectOption(ASSET);
  await page.getByRole('combobox', { name: 'Network', exact: true }).selectOption({ label: NETWORK });
  await page.getByRole('checkbox', { name: `I will send only ${ASSET} on ${NETWORK}.` }).check();
  await page.getByRole('button', { name: 'Show my deposit address' }).click();
  const depositAddress = (await page.getByTestId('deposit-address').locator('strong[data-testid="numeric"]').innerText()).trim();
  expect(depositAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

  // A saved wallet, approved by its emailed link in another browser and past its cooling-off, so a send could go out.
  await page.goto('/uc/withdraw/address');
  const add = page.getByRole('form', { name: 'Add an address' });
  await add.getByRole('textbox', { name: /^Label/ }).fill(LABEL);
  await add.getByRole('combobox', { name: /^Asset/ }).selectOption(ASSET);
  await add.getByRole('combobox', { name: /^Network/ }).selectOption('ethereum');
  await add.getByRole('textbox', { name: /^Address/ }).fill(ADDRESS);
  await add.getByRole('button', { name: 'Save address' }).click();
  await confirmItsMe(page);
  await expect(page.getByText(`${LABEL} was saved to your address book.`)).toBeVisible();
  const seen = mailedLines(who.email, 'withdraw-address-approval').length;
  await page.locator('tbody tr', { hasText: LABEL }).getByRole('button', { name: 'Withdraw to this address' }).click();
  await page.getByTestId('address-use').getByRole('button', { name: 'Email me an approval link' }).click();
  const link = await approvalLink(who.email, seen);
  const other = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
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
  expect(tool('local-test-stack.mjs', 'age-addresses', who.email, '25')).toContain('1 saved address(es)');
  await page.reload();
  await expect(page.locator('tbody tr', { hasText: LABEL })).toContainText('Ready to use');
  run.reset({ ...state(), key, depositAddress });
});

test(`${J} #1 presses Freeze on Safe: it applies at once and every session ends`, async ({ page }) => {
  test.setTimeout(180_000);
  const { account, key } = state();
  // Two sign-ins besides the browser's, made before the freeze, and the live key.
  const earlier = await customerApi();
  const before = await earlier.accountStatus();
  expect(before.state).toBe('active');
  await signInWithCode(page);

  await page.goto('/uc/safe');
  const card = freezeCard(page);
  await card.getByLabel('Your password').fill(account.password);
  const pressedAt = Date.now();
  await card.getByRole('button', { name: 'Freeze my account' }).click();
  // At once: the browser's own sign-in ends with it, so the room shows the freeze or the sign-in page, nothing else.
  await expect(
    page.getByRole('heading', { name: 'You froze this account' }).or(page.getByRole('heading', { name: 'Sign in to continue' })),
  ).toBeVisible();

  // Every session ends: the sign-in made before the freeze and the key are refused once Edge's authority cache passes.
  const { EDGE_AUTHORITY_CACHE_MAX_MS } = await import(path.join(ROOT, 'tooling/scripts/local-test-gates.mjs'));
  await new Promise((resolve) => setTimeout(resolve, EDGE_AUTHORITY_CACHE_MAX_MS + 100));
  const old = await earlier.get('/api/identity/trpc/accountStatus.mine');
  expect(old.status, JSON.stringify(old.body).slice(0, 300)).toBe(401);
  const viaKey = await withKey(key, { path: '/api/identity/trpc/accountStatus.mine' });
  expect(viaKey.status, JSON.stringify(viaKey.body).slice(0, 300)).toBe(401);
  await page.goto('/uc/safe');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();

  // Signed in again, only the new sign-in is live, the key is revoked, and identity holds the freeze since the press.
  const again = await customerApi();
  const status = await again.accountStatus();
  expect(status.state).toBe('frozen_self');
  const since = Date.parse(status.restrictions.find((r) => r.kind === 'self_freeze').since);
  expect(since).toBeGreaterThanOrEqual(pressedAt - 2_000);
  expect(since).toBeLessThanOrEqual(Date.now());
  const userId = (
    await (await fetch(`${EDGE}/api/identity/trpc/auth.me`, { headers: { origin: ORIGIN, authorization: `Bearer ${again.token}` } })).json()
  )?.result?.data?.userId;
  if (userId) expect((await again.sessions(userId)).map((s) => s.isCurrent)).toEqual([true]);
  expect((await again.keys()).filter((k) => k.name === 'freeze-key').map((k) => k.revoked)).toEqual([true]);
  run.reset({ ...state(), frozenAt: pressedAt });
});

test(`${J} #2 tries a withdrawal, an address change and a new key: each is refused with the freeze reason`, async ({ page }) => {
  test.setTimeout(180_000);
  const person = await customerApi();
  const start = await person.balance();
  expect(start.free).toBe(toUnits('300'));
  const before = (await person.withdrawals()).length;
  await signInWithCode(page);

  // A withdrawal to the saved wallet: the Withdraw room refuses it and names the freeze; nothing is held or recorded.
  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  const withdraw = page.getByTestId('withdraw-form');
  await expect(page.getByText(/You froze this account/).first()).toBeVisible();
  // svc-pay itself refuses it too, with a real quote and a fresh step-up, and names the freeze.
  const quoteRef = `${J}-quote-${Date.now()}`;
  const quoted = await person.post('/api/pay/trpc/withdrawal.quote', { quoteRef, assetId: ASSET, networkId: 'ethereum', amount: '25' });
  const stepped = await person.post('/api/identity/trpc/auth.stepUp', { totpCode: await freshCode() });
  expect(stepped.status, JSON.stringify(stepped.body).slice(0, 300)).toBe(200);
  const created = await person.post(
    '/api/pay/trpc/withdrawal.create',
    {
      assetId: ASSET,
      amount: '25',
      railId: 'crypto-native',
      networkId: 'ethereum',
      quoteRef,
      destination: { kind: 'crypto', ref: ADDRESS },
      clientRef: `${J}-frozen-${Date.now()}`,
    },
    stepped.body.result.data.accessToken,
  );
  expect(created.status, JSON.stringify({ quoted: quoted.body, created: created.body }).slice(0, 500)).not.toBe(200);
  expect(codeOn(created.body), JSON.stringify(created.body).slice(0, 300)).toMatch(/account_frozen_self$/);
  await expect(withdraw.or(page.getByTestId('withdraw-frozen'))).toBeVisible();

  // An address change: the address book refuses a new address and names the freeze.
  await page.goto('/uc/withdraw/address');
  const add = page.getByRole('form', { name: 'Add an address' });
  await add.getByRole('textbox', { name: /^Label/ }).fill('TEST another wallet');
  await add.getByRole('combobox', { name: /^Asset/ }).selectOption(ASSET);
  await add.getByRole('combobox', { name: /^Network/ }).selectOption('ethereum');
  await add.getByRole('textbox', { name: /^Address/ }).fill(OTHER_ADDRESS);
  await add.getByRole('button', { name: 'Save address' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  if (await dialog.isVisible().catch(() => false)) await confirmItsMe(page);
  await expect(page.getByText(/You froze this account/).first()).toBeVisible();
  await expect(page.getByText('TEST another wallet was saved to your address book.')).toHaveCount(0);

  // A new key: the key form refuses it and names the freeze.
  await page.goto('/uc/safe/api-keys/new');
  await page.getByLabel('Key name').fill('freeze-new-key');
  await page.getByLabel('Read only', { exact: true }).check();
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  await expect(page.getByText(/You froze this account/).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your new key' })).toHaveCount(0);

  // No withdrawal posts: the balance is whole, nothing is held and no withdrawal is recorded.
  const after = await person.balance();
  expect(after).toEqual(start);
  expect((await person.withdrawals()).length).toBe(before);
  expect((await person.keys()).filter((k) => k.name === 'freeze-new-key')).toHaveLength(0);
});

test(`${J} #3 receives a deposit while frozen: it still credits, exactly once`, async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const { depositAddress, account } = state();
  const person = await customerApi();
  expect((await person.accountStatus()).state).toBe('frozen_self');
  const start = await person.balance();
  const label = `jw13-${account.handle}-25-r${testInfo.retry}`;
  const tx = chainDeposit(depositAddress, '25', 6, label);
  await expect.poll(async () => (await person.balance()).free, { timeout: 30_000 }).toBe(start.free + toUnits('25'));
  // The same transfer delivered again credits nothing more.
  expect(chainDeposit(depositAddress, '25', 6, label)).toBe(tx);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect((await person.balance()).free).toBe(start.free + toUnits('25'));

  // The person sees it on Deposit's records, credited.
  await signInWithCode(page);
  await page.goto('/uc/recharge');
  const row = page
    .locator('section', { has: page.getByRole('heading', { name: 'Deposit records' }) })
    .locator('tbody tr', { hasText: tx.slice(0, 10) });
  await expect(row).toContainText(/Credited/i);
});

test(`${J} #4 unfreezes: it needs a fresh second factor, and a staff freeze needs staff`, async ({ page, browser }) => {
  test.setTimeout(240_000);
  const { frozenAt, account } = state();
  await signInWithCode(page);
  const due = frozenAt + 21_000;
  if (Date.now() < due) await page.waitForTimeout(due - Date.now());

  // The person's own freeze: Reactivate asks for a fresh second factor, and only that lifts it.
  await page.goto('/uc/safe');
  await frozenCard(page).getByRole('button', { name: 'Reactivate my account' }).click();
  const confirm = frozenCard(page).getByTestId('step-up-confirm');
  await expect(confirm).toBeVisible();
  // A wrong code lifts nothing.
  await confirm.getByLabel('Authenticator code').fill('000000');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Your account is active again.')).toHaveCount(0);
  const person = await customerApi();
  expect((await person.accountStatus()).state).toBe('frozen_self');
  await page.goto('/uc/safe');
  await frozenCard(page).getByRole('button', { name: 'Reactivate my account' }).click();
  await frozenCard(page)
    .getByTestId('step-up-confirm')
    .getByLabel('Authenticator code')
    .fill(await freshCode());
  await frozenCard(page).getByTestId('step-up-confirm').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Your account is active again.')).toBeVisible();
  expect((await person.accountStatus()).state).toBe('active');

  // A staff freeze of the same account: signing in is refused by name, the person is offered no reactivation, only staff lift it.
  const userId = await staffFreeze(account);
  let lifted = false;
  try {
    await page.goto('about:blank');
    await signOutBrowser(page.context());
    await page.goto('/login');
    await page.fill('input[name=totp]', await freshCode());
    await page.fill('input[name=identifier]', account.email);
    await page.fill('input[name=password]', account.password);
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/auth.login'));
    await page.getByRole('button', { name: /^sign in$/i }).click();
    const refused = await (await answered).json();
    expect(codeOn(refused)).toBe('auth.account_frozen');
    await expect(page.getByTestId('failure')).toContainText('Only support can lift a freeze');
    await expect(page.getByRole('button', { name: 'Reactivate in Security' })).toHaveCount(0);

    // Staff lift it through the two-founder unfreeze; then the person signs in again and the account is active.
    await staffRestore(userId);
    lifted = true;
    const back = await customerApi();
    expect((await back.accountStatus()).state).toBe('active');
  } finally {
    if (!lifted) await staffRestore(userId).catch((error) => console.warn(`${J} #4: restore after a failure failed: ${error}`));
  }
});
