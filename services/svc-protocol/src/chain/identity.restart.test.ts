import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AccountRegistry, bindingMessage, MemoryAccountStore } from '../accounts/registry.js';
import { badgeClaimMessage, badgeEligibility, claimBadge, type BadgeDeps } from '../nft/founding-badge.js';
import { memBadgeStore } from '../nft/founding-badge.test-store.js';
import { ProtocolChain } from './client.js';
import { chainIdentityReader } from './identity.js';

/**
 * A TEST chain started again, end to end over HTTP: this file serves a node on a port, stops it, and serves a new chain
 * on the same port and chain id with a new block 0, as anvil does on every start (its genesis carries its start time).
 * The real `ProtocolChain` reads the new genesis through viem, and what was read from the first chain (a badge mint, a
 * deployed account) reads as absent on the second. It never touches a shared chain: a restart there would break every
 * other test on it.
 */
const CHAIN_ID = 31337;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const OWNER = privateKeyToAccount(`0x${'55'.repeat(32)}`);
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const Z32 = `0x${'0'.repeat(64)}`;

/** Block 0 of a chain whose genesis hash is `hash`: the fields viem's block formatter reads. */
const genesisBlock = (hash: Hex) => ({
  number: '0x0',
  hash,
  parentHash: Z32,
  timestamp: '0x1',
  nonce: '0x0000000000000000',
  difficulty: '0x0',
  totalDifficulty: '0x0',
  gasLimit: '0x1c9c380',
  gasUsed: '0x0',
  miner: ZERO,
  extraData: '0x',
  logsBloom: `0x${'0'.repeat(512)}`,
  transactionsRoot: Z32,
  stateRoot: Z32,
  receiptsRoot: Z32,
  sha3Uncles: Z32,
  mixHash: Z32,
  size: '0x200',
  baseFeePerGas: '0x1',
  transactions: [],
  uncles: [],
});

let running: Server | null = null;
/** Serves a chain with this genesis on `port` (0 picks one); returns the port. */
async function startChain(genesis: Hex, port = 0): Promise<number> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const answer = (call: { id: number; method: string }) => ({
        jsonrpc: '2.0',
        id: call.id,
        result:
          call.method === 'eth_chainId'
            ? `0x${CHAIN_ID.toString(16)}`
            : call.method === 'eth_blockNumber'
              ? '0x0'
              : call.method === 'eth_getBlockByNumber'
                ? genesisBlock(genesis)
                : null,
      });
      const body = JSON.parse(raw) as { id: number; method: string } | { id: number; method: string }[];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  running = server;
  return (server.address() as AddressInfo).port;
}
async function stopChain(): Promise<void> {
  const server = running;
  running = null;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
}
afterEach(stopChain);

describe('a TEST chain started again (over HTTP)', () => {
  it('reads a new genesis; a badge minted and an account deployed on the old chain read as absent on the new one', async () => {
    const port = await startChain(`0x${'a1'.repeat(32)}`);
    const chain = new ProtocolChain({
      chainId: CHAIN_ID,
      rpcUrl: `http://127.0.0.1:${port}`,
      entryPoint: ZERO,
      factory: ZERO,
      implementation: ZERO,
    });
    // No reuse window: each call reads block 0, so the restart is seen at once.
    const identity = chainIdentityReader(chain, 0);

    const store = memBadgeStore([ACCOUNT]);
    const mints: Address[] = [];
    const deps: BadgeDeps = {
      store,
      minter: { signerFor: () => ({ mint: async (to) => (mints.push(to), `0x${String(mints.length).padStart(64, '0')}` as Hex) }) },
      window: { opensAt: new Date(Date.now() - 60_000), closesAt: new Date(Date.now() + 60_000) },
      now: () => new Date(),
    };
    const accounts = new AccountRegistry(new MemoryAccountStore(), { chainId: CHAIN_ID, factory: ZERO, implementation: ZERO }, identity);
    const address = accounts.predict(OWNER.address);
    expect(isAddress(address)).toBe(true);
    const claim = async () =>
      claimBadge(
        deps,
        ACCOUNT,
        { address, owner: OWNER.address },
        { chainId: CHAIN_ID, identity, mainnet: false, restartable: true },
        await OWNER.signMessage({ message: badgeClaimMessage({ accountId: ACCOUNT, chainId: CHAIN_ID, address }) }),
      );

    const first = await identity();
    expect(first).toMatchObject({ chainId: CHAIN_ID });
    expect(first.genesisHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await claim()).genesisHash).toBe(first.genesisHash);
    await accounts.claim({
      userId: ACCOUNT,
      owner: OWNER.address,
      address,
      signature: await OWNER.signMessage({ message: bindingMessage({ userId: ACCOUNT, chainId: CHAIN_ID, address }) }),
      deployed: true,
    });
    expect((await accounts.accountsOf(ACCOUNT, 1))[0]?.deployed).toBe(true);

    await stopChain();
    // While the chain is down the identity refuses rather than answer with the old genesis.
    await expect(identity()).rejects.toThrow();
    await startChain(`0x${'b2'.repeat(32)}`, port);
    const second = await identity();
    expect(second.chainId).toBe(CHAIN_ID);
    expect(second.genesisHash).toBe(`0x${'b2'.repeat(32)}`);
    expect(second.genesisHash).not.toBe(first.genesisHash);

    expect(await badgeEligibility(deps, ACCOUNT, { chainId: CHAIN_ID, identity, mainnet: false, restartable: true })).toMatchObject({
      claimed: false,
      txHash: null,
    });
    expect((await claim()).genesisHash).toBe(second.genesisHash);
    expect(mints).toHaveLength(2);
    expect((await accounts.accountsOf(ACCOUNT, 1))[0]?.deployed).toBe(false);
  });
});
