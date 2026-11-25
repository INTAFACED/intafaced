// World: restart, stack, book
import { generateKeyPairSync } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { api, journeyState, restartService, signOutBrowser, stackUrl, startService, stopService } from './stack.mjs';
import { PASSKEY_ORIGIN } from './identity-factors.mjs';
import { venueForThisFile, venueInfo, venueRecord } from './venue.mjs';
import { device, openRoom, recorded } from './embedded-wallet.mjs';

// J-wallet-22, in the running app: I get my own wallet when I sign up, without a seed phrase. One test per step, titled
// "J-wallet-22 #<n>", run in order by one signed-up TEST person. The provider is the stack's labelled TEST embedded-wallet
// provider (tooling/scripts/local-test-wallet-provider.mjs), its own process: it keeps the TEST keys in itself and its own state file, never in a svc-* database, and
// signs only after a WebAuthn assertion from a passkey bound to the wallet. Passkeys belong to the stack's relying party
// `localhost`, so this file uses the customer app at http://localhost:3210 and Chromium's virtual authenticator for the
// person's device. The passkey is carried between steps (and to the "new device" of #6) as the authenticator's own
// credential, kept only in this run's state file, as a synced passkey or a saved recovery passkey would be.
// #1 restarts svc-protocol once with the provider setting blank (`LOCAL_STACK_PROTOCOL_EMBEDDED_WALLET=off`,
// tooling/scripts/local-stack-services/protocol.mjs), and svc-protocol and Edge once with the TEST region AA not served
// (`LOCAL_STACK_TEST_REGION_SERVED=off`, as J-wallet-09 #1), and puts both back.
// Money: INTAFACED moves nothing and the ledger posts nothing in this journey; the key stays with the provider.
// The whole file runs with the stack's TEST venue door on (venue.mjs `venueForThisFile`, as J-wallet-09): svc-trade's
// user-venue door (`/api/v1/venue/*`, through Edge) on the TEST venue simulator (tooling/scripts/local-test-venue.mjs);
// trade restarts with LOCAL_STACK_USER_VENUE=on before #1 and back off after the file. #2, #4, #6 and #7 read the TEST
// venue's own record for the wallet on loopback (venue.mjs `venueRecord`), never our door: the agent keys it would accept
// for the wallet's account, its open orders and its deposits. #8 (one session-key approval per trading session, slice
// D-venue-09) trades there and reads the venue's agents and open orders the same way. The venue's TEST controls stand in for two outside
// events: `/test/expire-agent` for a key's expiry passing (the venue keeps it listed, expired), and `/test/lose-answers`
// for an approval whose answer is lost on the way back.
const J = 'J-wallet-22';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const PROVIDER = 'TEST wallet provider';
const KEPT_BY = `Your wallet’s key is kept by ${PROVIDER}. Only you can sign with it, after your passkey.`;
/** The TEST region AA's reason while it is not served (TEST_BUSINESS_BLOCK_REASON in packages/config jurisdiction.ts). */
const REGION_REASON = 'TEST region, not served at launch';

test.describe.configure({ mode: 'default' });
test.use({ baseURL: PASSKEY_ORIGIN });
venueForThisFile(test);

/**
 * The TEST venue's own record for the wallet's account, read on loopback (venue.mjs): the agent keys the venue would
 * accept to act for it, its open orders and its deposits. Empty is the venue saying nothing but the wallet's own key has
 * ever been given any power there, and nothing was signed or sent to it.
 */
async function onVenue(address) {
  const [agents, orders, deposits] = await Promise.all([
    venueRecord(address, '/agents'),
    venueRecord(address, '/open-orders'),
    venueRecord(address, '/deposits'),
  ]);
  return { agents: agents.value, orders: orders.value, deposits: deposits.value };
}
const NOTHING_ON_VENUE = { agents: [], orders: [], deposits: [] };

function state() {
  const s = run.read();
  if (!s.who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return s;
}
function walletState() {
  const s = state();
  if (!s.address || !s.credential) throw new Error(`${J} #2 made no wallet, so this step has no wallet to act on`);
  return s;
}

async function venueConnections(who) {
  const client = await api(who);
  const { status, body } = await client.get('/api/protocol/trpc/venueWallet.status');
  if (status !== 200) throw new Error(`venueWallet.status refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.result.data.connections;
}
async function disconnectVenue(who, address) {
  const client = await api(who);
  const { status } = await client.post('/api/protocol/trpc/venueWallet.disconnect', { address });
  expect(status).toBe(200);
}

const panel = (page) => page.locator('[data-panel="embedded-wallet"]');

test(`${J} #1 opens Wallet and presses Create my wallet: the provider is named; a blank provider setting, or a blocked region, is refused and nothing is made`, async ({
  page,
}) => {
  // One restart of svc-protocol for the blank setting, two of svc-protocol and Edge for the blocked region, and back.
  test.setTimeout(480_000);
  const phone = await device(page);
  const who = await signUp(page, 'jwallet22');
  run.reset({ who });

  // The provider setting blank: Create my wallet is refused by its code and no passkey or wallet is made.
  const blankPage = await page.context().newPage();
  try {
    await restartService('protocol', { LOCAL_STACK_PROTOCOL_EMBEDDED_WALLET: 'off' });
    const blankDevice = await device(blankPage);
    await openRoom(blankPage, who);
    await expect(panel(blankPage).locator('[data-embedded-provider]')).toHaveCount(0);
    await blankPage.getByRole('button', { name: 'Create my wallet', exact: true }).click();
    await expect(blankPage.getByText('No wallet provider is set', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(blankPage.getByText('No embedded-wallet provider is set, so no wallet can be made. Nothing was made.')).toBeVisible();
    await expect(blankPage.getByText('wallet.embedded_provider_unset')).toBeVisible();
    expect(await blankDevice.held()).toEqual([]);
    expect(await recorded(who)).toEqual({
      provider: null,
      wallet: null,
      gasSponsor: { set: false, code: 'wallet.gas_sponsor_unset' },
    });
  } finally {
    await blankPage.close();
    await restartService('protocol', { LOCAL_STACK_PROTOCOL_EMBEDDED_WALLET: undefined });
  }

  // A visitor from a blocked region is refused with its reason, before the provider is asked anything.
  const regionPage = await page.context().newPage();
  try {
    await restartService('protocol', { LOCAL_STACK_TEST_REGION_SERVED: 'off' });
    await restartService('edge', { LOCAL_STACK_TEST_REGION_SERVED: 'off' });
    const regionDevice = await device(regionPage);
    await openRoom(regionPage, who);
    await expect(regionPage.getByText('Not available in your region', { exact: true })).toBeVisible({ timeout: 20_000 });
    await regionPage.getByRole('button', { name: 'Create my wallet', exact: true }).click();
    await expect(regionPage.getByRole('button', { name: 'Create my wallet', exact: true })).toBeEnabled();
    await expect(regionPage.getByText(`Your own wallet is not available where you are: ${REGION_REASON}. Nothing was made.`)).toBeVisible();
    await expect(regionPage.getByText('denied.region_blocked')).toBeVisible();
    expect(await regionDevice.held()).toEqual([]);
  } finally {
    await regionPage.close();
    try {
      await restartService('edge', { LOCAL_STACK_TEST_REGION_SERVED: undefined });
    } finally {
      await restartService('protocol', { LOCAL_STACK_TEST_REGION_SERVED: undefined });
    }
  }
  expect((await recorded(who)).wallet).toBeNull();

  // Served, with the provider set: the room names where the key is kept and that only the person can sign with it.
  await openRoom(page, who);
  await expect(panel(page).locator('[data-embedded-provider]')).toHaveText(KEPT_BY);
  await expect(page.getByRole('button', { name: 'Create my wallet', exact: true })).toBeEnabled();
  expect(await phone.held()).toEqual([]);
  expect((await recorded(who)).provider).toEqual({
    id: 'test',
    displayName: PROVIDER,
    test: true,
    capabilities: { export: true, recovery: true },
  });
});

test(`${J} #2 creates it with a passkey: an address on the venue's network, labelled TEST; no seed phrase; INTAFACED records the address and the provider's wallet id, never key material`, async ({
  page,
}) => {
  const { who } = state();
  const phone = await device(page);
  await openRoom(page, who);
  await page.getByRole('button', { name: 'Create my wallet', exact: true }).click();
  const address = panel(page).locator('[data-embedded-address]');
  await expect(address).toHaveText(/^0x[0-9a-fA-F]{40}$/, { timeout: 20_000 });
  await expect(panel(page).locator('[data-test-label]')).toHaveText('TEST');
  await expect(page.getByText('There is no seed phrase. Your passkey on your device is what lets you sign.')).toBeVisible();
  // Nothing asks for or shows recovery words.
  await expect(panel(page).getByRole('textbox')).toHaveCount(0);
  await expect(panel(page)).not.toContainText(/recovery phrase|write down these words|secret phrase/i);

  // One passkey on the device, made for this wallet.
  const held = await phone.held();
  expect(held).toHaveLength(1);

  // INTAFACED's record: the address and the provider's wallet id under the business key, and nothing that can sign.
  const client = await api(who);
  const { wallet } = await recorded(who);
  expect(wallet).toEqual({
    address: await address.textContent(),
    providerWalletId: expect.stringMatching(/^testw_[0-9a-f]{24}$/),
    provider: 'test',
    idempotencyKey: `wallet:embedded:${client.userId}`,
    createdAt: expect.any(String),
    test: true,
    holdsKey: false,
  });
  expect(JSON.stringify(wallet)).not.toMatch(/0x[0-9a-fA-F]{64}/);
  await expect(panel(page).locator('[data-embedded-wallet-id]')).toHaveText(wallet.providerWalletId);
  // The venue's own record for the new address: an account on its network that no key but the wallet's own can act for
  // (no agent key given), with nothing signed or sent to it yet.
  expect(await onVenue(wallet.address), 'the venue knows no key but the wallet’s own for the new address').toEqual(NOTHING_ON_VENUE);
  run.write({ address: wallet.address, walletId: wallet.providerWalletId, credential: held[0] });
});

test(`${J} #3 presses Create my wallet again, or the request is replayed: the same wallet, never a second, under the business key wallet:embedded:<personId>`, async ({
  page,
  browser,
}) => {
  const { who, address, walletId } = walletState();

  // Pressing it again, for real: one new TEST person on two devices, each signed in and showing the room before the
  // wallet exists, so both offer Create my wallet. The first makes the wallet; the second's press gets that same wallet
  // back, with no passkey made on it.
  const twice = await signUp(page, 'jwallet22again');
  const first = page;
  const firstDevice = await device(first);
  const other = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  try {
    const second = await other.newPage();
    const secondDevice = await device(second);
    await openRoom(first, twice);
    await openRoom(second, twice);
    await expect(second.getByRole('button', { name: 'Create my wallet', exact: true })).toBeEnabled();
    await expect(first.getByRole('button', { name: 'Create my wallet', exact: true })).toBeEnabled();
    await first.getByRole('button', { name: 'Create my wallet', exact: true }).click();
    const made = panel(first).locator('[data-embedded-address]');
    await expect(made).toHaveText(/^0x[0-9a-fA-F]{40}$/, { timeout: 20_000 });
    const madeId = await panel(first).locator('[data-embedded-wallet-id]').textContent();
    await second.getByRole('button', { name: 'Create my wallet', exact: true }).click();
    await expect(panel(second).locator('[data-embedded-address]')).toHaveText(await made.textContent(), { timeout: 20_000 });
    await expect(panel(second).locator('[data-embedded-wallet-id]')).toHaveText(madeId);
    expect(await firstDevice.held()).toHaveLength(1);
    expect(await secondDevice.held(), 'the second press made no passkey').toEqual([]);
    const twiceClient = await api(twice);
    expect((await recorded(twice)).wallet).toMatchObject({
      address: await made.textContent(),
      providerWalletId: madeId,
      idempotencyKey: `wallet:embedded:${twiceClient.userId}`,
    });
  } finally {
    await other.close();
  }

  // A replayed create, twice at once, with another passkey, for the person of #2: the same wallet under the same business
  // key, created false, never a second.
  const client = await api(who);
  const key = `wallet:embedded:${client.userId}`;
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const passkey = {
    credentialId: 'cmVwbGF5ZWQ',
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    algorithm: -7,
  };
  const replies = await Promise.all([
    client.post('/api/protocol/trpc/embeddedWallet.create', { passkey }),
    client.post('/api/protocol/trpc/embeddedWallet.create', { passkey }),
  ]);
  for (const { status, body } of replies) {
    expect(status).toBe(200);
    expect(body.result.data).toMatchObject({ created: false, wallet: { address, providerWalletId: walletId, idempotencyKey: key } });
  }
  expect((await recorded(who)).wallet).toMatchObject({ address, providerWalletId: walletId, idempotencyKey: key });
});

test(`${J} #4 signs to connect it to the venue account: connected with its expiry, as J-wallet-09 #2, from the same address, after the passkey`, async ({
  page,
}) => {
  const { who, address, credential } = walletState();
  await device(page, [credential]);
  const signs = [];
  page.on('request', (r) => r.url().includes('/__test-wallet-provider/client/sign') && signs.push(r.url()));
  await openRoom(page, who);
  await expect(panel(page).locator('[data-embedded-address]')).toHaveText(address);
  // A connection left live from an earlier run of this step is ended first, so this step makes one.
  if ((await venueConnections(who)).length) {
    await disconnectVenue(who, address);
    await page.reload();
  }
  await page.getByRole('button', { name: 'Connect to the venue', exact: true }).click();
  const expires = page.getByTestId('embedded-venue-expires');
  await expect(expires).toBeVisible({ timeout: 20_000 });
  const expiresAt = await expires.getAttribute('datetime');
  expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
  expect(signs).toHaveLength(1);
  // svc-protocol's venue connection, J-wallet-09's record: this wallet's address, live, holding no key, on the chain the
  // venue's own signatures name.
  const { chainId } = await venueInfo();
  expect(await venueConnections(who)).toEqual([
    { address, chainId, connectedAt: expect.any(String), expiresAt, status: 'live', holdsKey: false },
  ]);
  // The venue's own record, as J-wallet-09 #2: connecting gave no agent key for the wallet, so only its own key can act.
  expect((await onVenue(address)).agents, 'the venue knows no agent key for the connected wallet').toEqual([]);
});

test(`${J} #5 exports the key, or adds a recovery method, with step-up: the provider's own flow after the passkey; INTAFACED never receives the key`, async ({
  page,
}) => {
  // One restart of svc-protocol for a provider that offers no export, and back.
  test.setTimeout(300_000);
  const { who, address, walletId, credential } = walletState();
  const phone = await device(page, [credential]);
  const toUs = [];
  const exports = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith('/api/')) toUs.push(`${r.url()} ${r.postData() ?? ''}`);
    if (path === '/__test-wallet-provider/client/export') exports.push(r.postDataJSON());
  });
  // The step-up: the provider exports nothing without a passkey assertion for this wallet.
  const bare = await page.request.post(`${PASSKEY_ORIGIN}/__test-wallet-provider/client/export`, { data: { walletId } });
  expect(bare.status(), 'an export with no passkey assertion is refused').toBeGreaterThanOrEqual(400);
  expect(await bare.text()).not.toMatch(/0x[0-9a-f]{64}/i);
  await openRoom(page, who);
  await expect(page.getByText(`These run at ${PROVIDER}, after your passkey. INTAFACED never receives your key.`)).toBeVisible();

  const signCount = async () => (await phone.held()).find((c) => c.credentialId === credential.credentialId).signCount;
  const before = await signCount();
  await page.getByRole('button', { name: 'Export my key', exact: true }).click();
  const shown = page.locator('[data-exported-key]');
  await expect(shown).toHaveText(/^0x[0-9a-f]{64}$/, { timeout: 20_000 });
  const key = await shown.textContent();
  // Opened by the person after one passkey assertion: the device signed once, and the one export the page sent the
  // provider carried that assertion, from the wallet's bound passkey.
  expect(await signCount()).toBe(before + 1);
  expect(exports).toHaveLength(1);
  // The device reports its credential id in base64, the page sends it in base64url.
  const bound = Buffer.from(credential.credentialId, 'base64').toString('base64url');
  expect(exports[0]).toMatchObject({ walletId, assertion: { credentialId: bound } });
  // The key the provider handed the person is this wallet's own.
  expect(privateKeyToAccount(key).address).toBe(address);
  await expect(page.getByText(`Your key, from ${PROVIDER}`)).toBeVisible();
  await page.getByRole('button', { name: 'Hide my key', exact: true }).click();
  await expect(shown).toHaveCount(0);

  // A recovery passkey, approved with the passkey already bound, at the provider.
  await page.getByRole('button', { name: 'Add a recovery passkey', exact: true }).click();
  await expect(page.getByText(`Recovery passkey added at ${PROVIDER}. Your wallet now answers to 2 passkeys.`)).toBeVisible({
    timeout: 20_000,
  });
  const recovery = (await phone.held()).find((c) => c.credentialId !== credential.credentialId);
  expect(recovery).toBeTruthy();
  run.write({ recovery });

  // Nothing the page sent to INTAFACED carried the key.
  expect(toUs.length).toBeGreaterThan(0);
  for (const sent of toUs) expect(sent.toLowerCase()).not.toContain(key.slice(2).toLowerCase());
  expect(JSON.stringify(await recorded(who))).not.toContain(key.slice(2));

  // Where the provider offers no export (the TEST provider standing in for one whose plan has none,
  // `LOCAL_STACK_PROTOCOL_EMBEDDED_WALLET=no-export`), the room says so and offers no button that would fail.
  const noExportPage = await page.context().newPage();
  try {
    await restartService('protocol', { LOCAL_STACK_PROTOCOL_EMBEDDED_WALLET: 'no-export' });
    await device(noExportPage, [credential]);
    await openRoom(noExportPage, who);
    await expect(panel(noExportPage).locator('[data-embedded-address]')).toHaveText(address, { timeout: 20_000 });
    await expect(noExportPage.getByText(`${PROVIDER} offers no key export.`, { exact: true })).toBeVisible();
    await expect(noExportPage.getByRole('button', { name: 'Export my key', exact: true })).toHaveCount(0);
    await expect(noExportPage.getByRole('button', { name: 'Add a recovery passkey', exact: true })).toBeVisible();
    expect((await recorded(who)).provider.capabilities).toEqual({ export: false, recovery: true });
  } finally {
    await noExportPage.close();
    await restartService('protocol', { LOCAL_STACK_PROTOCOL_EMBEDDED_WALLET: undefined });
  }
});

test(`${J} #6 signs in on a new device: the same wallet once the passkey or recovery check passes; a session that has not passed it cannot sign`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { who, address, walletId, credential, recovery } = walletState();
  if (!recovery) throw new Error(`${J} #5 added no recovery passkey, so there is no new device to sign in on`);
  await disconnectVenue(who, address);

  // A new device that holds no passkey for the wallet: it sees the same wallet, and cannot sign anything with it.
  const bare = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  try {
    const page = await bare.newPage();
    await device(page);
    await openRoom(page, who);
    await expect(panel(page).locator('[data-embedded-address]')).toHaveText(address);
    await page.getByRole('button', { name: 'Connect to the venue' }).click();
    await expect(page.getByText('Your passkey check did not pass', { exact: true })).toBeVisible({ timeout: 90_000 });
    expect(await venueConnections(who)).toEqual([]);
    // Nothing from that session reached the venue: no key given, no order, no deposit.
    expect(await onVenue(address), 'a session that has not passed the passkey check signs nothing at the venue').toEqual(NOTHING_ON_VENUE);
  } finally {
    await bare.close();
  }

  // A new device with the wallet's own passkey, synced to it: the same wallet signs once its passkey check passes.
  const synced = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  try {
    const page = await synced.newPage();
    await device(page, [credential]);
    await openRoom(page, who);
    await expect(panel(page).locator('[data-embedded-address]')).toHaveText(address);
    await expect(panel(page).locator('[data-embedded-wallet-id]')).toHaveText(walletId);
    await page.getByRole('button', { name: 'Connect to the venue' }).click();
    await expect(page.getByTestId('embedded-venue-expires')).toBeVisible({ timeout: 20_000 });
    expect((await venueConnections(who)).map((c) => [c.address, c.status])).toEqual([[address, 'live']]);
    expect((await onVenue(address)).agents).toEqual([]);
  } finally {
    await synced.close();
  }
  await disconnectVenue(who, address);

  // A new device with the recovery passkey: the same wallet signs.
  const fresh = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  try {
    const page = await fresh.newPage();
    await device(page, [recovery]);
    await openRoom(page, who);
    await expect(panel(page).locator('[data-embedded-address]')).toHaveText(address);
    await expect(panel(page).locator('[data-embedded-wallet-id]')).toHaveText(walletId);
    await page.getByRole('button', { name: 'Connect to the venue' }).click();
    await expect(page.getByTestId('embedded-venue-expires')).toBeVisible({ timeout: 20_000 });
    expect((await venueConnections(who)).map((c) => [c.address, c.status])).toEqual([[address, 'live']]);
    // The same wallet at the venue: still no key but its own.
    expect((await onVenue(address)).agents).toEqual([]);
  } finally {
    await fresh.close();
  }
});

test(`${J} #7 asks for a signature while the provider is down: refused with the provider named, in words; nothing signed or sent`, async ({
  page,
}) => {
  const { who, address, credential } = walletState();
  await device(page, [credential]);
  await disconnectVenue(who, address);
  // Every call the page makes to the provider, and how the stack answered it.
  const tried = [];
  page.on('response', (r) => {
    const p = new URL(r.url()).pathname;
    // The wallet room's chain reads (`/client/rpc`, read-only: J-wallet-24's deposit panel) ask the provider for no
    // signature and no passkey, so they are not counted; every other provider call is.
    if (p.startsWith('/__test-wallet-provider/') && p !== '/__test-wallet-provider/client/rpc') tried.push([p, r.status()]);
  });
  await openRoom(page, who);
  await expect(panel(page).locator('[data-embedded-address]')).toHaveText(address);
  // The provider goes down on the stack: its process (local-test-stack.mjs `test-wallet-provider`) is stopped, so the
  // page's provider path finds nothing behind it. It is started again after, with its state file (the wallet) kept.
  await stopService('test-wallet-provider');
  try {
    await page.getByRole('button', { name: 'Connect to the venue' }).click();
    await expect(page.getByText('Your wallet provider is not answering', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`${PROVIDER} is not answering. Nothing was made, signed or sent. Try again in a moment.`)).toBeVisible();
    await expect(page.getByText('wallet.embedded_provider_down')).toBeVisible();
  } finally {
    await startService('test-wallet-provider');
  }
  // It stopped at the provider's first call, which found the provider gone: nothing was signed, and no connection was
  // asked for.
  expect(tried).toEqual([['/__test-wallet-provider/client/challenge', 502]]);
  expect(await venueConnections(who)).toEqual([]);
  // The venue's own record: nothing was sent to it, no key given, no order, no deposit.
  expect(await onVenue(address), 'nothing signed or sent reaches the venue').toEqual(NOTHING_ON_VENUE);
});

/** The stack's TEST venue (local-test-stack.mjs PORTS['test-venue']). */
const TEST_VENUE = stackUrl('test-venue');
const VENUE_NAME = 'TEST venue simulator';

/** One call to the TEST venue: its JSON answer. Amounts travel as decimal strings. */
async function testVenue(path, body) {
  const res = await fetch(`${TEST_VENUE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(200);
  return json;
}
const venueAccount = async (owner) => ({ venueId: (await testVenue('/venue')).venue.id, owner: owner.toLowerCase(), subAccount: null });
/** The venue's own list of agents on the person's main account. */
const venueAgents = async (owner) => (await testVenue('/agents', { account: await venueAccount(owner) })).value;
const unnamedAgents = async (owner) => (await venueAgents(owner)).filter((a) => a.name === '').map((a) => a.address);

const sessionPanel = (page) => page.locator('[data-panel="trading-session"]');
/** Every wallet signature asked of the provider on this page: one passkey prompt each (the challenge is not one). */
function walletPrompts(page) {
  const asked = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    // A chain read (`/client/rpc`, read-only) asks for no passkey, so it is no prompt.
    if (p.startsWith('/__test-wallet-provider/client/') && !p.endsWith('/challenge') && !p.endsWith('/rpc')) asked.push(p);
  });
  return asked;
}
/** The session key this tab holds (the page keeps it in its own sessionStorage; never sent anywhere). */
const heldInTab = (page, userId) =>
  page.evaluate((k) => JSON.parse(sessionStorage.getItem(k) ?? 'null'), `intafaced.venue-session-key:${userId}`);

async function startSession(page) {
  await sessionPanel(page)
    .getByRole('button', { name: /^Start (trading session|a new session)$/ })
    .click();
  await expect(sessionPanel(page)).toHaveAttribute('data-session-state', 'on', { timeout: 30_000 });
  return (await sessionPanel(page).locator('[data-session-key]').textContent()).trim();
}

test(`${J} #8 starts a trading session and places two orders: one approval after the passkey for a fresh session key that trades and never withdraws, with its expiry; both orders signed by it with no second prompt; signing out or the expiry ends it, and the next session approves a new key, never an old one again`, async ({
  page,
  browser,
  stepPicture,
}) => {
  test.setTimeout(600_000);
  const s0 = walletState();
  const { who, address, credential } = s0;
  // Trading on the venue needs a verified account (the trade jurisdiction's tier); the journey's person verifies once.
  if (!s0.verified) {
    // verify() acts as the signed-in person, so this fresh page signs in first (it signs out again after).
    await signIn(page, who);
    await verify(page, who);
    run.write({ verified: true });
  }
  const client = await api(who);
  // The person's venue account starts with TEST USDC, by the TEST venue's deposit control (a labelled stand-in for
  // the deposit journey).
  const runId = process.env.JOURNEY_RUN_ID ?? 'local';
  await testVenue('/test/deposit', {
    account: await venueAccount(address),
    asset: 'USDC',
    amount: '1000',
    depositRef: `j-wallet-22:${runId}:${client.userId}:usdc`,
  });

  await device(page, [credential]);
  const prompts = walletPrompts(page);
  const prepares = [];
  const submits = [];
  const answers = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (p === '/api/v1/venue/prepare') prepares.push(r.postDataJSON());
    if (p === '/api/v1/venue/submit') submits.push(r.postDataJSON());
  });
  page.on('response', async (r) => {
    if (new URL(r.url()).pathname === '/api/v1/venue/submit') answers.push(await r.json().catch(() => null));
  });
  await openRoom(page, who);
  const panel = sessionPanel(page);
  await expect(panel.getByText(`Venue: ${VENUE_NAME}`)).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('[data-venue-test-label]')).toHaveText('TEST');
  // Our builder fee is approved once per account by the wallet (its own approval, before any order).
  const approveFee = panel.getByRole('button', { name: 'Approve the builder fee' });
  await expect(panel.locator('[data-builder-approved]').or(approveFee)).toBeVisible({ timeout: 20_000 });
  if (await approveFee.isVisible()) {
    await panel.getByRole('button', { name: 'Approve the builder fee' }).click();
    await expect(panel.locator('[data-builder-approved]')).toBeVisible({ timeout: 30_000 });
  }
  await expect(
    panel.getByText(
      `Start a session to trade on ${VENUE_NAME}. Your wallet signs one approval, after your passkey, for a new session key made on this device. The key can place and cancel orders and can never withdraw. It ends at its expiry, when you end the session, or when you sign out.`,
    ),
  ).toBeVisible();

  // ── One approval, after the passkey, for a fresh key with its expiry ────────────────────────────────────────────
  prompts.length = 0;
  const startedAt = Date.now();
  const first = await startSession(page);
  expect(prompts).toEqual(['/__test-wallet-provider/client/signtyped']);
  expect(first).toMatch(/^0x[0-9a-f]{40}$/);
  expect(first).not.toBe(address.toLowerCase());
  await expect(panel.getByText(`Session on. Your session key can trade on ${VENUE_NAME} and can never withdraw.`)).toBeVisible();
  const expiresAt = Date.parse(await panel.getByTestId('session-expires').getAttribute('datetime'));
  expect(expiresAt).toBeGreaterThan(startedAt);
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 8 * 60 * 60 * 1000);
  // The venue's own record: the key is approved on the person's account, unnamed, with that expiry.
  const listed = (await venueAgents(address)).find((a) => a.address === first);
  expect(listed).toEqual({ address: first, name: '', validUntil: new Date(expiresAt).toISOString() });
  // INTAFACED holds the address and the venue's answer, never the key.
  const held = await heldInTab(page, client.userId);
  expect(held.address).toBe(first);
  const record = await client.get(`/api/v1/venue/session?owner=${address.toLowerCase()}`);
  expect(record.status).toBe(200);
  expect(JSON.stringify(record.body).toLowerCase()).not.toContain(held.privateKey.slice(2).toLowerCase());

  // ── Two orders, signed by the session key, with no second prompt ────────────────────────────────────────────────
  const ordersBefore = (await testVenue('/open-orders', { account: await venueAccount(address) })).value.length;
  // A resting TEST buy inside the TEST venue's published price band (95% around its BTC-USDC book's middle, 60000):
  // the venue refuses a limit price outside it (`price_outside_venue_band`), so the ticket names its market and price.
  await panel.getByLabel(/^Market\b/).selectOption('BTC-USDC');
  await panel.getByLabel('Limit price', { exact: true }).fill('59000');
  for (const n of [1, 2]) {
    await panel.getByRole('button', { name: 'Place order' }).click();
    await expect(panel.locator('[data-session-orders] li')).toHaveCount(n, { timeout: 20_000 });
  }
  await expect(panel.getByText(`Order on ${VENUE_NAME}: open. Signed by your session key, with no passkey.`)).toBeVisible();
  await stepPicture(page);
  expect(prompts).toHaveLength(1);
  const orderPrepares = prepares.filter((b) => b.intent?.kind === 'place_order');
  expect(orderPrepares.map((b) => b.signer)).toEqual([
    { role: 'agent', address: first },
    { role: 'agent', address: first },
  ]);
  const orderKeys = orderPrepares.map((b) => b.intent.clientOrderKey);
  expect(new Set(orderKeys).size).toBe(2);
  for (const key of orderKeys) expect(submits.find((b) => b.actionKey === key)?.signature.signedBy).toBe(first);
  // The venue verified each signature against the session key and holds both orders.
  expect((await testVenue('/open-orders', { account: await venueAccount(address) })).value.length).toBe(ordersBefore + 2);

  // ── The session key can never withdraw ─────────────────────────────────────────────────────────────────────────
  const usdcBefore = (await testVenue('/balances', { account: await venueAccount(address) })).value.find((b) => b.asset === 'USDC');
  const withdraw = await client.post('/api/v1/venue/prepare', {
    owner: address.toLowerCase(),
    signer: { role: 'agent', address: first },
    intent: {
      kind: 'withdraw',
      asset: 'USDC',
      amount: '10',
      destination: address.toLowerCase(),
      withdrawalKey: `withdraw:${client.userId}:j-wallet-22-8`,
    },
  });
  expect(withdraw.status).toBe(422);
  expect(withdraw.body.intafacedCode).toBe('trade.venue.agent_not_permitted');
  expect((await testVenue('/balances', { account: await venueAccount(address) })).value.find((b) => b.asset === 'USDC')).toEqual(
    usdcBefore,
  );

  // ── The expiry ends it: an order signed by the expired key is refused, and a new session is offered ─────────────
  expect((await testVenue('/test/expire-agent', { account: await venueAccount(address), agentAddress: first })).expired).toBe(true);
  await panel.getByRole('button', { name: 'Place order' }).click();
  await expect(
    panel.getByText('Your session key can no longer trade. Start a new session to keep trading. (trade.venue.signer_not_authorised)'),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(panel.getByText('Your trading session ended at its expiry. Start a new session to keep trading.')).toBeVisible();
  expect((await testVenue('/open-orders', { account: await venueAccount(address) })).value.length).toBe(ordersBefore + 2);
  expect(prompts).toHaveLength(1);

  // ── The next session approves a new key. Its answer is lost on the way back: read back from the venue's agents ──
  await testVenue('/test/lose-answers', { account: await venueAccount(address), count: 1 });
  answers.length = 0;
  const second = await startSession(page);
  expect(second).not.toBe(first);
  // The approval's answer came back not definite; the room read the session back from the venue's agents and shows
  // it on, with no second prompt.
  expect(answers.at(-1)?.outcome).toEqual({ definite: false, reason: 'timeout' });
  expect(prompts).toHaveLength(2);
  expect(await unnamedAgents(address)).toEqual([second]);

  // ── A second device's session replaces the first device's key; the first device says so in words ────────────────
  const other = await browser.newContext({ baseURL: PASSKEY_ORIGIN });
  try {
    const b = await other.newPage();
    await device(b, [credential]);
    const bPrompts = walletPrompts(b);
    await openRoom(b, who);
    await expect(sessionPanel(b).getByText(`Venue: ${VENUE_NAME}`)).toBeVisible({ timeout: 20_000 });
    const third = await startSession(b);
    expect(bPrompts).toEqual(['/__test-wallet-provider/client/signtyped']);
    expect([first, second]).not.toContain(third);
    expect(await unnamedAgents(address)).toEqual([third]);
    await page.reload();
    await expect(
      sessionPanel(page).getByText(
        'Your trading session was replaced by one you started on another device. The key on this device no longer trades. Start a new session to trade here.',
      ),
    ).toBeVisible({ timeout: 20_000 });
    await expect(sessionPanel(page).getByRole('button', { name: 'Start a new session' })).toBeVisible();

    // ── Ending the session revokes the key on the venue; an order signed by it is refused ─────────────────────────
    const thirdKey = await heldInTab(b, client.userId);
    expect(thirdKey.address).toBe(third);
    await sessionPanel(b).getByRole('button', { name: 'End trading session' }).click();
    await expect(
      sessionPanel(b).getByText('You ended your trading session. Its key is revoked on the venue and is never approved again.'),
    ).toBeVisible({ timeout: 30_000 });
    expect(bPrompts).toHaveLength(2);
    expect(await unnamedAgents(address)).toEqual([]);
    expect(await heldInTab(b, client.userId)).toBeNull();
    const after = await client.post('/api/v1/venue/prepare', {
      owner: address.toLowerCase(),
      signer: { role: 'agent', address: third },
      intent: {
        kind: 'place_order',
        symbol: 'BTC-USDC',
        side: 'buy',
        type: 'limit',
        amount: '0.001',
        price: '59000',
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: `order:${client.userId}:j-wallet-22-8:revoked`,
        builderFee: null,
      },
    });
    expect(after.status).toBe(422);
    expect(after.body.intafacedCode).toBe('trade.venue.signer_not_authorised');

    // ── Signing out ends it for the device: the next sign-in has no session, and starts a new key ─────────────────
    const fourth = await startSession(b);
    expect(bPrompts).toHaveLength(3);
    await signOutBrowser(other);
    await openRoom(b, who);
    await expect(sessionPanel(b).getByRole('button', { name: 'Start trading session' })).toBeVisible({ timeout: 20_000 });
    await expect(sessionPanel(b).locator('[data-session-key]')).toHaveCount(0);
    // The key the tab kept from before the sign-out is dropped, never used again.
    await expect.poll(() => heldInTab(b, client.userId)).toBeNull();
    const fifth = await startSession(b);
    expect(bPrompts).toHaveLength(4);
    expect(await unnamedAgents(address)).toEqual([fifth]);
    const used = [first, second, third, fourth, fifth];
    expect(new Set(used).size).toBe(5);

    // ── Never an old key again: each one is refused, and the venue's list never shows it again ────────────────────
    for (const old of [first, second, third, fourth]) {
      const again = await client.post('/api/v1/venue/session/start', { owner: address.toLowerCase(), agentAddress: old });
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      expect(again.body.intafacedCode).toBe('trade.venue_session_key_reused');
    }
    expect(await unnamedAgents(address)).toEqual([fifth]);
    await sessionPanel(b).getByRole('button', { name: 'End trading session' }).click();
    await expect(
      sessionPanel(b).getByText('You ended your trading session. Its key is revoked on the venue and is never approved again.'),
    ).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await other.close();
  }
});

/** The name the page announces the person's TEST wallet under (EIP-6963), for every room that offers a browser wallet. */
const ANNOUNCED = 'INTAFACED wallet (TEST)';

test(`${J} outside: the wallet is a browser wallet for the rest of the app: Money's wallet panel offers Connect ${ANNOUNCED} and connects it, and the futures desk places and cancels an order it signs after the passkey`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const s0 = walletState();
  const { who, address, credential } = s0;
  if (!s0.verified) {
    await signIn(page, who);
    await verify(page, who);
    run.write({ verified: true });
  }
  const owner = address.toLowerCase();
  await device(page, [credential]);
  const prompts = walletPrompts(page);
  const submits = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/v1/venue/submit') submits.push(r.postDataJSON());
  });
  await signIn(page, who);

  // Money, through the menu: its wallet panel offers the person's own wallet by name, and connecting it asks no passkey.
  await page.getByRole('link', { name: 'Money', exact: true }).first().click();
  const wallet = page.getByTestId('venue-wallet').first();
  const connect = wallet.getByRole('button', { name: `Connect ${ANNOUNCED}`, exact: true });
  await expect(connect).toBeVisible({ timeout: 30_000 });
  await expect(wallet).not.toContainText('No wallet found in this browser');
  await connect.click();
  await expect(wallet.getByTestId('venue-wallet-address')).toHaveText(owner);
  await stepPicture(page);
  expect(prompts).toEqual([]);

  // The futures desk finds it connected, with no second Connect, and its order is signed by the wallet after the passkey.
  await page.goto('/trade/futures');
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('venue-wallet-address').first()).toHaveText(owner, { timeout: 20_000 });
  const before = (await testVenue('/open-orders', { account: await venueAccount(address) })).value.length;
  const ticket = page.getByTestId('venue-ticket');
  await page
    .getByRole('button', { name: /^BTC-PERP · / })
    .first()
    .click();
  await ticket.getByRole('button', { name: 'Long', exact: true }).click();
  await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
  await ticket.getByRole('textbox', { name: 'Size (BTC)', exact: true }).fill('0.001');
  await ticket.getByRole('textbox', { name: 'Price', exact: true }).fill('59000');
  const margin = ticket.getByRole('combobox', { name: 'Margin asset', exact: true });
  if (await margin.isVisible()) await margin.selectOption('USDC');
  await ticket.getByRole('button', { name: 'Review long', exact: true }).click();
  await page
    .getByTestId('venue-review')
    .getByRole('button', { name: /^(Open|Place) long/ })
    .click();
  await page
    .getByRole('dialog', { name: 'Check before you sign', exact: true })
    .getByRole('button', { name: 'Continue in wallet', exact: true })
    .click();
  // The person's only BTC-PERP order (#8's two rest on the spot market).
  const rows = page.getByTestId('venue-open-orders').locator('tbody tr').filter({ hasText: 'BTC-PERP' });
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  expect(prompts).toEqual(['/__test-wallet-provider/client/signtyped']);
  expect(submits.at(-1)?.signature.signedBy).toBe(owner);
  expect((await testVenue('/open-orders', { account: await venueAccount(address) })).value.length).toBe(before + 1);

  // Cancel: one more signature by the wallet, after the passkey, and the venue holds the order no more.
  await rows.first().getByRole('button', { name: 'Cancel', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Check before you sign', exact: true })
    .getByRole('button', { name: 'Continue in wallet', exact: true })
    .click();
  await expect(rows).toHaveCount(0, { timeout: 30_000 });
  expect(prompts).toEqual(['/__test-wallet-provider/client/signtyped', '/__test-wallet-provider/client/signtyped']);
  expect((await testVenue('/open-orders', { account: await venueAccount(address) })).value.length).toBe(before);
});
