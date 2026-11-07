/**
 * The liquidity procedures on a real disposable chain (D-liquidity-01..04, J-dex-protocol-12), end to end: the calls they
 * build are signed and sent by TEST wallets here, and what they read back is checked against the chain.
 *
 * Proves, in the journey's order: a pool created and seeded at 1000:2000 sets that price, and a second create for the
 * same pair and fee refuses; 100:100 offered pulls only 50:100; a minimum above what the pool mints reverts and the
 * contract's reason is named; a position shows its shares and share of the pool, and a share sent to another wallet is
 * that wallet's position with "entry unknown"; after the price moves to 1414:1414 the loss against holding matches the
 * closed form and the swap paid fees; swap-and-add swaps about half, and a failed add leaves nothing half done; collecting
 * fees refuses as compounding; removing every share pays both tokens pro rata and the position goes.
 *
 * Skips when no anvil unless REQUIRE_EVM_CHAIN=1 (CI). TEST tokens only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, maxUint256, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createEdgeContext, router } from '@intafaced/contracts';
import { loadArtifact } from '../chain/artifacts.js';
import { ProtocolChain } from '../chain/client.js';
import { pairsReader } from '../amm/pairs.js';
import type { DevChainClients } from '../../scripts/dev-chain.js';
import { createLiquidityProcedures } from './procedures.js';
import { sqrt } from './maths.js';

const devChainMod = await (async () => {
  try {
    return await import('../../scripts/dev-chain.js');
  } catch {
    return null;
  }
})();
const chainUp = devChainMod ? await devChainMod.devChainReachable() : false;
const describeOnChain = !devChainMod || (!chainUp && !devChainMod.devChainRequired()) ? describe.skip : describe;

const edge = createEdgeContext({ secret: 'a-protocol-liquidity-onchain-test-secret', serviceName: 'svc-protocol' });
const anonymous = () => edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-liquidity-onchain' });
const E = 10n ** 18n;
const ZERO: Address = '0x0000000000000000000000000000000000000000';

describeOnChain('liquidity procedures on chain (J-dex-protocol-12)', () => {
  if (!devChainMod) return;
  let clients: DevChainClients;
  let factory: Address;
  let liquidityRouter: Address;
  let tokenA: Address;
  let tokenB: Address;
  let person: PrivateKeyAccount;
  let other: PrivateKeyAccount;
  let trader: PrivateKeyAccount;
  let tiers: number[] | null = [5, 30, 100];
  let amm: ReturnType<typeof caller>;
  let pool: Address;
  let second: Address;

  const caller = () => {
    const chain = new ProtocolChain({
      chainId: devChainMod.DEV_CHAIN_ID,
      rpcUrl: clients.rpcUrl,
      entryPoint: ZERO,
      factory: ZERO,
      implementation: ZERO,
    });
    const readPairs = pairsReader(chain);
    return router(
      createLiquidityProcedures({
        client: () => chain.client,
        rpcUrl: () => clients.rpcUrl,
        factory: () => factory,
        router: () => liquidityRouter,
        feeTiers: () => tiers,
        quoteTtlSeconds: () => 30,
        slippageBps: () => 300,
        readPairs,
        toTrpcError: (err) => err as never,
      }),
    ).createCaller(anonymous());
  };

  const deploy = async (name: Parameters<typeof loadArtifact>[0], args: unknown[] = []) => {
    const a = loadArtifact(name);
    const hash = await clients.walletClient.deployContract({
      abi: a.abi,
      bytecode: a.bytecode as Hex,
      args,
      account: clients.walletClient.account!,
      chain: clients.walletClient.chain,
    });
    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress!;
  };
  // A fixed, ample gas limit, so a call that reverts is mined and reverts on chain rather than failing its estimate.
  const send = async (account: PrivateKeyAccount, to: Address, data: Hex) => {
    const hash = await clients.walletClient.sendTransaction({ account, to, data, chain: clients.walletClient.chain, gas: 6_000_000n });
    return clients.publicClient.waitForTransactionReceipt({ hash });
  };
  const erc20 = () => loadArtifact('MockERC20').abi;
  const balance = (token: Address, who: Address) =>
    clients.publicClient.readContract({ address: token, abi: erc20(), functionName: 'balanceOf', args: [who] }) as Promise<bigint>;
  const approveRouter = async (account: PrivateKeyAccount, token: Address) =>
    send(account, token, encodeFunctionData({ abi: erc20(), functionName: 'approve', args: [liquidityRouter, maxUint256] }));
  const reservesAB = async (p: Address) => {
    const [r0, r1] = (await clients.publicClient.readContract({
      address: p,
      abi: loadArtifact('LiquidityPool').abi,
      functionName: 'getReserves',
    })) as [bigint, bigint, number];
    const t0 = (await clients.publicClient.readContract({
      address: p,
      abi: loadArtifact('LiquidityPool').abi,
      functionName: 'token0',
    })) as Address;
    return getAddress(t0) === getAddress(tokenA) ? { a: r0, b: r1 } : { a: r1, b: r0 };
  };
  const ordered = async (p: Address, a: bigint, b: bigint) => {
    const t0 = (await clients.publicClient.readContract({
      address: p,
      abi: loadArtifact('LiquidityPool').abi,
      functionName: 'token0',
    })) as Address;
    return getAddress(t0) === getAddress(tokenA) ? [a, b] : [b, a];
  };

  beforeAll(async () => {
    clients = await devChainMod.devSuiteClients(import.meta.url);
    factory = await deploy('LiquidityFactory');
    liquidityRouter = await deploy('LiquidityRouter', [factory]);
    tokenA = await deploy('MockERC20');
    tokenB = await deploy('MockERC20');
    [person, other, trader] = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
    for (const who of [person, other, trader]) {
      await devChainMod.fundDevAccount(clients.publicClient, who.address, 10n * E);
      for (const token of [tokenA, tokenB]) {
        await send(
          clients.walletClient.account as PrivateKeyAccount,
          token,
          encodeFunctionData({ abi: erc20(), functionName: 'mint', args: [who.address, 100_000n * E] }),
        );
        await approveRouter(who, token);
      }
    }
    amm = caller();
  }, 120_000);

  it('#3 creates and seeds at 1000:2000: the price is the deposit ratio; the same pair and fee again refuses; above the cap refuses', async () => {
    expect((await amm.feeTiers()).tiers).toEqual([5, 30, 100]);
    const built = await amm.buildCreateAndSeed({
      owner: person.address,
      tokenA,
      tokenB,
      feeBps: 5,
      amountA: (1000n * E).toString(),
      amountB: (2000n * E).toString(),
    });
    expect((await send(person, built.call.to as Address, built.call.data as Hex)).status).toBe('success');
    pool = getAddress(built.pool);
    expect(await reservesAB(pool)).toEqual({ a: 1000n * E, b: 2000n * E });
    expect(await amm.poolExists({ tokenA: tokenB, tokenB: tokenA, feeBps: 5 })).toMatchObject({ exists: true, pool });
    await expect(
      amm.buildCreateAndSeed({ owner: person.address, tokenA, tokenB, feeBps: 5, amountA: '1', amountB: '1' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/^amm\.pool_exists/) });
    await expect(
      amm.buildCreateAndSeed({ owner: person.address, tokenA, tokenB, feeBps: 9900, amountA: '1', amountB: '1' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/^amm\.fee_out_of_range/) });
    tiers = null;
    await expect(amm.feeTiers()).rejects.toMatchObject({ message: expect.stringMatching(/^amm\.fee_tiers_unset/) });
    tiers = [5, 30, 100];
  });

  it('#4 into a second 1000:2000 pool, 100:100 pulls only 50:100; a minimum above what it mints reverts with the reason', async () => {
    const seeded = await amm.buildCreateAndSeed({
      owner: trader.address,
      tokenA,
      tokenB,
      feeBps: 25,
      amountA: (1000n * E).toString(),
      amountB: (2000n * E).toString(),
    });
    await send(trader, seeded.call.to as Address, seeded.call.data as Hex);
    second = getAddress(seeded.pool);
    const [d0, d1] = await ordered(second, 100n * E, 100n * E);
    const quote = await amm.quoteAddLiquidity({ pool: second, amount0Desired: d0!.toString(), amount1Desired: d1!.toString() });
    expect(await ordered(second, BigInt(quote.amount0), BigInt(quote.amount1))).toEqual([50n * E, 100n * E].map((x) => x) as never);
    const tooMany = await amm.buildAddLiquidity({
      owner: person.address,
      pool: second,
      amount0Desired: d0!.toString(),
      amount1Desired: d1!.toString(),
      minShares: (BigInt(quote.shares) + 1n).toString(),
    });
    const why = await amm.explainLiquidityCall({ from: person.address, to: tooMany.call.to, data: tooMany.call.data });
    expect(why).toMatchObject({ reverts: true, error: 'InsufficientShares' });
    const [a0, b0] = [await balance(tokenA, person.address), await balance(tokenB, person.address)];
    const add = await amm.buildAddLiquidity({
      owner: person.address,
      pool: second,
      amount0Desired: d0!.toString(),
      amount1Desired: d1!.toString(),
      minShares: quote.shares,
    });
    expect((await send(person, add.call.to as Address, add.call.data as Hex)).status).toBe('success');
    expect(a0 - (await balance(tokenA, person.address))).toBe(50n * E);
    expect(b0 - (await balance(tokenB, person.address))).toBe(100n * E);
  });

  it('#5 the position: shares and share of the pool; a share sent to another wallet is that wallet’s, with no entry', async () => {
    const mine = await amm.position({ pool, account: person.address });
    expect(BigInt(mine.shares)).toBe(sqrt(1000n * E * 2000n * E) - 1000n);
    expect(mine.shareOfPoolBps).toBe(9999);
    expect(mine.entry).not.toBeNull();
    const send10th = await amm.buildSendShares({
      owner: person.address,
      pool,
      to: other.address,
      shares: (BigInt(mine.shares) / 10n).toString(),
    });
    await send(person, send10th.call.to as Address, send10th.call.data as Hex);
    const theirs = await amm.positions({ account: other.address });
    expect(theirs.positions.map((p) => p.pool)).toEqual([pool]);
    const theirPosition = await amm.position({ pool, account: other.address });
    expect(theirPosition.entry).toBeNull();
    expect(theirPosition.impermanentLoss).toBeNull();
  });

  it('#6 after the price moves to 1414:1414, the loss against holding matches the closed form, and the swap earned fees', async () => {
    // An outside TEST trader swaps TEST A in until the pool holds about 1414:1414.
    const poolAbi = loadArtifact('LiquidityPool').abi;
    await send(trader, tokenA, encodeFunctionData({ abi: erc20(), functionName: 'approve', args: [pool, maxUint256] }));
    await send(
      trader,
      pool,
      encodeFunctionData({ abi: poolAbi, functionName: 'swapExactIn', args: [tokenA, 414_213_562_373_095_048_801n, 1n, trader.address] }),
    );
    const r = await reservesAB(pool);
    expect(r.a / E).toBe(1414n);
    expect(r.b / E).toBe(1414n);
    const mine = await amm.position({ pool, account: person.address });
    const il = mine.impermanentLoss!;
    // held: nine tenths of 1000:2000 (a tenth was sent away)
    const held = await ordered(pool, BigInt(il.held0), BigInt(il.held1));
    expect(Number(held[0]! / 10n ** 15n) / 1000).toBeCloseTo(900, 0);
    expect(Number(held[1]! / 10n ** 15n) / 1000).toBeCloseTo(1800, 0);
    expect(il.closedFormBps).toBe(-571);
    expect(Math.abs(il.diffBps - il.closedFormBps)).toBeLessThanOrEqual(3);
    expect(BigInt(mine.feesEarned!.amount0) + BigInt(mine.feesEarned!.amount1)).toBeGreaterThan(0n);
  });

  it('#7 swap-and-add swaps about half and mints at least the minimum; a failed add leaves nothing half done', async () => {
    const quote = await amm.quoteSwapAndAdd({ pool, tokenIn: tokenA, amountIn: (100n * E).toString() });
    expect(BigInt(quote.swapped) > 45n * E && BigInt(quote.swapped) < 50n * E).toBe(true);
    const before = { a: await balance(tokenA, person.address), b: await balance(tokenB, person.address), r: await reservesAB(pool) };
    const failing = await amm.buildSwapAndAdd({
      owner: person.address,
      pool,
      tokenIn: tokenA,
      amountIn: (100n * E).toString(),
      minShares: (BigInt(quote.shares) * 2n).toString(),
    });
    expect(await amm.explainLiquidityCall({ from: person.address, to: failing.call.to, data: failing.call.data })).toMatchObject({
      reverts: true,
      error: 'InsufficientShares',
    });
    const reverted = await send(person, failing.call.to as Address, failing.call.data as Hex);
    expect(reverted.status).toBe('reverted');
    expect({ a: await balance(tokenA, person.address), b: await balance(tokenB, person.address), r: await reservesAB(pool) }).toEqual(
      before,
    );
    const sharesBefore = BigInt((await amm.position({ pool, account: person.address })).shares);
    const ok = await amm.buildSwapAndAdd({
      owner: person.address,
      pool,
      tokenIn: tokenA,
      amountIn: (100n * E).toString(),
      minShares: quote.shares,
    });
    expect((await send(person, ok.call.to as Address, ok.call.data as Hex)).status).toBe('success');
    expect(BigInt((await amm.position({ pool, account: person.address })).shares) - sharesBefore).toBeGreaterThanOrEqual(
      BigInt(quote.shares),
    );
  });

  it('#8 collecting fees refuses as compounding; removing every share pays both tokens pro rata and the position goes', async () => {
    await expect(amm.claimFees({ pool })).rejects.toMatchObject({ message: expect.stringMatching(/^protocol\.fees_compound/) });
    const mine = await amm.position({ pool, account: person.address });
    const lp = loadArtifact('LiquidityPool').abi;
    await send(person, pool, encodeFunctionData({ abi: lp, functionName: 'approve', args: [liquidityRouter, BigInt(mine.shares)] }));
    const remove = await amm.buildRemoveLiquidity({ owner: person.address, pool, shares: mine.shares });
    expect(BigInt(remove.amount0)).toBe((BigInt(mine.shares) * BigInt(mine.reserve0)) / BigInt(mine.totalSupply));
    const [a0, b0] = [await balance(tokenA, person.address), await balance(tokenB, person.address)];
    expect((await send(person, remove.call.to as Address, remove.call.data as Hex)).status).toBe('success');
    const paid = await ordered(pool, BigInt(remove.amount0), BigInt(remove.amount1));
    expect((await balance(tokenA, person.address)) - a0).toBe(paid[0]);
    expect((await balance(tokenB, person.address)) - b0).toBe(paid[1]);
    expect((await amm.positions({ account: person.address })).positions.map((p) => p.pool)).toEqual([second]);
  });
});
