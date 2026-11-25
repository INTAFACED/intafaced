/**
 * THE DEMO WORLD'S CHAIN: the node the seeded trader's browser wallet reads through, as a person's own wallet reads its
 * network for them on the beta. `pnpm shots` serves it on loopback and hands it to the TEST wallet as its node
 * (test-wallet.mjs `rpcUrl`), so the rooms that read the wallet at one block (Home, Assets) draw its balance instead of
 * "couldn't be read". One block, at the recording's time; the wallet holds a little TEST gas and nothing else. Every
 * figure is TEST and invented; nothing here reaches a network. A read it does not hold is refused as a node refuses it,
 * so a room still says what it could not read.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { demoWalletKey } from './seed.mjs';

/** The demo wallet's TEST gas, in wei: 0.42 TEST ETH. */
const DEMO_GAS_WEI = 420_000_000_000_000_000n;
/** The one block the chain has, numbered as a test network's would be. */
const DEMO_BLOCK = 98_765_432n;

const hex = (v) => `0x${BigInt(v).toString(16)}`;
const refused = (code, message) => ({ error: { code, message } });

/** The demo chain's answer to one JSON-RPC call: `{ result }` or `{ error }`. */
export function demoChain(method, params = [], { chainId, now }) {
  const owner = privateKeyToAccount(demoWalletKey()).address.toLowerCase();
  const block = {
    number: hex(DEMO_BLOCK),
    timestamp: hex(Math.floor(now / 1000)),
    hash: `0x${'d'.repeat(64)}`,
    parentHash: `0x${'c'.repeat(64)}`,
    transactions: [],
  };
  switch (method) {
    case 'eth_chainId':
      return { result: hex(chainId) };
    case 'eth_blockNumber':
      return { result: block.number };
    case 'eth_getBlockByNumber':
      return { result: block };
    case 'eth_getBalance':
      return { result: hex(String(params[0]).toLowerCase() === owner ? DEMO_GAS_WEI : 0n) };
    case 'eth_gasPrice':
      return { result: hex(100_000_000n) };
    case 'eth_call':
      // The wallet holds no token on this chain: a token read is refused, so no token balance is invented.
      return refused(-32000, 'execution reverted');
    default:
      return refused(-32601, `The demo chain does not answer ${method}`);
  }
}
