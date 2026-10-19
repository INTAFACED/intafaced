/**
 * S-G1 MemeLaunch on-chain: two MockERC20 + factories → launch → LP at lock,
 * claim reverts before unlock. Skips without anvil; CI with REQUIRE_EVM_CHAIN=1
 * must run this.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeEventLog, type Address, type Abi, type Hex } from 'viem';
import { loadArtifact } from '../chain/artifacts.js';

const WAD = 10n ** 18n;
const FEE_BPS = 30;
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const SALT: Hex = `0x${'11'.repeat(32)}`;

const devChainMod = await (async () => {
  try {
    return await import('../../scripts/dev-chain.js');
  } catch {
    return null;
  }
})();

const chainUp = devChainMod ? await devChainMod.devChainReachable() : false;
const describeOnChain = !devChainMod || (!chainUp && !devChainMod.devChainRequired()) ? describe.skip : describe;

describeOnChain('MemeLaunch on chain (S-G1)', () => {
  if (!devChainMod) return;

  let clients: Awaited<ReturnType<typeof devChainMod.devSuiteClients>>;
  let tokenA: Address;
  let tokenB: Address;
  let meme: Address;
  let tokenFactory: Address;
  let poolFactory: Address;
  let tokenAbi: Abi;
  let memeAbi: Abi;
  let poolAbi: Abi;
  let lockAbi: Abi;
  let factoryAbi: Abi;

  async function write(fn: () => Promise<Hex>) {
    const hash = await fn();
    return clients.publicClient.waitForTransactionReceipt({ hash });
  }

  async function warp(seconds: number) {
    await clients.publicClient.request({ method: 'evm_increaseTime' as never, params: [seconds] as never });
    await clients.publicClient.request({ method: 'evm_mine' as never, params: [] as never });
  }

  async function tokenBalance(token: Address, account: Address) {
    return (await clients.publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [account],
    })) as bigint;
  }

  beforeAll(async () => {
    if (!chainUp && devChainMod.devChainRequired()) {
      throw new Error('REQUIRE_EVM_CHAIN=1 but no RPC at ' + devChainMod.devRpcUrl());
    }
    clients = await devChainMod.devSuiteClients(import.meta.url);

    const mock = loadArtifact('MockERC20');
    tokenAbi = mock.abi;
    const deployMock = async () => {
      const tx = await clients.walletClient.deployContract({
        abi: mock.abi,
        bytecode: mock.bytecode,
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      });
      return (await clients.publicClient.waitForTransactionReceipt({ hash: tx })).contractAddress!;
    };
    tokenA = await deployMock();
    tokenB = await deployMock();

    ({ factory: tokenFactory } = await devChainMod.deployTokenFactory(clients));
    ({ factory: poolFactory } = await devChainMod.deployPoolFactory(clients));

    const ml = loadArtifact('MemeLaunch');
    memeAbi = ml.abi;
    const mTx = await clients.walletClient.deployContract({
      abi: ml.abi,
      bytecode: ml.bytecode,
      args: [tokenFactory, poolFactory],
      account: clients.walletClient.account!,
      chain: clients.walletClient.chain,
    });
    meme = (await clients.publicClient.waitForTransactionReceipt({ hash: mTx })).contractAddress!;

    poolAbi = loadArtifact('ConstantProductPool').abi;
    lockAbi = loadArtifact('LaunchLpLock').abi;
    factoryAbi = loadArtifact('PoolFactory').abi;

    const seed = 100_000n * WAD;
    for (const token of [tokenA, tokenB]) {
      await write(() =>
        clients.walletClient.writeContract({
          address: token,
          abi: tokenAbi,
          functionName: 'mint',
          args: [clients.deployer, seed],
          account: clients.walletClient.account!,
          chain: clients.walletClient.chain,
        }),
      );
      await write(() =>
        clients.walletClient.writeContract({
          address: token,
          abi: tokenAbi,
          functionName: 'approve',
          args: [meme, seed],
          account: clients.walletClient.account!,
          chain: clients.walletClient.chain,
        }),
      );
    }
  }, 120_000);

  function launchArgs(overrides: Record<string, unknown> = {}) {
    return {
      existingToken: tokenA,
      name: '',
      symbol: '',
      decimals: 0,
      totalSupply: 0n,
      quoteToken: tokenB,
      feeBps: FEE_BPS,
      tokenAmount: 10_000n * WAD,
      quoteAmount: 10_000n * WAD,
      unlockTime: 2_000_000_000n,
      userSalt: SALT,
      ...overrides,
    };
  }

  it('launches: pool + LP locked at LaunchLpLock; claim reverts before unlock', async () => {
    const params = launchArgs();
    const receipt = await write(() =>
      clients.walletClient.writeContract({
        address: meme,
        abi: memeAbi,
        functionName: 'launch',
        args: [params],
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      }),
    );
    expect(receipt.status).toBe('success');

    let pool: Address = ZERO;
    let lpLock: Address = ZERO;
    let liquidity = 0n;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: memeAbi, data: log.data, topics: log.topics }) as {
          eventName: string;
          args?: { pool?: Address; lpLock?: Address; liquidity?: bigint };
        };
        if (decoded.eventName === 'Launched' && decoded.args) {
          pool = decoded.args.pool ?? ZERO;
          lpLock = decoded.args.lpLock ?? ZERO;
          liquidity = decoded.args.liquidity ?? 0n;
        }
      } catch {
        // logs from the pool / lock / tokens
      }
    }
    expect(pool).not.toBe(ZERO);
    expect(lpLock).not.toBe(ZERO);
    expect(liquidity > 0n).toBe(true);

    const recordedPool = (await clients.publicClient.readContract({
      address: poolFactory,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [tokenA, tokenB, FEE_BPS],
    })) as Address;
    expect(recordedPool.toLowerCase()).toBe(pool.toLowerCase());

    const lpAtLock = (await clients.publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'balanceOf',
      args: [lpLock],
    })) as bigint;
    expect(lpAtLock).toBe(liquidity);

    const lpAtLauncher = (await clients.publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'balanceOf',
      args: [meme],
    })) as bigint;
    expect(lpAtLauncher).toBe(0n);

    const memeTokenBal = (await clients.publicClient.readContract({
      address: tokenA,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [meme],
    })) as bigint;
    const memeQuoteBal = (await clients.publicClient.readContract({
      address: tokenB,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [meme],
    })) as bigint;
    expect(memeTokenBal).toBe(0n);
    expect(memeQuoteBal).toBe(0n);

    await expect(
      clients.walletClient.writeContract({
        address: lpLock,
        abi: lockAbi,
        functionName: 'claim',
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      }),
    ).rejects.toThrow();
  }, 120_000);

  it('after unlockTime, claim burns the lock LP and returns the deposited token and quote', async () => {
    const mock = loadArtifact('MockERC20');
    const deployMock = async () => {
      const tx = await clients.walletClient.deployContract({
        abi: mock.abi,
        bytecode: mock.bytecode,
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      });
      return (await clients.publicClient.waitForTransactionReceipt({ hash: tx })).contractAddress!;
    };
    const token = await deployMock();
    const quote = await deployMock();
    // Same seed and deposit the launch test above already passes. Not a new amount.
    const seed = 100_000n * WAD;
    const deposit = 10_000n * WAD;
    for (const erc20 of [token, quote]) {
      await write(() =>
        clients.walletClient.writeContract({
          address: erc20,
          abi: tokenAbi,
          functionName: 'mint',
          args: [clients.deployer, seed],
          account: clients.walletClient.account!,
          chain: clients.walletClient.chain,
        }),
      );
      await write(() =>
        clients.walletClient.writeContract({
          address: erc20,
          abi: tokenAbi,
          functionName: 'approve',
          args: [meme, seed],
          account: clients.walletClient.account!,
          chain: clients.walletClient.chain,
        }),
      );
    }

    const latest = await clients.publicClient.getBlock();
    const unlockTime = latest.timestamp + 30n;
    const receipt = await write(() =>
      clients.walletClient.writeContract({
        address: meme,
        abi: memeAbi,
        functionName: 'launch',
        args: [
          launchArgs({
            existingToken: token,
            quoteToken: quote,
            tokenAmount: deposit,
            quoteAmount: deposit,
            unlockTime,
          }),
        ],
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      }),
    );
    expect(receipt.status).toBe('success');

    let pool: Address = ZERO;
    let lpLock: Address = ZERO;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: memeAbi, data: log.data, topics: log.topics }) as {
          eventName: string;
          args?: { pool?: Address; lpLock?: Address };
        };
        if (decoded.eventName === 'Launched' && decoded.args) {
          pool = decoded.args.pool ?? ZERO;
          lpLock = decoded.args.lpLock ?? ZERO;
        }
      } catch {
        // logs from the pool / lock / tokens
      }
    }
    expect(pool).not.toBe(ZERO);
    expect(lpLock).not.toBe(ZERO);

    await expect(
      clients.walletClient.writeContract({
        address: lpLock,
        abi: lockAbi,
        functionName: 'claim',
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      }),
    ).rejects.toThrow();

    await warp(31);
    try {
      await write(() =>
        clients.walletClient.writeContract({
          address: lpLock,
          abi: lockAbi,
          functionName: 'claim',
          account: clients.walletClient.account!,
          chain: clients.walletClient.chain,
        }),
      );
    } catch {
      // Score the deposit that is still sitting in the pool.
    }

    // First mint assigns MINIMUM_LIQUIDITY (1_000) to address(0). Burning the
    // lock's shares returns the deposit minus that dust.
    const minimumLiquidity = 1_000n;
    expect(await tokenBalance(token, pool)).toBe(minimumLiquidity);
    expect(await tokenBalance(quote, pool)).toBe(minimumLiquidity);
    expect(await tokenBalance(token, clients.deployer)).toBe(seed - minimumLiquidity);
    expect(await tokenBalance(quote, clients.deployer)).toBe(seed - minimumLiquidity);

    const lpAtLock = (await clients.publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'balanceOf',
      args: [lpLock],
    })) as bigint;
    const lpAtZero = (await clients.publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'balanceOf',
      args: [ZERO],
    })) as bigint;
    expect(lpAtLock).toBe(0n);
    expect(lpAtZero).toBe(minimumLiquidity);
  }, 120_000);

  it('reverts on zero amounts, identical tokens, and unlockTime <= now', async () => {
    await expect(
      clients.walletClient.writeContract({
        address: meme,
        abi: memeAbi,
        functionName: 'launch',
        args: [launchArgs({ tokenAmount: 0n })],
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      }),
    ).rejects.toThrow();

    await expect(
      clients.walletClient.writeContract({
        address: meme,
        abi: memeAbi,
        functionName: 'launch',
        args: [launchArgs({ quoteToken: tokenA })],
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      }),
    ).rejects.toThrow();

    const latest = await clients.publicClient.getBlock();
    await expect(
      clients.walletClient.writeContract({
        address: meme,
        abi: memeAbi,
        functionName: 'launch',
        args: [launchArgs({ unlockTime: latest.timestamp })],
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      }),
    ).rejects.toThrow();
  }, 60_000);
});
