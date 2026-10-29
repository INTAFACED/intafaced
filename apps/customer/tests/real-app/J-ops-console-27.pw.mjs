import path from 'node:path';
import { test, expect } from '@playwright/test';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, bestPrices, fromUnits, journeyState, mailedLines, toUnits, tool } from './stack.mjs';
import { confirm, deskPath, previewed, reviewSheet, signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-27, in the running app (its step table lands in docs/roadmap/journeys.json): the money loop. One fresh customer signs up, passes
// TEST verification, deposits on the TEST chain, buys on the desk, pays a person, cashes out, withdraws, and every cent
// reconciles. One test per step, titled "J-ops-console-27 #<n>", run in order on that one TEST account (#5's recipient
// is a second fresh account). Nothing is funded by hand: the only money in is #3's TEST chain transfer, delivered to
// svc-pay's own chain webhook signed with the stack's secret (local-test-stack.mjs chain-deposit), as the chain watcher
// would. #4 fills against the real matching engine and the stack's TEST market maker. #6 pays out through the stack's
// TEST payout stand-in (BANK_PAYOUT_PARTNER=payout-sim, which pays nobody). #7 sends out through svc-pay's TEST custody
// signer for TEST Ethereum (PAY_TEST_WITHDRAW_SIGNER_NETWORKS, stack only), on the TEST withdrawal terms the stack's
// founders publish (local-test-gates.mjs withdraw-terms). Each step keeps what the owning service's own record says it
// moved; #8 reads the ledger back for the customer on every asset it holds and checks each against those records.
const J = 'J-ops-console-27';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ASSET = 'USDT';
const NETWORK = 'TEST Ethereum';
const DEPOSIT = '300';
const BUY_BTC = '0.001';
const PAY = '25';
const CASH_OUT = '20';
const WITHDRAW = '25';
// TEST: the standard example IBAN and a TEST wallet address, not a customer's.
const IBAN = 'GB82 WEST 1234 5698 7654 32';
const BANK_LABEL = 'TEST salary account';
const WALLET = '0x52908400098527886E0F7030069857D2E4169EE7';
const WALLET_LABEL = 'TEST send wallet';

test.describe.configure({ mode: 'default' });

function state() {
  const now = run.read();
  if (!now.who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return now;
}

/** Each move a step proved, by the owning service's own record: { asset: [decimal, ...] }, signed. */
function record(step, moves) {
  run.write({ moves: { ...(state().moves ?? {}), [step]: moves } });
}

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** The next authenticator code after the last one this run used, so no code is used twice. */
async function freshCode() {
  const now = state();
  if (!now.secret) throw new Error(`${J} #6 set up no authenticator, so this step has no second factor`);
  const { totp } = await totpLib();
  const { code, step } = await nextCode(totp, now.secret, now.step);
  run.write({ step });
  return code;
}

/** Signs in in the browser: with an authenticator code once #6 has set one up, with the password alone before. */
async function signInNow(page) {
  const { who, secret } = state();
  if (!secret) return signIn(page, who);
  const code = await freshCode();
  await page.goto('/login');
  await page.fill('input[name=totp]', code);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function confirmItsMe(page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Authenticator code or recovery code').fill(await freshCode());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  return dialog;
}

/**
 * `who`'s own API through Edge, with a session of its own (not the browser's): REST reads and tRPC by service. The run's
 * own customer signs in with its authenticator once #6 has set one up; anyone else (#5's recipient) with a password only.
 */
async function client(who = state().who) {
  const secret = who.email === state().who.email ? state().secret : undefined;
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceKey: DEVICE_KEY,
      identifier: who.email,
      password: who.password,
      ...(secret ? { totpCode: await freshCode() } : {}),
    }),
  }).then((res) => res.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${JSON.stringify(login).slice(0, 300)}`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const answer = async (res) => {
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, code: body?.error?.data?.intafacedCode ?? body?.error?.data?.code, body };
    return { ok: true, data: body?.result ? body.result.data : body };
  };
  return {
    userId: login.result.data.userId,
    get: (route) => fetch(`${EDGE}${route}`, { headers }).then(answer),
    query: (service, procedure, input) =>
      fetch(`${EDGE}/api/${service}/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, {
        headers,
      }).then(answer),
    /** The ledger's own balances for this person (svc-ledger `balances`, owner user), as { asset: { free, used, total } }. */
    async balances() {
      const res = await fetch(`${EDGE}/api/v1/account/balance`, { headers }).then(answer);
      if (!res.ok) throw new Error(`balance read refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
      return res.data.balances;
    },
  };
}

/** One asset's total on the ledger, in units (an asset the ledger does not list is zero). */
const total = (balances, asset) => toUnits(balances[asset]?.total ?? '0');

test(`${J} #1 signs up as a fresh customer: signed in to a new account that holds nothing`, async ({ page }) => {
  const who = await signUp(page, 'jm');
  run.reset({ who });
  await expect(page.getByRole('main').getByText('Verify your identity first').first()).toBeVisible();
  // A new account: the ledger lists nothing for it, or only zeros.
  const balances = await (await client(who)).balances();
  for (const [asset, row] of Object.entries(balances)) expect(toUnits(row.total), asset).toBe(0n);
});

test(`${J} #2 passes TEST verification: identity reads the account as fully verified`, async ({ page }) => {
  const { who } = state();
  await signIn(page, who);
  // The request in the app, then the stack's two TEST operators approve it through identity's own two-person door.
  await verify(page, who);
  const status = tool('local-test-gates.mjs', 'status');
  const accounts = JSON.parse(status.slice(status.indexOf('{'))).accounts;
  expect(accounts.filter((a) => a.handle === who.handle)).toHaveLength(1);
  expect(accounts.find((a) => a.handle === who.handle).tiers).toContain('full');
  // Signed in again, the app no longer asks for verification.
  await signIn(page, who);
  await page.goto(deskPath());
  // svc-trade answers the desk's market preview for this account (200, where an unverified one is refused), and once that
  // answer is in, the desk gives no verification reason. The buy itself waits for funds (#3).
  await page.locator('[role=tab]', { hasText: /^Market$/ }).click();
  await previewed(page, () => page.getByRole('textbox', { name: 'Amount' }).first().fill(BUY_BTC));
  await expect(page.locator('#dk-reason-buy')).not.toContainText('Verify your identity first');
});

/** One TEST chain delivery of `amount` USDT to `address`, `confirmations` deep, as transfer `label`. Returns its hash. */
function chainDeposit(address, amount, confirmations, label) {
  const out = tool('local-test-stack.mjs', 'chain-deposit', address, ASSET, amount, String(confirmations), '--tx', label);
  expect(out).toContain('"received":true');
  const tx = /^\s*tx\s+(0x[0-9a-f]{64}):\d+/m.exec(out)?.[1];
  expect(tx, out).toBeTruthy();
  return tx;
}

test(`${J} #3 deposits TEST ${DEPOSIT} ${ASSET} on the TEST chain: credited on the ledger, the amount read back`, async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const { who } = state();
  const api = await client();
  const before = total(await api.balances(), ASSET);
  expect(before).toBe(0n);
  await signIn(page, who);
  await page.goto('/uc/recharge');
  await page.mouse.move(0, 600);
  await page.getByRole('combobox', { name: /^Asset Coins you hold/ }).selectOption(ASSET);
  await page.getByRole('combobox', { name: 'Network', exact: true }).selectOption({ label: NETWORK });
  await page.getByRole('checkbox', { name: `I will send only ${ASSET} on ${NETWORK}.` }).check();
  await page.getByRole('button', { name: 'Show my deposit address' }).click();
  const address = (await page.getByTestId('deposit-address').locator('strong[data-testid="numeric"]').innerText()).trim();
  expect(address.length).toBeGreaterThan(8);

  // Seen, then confirmed past the published depth: credited once, and only then.
  const label = `jm27-${who.handle}-r${testInfo.retry}`;
  const tx = chainDeposit(address, DEPOSIT, 0, label);
  expect(total(await api.balances(), ASSET)).toBe(before);
  expect(chainDeposit(address, DEPOSIT, 6, label)).toBe(tx);
  await page.reload();
  const records = page.locator('section', { has: page.getByRole('heading', { name: 'Deposit records' }) });
  const row = records.locator('tbody tr', { hasText: tx });
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'credited');
  await expect(row).toContainText(`${DEPOSIT} ${ASSET}`);
  // A repeat of the same chain event credits nothing more.
  expect(chainDeposit(address, DEPOSIT, 6, label)).toBe(tx);
  const after = await api.balances();
  expect(total(after, ASSET) - before).toBe(toUnits(DEPOSIT));
  expect(toUnits(after[ASSET].free)).toBe(toUnits(DEPOSIT));
  record('deposit', { [ASSET]: [DEPOSIT] });
});

test(`${J} #4 buys ${BUY_BTC} BTC on the desk: a real matching-engine fill, and the ledger moves by the fill and its fee`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { who } = state();
  const api = await client();
  const before = await api.balances();
  await signIn(page, who);
  await page.goto(deskPath());
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
  await bestPrices();
  // The closed orders this account had before, so the order read back is the one this step placed.
  const closedBuys = async () => {
    const closed = await api.get(`/api/v1/orders/closed?symbol=${encodeURIComponent('BTC/USDT')}&limit=50`);
    expect(closed.ok, JSON.stringify(closed.body)).toBe(true);
    const list = Array.isArray(closed.data) ? closed.data : (closed.data.orders ?? closed.data.items ?? []);
    return list.filter((o) => o.side === 'buy' && o.status === 'closed');
  };
  const earlier = new Set((await closedBuys()).map((o) => o.id));
  await page.locator('[role=tab]', { hasText: /^Market$/ }).click();
  await previewed(page, () => page.getByRole('textbox', { name: 'Amount' }).first().fill(BUY_BTC));
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  await expect(reviewSheet(page)).toContainText(/Price protection/);
  await confirm(page, 'buy');

  // The order, closed by the engine, and its fills as svc-trade recorded them.
  let order;
  await expect
    .poll(
      async () => {
        const placed = (await closedBuys()).filter((o) => !earlier.has(o.id));
        expect(placed.length).toBeLessThanOrEqual(1);
        order = placed[0];
        return order?.id ?? null;
      },
      { timeout: 20_000 },
    )
    .not.toBeNull();
  expect(toUnits(String(order.filled))).toBe(toUnits(BUY_BTC));
  const fills = await api.get(`/api/v1/orders/${order.id}/trades?limit=50`);
  expect(fills.ok, JSON.stringify(fills.body)).toBe(true);
  expect(fills.data.length).toBeGreaterThan(0);
  const moved = { BTC: 0n, [ASSET]: 0n };
  let bought = 0n;
  for (const fill of fills.data) {
    expect(fill.order).toBe(order.id);
    bought += toUnits(String(fill.amount));
    moved.BTC += toUnits(String(fill.amount));
    moved[ASSET] -= toUnits(String(fill.cost));
    if (fill.fee && toUnits(String(fill.fee.cost)) !== 0n)
      moved[fill.fee.currency] = (moved[fill.fee.currency] ?? 0n) - toUnits(String(fill.fee.cost));
  }
  expect(bought).toBe(toUnits(BUY_BTC));

  // The ledger moved by exactly the fills and their fees, on every asset they touched, and holds nothing back.
  const after = await api.balances();
  for (const [asset, delta] of Object.entries(moved)) expect(total(after, asset) - total(before, asset), asset).toBe(delta);
  expect(toUnits(after[ASSET].used)).toBe(0n);
  record('buy', Object.fromEntries(Object.entries(moved).map(([asset, units]) => [asset, [fromUnits(units)]])));
});

test(`${J} #5 pays a person TEST ${PAY} ${ASSET}: the recipient is credited and the sender debited, both read back`, async ({ page }) => {
  test.setTimeout(180_000);
  // The person paid: a second fresh, verified account that holds nothing.
  const recipient = await signUp(page, 'jmr');
  await verify(page, recipient);
  run.write({ recipient });
  const { who } = state();
  const sender = await client();
  const them = await client(recipient);
  const before = { sender: total(await sender.balances(), ASSET), recipient: total(await them.balances(), ASSET) };
  expect(before.recipient).toBe(0n);

  await signIn(page, who);
  await page.goto('/pay');
  const to = page.getByLabel('Handle');
  await to.fill(recipient.handle);
  await to.press('Tab');
  await expect(page.getByText(`@${recipient.handle}`).first()).toBeVisible();
  await page.getByLabel('Amount to send').fill(PAY);
  await expect(page.getByTestId('pay-terms')).toHaveAttribute('data-terms', 'ok');
  await page.getByTestId('pay-review').click();
  await page.getByTestId('pay-send').click();
  await expect(page.getByTestId('pay-receipt')).toBeVisible();
  await expect(page.getByTestId('pay-receipt-amount')).toContainText(PAY);
  const reference = (await page.getByTestId('pay-receipt-reference').innerText()).trim();
  expect(reference).not.toBe('');

  expect(before.sender - total(await sender.balances(), ASSET)).toBe(toUnits(PAY));
  expect(total(await them.balances(), ASSET) - before.recipient).toBe(toUnits(PAY));
  run.write({ payReference: reference });
  record('pay', { [ASSET]: [`-${PAY}`] });
});

/** The TEST payout stand-in's signed job door, called as the partner would call it. */
let jobCtx;
async function partner(what, body) {
  jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} }));
  const ctx = await jobCtx;
  const raw = JSON.stringify(body);
  const res = await fetch(`${ctx.url('bank')}/internal/jobs/payout-sim/${what}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const answer = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`payout-sim/${what} refused: ${res.status} ${JSON.stringify(answer).slice(0, 300)}`);
  return answer;
}

async function seeCashOut(page, amount) {
  await page.goto('/bank/ramps/cash-out');
  await expect(page.getByRole('heading', { name: 'Cash out to your bank', level: 1 })).toBeVisible();
  await page.getByLabel('Currency to cash out').selectOption(ASSET);
  await page.getByLabel('Amount').fill(amount);
  await page.getByLabel('Bank account to pay into').selectOption({ label: `${BANK_LABEL} (GB82 •••• 5432)` });
  await page.getByRole('button', { name: 'See what you get' }).click();
}

test(`${J} #6 cashes out TEST ${CASH_OUT} ${ASSET} to a linked bank account: completed by the TEST payout stand-in, and the balance moved by it`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { who } = state();
  // The cash-out and the withdrawal both ask "Confirm it's you": the person adds an authenticator first.
  await signIn(page, who);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.write({ secret, step });

  await page.goto('/bank/ramps/accounts');
  const form = page.getByRole('form', { name: 'Link a bank account' });
  await form.getByLabel('Name for this account').fill(BANK_LABEL);
  await form.getByLabel('Account holder').fill('TEST Holder');
  await form.getByLabel('IBAN', { exact: true }).fill(IBAN);
  await form.getByRole('button', { name: 'Link account' }).click();
  await confirmItsMe(page);
  await expect(form).toContainText(`Linked ${BANK_LABEL}. It is unverified.`);

  // The partner verifies the account, and the TEST fixture moves its link past the 24-hour cooling-off.
  const api = await client();
  const [account] = (await api.query('bank', 'linkedAccounts.list')).data.accounts;
  expect(await partner('verify', { accountId: account.accountId })).toMatchObject({ state: 'verified' });
  expect(tool('local-test-stack.mjs', 'age-linked-accounts', who.email, '25')).toContain('1 linked account(s)');
  const before = total(await api.balances(), ASSET);

  await seeCashOut(page, CASH_OUT);
  await expect(page.getByTestId('cash-out-blocker')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cash out', exact: true }).click();
  await confirmItsMe(page);
  await expect(page.getByTestId('cash-out-sent')).toContainText('Your cash-out is on its way');
  const [taken] = (await api.query('bank', 'cashOut.requests', { limit: 10 })).data;
  expect(taken).toMatchObject({ amount: CASH_OUT, assetId: ASSET, status: 'processing' });

  const paid = await partner('paid', { cashOutId: taken.requestId });
  expect(paid).toMatchObject({ status: 'completed', ledgerTxId: expect.any(String) });
  await page.reload();
  const done = page.locator('[data-testid="cash-out-request"][data-status="completed"]');
  await expect(done).toHaveCount(1);
  await expect(done.getByTestId('cash-out-steps')).toHaveAttribute('aria-label', 'Completed (2/2)');
  // Recorded on the rail: the TEST payout stand-in's own payout reference for this request.
  await expect(done).toContainText(`Bank reference: TEST-PAYOUT-${taken.requestId}`);
  // The receipt names the ledger transaction the payout posted.
  const receipt = done.getByTestId('cash-out-receipt');
  await Promise.all([page.waitForEvent('download'), receipt.getByRole('button', { name: 'Download receipt' }).click()]);
  await expect(receipt.getByTestId('cash-out-receipt-ledger')).toHaveText(`Ledger record: ${paid.ledgerTxId}`);
  const requests = (await api.query('bank', 'cashOut.requests', { limit: 10 })).data;
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ requestId: taken.requestId, amount: CASH_OUT, assetId: ASSET, status: 'completed' });
  expect(before - total(await api.balances(), ASSET)).toBe(toUnits(CASH_OUT));
  record('cashOut', { [ASSET]: [`-${requests[0].amount}`] });
});

test(`${J} #7 withdraws TEST ${WITHDRAW} ${ASSET} on the TEST chain with the stack's TEST signer: sent and settled, and the amount and fee leave the ledger`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const { who } = state();
  tool('local-test-gates.mjs', 'withdraw-terms');
  await signInNow(page);

  // A saved wallet on TEST Ethereum, approved by its emailed link in another browser and past its cooling-off.
  await page.goto('/uc/withdraw/address');
  const add = page.getByRole('form', { name: 'Add an address' });
  await add.getByRole('textbox', { name: /^Label/ }).fill(WALLET_LABEL);
  await add.getByRole('combobox', { name: /^Asset/ }).selectOption(ASSET);
  await add.getByRole('combobox', { name: /^Network/ }).selectOption('ethereum');
  await add.getByRole('textbox', { name: /^Address/ }).fill(WALLET);
  await add.getByRole('button', { name: 'Save address' }).click();
  await confirmItsMe(page);
  await expect(page.getByText(`${WALLET_LABEL} was saved to your address book.`)).toBeVisible();
  const links = () =>
    mailedLines(who.email, 'withdraw-address-approval').map((line) => {
      const link = /link=(approveAddress\?token=\S+)/.exec(line)?.[1];
      if (!link) throw new Error(`an address-approval mail with no approval link: ${line}`);
      return `/${link}`;
    });
  const seen = links().length;
  await page.locator('tbody tr', { hasText: WALLET_LABEL }).getByRole('button', { name: 'Withdraw to this address' }).click();
  await page.getByTestId('address-use').getByRole('button', { name: 'Email me an approval link' }).click();
  await expect.poll(() => links().length, { timeout: 20_000 }).toBeGreaterThan(seen);
  const other = await browser.newContext();
  try {
    const away = await other.newPage();
    await away.goto(links().at(-1));
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

  const api = await client();
  const before = total(await api.balances(), ASSET);
  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  const form = page.getByTestId('withdraw-form');
  await form.getByRole('combobox', { name: /^Asset/ }).selectOption(ASSET);
  await expect(form.getByRole('combobox', { name: /^Network/ })).toHaveValue('ethereum');
  const saved = form.getByRole('combobox', { name: /^Saved address/ });
  await saved.selectOption({ label: `${WALLET_LABEL} · 0x5290…9EE7 · Ready to use` });
  await form.getByRole('textbox', { name: /^Amount/ }).fill(WITHDRAW);
  await page.getByRole('button', { name: 'Get the fee' }).click();
  // svc-pay's quote, as the review shows it: what leaves the balance is the amount plus the TEST terms' 1.5 fixed fee.
  const review = page.getByTestId('withdraw-review');
  await expect(review).toContainText(/Leaves your balance\s*[\d.]+ USDT/);
  const leaves = /Leaves your balance\s*([\d.]+) USDT/.exec(await review.innerText())[1];
  expect(toUnits(leaves)).toBe(toUnits(WITHDRAW) + toUnits('1.5'));
  await page.getByRole('button', { name: 'Confirm and send' }).click();
  await confirmItsMe(page);
  await expect(page.getByTestId('withdraw-outcome')).toContainText('Withdrawal recorded', { timeout: 30_000 });

  // svc-pay's own record: one withdrawal, sent by the TEST signer and settled on the TEST chain, with its amount and fee.
  let made;
  await expect
    .poll(
      async () => {
        const history = await api.query('pay', 'withdrawal.history', { limit: 10 });
        made = history.ok ? history.data.items : [];
        return made.map((w) => w.status);
      },
      { timeout: 60_000 },
    )
    .toEqual(['settled']);
  const [sent] = made;
  expect(sent.assetId).toBe(ASSET);
  expect(toUnits(sent.amount)).toBe(toUnits(WITHDRAW));
  // The ledger moved by exactly what the quote said leaves the balance, and holds nothing back.
  expect(before - total(await api.balances(), ASSET)).toBe(toUnits(leaves));
  expect(toUnits((await api.balances())[ASSET].used)).toBe(0n);
  record('withdraw', { [ASSET]: [`-${sent.amount}`, `-${fromUnits(toUnits(leaves) - toUnits(sent.amount))}`] });
});

test(`${J} #8 reconciles to the cent: the ledger read back for the customer on every asset equals what each service recorded`, async () => {
  const { moves = {} } = state();
  for (const step of ['deposit', 'buy', 'pay', 'cashOut', 'withdraw'])
    if (!moves[step]) throw new Error(`${J} ${step} recorded no move, so there is nothing to reconcile against`);
  const expected = {};
  for (const byAsset of Object.values(moves))
    for (const [asset, amounts] of Object.entries(byAsset))
      for (const amount of amounts) expected[asset] = (expected[asset] ?? 0n) + toUnits(amount);
  // The ledger's own read for this person: each asset it lists once, and each equal to the sum of the recorded moves.
  const balances = await (await client()).balances();
  const listed = Object.keys(balances).filter((asset) => toUnits(balances[asset].total) !== 0n);
  expect(new Set(listed).size).toBe(listed.length);
  expect(listed.sort()).toEqual(
    Object.keys(expected)
      .filter((asset) => expected[asset] !== 0n)
      .sort(),
  );
  for (const [asset, units] of Object.entries(expected)) {
    expect(fromUnits(toUnits(balances[asset]?.total ?? '0')), asset).toBe(fromUnits(units));
    expect(toUnits(balances[asset]?.used ?? '0'), `${asset} held`).toBe(0n);
  }
});

// The founders' side of #8, on the console's /ledger desk (the J-ops-console-07 run path): one outside_balance control per
// asset the customer holds, defined by founder A and run once a second founder approves.
const founders = {};
test.afterAll(async () => {
  for (const page of Object.values(founders)) await page.context().close();
});
async function founder(browser, which) {
  founders[which] ??= await browser.newContext().then(async (context) => {
    const page = await context.newPage();
    await founderSignIn(page, which);
    return page;
  });
  return founders[which];
}

async function openLedger(page) {
  await page.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  const section = page.getByTestId('reconciliation-controls');
  await expect(section.getByTestId('rc-table')).toBeVisible({ timeout: 60_000 });
  const parked = section.getByTestId('rc-treasury-parked');
  if (await parked.isVisible())
    throw new Error(`the console's treasury doors are parked: ${(await parked.innerText()).replace(/\s+/g, ' ')}`);
  return section;
}

const controlRow = (section, id) => section.locator(`[data-testid="rc-row"][data-control-id="${id}"]`);

async function defineOutside(section, asset, tag) {
  const details = section.getByTestId('rc-define');
  if (!(await details.evaluate((el) => el.open))) await details.locator('summary').click();
  const form = section.getByTestId('rc-form-define');
  const explanation = `LOCAL TEST ${asset} outside balance ${J} ${tag}`;
  await form.getByLabel('Template').selectOption('outside_balance');
  await form.getByLabel('Explanation (optional)').fill(explanation);
  await form.getByLabel('Asset', { exact: true }).fill(asset);
  await form.getByLabel('Cadence').selectOption('daily');
  await form.getByLabel('Hour (UTC)').fill('6');
  await form.getByLabel('Minute').fill('30');
  await form.getByLabel('Severity').selectOption('warning');
  // To the cent: no tolerance.
  await form.getByLabel(/^Tolerance \(blank/).fill('0');
  await form.getByRole('checkbox').check();
  await form.getByLabel(/^Why/).fill(`LOCAL TEST ${J} define ${tag}`);
  await form.getByRole('button', { name: 'Define control' }).click();
  await expect(form.getByTestId('rc-saved')).toBeVisible({ timeout: 30_000 });
  const defined = section.getByTestId('rc-row').filter({ hasText: explanation });
  await expect(defined).toHaveCount(1);
  return defined.getAttribute('data-control-id');
}

/** Founder A asks for a run, founder B approves the packet on their own console, A runs it: the service's answer. */
async function twoFounderRun(a, b, controlId, tag) {
  const sectionA = await openLedger(a);
  await controlRow(sectionA, controlId)
    .getByRole('button', { name: /^Choose|^Chosen/ })
    .click();
  await expect(sectionA.getByTestId('rc-selected').getByRole('heading')).toHaveText(`Control ${controlId.slice(0, 8)}`);
  const desk = sectionA.getByTestId('rc-run');
  const phrase = `RUN CONTROL ${controlId.slice(0, 8)}`;
  await desk.getByLabel(/^Why \(recorded with the run/).fill(`LOCAL TEST ${J} run ${tag}`);
  await desk.getByLabel(/to confirm$/).fill(phrase);
  await desk.getByRole('button', { name: 'Ask a second founder to approve the run' }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packet = (await desk.getByLabel('Request packet').inputValue()).trim();

  const deskB = (await openLedger(b)).getByTestId('rc-run');
  await deskB.getByLabel('Request packet').fill(packet);
  await expect(deskB.getByTestId('packet-summary')).toContainText(`Run reconciliation control ${controlId}`);
  await deskB.getByLabel(/to approve or run it$/).fill(phrase);
  await deskB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(deskB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 30_000 });

  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  const reply = desk.getByTestId('step-reply');
  await expect(reply).toContainText('The service answered', { timeout: 60_000 });
  return (await reply.innerText()).replace(/\s+/g, ' ');
}

test(`${J} #8 reconciles to the cent: the founders' outside-side reconciliation PASSes on every asset the customer holds`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { moves = {} } = state();
  const assets = [...new Set(Object.values(moves).flatMap((byAsset) => Object.keys(byAsset)))].sort();
  if (!assets.length) throw new Error(`${J} #3 to #7 recorded no move, so no asset to reconcile`);
  const a = await founder(browser, 'a');
  const b = await founder(browser, 'b');
  const tag = `${state().who.handle}-${Date.now().toString(36)}`;
  for (const asset of assets) {
    const id = await defineOutside(await openLedger(a), asset, tag);
    const answer = await twoFounderRun(a, b, id, tag);
    // The outside side is the stack's LOCAL TEST rail snapshot (lane 5, LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL); with no
    // snapshot source the run answers "outside unset", and this clause stays red by that name.
    expect(answer, `${asset}: the outside side needs the stack's LOCAL TEST snapshot source`).toContain('Outside side: snapshot');
    expect(answer, asset).toMatch(new RegExp(`Run [0-9a-f-]{36}: PASS\\.`));
  }
});
