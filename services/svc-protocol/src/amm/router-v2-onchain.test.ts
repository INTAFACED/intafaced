/**
 * Router v2 and SovereignPermit on a disposable anvil (D-swap-03, D-swap-intents-01, -02).
 *
 * The spec's tests, against the compiled contracts: a one-time permit pulls once and its nonce is spent; a replayed,
 * oversized or late pull reverts; a standing allowance pulls until its expiration and not after; a two-hop swap with a
 * hop under its minimum reverts whole (HopBelowMin) with nothing moved; exact-out pays no more than its maximum and the
 * pool K never falls; native in is wrapped and swapped in one transaction with the unused value refunded; a past deadline
 * reverts Expired with the pools unchanged; the router holds nothing after every call.
 *
 * Skips without a chain; CI with REQUIRE_EVM_CHAIN=1 must run it. Sends from this file's own derived account.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, http, parseUnits, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadArtifact } from '../chain/artifacts.js';
import type { DevChainClients } from '../../scripts/dev-chain.js';

const devChainMod = await (async () => {
  try {
    return await import('../../scripts/dev-chain.js');
  } catch {
    return null;
  }
})();
const chainUp = devChainMod ? await devChainMod.devChainReachable() : false;
const describeOnChain = !devChainMod || (!chainUp && !devChainMod.devChainRequired()) ? describe.skip : describe;

const PULL = { allowance: 0, standing: 1, native: 2 } as const;
const abi = (name: Parameters<typeof loadArtifact>[0]) => loadArtifact(name).abi as Abi;

describeOnChain('router v2 and SovereignPermit onchain', () => {
  if (!devChainMod) return;
  let c: DevChainClients;
  let factory: Address;
  let router: Address;
  let permit: Address;
  let weth: Address;
  let tokenA: Address; // EIP-2612 permit
  let tokenB: Address; // EIP-2612 permit
  let tokenC: Address; // no permit
  const pools: Record<string, Address> = {};
  const owner = privateKeyToAccount(generatePrivateKey());
  let ownerWallet: ReturnType<typeof createWalletClient>;

  const send = async (hash: Hex) => {
    const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`transaction failed: ${hash}`);
    return receipt;
  };
  const deploy = async (name: Parameters<typeof loadArtifact>[0], args: unknown[] = []) => {
    const a = loadArtifact(name);
    const receipt = await send(
      await c.walletClient.deployContract({
        abi: a.abi as Abi,
        bytecode: a.bytecode as Hex,
        args,
        account: c.walletClient.account!,
        chain: c.walletClient.chain,
      }),
    );
    return receipt.contractAddress as Address;
  };
  const write = async (address: Address, name: Parameters<typeof loadArtifact>[0], functionName: string, args: unknown[]) =>
    send(
      await c.walletClient.writeContract({
        address,
        abi: abi(name),
        functionName,
        args,
        account: c.walletClient.account!,
        chain: c.walletClient.chain,
      }),
    );
  const read = <T>(address: Address, name: Parameters<typeof loadArtifact>[0], functionName: string, args: unknown[] = []) =>
    c.publicClient.readContract({ address, abi: abi(name), functionName, args }) as Promise<T>;
  /** The owner sends; the revert's error name comes back when it reverts in simulation. */
  const ownerCall = async (address: Address, name: Parameters<typeof loadArtifact>[0], functionName: string, args: unknown[], value = 0n) => {
    const { request } = await c.publicClient.simulateContract({ address, abi: abi(name), functionName, args, value, account: owner });
    return send(await ownerWallet.writeContract({ ...request, account: owner, chain: c.walletClient.chain } as never));
  };
  const revertOf = async (address: Address, name: Parameters<typeof loadArtifact>[0], functionName: string, args: unknown[], value = 0n, from: Address = owner.address) =>
    // The router passes SovereignPermit's own errors through, so both ABIs decode a revert.
    c.publicClient.simulateContract({ address, abi: [...abi(name), ...abi('SovereignPermit').filter((item) => item.type === 'error')], functionName, args, value, account: from }).then(
      () => 'no revert',
      (err: Error & { cause?: { data?: { errorName?: string } } }) => err.cause?.data?.errorName ?? err.message,
    );
  const now = async () => (await c.publicClient.getBlock()).timestamp;
  const balance = (token: Address, who: Address) => read<bigint>(token, 'TestToken', 'balanceOf', [who]);
  const reservesOf = (pool: Address) => read<readonly [bigint, bigint, number]>(pool, 'ConstantProductPool', 'getReserves');
  const routerHoldsNothing = async () => {
    for (const token of [tokenA, tokenB, tokenC, weth]) expect(await balance(token, router)).toBe(0n);
    expect(await c.publicClient.getBalance({ address: router })).toBe(0n);
  };

  /** The owner's EIP-2612 signature on `token` for `spender`, split for `selfPermit`. */
  async function eip2612(token: Address, spender: Address, value: bigint, deadline: bigint) {
    const nonce = await read<bigint>(token, 'TestToken', 'nonces', [owner.address]);
    const name = await read<string>(token, 'TestToken', 'name');
    const signature = await owner.signTypedData({
      domain: { name, version: '1', chainId: await c.publicClient.getChainId(), verifyingContract: token },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      message: { owner: owner.address, spender, value, nonce, deadline },
    });
    return { signature, r: signature.slice(0, 66) as Hex, s: `0x${signature.slice(66, 130)}` as Hex, v: Number(`0x${signature.slice(130, 132)}`) };
  }
  const permitDomain = async () => ({ name: 'SovereignPermit', chainId: await c.publicClient.getChainId(), verifyingContract: permit });

  beforeAll(async () => {
    c = await devChainMod.devSuiteClients(import.meta.url);
    await devChainMod.fundDevAccount(c.publicClient, owner.address);
    ownerWallet = createWalletClient({ account: owner, chain: c.walletClient.chain, transport: http(c.rpcUrl) });
    factory = await deploy('PoolFactory');
    weth = await deploy('TestWrappedNative');
    permit = await deploy('SovereignPermit');
    router = await deploy('SovereignRouterV2', [weth, permit]);
    tokenA = await deploy('TestToken', ['RV2 A', 'RV2A', 6]);
    tokenB = await deploy('TestToken', ['RV2 B', 'RV2B', 18]);
    tokenC = await deploy('TestPlainToken', ['RV2 C', 'RV2C', 18]);
    const seedPool = async (key: string, a: Address, b: Address, amountA: bigint, amountB: bigint) => {
      await write(factory, 'PoolFactory', 'createPool', [a, b, 30]);
      const pool = await read<Address>(factory, 'PoolFactory', 'getPool', [a, b, 30]);
      for (const [t, amount] of [[a, amountA], [b, amountB]] as const) {
        if (t === weth) {
          await send(await c.walletClient.sendTransaction({ to: weth, value: amount, account: c.walletClient.account!, chain: c.walletClient.chain }));
        } else await write(t, 'TestToken', 'mint', [c.deployer, amount]);
        await write(t, 'TestToken', 'approve', [pool, amount]);
      }
      const token0 = await read<Address>(pool, 'ConstantProductPool', 'token0');
      const [x, y] = token0.toLowerCase() === a.toLowerCase() ? [amountA, amountB] : [amountB, amountA];
      await write(pool, 'ConstantProductPool', 'mint', [c.deployer, x, y]);
      pools[key] = pool;
    };
    await seedPool('AB', tokenA, tokenB, parseUnits('100000', 6), parseUnits('100000', 18));
    await seedPool('BC', tokenB, tokenC, parseUnits('100000', 18), parseUnits('100000', 18));
    await seedPool('WB', weth, tokenB, parseUnits('100', 18), parseUnits('100000', 18));
    for (const t of [tokenA, tokenB, tokenC]) await write(t, 'TestToken', 'mint', [owner.address, parseUnits('1000', t === tokenA ? 6 : 18)]);
  }, 180_000);

  it('a one-time EIP-2612 permit for the exact amount pays the swap with no approve transaction, and cannot be used again', async () => {
    const amount = parseUnits('10', 6);
    const deadline = (await now()) + 300n;
    const p = await eip2612(tokenA, router, amount, deadline);
    const swap = {
      path: [tokenA, tokenB],
      pools: [pools.AB],
      amount,
      limit: 1n,
      minOutPerHop: [1n],
      to: owner.address,
      deadline,
      pull: PULL.allowance,
      unwrapOut: false,
    };
    const { encodeFunctionData } = await import('viem');
    const calls = [
      encodeFunctionData({ abi: abi('SovereignRouterV2'), functionName: 'selfPermit', args: [tokenA, amount, deadline, p.v, p.r, p.s] }),
      encodeFunctionData({ abi: abi('SovereignRouterV2'), functionName: 'exactIn', args: [swap] }),
    ];
    const before = await balance(tokenB, owner.address);
    await ownerCall(router, 'SovereignRouterV2', 'multicall', [calls]);
    expect(await balance(tokenB, owner.address)).toBeGreaterThan(before);
    // The allowance was exactly the amount and is spent; the token's nonce moved, so the same signature reverts.
    expect(await read<bigint>(tokenA, 'TestToken', 'allowance', [owner.address, router])).toBe(0n);
    expect(await revertOf(tokenA, 'TestToken', 'permit', [owner.address, router, amount, deadline, p.v, p.r, p.s])).toBe('InvalidSigner');
    await routerHoldsNothing();
  });

  it('a signature transfer pulls once: the nonce is spent, a replay, a pull above the amount and a pull after the deadline revert', async () => {
    const amount = parseUnits('10', 18);
    await ownerCall(tokenB, 'TestToken', 'approve', [permit, amount * 10n]);
    const deadline = (await now()) + 300n;
    const sign = (nonce: bigint, dl: bigint) =>
      permitDomain().then((domain) =>
        owner.signTypedData({
          domain,
          types: {
            PermitTransferFrom: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
              { name: 'spender', type: 'address' },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' },
            ],
          },
          primaryType: 'PermitTransferFrom',
          message: { token: tokenB, amount, spender: c.deployer, nonce, deadline: dl },
        }),
      );
    const sig = await sign(7n, deadline);
    const args = (requested: bigint, signature: Hex, nonce = 7n, dl = deadline) => [tokenB, amount, nonce, dl, owner.address, c.deployer, requested, signature];
    expect(await revertOf(permit, 'SovereignPermit', 'permitTransferFrom', args(amount + 1n, sig), 0n, c.deployer)).toBe('AmountOverPermit');
    const before = await balance(tokenB, c.deployer);
    await write(permit, 'SovereignPermit', 'permitTransferFrom', args(amount, sig));
    expect((await balance(tokenB, c.deployer)) - before).toBe(amount);
    expect((await read<bigint>(permit, 'SovereignPermit', 'nonceBitmap', [owner.address, 0n])) & (1n << 7n)).not.toBe(0n);
    expect(await revertOf(permit, 'SovereignPermit', 'permitTransferFrom', args(amount, sig), 0n, c.deployer)).toBe('NonceUsed');
    const late = (await now()) - 1n;
    const lateSig = await sign(8n, late);
    expect(await revertOf(permit, 'SovereignPermit', 'permitTransferFrom', args(amount, lateSig, 8n, late), 0n, c.deployer)).toBe('SignatureExpired');
  });

  it('a standing allowance with an expiry pays a swap until the expiry and refuses a pull after it', async () => {
    const amount = parseUnits('5', 18);
    await ownerCall(tokenB, 'TestToken', 'approve', [permit, amount * 100n]);
    const expiration = (await now()) + 3n;
    const sigDeadline = (await now()) + 300n;
    const signature = await owner.signTypedData({
      domain: await permitDomain(),
      types: {
        PermitAllowance: [
          { name: 'token', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'amount', type: 'uint160' },
          { name: 'expiration', type: 'uint48' },
          { name: 'nonce', type: 'uint48' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
      },
      primaryType: 'PermitAllowance',
      message: { token: tokenB, spender: router, amount: amount * 2n, expiration: Number(expiration), nonce: 0, sigDeadline },
    });
    await ownerCall(router, 'SovereignRouterV2', 'standingPermit', [tokenB, amount * 2n, Number(expiration), 0, sigDeadline, signature]);
    const [left, exp] = await read<readonly [bigint, number, number]>(permit, 'SovereignPermit', 'allowance', [owner.address, tokenB, router]);
    expect(left).toBe(amount * 2n);
    expect(BigInt(exp)).toBe(expiration);
    const swap = (deadline: bigint) => ({
      path: [tokenB, tokenA],
      pools: [pools.AB],
      amount,
      limit: 1n,
      minOutPerHop: [1n],
      to: owner.address,
      deadline,
      pull: PULL.standing,
      unwrapOut: false,
    });
    await ownerCall(router, 'SovereignRouterV2', 'exactIn', [swap((await now()) + 300n)]);
    // The chain's clock passes the expiration: the next pull is refused by SovereignPermit, and the router passes it on.
    await c.publicClient.request({ method: 'evm_increaseTime', params: [5] } as never);
    await c.publicClient.request({ method: 'evm_mine', params: [] } as never);
    expect(await revertOf(router, 'SovereignRouterV2', 'exactIn', [swap((await now()) + 300n)])).toBe('AllowanceExpired');
    expect(await revertOf(permit, 'SovereignPermit', 'transferFrom', [owner.address, router, amount, tokenB], 0n, router)).toBe('AllowanceExpired');
    await routerHoldsNothing();
  });

  it('a two-hop swap checks each hop: a hop under its minimum reverts the whole swap and nothing moves', async () => {
    const amount = parseUnits('10', 6);
    await ownerCall(tokenA, 'TestToken', 'approve', [router, amount]);
    const outs = await read<readonly bigint[]>(router, 'SovereignRouterV2', 'quoteExactIn', [[tokenA, tokenB, tokenC], [pools.AB, pools.BC], amount]);
    const swap = (minOutPerHop: bigint[], limit: bigint) => ({
      path: [tokenA, tokenB, tokenC],
      pools: [pools.AB, pools.BC],
      amount,
      limit,
      minOutPerHop,
      to: owner.address,
      deadline: 0n,
      pull: PULL.allowance,
      unwrapOut: false,
    });
    const deadline = (await now()) + 300n;
    const before = await Promise.all([balance(tokenA, owner.address), balance(tokenC, owner.address), reservesOf(pools.AB), reservesOf(pools.BC)]);
    expect(await revertOf(router, 'SovereignRouterV2', 'exactIn', [{ ...swap([outs[0]! + 1n, outs[1]!], outs[1]!), deadline }])).toBe('HopBelowMin');
    expect(await revertOf(router, 'SovereignRouterV2', 'exactIn', [{ ...swap([outs[0]!, outs[1]! + 1n], outs[1]!), deadline }])).toBe('HopBelowMin');
    expect(await revertOf(router, 'SovereignRouterV2', 'exactIn', [{ ...swap([outs[0]!, outs[1]!], outs[1]! + 1n), deadline }])).toBe('InsufficientOut');
    // A mined revert: the transaction is sent anyway (no simulation), and the pools and balances are as they were.
    const hash = await ownerWallet.writeContract({
      address: router,
      abi: abi('SovereignRouterV2'),
      functionName: 'exactIn',
      args: [{ ...swap([outs[0]! + 1n, outs[1]!], outs[1]!), deadline }],
      account: owner,
      chain: c.walletClient.chain,
      gas: 500_000n,
    });
    expect((await c.publicClient.waitForTransactionReceipt({ hash })).status).toBe('reverted');
    expect(await Promise.all([balance(tokenA, owner.address), balance(tokenC, owner.address), reservesOf(pools.AB), reservesOf(pools.BC)])).toEqual(before);
    await ownerCall(router, 'SovereignRouterV2', 'exactIn', [{ ...swap([outs[0]!, outs[1]!], outs[1]!), deadline }]);
    expect((await balance(tokenC, owner.address)) - before[1]).toBe(outs[1]);
    await routerHoldsNothing();
  });

  it('exact output with native input: pays no more than the maximum, wraps in the same transaction, refunds the rest; K never falls', async () => {
    const out = parseUnits('5', 18);
    const ins = await read<readonly bigint[]>(router, 'SovereignRouterV2', 'quoteExactOut', [[weth, tokenB], [pools.WB], out]);
    const maxIn = (ins[0]! * 101n) / 100n;
    const [r0, r1] = await reservesOf(pools.WB);
    const ethBefore = await c.publicClient.getBalance({ address: owner.address });
    const bBefore = await balance(tokenB, owner.address);
    const swap = {
      path: [weth, tokenB],
      pools: [pools.WB],
      amount: out,
      limit: maxIn,
      minOutPerHop: [],
      to: owner.address,
      deadline: (await now()) + 300n,
      pull: PULL.native,
      unwrapOut: false,
    };
    const receipt = await ownerCall(router, 'SovereignRouterV2', 'exactOut', [swap], maxIn);
    expect((await balance(tokenB, owner.address)) - bBefore).toBe(out);
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    expect(ethBefore - (await c.publicClient.getBalance({ address: owner.address })) - gas).toBe(ins[0]);
    const [s0, s1] = await reservesOf(pools.WB);
    expect(s0 * s1).toBeGreaterThanOrEqual(r0 * r1);
    // Asking for more than the maximum allows reverts.
    expect(await revertOf(router, 'SovereignRouterV2', 'exactOut', [{ ...swap, limit: ins[0]! - 1n }], ins[0]! - 1n)).toBe('ExcessiveInput');
    await routerHoldsNothing();
  });

  it('a deadline in the past reverts Expired and leaves the pool as it was; a zero deadline is never one', async () => {
    const before = await reservesOf(pools.WB);
    const swap = (deadline: bigint) => ({
      path: [weth, tokenB],
      pools: [pools.WB],
      amount: parseUnits('1', 18),
      limit: parseUnits('1', 18),
      minOutPerHop: [],
      to: owner.address,
      deadline,
      pull: PULL.native,
      unwrapOut: false,
    });
    expect(await revertOf(router, 'SovereignRouterV2', 'exactOut', [swap((await now()) - 1n)], parseUnits('1', 18))).toBe('Expired');
    expect(await revertOf(router, 'SovereignRouterV2', 'exactOut', [swap(0n)], parseUnits('1', 18))).toBe('Expired');
    expect(await reservesOf(pools.WB)).toEqual(before);
  });
});
