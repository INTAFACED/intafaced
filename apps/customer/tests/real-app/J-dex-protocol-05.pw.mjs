// World: restart
import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  encodeFunctionData,
  formatUnits,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { CHAIN_ID, TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun, fundOnTestChain, testChain } from './dex.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { api, journeyState, ROOT, tool } from './stack.mjs';
import { installTestWallet, TEST_WALLET, testWalletKey } from './test-wallet.mjs';

// J-dex-protocol-05, in the running app (docs/roadmap/journeys.json): move value between a trading venue, the wallet and
// another chain. One test per step, titled "J-dex-protocol-05 #<n>", run in order by one verified TEST account.
// #1 to #3 are the venue's deposit and withdrawal (steps adapted under OWNER 226), on the venue account room
// (/wallet/venue, J-wallet-09's room) with one TEST browser wallet of this run's own (test-wallet.mjs) connected to the
// stack's TEST chain. They run on the TEST venue simulator behind svc-trade's user-venue door: the start step restarts
// trade with `LOCAL_STACK_USER_VENUE=on` (which starts the TEST venue, tooling/scripts/local-test-venue.mjs) and #3 puts
// it back off. The TEST venue publishes its deposit terms (TEST_VENUE_DEPOSIT_TERMS there): deposits under 5 TEST USDC
// are not credited, and a deposit is credited after 3 confirmations. It links each deposit to the TEST chain's explorer,
// the app's own /chain/tx/<hash> (TEST_VENUE_DEPOSIT_EXPLORER); #2 switches that link off on the TEST venue for a network
// with no explorer, where the row shows the hash alone, and puts it back. Once seeded, the stack's TEST chain mines a block
// every second (services/svc-protocol/scripts/seed-test-chain.ts mineOnInterval), which takes a deposit past the venue's 3
// confirmations before the room can show "Confirming 1 of 3". So #1 and #2 pause interval mining while they watch a deposit
// and mine each block themselves (`evm_mine`, the TEST chain's own control), as J-dex-protocol-04 and -09 do, and put it back.
// A withdrawal needs a fresh second factor (`trade.step_up.venue.withdraw`), so #3 adds an authenticator app first. Money: the user's wallet signs each venue deposit and withdrawal; the
// ledger posts nothing, read before and after.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #4 buys TEST USDC to the wallet on the bank's Add money page (/bank/ramps/new, "Deliver to: My wallet"), through the
//   stack's TEST pay-in stand-in. This test plays the TEST partner's side, as J-bank-02 does: it says the payment was
//   paid through the partner's signed job door, and it delivers the purchase itself on the TEST chain, from a TEST wallet
//   of its own funded there, as TEST USD (the TEST chain's stand-in for USDC, as the TEST venue's deposit route names it).
//   Money: the ledger posts nothing for a purchase delivered to the wallet, read before and after; the wallet's TEST USD
//   is read from the TEST chain itself;
// - /protocol/rails has no route table, burn, attestation or mint tracking (D-bridge-chain-03), and no cross-chain
//   review sheet (RC-dex-protocol-04);
// - there is no asset link review or contract-read docs (D-bridge-chain-04);
// - #1's "no banned partner wording" clause reads the names from the brand scan's own list (tooling/ci/brand-scan.mjs
//   FORBIDDEN) and checks the room's text against each; the test does not spell them out, since the scan refuses them
//   anywhere under apps/;
// - #1's later clause (OWNER 226) is the exchange Deposit page with custody absent: #1 restarts the bank with no deposit
//   custody (as J-wallet-02 #1 does) and puts it back; its address panel says deposit addresses are not available because
//   crypto custody isn't connected;
// - #7's crash clause (the process stopping after the intent is stored) cannot be caused from the browser; the step
//   checks the browser half: the same single row comes back after the browser closes.
const J = 'J-dex-protocol-05';
const dex = dexRun(`${J}-wallet`);
const account = dexRun(J);
// A contract address on the TEST chain: #3 puts code there, and withdrawing to it warns and needs a tick.
const CONTRACT = '0x0000000000000000000000000000000000c0ffee';
/** The stack's TEST chain's TEST USD (services/svc-protocol/scripts/seed-test-chain.ts TEST_TOKENS.USD), 6 decimals. */
const TEST_USD = '0x000000000000000000000000000000000000d011';
/** The TEST venue's published deposit terms (tooling/scripts/local-test-venue.mjs TEST_VENUE_DEPOSIT_TERMS). */
const MINIMUM = '5';
const CONFIRMATIONS = 3;
/** The TEST venue's own TEST controls (packages/venue-sim src/http-server.ts), on the stack's loopback port. */
const TEST_VENUE = 'http://127.0.0.1:14560';
/** The TEST chain's explorer, as the TEST venue links a deposit (tooling/scripts/local-test-venue.mjs). */
const EXPLORER = '/chain/tx/';
/** The trading venue's calls and public balances (services/svc-protocol/contracts/venue/SovereignVenue.sol). */
const VENUE_ABI = parseAbi([
  'function deposit(uint256 baseAmount, uint256 quoteAmount)',
  'function baseToken() view returns (address)',
  'function baseBal(address) view returns (uint256)',
  'function reservedBase(address) view returns (uint256)',
]);
const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

test.describe.configure({ mode: 'default' });

/** The run's verified, funded TEST account, signed in. */
async function person(page) {
  const who = account.run.read().who;
  expect(who, 'the start step made the account').toBeTruthy();
  await signIn(page, who);
  return who;
}

/** The run's account and its venue wallet's key, made by the start step. */
function venueState() {
  const s = account.run.read();
  if (!s.who || !s.venueKey) throw new Error(`${J} starts made no account and venue wallet, so this step has no one to act as`);
  return s;
}

/**
 * The bank restarted with no deposit custody, or back on the stack's svc-pay (as J-wallet-02 does). "Off" is written to
 * its own state file before the restart, so a step that fails or a run cancelled while custody is off is put back by the
 * hooks below, and cleared only once the bank is connected again.
 */
const custody = journeyState(`${J}-custody`);
function bankDepositCustody(on) {
  const before = process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY;
  if (on) delete process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY;
  else process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY = 'off';
  if (!on) custody.write({ off: true });
  try {
    tool('local-test-stack.mjs', 'restart', 'bank');
    if (on) custody.reset({});
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY;
    else process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY = before;
  }
}
const putCustodyBack = () => {
  if (custody.read().off) bankDepositCustody(true);
};
test.beforeAll(putCustodyBack);
test.afterEach(putCustodyBack);

const rails = (page) => page.getByRole('region', { name: 'Bridge routes' });
const transfers = (page) => page.getByRole('region', { name: 'Bridge transfers' }).getByRole('table');

/** Opens /protocol/rails with the run's wallet connected. */
async function openRails(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/protocol/rails');
  await expect(rails(page)).toBeVisible(UNBUILT);
  return wallet;
}

// ── buy to wallet (#4) ───────────────────────────────────────────────────────────────────────────────────────────────

let jobCtx;
const stackCtx = () =>
  (jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} })));

/** The next authenticator code of the app #3 added, kept in the run so no code is used twice. */
async function stepCode() {
  const { totp } = await totpLib();
  const now = account.run.read();
  const next = await nextCode(totp, now.secret, now.step);
  account.run.write({ step: next.step });
  return next.code;
}

/** One of the person's own add-money requests, as svc-bank answers it. */
async function addMoneyRequest(signedIn, requestId) {
  const input = encodeURIComponent(JSON.stringify({ requestId }));
  const { status, body } = await (await signedIn()).get(`/api/bank/trpc/addMoney.request?input=${input}`);
  if (status !== 200) throw new Error(`addMoney.request refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.result.data;
}

/** The TEST pay-in partner says a payment was paid, through its signed job door, as the partner would. */
async function partnerPaid(body) {
  const ctx = await stackCtx();
  const raw = JSON.stringify(body);
  const res = await fetch(`${ctx.url('bank')}/internal/jobs/payin-sim/paid`, {
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
  if (res.status !== 200) throw new Error(`payin-sim/paid refused: ${res.status} ${JSON.stringify(answer).slice(0, 300)}`);
  return answer;
}

/**
 * The TEST partner's delivery: `units` of TEST USD sent on the TEST chain to `to` from a TEST wallet of the partner's own,
 * funded there for this run. Returns the mined transfer's hash.
 */
async function partnerDelivers(to, units) {
  let { partnerKey } = account.run.read();
  if (!partnerKey) {
    partnerKey = testWalletKey();
    fundOnTestChain(privateKeyToAccount(partnerKey).address, 'venue');
    account.run.write({ partnerKey });
  }
  const gate = testChain().gateUrl;
  const chain = defineChain({
    id: CHAIN_ID,
    name: 'LOCAL TEST chain',
    nativeCurrency: { name: 'TEST ETH', symbol: 'TESTETH', decimals: 18 },
    rpcUrls: { default: { http: [gate] } },
  });
  const sender = createWalletClient({ account: privateKeyToAccount(partnerKey), chain, transport: http(gate) });
  const hash = await sender.writeContract({
    address: TEST_USD,
    abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
    functionName: 'transfer',
    args: [to, units],
  });
  const receipt = await createPublicClient({ chain, transport: http(gate) }).waitForTransactionReceipt({ hash, timeout: 60_000 });
  expect(receipt.status, 'the TEST partner’s delivery on the TEST chain').toBe('success');
  return hash;
}

// ── the venue account room (#1 to #3) ────────────────────────────────────────────────────────────────────────────────

/** svc-trade's user-venue door as the person reads it: off, down, or the TEST venue with its deposit route. */
async function venueDoor(who) {
  const { status, body } = await (await api(who)).get('/api/v1/venue/status');
  if (status !== 200) throw new Error(`venue status refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/** Restarts trade with the user-venue door on (which starts the TEST venue) or off, and puts this process's env back. */
function userVenue(on) {
  const before = process.env.LOCAL_STACK_USER_VENUE;
  if (on) process.env.LOCAL_STACK_USER_VENUE = 'on';
  else delete process.env.LOCAL_STACK_USER_VENUE;
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_USER_VENUE;
    else process.env.LOCAL_STACK_USER_VENUE = before;
  }
}

/** One call to the stack's TEST chain node. */
async function chainRpc(method, params = []) {
  const res = await fetch(testChain().gateUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * Runs `fn` with the TEST chain's interval mining paused, so a block lands only when the step mines one, and puts the
 * interval back after, whatever happens. A transfer the wallet sends meanwhile stays pending until the step mines it.
 */
async function withMiningPaused(fn) {
  const interval = await chainRpc('anvil_getIntervalMining');
  await chainRpc('evm_setIntervalMining', [0]);
  try {
    return await fn();
  } finally {
    await chainRpc('evm_setIntervalMining', [interval]);
  }
}

/** The wallet's TEST USD on the TEST chain, in base units (6 decimals), read from the node itself. */
async function chainUsd(address) {
  const data = encodeFunctionData({ abi: parseAbi(['function balanceOf(address) view returns (uint256)']), args: [address] });
  return BigInt(await chainRpc('eth_call', [{ to: TEST_USD, data }, 'latest']));
}

/**
 * Signed in, with the run's venue wallet in this page on the stack's TEST chain, on the venue room, the wallet connected.
 * `beforeVenue` runs signed in, before the room opens (#3 adds an authenticator app there).
 */
async function openVenue(page, who, privateKey, { beforeVenue = null } = {}) {
  const wallet = await installTestWallet(page, { chainId: CHAIN_ID, privateKey, rpcUrl: testChain().gateUrl });
  await signIn(page, who);
  if (beforeVenue) await beforeVenue();
  await page.goto('/wallet/venue');
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  return wallet;
}

/** After a reload: the browser wallet may come back by itself (it is still authorised); otherwise it is connected again. */
async function walletBack(page) {
  const again = page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` });
  await expect(
    page
      .getByRole('heading', { name: 'Connected' })
      .or(page.getByRole('heading', { name: 'Connection expired' }))
      .or(again),
  ).toBeVisible();
  if (await again.isVisible()) await again.click();
}

/** The venue's free TEST USDC for this wallet, read through the door: a whole number of TEST USDC in this journey. */
async function venueFree(who, owner) {
  const read = await (await api(who)).get(`/api/v1/venue/balances?owner=${owner}`);
  const free = read.body.value.find((b) => b.asset === 'USDC')?.free ?? '0';
  expect(free, 'this journey moves whole TEST USDC only').toMatch(/^\d+$/);
  return BigInt(free);
}

const sheet = (page) => page.locator('[data-sheet="sign"]');
const actions = (page) => page.getByRole('region', { name: 'Venue actions' });

/** Presses Connect (or Sign again), continues the plain-words sheet, and the TEST wallet signs. */
async function connectAndSign(page, button) {
  await page.getByRole('button', { name: button }).click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible();
}

/** What a signed action needs left of the connection: the stack's TEST connection lasts 60 s (local-stack-services/protocol.mjs). */
const CONNECTION_MARGIN_MS = 45_000;

/** Connected for the next signed action: an ended connection, or one about to end, is signed again. */
async function connectedNow(page) {
  await expect(
    page
      .getByRole('heading', { name: 'Connected' })
      .or(page.getByRole('heading', { name: 'Connection expired' }))
      .or(page.getByRole('button', { name: 'Connect to my account' })),
  ).toBeVisible();
  if (await page.getByRole('heading', { name: 'Connected' }).isVisible()) {
    const expiresAt = Date.parse(await page.getByTestId('venue-connection-expires').getAttribute('datetime'));
    if (expiresAt - Date.now() > CONNECTION_MARGIN_MS) return;
    await expect(page.getByRole('heading', { name: 'Connection expired' })).toBeVisible({ timeout: CONNECTION_MARGIN_MS + 15_000 });
  }
  if (await page.getByRole('button', { name: 'Sign again' }).isVisible()) await connectAndSign(page, 'Sign again');
  if (await page.getByRole('button', { name: 'Connect to my account' }).isVisible()) await connectAndSign(page, 'Connect to my account');
}

/** The venue's list of the deposits it has seen for this wallet, as the room shows it. */
const onItsWay = (page) => page.getByRole('region', { name: 'On its way' }).getByRole('table');
/** The row of one transfer, by its hash (the row's own record of it, whether it shows an explorer link or the hash). */
const rowOf = (page, hash) => onItsWay(page).locator(`tr[data-tx-hash="${hash.toLowerCase()}"]`);

/**
 * The brand scan's forbidden names, read from its own list (tooling/ci/brand-scan.mjs FORBIDDEN), never spelled out here:
 * the scan refuses them anywhere under apps/. A list that reads short fails, so the check can't pass by reading nothing.
 */
function bannedNames() {
  const src = fs.readFileSync(path.join(ROOT, 'tooling/ci/brand-scan.mjs'), 'utf8');
  const start = src.indexOf('const FORBIDDEN = [');
  const block = src.slice(start, src.indexOf('\n];', start));
  const names = [...block.matchAll(/pattern: \/((?:\\.|[^/\\\n])+)\/([a-z]*),/g)].map(([, source, flags]) => new RegExp(source, flags));
  expect(names.length, 'the brand scan lists its forbidden names').toBeGreaterThan(5);
  return names;
}

/** The TEST venue's explorer link for deposits: the TEST chain's explorer, or none (a network with no explorer). */
async function depositExplorer(url) {
  const res = await fetch(`${TEST_VENUE}/test/switches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ depositExplorerTxUrl: url }),
  });
  expect(res.status).toBe(200);
}

/** Fills the amount, presses Deposit, and the TEST wallet sends the person's own transfer. Returns its hash. */
async function depositFromWallet(page, wallet, amount) {
  const before = wallet.sends.length;
  await connectedNow(page);
  await actions(page).getByLabel('Amount').fill(amount);
  await actions(page).getByRole('button', { name: 'Deposit TEST USDC' }).click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect.poll(() => wallet.sends[before]?.hash ?? null).not.toBeNull();
  return { send: wallet.sends[before], hash: wallet.sends[before].hash };
}

test(`${J} starts: a verified account, a connected wallet and a TEST venue account`, async ({ page }) => {
  test.setTimeout(300_000);
  // A verified account (with TEST USDT for the later steps' exchange side), and the TEST wallet the later steps use.
  const who = await fundedTrader(page, 'dex05', '50');
  const venueKey = testWalletKey();
  account.run.reset({ who, venueKey });
  dex.start();
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
  // The TEST venue account: the venue door on, and the venue wallet funded on the TEST chain with TEST ETH for gas and
  // 100 TEST USD to deposit. The venue account is the wallet's own on the venue; it holds nothing yet.
  expect(testChain().chain, 'the stack runs its TEST chain').toBe('running');
  if (!(await venueDoor(who)).deposit) userVenue(true);
  const door = await venueDoor(who);
  expect(door).toMatchObject({
    enabled: true,
    available: true,
    label: 'TEST',
    deposit: { chainId: CHAIN_ID, token: TEST_USD, asset: 'USDC' },
  });
  const address = privateKeyToAccount(venueKey).address;
  fundOnTestChain(address, 'venue');
  // The wallet connected to the account: the person signs the connection message in it. Its own tab, since this tab
  // already holds the swap wallet and a tab takes one TEST wallet.
  const venuePage = await page.context().newPage();
  await openVenue(venuePage, who, venueKey);
  await connectAndSign(venuePage, 'Connect to my account');
  await expect(venuePage.locator('[data-venue-address]')).toHaveText(address);
  await expect(venuePage.getByTestId('venue-balance')).toHaveText('0 TEST USDC');
  account.run.write({ ledgerBefore: await (await api(who)).balances() });
});

test(`${J} #1 opens the venue's deposit for a chain: minimums and arrival terms in plain words as the venue publishes them; the user's wallet signs the deposit; no banned partner wording`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { who, venueKey } = venueState();
  if (!(await venueDoor(who)).deposit) userVenue(true);
  const door = await venueDoor(who);
  const wallet = await openVenue(page, who, venueKey);
  await connectedNow(page);
  // The venue's terms for its chain, in plain words, as the venue publishes them (its route, read through the door).
  expect(door.deposit).toMatchObject({ minimum: MINIMUM, confirmations: CONFIRMATIONS, network: 'TEST chain' });
  const terms = page.getByTestId('deposit-terms');
  await expect(terms).toContainText('TEST chain');
  await expect(terms).toContainText(`Deposits under ${MINIMUM} TEST USDC are not credited by the venue.`);
  await expect(terms).toContainText(`The venue credits a deposit after ${CONFIRMATIONS} confirmations on TEST chain.`);
  await expect(terms).toContainText('Your wallet signs each deposit: it is your own transfer to the venue.');

  await withMiningPaused(async () => {
    // The user's wallet signs the deposit: its own transfer of the venue's token to the venue's deposit address.
    const { send, hash } = await depositFromWallet(page, wallet, '25');
    expect(send.method).toBe('eth_sendTransaction');
    expect(send.params[0].to.toLowerCase()).toBe(TEST_USD);
    expect(send.params[0].data.toLowerCase()).toContain(door.deposit.address.slice(2));
    // Nothing else signed it: the only send is the wallet's own, and INTAFACED asked nothing more of the wallet.
    expect(wallet.sends).toHaveLength(1);
    // The venue has seen it on chain, in the one block that mined it: confirming, one of the published three.
    await chainRpc('evm_mine');
    await expect(rowOf(page, hash)).toContainText(`Confirming 1 of ${CONFIRMATIONS}`, { timeout: 30_000 });
    account.run.write({ firstDeposit: hash });
  });

  // No banned partner wording anywhere in the room: none of the brand scan's forbidden names is on the page.
  const words = await page.locator('main').innerText();
  for (const name of bannedNames()) expect(words, 'the room names nothing the brand scan forbids').not.toMatch(name);

  // Later (OWNER 226): on the exchange Deposit page, while crypto custody is absent, the address panel says so and shows
  // no address. Custody is made absent for this check and put back after.
  bankDepositCustody(false);
  try {
    await page.goto('/uc/recharge');
    await expect(page.getByText('Deposit addresses are not available', { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        'Crypto custody isn’t connected, so no deposit address is issued. Please do not send anything to an address from elsewhere.',
      ),
    ).toBeVisible();
    await expect(page.getByTestId('deposit-address')).toHaveCount(0);
  } finally {
    bankDepositCustody(true);
  }
});

test(`${J} #2 watches a TEST deposit arrive: "Confirming 1 of N" with an explorer link, or the hash alone when the network has no explorer, then credited by the venue; below the venue's minimum the row says it is not credited`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { who, venueKey, ledgerBefore } = venueState();
  if (!(await venueDoor(who)).deposit) userVenue(true);
  const address = privateKeyToAccount(venueKey).address;
  const wallet = await openVenue(page, who, venueKey);
  await connectedNow(page);
  const figure = page.getByTestId('venue-balance');
  // Whatever an earlier step sent is confirmed first, so this step's figure moves by this step's deposit alone.
  for (let i = 0; i < CONFIRMATIONS; i += 1) await chainRpc('evm_mine');
  await expect(
    onItsWay(page)
      .getByRole('row')
      .filter({ hasText: /Confirming/ }),
  ).toHaveCount(0, { timeout: 30_000 });
  const owner = address.toLowerCase();
  const before = await venueFree(who, owner);
  await expect(figure).toHaveText(`${before} TEST USDC`, { timeout: 30_000 });

  const { hash, small, onChainBefore } = await withMiningPaused(async () => {
    // A deposit of 10: mined in one block, so the venue's row reads "Confirming 1 of 3", with the link the venue gives it
    // on the TEST chain's explorer.
    const { hash } = await depositFromWallet(page, wallet, '10');
    const row = rowOf(page, hash);
    await chainRpc('evm_mine');
    await expect(row).toContainText(`Confirming 1 of ${CONFIRMATIONS}`, { timeout: 30_000 });
    const link = row.getByRole('link', { name: 'View on explorer' });
    await expect(link).toHaveAttribute('href', `${EXPLORER}${hash.toLowerCase()}`);
    // Not credited while it confirms: the venue's figure has not moved.
    await expect(figure).toHaveText(`${before} TEST USDC`);
    // The next block: two of three, still not credited.
    await chainRpc('evm_mine');
    await expect(row).toContainText(`Confirming 2 of ${CONFIRMATIONS}`, { timeout: 30_000 });
    await expect(figure).toHaveText(`${before} TEST USDC`);
    // The third: credited by the venue, and the venue's figure is exactly 10 more.
    await chainRpc('evm_mine');
    await expect(row).toContainText('Credited by the venue', { timeout: 30_000 });
    await expect(page.getByTestId('venue-deposit')).toHaveText('The venue credited 10 TEST USDC.', { timeout: 30_000 });
    await expect(figure).toHaveText(`${before + 10n} TEST USDC`, { timeout: 30_000 });
    // The link opens the transfer on the explorer: this hash, a success on the TEST chain. It is followed in this tab, as
    // the room opens it: a second tab of the same session refreshes the session and signs this one out.
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${EXPLORER}${hash.toLowerCase()}$`));
    await expect(page.getByRole('main').getByText(hash.toLowerCase(), { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('main').getByTestId('tx-status')).toHaveText('Success', { timeout: 60_000 });
    await page.goto('/wallet/venue');
    await walletBack(page);
    await connectedNow(page);

    // Below the venue's minimum: 1 TEST USDC leaves the wallet on chain, and the venue's row says it is not credited,
    // however many confirmations it gets; the venue's figure does not move.
    const onChainBefore = await chainUsd(address);
    const small = await depositFromWallet(page, wallet, '1');
    const smallRow = rowOf(page, small.hash);
    // Mined, so the venue sees it.
    await chainRpc('evm_mine');
    await expect(smallRow).toContainText('Below the minimum: not credited', { timeout: 30_000 });
    await expect(page.getByTestId('venue-deposit')).toHaveText(
      'Your transfer of 1 TEST USDC is below the venue’s minimum, so the venue does not credit it.',
      { timeout: 30_000 },
    );
    for (let i = 0; i < CONFIRMATIONS; i += 1) await chainRpc('evm_mine');
    return { hash, small, onChainBefore };
  });

  // On a network with no explorer (the TEST venue's link switched off), each row shows its hash alone, with no link.
  try {
    await depositExplorer(null);
    await page.reload();
    await walletBack(page);
    await connectedNow(page);
    for (const h of [hash, small.hash]) {
      const plain = rowOf(page, h);
      await expect(plain.getByText(/^0x[0-9a-f]{64}$/)).toHaveText(h.toLowerCase());
      await expect(plain.getByRole('link')).toHaveCount(0);
    }
    await expect(rowOf(page, hash)).toContainText('Credited by the venue');
    await expect(rowOf(page, small.hash)).toContainText('Below the minimum: not credited');
  } finally {
    await depositExplorer(EXPLORER);
  }
  await expect(figure).toHaveText(`${before + 10n} TEST USDC`);
  expect(onChainBefore - (await chainUsd(address))).toBe(1_000_000n);
  // The venue's own record, read through the door, is the same figure.
  expect(await venueFree(who, owner)).toBe(before + 10n);
  // The ledger posts nothing for a venue deposit.
  expect(await (await api(who)).balances()).toEqual(ledgerBefore);
});

test(`${J} #3 withdraws from the venue to the wallet: destination is the connected wallet and the network is filled, read-only until Edit; a contract destination shows a warning and needs a tick; the wallet signs`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { who, venueKey, ledgerBefore } = venueState();
  const address = privateKeyToAccount(venueKey).address;
  const owner = address.toLowerCase();
  try {
    if (!(await venueDoor(who)).deposit) userVenue(true);
    const { totp } = await totpLib();
    const code = async () => {
      const now = account.run.read();
      const next = await nextCode(totp, now.secret, now.step);
      account.run.write({ step: next.step });
      return next.code;
    };
    // A withdrawal needs a fresh second factor: the person adds an authenticator app in Security first.
    const wallet = await openVenue(page, who, venueKey, { beforeVenue: async () => account.run.write(await addAuthenticator(page, totp)) });
    await connectedNow(page);
    const where = page.getByTestId('withdraw-destination');
    const destination = where.getByRole('textbox', { name: 'Withdraw to' });
    const network = where.getByRole('combobox', { name: 'Network' });
    const withdraw = actions(page).getByRole('button', { name: 'Withdraw TEST USDC' });

    // The destination is the connected wallet and the network is filled; both are read-only until Edit.
    await expect(destination).toHaveValue(new RegExp(`^${address}$`, 'i'));
    await expect(destination).not.toBeEditable();
    await expect(network.locator('option:checked')).toHaveText('TEST chain');
    await expect(network).toBeDisabled();
    await where.getByRole('button', { name: 'Edit' }).click();
    await expect(destination).toBeEditable();
    await expect(network).toBeEnabled();

    // A contract destination: code on the TEST chain at that address. It shows a warning, and Withdraw needs the tick.
    await chainRpc('anvil_setCode', [CONTRACT, '0x6080604052']);
    await destination.fill(CONTRACT);
    await expect(where.getByRole('alert')).toContainText('This address is a contract');
    const tick = where.getByRole('checkbox', { name: /^I checked this address can receive/ });
    await expect(withdraw).toBeDisabled();
    await tick.check();
    await expect(withdraw).toBeEnabled();
    await tick.uncheck();
    await expect(withdraw).toBeDisabled();
    // A plain wallet address needs no tick.
    await destination.fill(address);
    await expect(where.getByRole('alert')).toHaveCount(0);
    await expect(withdraw).toBeEnabled();

    // The wallet signs the withdrawal to itself: the venue's own payload, after a fresh second factor; pending, then
    // done, and what arrives in the wallet on chain is the amount less the venue's network fee.
    const onChainBefore = await chainUsd(address);
    await connectedNow(page);
    const totpCode = await code();
    await actions(page).getByLabel('Amount').fill('5');
    const signedBefore = wallet.requests.length;
    await withdraw.click();
    const stepUp = page.getByTestId('step-up-confirm');
    await expect(stepUp).toContainText('Confirm it’s you');
    await stepUp.getByLabel('Authenticator code').fill(totpCode);
    await stepUp.getByRole('button', { name: 'Confirm', exact: true }).click();
    await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
    const withdrawalSigns = () => wallet.requests.slice(signedBefore).filter((r) => r.method !== 'personal_sign');
    await expect.poll(() => withdrawalSigns().length).toBe(1);
    expect(withdrawalSigns()[0].method).toBe('eth_signTypedData_v4');
    const withdrawal = page.getByTestId('venue-withdrawal');
    await expect(withdrawal).toContainText(owner);
    await expect(withdrawal.getByTestId('venue-withdrawal-status')).toHaveText('Done', { timeout: 90_000 });
    await expect.poll(async () => (await chainUsd(address)) - onChainBefore, { timeout: 30_000 }).toBe(4_750_000n);
    // The ledger posts nothing for a venue withdrawal.
    expect(await (await api(who, { totpCode: await code() })).balances()).toEqual(ledgerBefore);
  } finally {
    // The stack as it was: trade's user-venue door off again (the TEST venue keeps running, unreached).
    userVenue(false);
  }
});

test(`${J} #4 opens Buy to wallet in the ramps: the partner's purchase lands in the wallet address`, async ({ page }) => {
  test.setTimeout(300_000);
  const { who } = venueState();
  const signedIn = async () => api(who, account.run.read().secret ? { totpCode: await stepCode() } : {});
  // TEST setup: the account holds USDC as a currency to buy, as the person adds one on the Bank Overview.
  const added = await (await signedIn()).post('/api/bank/trpc/currencies.add', { assetId: 'USDC' });
  expect(added.status, `currencies.add: ${JSON.stringify(added.body).slice(0, 300)}`).toBe(200);
  const ledgerBefore = await (await signedIn()).balances();
  await signIn(page, who);
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  const owner = wallet.address.toLowerCase();
  const before = await chainUsd(wallet.address);

  await page.goto('/bank/ramps/new');
  const deliver = page.getByRole('radiogroup', { name: 'Deliver to' });
  await deliver.getByRole('radio', { name: 'My wallet' }).check();
  const destination = page.getByTestId('ramp-destination');
  await expect(destination).toContainText(new RegExp(wallet.address, 'i'));
  await expect(destination).not.toContainText('Exchange balance');
  await page.getByLabel('Add to').selectOption('USDC');
  await page.getByLabel('Amount').fill('3');
  await page.getByLabel('Country you pay from').fill('NL');
  await page.getByRole('button', { name: 'See ways to pay' }).click();
  await page.getByTestId('method-pay_by_bank').getByRole('radio').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  const { url } = await stackCtx();
  const confirm = page.getByTestId('add-money-confirm');
  await expect(confirm.getByTestId('add-money-sign-note')).toContainText('to prove it is yours');
  await confirm.getByRole('button', { name: 'Ask for this payment' }).click();
  // The wallet proves it is the person's: the plain-words sheet shows the message, and the TEST wallet signs it.
  const sheet = page.locator('[data-sheet="sign"]');
  await expect(sheet).toContainText(`Wallet: ${owner}`);
  await sheet.getByRole('button', { name: 'Continue in wallet' }).click();
  // The partner's page names the wallet the purchase goes to: the partner was told it.
  await page.waitForURL((at) => at.href.startsWith(`${url('bank')}/test/payin-sim/pay/`));
  await expect(page.getByTestId('payin-sim-label')).toContainText(/^TEST\b/);
  await expect(page.getByTestId('payin-sim-deliver-to')).toHaveText(`Delivered to the wallet ${owner}`);
  const requestId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop());
  const asked = await addMoneyRequest(signedIn, requestId);
  expect(asked).toMatchObject({ status: 'opened', assetId: 'USDC', amount: '3', walletAddress: owner, deliveryTx: null });
  await page.getByRole('button', { name: 'Approve payment' }).click();
  await page.waitForURL((at) => at.pathname === '/bank/ramps/new' && at.searchParams.get('request') === requestId);
  const tracker = page.getByTestId('add-money-tracker');
  await expect(tracker).toHaveAttribute('data-status', 'pending');
  await expect(page.getByTestId('tracker-delivery')).toHaveAttribute('data-state', 'waiting');
  await expect(page.getByTestId('tracker-delivery')).toContainText(owner);

  // The TEST partner delivers the purchase to that address on the TEST chain, then says it was paid with that transfer.
  const hash = await partnerDelivers(wallet.address, 3_000_000n);
  const paid = await partnerPaid({ requestId, paidAmount: asked.onramp.payAmount, payCurrency: 'EUR', deliveryTx: hash });
  expect(paid).toMatchObject({ requestId, status: 'delivered', walletAddress: owner, deliveryTx: hash, creditedAmount: null });
  await expect(tracker).toHaveAttribute('data-status', 'delivered');
  await expect(tracker).toContainText('Delivered to your wallet');
  await expect(page.getByTestId('tracker-delivery')).toHaveText(new RegExp(`Delivered to ${owner}`));
  await expect(page.getByTestId('tracker-delivery-tx')).toHaveAttribute('href', `/chain/tx/${hash}`);
  // It landed in the wallet address: the TEST chain itself says the wallet holds 3 TEST USD more.
  expect(await chainUsd(wallet.address)).toBe(before + 3_000_000n);
  // Once: the partner saying paid again is the same delivery, and nothing more moves.
  expect(await partnerPaid({ requestId, paidAmount: asked.onramp.payAmount, payCurrency: 'EUR', deliveryTx: hash })).toEqual(paid);
  expect(await chainUsd(wallet.address)).toBe(before + 3_000_000n);
  // The ledger posts nothing for a purchase delivered to the wallet: INTAFACED holds none of it.
  expect(await (await signedIn()).balances()).toEqual(ledgerBefore);
});

test(`${J} #5 opens the rails room with the route table blank: the full layout, the blocker for unset routes with its owner-decision label, no route offered`, async ({
  page,
}) => {
  await openRails(page);
  const table = rails(page).getByRole('table');
  await expect(table.getByRole('columnheader', { name: 'From' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'To' })).toBeVisible();
  await expect(rails(page)).toContainText('No bridge routes are set. Routes are an owner decision.');
  await expect(rails(page).getByText('Owner decision', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start a transfer' })).toBeDisabled();
});

test(`${J} #6 builds a burn on a TEST route and signs it: burn submitted, then mint ready when the attestation arrives, then minted after the mint is signed`, async ({
  page,
}) => {
  await openRails(page);
  await page.getByRole('button', { name: 'Start a transfer' }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'Bridge transfer' });
  await form.getByRole('combobox', { name: 'From' }).selectOption({ label: 'Base Sepolia' });
  await form.getByRole('combobox', { name: 'To' }).selectOption({ label: 'TEST chain' });
  await form.getByRole('combobox', { name: 'Token' }).selectOption({ label: 'USDC' });
  await form.getByRole('textbox', { name: /^Amount/ }).fill('1');
  await form.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  const row = transfers(page).getByRole('row').filter({ hasText: '1 USDC' });
  await expect(row).toContainText('Burn submitted');
  // Kept as soon as the burn is in, so #7 finds the transfer even if this step stops before the mint.
  dex.run.write({ bridged: true });
  await expect(row).toContainText('Mint ready', { timeout: 120_000 });
  await row.getByRole('button', { name: 'Sign the mint' }).click();
  await page.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(row).toContainText('Minted', { timeout: 60_000 });
});

test(`${J} #7 closes the browser after the burn and returns: the same row, still tracked; a stored intent resumes, never a second burn`, async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openRails(page);
    expect(dex.run.read().bridged, 'the burn step ran').toBe(true);
    // One row for the one burn, in whichever tracked state it reached; never a second burn row.
    const row = transfers(page).getByRole('row').filter({ hasText: '1 USDC' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/Burn submitted|Mint ready|Minted/);
  } finally {
    await context.close();
  }
});

test(`${J} #8 opens the review sheet before a cross-chain swap: provider, slippage, network fee, duration and receive; an expired quote is refused; a missing destination gas notice`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/dex');
  const swap = page.getByRole('form', { name: 'Swap' });
  await swap.getByRole('combobox', { name: 'Destination network' }).selectOption({ label: 'TEST chain' }, UNBUILT);
  await swap.getByRole('textbox', { name: /^Amount you pay/ }).fill('1');
  await swap.getByRole('button', { name: 'Review' }).click();
  const sheet = page.getByRole('dialog', { name: 'Review the cross-chain swap' });
  for (const term of ['Provider', 'Slippage', 'Network fee', 'Estimated time', 'You receive'])
    await expect(sheet.getByRole('term').filter({ hasText: term })).toBeVisible();
  await expect(sheet.getByRole('note')).toContainText('You have no gas on the destination network');
  // The quote runs out on real time; confirming after that is refused and asks for a fresh one.
  test.setTimeout(180_000);
  await expect(sheet.getByRole('status')).toHaveText('Quote expired', { timeout: 120_000 });
  await sheet.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(sheet.getByRole('alert')).toContainText('This quote expired. Get a fresh one.');
});

test(`${J} #9 deposits 10 TEST base to the trading venue and withdraws more than is free: the unsigned call is shown with amounts and network and nothing is sent; above the free amount refused naming it`, async ({
  page,
}) => {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  await page.goto('/dex/venue');
  const funds = page.getByRole('form', { name: 'Venue funds' });
  await funds.getByRole('radio', { name: 'Deposit' }).check();
  await funds.getByRole('radio', { name: 'TESTA' }).check();
  await funds.getByRole('textbox', { name: /^Amount/ }).fill('10');
  await funds.getByRole('button', { name: 'Build the call' }).click();
  const call = page.getByRole('region', { name: 'Unsigned call' });
  // The amounts and the network, as the call carries them.
  await expect(call).toContainText('Deposit 10 TESTA on Base Sepolia');
  await expect(call).toContainText('deposit(10 TESTA) into the venue');
  // The call itself: the venue contract's own deposit(base, quote), 10 TEST base in the venue's 18 decimals, read from the
  // call data the page shows, and the venue is the stack's TEST SovereignVenue (code on the TEST chain, base TEST Token A).
  const steps = call.getByRole('listitem');
  const last = steps.last();
  // Each step lists its contract, then its call data, as a term and its definition.
  await expect(last.getByRole('term')).toHaveText(['Contract', 'Call data']);
  const [venue, data] = (await last.getByRole('definition').allInnerTexts()).map((text) => text.trim());
  const decoded = decodeFunctionData({ abi: VENUE_ABI, data });
  expect(decoded.functionName).toBe('deposit');
  expect(decoded.args).toEqual([10n * 10n ** 18n, 0n]);
  const chain = createPublicClient({ transport: http(testChain().gateUrl), cacheTime: 0 });
  expect(await chain.getCode({ address: venue }), 'the venue is a contract on the TEST chain').toMatch(/^0x[0-9a-f]{2,}/);
  expect((await chain.readContract({ address: venue, abi: VENUE_ABI, functionName: 'baseToken' })).toLowerCase()).toBe(TOKEN_A.address);
  // Nothing is sent: the wallet was never asked to send, and the venue holds nothing for this wallet.
  expect(wallet.sends).toHaveLength(0);
  expect(await chain.readContract({ address: venue, abi: VENUE_ABI, functionName: 'baseBal', args: [wallet.address] })).toBe(0n);
  // A withdrawal above the free amount is refused, naming the free amount as the venue contract itself reports it.
  const [held, reserved] = await Promise.all([
    chain.readContract({ address: venue, abi: VENUE_ABI, functionName: 'baseBal', args: [wallet.address] }),
    chain.readContract({ address: venue, abi: VENUE_ABI, functionName: 'reservedBase', args: [wallet.address] }),
  ]);
  const free = formatUnits(held - reserved, 18);
  await funds.getByRole('radio', { name: 'Withdraw' }).check();
  await funds.getByRole('textbox', { name: /^Amount/ }).fill('1000000');
  await funds.getByRole('button', { name: 'Build the call' }).click();
  await expect(funds.getByRole('alert')).toContainText(`more than is free (${free} free)`);
  await expect(call).toHaveCount(0);
  expect(wallet.sends).toHaveLength(0);
});

test(`${J} #10 requests an asset link review and opens the contract-read docs: the review states decimals and the verdict; the docs list read-only calls with examples`, async ({
  page,
}) => {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A] });
  const chain = createPublicClient({ transport: http(testChain().gateUrl), cacheTime: 0 });
  const ERC20 = parseAbi(['function decimals() view returns (uint8)']);
  await page.goto('/protocol/contracts');
  await page.getByRole('button', { name: 'Request an asset link review' }).click(UNBUILT);
  const review = page.getByRole('form', { name: 'Asset link review' });
  const result = page.getByRole('region', { name: 'Review result' });
  /** Reviews `token` and returns the venue contract the result names it was read from. */
  async function reviewOf(token) {
    await review.getByRole('textbox', { name: /^Token address/ }).fill(token);
    await review.getByRole('button', { name: 'Request review' }).click();
    // The decimals the review states are the token's own, as the token contract answers them on the chain.
    const decimals = await chain.readContract({ address: token, abi: ERC20, functionName: 'decimals' });
    await expect(result).toContainText(`Decimals ${decimals}`);
    const venue = (await result.innerText()).match(/venue contract (0x[0-9a-fA-F]{40})/)?.[1];
    expect(venue, 'the review names the venue contract it read').toBeTruthy();
    return venue;
  }
  // TEST Token A is the venue's base asset, as the venue contract itself reports it: the verdict is linked.
  const venue = await reviewOf(TOKEN_A.address);
  expect(await chain.getCode({ address: venue }), 'the venue is a contract on the TEST chain').toMatch(/^0x[0-9a-f]{2,}/);
  const base = await chain.readContract({ address: venue, abi: VENUE_ABI, functionName: 'baseToken' });
  expect(base.toLowerCase()).toBe(TOKEN_A.address);
  await expect(result).toContainText('Verdict: linked');
  await expect(result).not.toContainText('Verdict: not linked');
  // TEST Token B is a token the venue does not trade (neither its base nor its quote): the verdict is not linked.
  const quote = await chain.readContract({
    address: venue,
    abi: parseAbi(['function quoteToken() view returns (address)']),
    functionName: 'quoteToken',
  });
  expect([base.toLowerCase(), quote.toLowerCase()]).not.toContain(TOKEN_B.address);
  await reviewOf(TOKEN_B.address);
  await expect(result).toContainText('Verdict: not linked');
  // The contract-read docs: every call listed is a read-only call on that venue, with an example; each example, run as
  // written against the chain (the person's own address in place of 0xYourAddress), is answered as a view call.
  await page.getByRole('link', { name: 'Contract-read docs' }).click();
  const calls = page.getByRole('region', { name: 'Read-only calls' });
  const entries = calls.getByRole('article');
  const count = await entries.count();
  expect(count, 'the docs list calls').toBeGreaterThan(0);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    const entry = entries.nth(i);
    await expect(entry.getByRole('heading')).toBeVisible();
    const example = (await entry.getByRole('code').last().innerText()).trim();
    const abiLine = example.match(/parseAbi\(\['(function [^']+)'\]\)/)?.[1];
    const name = example.match(/functionName: '([A-Za-z]+)'/)?.[1];
    expect(abiLine, `example ${i + 1} carries its ABI`).toMatch(/ view returns /);
    expect(example).toContain(`address: '${venue}'`);
    const args = (example.match(/args: \[(.*)\],/)?.[1] ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => (a === "'0xYourAddress'" ? wallet.address : BigInt(a.replace(/n$/, ''))));
    const abi = parseAbi([abiLine]);
    expect(abi[0].stateMutability, `${name} is read-only`).toBe('view');
    await chain.readContract({ address: venue, abi, functionName: name, args });
    names.push(name);
  }
  // The balances a person reads before moving funds are among them.
  expect(names).toEqual(expect.arrayContaining(['baseToken', 'quoteToken', 'baseBal', 'reservedBase']));
});
