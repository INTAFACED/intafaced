/**
 * AMM mint + swapExactIn on disposable anvil (protocol.amm residual).
 *
 * Tokens: launch TokenFactory → two SovereignTokens (already compiled).
 * Pool: PoolFactory createPool → mint liquidity → swapExactIn.
 *
 * Skips without chain / viem. CI with REQUIRE_EVM_CHAIN=1 must run this.
 *
 * Sends from an account derived from this file's own path, funded on demand —
 * see the per-suite sender banner in `scripts/dev-chain.ts`. It used to name
 * anvil index 4, which `launch/router-launch-live.test.ts` had also picked.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { loadArtifact } from '../chain/artifacts.js';
import type { DevChainClients } from '../../scripts/dev-chain.js';
import { parseTokenParams } from '../launch/params.js';
import { computeTokenAddress } from '../launch/address.js';

type Address = `0x${string}`;
type Hex = `0x${string}`;

/** Distinct 32-byte salts without node:crypto (avoids vitest TDZ on createHash). */
function salt(byte: number): Hex {
  return `0x${byte.toString(16).padStart(2, '0').repeat(32)}` as Hex;
}

const FEE_BPS = 30;

const devChainMod = await (async () => {
  try {
    return await import('../../scripts/dev-chain.js');
  } catch {
    return null;
  }
})();

const chainUp = devChainMod ? await devChainMod.devChainReachable() : false;
const describeOnChain = !devChainMod || (!chainUp && !devChainMod.devChainRequired()) ? describe.skip : describe;

describeOnChain('AMM mint + swapExactIn onchain', () => {
  if (!devChainMod) return;

  let clients: DevChainClients;
  let poolFactory: Address;
  let tokenFactory: Address;
  let token0: Address;
  let token1: Address;
  let pool: Address;

  beforeAll(async () => {
    if (!chainUp && devChainMod.devChainRequired()) {
      throw new Error('REQUIRE_EVM_CHAIN=1 but no RPC at ' + devChainMod.devRpcUrl());
    }
    // Asserts the chain is disposable before it writes anything to it.
    clients = await devChainMod.devSuiteClients(import.meta.url);

    ({ factory: poolFactory } = await devChainMod.deployPoolFactory(clients));
    ({ factory: tokenFactory } = await devChainMod.deployTokenFactory(clients));

    const deployer = clients.deployer;
    const tokenAbi = loadArtifact('SovereignToken').abi;
    const tfAbi = loadArtifact('TokenFactory').abi;

    const launch = async (name: string, symbol: string, saltByte: number) => {
      const params = parseTokenParams({
        name,
        symbol,
        decimals: 18,
        totalSupply: '1000000',
        recipient: deployer,
      });
      const userSalt = salt(saltByte);
      const predicted = computeTokenAddress({
        factory: tokenFactory,
        creator: deployer,
        userSalt,
        params,
      });
      const hash = await clients.walletClient.writeContract({
        address: tokenFactory,
        abi: tfAbi,
        functionName: 'createToken',
        args: [userSalt, params],
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      });
      await clients.publicClient.waitForTransactionReceipt({ hash });
      return { token: predicted, params };
    };

    const a = await launch('AMM Token A', 'AMMA', 0xaa);
    const b = await launch('AMM Token B', 'AMMB', 0xbb);
    // sort as pool does
    if (a.token.toLowerCase() < b.token.toLowerCase()) {
      token0 = a.token;
      token1 = b.token;
    } else {
      token0 = b.token;
      token1 = a.token;
    }

    // create pool
    const pfAbi = loadArtifact('PoolFactory').abi;
    const createHash = await clients.walletClient.writeContract({
      address: poolFactory,
      abi: pfAbi,
      functionName: 'createPool',
      args: [token0, token1, FEE_BPS],
      account: clients.walletClient.account!,
      chain: clients.walletClient.chain,
    });
    await clients.publicClient.waitForTransactionReceipt({ hash: createHash });
    pool = (await clients.publicClient.readContract({
      address: poolFactory,
      abi: pfAbi,
      functionName: 'getPool',
      args: [token0, token1, FEE_BPS],
    })) as Address;

    // approve pool for large amounts
    const amount = 100_000n * 10n ** 18n;
    for (const token of [token0, token1]) {
      const hash = await clients.walletClient.writeContract({
        address: token,
        abi: tokenAbi,
        functionName: 'approve',
        args: [pool, amount],
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      });
      await clients.publicClient.waitForTransactionReceipt({ hash });
    }
  }, 120_000);

  it('mints LP then swapExactIn moves reserves', async () => {
    const poolAbi = loadArtifact('ConstantProductPool').abi;
    const tokenAbi = loadArtifact('SovereignToken').abi;
    const seed = 10_000n * 10n ** 18n;

    const mintHash = await clients.walletClient.writeContract({
      address: pool,
      abi: poolAbi,
      functionName: 'mint',
      args: [clients.deployer, seed, seed],
      account: clients.walletClient.account!,
      chain: clients.walletClient.chain,
    });
    const mintReceipt = await clients.publicClient.waitForTransactionReceipt({ hash: mintHash });
    expect(mintReceipt.status).toBe('success');

    const lp = (await clients.publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'balanceOf',
      args: [clients.deployer],
    })) as bigint;
    expect(lp > 0n).toBe(true);

    const [r0Before, r1Before] = (await clients.publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'getReserves',
    })) as [bigint, bigint, number];
    expect(r0Before).toBe(seed);
    expect(r1Before).toBe(seed);

    const amountIn = 100n * 10n ** 18n;
    const bal1Before = (await clients.publicClient.readContract({
      address: token1,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [clients.deployer],
    })) as bigint;

    // Caller-supplied. This shared anvil is not warped; the case checks reserves, not the clock.
    const deadline = 2n ** 256n - 1n;
    const swapHash = await clients.walletClient.writeContract({
      address: pool,
      abi: poolAbi,
      functionName: 'swapExactIn',
      args: [token0, amountIn, 1n, clients.deployer, deadline],
      account: clients.walletClient.account!,
      chain: clients.walletClient.chain,
    });
    const swapReceipt = await clients.publicClient.waitForTransactionReceipt({ hash: swapHash });
    expect(swapReceipt.status).toBe('success');

    const [r0After, r1After] = (await clients.publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'getReserves',
    })) as [bigint, bigint, number];
    expect(r0After > r0Before).toBe(true);
    expect(r1After < r1Before).toBe(true);

    const bal1After = (await clients.publicClient.readContract({
      address: token1,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [clients.deployer],
    })) as bigint;
    expect(bal1After > bal1Before).toBe(true);
  }, 120_000);
});
