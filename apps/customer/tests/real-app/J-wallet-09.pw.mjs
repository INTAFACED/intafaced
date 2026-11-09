// World: restart
import path from 'node:path';
import { encodeFunctionData, keccak256, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { CHAIN_ID, fundOnTestChain, testChain } from './dex.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { api, journeyState, restartWith, ROOT, tool } from './stack.mjs';
import { installTestWallet, TEST_WALLET, testWalletKey } from './test-wallet.mjs';

// J-wallet-09, in the running app (docs/roadmap/journeys.json): I connect my own wallet and fund my venue account from
// it. One test per step, titled "J-wallet-09 #<n>", run in order by one signed-in TEST person with one TEST browser wallet
// (test-wallet.mjs, a fresh key kept in this run's state). The connection is svc-protocol's record (`venueWallet.*`):
// an address and its expiry, never a key. The stack's labelled TEST owner values (tooling/profiles/test-owner-values/
// protocol.json) give a one-minute connection, so #4 waits about a minute, and a wallet sanctions list of one TEST
// address, the wallet #1 derives from the TEST seed below. #1 also restarts svc-protocol once with that list blank
// (`LOCAL_STACK_PROTOCOL_WALLET_SANCTIONS=off`, tooling/scripts/local-stack-services/protocol.mjs) and puts it back.
// Region refusal: #1 restarts svc-protocol and Edge once with `LOCAL_STACK_TEST_REGION_SERVED=off`
// (tooling/scripts/local-stack-services/protocol.mjs and edge.mjs): svc-protocol then holds a labelled TEST business
// block for the TEST region AA (a user-assigned ISO code, no country; INTAFACED_TEST_BUSINESS_BLOCKS), Edge stamps every
// request from AA, and the person, signed in again, is refused denied.region_blocked with that region's reason in the
// room. Both are put back after. The stack's screened regions are a repository secret, so the test plays the TEST
// region, never one of them, and the sanctions list is never touched.
// #3 and #5 run on the TEST venue simulator behind svc-trade's user-venue door: #3 restarts trade with
// `LOCAL_STACK_USER_VENUE=on` (which starts the TEST venue, tooling/scripts/local-test-venue.mjs) and #5 puts it back off.
// The TEST venue takes deposits of the stack's TEST chain's TEST USD at its TEST deposit address and credits the sender
// as USDC (TEST USDC), and pays withdrawals back on that chain (packages/venue-sim src/chain-deposits.ts). The run's wallet
// is connected to the TEST chain and funded with TEST ETH for gas and 100 TEST USD (`fund <address> venue`). A withdrawal
// needs a fresh second factor (`trade.step_up.venue.withdraw`), so #5 adds an authenticator app to the person first.
// Money: INTAFACED moves nothing and the ledger posts nothing in this journey; #3 and #5 read the ledger before and after.
const J = 'J-wallet-09';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** The TEST wallet on the stack's TEST wallet sanctions list (PROTOCOL_WALLET_SANCTIONS in the TEST profile). */
const LISTED_KEY = keccak256(toHex('INTAFACED LOCAL TEST sanctioned wallet (J-wallet-09)'));
const LISTED = '0xe6d1aB28c0f3477FdBdAC2df19743CEae59e8A83';
/** The TEST USDC #3 deposits; the venue's figure for this new account must read exactly this after. */
const DEPOSIT = '25';
/** The TEST region AA's reason while it is not served (TEST_BUSINESS_BLOCK_REASON in packages/config jurisdiction.ts). */
const REGION_REASON = 'TEST region, not served at launch';
const NO_KEY = 'INTAFACED holds no key that can move this wallet’s funds. You sign every venue action in your own wallet.';
/** The stack's TEST chain's TEST USD (services/svc-protocol/scripts/seed-test-chain.ts TEST_TOKENS.USD), 6 decimals. */
const TEST_USD = '0x000000000000000000000000000000000000d011';
/** The TEST venue's own TEST controls (packages/venue-sim src/http-server.ts), on the stack's loopback port. */
const TEST_VENUE = 'http://127.0.0.1:14560';
/** The TEST venue's published fees (packages/venue-sim simulator.ts defaults): a 1 USDC withdrawal fee, a 0.25 network fee. */
const VENUE_FEE = '1 TEST USDC';
const NETWORK_FEE = '0.25 TEST USDC';
const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

test.describe.configure({ mode: 'default' });

function state() {
  const s = run.read();
  if (!s.who || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return s;
}

/**
 * Signed in, with the TEST wallet in this page, on the wallet room's Venue account tab, the browser wallet connected.
 * `rpcUrl` connects the wallet to the stack's TEST chain, so a transfer it sends lands there. `beforeVenue` runs signed in,
 * before the room opens (#5 adds an authenticator app there).
 */
async function openVenue(page, who, privateKey, { rpcUrl = null, beforeVenue = null } = {}) {
  const wallet = await installTestWallet(page, { chainId: CHAIN_ID, privateKey, rpcUrl });
  await signIn(page, who);
  if (beforeVenue) await beforeVenue();
  await page.goto('/wallet');
  await page.getByRole('button', { name: 'Venue account', exact: true }).click();
  await expect(page).toHaveURL(/\/wallet\/venue$/);
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  return wallet;
}

const venueAction = (page, name) => page.getByRole('region', { name: 'Venue actions' }).getByRole('button', { name });
const sheet = (page) => page.locator('[data-sheet="sign"]');

/** The person's own `venueWallet.status` through Edge: what svc-protocol records for their wallets. */
async function recorded(who) {
  const client = await api(who);
  const { status, body } = await client.get('/api/protocol/trpc/venueWallet.status');
  if (status !== 200) throw new Error(`venueWallet.status refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.result.data;
}

/** Presses Connect, continues the plain-words sheet, and the TEST wallet signs. */
async function connectAndSign(page, button = 'Connect to my account') {
  await page.getByRole('button', { name: button }).click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible();
}

test(`${J} #1 opens Wallet and presses Connect: a message to sign; a wallet on the blank or set sanctions list, or from a blocked region, is refused with its reason`, async ({
  page,
}) => {
  // Two restarts of svc-protocol for the blank list, and two of svc-protocol and Edge for the blocked region.
  test.setTimeout(480_000);
  const who = await signUp(page, 'jwallet09');
  const walletKey = testWalletKey();
  run.reset({ who, walletKey });

  // A wallet on the set sanctions list is refused with its reason, and no message is written for it.
  expect(privateKeyToAccount(LISTED_KEY).address).toBe(LISTED);
  const listedPage = await page.context().newPage();
  try {
    await openVenue(listedPage, who, LISTED_KEY);
    await listedPage.getByRole('button', { name: 'Connect to my account' }).click();
    await expect(listedPage.getByText('This wallet can’t be connected')).toBeVisible();
    await expect(
      listedPage.getByText('This wallet is on the sanctions list, so it cannot be connected or used. Nothing was connected.'),
    ).toBeVisible();
    await expect(listedPage.getByText('protocol.wallet_sanctioned')).toBeVisible();
    await expect(listedPage.locator('[data-venue-message]')).toHaveCount(0);
    await expect(sheet(listedPage)).toHaveCount(0);
  } finally {
    await listedPage.close();
  }

  // A blank wallet sanctions list refuses every wallet, the person's own included, with its reason (OWNER 88).
  const blankPage = await page.context().newPage();
  try {
    restartWith('protocol', 'LOCAL_STACK_PROTOCOL_WALLET_SANCTIONS', false);
    await openVenue(blankPage, who, walletKey);
    await blankPage.getByRole('button', { name: 'Connect to my account' }).click();
    await expect(blankPage.getByText('No wallet can be screened', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(
      blankPage.getByText('The wallet sanctions list is not set, so no wallet can be screened or connected. Nothing was connected.'),
    ).toBeVisible();
    await expect(blankPage.getByText('protocol.wallet_sanctions_unset')).toBeVisible();
    await expect(blankPage.locator('[data-venue-message]')).toHaveCount(0);
    await expect(sheet(blankPage)).toHaveCount(0);
  } finally {
    await blankPage.close();
    restartWith('protocol', 'LOCAL_STACK_PROTOCOL_WALLET_SANCTIONS', true);
  }

  // A visitor from a blocked region is refused with its reason before any message, the person's own wallet included
  // (OWNER 88, OWNER 237): the TEST region AA blocked in svc-protocol, and Edge stamping every request from it.
  const regionPage = await page.context().newPage();
  try {
    restartWith('protocol', 'LOCAL_STACK_TEST_REGION_SERVED', false);
    restartWith('edge', 'LOCAL_STACK_TEST_REGION_SERVED', false);
    await openVenue(regionPage, who, walletKey);
    // The room's read of the person's connections is refused by the same guard, so the refusal is there before Connect
    // too; pressing Connect is refused the same way, and no message is written.
    await expect(regionPage.getByText('Not available in your region', { exact: true })).toBeVisible({ timeout: 20_000 });
    await regionPage.getByRole('button', { name: 'Connect to my account' }).click();
    await expect(regionPage.getByRole('button', { name: 'Connect to my account' })).toBeEnabled();
    await expect(regionPage.getByText('Not available in your region', { exact: true })).toBeVisible();
    await expect(
      regionPage.getByText(`Connecting a wallet is not available where you are: ${REGION_REASON}. Nothing was connected.`),
    ).toBeVisible();
    await expect(regionPage.getByText('denied.region_blocked')).toBeVisible();
    await expect(regionPage.locator('[data-venue-message]')).toHaveCount(0);
    await expect(sheet(regionPage)).toHaveCount(0);
  } finally {
    await regionPage.close();
    // Edge first, so no request is stamped from the TEST region once it is served again.
    try {
      restartWith('edge', 'LOCAL_STACK_TEST_REGION_SERVED', true);
    } finally {
      restartWith('protocol', 'LOCAL_STACK_TEST_REGION_SERVED', true);
    }
  }

  // The person's own wallet: Connect shows the exact message to sign, naming INTAFACED, the address, the chain, a nonce
  // and the expiry.
  const address = privateKeyToAccount(walletKey).address;
  await openVenue(page, who, walletKey);
  await page.getByRole('button', { name: 'Connect to my account' }).click();
  const message = page.locator('[data-venue-message]');
  await expect(message).toContainText('wants you to sign in with your Ethereum account:');
  await expect(message).toContainText(address);
  await expect(message).toContainText('INTAFACED');
  await expect(message).toContainText(`Chain ID: ${CHAIN_ID}`);
  await expect(message).toContainText(/Nonce: [A-Za-z0-9]{8,}/);
  await expect(message).toContainText(/Expiration Time: \d{4}-\d{2}-\d{2}T/);
  // The wallet's own sheet shows the same message before it signs anything.
  await expect(sheet(page).locator('[data-sheet-payload]')).toContainText(address);
  await sheet(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('You cancelled the signature')).toBeVisible();
  expect((await recorded(who)).connections).toEqual([]);
});

test(`${J} #2 signs with the wallet: it shows connected with its expiry; INTAFACED holds no key that can move its funds`, async ({
  page,
}) => {
  const { who, walletKey } = state();
  const address = privateKeyToAccount(walletKey).address;
  const wallet = await openVenue(page, who, walletKey);
  await connectAndSign(page);
  expect(wallet.requests.map((r) => r.method)).toEqual(['personal_sign']);
  const panel = page.locator('[data-panel="venue-connection"]');
  await expect(panel.locator('[data-venue-address]')).toHaveText(address);
  const expires = panel.getByTestId('venue-connection-expires');
  await expect(expires).toBeVisible();
  const expiresAt = await expires.getAttribute('datetime');
  expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
  await expect(panel.getByText(NO_KEY)).toBeVisible();

  // What INTAFACED records is the address and its times: no key, no agent, nothing that can sign for the wallet.
  const { connections } = await recorded(who);
  expect(connections).toEqual([
    { address, chainId: CHAIN_ID, connectedAt: expect.any(String), expiresAt, status: 'live', holdsKey: false },
  ]);
  expect(JSON.stringify(connections)).not.toMatch(/0x[0-9a-fA-F]{64}/);
  run.write({ expiresAt });

  // The connection is the service's: a reload reads it back with the same expiry.
  await page.reload();
  // The browser wallet may come back by itself (it is still authorised); otherwise the person connects it again.
  const again = page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` });
  await expect(page.getByRole('heading', { name: 'Connected' }).or(again)).toBeVisible();
  if (await again.isVisible()) await again.click();
  await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible();
  await expect(page.getByTestId('venue-connection-expires')).toHaveAttribute('datetime', expiresAt);
});

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

/** The wallet's TEST USD on the TEST chain, in base units (6 decimals), read from the node itself. */
async function chainUsd(address) {
  const data = encodeFunctionData({ abi: parseAbi(['function balanceOf(address) view returns (uint256)']), args: [address] });
  const res = await fetch(testChain().gateUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: TEST_USD, data }, 'latest'] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`balanceOf: ${JSON.stringify(body.error)}`);
  return BigInt(body.result);
}

/** What a signed action needs left of the connection: the stack's TEST connection lasts 60 s (local-stack-services/protocol.mjs). */
const CONNECTION_MARGIN_MS = 45_000;

/**
 * Connected for the next signed action: the connection from an earlier step, or an earlier action, may have ended, so
 * the wallet signs again. One about to end is let end first (the room shows it expired), so the action never races it.
 */
async function connectedNow(page) {
  await roomSettled(page);
  if (await page.getByRole('heading', { name: 'Connected' }).isVisible()) {
    const expiresAt = Date.parse(await page.getByTestId('venue-connection-expires').getAttribute('datetime'));
    if (expiresAt - Date.now() > CONNECTION_MARGIN_MS) return;
    await expect(page.getByRole('heading', { name: 'Connection expired' })).toBeVisible({ timeout: CONNECTION_MARGIN_MS + 15_000 });
  }
  if (await page.getByRole('button', { name: 'Sign again' }).isVisible()) await connectAndSign(page, 'Sign again');
  if (await page.getByRole('button', { name: 'Connect to my account' }).isVisible()) await connectAndSign(page);
}

test(`${J} #3 deposits TEST USDC from the wallet into the venue account: the user signs in the wallet; the venue credits it; the app shows the venue's figure with an as-of time; the ledger posts nothing`, async ({
  page,
}) => {
  // One restart of trade (and the TEST venue's start), and the venue's credit.
  test.setTimeout(300_000);
  const { who, walletKey, verified } = state();
  const address = privateKeyToAccount(walletKey).address;
  expect(testChain().chain, 'the stack runs its TEST chain').toBe('running');
  // The venue door's account reads and withdrawals are trade, which needs a verified person (svc-trade
  // requireTradeJurisdiction: trade's minimum tier is basic); the person verifies once, as every trading journey does.
  if (!verified) {
    await signIn(page, who);
    await verify(page, who);
    run.write({ verified: true });
  }
  if (!(await venueDoor(who)).deposit) userVenue(true);
  const door = await venueDoor(who);
  expect(door).toMatchObject({
    enabled: true,
    available: true,
    label: 'TEST',
    deposit: { chainId: CHAIN_ID, token: TEST_USD, asset: 'USDC' },
  });
  fundOnTestChain(address, 'venue');
  const onChainBefore = await chainUsd(address);

  // What the ledger holds for this person before the deposit: it must hold exactly this after.
  const ledgerBefore = await (await api(who)).balances();
  const wallet = await openVenue(page, who, walletKey, { rpcUrl: testChain().gateUrl });
  await connectedNow(page);
  // The venue's figure for this new account, before anything is sent: it holds none.
  const figure = page.getByTestId('venue-balance');
  await expect(figure).toHaveText('0 TEST USDC');
  await expect(page.getByText('TEST venue: every figure here is TEST.')).toBeVisible();
  const asOfBefore = await page.getByTestId('venue-balance-as-of').getAttribute('datetime');

  await page.getByRole('region', { name: 'Venue actions' }).getByLabel('Amount').fill(DEPOSIT);
  await venueAction(page, 'Deposit TEST USDC').click();
  // The user signs in the wallet: the plain-words sheet, then the wallet sends their own transfer to the venue.
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect.poll(() => wallet.sends.length).toBe(1);
  expect(wallet.sends[0].method).toBe('eth_sendTransaction');
  expect(wallet.sends[0].params[0].to.toLowerCase()).toBe(TEST_USD);
  expect(wallet.sends[0].params[0].data.toLowerCase()).toContain(door.deposit.address.slice(2));
  await expect(page.getByTestId('venue-deposit')).toBeVisible();

  // The venue credits it: this new account's venue figure is exactly the deposit, with the venue's as-of time.
  await expect(figure).toHaveText(`${DEPOSIT} TEST USDC`, { timeout: 60_000 });
  await expect(page.getByTestId('venue-deposit')).toHaveText(`The venue credited ${DEPOSIT} TEST USDC.`);
  const asOf = await page.getByTestId('venue-balance-as-of').getAttribute('datetime');
  expect(Date.parse(asOf)).toBeGreaterThan(Date.parse(asOfBefore));
  expect(Math.abs(Date.parse(asOf) - Date.now())).toBeLessThan(120_000);
  // The tokens left the person's own wallet on chain, to the venue: the deposit is their transfer.
  expect(onChainBefore - (await chainUsd(address))).toBe(25_000_000n);
  // The venue's own record, read through the door, is the same figure.
  const read = await (await api(who)).get(`/api/v1/venue/balances?owner=${address.toLowerCase()}`);
  expect(read.body.value.find((b) => b.asset === 'USDC')).toMatchObject({ free: DEPOSIT, locked: '0' });
  // A reload reads the venue's figure again, never a figure the app kept: still exactly the deposit, credited once.
  await page.reload();
  const again = page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` });
  await expect(page.getByRole('heading', { name: 'Connected' }).or(again)).toBeVisible();
  if (await again.isVisible()) await again.click();
  await expect(figure).toHaveText(`${DEPOSIT} TEST USDC`);

  // The ledger posts nothing: the person's ledger balances are the same as before.
  expect(await (await api(who)).balances()).toEqual(ledgerBefore);
  run.write({ deposited: DEPOSIT });
});

/** The room has read the connection back: it shows Connected, Connection expired, or Connect. Branch only after this. */
async function roomSettled(page) {
  await expect(
    page
      .getByRole('heading', { name: 'Connected' })
      .or(page.getByRole('heading', { name: 'Connection expired' }))
      .or(page.getByRole('button', { name: 'Connect to my account' })),
  ).toBeVisible();
}

test(`${J} #4 lets the connection expire: every signed action refuses until the wallet signs again`, async ({ page }) => {
  test.setTimeout(180_000);
  const { who, walletKey } = state();
  await openVenue(page, who, walletKey);
  // A connection that is live now, so this step watches it expire.
  await roomSettled(page);
  if (await page.getByRole('button', { name: 'Sign again' }).isVisible()) await connectAndSign(page, 'Sign again');
  if (await page.getByRole('button', { name: 'Connect to my account' }).isVisible()) await connectAndSign(page);
  const expiresAt = await page.getByTestId('venue-connection-expires').getAttribute('datetime');
  const left = Date.parse(expiresAt) - Date.now();
  expect(left).toBeGreaterThan(0);

  // The expiry passes: the room says so.
  await expect(page.getByRole('heading', { name: 'Connection expired' })).toBeVisible({ timeout: left + 15_000 });
  await expect(page.getByRole('button', { name: 'Sign again' })).toBeVisible();
  expect((await recorded(who)).connections.map((c) => c.status)).toEqual(['expired']);

  // Every signed action is refused by the service, by name, and nothing is asked of the wallet.
  for (const action of ['Deposit TEST USDC', 'Withdraw TEST USDC']) {
    await venueAction(page, action).click();
    await expect(page.getByText('Your wallet must sign again')).toBeVisible();
    await expect(page.getByText('protocol.venue_connection_expired')).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
  }

  // Until the wallet signs again: then the connection is live with a new expiry, and the expiry refusal is gone.
  await connectAndSign(page, 'Sign again');
  const renewed = await page.getByTestId('venue-connection-expires').getAttribute('datetime');
  expect(Date.parse(renewed)).toBeGreaterThan(Date.parse(expiresAt));
  await venueAction(page, 'Deposit TEST USDC').click();
  await expect(page.getByText('protocol.venue_connection_expired')).toHaveCount(0);
  expect((await recorded(who)).connections.map((c) => c.status)).toEqual(['live']);
});

/** Presses Withdraw for `amount`, confirms with a fresh authenticator code, and continues to the wallet. */
async function withdrawWithCode(page, amount, code) {
  // A connection that outlasts the action, then the code (it may wait up to 30 s for the authenticator's next step), so
  // the code is fresh when the step-up takes it and the connection still has at least 15 s for the signed action.
  await connectedNow(page);
  const totpCode = await code();
  await page.getByRole('region', { name: 'Venue actions' }).getByLabel('Amount').fill(amount);
  await venueAction(page, 'Withdraw TEST USDC').click();
  const stepUp = page.getByTestId('step-up-confirm');
  await expect(stepUp).toContainText('Confirm it’s you');
  await stepUp.getByLabel('Authenticator code').fill(totpCode);
  await stepUp.getByRole('button', { name: 'Confirm', exact: true }).click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
}

/** The TEST venue's own switch for the network fee it reports (TEST control, never part of the venue interface). */
async function networkFeeSwitch(fee) {
  const res = await fetch(`${TEST_VENUE}/test/switches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ networkFee: fee }),
  });
  expect(res.status).toBe(200);
}

test(`${J} #5 withdraws TEST USDC from the venue to the wallet: the user signs; the venue's withdrawal shows pending then done, with the venue's fee and the network fee, or "not known"`, async ({
  page,
}) => {
  // Four withdrawals, each with a fresh authenticator code (a new 30-second step), the venue's delay, and a restart.
  test.setTimeout(480_000);
  const { who, walletKey, deposited } = state();
  if (!deposited) throw new Error(`${J} #3 made no deposit, so there is nothing on the venue to withdraw`);
  const address = privateKeyToAccount(walletKey).address;
  const owner = address.toLowerCase();
  try {
    if (!(await venueDoor(who)).deposit) userVenue(true);
    const ledgerBefore = await (await api(who)).balances();
    const { totp } = await totpLib();
    const code = async () => {
      const now = run.read();
      const next = await nextCode(totp, now.secret, now.step);
      run.write({ step: next.step });
      return next.code;
    };
    const wallet = await openVenue(page, who, walletKey, {
      rpcUrl: testChain().gateUrl,
      // A withdrawal needs a fresh second factor: the person adds an authenticator app in Security first.
      beforeVenue: async () => run.write(await addAuthenticator(page, totp)),
    });
    await connectedNow(page);
    const figure = page.getByTestId('venue-balance');
    await expect(figure).toHaveText(`${deposited} TEST USDC`);

    // A withdrawal the venue's free balance does not cover is refused by the venue, by name: nothing is pending or sent.
    await withdrawWithCode(page, '1000', code);
    await expect(page.getByText('Not enough on the venue')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('trade.venue.insufficient_balance')).toBeVisible();
    await expect(page.getByTestId('venue-withdrawal')).toHaveCount(0);

    // A signature that does not match the prepared withdrawal (another key answers in the wallet) is refused before
    // anything is stored or sent.
    const onChainBefore = await chainUsd(address);
    wallet.signWithOtherKeyNext();
    await withdrawWithCode(page, '5', code);
    await expect(page.getByText('The signature does not match this wallet')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('trade.venue.signature_mismatch')).toBeVisible();
    await expect(page.getByTestId('venue-withdrawal')).toHaveCount(0);
    await expect(figure).toHaveText(`${deposited} TEST USDC`);

    // The user signs: the venue's withdrawal shows pending, then done, with the venue's fee and the network fee.
    const signedBefore = wallet.requests.length;
    await withdrawWithCode(page, '10', code);
    await expect.poll(() => wallet.requests.length).toBe(signedBefore + 1);
    expect(wallet.requests.at(-1).method).toBe('eth_signTypedData_v4');
    const withdrawal = page.getByTestId('venue-withdrawal');
    await expect(withdrawal.getByTestId('venue-withdrawal-status')).toHaveText('Pending', { timeout: 30_000 });
    await expect(withdrawal.getByTestId('venue-fee')).toHaveText(VENUE_FEE);
    await expect(withdrawal.getByTestId('network-fee')).toHaveText(NETWORK_FEE);
    await expect(withdrawal.getByTestId('venue-withdrawal-status')).toHaveText('Done', { timeout: 60_000 });
    // The venue took the amount and its fee; what arrived on chain in the person's own wallet is the amount less the
    // network fee: 10 − 0.25.
    await expect(figure).toHaveText('14 TEST USDC', { timeout: 30_000 });
    await expect.poll(async () => (await chainUsd(address)) - onChainBefore, { timeout: 30_000 }).toBe(9_750_000n);

    // A network fee the venue does not publish is shown "not known", never 0.
    await networkFeeSwitch({ known: false });
    await withdrawWithCode(page, '2', code);
    await expect(withdrawal.getByTestId('venue-withdrawal-status')).toHaveText(/Pending|Done/, { timeout: 30_000 });
    await expect(withdrawal.getByTestId('venue-fee')).toHaveText(VENUE_FEE);
    await expect(withdrawal.getByTestId('network-fee')).toHaveText('not known');
    await expect(withdrawal.getByTestId('venue-withdrawal-status')).toHaveText('Done', { timeout: 60_000 });
    await expect(figure).toHaveText('11 TEST USDC', { timeout: 30_000 });

    // The ledger posts nothing: the person's ledger balances are the same as before.
    const client = await api(who, { totpCode: await code() });
    expect(await client.balances()).toEqual(ledgerBefore);
    // The venue's record, read through the door by its owner, is the room's figure.
    const read = await client.get(`/api/v1/venue/balances?owner=${owner}`);
    expect(read.body.value.find((b) => b.asset === 'USDC')).toMatchObject({ free: '11' });
  } finally {
    await networkFeeSwitch({ known: true, value: '0.25' }).catch(() => undefined);
    // The stack as it was: trade's user-venue door off again (the TEST venue keeps running, unreached).
    userVenue(false);
  }
});
