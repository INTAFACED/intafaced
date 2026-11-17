import { privateKeyToAccount } from 'viem/accounts';
import { expect } from './journey.mjs';
import { api } from './stack.mjs';

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
