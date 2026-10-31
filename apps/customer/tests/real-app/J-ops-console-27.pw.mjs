import path from 'node:path';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, bestPrices, fromUnits, journeyState, mailedLines, stackFile, toUnits, tool } from './stack.mjs';
import { confirm, deskPath, previewed, reviewSheet, signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { readRail, recordRailMovement } from '../../../../tooling/scripts/local-test-rail-records.mjs';

// J-ops-console-27, in the running app (its step table lands in docs/roadmap/journeys.json): the money loop. One fresh customer signs up, passes
// TEST verification, deposits on the TEST chain, buys on the desk, pays a person, cashes out, withdraws, and every cent
// reconciles. One test per step, titled "J-ops-console-27 #<n>", run in order on that one TEST account (#5's recipient
// is a second fresh account). Nothing is funded by hand: the only money in is #3's TEST chain transfer, delivered to
// svc-pay's own chain webhook signed with the stack's secret (local-test-stack.mjs chain-deposit), as the chain watcher
// would. #4 fills against the real matching engine and the stack's TEST market maker. #6 pays out through the stack's
// TEST payout stand-in (BANK_PAYOUT_PARTNER=payout-sim, which pays nobody). #7 sends out through svc-pay's TEST custody
// signer for TEST Ethereum (PAY_TEST_WITHDRAW_SIGNER_NETWORKS, stack only), on the TEST withdrawal terms the stack's
// founders publish (local-test-gates.mjs withdraw-terms). Each step keeps what the owning service's own record says it
// moved; #8 reads the ledger back for the customer on every asset it holds and checks each against those records, and
// the founders reconcile each outside rail's boundary (rail:crypto-native, rail:payout-sim) against that rail's own
// statement, which the stack serves from the stand-ins' records (local-test-rail-statements.mjs).
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

/** One outside rail's own records (the stand-in's TEST lines, local-test-rail-records.mjs), read from the running stack's state folder. */
const railRecords = (rail) => readRail(stackFile('.'), rail);

/** The account menu in this browser: what identity answers for the browser's own session (handle, account id, level). */
async function accountSummary(page) {
  const menu = page.getByRole('button', { name: 'Account menu' });
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  const summary = page.getByTestId('account-summary');
  await expect(summary).toHaveAttribute('aria-busy', 'false');
  return summary;
}

test(`${J} #1 signs up as a fresh customer: signed in to a new account that holds nothing`, async ({ page }) => {
  const who = await signUp(page, 'jm');
  run.reset({ who });
  await expect(page.getByRole('main').getByText('Verify your identity first').first()).toBeVisible();
  // The page that asked, kept so #2 can see it stop asking.
  const asked = new URL(page.url());
  run.write({ askedAt: `${asked.pathname}${asked.search}` });
  const api = await client(who);
  // Signed in in this browser: the account menu reads identity with the browser's own session, and it names this new
  // account (its handle and the account id identity gave the sign-in), not yet verified.
  const summary = await accountSummary(page);
  await expect(summary).toContainText(`@${who.handle}`);
  await expect(summary).toContainText(`Account ID ${api.userId.slice(0, 8)}…`);
  await expect(summary).toContainText('Verification: Not verified');
  // A new account: the ledger lists nothing for it, or only zeros.
  const balances = await api.balances();
  for (const [asset, row] of Object.entries(balances)) expect(toUnits(row.total), asset).toBe(0n);
});

test(`${J} #2 passes TEST verification: identity reads the account as fully verified`, async ({ page }) => {
  const { who, askedAt } = state();
  if (!askedAt) throw new Error(`${J} #1 kept no page that asked to verify, so this step cannot see it stop asking`);
  await signIn(page, who);
  // The request in the app, then the stack's two TEST operators approve it through identity's own two-person door.
  await verify(page, who);
  // Identity's own answer to the customer: the tier this account now adds up to, from its approved Full record.
  const kyc = await (await client()).query('identity', 'kyc.status', { limit: 10 });
  expect(kyc.ok, JSON.stringify(kyc.body)).toBe(true);
  expect(kyc.data.tier).toBe('full');
  expect(kyc.data.records.filter((r) => r.tier === 'full' && r.status === 'approved')).toHaveLength(1);
  // Signed in again, the app reads the account as fully verified and no longer asks for verification.
  await signIn(page, who);
  await page.goto(askedAt);
  await expect(await accountSummary(page)).toContainText('Verification: Full');
  // The page that asked in #1 now shows what stood in the prompt's place (the total value) and the verification step
  // done, and the prompt is gone.
  const main = page.getByRole('main');
  await expect(main.getByRole('img', { name: /^\$[\d,]+\.\d{2}$/ })).toBeVisible();
  await expect(
    main.getByRole('region', { name: 'Get started' }).getByRole('link', { name: /^Verify your identity\s+Done$/ }),
  ).toBeVisible();
  await expect(main.getByText('Verify your identity first')).toHaveCount(0);
  await page.goto(deskPath());
  // svc-trade answers the desk's market preview for this account (200, where an unverified one is refused), and once that
  // answer is in, the desk's buy reason is shown and is not a verification reason. The buy itself waits for funds (#3).
  await page.locator('[role=tab]', { hasText: /^Market$/ }).click();
  await previewed(page, () => page.getByRole('textbox', { name: 'Amount' }).first().fill(BUY_BTC));
  await expect(page.locator('#dk-reason-buy')).toBeVisible();
  await expect(page.locator('#dk-reason-buy')).not.toContainText('Verify your identity first');
});

/**
 * One TEST chain delivery of `amount` USDT to `address`, `confirmations` deep, as transfer `label`. Returns its hash and
 * the chain's key for it (`<hash>:<output>`, the key the TEST chain's own record carries).
 */
function chainDeposit(address, amount, confirmations, label) {
  const out = tool('local-test-stack.mjs', 'chain-deposit', address, ASSET, amount, String(confirmations), '--tx', label);
  expect(out).toContain('"received":true');
  const found = /^\s*tx\s+((0x[0-9a-f]{64}):\d+)/m.exec(out);
  expect(found, out).toBeTruthy();
  return { tx: found[2], key: found[1] };
}

/** svc-pay's own deposit records for transfer `tx`, as the customer's own API reads them (svc-bank `deposits.list`). */
async function depositRecords(api, tx) {
  const res = await api.query('bank', 'deposits.list', { txId: tx, limit: 10 });
  expect(res.ok, JSON.stringify(res.body)).toBe(true);
  return res.data.items.filter((item) => item.txHash === tx);
}

test(`${J} #3 deposits TEST ${DEPOSIT} ${ASSET} on the TEST chain: credited on the ledger, the amount read back`, async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const { who } = state();
  const api = await client();
  const before = total(await api.balances(), ASSET);
  expect(before).toBe(0n);
  // The depth svc-pay publishes for this coin on this network (its deposit catalogue, as the customer's API reads it).
  const terms = await api.query('bank', 'deposits.assets');
  expect(terms.ok, JSON.stringify(terms.body)).toBe(true);
  const published = (terms.data.assets.find((a) => a.assetId === ASSET)?.networks ?? []).filter((n) => n.label === NETWORK);
  expect(published, `${ASSET} on ${NETWORK} is published once`).toHaveLength(1);
  const depth = published[0].confirmationsRequired;
  expect(depth).toBeGreaterThan(0);
  await signIn(page, who);
  await page.goto('/uc/recharge');
  await page.mouse.move(0, 600);
  await page.getByRole('combobox', { name: /^Asset Coins you hold/ }).selectOption(ASSET);
  await page.getByRole('combobox', { name: 'Network', exact: true }).selectOption({ label: NETWORK });
  await page.getByRole('checkbox', { name: `I will send only ${ASSET} on ${NETWORK}.` }).check();
  await page.getByRole('button', { name: 'Show my deposit address' }).click();
  const address = (await page.getByTestId('deposit-address').locator('strong[data-testid="numeric"]').innerText()).trim();
  expect(address.length).toBeGreaterThan(8);

  // Seen, then one short of the published depth: nothing credited. At the depth: credited once, and only then.
  const label = `jm27-${who.handle}-r${testInfo.retry}`;
  const { tx, key } = chainDeposit(address, DEPOSIT, 0, label);
  expect(total(await api.balances(), ASSET)).toBe(before);
  expect(chainDeposit(address, DEPOSIT, depth - 1, label).tx).toBe(tx);
  expect(total(await api.balances(), ASSET), `${depth - 1} of ${depth} confirmations credits nothing`).toBe(before);
  const short = await depositRecords(api, tx);
  expect(short).toHaveLength(1);
  expect(short[0].status).not.toBe('credited');
  expect(short[0].creditedAt).toBeNull();
  expect(chainDeposit(address, DEPOSIT, depth, label).tx).toBe(tx);
  await page.reload();
  const records = page.locator('section', { has: page.getByRole('heading', { name: 'Deposit records' }) });
  const row = records.locator('tbody tr', { hasText: tx });
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'credited');
  await expect(row).toContainText(`${DEPOSIT} ${ASSET}`);
  expect(total(await api.balances(), ASSET) - before).toBe(toUnits(DEPOSIT));
  // A repeat of the same chain event credits nothing more: still one record, in the app and in svc-pay, and one credit.
  expect(chainDeposit(address, DEPOSIT, depth, label).tx).toBe(tx);
  await page.reload();
  await expect(row).toHaveCount(1);
  const [credited, ...extra] = await depositRecords(api, tx);
  expect(extra).toHaveLength(0);
  expect(credited).toMatchObject({ assetId: ASSET, status: 'credited', confirmationsRequired: depth });
  expect(credited.confirmations).toBeGreaterThanOrEqual(depth);
  expect(toUnits(credited.amount)).toBe(toUnits(DEPOSIT));
  const after = await api.balances();
  expect(total(after, ASSET) - before).toBe(toUnits(credited.amount));
  expect(toUnits(after[ASSET].free)).toBe(toUnits(credited.amount));
  // #8 reuses the address and the transfer: a held deposit to it, and the chain taking this one back once it is spent.
  run.write({ depositKey: key, depositAddress: address, depositLabel: label, depositId: credited.id, depositDepth: depth });
  record('deposit', { [ASSET]: [credited.amount] });
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
  // The rates svc-trade publishes for this account on this market: each fill's fee is charged at the published rate.
  const rates = await api.get(`/api/v1/account/fees?symbol=${encodeURIComponent('BTC/USDT')}`);
  expect(rates.ok, JSON.stringify(rates.body)).toBe(true);
  const rate = rates.data['BTC/USDT'];
  expect(rate, 'svc-trade publishes a fee rate for BTC/USDT').toBeTruthy();
  // Each fill is one engine trade: its own trade id, once, and this market order took resting liquidity (taker).
  expect(new Set(fills.data.map((fill) => fill.id)).size).toBe(fills.data.length);
  const moved = { BTC: 0n, [ASSET]: 0n };
  let bought = 0n;
  let charged = 0n;
  for (const fill of fills.data) {
    expect(fill.order).toBe(order.id);
    expect(fill.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(fill.id).not.toBe(order.id);
    expect(fill.takerOrMaker).toBe('taker');
    expect(fill.fee, `fill ${fill.id} carries its fee`).toBeTruthy();
    expect(['BTC', ASSET]).toContain(fill.fee.currency);
    expect(toUnits(String(fill.fee.rate))).toBe(toUnits(String(rate.taker)));
    // The fee is the published rate on what the fill delivered in the fee's currency, to the fee's own precision.
    const base = fill.fee.currency === 'BTC' ? toUnits(String(fill.amount)) : toUnits(String(fill.cost));
    const exact = (base * toUnits(String(fill.fee.rate))) / toUnits('1');
    const places = String(fill.fee.cost).split('.')[1]?.length ?? 0;
    const step = 10n ** BigInt(18 - Math.min(places, 18));
    const fee = toUnits(String(fill.fee.cost));
    expect(fee > exact ? fee - exact : exact - fee, `fill ${fill.id} fee ${fill.fee.cost} at rate ${fill.fee.rate}`).toBeLessThan(step);
    charged += fee;
    bought += toUnits(String(fill.amount));
    moved.BTC += toUnits(String(fill.amount));
    moved[ASSET] -= toUnits(String(fill.cost));
    moved[fill.fee.currency] -= fee;
  }
  expect(bought).toBe(toUnits(BUY_BTC));
  expect(charged, 'a fee was charged on the fill').toBeGreaterThan(0n);

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
  // The To field by its own role: Pay also shows a "Handle" discoverability switch.
  const to = page.getByRole('textbox', { name: 'Handle', exact: true });
  await to.fill(recipient.handle);
  await to.press('Tab');
  await expect(page.getByText(`@${recipient.handle}`).first()).toBeVisible();
  await page.getByLabel('Amount to send').fill(PAY);
  await expect(page.getByTestId('pay-terms')).toHaveAttribute('data-terms', 'ok');
  await page.getByTestId('pay-review').click();
  await page.getByTestId('pay-send').click();
  await expect(page.getByTestId('pay-receipt')).toBeVisible();
  const shown = /^\s*([\d.,]+)\s+(\S+)\s*$/.exec(await page.getByTestId('pay-receipt-amount').innerText());
  expect(shown, 'the receipt shows one amount and its asset').not.toBeNull();
  expect(toUnits(shown[1].replace(/,/g, ''))).toBe(toUnits(PAY));
  expect(shown[2]).toBe(ASSET);
  const reference = (await page.getByTestId('pay-receipt-reference').innerText()).trim();
  expect(reference).not.toBe('');

  // The paying service's own record of this send, found by the receipt's reference, as each party reads it.
  const paid = await sender.query('bank', 'transfers.get', { ledgerTxId: reference });
  expect(paid.ok, JSON.stringify(paid.body)).toBe(true);
  expect(paid.data).toMatchObject({
    ledgerTxId: reference,
    status: 'posted',
    assetId: ASSET,
    fromHandle: who.handle,
    toHandle: recipient.handle,
  });
  expect(toUnits(paid.data.amount)).toBe(toUnits(PAY));
  const got = await them.query('bank', 'transfers.get', { ledgerTxId: reference });
  expect(got.ok, JSON.stringify(got.body)).toBe(true);
  expect(got.data).toMatchObject({ ledgerTxId: reference, transferId: paid.data.transferId, amount: paid.data.amount, assetId: ASSET });

  expect(before.sender - total(await sender.balances(), ASSET)).toBe(toUnits(paid.data.amount));
  expect(total(await them.balances(), ASSET) - before.recipient).toBe(toUnits(paid.data.amount));
  run.write({ payReference: reference });
  record('pay', { [ASSET]: [`-${paid.data.amount}`] });
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
  const linked = await api.query('bank', 'linkedAccounts.list');
  expect(linked, 'the linked accounts are read').toMatchObject({ ok: true });
  const named = linked.data.accounts.filter((entry) => entry.label === BANK_LABEL);
  expect(named, `exactly one linked account is ${BANK_LABEL}`).toHaveLength(1);
  const [account] = named;
  expect(await partner('verify', { accountId: account.accountId })).toMatchObject({ state: 'verified' });
  expect(tool('local-test-stack.mjs', 'age-linked-accounts', who.email, '25')).toContain('1 linked account(s)');
  const before = total(await api.balances(), ASSET);

  await seeCashOut(page, CASH_OUT);
  await expect(page.getByTestId('cash-out-blocker')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cash out', exact: true }).click();
  await confirmItsMe(page);
  await expect(page.getByTestId('cash-out-sent')).toContainText('Your cash-out is on its way');
  const asked = await api.query('bank', 'cashOut.requests', { limit: 10 });
  expect(asked, 'the cash-out requests are read').toMatchObject({ ok: true });
  expect(asked.data, 'this account has made one cash-out').toHaveLength(1);
  const [taken] = asked.data;
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
  const reread = await api.query('bank', 'cashOut.requests', { limit: 10 });
  expect(reread, 'the cash-out requests are read again').toMatchObject({ ok: true });
  const requests = reread.data;
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    requestId: taken.requestId,
    amount: CASH_OUT,
    assetId: ASSET,
    status: 'completed',
    payoutRef: `TEST-PAYOUT-${taken.requestId}`,
    ledgerTxId: paid.ledgerTxId,
  });
  const after = await api.balances();
  expect(before - total(after, ASSET)).toBe(toUnits(CASH_OUT));
  // Completed means paid out: nothing of it is still held on the ledger.
  expect(toUnits(after[ASSET]?.used ?? '0'), `${ASSET} held after the payout`).toBe(0n);
  // Recorded on the rail: the TEST payout stand-in's own record (its line in the stack's rail records, which its
  // statement totals), one payout out of custody for this request, of this amount and asset.
  const key = `cash-out:${taken.requestId}:paid`;
  const onRail = railRecords('payout-sim').filter((line) => line.key.startsWith(`cash-out:${taken.requestId}:`));
  expect(onRail, `payout-sim's records for cash-out ${taken.requestId}`).toHaveLength(1);
  // The rail's own line carries the stand-in's payout reference, the one the customer and svc-bank show.
  expect(onRail[0]).toMatchObject({ key, direction: 'out', assetId: ASSET, ref: requests[0].payoutRef });
  expect(onRail[0].ref).toBe(`TEST-PAYOUT-${taken.requestId}`);
  expect(toUnits(onRail[0].amount)).toBe(toUnits(requests[0].amount));
  run.write({ cashOutKey: key });
  record('cashOut', { [ASSET]: [`-${requests[0].amount}`] });
});

test(`${J} #7 withdraws TEST ${WITHDRAW} ${ASSET} on the TEST chain with the stack's TEST signer: sent and settled, and the amount and fee leave the ledger`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const { who } = state();
  // The stack's founders publish the TEST withdrawal terms in svc-pay: the fee quote policy and this network's rules.
  const published = tool('local-test-gates.mjs', 'withdraw-terms');
  expect(published).toMatch(/withdrawal quote policy: (already )?published/);
  expect(published).toMatch(new RegExp(`withdrawal rules ${ASSET} on ethereum: (already )?published`));
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
  // svc-pay's own quote on its published terms (its `withdrawal.quote` answer to this page): the fee it charges, and what
  // leaves the balance, the amount plus that fee.
  const quoted = page.waitForResponse((r) => r.url().includes('/pay/trpc/withdrawal.quote') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Get the fee' }).click();
  const answer = await quoted;
  expect(answer.status()).toBe(200);
  const body = await answer.json();
  const quote = (Array.isArray(body) ? body[0] : body).result.data;
  expect(quote).toMatchObject({ assetId: ASSET, networkId: 'ethereum' });
  expect(toUnits(quote.amount)).toBe(toUnits(WITHDRAW));
  expect(toUnits(quote.feeTotal), 'svc-pay quotes a fee').toBeGreaterThan(0n);
  expect(toUnits(quote.totalDebit)).toBe(toUnits(quote.amount) + toUnits(quote.feeTotal));
  // The review shows svc-pay's quote.
  const review = page.getByTestId('withdraw-review');
  await expect(review).toContainText(/Leaves your balance\s*[\d.]+ USDT/);
  const leaves = /Leaves your balance\s*([\d.]+) USDT/.exec(await review.innerText())[1];
  expect(toUnits(leaves)).toBe(toUnits(quote.totalDebit));
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
  const [settled] = made;
  const one = await api.query('pay', 'withdrawal.get', { withdrawalId: settled.id });
  expect(one.ok, JSON.stringify(one.body)).toBe(true);
  const sent = one.data;
  expect(sent).toMatchObject({ id: settled.id, assetId: ASSET, rail: 'crypto-native', networkId: 'ethereum', customerStatus: 'settled' });
  expect(sent.destination).toMatchObject({ kind: 'crypto', ref: WALLET });
  expect(toUnits(sent.amount)).toBe(toUnits(WITHDRAW));
  // svc-pay recorded the fee it quoted.
  expect(sent.fee, 'svc-pay records the withdrawal fee').not.toBeNull();
  expect(toUnits(sent.fee)).toBe(toUnits(quote.feeTotal));
  // Sent by the stack's TEST signer on the TEST chain: the chain's own reference for the send is on svc-pay's record, and
  // the TEST chain's own record holds the send for this withdrawal, of this amount and asset, out of custody.
  expect(sent.railRef, "svc-pay records the TEST chain's reference for the send").toMatch(/^0x[0-9a-z]+$/);
  const onChain = railRecords('crypto-native').filter((line) => line.key.startsWith(`send:pay.payout:${sent.id}:`));
  expect(onChain, `the TEST chain's records for withdrawal ${sent.id}`).toHaveLength(1);
  expect(onChain[0]).toMatchObject({ direction: 'out', assetId: ASSET });
  expect(toUnits(onChain[0].amount)).toBe(toUnits(sent.amount));
  // The ledger moved by exactly the amount and the fee svc-pay recorded, and holds nothing back.
  expect(before - total(await api.balances(), ASSET)).toBe(toUnits(sent.amount) + toUnits(sent.fee));
  expect(toUnits((await api.balances())[ASSET].used)).toBe(0n);
  run.write({ withdrawalKey: onChain[0].key });
  record('withdraw', { [ASSET]: [`-${sent.amount}`, `-${sent.fee}`] });
});

test(`${J} #8 reconciles to the cent: the ledger read back for the customer on every asset equals what each service recorded`, async () => {
  const { moves = {} } = state();
  for (const step of ['deposit', 'buy', 'pay', 'cashOut', 'withdraw'])
    if (!moves[step]) throw new Error(`${J} ${step} recorded no move, so there is nothing to reconcile against`);
  const expected = {};
  for (const byAsset of Object.values(moves))
    for (const [asset, amounts] of Object.entries(byAsset))
      for (const amount of amounts) expected[asset] = (expected[asset] ?? 0n) + toUnits(amount);
  // The ledger's own read for this person: the assets it holds are exactly those the records moved, and each equals the
  // sum of the recorded moves.
  const balances = await (await client()).balances();
  const listed = Object.keys(balances).filter((asset) => toUnits(balances[asset].total) !== 0n);
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
// rail the customer's money crossed, defined by founder A and run once a second founder approves.
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

async function defineOutside(section, rail, tag) {
  const details = section.getByTestId('rc-define');
  if (!(await details.evaluate((el) => el.open))) await details.locator('summary').click();
  const form = section.getByTestId('rc-form-define');
  const explanation = `LOCAL TEST rail ${rail} outside balance ${J} ${tag}`;
  await form.getByLabel('Template').selectOption('outside_balance');
  await form.getByLabel('Explanation (optional)').fill(explanation);
  // One rail's boundary: the treasury account `rail:<rail>` value crosses on its way in or out, on every asset, judged
  // against that rail's own statement (the stand-in's records, served by the stack), never against the ledger read back.
  // No asset is named, so an asset the ledger holds on that boundary and the statement leaves out is UNSET, not skipped.
  await form.getByLabel('Rail boundary').fill(rail);
  await form.getByLabel('Account kind').selectOption('available');
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
  await expect(defined).toContainText(`boundary of rail ${rail}`);
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

// The rails whose stand-ins keep their own statement (local-test-rail-statements.mjs), and the steps that moved value
// across each. Rail `local-test` is the stack's TEST mint: it has no outside side, so it gets no control.
const RAIL_STEPS = { 'crypto-native': ['deposit', 'withdraw'], 'payout-sim': ['cashOut'] };
// The business key each of those steps left on that rail's own records (#3 the chain transfer, #7 the TEST signer's send,
// #6 the payout), so a run judges a statement that holds this customer's movements.
const RAIL_KEYS = { 'crypto-native': ['depositKey', 'withdrawalKey'], 'payout-sim': ['cashOutKey'] };
// What a FAIL on each rail means, by name.
const BREAK = {
  'crypto-native': 'rail deposits received but not credited are not booked (the boundary differs from the TEST chain statement)',
  'payout-sim': 'payouts the TEST bank rail made are not booked (the boundary differs from the TEST payout statement)',
};

// The held deposits open on each rail (lead ruling on #8: no netting, held deposits post nothing). svc-pay's custody
// deposits all arrive on crypto-native, so only that rail can carry them; payout-sim never does.
const OPEN_ITEMS_RAILS = new Set(['crypto-native']);
// One asset's evidence line on a run (apps/admin describeEvidence), with the items' sum and the residual when items were read.
const EVIDENCE =
  /([A-Z0-9._-]+): observed (-?[\d.]+), expected (-?[\d.]+|unset), difference (-?[\d.]+|unset), tolerance [^,.]+(?:\.\d+)?(?:, reconciling items (-?[\d.]+), residual (-?[\d.]+|unset))?\./g;
// One named item on a run (apps/admin describeRun): kind, id, asset, signed amount, the service that holds its record.
const ITEM = /(held|reversal_unfunded) (\S+) ([A-Z0-9._-]+) (-?[\d.]+) \(svc-pay\)\./g;
// The TEST transfer no item lists, written on the rail's own records to show the control can FAIL by it.
const STRAY = '0.01';
const describeNet = (net) =>
  Object.entries(net)
    .filter(([, units]) => units !== 0n)
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([asset, units]) => `${asset} ${fromUnits(units)}`)
    .join(', ') || 'net 0';

/**
 * The founders' read of open custody items (svc-pay founderAdmin.depositOpenItems.list, on the console's custody-ops
 * page): per asset, the signed sum over every network (held positive, taken back uncovered negative), and the count.
 */
async function openItems(page) {
  await page.goto(`${ADMIN}/custody-ops`, { waitUntil: 'load' });
  const section = page.getByRole('region', { name: 'Open custody items' });
  await expect(section.getByTestId('co-open-none').or(section.getByTestId('co-open-total'))).toBeVisible({ timeout: 60_000 });
  if (await section.getByTestId('co-open-none').isVisible()) return { total: 0, net: {} };
  const total = Number(await section.getByTestId('co-open-total').getAttribute('data-total'));
  const net = {};
  for (const row of await section.getByTestId('co-open-sum').all()) {
    const asset = await row.getAttribute('data-asset-id');
    net[asset] = (net[asset] ?? 0n) + toUnits(await row.getAttribute('data-net'));
  }
  return { total, net };
}

/**
 * Opens two custody items of this run's own on crypto-native, so #8 judges named items, never only an empty list: a TEST
 * deposit below the published minimum to #3's address (held: custody has it, the ledger booked nothing), and the TEST chain
 * taking back #3's transfer after #4 to #7 spent part of it (an uncovered reversal: the ledger credited it, custody no
 * longer has it). Each is read back from svc-pay's own record. A retry repeats the same two chain events, which svc-pay
 * treats as the same reports.
 */
async function openItemsOfThisRun() {
  const { depositAddress, depositLabel, depositId, depositDepth } = state();
  if (!depositAddress || !depositLabel || !depositId) throw new Error(`${J} #3 kept no deposit address, label or id for #8`);
  const api = await client();
  const terms = await api.query('bank', 'deposits.assets');
  expect(terms.ok, JSON.stringify(terms.body)).toBe(true);
  const [network] = (terms.data.assets.find((a) => a.assetId === ASSET)?.networks ?? []).filter((n) => n.label === NETWORK);
  expect(network, `${ASSET} on ${NETWORK} is published with a minimum deposit`).toBeTruthy();
  expect(typeof network.minimumDeposit, 'the minimum deposit is published, not blank').toBe('string');
  const below = toUnits(network.minimumDeposit) / 2n;
  expect(below, `half of the published ${ASSET} minimum is above 0`).toBeGreaterThan(0n);
  const { tx: heldTx } = chainDeposit(depositAddress, fromUnits(below), depositDepth, `${depositLabel}-below-minimum`);
  const [held] = await depositRecords(api, heldTx);
  expect(held, 'svc-pay recorded the deposit below the minimum').toMatchObject({ status: 'below_minimum', reason: 'below_minimum' });
  const free = total(await api.balances(), ASSET);
  expect(free, `#4 to #7 spent part of #3's ${DEPOSIT} ${ASSET}, so a reversal can't be covered`).toBeLessThan(toUnits(DEPOSIT));
  expect(tool('local-test-stack.mjs', 'chain-reorg', depositAddress, '--tx', depositLabel)).toContain('TEST chain reorg delivered');
  const [, taken] = /^(0x[0-9a-f]{64}):/.exec(state().depositKey) ?? [];
  const [reversed] = await depositRecords(api, taken);
  expect(reversed, 'svc-pay holds the reversed deposit for review, unfunded').toMatchObject({
    id: depositId,
    status: 'needs_review',
    reason: 'reversal_unfunded',
  });
  // The ledger posted nothing for either: the customer's balance is unchanged by both.
  expect(total(await api.balances(), ASSET)).toBe(free);
  return [
    { id: held.id, kind: 'held', units: below, what: 'the held deposit below the minimum' },
    { id: depositId, kind: 'reversal_unfunded', units: -toUnits(DEPOSIT), what: "the uncovered reversal of #3's deposit" },
  ];
}

test(`${J} #8 reconciles to the cent: each rail's boundary PASSes against that rail's own statement`, async ({ browser }) => {
  test.setTimeout(600_000);
  const { moves = {} } = state();
  const a = await founder(browser, 'a');
  const b = await founder(browser, 'b');
  const tag = `${state().who.handle}-${Date.now().toString(36)}`;
  // A run killed between the unlisted transfer and its reversal (below) left the rail off by STRAY: close it first, so no
  // later run judges a stray it never wrote.
  for (const rail of Object.keys(RAIL_STEPS)) {
    const keys = new Set(railRecords(rail).map((line) => line.key));
    for (const key of keys) {
      if (!key.startsWith('test-unlisted:') || !key.endsWith(':in')) continue;
      const out = `${key.slice(0, -':in'.length)}:out`;
      if (!keys.has(out)) recordRailMovement(stackFile('.'), { rail, key: out, direction: 'out', assetId: ASSET, amount: STRAY });
    }
  }
  const mine = await openItemsOfThisRun();
  const judged = [];
  for (const [rail, steps] of Object.entries(RAIL_STEPS)) {
    const crossed = [...new Set(steps.flatMap((step) => Object.keys(moves[step] ?? {})))].sort();
    if (!crossed.length) throw new Error(`${J} ${steps.join(' and ')} recorded no move, so rail ${rail} has nothing to reconcile`);
    // This run's own movements are on the rail's records the statement totals, each once, before the run is asked for.
    const keys = RAIL_KEYS[rail].map((name) => {
      const key = state()[name];
      if (!key) throw new Error(`${J} kept no ${name}, so rail ${rail}'s statement cannot be tied to this run`);
      return key;
    });
    const lines = railRecords(rail);
    for (const key of keys)
      expect(
        lines.filter((line) => line.key === key),
        `${rail}: its records hold ${key} once`,
      ).toHaveLength(1);
    const carries = OPEN_ITEMS_RAILS.has(rail);
    // The founders' own read of what is open (custody-ops), before and after: the two must agree, or the run judged a
    // moving list. Only crypto-native can carry custody items; on payout-sim the run must say it read none.
    const before = carries ? await openItems(a) : null;
    const id = await defineOutside(await openLedger(a), rail, tag);
    const answer = await twoFounderRun(a, b, id, tag);
    if (carries) expect(await openItems(a), `${rail}: the open custody items did not change during the run`).toEqual(before);
    judged.push(rail);
    // The run read this rail's boundary: one account per asset on it, never a set that nets to 0.
    const read = /(\d+) accounts? and \d+ assets? read\./.exec(answer);
    expect.soft(read, `${rail}: the run names how many boundary accounts it read`).not.toBeNull();
    expect.soft(Number(read?.[1] ?? 0), `${rail}: at least one boundary account read`).toBeGreaterThan(0);
    for (const asset of crossed) {
      const observed = new RegExp(`${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: observed (-?[\\d.]+),`).exec(answer);
      expect.soft(observed, `${rail} ${asset}: the run names what the boundary holds`).not.toBeNull();
      expect.soft(toUnits(observed?.[1] ?? '0'), `${rail} ${asset}: the boundary the customer's money crossed is not 0`).not.toBe(0n);
    }
    // The outside side is this rail's own statement (LEDGER_RECONCILE_RAIL_<RAIL>_URL, the stack's rail-statements stand-in).
    expect.soft(answer, `${rail}: the outside side is this rail's own statement`).toContain('Outside side: snapshot');
    const evidence = [...answer.matchAll(EVIDENCE)];
    expect.soft(evidence.length, `${rail}: the run names each asset's difference`).toBeGreaterThan(0);
    if (!carries) {
      // No open items on this rail: the boundary must equal the statement exactly, and no item is taken out.
      expect.soft(answer, `${rail}: no open items are read for this rail`).not.toContain('reconciling item');
      for (const [, asset, , , difference] of evidence) expect.soft(difference, `${rail} ${asset}: difference`).toBe('0');
      expect.soft(answer, `${rail}: ${BREAK[rail]}`).toMatch(/Run [0-9a-f-]{36}: PASS\./);
    } else {
      // Lead ruling 2026-10-30: the rail PASSes only when its difference is exactly the open items svc-pay lists, each named
      // on the run with its id and amount; the residual on every asset is 0. Branch by the count the founders read.
      // This run opened two items of its own (openItemsOfThisRun), so the items branch always runs, never only "none open".
      expect(before.total, `${rail}: the founders read at least this run's two open items`).toBeGreaterThanOrEqual(2);
      console.log(`${J} #8 ${rail}: ${before.total} items open (${describeNet(before.net)}); expecting PASS with each named`);
      const count = /(\d+) reconciling items?[:.]/.exec(answer);
      expect.soft(count, `${rail}: the run says how many open items it took out`).not.toBeNull();
      expect.soft(Number(count?.[1] ?? -1), `${rail}: the run took out exactly the items the founders read`).toBe(before.total);
      const named = [...answer.matchAll(ITEM)];
      expect.soft(named.length, `${rail}: each item is named on the run`).toBe(before.total);
      expect.soft(new Set(named.map((m) => m[2])).size, `${rail}: each item is named once, by its own id`).toBe(named.length);
      const sums = {};
      for (const [, kind, , asset, amount] of named) {
        expect.soft(toUnits(amount) > 0n, `${rail}: a ${kind} item carries its sign`).toBe(kind === 'held');
        sums[asset] = (sums[asset] ?? 0n) + toUnits(amount);
      }
      expect.soft(describeNet(sums), `${rail}: the named items add up to the founders' read`).toBe(describeNet(before.net));
      for (const [, asset, , , difference, items, residual] of evidence) {
        expect.soft(difference, `${rail} ${asset}: the statement names this asset`).not.toBe('unset');
        expect.soft(items, `${rail} ${asset}: the run states the items' sum`).toBe(fromUnits(before.net[asset] ?? 0n));
        expect.soft(residual, `${rail} ${asset}: nothing is left once the items are taken out`).toBe('0');
      }
      // This run's own two items, each by its deposit id with its exact signed amount.
      for (const want of mine) {
        const hit = named.find((m) => m[2] === want.id);
        expect.soft(hit?.[1], `${rail}: the run names ${want.what} ${want.id}`).toBe(want.kind);
        expect.soft(hit?.[3], `${rail}: ${want.id} is in ${ASSET}`).toBe(ASSET);
        expect.soft(toUnits(hit?.[4] ?? '0'), `${rail}: ${want.id} carries exactly ${fromUnits(want.units)}`).toBe(want.units);
      }
      expect.soft(answer, `${rail}: ${BREAK[rail]}`).toMatch(/Run [0-9a-f-]{36}: PASS\./);
    }

    // The scope can be non-zero (checklist point 9): a TEST transfer into custody that no item lists, written on the rail's
    // own records, FAILs the same control by exactly that amount, named as the residual. An equal TEST transfer out then
    // closes it, so the rail's records net back to what they were.
    const stray = `test-unlisted:${tag}`;
    recordRailMovement(stackFile('.'), {
      rail,
      key: `${stray}:in`,
      direction: 'in',
      assetId: ASSET,
      amount: STRAY,
      at: new Date(Date.now() - 60_000).toISOString(),
    });
    let strayAnswer;
    try {
      strayAnswer = await twoFounderRun(a, b, id, `${tag}-unlisted`);
    } finally {
      recordRailMovement(stackFile('.'), { rail, key: `${stray}:out`, direction: 'out', assetId: ASSET, amount: STRAY });
    }
    expect.soft(strayAnswer, `${rail}: a transfer no item lists FAILs the rail`).toMatch(/Run [0-9a-f-]{36}: FAIL\./);
    // With items the residual decides (column 6); on a rail without items the difference does (column 4).
    const decides = carries ? 6 : 4;
    const strayRow = [...strayAnswer.matchAll(EVIDENCE)].find((m) => m[1] === ASSET);
    const firstRow = evidence.find((m) => m[1] === ASSET);
    expect.soft(strayRow?.[decides], `${rail} ${ASSET}: the run names what is left over`).toMatch(/^-?[\d.]+$/);
    expect
      .soft(
        fromUnits(toUnits(strayRow?.[decides] ?? '0') - toUnits(firstRow?.[decides] ?? '0')),
        `${rail} ${ASSET}: what is left over moved by exactly the unlisted transfer`,
      )
      .toBe(STRAY);
  }
  expect(judged, 'every rail with a statement was judged').toEqual(Object.keys(RAIL_STEPS));
});
