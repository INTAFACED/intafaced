import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AccountRegistry, bindingMessage, MemoryAccountStore } from '../accounts/registry.js';
import { badgeClaimMessage, badgeEligibility, claimBadge, type BadgeDeps } from '../nft/founding-badge.js';
import { memBadgeStore } from '../nft/founding-badge.test-store.js';
import { ProtocolChain } from './client.js';
import { chainIdentityReader } from './identity.js';

/**
 * A TEST chain started again, for real: this file starts its own anvil, stops it, and starts it again on the same port
 * and chain id. The real `ProtocolChain` reads the new genesis, and what was read from the first chain (a badge mint, a
 * deployed account) reads as absent on the second.
 *
 * It needs the anvil binary (`LOCAL_STACK_ANVIL_BIN`, or `anvil` on PATH) and skips without it, as CI runs anvil in a
 * container it cannot restart. It never touches a shared chain: a restart there would break every other test on it.
 */
const ANVIL = process.env.LOCAL_STACK_ANVIL_BIN ?? 'anvil';
const hasAnvil = spawnSync(ANVIL, ['--version'], { stdio: 'ignore' }).status === 0;
const CHAIN_ID = 31337;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const OWNER = privateKeyToAccount(`0x${'55'.repeat(32)}`);
const ACCOUNT = '33333333-3333-4333-8333-333333333333';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

let running: ChildProcess | null = null;
async function startAnvil(port: number, chain: ProtocolChain): Promise<void> {
  running = spawn(ANVIL, ['--port', String(port), '--chain-id', String(CHAIN_ID), '--silent'], { stdio: 'ignore' });
  const child = running!;
  for (let i = 0; i < 100; i++) {
    // An anvil that could not start (its port taken) has exited: fail here rather than read whatever answers on the port.
    if (child.exitCode !== null) throw new Error(`anvil exited with ${child.exitCode} before it answered on port ${port}`);
    try {
      await chain.headBlock();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('anvil did not answer');
}
async function stopAnvil(): Promise<void> {
  const child = running;
  running = null;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}
afterEach(stopAnvil);

describe.skipIf(!hasAnvil)('a TEST chain started again (real anvil)', () => {
  it('reads a new genesis; a badge minted and an account deployed on the old chain read as absent on the new one', async () => {
    const port = await freePort();
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
        { chainId: CHAIN_ID, identity, mainnet: false },
        await OWNER.signMessage({ message: badgeClaimMessage({ accountId: ACCOUNT, chainId: CHAIN_ID, address }) }),
      );

    await startAnvil(port, chain);
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

    await stopAnvil();
    // Anvil's genesis carries its start time in seconds: start again in a later second.
    await new Promise((r) => setTimeout(r, 1_100));
    await startAnvil(port, chain);
    const second = await identity();
    expect(second.chainId).toBe(CHAIN_ID);
    expect(second.genesisHash).not.toBe(first.genesisHash);

    expect(await badgeEligibility(deps, ACCOUNT, { chainId: CHAIN_ID, identity, mainnet: false })).toMatchObject({
      claimed: false,
      txHash: null,
    });
    expect((await claim()).genesisHash).toBe(second.genesisHash);
    expect(mints).toHaveLength(2);
    expect((await accounts.accountsOf(ACCOUNT, 1))[0]?.deployed).toBe(false);
  }, 30_000);
});
