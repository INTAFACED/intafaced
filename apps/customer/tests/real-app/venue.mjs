import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { expect } from './journey.mjs';
import { VENUE_DOOR_SETTING, markVenueDoor, restartWithSetting, toUnits } from './stack.mjs';
import { signIn } from './desk.mjs';
import { installTestWallet } from './test-wallet.mjs';

// What the venue journeys (J-cex-spot-01-venue, J-derivatives-01-venue) share: svc-trade's user-venue door switched on
// for one file and off after it, the stack's LOCAL TEST venue simulator (tooling/scripts/local-test-venue.mjs) reached
// on loopback for its TEST controls and as the other TEST trader, and the desk opened with the browser TEST wallet.
// Every figure the TEST venue reports is TEST.

/** The stack's TEST venue (local-test-stack.mjs PORTS['test-venue']). */
export const TEST_VENUE = 'http://127.0.0.1:14560';

/**
 * Turns the door on for this file and always off after it, so every other file in the shard sees the door off. Trade's
 * restart with the setting on also starts the TEST venue (local-test-stack.mjs `cmdStart`); off, the venue may keep
 * running, and trade no longer points at it. A worker that dies before afterAll leaves a mark; the next file's first
 * sign-in switches the door off (stack.mjs `venueDoorLeftOnGuard`).
 */
export function venueForThisFile(test) {
  test.beforeAll(() => {
    test.setTimeout(240_000);
    markVenueDoor(true);
    restartWithSetting('trade', VENUE_DOOR_SETTING, 'on');
  });
  test.afterAll(() => {
    test.setTimeout(240_000);
    restartWithSetting('trade', VENUE_DOOR_SETTING, 'off');
    markVenueDoor(false);
  });
}

/** One call to the TEST venue: its JSON answer and status. Amounts travel as decimal strings. */
export async function testVenue(path, body) {
  const res = await fetch(`${TEST_VENUE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** The venue's id and the chain its signatures name. */
export async function venueInfo() {
  const { status, body } = await testVenue('/venue');
  expect(status, JSON.stringify(body)).toBe(200);
  expect(body.label).toBe('TEST');
  return { id: body.venue.id, chainId: body.chainId, displayName: body.venue.displayName };
}

export const venueAccount = async (owner) => ({ venueId: (await venueInfo()).id, owner: owner.toLowerCase(), subAccount: null });

/** The venue's own record for `owner`, read directly (what the desk must equal). */
export async function venueRecord(owner, path, extra = {}) {
  const { status, body } = await testVenue(path, { account: await venueAccount(owner), ...extra });
  expect(status, JSON.stringify(body)).toBe(200);
  return body;
}

/**
 * TEST funding of a venue account by its TEST deposit control, keyed by a chain-transfer-shaped reference
 * (`<chainId>:<txHash>:<logIndex>`), so a replay of the same reference credits nothing.
 */
export async function testDeposit(owner, asset, amount, depositRef) {
  const { status, body } = await testVenue('/test/deposit', { account: await venueAccount(owner), asset, amount, depositRef });
  expect(status, JSON.stringify(body)).toBe(200);
  return body.credited;
}

/** A TEST key for another TEST trader, derived from a public name: it holds nothing outside the TEST venue's memory. */
export const otherTraderKey = (name) => privateKeyToAccount(keccak256(toHex(`intafaced TEST venue journey trader ${name}`)));

/** The other TEST trader signs and sends one action on the TEST venue directly, as an outside participant would. */
export async function otherTraderRun(name, intent) {
  const key = otherTraderKey(name);
  const owner = key.address.toLowerCase();
  const account = await venueAccount(owner);
  const signer = { role: 'owner', address: owner };
  const prepared = await testVenue('/prepare', { account, signer, intent });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const typed = prepared.body.typedData;
  const signature = await key.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  return sent.body;
}

/** The plain-words sheet that comes before every wallet prompt, answered: the wallet is then asked. */
export async function continueInWallet(page) {
  const sheet = page.getByRole('dialog', { name: 'Check before you sign' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(sheet).toHaveCount(0);
}

/**
 * Signs in, installs the browser TEST wallet with this run's key on the venue's chain, opens `path` in venue mode and
 * connects the wallet. Returns the wallet (its signature requests are counted).
 */
export async function openVenueDesk(page, who, path, privateKey) {
  const { chainId } = await venueInfo();
  const wallet = await installTestWallet(page, { chainId, privateKey });
  await signIn(page, who);
  await page.goto(path);
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Connect TEST Wallet' }).click();
  await expect(page.getByTestId('venue-wallet-address')).toHaveText(wallet.address);
  return wallet;
}

/** A balance row of the desk's venue balances: free, used and total as the desk shows them. */
export async function shownBalance(page, asset) {
  const row = page.getByTestId('venue-balances').locator(`tr[data-asset="${asset}"]`);
  await expect(row).toBeVisible();
  const cell = async (name) => (await row.locator(`[data-cell="${name}"]`).innerText()).replace(/,/g, '');
  return { free: await cell('free'), used: await cell('used'), total: await cell('total') };
}

/** A decimal string's exact value, so "1000" and "1000.0" compare equal. */
export function sameDecimal(a, b) {
  const units = (x) => toUnits(String(x).replace(/,/g, '').replace('−', '-').trim());
  return units(a) === units(b);
}

/** The venue's balance of `asset` for `owner`, from its own record. */
export async function venueBalance(owner, asset) {
  const body = await venueRecord(owner, '/balances');
  return body.value.find((b) => b.asset === asset) ?? { asset, free: '0', locked: '0', total: '0' };
}
