/**
 * OrderVault (D-limit-dca-01 to -04, ENGINE VLT-1..VLT-10) on a disposable anvil, from the committed artefact.
 *
 * Given a deposit of 100 (TEST) the credit is 100; a direct transfer of 50 is not credited and only the sweeper returns
 * it, to the address it names; a non-maker withdraw reverts; a fill before the trigger, after expiry, on a stale mark or
 * paying under the minimum reverts; a partial fill of 40 leaves 60 and the remaining only goes down; one leg of a linked
 * pair filling in full leaves its sibling nothing; a cancel or a raised version kills the order's signature; a trailing
 * watermark only moves in the holder's favour; the vault always holds at least what it credits.
 *
 * Skips without a chain; CI with REQUIRE_EVM_CHAIN=1 must run it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, http, parseUnits, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { DevChainClients } from '../../scripts/dev-chain.js';
import { loadArtifact } from '../chain/artifacts.js';

// Runs unconditionally: CI provides the TEST chain (anvil). Locally, with no chain up, this suite fails and says why.
const devChainMod = await import('../../scripts/dev-chain.js');
const chainUp = await devChainMod.devChainReachable();

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const ORDER_TYPES = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'base', type: 'address' },
    { name: 'quote', type: 'address' },
    { name: 'isBuy', type: 'bool' },
    { name: 'above', type: 'bool' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'triggerWad', type: 'uint256' },
    { name: 'trailBps', type: 'uint256' },
    { name: 'minOut', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'version', type: 'uint256' },
    { name: 'link', type: 'bytes32' },
    { name: 'parent', type: 'bytes32' },
    { name: 'outputToVault', type: 'bool' },
  ],
} as const;
type Order = {
  maker: Address;
  base: Address;
  quote: Address;
  isBuy: boolean;
  above: boolean;
  amountIn: bigint;
  triggerWad: bigint;
  trailBps: bigint;
  minOut: bigint;
  expiry: bigint;
  nonce: bigint;
  version: bigint;
  link: Hex;
  parent: Hex;
  outputToVault: boolean;
};

describe('OrderVault on chain', () => {
  let clients: DevChainClients;
  let pc: PublicClient;
  let A: Address;
  let B: Address;
  let oracle: Address;
  let pool: Address;
  let vault: Address;
  const maker = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const sweeper = privateKeyToAccount(generatePrivateKey());
  const reporters = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
  const vaultAbi = () => loadArtifact('OrderVault').abi;
  const errorsOf = (name: 'FailClosedOracle' | 'ConstantProductPool') => loadArtifact(name).abi.filter((e) => e.type === 'error');
  const tokenAbi = () => loadArtifact('TestToken').abi;
  const wallet = (account: PrivateKeyAccount) =>
    createWalletClient({ account, chain: clients.walletClient.chain!, transport: http(devChainMod.devRpcUrl()) });
  const mined = async (hash: Hex) => pc.waitForTransactionReceipt({ hash });
  const deploy = async (name: Parameters<typeof loadArtifact>[0], args: unknown[]) => {
    const a = loadArtifact(name);
    const hash = await clients.walletClient.deployContract({
      abi: a.abi,
      bytecode: a.bytecode as Hex,
      args,
      account: clients.walletClient.account!,
      chain: clients.walletClient.chain,
    });
    return (await mined(hash)).contractAddress as Address;
  };
  const write = async (account: PrivateKeyAccount, address: Address, abi: unknown, functionName: string, args: unknown[]) => {
    const r = await mined(
      await wallet(account).writeContract({
        address,
        abi: abi as never,
        functionName: functionName as never,
        args: args as never,
        gas: 900_000n,
      }),
    );
    expect(r.status, `${functionName} mined`).toBe('success');
    return r;
  };
  const revertOf = async (account: PrivateKeyAccount, functionName: string, args: readonly unknown[]) =>
    pc
      .simulateContract({
        account,
        address: vault,
        // The oracle's and the pool's own errors pass through the vault's calls: decode them by name too.
        abi: [...vaultAbi(), ...errorsOf('FailClosedOracle'), ...errorsOf('ConstantProductPool')] as never,
        functionName: functionName as never,
        args: args as never,
      })
      .then(
        () => 'no revert',
        (err: Error) => /Error: (\w+)\(\)/.exec(err.message)?.[1] ?? err.message,
      );
  const read = async <T>(functionName: string, args: unknown[]) =>
    (await pc.readContract({ address: vault, abi: vaultAbi() as never, functionName: functionName as never, args: args as never })) as T;
  const balance = async (token: Address, who: Address) =>
    (await pc.readContract({ address: token, abi: tokenAbi(), functionName: 'balanceOf', args: [who] })) as bigint;
  const mint = async (token: Address, to: Address, amount: bigint) =>
    mined(
      await clients.walletClient.writeContract({
        address: token,
        abi: tokenAbi(),
        functionName: 'mint',
        args: [to, amount],
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      }),
    );
  /** Both reporters mark `token` at `wad`. */
  const mark = async (token: Address, wad: bigint) => {
    for (const r of reporters) await write(r, oracle, loadArtifact('FailClosedOracle').abi, 'report', [token, wad]);
  };
  const setPrice = async (priceWad: bigint) => {
    await mark(B, 10n ** 18n);
    await mark(A, priceWad);
  };
  const sign = async (o: Order, by = maker) =>
    by.signTypedData({
      domain: { name: 'INTAFACED Order Vault', version: '1', chainId: await pc.getChainId(), verifyingContract: vault },
      types: ORDER_TYPES,
      primaryType: 'Order',
      message: o,
    });
  const chainTime = async () => (await pc.getBlock()).timestamp;
  let nonce = 1n;
  const sell = async (over: Partial<Order> = {}): Promise<Order> => ({
    maker: maker.address,
    base: A,
    quote: B,
    isBuy: false,
    above: true,
    amountIn: parseUnits('100', 6),
    triggerWad: parseUnits('1.25', 18),
    trailBps: 0n,
    // 100 A at 1.25, less 0.5%: 124.375 B.
    minOut: parseUnits('124.375', 18),
    expiry: (await chainTime()) + 86_400n,
    nonce: nonce++,
    version: 1n,
    link: ZERO32,
    parent: ZERO32,
    outputToVault: false,
    ...over,
  });
  const invariant = async () => {
    for (const t of [A, B])
      expect(await balance(t, vault), 'vault.credited-equals-deposits-minus-withdrawals-minus-fills').toBeGreaterThanOrEqual(
        await read<bigint>('totalCredited', [t]),
      );
  };
  /** Sets the pool to `base` A and `quote` B (adds liquidity from the deployer to a fresh pool). */
  const freshPool = async (base: string, quote: string) => {
    pool = await deploy('ConstantProductPool', [A, B, 30]);
    const deployer = clients.walletClient.account!.address;
    await mint(A, deployer, parseUnits(base, 6));
    await mint(B, deployer, parseUnits(quote, 18));
    for (const [t, amt] of [
      [A, parseUnits(base, 6)],
      [B, parseUnits(quote, 18)],
    ] as const)
      await mined(
        await clients.walletClient.writeContract({
          address: t,
          abi: tokenAbi(),
          functionName: 'approve',
          args: [pool, amt],
          account: clients.walletClient.account!,
          chain: clients.walletClient.chain,
        }),
      );
    const token0 = (await pc.readContract({
      address: pool,
      abi: loadArtifact('ConstantProductPool').abi,
      functionName: 'token0',
    })) as Address;
    const [a0, a1] =
      token0.toLowerCase() === A.toLowerCase()
        ? [parseUnits(base, 6), parseUnits(quote, 18)]
        : [parseUnits(quote, 18), parseUnits(base, 6)];
    await mined(
      await clients.walletClient.writeContract({
        address: pool,
        abi: loadArtifact('ConstantProductPool').abi,
        functionName: 'mint',
        args: [deployer, a0, a1],
        account: clients.walletClient.account!,
        chain: clients.walletClient.chain,
      }),
    );
  };

  beforeAll(async () => {
    if (!chainUp) throw new Error('OrderVault on chain needs the TEST chain; no RPC at ' + devChainMod.devRpcUrl());
    clients = await devChainMod.devSuiteClients(import.meta.url);
    pc = clients.publicClient;
    for (const who of [maker, stranger, sweeper, ...reporters])
      await pc.request({ method: 'anvil_setBalance', params: [who.address, toHex(parseUnits('10', 18))] } as never);
    A = await deploy('TestToken', ['TEST Token A', 'TESTA', 6]);
    B = await deploy('TestToken', ['TEST Token B', 'TESTB', 18]);
    oracle = await deploy('FailClosedOracle', [reporters[0]!.address, reporters[1]!.address, 3600, 100]);
    vault = await deploy('OrderVault', [oracle, sweeper.address]);
    await freshPool('1000000', '1000000');
    await setPrice(10n ** 18n);
    await mint(A, maker.address, parseUnits('1000', 6));
    await write(maker, A, tokenAbi(), 'approve', [vault, parseUnits('1000', 6)]);
  });

  it('credits a deposit; a direct transfer is not credited and only the sweeper returns it; a non-maker withdraw reverts', async () => {
    await write(maker, vault, vaultAbi(), 'deposit', [A, parseUnits('100', 6)]);
    expect(await read<bigint>('credit', [maker.address, A])).toBe(parseUnits('100', 6));
    await write(maker, A, tokenAbi(), 'transfer', [vault, parseUnits('50', 6)]);
    expect(await read<bigint>('credit', [maker.address, A])).toBe(parseUnits('100', 6));
    expect(await read<bigint>('uncredited', [A])).toBe(parseUnits('50', 6));
    expect(await revertOf(stranger, 'sweepUncredited', [A, stranger.address, parseUnits('50', 6)])).toBe('NotSweeper');
    expect(await revertOf(sweeper, 'sweepUncredited', [A, maker.address, parseUnits('51', 6)])).toBe('NothingToSweep');
    const before = await balance(A, maker.address);
    await write(sweeper, vault, vaultAbi(), 'sweepUncredited', [A, maker.address, parseUnits('50', 6)]);
    expect(await balance(A, maker.address)).toBe(before + parseUnits('50', 6));
    expect(await revertOf(stranger, 'withdraw', [A, 1n])).toBe('InsufficientCredit');
    await invariant();
  });

  it('fills only at the trigger, at least the minimum, never after expiry or on a stale mark; 40 of 100 leaves 60', async () => {
    const o = await sell();
    const sig = await sign(o);
    expect(await revertOf(stranger, 'fill', [o, sig, parseUnits('40', 6), pool])).toBe('TriggerNotReached');
    await setPrice(parseUnits('1.30', 18));
    // The deep pool sits at 1.00: it cannot pay 1.24375 a unit, so the fill reverts rather than pay under the minimum.
    expect(await revertOf(stranger, 'fill', [o, sig, parseUnits('40', 6), pool])).toMatch(/InsufficientOutput|BelowMinOut/);
    await freshPool('1000000', '1300000');
    const out0 = await balance(B, maker.address);
    await write(stranger, vault, vaultAbi(), 'fill', [o, sig, parseUnits('40', 6), pool]);
    const got = (await balance(B, maker.address)) - out0;
    expect(got, 'order.fill.never-below-minOut').toBeGreaterThanOrEqual((o.minOut * 40n + 99n) / 100n);
    expect(await read<bigint>('remaining', [o])).toBe(parseUnits('60', 6));
    expect(await revertOf(stranger, 'fill', [o, sig, parseUnits('61', 6), pool])).toBe('Overfill');
    // Stale: the reports age past the bound.
    await pc.request({ method: 'evm_increaseTime', params: [3601] } as never);
    await pc.request({ method: 'evm_mine', params: [] } as never);
    expect(await revertOf(stranger, 'fill', [o, sig, parseUnits('10', 6), pool])).toBe('Stale');
    await setPrice(parseUnits('1.30', 18));
    const late = await sell({ expiry: (await chainTime()) + 10n });
    await pc.request({ method: 'evm_increaseTime', params: [20] } as never);
    await pc.request({ method: 'evm_mine', params: [] } as never);
    expect(await revertOf(stranger, 'fill', [late, await sign(late), parseUnits('1', 6), pool])).toBe('OrderExpired');
    // Another wallet's signature fills nothing.
    expect(await revertOf(stranger, 'fill', [o, await sign(o, stranger), parseUnits('1', 6), pool])).toBe('BadSignature');
    await invariant();
  });

  it('one leg of a linked pair filling in full leaves its sibling nothing', async () => {
    const link = toHex(7n, { size: 32 });
    const tp = await sell({ amountIn: parseUnits('10', 6), minOut: parseUnits('12.4375', 18), link });
    const sl = await sell({ amountIn: parseUnits('10', 6), above: false, triggerWad: parseUnits('2', 18), minOut: 1n, link });
    await write(stranger, vault, vaultAbi(), 'fill', [tp, await sign(tp), parseUnits('10', 6), pool]);
    expect(await read<bigint>('remaining', [sl])).toBe(0n);
    expect(await revertOf(stranger, 'fill', [sl, await sign(sl), 1n, pool])).toBe('Overfill');
  });

  it('a cancel or a raised version kills the signature; only the maker can do either', async () => {
    const o = await sell({ amountIn: parseUnits('5', 6), minOut: parseUnits('6.21875', 18) });
    const sig = await sign(o);
    await write(maker, vault, vaultAbi(), 'raiseVersion', [o.nonce, 2n]);
    expect(await revertOf(stranger, 'fill', [o, sig, 1n, pool])).toBe('StaleVersion');
    const v2 = { ...o, version: 2n };
    await write(stranger, vault, vaultAbi(), 'fill', [v2, await sign(v2), parseUnits('1', 6), pool]);
    // A stranger's cancel names the stranger's own order id, never the maker's.
    await write(stranger, vault, vaultAbi(), 'cancel', [o.nonce]);
    expect(await read<bigint>('remaining', [v2])).toBe(parseUnits('4', 6));
    await write(maker, vault, vaultAbi(), 'cancel', [o.nonce]);
    expect(await revertOf(stranger, 'fill', [v2, await sign(v2), 1n, pool])).toBe('OrderCancelled');
  });

  it('a trailing watermark only moves in the holder’s favour', async () => {
    const t = await sell({ above: false, triggerWad: 0n, trailBps: 500n, amountIn: parseUnits('1', 6), minOut: 1n });
    await setPrice(parseUnits('1.30', 18));
    await write(stranger, vault, vaultAbi(), 'poke', [t]);
    const id = await read<Hex>('orderId', [maker.address, t.nonce]);
    expect(await read<bigint>('watermark', [id])).toBe(parseUnits('1.30', 18));
    await setPrice(parseUnits('1.20', 18));
    await write(stranger, vault, vaultAbi(), 'poke', [t]);
    expect(await read<bigint>('watermark', [id]), 'trail.never-moves-against-holder').toBe(parseUnits('1.30', 18));
    await setPrice(parseUnits('1.40', 18));
    await write(stranger, vault, vaultAbi(), 'poke', [t]);
    expect(await read<bigint>('watermark', [id])).toBe(parseUnits('1.40', 18));
  });
});
