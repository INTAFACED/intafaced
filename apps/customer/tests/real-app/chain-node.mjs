import { expect } from './journey.mjs';
import { TOKEN_USD, testChain } from './dex.mjs';
import { GATE_URL } from '../../../../tooling/scripts/local-test-facts.mjs';

// What the journeys read and steer on the stack's TEST chain node itself, never through INTAFACED.

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** One call to the stack's TEST chain node. */
export async function chainRpc(method, params = []) {
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
export async function withMiningPaused(fn) {
  const interval = await chainRpc('anvil_getIntervalMining');
  await chainRpc('evm_setIntervalMining', [0]);
  try {
    return await fn();
  } finally {
    await chainRpc('evm_setIntervalMining', [interval]);
  }
}

/** Mines `n` empty blocks on the stack's TEST chain (`evm_mine`, the TEST chain's own control). */
export async function mineBlocks(n) {
  for (let i = 0; i < n; i += 1) {
    const res = await fetch(testChain().gateUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`evm_mine: ${JSON.stringify(body.error)}`);
  }
}

/** TEST USD (base units) `address` holds on the TEST chain, read from the node itself. */
export async function chainUsd(address) {
  const res = await fetch(GATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: TOKEN_USD.address, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest'],
    }),
  });
  return BigInt((await res.json()).result);
}

/** The TEST chain's own receipt of `txHash`: the token transfers it made, as { token, to, value } (read from the chain). */
export async function chainTransfers(txHash) {
  const res = await fetch(GATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
  });
  const receipt = (await res.json()).result;
  expect(receipt, `the TEST chain has a receipt for ${txHash}`).toBeTruthy();
  expect(receipt.status).toBe('0x1');
  return receipt.logs
    .filter((l) => l.topics[0] === TRANSFER_TOPIC)
    .map((l) => ({ token: l.address.toLowerCase(), to: `0x${l.topics[2].slice(26)}`, value: BigInt(l.data) }));
}

/** A decimal TEST USD amount in the token's base units (6 decimals), exactly. */
export const tokenUsdUnits = (amount) => {
  const [w, f = ''] = amount.split('.');
  return BigInt(w + f.padEnd(TOKEN_USD.decimals, '0'));
};
