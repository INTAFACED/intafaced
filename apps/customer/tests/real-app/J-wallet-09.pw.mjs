// World: none
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { CHAIN_ID, UNBUILT } from './dex.mjs';
import { signIn, signUp } from './desk.mjs';
import { api, journeyState } from './stack.mjs';
import { installTestWallet, TEST_WALLET, testWalletKey } from './test-wallet.mjs';

// J-wallet-09, in the running app (docs/roadmap/journeys.json): I connect my own wallet and fund my venue account from
// it. One test per step, titled "J-wallet-09 #<n>", run in order by one signed-in TEST person with one TEST browser wallet
// (test-wallet.mjs, a fresh key kept in this run's state). The connection is svc-protocol's record (`venueWallet.*`):
// an address and its expiry, never a key. The stack's labelled TEST owner values (tooling/profiles/test-owner-values/
// protocol.json) give a one-minute connection, so #4 waits about a minute, and a wallet sanctions list of one TEST
// address, the wallet #1 derives from the TEST seed below. Region refusal: the journeys stack names no trusted region
// header, so a test cannot play a visitor from a blocked region here; svc-protocol's mounted test proves that refusal
// (services/svc-protocol/src/venue-wallet/connection.test.ts). #3 and #5 need the TEST venue simulator.
// Money: INTAFACED moves nothing and the ledger posts nothing in this journey.
const J = 'J-wallet-09';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** The TEST wallet on the stack's TEST wallet sanctions list (PROTOCOL_WALLET_SANCTIONS in the TEST profile). */
const LISTED_KEY = keccak256(toHex('INTAFACED LOCAL TEST sanctioned wallet (J-wallet-09)'));
const LISTED = '0xe6d1aB28c0f3477FdBdAC2df19743CEae59e8A83';
const NO_KEY = 'INTAFACED holds no key that can move this wallet’s funds. You sign every venue action in your own wallet.';

test.describe.configure({ mode: 'default' });

function state() {
  const s = run.read();
  if (!s.who || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return s;
}

/** Signed in, with the TEST wallet in this page, on the wallet room's Venue account tab, the browser wallet connected. */
async function openVenue(page, who, privateKey) {
  const wallet = await installTestWallet(page, { chainId: CHAIN_ID, privateKey });
  await signIn(page, who);
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

test(`${J} #1 opens Wallet and presses Connect: a message to sign; a wallet on the sanctions list is refused with its reason`, async ({
  page,
}) => {
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

test(`${J} #3 deposits TEST USDC from the wallet into the venue account: the venue credits it, with an as-of time`, async ({ page }) => {
  const { who, walletKey } = state();
  const wallet = await openVenue(page, who, walletKey);
  // The connection from #2 may have ended: sign again so this step starts connected.
  if (await page.getByRole('button', { name: 'Sign again' }).isVisible()) await connectAndSign(page, 'Sign again');
  await venueAction(page, 'Deposit TEST USDC').click();
  // The user signs in the wallet.
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click(UNBUILT);
  expect(wallet.requests.length).toBeGreaterThan(1);
  // The venue credits it, and the app shows the venue's figure with an as-of time; the ledger posts nothing.
  const figure = page.getByTestId('venue-balance');
  await expect(figure).toContainText('TEST USDC', UNBUILT);
  await expect(page.getByTestId('venue-balance-as-of')).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/, UNBUILT);
});

test(`${J} #4 lets the connection expire: every signed action refuses until the wallet signs again`, async ({ page }) => {
  test.setTimeout(180_000);
  const { who, walletKey } = state();
  await openVenue(page, who, walletKey);
  // A connection that is live now, so this step watches it expire.
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

test(`${J} #5 withdraws TEST USDC from the venue to the wallet: pending then done, with the venue's fee and the network fee`, async ({
  page,
}) => {
  const { who, walletKey } = state();
  await openVenue(page, who, walletKey);
  if (await page.getByRole('button', { name: 'Sign again' }).isVisible()) await connectAndSign(page, 'Sign again');
  await venueAction(page, 'Withdraw TEST USDC').click();
  // The user signs.
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click(UNBUILT);
  // The venue's withdrawal shows pending, then done.
  const withdrawal = page.getByTestId('venue-withdrawal');
  await expect(withdrawal).toContainText('Pending', UNBUILT);
  await expect(withdrawal).toContainText('Done', { timeout: 60_000 });
  // With the venue's fee and the network fee, each a figure or "not known".
  await expect(withdrawal.getByTestId('venue-fee')).toHaveText(/TEST USDC|not known/, UNBUILT);
  await expect(withdrawal.getByTestId('network-fee')).toHaveText(/\d|not known/, UNBUILT);
});
