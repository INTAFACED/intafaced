/**
 * Router v2 and SovereignPermit on a disposable anvil (D-swap-03, D-swap-intents-01, -02).
 *
 * The spec's tests, against the compiled contracts: a one-time permit pulls once and its nonce is spent; a replayed,
 * oversized or late pull reverts; a standing allowance pulls until its expiration and not after; a two-hop swap with a
 * hop under its minimum reverts whole (HopBelowMin) with nothing moved; exact-out pays no more than its maximum and the
 * pool K never falls; native in is wrapped and swapped in one transaction with the unused value refunded; a past deadline
 * reverts Expired with the pools unchanged; the router holds nothing after every call.
 *
 * Needs a disposable chain (CI starts one, REQUIRE_EVM_CHAIN=1); without one it fails. Sends from this file's own derived account.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, http, parseUnits, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadArtifact } from '../chain/artifacts.js';
import type { DevChainClients } from '../../scripts/dev-chain.js';
import type { ProtocolSwapPairs } from '@intafaced/contracts';
import { bestPath, buildPermit, buildSwapV2, readApprovalRoute, type SwapV2Deps } from './swap-v2.js';

// Runs unconditionally: CI starts the disposable chain (REQUIRE_EVM_CHAIN=1); with no chain here it fails, by name.
const devChainMod = await import('../../scripts/dev-chain.js');

const PULL = { allowance: 0, standing: 1, native: 2 } as const;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const abi = (name: Parameters<typeof loadArtifact>[0]) => loadArtifact(name).abi as Abi;

describe('router v2 and SovereignPermit onchain', () => {
  let c: DevChainClients;
  let factory: Address;
  let router: Address;
  let permit: Address;
  let weth: Address;
  let tokenA: Address; // EIP-2612 permit
  let tokenB: Address; // EIP-2612 permit
  let tokenC: Address; // no permit
  const pools = {} as Record<'AB' | 'BC' | 'WB', Address>;
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
  const ownerCall = async (
    address: Address,
    name: Parameters<typeof loadArtifact>[0],
    functionName: string,
    args: unknown[],
    value = 0n,
  ) => {
    const { request } = await c.publicClient.simulateContract({ address, abi: abi(name), functionName, args, value, account: owner });
    return send(await ownerWallet.writeContract({ ...request, account: owner, chain: c.walletClient.chain } as never));
  };
  const revertOf = async (
    address: Address,
    name: Parameters<typeof loadArtifact>[0],
    functionName: string,
    args: unknown[],
    value = 0n,
    from: Address = owner.address,
  ) =>
    // The router passes SovereignPermit's own errors through, so both ABIs decode a revert.
    c.publicClient
      .simulateContract({
        address,
        abi: [...abi(name), ...abi('SovereignPermit').filter((item) => item.type === 'error')],
        functionName,
        args,
        value,
        account: from,
      })
      .then(
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
    return {
      signature,
      r: signature.slice(0, 66) as Hex,
      s: `0x${signature.slice(66, 130)}` as Hex,
      v: Number(`0x${signature.slice(130, 132)}`),
    };
  }
  const permitDomain = async () => ({
    name: 'SovereignPermit',
    version: '1',
    chainId: await c.publicClient.getChainId(),
    verifyingContract: permit,
  });

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
    const seedPool = async (key: 'AB' | 'BC' | 'WB', a: Address, b: Address, amountA: bigint, amountB: bigint) => {
      await write(factory, 'PoolFactory', 'createPool', [a, b, 30]);
      const pool = await read<Address>(factory, 'PoolFactory', 'getPool', [a, b, 30]);
      for (const [t, amount] of [
        [a, amountA],
        [b, amountB],
      ] as const) {
        if (t === weth) {
          await send(
            await c.walletClient.sendTransaction({
              to: weth,
              value: amount,
              account: c.walletClient.account!,
              chain: c.walletClient.chain,
            }),
          );
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
    for (const t of [tokenA, tokenB, tokenC])
      await write(t, 'TestToken', 'mint', [owner.address, parseUnits('1000', t === tokenA ? 6 : 18)]);
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
      encodeFunctionData({
        abi: abi('SovereignRouterV2'),
        functionName: 'selfPermit',
        args: [tokenA, amount, deadline, p.v, p.r, p.s, false],
      }),
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
    const args = (requested: bigint, signature: Hex, nonce = 7n, dl = deadline) => [
      tokenB,
      amount,
      nonce,
      dl,
      owner.address,
      c.deployer,
      requested,
      signature,
    ];
    expect(await revertOf(permit, 'SovereignPermit', 'permitTransferFrom', args(amount + 1n, sig), 0n, c.deployer)).toBe(
      'AmountOverPermit',
    );
    const before = await balance(tokenB, c.deployer);
    await write(permit, 'SovereignPermit', 'permitTransferFrom', args(amount, sig));
    expect((await balance(tokenB, c.deployer)) - before).toBe(amount);
    expect((await read<bigint>(permit, 'SovereignPermit', 'nonceBitmap', [owner.address, 0n])) & (1n << 7n)).not.toBe(0n);
    expect(await revertOf(permit, 'SovereignPermit', 'permitTransferFrom', args(amount, sig), 0n, c.deployer)).toBe('NonceUsed');
    const late = (await now()) - 1n;
    const lateSig = await sign(8n, late);
    expect(await revertOf(permit, 'SovereignPermit', 'permitTransferFrom', args(amount, lateSig, 8n, late), 0n, c.deployer)).toBe(
      'SignatureExpired',
    );
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
    const [left, exp] = await read<readonly [bigint, number, number]>(permit, 'SovereignPermit', 'allowance', [
      owner.address,
      tokenB,
      router,
    ]);
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
    expect(await revertOf(permit, 'SovereignPermit', 'transferFrom', [owner.address, router, amount, tokenB], 0n, router)).toBe(
      'AllowanceExpired',
    );
    await routerHoldsNothing();
  });

  it('a two-hop swap checks each hop: a hop under its minimum reverts the whole swap and nothing moves', async () => {
    const amount = parseUnits('10', 6);
    await ownerCall(tokenA, 'TestToken', 'approve', [router, amount]);
    const outs = await read<readonly bigint[]>(router, 'SovereignRouterV2', 'quoteExactIn', [
      [tokenA, tokenB, tokenC],
      [pools.AB, pools.BC],
      amount,
    ]);
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
    const before = await Promise.all([
      balance(tokenA, owner.address),
      balance(tokenC, owner.address),
      reservesOf(pools.AB),
      reservesOf(pools.BC),
    ]);
    expect(await revertOf(router, 'SovereignRouterV2', 'exactIn', [{ ...swap([outs[0]! + 1n, outs[1]!], outs[1]!), deadline }])).toBe(
      'HopBelowMin',
    );
    expect(await revertOf(router, 'SovereignRouterV2', 'exactIn', [{ ...swap([outs[0]!, outs[1]! + 1n], outs[1]!), deadline }])).toBe(
      'HopBelowMin',
    );
    expect(await revertOf(router, 'SovereignRouterV2', 'exactIn', [{ ...swap([outs[0]!, outs[1]!], outs[1]! + 1n), deadline }])).toBe(
      'InsufficientOut',
    );
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
    expect(
      await Promise.all([balance(tokenA, owner.address), balance(tokenC, owner.address), reservesOf(pools.AB), reservesOf(pools.BC)]),
    ).toEqual(before);
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
    expect(await revertOf(router, 'SovereignRouterV2', 'exactOut', [{ ...swap, limit: ins[0]! - 1n }], ins[0]! - 1n)).toBe(
      'ExcessiveInput',
    );
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
  it('a standing-allowance signature submitted first by someone else does not block the swap; a revoke spends its nonce', async () => {
    const amount = parseUnits('2', 18);
    await ownerCall(tokenB, 'TestToken', 'approve', [permit, amount * 10n]);
    const [, , nonce] = await read<readonly [bigint, number, number]>(permit, 'SovereignPermit', 'allowance', [
      owner.address,
      tokenB,
      router,
    ]);
    const expiration = (await now()) + 600n;
    const sigDeadline = (await now()) + 300n;
    const signAllowance = (n: number) =>
      permitDomain().then((domain) =>
        owner.signTypedData({
          domain,
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
          message: { token: tokenB, spender: router, amount, expiration: Number(expiration), nonce: n, sigDeadline },
        }),
      );
    const signature = await signAllowance(nonce);
    // A watcher submits the signature straight to SovereignPermit first.
    await write(permit, 'SovereignPermit', 'permit', [
      owner.address,
      tokenB,
      router,
      amount,
      Number(expiration),
      nonce,
      sigDeadline,
      signature,
    ]);
    const { encodeFunctionData } = await import('viem');
    const swap = {
      path: [tokenB, tokenA],
      pools: [pools.AB],
      amount,
      limit: 1n,
      minOutPerHop: [1n],
      to: owner.address,
      deadline: sigDeadline,
      pull: PULL.standing,
      unwrapOut: false,
    };
    await ownerCall(router, 'SovereignRouterV2', 'multicall', [
      [
        encodeFunctionData({
          abi: abi('SovereignRouterV2'),
          functionName: 'standingPermit',
          args: [tokenB, amount, Number(expiration), nonce, sigDeadline, signature],
        }),
        encodeFunctionData({ abi: abi('SovereignRouterV2'), functionName: 'exactIn', args: [swap] }),
      ],
    ]);
    // A signature signed and never used no longer counts once the owner revokes directly.
    const unused = await signAllowance(nonce + 1);
    await ownerCall(permit, 'SovereignPermit', 'approve', [tokenB, router, 0n, 0]);
    expect(
      await revertOf(
        permit,
        'SovereignPermit',
        'permit',
        [owner.address, tokenB, router, amount, Number(expiration), nonce + 1, sigDeadline, unused],
        0n,
        c.deployer,
      ),
    ).toBe('BadNonce');
    // And no allowance is ever written for the zero owner.
    expect(
      await revertOf(
        permit,
        'SovereignPermit',
        'permit',
        [ZERO, tokenB, router, amount, Number(expiration), 0, sigDeadline, '0x'],
        0n,
        c.deployer,
      ),
    ).toBe('ZeroAddress');
    await routerHoldsNothing();
  });

  describe('the v2 swap procedures (swap-v2.ts) on the same contracts', () => {
    const refusal = (work: Promise<unknown>) =>
      work.then(
        () => 'no refusal',
        (err: { cause?: { code?: string } }) => err.cause?.code ?? String(err),
      );
    const pairsAt = async (): Promise<ProtocolSwapPairs> => {
      const blockNumber = await c.publicClient.getBlockNumber();
      const list = await Promise.all(
        Object.values(pools).map(async (pool) => {
          const [token0, token1, [reserve0, reserve1]] = await Promise.all([
            read<Address>(pool, 'ConstantProductPool', 'token0'),
            read<Address>(pool, 'ConstantProductPool', 'token1'),
            reservesOf(pool),
          ]);
          return { pool, token0, token1, feeBps: 30, reserve0: reserve0.toString(), reserve1: reserve1.toString(), blockTimestampLast: 0 };
        }),
      );
      return { factory, blockNumber: blockNumber.toString(), tokens: [], pools: list, skipped: 0 };
    };
    let cap: number | null = 3600;
    const deps = (): SwapV2Deps => ({
      client: () => c.publicClient,
      chainId: () => c.walletClient.chain!.id,
      setting: () => ({ router, sovereignPermit: permit, wrappedNative: weth }),
      permitLifetimeCapSeconds: () => cap,
      slippageCeilingBps: () => 300,
      pairs: pairsAt,
      toTrpcError: (err) => err as never,
    });

    it("names the approval route: the token's own permit, or an approve transaction for a token with none", async () => {
      expect((await readApprovalRoute(deps(), owner.address, tokenA)).route).toBe('native_permit');
      expect((await readApprovalRoute(deps(), owner.address, tokenC)).route).toBe('approve_only');
    });

    it('builds an exact permit for the amount and deadline; refuses a blank cap, a past or over-cap expiry and a token with no permit', async () => {
      const t = await now();
      const input = { owner: owner.address, token: tokenA, amount: '10000000', mode: 'exact' as const, expiresAt: String(t + 300n) };
      const built = await buildPermit(deps(), input);
      expect(built.tokenPermit?.message).toMatchObject({ spender: router, value: '10000000', deadline: String(t + 300n) });
      expect(await refusal(buildPermit(deps(), { ...input, token: tokenC }))).toBe('protocol.permit.not_supported');
      expect(await refusal(buildPermit(deps(), { ...input, expiresAt: String(t - 1n) }))).toBe('protocol.deadline_past');
      expect(await refusal(buildPermit(deps(), { ...input, expiresAt: String(t + 4000n) }))).toBe('protocol.permit.lifetime_over_cap');
      cap = null;
      expect(await refusal(buildPermit(deps(), input))).toBe('protocol.permit.lifetime_unset');
      cap = 3600;
    });

    it('a multi-hop route with no hop limit refuses by name; with one it returns the path and each hop', async () => {
      const ask = { tokenIn: tokenA, tokenOut: tokenC, kind: 'exact_in' as const, amount: '1000000', hops: 2, maxHops: null };
      expect(await refusal(bestPath(deps(), ask))).toBe('dex.route.max_hops_unset');
      expect(await refusal(bestPath(deps(), { ...ask, maxHops: 1 }))).toBe('dex.route.over_max_hops');
      const path = await bestPath(deps(), { ...ask, maxHops: 2 });
      expect(path.path.map((a) => a.toLowerCase())).toEqual([tokenA, tokenB, tokenC].map((a) => a.toLowerCase()));
      expect(path.hops).toHaveLength(2);
    });

    it('builds a swap whose per-hop minimums come from a fresh read; refuses a zero or past deadline; a simulated expired standing pull refuses by name', async () => {
      const t = await now();
      const base = {
        owner: owner.address,
        kind: 'exact_in' as const,
        path: [tokenA, tokenB, tokenC],
        pools: [pools.AB, pools.BC],
        amount: '1000000',
        slippageBps: 100,
        deadline: String(t + 300n),
        pull: 'allowance' as const,
        unwrapOut: false,
        simulate: false,
        maxHops: 2 as number | null,
      };
      const built = await buildSwapV2(deps(), base);
      expect(built.minOutPerHop).toHaveLength(2);
      built.minOutPerHop.forEach((min, i) => expect(BigInt(min)).toBe((BigInt(built.quoted[i]!) * 9_900n) / 10_000n));
      expect(await refusal(buildSwapV2(deps(), { ...base, deadline: '0' }))).toBe('protocol.deadline_required');
      expect(await refusal(buildSwapV2(deps(), { ...base, deadline: String(t - 1n) }))).toBe('protocol.deadline_past');
      expect(await refusal(buildSwapV2(deps(), { ...base, slippageBps: 301 }))).toBe('protocol.swap_slippage_over_ceiling');
      // The limits the person saw go in as they are; looser than the ceiling or above the fresh read refuses.
      const shownMins = built.minOutPerHop;
      const sent = await buildSwapV2(deps(), { ...base, minOutPerHop: shownMins });
      expect(sent.minOutPerHop).toEqual(shownMins);
      expect(await refusal(buildSwapV2(deps(), { ...base, minOutPerHop: ['1', '1'] }))).toBe('protocol.swap_min_out_below_bound');
      expect(await refusal(buildSwapV2(deps(), { ...base, minOutPerHop: built.quoted.map((q) => String(BigInt(q) + 1n)) }))).toBe(
        'protocol.swap.hop_below_min',
      );
      // A multi-hop build names its hop limit, as the path read does.
      expect(await refusal(buildSwapV2(deps(), { ...base, maxHops: null }))).toBe('dex.route.max_hops_unset');
      expect(await refusal(buildSwapV2(deps(), { ...base, maxHops: 1 }))).toBe('dex.route.over_max_hops');
      // The standing allowance on token B (set in the earlier test) has expired: the pull is refused before it is sent.
      expect(
        await refusal(
          buildSwapV2(deps(), {
            ...base,
            path: [tokenB, tokenA],
            pools: [pools.AB],
            amount: '1000000000000000000',
            pull: 'standing',
            simulate: true,
          }),
        ),
      ).toBe('protocol.permit.allowance_expired');
    });
  });
});
