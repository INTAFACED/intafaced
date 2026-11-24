import { privateKeyToAccount } from 'viem/accounts';
import { expect } from './journey.mjs';
import { api } from './stack.mjs';
import { signIn } from './desk.mjs';
import { installTestWallet } from './test-wallet.mjs';
import { connectWhenAsked } from './dex.mjs';
import { TEST_VENUE, testVenueAt } from './venue.mjs';

// What the venue journeys watch of our own door and ledger: every venue action the page posts to the door, and the
// person's ledger read before and after, to show a venue step posts nothing (the launch money model: the venue holds
// the funds). A file that already holds its own copy keeps it until it is rewritten for another reason.

/** Every door call this page makes, by its path (`prepare`, `submit`, `preview`). */
export function doorCalls(page) {
  const calls = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === 'POST' && path.startsWith('/api/v1/venue/'))
      calls.push({ path: path.slice('/api/v1/venue/'.length), body: r.postDataJSON() });
  });
  return { all: calls, of: (name) => calls.filter((c) => c.path === name) };
}

/** The person's ledger balances, as our ledger answers them. */
export const ledgerView = async (who) => (await api(who)).balances();

/** The ledger posted nothing since `s.ledger` was read for `s.account`. */
export async function ledgerUntouched(s) {
  expect(await ledgerView(s.account)).toEqual(s.ledger);
}

/**
 * The run's person, read from its journey state: their account, wallet key and the owner address it signs as. `first`
 * names the step that makes them, for the error when it made no one.
 */
export function walletOwner(run, first) {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${first} made no account and wallet, so this step has no one to act as`);
  const key = privateKeyToAccount(s.walletKey);
  return { ...s, key, owner: key.address.toLowerCase() };
}

// ── the TEST venue read and signed on directly, and a venue room opened as the person ──

/** One call to the stack's TEST venue that must answer 200; its body. */
export async function venueAt(path, body) {
  return venueAtBase(TEST_VENUE, path, body);
}

/** As `venueAt`, on either TEST venue by its base URL (TEST_VENUE_B for a journey across both). */
export async function venueAtBase(base, path, body) {
  const { status, body: out } = await testVenueAt(base, path, body);
  expect(status, `${path}: ${JSON.stringify(out).slice(0, 300)}`).toBe(200);
  return out;
}

/** The TEST venue's id, name and chain, as it says them (it labels itself TEST). */
export async function venueNow() {
  const v = await venueAt('/venue');
  expect(v.label).toBe('TEST');
  return { id: v.venue.id, name: v.venue.displayName, chainId: v.chainId };
}

/** One action signed by `key` as the owner and sent to the TEST venue itself (setup, never a step's own action). */
export async function signedOnVenue(venue, key, intent) {
  const owner = key.address.toLowerCase();
  const account = { venueId: venue.id, owner, subAccount: null };
  const prepared = await venueAt('/prepare', { account, signer: { role: 'owner', address: owner }, intent });
  const t = prepared.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await venueAt('/submit', { prepared, signature: { digest: prepared.digest, signature, signedBy: owner } });
  expect(sent, JSON.stringify(sent).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  return sent;
}

/**
 * Signs in as the run's person, installs the TEST wallet with their key on the venue's chain, opens `room` and connects;
 * waits for the positions table. Returns the wallet (its signature requests are counted).
 */
export async function openVenueRoom(page, s, room) {
  const { chainId } = await venueNow();
  const wallet = await installTestWallet(page, { chainId, privateKey: s.walletKey });
  await signIn(page, s.account);
  await page.goto(room);
  const address = page.getByTestId('venue-wallet-address');
  await connectWhenAsked(page, address);
  await expect(address).toHaveText(s.owner);
  await expect(page.getByTestId('positions-all')).toBeVisible({ timeout: 30_000 });
  return wallet;
}
