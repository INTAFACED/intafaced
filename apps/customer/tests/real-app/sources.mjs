// Each place that holds a person's money on the launch model, read the way a journey checks a page against it: svc-ops'
// published prices, the TEST chain's node and indexer, the TEST partner bank's lines, and the TEST venue signed with the
// person's own wallet key. None of these reads go through the page; a step compares the page with them.
import { privateKeyToAccount } from 'viem/accounts';
import { expect } from './journey.mjs';
import { EDGE, ORIGIN, api } from './stack.mjs';
import { signIn } from './desk.mjs';
import { CHAIN_ID, testChain } from './dex.mjs';
import { installTestWallet } from './test-wallet.mjs';
import { testVenue, venueAccount } from './venue.mjs';

/** A file's TEST person and wallet from its run state, with the wallet's address; throws when its setup made none. */
export function walletPerson(run, journey) {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${journey}'s TEST setup made no account and wallet, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

/** Signs `who` in with their TEST browser wallet installed on the TEST chain, so the page's reads go to its node. */
export async function signInWithWallet(page, { account: who, walletKey }) {
  await installTestWallet(page, { chainId: CHAIN_ID, privateKey: walletKey, rpcUrl: testChain().gateUrl });
  await signIn(page, who);
}

/** svc-ops' published prices, as anyone reads them (the read is public). */
export async function pricesPublished() {
  const res = await fetch(`${EDGE}/api/ops/trpc/valuation.prices`, { headers: { origin: ORIGIN } });
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

/** One read from the TEST chain's node itself. */
export async function testChainRead(method, params) {
  const res = await fetch(testChain().gateUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** The wallet's own record: its transactions as the TEST chain's indexer has them. */
export async function indexedTransfers(who, owner) {
  const session = await api(who);
  const input = encodeURIComponent(JSON.stringify({ chainId: CHAIN_ID, address: owner }));
  const res = await session.get(`/api/indexer/trpc/explorer.address.txs?input=${input}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.rows;
}

/** The partner's own record of its moves for this person: the bank's lines that carry the partner's name. */
export async function partnerLines(who) {
  const session = await api(who);
  const input = encodeURIComponent(JSON.stringify({ limit: 200 }));
  const res = await session.get(`/api/bank/trpc/activity.list?input=${input}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.items.filter((item) => item.heldAt);
}

/** The person signs one action on the TEST venue with their own wallet key, as their wallet would; it must be accepted. */
export async function signedOnVenue(walletKey, intent) {
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  const prepared = await testVenue('/prepare', { account: await venueAccount(owner), signer: { role: 'owner', address: owner }, intent });
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
  expect(sent.body.definite && sent.body.accepted, JSON.stringify(sent.body)).toBe(true);
  return sent.body;
}
